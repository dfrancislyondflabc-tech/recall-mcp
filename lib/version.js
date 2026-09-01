// lib/version.js — WHICH BUILD OF THIS SERVER IS ANSWERING.
//
// Node caches every module at spawn time. An MCP server that Claude Desktop
// started this morning keeps running this morning's code no matter how many
// times the repo is edited, and NOTHING in a tool response used to say so — a
// session could read a fixed bug's symptom and conclude the fix does not work.
//
// So the server states its identity: the git SHA it was spawned from, the
// branch, and the moment the process started. Logged once at startup (stderr —
// stdout is the JSON-RPC channel) and stamped on every search response, which
// makes "the running process is older than the code" a one-glance diagnosis
// instead of an afternoon.
//
// The SHA is read from .git directly rather than by spawning `git`: this runs
// inside an MCP stdio server, and a child process on a hot path is both slower
// and a way to break the protocol. Read once, cached — the SHA of a RUNNING
// process cannot change, and pretending otherwise would be the same lie this
// module exists to prevent.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

/** The instant this module was loaded — i.e. when the server process began. */
export const SERVER_STARTED_AT = new Date().toISOString();
export const SERVER_STARTED_MS = Date.now();

let CACHED = null;

function readGitHead(gitDir) {
  const headFile = join(gitDir, 'HEAD');
  if (!existsSync(headFile)) return null;
  const head = readFileSync(headFile, 'utf8').trim();

  // Detached HEAD: the file holds the SHA itself.
  if (/^[0-9a-f]{40}$/i.test(head)) return { sha: head, branch: '(detached)' };

  const m = head.match(/^ref:\s*(.+)$/);
  if (!m) return null;
  const ref = m[1].trim();
  const branch = ref.replace(/^refs\/heads\//, '');

  const looseRef = join(gitDir, ref);
  if (existsSync(looseRef)) {
    const sha = readFileSync(looseRef, 'utf8').trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return { sha, branch };
  }

  // Packed refs: the loose file is absent after `git pack-refs`.
  const packed = join(gitDir, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return { sha, branch };
    }
  }
  return { sha: null, branch };
}

/** A SHA recorded AT PACKAGE TIME, for installs that have no .git.
 *
 * This is not a guess dressed as a fact: build-public-tree.sh knows exactly which commit
 * it exported and writes it down. Git is still tried FIRST, so a clone always reports its
 * real live HEAD and a stamp can never mask it. The two are reported differently —
 * `(main)` vs `(packaged)` — because "the branch I am on" and "the commit I was cut from"
 * are different claims and a reader must be able to tell which one they are being given.
 */
function readBuildStamp(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, '.build-stamp.json'), 'utf8'));
    const sha = String(raw.sha || '');
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return { sha, builtAt: raw.builtAt || null };
  } catch (_) { /* absent or malformed: fall through to honest ignorance */ }
  return null;
}

/**
 * { sha, shaShort, branch, source, builtAt, startedAt, pid, packageVersion }
 * `sha` is null only when there is neither a readable .git NOR a build stamp — a copied
 * tree someone assembled by hand. Reported honestly rather than guessed.
 * `source` is 'git' | 'packaged' | null, and it is the field that says how much the SHA
 * is worth: 'git' is the live HEAD, 'packaged' is where the tree was cut from.
 */
export function serverVersion() {
  if (CACHED) return CACHED;
  let git = null;
  try { git = readGitHead(join(ROOT, '.git')); } catch (_) { git = null; }

  // Only when git cannot answer. A checkout's live HEAD always outranks a stamp.
  const stamp = git?.sha ? null : readBuildStamp(ROOT);

  let packageVersion = null;
  try {
    packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || null;
  } catch (_) { /* not fatal */ }

  const sha = git?.sha || stamp?.sha || null;
  CACHED = {
    sha,
    shaShort: sha ? sha.slice(0, 7) : null,
    branch: git?.branch || null,
    source: git?.sha ? 'git' : (stamp ? 'packaged' : null),
    builtAt: stamp?.builtAt || null,
    packageVersion,
    startedAt: SERVER_STARTED_AT,
    pid: process.pid
  };
  return CACHED;
}

/** The compact form stamped on responses: `1.1.0@dfe2357(main)`, `1.1.0@6baf308(packaged)`,
 *  or `1.1.0@unknown-sha(no-git)` when neither source exists — the last one says WHY it is
 *  unknown, because a bare "unknown" reads like a bug rather than an install shape. */
export function serverVersionString() {
  const v = serverVersion();
  const parts = [];
  if (v.packageVersion) parts.push(v.packageVersion);
  parts.push(v.shaShort ? `@${v.shaShort}` : '@unknown-sha');
  parts.push(`(${v.branch || (v.source === 'packaged' ? 'packaged' : 'no-git')})`);
  return parts.join('');
}

/** One stderr line at startup, so a stale process is visible in the log too. */
export function versionBanner() {
  const v = serverVersion();
  return `server build: ${serverVersionString()} pid=${v.pid} startedAt=${v.startedAt} root=${ROOT} — ` +
         'a RUNNING MCP process keeps the code it was spawned with; quit and relaunch the client after editing this repo';
}

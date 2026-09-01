#!/usr/bin/env node
// scripts/auto-ingest.js — the hook entry point. Ingest a finished conversation
// into the staging store and refresh the staging index.
//
//   node scripts/auto-ingest.js [transcript.jsonl]      (default: most recent)
//
// Designed to be fired by a SessionEnd hook and to be BORING when there is
// nothing to do: it exits in milliseconds if the transcript is already ingested.
//
// FOUR THINGS THAT MAKE THIS SAFE TO RUN UNATTENDED
//
// 1. It only ever writes to the STAGING store and the STAGING index. The curated
//    corpus and its index are never opened for writing. That boundary is what
//    the 2026-08-17 measurement bought: mixing the two costs three memories
//    their answer and 0.145 MRR, keeping them apart costs nothing at all.
// 2. Tool traffic never reaches disk. The extractor drops tool_use/tool_result
//    and thinking blocks, which is where every credential in 50 MB of measured
//    transcript actually lived.
// 3. A LOCK. Two sessions can end within a second of each other; a half-written
//    index is worse than a stale one. Second runner exits rather than queues.
// 4. It is INCREMENTAL twice over — the extractor skips exchanges whose file is
//    byte-identical, and buildIndex reuses vectors by mtime+hash — so the steady
//    state is "a few new documents", not "re-embed the world".

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ownStoreDir, stagingIndexPath, memoryRoots, rootsForCorpus } from '../lib/config.js';
import { localConfig } from '../lib/local-config.js';
import { connectorRecentlyOn } from '../lib/heartbeat.js';
import { buildIndex } from '../lib/index-store.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// EVERY project directory, not one. Claude keeps a transcript folder per
// project, so a hook hard-wired to a single folder silently ignores sessions
// from any other project — and then its "most recent" fallback re-scans an
// unrelated transcript, which looks like success. Found by asking what happens
// when two chats run at once: this machine has two project dirs.
// homedir(), not process.env.HOME: HOME is not set on Windows (it uses
// USERPROFILE), so this would have been join(undefined, ...) and thrown on
// every single turn -- taking transcript capture down with it.
const PROJECT_ROOT = join(homedir(), '.claude', 'projects');
const projectDirs = () => {
  if (process.env.MEMORY_TRANSCRIPT_DIR) return [process.env.MEMORY_TRANSCRIPT_DIR];
  try {
    return readdirSync(PROJECT_ROOT).map((d) => join(PROJECT_ROOT, d)).filter((d) => existsSync(d));
  } catch (_) { return []; }
};

const log = (...a) => console.error('[auto-ingest]', ...a);

/** A session id resolves to its own transcript wherever it lives. */
function resolveTranscript(arg) {
  if (arg && existsSync(arg)) return arg;                    // an explicit path
  if (arg) {                                                 // a bare session id
    const sid = arg.replace(/\.jsonl$/, '');
    for (const d of projectDirs()) {
      const cand = join(d, `${sid}.jsonl`);
      if (existsSync(cand)) return cand;
    }
    log(`session ${sid} not found in any project dir; falling back to most recent`);
  }
  const all = [];
  for (const d of projectDirs()) {
    let names = []; try { names = readdirSync(d); } catch (_) { continue; }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(d, f);
      try { all.push({ p: full, m: statSync(full).mtimeMs }); } catch (_) { /* skip */ }
    }
  }
  all.sort((a, b) => b.m - a.m);
  return all.length ? all[0].p : null;
}

/**
 * The session id, from argv OR from the hook's own JSON on stdin.
 *
 * The Mac hook was `jq -r '.session_id' | { read -r sid; node auto-ingest.js "$sid"; }`
 * -- which needs jq, a POSIX pipe and a POSIX shell, none of which exist on
 * Windows. Reading stdin here instead makes the hook a bare `node auto-ingest.js`
 * that is byte-identical on both platforms, and drops an external dependency.
 *
 * readFileSync(0) is a synchronous read of fd 0. It is guarded three ways: skipped
 * when stdin is a TTY (an interactive run has no hook JSON and would block
 * forever), wrapped so a closed or empty stdin is not an error, and tolerant of
 * non-JSON. Falling through to `undefined` is harmless -- resolveTranscript()
 * already falls back to the most recently modified transcript.
 */
function sessionIdFromStdin() {
  try {
    if (process.stdin.isTTY) return undefined;
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return undefined;
    const j = JSON.parse(raw);
    return j.session_id || j.sessionId || undefined;
  } catch (_) { return undefined; }
}

// WHICH SESSIONS GET REMEMBERED, and how you change your mind about it.
//
// DEFAULT: the ones you had the memory connector switched ON for. That toggle is already in
// Claude's UI, everyone can find it, and it has a physical consequence this hook can observe —
// an enabled connector means this server is running and leaving a dated mark. So the switch
// people already use becomes the switch, with no hook JSON to edit and nothing invisible.
//
// Two overrides, both in local-config.json because a HOOK INHERITS NO ENVIRONMENT — that is
// the whole reason lib/local-config.js exists, and an env-var-only switch would silently do
// nothing here:
//
//   { "captureAlways": true }   remember every session, connector on or off
//   { "autoIngest": false }     remember nothing, ever
//
// Env vars are honoured too, for a one-off manual run: MEMORY_AUTO_INGEST=0 | 1 | always.
const AI_ENV = String(process.env.MEMORY_AUTO_INGEST ?? '').toLowerCase();
if (AI_ENV === '0' || localConfig().autoIngest === false) process.exit(0);
const CAPTURE_ALWAYS = AI_ENV === 'always' || AI_ENV === '1' || localConfig().captureAlways === true;
if (!CAPTURE_ALWAYS) {
  const hb = connectorRecentlyOn();
  if (!hb.on) {
    // Silent and exit 0: a session you had memory switched off for is not an error, and a hook
    // that prints on every ordinary session end is a hook people delete.
    process.exit(0);
  }
}

const transcript = resolveTranscript(process.argv[2] || sessionIdFromStdin());
if (!transcript || !existsSync(transcript)) { log('no transcript; nothing to do'); process.exit(0); }

const store = ownStoreDir();
const stagingIdx = stagingIndexPath();
if (!store || !stagingIdx) { log('staging disabled; nothing to do'); process.exit(0); }
mkdirSync(store, { recursive: true });

// ---- DEBOUNCE (BEFORE THE LOCK, DELIBERATELY) -------------------------------------------------------------
// SessionEnd is not enough. It fires on exit/clear/logout/resume, and a chat
// left open for DAYS never fires it — so the work in the session you actually
// live in is the work that never gets captured. A Stop hook fires after every
// assistant turn and closes that gap, but a turn-by-turn full re-parse is not
// free: a 100 MB transcript takes ~60s to walk. So a per-transcript stamp keeps
// the common case to a stat() and an early exit.
// Override with MEMORY_INGEST_DEBOUNCE_SEC; 0 disables.
const DEBOUNCE_SEC = Number(process.env.MEMORY_INGEST_DEBOUNCE_SEC ?? 600);
const stampFile = join(store, '.last-ingest.json');
const readStamps = () => { try { return JSON.parse(readFileSync(stampFile, 'utf8')); } catch { return {}; } };
const stamps = readStamps();
const txKey = transcript;
if (DEBOUNCE_SEC > 0 && stamps[txKey]) {
  const sinceRun = (Date.now() - stamps[txKey].at) / 1000;
  let size = 0; try { size = statSync(transcript).size; } catch (_) { /* ignore */ }
  // Skip only if BOTH little time has passed AND the transcript has not grown.
  // Growth is the real signal; the clock alone would drop a burst of work.
  if (sinceRun < DEBOUNCE_SEC && size === stamps[txKey].size) {
    log(`nothing new since ${sinceRun.toFixed(0)}s ago (transcript unchanged); skipping`);
    process.exit(0);
  }
}

// The debounce runs BEFORE the lock is taken. It used to run after, and its
// early exit skipped the `finally` that releases the lock -- reintroducing the
// exact leak fixed one commit earlier. Deciding to do nothing should never
// require holding a lock.
// ---- the lock -------------------------------------------------------------
// A LOCK HELD BY A DEAD PROCESS IS NOT A LOCK. Observed on the first real
// SessionEnd firing: the hook is async, the app was quitting, and the host
// killed the ingest mid-run. The `finally` cleanup never got to run, so the
// lock survived with a pid that no longer existed — and the age-only rule would
// have blocked the NEXT session's ingest for 28 more minutes for no reason.
// Age is the fallback; liveness is the real test.
const processAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const lock = join(store, '.auto-ingest.lock');
if (existsSync(lock)) {
  const age = (Date.now() - statSync(lock).mtimeMs) / 1000;
  let holder = NaN;
  try { holder = parseInt(readFileSync(lock, 'utf8').trim(), 10); } catch (_) { /* unreadable = treat as dead */ }
  if (processAlive(holder)) {
    log(`another run (pid ${holder}) holds the lock; exiting`);
    process.exit(0);
  }
  log(`lock held by dead pid ${holder || '?'} (${age.toFixed(0)}s old); taking it`);
}
writeFileSync(lock, String(process.pid));

try {
  const before = existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.md')).length : 0;

  execFileSync(process.execPath, [join(ROOT, 'scripts/ingest-transcript.js'), transcript, '--write'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

  // NO process.exit() INSIDE THIS TRY. process.exit() does not run `finally`,
  // so the early return for "nothing new" leaked the lock on every quiet run --
  // which is the COMMON case. The next run then found a lock held by a dead pid;
  // the liveness check above recovers from that, so the two defects masked each
  // other and only a fixture that asserted the lock was CLEARED could see it.
  const after = readdirSync(store).filter((f) => f.endsWith('.md')).length;
  if (after === before) {
    log(`no new exchanges (${after} in store); index untouched`);
  } else {
    log(`${after - before} new exchange(s); refreshing staging index`);
    // rootsForCorpus, NOT !primary. There are three corpora now, and the
    // handoff roots are also non-primary — `!primary` would have quietly
    // written the handoff documents into the staging index, which is the exact
    // blending this architecture exists to prevent.
    const staging = rootsForCorpus('staging');
    const report = await buildIndex({ dir: staging, out: stagingIdx });
    log(`staging index: ${report.fileCount ?? after} docs, ${report.chunks ?? '?'} chunks`);
  }
} catch (e) {
  log('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  try {
    let size = 0; try { size = statSync(transcript).size; } catch (_) { /* ignore */ }
    stamps[txKey] = { at: Date.now(), size };
    writeFileSync(stampFile, JSON.stringify(stamps, null, 2) + '\n', 'utf8');
  } catch (_) { /* a missing stamp only costs a redundant run */ }
  try { unlinkSync(lock); } catch (_) { /* best effort */ }
}

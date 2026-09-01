#!/usr/bin/env node
// scripts/stamp-memory-account.js — put the signed-in account on a memory file
// that does not already name one.
//
//   node scripts/stamp-memory-account.js <file.md>
//
// WHY A HOOK AND NOT A CONVENTION. Auto-captured exchanges are stamped by the
// extractor, because the extractor writes them. CURATED memories are written by
// Claude with an ordinary file tool that never goes through this server, so
// nothing stamps those — the label depended on whoever was writing remembering
// to add it, and a rule that depends on remembering is a rule that decays.
//
// Only ever ADDS. If a memory already names an account that stands, including
// when it names a different one: re-attributing somebody else's memory to
// whoever happens to edit it next is the exact "attribution follows the reader"
// mistake this field exists to avoid.
//
// Silent and non-fatal by design: it runs on every memory write, and a stamping
// failure must never be able to lose the memory itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { accountLabel } from '../lib/config.js';

/**
 * The edited file path, from argv OR from the hook's own JSON on stdin.
 *
 * The hook used to pipe jq into a POSIX `case` that matched the memory path glob
 * before calling this script. jq, the pipe and `case` are all POSIX-only, so none
 * of it exists on Windows. (That glob cannot be written in this comment: it ends
 * in the two characters that close a block comment, which is exactly how the
 * first version of this file turned its own documentation into a syntax error.)
 * Reading stdin here makes
 * the hook a bare `node stamp-memory-account.js`, identical on both platforms, and
 * the path filtering moves into the guard below, which this script already had.
 */
function filePathFromStdin() {
  try {
    if (process.stdin.isTTY) return undefined;
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return undefined;
    const j = JSON.parse(raw);
    return j?.tool_input?.file_path || j?.tool_response?.filePath || undefined;
  } catch (_) { return undefined; }
}

const file = process.argv[2] || filePathFromStdin();
if (!file || !file.endsWith('.md')) process.exit(0);

// SCOPE THE SCRIPT ITSELF, not just the hook that calls it. The hook filters by
// path, so a HAND-RUN of this script had no guard at all — and promptly stamped
// account frontmatter onto a handoff document that is not a memory. A tool that
// edits files must carry its own precondition, because the caller that enforced
// it will not always be the caller.
// BOTH SEPARATORS. Windows hands this "C:\\Users\\me\\.claude\\projects\\x\\memory\\y.md",
// which a forward-slash-only pattern never matches -- so the guard would reject
// every real memory and stamping would silently never happen on that platform.
const looksLikeMemoryPath = (f) =>
  /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/.test(f) ||
  /[\\/]store[\\/]/.test(f) && /[\\/](recall-mcp|memory-mcp-server)[\\/]/.test(f) ||
  process.env.MEMORY_STAMP_ANY === '1';
if (!looksLikeMemoryPath(file)) process.exit(0);
if (basename(file) === 'MEMORY.md') process.exit(0);   // the shared index belongs to nobody

const account = accountLabel();
if (!account) process.exit(0);

let s;
try { s = readFileSync(file, 'utf8'); } catch { process.exit(0); }
if (/^\s+account:/m.test(s)) process.exit(0);          // already attributed — leave it

const name = basename(file, '.md');
let out;
if (s.startsWith('---')) {
  const end = s.indexOf('\n---', 3);
  if (end === -1) process.exit(0);                     // malformed; do not touch it
  let fm = s.slice(0, end), rest = s.slice(end);
  if (/^metadata:\s*$/m.test(fm)) fm = fm.replace(/^metadata:[ \t]*$/m, `metadata:\n  account: ${account}`);
  else if (/^metadata:/m.test(fm)) fm = fm.replace(/^metadata:.*$/m, (m) => `${m}\n  account: ${account}`);
  else fm = `${fm}\nmetadata:\n  account: ${account}`;
  out = fm + rest;
} else {
  out = `---\nname: ${name}\nmetadata:\n  account: ${account}\n---\n\n${s}`;
}
try { writeFileSync(file, out, 'utf8'); console.error(`[stamp] ${name} -> ${account}`); } catch { /* never fail a write */ }

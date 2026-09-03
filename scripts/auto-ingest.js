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

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, readFileSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- THE LOG IS ARMED BEFORE ANYTHING THAT CAN THROW ------------------------------------------
//
// Reviewed 2026-09-03 (MEM-20/F7): a throw during the lib imports, or in homedir() at module level
// (seen: ENOBUFS from an oversized HOME), exited non-zero having written NOTHING -- and the hook host
// discards stderr, so the run left no trace at all. The log path is therefore resolved here, from the
// environment alone, and the exit handler registered, BEFORE the libraries are imported. The imports
// are dynamic and guarded so an import failure is a logged `failed`, not silence. If lib/config.js
// later resolves a different store, the path is switched then.
const TIMED = process.argv.includes('--timed') || process.env.MEMORY_INGEST_TIMED === '1';
let RUN_LOG = process.env.MEMORY_INGEST_LOG
  || join(process.env.MEMORY_OWN_STORE || join(process.env.MEMORY_ROOT || ROOT, 'store'), '.ingest-runs.jsonl');
const RUN_LOG_MAX = Number(process.env.MEMORY_INGEST_LOG_MAX_BYTES ?? 2 * 1024 * 1024);
let runLogged = false;
let sessionForLog = null;
function runLog(outcome, extra = {}) {
  // `started` is the one line allowed BEFORE the terminal one: a run killed mid-way (the walker's
  // 10-minute SIGTERM, a host quitting) then leaves `started` with no `captured`/`no-op`/`failed`
  // after it, which is the crash signature the next reader can look for.
  if (outcome !== 'started') {
    if (runLogged) return;              // one terminal line per run, whichever exit is reached first
    runLogged = true;
  }
  if (!RUN_LOG) return;
  try {
    try { if (statSync(RUN_LOG).size > RUN_LOG_MAX) renameSync(RUN_LOG, RUN_LOG + '.1'); } catch (_) { /* first run */ }
    try { mkdirSync(dirname(RUN_LOG), { recursive: true }); } catch (_) { /* exists */ }
    appendFileSync(RUN_LOG, JSON.stringify({
      at: new Date().toISOString(),
      trigger: TIMED ? 'timed' : 'hook',
      outcome,
      pid: process.pid,
      ...(sessionForLog ? { session: sessionForLog } : {}),
      ...extra
    }) + '\n', 'utf8');
  } catch (_) { /* a log that cannot be written must never fail an ingest */ }
}
process.on('exit', () => runLog('exited', {}));

let ownStoreDir, stagingIndexPath, memoryRoots, rootsForCorpus, localConfig, connectorRecentlyOn, buildIndex, homedir;
try {
  ({ homedir } = await import('node:os'));
  ({ ownStoreDir, stagingIndexPath, memoryRoots, rootsForCorpus } = await import('../lib/config.js'));
  ({ localConfig } = await import('../lib/local-config.js'));
  ({ connectorRecentlyOn } = await import('../lib/heartbeat.js'));
  ({ buildIndex } = await import('../lib/index-store.js'));
  if (!process.env.MEMORY_INGEST_LOG && ownStoreDir()) RUN_LOG = join(ownStoreDir(), '.ingest-runs.jsonl');
} catch (e) {
  console.error('[auto-ingest] FAILED before start:', e.message);
  runLog('failed', { error: 'startup: ' + String(e.message).slice(0, 280) });
  process.exit(1);
}
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

// ---- TIMED vs HOOK: provisional versus final -------------------------------------------------
//
// A hook run happens when a turn ENDS, so every exchange in the transcript is finished and all of
// them are captured. A TIMED run happens mid-turn, so the last exchange is still being written —
// ingest-transcript.js pairs "one user turn + everything the assistant said before the next user
// turn", which makes the in-flight exchange exactly the one with no following user turn.
//
// A timed run therefore DEFERS the final exchange to the next pass. Not for safety — a partial is
// self-correcting, because the writer overwrites whenever content differs — but because a growing
// exchange rewritten every interval is re-embedded every interval, and a truncated answer is
// briefly searchable as though it were complete.
//
// 🟥 The hook must NOT defer. Dropping the last exchange there would lose the final exchange of
// every session, since no further user turn ever arrives.
// (TIMED is defined above, before the log is armed.)

const log = (...a) => console.error('[auto-ingest]', ...a);

// ---- A RUN LEAVES A TRACE ---------------------------------------------------------------------
//
// Everything above logs to stderr, which the hook host discards. So when the staging index turned
// out to be five hours stale, there was no way to tell whether this had run and skipped, run and
// failed, or never run at all — the question was unanswerable by the one instrument that could
// have answered it. One line per run, appended, so the next occurrence is diagnosable.
//
// Every field is an OUTCOME, not a narration: a reader wants to know what happened, not what the
// script was thinking. `why` is present exactly when nothing was written.
// (RUN_LOG, runLog() and the exit handler are defined at the top of the file, BEFORE the library
// imports, so that a failure during startup still leaves a line. `session` is set on every line once
// the transcript is resolved: the walker fires one run per active session and three are usually
// live, so a line without it could not be attributed to a conversation.)

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
    runLog('skipped', { why: 'memory connector not recently on (heartbeat cold)' });
      process.exit(0);
  }
}

const transcript = resolveTranscript(process.argv[2] || sessionIdFromStdin());
if (!transcript || !existsSync(transcript)) { log('no transcript; nothing to do'); runLog('skipped', { why: 'no transcript' }); process.exit(0); }

/**
 * A scheduled task is a robot run, not a conversation, and must not become memory.
 *
 * 🟥 FOUND 2026-09-03, and it is a defect the TIMER introduces, not a pre-existing one. Four of the
 * 31 sessions active in the last 72 hours had never been captured; all four turned out to be the
 * same scheduled task (`bh-ds925-price-log`), which evidently does not fire the Stop hook. The
 * timer walks every recently-touched transcript instead of the one that just stopped, so it would
 * reach them where the hook never did.
 *
 * Measured rather than assumed, because the first version of this comment overstated it: run with
 * MEMORY_CAPTURE_INCLUDE_TASKS=1, three of the four produce nothing (the extractor's own reply-
 * length rules already decline them) and ONE produces a memory whose description is the raw
 * `<scheduled-task name="bh-ds925-price-log" file="...">` XML. So this guard prevents 1 junk
 * document in 4 sessions, not 4 — small, but it is corpus poisoning, and it recurs on every run.
 *
 * Detection is the first user turn: the client wraps these as `<scheduled-task name="...">`.
 * Reading only the head of the file keeps this cheap on a multi-megabyte transcript.
 *
 * Opt in with MEMORY_CAPTURE_INCLUDE_TASKS=1 if a scheduled task should ever be remembered.
 */
function isScheduledTask(path) {
  if (process.env.MEMORY_CAPTURE_INCLUDE_TASKS === '1') return false;
  let head;
  try { head = readFileSync(path, 'utf8').slice(0, 64 * 1024); } catch { return false; }
  for (const line of head.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }   // a truncated tail line is not fatal
    if (o.type !== 'user') continue;
    const c = o.message && o.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? (c.find((b) => b && b.type === 'text') || {}).text || '' : '';
    return /^\s*<scheduled-task\b/.test(text);   // decided by the FIRST user turn, then stop
  }
  return false;
}

if (isScheduledTask(transcript)) {
  log('scheduled-task session; not a conversation, nothing to remember');
  runLog('skipped', { why: 'scheduled-task session' });
  process.exit(0);
}

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
sessionForLog = String(transcript).replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
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
    runLog('skipped', { why: 'debounced: transcript unchanged', sinceSec: Math.round(sinceRun) });
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
// ATOMIC, OR IT IS NOT A LOCK. `existsSync` then `writeFileSync` is a check-then-act gap: measured
// with a hook and a timed run started together, 20 trials -- both proceeded 8 times, and 6 of those
// left the index one document short of the store while BOTH log lines said "captured". `wx` makes
// creation the test; the liveness check runs only when creation fails.
const tryLock = () => { try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
if (!tryLock()) {
  let age = 0, holder = NaN;
  try { age = (Date.now() - statSync(lock).mtimeMs) / 1000; } catch (_) { /* vanished between the two calls */ }
  try { holder = parseInt(readFileSync(lock, 'utf8').trim(), 10); } catch (_) { /* unreadable = treat as dead */ }
  if (processAlive(holder)) {
    log(`another run (pid ${holder}) holds the lock; exiting`);
    runLog('skipped', { why: `lock held by live pid ${holder}` });
    process.exit(0);
  }
  log(`lock held by dead pid ${holder || '?'} (${age.toFixed(0)}s old); taking it`);
  try { unlinkSync(lock); } catch (_) { /* someone else already cleared it */ }
  if (!tryLock()) {                     // lost the race to another run that saw the same dead pid
    log('lock taken by another run while clearing a dead one; exiting');
    runLog('skipped', { why: 'lock raced' });
    process.exit(0);
  }
}

// THE DEBOUNCE STAMP RECORDS THE SIZE THE EXTRACTOR READ, not the size when it finished. Stamping
// afterwards recorded anything appended DURING the run as already captured: reproduced -- an exchange
// appended 1.5 s into a 5 s run was in no store file, and the next two runs said "transcript
// unchanged". Read the size here, before the extractor does, and stamp exactly that.
let sizeAtStart = 0; try { sizeAtStart = statSync(transcript).size; } catch (_) { /* ignore */ }
let failed = false;
// A `started` line with no terminal line after it is the signature of a run that was killed.
runLog('started', { transcriptBytes: sizeAtStart });

try {
  const before = existsSync(store) ? readdirSync(store).filter((f) => f.endsWith('.md')).length : 0;

  // --defer-last is what makes a timed run provisional: the in-flight exchange waits for the
  // next pass rather than being written and re-embedded on every interval.
  const stdout = execFileSync(process.execPath, [join(ROOT, 'scripts/ingest-transcript.js'), transcript, '--write',
    ...(TIMED ? ['--defer-last'] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }).toString();

  // NO process.exit() INSIDE THIS TRY. process.exit() does not run `finally`,
  // so the early return for "nothing new" leaked the lock on every quiet run --
  // which is the COMMON case. The next run then found a lock held by a dead pid;
  // the liveness check above recovers from that, so the two defects masked each
  // other and only a fixture that asserted the lock was CLEARED could see it.
  //
  // A REWRITE COUNTS. This used to compare file COUNTS only, so an existing exchange whose content
  // changed -- the extractor learned to see something it had missed (1.5.1: mid-turn messages), or
  // an exchange was captured provisionally and then completed -- left the index describing the OLD
  // text until some later capture happened to add a file. The extractor reports what it wrote;
  // read that instead of inferring it from a count that cannot see a rewrite.
  const after = readdirSync(store).filter((f) => f.endsWith('.md')).length;
  const wrote = parseInt((/^wrote (\d+),/m.exec(stdout) || [])[1] || '0', 10);
  if (after === before && wrote === 0) {
    log(`no new exchanges (${after} in store); index untouched`);
    runLog('no-op', { why: 'no new exchanges', storeFiles: after });
  } else {
    const rewritten = Math.max(0, wrote - (after - before));
    log(`${after - before} new exchange(s)${rewritten ? `, ${rewritten} rewritten` : ''}; refreshing staging index`);
    // rootsForCorpus, NOT !primary. There are three corpora now, and the
    // handoff roots are also non-primary — `!primary` would have quietly
    // written the handoff documents into the staging index, which is the exact
    // blending this architecture exists to prevent.
    const staging = rootsForCorpus('staging');
    const report = await buildIndex({ dir: staging, out: stagingIdx });
    log(`staging index: ${report.fileCount ?? after} docs, ${report.chunks ?? '?'} chunks`);
    runLog('captured', { newExchanges: after - before, ...(rewritten ? { rewritten } : {}), storeFiles: after,
      indexedDocs: report.fileCount ?? after, indexedChunks: report.chunks ?? null });
  }
} catch (e) {
  failed = true;
  log('FAILED:', e.message);
  runLog('failed', { error: String(e.message).slice(0, 300) });
  process.exitCode = 1;
} finally {
  // No stamp after a failure: a stamp says "this size was captured", and it was not. Without this
  // a failed ingest followed by no further growth was a permanent skip after one `failed` line.
  if (!failed) {
    try {
      stamps[txKey] = { at: Date.now(), size: sizeAtStart };
      writeFileSync(stampFile, JSON.stringify(stamps, null, 2) + '\n', 'utf8');
    } catch (_) { /* a missing stamp only costs a redundant run */ }
  }
  // Release only OUR lock. An unconditional unlink removed whichever run held it.
  try { if (parseInt(readFileSync(lock, 'utf8').trim(), 10) === process.pid) unlinkSync(lock); } catch (_) { /* best effort */ }
}

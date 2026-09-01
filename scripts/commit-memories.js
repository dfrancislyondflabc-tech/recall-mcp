#!/usr/bin/env node
// scripts/commit-memories.js — give the curated memories a history.
//
// The memory folder held 132 hand-written memories and NO version control, so a
// bad overwrite was unrecoverable. The evidence that this hurt was already sitting
// in the folder: two hand-made backups (`.bak`, `.backup-pre-scrub`) that someone
// created because there was no other way to undo a change.
//
// LOCAL ONLY, AND DELIBERATELY SO. A memory corpus accumulates credentials --
// an SSH password pasted into a note, a token in a runbook. On disk that is a
// fact you can still fix; in a pushed git
// history it would be permanent and off-machine, surviving any later deletion
// unless the history were rewritten. So this script never adds a remote and never
// pushes, and it refuses to run if someone else adds one while secrets are still
// present. History for recovery is the goal; offsite replication is a separate
// decision that needs the credentials dealt with first.
//
// Runs from the Stop hook: at most one commit per turn, and only when something
// actually changed. It must NEVER break the hook, so every path exits 0.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDir } from '../lib/config.js';

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('--status');
const say = (m) => { if (VERBOSE) console.log(m); };

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// Secret shapes that must never reach a remote. Deliberately narrow: this decides
// whether to BLOCK a push, so a false positive is expensive and vagueness is not
// a virtue here.
const SECRET_RES = [
  /sshpass\s+-p\s+'[^']+'/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/
];

function filesWithSecrets(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (f === '.git') continue;
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    if (SECRET_RES.some((re) => re.test(text))) out.push(f);
  }
  return out;
}

try {
  const dir = memoryDir();
  if (!dir || !existsSync(dir)) { say('no memory dir; nothing to do'); process.exit(0); }

  const fresh = !existsSync(join(dir, '.git'));
  if (fresh) {
    git(dir, ['init', '-q', '-b', 'main']);
    const readme = join(dir, '.gitignore');
    if (!existsSync(readme)) {
      writeFileSync(readme,
        '# Nothing is ignored: the point of this repo is that no memory edit is\n' +
        '# unrecoverable. Index files and caches live elsewhere (see lib/config.js).\n');
    }
    say('initialised a repository for the memory folder');
  }

  // A remote plus a plaintext credential is the one combination this must refuse.
  let remotes = '';
  try { remotes = git(dir, ['remote']).trim(); } catch { remotes = ''; }
  if (remotes) {
    const leaky = filesWithSecrets(dir);
    if (leaky.length) {
      console.error('[commit-memories] REFUSING TO RUN: a git remote is configured (' +
        remotes.split('\n').join(', ') + ') while these memory files contain plaintext ' +
        'credentials: ' + leaky.join(', ') + '. Pushing them would put a live secret in a ' +
        'permanent history. Remove the credential (or the remote) first.');
      process.exit(0);
    }
  }

  // DO NOT .trim() THE WHOLE OUTPUT. Porcelain lines are "XY filename", and for an
  // unstaged modification X is a SPACE (" M file"). Trimming the output stripped
  // that leading space from the FIRST line only, so slice(3) then ate a character
  // of the filename: a commit recording "z-recovery-probe.md" for a file actually
  // called "zz-recovery-probe.md". Untracked files ("?? file") were unaffected,
  // which is exactly why it survived the first round of testing.
  //
  // That matters more here than it looks: the commit message IS the index someone
  // reads when hunting for the version to restore, and a name that does not exist
  // is worse than no name.
  const status = git(dir, ['status', '--porcelain']);
  const lines = status.split('\n').filter((l) => l.length > 3);
  if (!lines.length) { say('memories unchanged; no commit'); process.exit(0); }

  const names = lines
    // A rename is "R  old -> new"; the new name is the one worth recording.
    .map((l) => { const p = l.slice(3); const i = p.indexOf(' -> '); return i === -1 ? p : p.slice(i + 4); })
    .map((n) => n.replace(/^"|"$/g, ''))
    .filter(Boolean);
  const added = lines.filter((l) => l.startsWith('??') || l.startsWith('A')).length;
  const modified = lines.filter((l) => /^\s*M/.test(l)).length;
  const deleted = lines.filter((l) => /^\s*D/.test(l)).length;

  if (process.argv.includes('--status')) {
    console.log(`${names.length} uncommitted change(s): ${added} added, ${modified} modified, ${deleted} deleted`);
    for (const n of names.slice(0, 20)) console.log('  ' + n);
    process.exit(0);
  }

  // ---- REAL FACT-TIME (Phase 2a) -------------------------------------------
  // Every changed memory gets metadata.modified = now, in the SAME commit that
  // carries the change — so from here on `modified` is fact-time, not the mtime
  // bookkeeping that the 2026-08-19 bulk backfill proved worthless. REFRESHED on
  // every change, not only when missing: an old explicit stamp SHADOWS the fresh
  // mtime in loadCorpus, so leaving it in place on an edited file would make
  // currency strictly worse — the exact failure class this exists to fight.
  // setModified is frontmatter-only surgery and refuses files without
  // frontmatter (MEMORY.md), so a stamp can never touch a body or a context
  // window. Failures are per-file and swallowed: the hook must never die.
  try {
    const { setModified } = await import('../lib/corpus.js');
    const nowIso = new Date().toISOString();
    let stamped = 0;
    for (const line of lines) {
      if (/^\s*D/.test(line) || line.startsWith('D')) continue;   // a deletion has no file to stamp
      const p = line.slice(3);
      const name = (p.includes(' -> ') ? p.slice(p.indexOf(' -> ') + 4) : p).replace(/^"|"$/g, '');
      if (!name.endsWith('.md')) continue;
      try {
        const r = setModified(join(dir, name), nowIso, 'stop-hook');
        if (r.changed) stamped++;
      } catch (_) { /* one unstampable file must not stop the commit */ }
    }
    say(`stamped modified on ${stamped} changed file(s)`);
  } catch (_) { /* stamping is best-effort; the commit below still runs */ }

  const parts = [];
  if (added) parts.push(`+${added}`);
  if (modified) parts.push(`~${modified}`);
  if (deleted) parts.push(`-${deleted}`);
  const headline = names.length === 1
    ? `memory: ${names[0]}`
    : `memory: ${names.length} files (${parts.join(' ')})`;

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m',
    headline + '\n\n' + names.slice(0, 40).map((n) => '  ' + n).join('\n') +
    (names.length > 40 ? `\n  …and ${names.length - 40} more` : '') +
    '\n\nCommitted automatically by scripts/commit-memories.js (Stop hook).'],
    { env: { ...process.env, GIT_AUTHOR_NAME: 'memory-autocommit', GIT_COMMITTER_NAME: 'memory-autocommit' } });
  say('committed: ' + headline);

  // ---- MARGIN AT WRITE TIME (2026-08-29) -----------------------------------
  // Twice on 2026-08-28 an ordinary, correct memory write displaced a gold answer
  // and turned the suite red — verify-protocol in the morning (+0.0143 -> -0.0042),
  // the changelog at night — and both times it was discovered hours later by
  // running the suite for something else. The monitor already existed; what was
  // missing was TIMING. This is the moment of cause: the memories that did it are
  // in the commit directly above.
  //
  // WARNS, NEVER BLOCKS. Both of those memories were true and worth keeping; the
  // fix each time was to reword the DISPLACING document, which is a judgment call
  // for a person. And it runs AFTER the commit on purpose — a failure in the check
  // must never be able to lose a memory.
  //
  // Every path below exits 0. This file's contract is that a hook is never the
  // reason a turn fails, and a margin report does not get to be the exception.
  try {
    const mm = await import('./monitor-margins.js');
    const reading = await mm.measureMargins();
    if (mm.isSentinelReading(reading)) {
      say('margin check: reading located none of its cases — refused (D3 sentinel)');
    } else {
      mm.appendHistory(reading);
      const prev = mm.previousReading();          // the row before the one just added
      const fell = prev && typeof prev.min === 'number' && reading.min < prev.min;
      const tight = reading.min <= 0.005;
      if (fell || tight) {
        const d = (reading.min - prev.min).toFixed(4);
        console.error(
          `\n[commit-memories] 🟥 RETRIEVAL MARGIN FELL — ${prev.min} → ${reading.min} (${d})` +
          `\n                  losing case : ${reading.minSet}/${reading.minCase}` +
          (reading.minRival ? `\n                  displaced by: ${reading.minRival}` : '') +
          `\n                  The memories in the commit above crowded a protected answer.` +
          `\n                  NOT BLOCKED — the write stands. Fix it in the CORPUS (reword the` +
          `\n                  displacing description), never in the ranker.` +
          (tight ? `\n                  🟥 AT OR INSIDE THE 0.005 DRIFT BAND.` : '') + '\n');
      } else {
        say(`margin check: min ${reading.min} on ${reading.minSet}/${reading.minCase} — no fall`);
      }
    }
  } catch (e) {
    // A margin measurement that cannot run is not a reason to fail a turn.
    const msg = e && e.message ? e.message : String(e);
    say(/Cannot find module/.test(msg)
      ? 'margin check: not installed (the benchmark harness ships only in the author\'s tree) — skipped'
      : 'margin check skipped: ' + msg);
  }
} catch (e) {
  // A hook must never be the reason a turn fails.
  console.error('[commit-memories] ' + (e && e.message ? e.message : e));
}
process.exit(0);

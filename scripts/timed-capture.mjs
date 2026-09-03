#!/usr/bin/env node
// scripts/timed-capture.mjs — capture without waiting for a turn to end.
//
//   node scripts/timed-capture.mjs [--window-min N] [--dry]
//
// WHY THIS EXISTS. Capture fires on the Stop hook, so its unit is a TURN — the whole run of work
// between two user messages. An exchange is written only once its turn ends, so capture lag equals
// turn length. Measured on this session: 1, 1, 1, 2, 10, 37, 41 and 57 minutes.
//
// 🟥 A CORRECTION — this file previously carried the wrong reason, twice over.
// It first said "ten exchanges written in the same second, then a 283-minute gap", read as
// accumulation during one long turn. I later told Daniel it was ten turns whose hook never fired.
// BOTH are wrong. What the store shows (store/x-b58a69af-*.md, file mtime vs frontmatter `ts`):
//   - the burst was 52 exchanges, not ten, and their ask-times span FIVE DAYS (2026-08-28 →
//     2026-09-02). It was the first-ever ingest of a session that had run uncaptured for days.
//   - the 283-minute "gap" was 20:34 → 01:24 between two of Daniel's messages. No user turn means
//     no exchange. Nothing was missed, because there was nothing to capture.
// The hook is not failing: the run log holds 27 hook runs — 3 captured, 24 honest "no new
// exchanges".
//
// THE REAL GAP, measured across every session active in the last 72 hours: 4 of 31 had never been
// captured (all four scheduled tasks — see the guard in auto-ingest.js), and several show a last
// capture days older than their transcript, having been resumed since. A per-turn hook cannot reach
// a session that is resumed and closed without it firing, because it only ever runs for the session
// that just stopped. Walking every recently-touched transcript is what does.
//
// Sized honestly, against a control: a session captured live start-to-finish captures 59 of 77
// prose user turns; the "7 days behind" session captures 45 of 59 — the SAME 1.3x ratio. So the
// shortfall is single digits per session, not the ~1,559 exchanges I first computed by counting raw
// `type:"user"` entries (tool results carry that type too). Real, worth closing, NOT an emergency,
// and explicitly not grounds for a backfill pass.
//
// So: run on a timer as well, and let auto-ingest do exactly what it already does — with `--timed`,
// which defers the in-flight exchange. See test/timed-capture-preregistration.md.
//
// 🟥 EVERY ACTIVE SESSION, NOT THE NEWEST ONE. auto-ingest resolves a transcript from an argument
// or a session id and otherwise falls back to "most recent". On a machine running two conversations
// at once, that captures one and silently starves the other — and two-at-once is the normal case
// here. This walks every transcript touched inside the window instead.
//
// Safe to run at any time and at any frequency: auto-ingest keeps its own debounce (it skips when
// the transcript has not grown) and its own lock (it exits if another run holds it). This script
// adds no state of its own.

import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECTS = join(homedir(), '.claude', 'projects');

const argMin = process.argv.indexOf('--window-min');
// 15 minutes against a 5-minute timer: deliberately generous overlap, so one missed run (a laptop
// asleep, a busy machine) does not leave a session uncaptured until its next message.
const WINDOW_MIN = argMin !== -1 ? Number(process.argv[argMin + 1]) : Number(process.env.MEMORY_CAPTURE_WINDOW_MIN ?? 15);
const DRY = process.argv.includes('--dry');

function activeTranscripts() {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(PROJECTS); } catch { return out; }
  for (const d of dirs) {
    const p = join(PROJECTS, d);
    let files = [];
    try { files = readdirSync(p); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(p, f);
      let st; try { st = statSync(full); } catch { continue; }
      const ageMin = (Date.now() - st.mtimeMs) / 60000;
      if (ageMin <= WINDOW_MIN) out.push({ path: full, ageMin, session: f.slice(0, 8) });
    }
  }
  // Freshest first: if something goes wrong partway, the most active conversation is already done.
  return out.sort((a, b) => a.ageMin - b.ageMin);
}

const active = activeTranscripts();
if (!active.length) {
  console.log(`[timed-capture] no transcript touched in the last ${WINDOW_MIN} min; nothing to do`);
  process.exit(0);
}

console.log(`[timed-capture] ${active.length} active session(s) in the last ${WINDOW_MIN} min`);
for (const t of active) {
  console.log(`[timed-capture] ${t.session} (${t.ageMin.toFixed(1)} min ago)${DRY ? ' — DRY' : ''}`);
  if (DRY) continue;
  // Each session is independent: one that fails must not stop the others.
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'auto-ingest.js'), t.path, '--timed'],
    { encoding: 'utf8', env: process.env, cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (r.status !== 0) {
    const tail = String(r.stderr || '').split('\n').filter(Boolean).slice(-2).join(' | ');
    console.error(`[timed-capture] ${t.session} exited ${r.status}: ${tail.slice(0, 200)}`);
  }
}

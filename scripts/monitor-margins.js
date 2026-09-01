#!/usr/bin/env node
// scripts/monitor-margins.js — how much room do the protected sets have left?
//
//   node scripts/monitor-margins.js [--quiet]
//
// THE LESSON THIS EXISTS FOR. A verbatim body-quote fixture held rank 1 by
// 0.005 for weeks. Nobody knew, because a margin is invisible right up until
// something walks into it and the suite goes red. The α=0.15 regression was
// that walk. Margins are now WATCHED: one dated line per run into
// `.margin-history.jsonl`, and dream reports the minimum and its trend.
//
// Three protected sets, and the margin definitions are the ones the enlarged
// bar registered (test/graph-spread-preregistration.md):
//
//   gold    top-3 margin — score(expected) − score(rank-4 document)
//   quotes  rank-1 margin — score(expected) − score(best other document)
//   razor   rank-1 margin (it rides in gold too; reported separately because
//           it is the documented canary for the absence floor)
//
// Read-only with respect to every index and corpus. Exported for dream and
// for the suite's clock-forward canary, so all three read one definition.

import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../lib/search.js';
import { marginHistoryPath } from '../lib/config.js';
import { spreadAlpha, spreadGate } from '../lib/graph-spread.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const GOLD = JSON.parse(readFileSync(join(ROOT, 'test', 'curated-gold.json'), 'utf8')).cases;

// Restated from the suite's (d1) group. Drift between these and
// test/run-tests.js is a bug in this file.
export const QUOTES = [
  ['never key sidebar-row identity on raw row text', 'tawk-watcher-speedup-2026-06-29'],
  ['a green gate is not evidence this file is current', 'zip-v107-shipped'],
  ['it works in this session is not done', 'commit-changes-when-done'],
  ['we make more margin selling our own 60 bay', 'seagate-exos-5u84-jbod'],
  ['any state keyed to the sidebar reading zero must survive the post-refresh render blip',
    'tawk-watcher-speedup-2026-06-29'],
  ['it does not silently corrupt which is the whole point', 'dom-pilot-excel-reliability-fixes']
];
export const RAZOR = ['how is end-of-life marked in the price book', 'price-book-eol-grey-shading'];

const r4 = (n) => Number(Number(n).toFixed(4));
const isWanted = (n, want) => n === want || n.startsWith(want + '#');

/** One case's margin. `rankOne` picks the definition. */
export async function marginFor(q, want, { rankOne }) {
  const rows = (await search(q, { limit: 10 })).results || [];
  const at = rows.findIndex((x) => isWanted(x.name, want));
  if (at === -1) return { margin: -1, rank: null };
  const others = rows.filter((x) => !isWanted(x.name, want));
  const rival = rankOne ? others[0] : others[2];    // best other / rank-4 overall
  // The rival's NAME rides along: knowing the margin fell is half an answer, and
  // the half that does not tell you what to do about it. Both 2026-08-28
  // regressions were fixed by editing the DISPLACING document, which you cannot
  // do until you know which one it is.
  return { margin: r4(rows[at].score - (rival ? rival.score : 0)), rank: at + 1,
           rival: rival ? rival.name : null };
}

/** Every protected set, with each set's minimum and the overall minimum. */
export async function measureMargins() {
  const sets = {};
  const collect = async (name, cases, rankOne) => {
    const rows = [];
    for (const [q, want] of cases) rows.push({ want, ...(await marginFor(q, want, { rankOne })) });
    const worst = rows.reduce((a, b) => (b.margin < a.margin ? b : a));
    sets[name] = { min: worst.margin, minCase: worst.want, minRival: worst.rival || null, rows };
  };
  await collect('gold', GOLD, false);
  await collect('quotes', QUOTES, true);
  await collect('razor', [RAZOR], true);

  const worstSet = Object.entries(sets).reduce((a, b) => (b[1].min < a[1].min ? b : a));
  return {
    ts: new Date().toISOString(),
    alpha: spreadAlpha(), gate: spreadGate(),
    sets, min: worstSet[1].min, minSet: worstSet[0], minCase: worstSet[1].minCase,
    minRival: worstSet[1].minRival || null
  };
}

/**
 * A measurement that found NOTHING is not a measurement (D3).
 * The suite's fixture-corpus dream spawn appended three rows whose every rank
 * was null and every margin -1, because that corpus holds none of these
 * memories. The trend line then differenced a real 0.0138 against a sentinel
 * and printed "+1.0138". A history with sentinels in it cannot be the basis of
 * a drift alarm, so a reading that located none of its cases is refused.
 */
export function isSentinelReading(reading) {
  const rows = Object.values(reading?.sets || {}).flatMap((s) => s.rows || []);
  return rows.length > 0 && rows.every((r) => r.rank === null);
}

/** Append one line. Never throws — a monitor must not be able to fail a run. */
export function appendHistory(reading) {
  try {
    if (isSentinelReading(reading)) return null;   // found nothing: record nothing
    const path = marginHistoryPath();
    if (!path) return null;
    appendFileSync(path, JSON.stringify(reading) + '\n', 'utf8');
    return path;
  } catch (_) { return null; }
}

/** Previous reading, for the trend line. */
export function previousReading() {
  try {
    const path = marginHistoryPath();
    if (!path) return null;
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length < 2) return null;
    return JSON.parse(lines[lines.length - 2]);
  } catch (_) { return null; }
}

/** The one line dream prints. */
export function trendLine(reading, prev) {
  const drift = 0.005;   // the band the α=0.15 regression lived and died in
  let arrow = '';
  if (prev && typeof prev.min === 'number') {
    const d = r4(reading.min - prev.min);
    arrow = d === 0 ? '  (unchanged)' : `  (${d > 0 ? '+' : ''}${d} since ${String(prev.ts).slice(0, 10)})`;
  }
  const warn = reading.min <= drift
    ? `   🟥 AT OR INSIDE THE ${drift} DRIFT BAND — re-measure the grid before anything else moves`
    : '';
  return `margins      : min ${reading.min} on ${reading.minSet}/${reading.minCase}${arrow}${warn}`;
}

if (process.argv[1] && process.argv[1].endsWith('monitor-margins.js')) {
  const reading = await measureMargins();
  const prev = previousReading();
  const path = appendHistory(reading);
  if (!process.argv.includes('--quiet')) {
    console.log(`\nprotected-set margins   alpha ${reading.alpha}  gate ${reading.gate}\n`);
    for (const [name, set] of Object.entries(reading.sets)) {
      console.log(`  ${name.padEnd(7)} min ${String(set.min).padEnd(9)} on ${set.minCase}`);
      for (const row of set.rows.slice().sort((a, b) => a.margin - b.margin)) {
        console.log(`      ${String(row.margin).padStart(8)}  rank ${row.rank ?? '-'}  ${row.want}`);
      }
    }
    console.log(`\n${trendLine(reading, appendHistory === null ? null : prev)}`);
    console.log(path ? `appended to ${path}\n` : '(history sidecar disabled)\n');
  }
}

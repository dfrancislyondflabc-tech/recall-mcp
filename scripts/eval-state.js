#!/usr/bin/env node
// scripts/eval-state.js — can the corpus answer "did this finish?"
//
// The existing gold set measures RETRIEVAL: given a query, does the right memory
// rank first. This measures STATE QUESTIONS, which is a different failure mode and
// the one that actually bit: relevance cannot separate "we are starting X" from
// "X is finished", because both are equally about X.
//
// Every answer in test/state-questions.json was written down BEFORE the corpus was
// queried. That ordering is the entire value: grading after seeing the results
// produces a test that passes for the wrong reason, and this repo has done that
// four times. The exit code is the verdict, as everywhere else here.
//
// Needs the local store/ corpus, which is gitignored, so this is deliberately NOT
// part of npm test -- it lives with bench/measure-*, which have the same property.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SET = JSON.parse(readFileSync(join(HERE, '..', 'test', 'state-questions.json'), 'utf8'));

const { registerMemoryTools } = await import('../tools/memory.js');
const calls = new Map();
registerMemoryTools({ tool: (name, _d, _s, handler) => calls.set(name, handler) });
const memory = async (args) => {
  const r = await calls.get('memory')(args);
  try { return JSON.parse(r.content[0].text); } catch { return { error: 'unparseable' }; }
};

const LIMIT = Number(process.env.EVAL_LIMIT || 6);
const verbose = process.argv.includes('--verbose');

async function ask(query) {
  const r = await memory({ action: 'latest', query, limit: LIMIT });
  return {
    n: r.totalMentions || 0,
    relaxed: Boolean(r.relaxed),
    rows: r.results || []
  };
}

function rankOf(rows, re) {
  const i = rows.findIndex((row) => re.test(row.snippet || ''));
  return i < 0 ? null : i + 1;
}

console.log('\n=== state-question eval (answers pre-registered ' + SET.baseline.measuredOn + ') ===\n');

let found = 0;
let controlsFailed = 0;
const rows = [];

for (const c of SET.cases) {
  const re = new RegExp(c.expect, 'i');
  const hit = await ask(c.query);
  const rank = rankOf(hit.rows, re);
  if (rank) found++;

  // The control is expected to FAIL. It is the measurement behind "query a term
  // filter with identifiers, not prose" -- if it starts passing, revisit that.
  const ctl = c.proseControl ? await ask(c.proseControl) : null;
  const ctlRank = ctl ? rankOf(ctl.rows, re) : null;
  if (ctl && !ctlRank) controlsFailed++;

  rows.push({ id: c.id, rank, n: hit.n, relaxed: hit.relaxed, ctlRank, ctlN: ctl ? ctl.n : null });

  const mark = rank ? 'FOUND at rank ' + String(rank).padEnd(2) : 'MISSED       ';
  console.log('  ' + mark + '  ' + c.id);
  console.log('      query   «' + c.query + '»  -> ' + hit.n + ' mentions' + (hit.relaxed ? ' [RELAXED]' : ''));
  if (c.proseControl) {
    console.log('      control «' + c.proseControl + '»  -> ' +
      (ctlRank ? 'also found at rank ' + ctlRank + ' (prose worked here)' : 'not found (as expected)'));
  }
  if (verbose && rank) {
    console.log('      evidence: ' + String(hit.rows[rank - 1].snippet || '').replace(/\s+/g, ' ').slice(0, 150));
  }
}

const total = SET.cases.length;
console.log('\n  answered      : ' + found + ' of ' + total + '   (baseline ' + SET.baseline.found + '/' + SET.baseline.of + ')');
console.log('  prose controls: ' + controlsFailed + ' of ' + rows.filter((r) => r.ctlRank !== undefined && r.ctlN !== null).length +
  ' failed as expected  (baseline ' + SET.baseline.controlsFailingAsExpected + ')');

// A DROP is a regression; an IMPROVEMENT is not a failure, but the baseline in the
// JSON should then be raised deliberately rather than drifting upward unnoticed.
const floor = Number(process.env.EVAL_FLOOR || SET.baseline.found);
if (found < floor) {
  console.log('\n  REGRESSION: ' + found + ' < floor ' + floor + '. Retrieval got worse for state questions.\n');
  process.exit(1);
}
if (found > SET.baseline.found) {
  console.log('\n  IMPROVED past the recorded baseline — raise `baseline.found` in ' +
    'test/state-questions.json so the gain is locked in.');
}
console.log('\n  OK\n');
process.exit(0);

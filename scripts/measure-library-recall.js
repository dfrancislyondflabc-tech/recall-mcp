#!/usr/bin/env node
// scripts/measure-library-recall.js — grade the library corpora against the
// pre-registered questions in test/library-questions.json.
//
//   node scripts/measure-library-recall.js
//
// The instrument, not the judge: the bar lives in the questions file, fixed
// before this script first ran. Grading rules are restated there and
// implemented here VERBATIM:
//   * recall: a top-3 result name starts with expectPrefix; when expectAnchors
//     is present the matching name must be exactly <prefix>#<anchor slug> for
//     one of the LISTED anchors.
//   * absence: noStrongMatch === true.
//   * leaks: zero returned rows whose corpus is outside the scoped set.
//
// Before grading, it VERIFIES the preconditions the file promises: every
// fabricated absence term must be absent from the library indexes — a probe
// term that leaked into the corpus measures nothing (the a45 lesson).

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search } from '../lib/search.js';
import { getIndex } from '../lib/search.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const Q = JSON.parse(readFileSync(join(ROOT, 'test', 'library-questions.json'), 'utf8'));

const anchorSlug = (a) => a.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// ---- precondition: fabricated terms are ABSENT from the library ----
{
  const fabricated = Q.absence.filter((a) => a.class === 'fabricated-term');
  const terms = fabricated.flatMap((a) => (a.q.match(/[A-Z][a-z]+[a-z0-9-]*|QX-\d+/g) || []))
    .filter((t) => /^(Thrymvold|QX-9910|Ellsworth|Vantrave|Zentrifax|Petrel)$/.test(t) || /^QX-/.test(t));
  const leaked = [];
  for (const scope of ['books', 'manuals']) {
    const idx = getIndex({ scope });
    const hay = JSON.stringify(idx.docs.map((d) => (d.chunks || []).map((c) => c.text).join(' '))).toLowerCase();
    for (const t of new Set(terms)) if (hay.includes(t.toLowerCase())) leaked.push(`${t} in ${scope}`);
  }
  if (leaked.length) {
    console.error(`PRECONDITION FAILED — fabricated probe terms found in the corpus: ${leaked.join(', ')}. ` +
      'An absence probe over a corpus that contains its term measures nothing. Fix the corpus or the probes.');
    process.exit(2);
  }
  console.log('precondition: fabricated absence terms verified absent from books + manuals indexes\n');
}

const rows = [];
let groupsPass = true;

for (const [group, questions] of Object.entries(Q.groups)) {
  let hit = 0;
  const misses = [];
  for (const item of questions) {
    const r = await search(item.q, { scope: item.scope, limit: 3 });
    const results = (r.results && r.results.length ? r.results : r.bestWeak || []).slice(0, 3);
    let ok = false;
    for (const row of results) {
      if (!row.name.startsWith(item.expectPrefix)) continue;
      if (item.expectAnchors) {
        if (item.expectAnchors.some((a) => row.name === `${item.expectPrefix}#${anchorSlug(a)}`)) { ok = true; break; }
      } else { ok = true; break; }
    }
    if (ok) hit++;
    else misses.push({ q: item.q, got: results.map((x) => x.name) });
  }
  const share = hit / questions.length;
  const pass = share >= Q.bar.recallAtRank3PerGroup;
  if (!pass) groupsPass = false;
  rows.push(`${group.padEnd(9)} recall@3 ${hit}/${questions.length}  (${(share * 100).toFixed(0)}%)  ${pass ? 'PASS' : 'FAIL'}`);
  for (const m of misses) rows.push(`   miss: "${m.q}" -> ${m.got.join(' | ') || '(nothing)'}`);
}

let absHit = 0;
for (const item of Q.absence) {
  const r = await search(item.q, { scope: item.scope, limit: 3 });
  if (r.noStrongMatch === true) absHit++;
  else rows.push(`   absence MISS (${item.class}): "${item.q}" -> ${(r.results || []).map((x) => `${x.name}:${x.score}`).join(' | ')}`);
}
const absPass = absHit === Q.absence.length;
rows.push(`absence   ${absHit}/${Q.absence.length}  ${absPass ? 'PASS' : 'FAIL'}`);

let leakCount = 0;
for (const item of Q.leaks) {
  const r = await search(item.q, { scope: item.scope, limit: 5 });
  const all = [
    ...(r.results || []),
    ...Object.values(r.groups || {}).flatMap((g) => [...(g.results || []), ...(g.bestWeak || [])])
  ];
  const bad = all.filter((row) => row.corpus && !item.allowedCorpora.includes(row.corpus));
  if (bad.length) { leakCount += bad.length; rows.push(`   LEAK: "${item.q}" -> ${bad.map((b) => `${b.name}@${b.corpus}`).join(', ')}`); }
}
rows.push(`leaks     ${leakCount}  ${leakCount === 0 ? 'PASS' : 'FAIL'}`);

console.log(rows.join('\n'));
const allPass = groupsPass && absPass && leakCount === 0;
console.log(`\nBAR (${JSON.stringify(Q.bar)}): ${allPass ? 'MET' : 'NOT MET'}`);
process.exit(allPass ? 0 : 1);

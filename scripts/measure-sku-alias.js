#!/usr/bin/env node
// scripts/measure-sku-alias.js — grade the Phase-4a alias layer against the
// pre-registered set in test/sku-alias-questions.json.
//
//   node scripts/measure-sku-alias.js
//
// The instrument, not the judge. The bar lives in the questions file, frozen
// before the flag existed; the grading rules are restated there and
// implemented here verbatim:
//   * target  = rank (1-based, over the top 5) of the first result named
//               exactly `<expectPrefix>#<slug of a listed anchor>`; 99 if
//               absent. improved = strictly better with the flag on.
//   * control = regression if the ordered result-name list OR the
//               noStrongMatch verdict differs between the two arms.
//
// Both arms run in ONE process against the same indexes, flipping only
// MEMORY_SKU_ALIAS, because two processes would also differ in cache warmth.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, invalidate } from '../lib/search.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const Q = JSON.parse(readFileSync(join(ROOT, 'test', 'sku-alias-questions.json'), 'utf8'));
const PREFIX = 'ts-x73a-user-guide';
const anchorSlug = (a) => a.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function arm(on) {
  if (on) process.env.MEMORY_SKU_ALIAS = '1'; else delete process.env.MEMORY_SKU_ALIAS;
  const targets = {};
  for (const t of Q.targets) {
    const r = await search(t.q, { scope: t.scope, limit: 5 });
    const names = (r.results || []).map((x) => x.name);
    const wanted = new Set(t.anchors.map((a) => `${PREFIX}#${anchorSlug(a)}`));
    const at = names.findIndex((n) => wanted.has(n));
    targets[t.id] = { rank: at === -1 ? 99 : at + 1, names, expansion: r.modelFamilyExpansion?.added || [] };
  }
  const controls = {};
  for (const c of Q.controls) {
    const r = await search(c.q, { scope: c.scope, limit: 5 });
    controls[c.id] = {
      names: (r.results || []).map((x) => x.name),
      noStrongMatch: r.noStrongMatch === true,
      expansion: r.modelFamilyExpansion?.added || []
    };
  }
  return { targets, controls };
}

invalidate();
const off = await arm(false);
invalidate();
const on = await arm(true);
delete process.env.MEMORY_SKU_ALIAS;

let improved = 0, regressed = 0;
console.log('\nTARGETS  (rank of the expected page anchor; 99 = not in top 5)\n');
console.log('id     off   on    verdict     expansion');
for (const t of Q.targets) {
  const a = off.targets[t.id].rank, b = on.targets[t.id].rank;
  const v = b < a ? 'IMPROVED' : (b > a ? 'REGRESSED' : 'same');
  if (b < a) improved++; if (b > a) regressed++;
  console.log(`${t.id.padEnd(7)}${String(a).padEnd(6)}${String(b).padEnd(6)}${v.padEnd(12)}${on.targets[t.id].expansion.join(',')}`);
}

let controlRegressions = 0;
console.log('\nCONTROLS  (must not change)\n');
for (const c of Q.controls) {
  const a = off.controls[c.id], b = on.controls[c.id];
  const sameNames = JSON.stringify(a.names) === JSON.stringify(b.names);
  const sameVerdict = a.noStrongMatch === b.noStrongMatch;
  const ok = sameNames && sameVerdict;
  if (!ok) controlRegressions++;
  console.log(`${c.id.padEnd(6)}${ok ? 'unchanged' : 'CHANGED  '}  ` +
    `${c.expect === 'noStrongMatch' ? `absent off=${a.noStrongMatch} on=${b.noStrongMatch}  ` : ''}` +
    `${sameNames ? '' : `\n        off: ${JSON.stringify(a.names)}\n         on: ${JSON.stringify(b.names)}`}` +
    `${b.expansion.length ? `   (expanded: ${b.expansion.join(',')})` : ''}`);
}

console.log(`\ntargets improved ${improved}/12  (regressed ${regressed})`);
console.log(`control regressions ${controlRegressions}/12`);
console.log(`\nBAR: >=8 improved AND 0 control regressions  ->  ` +
  `${improved >= 8 && controlRegressions === 0 ? 'MET (subject to the gold/a48 clauses)' : 'MISSED — flag stays OFF'}\n`);

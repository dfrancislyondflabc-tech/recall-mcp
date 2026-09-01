#!/usr/bin/env node
// test-stale-absence.js — an absence verdict must never come from an index that
// knows it is incomplete.  See test/stale-absence-preregistration.md
//
// THE INCIDENT (2026-08-29). A query for the ship SHA `31cab63` returned
// totalMentions 0 with unmatchableTerms ["31cab63"], and I reported that a whole
// session had never been captured. It had — 149 exchanges — and the SHA sat in the
// CONTENT of three store files added after the index was built. The very same
// response carried `indexStale: true` and a 163-file stale warning. Both halves
// were printed; nothing connected them, and I read the zero.
//
// WHY THIS TEST IS SANDBOXED RATHER THAN LIVE. The first version queried the real
// staging corpus, and every control was already contaminated: `Karvellin` and
// `kubernetes` are the suite's own absence traps, and by DISCUSSING them in a
// captured conversation I had put them in the corpus. In a system whose corpus is
// its own working notes, a live absence control decays the moment you talk about
// it. So the corpus here is built from scratch, and the staleness is manufactured.
//
// AND IT MUST BE THE STAGING CORPUS. The first sandbox version used `curated` and
// every MUST-FIND failed with indexStale=false — because curated REPAIRS ITSELF
// INLINE when it notices staleness, so the bug is unreachable there. Staging
// refuses inline repair by design ("ingest-driven — auto-ingest.js owns it"), which
// is exactly why the incident happened in staging and only in staging.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

const mem = (name, body) => `---\nname: ${name}\ndescription: "${name} fixture"\n---\n\n${body}\n`;

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stale-absence-'));
  const curated = join(tmp, 'memory');
  const store = join(tmp, 'store');
  mkdirSync(curated, { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(join(curated, 'alpha.md'), mem('alpha', 'The alpha note covers deal registration.'));

  // ---- a staging corpus, indexed while complete ----------------------------
  const exch = (n, body) =>
    `---\nname: x-stalesess-000${n}\ndescription: "a staged exchange"\nmetadata:\n  type: exchange\n  sessionId: stalesess\n  modified: 2026-0${n}-01T00:00:00.000Z\n---\n${body}\n`;
  for (let i = 1; i <= 3; i++) {
    writeFileSync(join(store, `x-stalesess-000${i}.md`),
      exch(i, `zip building and gate discussion number ${i}, with enough words to be a real body for the retrieval legs to chew on`));
  }

  process.env.MEMORY_DIR = curated;
  process.env.MEMORY_INDEX = join(tmp, 'index.json');
  process.env.MEMORY_QUERY_LOG = join(tmp, 'q.jsonl');
  process.env.MEMORY_OWN_STORE = store;
  process.env.MEMORY_STAGING_INDEX = join(tmp, 'staging.json');

  const { buildIndex } = await import('../lib/index-store.js');
  await buildIndex({ dir: [{ dir: curated, label: 'memory', primary: true }], out: process.env.MEMORY_INDEX });
  await buildIndex({ dir: [{ dir: store, label: 'store', defaultTier: 'archive', primary: false }],
                    out: process.env.MEMORY_STAGING_INDEX });

  // ---- now make it stale, the way real life does: add a file ---------------
  // `zt4k9qx` is deliberately nonsense — a token no other fixture, test or memory
  // in this repo contains, so a hit can only come from the file written below.
  await new Promise((r) => setTimeout(r, 1100));   // clear the mtime resolution
  writeFileSync(join(store, 'x-stalesess-0004.md'),
    exch(4, 'they must rebuild — the zips were built at zt4k9qx and carry the old KB'));

  const { latest, invalidate } = await import('../lib/search.js');
  invalidate();
  const ask = (q) => latest(q, { scope: 'staging', limit: 5 });

  // ---- MUST-FIND: the incident ---------------------------------------------
  const found = await ask('zt4k9qx');
  check('index reports itself stale after the add', found.indexStale === true,
    `indexStale=${found.indexStale}`);
  check('MUST-FIND: an unindexed term is NOT reported as absent',
    !!found.foundInUnindexed,
    `foundInUnindexed=${JSON.stringify(found.foundInUnindexed || null)} totalMentions=${found.totalMentions}`);
  check('MUST-FIND: it names the file holding the term',
    !!found.foundInUnindexed && JSON.stringify(found.foundInUnindexed).includes('x-stalesess-0004'),
    JSON.stringify(found.foundInUnindexed || null));
  check('MUST-FIND: the correction is in the guidance a reader sees',
    (found.guidance || []).some((g) => /NOT ABSENT — UNINDEXED/.test(g)),
    JSON.stringify(found.guidance || []));

  // ---- MUST-NOT: absence must survive --------------------------------------
  // The whole value of this corpus is that it can say "no". A fix that makes
  // absence unsayable is worse than the bug it fixes.
  const absent = await ask('qq7vv2mz');
  check('MUST-NOT: a genuinely absent term stays absent', !absent.foundInUnindexed,
    `foundInUnindexed=${JSON.stringify(absent.foundInUnindexed || null)}`);
  check('MUST-NOT: absent term still reports zero mentions', (absent.totalMentions || 0) === 0,
    `totalMentions=${absent.totalMentions}`);
  check('MUST-NOT: absent term still names itself unmatchable',
    (absent.unmatchableTerms || []).includes('qq7vv2mz'),
    JSON.stringify(absent.unmatchableTerms || null));

  // ---- MUST-NOT: a current index takes the fast path -----------------------
  await buildIndex({ dir: [{ dir: store, label: 'store', defaultTier: 'archive', primary: false }],
                    out: process.env.MEMORY_STAGING_INDEX });
  invalidate();
  const fresh = await ask('zt4k9qx');
  check('MUST-NOT: a FRESH index does no scan and reports no correction',
    !fresh.foundInUnindexed,
    `foundInUnindexed=${JSON.stringify(fresh.foundInUnindexed || null)} indexStale=${fresh.indexStale}`);
  check('MUST-NOT: once indexed, the term is found normally',
    (fresh.totalMentions || 0) > 0, `totalMentions=${fresh.totalMentions}`);

  // ---- MUST-NOT: the response never grows the full stale list --------------
  check('MUST-NOT: the internal full stale list never reaches the caller',
    !('_staleScan' in found) && !Object.keys(found).some((k) => k === '_staleScan'),
    Object.keys(found).filter((k) => k.startsWith('_')).join(','));

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });

#!/usr/bin/env node
// test/public/run-public-tests.js — the suite that ships.
//
//     npm run test:full
//
// WHY THIS EXISTS AS A SEPARATE FILE. The project's main suite asserts against the author's own
// memories by name, and the file itself carries real addresses and private IPs because several of
// its tests assert on genuine redaction targets. The release gate refuses it, correctly. Scrubbing
// it would weaken exactly the tests that check redaction, so this is a purpose-built suite over
// committed fixtures instead: everything here runs on a machine that has never seen a real memory.
//
// It asserts CONTRACTS, not corpus statistics. Nothing here depends on how many documents exist, on
// wall-clock time, or on any file outside test/fixtures/ and a temp directory it creates itself.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync,
         symlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const FIXTURES = join(ROOT, 'test', 'fixtures', 'gold-corpus');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function group(t) { console.log(`\n=== ${t} ===`); }

// Every child runs with an isolated everything. A test that can see the developer's real memory
// folder is a test that behaves differently on their machine than in CI.
function sandbox(extra = {}) {
  const d = mkdtempSync(join(tmpdir(), 'recall-public-'));
  mkdirSync(join(d, 'store'), { recursive: true });
  return {
    dir: d,
    env: {
      ...process.env,
      HOME: d,
      MEMORY_DIR: join(d, 'mem'),
      MEMORY_INDEX: join(d, 'curated.json'),
      MEMORY_OWN_STORE: join(d, 'store'),
      MEMORY_STAGING_INDEX: join(d, 'staging.json'),
      MEMORY_HANDOFF_INDEX: '0',
      MEMORY_PROJECTS_INDEX: '0',
      MEMORY_INLINE_REINDEX: '0',
      MEMORY_QUERY_SOURCE: 'test',
      MEMORY_AUTHOR_CORPUS: '0',
      MEMORY_MODEL_CACHE: join(ROOT, '.model-cache'),
      MEMORY_VANISH_LOG: join(d, 'vanish.jsonl'),
      ...extra
    }
  };
}

// Run a snippet in a child process against a sandbox. Returns whatever it prints between @@ markers.
function run(env, body, { cwd = ROOT } = {}) {
  const src = `
    const IDX  = ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'index-store.js')).href)};
    const SRCH = ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'search.js')).href)};
    const TOOL = ${JSON.stringify(pathToFileURL(join(ROOT, 'tools', 'memory.js')).href)};
    const out = (v) => process.stdout.write('@@' + JSON.stringify(v) + '@@');
    const buildIndexOver = async (dir, out2, corpus = 'curated') => {
      const { buildIndex } = await import(IDX);
      return buildIndex({ force: true, dir: [{ dir, corpus, primary: true }], out: out2 });
    };
    const memoryTool = async () => {
      const m = await import(TOOL); const c = new Map();
      m.registerMemoryTools({ tool: (n, d, s, h) => c.set(n, h) });
      return async (args) => { const r = await c.get('memory')(args); return JSON.parse(r.content[0].text); };
    };
    ${body}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src],
    { encoding: 'utf8', env, cwd, maxBuffer: 64 * 1024 * 1024 });
  const m = /@@([\s\S]*)@@/.exec(r.stdout || '');
  if (!m) return { __nores: true, stderr: String(r.stderr || '').slice(0, 240), status: r.status };
  try { return JSON.parse(m[1]); } catch { return { __unparsable: m[1].slice(0, 300) }; }
}

const copyFixtures = (to) => { mkdirSync(to, { recursive: true });
  for (const f of readdirSync(FIXTURES)) if (f.endsWith('.md')) writeFileSync(join(to, f), readFileSync(join(FIXTURES, f))); };

console.log('recall-mcp — public test suite (fixtures only, no author corpus)');

// =============================================================================================
group('retrieval — the contracts a memory server has to keep');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { search } = await import(SRCH);
    const quote = 'Pawls get the light oil, never the thick bearing grease';
    const q1 = await search(quote, { limit: 5 });
    // A direct question whose WORDS THE DOCUMENT USES. A pure paraphrase gets refused at this corpus
    // size — a 16-document vocabulary is thin, that is measured and documented behaviour, and
    // asserting otherwise would make this suite flaky rather than strict.
    const q2 = await search('who is allowed to sign off a bike before it goes on sale', { limit: 5 });
    const q3 = await search('what is the airport parking policy for staff cars', { limit: 5 });
    const a = await search('how do I bleed the brakes', { limit: 5 });
    const b = await search('how do I bleed the brakes', { limit: 5 });
    out({
      quoteTop: (q1.results||[])[0]?.name || null,
      quoteSnippet: (q1.results||[])[0]?.snippet || '',
      questionTop: (q2.results||[])[0]?.name || null,
      absent: !!q3.noStrongMatch,
      absentOffersWeak: ((q3.bestWeak||[]).length > 0),
      deterministic: JSON.stringify(a.results) === JSON.stringify(b.results),
      hasScores: (q2.results||[]).every((x) => typeof x.score === 'number')
    });`);
  check('a verbatim quote returns its own memory first',
    String(r.quoteTop).startsWith('grease-rule-pawls'), JSON.stringify(r).slice(0, 220));
  check('...and the snippet actually carries the quoted words',
    /pawls/i.test(r.quoteSnippet || '') && /oil/i.test(r.quoteSnippet || ''), String(r.quoteSnippet).slice(0, 120));
  check('a natural-language question finds the right memory',
    String(r.questionTop).startsWith('volunteer-onboarding'), String(r.questionTop));
  check('a topic the corpus knows nothing about is REFUSED, not answered', r.absent === true, JSON.stringify(r).slice(0, 200));
  check('...and the refusal still offers the nearest candidates', r.absentOffersWeak === true);
  check('the same query twice returns byte-identical results', r.deterministic === true);
  check('every result carries a numeric score', r.hasScores === true);
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('word order is evidence, not noise');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { search } = await import(SRCH);
    const a = await search('light oil on the pawls', { limit: 4 });
    const b = await search('thick grease in the bearing', { limit: 4 });
    out({ a: (a.results||[]).map(x=>x.name), b: (b.results||[]).map(x=>x.name),
          aScores: (a.results||[]).slice(0,2).map(x=>x.score) });`);
  // Two fixtures use the SAME WORDS IN OPPOSITE ROLES, so only word order can separate them. The
  // assertion is RELATIVE on purpose: a third memory (the bearing grease chart) is a perfectly good
  // answer to either question and legitimately outranks both. Demanding a specific document at rank
  // 1 failed for that reason — and asserting it anyway would have been a test tuned to a wrong
  // expectation. What must hold is that the PAIR is ordered correctly.
  const rankOf = (list, name) => (list || []).findIndex((n) => String(n).startsWith(name));
  const aPawls = rankOf(r.a, 'grease-rule-pawls'), aBear = rankOf(r.a, 'grease-rule-bearing');
  const bPawls = rankOf(r.b, 'grease-rule-pawls'), bBear = rankOf(r.b, 'grease-rule-bearing');
  check('“light oil on the pawls” ranks the pawls rule ABOVE the bearing rule',
    aPawls !== -1 && aBear !== -1 && aPawls < aBear, JSON.stringify(r.a));
  check('“thick grease in the bearing” ranks the bearing rule ABOVE the pawls rule',
    bPawls !== -1 && bBear !== -1 && bBear < bPawls, JSON.stringify(r.b));
  check('...and the two questions genuinely disagree (the order flips)',
    (aPawls < aBear) !== (bPawls < bBear), `a=${JSON.stringify(r.a)} b=${JSON.stringify(r.b)}`);
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('reading a memory — get, sections, and live metadata');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const memory = await memoryTool();
    const full  = await memory({ action: 'get', name: 'brake-bleed-procedure' });
    const brief = await memory({ action: 'get', name: 'brake-bleed-procedure', brief: true });
    const missing = await memory({ action: 'get', name: 'no-such-memory-anywhere' });
    out({ found: full.found !== false, hasBody: typeof full.body === 'string' && full.body.length > 0,
          livePath: typeof full.path === 'string',
          briefIsSmaller: JSON.stringify(brief).length < JSON.stringify(full).length,
          briefKeepsBody: typeof brief.body === 'string' && brief.body.length > 0,
          missingIsHonest: missing.found === false && typeof missing.hint === 'string' });`);
  check('get returns the memory', r.found === true, JSON.stringify(r).slice(0, 200));
  check('get returns its body', r.hasBody === true);
  check('get reports where it read it from', r.livePath === true);
  check('get brief:true is smaller than the full response', r.briefIsSmaller === true);
  check('...but still carries the text', r.briefKeepsBody === true);
  check('an unknown name says so instead of guessing', r.missingIsHonest === true);
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('the corpus boundary — a symlink may not leave it');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const outside = join(sb.dir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'),
    '---\nname: secret\ndescription: outside the configured root\n---\n\nCANARY-OUTSIDE-THE-ROOT.\n');
  try { symlinkSync(join(outside, 'secret.md'), join(sb.env.MEMORY_DIR, 'leak.md')); } catch { /* platform */ }
  try { symlinkSync(outside, join(sb.env.MEMORY_DIR, 'outdir')); } catch { /* platform */ }
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(process.env.MEMORY_INDEX, 'utf8');
    const memory = await memoryTool();
    const t1 = await memory({ action: 'get', name: '../../etc/passwd' });
    const t2 = await memory({ action: 'get', name: '/etc/passwd' });
    out({ leaked: raw.includes('CANARY-OUTSIDE-THE-ROOT'),
          traversed: (JSON.stringify(t1) + JSON.stringify(t2)).includes('root:x:'),
          t1Found: t1.found, t2Found: t2.found });`);
  check('a symlink pointing outside the memory root is not read', r.leaked === false, JSON.stringify(r).slice(0, 200));
  check('a traversal path in get() does not escape', r.traversed === false);
  check('...and it refuses rather than throwing', r.t1Found === false && r.t2Found === false, JSON.stringify(r));
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('line endings and encodings — the historically worst area');
{
  const sb = sandbox();
  const dir = sb.env.MEMORY_DIR; mkdirSync(dir, { recursive: true });
  const LF = '---\nname: NAME\ndescription: a note about wheel truing and spoke tension\nmetadata:\n  type: project\n---\n\n## First heading\n\nThe rim runs true at last.\n\n## Second heading\n\nSpoke tension matters.\n';
  const mk = (n, t) => writeFileSync(join(dir, n + '.md'), t.replace(/NAME/g, n));
  mk('plain_lf', LF);
  mk('crlf', LF.replace(/\n/g, '\r\n'));
  mk('bom', '﻿' + LF);
  mk('mixed', LF.split('\n').map((l, i) => (i % 2 ? l + '\r\n' : l + '\n')).join(''));
  mk('unicode', LF.replace('a note about', 'a 📊 note with accents café and CJK 記録 about'));
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync } = await import('node:fs');
    const idx = JSON.parse(readFileSync(process.env.MEMORY_INDEX, 'utf8'));
    const docs = idx.docs || idx.documents || [];
    const pick = (n) => docs.find((d) => (d.file || '').includes(n + '.md')) || {};
    const rep = {};
    for (const n of ['plain_lf','crlf','bom','mixed','unicode']) {
      const d = pick(n);
      rep[n] = { name: d.name, hasDesc: !!d.description, type: d.type,
                 headings: (d.headings || []).length, fm: d.hasFrontmatter };
    }
    rep.replacementChar = JSON.stringify(docs).includes('\\uFFFD');
    out(rep);`);
  for (const kind of ['crlf', 'bom', 'mixed', 'unicode']) {
    const d = r[kind] || {};
    check(`${kind}: frontmatter parses (name, description, type)`,
      d.name === kind && d.hasDesc === true && d.type === 'project', JSON.stringify(d));
    check(`${kind}: headings survive`, d.headings === 2, JSON.stringify(d));
  }
  check('no U+FFFD replacement characters are introduced', r.replacementChar === false);
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('the index is a cache of a directory, and knows it');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    const { buildIndex } = await import(IDX);
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { readFileSync, writeFileSync } = await import('node:fs');
    const before = JSON.parse(readFileSync(process.env.MEMORY_INDEX, 'utf8'));
    const beforeCount = (before.docs || before.documents || []).length;

    // GUARD 1: an empty root list must never be read as "erase the index".
    let emptyRefused = false;
    try { await buildIndex({ force: true, dir: [], out: process.env.MEMORY_INDEX }); }
    catch { emptyRefused = true; }
    const afterEmpty = JSON.parse(readFileSync(process.env.MEMORY_INDEX, 'utf8'));

    // GUARD 2: a root that does not exist is a misconfiguration, and is REPORTED.
    const rep = await buildIndex({ force: true, out: process.env.MEMORY_INDEX + '.probe',
      dir: [{ dir: process.env.MEMORY_DIR + '-does-not-exist', corpus: 'curated', primary: true }] });

    out({ beforeCount, emptyRefused,
          survivedEmpty: (afterEmpty.docs || afterEmpty.documents || []).length,
          missingRoots: (rep.missingRoots || []).length,
          missingIndexed: rep.filesIndexed });`);
  check('the fixture corpus indexes', r.beforeCount === 16, `got ${r.beforeCount}`);
  check('an EMPTY root list is refused, not treated as "index nothing"', r.emptyRefused === true);
  check('...and the existing index is left intact', r.survivedEmpty === r.beforeCount,
    `${r.survivedEmpty} vs ${r.beforeCount}`);
  check('a root that does not exist is REPORTED, not silently empty', r.missingRoots === 1,
    JSON.stringify(r));
  check('...and it indexed nothing from it', r.missingIndexed === 0);
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('a memory that disappears is written down, not just warned about');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    const { buildIndex } = await import(IDX);
    const { unlinkSync, existsSync, readFileSync } = await import('node:fs');
    const roots = [{ dir: process.env.MEMORY_DIR, corpus: 'curated', primary: true }];
    await buildIndex({ dir: roots, out: process.env.MEMORY_INDEX });          // incremental path
    for (const f of ['winter-storage.md', 'workshop-rota.md']) unlinkSync(process.env.MEMORY_DIR + '/' + f);
    await buildIndex({ dir: roots, out: process.env.MEMORY_INDEX });          // the vanish path
    const sink = process.env.MEMORY_VANISH_LOG;
    const rows = existsSync(sink)
      // String.fromCharCode(10) rather than a newline escape: this runs inside an OUTER template
      // literal, which consumes \\n and \\r itself, so the child received a real line break and a
      // SyntaxError. Twice — once as a string escape, once inside a regex.
      ? readFileSync(sink, 'utf8').trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l)) : [];
    const last = rows[rows.length - 1] || {};
    out({ rows: rows.length, vanished: last.vanished, names: last.names || [],
          hasTime: typeof last.at === 'string', prev: last.previousDocs, now: last.currentDocs });`,
    );
  // The warning goes to stderr, which the hook host keeps nowhere. "When did those memories
  // disappear" is asked days later, so the record has to outlive the console.
  check('the disappearance is appended to a durable sink', r.rows === 1, JSON.stringify(r).slice(0, 200));
  check('...naming exactly what went', r.vanished === 2 &&
    ['winter-storage', 'workshop-rota'].every((n) => (r.names || []).includes(n)), JSON.stringify(r.names));
  check('...with a timestamp and the before/after counts',
    r.hasTime === true && r.prev === 16 && r.now === 14, JSON.stringify(r));
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('a server adopts an index another process rebuilt');
{
  const sb = sandbox();
  copyFixtures(sb.env.MEMORY_DIR);
  const r = run(sb.env, `
    await buildIndexOver(process.env.MEMORY_DIR, process.env.MEMORY_INDEX);
    const { search } = await import(SRCH);
    await search('how do I bleed the brakes', { limit: 3 });        // caches the index in THIS process
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.env.MEMORY_DIR + '/late-arrival.md',
      '---\\nname: late-arrival\\ndescription: added after the index was cached\\n---\\n\\nThe KANGAROO procedure is written down here.\\n');
    // ANOTHER process rebuilds — the real shape, because an in-process rebuild clears the cache itself.
    const { spawnSync } = await import('node:child_process');
    spawnSync(process.execPath, ['--input-type=module', '-e',
      "const {buildIndex}=await import(" + JSON.stringify(IDX) + ");" +
      "await buildIndex({force:true,dir:[{dir:process.env.MEMORY_DIR,corpus:'curated',primary:true}],out:process.env.MEMORY_INDEX});"],
      { encoding: 'utf8', env: process.env });
    const after = await search('KANGAROO procedure', { limit: 5 });
    out({ found: (after.results || []).some((x) => x.name === 'late-arrival'),
          reloaded: after.indexReloadedFromDisk === true });`);
  check('a memory indexed by ANOTHER process is found without a restart', r.found === true,
    JSON.stringify(r).slice(0, 200));
  check('...and the response says the index was re-read', r.reloaded === true, JSON.stringify(r));
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('writing to a memory folder — the one guarded door');
{
  const sb = sandbox();
  const dir = sb.env.MEMORY_DIR; mkdirSync(dir, { recursive: true });
  const ORIGINAL = '---\nname: subject\ndescription: a memory to edit\n---\n\nEvery word of this body matters.\n';
  writeFileSync(join(dir, 'subject.md'), ORIGINAL);
  const r = run(sb.env, `
    const SW = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'safe-write.js')).href)});
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const p = process.env.MEMORY_DIR + '/subject.md';
    const original = readFileSync(p, 'utf8');

    // 1. a frontmatter-only edit is allowed, and snapshots the previous bytes
    const ok = SW.rewriteFrontmatterOnly(p, original.replace('description: a memory to edit',
      'description: a memory to edit\\nmetadata:\\n  tier: archive'));
    const snapDir = process.env.MEMORY_DIR + '/' + SW.SNAPSHOT_DIR;
    // 2. an edit that would change the BODY must be refused
    const bad = SW.rewriteFrontmatterOnly(p, original.replace('Every word of this body matters.', 'MANGLED.'));
    // 3. a truncating write must be refused
    const trunc = SW.rewriteFrontmatterOnly(p, original.slice(0, 40));
    out({ wrote: ok.written === true,
          snapshotKept: existsSync(snapDir) && readdirSync(snapDir).length > 0,
          bodyRefused: bad.written !== true,
          truncRefused: trunc.written !== true,
          bodyIntact: SW.bodyOf(readFileSync(p, 'utf8')).trim() === 'Every word of this body matters.',
          snapshotsPerFile: SW.SNAPSHOTS_PER_FILE });`);
  check('a frontmatter-only edit is written', r.wrote === true, JSON.stringify(r).slice(0, 200));
  check('...and the previous bytes are snapshotted first', r.snapshotKept === true);
  check('an edit that would change the BODY is refused', r.bodyRefused === true);
  check('a truncating write is refused', r.truncRefused === true);
  check('the body is byte-identical after all of it', r.bodyIntact === true);
  check('the snapshot count can never be configured below 1', r.snapshotsPerFile >= 1, String(r.snapshotsPerFile));
  rmSync(sb.dir, { recursive: true, force: true });
}

// =============================================================================================
group('read-only mode writes nothing at all');
{
  const mk = (d) => { mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'subject.md'), '---\nname: subject\ndescription: d\n---\n\nBody.\n'); };
  const probe = (readOnly) => {
    const sb = sandbox(readOnly ? { MEMORY_CURATED_READ_ONLY: '1' } : {});
    mk(sb.env.MEMORY_DIR);
    const r = run(sb.env, `
      const { existsSync, readdirSync } = await import('node:fs');
      const memory = await memoryTool();
      const res = await memory({ action: 'demote', name: 'subject' });
      const SW = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'safe-write.js')).href)});
      const snapDir = process.env.MEMORY_DIR + '/' + SW.SNAPSHOT_DIR;
      out({ changed: res.changed === true,
            snapshots: existsSync(snapDir) ? readdirSync(snapDir).length : 0 });`);
    rmSync(sb.dir, { recursive: true, force: true });
    return r;
  };
  const on = probe(false), off = probe(true);
  // The control matters: without it, "nothing changed" proves nothing about read-only mode.
  check('CONTROL: with writes allowed, demote actually changes something', on.changed === true, JSON.stringify(on));
  check('...and snapshots the previous version', on.snapshots > 0, JSON.stringify(on));
  check('MEMORY_CURATED_READ_ONLY=1 refuses the write', off.changed === false, JSON.stringify(off));
  check('...and writes no snapshot either', off.snapshots === 0, JSON.stringify(off));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail ? 1 : 0);

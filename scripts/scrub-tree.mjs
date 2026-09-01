#!/usr/bin/env node
// scrub-tree.mjs — scrub every TEXT file in a staged tree, then PROVE it.
//
// ONE scrubber for anything that leaves this machine. build-zip.sh used to grep for
// one plaintext literal; that is both a weaker check than redact() and the reason the
// literal had to exist in the repo at all. This uses the hash route, so nothing here
// needs to know the secret it is removing.
//
// 🟥 The audit walks EVERY file, not the subset the scrubber chose. An audit that
// shares the scrubber's filter cannot catch a filter that is too narrow — the exact
// defect that shipped 8 unscrubbed files in backup-memory.js's first version.
//
//   node scripts/scrub-tree.mjs <dir> [--report-only]
import { readdirSync, statSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { redact } from '../lib/secrets.js';

const root = process.argv[2];
const REPORT_ONLY = process.argv.includes('--report-only');
if (!root) { console.error('usage: scrub-tree.mjs <dir> [--report-only]'); process.exit(2); }

const isText = (p) => {
  const fd = openSync(p, 'r');
  try { const b = Buffer.alloc(8192); const n = readSync(fd, b, 0, 8192, 0); return !b.subarray(0, n).includes(0); }
  finally { closeSync(fd); }
};

// Vendored deps and model weights are not ours and hold no corpus text; walking
// 284 MB of node_modules would make the check slow enough to get skipped.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.model-cache']);

// 🟥 FILES THAT ARE *ABOUT* CREDENTIALS, NOT FILES THAT CONTAIN ONE.
// secrets-exclude.json IS the detector's policy — its regexes are credential-shaped by
// definition, and scrubbing them ships a NEUTERED DETECTOR to whoever opens the zip.
// The test fixtures are synthetic strings whose whole job is to be redacted; scrubbing
// them turns the test into "[REDACTED] contains [REDACTED]", which passes while proving
// nothing. Blanket-scrubbing these DEGRADES the product without removing any secret.
//
// This is an exemption, so it is the dangerous kind of rule. It is therefore NOT a pass:
// these files are still checked by the HASH route, which recognises the actual known
// literals. Shaped-like-a-credential is allowed here; IS-a-known-credential never is.
const SHAPED_OK = new Set([
  'secrets-exclude.json',
  'test/run-tests.js',
  'test/scrub-rule-text-preregistration.md',
  'test/backup-memory-preregistration.md',
]);

let scrubbed = 0, scanned = 0;
const names = new Set(), files = [], exempt = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(e)) walk(p); continue; }
    if (st.size > 8e6) continue;                       // model weights, caches
    let text; try { text = readFileSync(p, isText(p) ? 'utf8' : 'latin1'); } catch { continue; }
    scanned++;
    const r = redact(text);
    if (!r.hits || !r.hits.length) continue;
    const rel = relative(root, p);
    if (SHAPED_OK.has(rel)) {
      // The hash route still applies — a REAL known credential in one of these is a leak.
      if (r.hits.includes('known-literal')) {
        files.push(rel + ' :: known-literal (A REAL SECRET, not a pattern — refusing)');
        names.add('known-literal');
      } else exempt.push(rel);
      continue;
    }
    files.push(rel + ' :: ' + [...new Set(r.hits)].join(','));
    r.hits.forEach((h) => names.add(h));
    if (!REPORT_ONLY && isText(p)) { writeFileSync(p, r.text); scrubbed++; }
  }
};
walk(root);

if (REPORT_ONLY) {
  console.log(`   audit: ${scanned} files scanned, ${files.length} still carry credential patterns` +
    (exempt.length ? `; ${exempt.length} pattern-definition file(s) exempt but hash-checked (${exempt.join(', ')})` : ''));
  files.slice(0, 20).forEach((f) => console.log('     ' + f));
  process.exit(files.length ? 3 : 0);
}
console.log(`   scrubbed ${scrubbed} of ${scanned} file(s)` + (names.size ? ` (${[...names].join(', ')})` : ' — nothing matched') +
  (exempt.length ? `\n   exempt (pattern definitions, hash-checked): ${exempt.join(', ')}` : ''));
files.slice(0, 20).forEach((f) => console.log('     ' + f.split(' :: ')[0]));

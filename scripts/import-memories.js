#!/usr/bin/env node
// scripts/import-memories.js — bring someone else's memories in.
//
// This server was built for one person's software project. The friend who tries it
// next may be planning a novel, or a business, and their history may live in a
// ChatGPT export rather than a Claude transcript. None of that should require them
// to understand corpora, indexes or frontmatter.
//
//   node scripts/import-memories.js <path> [--dry] [--domain writing] [--name mine]
//
// <path> may be:
//   * a ChatGPT export .zip or its conversations.json
//   * a folder of .md / .txt notes (Obsidian, Notion export, plain files)
//   * a single .md / .txt file
//
// What it does, in order: detect the shape, convert each conversation or note into
// one memory document, DERIVE what kind of corpus it is, then tell the user the two
// commands that finish the job. --dry changes nothing and prints the same report,
// because the first thing anyone should be able to do with an importer is see what
// it WOULD do.
//
// Design rules this follows, each learned the hard way in this repo:
//   * never write outside the memory root
//   * never overwrite an existing memory (a re-run is safe)
//   * skip nothing silently — every skipped item is counted and named
//   * a credential-shaped line is refused, not imported (see lib/secrets.js policy)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryDir } from '../lib/config.js';
import { deriveProfile } from '../lib/corpus-profile.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const argOf = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const SRC = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--domain'
  && args[args.indexOf(a) - 1] !== '--name' && args[args.indexOf(a) - 1] !== '--out');
const DOMAIN = argOf('--domain');
const PREFIX = (argOf('--name') || 'imported').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
const OUT = argOf('--out') || memoryDir();

if (!SRC) {
  console.error('usage: node scripts/import-memories.js <path-to-export-or-folder> [--dry] [--domain writing] [--name mine]');
  process.exit(2);
}

const slug = (s, n = 60) => String(s || 'untitled').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'untitled';

// Refuse to import a credential. Same shapes lib/git-join.js and the memory
// versioning guard use — a plaintext secret in a corpus is permanent in a way its
// author rarely intends.
const SECRET_RES = [/sshpass\s+-p\s+'[^']+'/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/,
                    /\b(api[_-]?key|password|secret)\s*[:=]\s*['"][^'"]{12,}['"]/i];
const looksSecret = (t) => SECRET_RES.some((re) => re.test(t));

// ---- readers ---------------------------------------------------------------

/** ChatGPT export: conversations.json is an array; each has a `mapping` TREE. */
function readChatGpt(jsonPath) {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const convos = Array.isArray(raw) ? raw : (raw.conversations || []);
  const out = [];
  for (const c of convos) {
    const mapping = c.mapping || {};
    // Walk the tree in create_time order rather than trusting insertion order —
    // a branched conversation has no single linear list.
    const msgs = Object.values(mapping)
      .map((n) => n && n.message)
      .filter((m) => m && m.content)
      .filter((m) => !m.author || m.author.role !== 'system')
      .map((m) => ({
        role: (m.author && m.author.role) || 'unknown',
        time: m.create_time || 0,
        text: Array.isArray(m.content.parts)
          ? m.content.parts.filter((p) => typeof p === 'string').join('\n')
          : (typeof m.content === 'string' ? m.content : '')
      }))
      .filter((m) => m.text && m.text.trim())
      .sort((a, b) => (a.time || 0) - (b.time || 0));
    if (!msgs.length) continue;
    out.push({
      title: c.title || 'untitled conversation',
      when: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
      body: msgs.map((m) => `**${m.role === 'user' ? 'Asked' : 'Answered'}:** ${m.text.trim()}`).join('\n\n')
    });
  }
  return out;
}

/** A folder (or single file) of .md / .txt notes. */
function readNotes(p) {
  const st = statSync(p);
  const files = st.isDirectory()
    ? readdirSync(p).filter((f) => /\.(md|txt|markdown)$/i.test(f)).map((f) => join(p, f))
    : [p];
  return files.map((f) => {
    const text = readFileSync(f, 'utf8');
    // If it already has frontmatter, keep the body and let the title come from the
    // filename — re-wrapping someone's YAML in more YAML helps nobody.
    const parts = text.split('---');
    const body = (text.trimStart().startsWith('---') && parts.length > 2) ? parts.slice(2).join('---') : text;
    const h1 = body.match(/^#\s+(.+)$/m);
    return {
      title: (h1 && h1[1].trim()) || basename(f, extname(f)).replace(/[-_]+/g, ' '),
      when: (() => { try { return new Date(statSync(f).mtimeMs).toISOString(); } catch { return null; } })(),
      body: body.trim()
    };
  });
}

// ---- detect ----------------------------------------------------------------

const src = resolve(SRC);
if (!existsSync(src)) { console.error(`no such path: ${src}`); process.exit(2); }

let items = [];
let shape = '';
if (/\.zip$/i.test(src)) {
  // Unzip to a temp dir and look for conversations.json.
  const tmp = join(tmpdir(), `mem-import-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try { execFileSync('unzip', ['-q', '-o', src, '-d', tmp]); }
  catch (e) { console.error('could not unzip that file: ' + e.message); process.exit(2); }
  const conv = join(tmp, 'conversations.json');
  if (!existsSync(conv)) { console.error('that zip has no conversations.json — is it a ChatGPT export?'); process.exit(2); }
  items = readChatGpt(conv); shape = 'ChatGPT export (zip)';
} else if (/conversations\.json$/i.test(src)) {
  items = readChatGpt(src); shape = 'ChatGPT export (conversations.json)';
} else if (/\.json$/i.test(src)) {
  try { items = readChatGpt(src); shape = 'JSON export'; }
  catch (e) { console.error('that JSON is not a shape I recognise: ' + e.message); process.exit(2); }
} else {
  items = readNotes(src); shape = statSync(src).isDirectory() ? 'folder of notes' : 'single note';
}

// ---- report + write --------------------------------------------------------

console.log(`\nsource   : ${src}`);
console.log(`shape    : ${shape}`);
console.log(`found    : ${items.length} item(s)`);

const skipped = { empty: 0, secret: [], exists: [] };
const written = [];
const profileInput = [];

// A dry run must change NOTHING, not even an empty directory.
if (!DRY) mkdirSync(OUT, { recursive: true });
let n = 0;
for (const it of items) {
  const text = (it.body || '').trim();
  if (text.length < 40) { skipped.empty++; continue; }
  if (looksSecret(text)) { skipped.secret.push(it.title); continue; }
  n++;
  const name = `${PREFIX}-${String(n).padStart(4, '0')}-${slug(it.title, 48)}`;
  const file = join(OUT, `${name}.md`);
  if (existsSync(file)) { skipped.exists.push(name); continue; }
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(it.title).slice(0, 300)}`,
    'metadata:',
    '  type: imported',
    `  importedFrom: ${JSON.stringify(shape)}`,
    it.when ? `  originalDate: ${it.when}` : null,
    DOMAIN ? `  domain: ${DOMAIN}` : null,
    '---'
    // NOTE: no trailing '' here — .filter(Boolean) would drop it, which is exactly
    // how the first version emitted "---# Title" on one line. The blank line is
    // added explicitly below instead.
  ].filter(Boolean).join('\n');
  profileInput.push({ bodyText: text });
  if (!DRY) writeFileSync(file, `${fm}\n\n# ${it.title}\n\n${text}\n`, 'utf8');
  written.push(name);
}

console.log(`written  : ${DRY ? '(dry run — nothing written) ' : ''}${written.length}`);
if (skipped.empty) console.log(`skipped  : ${skipped.empty} too short to be useful`);
if (skipped.secret.length) {
  console.log(`REFUSED  : ${skipped.secret.length} item(s) contain a credential and were NOT imported:`);
  for (const t of skipped.secret.slice(0, 5)) console.log(`             ${JSON.stringify(t)}`);
  console.log('           A plaintext secret in a memory corpus is permanent in a way its author rarely intends.');
}
if (skipped.exists.length) console.log(`skipped  : ${skipped.exists.length} already imported (re-running is safe)`);

const profile = deriveProfile(profileInput, { override: DOMAIN });
console.log(`\ndomain   : ${profile.domain}  (confidence ${profile.confidence}${profile.overridden ? ', you set it' : ', derived by counting'})`);
console.log(`           ${profile.note}`);
if (!DOMAIN && profile.domain !== 'code') {
  console.log('           Counting can only tell code from not-code. If these are notes for a book, a');
  console.log('           business or a research project, re-run with --domain writing|business|research');
  console.log('           (or pass domain: on each query) to get advice written for that work.');
}

// ── finish the job ──────────────────────────────────────────────────────────
//
// Indexing and a first curation pass are not optional extras — an imported corpus
// that has not been indexed is not searchable, and telling a non-coder to "now run
// two more commands" is exactly the step where an import gets abandoned half done.
// So import DOES them, and --no-curate exists for the person who wants to stage the
// files and decide later.
// Auto-curating only makes sense when the files landed where the indexer looks.
// With a custom --out they have not, and running build-index would rebuild the
// REAL corpus while silently leaving the imported one unsearchable — a confident
// "done" over work that did not happen.
const OUT_IS_MEMORY_DIR = resolve(OUT) === resolve(memoryDir());
const CURATE = !args.includes('--no-curate') && OUT_IS_MEMORY_DIR;

console.log('');
if (DRY) {
  console.log('next: re-run without --dry to actually import.\n');
} else if (!written.length) {
  console.log('next: nothing new was imported, so there is nothing to index.\n');
} else if (!CURATE) {
  console.log(OUT_IS_MEMORY_DIR
    ? 'next (you passed --no-curate):'
    : `next (--out is not the memory folder, so indexing it here would not help):`);
  console.log('  1. node scripts/build-index.js          # make them searchable');
  console.log('  2. node scripts/dream.js --force        # first curation pass\n');
} else {
  const run = (label, file, argv) => {
    process.stdout.write(`  ${label} … `);
    try {
      execFileSync(process.execPath, [join(import.meta.dirname, file), ...argv],
        { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
      console.log('done');
      return true;
    } catch (e) {
      // Never fail the IMPORT because a follow-up step failed — the memories are
      // already written and are the thing that matters.
      console.log('FAILED (the memories are imported; run it yourself)');
      console.log(`     ${String(e.message || e).split('\n')[0].slice(0, 120)}`);
      return false;
    }
  };
  console.log('finishing up:');
  const indexed = run('indexing so they are searchable', 'build-index.js', []);
  if (indexed) run('first curation pass (dream)', 'dream.js', ['--force']);
  console.log('');
  console.log('Now ask Claude something you know is in there, and check it comes back.');
  console.log('If the answer looks wrong, open Edit Alignment on the corpus profile: pass');
  console.log('domain: on a query, or re-import with --domain, and ask again.\n');
}

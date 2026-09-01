// lib/import-sources.js — turn somebody else's files into memory documents.
//
// ONE implementation, shared by the CLI (scripts/import-memories.js) and the MCP
// `import` action. Two copies of a reader is how the trace endpoint ended up five
// fixes behind the scorer it was supposed to explain, so there is exactly one here.
//
// FORMAT SUPPORT COSTS NO NEW DEPENDENCIES. macOS ships `textutil` (rtf, doc,
// docx, odt, html) and most machines have `pdftotext`; `unzip` handles archives.
// Where a converter is missing the file is REFUSED BY NAME with the reason, never
// imported as the binary garbage that would otherwise land in the corpus and
// poison every search that touches it.

import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const has = (bin) => {
  try { execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: '/bin/bash' }); return true; }
  catch { return false; }
};
const TOOLS = { textutil: has('textutil'), pdftotext: has('pdftotext'), unzip: has('unzip') };

export function converterReport() {
  return {
    textutil: TOOLS.textutil, pdftotext: TOOLS.pdftotext, unzip: TOOLS.unzip,
    note: 'Formats needing a converter that is missing are refused by name, never imported as binary.'
  };
}

const PLAIN = new Set(['.md', '.markdown', '.txt', '.text', '.log']);
const VIA_TEXTUTIL = new Set(['.rtf', '.rtfd', '.doc', '.docx', '.odt', '.html', '.htm', '.webarchive']);
const TABULAR = new Set(['.csv', '.tsv']);

export function supportedExtensions() {
  return [...PLAIN, ...VIA_TEXTUTIL, ...TABULAR, '.pdf', '.json', '.zip'].sort();
}

function runCapture(bin, argv) {
  return execFileSync(bin, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// ---- STRUCTURE RECOVERY ----------------------------------------------------
// The section-doc splitter (lib/section-docs.js) chapters any document with
// >= 20 KB and >= 3 `##` headings — which means the whole "make a book
// retrievable" problem reduces to RECOVERING `##` LINES the source format
// already implies. Measured winner per the plan's research: structure-aware
// beats fixed and semantic chunking for manuals, and the anchors double as
// citations ("## p.37" is a page a human can open).

/**
 * pdftotext emits form-feed (\f) page breaks. Convert them to `## p.N`
 * headings so a PDF arrives pre-chaptered with PAGE-ANCHORED provenance —
 * N is the physical page index, so a citation can be checked against the
 * actual PDF. A single-page extraction is returned untouched.
 */
export function pdfPagesToHeadings(text) {
  const pages = String(text || '').split('\f');
  if (pages.length < 2) return String(text || '');

  // RUNNING HEADERS ARE NOISE, NOT CONTENT. pdftotext repeats the page header
  // ("ACME-x73A User Guide") and footer on every page, which hands every page
  // section the same high-frequency terms — measured: the model name appeared
  // on all 68 pages of a real manual, so the one page that actually ANSWERS a
  // model-name question had no lexical edge over the 67 that merely carry the
  // header. Detection is positional and conservative: an exact line repeated in
  // the FIRST or LAST two lines of more than half the pages is a running
  // header/footer and is dropped everywhere; body text never repeats like that.
  const trimmedPages = pages.map((p) => p.split('\n').map((l) => l.trim()));
  const edgeCounts = new Map();
  let nonEmptyPages = 0;
  for (const lines of trimmedPages) {
    const body = lines.filter(Boolean);
    if (!body.length) continue;
    nonEmptyPages++;
    for (const l of new Set([...body.slice(0, 2), ...body.slice(-2)])) {
      if (l.length > 80) continue;
      edgeCounts.set(l, (edgeCounts.get(l) || 0) + 1);
    }
  }
  const running = new Set([...edgeCounts.entries()]
    .filter(([, n]) => nonEmptyPages >= 4 && n > nonEmptyPages / 2)
    .map(([l]) => l));

  const out = [];
  pages.forEach((page, i) => {
    const kept = page.split('\n').filter((l) => !running.has(l.trim()));
    const t = kept.join('\n').trim();
    if (!t) return;                       // a blank page earns no heading, but keeps its number
    out.push(`## p.${i + 1}\n\n${t}`);
  });
  return out.join('\n\n');
}

/**
 * A plain-text book has structure too — Gutenberg texts carry `CHAPTER 12.` /
 * `Chapter IV.` lines — it is just not spelled `##`. Promote those lines,
 * CONSERVATIVELY: only short bare lines matching the chapter shapes, only in a
 * document that has no markdown headings of its own, and only when at least 3
 * promotions result (the splitter needs 3, and one or two "matches" in a
 * document are likelier to be false positives than a table of contents).
 */
const CHAPTER_LINE_RE = /^\s{0,3}((?:CHAPTER|Chapter|BOOK|Book|PART|Part|VOLUME|Volume|ACT|Canto)\s+(?:[0-9]+|[IVXLCDM]+|[A-Z][a-z]+)\b\.?[^\n]{0,60})\s*$/;
export function promoteChapterHeadings(text) {
  const src = String(text || '');
  if (/^##?#?\s+\S/m.test(src)) return src;          // real markdown headings win
  const lines = src.split('\n');
  // A designator that appears TWICE is a table of contents plus the chapter
  // itself. Promote only the LAST occurrence: promoting both turned Gutenberg's
  // ToC into 135 sub-200-byte sections (harmlessly filtered) PLUS one junk
  // section anchored on the final ToC line that swallowed the whole front
  // matter under the wrong chapter's name. The ToC stays plain text; the front
  // matter stays with the document head, where it belongs.
  const designator = (m) => m[1].match(/^\S+\s+\S+/)[0].replace(/\.$/, '').toUpperCase();
  const lastIndex = new Map();
  lines.forEach((line, i) => {
    const m = CHAPTER_LINE_RE.exec(line);
    if (m) lastIndex.set(designator(m), i);
  });
  let hits = 0;
  const promoted = lines.map((line, i) => {
    const m = CHAPTER_LINE_RE.exec(line);
    if (!m || lastIndex.get(designator(m)) !== i) return line;
    hits++;
    return `## ${m[1].trim()}`;
  });
  return hits >= 3 ? promoted.join('\n') : src;
}

/**
 * Minimal HTML -> markdown-ish text: <h1>-<h6> become #-headings (the whole
 * point — textutil's txt conversion flattens headings into indistinguishable
 * lines), block elements become paragraph breaks, everything else is stripped,
 * basic entities decoded. Not a general HTML parser and not trying to be one.
 */
export function htmlToMarkdownish(html) {
  let t = String(html || '');
  t = t.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`);
  t = t.replace(/<\/(p|div|li|tr|table|ul|ol|blockquote|section|article)>/gi, '\n\n');
  t = t.replace(/<(br|hr)\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'");
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Text of one file, or { skip: reason } — never binary, never a guess. */
export function textOf(file, { structure = false } = {}) {
  const ext = extname(file).toLowerCase();
  try {
    if (PLAIN.has(ext)) {
      const text = readFileSync(file, 'utf8');
      // Chapter promotion is opt-in (category imports): a three-line curated
      // note must never come back rewritten because a word matched a regex.
      return { text: structure ? promoteChapterHeadings(text) : text };
    }
    if (TABULAR.has(ext)) {
      // A spreadsheet of notes is still notes. Keep it as text rather than
      // inventing a row-to-memory mapping nobody asked for.
      return { text: readFileSync(file, 'utf8') };
    }
    if (ext === '.html' || ext === '.htm') {
      // The headings are RIGHT THERE in the source; going through textutil's
      // txt conversion erases them. Structure mode reads the file directly.
      if (structure) {
        const md = htmlToMarkdownish(readFileSync(file, 'utf8'));
        if (md.length > 40) return { text: md };
      }
      if (!TOOLS.textutil) return { skip: `needs textutil (macOS) to read ${ext}` };
      return { text: runCapture('textutil', ['-convert', 'txt', '-stdout', file]) };
    }
    if (VIA_TEXTUTIL.has(ext)) {
      if (!TOOLS.textutil) return { skip: `needs textutil (macOS) to read ${ext}` };
      if (structure) {
        // docx/odt/rtf keep their heading levels through the HTML conversion
        // and lose them through txt — recover them, and fall back to txt when
        // the document yields nothing that way.
        try {
          const md = htmlToMarkdownish(runCapture('textutil', ['-convert', 'html', '-stdout', file]));
          if (md.length > 40) return { text: md };
        } catch (_) { /* fall through to the txt path */ }
      }
      return { text: runCapture('textutil', ['-convert', 'txt', '-stdout', file]) };
    }
    if (ext === '.pdf') {
      if (!TOOLS.pdftotext) return { skip: 'needs pdftotext to read .pdf — convert it first, or install poppler' };
      // Page headings are NOT gated on structure mode: a form feed in a memory
      // body is garbage in every destination, and `## p.N` is the provenance
      // a PDF citation needs anywhere it lands.
      return { text: pdfPagesToHeadings(runCapture('pdftotext', ['-q', file, '-'])) };
    }
    return { skip: `unsupported format ${ext || '(no extension)'}` };
  } catch (e) {
    return { skip: `could not read: ${String(e.message || e).split('\n')[0].slice(0, 80)}` };
  }
}

/** ChatGPT export: conversations.json is an array; each has a `mapping` TREE. */
export function readChatGptExport(jsonPath) {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const convos = Array.isArray(raw) ? raw : (raw.conversations || []);
  const out = [];
  for (const c of convos) {
    const mapping = c.mapping || {};
    // Ordered by create_time, not insertion order: a branched conversation has no
    // single linear list, and the tree is the only thing that knows the sequence.
    const msgs = Object.values(mapping)
      .map((nd) => nd && nd.message)
      .filter((m) => m && m.content && (!m.author || m.author.role !== 'system'))
      .map((m) => ({
        role: (m.author && m.author.role) || 'unknown',
        time: m.create_time || 0,
        text: Array.isArray(m.content.parts)
          ? m.content.parts.filter((x) => typeof x === 'string').join('\n')
          : (typeof m.content === 'string' ? m.content : '')
      }))
      .filter((m) => m.text && m.text.trim())
      .sort((a, b) => (a.time || 0) - (b.time || 0));
    if (!msgs.length) continue;
    out.push({
      title: c.title || 'untitled conversation',
      when: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
      body: msgs.map((m) => `**${m.role === 'user' ? 'Asked' : 'Answered'}:** ${m.text.trim()}`).join('\n\n'),
      source: 'chatgpt'
    });
  }
  return out;
}

// A raw-text file over 5 MB is a data dump, not notes. A CONVERTER format gets
// a far higher bar because its on-disk size is binary, not text: a 15 MB
// hardware-manual PDF extracts to well under 2 MB of text, and refusing it by
// the binary size was exactly how the first manual import failed.
const PLAIN_SIZE_CAP = 5 * 1024 * 1024;
const BINARY_SIZE_CAP = 64 * 1024 * 1024;
const sizeCapFor = (ext) => (PLAIN.has(ext) || TABULAR.has(ext) ? PLAIN_SIZE_CAP : BINARY_SIZE_CAP);

/** Anything else: walk a folder (recursively) or read one file. */
export function readFilesAt(p, { maxDepth = 4, structure = false } = {}) {
  const items = [];
  const skipped = [];
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;                       // .git, .DS_Store, dotfiles
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (depth < maxDepth) walk(full, depth + 1); continue; }
      const cap = sizeCapFor(extname(full).toLowerCase());
      if (st.size > cap) { skipped.push({ file: e, why: `over ${Math.round(cap / 1024 / 1024)} MB` }); continue; }
      const r = textOf(full, { structure });
      if (r.skip) { skipped.push({ file: e, why: r.skip }); continue; }
      const text = (r.text || '').trim();
      if (!text) { skipped.push({ file: e, why: 'no readable text' }); continue; }
      const h1 = text.match(/^#\s+(.+)$/m);
      items.push({
        title: (h1 && h1[1].trim()) || basename(full, extname(full)).replace(/[-_]+/g, ' '),
        when: new Date(st.mtimeMs).toISOString(),
        body: text,
        source: extname(full).toLowerCase().replace('.', '') || 'file',
        sourcePath: full,
        bytes: st.size
      });
    }
  };
  const st = statSync(p);
  if (st.isDirectory()) walk(p, 0);
  else {
    const r = textOf(p, { structure });
    if (r.skip) skipped.push({ file: basename(p), why: r.skip });
    else {
      const text = (r.text || '').trim();
      const h1 = text.match(/^#\s+(.+)$/m);
      items.push({ title: (h1 && h1[1].trim()) || basename(p, extname(p)).replace(/[-_]+/g, ' '),
                   when: new Date(st.mtimeMs).toISOString(), body: text,
                   source: extname(p).toLowerCase().replace('.', '') || 'file',
                   sourcePath: p, bytes: st.size });
    }
  }
  return { items, skipped };
}

/** Detect what a path is and read it. Returns { shape, items, skipped }. */
export function readSource(p, opts = {}) {
  const st = statSync(p);
  const ext = extname(p).toLowerCase();

  if (!st.isDirectory() && ext === '.zip') {
    if (!TOOLS.unzip) return { shape: 'zip', items: [], skipped: [{ file: basename(p), why: 'needs unzip' }] };
    const tmp = mkdtempSync(join(tmpdir(), 'mem-import-'));
    try { execFileSync('unzip', ['-q', '-o', p, '-d', tmp], { stdio: 'ignore' }); }
    catch (e) { return { shape: 'zip', items: [], skipped: [{ file: basename(p), why: 'could not unzip: ' + e.message }] }; }
    const conv = join(tmp, 'conversations.json');
    if (existsSync(conv)) return { shape: 'ChatGPT export (zip)', items: readChatGptExport(conv), skipped: [] };
    const r = readFilesAt(tmp, opts);
    return { shape: 'zip of files', ...r };
  }

  if (!st.isDirectory() && ext === '.json') {
    // conversations.json, or any JSON we can recognise as an export.
    try {
      const items = readChatGptExport(p);
      if (items.length) return { shape: 'ChatGPT export (conversations.json)', items, skipped: [] };
    } catch { /* fall through and treat it as a text file */ }
    const r = readFilesAt(p, opts);
    return { shape: 'JSON (read as text — not a recognised export)', ...r };
  }

  const r = readFilesAt(p, opts);
  return { shape: st.isDirectory() ? 'folder of files' : 'single file', ...r };
}

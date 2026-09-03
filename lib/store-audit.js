// lib/store-audit.js — does the store agree with the transcripts it was extracted from?
//
// Built after a night in which 19 duplicate memories and one deleted real one sat in the store with
// nothing reporting either (MEM-20/21). For every session whose transcript is still on disk, the
// extractor is run into a scratch store and the two sets of files are compared:
//
//   missing         an exchange the extractor yields today has no file in the store
//                   (expected for a live session: the in-flight exchange, or growth since capture)
//   orphan          a file of the session that the extractor does not yield (a stale tail)
//   duplicate-body  two files of one session with the same body
//   order           file order (name) disagrees with ask-time order (ts)
//   dangling-prev   a Previous: link whose target is not in the store
//   no-session      a store file with no sessionId in frontmatter
//
// Read-only. The scratch extraction runs with MEMORY_GIT_REPOS='' and --backfill so it neither
// hits git nor stamps an account. Used as a GATE on fixtures and an ADVISORY on the live store
// (test/run-tests.js a69), and from `npm run audit:store`.
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NAME = /^x-([^-]+)-(.+)\.md$/;
const headOf = (raw) => raw.slice(0, raw.indexOf('\n---', 4) + 1 || 4000);
const field = (raw, key) => (new RegExp(`^  ${key}: (.+)$`, 'm').exec(headOf(raw)) || [])[1]?.trim() || null;
const bodyOf = (raw) => { const i = raw.indexOf('\n---', 4); return i === -1 ? raw : raw.slice(i + 4).replace(/\nPrevious: \[\[[^\]]+\]\]\n?$/, '').trim(); };

function defaultTranscriptDirs() {
  const root = join(homedir(), '.claude', 'projects');
  try { return readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(d)); } catch { return []; }
}

function findTranscript(sessionId, dirs) {
  for (const d of dirs) { const p = join(d, `${sessionId}.jsonl`); if (existsSync(p)) return p; }
  return null;
}

/**
 * @param {object} o
 * @param {string} o.storeDir
 * @param {string[]|null} o.transcriptDirs   null = every ~/.claude/projects/<dir>
 * @param {string} o.extractor               path to scripts/ingest-transcript.js
 * @param {number} [o.maxSessions]           audit only the N most recently modified sessions
 * @returns {{ sessions: number, skipped: number, problems: Array<{kind:string, session:string, file?:string, name?:string, detail?:string}> }}
 */
export function audit({ storeDir, transcriptDirs, extractor, maxSessions = Infinity }) {
  const dirs = transcriptDirs || defaultTranscriptDirs();
  const problems = [];
  const bySession = new Map();     // sessionId -> [{ file, name, ts, raw }]
  for (const f of readdirSync(storeDir)) {
    if (!NAME.test(f)) continue;
    const raw = readFileSync(join(storeDir, f), 'utf8');
    const sessionId = field(raw, 'sessionId');
    if (!sessionId) { problems.push({ kind: 'no-session', session: '?', file: f }); continue; }
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push({ file: f, name: basename(f, '.md'), ts: field(raw, 'ts'), raw, mtime: statSync(join(storeDir, f)).mtimeMs });
  }
  const allNames = new Set([...bySession.values()].flat().map((e) => e.name));

  // Most recently touched sessions first, so a capped audit looks at what is live.
  const order = [...bySession.entries()].sort((a, b) => Math.max(...b[1].map((e) => e.mtime)) - Math.max(...a[1].map((e) => e.mtime)));
  let sessions = 0, skipped = 0;
  for (const [sessionId, files] of order) {
    if (sessions >= maxSessions) break;
    const tx = findTranscript(sessionId, dirs);
    if (!tx) { skipped++; continue; }
    sessions++;

    // S3 duplicate bodies, S4 order, S5 dangling Previous -- from the store alone.
    const seen = new Map();
    for (const e of files) {
      const h = createHash('sha256').update(bodyOf(e.raw)).digest('hex');
      if (seen.has(h)) problems.push({ kind: 'duplicate-body', session: sessionId, file: e.file, detail: `same body as ${seen.get(h)}` });
      else seen.set(h, e.file);
      const m = /^Previous: \[\[([^\]]+)\]\]$/m.exec(e.raw);
      if (m && !allNames.has(m[1])) problems.push({ kind: 'dangling-prev', session: sessionId, file: e.file, detail: m[1] });
    }
    const byName = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const byTs = [...files].filter((e) => e.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (byTs.length === files.length) {
      for (let i = 0; i < files.length; i++) if (byName[i] !== byTs[i]) { problems.push({ kind: 'order', session: sessionId, file: byName[i].file, detail: `position ${i + 1}: by name ${byName[i].name}, by ts ${byTs[i].name}` }); break; }
    }

    // S1/S2: what the extractor yields today vs what the store holds.
    const scratch = mkdtempSync(join(tmpdir(), 'store-audit-'));
    try {
      const r = spawnSync(process.execPath, [extractor, tx, '--write', '--backfill'],
        { encoding: 'utf8', env: { ...process.env, MEMORY_OWN_STORE: scratch, MEMORY_GIT_REPOS: '', MEMORY_PRUNE_ORPHANS: '0' }, maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) { problems.push({ kind: 'extractor-failed', session: sessionId, detail: (r.stderr || '').slice(0, 200) }); continue; }
      const expected = new Set(readdirSync(scratch).filter((f) => f.endsWith('.md')));
      const have = new Set(files.map((e) => e.file));
      for (const f of expected) if (!have.has(f)) problems.push({ kind: 'missing', session: sessionId, file: f });
      for (const f of have) if (!expected.has(f)) problems.push({ kind: 'orphan', session: sessionId, file: f });
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  return { sessions, skipped, problems };
}

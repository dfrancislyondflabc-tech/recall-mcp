// lib/freshness.js — IS THE INDEX STILL TELLING THE TRUTH?
//
// THE INCIDENT (2026-08-19). The curated index was built at 06:18. The corpus
// files changed at 07:13 and again at 20:46. Every search for the rest of the
// day answered from the 06:18 snapshot, silently, and a session in another chat
// built a conclusion about the state of the project on top of it — compounding
// the error by reading each record's `modified` field, which is the file's mtime
// AT INDEX TIME, as though it were a live stat.
//
// A retrieval index is a cache of a directory. Every cache needs an invalidation
// rule, and this one had none: nothing compared the corpus to the index, and
// nothing in a response said how old the index was. Both are fixed here.
//
//   CHECK   a stat pass over the corpus files, compared per file against the
//           mtime the index recorded for it. Exact, not a heuristic: added,
//           removed and edited files are each detected on their own terms.
//   REPAIR  if anything moved, run the EXISTING incremental reindex inline,
//           before answering. There is exactly one indexer in this repo
//           (lib/index-store.js buildIndex, incremental by mtime+hash); this
//           module calls it and does not reimplement any part of it.
//   ADMIT   if the repair cannot be cheap — no index at all, a refused header,
//           no embedding model, or too many changed files — do NOT block the
//           query. Serve the stale answer and stamp it: `indexStale: true`,
//           `indexBuiltAt`, `staleFiles`, and a sentence saying so in plain
//           English. A slow correct answer is a bad trade against a fast honest
//           one; a fast dishonest one is what caused the incident.
//
// COST. Measured on this Mac: 122 curated files = 1.00 ms cold, 0.69 ms warm;
// the 2,104-file staging store = 11.5 ms cold, 8.7 ms warm. Cheap enough per
// query that the TTL cache below is a courtesy to bursts, not a necessity.

import { statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRESHNESS, rootsForCorpus, ownStoreDir } from './config.js';
import { listCorpusFiles } from './corpus.js';
import { buildIndex } from './index-store.js';
import { embeddingsAvailable, embeddingsDisabledReason } from './embed.js';
import { log, warn } from './logger.js';

// ---- which roots belong to which index -----------------------------------
// The three indexes are separate FILES for a measured reason (lib/config.js), so
// the freshness check has to respect the same split: the curated check must
// never be satisfied or upset by a staging or handoff file.
export function rootsForScope(scope) {
  // The 'all' -> 'curated' collapse here is NOT the bug that was fixed in latest().
  // There, 'all' fell through to a default and ANSWERED from curated alone while
  // labelling itself 'all'. Here it only chooses which roots to stat, and both
  // callers now fan out per-corpus before they ever reach this function, so 'all'
  // is unreachable from them. If a future caller does pass 'all' expecting a
  // combined freshness check, this line will quietly check curated only -- fan out
  // per corpus instead, the way search() and latestAll() do.
  return rootsForCorpus(scope === 'all' ? 'curated' : scope);
}

// ---- the stat pass, with a short TTL ------------------------------------
const STAT_CACHE = new Map();   // key -> { at, files }

function cacheKey(roots) {
  return roots.map((r) => `${r.dir}|${r.label ?? ''}`).join('\n');
}

/**
 * Every corpus file with its LIVE mtime. No content is read.
 * Returns { files: [{fileId, path, mtimeMs, size}], count, maxMtimeMs, statMs, cached }
 */
export function statSourceFiles(roots, { ttlMs = FRESHNESS.statCacheMs } = {}) {
  const key = cacheKey(roots);
  const hit = STAT_CACHE.get(key);
  const now = Date.now();
  if (hit && ttlMs > 0 && now - hit.at < ttlMs) return { ...hit.value, cached: true };

  const t0 = Date.now();
  const files = [];
  let maxMtimeMs = 0;
  for (const entry of listCorpusFiles(roots)) {
    let st;
    try { st = statSync(entry.path); } catch (_) { continue; }   // vanished mid-pass
    if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    files.push({ fileId: entry.fileId, path: entry.path, mtimeMs: st.mtimeMs, size: st.size });
  }
  const value = { files, count: files.length, maxMtimeMs, statMs: Date.now() - t0 };
  STAT_CACHE.set(key, { at: now, value });
  return { ...value, cached: false };
}

/** Drop the stat cache — used by the tests and after a rebuild. */
export function forgetStatCache() { STAT_CACHE.clear(); }

// ---- the comparison ------------------------------------------------------

const MAX_NAMED = 8;   // never let a stale-file list become the response

/**
 * Compare a LOADED index against the live corpus.
 *
 * Per file against the mtime the index recorded, not against builtAt — that is
 * what makes this exact rather than clock-sensitive. Files the index knowingly
 * EXCLUDED (denylist, frontmatter secret) are compared against builtAt instead,
 * because their exclusion is a decision that could itself have changed.
 *
 * Returns a plain report; it never rebuilds anything.
 */
export function checkStaleness(idx, roots, opts = {}) {
  const builtAt = idx?.header?.builtAt || null;
  const builtAtMs = builtAt ? Date.parse(builtAt) : NaN;
  const pass = statSourceFiles(roots, opts);

  const indexed = new Map();
  for (const d of idx?.docs || []) indexed.set(d.file, d.mtimeMs);
  const excluded = new Set((idx?.excluded || []).map((e) => e.file));

  const changed = [], added = [], removed = [];
  const live = new Set();
  for (const f of pass.files) {
    live.add(f.fileId);
    if (indexed.has(f.fileId)) {
      // An index built before mtimeMs was recorded has undefined here; treat a
      // missing recorded mtime as "cannot prove it is current" rather than as a
      // match, and let the builtAt comparison decide.
      const was = indexed.get(f.fileId);
      if (typeof was !== 'number') {
        if (Number.isFinite(builtAtMs) && f.mtimeMs > builtAtMs) changed.push(f.fileId);
      } else if (was !== f.mtimeMs) {
        changed.push(f.fileId);
      }
    } else if (excluded.has(f.fileId)) {
      if (Number.isFinite(builtAtMs) && f.mtimeMs > builtAtMs) changed.push(f.fileId);
    } else {
      added.push(f.fileId);
    }
  }
  for (const fileId of indexed.keys()) if (!live.has(fileId)) removed.push(fileId);
  const mtimeById = new Map(pass.files.map((f) => [f.fileId, f.mtimeMs]));

  const staleFiles = changed.length + added.length + removed.length;
  // The newest mtime among files the index has NOT seen. Distinct from newestSourceModified,
  // which is the newest mtime in the whole corpus INCLUDING indexed files — that one cannot
  // answer 'is there unread content newer than my best answer?', because the newest file is
  // usually one the index already has.
  const staleMtimes = [...changed, ...added]
    .map((id) => mtimeById.get(id))
    .filter((m) => Number.isFinite(m));
  const staleNewestMs = staleMtimes.length ? Math.max(...staleMtimes) : null;
  return {
    stale: staleFiles > 0,
    staleFiles,
    changed, added, removed,
    changedNamed: changed.slice(0, MAX_NAMED),
    addedNamed: added.slice(0, MAX_NAMED),
    removedNamed: removed.slice(0, MAX_NAMED),
    indexBuiltAt: builtAt,
    indexBuiltAtMs: Number.isFinite(builtAtMs) ? builtAtMs : null,
    // The fileIds above are display strings. Keep the absolute paths too, so a
    // caller that must READ a stale file (see staleContentScan in search.js) does
    // not have to re-derive them from roots and guess at the join.
    pathById: new Map(pass.files.map((f) => [f.fileId, f.path])),
    staleNewestMs,
    staleNewestModified: staleNewestMs ? new Date(staleNewestMs).toISOString() : null,
    checkedFiles: pass.count,
    newestSourceModified: pass.maxMtimeMs ? new Date(pass.maxMtimeMs).toISOString() : null,
    checkMs: pass.statMs,
    statCached: pass.cached
  };
}

/** The sentence a caller reads when the index could not be repaired in time. */
export function staleWarningText(st, reason) {
  const bits = [];
  if (st.changed.length) bits.push(`${st.changed.length} edited (${st.changedNamed.join(', ')}${st.changed.length > st.changedNamed.length ? ', …' : ''})`);
  if (st.added.length) bits.push(`${st.added.length} added (${st.addedNamed.join(', ')}${st.added.length > st.addedNamed.length ? ', …' : ''})`);
  if (st.removed.length) bits.push(`${st.removed.length} deleted (${st.removedNamed.join(', ')}${st.removed.length > st.removedNamed.length ? ', …' : ''})`);
  return `STALE INDEX — these results come from an index built at ${st.indexBuiltAt || 'an unknown time'}, ` +
         `and ${st.staleFiles} corpus file(s) have changed since: ${bits.join('; ')}. ` +
         `Not repaired inline because ${reason}. ` +
         'Rebuild with memory({action:"index"}) — it returns a jobId IMMEDIATELY and builds off the ' +
         'request (a blocking index used to time out through MCP); poll with ' +
         'memory({action:"index_status", jobId}). `npm run index` also works. Note that each ' +
         "result's `modified` is the file's mtime AT INDEX TIME, not a live read.";
}

// ---- the inline repair ---------------------------------------------------

// One rebuild at a time per index file, and a cooldown after a failure. Without
// the first, a burst of queries starts a burst of builds over the same 16 MB
// file; without the second, a broken model load turns every query into a fresh
// failed build.
const INFLIGHT = new Map();     // out-path -> promise
const LAST_FAILURE = new Map(); // out-path -> { at, message }

/**
 * Run the EXISTING incremental indexer inline, if that can be cheap.
 * Returns { ok: true, report } or { ok: false, reason } — never throws.
 */
export async function reindexInline({ idx, roots, out, staleness }) {
  if (!FRESHNESS.inlineEnabled) {
    return { ok: false, reason: 'inline reindex is switched off (MEMORY_INLINE_REINDEX=0)' };
  }
  // A missing or refused index means there are no reusable vectors, so the
  // "incremental" path is a full rebuild. For the curated corpus or the staging
  // store that is minutes, and a query must never wait for it.
  //
  // THE DAY-2 CASE IS DIFFERENT, and it is the one this exception exists for:
  // another project writes its first memories, and the corpus that holds them
  // has no index at all because it did not exist an hour ago. Telling the caller
  // to run `memory({action:"index"})` is correct and it is also how a new
  // project's memories stay invisible for a week — nobody reads the stamp until
  // they have already trusted an answer. A corpus small enough to build in
  // seconds is built.
  //
  // The bound is on FILE COUNT, not on wishful thinking: at the measured
  // ~4.7 s/file for never-seen documents (see FRESHNESS.maxInlineFiles), 40 files
  // is a worst case a client waits through, and the 15-document fixture second
  // project builds in 2.2 s with a warm vector cache.
  if (!idx?.present) {
    const n = statSourceFiles(roots).count;
    if (n === 0) return { ok: false, reason: 'there is no index and no corpus files either — nothing to build' };
    if (n > FRESHNESS.firstBuildMaxFiles) {
      return { ok: false, reason: `there is no index yet and this corpus has ${n} files (over the first-build limit of ${FRESHNESS.firstBuildMaxFiles}), so this would be a FULL build (minutes), not an incremental one` };
    }
    log(`no index at ${out} for a ${n}-file corpus — building it inline before answering`);
  } else if (idx.headerProblems?.length) {
    return { ok: false, reason: `the index header does not match the running embedding contract (${idx.headerProblems.join('; ')}), so every vector would have to be recomputed — a FULL rebuild` };
  }
  if (staleness && staleness.staleFiles > FRESHNESS.maxInlineFiles) {
    return { ok: false, reason: `${staleness.staleFiles} files changed, over the inline limit of ${FRESHNESS.maxInlineFiles} — at that size it is a full rebuild in disguise` };
  }
  const fail = LAST_FAILURE.get(out);
  if (fail && Date.now() - fail.at < FRESHNESS.failureCooldownMs) {
    const left = Math.ceil((FRESHNESS.failureCooldownMs - (Date.now() - fail.at)) / 1000);
    return { ok: false, reason: `the last inline rebuild failed ${Math.round((Date.now() - fail.at) / 1000)}s ago (${fail.message}); not retrying for another ${left}s` };
  }
  if (!(await embeddingsAvailable())) {
    return { ok: false, reason: `the embedding model is unavailable (${embeddingsDisabledReason()}), so a rebuild would produce a BM25-only index — worse than the stale one` };
  }

  if (INFLIGHT.has(out)) {
    // Another query is already doing exactly this build. Wait for it rather
    // than starting a second writer over the same file.
    try { return await INFLIGHT.get(out); } catch (e) { return { ok: false, reason: `a concurrent inline rebuild failed: ${e.message}` }; }
  }

  const p = (async () => {
    const t0 = Date.now();
    try {
      if (staleness) log(`STALE INDEX detected (${staleness.staleFiles} file(s) changed since ${staleness.indexBuiltAt}) — reindexing inline before answering`);
      const report = await buildIndex({ force: false, dir: roots, out });
      LAST_FAILURE.delete(out);
      forgetStatCache();
      log(`inline reindex done in ${((Date.now() - t0) / 1000).toFixed(2)}s: ${report.filesReused} reused, ${report.filesEmbedded} re-embedded`);
      return { ok: true, report, seconds: Number(((Date.now() - t0) / 1000).toFixed(2)) };
    } catch (e) {
      LAST_FAILURE.set(out, { at: Date.now(), message: e.message });
      warn(`inline reindex FAILED (${e.message}) — serving the stale index, stamped`);
      return { ok: false, reason: `the inline rebuild threw: ${e.message}` };
    }
  })();

  INFLIGHT.set(out, p);
  try { return await p; } finally { INFLIGHT.delete(out); }
}

// ---- the staging equivalent ---------------------------------------------
// Staging is INGEST-driven, not hand-edited: scripts/auto-ingest.js writes
// exchange files into store/ and rebuilds .staging-index.json itself. So the
// same per-file mtime check works and costs ~9 ms over 2,104 files — it is
// stamped exactly like curated.
//
// What is NOT done inline is the REPAIR. A staging rebuild writes 130 MB and
// takes ~14 s even fully cached, and the population it serves is raw
// conversation exchanges that the curated corpus does not depend on. Blocking a
// query for that is the wrong trade, so a stale staging index is reported and
// left for the ingest hook to fix. `lastIngestAt` is included because for this
// corpus "when did material last arrive" is the more useful question than "when
// was the file written".
export function lastIngestAt() {
  const store = ownStoreDir();
  if (!store) return null;
  const stamp = join(store, '.last-ingest.json');
  if (!existsSync(stamp)) return null;
  try {
    const j = JSON.parse(readFileSync(stamp, 'utf8'));
    let max = 0;
    for (const v of Object.values(j || {})) {
      const at = Number(v?.at);
      if (Number.isFinite(at) && at > max) max = at;
    }
    return max ? new Date(max).toISOString() : null;
  } catch (_) { return null; }
}

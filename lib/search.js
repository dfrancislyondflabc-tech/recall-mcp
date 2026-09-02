// lib/search.js — hybrid retrieval over a loaded index.
//
// THREE retrievers with complementary failure modes:
//   * BM25 over title+description+headings+BODY — precise on jargon, part
//     numbers, file names, slugs, and (v1.1) any literal string in the text.
//   * Dense cosine over ~200-word body chunks — catches "how do I restart the
//     email app server" hitting a memory that never says "restart".
//   * Phrase proximity over the body (v1.1, lib/lexical.js) — did the query's
//     words occur TOGETHER. The tie-breaker that separates a quoted sentence
//     from a document with the same vocabulary.
// Fuse normalised scores, then apply the two-tier boost and a mild recency
// decay. Provenance (keyword / semantic / phrase / both) is reported so a bad
// result is diagnosable rather than mysterious.
//
// v1.1 also fixes two things the 2026-08-14 benchmark measured as defects:
// long documents winning the dense leg by sheer chunk count (see
// RETRIEVAL.longDoc), and the absence of any way to answer "nothing matched"
// (see RETRIEVAL.absence and `noStrongMatch` below).

import { RETRIEVAL, queryLogPath, indexPath, stagingIndexPath, indexPathForCorpus, CORPORA,
         libraryCorpora, isLibraryCorpus, categoryConfig,
         accountLabel, memoryDir as memoryDirPath, querySource} from './config.js';
import { basename, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildBm25, bm25Search, queryTermStats, bodyOf } from './bm25.js';
import { bestWindow, snippetAround } from './lexical.js';
import { embedQuery, cosine, embeddingsDisabledReason } from './embed.js';
import { loadIndex } from './index-store.js';
import { guardValue } from './secrets.js';
import { log } from './logger.js';
import { appendFileSync, statSync as statSyncFs, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isBenchmarkQuery } from './benchmark-strings.js';
import { rootsForScope, checkStaleness, reindexInline, staleWarningText, lastIngestAt } from './freshness.js';
import { runId } from './config.js';
import { serverVersionString, SERVER_STARTED_AT } from './version.js';
import { extractShas, verifyShas, configuredRepos, commitsInRange, corpusCurrency, autoVerifyQuery } from './git-join.js';
import { aliasExpansion, aliasWeight, aliasNote } from './aliases.js';
import { applyGraphSpread, graphSpreadEnabled, spreadAlpha } from './graph-spread.js';
import { spreadEffect, shadowDivergence } from './spread-telemetry.js';
import { floorsFor } from './absence-floors.js';
import { deriveProfile, adviceFor, verificationAppliesTo } from './corpus-profile.js';
import { orphanHandoffLines } from './orphan-handoffs.js';
import { isVec } from './vec.js';

// TELEMETRY IS NOT LOAD-BEARING, AND THIS IMPORT SAYS SO IN CODE.
//
// lib/ordinary-shadow.js is measurement scaffolding: it computes a signal AFTER a refusal is
// decided, writes a line to a log, and can change no answer. Two consequences follow, and this
// lazy optional import is both of them:
//
//   1. It is EXCLUDED FROM THE DISTRIBUTION. Unproven instrumentation belongs in the tree where
//      it is being measured, not in everyone's install. A static import would have made that
//      impossible — removing the file would break `search` outright.
//   2. Even where it IS present, a fault in it must never reach a query. If the module cannot
//      be loaded for any reason, searching continues with a no-op and says nothing about it.
//
// Resolved once and cached; the call site discards the result, so nothing here can influence
// a response even when the module loads perfectly.
let _observeAbsence;
async function observeAbsence(args) {
  if (_observeAbsence === undefined) {
    try { _observeAbsence = (await import('./ordinary-shadow.js')).observeAbsence; }
    catch { _observeAbsence = null; }
  }
  try { return _observeAbsence ? _observeAbsence(args) : null; } catch { return null; }
}

// One cache PER SCOPE. The indexes must never share BM25 statistics OR the
// corpus-derived constants below — that is the whole reason they are separate
// files, and it is measured twice over (see lib/config.js): blending staging
// cost MRR 0.826 -> 0.681, and blending the handoff documents cost 0.8194 ->
// 0.7986 plus an absence verdict, entirely by moving `referenceChunks`.
const CACHES = new Map();      // scope -> loaded index + its own statistics

// Map every exchange to its position in its own thread, and to that thread's
// LAST exchange.
//
// `threadLast` is the field that does the work. Measured on the real corpus:
// mean thread length 36.7, and 87% of exchanges sit in threads >=20 long -- so
// "you are at 12 of 47" is almost always true and almost never discriminating.
// It tells the caller to go looking without saying where. The NAME of the final
// exchange puts the last word one get() away.
function buildThreadMap(docs) {
  const bySession = new Map();
  for (const d of docs) {
    const m = /^x-(.+)-(\d+)$/.exec(d.name || '');
    if (!m) continue;
    const [, sid, ord] = m;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ name: d.name, ord: Number(ord) });
  }
  const out = new Map();   // exchange name -> { position, total, last, names }
  for (const [, list] of bySession) {
    list.sort((a, b) => a.ord - b.ord);
    const names = list.map((e) => e.name);   // ONE array shared by every member
    const last = names[names.length - 1];
    list.forEach((e, i) => out.set(e.name, { position: i + 1, total: list.length, last, names }));
  }
  return out;
}

function loadScope(scope) {
  const path = indexPathForCorpus(scope);
  if (!path) return { present: false, docs: [], headerProblems: [], dense: false };
  const t0 = Date.now();
  const idx = loadIndex(path);
  const chunkCounts = idx.docs.map((d) => (d.chunks || []).length).sort((a, b) => a - b);
  const entry = {
    ...idx,
    bm25: idx.docs.length ? buildBm25(idx.docs) : null,
    // The reference length for the dense-leg correction, derived from THIS
    // corpus rather than hard-coded: documents up to the 90th percentile are
    // "normally long" and pay nothing. Using the median instead cost the
    // benchmark's P1 — `tawk-watcher-speedup` is a legitimately long memory
    // at 23 chunks and lost a third of its dense score for it. Only the tail
    // above p90 is the multiple-draws problem worth correcting.
    //
    // DERIVED PER CORPUS, and that is load-bearing: this one number is what
    // made the handoff documents regress the curated benchmark from inside the
    // same index without ever appearing in a result.
    referenceChunks: Math.max(1, chunkCounts[Math.floor(0.90 * (chunkCounts.length - 1))] || 1),

    // WHERE IN ITS THREAD each exchange sits, computed once per index and cached
    // here beside referenceChunks. Exchange names are x-<session>-NNNN, so the
    // ordering is already in the corpus and needs no NLP and no guessing.
    //
    // This exists because of a specific failure: a session asked whether a
    // re-parse had finished, got the exchange where the work STARTED, and
    // reported the answer unknowable -- while reading one exchange of a
    // 650-exchange thread. It could not see that it was mid-thread.
    //
    // The obvious alternative -- warn when a result "looks unresolved" -- was
    // measured and rejected: that vocabulary fires on 24% of all exchanges,
    // which at limit:8 puts a warning on ~87% of searches. This repo has been
    // burned by exactly that twice (see the correction regex at 76%). Thread
    // position is never a guess and never cries wolf.
    threads: buildThreadMap(idx.docs),

    // WHAT KIND of corpus this is, derived once per index from structural counts.
    // Cached here beside referenceChunks because it is the same shape of fact: a
    // per-corpus constant that must never be computed from a blend of corpora.
    // A library category may DECLARE its domain (.category.json) — a statute
    // and a novel are statistically identical prose, and only the author of the
    // category knows which advice fits. Absent, the derived profile decides.
    profile: deriveProfile(idx.docs.map((d) => ({
      bodyText: (d.chunks || []).map((c) => c.text || '').join(' ') || d.description || ''
    })), isLibraryCorpus(scope) ? { override: categoryConfig(scope).domain || null } : {}),

    // The newest thing this corpus knows about, computed once. Used to say how far
    // behind the world it is -- the one limit no query can work around.
    newestTs: idx.docs.reduce((m, d) => {
      const t = Date.parse(d.ts || d.modified || 0) || 0;
      return t > m ? t : m;
    }, 0)
  };
  log(`index loaded [${scope}]: ${idx.docs.length} docs, dense=${idx.dense}, refChunks=${entry.referenceChunks}, ${Date.now() - t0} ms` +
      (idx.headerProblems.length ? ` (header problems: ${idx.headerProblems.join('; ')})` : ''));
  return entry;
}

export function getIndex({ reload = false, scope = 'curated' } = {}) {
  if (reload) CACHES.delete(scope);
  if (!CACHES.has(scope)) CACHES.set(scope, loadScope(scope));
  return CACHES.get(scope);
}

export function invalidate(scope = null) {
  if (scope) CACHES.delete(scope);
  else CACHES.clear();
}

// ---- THE STALENESS GUARD (see lib/freshness.js for the incident) ----------
//
// An index is a cache of a directory, so it needs an invalidation rule. Before
// this existed, a search answered from whatever snapshot happened to be on disk
// and said nothing about its age; on 2026-08-19 that served an 06:18 index all
// day over files edited at 07:13 and 20:46.
//
// The rule: check, repair if the repair is cheap, and otherwise ADMIT. What is
// never allowed is answering from a stale index without saying so.
//
// Returns { idx, stamp } where `stamp` is the set of fields every search
// response carries.
async function ensureFresh(scope) {
  const roots = rootsForScope(scope);
  const out = indexPathForCorpus(scope);
  let idx = getIndex({ scope });

  const stamp = {
    indexBuiltAt: idx?.header?.builtAt || null,
    indexPath: out,
    indexStale: false,
    // Said once, in the response, because saying it only in the docs did not
    // stop it from being misread.
    modifiedFieldNote: "each result's `modified` is that file's mtime AT INDEX TIME (see indexBuiltAt), not a live stat — memory({action:'get'}) returns a live one",
    serverVersion: serverVersionString(),
    serverStartedAt: SERVER_STARTED_AT
  };
  if (scope === 'staging') stamp.lastIngestAt = lastIngestAt();
  if (scope === 'handoff') {
    stamp.corpusNote = 'Institutional handoff documents, indexed READ-ONLY from outside the memory folders. ' +
      'Their own index, so they cannot move a curated score.';
  }
  if (scope === 'projects') {
    stamp.corpusNote = 'Hand-written memories from OTHER projects\' memory folders (~/.claude/projects/<project>/memory). ' +
      'Curated-type content at hot tier, writable, each row carrying its `project` — but its own index, ' +
      'so it cannot move a curated score.';
  }
  if (isLibraryCorpus(scope)) {
    stamp.corpusNote = `Library category '${scope}' — imported reference material (books/manuals/docs), ` +
      'indexed READ-ONLY in its own index with its own statistics. Never searched unless named ' +
      "(or via scope:'everything'), so it cannot move a work-corpus score.";
  }

  // LIBRARY CORPORA ARE NEVER REBUILT INLINE — the staging exemption, for the
  // staging reason at book scale: one imported manual is hundreds of chunks, so
  // "incremental" over a changed book is minutes of embedding a query must not
  // wait for. Import/index own these builds.
  const libraryScope = isLibraryCorpus(scope);

  if (!idx.present) {
    // NO INDEX AT ALL. For curated or staging that stays an admission (the build
    // is minutes). For a corpus small enough to build in seconds it is built now
    // — the day-2 case, where another project has just written its first
    // memories and nothing has indexed them yet. See reindexInline.
    const first = out && scope !== 'staging' && !libraryScope
      ? await reindexInline({ idx, roots, out, staleness: null })
      : { ok: false,
          reason: libraryScope
            ? `the '${scope}' library index is import-driven — build it with memory({action:"index", scope:"${scope}"})`
            : 'the staging index is ingest-driven — scripts/auto-ingest.js owns it' };
    if (first.ok) {
      invalidate(scope);
      idx = getIndex({ scope, reload: true });
      stamp.indexBuiltAt = idx?.header?.builtAt || null;
      stamp.indexBuiltInline = true;
      stamp.indexReindexSeconds = first.seconds;
      stamp.indexReindexNote =
        `This corpus had no index; it was small enough to build inline (${first.report.filesIndexed} files, ` +
        `${first.report.chunkCount} chunks, ${first.seconds}s) before this search ran. These results are current.`;
      return { idx, stamp };
    }
    stamp.indexStale = true;
    stamp.staleFiles = null;
    stamp.staleWarning = 'There is no index on disk, so nothing here was retrieved from the corpus. ' +
      `Run memory({action:"index"}). Not built inline because ${first.reason}.`;
    return { idx, stamp };
  }

  let st;
  try {
    st = checkStaleness(idx, roots);
  } catch (e) {
    // The guard is a safety feature; it may not become a new way to fail a
    // search. An unreadable corpus directory is reported, not thrown.
    stamp.freshnessCheckError = e.message;
    return { idx, stamp };
  }

  stamp.indexCheckedFiles = st.checkedFiles;
  stamp.indexCheckMs = st.checkMs;
  stamp.newestSourceModified = st.newestSourceModified;

  if (!st.stale) return { idx, stamp };

  // Staging is ingest-driven and its rebuild writes 130 MB in ~14 s; a query
  // does not wait for that. The same holds for a library category — a changed
  // book re-embeds hundreds of chunks. Curated gets the inline repair.
  if (scope === 'staging' || libraryScope || !out) {
    stamp.indexStale = true;
    stamp.staleFiles = st.staleFiles;
    stamp.staleWarning = staleWarningText(st, libraryScope
      ? `the '${scope}' library index is import-driven and a changed book is a full re-embed — rebuild with memory({action:"index", scope:"${scope}"})`
      : 'the staging index is ingest-driven and its rebuild is not cheap enough to run inline — scripts/auto-ingest.js owns it');
    // 2026-08-29: this branch used to return WITHOUT the file lists. So
    // staleTermCollision — written for exactly this failure — was inert on the
    // only corpus that can suffer it: curated repairs itself inline and never
    // reaches a stale answer, while staging always does. The guard read
    // stamp.staleFilesAdded, which was undefined here, and silently found nothing.
    attachStaleFiles(stamp, st);
    return { idx, stamp };
  }

  const repair = await reindexInline({ idx, roots, out, staleness: st });
  if (repair.ok) {
    invalidate(scope);
    idx = getIndex({ scope, reload: true });
    stamp.indexBuiltAt = idx?.header?.builtAt || null;
    stamp.indexStale = false;
    stamp.indexReindexedInline = true;
    stamp.indexReindexSeconds = repair.seconds;
    stamp.indexReindexNote =
      `The index was ${st.staleFiles} file(s) behind the corpus (built ${st.indexBuiltAt}); it was rebuilt ` +
      `incrementally before this search ran (${repair.report.filesReused} files reused, ${repair.report.filesEmbedded} re-embedded). ` +
      'These results are current.';
    return { idx, stamp };
  }

  stamp.indexStale = true;
  stamp.staleFiles = st.staleFiles;
  stamp.staleWarning = staleWarningText(st, repair.reason);
  attachStaleFiles(stamp, st);
  return { idx, stamp };
}

// Both stale branches attach the same evidence, through one function, because
// they drifted once already and the drift was invisible: the display slices are
// capped at MAX_NAMED (8) so a stale list can never become the response, while the
// FULL set rides non-enumerably for the scanners — `...stamp` spreads only
// enumerable own properties, so it reaches staleContentScan and never the caller.
function attachStaleFiles(stamp, st) {
  // The newest UNINDEXED mtime. `latest` compares it against its own top row: if unread
  // content is newer than the newest thing that can be ranked, a newest-first answer is not
  // the last word, whatever it ranked. See the recency block in latestIn().
  stamp.staleNewestModified = st.staleNewestModified ?? null;
  Object.defineProperty(stamp, '_staleNewestMs', { value: st.staleNewestMs ?? null, enumerable: false, configurable: true });
  stamp.staleFilesChanged = st.changedNamed;
  stamp.staleFilesAdded = st.addedNamed;
  stamp.staleFilesRemoved = st.removedNamed;
  Object.defineProperty(stamp, '_staleScan', {
    value: [...st.changed, ...st.added]
      .map((id) => ({ fileId: id, path: st.pathById ? st.pathById.get(id) : null }))
      .filter((f) => f.path),
    enumerable: false, configurable: true
  });
}

/**
 * Per-query-max normalisation. ONLY safe when the scores are not about to be
 * fused with a second retriever: it guarantees a 1.0 to whatever scored best,
 * so it says "the best of these" and never "this is a good match". Kept for
 * bm25-only mode, where that distinction cannot affect anything.
 */
function normalise(map) {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  const out = new Map();
  if (max <= 0) return out;
  for (const [k, v] of map) out.set(k, v / max);
  return out;
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * ABSOLUTE keyword scale — the fused path's normalisation.
 *
 * Two factors, both measured (see RETRIEVAL.keywordScale in config.js for the
 * distributions the numbers come from):
 *   magnitude — where the raw BM25 score sits between a noise floor and the
 *               score a real lexical match earns;
 *   coverage  — how much of what this query COULD have matched the document
 *               actually matched, which is what separates "answered the
 *               question" from "shares one common word".
 *
 * Both are needed: magnitude alone lets a long query that hits a single rare
 * term score high; coverage alone lets a three-word query that matches its two
 * common words score 1.0. A document below the floor scores 0 and rides on its
 * semantic score alone — no keyword evidence is the honest reading.
 *
 * The two reference points are each the lesser of an absolute raw score and a
 * share of the query's achievable score, so that a short exact query, which
 * cannot reach the absolute bar however perfectly it matches, is judged against
 * what it could actually have earned.
 *
 * Ranking WITHIN the keyword leg is untouched (the map is monotone in the raw
 * score for a fixed query); only its magnitude relative to the dense leg moves.
 */
function absoluteKeyword(rawScores, stats) {
  const { absFloor, absFull, covFloor, covFull } = RETRIEVAL.keywordScale;
  const ideal = stats.ideal;
  const out = new Map();
  if (ideal <= 0) return out;                    // no query term exists in the corpus
  const floorPoint = Math.min(absFloor, covFloor * ideal);
  const fullPoint = Math.min(absFull, covFull * ideal);
  for (const [k, raw] of rawScores) {
    const magnitude = clamp01((raw - floorPoint) / (fullPoint - floorPoint));
    if (magnitude <= 0) continue;
    out.set(k, magnitude * clamp01((raw / ideal) / covFloor));
  }
  return out;
}

/**
 * Dense-leg length correction. `nChunks` draws from a document's chunk-score
 * distribution beat `few` draws on the maximum alone, so a document with 517
 * chunks out-scores a three-line standing rule without being more relevant.
 * Shrink the dense score toward the corpus-median document, and waive the
 * shrinkage in proportion to keyword evidence — a document with concentrated
 * lexical hits has already passed BM25's own length test.
 */
/**
 * The phrase leg's DEADBAND.
 *
 * Below the floor, a "phrase score" is not evidence of a quote — it is the
 * incidental co-occurrence any two documents about the same subject produce,
 * and letting it into the fused score means a near-tie gets decided by noise.
 * Measured: benchmark probe E9 has its correct answer and a sibling within 0.9%
 * of each other, the correct one ahead on keyword score by 3.3×; raw phrase
 * scores of 0.13 vs 0.08 — both meaningless — flipped it. Meanwhile every
 * genuine quote in the verbatim category scores 0.56 or higher.
 *
 * So the leg contributes nothing until 0.35 and then rescales to full weight,
 * which makes it do exactly what it is documented to do: fire on quotes, stay
 * silent otherwise.
 */
function phraseContribution(phrase) {
  const floor = RETRIEVAL.fuse.phraseFloor;
  if (!(phrase > floor)) return 0;
  return (phrase - floor) / (1 - floor);
}

// file -> total chunks across every doc from that file, memoised per index.
// Section children share their parent's `file`, which is also what lets
// capPerDocument cap a parent and its children together.
const CHUNKS_BY_FILE = new WeakMap();
function chunksByFile(idx) {
  let m = CHUNKS_BY_FILE.get(idx);
  if (m) return m;
  m = new Map();
  for (const d of idx.docs || []) m.set(d.file, (m.get(d.file) || 0) + (d.chunks || []).length);
  CHUNKS_BY_FILE.set(idx, m);
  return m;
}

function longDocFactor(nChunks, referenceChunks, kw, waiverOverride) {
  const { alpha, keywordWaiver } = RETRIEVAL.longDoc;
  if (nChunks <= referenceChunks || alpha <= 0) return 1;
  const raw = Math.pow(referenceChunks / nChunks, alpha);
  const waive = clamp01(kw / (waiverOverride || keywordWaiver));
  return raw + (1 - raw) * waive;
}

// ---- PHASE B: how big is a section, for the purpose of being penalised? ----
//
// The two obvious answers are both wrong, and each is wrong in the opposite
// direction (both measured, 2026-08-25):
//
//   own chunks    -> a 635 KB changelog becomes 138 short documents, none of
//                    them penalised. It took a top-3 slot on 20 of 32 probes.
//   parent chunks -> a section is punished for its parent's bulk and can never
//                    win, which loses the entire point of splitting.
//
// So blend them geometrically and let the exponent be measured, not asserted:
//   beta = 0  -> own size          (flooding)
//   beta = 1  -> parent size       (section can never win)
// and give a child its own keyword waiver, because the case a section SHOULD
// win is exactly the one where a specific term matches it hard ("Gate #24").
const sectionBeta = () => {
  const v = Number(process.env.MEMORY_SECTION_BETA);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
};
const sectionWaiver = () => {
  const v = Number(process.env.MEMORY_SECTION_WAIVER);
  return Number.isFinite(v) && v > 0 ? v : RETRIEVAL.longDoc.keywordWaiver;
};
function sectionEffectiveChunks(own, parent) {
  const b = sectionBeta();
  if (b <= 0) return own;
  if (b >= 1) return parent;
  return Math.exp((1 - b) * Math.log(Math.max(1, own)) + b * Math.log(Math.max(1, parent)));
}

/** Map a raw bge cosine onto 0..1 across the band this corpus actually uses. */
function rescaleCosine(cos) {
  const { floor, span } = RETRIEVAL.semanticScale;
  return Math.max(0, Math.min(1, (cos - floor) / span));
}

function recencyFactor(modified) {
  const { floor, halfLifeDays } = RETRIEVAL.recency;
  const t = Date.parse(modified);
  if (!Number.isFinite(t)) return 1;
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  return floor + (1 - floor) * Math.exp(-ageDays / halfLifeDays);
}

function tierBoost(doc) {
  const { boost } = RETRIEVAL;
  if (doc.tier === 'archive') return boost.archive;
  return doc.inMemoryIndex ? boost.hotIndexed : boost.hot;
}

function trimSnippet(text, max = RETRIEVAL.snippetChars) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max).replace(/\s\S*$/, '') + '…';
}

/**
 * Hold shelf space for the curated corpus.
 *
 * Applied AFTER ranking, so it never rewrites a score and never promotes a weak
 * document: archive results keep their order and their positions, and the only
 * thing that changes is that they stop past their share, letting the next hot
 * documents through. With no archive tier present this is a no-op, which is why
 * every pre-existing benchmark number is unaffected.
 */
function capArchiveShare(sorted, limit, share = RETRIEVAL.maxArchiveShare) {
  const maxArchive = Math.max(1, Math.floor(limit * share));
  const out = [];
  const held = [];
  let archived = 0;
  for (const row of sorted) {
    if (out.length >= limit) break;
    if (row.tier === 'archive') {
      if (archived >= maxArchive) { held.push(row); continue; }
      archived++;
    }
    out.push(row);
  }
  // If there were not enough hot documents to fill the page, give the space back
  // rather than returning a short result.
  for (const row of held) { if (out.length >= limit) break; out.push(row); }
  return out;
}

/**
 * SOFT TIME ANCHOR. recencyFactor() is this same shape anchored on now; this
 * generalises the anchor to any date, which is what "things from around when
 * that conversation happened" needs.
 *
 * Deliberately a MULTIPLIER, not a filter. A hard window's failure mode is
 * hiding the right answer and saying nothing, so the default tilt must never be
 * able to do that — a document from the wrong month can still win if it is the
 * only real match. Use after/before when you actually mean exclusion.
 */
function nearFactor(modified, anchorMs, halfLifeDays = RETRIEVAL.recency.halfLifeDays, floor = RETRIEVAL.recency.floor) {
  if (!anchorMs) return 1;
  const t = Date.parse(modified);
  if (!Number.isFinite(t)) return 1;
  const days = Math.abs(t - anchorMs) / 864e5;
  return floor + (1 - floor) * Math.pow(0.5, days / halfLifeDays);
}

// A result set that does not say what it CANNOT answer invites the caller to
// over-read it. staleWarning already set the precedent — it names the exact
// command that fixes the staleness — so the same applies to the two mistakes a
// caller actually makes with this corpus:
//   * treating a conversation EXCHANGE as a settled conclusion, when it is a
//     moment in a conversation that may have continued
//   * reading the TOP MATCH as the current state, when relevance ranking cannot
//     distinguish "starting X" from "finished X"
// Both were made here, by me, on the re-parse question. The fix is one call.
// Attach thread position to an exchange row. A FACT, never an alarm: it is either
// exactly right or absent, so it can be shown on every exchange without becoming
// noise the caller learns to skip.
function withThreadPosition(row, idx) {
  const t = idx.threads && idx.threads.get(row.name);
  if (!t) return row;
  row.threadPosition = `${t.position} of ${t.total}`;
  row.laterInThread = t.total - t.position;
  if (t.last !== row.name) row.threadLast = t.last;
  return row;
}

function buildGuidance(results, { scope, query }) {
  const g = [];
  const ex = results.filter((r) => r.type === 'exchange');
  if (ex.length) {
    g.push(`${ex.length} of these are conversation EXCHANGES — a moment in a chat, not a settled ` +
      `conclusion. For "what is the current state", relevance is the wrong axis: call ` +
      `memory({action:"latest", query:"…"}), which filters on terms and orders NEWEST FIRST.`);
    // The conclusion is usually in the exchanges AFTER the one that ranked. Say
    // where it is rather than saying to go looking: 87% of exchanges are >=20
    // deep in a thread, so "there is more" alone is nearly constant and useless.
    // Anchored on the TOP-RANKED mid-thread hit, not the one with the most unread
    // material after it. The failure being prevented is "read the top hit, conclude
    // from it", so the advice has to be about the document that will actually be
    // read -- picking the maximum instead points at a row the caller may never open.
    const mid = ex.filter((r) => r.laterInThread > 0 && r.threadLast);
    if (mid.length) {
      const worst = mid[0];
      g.push(`${mid.length} of these are MID-THREAD — e.g. ${worst.name} is ${worst.threadPosition}, ` +
        `with ${worst.laterInThread} exchanges after it. If you are asking whether something ` +
        `finished, the answer is in one of those, not here: memory({action:"get", name:"${worst.threadLast}"}) ` +
        'is that thread\'s last word.');
    }
    // The "it may have simply stopped" hedge is only honest about a TERMINAL
    // exchange. 97.3% of exchanges are non-terminal, so firing it on all of them
    // would be the cry-wolf failure this file already avoids elsewhere.
    if (ex.some((r) => r.laterInThread === 0)) {
      g.push('Some of these ARE the last exchange of their thread — which means the thread may ' +
        'have concluded, or may simply have STOPPED. Those look identical here; check the world ' +
        '(git log, the filesystem) before reporting one as the other.');
    }
    const sids = [...new Set(ex.map((r) => r.sessionId).filter(Boolean))];
    if (sids.length === 1) {
      g.push('All from one conversation. Its exchanges are ordered by the numeric suffix ' +
        '(…-0616) and chained by [[prev]] links, so the thread can be read in sequence.');
    } else if (sids.length > 1) {
      g.push(`Spanning ${sids.length} conversations — check each hit's sessionTitle/account before ` +
        'treating two of them as the same thread.');
    }
  }
  if (scope === 'curated') {
    g.push('scope defaulted to CURATED (hand-written memories). Captured conversations are ' +
      'scope:"staging"; scope:"all" returns both as separate groups.');
    // The library hint rides the same default-scope line, and ONLY when
    // categories actually exist: imported reference material is opt-in by
    // Daniel's rule, so the only honest failure mode left is not knowing it is
    // there to ask for.
    const libs = libraryCorpora();
    if (libs.length) {
      g.push(`${libs.length} library categor${libs.length === 1 ? 'y' : 'ies'} (${libs.join(', ')}) ` +
        "hold imported reference material and are NEVER searched unless named — scope:'" + libs[0] +
        "', an array like ['all','" + libs[0] + "'], or scope:'everything'.");
    }
  }
  return g.length ? g : undefined;
}

/** Enforce RETRIEVAL.maxSlotsPerDoc over an already-sorted result list. */
function capPerDocument(sorted, limit, maxSlots = RETRIEVAL.maxSlotsPerDoc) {
  const seen = new Map();
  const out = [];
  for (const r of sorted) {
    const n = seen.get(r.file) || 0;
    if (n >= maxSlots) continue;
    seen.set(r.file, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}


// ---- retrieval telemetry -------------------------------------------------
// One JSON line per search. This exists so curation can be TARGETED: the
// ablation of 2026-08-17 measured a hand-written description to be worth about
// two rank-1 positions across 101 documents, so rewriting the corpus blind is
// mostly wasted effort. What is worth rewriting is the memory that is actually
// retrieved and actually ranks badly, and nothing could say which until now.
//
// The payload logged is the one already through guardValue(): a credential
// pasted into a query is redacted here exactly as it is in the response.
// Failure is swallowed — telemetry must never be able to fail a search.
// One caller question = ONE queryId, however many rows fan-out writes.
// Measured on the frozen 2026-08-26/27 window: 180 "live" rows were 26 real
// questions — a multi-scope call logs one row per corpus, and nothing joined
// them, so the log over-reported failure by counting each empty scope as a
// failed query. The id is generated at the public entry and threaded through
// recursion via opts._queryId.
const newQueryId = () => randomUUID().slice(0, 8);

// The log grows without bound (27k rows / 10 MB in its first month). Over the
// cap, the live file rolls to ONE kept generation — never deleted, and the
// pre-fix era is separately preserved in archive-2026-08.query-log.jsonl.
const QUERY_LOG_MAX_BYTES = Number(process.env.MEMORY_QUERY_LOG_MAX_BYTES || 20 * 1024 * 1024);

function logQuery(payload, extra = {}) {
  let path;
  try { path = queryLogPath(); } catch (_) { return; }
  if (!path) return;
  try {
    try {
      if (statSyncFs(path).size > QUERY_LOG_MAX_BYTES) {
        renameSync(path, path.replace(/\.jsonl$/, '.1.jsonl'));
      }
    } catch (_) { /* no file yet, or the roll lost a race — either way, append */ }
    const top = (payload.results || payload.bestWeak || []).slice(0, 3)
      .map((r) => ({ name: r.name, score: r.score, prov: r.provenance }));
    appendFileSync(path, JSON.stringify({
      ts: new Date().toISOString(),
      // WHERE THE QUERY CAME FROM. Without this the log is dominated by the
      // suite's own absence probes -- "widget calibration" and "when is the CEO's
      // birthday" are deliberate negative fixtures, and they appeared as the top
      // 5 "real failures" the first time the log was analysed. A report that
      // confident and that wrong is the exact failure this server exists to stop.
      src: querySource(),
      // WHAT was asked matters as much as how the call arrived: eval:state and
      // the gold scorers drive the REAL handler, so their rows are honestly
      // 'live' — the stamp is what lets the analyser exclude them anyway.
      ...(isBenchmarkQuery(payload.query) ? { benchmarkQuery: true } : {}),
      queryId: extra.queryId || newQueryId(),
      // The WRITER's identity (D4), when it declares one. Lets an assertion
      // reason about rows it can prove it produced, instead of every row that
      // happened to land in the same second.
      ...(runId() ? { runId: runId() } : {}),
      // GRAPH SPREAD, WATCHED. Present only when spreading actually changed
      // the top 3 (spreadEffect) or when the mean-normalised shadow would
      // have disagreed (shadowDivergence). Logging only — neither field has
      // ever been read by anything that ranks.
      ...(extra.spreadEffect ? { spreadEffect: extra.spreadEffect } : {}),
      ...(extra.shadowDivergence ? { shadowDivergence: extra.shadowDivergence } : {}),
      scope: payload.scope,
      q: payload.query,
      mode: payload.mode,
      confidence: payload.confidence,
      noStrongMatch: !!payload.noStrongMatch,
      totalCandidates: payload.totalCandidates,
      // A confidently WRONG top answer used to log exactly like a success.
      // rank1/topScore make wrong-answer analysis possible after the fact.
      rank1: top[0]?.name,
      topScore: top[0]?.score,
      // Row-level failure shape: this SCOPE had nothing at all, vs it had
      // candidates and none was strong. Caller-level verdicts (every scope
      // failed) are derived by the analyser over the queryId group.
      ...(payload.totalCandidates === 0 ? { failKind: 'scope_empty' }
        : (payload.noStrongMatch ? { failKind: 'no_strong_match' } : {})),
      top
    }) + '\n', 'utf8');
  } catch (_) { /* never fail a search over telemetry */ }
}


// Resolve the `account` / `project` filters ONCE, for every action that takes them.
//
// This lived inside search() and latest() re-implemented it from scratch — badly:
// it compared `doc.account !== account` with strict equality, so an ARRAY value
// matched nothing (measured: 27 results as a string, 1 as a one-element array),
// and it never resolved the aliases at all, so `project:'this'` returned 0.
// Two hand-written copies of one rule is exactly how that drifted, so there is
// now one copy and both callers use it.
//
// 'mine' resolves to whatever THIS surface is configured as, so a caller does not
// have to know its own label. 'this' means the project this server is canonically
// pointed at. An unlabelled memory is never filtered out: hiding everything
// written before labelling existed would be a silent loss.
export function resolveFilters({ account = null, project = null } = {}) {
  const toSet = (v, alias) => {
    if (!v) return null;
    const list = (Array.isArray(v) ? v : [v]).map((x) => alias(String(x))).filter(Boolean);
    return list.length ? new Set(list) : null;
  };
  return {
    wantAccounts: toSet(account, (x) => (x === 'mine' ? accountLabel() : x)),
    wantProjects: toSet(project, (x) => (x === 'this' ? basename(dirname(memoryDirPath())) : x))
  };
}

export async function search(query, opts = {}) {
  const {
    limit = RETRIEVAL.defaultLimit,
    includeArchive = true,
    scope = 'curated',       // 'curated' | 'staging' | 'all'
    sessionId = null,        // restrict to one conversation
    account = null,          // 'mine' | a label | array of labels | null = all
    project = null,          // 'this' | a project folder | array | null = all
    after = null, before = null,   // HARD window — excludes
    near = null                    // SOFT anchor — tilts, hides nothing
  } = opts;

  // ONE id per caller question, shared by every fan-out row (see logQuery).
  const queryId = opts._queryId || newQueryId();

  // A multi-corpus scope ('all', 'everything', or an array) searches each
  // corpus against ITS OWN statistics and returns them as separate ranked
  // sections. That is what dissolves the competition problem: measured
  // 2026-08-17, one shared ranked list cost three memories their answer
  // outright, because a transcript of the user discussing a topic outscores the
  // distilled rule for a conversationally-phrased query.
  // 'all' is THE WORK SET (Daniel's rule) — library categories enter only when
  // named, or via 'everything'. See expandScope.
  if (isMultiScope(scope)) {
    const names = expandScope(scope);
    const parts = await Promise.all(names.map((s) => search(query, { ...opts, scope: s, _queryId: queryId })));
    const groups = Object.fromEntries(names.map((s, i) => [s, parts[i]]));

    // PROVENANCE ON THE COMBINED RESPONSE. Each group carries its own
    // indexBuiltAt (they are separate index files, built at different times), so
    // the top level reports the curated one plus the per-scope map — a reader
    // that only looks at the top level still cannot mistake one for the other.
    const builtByScope = Object.fromEntries(names.map((s) => [s, groups[s].indexBuiltAt ?? null]));
    const staleAny = names.some((s) => groups[s].indexStale);
    const staleTotal = names.reduce((a, s) => a + (groups[s].staleFiles || 0), 0);
    // The orphan-handoff alarm is HOISTED to the top level. It fires inside
    // groups.handoff.guidance via the recursive call above, but a scope:'all'
    // caller reading only the top-level fields would never see it — and that is
    // most callers, because 'all' is the scope people use when they do not know
    // where something lives. Same cached scan, so this costs nothing extra.
    const topG = (groups.handoff?.guidance || []).filter((l) => l.startsWith('ORPHAN HANDOFF'));
    // The library hint, in the same top-level spot and for the same reader: a
    // scope that expanded to work corpora only, while categories exist, has NOT
    // searched them — say so once rather than let silence read as absence.
    const libs = libraryCorpora();
    const missedLibs = libs.filter((c) => !names.includes(c));
    if (libs.length && missedLibs.length && names.some((n) => CORPORA.includes(n))) {
      topG.push(`${missedLibs.length} library categor${missedLibs.length === 1 ? 'y' : 'ies'} ` +
        `(${missedLibs.join(', ')}) exist and were NOT searched — library content is opt-in by design. ` +
        `Name one (scope:'${missedLibs[0]}') or use scope:'everything' to include them all.`);
    }

    // THE COMPACT EVERYTHING VIEW — scope === 'everything' EXACTLY, never 'all',
    // never an array: those keep today's shape byte-for-byte. Presentation only;
    // every group above was ranked exactly as its named scope ranks.
    let outGroups = groups;
    if (scope === 'everything') {
      const rowCap = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
        ? Math.floor(Number(opts.limit)) : EVERYTHING_VIEW.rowsPerSection;
      const snipCap = Number.isFinite(Number(opts.maxChars)) && Number(opts.maxChars) > 0
        ? Math.floor(Number(opts.maxChars)) : EVERYTHING_VIEW.snippetChars;
      outGroups = compactEverythingGroups(groups, names, { rowCap, snipCap });
      const hint = readTaskHint(query, names);
      if (hint) topG.unshift(hint);
      topG.push(`scope:'everything' is a COMPACT view: up to ${rowCap} row(s) per corpus, ${snipCap}-char ` +
        'snippets, diagnostic fields dropped, per-group boilerplate said once here. These are DEFAULTS, not ' +
        'ceilings — limit:/maxChars: raise them, and naming a scope returns its full section. Each ' +
        'trimmed section carries its own compactNote with the counts.');
      if (names.some((s) => (outGroups[s]?.bestWeak || []).length)) {
        topG.push('Sections flagged noStrongMatch hold NEAREST NEIGHBOURS under bestWeak, not ranked answers — ' +
          'do not report one as a memory of the thing asked on the strength of its rank; if a snippet looks ' +
          'like the answer, open its section and verify before quoting it. The full absence verdict is in the named scope.');
      }
      return {
        query, scope,
        guidance: topG,
        indexBuiltAt: builtByScope.curated ?? builtByScope[names[0]] ?? null,
        indexBuiltAtByScope: builtByScope,
        indexStale: staleAny,
        staleFiles: staleAny ? staleTotal : 0,
        staleWarning: staleAny
          ? names.map((s) => groups[s].staleWarning).filter(Boolean).join(' | ')
          : undefined,
        // Said once, instead of once per group.
        modifiedFieldNote: "each result's `modified` is that file's mtime AT INDEX TIME, not a live stat — memory({action:'get'}) returns a live one",
        serverVersion: serverVersionString(),
        serverStartedAt: SERVER_STARTED_AT,
        groups: outGroups,
        // The flat back-compat array would DUPLICATE every group row here, and
        // duplication was a third of the oversized response. In the compact
        // view it is a directory — name, corpus, score — not a second copy.
        results: names.flatMap((s) => (outGroups[s].results || []).map((r) => ({ name: r.name, corpus: s, score: r.score }))),
        resultsNote: 'results is a DIRECTORY of the group rows (name/corpus/score) — the rows themselves are under groups.<corpus>.',
        noStrongMatch: names.every((s) => groups[s].noStrongMatch)
      };
    }

    return {
      query, scope,
      ...(topG.length ? { guidance: topG } : {}),
      indexBuiltAt: builtByScope.curated ?? builtByScope[names[0]] ?? null,
      indexBuiltAtByScope: builtByScope,
      indexStale: staleAny,
      staleFiles: staleAny ? staleTotal : 0,
      staleWarning: staleAny
        ? names.map((s) => groups[s].staleWarning).filter(Boolean).join(' | ')
        : undefined,
      serverVersion: serverVersionString(),
      serverStartedAt: SERVER_STARTED_AT,
      groups,
      // Back-compat: a caller that only reads .results still gets something
      // sensible, curated first, and each row says which corpus it came from.
      results: names.flatMap((s) => (groups[s].results || []).map((r) => ({ ...r, corpus: s })))
        .slice(0, limit * names.length),
      noStrongMatch: names.every((s) => groups[s].noStrongMatch)
    };
  }

  const { wantAccounts, wantProjects } = resolveFilters({ account, project });

  const anchorMs = near ? Date.parse(near) : null;
  const afterMs = after ? Date.parse(after) : null;
  const beforeMs = before ? Date.parse(before) : null;

  // CHECK THE INDEX AGAINST THE CORPUS BEFORE ANSWERING FROM IT. This may
  // rebuild incrementally, in which case `idx` below is the fresh one.
  const { idx, stamp } = await ensureFresh(scope);
  if (!idx.present) {
    // A SECONDARY corpus with no index is empty, not broken: it may simply be
    // switched off. Saying `noStrongMatch` keeps a scope:'all' verdict honest —
    // without it, an absent handoff index read as "something matched".
    // The orphan alarm still fires here: "no handoff index AND a handoff file
    // is sitting one level below a root" is the emptiest possible corpus hiding
    // the very document being asked for.
    if (scope !== 'curated') {
      const orphanG = scope === 'handoff' ? orphanHandoffLines() : [];
      const out = { query, scope, mode: 'empty', results: [], noStrongMatch: true, ...stamp,
        ...(orphanG.length ? { guidance: orphanG } : {}) };
      // An empty scope is an ANSWERED question ("this corpus had nothing"),
      // and the caller-level analyser needs the row to say so: without it, a
      // fan-out over eight corpora logged only the non-empty ones and the
      // queryId group under-counted its own scopes.
      logQuery({ ...out, totalCandidates: 0 }, { queryId });
      return out;
    }
    return { mode: 'unavailable', error: 'no index — run `npm run index` (or memory({action:"index"}))', results: [], ...stamp };
  }

  // PRESENT BUT EMPTY is a real state, and it is the FIRST state every new install
  // is in: `npm run index` on a machine with no memories yet writes a perfectly
  // valid index containing zero documents. `present` is then true while `bm25` is
  // null, because buildBm25 is skipped for an empty corpus (see loadScope) — and
  // every search threw "Cannot read properties of null (reading 'postings')".
  //
  // Found by installing the zip on a clean HOME and running the stdio check, which
  // is the only place this could have shown up: no developer machine is ever empty.
  if (!idx.docs.length) {
    const out = {
      query, scope, mode: 'empty', results: [], noStrongMatch: true, ...stamp,
      note: 'This corpus has an index but NO DOCUMENTS in it. On a new install that is ' +
        'expected until memories are written or a conversation is captured — nothing is ' +
        'broken, and there is nothing to find yet.'
    };
    logQuery({ ...out, totalCandidates: 0 }, { queryId });   // same reason as the no-index row above
    return out;
  }

  const docs = idx.docs;
  const model = idx.bm25;

  // ---- D5: IS THIS A READ TASK? Asked for EVERY scope, not just 'everything'.
  // readTaskHint() handled this correctly from the day it was written and was
  // only ever called inside the scope:'everything' branch, so a named library
  // scope asking "summarize <a document this corpus holds>" got a refusal and
  // no hint. Computed here because the second half of the fix (flag-gated
  // below) needs it before the term statistics are taken.
  const readHint = readTaskHint(query, [scope]);
  const readVerb = READ_VERB_RE.exec(String(query || ''));

  // ---- keyword side (normalised below, once we know whether we are fusing) ----
  const { scores: rawKw, matchedTerms } = bm25Search(model, query);
  // THE READ VERB IS NOT A MISSING SUBJECT (D5, flag MEMORY_READ_VERB_WEIGHT).
  // `summarize` appears in no document, so it was charged as evidence that the
  // corpus lacks what was asked for — 49% of one observed query's
  // discriminative weight. Only when the hint actually fired, and only the
  // matched verb text: the keyword and semantic legs still read the whole
  // question, and a query about a "summary section" is untouched because the
  // hint does not fire on it.
  const stripVerbWeight = readVerbWeightEnabled() && readHint && readVerb;
  const stats = queryTermStats(model,
    stripVerbWeight ? String(query).slice(readVerb[0].length) : query);

  // ---- PHASE 4a: model -> family expansion, keyword leg only ---------------
  // A question about ACME-673A is a question about the ACME-x73A manual. The
  // family stems ride as a SEPARATE, lower-weighted keyword pass so that
  // `matchedTerms`, the phrase window, the semantic query and the term
  // statistics all keep reading the question as it was asked. rawKwUnexpanded
  // is kept because the absence verdict must never see the expansion: a
  // refusal is about the caller's words, and expansion is not allowed to argue
  // one away. Flag MEMORY_SKU_ALIAS, default per the pre-registered bar.
  const aliasAdded = aliasExpansion(query, { scope });
  let rawKwUnexpanded = rawKw;
  const aliasBoost = new Map();
  if (aliasAdded.length) {
    rawKwUnexpanded = new Map(rawKw);
    const w = aliasWeight();
    const { scores: aliasKw } = bm25Search(model, aliasAdded.join(' '));
    for (const [i, v] of aliasKw) {
      aliasBoost.set(i, w * v);
      rawKw.set(i, (rawKw.get(i) || 0) + w * v);
    }
  }

  // ---- semantic side ----
  const sem = new Map();
  const bestChunk = new Map();
  let mode = 'bm25-only';
  let degradedReason = idx.headerProblems.length
    ? `index header refused: ${idx.headerProblems.join('; ')}`
    : embeddingsDisabledReason();

  if (idx.dense) {
    const qvec = await embedQuery(query);           // QUERY: prefix applied.
    if (qvec) {
      mode = 'hybrid';
      degradedReason = null;
      docs.forEach((doc, i) => {
        let best = -1, bestText = null;
        for (const c of doc.chunks || []) {
          if (!isVec(c.vec)) continue;
          const s = cosine(qvec, c.vec);
          if (s > best) { best = s; bestText = c.text; }
        }
        // The doc-level summary vector competes on equal footing, so a
        // three-line standing rule can out-rank a 60-chunk runbook.
        if (isVec(doc.summaryVec)) {
          const s = cosine(qvec, doc.summaryVec);
          if (s > best) { best = s; bestText = bestText || doc.description; }
        }
        const scaled = rescaleCosine(best);
        if (scaled > 0) { sem.set(i, scaled); bestChunk.set(i, bestText); }
      });
    } else {
      degradedReason = embeddingsDisabledReason() || 'query embedding failed';
    }
  }

  // ---- normalise the keyword leg ----
  // Fusing: the score has to mean the same thing on every query, so it is
  // measured against an absolute scale. Not fusing: nothing to be compared
  // against, so keep the historical per-query-max form.
  const kw = mode === 'hybrid' ? absoluteKeyword(rawKw, stats) : normalise(rawKw);
  // The same leg WITHOUT the family expansion, kept only so the absence
  // verdict can be computed on the question as asked (Phase 4a). Identical
  // object when nothing was expanded, so the no-alias path costs nothing.
  const kwUnexpanded = aliasAdded.length
    ? (mode === 'hybrid' ? absoluteKeyword(rawKwUnexpanded, stats) : normalise(rawKwUnexpanded))
    : kw;

  // ---- fuse, pass 1: keyword + (length-corrected) semantic ----
  const { keyword: wk, semantic: ws, phrase: wp } = RETRIEVAL.fuse;
  const candidates = new Set([...kw.keys(), ...sem.keys()]);
  const pass1 = [];
  for (const i of candidates) {
    const doc = docs[i];
    if (!includeArchive && doc.tier === 'archive') continue;
    // HARD filters: these EXCLUDE, so they are only ever applied when asked for.
    if (sessionId && doc.sessionId !== sessionId) continue;
    if (wantAccounts && doc.account && !wantAccounts.has(doc.account)) continue;   // accountFilter
    if (wantProjects && doc.project && !wantProjects.has(doc.project)) continue;
    if (afterMs || beforeMs) {
      const t = Date.parse(doc.modified);
      if (Number.isFinite(t)) {
        if (afterMs && t < afterMs) continue;
        if (beforeMs && t > beforeMs) continue;
      }
    }
    const k = kw.get(i) || 0;
    const rawSem = sem.get(i) || 0;
    // PHASE B -- A SECTION IS PENALISED AS ITS PARENT.
    //
    // longDocFactor exists because scoring a document by the MAXIMUM over its
    // chunks lets a 517-chunk document beat a 3-chunk one on volume alone.
    // Splitting that document into sections hands the advantage straight back
    // through the side door: 138 changelog sections are 138 small documents,
    // each individually short enough to escape the penalty entirely.
    //
    // Measured before this correction: the changelog took a top-3 slot on 20 of
    // 32 probes, up from 0. Recall fell 10/10 -> 9/10 and MRR 0.833 -> 0.683 --
    // almost exactly the staging-blend regression (0.826 -> 0.681) the plan
    // warned that this class of change reproduces.
    //
    // A child is therefore scored with its PARENT'S chunk count, summed over
    // every doc sharing the file. A section of a huge document is still part of
    // a huge document, and the correction has to see it that way.
    const ownChunks = (doc.chunks || []).length;
    const nChunks = doc.parentName
      ? sectionEffectiveChunks(ownChunks, chunksByFile(idx).get(doc.file) || ownChunks)
      : ownChunks;
    const ldf = mode === 'hybrid'
      ? longDocFactor(nChunks, idx.referenceChunks, k, doc.parentName ? sectionWaiver() : undefined)
      : 1;
    const s = rawSem * ldf;
    const base = mode === 'hybrid' ? wk * k + ws * s : k;
    if (base <= 0) continue;
    pass1.push({ i, doc, k, s, rawSem, ldf, base });
  }
  pass1.sort((a, b) => b.base - a.base);

  // ---- fuse, pass 2: the phrase leg, over the rerank set only ----
  // Everything below the rerank set keeps phrase = 0, which is what it would
  // almost certainly have scored anyway: the leg only fires on a document that
  // holds the query's words side by side, and such a document is not sitting at
  // rank 40 on the other two legs.
  const rerankTo = Math.min(pass1.length, Math.max(RETRIEVAL.rerankSet, limit));
  let topPhrase = 0;
  for (let n = 0; n < rerankTo; n++) {
    const row = pass1[n];
    const win = matchedTerms.length ? bestWindow(row.doc, matchedTerms) : null;
    row.phrase = win ? win.phrase : 0;
    row.window = win;
    if (row.phrase > topPhrase) topPhrase = row.phrase;
    row.base = mode === 'hybrid' ? wk * row.k + ws * row.s + wp * phraseContribution(row.phrase) : row.k;
  }

  const scored = [];
  // name -> the score this document would have had WITHOUT family expansion.
  // Only the top row's entry is ever read (by the absence verdict), but it is
  // built for every row so the map cannot disagree with the ranking.
  const aliasFreeScore = new Map();
  for (const row of pass1) {
    const { doc, k, s, base } = row;
    const phrase = row.phrase || 0;
    const envelope = tierBoost(doc) * recencyFactor(doc.modified) * nearFactor(doc.modified, anchorMs);
    const score = base * envelope;
    if (aliasAdded.length) {
      const kU = kwUnexpanded.get(row.i) || 0;
      const baseU = mode === 'hybrid'
        ? wk * kU + ws * s + wp * phraseContribution(phrase)
        : kU;
      aliasFreeScore.set(doc.name, baseU * envelope);
    }
    const provenance = k > 0 && s > 0.35 ? 'both' : (k > 0 ? 'keyword' : (phrase > 0.2 ? 'phrase' : 'semantic'));
    // Snippet: the phrase window decides where to cut whenever the keyword leg
    // found anything at all — that is what makes a verbatim search return the
    // sentence rather than the top of the document. Only a purely semantic hit
    // falls back to the best-matching chunk.
    let snippet;
    if (row.window) snippet = snippetAround(bodyOf(doc), row.window.charStart, row.window.charEnd);
    else snippet = trimSnippet(bestChunk.get(row.i) || doc.description);
    scored.push({
      name: doc.name,
      file: doc.file,
      // WHICH CORPUS answered. scope:'all' used to be the only response that said
      // so, which made a single-scope row ambiguous the moment there was more
      // than one corpus holding hot, writable, project-stamped memories.
      corpus: scope,
      description: doc.description,
      tier: doc.tier,
      inMemoryIndex: doc.inMemoryIndex,
      type: doc.type,
      // attribution travels WITH the hit: a caller that can filter by account
      // but cannot see it has to guess where an answer came from.
      account: doc.account || null,
      project: doc.project || null,
      sessionId: doc.sessionId || null,
      sessionTitle: doc.sessionTitle || null,
      // WHERE this came from. For a handoff document the folder is the whole
      // provenance story — its file id is only a namespaced basename.
      path: doc.sourcePath || null,
      readOnly: !!doc.readOnly,
      // THE FILE'S MTIME AT INDEX TIME, not a live stat. Read as a live value on
      // 2026-08-19 it produced a confidently wrong conclusion about project
      // state, which is why `indexBuiltAt` and `modifiedFieldNote` are stamped
      // on every response. memory({action:"get"}) returns a live mtime.
      modified: doc.modified,
      score: Number(score.toFixed(4)),
      keywordScore: Number(k.toFixed(4)),
      semanticScore: Number(s.toFixed(4)),
      phraseScore: Number(phrase.toFixed(4)),
      provenance,
      snippet,
      links: doc.links
    });
  }
  scored.sort((a, b) => b.score - a.score);
  // capPerDocument first, over the WHOLE ranked list: capArchiveShare has to be
  // able to reach past a run of archive hits to find the hot documents it is
  // holding space for, and a pre-truncated pool cannot (measured: a limit*3 pool
  // was already 7/9 archive, so the giveback path handed the slots straight back).
  // THE PER-FILE CAP DOES NOT FIT A LIBRARY CORPUS. capPerDocument counts slots
  // by r.file so a parent and its children never pose as independent evidence —
  // correct where a corpus holds hundreds of files. A library category is often
  // ONE file: the first manual question measured returned exactly one row (the
  // parent nav stub) because every page section shares the manual's file, so no
  // section could ever reach the caller. Three sections of the same manual ARE
  // the answer there. Work corpora keep the cap unchanged (a48 pins that).
  const perDocCap = isLibraryCorpus(scope) ? Infinity : undefined;
  const shapeRows = (rows) => capArchiveShare(capPerDocument(rows, rows.length, perDocCap), limit)
    .map((r) => withThreadPosition(r, idx));
  // THE PRE-SPREAD RANKING IS KEPT. The absence verdict is judged on it
  // (Phase 4c): spreading may reorder what the query reached, never turn a
  // refusal into an answer — the same rule Phase 4a's expansion obeys.
  const resultsPreSpread = shapeRows(scored);
  let results = resultsPreSpread;
  let graphSpreadInfo = null;
  let spreadEffectRow = null, shadowRow = null;

  // ---- PHASE 4c: gated spreading over the hand-authored [[wiki-link]] graph
  // Curated only, single hop, from the pre-spread scores, and only onto
  // documents the query already reached that clear the similarity gate.
  if (graphSpreadEnabled() && scope === 'curated') {
    const byName = new Map(idx.docs.map((d) => [d.name, d]));
    const linksOf = (name) => {
      const d = byName.get(name);
      return d ? { links: d.links || [], backlinks: d.backlinks || [] } : null;
    };
    const { rows: spreadRows, spread } = applyGraphSpread(scored, linksOf);
    if (spread.length) {
      results = shapeRows(spreadRows);
      // TELEMETRY, NOT PAYLOAD. Both of these go to the query log and nowhere
      // near `out` — a caller's bytes do not change because watching is on.
      spreadEffectRow = spreadEffect(resultsPreSpread, results);
      shadowRow = shadowDivergence(scored, linksOf, results,
        { alpha0: spreadAlpha(), docs: idx.docs, shape: shapeRows });
      graphSpreadInfo = { received: spread.length,
        note: 'GRAPH SPREAD: some results were lifted by the [[wiki-link]]s a person wrote between ' +
          'these memories — a linked neighbour of a strong hit, which also matched the question on ' +
          'its own. The absence verdict was computed BEFORE any of this.' };
    }
  }

  // VERIFICATION BELONGS HERE MOST OF ALL. attachCommits was wired into latest()
  // and thread() and not into search() -- and the query log says search is 98.4%
  // of real traffic, so the check that turns a claim into a fact was missing from
  // the action almost everyone actually calls. Same batch, same cache: one git
  // process for the whole response, nothing when MEMORY_GIT_REPOS is unset.
  const byNameForCommits = new Map(idx.docs.map((d) => [d.name, d]));
  await attachCommits(results, results.map((r) => bodyOf(byNameForCommits.get(r.name)) || ''));

  // ---- the absence verdict ----
  // THE VERDICT IS COMPUTED ON THE QUESTION AS ASKED. Both of its inputs are
  // handed over unexpanded (Phase 4a): the raw keyword mass, and — through
  // aliasFreeScore — the top document's score. Expansion can move what ranks;
  // it can never turn "I have no memory of that" into an answer.
  const verdict = absenceVerdict({ results: resultsPreSpread, topPhrase, rawKw: rawKwUnexpanded, stats, mode, aliasFreeScore, scope });
  // Refusals keep their empty list; an answered query is answered with the
  // spread ordering. Nothing here can create or destroy a refusal.
  if (verdict.results && verdict.results.length) verdict.results = results;

  // SHADOW ONLY. Runs after the verdict is final, reads what the verdict already computed, and
  // writes to a log. Its return value is deliberately discarded: there is no expression here
  // whose value can reach a caller, so the probe cannot change an answer even by accident.
  // See lib/ordinary-shadow.js and test/ordinary-word-shadow-preregistration.md.
  observeAbsence({ query, scope, stats, verdict });

  // CORPUS CURRENCY, ON THE ACTION PEOPLE ACTUALLY USE. corpusCurrency fired
  // only from latest() while ~95% of real traffic is search — the f2fffdd
  // defect class (verification wired into the paths the author was thinking
  // about) for the third time. Cached with a TTL because search volume is what
  // latest never had: one rev-list bundle per corpus state per minute, not per
  // query. Silent no-op without MEMORY_GIT_REPOS, exactly like latest.
  let currency = null;
  try {
    currency = idx.newestTs ? await cachedCorpusCurrency(new Date(idx.newestTs).toISOString()) : null;
  } catch (_) { currency = null; }

  // C2 -- awaited HERE because the guidance below is assembled synchronously.
  // Cached and time-boxed in git-join; a no-op without MEMORY_GIT_REPOS.
  const autoIdent = await autoVerifyQuery(query);

  const out = guardValue({
    query,
    scope,
    mode,
    // WHEN was this index built, WHICH build of the server answered, and is the
    // index still level with the corpus. Additive: no existing field moved.
    ...stamp,
    degradedReason: degradedReason || undefined,
    matchedTerms,
    unmatchableTerms: stats.absent.length ? stats.absent : undefined,
    // The STRUCTURED half of F1: the guidance line above is prose a caller has to
    // read; this is the field it can branch on, mirroring latest().
    ...(() => {
      const u = staleTermCollision(stats.absent, stamp) ? null : staleContentScan(stats.absent, stamp);
      if (!u) return {};
      // scanTruncated rides alongside: a caller branching on foundInUnindexed being empty
      // must be able to tell "we looked everywhere and found nothing" from "we ran out of
      // budget" — opposite conclusions from the same empty object.
      return { foundInUnindexed: u.foundInUnindexed,
               ...(u.scanTruncated ? { scanTruncated: u.scanTruncated } : {}) };
    })(),
    totalCandidates: scored.length,
    ...verdict,
    guidance: (() => {
      const g = buildGuidance(verdict.results || verdict.bestWeak || [], { scope, query }) || [];
      // Same diagnosis as latest(): an unmatchable term that names a file the
      // staleness check just flagged is a STALE INDEX, not an absence.
      const c = staleTermCollision(stats.absent, stamp);
      // 🟥 F1 (2026-08-30). The FILENAME pass above was already here; the CONTENT
      // pass was not — it only ever lived in latest(). So the motivating incident was
      // alive in this sibling API: the five cases where lib/freshness.js REFUSES an
      // inline repair (>8 files changed, embedder unavailable, a failed rebuild inside
      // the cooldown, a header change, and staging which never repairs inline by
      // design) all leave search() answering from a stale index — able to imply
      // absence while its own staleWarning names the file holding the answer.
      // Runs only when the filename pass found nothing AND a term is still
      // unmatchable, exactly as latest() does, so a fresh index does no extra work.
      const unindexedHere = c ? null : staleContentScan(stats.absent, stamp);
      const pre = [];
      if (unindexedHere) pre.push(unindexedHere.note);
      // FIRST, when it fires: it reframes the entire response. A caller told
      // "these are fragments, read the document instead" does not need to be
      // talked out of the absence note first.
      if (readHint) pre.push(readHint);
      if (c) pre.push(c);
      if (autoIdent) pre.push('NOT IN THE CODE — ' + autoIdent.note);
      // THE SMOKE ALARM. A handoff document one level below a root matches the
      // patterns and is indexed by nothing (the scan is flat by design), which
      // is invisible everywhere except here — the moment someone queries the
      // handoff corpus and might conclude "no handoff exists". Cached with a
      // short TTL in lib/orphan-handoffs.js, so this is not a readdir per query.
      if (scope === 'handoff') pre.push(...orphanHandoffLines());
      // Fires only when there IS a gap — the same say-it-when-true rule the
      // last-word caveat follows. A zero-commit confirmation is a field, not
      // a guidance line.
      if (currency && currency.commitsSince.some((r) => r.commitsSince > 0)) pre.push(currency.note);
      return pre.length ? [...pre, ...g] : (g.length ? g : undefined);
    })(),
    ...(currency ? { corpusCurrency: currency } : {}),
    // SAY WHEN A QUESTION WAS BROADENED. A caller who asked about one model
    // and is handed a family manual deserves to know which word did that.
    ...(aliasAdded.length ? { modelFamilyExpansion: { added: aliasAdded, note: aliasNote(aliasAdded) } } : {}),
    ...(graphSpreadInfo ? { graphSpread: graphSpreadInfo } : {}),
    identifiersNotInCode: autoIdent ? autoIdent.identifiersNotInCode : undefined
  }, 'search-output');
  logQuery(out, { queryId, spreadEffect: spreadEffectRow, shadowDivergence: shadowRow });
  return out;
}

// One rev-list bundle per (corpus newest-timestamp, repo set) per TTL window.
// latest() could afford a per-call git spawn; search cannot — it is ~95% of
// traffic and the everything scope fans out to eight corpora per question.
const CURRENCY_CACHE = new Map();   // key -> { at, value }
const currencyTtlMs = () => Number(process.env.MEMORY_CURRENCY_TTL_MS || 60000);
async function cachedCorpusCurrency(sinceIso) {
  const key = `${sinceIso}|${configuredRepos().map((r) => r.dir).join(':')}`;
  const hit = CURRENCY_CACHE.get(key);
  if (hit && Date.now() - hit.at < currencyTtlMs()) return hit.value;
  const value = await corpusCurrency(sinceIso);
  CURRENCY_CACHE.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Can the server say "I have no memory of that"?
 *
 * Only when all three independent weaknesses coincide (see RETRIEVAL.absence
 * for the measured constants and why a single score threshold cannot work):
 * nothing scored well, the query's words never occur together anywhere, and —
 * once the words that exist nowhere in the corpus are charged for — most of the
 * question went unanswered.
 *
 * The results are still returned, under `bestWeak`, because "nothing strong,
 * but here is the nearest thing" is more useful than an empty array and lets
 * the caller overrule the verdict. What changes is the label: a caller that
 * sees `noStrongMatch: true` must not report the top hit as an answer.
 */
function absenceVerdict({ results, topPhrase, rawKw, stats, mode, aliasFreeScore = null, scope = null }) {
  // PER CORPUS, not per server. A floor calibrated on curated and applied to a
  // one-book library category does not measure absence, it measures the
  // corpus — see lib/absence-floors.js. Falls back to the shipped constants
  // for any corpus with no derived profile.
  const { scoreFloor, phraseFloor, coverageFloor, orphanFloor, weakResults } = floorsFor(scope);
  const top = results[0];
  if (!top) {
    return {
      noStrongMatch: true, confidence: 'none', results: [], bestWeak: [],
      absenceNote: 'No document matched any term of this query and no passage was semantically close. Treat as absent from memory.'
    };
  }
  // The absence rule is calibrated on the fused three-leg score. In degraded
  // (bm25-only) mode there is no dense leg and the keyword score is per-query
  // normalised, so the constants do not apply — never claim absence there.
  if (mode !== 'hybrid') return { confidence: 'unrated', results };

  let bestRaw = 0;
  for (const v of rawKw.values()) if (v > bestRaw) bestRaw = v;
  const strictCoverage = stats.idealFull > 0 ? bestRaw / stats.idealFull : 0;
  // PHRASE EVIDENCE COUNTS IN PROPORTION TO WHAT IT COVERS. bestWindow computes
  // adjacency over the MATCHED terms only, so a query whose one discriminative
  // term is an orphan can still score topPhrase 1.0 on the ordinary words left
  // over — measured on the library corpus: "warranty period of the Zentrifax
  // burner" hit phrase 1.0 ("warranty period", adjacent in GPL boilerplate)
  // with orphanShare 0.83 and lexical coverage 0.06, and the phrase guard
  // blocked BOTH absence routes. A perfect phrase over 6% of the question is
  // not the verbatim-quote case the guard exists for: a real quote carries its
  // coverage with it. So the guard reads the phrase DISCOUNTED by how much of
  // the question the document answers lexically — a full-coverage phrase is
  // untouched, a residue phrase shrinks to what it actually proves.
  const effPhrase = topPhrase * Math.min(1, strictCoverage / coverageFloor);
  // THE SCORE THE VERDICT JUDGES ON is the one the caller's own words earned.
  // With family expansion on, top.score contains borrowed keyword mass, and
  // judging absence on it would let expansion overturn a refusal — the one
  // thing the layer is forbidden to do.
  const topScore = (aliasFreeScore && aliasFreeScore.has(top.name)) ? aliasFreeScore.get(top.name) : top.score;
  // The three numbers the verdict is made of, always reported: a surprising
  // verdict should be as diagnosable as a surprising rank.
  const signals = {
    topScore: Number(topScore.toFixed(4)),
    topPhrase: Number(topPhrase.toFixed(4)),
    effectivePhrase: Number(effPhrase.toFixed(4)),
    lexicalCoverage: Number(strictCoverage.toFixed(4)),
    orphanShare: Number(stats.orphanShare.toFixed(4))
  };

  // Two independent routes to a no-match verdict, because two different things
  // make a question unanswerable.
  //   VOCABULARY — the words that make the question specific exist nowhere in
  //     the corpus, and nothing in it holds the remaining words together. This
  //     is the strong signal, and it does not need a score threshold: an
  //     orphan share this high means the corpus has never discussed the thing.
  //   EVIDENCE — every word is familiar, but nothing scored, nothing is
  //     phrased that way, and most of the question went unanswered. Needs all
  //     three because each one alone fires on real questions.
  const byVocabulary = stats.orphanShare >= orphanFloor && effPhrase < phraseFloor;
  const byEvidence = topScore < scoreFloor && effPhrase < phraseFloor && strictCoverage < coverageFloor;
  if (!byVocabulary && !byEvidence) {
    return { confidence: topScore >= scoreFloor ? 'high' : 'medium', signals, results };
  }

  // Is this the "your words, not the corpus's words" refusal? See absenceNote below for the
  // measurement. Derived from scoreFloor rather than a new constant, because the two routes
  // already partition on it: byEvidence cannot fire at or above scoreFloor.
  const readThisFirst = topScore >= scoreFloor;
  const why = byVocabulary
    ? `the term(s) that make this question specific appear NOWHERE in the corpus (${stats.orphans.join(', ')} — ` +
      `${(stats.orphanShare * 100).toFixed(0)}% of the query's discriminative weight, floor ${orphanFloor * 100}%)`
    : `best score ${topScore.toFixed(3)} < ${scoreFloor}, no passage holds these words together ` +
      `(effective phrase ${effPhrase.toFixed(3)} < ${phraseFloor}), and only ${(strictCoverage * 100).toFixed(0)}% of the question ` +
      `is answered lexically (floor ${(coverageFloor * 100).toFixed(0)}%)`;

  return {
    noStrongMatch: true,
    confidence: 'low',
    signals,
    // VERIFY-THEN-QUOTE, not never-quote. The old wording said a bestWeak row
    // is never an answer, full stop — and the library casualty proved that
    // over-refuses: the answer was sitting verbatim in the returned snippet
    // while the server said it had nothing. A caller who can OPEN the section
    // and see the sentence is not guessing. What stays forbidden is the thing
    // that actually goes wrong: reporting a near neighbour as a memory of the
    // thing asked because it came back and looked plausible.
    absenceNote: readThisFirst
      // SEMANTICALLY CLOSE, LEXICALLY FAR — lead with the instruction, not the prohibition.
      // The evidence route REQUIRES topScore < scoreFloor, so a refusal that scored ABOVE it
      // can only have come from the vocabulary route: everything about this result is strong
      // except that the caller's words are not the corpus's words. That is the case where the
      // answer is most often sitting in bestWeak[0] — measured 21/21 on a corpus whose own
      // vocabulary was too narrow to recognise ordinary questions, against 0/40 and 0/40 for
      // questions with nothing close on either corpus (test/fixtures/ordinary-word-absences.json
      // and the pre-registration). The old wording opened with "do not report one as a memory
      // of this", which is the right rule and the wrong first sentence: the reader who most
      // needs to OPEN the document is the one being told first what not to do with it.
      //
      // This changes NO verdict and no score. noStrongMatch, bestWeak and every signal are
      // exactly as before; only the order and emphasis of the sentence differ.
      // TWO CORRECTIONS, both from a first-use report by a reader who had never seen this tool.
      //
      // 1. It reused the ABSENCE branch's wording — "the term(s) that make this question specific
      //    appear NOWHERE in the corpus (often, feed)" — which is literally true and pragmatically
      //    false here. Measured case: the corpus says "the starter is fed twice a day", so the FORM
      //    "feed" appears nowhere, and the note announced the topic was missing while the answer sat
      //    at 0.966. The reader's words for it: "the tool talks itself out of matches it actually
      //    made." This branch now says the true thing — your exact forms are not in it — and stops
      //    implying an absence that is precisely what this branch exists to leave UNDECIDED.
      // 2. It ran to 125 words of near-identical hedging on every refusal, dwarfing the data it was
      //    attached to. A warning nobody finishes reading is not a warning.
      ? `READ BEFORE JUDGING: a document here scored ${topScore.toFixed(3)}, but your distinctive ` +
        `words are not in it (stems: ${(stats.orphans || []).join(', ')} — ` +
        `${(stats.orphanShare * 100).toFixed(0)}% of the query; the corpus may use other forms of the ` +
        'same idea). That looks identical whether it is your answer in different language or a ' +
        'different topic nearby, so only the text decides. OPEN bestWeak[0] and read it: cite it if ' +
        'it answers, say the memory is absent if it does not.'
      : `No strong match: ${why}. The documents under bestWeak are the nearest neighbours, NOT ranked ` +
        'answers — do not report one as a memory of this on the strength of its rank. But they are real ' +
        'passages: if a snippet appears to contain the answer, OPEN its section and read it, and you may ' +
        'rely on what you can see there. Quote what you verified, not what was returned.',
    results: [],
    bestWeak: results.slice(0, weakResults)
  };
}

/** Top-N semantically nearest docs to `doc` — the free expansion signal. */
export async function nearest(doc, docs, n = 3) {
  const vecs = (doc.chunks || []).map((c) => c.vec).filter(isVec);
  if (!vecs.length) return [];
  const out = [];
  for (const other of docs) {
    if (other.name === doc.name) continue;
    let best = -1;
    for (const c of other.chunks || []) {
      if (!isVec(c.vec)) continue;
      for (const v of vecs) {
        const s = cosine(v, c.vec);
        if (s > best) best = s;
      }
    }
    if (best > 0) out.push({ name: other.name, similarity: Number(best.toFixed(4)), tier: other.tier });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, n);
}


// ---------------------------------------------------------------------------
// latest() — "what is the CURRENT STATE of X", as opposed to "what best matches X".
//
// WHY THIS EXISTS, and it is a usage failure made concrete. Asked whether a
// re-parse had finished, I ran a similarity search, got the exchange where the
// work STARTED at 0.88, saw no completion above it, and reported the answer was
// unknowable. It was not. The corpus held the conclusion — in the very same
// exchange — and an exhaustive scan ordered by time found it immediately.
//
// Similarity cannot separate "we are starting X" from "X is finished": both look
// equally like a question about X. Ranking by relevance and reading the top hit
// is the WRONG METHOD for a state question, however good the ranker is.
//
// So: match on terms (exhaustively, no ranking), then order by TIME, newest
// first. The last thing said about a topic is the last word on it — and if the
// thread simply stops, "last word: still in progress" is at least honest.
// A corpus's CLOCK, derived from its data rather than assumed. Exchanges ingested
// from transcripts carry `ts` — when the words were actually said. Curated memory
// files do not, so their only ordering is file mtime, and mtime is BOOKKEEPING,
// not chronology: the 2026-08-19 account-labelling backfill rewrote all 118
// curated files in a single pass, so by mtime every one of them outranks a
// genuine 08-22 conversation. That is why `scope:'all'` segments instead of
// merging — see latestAll().
// How many times the query's terms occur in a document. A term mentioned once in
// 17k characters and a term the document is ABOUT are both "a match" to an AND
// filter; this is what lets a caller tell them apart without reading the body.
// The snippet, taken AROUND THE MATCH and anchored on the RAREST term -- the most
// distinctive one, and so the one whose neighbourhood explains why this document
// came back. Falls back to the document tail only if nothing is locatable.
function matchSnippet(body, terms, df) {
  const hay = String(body || '').toLowerCase();
  const ranked = [...terms].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
  for (const t of ranked) {
    const i = hay.indexOf(t);
    if (i !== -1) return snippetAround(body, i, i + t.length);
  }
  return body.slice(-RETRIEVAL.snippetChars * 2);
}

// CONTEXT-COMPACTION SUMMARIES ARE DERIVATIVE DOCUMENTS, and for a time-ordered
// question they are actively harmful.
//
// When a session runs out of context the harness re-opens it with a summary of
// everything so far, and ingest stores that as an exchange like any other. The
// result is a very long document that restates an entire conversation -- so it
// contains almost every term, matches almost every AND filter, and carries a
// RECENT timestamp. Measured: 34 of 2,318 documents, and one of them took first
// place on 5 of 6 real test questions, including one where its only relevance was
// that it restated the QUESTION.
//
// This is the corpus-clock mismatch in miniature: the `ts` says now, the content
// is about before. A summary of the past cannot be the last word by construction,
// so it must never take first place from a real exchange.
//
// EXCLUDING them outright was tried first and measured WORSE: on the six-question
// test it fixed one question (the real answer had been buried under a summary that
// merely restated the QUESTION) and broke another (whose answer existed ONLY in a
// summary -- a distilled index of a conversation is sometimes the best source
// there is). So they are DEMOTED and LABELLED, never dropped: a summary can still
// answer, it just cannot outrank a first-hand exchange. `includeSummaries:false`
// removes them entirely for a caller who wants only primary sources.
//
// The marker is an exact string the HARNESS emits, not a vocabulary anyone wrote
// -- the standing rule against hand-written regexes is about inferring meaning
// from language, which this is not.
const COMPACTION_MARKER = 'This session is being continued from a previous conversation';
function isCompactionSummary(doc) {
  const head = ((doc.description || '') + ' ' + String(bodyOf(doc) || '').slice(0, 400));
  return head.includes(COMPACTION_MARKER);
}

function countHits(body, terms) {
  const hay = String(body || '').toLowerCase();
  let n = 0;
  for (const t of terms) {
    let i = hay.indexOf(t);
    while (i !== -1) { n++; i = hay.indexOf(t, i + t.length); }
  }
  return n;
}


// Attach VERIFIED commits to result rows, in ONE batch for the whole response.
//
// Per-row verification would spawn git once per result per repo; collecting every
// candidate first means a query costs one process, and the module's cache makes
// repeat queries free. Rows gain `verifiedCommits` only when something actually
// verified -- an empty array on every row would be noise, and would also imply
// "nothing was committed" when the truth is "no SHA was cited here".
async function attachCommits(rows, bodies) {
  if (!configuredRepos().length || !rows.length) return rows;
  // BOUNDED. A compaction summary can cite 27 commits, and a response is several
  // rows: uncapped, one cold query spent 2.6 s verifying tokens nobody asked about.
  // The cap is per row, because the first SHAs a document cites are the ones it is
  // about and the tail is usually incidental.
  const PER_ROW = 12;
  const per = rows.map((_, i) => extractShas(bodies[i]).slice(0, PER_ROW));
  const all = [...new Set(per.flat())].slice(0, 60);
  if (!all.length) return rows;
  let found;
  try {
    found = await verifyShas(all);
  } catch {
    return rows;   // verification is an ENRICHMENT: never fail a query over it
  }
  if (!found.size) return rows;
  rows.forEach((r, i) => {
    const hits = per[i].filter((sh) => all.includes(sh)).map((sh) => found.get(sh)).filter(Boolean)
      .map((c) => ({ sha: c.sha, repo: c.repo, date: c.date, onMainline: c.onMainline, subject: c.subject }));
    if (hits.length) r.verifiedCommits = hits;
  });
  return rows;
}

// ── "That term is not missing — your index predates it" ────────────────────
//
// On 2026-08-25 a search for `v111 zip shipped gates` returned v108/v107/v105.
// `zip-v111-shipped.md` had been added AFTER the index was built, so `v111` came
// back in `unmatchableTerms` and the answer was two releases stale. The response
// already carried BOTH halves — `unmatchableTerms: ["v111"]` and a
// `staleFilesAdded` list naming `zip-v111-shipped.md` — and nothing connected
// them. The caller saw a plausible answer from the wrong era.
//
// So: when an unmatchable term appears in the FILENAME of a file the staleness
// check just reported as added or changed, say that outright. It converts a
// generic "index is stale" warning into a diagnosis of the specific query.
function staleTermCollision(unmatchable, stamp) {
  const files = [...(stamp.staleFilesAdded || []), ...(stamp.staleFilesChanged || [])];
  if (!files.length || !unmatchable || !unmatchable.length) return null;
  const hits = [];
  for (const term of unmatchable) {
    const t = String(term).toLowerCase();
    if (t.length < 3) continue;
    const named = files.filter((f) => String(f).toLowerCase().includes(t));
    if (named.length) hits.push({ term, files: named.slice(0, 4) });
  }
  if (!hits.length) return null;
  return 'YOUR INDEX PREDATES THE ANSWER — ' + hits.map((h) =>
    `${JSON.stringify(h.term)} matches no INDEXED document, but it appears in the name of ` +
    `${h.files.map((f) => JSON.stringify(f)).join(', ')}, which the staleness check just reported as ` +
    'added/changed since this index was built').join('; ') +
    '. This is not an absence, it is a stale index. Rebuild before trusting the ordering: ' +
    'memory({action:"index"}) (async) or `npm run index`.';
}

// ── The same principle, one scope wider: scan the CONTENT ──────────────────
//
// staleTermCollision above matches an unmatchable term against stale FILENAMES.
// On 2026-08-29 that was not enough. A query for the ship SHA `31cab63` returned
// totalMentions 0 / unmatchableTerms ["31cab63"], and I reported that a session had
// never been captured. It had — 149 exchanges — and the SHA sat in the CONTENT of
// three unindexed store files whose names contain no SHA at all. The response
// carried `indexStale: true` and a 163-file warning in the same breath as the zero.
//
// So when a term matches nothing INDEXED and the index is known stale, read the
// stale files before saying the word "absent". Bounded by construction: it runs
// only when an absence would otherwise be reported, and only over files already
// known to be stale.
const STALE_SCAN_MAX_FILES = 500;
const STALE_SCAN_MAX_BYTES = 32 * 1024 * 1024;

function staleContentScan(unmatchable, stamp) {
  const files = stamp && stamp._staleScan;
  if (!files || !files.length || !unmatchable || !unmatchable.length) return null;
  const terms = unmatchable.map((t) => String(t).toLowerCase()).filter((t) => t.length >= 3);
  if (!terms.length) return null;

  const hits = new Map();
  let bytes = 0;
  // 🟥 F2 (2026-08-30). Both caps below TRUNCATE, and until now they did so silently:
  // when the scan found nothing it returned null and the caller reported a clean absence,
  // with no hint that most of the stale files were never opened. Measured: the same file
  // and token found at 1 stale file, missed at 601. A bounded scan is correct; a bounded
  // scan that presents itself as exhaustive is the thing this whole guard exists against.
  let scanned = 0;
  const total = files.length;
  for (const f of files.slice(0, STALE_SCAN_MAX_FILES)) {
    if (bytes > STALE_SCAN_MAX_BYTES) break;
    scanned++;
    let text;
    try { text = readFileSync(f.path, 'utf8'); } catch { continue; }
    bytes += text.length;
    const hay = text.toLowerCase();
    for (let i = 0; i < terms.length; i++) {
      if (!hay.includes(terms[i])) continue;
      const key = unmatchable[i];
      if (!hits.has(key)) hits.set(key, []);
      const list = hits.get(key);
      if (list.length < 6) list.push(f.fileId);
    }
  }
  const truncated = scanned < total;
  const truncNote = truncated
    ? ` ⚠️ ONLY ${scanned} OF ${total} STALE FILES WERE READ (cap: ${STALE_SCAN_MAX_FILES} files / ` +
      `${Math.round(STALE_SCAN_MAX_BYTES / 1048576)} MB), so this scan is NOT exhaustive — ` +
      'a term absent from BOTH the index and this partial scan may still exist in a file ' +
      'nobody opened. Rebuild before treating it as missing.'
    : '';

  // Nothing found, but the scan was cut short: that is NOT the same as "nothing there",
  // and it is the caller who has to be told, because the absence verdict is theirs to make.
  if (!hits.size) {
    return truncated
      ? { foundInUnindexed: {}, scanTruncated: { filesScanned: scanned, filesTotal: total },
          note: 'INCONCLUSIVE, NOT ABSENT.' + truncNote }
      : null;
  }

  const parts = [...hits.entries()].map(([term, fs]) =>
    `${JSON.stringify(term)} appears in ${fs.map((f) => JSON.stringify(f)).join(', ')}`);
  return {
    foundInUnindexed: Object.fromEntries(hits),
    ...(truncated ? { scanTruncated: { filesScanned: scanned, filesTotal: total } } : {}),
    note: 'NOT ABSENT — UNINDEXED. ' + parts.join('; ') + truncNote +
      ', which the staleness check reports as added/changed since this index was built. ' +
      'The zero above counts INDEXED documents only. Do not report this as missing: ' +
      'rebuild first with memory({action:"index"}) (async) or `npm run index`.'
  };
}

function corpusClock(idx) {
  const docs = idx.docs || [];
  if (!docs.length) return 'mtime';
  const withTs = docs.reduce((n, d) => n + (d.ts ? 1 : 0), 0);
  return withTs > docs.length / 2 ? 'ts' : 'mtime';
}

// ---- SCOPE GRAMMAR ---------------------------------------------------------
// A scope is a string or an array, freely mixing corpus names, category names,
// 'all' and 'everything'. Expansion is a union, deduped; the RESULT ORDER puts
// the work corpora first (in CORPORA order) because scope:'everything' exists
// for someone who does not know where a thing lives, and the work corpora are
// where it usually does.
//
// 'all' expands to CORPORA and NOTHING ELSE — that is Daniel's rule, and it is
// what makes the library's reach isolation real: a category is searched only
// when a caller names it, or names 'everything'.
export function expandScope(scope) {
  const parts = Array.isArray(scope) ? scope : [scope];
  const names = [];
  for (const s of parts) {
    if (s === 'all') names.push(...CORPORA);
    else if (s === 'everything') names.push(...CORPORA, ...libraryCorpora());
    else names.push(s);
  }
  const dedup = [...new Set(names)];
  return [...CORPORA.filter((c) => dedup.includes(c)), ...dedup.filter((c) => !CORPORA.includes(c))];
}

function isMultiScope(scope) {
  return Array.isArray(scope) || scope === 'all' || scope === 'everything';
}

// ---- THE EVERYTHING VIEW IS COMPACT, AND SAYS SO ---------------------------
// scope:'everything' is the read-across-eight-corpora scope, and at named-scope
// defaults it answered a broad query with ~54 KB of response — the blind reader
// drowned. PRESENTATION ONLY: every group is ranked exactly as its named scope
// would rank it, then the VIEW trims — fewer rows per section, shorter
// snippets, null fields dropped, per-group boilerplate said once at the top.
//
// DEFAULTS, NOT CEILINGS (Daniel's ruling): an explicit `limit` or `maxChars`
// on the call overrides them fully. And nothing trims silently — every trimmed
// section carries a line saying how many rows exist and what gets the rest,
// because a slice that looks like a whole document is how a caller concludes
// something is absent (the documented get() trap, same failure shape).
const EVERYTHING_VIEW = { rowsPerSection: 2, snippetChars: 160, descriptionChars: 140 };

// What a compact ROW keeps: identity, the fused score, provenance, the snippet,
// and the fields that prevent known misreadings (thread position, verified
// commits, modified). Diagnostics (per-leg scores, file ids, paths, tiers,
// links) live one named-scope call away, and the compactNote says so.
const EV_ROW_KEEP = ['name', 'corpus', 'type', 'description', 'score', 'provenance', 'snippet', 'modified',
  'threadPosition', 'laterInThread', 'threadLast', 'sessionTitle', 'verifiedCommits'];
// What a compact GROUP keeps: the verdict, the honesty fields, and the rows.
// absenceNote is deliberately NOT here — it is the same sentence in every
// noStrongMatch group, so the compact view says it ONCE at the top level;
// the per-group noStrongMatch/confidence flags stay.
const EV_GROUP_KEEP = ['results', 'bestWeak', 'noStrongMatch', 'confidence', 'totalCandidates',
  'indexStale', 'staleFiles', 'staleWarning', 'mode', 'premiseSupported'];
// Group-guidance lines that are generic advice restated identically on every
// response of that scope — pure repetition in the everything view. Anything
// carrying SPECIFIC names (orphan alarms, mid-thread pointers, collisions)
// survives.
const EV_GROUP_GUIDANCE_DROP = [
  /^scope defaulted to CURATED/, /library categor/,
  /conversation EXCHANGES — a moment in a chat/,
  /^Some of these ARE the last exchange of their thread/
];

function compactRow(r, snipCap, descCap) {
  const out = {};
  for (const k of EV_ROW_KEEP) {
    if (r[k] === null || r[k] === undefined) continue;
    out[k] = r[k];
  }
  // A read-only row must SAY so in every view — the caller who tries to demote
  // it deserves the warning before the refusal. Absence of the field means
  // writable, so only `true` is worth the bytes.
  if (r.readOnly === true) out.readOnly = true;
  if (typeof out.snippet === 'string' && out.snippet.length > snipCap) out.snippet = out.snippet.slice(0, snipCap) + '…';
  if (typeof out.description === 'string' && out.description.length > descCap) out.description = out.description.slice(0, descCap) + '…';
  return out;
}

function compactEverythingGroups(groups, names, { rowCap, snipCap }) {
  const descCap = EVERYTHING_VIEW.descriptionChars;
  const out = {};
  for (const s of names) {
    const g = groups[s];
    const ranked = (g.results?.length || 0) + (g.bestWeak?.length || 0);
    // An empty corpus is one honest line, not nineteen stamped fields.
    if (!ranked) {
      out[s] = { noStrongMatch: true,
        compactNote: `nothing ranked in '${s}'` + (g.indexStale ? ' (its index is STALE — see staleWarning at the top level)' : '') +
          `; scope:'${s}' gives the full empty-section detail.` };
      continue;
    }
    const g2 = {};
    for (const k of EV_GROUP_KEEP) if (g[k] !== undefined) g2[k] = g[k];
    const gGuide = (g.guidance || []).filter((l) => !EV_GROUP_GUIDANCE_DROP.some((re) => re.test(l)));
    if (gGuide.length) g2.guidance = gGuide;
    for (const field of ['results', 'bestWeak']) {
      if (!Array.isArray(g[field])) continue;
      g2[field] = g[field].slice(0, rowCap).map((r) => compactRow({ ...r, corpus: s }, snipCap, descCap));
    }
    const shown = (g2.results?.length || 0) + (g2.bestWeak?.length || 0);
    g2.compactNote = `COMPACT everything view: ${shown} of ${ranked} ranked row(s)` +
      (typeof g.totalCandidates === 'number' ? ` (${g.totalCandidates} candidates in '${s}')` : '') +
      `, ${snipCap}-char snippets, diagnostic fields dropped. limit:/maxChars: raise this; ` +
      `scope:'${s}' returns the full section.`;
    out[s] = g2;
  }
  return out;
}

// ---- TASK-SHAPE ROUTING: A READ TASK IS NOT A SEARCH -----------------------
// The blind reader asked scope:'everything' to "summarize the <manual>" and got
// ranked fragments — correct retrieval, wrong tool. Two conservative triggers,
// per the query-log audit (689 distinct real queries):
//   * TITLE — the query, minus a leading summarize/overview verb and article,
//     slug-matches an indexed PARENT document name exactly. The strong signal.
//   * VERB — the query STARTS with a summarize/overview phrase. Start-anchored
//     because the audit found the one live 'summarize' besides the blind
//     reader's sat mid-way through a pasted mega-prompt (0/689 false fires
//     with the anchor). 'read the whole' was audited and DROPPED — it fired
//     mid-prose on an unrelated pasted analysis (1/689).
const READ_VERB_RE = /^\s*(?:summari[sz]e|(?:give\s+me\s+)?(?:an?\s+)?(?:summary|overview)\s+of)\b[:,]?\s*/i;
// D5 second half — ranking-adjacent, so it was flagged and barred before it
// was written. ON by default since 2026-08-28: the manuals read-task case
// stopped refusing (orphanShare 0.4908 -> 0, three page sections returned) and
// every protected number came back identical arm-to-arm — curated gold 10/10 /
// MRR 0.8833, absence 4/4, verbatim 6/6, library absence 10/10, library gold
// 12/12 · 11/12 · 8/12, currency r_cur / r_stale / FDR / abstention all equal.
// `0` disables. Numbers: test/read-verb-weight-preregistration.md.
const readVerbWeightEnabled = () =>
  !['0', 'false', 'off'].includes(String(process.env.MEMORY_READ_VERB_WEIGHT || '').toLowerCase());
const slugOfQuery = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function readTaskHint(query, names) {
  const verb = READ_VERB_RE.exec(String(query || ''));
  const remainder = verb ? String(query).slice(verb[0].length) : String(query);
  const slug = slugOfQuery(remainder.replace(/^\s*(the|a|an)\s+/i, ''));
  let titleDoc = null;
  if (slug.length >= 8) {                     // a shorter slug matches by accident
    for (const s of names) {
      let idx; try { idx = getIndex({ scope: s }); } catch { continue; }
      for (const d of idx.docs || []) {
        if (d.parentName) continue;           // parents only — a title names a document
        if (d.name === slug || slugOfQuery(d.name) === slug) { titleDoc = { name: d.name, scope: s }; break; }
      }
      if (titleDoc) break;
    }
  }
  if (!titleDoc && !verb) return null;
  const target = titleDoc
    ? `memory({action:"get", name:"${titleDoc.name}", outline:true})`
    : 'memory({action:"get", name:"<the document>", outline:true})';
  return 'READ TASK, NOT A SEARCH — ' +
    (titleDoc ? `this query is the title of the indexed document '${titleDoc.name}'` : 'this query asks for a summary/overview') +
    `. Search returns FRAGMENTS ranked by similarity, never the document. Read it instead: ${target}, ` +
    'then read sections with section:"<heading>". The fragments below are NOT the document.';
}

// `scope:'all'` used to fall through to loadScope's default and answer silently
// from CURATED ALONE while labelling itself 'all' — a confident answer that had
// never looked at 2,312 staged exchanges, including the conversation that settled
// the question. Merging the corpora is not the fix either (see corpusClock).
//
// So: one call, one section per corpus, each ordered by ITS OWN clock and saying
// so. Nothing is ranked against a clock it does not have, and the caller gets the
// comparison that is usually the real answer -- the standing rule says X, the last
// conversation says Y -- without having to know to ask twice.
async function latestAll(query, opts) {
  // Generalised the same way search()'s grouped branch is: 'all' stays the work
  // set, 'everything' and arrays expand through the one scope grammar.
  const requested = opts.scope ?? 'all';
  const names = expandScope(requested);
  const sections = [];
  let total = 0;
  for (const corpus of names) {
    const r = await latest(query, { ...opts, scope: corpus });
    if (!r.results || !r.results.length) continue;
    const clock = corpusClock(getIndex({ scope: corpus }));
    sections.push({
      corpus,
      orderedBy: clock,
      totalMentions: r.totalMentions || 0,
      results: r.results,
      note: clock === 'ts' ? 'Ordered NEWEST FIRST by when it was said.'
        : 'NOT TIME-ORDERED. This corpus carries no timestamps, so this is FILE MTIME only — ' +
          'the 2026-08-19 account backfill rewrote every curated file at once, so mtime order ' +
          'here is bookkeeping, not chronology. Do not read section order as "what happened last".'
    });
    total += r.totalMentions || 0;
  }
  return guardValue({
    query, mode: 'latest', scope: requested,
    merged: false,
    totalMentions: total,
    note: sections.length
      ? 'NOT MERGED, BY DESIGN — THE CORPORA DO NOT SHARE A CLOCK. Each section is ordered by ' +
        'its own, and says which. Blending them is measured harm here: mixing staging into ' +
        'curated cost 3 memories their answer and dropped MRR 0.826 -> 0.681. Compare the ' +
        'sections instead — the standing rule vs. the last conversation — that difference is ' +
        'usually the answer.'
      : 'No document in any corpus mentions every term. Drop a term and retry; latest() is a ' +
        'FILTER, not a ranker.',
    sections,
    // Back-compat: a caller reading only .results still gets the time-ordered corpora
    // first, and every row says which corpus it came from.
    results: sections.filter((x) => x.orderedBy === 'ts')
      .concat(sections.filter((x) => x.orderedBy !== 'ts'))
      .flatMap((sec) => sec.results.map((r) => ({ ...r, corpus: sec.corpus, orderedBy: sec.orderedBy })))
  }, 'latest-all-output');
}

export async function latest(query, opts = {}) {
  const { limit = 5, scope = 'staging', sessionId = null, account = null, project = null,
          includeSummaries = true } = opts;
  const queryId = opts._queryId || newQueryId();
  if (isMultiScope(scope)) return latestAll(query, { ...opts, scope, _queryId: queryId });

  const terms = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
  if (!terms.length) return { query, mode: 'latest', scope, results: [], note: 'no usable terms' };

  // CHECK THE INDEX AGAINST THE CORPUS BEFORE ANSWERING FROM IT -- the same guard
  // search() has had, which latest() shipped without.
  //
  // The irony was exact: latest() is the action MOST damaged by staleness, because
  // new material is precisely what a stale index lacks. Ask "what is the latest on
  // X" right after a conversation about X and the answer could omit that whole
  // conversation while looking authoritative. Observed live: the staging index was
  // built at 01:30, the Stop hook ingested at 15:57, 59 files changed in between --
  // search() named eight of them and gave the fix command, latest() said nothing.
  //
  // ensureFresh may rebuild inline, but only where that is cheap: reindexInline's
  // file-count bound refuses a 2,317-document staging rebuild (~14 s / ~140 MB), so
  // this reports the staleness rather than making a query wait for it.
  const { idx, stamp } = await ensureFresh(scope);
  if (!idx.present) return { query, mode: 'latest', scope, results: [], ...stamp, note: 'no index for this scope' };

  // ONE copy of the alias/array rule, shared with search(). latest() used to
  // re-implement it with `doc.account !== account`, which matched nothing when the
  // caller passed an array and never resolved 'mine'/'this' at all.
  const { wantAccounts, wantProjects } = resolveFilters({ account, project });

  const when = (d) => Date.parse(d.ts || d.modified || 0) || 0;
  const hits = [];
  // Document frequency PER TERM, counted in the same pass. latest() is an AND
  // filter, so one term nobody uses takes the whole query to zero -- and the bare
  // zero looks exactly like "this never happened". Naming the term turns a dead
  // end into the next query. (Reported only, never dropped automatically: the term
  // that matches nothing is often the one that mattered, and silently relaxing the
  // filter would answer a question the caller did not ask.)
  const df = new Map(terms.map((t) => [t, 0]));
  // 🟥 SUBSTRING MATCHING IS DELIBERATE — it is what makes `v111` find `zip-v111-shipped` and a
  // SHA find the exchange that cites it. What was NOT deliberate is REPORTING it as a term
  // count. Measured 2026-09-02: latest("Rust") returned totalMentions 509 with three results
  // dated today, one carrying a git-VERIFIED commit, under "results[0] is the last thing said
  // about this" — and every single match was the word `trust`. latest("Redis") returned 12,
  // all `rediscovers`. Asked about work that never happened, it manufactured recent,
  // specific, commit-corroborated evidence for it.
  //
  // So: count whole-word matches too, and when a term matches ONLY inside other words, say so.
  // This is an observation, not a judgement — it changes no filtering and no ordering.
  const dfWord = new Map(terms.map((t) => [t, 0]));
  const wordRe = new Map(terms.map((t) => [t, new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')]));
  const partial = [];   // every doc matching at least one term, for the relaxed fallback
  let summariesDemoted = 0;
  for (const doc of idx.docs) {
    if (sessionId && doc.sessionId !== sessionId) continue;
    if (wantAccounts && doc.account && !wantAccounts.has(doc.account)) continue;
    if (wantProjects && doc.project && !wantProjects.has(doc.project)) continue;
    const summary = isCompactionSummary(doc);
    if (summary && includeSummaries === false) continue;
    const hay = (doc.name + ' ' + (doc.description || '') + ' ' + bodyOf(doc)).toLowerCase();
    const matched = terms.filter((t) => hay.includes(t));
    for (const t of matched) {
      df.set(t, df.get(t) + 1);
      if (wordRe.get(t).test(hay)) dfWord.set(t, dfWord.get(t) + 1);
    }
    if (matched.length) partial.push({ doc, when: when(doc), matched, n: matched.length, summary });
    // every term, so this stays a FILTER and does not drift into fuzzy ranking
    if (matched.length !== terms.length) continue;
    if (summary) summariesDemoted++;
    hits.push({ doc, when: when(doc), summary });
  }
  // Primary sources first, THEN summaries -- each half still strictly newest-first.
  hits.sort((a, b) => (a.summary === b.summary ? b.when - a.when : (a.summary ? 1 : -1)));

  // RELAXED FALLBACK -- only when the strict AND found NOTHING.
  //
  // The plan called this "optional and riskier" and shipped only the naming half.
  // Then the test that was supposed to validate the naming half sent 2 of 6 real
  // questions to zero, and the top hit for a third turned out to be an EARLIER
  // session writing down this exact fix: "Every-term AND is brittle. Fix: fall
  // back to most-terms-matched when the strict AND returns nothing, and say which
  // term was dropped." Taking the corpus's own advice.
  //
  // The risk is real and it is why this NEVER runs when the strict filter found
  // something: a dropped term is often the term that mattered. So it fires only
  // where the alternative is an empty answer, keeps the documents matching the
  // MOST terms (not an arbitrary count), and names every term it gave up on.
  let relaxed = false;
  let droppedTerms = [];
  if (!hits.length && partial.length && terms.length > 1) {
    const best = Math.max(...partial.map((x) => x.n));
    const kept = partial.filter((x) => x.n === best)
      .sort((a, b) => (a.summary === b.summary ? b.when - a.when : (a.summary ? 1 : -1)));
    // INTERSECTION, not union. The union let `relaxed: true` ship with
    // `droppedTerms: []` -- incoherent, and observed in the six-question test:
    // the kept documents collectively covered every term while no single one did.
    droppedTerms = terms.filter((t) => !kept.every((x) => x.matched.includes(t)));
    hits.push(...kept);
    relaxed = true;
  }

  const unmatchableTerms = terms.filter((t) => df.get(t) === 0);
  const rarest = terms.filter((t) => df.get(t) > 0).sort((a, b) => df.get(a) - df.get(b))[0];
  const termNote = !hits.length && !relaxed && terms.length > 1
    ? (unmatchableTerms.length
        ? `NO DOCUMENT CONTAINS ${unmatchableTerms.map((t) => JSON.stringify(t)).join(' or ')} — ` +
          `that term alone took this AND-filter to zero. Retry without it: ` +
          `memory({action:"latest", query:"${terms.filter((t) => !unmatchableTerms.includes(t)).join(' ')}"}).`
        : `Every term appears somewhere, but never all together. The rarest is ${JSON.stringify(rarest)} ` +
          `(${df.get(rarest)} documents) — drop that one first, or use action:"search", which ranks ` +
          'rather than filtering.')
    : null;

  // A filter that eliminates EVERYTHING because the corpus does not carry that
  // label at all is indistinguishable, from the outside, from "nothing happened".
  // Measured: `project:'this'` resolves to the Claude-projects slug, which is
  // exactly how the 123 CURATED docs are labelled -- but latest() defaults to
  // STAGING, where all 2,317 docs are labelled 'store'. The filter is right and
  // the zero is honest; it was just SILENT, which is the failure this whole file
  // is being changed to stop. So name it, and name what the corpus does carry.
  const filterNotes = [];
  const noneCarry = (key, want) => want && !idx.docs.some((d) => d[key] && want.has(d[key]));
  for (const [key, want, arg] of [['project', wantProjects, 'project'], ['account', wantAccounts, 'account']]) {
    if (!noneCarry(key, want)) continue;
    const seen = [...new Set(idx.docs.map((d) => d[key]).filter(Boolean))].slice(0, 6);
    filterNotes.push(
      `FILTER MATCHED NOTHING — NOT AN EMPTY CORPUS. No document in scope '${scope}' carries ` +
      `${key} ${[...want].map((v) => JSON.stringify(v)).join(', ')}. This corpus labels its ` +
      `documents ${seen.length ? seen.map((v) => JSON.stringify(v)).join(', ') : '(nothing)'}. ` +
      `Retry without \`${arg}\`, or with one of those values.`);
  }

  const results = hits.slice(0, limit).map(({ doc, when: w }) => withThreadPosition({
    name: doc.name, file: doc.file, account: doc.account || null, project: doc.project || null,
    sessionId: doc.sessionId || null, sessionTitle: doc.sessionTitle || null,
    ts: doc.ts || doc.modified || null,
    // AROUND THE MATCH, not the tail of the document. The tail was actively
    // misleading: a 17,608-char exchange that mentions a term once, in passing,
    // showed a snippet from a completely different subject -- and because it was
    // also the NEWEST document containing every term, it took first place on three
    // unrelated test questions. Same ordering, but now the row shows why it matched.
    snippet: guardValue(trimSnippet(matchSnippet(bodyOf(doc), terms, df)), 'latest-snippet'),
    termHits: countHits(bodyOf(doc), terms),
    ...(isCompactionSummary(doc) ? { isCompactionSummary: true } : {}),
    links: doc.links
  }, idx));

  // VERIFICATION, NOT INFERENCE. "Did this finish?" is a question about the world,
  // and for engineering claims the world keeps a record: the commit. Where a row
  // cites a SHA that really exists, the row now carries the date, the subject and
  // whether it landed on the mainline -- so a claim can be CHECKED rather than
  // read. Silent no-op unless MEMORY_GIT_REPOS is configured.
  await attachCommits(results, hits.slice(0, limit).map(({ doc }) => bodyOf(doc)));
  const verifiedRows = results.filter((r) => r.verifiedCommits).length;

  // ONE field name for advice, the same one search() uses, instead of a single
  // `note` string that a caller has to parse prose out of. `note` is kept because
  // the query log captures payloads and old rows are still read.
  // ABSENCE VERDICT — the half latest() shipped without.
  //
  // search() has had one since v1.1; latest() returned whatever the filter matched
  // and let the caller infer the rest. Measured with five pre-registered FALSE
  // premises ("the Tier 3 dream resolution arm shipped", "MEMORY_CURRENCY_REPOS
  // implemented" — none of which happened): all five returned rows, none said so,
  // and one returned 75 relaxed matches whose top snippet read like confirmation.
  //
  // For a memory system that is the worst possible failure: not missing an answer,
  // but manufacturing one. So say plainly whether the query AS PHRASED appears
  // anywhere, and never let a relaxed match stand in as evidence that it does.
  const premiseSupported = hits.length > 0 && !relaxed;
  const guidance = [];
  const collision = staleTermCollision(unmatchableTerms, stamp);
  if (collision) guidance.push(collision);
  // Filename first (cheap, exact), then content. The content scan only reads
  // anything when the filename pass found nothing and a term is still unmatchable.
  const unindexed = collision ? null : staleContentScan(unmatchableTerms, stamp);
  if (unindexed) guidance.unshift(unindexed.note);
  // C2 -- the query named an identifier that exists in no configured repo.
  // Runs here rather than waiting to be asked, because the caller who most
  // needs this is the one who does not suspect anything is wrong.
  const autoIdent = await autoVerifyQuery(query);
  if (autoIdent) guidance.push('NOT IN THE CODE — ' + autoIdent.note);
  if (!premiseSupported && terms.length > 1) {
    guidance.push('PREMISE NOT SUPPORTED — no single document contains all of ' +
      terms.map((t) => JSON.stringify(t)).join(', ') + '. ' +
      (relaxed
        ? 'What follows matched only SOME of those terms, so it is NOT evidence that the thing ' +
          'you asked about happened. Treat it as related reading, not as confirmation.'
        : 'Nothing matched at all.') +
      ' If you are checking whether something is true, this is the answer: the corpus does not ' +
      'say so. Absence here is weak evidence — it may have happened without being written down ' +
      '(measured: only 2 of 12 commits made in one session were named in that session\'s text) — ' +
      'but it is NEVER support for the claim.');
  }
  if (summariesDemoted) {
    guidance.push(`${summariesDemoted} MATCHING exchange(s) are CONTEXT-COMPACTION SUMMARIES ` +
      '(isCompactionSummary) and were sorted BELOW every first-hand exchange, so they may fall ' +
      'outside this limit entirely. A summary restates a whole conversation, so it matches ' +
      'nearly any query while carrying a recent timestamp for old content — it can still answer, ' +
      'but it is a restatement, not the last word. Pass includeSummaries:false to drop them.');
  }
  if (relaxed) {
    guidance.push(`RELAXED FILTER — no document contained all ${terms.length} terms, so these ` +
      `matched the most that any document did. DROPPED: ${droppedTerms.map((t) => JSON.stringify(t)).join(', ')}. ` +
      'A dropped term is often the term that mattered, so check these are about what you asked ' +
      'before trusting the ordering.');
    // The measured cause of nearly every relaxed query in the six-question test:
    // the query was PROSE and the corpus is written in IDENTIFIERS. "did the
    // reparse finish" and "pushed commit with failing test semicolon" both failed;
    // "pushed c509e0f" and "max-old-space-size heap 20000 rows" returned the exact
    // answer from the same corpus. A term filter matches strings, so the words that
    // work are the ones the work itself was written in.
    // DOMAIN-AWARE. This used to say "RETRY WITH IDENTIFIERS, NOT PROSE" to every
    // caller, which is measured advice — on a CODE corpus. Told to someone whose
    // memories are notes for a novel it inverts: they have no SHAs, no flags and no
    // paths, and prose is the only thing they CAN search with. Stating a
    // corpus-specific finding as a universal rule misleads a new user on their
    // first query, so the advice now follows the corpus, the query shape, or an
    // explicit domain the caller names.
    const adv = adviceFor({ query, corpusDomain: (idx.profile || {}).domain, hint: opts.domain });
    guidance.push('RETRY DIFFERENTLY — ' + adv.advice + ` (advice basis: ${adv.basis})`);
  }
  if (verifiedRows) {
    const landed = results.flatMap((r) => r.verifiedCommits || []).filter((c) => c.onMainline).length;
    guidance.push(`${verifiedRows} of these rows cite commits that were VERIFIED IN GIT ` +
      `(${landed} on the mainline) — see verifiedCommits. That is the record, not the wording: ` +
      'a row saying work was committed is confirmed by the commit existing, and a row with no ' +
      'verifiedCommits cited no SHA (which proves nothing either way).');
  }
  // ---- THE RECENCY PROMISE, CHECKED AGAINST THE CLOCK ----------------------
  //
  // `latest` exists to answer "what is the last word on X". It ranks what the INDEX holds. When
  // the index is stale, it used to rank anyway and still say "results[0] is the last thing said
  // about this" — with the count of unread files sitting in the same response.
  //
  // The observed failure: the answer lived in a store file written at 17:02, the index had been
  // built at 00:24, the response reported indexStale with 25 stale files, and then returned a
  // drafting session from the PREVIOUS DAY as results[0] under that sentence. The five files
  // holding the real answer were named in its own warning and absent from its results.
  //
  // 🟥 WHY THIS IS NOT staleTermCollision OR staleContentScan. Both of those fire only when a
  // term is UNMATCHABLE. Here nothing was unmatchable — the query matched plenty of documents,
  // just older ones — so neither could fire. Those guards check TERMS; this one checks TIME, and
  // that is the whole difference.
  //
  // 🟥 AND WHY IT IS ADDITIVE. It runs after autoVerifyQuery, corpusCurrency and the guidance
  // array are assembled, and removes none of them. An early return here would silently disable
  // the git "is this still true?" layer — trading one wrong-answer bug for another.
  let recencyVoid = null;
  try {
    const newestUnread = stamp._staleNewestMs;
    const topTs = results[0]?.ts ? Date.parse(results[0].ts) : NaN;
    if (stamp.indexStale && Number.isFinite(newestUnread) && Number.isFinite(topTs) && newestUnread > topTs) {
      const files = [...(stamp.staleFilesAdded || []), ...(stamp.staleFilesChanged || [])];
      recencyVoid = {
        newestUnindexedModified: stamp.staleNewestModified,
        newestRankedAt: results[0].ts,
        unreadFiles: files.slice(0, 15),
        unreadFileCount: stamp.staleFiles ?? files.length
      };
      guidance.unshift(
        `NEWEST-FIRST CANNOT BE HONOURED — ${recencyVoid.unreadFileCount} file(s) this index has not ` +
        `read were modified as recently as ${recencyVoid.newestUnindexedModified}, which is NEWER than ` +
        `the newest row it can rank (${recencyVoid.newestRankedAt}). results[0] is therefore NOT ` +
        'the last word. READ THESE FIRST: ' + recencyVoid.unreadFiles.join(', ') +
        (files.length > 15 ? `, …and ${files.length - 15} more` : '') + '.');
    }
  } catch { recencyVoid = null; }

  if (hits.length) {
    // 🟥 THE CLAIM APPEARS TWICE — here and in `note`. A first version of this guard fixed only
    // `note`, and the response then CONTRADICTED ITSELF: guidance[0] said newest-first could not
    // be honoured while a later guidance line still said results[0] was the last word. Found by
    // reading a real response, not by reasoning about the diff.
    guidance.push(recencyVoid
      ? 'Ordered NEWEST FIRST by ' + (corpusClock(idx) === 'ts' ? 'when it was said' : 'FILE MTIME (not chronology)') +
        ' — but ONLY over what is indexed, and unread files are newer. results[0] is NOT the last word here.'
      : 'Ordered NEWEST FIRST by ' + (corpusClock(idx) === 'ts' ? 'when it was said' : 'FILE MTIME (not chronology)') +
        '. results[0] is the last thing said about this.');
    const top = results[0];
    if (top && top.laterInThread > 0) {
      guidance.push(`But results[0] is ${top.threadPosition} of its thread — the newest exchange ` +
        `MENTIONING these terms is not the newest exchange in the conversation. ` +
        `memory({action:"get", name:"${top.threadLast}"}) is where that thread actually ends.`);
    }
    // THE LAST-WORD CAVEAT IS NOW CONDITIONAL. It used to fire on every call, and
    // measuring the result showed why that was wrong: guidance averaged 1,607 chars
    // over six real queries, so the lines that MATTER (premise unsupported, relaxed
    // filter) were buried among lines that are always there. The caveat is also in
    // the tool description, which is loaded once per session, so repeating it in
    // full on every response bought nothing.
    //
    // It now fires when there is an actual gap to warn about: the corpus is behind
    // the repos, or the newest matching exchange is over two days old. Same rule
    // applied to the cry-wolf warnings earlier today -- say it when it is true, not
    // as decoration.
    const newestHit = Date.parse(results[0]?.ts || 0) || 0;
    const staleHours = newestHit ? (Date.now() - newestHit) / 3600000 : 0;
    if (staleHours > 48) {
      guidance.push('THE LAST WORD IS NOT CURRENT TRUTH — and the newest match here is ' +
        Math.round(staleHours / 24) + ' days old. This is the last thing SAID about it, not the ' +
        'last thing that HAPPENED. Check the world (git log, the filesystem, the running process) ' +
        'before reporting it as current state.');
    }
  }

  // Logged like search is, so the mode split answers "is the guidance changing
  // behaviour?" -- previously `latest` was invisible to the log entirely, which
  // made that question unanswerable by the one instrument that could answer it.
  // CORPUS CURRENCY. The guidance already says the last word is not current truth;
  // a sentence is easy to skip and a COUNT is not. Emitted here rather than in a
  // report nobody reads, because `latest` is the action that claims to give the
  // last word, so this is exactly where over-trusting it does the damage.
  let currency = null;
  try {
    currency = idx.newestTs ? await cachedCorpusCurrency(new Date(idx.newestTs).toISOString()) : null;
  } catch { currency = null; }
  if (currency && currency.commitsSince.some((r) => r.commitsSince > 0)) guidance.push(currency.note);

  // Report the divergence BEFORE the newest-first framing, because that framing is what makes
  // a substring artefact read as a finding.
  const insideOnly = terms.filter((t) => df.get(t) > 0 && dfWord.get(t) === 0);
  const mostlyInside = terms.filter((t) => df.get(t) > 0 && dfWord.get(t) > 0 && dfWord.get(t) * 4 < df.get(t));
  if (insideOnly.length) {
    guidance.unshift(
      'MATCHED INSIDE OTHER WORDS, NOT AS A WORD — ' +
      insideOnly.map((t) => `"${t}" appears in ${df.get(t)} document(s) but in NONE of them as a ` +
        'separate word (it is inside a longer word)').join('; ') +
      '. Treat the count and these results as evidence of NOTHING about that term until you have ' +
      'read a snippet and seen the word itself.');
  } else if (mostlyInside.length) {
    guidance.push('MOSTLY INSIDE OTHER WORDS — ' + mostlyInside.map((t) =>
      `"${t}": ${dfWord.get(t)} of ${df.get(t)} matches are the whole word`).join('; ') + '.');
  }

  logQuery({ query, mode: 'latest', scope, totalCandidates: hits.length,
    noStrongMatch: !hits.length, results }, { queryId });

  return guardValue({
    query, mode: 'latest', scope,
    ...stamp,
    orderedBy: corpusClock(idx),
    totalMentions: hits.length,
    guidance: guidance.length ? guidance : undefined,
    note: hits.length
      // The claim is the defect, so the claim is what changes. Everything else in this response
      // is identical either way.
      ? (recencyVoid
        ? `Ordered NEWEST FIRST — but ${recencyVoid.unreadFileCount} unread file(s) are NEWER than ` +
          'results[0], so this is not the last word. Read the files in recencyVoid.unreadFiles ' +
          'before concluding anything about what happened most recently.'
        : 'Ordered NEWEST FIRST. results[0] is the last thing said about this. A thread that ' +
          'simply stops still reads as "in progress" — read the snippet before concluding it is done.')
      : 'No document mentions every term. Drop a term and retry; latest() is a FILTER, not a ranker.',
    ...(recencyVoid ? { recencyVoid } : {}),
    ...(filterNotes.length ? { filterWarning: filterNotes.join(' ') } : {}),
    ...(unmatchableTerms.length ? { unmatchableTerms } : {}),
    ...(unindexed ? { foundInUnindexed: unindexed.foundInUnindexed } : {}),
    premiseSupported,
    corpusProfile: idx.profile ? { domain: idx.profile.domain, confidence: idx.profile.confidence,
      basis: idx.profile.overridden ? 'override' : 'derived', note: idx.profile.note } : undefined,
    ...(currency ? { corpusCurrency: currency } : {}),
    ...(relaxed ? { relaxed: true, droppedTerms, matchedTermsPerDoc: `${terms.length - droppedTerms.length} of ${terms.length}` } : {}),
    ...(summariesDemoted ? { summariesDemoted } : {}),
    ...(termNote ? { termWarning: termNote } : {}),
    termFrequencies: Object.fromEntries(df),
    // The same counts restricted to whole-word matches. A big gap between these two is the
    // difference between a real mention and a stemming artefact.
    termFrequenciesWholeWord: Object.fromEntries(dfWord),
    results
  }, 'latest-output');
}

// READ FORWARD FROM A HIT, in the order the conversation actually happened.
//
// `threadLast` hands back the END of a thread, which is the right answer for a
// short one and the wrong end of a long one: the resolution to a claim made at
// exchange 200 of a 650-exchange thread is almost always at 201-210, not at 650.
// Relevance cannot find it either -- the exchange that RESOLVES something often
// shares almost no vocabulary with the exchange that raised it ("done", "shipped",
// "you were right"). Sequence can, and sequence is already in the corpus: the
// names are x-<session>-NNNN.
//
// So this is arithmetic, not retrieval. No ranking, no scoring, no judgment: given
// an anchor, return its neighbours in order. It is the half of "what happened
// after Y" that neither search nor latest can answer.
export async function thread(name, opts = {}) {
  // `forward`/`back`, NOT `after`/`before`. Those names were already taken by
  // search's DATE filters, and the collision produced a silent empty answer:
  // thread({after:'2026-08-01'}) ran Math.max(0,'2026-08-01') -> NaN, sliced to
  // nothing, and reported "this window covers 616-NaN" with results: []. Found by
  // calling the real MCP tool after a restart; every lib-level test had passed,
  // because they all passed numbers.
  const { scope = 'staging', snippetChars = RETRIEVAL.snippetChars } = opts;
  const count = (v, fallback) => {
    if (v === undefined || v === null || v === '') return { n: fallback };
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { bad: String(v) };
    return { n: Math.floor(n) };
  };
  const fwd = count(opts.forward !== undefined ? opts.forward : opts.after, 8);
  const bwd = count(opts.back !== undefined ? opts.back : opts.before, 0);
  if (fwd.bad || bwd.bad) {
    return guardValue({
      anchor: name, mode: 'thread', scope, results: [],
      error: `thread takes COUNTS, not dates: got ${JSON.stringify(fwd.bad || bwd.bad)}. Use ` +
        '`forward` and `back` (numbers of exchanges). `after`/`before` are search\'s DATE filters ' +
        'and mean something different there — that name collision used to return an empty result ' +
        'silently, so it is now refused loudly.'
    }, 'thread-output');
  }
  const after = fwd.n, before = bwd.n;
  const { idx, stamp } = await ensureFresh(scope);
  if (!idx.present) return { anchor: name, mode: 'thread', scope, results: [], note: 'no index for this scope' };

  const t = idx.threads && idx.threads.get(name);
  if (!t) {
    // A wrong scope is the likely cause and is invisible otherwise, so name it.
    const known = idx.docs.some((d) => d.name === name);
    return guardValue({
      anchor: name, mode: 'thread', scope, ...stamp, results: [],
      note: known
        ? `'${name}' is in scope '${scope}' but is not a threaded exchange — only ingested ` +
          'exchanges (x-<session>-NNNN) have a sequence. Curated memories are standalone files.'
        : `'${name}' is not in scope '${scope}'. Ingested exchanges live in scope:'staging'; ` +
          'check the name came from a staging result.'
    }, 'thread-output');
  }

  const byName = new Map(idx.docs.map((d) => [d.name, d]));
  const i = t.position - 1;
  const from = Math.max(0, i - Math.max(0, before));
  const to = Math.min(t.names.length, i + Math.max(0, after) + 1);
  const window = t.names.slice(from, to);

  const results = window.map((n, k) => {
    const doc = byName.get(n);
    const pos = from + k + 1;
    return {
      name: n,
      isAnchor: n === name,
      threadPosition: `${pos} of ${t.total}`,
      offset: pos - t.position,        // -2 = two BEFORE the anchor, +3 = three after
      ts: doc?.ts || doc?.modified || null,
      sessionTitle: doc?.sessionTitle || null,
      ...(doc && isCompactionSummary(doc) ? { isCompactionSummary: true } : {}),
      snippet: guardValue(trimSnippet(String(bodyOf(doc) || '').slice(0, snippetChars * 2), snippetChars * 2), 'thread-snippet')
    };
  });

  await attachCommits(results, window.map((n) => bodyOf(byName.get(n))));

  // WHAT LANDED WHILE THIS WAS BEING SAID. The corpus records promises ("I'll
  // commit the fix") far more reliably than outcomes -- measured, a session that
  // produced 12 commits named 2 of them in its text, because the work happened in
  // tool calls and ingest captures prose. Reading the corpus harder cannot recover
  // what was never written; joining on TIME can, and needs no SHA and no wording.
  const spanFrom = results[0]?.ts || null;
  const spanTo = results[results.length - 1]?.ts || null;
  let landed = [];
  try {
    landed = await commitsInRange(spanFrom, spanTo);
  } catch { landed = []; }

  const guidance = [
    'THIS IS A SEQUENCE, NOT A RANKING — read it in order. `offset` is relative to the anchor: ' +
    'negative is before it, positive is after.',
    `Anchor ${name} is ${t.position} of ${t.total}; this window covers ${from + 1}-${to} and ` +
    `${t.total - to} exchange(s) after it are not shown` + (to < t.total ? ` (raise \`forward\`, or jump to ${t.last}).` : '.'),
    'THE LAST WORD IS NOT CURRENT TRUTH: this is what was SAID next, not what happened next. ' +
    'A claim that something was committed is confirmed by git, not by the sentence after it.'
  ];
  if (landed.length) {
    guidance.push(`${landed.length} commit(s) landed in the configured repos DURING this stretch ` +
      `of conversation (${String(spanFrom).slice(0, 16)} to ${String(spanTo).slice(0, 16)}) — see ` +
      'commitsDuringWindow. EVIDENCE, NOT PROOF: a commit inside the window may be unrelated work, ' +
      'and related work can land days later. But it answers "was anything actually done here?" ' +
      'without depending on whether the conversation wrote the SHA down — measured, one session ' +
      'produced 12 commits and named 2.');
  }

  logQuery({ query: name, mode: 'thread', scope, totalCandidates: results.length,
    noStrongMatch: !results.length, results });

  return guardValue({
    anchor: name, mode: 'thread', scope, ...stamp,
    ...(landed.length ? { commitsDuringWindow: landed, windowSpan: { from: spanFrom, to: spanTo } } : {}),
    threadTotal: t.total, anchorPosition: t.position, threadLast: t.last,
    windowFrom: from + 1, windowTo: to, remainingAfter: t.total - to,
    guidance, results
  }, 'thread-output');
}

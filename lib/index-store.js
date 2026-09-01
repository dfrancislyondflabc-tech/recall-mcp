// lib/index-store.js — build / load / persist .memory-index.json
//
// THE HEADER IS THE POINT. Vectors are meaningless without the exact recipe
// that produced them. The header records that recipe, and the loader REFUSES
// the dense half of any index whose header does not match the running
// contract, field for field — logging which field disagreed. A refused index
// degrades to BM25-only; it never silently returns wrong neighbours.
//
// Incremental: per-file mtime+hash. Unchanged files keep their vectors, so a
// rebuild after editing one memory re-embeds one memory.

import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { EMBEDDING, INDEX_FORMAT_VERSION, indexPath, stagingIndexPath, memoryDir, memoryRoots,
         CORPORA, rootsForCorpus, indexPathForCorpus } from './config.js';
import { loadCorpus, sha256 } from './corpus.js';
import { chunkBody, embedPassages, embedQuery, embeddingsAvailable, embeddingsDisabledReason } from './embed.js';
import { guard, isFailedClosed } from './secrets.js';
import { log, warn, error } from './logger.js';
import { loadCache, flushCache, cacheGet, cacheSet } from './vector-cache.js';

function expectedHeader(corpusHash, chunkCount, docCount) {
  return {
    formatVersion: INDEX_FORMAT_VERSION,
    model: EMBEDDING.model,
    queryPrefix: EMBEDDING.queryPrefix,
    pooling: EMBEDDING.pooling,
    normalize: EMBEDDING.normalize,
    dim: EMBEDDING.dim,
    chunkWords: EMBEDDING.chunkWords,
    chunkOverlapWords: EMBEDDING.chunkOverlapWords,
    chunkCount,
    docCount,
    corpusHash,
    builtAt: new Date().toISOString()
  };
}

/** Fields that MUST match for stored vectors to mean anything. */
const CONTRACT_FIELDS = ['formatVersion', 'model', 'queryPrefix', 'pooling', 'normalize', 'dim', 'chunkWords', 'chunkOverlapWords'];

export function validateHeader(header) {
  if (!header || typeof header !== 'object') return ['header missing or not an object'];
  const want = {
    formatVersion: INDEX_FORMAT_VERSION,
    model: EMBEDDING.model,
    queryPrefix: EMBEDDING.queryPrefix,
    pooling: EMBEDDING.pooling,
    normalize: EMBEDDING.normalize,
    dim: EMBEDDING.dim,
    chunkWords: EMBEDDING.chunkWords,
    chunkOverlapWords: EMBEDDING.chunkOverlapWords
  };
  const problems = [];
  for (const f of CONTRACT_FIELDS) {
    if (header[f] !== want[f]) {
      problems.push(`${f}: index has ${JSON.stringify(header[f])}, runtime expects ${JSON.stringify(want[f])}`);
    }
  }
  return problems;
}

export function corpusHashOf(docs) {
  return sha256(docs.map((d) => `${d.file}:${d.hash}`).sort().join('|'));
}

/**
 * Build (or incrementally refresh) the index.
 * Returns a report: counts, excluded files (named), timings.
 */
// DEFAULTS TO THE PRIMARY ROOTS ONLY, and that is load-bearing rather than
// tidy. memoryRoots() returns EVERY root, so a caller taking the default while
// a staging store exists silently builds one mixed index — which is the precise
// thing measured to cost three memories their answer and 0.145 MRR. It happened
// here: scripts/build-index.js took the default and produced 114 curated + 22
// staging in .memory-index.json. Use buildAllIndexes() to build both, properly
// separated; pass `dir` explicitly to build any other set.
export async function buildIndex({ force = false, dir = rootsForCorpus('curated'), out = indexPath() } = {}) {
  const t0 = Date.now();
  if (isFailedClosed()) {
    throw new Error('secrets-exclude.json unreadable — refusing to index (fail closed)');
  }

  const { docs, excluded } = loadCorpus(dir);
  const corpusHash = corpusHashOf(docs);

  // Reuse vectors for files whose mtime+hash are unchanged.
  const prev = force ? null : readIndexRaw(out);
  const prevOk = prev && validateHeader(prev.header).length === 0;
  const reusable = new Map();
  if (prevOk) {
    // 🟥 KEYED BY NAME, NOT FILE. `file` was a safe key only while every file
    // produced exactly ONE document. Section children share their parent's file,
    // so a file key made all 138 collide with the parent's cached entry -- and
    // because they also inherited its hash and mtimeMs, the guard below passed
    // and each child was handed the parent's 517 chunks, vectors included. The
    // index then blew past V8's maximum string length and JSON.stringify threw
    // `RangeError: Invalid string length`.
    // Names are unique (lib/corpus.js warns on duplicates, and section children
    // disambiguate their slugs), so this is the identity that was always meant.
    for (const d of prev.docs || []) {
      if (d.hash && Array.isArray(d.chunks)) reusable.set(d.name, d);
    }
  } else if (prev) {
    warn('previous index header does not match the current contract — re-embedding everything');
  }

  const dense = await embeddingsAvailable();

  // 🟥 HARD RULE (Daniel, 2026-08-30): ONLY THE CORRECT MODEL INDEXES.
  // "make sure that if the right model is down, that some lesser model does not index.
  //  I rather just wait to index if the good model is down."
  //
  // The model is LOCAL, but local is not the same as cannot-fail. lib/embed.js caches its
  // disabledReason for the LIFE OF THE PROCESS, so one transient failure at startup makes
  // every later rebuild in that process BM25-only. Other real causes: a Node upgrade or
  // npm install breaking the native binding (the sharp/onnxruntime class), a missing
  // .model-cache falling back to a network fetch, memory pressure at load.
  //
  // What a degraded rebuild costs: a STALE dense index still has correct vectors for
  // everything except the handful of changed files. A BM25-only rebuild throws away
  // semantic matching for the ENTIRE corpus — and overwrites the vectors that proved it.
  // So: refuse, leave the existing index serving, and wait. There is deliberately NO env
  // override; an escape hatch is how "temporarily" becomes permanent.
  //
  // freshness.js already refuses this for the inline path; this is the same rule for the
  // deliberate one (npm run index, memory({action:"index"}), the Stop hook, dream).
  if (!dense) {
    throw new Error(
      `REFUSING TO INDEX: the embedding model is unavailable — ${embeddingsDisabledReason() || 'reason unknown'}\n` +
      `  Nothing was written. Any existing index at ${out} is UNCHANGED and still serving.\n` +
      `  A stale dense index beats a fresh keyword-only one, so this waits for the model.\n` +
      `  Fix: ensure .model-cache holds ${EMBEDDING.model} and that onnxruntime/sharp load, then re-run.`);
  }

  // ...and it must be the model this index CLAIMS, not merely some embedder. The header
  // records model + dim; a vector of the wrong width means the running embedder is not the
  // one the contract names, which would silently poison every comparison in the index.
  {
    const probe = await embedQuery('dimension check');
    if (!probe || probe.length !== EMBEDDING.dim) {
      throw new Error(
        `REFUSING TO INDEX: the live embedder returned ${probe ? probe.length : 'no'} dimensions, ` +
        `but the contract declares ${EMBEDDING.dim} for ${EMBEDDING.model}.\n` +
        `  Nothing was written; the existing index is UNCHANGED.\n` +
        `  Mixing vector widths or models makes every similarity in the index meaningless.`);
    }
  }

  // Vectors keyed by the TEXT they encode, so a rebuild costs only what actually
  // changed and an interrupt keeps what it computed. Flushed every
  // CACHE_FLUSH_EVERY newly embedded documents — the checkpointing this build
  // never had.
  const vcache = loadCache();
  const CACHE_FLUSH_EVERY = Number(process.env.MEMORY_CACHE_FLUSH_EVERY ?? 50);
  let sinceFlush = 0;

  let reused = 0, embedded = 0, chunkCount = 0;
  const outDocs = [];

  for (const d of docs) {
    const before = reusable.get(d.name);
    let chunks, summaryVec;
    if (before && before.hash === d.hash && before.mtimeMs === d.mtimeMs && before.chunks.length) {
      chunks = before.chunks;
      summaryVec = before.summaryVec ?? null;
      reused++;
    } else {
      const texts = chunkBody(d.body);
      // A doc-level "what is this memory about" vector, embedded alongside the
      // body chunks. Without it, max-over-chunks quietly favours long runbooks:
      // 60 chunks get 60 chances to score, a 3-line standing rule gets one.
      const summaryText = `${d.name.replace(/[-_]/g, ' ')}. ${d.description}`;
      let vecs = null, sVec = null;
      if (dense) {
        // Ask the cache first and embed only what it lacks. A frontmatter-only
        // edit changes the FILE hash (so the doc lands here) while every chunk
        // TEXT is identical — all cache hits, costing nothing. That case took
        // 43.8 minutes before this existed.
        const wanted = [summaryText, ...texts];
        const known = wanted.map((t) => cacheGet(vcache, t));
        const missingIdx = known.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
        if (missingIdx.length) {
          const fresh = await embedPassages(missingIdx.map((i) => wanted[i]));   // PASSAGES: no prefix.
          if (fresh) {
            missingIdx.forEach((wIdx, k) => { known[wIdx] = fresh[k]; cacheSet(vcache, wanted[wIdx], fresh[k]); });
          }
        }
        if (known[0]) { sVec = known[0]; vecs = known.slice(1); }
      }
      summaryVec = sVec;
      chunks = texts.map((text, i) => ({
        text: guard(text, 'index-chunk'),           // pattern guard, index time
        vec: vecs ? vecs[i] : null
      }));
      if (texts.length) embedded++;
      if (++sinceFlush >= CACHE_FLUSH_EVERY) { flushCache(vcache); sinceFlush = 0; }
    }
    chunkCount += chunks.length;

    outDocs.push({
      name: d.name,
      file: d.file,
      // The absolute path, so a search hit can name WHERE it came from. That is
      // the whole provenance story for a handoff document, whose file id is a
      // namespaced basename and whose folder is the thing worth knowing.
      sourcePath: d.path || null,
      readOnly: !!d.readOnly,
      description: guard(d.description, 'index-description'),
      descriptionSynthesised: d.descriptionSynthesised,
      // PHASE B -- carried so a section hit can name its parent, and so the
      // long-document correction can recognise a child at scoring time. The
      // first version of this relied on `parentName` being present at search
      // time; it is not, because this list is what survives into the index,
      // and the correction silently never fired.
      parentName: d.parentName,
      heading: d.heading,
      isSectionParent: d.isSectionParent,
      hasFrontmatter: d.hasFrontmatter,
      type: d.type,
      tier: d.tier,
      root: d.root || null,
      sessionId: d.sessionId || null,
      account: d.account || null,
      project: d.project || null,
      sessionTitle: d.sessionTitle || null,
      ts: d.ts || null,
      inMemoryIndex: d.inMemoryIndex,
      // PHASE 3a (dark) — probe fields survive into the index so probe_status
      // and the sweep can enumerate configured probes without re-reading the
      // corpus. Verdicts NEVER live here; they live in the sidecar.
      probe: d.probe || null,
      probeExpected: d.probeExpected ?? null,
      asOf: d.asOf || null,
      validUntil: d.validUntil || null,
      modified: d.modified,
      mtimeMs: d.mtimeMs,
      size: d.size,
      hash: d.hash,
      headings: d.headings.map((h) => guard(h, 'index-heading')),
      // Phase 4b: key facts must survive into the index, or a built index
      // silently loses the field the sidecar supplied.
      ...(d.keyFacts && d.keyFacts.length ? { keyFacts: d.keyFacts.map((f) => guard(f, 'index-key-fact')) } : {}),
      links: d.links,
      backlinks: d.backlinks,
      scrubbedSections: d.scrubbedSections,
      summaryVec,
      chunks
    });
  }

  flushCache(vcache, { force: true });
  log(`vector cache: ${vcache.hits} hits, ${vcache.misses} embedded, ${vcache.vectors.size} stored`);

  const payload = {
    header: expectedHeader(corpusHash, chunkCount, outDocs.length),
    denseEnabled: dense,
    excluded,
    docs: outDocs
  };

  // FINAL pattern-guard sweep over the serialized index before it hits disk.
  let json = JSON.stringify(payload);
  const guarded = guard(json, 'index-file');
  if (guarded !== json) {
    error('pattern guard fired on the SERIALIZED INDEX — a credential survived per-field guarding. Writing the redacted form.');
    json = guarded;
  }
  // ATOMIC WRITE. Two Claude sessions can end at the same moment, both firing
  // the SessionEnd ingest hook, and this file is 120 MB — a direct write to the
  // final path lets a reader observe a half-written index, which parses as
  // garbage and gets refused. rename(2) is atomic within a filesystem, so a
  // reader sees either the whole old index or the whole new one, never a seam.
  // The temp name carries the pid so two writers cannot share a scratch file.
  const tmpOut = `${out}.${process.pid}.tmp`;
  writeFileSync(tmpOut, json, 'utf8');
  try {
    renameSync(tmpOut, out);
  } catch (e) {
    try { unlinkSync(tmpOut); } catch (_) { /* best effort */ }
    throw e;
  }

  const seconds = (Date.now() - t0) / 1000;
  const report = {
    indexPath: out,
    corpusDir: dir,
    filesIndexed: outDocs.length,
    filesExcluded: excluded.length,
    excluded,
    filesReused: reused,
    filesEmbedded: embedded,
    chunkCount,
    denseEnabled: dense,
    denseDisabledReason: dense ? null : embeddingsDisabledReason(),
    sectionsScrubbed: outDocs.filter((d) => d.scrubbedSections?.length)
      .map((d) => ({ file: d.file, sections: d.scrubbedSections })),
    buildSeconds: Number(seconds.toFixed(2)),
    indexBytes: statSync(out).size,
    corpusHash
  };
  log(`index built: ${report.filesIndexed} files, ${report.chunkCount} chunks, ${report.buildSeconds}s, ${(report.indexBytes / 1e6).toFixed(2)} MB, dense=${dense}`);
  return report;
}

function readIndexRaw(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    warn(`index file unreadable (${e.message}) — will rebuild`);
    return null;
  }
}

/**
 * Load the index for querying.
 * Never throws on a bad header: returns { dense:false, headerProblems:[...] }
 * so the caller can serve BM25-only and say why.
 */
export function loadIndex(path = indexPath()) {
  const raw = readIndexRaw(path);
  if (!raw) return { present: false, dense: false, headerProblems: ['no index file — run `npm run index`'], docs: [], excluded: [] };

  const problems = validateHeader(raw.header);
  if (problems.length) {
    error(`INDEX HEADER REFUSED — dense retrieval disabled, BM25-only. Mismatches: ${problems.join('; ')}. Fix: npm run index -- --force`);
  }
  const dense = problems.length === 0 && raw.denseEnabled !== false &&
                (raw.docs || []).some((d) => d.chunks?.some((c) => Array.isArray(c.vec)));

  return {
    present: true,
    dense,
    headerProblems: problems,
    header: raw.header,
    docs: raw.docs || [],
    excluded: raw.excluded || []
  };
}

/**
 * Build EVERY index: one per corpus, each into its own file.
 *
 * THREE now — curated, staging, handoff. Separate files mean separate BM25
 * statistics AND separate corpus-derived constants, which is the entire point:
 * blending staging cost MRR 0.826 -> 0.681, and blending the handoff documents
 * cost 0.8194 -> 0.7986 plus an absence verdict, purely by moving the p90 chunk
 * count the long-document correction is derived from. See lib/config.js.
 *
 * Returns one report per index built.
 */
export async function buildAllIndexes({ force = false } = {}) {
  const roots = memoryRoots();
  const reports = [];
  for (const name of CORPORA) {
    const dir = rootsForCorpus(name, roots);
    const out = indexPathForCorpus(name);
    if (!out) continue;                                   // that corpus is switched off
    if (name !== 'curated' && !dir.length) continue;      // curated always builds, even empty
    reports.push({ scope: name, ...(await buildIndex({ force, dir, out })) });
  }
  return reports;
}

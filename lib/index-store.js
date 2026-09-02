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

import { dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { EMBEDDING, INDEX_FORMAT_VERSION, indexPath, stagingIndexPath, memoryDir, memoryRoots,
         CORPORA, rootsForCorpus, indexPathForCorpus } from './config.js';
import { loadCorpus, sha256 } from './corpus.js';
import { chunkBody, embedPassages, embedQuery, embeddingsAvailable, embeddingsDisabledReason } from './embed.js';
import { guard, isFailedClosed } from './secrets.js';
import { log, warn, error } from './logger.js';
import { loadCache, flushCache, cacheGet, cacheSet } from './vector-cache.js';
import { isVec, toVec, vecReplacer, hydrateIndex } from './vec.js';

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

/**
 * Fields that MUST match for stored vectors to mean anything.
 *
 * `formatVersion` is different in kind from the other seven. Those describe the RECIPE — which
 * model, which prefix, which pooling — and a mismatch means the stored numbers were produced by
 * something else, so they must match field-for-field. `formatVersion` describes only the
 * ENCODING: how the same numbers are written down. A reader that understands an encoding may
 * use it; one that does not must refuse BY NAME rather than quietly find no vectors.
 */
const CONTRACT_FIELDS = ['formatVersion', 'model', 'queryPrefix', 'pooling', 'normalize', 'dim', 'chunkWords', 'chunkOverlapWords'];

/** Encodings THIS build can read. Both, so an existing v1 index needs no rebuild. */
export const ACCEPTED_FORMAT_VERSIONS = new Set([1, 2]);

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
    if (f === 'formatVersion') {
      // Accept any encoding we can decode — NOT just our own. A newer index than this build
      // understands is named explicitly here so the operator is told to upgrade, rather than
      // being left with a dense=false server that still answers.
      if (!ACCEPTED_FORMAT_VERSIONS.has(header[f])) {
        problems.push(`formatVersion: index is format ${JSON.stringify(header[f])}, this build reads ${[...ACCEPTED_FORMAT_VERSIONS].join(' or ')} — upgrade the server, or rebuild with \`npm run index -- --force\``);
      }
      continue;
    }
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
/**
 * Documents in the index currently on disk, WITHOUT parsing it.
 *
 * The staging index is 56 MB; parsing it to answer "how many documents did you have a moment
 * ago" would cost more than the build this guard protects. The header is the first object in
 * the file, so a few KB is always enough. Returns null when it cannot tell — and a guard that
 * cannot tell must not block a build.
 */
function previousDocCount(out) {
  try {
    if (!existsSync(out)) return null;
    const fd = openSync(out, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      const m = buf.toString('utf8', 0, n).match(/"docCount"\s*:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    } finally { closeSync(fd); }
  } catch { return null; }
}

export async function buildIndex({ force = false, dir = rootsForCorpus('curated'), out = indexPath(),
  allowEmpty = false, allowShrink = false } = {}) {
  const t0 = Date.now();
  if (isFailedClosed()) {
    throw new Error('secrets-exclude.json unreadable — refusing to index (fail closed)');
  }

  // 🟥 GUARD 1 — AN EMPTY ROOT LIST IS NOT AN INSTRUCTION TO ERASE THE INDEX.
  //
  // This is not hypothetical. On 2026-09-01 a caller passed `rootsForScope('handoff')`, which
  // returns [] whenever MEMORY_HANDOFF_DIRS is unset (DEFAULT_HANDOFF_DIRS is empty by design,
  // so the library ships no one person's directories). buildIndex accepted it, indexed nothing,
  // and atomically renamed a 0-document index over a live one holding 147 documents. It reported
  //     index built: 0 files, 0 chunks, 3.33s, 0.00 MB, dense=true
  // which is indistinguishable from a successful build — `dense=true` on an index with no
  // vectors, and no error anywhere. The data came back only because MEMORY_HANDOFF_DIRS happened
  // to be recoverable from a Claude config file.
  //
  // There is no legitimate call that means "index nothing, and overwrite what is there".
  const rootList = Array.isArray(dir) ? dir : [dir].filter(Boolean);
  if (!rootList.length && !allowEmpty) {
    throw new Error(
      `refusing to build ${out} from an EMPTY root list — that would replace the existing index with nothing. ` +
      'A corpus name whose roots are unconfigured resolves to [] (handoff needs MEMORY_HANDOFF_DIRS; ' +
      'library categories need their directory to exist). Configure the roots, or pass allowEmpty:true ' +
      'if an empty index is genuinely what you want.');
  }

  const { docs, excluded } = loadCorpus(dir);

  // 🟥 GUARD 2 — a build that finds NOTHING where there was SOMETHING is a configuration
  // accident, not a corpus that emptied itself. Roots can exist and still yield no documents:
  // a directory renamed, a volume not mounted, a filter that matched everything. Cheap header
  // read, so it costs nothing on the 56 MB index it most needs to protect.
  const prevCount = previousDocCount(out);
  if (docs.length === 0 && prevCount > 0 && !allowShrink) {
    throw new Error(
      `refusing to overwrite ${out}: it holds ${prevCount} document(s) and this build found 0. ` +
      `Roots checked: ${rootList.map((r) => (typeof r === 'string' ? r : r.dir)).join(', ') || '(none)'}. ` +
      'That is almost always a path that moved or a drive that is not mounted. ' +
      'Pass allowShrink:true if the corpus really is empty now.');
  }
  // A large drop is suspicious but legitimate often enough (a real cleanup) that refusing it
  // would train people to pass the flag by reflex, which is how a guard stops guarding.
  if (prevCount > 0 && docs.length > 0 && docs.length < prevCount / 2) {
    warn(`index ${out}: document count is dropping ${prevCount} -> ${docs.length}. ` +
      'Proceeding — but if that is not deliberate, stop and check the roots before this is committed.');
  }
  const corpusHash = corpusHashOf(docs);

  // Reuse vectors for files whose mtime+hash are unchanged.
  const prev = force ? null : readIndexRaw(out);
  const prevOk = prev && validateHeader(prev.header).length === 0;

  // ---- VANISH REPORT — SHADOW ONLY ---------------------------------------
  //
  // The second net under a lost memory, at a different moment: commit-memories catches a
  // deletion when it is committed, this catches it when the index is rebuilt. Both exist
  // because the loss is otherwise silent — an index simply comes back smaller.
  //
  // It REPORTS AND NOTHING ELSE. No refusal, no restore, no effect on what is written; the
  // guards above already refuse the catastrophic shapes. This one names individual documents,
  // which is the case those cannot see.
  //
  // Deliberately only on the incremental path: `prev` is already parsed there, so the report
  // is free. On a --force build the previous index is not read at all, and parsing a 56 MB
  // file purely to diff names would cost more than the observation is worth — that path is
  // covered by the zero-document guard above instead.
  if (prevOk && !['0', 'false', 'off'].includes(String(process.env.MEMORY_VANISH_REPORT || '').toLowerCase())) {
    try {
      const now = new Set(docs.map((d) => d.name));
      const gone = (prev.docs || []).map((d) => d.name).filter((n) => n && !now.has(n));
      if (gone.length) {
        warn(`${gone.length} document(s) present in the last index are GONE from the corpus: ` +
          gone.slice(0, 15).join(', ') + (gone.length > 15 ? `, …and ${gone.length - 15} more` : '') +
          '. If that was not deliberate, stop before this index is written over the old one — ' +
          'the memory folder is version-controlled (npm run memories-status).');
      }
    } catch (_) { /* an observation must never be able to fail a build */ }
  }
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
  // vecReplacer, ALWAYS: a bare JSON.stringify turns a Float32Array into {"0":0.12,...} —
  // valid JSON, no error, and the next load finds no vectors and silently drops to BM25-only.
  let json = JSON.stringify(payload, vecReplacer);
  const guarded = guard(json, 'index-file');
  if (guarded !== json) {
    error('pattern guard fired on the SERIALIZED INDEX — a credential survived per-field guarding. Writing the redacted form.');
    // THE GUARD REWRITES TEXT, AND SINCE v2 SOME OF THAT TEXT IS VECTOR DATA. Standard base64 is
    // safe against the credential patterns by construction (sk-/ghp_/AKIA need [-_], JWT needs a
    // dot), but the hashed-literal sweep matches bare runs and could clip a blob by coincidence.
    // A clipped blob is silent at write time and only surfaces as a load failure later, so decode
    // every vector NOW and refuse to write an index that would not load.
    let checked = 0;
    try {
      const reparsed = JSON.parse(guarded);
      for (const d of reparsed.docs || []) {
        if (d.summaryVec != null && !toVec(d.summaryVec)) throw new Error(`summary vector of ${d.name} no longer decodes`);
        for (const c of d.chunks || []) if (c.vec != null) { if (!toVec(c.vec)) throw new Error(`a chunk vector of ${d.name} no longer decodes`); checked++; }
      }
    } catch (e) {
      throw new Error(`refusing to write the index: the pattern guard altered vector data (${e.message}). ` +
        'Add the offending literal to secrets-exclude.json, or set MEMORY_VEC_ENCODING=array to write plain arrays.');
    }
    log(`post-guard check: ${checked} vectors still decode`);
    json = guarded;
  }
  // ATOMIC WRITE. Two Claude sessions can end at the same moment, both firing
  // the SessionEnd ingest hook, and this file is 120 MB — a direct write to the
  // final path lets a reader observe a half-written index, which parses as
  // garbage and gets refused. rename(2) is atomic within a filesystem, so a
  // reader sees either the whole old index or the whole new one, never a seam.
  // The temp name carries the pid so two writers cannot share a scratch file.
  // CREATE THE INDEX'S DIRECTORY. A library category's index lives wherever
  // MEMORY_LIBRARY_INDEX_DIR points, and that directory does not exist until something makes it
  // — so `import` into a new category succeeded, told the caller to build the index, and the
  // build then failed on ENOENT for a directory the caller had configured on purpose. Making it
  // is not a guess about intent; refusing to make it was.
  try { mkdirSync(dirname(out), { recursive: true }); } catch (_) { /* the write below reports it */ }
  const tmpOut = `${out}.${process.pid}.tmp`;
  // A FAILURE HERE IS A SETUP PROBLEM, NOT A BUG, and it should read like one. Pointing
  // MEMORY_INDEX somewhere unwritable produced a raw EACCES stack trace out of node:fs, which
  // tells a newcomer nothing about what they did or how to fix it. The cause is almost always
  // the directory, so name it and say what to do.
  try {
    writeFileSync(tmpOut, json, 'utf8');
  } catch (e) {
    const why = e && e.code === 'EACCES' ? 'no permission to write there'
      : e && e.code === 'ENOSPC' ? 'the disk is full'
      : e && e.code === 'ENOENT' ? 'that directory does not exist'
      : e && e.message;
    const err = new Error(
      `cannot write the index to ${out} — ${why}. ` +
      'Point MEMORY_INDEX at a writable path (or fix the permissions on that directory). ' +
      'The corpus itself was not touched.');
    err.cause = e;
    throw err;
  }
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

  // NAME THE FILE THAT COST THE TIME. Dropping one large export into the notes folder is an
  // ordinary accident, and it is silent: measured, a single 4.6 MB file alongside twelve normal
  // notes produced 4,562 of 4,574 chunks, took the build from about a second to 163, and grew
  // the index from 0.2 MB to 43 MB — with nothing in the output pointing at it.
  //
  // It is NOT refused and NOT excluded. Retrieval handles it correctly (measured: 6/6 questions
  // still answered by the right note, and the giant never entered a top-3 it did not belong in),
  // so this is the user's corpus and their decision. What they were missing is which file to
  // decide ABOUT.
  const biggest = outDocs.map((d) => ({ name: d.name, n: (d.chunks || []).length }))
    .sort((a, b) => b.n - a.n)[0];
  if (biggest && chunkCount >= 200 && biggest.n / chunkCount >= 0.25) {
    warn(`${biggest.name} produced ${biggest.n} of ${chunkCount} chunks ` +
      `(${Math.round(100 * biggest.n / chunkCount)}% of this index, and most of the ${report.buildSeconds}s build). ` +
      'One very large file does this. Retrieval handles it — long documents are corrected for, and it ' +
      'stays findable — but if the rebuild time bothers you, that is the file to move out or split.');
  }
  return report;
}

function readIndexRaw(path) {
  if (!existsSync(path)) return null;
  try {
    // hydrateIndex converts EVERY vector to Float32Array. See lib/vec.js for why this is
    // the parse site and not loadIndex: the build-reuse path reads this same object.
    return hydrateIndex(JSON.parse(readFileSync(path, 'utf8')));
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
                (raw.docs || []).some((d) => d.chunks?.some((c) => isVec(c.vec)));

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

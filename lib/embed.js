// lib/embed.js — dense side. Lazy, optional, and LOUD when it fails.
//
// If @xenova/transformers cannot load (not installed, model not cached, no
// network on first run), we do not throw: retrieval degrades to BM25-only and
// says so, in the logs and in every search response's `mode` field. Silent
// degradation is the failure mode that wastes a week.
//
// bge-small-en-v1.5 is ASYMMETRIC. The prefix goes on QUERIES ONLY.

import { EMBEDDING, modelCacheDir } from './config.js';
import { log, warn, error } from './logger.js';

let pipePromise = null;
let disabledReason = null;

export function embeddingsDisabledReason() {
  return disabledReason;
}

async function getPipe() {
  if (disabledReason) return null;
  if (!pipePromise) {
    pipePromise = (async () => {
      const t0 = Date.now();
      const { env, pipeline } = await import('@xenova/transformers');
      env.cacheDir = modelCacheDir();
      env.allowLocalModels = true;
      const pipe = await pipeline('feature-extraction', EMBEDDING.model, { quantized: true });
      log(`embedding model ready: ${EMBEDDING.model} (${Date.now() - t0} ms)`);
      return pipe;
    })().catch((e) => {
      disabledReason = `embedding model unavailable: ${e.message}`;
      error(`DENSE RETRIEVAL DISABLED — ${disabledReason}. Falling back to BM25-only. ` +
            `Fix: run \`npm run index\` with network access so the model caches into ${modelCacheDir()}.`);
      return null;
    });
  }
  return pipePromise;
}

export async function embeddingsAvailable() {
  return (await getPipe()) !== null;
}

/** Embed PASSAGES — bare, no prefix. */
export async function embedPassages(texts, onProgress) {
  return embedBatched(texts, false, onProgress);
}

/** Embed QUERIES — with the bge query prefix. Getting this backwards is silent. */
export async function embedQuery(text) {
  const vecs = await embedBatched([EMBEDDING.queryPrefix + text], true);
  return vecs ? vecs[0] : null;
}

async function embedBatched(texts, isQuery, onProgress) {
  const pipe = await getPipe();
  if (!pipe) return null;
  const out = [];
  const BATCH = 16;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await pipe(batch, { pooling: EMBEDDING.pooling, normalize: EMBEDDING.normalize });
    const dim = res.dims[res.dims.length - 1];
    if (dim !== EMBEDDING.dim) {
      disabledReason = `model returned dim ${dim}, contract expects ${EMBEDDING.dim}`;
      error(`DENSE RETRIEVAL DISABLED — ${disabledReason}`);
      return null;
    }
    for (let r = 0; r < batch.length; r++) {
      out.push(Array.from(res.data.slice(r * dim, (r + 1) * dim), (x) => Math.fround(x)));
    }
    if (onProgress) onProgress(Math.min(i + BATCH, texts.length), texts.length);
  }
  if (isQuery === false && !out.length) warn('embedPassages produced no vectors');
  return out;
}

/** Vectors are L2-normalised, so cosine is a plain dot product. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * The exact inverse of chunkBody(): stitch the stored chunks back into the
 * whitespace-normalised body, dropping each chunk's overlap with its
 * predecessor.
 *
 * The index stores chunks, not bodies. The keyword leg needs the body (a term
 * counted once per occurrence, not 1.25× because 40 of every 160 words appear
 * in two chunks), and the phrase leg needs one continuous token sequence — a
 * quote that straddles a chunk boundary must still be findable. Reconstructing
 * costs one array walk and keeps the index format unchanged.
 *
 * Correctness rests on the chunker's own arithmetic: chunk k covers words
 * [step*k, step*k + chunkWords), so every chunk after the first repeats exactly
 * `chunkOverlapWords` words. The loop's break condition guarantees the final
 * chunk is longer than the overlap, so nothing is ever dropped.
 */
export function unchunkBody(chunkTexts) {
  const { chunkOverlapWords } = EMBEDDING;
  if (!chunkTexts?.length) return '';
  const words = chunkTexts[0].split(' ');
  for (let i = 1; i < chunkTexts.length; i++) {
    const w = chunkTexts[i].split(' ');
    if (w.length <= chunkOverlapWords) continue;    // fully contained in its predecessor
    for (let j = chunkOverlapWords; j < w.length; j++) words.push(w[j]);
  }
  return words.join(' ');
}

/** ~200-word windows with ~40-word overlap, headings kept with their text. */
export function chunkBody(body) {
  const { chunkWords, chunkOverlapWords } = EMBEDDING;
  const words = body.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const step = Math.max(1, chunkWords - chunkOverlapWords);
  const chunks = [];
  for (let i = 0; i < words.length; i += step) {
    const slice = words.slice(i, i + chunkWords);
    if (!slice.length) break;
    chunks.push(slice.join(' '));
    if (i + chunkWords >= words.length) break;
  }
  return chunks;
}

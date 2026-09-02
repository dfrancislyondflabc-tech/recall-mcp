// lib/ordinary-shadow.js — is a refusal's missing vocabulary ORDINARY ENGLISH? Measured, never applied.
//
// See test/ordinary-word-shadow-preregistration.md — written before this file, and it fixes how the
// log is allowed to be read.
//
// ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
//
// When a search refuses, it names the query terms that appear nowhere in the corpus. Today they all
// count the same. They are not the same:
//
//   "how many people work overnight"   missing: many, people, work   -> refusal was WRONG
//                                      (the corpus says "two bakers overnight")
//   "what causes crazing in a glaze"   missing: cause, craz, finish  -> refusal was RIGHT
//                                      (the corpus documents crawling, a different defect)
//
// `craz` is a subject word this corpus has never seen. `people` is not evidence of anything.
//
// ── WHY IT ONLY LOGS ───────────────────────────────────────────────────────
//
// The user's standing rule: a change that asks a detector to JUDGE something it does not judge
// today ships in shadow first, because more judgment means more ways to be wrong, and reliability
// is the thing being protected. This asks the absence layer to judge WHAT KIND of word is missing.
// So it runs AFTER the verdict, from data the verdict already produced, and writes to a file.
//
// There is deliberately no code path from this module back into a result. It exports no predicate
// the search can consult, and `search.js` ignores its return value. If someone later wants the
// behaviour, the pre-registration says what the log has to show first — and that it earns a
// PROPOSAL, not a shipped change.
//
// ── THE INSTRUMENT, AND ITS KNOWN LIMITS ───────────────────────────────────
//
// The WordPiece vocabulary of the embedding model already on disk: 30,522 entries, built by
// frequency over general English. A single-token word is ordinary; one that must be split is not.
// Derived from data rather than hand-written, per the standing rule — and it costs nothing to ship,
// because the file is already there.
//
// Measured before it was written, on words chosen to break it (numbers in the pre-registration):
//
//   * ordinary classed ordinary 19/24. The misses are STEMMER ARTIFACTS — the BM25 stemmer turns
//     `running` into `runn`, which is not a word in any vocabulary. This fails SAFE: it suppresses
//     divergences rather than inventing them.
//   * technical classed ordinary 7/22 — server, index, cache, token, python, buffer, vector. Those
//     really are common English words that happen to also be technical. Whether that should count
//     as evidence of absence is exactly what the log exists to answer, so it is not "fixed" here.
//
// Nothing about this module may throw into a search. Every entry point is wrapped, and a sink that
// cannot be written leaves the caller untouched — asserted by test, not by inspection.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { modelCacheDir, EMBEDDING } from './config.js';
import { isBenchmarkQuery } from './benchmark-strings.js';

export function ordinaryShadowEnabled() {
  return !['0', 'false', 'off'].includes(String(process.env.MEMORY_ORDINARY_SHADOW || '').toLowerCase());
}

/** Where the divergences accumulate. Beside the model cache, not in the corpus — a shadow log is
 *  not a memory, and indexing it would feed the system its own telemetry. */
export function shadowLogPath() {
  return process.env.MEMORY_ORDINARY_SHADOW_LOG || join(dirname(modelCacheDir()), '.shadow', 'ordinary-word-shadow.jsonl');
}

let VOCAB = null;          // Map-free: a plain object from tokenizer.json
let vocabTried = false;

/** Load the WordPiece vocabulary once. Absent or unreadable -> the probe stays silent forever. */
function vocab() {
  if (vocabTried) return VOCAB;
  vocabTried = true;
  try {
    const p = join(modelCacheDir(), EMBEDDING.model, 'tokenizer.json');
    if (!existsSync(p)) return (VOCAB = null);
    const v = JSON.parse(readFileSync(p, 'utf8'))?.model?.vocab;
    // A vocabulary that is present but tiny is a broken file, not a small language. Refuse it
    // rather than classify every word on earth as technical and log a flood of false divergences.
    VOCAB = v && Object.keys(v).length > 10000 ? v : null;
  } catch {
    VOCAB = null;
  }
  return VOCAB;
}

/**
 * Classify ONE stem. Returns 'ordinary' | 'technical' | 'unknown'.
 *
 * 'unknown' when there is no vocabulary at all — distinct from 'technical', so a missing model
 * never reads in the log as evidence that a word was exotic.
 */
export function classifyStem(stem) {
  const v = vocab();
  if (!v) return 'unknown';
  return Object.prototype.hasOwnProperty.call(v, String(stem).toLowerCase()) ? 'ordinary' : 'technical';
}

/**
 * Called AFTER the verdict, with what the verdict already computed. Returns the divergence record
 * for tests, or null. THE CALLER IGNORES THE RETURN VALUE — it exists so the behaviour can be
 * asserted without reading the log file.
 */
export function observeAbsence({ query, scope, stats, verdict }) {
  try {
    if (!ordinaryShadowEnabled()) return null;
    if (!verdict?.noStrongMatch) return null;            // only refusals are interesting
    // OUR OWN TEST STRINGS ARE NOT TRAFFIC. The first 240 lines this probe ever wrote were 14
    // benchmark questions repeated ~20 times each by the suite — a population that would have
    // been read as real usage. The same mistake is documented in lib/benchmark-strings.js: 58%
    // of 'live' query-log rows once turned out to be the project's own gold strings.
    if (isBenchmarkQuery(query)) return null;
    const orphans = stats?.orphans || [];
    if (!orphans.length) return null;                     // the evidence route can refuse with none

    const classified = orphans.map((o) => ({ stem: o, klass: classifyStem(o) }));
    if (classified.some((c) => c.klass === 'unknown')) return null;   // no instrument, no claim
    // THE CONDITION: every missing word is ordinary English. One real subject word is enough to
    // make the refusal defensible, so this deliberately requires unanimity.
    if (!classified.every((c) => c.klass === 'ordinary')) return null;

    const weak = (verdict.bestWeak || [])[0] || null;
    const record = {
      at: new Date().toISOString(),
      query,
      scope: scope ?? null,
      orphans: classified,
      orphanShare: stats?.orphanShare ?? null,
      signals: verdict.signals ?? null,
      // Which route refused. byEvidence cannot fire at or above scoreFloor, so a refusal whose top
      // score is high came from the vocabulary route — the case this signal is really about.
      topWeak: weak ? { name: weak.name, score: weak.score } : null,
      // What a reader has to open to judge it. Recorded so the log can be adjudicated later
      // WITHOUT re-running the query against a corpus that has since changed.
      weakSnippet: weak?.snippet ? String(weak.snippet).slice(0, 400) : null
    };

    const p = shadowLogPath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch {
    // A shadow that breaks a search is worse than no shadow. Swallow everything: an unwritable
    // sink, a full disk, a read-only volume, a malformed vocabulary. The search never learns.
    return null;
  }
}

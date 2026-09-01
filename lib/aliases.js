// lib/aliases.js — Phase 4a: a query names one model, the manual is written
// for the family.
//
// The only relation this layer knows is MODEL -> FAMILY STEM (`ACME-673A` ->
// `ACME-x73A`), read from `lib/alias-table.json`, which is GENERATED from the
// 425-model expansion-compatibility database by scripts/build-alias-table.js
// and never hand-edited.
//
// THREE PROPERTIES, EACH STRUCTURAL RATHER THAN CAREFUL:
//
//   1. A model never aliases to another MODEL. That is the whole dash-boundary
//      rule: ACME-464U and ACME-464 derive different stems, so no path connects
//      them, and ACME-464U (whose stem has no second member in the source)
//      expands to nothing at all.
//   2. Expansion touches the KEYWORD leg only, as a separate lower-weighted
//      pass. The semantic leg, the phrase leg, `matchedTerms` and the term
//      statistics all keep reading the original question.
//   3. THE ABSENCE VERDICT NEVER SEES IT. Both inputs the verdict is made of —
//      the raw keyword mass and the top document's score — are handed over in
//      their unexpanded form. Expansion may change what ranks; it may never
//      argue a refusal into an answer. Pinned by test.
//
// Flag: MEMORY_SKU_ALIAS. Default is decided by the pre-registered bar in
// test/sku-alias-preregistration.md, not by taste.

import { fileURLToPath } from 'node:url';
import { jsonFileMemo } from './file-memo.js';

// SAME CLASS AS D1, fixed alongside it. The alias flag is OFF by default so
// this was never live, but a regenerated alias table under a running process
// would have been invisible in exactly the same way.
const table = jsonFileMemo(
  () => fileURLToPath(new URL('./alias-table.json', import.meta.url)),
  (text) => JSON.parse(text),
  () => ({ modelToFamilies: {}, families: {} })
);

export function aliasEnabled() {
  return ['1', 'true', 'on'].includes(String(process.env.MEMORY_SKU_ALIAS || '').toLowerCase());
}

/** How much of the keyword leg an alias term may earn. Never 1: a family is
 *  evidence about the question, not the words of it. */
export function aliasWeight() {
  const v = Number(process.env.MEMORY_SKU_ALIAS_WEIGHT);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.35;
}

// A model token as the source database writes them: ACME-410X, ACME-h820,
// ACME-2200P, ACME-h9600GX. Anchored on the prefix-dash shape so ordinary words
// and dates cannot be read as products.
const MODEL_TOKEN_RE = /\b[A-Za-z]{2,4}-[A-Za-z]?\d[0-9A-Za-z+]*\b/g;

/**
 * The family stems a query earns. Returns [] when the flag is off, when the
 * scope is a multi-corpus fan-out, or when no token is a known model.
 */
export function aliasExpansion(query, { scope } = {}) {
  if (!aliasEnabled()) return [];
  // NAMED CORPUS ONLY. A fan-out asks eight corpora one question; quietly
  // adding a term to all eight is a different experiment from this one.
  if (!scope || Array.isArray(scope) || scope === 'all' || scope === 'everything') return [];
  const map = table().modelToFamilies || {};
  const q = String(query || '');
  const present = new Set((q.match(MODEL_TOKEN_RE) || []).map((t) => t.toUpperCase()));
  const out = [];
  for (const tok of present) {
    for (const stem of map[tok] || []) {
      if (!present.has(stem.toUpperCase()) && !out.includes(stem)) out.push(stem);
    }
  }
  return out;
}

/** For the response: what was added, and where it came from. */
export function aliasNote(added) {
  if (!added.length) return null;
  return `MODEL FAMILY EXPANSION: also searched for ${added.join(', ')} — the family stem(s) of the ` +
    'model(s) named in the question, from the generated alias table. Keyword leg only, at reduced ' +
    'weight; the absence verdict was computed on your question as written.';
}

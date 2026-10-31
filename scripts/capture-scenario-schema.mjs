/**
 * Shared schema for the dev-capture scenario registry
 * (AH-0MVSDM4ED003C8ZC, child of AH-0MVI5XI73000ZVYA).
 *
 * The registry (`scripts/capture-scenarios.mjs`) is the single source of
 * truth for the dev scenarios, and it is read by two very different
 * consumers: the capture CLI under bare Node and the game resolver
 * (`src/core/devScenario.ts`) inside the Vite build. Both must reject a
 * malformed entry **at module load** rather than silently shipping a
 * scenario whose promo metadata is missing, so the entry vocabulary and its
 * validation live here once instead of being copied into each consumer.
 *
 * Why not derive the vocabulary from `EDITORIAL_CONFIG` in
 * `scripts/compile-promo.mjs`? That module imports `node:fs` /
 * `node:child_process`, so it cannot be imported by anything the browser
 * bundle reaches — which includes this schema and the registry. The list is
 * therefore restated here and pinned to `EDITORIAL_CONFIG.categories` by the
 * registry contract test (`scripts/capture-scenarios.test.ts`), so the two
 * cannot drift without failing the suite.
 *
 * Plain ESM with **no Node APIs and no DOM/types**, so bare Node (the capture
 * CLI) and the Vite game build can both import it untouched;
 * `capture-scenario-schema.d.mts` supplies the types for TypeScript
 * consumers.
 */

/**
 * The entry kinds the enriched registry may declare.
 *
 * - `boss` — jump straight into the boss encounter (the original scenarios).
 * - `defeat` — clear the wave and end the run in defeat on release.
 * - `promo` — a curated promo-video scenario carrying bot-tuning preset,
 *   promo wave level, optional seed and the editorial categories it
 *   evidences.
 *
 * Frozen so no consumer can widen the vocabulary at runtime; the resolver
 * (`src/core/devScenario.ts`) switches on exactly these kinds.
 */
export const CAPTURE_SCENARIO_KINDS = Object.freeze([
  'boss',
  'defeat',
  'promo',
]);

/**
 * Editorial feature categories a promo scenario may evidence, in the promo
 * compiler's manifest order.
 *
 * Mirrors `EDITORIAL_CONFIG.categories` in `scripts/compile-promo.mjs` (the
 * promo pipeline's single source of truth); the registry contract test pins
 * the two lists to each other, so tuning one without the other fails fast.
 */
export const EDITORIAL_CATEGORIES = Object.freeze([
  'weapons',
  'pickups',
  'enemies',
  'boss',
]);

/** Whether `value` is one of the registry entry kinds. */
export function isCaptureScenarioKind(value) {
  return CAPTURE_SCENARIO_KINDS.includes(value);
}

/** Whether `value` is one of the promo editorial categories. */
export function isEditorialCategory(value) {
  return EDITORIAL_CATEGORIES.includes(value);
}

/** A non-empty (after trimming) string — the shape every text field needs. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Asserts the promo metadata contract on one `kind: 'promo'` entry.
 *
 * A promo entry must carry a non-empty bot-tuning `preset`, a non-empty
 * `promoLevel` reference into the promo wave module, and a non-empty
 * `categories` array drawn from {@link EDITORIAL_CATEGORIES}; `seed` is
 * optional but, when present, must be a uint32 so a capture is reproducible.
 *
 * @param {Record<string, unknown>} entry
 * @param {string} where — human-readable entry label for the error message.
 */
function assertPromoMetadata(entry, where) {
  if (!isNonEmptyString(entry.preset)) {
    throw new Error(
      `capture-scenarios: ${where} must declare a non-empty "preset" `
        + '(a bot-tuning preset name from src/data/bot-tuning.json)',
    );
  }
  if (!isNonEmptyString(entry.promoLevel)) {
    throw new Error(
      `capture-scenarios: ${where} must declare a non-empty "promoLevel" `
        + '(a level reference in the promo wave module)',
    );
  }

  const categories = entry.categories;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error(
      `capture-scenarios: ${where} must declare a non-empty "categories" `
        + `array (expected ${EDITORIAL_CATEGORIES.join(' | ')})`,
    );
  }
  for (const category of categories) {
    if (!isEditorialCategory(category)) {
      throw new Error(
        `capture-scenarios: ${where} declares an unknown editorial category `
          + `"${String(category)}" (expected ${EDITORIAL_CATEGORIES.join(' | ')})`,
      );
    }
  }

  const seed = entry.seed;
  if (seed !== undefined) {
    const isUint32 = typeof seed === 'number'
      && Number.isInteger(seed)
      && seed >= 0
      && seed <= 0xffffffff;
    if (!isUint32) {
      throw new Error(
        `capture-scenarios: ${where} "seed" must be a uint32 integer `
          + `(0..${0xffffffff}), got ${String(seed)}`,
      );
    }
  }
}

/**
 * Asserts the full enriched-entry contract on one registry entry.
 *
 * Every entry declares a `name`, a one-line `effect` and one of the
 * {@link CAPTURE_SCENARIO_KINDS}; a `promo` entry additionally satisfies the
 * promo metadata contract. Throws with an actionable message naming the entry
 * and the offending field, so a bad authored entry fails the capture CLI and
 * the game build at import time instead of producing a broken scenario.
 *
 * @param {unknown} entry
 * @param {string} [label] — human-readable entry label for messages.
 */
export function assertCaptureScenarioEntry(entry, label = 'scenario') {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`capture-scenarios: ${label} must be an object`);
  }
  const fields = /** @type {Record<string, unknown>} */ (entry);
  if (!isNonEmptyString(fields.name)) {
    throw new Error(`capture-scenarios: ${label} must have a non-empty "name"`);
  }
  const where = `${label} "${String(fields.name)}"`;
  if (!isNonEmptyString(fields.effect)) {
    throw new Error(`capture-scenarios: ${where} must have a non-empty "effect"`);
  }
  if (!isCaptureScenarioKind(fields.kind)) {
    throw new Error(
      `capture-scenarios: ${where} must declare a "kind" `
        + `(${CAPTURE_SCENARIO_KINDS.join(' | ')})`,
    );
  }
  if (fields.kind === 'promo') assertPromoMetadata(fields, where);
}

/**
 * Validates one registry entry and returns it as a frozen copy.
 *
 * The registry freezes its entries so no consumer (the game resolver, the CLI
 * formatter or a test) can mutate the single source of truth; the promo
 * `categories` array is frozen too, so a caller that forgets to copy cannot
 * widen a scenario's evidenced categories.
 *
 * @param {unknown} entry
 * @param {string} [label]
 * @returns {object}
 */
export function freezeCaptureScenarioEntry(entry, label = 'scenario') {
  assertCaptureScenarioEntry(entry, label);
  const fields = /** @type {Record<string, unknown>} */ (entry);
  const frozen = { ...fields };
  if (Array.isArray(fields.categories)) {
    frozen.categories = Object.freeze([...fields.categories]);
  }
  return Object.freeze(frozen);
}

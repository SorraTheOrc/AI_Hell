/**
 * Shared dev-capture scenario registry (single source of truth)
 * (AH-0MV6JGE9R005YOL1, foundation child of AH-0MUZM8ATZ002AKFP).
 *
 * Both consumers — the game resolver (`src/core/devScenario.ts`) and the
 * capture CLI (`npm run capture`) — read the same list from here, so the
 * scenario names and their one-line effects cannot drift between the URL
 * query parameter, the `--list-scenarios` output and the docs table. A
 * scenario added to one side without registering it here fails the registry
 * ↔ resolver parity test instead of silently diverging.
 *
 * This module is plain ESM JavaScript with **no Node APIs and no DOM/types**,
 * so bare Node (the capture script) and the Vite game build can both import
 * it untouched; `capture-scenarios.d.mts` supplies the types for TypeScript
 * consumers and tests.
 *
 * ## Enriched entry schema (AH-0MVSDM4ED003C8ZC, child of AH-0MVI5XI73000ZVYA)
 *
 * Each entry is more than a name and a one-line effect: it declares the
 * `kind` of scenario it is, and a `kind: 'promo'` entry additionally carries
 * the **promo metadata** the catalogue needs — the bot-tuning `preset` it
 * flies, the `promoLevel` reference into the hand-authored promo wave module,
 * the optional deterministic `seed`, and the editorial `categories` it
 * evidences. The shape and its validation live in
 * `scripts/capture-scenario-schema.mjs` (browser-free, like this module); the
 * entries below are validated as this module is imported, so a malformed
 * authored entry fails the capture CLI and the game build immediately rather
 * than producing a scenario that cannot be flown.
 *
 * The existing three entries keep their names, effects and runtime behaviour
 * exactly; the first real promo entries arrive with the catalogue item, so
 * this module stays a three-entry registry for now.
 */

import { freezeCaptureScenarioEntry } from './capture-scenario-schema.mjs';

/**
 * One implemented dev capture scenario.
 *
 * `name` is the value of the `scenario` URL query parameter the resolver
 * accepts (and what `--scenario` passes through); `effect` is a single line
 * a maintainer can read to know what the scenario does; `kind` selects the
 * resolver union member it produces. A `promo` entry also carries `preset`,
 * `promoLevel`, optional `seed` and `categories` (see
 * `scripts/capture-scenario-schema.mjs`).
 *
 * @typedef {import('./capture-scenario-schema.mjs').CaptureScenario} CaptureScenario
 */

/**
 * The authored scenario entries, in the order the tooling lists and runs
 * them.
 *
 * `boss` is the tunable jump (`&bossHits=N`); `boss-four-hits` is the recorded
 * default (4 hits); `defeat` ends the run in defeat on release. This list is
 * an implementation detail — {@link CAPTURE_SCENARIOS} is the validated,
 * frozen registry every consumer reads.
 *
 * @type {readonly CaptureScenario[]}
 */
const AUTHORED_SCENARIOS = [
  {
    name: 'boss',
    effect: 'Jump straight to the boss with a tunable hit count (&bossHits=N).',
    kind: 'boss',
  },
  {
    name: 'boss-four-hits',
    effect: 'Jump straight to the boss with 4 hits remaining (the recorded demo).',
    kind: 'boss',
  },
  {
    name: 'defeat',
    effect: 'Clear the wave and end the run in defeat on release (defeat-path demo).',
    kind: 'defeat',
  },
];

/**
 * The implemented dev capture scenarios, in the order the tooling lists and
 * runs them.
 *
 * Frozen top-level array and frozen entries (a promo entry's `categories`
 * array is frozen too), so no consumer (the game resolver, the CLI formatter
 * or a test) can mutate the single source of truth. Every entry is validated
 * by the shared schema as this module loads, so an authored entry that breaks
 * the contract throws here instead of at some later, more confusing point.
 *
 * @type {readonly CaptureScenario[]}
 */
export const CAPTURE_SCENARIOS = Object.freeze(
  AUTHORED_SCENARIOS.map((scenario, index) =>
    freezeCaptureScenarioEntry(scenario, `CAPTURE_SCENARIOS[${index}]`)),
);

/**
 * Whether `value` is a registered scenario name.
 *
 * Matching mirrors the resolver's own normalisation (trim + lowercase), so
 * the gate and the resolver agree on case/whitespace; any other value
 * (unknown name, blank, non-string) is rejected.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRegisteredScenario(value) {
  if (typeof value !== 'string') return false;
  const normalised = value.trim().toLowerCase();
  return CAPTURE_SCENARIOS.some((scenario) => scenario.name === normalised);
}

/**
 * Lists the registered scenarios as fresh copies.
 *
 * A pure list helper for CLI formatters and batch builders: callers get new
 * objects each call, so formatting or reordering the returned list can never
 * mutate the frozen registry.
 *
 * @returns {CaptureScenario[]}
 */
export function listCaptureScenarios() {
  return CAPTURE_SCENARIOS.map((scenario) => ({ ...scenario }));
}

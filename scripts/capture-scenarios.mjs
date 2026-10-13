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
 */

/**
 * One implemented dev capture scenario.
 *
 * `name` is the value of the `scenario` URL query parameter the resolver
 * accepts (and what `--scenario` passes through); `effect` is a single line
 * a maintainer can read to know what the scenario does.
 *
 * @typedef {object} CaptureScenario
 * @property {string} name
 * @property {string} effect
 */

/**
 * The implemented dev capture scenarios, in the order the tooling lists and
 * runs them.
 *
 * Frozen top-level array and frozen entries, so no consumer (the game
 * resolver, the CLI formatter or a test) can mutate the single source of
 * truth. `boss` is the tunable jump (`&bossHits=N`); `boss-four-hits` is the
 * recorded default (4 hits); `defeat` ends the run in defeat on release.
 *
 * @type {readonly CaptureScenario[]}
 */
export const CAPTURE_SCENARIOS = Object.freeze([
  Object.freeze({
    name: 'boss',
    effect: 'Jump straight to the boss with a tunable hit count (&bossHits=N).',
  }),
  Object.freeze({
    name: 'boss-four-hits',
    effect: 'Jump straight to the boss with 4 hits remaining (the recorded demo).',
  }),
  Object.freeze({
    name: 'defeat',
    effect: 'Clear the wave and end the run in defeat on release (defeat-path demo).',
  }),
]);

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

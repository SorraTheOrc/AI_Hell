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
 * The registry now also carries the **promo catalogue**
 * (AH-0MVSDMBU60018JOE, child of AH-0MVI5XI73000ZVYA): the authored
 * `kind: 'promo'` entries that pair a curated bot-tuning preset with a
 * hand-authored promo level from `scripts/promo-scenarios.mjs`. The three
 * original capture shortcuts keep their names, effects and runtime behaviour
 * exactly; they are listed **after** the promo catalogue so the first entry —
 * and therefore the first `--all-scenarios` clip — is the designated
 * high-intensity hook (`promo-blitz-hook`), which keeps the first compiled
 * promo cut free of dead air (parent AC3).
 *
 *   `promo-blitz-hook` → promo catalogue (12 curated promo scenarios)
 *   `boss`, `boss-four-hits`, `defeat` → the original jump/defeat shortcuts
 *
 * Every promo entry declares the editorial `categories` it evidences, so the
 * catalogue as a whole covers all four `EDITORIAL_CONFIG.categories`
 * (`weapons`, `pickups`, `enemies`, `boss`). The catalogue invariants (count,
 * category coverage, hook-first ordering, registry ↔ resolver and registry ↔
 * promo-level parity) are pinned by `scripts/capture-scenarios.test.ts`.
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
 * The promo catalogue comes first, opening with the high-intensity hook
 * (AH-0MVSDMBU60018JOE, parent AC3): each entry names the bot-tuning `preset`
 * it flies, the `promoLevel` it plays (a level id in
 * `scripts/promo-scenarios.mjs`) and the editorial `categories` the scene was
 * authored to evidence. Every entry also declares a fixed `seed`, so a promo
 * capture is reproducible (the same seed replays the same spawns).
 *
 * The three original shortcuts follow: `boss` is the tunable jump
 * (`&bossHits=N`); `boss-four-hits` is the recorded default (4 hits);
 * `defeat` ends the run in defeat on release. This list is an implementation
 * detail — {@link CAPTURE_SCENARIOS} is the validated, frozen registry every
 * consumer reads.
 *
 * @type {readonly CaptureScenario[]}
 */
const AUTHORED_SCENARIOS = [
  {
    name: 'promo-blitz-hook',
    effect: 'Open on a dense fleet and a wide swarm sweep: the high-intensity hook.',
    kind: 'promo',
    preset: 'relentless-hunter',
    promoLevel: 'promo-blitz-hook',
    categories: ['weapons', 'enemies'],
    seed: 1001,
  },
  {
    name: 'promo-swarm-saturation',
    effect: 'Saturate the screen with swarm walls for maximal shots and drops.',
    kind: 'promo',
    preset: 'cautious-collector',
    promoLevel: 'promo-swarm-saturation',
    categories: ['weapons', 'pickups'],
    seed: 1002,
  },
  {
    name: 'promo-tank-wall',
    effect: 'Grind through heavy tank phalanxes and chase the drops they leave.',
    kind: 'promo',
    preset: 'glass-cannon',
    promoLevel: 'promo-tank-wall',
    categories: ['weapons', 'pickups'],
    seed: 1003,
  },
  {
    name: 'promo-march-columns',
    effect: 'Hold the line against reversing Space-Invaders march columns.',
    kind: 'promo',
    preset: 'aggressive-hunter',
    promoLevel: 'promo-march-columns',
    categories: ['enemies', 'weapons'],
    seed: 1004,
  },
  {
    name: 'promo-centipede-tunnel',
    effect: 'Thread the centipede chain as it winds through a scout screen.',
    kind: 'promo',
    preset: 'evasive',
    promoLevel: 'promo-centipede-tunnel',
    categories: ['enemies'],
    seed: 1005,
  },
  {
    name: 'promo-ghost-hunt',
    effect: 'Outrun Pac-Man pursuers hunting between non-targeting escorts.',
    kind: 'promo',
    preset: 'evasive',
    promoLevel: 'promo-ghost-hunt',
    categories: ['enemies'],
    seed: 1006,
  },
  {
    name: 'promo-horde-siege',
    effect: 'Survive the homing-horde rush pouring in from the arena edges.',
    kind: 'promo',
    preset: 'aggressive-hunter',
    promoLevel: 'promo-horde-siege',
    categories: ['enemies', 'weapons'],
    seed: 1007,
  },
  {
    name: 'promo-lane-runner',
    effect: 'Weave lane traffic while farming the fleet for drops.',
    kind: 'promo',
    preset: 'cautious-collector',
    promoLevel: 'promo-lane-runner',
    categories: ['enemies', 'pickups'],
    seed: 1008,
  },
  {
    name: 'promo-orbital-barrage',
    effect: 'Crossfire of orbital phasers and telegraphed strike arcs.',
    kind: 'promo',
    preset: 'barrage-dodger',
    promoLevel: 'promo-orbital-barrage',
    categories: ['weapons', 'enemies'],
    seed: 1009,
  },
  {
    name: 'promo-capture-cordon',
    effect: 'Break a tractor-pull and attack-run cordon with a hard silhouette.',
    kind: 'promo',
    preset: 'cordon-breaker',
    promoLevel: 'promo-capture-cordon',
    categories: ['enemies'],
    seed: 1010,
  },
  {
    name: 'promo-boss-prelude',
    effect: 'Pressure waves into a mini-boss cordon: the boss-category footage.',
    kind: 'promo',
    preset: 'glass-cannon',
    promoLevel: 'promo-boss-prelude',
    categories: ['boss', 'enemies'],
    seed: 1011,
  },
  {
    name: 'promo-final-gauntlet',
    effect: 'Every showcase at once, closing on a double-raider mini-boss.',
    kind: 'promo',
    preset: 'gauntlet-runner',
    promoLevel: 'promo-final-gauntlet',
    categories: ['weapons', 'pickups', 'enemies', 'boss'],
    seed: 1012,
  },
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

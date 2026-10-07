/**
 * Deterministic pseudo-random number generation for gameplay runs
 * (AH-0MUY08V6W001SJJN).
 *
 * A run is reproducible when **every** gameplay RNG draw comes from a
 * single seeded stream. This module owns that stream: the game's
 * `PlayScene` seeds one generator per run and threads it to every gameplay
 * subsystem (wave spawning, enemy behaviour, asteroid timing, mineral
 * drops, power-up rolls, random AOE), replacing ad-hoc `Math.random()`
 * calls that made two runs of the same scenario diverge.
 *
 * ## Seed sources
 *
 * `Math.random()` (and wall-clock time) are *not* gameplay randomness here:
 * they are only the **entropy source for a fresh run seed** — see
 * {@link randomSeed}. Once a seed exists, every gameplay decision is a pure
 * function of that seed and the player's inputs, so the same seed replays
 * identically. Callers that need determinism (tests, headless bot runs,
 * same-seed evaluation) inject an explicit seed instead.
 *
 * @module src/core/rng
 */

/**
 * Normalises an arbitrary number to a valid 32-bit unsigned seed.
 *
 * Seeds may arrive from scene-start data, config or a prior run's
 * telemetry; this keeps them in the `[0, 2^32)` range the generator
 * expects. `>>> 0` truncates the fractional part and wraps the sign.
 *
 * @param seed - Any finite number.
 * @returns A 32-bit unsigned integer.
 */
export function normaliseSeed(seed: number): number {
  return Number.isFinite(seed) ? seed >>> 0 : 0;
}

/**
 * Generates a fresh, unpredictable 32-bit run seed.
 *
 * This is the **only** gameplay-adjacent use of `Math.random()` that is
 * permitted: seeding a new run. It is called once per run (in
 * `PlayScene.create()`) when no explicit seed was supplied; every
 * subsequent draw comes from {@link createSeededRng}. Tests and headless
 * runners bypass it by injecting an explicit seed.
 *
 * @returns A 32-bit unsigned integer.
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * Creates a deterministic pseudo-random number generator (mulberry32)
 * seeded by `seed`.
 *
 * The returned function yields values in the half-open interval `[0, 1)`,
 * matching the `() => number` contract accepted throughout the gameplay
 * code. Two generators constructed with the same seed always produce the
 * same sequence — the property that makes a seeded run reproducible.
 *
 * @param seed - Any 32-bit integer (coerced to unsigned).
 * @returns A deterministic `() => number` RNG.
 */
export function createSeededRng(seed: number): () => number {
  let state = normaliseSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic scripted player for the automated gameplay capture spike
 * (AH-0MUWMFF3C002WOBK).
 *
 * ## Why a scripted bot (and not a heuristic AI)
 *
 * The capture spike only needs a *non-trivial* gameplay segment: the ship
 * auto-fires, so steering it across the wave is enough to produce live
 * combat, explosions and pickups. A fixed, wall-clock-relative key
 * sequence is:
 *
 * - **reproducible** — the same plan is generated on every run (the game
 *   itself is not yet fully deterministic; see the determinism note in
 *   `docs/dev/gameplay-capture.md`);
 * - **tiny** — no reach into Phaser internals, no scene hooks, so the
 *   capture tool stays entirely opt-in and outside the shipped bundle;
 * - **testable** — plan construction is a pure function, unit-tested in
 *   `scripts/capture-gameplay.test.ts`.
 *
 * The plan is executed by `scripts/capture-gameplay.mjs`, which replays
 * each step as a real keydown/keyup pair through Playwright (trusted
 * browser input), while the canvas is recorded via
 * `canvas.captureStream(60)` → `MediaRecorder`.
 *
 * This module is plain ESM JavaScript so it can run under the project's
 * Node runtime without a TypeScript loader; `capture-bot.d.mts` supplies
 * the types used by the test suite.
 */

/** The four movement keys the bot uses (the ship auto-fires). */
export const MOVE_KEYS = Object.freeze([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

/** Default clip length in milliseconds (~15 s of gameplay). */
export const DEFAULT_CAPTURE_DURATION_MS = 15_000;

/** Default pause after pressing Enter, before recording, for PlayScene to settle. */
export const DEFAULT_WARMUP_MS = 2_000;

/**
 * A deterministic "sweep" figure: traverse the playfield left↔right with
 * small vertical bobs so the auto-fire tracks across wave formations and
 * the ship survives long enough to show explosions and pickups.
 *
 * Each entry holds one direction for `holdMs`; the ship's acceleration
 * model means short holds produce visible motion without hitting the walls.
 */
export const BASE_SWEEP_PATTERN = Object.freeze([
  { key: 'ArrowLeft', holdMs: 900 },
  { key: 'ArrowUp', holdMs: 250 },
  { key: 'ArrowRight', holdMs: 900 },
  { key: 'ArrowDown', holdMs: 250 },
  { key: 'ArrowLeft', holdMs: 700 },
  { key: 'ArrowDown', holdMs: 250 },
  { key: 'ArrowRight', holdMs: 700 },
  { key: 'ArrowUp', holdMs: 250 },
]);

/**
 * Builds a deterministic input plan that runs for approximately
 * `durationMs`: the base pattern is repeated (truncating the final step)
 * until the requested duration is covered.
 *
 * @param {number} [durationMs] — total hold time, in milliseconds.
 * @param {ReadonlyArray<{ key: string, holdMs: number }>} [pattern] — base pattern.
 * @returns {Array<{ key: string, holdMs: number }>} ordered plan.
 */
export function buildScriptedPlan(
  durationMs = DEFAULT_CAPTURE_DURATION_MS,
  pattern = BASE_SWEEP_PATTERN,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  if (!Array.isArray(pattern) || pattern.length === 0) return [];

  const plan = [];
  let remaining = Math.round(durationMs);
  let index = 0;

  while (remaining > 0) {
    const step = pattern[index % pattern.length];
    const holdMs = Math.min(step.holdMs, remaining);
    plan.push({ key: step.key, holdMs });
    remaining -= holdMs;
    index += 1;
  }

  return plan;
}

/**
 * Total hold time of a plan, in milliseconds.
 *
 * @param {ReadonlyArray<{ holdMs: number }>} plan
 * @returns {number}
 */
export function planDurationMs(plan) {
  return plan.reduce((total, step) => total + step.holdMs, 0);
}

/**
 * Decides whether a recorded clip is "non-trivial" enough for the spike's
 * acceptance criteria: it must be a decodable, non-black, moving image.
 *
 * This is a pure predicate over the in-browser probe stats produced by
 * `scripts/capture-gameplay.mjs`, so it can be unit-tested without a
 * browser. Thresholds are deliberately loose — the acceptance criterion is
 * "actual gameplay/VFX, not a black or static frame" — while still
 * rejecting an empty recording, a blank canvas and a frozen frame.
 *
 * @param {{ bytes?: number, width?: number, height?: number, nonBlackFraction?: number, uniqueColours?: number, motion?: number }} probe
 * @returns {{ nonTrivial: boolean, reasons: string[] }}
 */
export function isNonTrivialClip(probe) {
  const reasons = [];
  const bytes = Number(probe?.bytes ?? 0);
  const width = Number(probe?.width ?? 0);
  const height = Number(probe?.height ?? 0);
  const nonBlackFraction = Number(probe?.nonBlackFraction ?? 0);
  const uniqueColours = Number(probe?.uniqueColours ?? 0);
  const motion = Number(probe?.motion ?? 0);

  if (bytes <= 0) reasons.push('empty recording (0 bytes)');
  if (width <= 0 || height <= 0) reasons.push('no decodable video frames');
  if (nonBlackFraction < 0.002) reasons.push('frame is essentially black');
  if (uniqueColours < 8) reasons.push('too few distinct colours (static/black)');
  if (motion < 0.0005) reasons.push('sampled frames are static (no motion)');

  return { nonTrivial: reasons.length === 0, reasons };
}

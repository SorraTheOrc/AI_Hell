/**
 * Pure Euclidean rhythm module (AH-0MVYA1VHT004L2O0): Bjorklund pattern
 * generation plus the lattice-grid helpers that turn a pattern into exact
 * tick times, for the epic's Euclidean weapon cadence
 * (AH-0MVYA1JFK003RLAW).
 *
 * A **Euclidean rhythm** `E(k, n)` spreads `k` onsets as evenly as possible
 * over a repeating tile of `n` steps. {@link euclidPattern} generates it with
 * **Bjorklund's algorithm** (Toussaint, *The Euclidean Algorithm Generates
 * Traditional Musical Rhythms*, 2004), which yields the **maximally even**
 * onset set: every cyclic gap is `floor(n / k)` or `ceil(n / k)` steps. The
 * rhythm is deliberately irregular — `E(5, 8)` mixes 1- and 2-step gaps — but
 * never lopsided.
 *
 * ## What this module owns
 *
 * Only **pure pattern and grid maths**, with no weapon, scene or audio state.
 * `src/utils/weaponLevels.ts` owns the per-weapon `(k, n, rotation)` ladder
 * (`WEAPON_EUCLIDEAN_LADDERS` / `resolveWeaponPattern`), and the fire
 * scheduler (AH-0MVYA1V8Z009SHMR) consumes the helpers below to decide
 * **when** an onset is due. Patterns are pure data — no `Date`, no
 * `Math.random`, no hidden state — so a seeded replay is unaffected.
 *
 * ## The shared lattice (no duplicated maths)
 *
 * Every time value here is an exact tick of the grid defined by
 * `src/utils/beat.ts`: ticks are `anchorMs + i × stepMs` for integer `i`.
 * {@link euclidStepMs} derives `stepMs` from `beatSubdivisionMs`, i.e. the
 * shared **16th-note lattice** — 187.5 ms at the default 80 BPM, one step per
 * 16th note, sixteen steps per bar. Step indexing delegates to `shotTimeFor`,
 * tick rounding to `nextTick` and tick exactness to `isOnGrid`, so there is
 * no second lattice implementation to drift.
 *
 * ## Rotation convention
 *
 * {@link euclidPattern} roots its output at step 0 (Bjorklund's onset set
 * rotated so the first onset sits on step 0), and `rotation` then shifts the
 * whole set by that many steps (`mod n`; negative rotations are allowed).
 * Published spellings sometimes choose a different rotation of the same
 * rhythm class — the literature's `E(5, 8) = x.xx.x.x` is the shipped
 * `x.xx.xx.` rotated by five steps — so canonical examples are compared **up
 * to rotation** (`src/utils/euclid.test.ts`).
 *
 * The tile repeats forever: step index `i` of the pattern is
 * `((i mod n) + n) mod n`, so `E(3, 8)` fires on steps 0, 3 and 6 of every
 * eight-step block, across bars and scene restarts.
 */

import {
  DEFAULT_BPM,
  SIXTEENTH_NOTE_SUBDIVISIONS,
  beatSubdivisionMs,
  isOnGrid,
  nextTick,
  shotTimeFor,
} from './beat';

/**
 * Subdivisions per beat of the Euclidean lattice: one **16th note**
 * (`4` per beat), re-exported from `src/utils/beat.ts` so the pattern grid
 * and the beat grid are the same lattice by construction.
 */
export const EUCLID_STEP_SUBDIVISIONS = SIXTEENTH_NOTE_SUBDIVISIONS;

/**
 * A resolved **Euclidean rhythm**: `k` onsets over a repeating tile of `n`
 * steps, phase-shifted by `rotation` steps, with the onset step indices
 * precomputed.
 *
 * `k`, `n` and `rotation` are the **effective** (normalised) inputs — `k` is
 * clamped to `[0, n]`, `n` to at least 1 and `rotation` into `[0, n)` — so a
 * pattern is always well formed. `onsets` holds the distinct onset steps in
 * ascending order inside `[0, n)`; a rotation therefore never reorders the
 * rhythm, only moves where it starts.
 */
export interface EuclidPattern {
  /** Effective onsets per tile (`0 <= k <= n`). */
  readonly k: number;
  /** Steps per tile (`n >= 1`). */
  readonly n: number;
  /** Effective phase shift in steps (`0 <= rotation < n`). */
  readonly rotation: number;
  /** Onset step indices inside the tile, strictly ascending. */
  readonly onsets: readonly number[];
}

// ── Internals ───────────────────────────────────────────────────────

/** True when `stepMs` can serve as a lattice step. */
function isUsableStepMs(stepMs: number): boolean {
  return Number.isFinite(stepMs) && stepMs > 0;
}

/** True when a pattern is usable for grid maths (well-formed, non-empty). */
function isValidPattern(pattern: EuclidPattern): boolean {
  return (
    Number.isInteger(pattern.n) &&
    pattern.n >= 1 &&
    pattern.onsets.length > 0
  );
}

/** Wraps a (possibly negative) step index into `[0, steps)`. */
function stepPhase(step: number, steps: number): number {
  return ((step % steps) + steps) % steps;
}

/**
 * Bjorklund's algorithm: the maximally even onset steps of `pulses` onsets
 * over `steps` steps, in Bjorklund's own (unnormalised) rotation order.
 *
 * The nested `counts`/`remainders` levels are Toussaint's formulation of
 * Euclid's algorithm; `build` walks them depth-first, appending a rest (`0`)
 * for the short level and an onset (`1`) for the paired level. Reading the
 * flags off in step order gives the onset positions.
 */
function bjorklundOnsets(pulses: number, steps: number): number[] {
  if (pulses <= 0) return [];
  if (pulses >= steps) {
    return Array.from({ length: steps }, (_, step) => step);
  }

  const counts: number[] = [];
  const remainders: number[] = [pulses];
  let divisor = steps - pulses;
  let level = 0;
  for (;;) {
    counts.push(Math.floor(divisor / remainders[level]));
    remainders.push(divisor % remainders[level]);
    divisor = remainders[level];
    level += 1;
    if (remainders[level] <= 1) break;
  }
  counts.push(divisor);

  const flags: number[] = [];
  const build = (depth: number): void => {
    if (depth === -1) {
      flags.push(0);
      return;
    }
    if (depth === -2) {
      flags.push(1);
      return;
    }
    for (let index = 0; index < counts[depth]; index += 1) {
      build(depth - 1);
    }
    if (remainders[depth] !== 0) build(depth - 2);
  };
  build(level);

  const onsets: number[] = [];
  for (let step = 0; step < flags.length; step += 1) {
    if (flags[step] === 1) onsets.push(step);
  }
  return onsets;
}

/**
 * Rotates an ascending onset set so its first onset lands on step 0 (the
 * documented root convention). Bjorklund's output is ascending, so shifting
 * by the first onset keeps the result ascending.
 */
function rootOnsetsAtZero(onsets: readonly number[], steps: number): number[] {
  if (onsets.length === 0) return [];
  const shift = onsets[0];
  return onsets.map((onset) => stepPhase(onset - shift, steps));
}

// ── Pattern generation ──────────────────────────────────────────────

/**
 * Milliseconds per Euclidean step — the shared **16th-note lattice** at
 * `bpm`, derived from `beatSubdivisionMs` in `src/utils/beat.ts` (187.5 ms at
 * the default 80 BPM; a quarter of the beat for any tempo).
 *
 * An invalid `bpm` falls back to `DEFAULT_BPM`, mirroring `beat.ts`.
 *
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns Step duration in milliseconds.
 */
export function euclidStepMs(bpm: number = DEFAULT_BPM): number {
  return beatSubdivisionMs(EUCLID_STEP_SUBDIVISIONS, bpm);
}

/**
 * Generates the maximally even Euclidean rhythm `E(k, n)` with `rotation`
 * applied: `k` onsets distributed as evenly as possible over a repeating tile
 * of `n` lattice steps, shifted by `rotation` steps.
 *
 * Canonical fixtures (the shipped root starts on step 0):
 * - `E(3, 8)` → `x..x..x.` (3-3-2 step gaps)
 * - `E(5, 8)` → `x.xx.xx.` — the literature's `x.xx.x.x` rotated by 5
 * - `E(2, 5)` → `x.x..` (2-3 step gaps)
 *
 * Edge cases (all documented by tests):
 * - `k = 0` is the empty rhythm (no onsets).
 * - `k = n` is every step; `k > n` clamps to `n`.
 * - `n = 1` is a single-step tile (`k = 1` → one onset at step 0).
 * - Fractional inputs truncate to whole steps; invalid `k`/`n`
 *   (non-finite, negative, `n < 1`) degrade to an empty single-step rhythm.
 * - `rotation` is truncated and normalised into `[0, n)`, so `-1` is the last
 *   step (`n - 1`) and `n` is `0`.
 *
 * Pure and deterministic: the same arguments always produce the same onsets,
 * with no RNG and no wall-clock read.
 *
 * @param k - Desired onsets per tile (clamped to `[0, n]`).
 * @param n - Steps per tile (at least 1).
 * @param rotation - Phase shift in steps (default 0; applied `mod n`).
 * @returns The resolved pattern, including its ascending onset steps.
 */
export function euclidPattern(
  k: number,
  n: number,
  rotation = 0,
): EuclidPattern {
  // An unusable step count (non-finite, zero or negative) has no lattice, so
  // it degrades to an empty single-step tile rather than inventing onsets.
  const usableSteps = Number.isFinite(n) && Math.trunc(n) >= 1;
  const steps = usableSteps ? Math.trunc(n) : 1;
  const pulses =
    usableSteps && Number.isFinite(k)
      ? Math.min(steps, Math.max(0, Math.trunc(k)))
      : 0;
  const phase = Number.isFinite(rotation)
    ? stepPhase(Math.trunc(rotation), steps)
    : 0;

  const root = rootOnsetsAtZero(bjorklundOnsets(pulses, steps), steps);
  const onsets =
    phase === 0
      ? root
      : root
          .map((onset) => stepPhase(onset + phase, steps))
          .sort((a, b) => a - b);

  return { k: pulses, n: steps, rotation: phase, onsets };
}

// ── Grid helpers (shared lattice) ───────────────────────────────────

/**
 * The lattice step that contains `timeMs`: the index `i` of the step whose
 * tick is at or before the time, so `stepIndexAt(tick) = i` for an exact tick.
 *
 * Indexing is delegated to `shotTimeFor` (`src/utils/beat.ts`), so a time a
 * hair off a tick is attributed to that tick rather than the previous one,
 * matching how `beat.ts` attributes a shot to a beat. Steps before
 * `anchorMs` have negative indices, which wrap correctly through `mod n` when
 * matched against a pattern.
 *
 * An unusable `stepMs` (non-finite, zero or negative) disables the lattice
 * and returns `0`, mirroring `beat.ts`'s fail-safe quantisation behaviour.
 *
 * @param timeMs - Game time in milliseconds.
 * @param stepMs - Lattice step in milliseconds (e.g. `euclidStepMs()`).
 * @param anchorMs - Lattice origin in milliseconds (default 0).
 * @returns The step index containing `timeMs`.
 */
export function stepIndexAt(
  timeMs: number,
  stepMs: number,
  anchorMs = 0,
): number {
  if (!isUsableStepMs(stepMs)) return 0;
  const tick = shotTimeFor(timeMs, stepMs, anchorMs);
  return Math.round((tick - anchorMs) / stepMs);
}

/**
 * True when `timeMs` is an onset tick of `pattern`: the time lies on the
 * lattice (`isOnGrid`, so accumulated frame drift of up to the grid epsilon
 * still counts) **and** its step is one of the pattern's onsets.
 *
 * The tile repeats, so onset steps recur every `n` steps. Scheduling should
 * use {@link nextOnsetTick} / {@link nextOnsetDelayMs} rather than polling
 * this predicate, which is the "which step is this?" attribution question —
 * the counterpart of `shotTimeFor` in `beat.ts`.
 *
 * An unusable `stepMs`, an empty pattern or a malformed pattern is never an
 * onset.
 *
 * @param timeMs - Game time in milliseconds.
 * @param pattern - The pattern to test (from {@link euclidPattern}).
 * @param stepMs - Lattice step in milliseconds.
 * @param anchorMs - Lattice origin in milliseconds (default 0).
 * @returns True when the time is one of the pattern's onset ticks.
 */
export function isOnset(
  timeMs: number,
  pattern: EuclidPattern,
  stepMs: number,
  anchorMs = 0,
): boolean {
  if (!isUsableStepMs(stepMs) || !isValidPattern(pattern)) return false;
  if (!isOnGrid(timeMs, stepMs, anchorMs)) return false;
  return pattern.onsets.includes(
    stepPhase(stepIndexAt(timeMs, stepMs, anchorMs), pattern.n),
  );
}

/**
 * The next onset tick of `pattern` at or after `timeMs` — the scheduling
 * primitive for a Euclidean cadence.
 *
 * The search starts from the first lattice tick at/after `timeMs`
 * (`nextTick`, so an exact onset tick returns itself, delay 0) and walks
 * forward step by step until it reaches an onset, wrapping into the next tile
 * when necessary (at most `n` steps). Every returned time is an exact tick
 * `anchorMs + i × stepMs`, which is "at or after" rather than strictly after,
 * matching `beat.ts`'s `nextTick` contract.
 *
 * Fail-safes:
 * - An empty pattern has no next onset → `Number.POSITIVE_INFINITY` (a
 *   scheduler that stores the next onset therefore never fires, rather than
 *   firing on a `NaN` comparison).
 * - An unusable `stepMs` disables the lattice and returns `timeMs` unchanged,
 *   so the delay is 0 and time never runs backwards.
 *
 * @param timeMs - Game time in milliseconds.
 * @param pattern - The pattern to schedule (from {@link euclidPattern}).
 * @param stepMs - Lattice step in milliseconds.
 * @param anchorMs - Lattice origin in milliseconds (default 0).
 * @returns The next onset tick at/after `timeMs` (`Infinity` when empty).
 */
export function nextOnsetTick(
  timeMs: number,
  pattern: EuclidPattern,
  stepMs: number,
  anchorMs = 0,
): number {
  if (!isUsableStepMs(stepMs)) return timeMs;
  if (!isValidPattern(pattern)) return Number.POSITIVE_INFINITY;

  const firstTick = nextTick(timeMs, stepMs, anchorMs);
  let index = Math.round((firstTick - anchorMs) / stepMs);
  for (let step = 0; step < pattern.n; step += 1) {
    if (pattern.onsets.includes(stepPhase(index, pattern.n))) {
      return anchorMs + index * stepMs;
    }
    index += 1;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Milliseconds from `timeMs` to the next onset tick of `pattern` — always
 * `>= 0` and, for a non-empty pattern, less than one tile (`n × stepMs`).
 *
 * `0` means an onset is due now (the time is already an onset tick, or the
 * lattice is disabled by an unusable `stepMs`). An empty pattern returns
 * `Number.POSITIVE_INFINITY`, which is never due.
 *
 * @param timeMs - Game time in milliseconds.
 * @param pattern - The pattern to schedule (from {@link euclidPattern}).
 * @param stepMs - Lattice step in milliseconds.
 * @param anchorMs - Lattice origin in milliseconds (default 0).
 * @returns Milliseconds until the next onset (`>= 0`).
 */
export function nextOnsetDelayMs(
  timeMs: number,
  pattern: EuclidPattern,
  stepMs: number,
  anchorMs = 0,
): number {
  return Math.max(
    0,
    nextOnsetTick(timeMs, pattern, stepMs, anchorMs) - timeMs,
  );
}

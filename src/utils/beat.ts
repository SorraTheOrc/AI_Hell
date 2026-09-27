/**
 * Pure, configurable beat-clock module (AH-0MUAYB8EH005RJ8B).
 *
 * Player auto-fire is locked to a single musical grid: every shot lands on
 * a tick of an **80 BPM** beat (by default), and every weapon's fire
 * interval is an exact subdivision of that beat. This module is the single
 * source of truth for the grid math — BPM → beat period, quantisation to
 * the next/previous grid tick, and on-grid checks.
 *
 * The beat is a **silent internal scheduling contract**: there is no audio
 * metronome and no visual indicator (GDD §7.3 keeps music out of MVP scope).
 * It is observable only through bullet cadence and tests.
 *
 * Everything here is **pure and deterministic given an input time** — no
 * `Date`, no frame coupling, no hidden state. `createBeatClock` is a thin,
 * opt-in convenience wrapper that accumulates game time (so a scene can
 * share one clock) but remains deterministic: given the same sequence of
 * `advance()` deltas it always produces the same ticks. It never reads the
 * wall clock, so it pauses naturally with the game (a paused scene simply
 * stops calling `advance`).
 *
 * Anchoring: grid ticks are `anchorMs + k × intervalMs` for integer `k`.
 * The anchor defaults to `0` (scene/player start) and is configurable.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Milliseconds in one minute — the basis for BPM → period conversion. */
export const MS_PER_MINUTE = 60_000;

/** Default tempo in beats per minute (producer decision, AH-0MUAYB8EH005RJ8B). */
export const DEFAULT_BPM = 80;

/**
 * Tolerance (ms) used by {@link isOnGrid} to absorb floating-point drift
 * accumulated across frames. Grid ticks are computed from game time, which
 * is a sum of potentially non-integer frame deltas, so an exact `=== 0`
 * remainder check is not reliable.
 */
const GRID_EPSILON = 1e-6;

// ── Internals ───────────────────────────────────────────────────────

/** Returns true when `value` is a finite number (usable as a time/rate). */
function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * If `timeMs` is within {@link GRID_EPSILON} of a grid tick, returns that
 * tick exactly (absorbing floating-point drift); otherwise returns `null`
 * so the caller can round up/down as required.
 */
function snapToNearestTick(
  timeMs: number,
  intervalMs: number,
  anchorMs: number,
): number | null {
  const nearestTick =
    anchorMs + Math.round((timeMs - anchorMs) / intervalMs) * intervalMs;
  return Math.abs(timeMs - nearestTick) <= GRID_EPSILON ? nearestTick : null;
}

// ── Tempo → period ──────────────────────────────────────────────────

/**
 * Converts a tempo in beats per minute to the beat period in milliseconds:
 * `60_000 / bpm`. The default of {@link DEFAULT_BPM} (80 BPM) yields the
 * canonical **750 ms** beat.
 *
 * An invalid BPM (non-finite, zero or negative) falls back to
 * {@link DEFAULT_BPM} so a corrupt config cannot produce a zero/negative
 * interval.
 *
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns Beat period in milliseconds.
 */
export function beatPeriodMs(bpm: number = DEFAULT_BPM): number {
  const safeBpm = isUsableNumber(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  return MS_PER_MINUTE / safeBpm;
}

/**
 * Returns the period of a subdivision of the beat: `beatPeriodMs(bpm) /
 * subdivisions`. A subdivision is how many times a weapon fires per beat
 * (cannon 2, spread/dual 1, rapid 6), so this yields each weapon's fire
 * interval in milliseconds.
 *
 * An invalid (non-finite, zero or negative) subdivision count falls back to
 * 1 (one shot per beat), and an invalid BPM falls back to the default.
 *
 * @param subdivisions - Shots per beat (positive integer).
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns Subdivision period in milliseconds.
 */
export function beatSubdivisionMs(
  subdivisions: number,
  bpm: number = DEFAULT_BPM,
): number {
  const safeSubdivisions =
    isUsableNumber(subdivisions) && subdivisions > 0 ? subdivisions : 1;
  return beatPeriodMs(bpm) / safeSubdivisions;
}

// ── Quantisation ────────────────────────────────────────────────────

/**
 * Rounds an arbitrary elapsed time **up** to the next grid tick for
 * `intervalMs`: the smallest multiple of `intervalMs` (relative to
 * `anchorMs`) that is **at or after** `elapsedTime`.
 *
 * This is the scheduling primitive for auto-fire: a weapon's next shot
 * time is `nextTick(currentTime, interval)`, so a weapon collected mid-beat
 * fires on the next grid tick instead of drifting.
 *
 * Edge cases:
 * - A time already exactly on a tick is returned unchanged (`at/after`).
 * - A non-positive/non-finite `intervalMs` disables quantisation and the
 *   input time is returned unchanged.
 * - A tiny epsilon snaps a time that is (almost) exactly a tick to that
 *   tick, so accumulated frame deltas cannot skip or double-fire a tick.
 *
 * @param elapsedTime - Arbitrary elapsed/game time in ms.
 * @param intervalMs - Grid interval in ms (e.g. a weapon's fire rate).
 * @param anchorMs - Grid origin in ms (default 0 = scene/player start).
 * @returns The smallest grid tick `>= elapsedTime`.
 */
export function nextTick(
  elapsedTime: number,
  intervalMs: number,
  anchorMs = 0,
): number {
  if (!isUsableNumber(intervalMs) || intervalMs <= 0) {
    return elapsedTime;
  }
  const snapped = snapToNearestTick(elapsedTime, intervalMs, anchorMs);
  if (snapped !== null) return snapped;
  const offset = (elapsedTime - anchorMs) / intervalMs;
  return anchorMs + Math.ceil(offset) * intervalMs;
}

/**
 * Rounds an arbitrary time **down** to the grid tick at or before it: the
 * beat time a shot emitted at `currentTime` is attributed to. Whereas
 * {@link nextTick} answers "when is the next shot due?", `shotTimeFor`
 * answers "which beat did the shot just fire on?" — so both a shot's
 * schedule and its recorded time are exact grid ticks.
 *
 * A time already exactly on a tick is returned unchanged. A
 * non-positive/non-finite `intervalMs` disables quantisation and the input
 * time is returned unchanged.
 *
 * @param currentTime - The current time in ms.
 * @param intervalMs - Grid interval in ms (e.g. a weapon's fire rate).
 * @param anchorMs - Grid origin in ms (default 0 = scene/player start).
 * @returns The largest grid tick `<= currentTime`.
 */
export function shotTimeFor(
  currentTime: number,
  intervalMs: number,
  anchorMs = 0,
): number {
  if (!isUsableNumber(intervalMs) || intervalMs <= 0) {
    return currentTime;
  }
  const snapped = snapToNearestTick(currentTime, intervalMs, anchorMs);
  if (snapped !== null) return snapped;
  const offset = (currentTime - anchorMs) / intervalMs;
  return anchorMs + Math.floor(offset) * intervalMs;
}

/**
 * Returns true when `timeMs` lies on the grid for `intervalMs` (relative to
 * `anchorMs`), within {@link GRID_EPSILON} of a tick. Used by tests to
 * assert that emitted shots are exact grid ticks.
 *
 * @param timeMs - The time to test in ms.
 * @param intervalMs - Grid interval in ms.
 * @param anchorMs - Grid origin in ms (default 0 = scene/player start).
 * @returns True when `timeMs` is (approximately) a grid tick.
 */
export function isOnGrid(
  timeMs: number,
  intervalMs: number,
  anchorMs = 0,
): boolean {
  if (!isUsableNumber(intervalMs) || intervalMs <= 0) {
    return false;
  }
  const ticks = Math.round((timeMs - anchorMs) / intervalMs);
  const nearest = anchorMs + ticks * intervalMs;
  return Math.abs(timeMs - nearest) <= GRID_EPSILON;
}

// ── Shared beat-clock instance ──────────────────────────────────────

/** Configuration for {@link createBeatClock}. */
export interface BeatClockConfig {
  /** Tempo in beats per minute (default {@link DEFAULT_BPM}). */
  bpm?: number;
  /** Grid origin in ms (default 0 = scene/player start). */
  anchorMs?: number;
}

/**
 * A shared, scene-level beat clock: configurable tempo + anchor, game time
 * that advances with `advance(dt)`, and quantisation helpers bound to the
 * current time and anchor.
 *
 * Scenes create **one** clock and share it (game + gyms), so every player
 * shot is phase-locked to the same grid. The clock is deterministic — it
 * stores only accumulated elapsed time and never reads the wall clock.
 */
export interface BeatClock {
  /** Configured tempo in beats per minute. */
  readonly bpm: number;
  /** Grid origin in ms. */
  readonly anchorMs: number;
  /** Beat period in milliseconds (`beatPeriodMs(bpm)`). */
  readonly periodMs: number;
  /** Elapsed game time in ms since the clock was created (starts at 0). */
  now(): number;
  /**
   * Advances the clock by `dtMs` milliseconds; a non-positive/non-finite
   * delta is ignored so time never runs backwards. Returns the new elapsed
   * time.
   */
  advance(dtMs: number): number;
  /** Smallest grid tick at/after the current time for `intervalMs`. */
  nextTick(intervalMs: number): number;
  /** Grid tick at/before the current time — the beat time of a shot due now. */
  shotTimeFor(intervalMs: number): number;
  /** True when `timeMs` is an exact grid tick for `intervalMs`. */
  isOnGrid(timeMs: number, intervalMs: number): boolean;
}

/**
 * Creates a shared beat clock with configurable tempo and anchor (both
 * defaulting to the 80 BPM / scene-start grid). Invalid values fall back to
 * the defaults.
 *
 * @param config - Optional `{ bpm, anchorMs }` overrides.
 * @returns A new {@link BeatClock} starting at elapsed time 0.
 */
export function createBeatClock(config: BeatClockConfig = {}): BeatClock {
  const bpm =
    isUsableNumber(config.bpm) && config.bpm > 0 ? config.bpm : DEFAULT_BPM;
  const anchorMs = isUsableNumber(config.anchorMs) ? config.anchorMs : 0;
  let elapsedMs = 0;

  return {
    bpm,
    anchorMs,
    periodMs: beatPeriodMs(bpm),
    now: () => elapsedMs,
    advance(dtMs: number): number {
      if (isUsableNumber(dtMs) && dtMs > 0) {
        elapsedMs += dtMs;
      }
      return elapsedMs;
    },
    nextTick: (intervalMs: number) =>
      nextTick(elapsedMs, intervalMs, anchorMs),
    shotTimeFor: (intervalMs: number) =>
      shotTimeFor(elapsedMs, intervalMs, anchorMs),
    isOnGrid: (timeMs: number, intervalMs: number) =>
      isOnGrid(timeMs, intervalMs, anchorMs),
  };
}

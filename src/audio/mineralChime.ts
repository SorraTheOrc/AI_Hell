/**
 * Pure pitch-escalation state machine for mineral pickups (AH-0MWNMRCEW006N0EH).
 *
 * A Phaser-free module that owns the streak counter, the game-clock gap check
 * and the reset seam.  Callers pass the game time in, so tests drive time
 * deterministically and a paused scene cannot expire a streak mid-run.
 *
 * ## Why an A-minor scale
 *
 * The ladder is the A-minor diatonic scale rather than a mechanical semitone
 * step: every pickup climbs one **scale degree**, so any prefix of a streak is
 * a consonant interval (root, major second, minor third, perfect fourth,
 * perfect fifth …) and a fast cluster of pickups sounds musical instead of
 * detuned.  The ladder names the scale degrees, so retuning the chime is a
 * one-line change here and nowhere else.
 *
 * ## Why the cap is one octave
 *
 * A streak has to stay a reward, never a shrill noise.  The ladder stops at
 * the major seventh (10 semitones) — as high as the scale goes before the
 * octave repeat — so a long streak settles into a bright but controlled pitch
 * instead of climbing without bound.  The ceiling is therefore "one scale
 * degree per pickup, capped at one octave".
 *
 * ## Why the gap is game time
 *
 * {@link MINERAL_CHIME_RESET_GAP_MS} is measured on the **scene clock** (game
 * time), never wall time.  A paused scene freezes its clock, so pausing
 * mid-run can never expire a live streak: the player resumes and the climb
 * continues from where they left it.  A wall clock would silently reset the
 * streak during any pause, menu or tab stall.
 *
 * ## Why a dedicated cue, not the tinkle
 *
 * The shipped `aihell-mineral-tinkle` is the Mystery UFO **spill** cue: it
 * fires once when the drone's wreck scatters its dropped minerals. Reusing it
 * for a pickup would make a collection indistinguishable from a spill and
 * would stop the pickup being gain-staged on its own, so the chime is a
 * dedicated `aihell-mineral-chime` recipe at seed 32292
 * (AH-0MWNMRD6I002CCVT) — a steady A5 triangle with a quiet A6 shimmer and
 * no falling sweep or noise tick.
 *
 * ## Fill → step mapping
 *
 * {@link mineralChimeStepForFill} is the pure, Phaser-free rule the game and
 * every gym share when the hull-fill chime is enabled: the post-credit hold
 * state picks a ladder step with **fixed endpoints**.  The first mineral
 * (`store <= 1`) always sounds the base note and a full hold
 * (`store >= capacity`) always sounds the top note, so both stay learnable at
 * every capacity.  Interior fills spread linearly over the interior steps and
 * never fall as the hold grows; quantising onto the existing ladder keeps the
 * one-octave ceiling.  Degenerate inputs (`NaN`/non-finite, `capacity <= 1`,
 * negative store) clamp to a safe step instead of producing `NaN`.
 *
 * ## Rules
 *
 * 1. **Base step** — the first pickup (or the first pickup after a reset/gap)
 *    sounds step 0 (`1.0` playback rate).
 * 2. **Ladder advance** — each successive pickup inside the reset gap climbs
 *    exactly one step up {@link MINERAL_CHIME_SEMITONES}.
 * 3. **Octave clamp** — a long streak clamps at the last ladder degree; the
 *    playback rate never exceeds the octave ceiling.
 * 4. **Gap reset** — a gap of exactly {@link MINERAL_CHIME_RESET_GAP_MS} resets
 *    the streak to base; a gap 1 ms shorter does not.
 * 5. **Explicit reset** — {@link MineralChime.reset} /
 *    {@link resetMineralChimeStreak} return the streak to base.
 * 6. **Sequential independence** — isolated factory instances share no state
 *    with each other or with the shared singleton.
 * 7. **Fill endpoints** — {@link mineralChimeStepForFill} returns step 0 for
 *    the first mineral (`store <= 1`) and the last degree for a full hold
 *    (`store >= capacity`), at every capacity.
 * 8. **Fill interior** — interior fills quantise monotonically onto the
 *    interior ladder steps and never fall as the store grows.
 * 9. **Degenerate fill** — a non-finite or degenerate hold clamps to an
 *    in-range step, never `NaN`.
 *
 * Playback rates come from {@link mineralChimeRate}, the single place a ladder
 * step becomes `2 ** (semitones / 12)`.
 *
 * @module audio/mineralChime
 */

// ── Constants ─────────────────────────────────────────────────────────

/**
 * A-minor semitone ladder: one scale degree per pickup, capped at one octave.
 *
 * `[0, 2, 3, 5, 7, 8, 10]` — root, major second, minor third, perfect fourth,
 * perfect fifth, major sixth, major seventh (the A-minor diatonic scale up to
 * but not including the octave).  Tunable in one place only.
 */
export const MINERAL_CHIME_SEMITONES = [0, 2, 3, 5, 7, 8, 10] as const;

/**
 * Reset gap in milliseconds.  After a streak-free interval of this duration
 * (or longer), the next pickup resets to base pitch.
 *
 * Measured on **game time** (the scene clock), not wall clock, so a paused
 * scene cannot expire a streak mid-run.
 */
export const MINERAL_CHIME_RESET_GAP_MS = 1500;

// ── Rate helper ───────────────────────────────────────────────────────

/**
 * Playback rate for ladder `step`: `2^(semitones/12)` from
 * {@link MINERAL_CHIME_SEMITONES} (precedent: `countdownTickRate` in
 * `audio/effects.ts`).
 *
 * A negative or non-finite step clamps to the base degree (so a bad index can
 * never produce `undefined`/`NaN`); a step past the ladder clamps to the last
 * degree (the octave ceiling); a fractional step floors.
 *
 * @param step - 0-based ladder step.
 */
export function mineralChimeRate(step: number): number {
  const index = Number.isFinite(step)
    ? Math.min(Math.max(Math.floor(step), 0), MINERAL_CHIME_SEMITONES.length - 1)
    : 0;
  return 2 ** (MINERAL_CHIME_SEMITONES[index] / 12);
}

// ── Fill → step mapping ───────────────────────────────────────────────

/**
 * Ladder step for the post-credit hull-fill hold state.
 *
 * The **first mineral** (`store <= 1`) is the fixed base note (step 0) and a
 * **full hold** (`store >= capacity`) is the fixed top note (the last degree
 * of {@link MINERAL_CHIME_SEMITONES}), so both endpoints stay learnable as the
 * hull capacity grows.  Interior fills quantise linearly onto the interior
 * steps — `round((store - 1) / (capacity - 1) * last)` clamped into
 * `[0, last]` — and the mapping never falls as `store` grows within one
 * capacity.
 *
 * Degenerate inputs clamp to a safe step rather than `NaN`: a non-finite or
 * negative store is the base note (positive infinity is a full hold and is
 * the top note), and a degenerate capacity (`NaN`, or `capacity <= 1` with a
 * store above it) is the top note.  The function reads the **credited**
 * store, so a red deposit (`MINERAL_DEPOSIT_VALUE`) climbs the equivalent
 * number of steps in one pickup.
 *
 * No Phaser, no clock, no side effects — the game and every gym consume this
 * one rule.
 *
 * @param store - Mineral store after this pickup has been credited.
 * @param capacity - Current hull mineral capacity.
 */
export function mineralChimeStepForFill(
  store: number,
  capacity: number,
): number {
  const last = MINERAL_CHIME_SEMITONES.length - 1;

  // A non-finite store is degenerate: positive infinity is a full hold, every
  // other non-finite value (`NaN`, negative infinity) is no fill at all.
  if (!Number.isFinite(store)) {
    return store === Number.POSITIVE_INFINITY ? last : 0;
  }

  // The first mineral (and any negative store) is the fixed base note.
  if (store <= 1) {
    return 0;
  }

  // A full hold — including a degenerate `capacity <= 1` — is the fixed top
  // note.
  if (store >= capacity) {
    return last;
  }

  // A non-finite `capacity` cannot form a finite ratio; a huge capacity is
  // effectively an (almost) empty hold, so clamp to the base note.
  if (!Number.isFinite(capacity)) {
    return 0;
  }

  // Interior fills spread linearly over the interior steps and quantise onto
  // the ladder; the clamp keeps a rounding overshoot inside the endpoints.
  const step = Math.round(((store - 1) / (capacity - 1)) * last);
  return Math.min(Math.max(step, 0), last);
}

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Pitch-escalation state machine for mineral pickups.
 *
 * Call {@link MineralChime.noteMineralCollected} on every mineral pickup to
 * get the playback rate for that pickup.  Call {@link MineralChime.reset}
 * on run restart or scene teardown to return the streak to base.
 */
export interface MineralChime {
  /**
   * Called on every mineral pickup.
   *
   * Returns the playback rate for this pickup: `2^(semitones/12)` where
   * `semitones` is the ladder degree of this pickup, clamped to the ladder
   * length.
   *
   * @param nowMs - Current game time in milliseconds (from the injected clock).
   */
  noteMineralCollected(nowMs: number): number;

  /**
   * Reset the streak to base.  Call on run restart or scene teardown.
   *
   * After reset the next {@link noteMineralCollected} call returns the base
   * rate of `1.0` (0 semitones).
   */
  reset(): void;

  /**
   * The ladder step of the **most recent** pickup (0 = base degree), for
   * observability and tests.  Before any pickup it reports 0.
   */
  step(): number;
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Create an isolated mineral-chime state machine.
 *
 * The machine holds no clock of its own: every call passes the current
 * **game time** in milliseconds (the scene clock, not `Date.now()`), so a
 * paused scene cannot expire a streak mid-run and the machine stays pure.
 */
export function createMineralChime(): MineralChime {
  // Ladder degree of the most recent pickup; the next pickup reports this one
  // (advanced) or resets to base when the gap expired.
  let step = 0;
  // `null` until the first pickup (and after an explicit reset), so a first
  // pickup can never be read as the end of a streak.
  let lastPickupMs: number | null = null;

  return {
    noteMineralCollected(nowMs: number): number {
      if (lastPickupMs !== null) {
        // Gap reset: a gap of at least the reset interval restarts at base;
        // anything shorter continues the climb.
        if (nowMs - lastPickupMs >= MINERAL_CHIME_RESET_GAP_MS) {
          step = 0;
        } else {
          // One scale degree per pickup, capped at the ladder's last degree.
          step = Math.min(step + 1, MINERAL_CHIME_SEMITONES.length - 1);
        }
      }

      lastPickupMs = nowMs;

      return mineralChimeRate(step);
    },

    reset(): void {
      step = 0;
      lastPickupMs = null;
    },

    step(): number {
      return step;
    },
  };
}

// ── Shared singleton (game + every gym) ───────────────────────────────

/**
 * The shared mineral-chime state used by the single dispatch point in
 * `CombatCoreScene`, so the game and every gym climb the same streak.
 */
export const mineralChime = createMineralChime();

/**
 * Called on every **player** mineral pickup via the shared dispatch.
 *
 * Advances the shared streak (restarting it when the gap expired) and returns
 * the playback rate to play.
 *
 * @param nowMs - Current game time in milliseconds (the scene clock).
 */
export function noteMineralCollected(nowMs: number): number {
  return mineralChime.noteMineralCollected(nowMs);
}

/**
 * Reset the shared streak to base — the run-restart / scene-teardown seam.
 *
 * Both seams must call this so a restarted run and a scene shutdown always
 * start from the base pitch (the scene instance is reused across restarts).
 */
export function resetMineralChimeStreak(): void {
  mineralChime.reset();
}

/**
 * The shared streak's current ladder step (the step of the most recent
 * pickup, 0 = base) — for the cue dispatch and for observability/tests.
 */
export function mineralChimeStep(): number {
  return mineralChime.step();
}

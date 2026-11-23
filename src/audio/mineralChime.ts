/**
 * Pure pitch-escalation state machine for mineral pickups (AH-0MWNMRBO4000T5F8).
 *
 * A Phaser-free module that owns the streak counter, the game-clock gap check
 * and the reset seam.  Callers pass the game time in, so tests drive time
 * deterministically and a paused scene cannot expire a streak mid-run.
 *
 * The pitch ladder follows an A-minor scale: one degree per pickup, capped at
 * an octave (the last degree in {@link MINERAL_CHIME_SEMITONES}).
 *
 * ## Rules
 *
 * 1. **Base step** — the first pickup (or the first pickup after a reset/gap)
 *    returns playback rate `1.0` (0 semitones above base).
 * 2. **Ladder advance** — each successive pickup inside the reset gap advances
 *    exactly one step up the semitone ladder.
 * 3. **Octave clamp** — a long streak clamps at the last ladder degree; the
 *    playback rate never exceeds the octave rate.
 * 4. **Gap reset** — a gap of exactly {@link MINERAL_CHIME_RESET_GAP_MS} resets
 *    the streak to base; a gap 1 ms shorter does not.
 * 5. **Explicit reset** — {@link MineralChime.reset} returns the streak to base.
 * 6. **Sequential independence** — two streaks after a reset are independent.
 *
 * Playback rates are computed as `2 ** (semitones / 12)`.
 *
 * @module audio/mineralChime
 */

// ── Constants ─────────────────────────────────────────────────────────

/**
 * A-minor semitone ladder: one degree per pickup, capped at one octave.
 *
 * `[0, 2, 3, 5, 7, 8, 10]` — root, major second, major third, perfect
 * fourth, perfect fifth, major sixth, major seventh (the A-minor diatonic
 * scale up to but not including the octave).  Tunable in one place.
 */
export const MINERAL_CHIME_SEMITONES = [0, 2, 3, 5, 7, 8, 10] as const;

/**
 * Reset gap in milliseconds.  After a streak-free interval of this
 * duration (or longer), the next pickup resets to base pitch.
 *
 * Measured on game time (not wall clock), so a paused scene cannot expire
 * a streak mid-run.
 */
export const MINERAL_CHIME_RESET_GAP_MS = 1500;

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
   * `semitones` is the current streak position in
   * {@link MINERAL_CHIME_SEMITONES}, clamped to the ladder length.
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
  let streak = 0;
  // `null` until the first pickup, so the very first call can never be read
  // as the end of a streak.
  let lastPickupMs: number | null = null;

  return {
    noteMineralCollected(nowMs: number): number {
      // Gap reset: check if enough time has passed since the last pickup.
      if (lastPickupMs !== null && nowMs - lastPickupMs >= MINERAL_CHIME_RESET_GAP_MS) {
        streak = 0;
      }

      lastPickupMs = nowMs;

      // Return the rate for the current streak position, then advance.
      const rate = 2 ** (MINERAL_CHIME_SEMITONES[streak] / 12);
      streak = Math.min(streak + 1, MINERAL_CHIME_SEMITONES.length - 1);

      return rate;
    },

    reset(): void {
      streak = 0;
      lastPickupMs = null;
    },
  };
}

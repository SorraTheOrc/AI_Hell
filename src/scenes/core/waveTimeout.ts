/**
 * Shared wave-timeout constants (GDD §7.3).
 *
 * The shipped game (`PlayScene._timeoutWave`) and any gym wave-timeout run
 * a carry-over model where surviving enemies persist into the next wave.
 * The shared detonation helper `detonateWaveTimeoutSurvivors` is a no-op —
 * see AH-0MUNS3ZQ1002DJ9S for the carry-over implementation.
 *
 * Asteroids are special: they survive the timeout (they are not detonated)
 * and carry over, exactly as in the game (AH-0MUJM746P000QAEO). Callers pass
 * an `exclude` predicate to skip them (no-op for all entities now).
 */

import { GAME_WIDTH } from '../../core/constants';

/**
 * Seconds a wave may run before the time-limit penalty triggers
 * (per-wave, resets each wave; tunable — default 30 s per
 * AH-0MU7JTG9R002ZWA6 assumptions).
 */
export const WAVE_TIME_LIMIT_SECONDS = 30;

/**
 * Legacy detonation scale factor — retained for JSDoc references in callers
 * but no longer used at runtime (AH-0MUNS3ZQ1002DJ9S replaced detonation with
 * carry-over; the constant persists so existing doc comments remain valid).
 */
export const WAVE_TIMEOUT_EXPLOSION_SCALE = 10;

/** Wave time-limit bar geometry (top-centre, above the level readout). */
export const WAVE_TIMER_BAR_X = GAME_WIDTH * 0.25;
export const WAVE_TIMER_BAR_Y = 2;
export const WAVE_TIMER_BAR_WIDTH = GAME_WIDTH * 0.5;
export const WAVE_TIMER_BAR_HEIGHT = 6;

/** Minimal entity contract needed to detonate a wave-timeout survivor. */
export interface WaveTimeoutDetonatable {
  /** False once the entity is destroyed (mid-explosion counts as dead). */
  readonly alive: boolean;
  /**
   * Destroys the entity, playing an explosion geometry at `scale`
   * (default 1). The wave-timeout penalty uses
   * {@link WAVE_TIMEOUT_EXPLOSION_SCALE}.
   */
  destroySelf(scale?: number): void;
}

/**
 * No-op placeholder for the former wave-timeout detonation helper (AH-0MUNS3ZQ1002DJ9S).
 *
 * Survivors are no longer detonated on timeout; they persist into the next
 * wave as active, gating threats. This function remains as a stable API so
 * callers (`PlayScene._timeoutWave`, `GymFormationScene._onWaveTimeout`)
 * compile without change — the carry-over logic lives in the callers
 * instead.
 *
 * @returns 0 — no entities are detonated.
 */
export function detonateWaveTimeoutSurvivors<T extends WaveTimeoutDetonatable>(
  _survivors: readonly T[],
  _exclude?: (entity: T) => boolean,
): number {
  return 0;
}

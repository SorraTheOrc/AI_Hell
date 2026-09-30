/**
 * Shared wave-timeout constants and detonation helper (GDD §7.3).
 *
 * The shipped game (`PlayScene._timeoutWave`) and any gym wave-timeout run
 * this single implementation, so the major-explosion cue, its concurrency
 * limiter (`playMajorExplosionSound`) and the 10x detonation scale can never
 * diverge — the gym↔game parity convention in AGENTS.md. Extracted for
 * AH-0MUK5ONAA0007YEX (reuse the cue + limiter if a gym timeout is added)
 * and consumed by AH-0MUNR5LM1004B223 (enemy-gym timeout).
 *
 * Asteroids are special: they survive the timeout (they are not detonated)
 * and carry over, exactly as in the game (AH-0MUJM746P000QAEO). Callers pass
 * an `exclude` predicate to skip them.
 */

import { GAME_WIDTH } from '../../core/constants';
import { playMajorExplosionSound } from '../../audio/effects';

/**
 * Seconds a wave may run before the time-limit penalty triggers
 * (per-wave, resets each wave; tunable — default 30 s per
 * AH-0MU7JTG9R002ZWA6 assumptions).
 */
export const WAVE_TIME_LIMIT_SECONDS = 30;

/** Detonation scale factor applied to survivors on wave-timeout (10x). */
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
 * Detonates every surviving detonatable entity at the shared
 * {@link WAVE_TIMEOUT_EXPLOSION_SCALE}, playing the shared major-explosion
 * cue once per detonation (reusing its concurrency limiter). Entities for
 * which `exclude` returns true are skipped silently — the game passes a
 * predicate that skips carried-over asteroids.
 *
 * @returns the number of entities that were detonated.
 */
export function detonateWaveTimeoutSurvivors<T extends WaveTimeoutDetonatable>(
  survivors: readonly T[],
  exclude?: (entity: T) => boolean,
): number {
  let detonated = 0;
  for (const entity of survivors) {
    if (!entity.alive) continue;
    if (exclude?.(entity)) continue;
    playMajorExplosionSound();
    entity.destroySelf(WAVE_TIMEOUT_EXPLOSION_SCALE);
    detonated += 1;
  }
  return detonated;
}

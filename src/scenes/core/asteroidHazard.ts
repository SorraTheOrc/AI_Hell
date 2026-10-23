/**
 * Shared scheduled-asteroid hazard layer (AH-0MV9AWR7A0084XJ0).
 *
 * The shipped game (`PlayScene`) and the level-based gyms (`GymLevel`, hence
 * the bot-tuning gym) run the *same* random offscreen asteroid hazard: each
 * regular wave plans its spawns once with the pure planner
 * `src/waves/AsteroidSpawner.ts` (`computeSpawns`) and releases them on
 * schedule as the wave clock advances. This module owns that
 * plan → release → spawn lifecycle so the two scenes cannot fork it
 * (AGENTS.md § Game Architecture Conventions — an enabled gameplay object runs
 * the same code in a gym and in the game).
 *
 * Determinism: the layer itself holds no entropy. The caller passes the RNG to
 * {@link AsteroidHazardLayer.plan}, so the plan advances the scene's RNG stream
 * exactly once per wave (never per frame) and a seeded run reproduces byte-
 * identical spawn events.
 *
 * @module src/scenes/core/asteroidHazard
 */

import type Phaser from 'phaser';

import { Asteroid } from '../../entities/Asteroid';
import { computeSpawns, type SpawnEvent } from '../../waves/AsteroidSpawner';

/** Everything a scene needs to spawn one planned asteroid. */
export type AsteroidSpawnEvent = SpawnEvent;

/**
 * Plans a wave's asteroid spawns and releases them in scheduled order.
 *
 * Usage (both the game and the gyms):
 *
 * ```ts
 * layer.plan(globalWaveIndex, WIDTH, HEIGHT, waveTimeLimit, rng); // once per wave
 * layer.releaseDue(elapsedSeconds, (event) => spawn(event));       // every tick
 * ```
 */
export class AsteroidHazardLayer {
  private events: SpawnEvent[] = [];
  private released = 0;

  /**
   * Plans the spawn events for one wave. Replaces any previous plan and resets
   * the release cursor, so only the current wave's schedule can fire.
   *
   * @param globalWaveIndex — cumulative 0-based wave index (escalation input).
   * @param gameWidth — viewport width in px.
   * @param gameHeight — viewport height in px.
   * @param waveTimeLimit — wave duration in seconds (the spawn window).
   * @param rng — deterministic random number generator (returns `[0, 1)`).
   * @returns the planned events, in scheduled order.
   */
  plan(
    globalWaveIndex: number,
    gameWidth: number,
    gameHeight: number,
    waveTimeLimit: number,
    rng: () => number,
  ): readonly SpawnEvent[] {
    this.events = computeSpawns(
      globalWaveIndex,
      gameWidth,
      gameHeight,
      waveTimeLimit,
      rng,
    );
    this.released = 0;
    return this.events;
  }

  /** Drops the current plan and its release cursor. */
  reset(): void {
    this.events = [];
    this.released = 0;
  }

  /** The current wave's planned events (empty when nothing is planned). */
  getPlan(): readonly SpawnEvent[] {
    return this.events;
  }

  /** How many of the planned events have been released this wave. */
  getReleasedCount(): number {
    return this.released;
  }

  /**
   * Releases every planned event whose scheduled time has passed, in order,
   * stopping at the first not-yet-due event (the plan is time-ordered).
   *
   * @param elapsedSeconds — seconds elapsed in the active wave.
   * @param spawn — callback that materialises one event.
   * @returns the number of events released by this call.
   */
  releaseDue(
    elapsedSeconds: number,
    spawn: (event: SpawnEvent) => void,
  ): number {
    let count = 0;
    while (this.released < this.events.length) {
      const event = this.events[this.released];
      // Same epsilon as `PlayScene._releasesDueAsteroidSpawns` so a spawn
      // scheduled exactly at `elapsed` fires on that frame.
      if (elapsedSeconds + 1e-9 < event.timeSeconds) break;
      spawn(event);
      this.released += 1;
      count += 1;
    }
    return count;
  }
}

/**
 * Materialises one planned asteroid at its offscreen spawn position with the
 * planned inward velocity, adding it to the scene.
 *
 * Shared by `PlayScene._spawnScheduledAsteroid` and the level gyms so the
 * entity configuration (tier, velocity, offscreen entry, RNG) is identical.
 *
 * @param scene — the scene that owns the entity.
 * @param event — a planned spawn event.
 * @param rng — the scene RNG (shape/rotation entropy for the entity).
 * @returns the spawned asteroid (already added to the scene).
 */
export function createAsteroidFromEvent(
  scene: Phaser.Scene,
  event: SpawnEvent,
  rng: () => number,
): Asteroid {
  const entity = new Asteroid(scene, {
    x: event.x,
    y: event.y,
    formationOffset: { row: 0, col: 0 },
    sizeTier: event.sizeTier,
    vx: event.vx,
    vy: event.vy,
    enterFromOffscreen: true,
    rng,
  });
  scene.add.existing(entity);
  return entity;
}

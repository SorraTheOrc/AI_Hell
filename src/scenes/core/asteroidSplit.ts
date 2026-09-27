/**
 * Shared asteroid-split helper (GDD §4.1 — E6 Asteroid;
 * AH-0MUII3F7Q002O7WX, gap 8).
 *
 * Destroying a `large` asteroid spawns two `medium` children; destroying a
 * `medium` spawns two `small` children; a `small` asteroid destroys cleanly.
 * The shipped `PlayScene` and both asteroid-bearing gyms (`GymEnemies` and
 * `GymMinerals`) historically each carried their own copy of this spawn
 * closure, so a split-physics change had to be made in three places. This
 * module owns the spawn loop once: the parent computes the child
 * specifications (`Asteroid.getSplitChildren`) and this helper draws each
 * child, adds it to the scene and hands it to the caller's registration
 * callback — the game records wave accounting, the gyms append to their live
 * formation list.
 *
 * @module scenes/core/asteroidSplit
 */

import Phaser from 'phaser';

import { Asteroid } from '../../entities/Asteroid';

/** Options for {@link splitAsteroid}. */
export interface AsteroidSplitOptions {
  /** Scene that owns and renders the new children. */
  scene: Phaser.Scene;
  /** The destroyed large/medium parent asteroid. */
  parent: Asteroid;
  /**
   * Registers one spawned child with the caller's live list (the game's
   * `spawned`/`WaveManager` bookkeeping, or a gym's `entities` list).
   */
  register: (child: Asteroid) => void;
}

/**
 * Spawns the two smaller children of a destroyed large/medium asteroid at
 * the parent's position, using the parent-derived velocity fan and the child
 * tier's rotation speed. Each child is added to `scene` and passed to
 * `register` so the caller can track it.
 *
 * This is the single shared implementation consumed by
 * `PlayScene._splitAsteroid` and the `GymEnemies`/`GymMinerals` destruction
 * seams, so the split physics cannot drift between the game and the gyms.
 *
 * @returns the two spawned children, or `null` for a `small` asteroid (which
 *   destroys cleanly with no children).
 */
export function splitAsteroid(
  options: AsteroidSplitOptions,
): Asteroid[] | null {
  const { scene, parent, register } = options;
  const children = parent.getSplitChildren(parent.x, parent.y);
  if (!children) return null; // small tier — clean destruction, no children

  const spawned: Asteroid[] = [];
  for (const spec of children) {
    const child = new Asteroid(scene, {
      x: spec.x,
      y: spec.y,
      formationOffset: { row: 0, col: 0 },
      sizeTier: spec.sizeTier,
      vx: spec.vx,
      vy: spec.vy,
      rotationSpeed: spec.rotationSpeed,
    });
    scene.add.existing(child);
    register(child);
    spawned.push(child);
  }
  return spawned;
}

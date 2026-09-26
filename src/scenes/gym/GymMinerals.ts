/**
 * Asteroids-only mineral gym (AH-0MUBVGI62004ED9Q).
 *
 * Demonstrates the whole mineral mechanic in isolation on an asteroids-only
 * field: small-asteroid mineral drops, player hold fill and the HUD hold bar,
 * enemy absorption and re-drop on death, and the hold-full choice overlay.
 * Drops run through the shared `scenes/core/mineralKillDrops.ts` rule — the
 * same code the shipped `PlayScene` uses — so the gym cannot drift from the
 * game. The base scene seeds 100 random minerals on create (see
 * `GymFormationScene._initMineralLayer`).
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention.
 *
 * @module src/scenes/gym/GymMinerals
 */

import Phaser from 'phaser';

import { PLAYER_SPAWN } from '../../core/constants';
import { Asteroid } from '../../entities/Asteroid';
import type { EnemyEntity } from '../../entities/enemyFactory';
import type { FormationOffset } from '../../utils/formations';
import {
  GymFormationScene,
  type EnemyFormationConfig,
  type FormationSceneBullet,
} from './core/GymFormationScene';

/** Hint line shown at the bottom of the gym. */
export const GYM_MINERALS_HINT =
  'Minerals gym — asteroids only, 100 mineral drops (collect to fill the hold)';

/** Number of large asteroids seeded onto the field. */
export const GYM_MINERALS_ASTEROID_COUNT = 3;

/** Builds the asteroids-only formation config for the mineral gym. */
function asteroidFormationConfig(): EnemyFormationConfig<EnemyEntity, FormationSceneBullet> {
  return {
    sceneKey: 'GymMinerals',
    buildOffsets: (): FormationOffset[] => [
      { row: 0, col: 0 },
      { row: 1, col: -3 },
      { row: 1, col: 3 },
    ],
    count: GYM_MINERALS_ASTEROID_COUNT,
    spacingX: 150,
    spacingY: 90,
    driftSpeed: 0,
    startX: 300,
    startY: 160,
    statusLabel: 'asteroids',
    hintText: GYM_MINERALS_HINT,
    player: { ...PLAYER_SPAWN },
    createEntity: (scene: Phaser.Scene, x: number, y: number, offset: FormationOffset) =>
      new Asteroid(scene, { x, y, formationOffset: offset, sizeTier: 'large' }),
    collectBullets: () => [],
    // Asteroid split seam: destroyed large/medium rocks spawn two smaller
    // children that join the live formation list (mirrors GymEnemies).
    onEntityDestroyed: (entity: EnemyEntity): void => {
      if (!(entity instanceof Asteroid)) return;
      const parent = entity as Asteroid;
      const children = parent.getSplitChildren(parent.x, parent.y);
      if (!children) return; // small tier — clean destruction
      const scene = parent.scene as Phaser.Scene | undefined;
      if (!scene) return;
      const live = (scene as unknown as { entities: EnemyEntity[] }).entities;
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
        live.push(child);
      }
    },
  };
}

export class GymMinerals extends GymFormationScene<EnemyEntity, FormationSceneBullet> {
  constructor() {
    super(asteroidFormationConfig());
  }
}

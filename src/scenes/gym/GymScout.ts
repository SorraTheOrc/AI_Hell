/**
 * Gym scene — E1 Scout testbed (GDD §4.1).
 *
 * Renders a V-formation of Scout enemies that advances across the screen,
 * wiggling subtly. Two on-screen controls drive the demonstration:
 *
 * - **Explode** — destroys a random surviving scout with an explosion
 *   animation.
 * - **Shoot**  — toggles aimed firing (simulates Level 4+ behaviour):
 *   when on, scouts periodically fire red shots aimed at a default target
 *   position (bottom-centre of the screen, standing in for the player).
 *
 * Standalone gym scope: no player ship, no other enemy types, no HUD, no
 * power-ups. Scouts pass freely through one another — no collision is
 * installed (GDD §2.6).
 *
 * This scene is a **thin** GymFormationScene subclass: all formation
 * spawn/UI/update/bullet-lifecycle boilerplate lives in the shared core
 * library (see `core/GymFormationScene.ts` and
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). Scout-specific bits — the
 * offset builder, tuning constants, entity factory and aimed-fire
 * collection — are supplied here as configuration.
 */

import Phaser from 'phaser';

import { Scout, ScoutBullet } from '../../entities/Scout';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { buildVFormationOffsets } from '../../utils/formations';
import { FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
} from './core/GymFormationScene';

/** How many scouts spawn in the V-formation. */
export const SCOUT_FORMATION_COUNT = 6;
/** Horizontal spacing between wing columns (px). */
export const SCOUT_FORMATION_SPACING_X = 26;
/** Vertical spacing between formation rows (px). */
export const SCOUT_FORMATION_SPACING_Y = 22;
/** Forward (rightward) drift of the whole formation (px/s). */
export const SCOUT_FORMATION_DRIFT_SPEED = 40;
/** Initial formation base position. */
export const SCOUT_FORMATION_START_X = GAME_WIDTH * 0.25;
export const SCOUT_FORMATION_START_Y = GAME_HEIGHT * 0.5;

const SCOUT_CONFIG: EnemyFormationConfig<Scout, ScoutBullet> = {
  sceneKey: 'GymScout',
  buildOffsets: buildVFormationOffsets,
  count: SCOUT_FORMATION_COUNT,
  spacingX: SCOUT_FORMATION_SPACING_X,
  spacingY: SCOUT_FORMATION_SPACING_Y,
  driftSpeed: SCOUT_FORMATION_DRIFT_SPEED,
  startX: SCOUT_FORMATION_START_X,
  startY: SCOUT_FORMATION_START_Y,
  statusLabel: 'scouts',
  hintText: 'E1 Scout gym — V-formation demo',
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): Scout => new Scout(scene, { x, y, formationOffset }),
  collectBullets: (scout, now): ScoutBullet[] => {
    const bullet = scout.tryFireAimedBullet(now);
    return bullet ? [bullet] : [];
  },
};

export class GymScout extends GymFormationScene<Scout, ScoutBullet> {
  constructor() {
    super(SCOUT_CONFIG);
  }

  // ── Public test accessors (behaviour preserved from the pre-refactor
  //    scene; existing GymScout.test.ts passes unchanged) ───────────

  /** All scouts in the scene (alive or destroyed). */
  get formationScouts(): Scout[] {
    return this.formationEntities;
  }
}
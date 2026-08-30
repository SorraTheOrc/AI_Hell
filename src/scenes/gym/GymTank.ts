/**
 * Gym scene — E3 Tank testbed (GDD §4.1).
 *
 * Renders a rectangular formation of Tank enemies that moves slowly
 * across the screen with deliberate, extended hold positions.
 * Two on-screen controls drive the demonstration:
 *
 * - **Explode** — destroys a random surviving tank with an explosion
 *   animation.
 * - **Shoot**  — toggles radial burst firing (simulates Level 4+
 *   behaviour): when on, tanks periodically fire 10-projectile radial
 *   bursts; when off, tanks only hold formation.
 *
 * The player ship (arrows + WASD) is part of the scene with live combat:
 * player bullets destroy tanks, and tank shots hitting the ship trigger
 * explosion + respawn (infinite lives). No other enemy types, no HUD, no
 * power-ups. Tanks pass freely through one another — no collision is
 * installed (GDD §2.6).
 *
 * This scene is a **thin** GymFormationScene subclass: all formation
 * spawn/UI/update/bullet-lifecycle boilerplate lives in the shared core
 * library (see `core/GymFormationScene.ts` and
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). Tank-specific bits — the
 * offset builder, tuning constants, entity factory and radial-burst
 * collection — are supplied here as configuration.
 */

import Phaser from 'phaser';

import { Tank, TankBullet } from '../../entities/Tank';
import { GAME_WIDTH, GAME_HEIGHT, PLAYER_SPAWN } from '../../core/constants';
import { buildRectFormationOffsets } from '../../utils/formations';
import { FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
} from './core/GymFormationScene';

/** How many tanks spawn in the rectangular formation. */
export const TANK_FORMATION_COUNT = 6;
/** Horizontal spacing between columns (px). */
export const TANK_FORMATION_SPACING_X = 50;
/** Vertical spacing between rows (px). */
export const TANK_FORMATION_SPACING_Y = 45;
/** Forward (rightward) drift speed of the whole formation (px/s). */
export const TANK_FORMATION_DRIFT_SPEED = 18;
/** Initial formation base position. */
export const TANK_FORMATION_START_X = GAME_WIDTH * 0.25;
export const TANK_FORMATION_START_Y = GAME_HEIGHT * 0.5;

const TANK_CONFIG: EnemyFormationConfig<Tank, TankBullet> = {
  sceneKey: 'GymTank',
  buildOffsets: buildRectFormationOffsets,
  count: TANK_FORMATION_COUNT,
  spacingX: TANK_FORMATION_SPACING_X,
  spacingY: TANK_FORMATION_SPACING_Y,
  driftSpeed: TANK_FORMATION_DRIFT_SPEED,
  startX: TANK_FORMATION_START_X,
  startY: TANK_FORMATION_START_Y,
  player: PLAYER_SPAWN,
  statusLabel: 'tanks',
  hintText: 'E3 Tank gym — slow formation demo',
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): Tank => new Tank(scene, { x, y, formationOffset }),
  collectBullets: (tank, now): TankBullet[] => tank.tryFireRadialBurst(now),
};

export class GymTank extends GymFormationScene<Tank, TankBullet> {
  constructor() {
    super(TANK_CONFIG);
  }

  // ── Public test accessors (behaviour preserved from the pre-refactor
  //    scene; existing GymTank.test.ts passes unchanged) ───────────

  /** All tanks in the scene (alive or destroyed). */
  get formationTanks(): Tank[] {
    return this.formationEntities;
  }
}
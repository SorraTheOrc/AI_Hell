/**
 * Gym scene — E4 Phaser testbed (GDD §4.1, Level 5 exclusive).
 *
 * Renders Phaser enemies moving in fixed orbital paths around a central
 * point. Each Phaser appears as a circular neon ring (magenta `#ff00ff`)
 * with a central core. Phasers fire predictable radial bursts with clear
 * tell animations (≥ 500 ms advance cue) before each firing cycle.
 *
 * The player ship (arrows + WASD) is part of the scene with live combat:
 * player bullets destroy phasers, and phasers shots hitting the
 * ship trigger explosion + respawn (infinite lives). No other enemy
 * types, no HUD, no power-ups. Phasers pass freely through one another — no
 * collision is installed (GDD §2.6).
 *
 * This scene is a **thin** GymFormationScene subclass: all formation
 * spawn/UI/update/bullet-lifecycle boilerplate lives in the shared core
 * library (see `core/GymFormationScene.ts` and
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). Phaser-specific bits —
 * tuning constants, entity factory, radial-fire collection, and an
 * orbital-phase offset builder — are supplied here as configuration.
 */

import Phaser from 'phaser';

import {
  PhaserEntity,
  PhaserBullet,
  PHASER_FORMATION_COUNT,
  PHASER_ORBITAL_RADIUS,
  PHASER_FIRE_INTERVAL,
  PHASER_ORBITAL_SPEED,
  PHASER_BULLET_SPEED,
  PHASER_COLOR,
} from '../../entities/Phaser';
import { GAME_WIDTH, GAME_HEIGHT, PLAYER_SPAWN } from '../../core/constants';
import { FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
} from './core/GymFormationScene';

/** How many Phasers spawn in the orbital formation. */
export const PHASER_FORMATION_ENTITY_COUNT = PHASER_FORMATION_COUNT;
/** Orbital radius (px) — distance from formation centre. */
export const PHASER_FORMATION_ORBITAL_RADIUS = PHASER_ORBITAL_RADIUS;
/** Orbital angular speed (radians/s). */
export const PHASER_FORMATION_ORBITAL_SPEED = PHASER_ORBITAL_SPEED;
/** Firing interval (ms). */
export const PHASER_FORMATION_FIRE_INTERVAL = PHASER_FIRE_INTERVAL;
/** Bullet speed (px/s). */
export const PHASER_FORMATION_BULLET_SPEED = PHASER_BULLET_SPEED;
/** Body colour (hex string). */
export const PHASER_FORMATION_COLOR = PHASER_COLOR;
/** Forward (rightward) drift speed of the whole orbital system (px/s). */
export const PHASER_FORMATION_DRIFT_SPEED = 30;
/** Initial orbital formation base position. */
export const PHASER_FORMATION_START_X = GAME_WIDTH * 0.35;
export const PHASER_FORMATION_START_Y = GAME_HEIGHT * 0.5;

/**
 * Builds orbital-phase offsets for N Phasers.
 * Each Phaser gets a unique column index that maps to its orbital phase.
 * The entity computes phase from `row * 10 + col`.
 */
function buildOrbitalPhaseOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  for (let i = 0; i < count; i++) {
    offsets.push({ row: 0, col: i });
  }
  return offsets;
}

// Extend FormationOffset to include an optional phase field.
// The core library only uses `row` and `col`, so this is backward-compatible.

const PHASER_CONFIG: EnemyFormationConfig<PhaserEntity, PhaserBullet> = {
  sceneKey: 'GymPhaser',
  buildOffsets: buildOrbitalPhaseOffsets,
  count: PHASER_FORMATION_ENTITY_COUNT,
  spacingX: PHASER_FORMATION_ORBITAL_RADIUS,
  spacingY: PHASER_FORMATION_ORBITAL_RADIUS,
  driftSpeed: PHASER_FORMATION_DRIFT_SPEED,
  startX: PHASER_FORMATION_START_X,
  startY: PHASER_FORMATION_START_Y,
  player: PLAYER_SPAWN,
  statusLabel: 'phasers',
  hintText: 'E4 Phaser gym — orbital path demo',
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): PhaserEntity => new PhaserEntity(scene, { x, y, formationOffset }),
  collectBullets: (phaser, now): PhaserBullet[] => {
    const bullets = phaser.tryFireRadialBullets(now);
    return bullets;
  },
};

/**
 * Gym scene for E4 Phaser enemies.
 *
 * Phasers orbit around the formation centre at fixed radii and speeds.
 * The entity's `applyFormationPosition` overrides the flat grid positioning
 * with circular orbital motion. When shooting is enabled, each Phaser fires
 * a radial burst of 8 bullets after a visual tell animation (≥ 500 ms).
 */
export class GymPhaser extends GymFormationScene<PhaserEntity, PhaserBullet> {
  constructor() {
    super(PHASER_CONFIG);
  }

  // ── Public test accessors ────────────────────────────────────────

  /** All Phasers in the scene (alive or destroyed). */
  get formationPhasers(): PhaserEntity[] {
    return this.formationEntities;
  }
}

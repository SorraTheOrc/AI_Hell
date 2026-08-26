/**
 * Gym scene — E2 Diver testbed (GDD §4.2).
 *
 * Renders a diamond-formation of Diver enemies that advance across the
 * screen. Each diver periodically breaks from formation, follows a curved
 * (parabolic) trajectory toward the player position, then returns to its
 * formation slot. Two on-screen controls drive the demonstration:
 *
 * - **Explode** — destroys a random surviving diver with an explosion
 *   animation.
 * - **Shoot**  — toggles spread-shot firing (simulates Level 4+ behaviour):
 *   when on, divers periodically fire short-burst spread shots (3–5
 *   projectiles at slight angles) during their dive trajectory.
 *
 * Standalone gym scope: no player ship, no other enemy types, no HUD,
 * no power-ups. Divers pass freely through one another — no collision
 * is installed (GDD §2.6).
 *
 * This scene is a **thin** GymFormationScene subclass: all formation
 * spawn/UI/update/bullet-lifecycle boilerplate lives in the shared core
 * library (see `core/GymFormationScene.ts` and
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). Diver-specific bits — the
 * offset builder, tuning constants, entity factory and spread-burst
 * collection — are supplied here as configuration.
 */

import Phaser from 'phaser';

import { Diver, DiverBullet, DiverState } from '../../entities/Diver';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { buildDiverFormationOffsets } from '../../utils/formations';
import { FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
} from './core/GymFormationScene';

/** How many divers spawn in the diamond formation. */
export const DIVER_FORMATION_COUNT = 6;
/** Horizontal spacing between columns (px). */
export const DIVER_FORMATION_SPACING_X = 30;
/** Vertical spacing between rows (px). */
export const DIVER_FORMATION_SPACING_Y = 25;
/** Forward (rightward) drift speed of the whole formation (px/s). */
export const DIVER_FORMATION_DRIFT_SPEED = 30;
/** Initial formation base position. */
export const DIVER_FORMATION_START_X = GAME_WIDTH * 0.25;
export const DIVER_FORMATION_START_Y = GAME_HEIGHT * 0.45;

const DIVER_CONFIG: EnemyFormationConfig<Diver, DiverBullet> = {
  sceneKey: 'GymDiver',
  buildOffsets: buildDiverFormationOffsets,
  count: DIVER_FORMATION_COUNT,
  spacingX: DIVER_FORMATION_SPACING_X,
  spacingY: DIVER_FORMATION_SPACING_Y,
  driftSpeed: DIVER_FORMATION_DRIFT_SPEED,
  startX: DIVER_FORMATION_START_X,
  startY: DIVER_FORMATION_START_Y,
  statusLabel: 'divers',
  hintText: 'E2 Diver gym — curved-dive demo',
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): Diver => new Diver(scene, { x, y, formationOffset }),
  collectBullets: (diver, now): DiverBullet[] =>
    diver.tryFireSpreadBurst(now),
};

export class GymDiver extends GymFormationScene<Diver, DiverBullet> {
  constructor() {
    super(DIVER_CONFIG);
  }

  // ── Public test accessors (behaviour preserved from the pre-refactor
  //    scene; existing GymDiver.test.ts passes unchanged) ───────────

  /** All divers in the scene (alive or destroyed). */
  get formationDivers(): Diver[] {
    return this.formationEntities;
  }

  /** Returns the count of divers currently in each state. */
  get stateCounts(): { formation: number; diving: number; returning: number } {
    let formation = 0;
    let diving = 0;
    let returning = 0;
    for (const diver of this.formationDivers) {
      switch (diver.behaviourState) {
        case DiverState.FORMATION: formation++; break;
        case DiverState.DIVING: diving++; break;
        default: returning++; break;
      }
    }
    return { formation, diving, returning };
  }
}
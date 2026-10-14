/**
 * Centipede gym scene (classic-arcade archetype, AH-0MV01EJ92008ZZ86).
 *
 * Exercises the linked-chain archetype end-to-end in the gym so the game and
 * the gym run the *same* code: the scene builds the shared `CentipedeChain`
 * (`src/scenes/core/centipedeChain.ts`) and one shared `Centipede` entity per
 * segment (`src/entities/Centipede.ts`). Shooting a middle segment splits the
 * chain into two independent sub-chains; the EXPLODE button does the same.
 *
 * The chain formation is owned once by the shared
 * `src/scenes/gym/core/centipedeFormation.ts` module: the dedicated `GymCentipede`
 * scene and the reusable `GymFodderEnemies` scene (which surfaces the Centipede
 * as one of its in-panel enemy types, AH-0MV4ZOIZR0086T66) both boot the *same*
 * chain — so no diverging copy exists and the game/gym parity guard is
 * satisfied by construction.
 *
 * The scene is a thin `GymFormationScene` subclass — it does not re-implement
 * any chain law, so the game/gym parity guard is satisfied by construction.
 *
 * @module scenes/gym/GymCentipede
 */

import Phaser from 'phaser';

import { Centipede } from '../../entities/Centipede';
import { CentipedeChain } from '../core/centipedeChain';
import {
  CentipedeFormationBullet,
  centipedeFormationConfig,
  getCentipedeChain,
} from './core/centipedeFormation';
import { GymFormationScene } from './core/GymFormationScene';

export type GymCentipedeBullet = CentipedeFormationBullet;

/** The chain currently backing `scene` (for tests). */
export function getGymCentipedeChain(scene: Phaser.Scene): CentipedeChain | undefined {
  return getCentipedeChain(scene);
}

export class GymCentipede extends GymFormationScene<
  Centipede,
  GymCentipedeBullet
> {
  constructor() {
    super(centipedeFormationConfig('GymCentipede'));
  }

  /** Live segments for assertions. */
  get centipedeSegments(): Centipede[] {
    return this.formationEntities;
  }

  /** The shared chain backing the current formation. */
  get chain(): CentipedeChain | undefined {
    return getCentipedeChain(this);
  }

  /** Live enemy-bullet count (segments never fire, so this stays 0). */
  get enemyBulletCount(): number {
    return this.bullets.length;
  }
}

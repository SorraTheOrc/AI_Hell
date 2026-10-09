/**
 * Centipede gym scene (classic-arcade archetype, AH-0MV01EJ92008ZZ86).
 *
 * Exercises the linked-chain archetype end-to-end in the gym so the game and
 * the gym run the *same* code: the scene builds the shared `CentipedeChain`
 * (`src/scenes/core/centipedeChain.ts`) and one shared `Centipede` entity per
 * segment (`src/entities/Centipede.ts`). Shooting a middle segment splits the
 * chain into two independent sub-chains; the EXPLODE button does the same.
 *
 * The scene is a thin `GymFormationScene` subclass — it does not re-implement
 * any chain law, so the game/gym parity guard is satisfied by construction.
 *
 * @module scenes/gym/GymCentipede
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH, PLAYER_SPAWN } from '../../core/constants';
import type { FormationOffset } from '../../utils/formations';
import { CentipedeChain } from '../core/centipedeChain';
import { Centipede } from '../../entities/Centipede';
import {
  CENTIPEDE_SEGMENT_COUNT,
  CENTIPEDE_SEGMENT_SPACING,
  CENTIPEDE_DESCENT_SPEED,
  CENTIPEDE_LATERAL_SPEED,
  centipedeArena,
} from '../../waves/CentipedeSpawner';
import {
  GymFormationScene,
  type EnemyFormationConfig,
  type FormationSceneBullet,
} from './core/GymFormationScene';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';

export type GymCentipedeBullet = FormationSceneBullet;

/**
 * Per-scene chain registry. The chain must be shared by every segment entity
 * of a formation, but `GymFormationScene` builds each entity through a plain
 * `createEntity` callback. A `WeakMap` keyed by the scene keeps the chain off
 * the base class and is recreated whenever the lead (col 0) is spawned, so a
 * manual Respawn always starts a fresh chain.
 */
const sceneChains = new WeakMap<Phaser.Scene, CentipedeChain>();

/** The chain currently backing `scene` (for tests). */
export function getGymCentipedeChain(scene: Phaser.Scene): CentipedeChain | undefined {
  return sceneChains.get(scene);
}

/** Builds one segment, creating/replacing the shared chain at the lead (col 0). */
function createSegment(
  scene: Phaser.Scene,
  _x: number,
  _y: number,
  offset: FormationOffset,
): Centipede {
  let chain = sceneChains.get(scene);
  if (!chain || offset.col === 0) {
    const arena = centipedeArena(GAME_WIDTH, GAME_HEIGHT);
    chain = new CentipedeChain({
      startX: (arena.minX + arena.maxX) / 2,
      startY: arena.minY,
      arena,
      segmentCount: CENTIPEDE_SEGMENT_COUNT,
      spacing: CENTIPEDE_SEGMENT_SPACING,
      lateralSpeed: CENTIPEDE_LATERAL_SPEED,
      descentSpeed: CENTIPEDE_DESCENT_SPEED,
      initialDir: 1,
    });
    sceneChains.set(scene, chain);
  }
  const segment = chain.segment(offset.col);
  return new Centipede(scene, {
    x: segment?.x ?? 0,
    y: segment?.y ?? 0,
    formationOffset: offset,
    chain,
    segmentId: offset.col,
  });
}

function centipedeFormationConfig(): EnemyFormationConfig<
  Centipede,
  GymCentipedeBullet
> {
  return {
    sceneKey: 'GymCentipede',
    // One offset per segment, laid out as a linear index in `col`.
    buildOffsets: (count: number): FormationOffset[] =>
      Array.from({ length: count }, (_, col) => ({ row: 0, col })),
    count: CENTIPEDE_SEGMENT_COUNT,
    spacingX: 0,
    spacingY: 0,
    driftSpeed: 0,
    formationKind: 'single',
    startX: GAME_WIDTH / 2,
    startY: CENTIPEDE_SEGMENT_COUNT * CENTIPEDE_SEGMENT_SPACING,
    statusLabel: 'centipede',
    hintText: 'Centipede — linked chain; shooting a middle segment splits it',
    player: { ...PLAYER_SPAWN },
    timeoutDuration: WAVE_TIME_LIMIT_SECONDS,
    createEntity: createSegment,
    // Segments never fire at any level.
    collectBullets: () => [],
  };
}

export class GymCentipede extends GymFormationScene<
  Centipede,
  GymCentipedeBullet
> {
  constructor() {
    super(centipedeFormationConfig());
  }

  /** Live segments for assertions. */
  get centipedeSegments(): Centipede[] {
    return this.formationEntities;
  }

  /** The shared chain backing the current formation. */
  get chain(): CentipedeChain | undefined {
    return getGymCentipedeChain(this);
  }

  /** Live enemy-bullet count (segments never fire, so this stays 0). */
  get enemyBulletCount(): number {
    return this.bullets.length;
  }
}

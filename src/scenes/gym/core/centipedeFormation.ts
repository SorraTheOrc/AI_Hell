/**
 * Shared Centipede chain formation config (classic-arcade archetype,
 * AH-0MV01EJ92008ZZ86).
 *
 * The Centipede is a linked chain, not a config-driven formation: it is
 * delivered by the shared `CentipedeChain` model (`../../core/centipedeChain`)
 * over the shared `Centipede` entity (`../../../entities/Centipede`). This
 * module owns the single `EnemyFormationConfig` the chain is built from, so
 * both the dedicated `GymCentipede` scene and the reusable `GymFodderEnemies`
 * scene (which surfaces the Centipede as one of its in-panel enemy types) run
 * the *same* code — game/gym parity by construction
 * (AH-0MV4ZOIZR0086T66).
 *
 * The chain must be shared by every segment entity of a formation, but
 * `GymFormationScene` builds each entity through a plain `createEntity`
 * callback. A `WeakMap` keyed by the scene keeps the chain off the base class
 * and is recreated whenever the lead (col 0) is spawned, so a manual Respawn —
 * or switching the fodder gym's archetype away and back — always starts a
 * fresh chain.
 *
 * @module scenes/gym/core/centipedeFormation
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH, PLAYER_SPAWN } from '../../../core/constants';
import type { FormationOffset } from '../../../utils/formations';
import { CentipedeChain } from '../../core/centipedeChain';
import { Centipede } from '../../../entities/Centipede';
import {
  CENTIPEDE_SEGMENT_COUNT,
  CENTIPEDE_SEGMENT_SPACING,
  CENTIPEDE_DESCENT_SPEED,
  CENTIPEDE_LATERAL_SPEED,
  centipedeArena,
} from '../../../waves/CentipedeSpawner';
import { WAVE_TIME_LIMIT_SECONDS } from '../../core/waveTimeout';
import {
  type EnemyFormationConfig,
  type FormationSceneBullet,
} from './GymFormationScene';

/** Bullet shape the Centipede formation uses (segments never fire). */
export type CentipedeFormationBullet = FormationSceneBullet;

/**
 * Per-scene chain registry. Keyed by scene so the chain is shared by every
 * segment of one formation without living on the base class.
 */
const sceneChains = new WeakMap<Phaser.Scene, CentipedeChain>();

/** The chain currently backing `scene` (for tests and the scene getters). */
export function getCentipedeChain(
  scene: Phaser.Scene,
): CentipedeChain | undefined {
  return sceneChains.get(scene);
}

/**
 * Builds one segment, creating/replacing the shared chain at the lead
 * (col 0). Every non-lead segment joins the chain the lead created, so a
 * single formation shares one `CentipedeChain`.
 */
export function createCentipedeSegment(
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

/**
 * The Centipede chain as an `EnemyFormationConfig`, parameterised by the
 * owning scene key. One offset per segment, laid out as a linear index in
 * `col`; the segments never fire and the shared wave-timeout applies.
 */
export function centipedeFormationConfig(
  sceneKey: string,
): EnemyFormationConfig<Centipede, CentipedeFormationBullet> {
  return {
    sceneKey,
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
    createEntity: createCentipedeSegment,
    // Segments never fire at any level.
    collectBullets: () => [],
  };
}

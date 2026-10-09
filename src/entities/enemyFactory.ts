/**
 * Config-aware enemy factory.
 *
 * Maps an `EnemyConfig` to an entity constructor so the single
 * `GymEnemies` scene can spawn any archetype without branching on type.
 * Kept thin — only a seam for tests and the gym scene; not a full ECS.
 */

import Phaser from 'phaser';

import { Asteroid } from './Asteroid';
import { Capturer } from './Capturer';
import { Ghost, personalityFromKey } from './Ghost';
import { Harvester } from './Harvester';
import { Diver } from './Diver';
import { PhaserEntity } from './Phaser';
import { Scout } from './Scout';
import { Swarm } from './Swarm';
import { Tank } from './Tank';
import type {
  FormationOffset,
  FormationReanchorRequest,
} from '../utils/formations';
import type { Mineral } from './Mineral';
import type { EnemyConfig } from '../core/enemyConfig';
import { SWARM_CLUSTER_COUNT } from './Swarm';
import { SWARM_CLUSTER_ROW_STRIDE } from '../utils/formations';

/**
 * Optional per-entity seam: plays the entity-specific destruction sound
 * (mirrors the combat gym base). When present, scenes prefer it over the
 * shared `playDestructionSound()` so the entity's destruction sound plays
 * exactly once.
 */
interface DestructionAudioSeam {
  playDestructionAudio?(): void;
}

/**
 * Optional per-entity seam: a formation entity (currently the Diver) returns
 * a re-anchor request when its attack finishes, and the owning scene re-bases
 * the whole unit so the entity's slot coincides with its attack-end position
 * (GDD §4.1 — E2). Other entities omit it and the scenes use optional
 * chaining.
 */
interface FormationReanchorSeam {
  consumeFormationReanchor?(): FormationReanchorRequest | null;
}

/**
 * Optional roaming-seek seam (Harvester, GDD §4.1 — E7). When present, the
 * scene pushes its live mineral field to the entity each frame so a roaming
 * enemy can steer toward the nearest mineral; the entity advances its own
 * motion through the optional `updatePosition` seam.
 */
interface SeekSeam {
  setSeekTargets?(minerals: readonly Mineral[]): void;
  updatePosition?(dt: number): void;
}

export type EnemyEntity = (Scout | Diver | Tank | PhaserEntity | Swarm | Asteroid | Harvester | Capturer | Ghost) &
  DestructionAudioSeam &
  FormationReanchorSeam &
  SeekSeam & {
    /** Tractor-beam seam (Galaga capturer, AH-0MV01EFII008298D). */
    getCaptureBeam?(): import('../scenes/core/captureBeam').CaptureBeamState | null;
    notifyPlayerCaptured?(): void;
  };

/**
 * Build one entity of the right type from the config key / formationKind.
 *
 * @param rng — optional seeded random source threaded into every archetype
 *   (AH-0MUY08V6W001SJJN). `PlayScene` passes its per-run seeded RNG so
 *   enemy behaviour (cluster drift, wiggle phase, fire rolls, asteroid
 *   headings) is reproducible; callers that omit it keep the entity's
 *   `Math.random` default (interactive gyms, tests that do not assert
 *   determinism).
 */
export function createEnemyFromConfig(
  scene: Phaser.Scene,
  config: EnemyConfig,
  x: number,
  y: number,
  offset: FormationOffset,
  rng?: () => number,
): EnemyEntity {
  const opts = {
    size: config.size,
    color: config.color,
    bulletColor: config.bulletColor,
    bulletSize: config.bulletSize,
    bulletSpeed: config.bulletSpeed,
    bulletLifetime: config.bulletLifetime,
    fireInterval: config.fireInterval,
    burstCount: config.burstCount,
    shotProbability: config.shotProbability,
    health: config.health,
    rng,
  };
  // Tractor-beam tuning (Galaga capturer archetype, AH-0MV01EFII008298D).
  const beamOpts = {
    beamDuration: config.beamDuration,
    pullStrength: config.pullStrength,
  };

  switch (config.key) {
    // Pac-Man personality pursuers (AH-0MV01EH2U008XT3Q): one key per
    // personality, each mapped to the shared `Ghost` steering entity.
    case 'ghost-chase':
    case 'ghost-ambush':
    case 'ghost-flank':
    case 'ghost-wander':
      return new Ghost(scene, {
        x,
        y,
        formationOffset: offset,
        personality: personalityFromKey(config.key),
        ...opts,
      });
    case 'capturer':
      return new Capturer(scene, {
        x,
        y,
        formationOffset: offset,
        ...opts,
        ...beamOpts,
      });
    case 'asteroid':
      return new Asteroid(scene, { x, y, formationOffset: offset, ...opts });
    case 'harvester':
      return new Harvester(scene, { x, y, formationOffset: offset, ...opts });
    case 'diver':
      return new Diver(scene, { x, y, formationOffset: offset, ...opts });
    case 'tank':
      return new Tank(scene, { x, y, formationOffset: offset, ...opts });
    case 'phaser':
      return new PhaserEntity(scene, { x, y, formationOffset: offset, ...opts });
    case 'swarm': {
      const clusterIndex = Math.min(
        SWARM_CLUSTER_COUNT - 1,
        Math.max(0, Math.round(offset.row / SWARM_CLUSTER_ROW_STRIDE)),
      );
      return new Swarm(scene, { x, y, formationOffset: offset, ...opts }, clusterIndex);
    }
    case 'scout':
    // Space Invaders marching block (AH-0MV01EDZS0005R20) reuses the Scout
    // body; its distinct behaviour is the shared `march` movement policy, not
    // a new entity class.
    case 'march':
    default: {
      // Unknown keys fall back to Scout — deterministic behaviour for
      // Save As custom enemies without a dedicated entity class.
      // Custom visuals/bullet tunings are still applied via opts.
      return new Scout(scene, { x, y, formationOffset: offset, ...opts });
    }
  }
}

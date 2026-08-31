/**
 * Config-aware enemy factory.
 *
 * Maps an `EnemyConfig` to an entity constructor so the single
 * `GymEnemies` scene can spawn any archetype without branching on type.
 * Kept thin — only a seam for tests and the gym scene; not a full ECS.
 */

import Phaser from 'phaser';

import { Diver } from './Diver';
import { PhaserEntity } from './Phaser';
import { Scout } from './Scout';
import { Swarm } from './Swarm';
import { Tank } from './Tank';
import type { FormationOffset } from '../utils/formations';
import type { EnemyConfig } from '../core/enemyConfig';
import { SWARM_CLUSTER_COUNT } from './Swarm';
import { SWARM_CLUSTER_ROW_STRIDE } from '../utils/formations';

export type EnemyEntity = Scout | Diver | Tank | PhaserEntity | Swarm;

/** Build one entity of the right type from the config key / formationKind. */
export function createEnemyFromConfig(
  scene: Phaser.Scene,
  config: EnemyConfig,
  x: number,
  y: number,
  offset: FormationOffset,
): EnemyEntity {
  const opts = {
    size: config.size,
    color: config.color,
    bulletColor: config.bulletColor,
    bulletSize: config.bulletSize,
    bulletSpeed: config.bulletSpeed,
    fireInterval: config.fireInterval,
    burstCount: config.burstCount,
  };

  switch (config.key) {
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
    default: {
      // Unknown keys fall back to Scout — deterministic behaviour for
      // Save As custom enemies without a dedicated entity class.
      // Custom visuals/bullet tunings are still applied via opts.
      return new Scout(scene, { x, y, formationOffset: offset, ...opts });
    }
  }
}

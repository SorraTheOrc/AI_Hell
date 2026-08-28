/**
 * Gym scene — E5 Swarm testbed (GDD §4.1).
 *
 * Renders a swarm of diamond-shaped neon-blue Swarm enemies that advance
 * across the screen in tight, fast-moving clusters with sudden direction
 * changes. Clusters of 3–5 enemies weave together, split and rejoin —
 * creating the unpredictable, chaotic movement that defines the E5 Swarm.
 *
 * Standalone gym scope: no player ship, no other enemy types, no HUD, no
 * power-ups. Swarms pass freely through one another — no collision is
 * installed (GDD §2.6).
 *
 * Two on-screen controls:
 *
 * - **Explode** — destroys a random surviving swarm member with an
 *   explosion animation.
 * - **Shoot**  — toggles coordinated burst firing (simulates Level 4+
 *   behaviour): when on, swarm members fire cyan burst shots toward the
 *   bottom-centre target.
 *
 * This scene is a **thin** GymFormationScene subclass: all formation
 * spawn / UI / update / bullet-lifecycle boilerplate lives in the shared
 * core library (see `core/GymFormationScene.ts` and
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). Swarm-specific bits — the
 * cluster offset builder, tuning constants, entity factory, and
 * coordinated-burst collection — are supplied here as configuration.
 */

import Phaser from 'phaser';

import { Swarm, SwarmBullet, SWARM_CLUSTER_COUNT } from '../../entities/Swarm';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { buildSwarmClusterOffsets, FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
} from './core/GymFormationScene';

/** How many swarm members spawn. */
export const SWARM_FORMATION_COUNT = 15;
/** Horizontal spacing between slots (px). */
export const SWARM_FORMATION_SPACING_X = 28;
/** Vertical spacing between slots (px). */
export const SWARM_FORMATION_SPACING_Y = 24;
/** Forward (rightward) drift of the whole swarm (px/s). */
export const SWARM_FORMATION_DRIFT_SPEED = 60;
/** Initial formation base position. */
export const SWARM_FORMATION_START_X = GAME_WIDTH * 0.15;
export const SWARM_FORMATION_START_Y = GAME_HEIGHT * 0.3;

const SWARM_CONFIG: EnemyFormationConfig<Swarm, SwarmBullet> = {
  sceneKey: 'GymSwarm',
  buildOffsets: buildSwarmClusterOffsets,
  count: SWARM_FORMATION_COUNT,
  spacingX: SWARM_FORMATION_SPACING_X,
  spacingY: SWARM_FORMATION_SPACING_Y,
  driftSpeed: SWARM_FORMATION_DRIFT_SPEED,
  startX: SWARM_FORMATION_START_X,
  startY: SWARM_FORMATION_START_Y,
  statusLabel: 'swarms',
  hintText: 'E5 Swarm gym — tight-cluster movement demo',
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): Swarm => {
    // Assign clusters: members are distributed across SWARM_CLUSTER_COUNT
    // clusters based on their spawn index.
    const swarmIndex = SWARM_CONFIG.buildOffsets(SWARM_FORMATION_COUNT)
      .findIndex((o) => o.row === formationOffset.row && o.col === formationOffset.col);
    const clusterIndex = (swarmIndex % SWARM_CLUSTER_COUNT);
    return new Swarm(scene, { x, y, formationOffset }, clusterIndex);
  },
  collectBullets: (swarm, now): SwarmBullet[] => {
    const bullet = swarm.tryFireBurstBullet(now);
    return bullet ? [bullet] : [];
  },
};

export class GymSwarm extends GymFormationScene<Swarm, SwarmBullet> {
  constructor() {
    super(SWARM_CONFIG);
  }

  // ── Public test accessors (thin wrappers over the base class) ───

  /** All swarm members in the scene (alive or destroyed). */
  get formationSwarms(): Swarm[] {
    return this.formationEntities;
  }
}

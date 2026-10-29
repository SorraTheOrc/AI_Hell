/**
 * Shared per-wave dynamic-spawn planning and release seams
 * (docs/GYM_PARITY.md D3).
 *
 * Beyond the hand-authored wave groups, the game schedules several
 * **spawner-delivered** archetypes/hazards from an opt-in wave flag:
 *
 * | Flag | Plan module | Released through |
 * |---|---|---|
 * | `ghosts` | `GhostSpawner` | `releaseDueSpawns` |
 * | `centipede` | `CentipedeSpawner` | `releaseDueSpawns` |
 * | `horde` | `HordeSpawner` | `releaseDueSpawns` |
 * | `laneTraffic` | `LaneTrafficSpawner` | `releaseDueSpawns` |
 * | (wave 3+) | `StrikeSpawner` | `releaseDueSpawns` |
 *
 * `PlayScene` and `GymLevel` each carry their own scene-specific spawn
 * accounting (the game registers archetypes with the `WaveManager`, the gym
 * keeps its own `spawned` list), but the **plan** and the **time-ordered
 * release** are identical. They used to be duplicated in the two scenes and
 * were missing entirely from `GymLevel`, so a launched campaign
 * `LevelDefinition` silently lost its ghosts, centipede, horde, lane traffic
 * and orbital strikes.
 *
 * This module owns the plan/release rule once. The scene-specific entity
 * construction and wave accounting stay scene-side (they are genuinely
 * different), so no gameplay object runs a divergent copy.
 *
 * @module scenes/core/dynamicSpawnPlan
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { loadEnemyConfig } from '../../core/enemyConfig';
import {
  computeCentipedeSpawn,
  type CentipedeSpawnEvent,
} from '../../waves/CentipedeSpawner';
import {
  computeGhostSpawns,
  type GhostSpawnEvent,
} from '../../waves/GhostSpawner';
import {
  computeHordeSpawns,
  GRUNT_ENEMY_KEY,
  HORDE_DEFAULT_GROUP_SIZE,
  HORDE_DEFAULT_SPAWN_INTERVAL_SECONDS,
  type HordeSpawnEvent,
} from '../../waves/HordeSpawner';
import {
  computeLaneTrafficSpawns,
  LANE_TRAFFIC_DEFAULT_LANE_COUNT,
  LANE_TRAFFIC_DEFAULT_LANE_SPACING,
  type LaneTrafficSpawnEvent,
} from '../../waves/LaneTrafficSpawner';
import {
  computeSpawns as computeStrikeSpawns,
  type SpawnEvent,
} from '../../waves/StrikeSpawner';
import { WAVE_TIME_LIMIT_SECONDS } from './waveTimeout';

/** Any planned spawn carries an absolute release time in seconds. */
export interface TimedSpawnEvent {
  timeSeconds: number;
}

/**
 * Plans one wave's Pac-Man ghost-pursuer group.
 *
 * @param rng — the scene's content RNG (advanced only at wave boundaries).
 */
export function planGhostWaveSpawns(
  rng: () => number,
): GhostSpawnEvent[] {
  return computeGhostSpawns(GAME_WIDTH, GAME_HEIGHT, WAVE_TIME_LIMIT_SECONDS, rng);
}

/**
 * Plans one wave's Centipede chain.
 *
 * @param rng — the scene's content RNG.
 */
export function planCentipedeWaveSpawn(
  rng: () => number,
): CentipedeSpawnEvent {
  return computeCentipedeSpawn(GAME_WIDTH, GAME_HEIGHT, WAVE_TIME_LIMIT_SECONDS, rng);
}

/**
 * Plans one wave's Robotron homing horde, reading the data-driven `grunt`
 * config for count, group size and cadence (the same rows the game reads).
 *
 * @param rng — the scene's content RNG.
 */
export function planHordeWaveSpawns(
  rng: () => number,
): HordeSpawnEvent[] {
  const cfg = loadEnemyConfig(GRUNT_ENEMY_KEY);
  return computeHordeSpawns({
    gameWidth: GAME_WIDTH,
    gameHeight: GAME_HEIGHT,
    waveTimeLimitSeconds: WAVE_TIME_LIMIT_SECONDS,
    count: cfg.count,
    groupSize: cfg.hordeGroupSize ?? HORDE_DEFAULT_GROUP_SIZE,
    spawnIntervalSeconds:
      cfg.hordeSpawnInterval ?? HORDE_DEFAULT_SPAWN_INTERVAL_SECONDS,
    rng,
  });
}

/**
 * Plans one wave's Frogger lane traffic, reading the data-driven `lane-traffic`
 * config for lane count, per-lane count, spacing and speed.
 *
 * @param rng — the scene's content RNG.
 */
export function planLaneTrafficWaveSpawns(
  rng: () => number,
): LaneTrafficSpawnEvent[] {
  const cfg = loadEnemyConfig('lane-traffic');
  return computeLaneTrafficSpawns({
    gameWidth: GAME_WIDTH,
    gameHeight: GAME_HEIGHT,
    waveTimeLimitSeconds: WAVE_TIME_LIMIT_SECONDS,
    laneCount: cfg.laneCount ?? LANE_TRAFFIC_DEFAULT_LANE_COUNT,
    perLaneCount: cfg.count,
    spacing: cfg.spacingX,
    laneSpacing: cfg.laneSpacing ?? LANE_TRAFFIC_DEFAULT_LANE_SPACING,
    speed: cfg.driftSpeed,
    rng,
  });
}

/**
 * Plans one wave's telegraphed orbital strikes (none before wave 3).
 *
 * @param globalWaveIndex — cumulative 0-based wave index across the session.
 * @param playerX — the live ship position the planner aims the strikes near.
 * @param playerY — the live ship position the planner aims the strikes near.
 * @param rng — the scene's content RNG.
 */
export function planStrikeWaveSpawns(
  globalWaveIndex: number,
  playerX: number,
  playerY: number,
  rng: () => number,
): SpawnEvent[] {
  return computeStrikeSpawns(
    globalWaveIndex,
    GAME_WIDTH,
    GAME_HEIGHT,
    WAVE_TIME_LIMIT_SECONDS,
    playerX,
    playerY,
    rng,
  );
}

/**
 * Releases every planned spawn whose scheduled time has passed, stopping at
 * the first not-yet-due event (the plan is time-ordered) and advancing the
 * caller's cursor past what it spawned.
 *
 * This is the single release rule the game and the level gym run; the caller
 * owns the gating (wave active / not paused / not in a boss encounter) and the
 * spawn-one action.
 *
 * @param plan — the time-ordered plan for this wave.
 * @param spawnedSoFar — how many events of `plan` have already been released.
 * @param elapsedSeconds — seconds since the wave window began.
 * @param spawnOne — scene-specific release of one event.
 * @returns the new cursor (number of events released after this call).
 */
export function releaseDueSpawns<T extends TimedSpawnEvent>(
  plan: readonly T[],
  spawnedSoFar: number,
  elapsedSeconds: number,
  spawnOne: (event: T) => void,
): number {
  let cursor = spawnedSoFar;
  while (cursor < plan.length) {
    const event = plan[cursor];
    if (elapsedSeconds + 1e-9 < event.timeSeconds) break;
    spawnOne(event);
    cursor += 1;
  }
  return cursor;
}

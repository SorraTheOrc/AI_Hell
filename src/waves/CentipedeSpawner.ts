/**
 * Pure planner for the Centipede chain spawn (classic-arcade archetype,
 * AH-0MV01EJ92008ZZ86).
 *
 * A Centipede is a linked chain, not a formation, so it is delivered by a
 * dynamic spawner (the same pattern as the Asteroid/Harvester/Ghost
 * spawners). The chain enters from the top edge and weaves downward. Like
 * the Harvester/Ghost spawners — and unlike the Asteroid — **every segment
 * is registered with the `WaveManager`** by the scene, so the wave neither
 * clears early nor stalls while any segment is alive.
 *
 * This module has **no Phaser dependency**, so the spawn schedule is fully
 * unit-testable and deterministic for a fixed RNG.
 *
 * @module CentipedeSpawner
 */

// ── Archetype + tuning ──────────────────────────────────────────────

/** Enemy-config/archetype key for the Centipede chain. */
export const CENTIPEDE_ENEMY_KEY = 'centipede';

/** Number of linked segments in one chain. */
export const CENTIPEDE_SEGMENT_COUNT = 6;

/** Fixed arc-length between adjacent segments (px). */
export const CENTIPEDE_SEGMENT_SPACING = 24;

/** Horizontal weave speed of a full-strength chain (px/s). */
export const CENTIPEDE_LATERAL_SPEED = 90;

/** Vertical descent speed of a full-strength chain (px/s). */
export const CENTIPEDE_DESCENT_SPEED = 16;

/** Inset from the arena edge the chain spawns/roams within (px). */
export const CENTIPEDE_SPAWN_EDGE_INSET = 96;

/** Earliest spawn time fraction within the wave. */
export const CENTIPEDE_SPAWN_MIN_TIME_FRACTION = 0.1;

/** Latest spawn time fraction within the wave. */
export const CENTIPEDE_SPAWN_MAX_TIME_FRACTION = 0.6;

// ── Types ───────────────────────────────────────────────────────────

/** A single Centipede spawn event computed by the planner. */
export interface CentipedeSpawnEvent {
  /** Enemy-config key for the chain (`'centipede'`). */
  enemyKey: string;
  /** Spawn x (px) of the chain lead, inside the play area. */
  x: number;
  /** Spawn y (px) of the chain lead, inside the play area. */
  y: number;
  /** Number of linked segments in the chain. */
  segmentCount: number;
  /** Initial horizontal direction: `1` right, `-1` left. */
  dir: 1 | -1;
  /** Fraction of the wave time limit at which the chain should spawn. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes the Centipede spawn event for one wave: a single chain entering
 * near the top edge, its lead inside the play area so every segment is
 * immediately reachable (and therefore never stalls wave completion).
 *
 * @param gameWidth — viewport width in px.
 * @param gameHeight — viewport height in px.
 * @param waveTimeLimit — wave duration in seconds.
 * @param rng — deterministic RNG returning [0, 1).
 * @returns the chain spawn event.
 */
export function computeCentipedeSpawn(
  gameWidth: number,
  gameHeight: number,
  waveTimeLimit: number,
  rng: () => number,
): CentipedeSpawnEvent {
  const insetX = Math.min(CENTIPEDE_SPAWN_EDGE_INSET, gameWidth / 2);
  const minX = insetX;
  const maxX = Math.max(minX, gameWidth - insetX);
  const minY = Math.min(CENTIPEDE_SPAWN_EDGE_INSET, gameHeight / 2);

  const x = minX + rng() * (maxX - minX);
  const y = minY;
  const dir: 1 | -1 = rng() < 0.5 ? -1 : 1;

  const span = CENTIPEDE_SPAWN_MAX_TIME_FRACTION - CENTIPEDE_SPAWN_MIN_TIME_FRACTION;
  const timeFraction = CENTIPEDE_SPAWN_MIN_TIME_FRACTION + rng() * span;

  return {
    enemyKey: CENTIPEDE_ENEMY_KEY,
    x,
    y,
    segmentCount: CENTIPEDE_SEGMENT_COUNT,
    dir,
    timeFraction,
    timeSeconds: timeFraction * waveTimeLimit,
  };
}

/** The vertical roam bounds the chain is kept inside for the given viewport. */
export function centipedeArena(gameWidth: number, gameHeight: number): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const inset = CENTIPEDE_SPAWN_EDGE_INSET;
  const minX = Math.min(inset, gameWidth / 2);
  const maxX = Math.max(minX, gameWidth - inset);
  const minY = Math.min(inset, gameHeight / 2);
  const maxY = Math.max(minY, gameHeight - inset);
  return { minX, minY, maxX, maxY };
}

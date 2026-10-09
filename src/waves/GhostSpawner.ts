/**
 * Pure planner for Pac-Man ghost grouping spawns (classic-arcade archetype,
 * AH-0MV01EH2U008XT3Q).
 *
 * The four personalities are a coordinated group: they enter the arena from
 * the edges, spread across the first third of the wave, and then pursue with
 * their own targeting rules. Like the asteroid/harvester planners this module
 * has **no Phaser dependency** so the spawn schedule is fully unit-testable
 * and deterministic for a fixed RNG.
 *
 * Unlike the Asteroid (which is explicitly *not* wave-accounted), every ghost
 * this planner releases **is** registered with the `WaveManager`
 * (`registerDynamicSpawn`), so the wave neither clears early nor stalls while
 * a ghost is alive (the same invariant as the Harvester spawner).
 *
 * @module GhostSpawner
 */

import {
  GHOST_PERSONALITIES,
  type GhostPersonality,
} from '../scenes/core/ghostSteering';

// ── Archetype keys ──────────────────────────────────────────────────

/**
 * The committed enemy-config key for each personality. One CSV row per
 * personality keeps the tuning data-driven and lets the single `GymEnemies`
 * scene exercise every personality independently.
 */
export const GHOST_ARCHETYPE_BY_PERSONALITY: Record<GhostPersonality, string> = {
  chase: 'ghost-chase',
  ambush: 'ghost-ambush',
  flank: 'ghost-flank',
  wander: 'ghost-wander',
};

/** Every ghost archetype key, in personality order. */
export const GHOST_ENEMY_KEYS: readonly string[] = GHOST_PERSONALITIES.map(
  (p) => GHOST_ARCHETYPE_BY_PERSONALITY[p],
);

// ── Tuning ──────────────────────────────────────────────────────────

/** Inset from the arena edge at which a ghost spawns (px) — always reachable. */
export const GHOST_SPAWN_EDGE_INSET = 70;

/** Earliest spawn time fraction within the wave. */
export const GHOST_SPAWN_MIN_TIME_FRACTION = 0.05;

/** Latest spawn time fraction within the wave. */
export const GHOST_SPAWN_MAX_TIME_FRACTION = 0.35;

/** Maximum ghosts released per wave (one per personality). */
export const GHOST_MAX_PER_WAVE = GHOST_PERSONALITIES.length;

// ── Types ───────────────────────────────────────────────────────────

/** A single ghost spawn event computed by the planner. */
export interface GhostSpawnEvent {
  /** Enemy-config key for the personality (e.g. `ghost-ambush`). */
  enemyKey: string;
  /** The personality this ghost steers with. */
  personality: GhostPersonality;
  /** Spawn x (px), inside the play area. */
  x: number;
  /** Spawn y (px), inside the play area. */
  y: number;
  /** Fraction of the wave time limit at which this ghost should spawn. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes the ghost spawn events for one wave: exactly one ghost per
 * personality ({@link GHOST_MAX_PER_WAVE}), each entering from a different
 * arena edge and spread across the first third of the wave's time limit.
 *
 * Positions are inset inside the play area so every spawned ghost is
 * immediately reachable and therefore never stalls the wave (the wave is
 * only complete once every released, wave-accounted ghost is destroyed).
 *
 * @param gameWidth — viewport width in px.
 * @param gameHeight — viewport height in px.
 * @param waveTimeLimit — wave duration in seconds.
 * @param rng — deterministic RNG returning [0, 1).
 * @returns one spawn event per personality, ordered by personality.
 */
export function computeGhostSpawns(
  gameWidth: number,
  gameHeight: number,
  waveTimeLimit: number,
  rng: () => number,
): GhostSpawnEvent[] {
  const inset = GHOST_SPAWN_EDGE_INSET;
  const minX = Math.min(inset, gameWidth / 2);
  const maxX = Math.max(minX, gameWidth - inset);
  const minY = Math.min(inset, gameHeight / 2);
  const maxY = Math.max(minY, gameHeight - inset);

  const count = GHOST_PERSONALITIES.length;
  const timeSpan = GHOST_SPAWN_MAX_TIME_FRACTION - GHOST_SPAWN_MIN_TIME_FRACTION;

  return GHOST_PERSONALITIES.map((personality, index) => {
    // One edge per personality (top, right, bottom, left) so the group
    // enters from all sides; the along-edge position is jittered.
    const edge = index % 4;
    let x: number;
    let y: number;
    switch (edge) {
      case 0: // top
        x = minX + rng() * (maxX - minX);
        y = minY;
        break;
      case 1: // right
        x = maxX;
        y = minY + rng() * (maxY - minY);
        break;
      case 2: // bottom
        x = minX + rng() * (maxX - minX);
        y = maxY;
        break;
      default: // left
        x = minX;
        y = minY + rng() * (maxY - minY);
        break;
    }

    // Spread evenly across the window with a small deterministic jitter.
    const anchor = count > 1 ? index / (count - 1) : 0;
    const jitter = (rng() * 2 - 1) * (timeSpan / (count * 4));
    const timeFraction = Math.max(
      GHOST_SPAWN_MIN_TIME_FRACTION,
      Math.min(GHOST_SPAWN_MAX_TIME_FRACTION, GHOST_SPAWN_MIN_TIME_FRACTION + anchor * timeSpan + jitter),
    );

    return {
      enemyKey: GHOST_ARCHETYPE_BY_PERSONALITY[personality],
      personality,
      x,
      y,
      timeFraction,
      timeSeconds: timeFraction * waveTimeLimit,
    };
  });
}

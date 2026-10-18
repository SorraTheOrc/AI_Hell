/**
 * Pure planner for Pac-Man ghost grouping spawns (classic-arcade archetype,
 * AH-0MV01EH2U008XT3Q; group-spawn behaviour AH-0MV9G78DO0053MGK).
 *
 * The four personalities are a coordinated group: they enter the arena as a
 * single tight cluster from one common entry point and are released within a
 * narrow time window, then pursue with their own targeting rules. Like the
 * asteroid/harvester planners this module has **no Phaser dependency** so the
 * spawn schedule is fully unit-testable and deterministic for a fixed RNG.
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
 * personality keeps the tuning data-driven and lets the single `GymFodderEnemies`
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

/** Inset from the arena edge at which a ghost may tread (px) — always reachable. */
export const GHOST_SPAWN_EDGE_INSET = 70;

/** Horizontal centre of the group's single entry point (fraction of arena width). */
export const GHOST_GROUP_ENTRY_X_FRACTION = 0.5;

/**
 * Vertical centre of the group's single entry point (fraction of arena
 * height). Kept away from the arena edges and from the player's central
 * spawn so the pack is never on top of the ship.
 */
export const GHOST_GROUP_ENTRY_Y_FRACTION = 0.25;

/** Max distance (px) of any ghost from the group's entry point (tight pack). */
export const GHOST_GROUP_CLUSTER_RADIUS = 42;

/**
 * Delay (seconds) from wave start before the first ghost of the group
 * enters. The pack appears as one unit shortly after the wave begins — the
 * delay only sets *when* the group enters, never how spread out it is.
 */
export const GHOST_GROUP_ENTRY_DELAY_SECONDS = 1.5;

/**
 * The whole group's release window (seconds): every ghost spawns within this
 * single narrow window (well under a second), so the pack enters together
 * instead of being staggered across the wave.
 */
export const GHOST_GROUP_RELEASE_WINDOW_SECONDS = 0.09;

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

/** Clamps `v` into [`lo`, `hi`], keeping every spawn inside the play area. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes the ghost spawn events for one wave: exactly one ghost per
 * personality ({@link GHOST_MAX_PER_WAVE}), all clustered around a single
 * common entry point and released within {@link GHOST_GROUP_RELEASE_WINDOW_SECONDS}.
 *
 * Positions are inset inside the play area so every spawned ghost is
 * immediately reachable and therefore never stalls the wave (the wave is
 * only complete once every released, wave-accounted ghost is destroyed).
 * Only the spawn planner changes — each ghost keeps its personality steering,
 * behaviour and entity config, so the group is observationally identical to a
 * hand-placed set of individual ghosts (gym↔game parity).
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
  const count = GHOST_PERSONALITIES.length;

  // Single common entry point, clamped inside the reachable play area so the
  // group stays in bounds even on very small arenas.
  const inset = GHOST_SPAWN_EDGE_INSET;
  const minX = Math.min(inset, gameWidth / 2);
  const maxX = Math.max(minX, gameWidth - inset);
  const minY = Math.min(inset, gameHeight / 2);
  const maxY = Math.max(minY, gameHeight - inset);
  const entryX = clamp(GHOST_GROUP_ENTRY_X_FRACTION * gameWidth, minX, maxX);
  const entryY = clamp(GHOST_GROUP_ENTRY_Y_FRACTION * gameHeight, minY, maxY);

  // The cluster radius must never push a ghost past the play-area bounds.
  const clusterRadius = Math.max(
    0,
    Math.min(
      GHOST_GROUP_CLUSTER_RADIUS,
      entryX - minX,
      maxX - entryX,
      entryY - minY,
      maxY - entryY,
    ),
  );

  return GHOST_PERSONALITIES.map((personality, index) => {
    // Place each ghost on its own spoke of the cluster so the pack reads as a
    // group rather than a single overlapping sprite; the ring radius is
    // jittered by the RNG (deterministic for a fixed sequence).
    const angle =
      (index / count) * Math.PI * 2 + (rng() * 2 - 1) * ((Math.PI / count) * 0.4);
    const radius = clusterRadius * (0.55 + 0.45 * rng());
    const x = clamp(entryX + Math.cos(angle) * radius, minX, maxX);
    const y = clamp(entryY + Math.sin(angle) * radius, minY, maxY);

    // Narrow release window: the pack enters together within one named
    // constant (well under a second), after a short fixed entry delay so the
    // group appears as a beat rather than synchronously with the wave start.
    const span = count > 1 ? index / (count - 1) : 0;
    const timeSeconds =
      GHOST_GROUP_ENTRY_DELAY_SECONDS +
      span * GHOST_GROUP_RELEASE_WINDOW_SECONDS;
    const timeFraction = waveTimeLimit > 0 ? timeSeconds / waveTimeLimit : 0;

    return {
      enemyKey: GHOST_ARCHETYPE_BY_PERSONALITY[personality],
      personality,
      x,
      y,
      timeFraction,
      timeSeconds,
    };
  });
}

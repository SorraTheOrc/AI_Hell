/**
 * Pure planner for rare roaming Harvester spawns in the later campaign
 * levels (parent AH-0MUI820PM0038HS2, feature F6).
 *
 * The Harvester is a memorable mineral-denial threat, not constant noise, so
 * it is spawned rarely and only in the two hardest regular levels. Unlike the
 * Asteroid spawner, Harvester spawns **are** registered with the WaveManager
 * (they gate wave completion), so the planner must never produce a spawn that
 * cannot be reached — hence an on-screen edge inset rather than a fully
 * offscreen origin (the Harvester holds station when no mineral is present).
 *
 * No Phaser runtime dependency — all logic is pure TypeScript so it is fully
 * unit-testable and shared by the static and sequenced campaigns.
 *
 * @module HarvesterSpawner
 */

// ── Tuning constants ────────────────────────────────────────────────

/** First level in which the Harvester may appear (inclusive). */
export const HARVESTER_MIN_LEVEL = 4;

/** Last level in which the Harvester may appear (inclusive). */
export const HARVESTER_MAX_LEVEL = 5;

/** Maximum Harvesters per wave (rare, bounded). */
export const HARVESTER_MAX_PER_WAVE = 1;

/** Probability that a qualifying wave rolls a Harvester (rare). */
export const HARVESTER_SPAWN_CHANCE = 0.35;

/** Inset from the screen edge at which a Harvester spawns (px). */
export const HARVESTER_SPAWN_EDGE_INSET = 60;

/** Earliest spawn time fraction within the wave. */
export const HARVESTER_SPAWN_MIN_TIME_FRACTION = 0.2;

/** Latest spawn time fraction within the wave. */
export const HARVESTER_SPAWN_MAX_TIME_FRACTION = 0.7;

// ── Types ───────────────────────────────────────────────────────────

/** A single Harvester spawn event computed by the planner. */
export interface HarvesterSpawnEvent {
  /** Spawn x coordinate (px), inside the play area near an edge. */
  x: number;
  /** Spawn y coordinate (px), inside the play area near an edge. */
  y: number;
  /** Fraction of the wave time limit at which this Harvester should spawn. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes the Harvester spawn events for one wave.
 *
 * Rules:
 * 1. **Level gate** — no spawns outside Levels 4–5.
 * 2. **Rarity** — a single bounded roll per wave; at most one Harvester.
 * 3. **Placement** — a random screen edge, inset inside the play area so the
 *    spawn is always reachable and wave-accounted (never stalls offscreen).
 * 4. **Timing** — a mid-wave time fraction in
 *    [`HARVESTER_SPAWN_MIN_TIME_FRACTION`, `HARVESTER_SPAWN_MAX_TIME_FRACTION`].
 *
 * @param level — 1-based campaign level number.
 * @param gameWidth — viewport width in px.
 * @param gameHeight — viewport height in px.
 * @param waveTimeLimit — wave duration in seconds.
 * @param rng — deterministic random-number generator (returns [0, 1)).
 * @returns the spawn events for this wave (empty when not eligible).
 */
export function computeHarvesterSpawns(
  level: number,
  gameWidth: number,
  gameHeight: number,
  waveTimeLimit: number,
  rng: () => number,
): HarvesterSpawnEvent[] {
  if (level < HARVESTER_MIN_LEVEL || level > HARVESTER_MAX_LEVEL) return [];

  // Rare bounded roll.
  if (rng() >= HARVESTER_SPAWN_CHANCE) return [];

  const inset = HARVESTER_SPAWN_EDGE_INSET;
  const minX = inset;
  const maxX = Math.max(minX, gameWidth - inset);
  const minY = inset;
  const maxY = Math.max(minY, gameHeight - inset);

  // Random edge, then a random position along that edge (inside the field).
  const edge = Math.floor(rng() * 4);
  let x: number;
  let y: number;
  switch (edge) {
    case 0: // top
      x = minX + rng() * (maxX - minX);
      y = minY;
      break;
    case 1: // bottom
      x = minX + rng() * (maxX - minX);
      y = maxY;
      break;
    case 2: // left
      x = minX;
      y = minY + rng() * (maxY - minY);
      break;
    default: // right
      x = maxX;
      y = minY + rng() * (maxY - minY);
      break;
  }

  const span = HARVESTER_SPAWN_MAX_TIME_FRACTION - HARVESTER_SPAWN_MIN_TIME_FRACTION;
  const timeFraction =
    HARVESTER_SPAWN_MIN_TIME_FRACTION + rng() * span;

  return [
    {
      x,
      y,
      timeFraction,
      timeSeconds: timeFraction * waveTimeLimit,
    },
  ];
}

/**
 * Pure planner for random offscreen asteroid spawning.
 *
 * Computes when and where asteroids should spawn based on the global wave
 * index. No Phaser runtime dependency — all logic is pure TypeScript so it
 * is fully unit-testable.
 *
 * The spawner drives the escalating hazard described in the GDD §4.2 wave
 * structure: every regular wave spawns asteroids from offscreen edges that
 * drift inward. The frequency and large-weight increase with each wave,
 * creating a slow escalation without sudden spikes.
 *
 * @module AsteroidSpawner
 */

// ── Tuning constants ────────────────────────────────────────────────

/** Baseline asteroids spawned per wave. */
export const ASTEROID_SPAWN_BASE_COUNT = 2;

/** Baseline large-asteroid weight (out of 100). */
export const ASTEROID_SPAWN_BASE_LARGE_WEIGHT = 20;

/** Medium-asteroid weight (fixed at 80). */
export const ASTEROID_SPAWN_MEDIUM_WEIGHT = 80;

/** Increment added to the large weight each wave. */
export const ASTEROID_SPAWN_LARGE_WEIGHT_INCREMENT = 20;

/** Large-weight threshold that triggers a reset + count-doubling. */
export const ASTEROID_SPAWN_LARGE_WEIGHT_RESET = 160;

/** Jitter fraction applied to spawn timing (±5 %). */
export const ASTEROID_SPAWN_JITTER_FRACTION = 0.05;

/** Maximum allowed spawn time fraction. */
export const ASTEROID_SPAWN_MAX_JITTER_FRACTION = 0.95;

/** Maximum spawn time fraction for the first asteroid (first 10 %). */
export const ASTEROID_SPAWN_FIRST_ASTEROID_MAX_FRACTION = 0.10;

/** Inward angular spread in radians (±30°). */
export const ASTEROID_SPAWN_INWARD_ANGULAR_SPREAD = Math.PI / 6;

/** Extra px beyond the asteroid half-size for offscreen margin. */
export const ASTEROID_SPAWN_OUTWARD_MARGIN = 10;

// ── Size-tier constants (mirrors Asteroid.ts — kept local for purity) ─

/** Large asteroid half-size in px. */
const ASTEROID_LARGE_SIZE = 42;

/** Medium asteroid half-size in px. */
const ASTEROID_MEDIUM_SIZE = 27;

/** Large asteroid speed in px/s. */
const ASTEROID_LARGE_SPEED = 18;

/** Medium asteroid speed in px/s. */
const ASTEROID_MEDIUM_SPEED = 27;

// ── Types ───────────────────────────────────────────────────────────

/**
 * A single asteroid spawn event computed by the planner.
 */
export interface SpawnEvent {
  /** Size tier of the spawned asteroid. */
  sizeTier: 'large' | 'medium';
  /** Spawn x coordinate (px), fully offscreen. */
  x: number;
  /** Spawn y coordinate (px), fully offscreen. */
  y: number;
  /** Velocity x component (px/s). */
  vx: number;
  /** Velocity y component (px/s). */
  vy: number;
  /** Fraction of the wave time limit at which this asteroid should spawn. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Returns the half-size for the given tier.
 */
function tierHalfSize(tier: 'large' | 'medium'): number {
  return tier === 'large' ? ASTEROID_LARGE_SIZE : ASTEROID_MEDIUM_SIZE;
}

/**
 * Returns the canonical speed for the given tier.
 */
function tierSpeed(tier: 'large' | 'medium'): number {
  return tier === 'large' ? ASTEROID_LARGE_SPEED : ASTEROID_MEDIUM_SPEED;
}

/**
 * Edge index → perpendicular (inward) angle in screen coords.
 *
 * Screen-angle convention: 0 = right, π/2 = down, π = left, 3π/2 = up.
 */
const INWARD_ANGLES: Record<number, number> = {
  0: Math.PI / 2, // top edge → inward down
  1: -Math.PI / 2, // bottom edge → inward up
  2: 0, // left edge → inward right
  3: Math.PI, // right edge → inward left
};

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes spawn events for a single wave.
 *
 * The algorithm:
 *
 * 1. **Count** starts at 2 and doubles every 8 waves (when the large
 *    weight reaches the reset threshold).
 * 2. **Weight escalation**: medium weight = 80 (fixed), large weight
 *    = 20 + 20 × (wave % 8), capped at 160 where it resets.
 * 3. **Timing**: N asteroids divide the wave into N equal segments
 *    with ±5 % jitter, clamped to [0, 0.95]; first asteroid within
 *    the first 10 %.
 * 4. **Offscreen origin**: random edge, outward margin, inward velocity
 *    with ±30° spread at the tier's canonical speed.
 *
 * @param globalWaveIndex — cumulative 0-based wave index across the campaign.
 * @param gameWidth — viewport width in px.
 * @param gameHeight — viewport height in px.
 * @param waveTimeLimit — wave duration in seconds.
 * @param rng — deterministic random number generator (returns [0, 1)).
 * @returns spawn events for this wave.
 */
export function computeSpawns(
  globalWaveIndex: number,
  gameWidth: number,
  gameHeight: number,
  waveTimeLimit: number,
  rng: () => number,
): SpawnEvent[] {
  // 1. Per-wave count
  const cycles = Math.floor((globalWaveIndex + 1) / 8);
  const count = ASTEROID_SPAWN_BASE_COUNT * (2 ** cycles);

  // 2. Size weighting
  let largeWeight =
    ASTEROID_SPAWN_BASE_LARGE_WEIGHT +
    ASTEROID_SPAWN_LARGE_WEIGHT_INCREMENT * (globalWaveIndex % 8);
  if (largeWeight >= ASTEROID_SPAWN_LARGE_WEIGHT_RESET) {
    largeWeight = ASTEROID_SPAWN_BASE_LARGE_WEIGHT; // reset
  }

  // 3. Spawn timing
  const timeFractions: number[] = [];
  for (let i = 0; i < count; i++) {
    const anchor = i / count;
    const jitter = (rng() * 2 - 1) * ASTEROID_SPAWN_JITTER_FRACTION;
    let fraction = anchor + jitter;
    // Clamp to [0, 0.95]
    fraction = Math.max(0, Math.min(ASTEROID_SPAWN_MAX_JITTER_FRACTION, fraction));
    // First asteroid constrained to [0, 0.10]
    if (i === 0) {
      fraction = Math.max(0, Math.min(ASTEROID_SPAWN_FIRST_ASTEROID_MAX_FRACTION, fraction));
    }
    timeFractions.push(fraction);
  }
  // Sort to guarantee ordering
  timeFractions.sort((a, b) => a - b);

  // 4. Generate spawn events
  const events: SpawnEvent[] = [];
  for (let i = 0; i < count; i++) {
    // Choose size tier from weighted draw
    const roll = rng() * (ASTEROID_SPAWN_MEDIUM_WEIGHT + largeWeight);
    const sizeTier: 'large' | 'medium' = roll < largeWeight ? 'large' : 'medium';
    const halfSize = tierHalfSize(sizeTier);
    const speed = tierSpeed(sizeTier);

    // Choose random edge (uniform over 4 edges)
    const edge = Math.floor(rng() * 4);

    let x: number, y: number, vx: number, vy: number;
    const inwardAngle = INWARD_ANGLES[edge] ?? 0;
    const jitter = (rng() * 2 - 1) * ASTEROID_SPAWN_INWARD_ANGULAR_SPREAD;
    const angle = inwardAngle + jitter;

    switch (edge) {
      case 0: // Top edge → inward = down
        x = rng() * gameWidth;
        y = -(halfSize + ASTEROID_SPAWN_OUTWARD_MARGIN);
        vx = speed * Math.cos(angle);
        vy = speed * Math.sin(angle);
        break;

      case 1: // Bottom edge → inward = up
        x = rng() * gameWidth;
        y = gameHeight + halfSize + ASTEROID_SPAWN_OUTWARD_MARGIN;
        vx = speed * Math.cos(angle);
        vy = speed * Math.sin(angle);
        break;

      case 2: // Left edge → inward = right
        x = -(halfSize + ASTEROID_SPAWN_OUTWARD_MARGIN);
        y = rng() * gameHeight;
        vx = speed * Math.cos(angle);
        vy = speed * Math.sin(angle);
        break;

      default: // Right edge → inward = left
        x = gameWidth + halfSize + ASTEROID_SPAWN_OUTWARD_MARGIN;
        y = rng() * gameHeight;
        vx = speed * Math.cos(angle);
        vy = speed * Math.sin(angle);
        break;
    }

    events.push({
      sizeTier,
      x,
      y,
      vx,
      vy,
      timeFraction: timeFractions[i],
      timeSeconds: timeFractions[i] * waveTimeLimit,
    });
  }

  return events;
}

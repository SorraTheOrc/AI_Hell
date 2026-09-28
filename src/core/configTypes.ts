/**
 * Shared configuration types (AH-0MTZWZ9TE009CVUA).
 *
 * Leaf module (no imports) so the CSV codec and the Vite plugin can use the
 * config shapes without pulling in `configStore.ts` (whose `?raw` CSV imports
 * would break the Vite config loader).
 */

// ── Enemy shot-pattern / formation-kind enums ──────────────────────

export type EnemyShotPattern =
  | 'none'
  | 'aimed'
  | 'spread'
  | 'radial'
  | 'orbital'
  | 'coordinated';

// Single source of truth for formation kinds lives in `src/utils/formations.ts`
// (`EnemyFormationKind`). Re-exported here so callers can import from either
// place without creating a circular dep (both are leaf modules).
export type EnemyFormationKind = 'v' | 'diver' | 'rect' | 'swarm' | 'orbital' | 'single';

/**
 * JSON-serializable enemy archetype. Only persisted fields are present
 * here; per-entity animation/runtime state (e.g. wiggle phase, dive
 * progress, return phase) is NOT serialized.
 */
export interface EnemyConfig {
  /** Stable, slug key — also the localStorage suffix (lowercase, hyphenated). */
  key: string;
  /** Human-readable name shown in the gym index / editor panel. */
  displayName: string;

  // Formation / placement
  /** Which builder to use from `src/utils/formations.ts`. */
  formationKind: EnemyFormationKind;
  /** Enemy count in the formation. */
  count: number;
  /** Horizontal spacing between formation slots (px). */
  spacingX: number;
  /** Vertical spacing between formation slots (px). */
  spacingY: number;
  /** Rightward drift speed of the formation (px/s). */
  driftSpeed: number;
  /** Initial base position (px). */
  startX: number;
  startY: number;
  /**
   * Minimum spawn X (px) for this enemy archetype. When `startXMin` differs
   * from `startXMax`, each wave group selects a random base X within
   * `[startXMin, startXMax]`. When they are equal (or absent), the base
   * equals `startX` — preserving the current single-point behaviour.
   */
  startXMin?: number;
  /**
   * Maximum spawn X (px) for this enemy archetype. See {@link startXMin}.
   */
  startXMax?: number;
  /**
   * Minimum spawn Y (px) for this enemy archetype. When `startYMin` differs
   * from `startYMax`, each wave group selects a random base Y within
   * `[startYMin, startYMax]`. When they are equal (or absent), the base
   * equals `startY` — preserving the current single-point behaviour.
   */
  startYMin?: number;
  /**
   * Maximum spawn Y (px) for this enemy archetype. See {@link startYMin}.
   */
  startYMax?: number;

  // Entity health
  /**
   * Hit points before the enemy is destroyed. Data-driven (AH-0MUI820PM0038HS2);
   * defaults to `1` so every single-hit archetype is unchanged. Values must be
   * positive integers — the CSV codec validates and coerces invalid input.
   */
  health: number;

  // Entity visuals / motion
  /** Body radius / half-size in px. */
  size: number;
  /** Body colour as a 0xRRGGBB number. */
  color: number;
  /** Bullet/body details for the entity type. */
  bulletColor: number;
  bulletSize: number;

  // Shot / bullet behaviour (shared across entity seam)
  shotPattern: EnemyShotPattern;
  /** Milliseconds between volleys (entity-level fire interval). */
  fireInterval: number;
  /** Bullet speed (px/s). */
  bulletSpeed: number;
  /** Bullet lifetime in seconds. */
  bulletLifetime: number;
  /** Burst / radial-spoke count. */
  burstCount: number;
  /** Chance (fraction `0.0`–`1.0`) that an individual enemy fires per cycle. */
  shotProbability: number;

  /**
   * Extensible passthrough — future tuning axes can be added here without
   * breaking JSON compatibility. Unknown fields are preserved on merge.
   */
  [extra: string]: unknown;
}

/**
 * Resolved inclusive spawn band for one axis. `min === max` denotes the
 * legacy scalar behaviour (no randomness).
 */
export interface SpawnRange {
  min: number;
  max: number;
}

/**
 * Resolves an enemy archetype's effective spawn range on a single axis.
 *
 * Backward compatibility (AH-0MUKCLXLW0032R67): when the optional `min`/`max`
 * bounds are absent, the scalar `start` value is used for that bound, so
 * callers never need null checks and legacy configs keep spawning at exactly
 * `start`. Reversed bounds (`min > max`) are normalised by swapping so the
 * returned {@link SpawnRange} always satisfies `min <= max`.
 *
 * @param start — scalar legacy base position on this axis (px).
 * @param min — optional configured minimum bound (px).
 * @param max — optional configured maximum bound (px).
 */
export function resolveSpawnRange(
  start: number,
  min: number | undefined,
  max: number | undefined,
): SpawnRange {
  const lo = min ?? start;
  const hi = max ?? start;
  return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
}

/**
 * Picks a value inside a {@link SpawnRange} using the supplied RNG.
 *
 * A degenerate range (`min === max`) returns `min` verbatim so a zero-width
 * band never advances the RNG stream — this keeps the legacy scalar path
 * fully deterministic. The RNG is expected to return a value in `[0, 1)`.
 *
 * @param range — inclusive `[min, max]` band (already normalised).
 * @param rng — RNG returning a fraction in `[0, 1)`.
 */
export function pickInRange(range: SpawnRange, rng: () => number): number {
  if (range.max <= range.min) return range.min;
  return range.min + rng() * (range.max - range.min);
}

// ── Difficulty-curve config ─────────────────────────────────────────

/**
 * Per-level source selector for a difficulty-curve level
 * (AH-0MUH7Q6HN0006QPD). `generated` levels come from the runtime
 * auto-sequencer; `scripted` levels are taken verbatim from the static
 * `LEVELS` campaign and are never passed to the sequencer.
 */
export type DifficultySource = 'generated' | 'scripted';

/**
 * One (level, wave) row of the data-driven difficulty curve
 * (AH-0MUH6LEYY0054E63). The curve length of a level (its number of rows)
 * defines that level's wave count; `levelName` supplies the level's theme
 * name. Kept in this leaf module so the CSV codec and the Vite plugin can
 * use the shape without pulling in `configStore.ts`.
 */
export interface DifficultyCurveRow {
  /** 1-based level number (the configured campaign skeleton is data-driven). */
  level: number;
  /** Human-readable level theme name, e.g. `The Core`. */
  levelName: string;
  /** 1-based wave number within the level. */
  wave: number;
  /** Target difficulty score for this wave (0–100, same scale as the sequencer). */
  targetDifficulty: number;
  /**
   * Per-level source selector (AH-0MUH7Q6HN0006QPD). Defaults to
   * `generated` when absent. All rows of one level must agree; conflicting
   * values make the level (and its file) malformed. Ignored for `scripted`
   * rows, whose waves come from the static `LEVELS` definition instead.
   */
  source?: DifficultySource;
}

// ── Ship config ─────────────────────────────────────────────────────

export type ControlScheme = 'fourDirectional' | 'asteroids';

export interface ShipConfig {
  /** Acceleration applied each second a thrust direction is held (px/s²). */
  thrustAcceleration: number;
  /** Absolute speed cap to prevent unbounded acceleration (px/s). */
  maxSpeed: number;
  /** Ship size used for visual rendering and physics bounds (px). */
  shipSize: number;
  /** Thrust flame length multiplier relative to ship size. */
  thrustFlameLength: number;
  /** Ship colour — neon cyan per the GDD art direction. */
  shipColor: number;
  /** Thrust flame colour — hot orange/yellow. */
  thrustFlameColor: number;
  /** Inner flame colour — bright yellow. */
  thrustFlameInnerColor: number;
  /** Linear deceleration rate (px/s²) when no direction keys are held; 0 = zero friction. */
  frictionDeceleration: number;
  /** Control scheme: 'fourDirectional' (WASD → thrust) or 'asteroids' (W → forward, A/S → turn). */
  controlScheme: ControlScheme;
  /** Rotation speed in radians/s for the Asteroids control scheme. */
  asteroidsRotationSpeed: number;
}

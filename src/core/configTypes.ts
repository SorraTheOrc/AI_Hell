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

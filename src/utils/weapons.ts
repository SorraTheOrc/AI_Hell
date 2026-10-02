/**
 * Weapon catalogue + heading-relative angle math (GDD §2.3, §4.4).
 *
 * Provides pure, unit-testable weapon definitions — each with a pattern
 * (relative angle offsets), fire rate, bullet colour, and bullet shape —
 * plus utilities to convert a heading into absolute bullet angles and
 * velocities.
 *
 * Weapons are **cumulative and timed** (GDD §4.4 revision): collecting a
 * weapon power-up (Spread, Dual, Rapid) **adds** it to the ship's active
 * set for **10 seconds** (each with its own independent countdown from the
 * moment of collection), after which it expires and stops firing. The
 * **cannon** is the permanent starting weapon — always active, never
 * expires; a **reset** power-up clears all timed weapons, leaving only the
 * cannon.
 *
 * Four weapons:
 * - **cannon** — single bullet straight ahead (permanent default starting weapon)
 * - **spread** — 3-bullet fan at -30° / 0° / +30° relative to heading (timed)
 * - **dual**   — 2 bullets offset perpendicular (±90°) to heading (timed)
 * - **rapid**  — single bullets at a much higher fire rate (timed)
 *
 * Distances use **radians** for math (Phaser convention, positive =
 * clockwise); the scene-facing helpers (`createBulletsFromHeading`,
 * `angleToVelocity`) accept heading in **degrees** for readability.
 *
 * Fire rates are **beat subdivisions** (AH-0MUAYB8EH005RJ8B): each weapon's
 * interval is an exact fraction of the shared 80 BPM beat period, derived
 * from the pure beat-clock module (`utils/beat.ts`) rather than hard-coded.
 * This keeps every current and future weapon on-grid by construction, and
 * `isOnBeatGrid` is the catalogue-wide invariant that guards it.
 */

import {
  DEFAULT_BPM,
  beatPeriodMs,
  beatSubdivisionMs,
} from './beat';

// ── Weapon IDs ───────────────────────────────────────────────────────

/**
 * Unique weapon identifiers. `'cannon'` is the starting weapon; the
 * `'reset'` drop type returns the ship to it (not a weapon itself).
 *
 * The `'nova' | 'mortar' | 'arc'` ids are the **area-of-effect (AOE)**
 * family (parent AH-0MUOOB3OR001V8CD): each carries an {@link AoEDescriptor}
 * that the shared combat core reads to resolve its area effect.
 */
export type WeaponId =
  | 'cannon'
  | 'spread'
  | 'dual'
  | 'rapid'
  | 'nova'
  | 'mortar'
  | 'arc';

// ── AOE descriptors ─────────────────────────────────────────────────

/**
 * When an area-of-effect weapon resolves its effect:
 * - `'onFire'` — the area resolves at the ship the instant the weapon fires
 *   (e.g. an expanding nova ring or a chaining arc — no travelling shot).
 * - `'onImpact'` — the weapon launches a projectile whose area resolves when
 *   it hits an enemy/bullet or expires (e.g. a mortar shell).
 */
export type AoETrigger = 'onFire' | 'onImpact';

/**
 * Declarative area-of-effect descriptor attached to an AOE weapon
 * (parent AH-0MUOOB3OR001V8CD). The shared combat core reads it once and
 * resolves the effect identically in the game and every gym — the descriptor
 * carries only data, never behaviour.
 */
export interface AoEDescriptor {
  /** When the area effect resolves (see {@link AoETrigger}). */
  trigger: AoETrigger;
  /** Effect radius in pixels, measured from the effect origin. */
  radius: number;
  /** Whether the effect damages enemies inside the radius. */
  damagesEnemies: boolean;
  /** Whether the effect clears enemy bullets inside the radius. */
  clearsEnemyBullets: boolean;
  /**
   * Maximum number of additional targets an `'onFire'` effect may chain to
   * after the primary target (0/undefined = no chaining). Reserved for the
   * Arc weapon's chain mechanic.
   */
  chains?: number;
  /**
   * Projectile speed (px/s) for an `'onImpact'` weapon. The shared auto-fire
   * loop launches the projectile at this speed; when omitted it falls back to
   * the shared `BULLET_SPEED`. An `'onFire'` descriptor never launches a
   * projectile, so the field is ignored for it.
   */
  projectileSpeed?: number;
}

/**
 * The AOE weapon ids, in catalogue order. Exposed so dispatch and tests can
 * iterate the family without hard-coding the membership list.
 */
export const AOE_WEAPON_IDS: readonly WeaponId[] = ['nova', 'mortar', 'arc'];

/** Returns true when `id` is an AOE weapon (carries an {@link AoEDescriptor}). */
export function isAoeWeapon(id: WeaponId): boolean {
  return AOE_WEAPON_IDS.includes(id);
}

/**
 * Returns true when the weapon is a timed power-up (Spread, Dual, Rapid)
 * — collected weapons that expire after `WEAPON_TIMEOUT_MS`. The cannon
 * is the only permanent weapon (never expires).
 */
export function isTimedWeapon(id: WeaponId): boolean {
  return id !== 'cannon';
}

// ── Tunable weapon constants (fire rates, bullet tuning) ────────────

/**
 * Shots per beat for each weapon — the musical subdivision that defines
 * its fire rate. The cannon is double-time (2/beat, 160 BPM); spread and
 * dual are whole-time (1/beat, 80 BPM); rapid is six-per-beat (6/beat,
 * 480 BPM). These are the **defaults**; the live values are configurable
 * through `core/rules.ts` (`weaponSubdivisions`), and every fire rate is
 * derived from them so it is an exact subdivision of the beat period
 * (AH-0MUAYB8EH005RJ8B).
 */
export type WeaponSubdivisions = Record<WeaponId, number>;

/**
 * Default shots-per-beat for each weapon. The four conventional weapons are
 * integer subdivisions (cannon 2, spread 1, dual 1, rapid 6). The AOE family
 * fires **slower than the beat**, so its entries are fractional subdivisions:
 * Nova fires once every 4 beats (`0.25`), Mortar once every 2 beats (`0.5`)
 * and Arc once per beat (`1`). `beatSubdivisionMs` accepts any positive
 * number, and every derived rate stays an exact subdivision/multiple of the
 * beat, so the on-grid invariant holds for the whole catalogue.
 */
export const DEFAULT_WEAPON_SUBDIVISIONS: WeaponSubdivisions = {
  cannon: 2,
  spread: 1,
  dual: 1,
  rapid: 6,
  nova: 0.25,
  mortar: 0.5,
  arc: 1,
};

/** Default cannon subdivision (2 shots per beat). */
export const WEAPON_CANNON_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.cannon;
/** Default spread subdivision (1 shot per beat). */
export const WEAPON_SPREAD_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.spread;
/** Default dual subdivision (1 shot per beat). */
export const WEAPON_DUAL_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.dual;
/** Default rapid subdivision (6 shots per beat). */
export const WEAPON_RAPID_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.rapid;
/** Default Nova subdivision (once every 4 beats → 3000 ms at 80 BPM). */
export const WEAPON_NOVA_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.nova;
/** Default Mortar subdivision (once every 2 beats → 1500 ms at 80 BPM). */
export const WEAPON_MORTAR_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.mortar;
/** Default Arc subdivision (once per beat → 750 ms at 80 BPM). */
export const WEAPON_ARC_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.arc;

/**
 * Derives a weapon's fire interval (ms) from a subdivision of the beat:
 * `beatPeriodMs(bpm) / subdivisions`. Every rate is therefore an exact
 * subdivision of the beat by construction, so the catalogue-wide on-grid
 * invariant holds for any configured BPM/subdivisions (AH-0MUAYB8EH005RJ8B).
 *
 * @param weaponId - The weapon whose interval to derive.
 * @param subdivisions - Shots per beat per weapon (defaults to the catalogue).
 * @param bpm - Tempo in beats per minute (default 80).
 */
export function weaponFireRateMs(
  weaponId: WeaponId,
  subdivisions: WeaponSubdivisions = DEFAULT_WEAPON_SUBDIVISIONS,
  bpm: number = DEFAULT_BPM,
): number {
  const count =
    subdivisions[weaponId] ?? DEFAULT_WEAPON_SUBDIVISIONS[weaponId];
  return beatSubdivisionMs(count, bpm);
}

/**
 * Fire rate interval for the cannon (ms between shots) — 2 shots per beat
 * of the default 80 BPM grid (375 ms).
 */
export const WEAPON_CANNON_FIRE_RATE = beatSubdivisionMs(WEAPON_CANNON_SUBDIVISION);

/**
 * Fire rate interval for the spread weapon (ms) — 1 shot per beat (750 ms).
 */
export const WEAPON_SPREAD_FIRE_RATE = beatSubdivisionMs(WEAPON_SPREAD_SUBDIVISION);

/**
 * Fire rate interval for the dual weapon (ms) — 1 shot per beat (750 ms).
 */
export const WEAPON_DUAL_FIRE_RATE = beatSubdivisionMs(WEAPON_DUAL_SUBDIVISION);

/**
 * Fire rate interval for the rapid weapon (ms) — 6 shots per beat (125 ms),
 * the fastest weapon on the grid.
 */
export const WEAPON_RAPID_FIRE_RATE = beatSubdivisionMs(WEAPON_RAPID_SUBDIVISION);

/**
 * Fire rate interval for the Nova AOE weapon (ms) — 1 shot every 4 beats
 * (3000 ms at the default 80 BPM). Slow and defensive: a sparse pulse that
 * clears the ship's immediate surroundings.
 */
export const WEAPON_NOVA_FIRE_RATE = beatSubdivisionMs(WEAPON_NOVA_SUBDIVISION);

/**
 * Fire rate interval for the Mortar AOE weapon (ms) — 1 shot every 2 beats
 * (1500 ms at the default 80 BPM). The launched shell detonates on impact or
 * expiry.
 */
export const WEAPON_MORTAR_FIRE_RATE = beatSubdivisionMs(WEAPON_MORTAR_SUBDIVISION);

/**
 * Fire rate interval for the Arc AOE weapon (ms) — 1 shot per beat (750 ms at
 * the default 80 BPM), the fastest AOE cadence.
 */
export const WEAPON_ARC_FIRE_RATE = beatSubdivisionMs(WEAPON_ARC_SUBDIVISION);

/** Bullet speed in pixels per second (used by all weapons). */
export const BULLET_SPEED = 350;

/** Per-bullet perpendicular offset (px) for the Dual weapon's side-by-side pattern. */
export const DUAL_SIDE_OFFSET = 8;

/**
 * Per-weapon bullet lifetime (seconds). Bullets wrap across all four screen
 * edges while alive and are destroyed once this many seconds elapse; the
 * effective range is therefore `BULLET_SPEED × bulletLifetime`. Each weapon
 * is tuned independently (AH-0MU960UTE001PTV0).
 */
export const WEAPON_BULLET_LIFETIME = {
  /** Cannon — long reach for the default weapon (~525 px). */
  cannon: 1.5,
  /** Spread — slightly shorter than cannon (~490 px). */
  spread: 1.4,
  /** Dual — matches spread (~490 px). */
  dual: 1.4,
  /** Rapid — short reach balanced by its high fire rate (~262 px). */
  rapid: 0.75,
  /** Nova — the ring resolves instantly; no travelling bullet. */
  nova: 0.5,
  /** Mortar — the shell lives ~2 s (its detonation window), wrapping meanwhile. */
  mortar: 2.0,
  /** Arc — the bolt resolves instantly; no travelling bullet. */
  arc: 0.5,
} as const;

// ── Bullet visual definitions ───────────────────────────────────────

/** Bullet colour constants — neon palette matching the project aesthetic. */
export const BULLET_COLORS = {
  /** Default cannon bullet — bright cyan. */
  cannon: 0x00ffff,
  /** Spread weapon bullet — warm orange. */
  spread: 0xffaa00,
  /** Dual weapon bullet — vivid magenta. */
  dual: 0xff00ff,
  /** Rapid weapon bullet — electric yellow. */
  rapid: 0xffff00,
  /** Nova ring / projectile — pale cyan. */
  nova: 0x66ffff,
  /** Mortar shell / blast — deep orange. */
  mortar: 0xff6600,
  /** Arc chaining bolt — electric purple. */
  arc: 0xcc66ff,
};

/**
 * AOE effect radii (px) — the single source of truth read by the catalogue
 * descriptors and (later) the distinctive VFX helpers.
 */
export const AOE_RADII = {
  /** Nova ring radius — a defensive pulse around the ship. */
  nova: 90,
  /** Mortar blast radius — a focused detonation at the impact point. */
  mortar: 70,
  /** Arc chaining reach — the longest AOE, spanning nearby targets. */
  arc: 120,
} as const;

/**
 * AOE `'onImpact'` projectile speeds (px/s). Slower than the standard
 * `BULLET_SPEED` (350), so the Mortar shell visibly arcs across the screen
 * and its detonation point stays legible.
 */
export const AOE_PROJECTILE_SPEEDS = {
  /** Mortar shell — deliberately slow, giving the blast a readable travel. */
  mortar: 180,
} as const;

/**
 * Bullet shape type — determines how the bullet is drawn.
 * `circle` = filled circle (cannon, spread, rapid);
 * `line` = short line segment (dual).
 */
export type BulletShape = 'circle' | 'line';

// ── Weapon definition ───────────────────────────────────────────────

/**
 * A single weapon definition: human-readable name, relative angle
 * offsets (the shot pattern, in radians), fire rate in milliseconds,
 * bullet colour, shape, and size multiplier.
 */
export interface WeaponDefinition {
  /** Unique weapon ID (e.g. `'cannon'`). */
  id: WeaponId;
  /** Human-readable display name. */
  name: string;
  /**
   * One-line player-facing effect description (GDD §4.4). Rendered by the
   * gym help overlay so help copy cannot drift from the catalogue.
   */
  description: string;
  /** Relative angle offsets in radians — each fires at `heading + offset`. */
  offsets: ReadonlyArray<number>;
  /**
   * Per-bullet positional offset (px) **perpendicular** to the heading
   * (one per pattern bullet; defaults to 0s). Lets a pattern place
   * parallel bullets side-by-side offset across the direction of travel
   * (e.g. Dual) without changing their flight angles.
   */
  sideOffsets?: ReadonlyArray<number>;
  /** Milliseconds between shots. */
  fireRateMs: number;
  /** Bullet colour (Phaser integer). */
  bulletColor: number;
  /** Bullet visual shape. */
  bulletShape: BulletShape;
  /** Bullet radius multiplier relative to the default. */
  bulletSize: number;
  /**
   * Bullet lifetime in seconds. The bullet wraps across all four screen
   * edges while alive and expires once this elapses; effective range is
   * `BULLET_SPEED × bulletLifetime` (AH-0MU960UTE001PTV0).
   */
  bulletLifetime: number;
  /**
   * Area-of-effect descriptor (absent for conventional weapons). When
   * present the shared combat core dispatches the area effect through the
   * AOE seam rather than treating the shot as an ordinary bullet
   * (parent AH-0MUOOB3OR001V8CD).
   */
  aoe?: AoEDescriptor;
}

// ── Weapon catalogue ────────────────────────────────────────────────

/**
 * The complete weapon catalogue — cannon plus the three weapon
 * power-ups (spread, dual, rapid).
 *
 * Spread uses a 3-bullet fan (-30°, 0°, +30°). Dual fires 2 bullets
 * perpendicular to the heading (±90°). Rapid fires single bullets fast.
 */
export const WEAPON_CATALOGUE: Record<WeaponId, WeaponDefinition> = {
  cannon: {
    id: 'cannon',
    name: 'Cannon',
    description: 'Permanent default weapon — one bullet straight ahead.',
    offsets: [0],
    fireRateMs: WEAPON_CANNON_FIRE_RATE,
    bulletColor: BULLET_COLORS.cannon,
    bulletShape: 'circle',
    bulletSize: 1,
    bulletLifetime: WEAPON_BULLET_LIFETIME.cannon,
  },
  spread: {
    id: 'spread',
    name: 'Spread',
    description: 'Adds a 3-bullet fan (−30°/0°/+30°) for 10 s.',
    offsets: [(-30 * Math.PI) / 180, 0, (30 * Math.PI) / 180],
    fireRateMs: WEAPON_SPREAD_FIRE_RATE,
    bulletColor: BULLET_COLORS.spread,
    bulletShape: 'circle',
    bulletSize: 0.8,
    bulletLifetime: WEAPON_BULLET_LIFETIME.spread,
  },
  dual: {
    id: 'dual',
    name: 'Dual',
    description: 'Adds two side-by-side bullets for 10 s.',
    // Two parallel bullets, side-by-side across the direction of travel:
    // both fly at heading + 0° but are launched offset perpendicular to
    // the heading by ±DUAL_SIDE_OFFSET px.
    offsets: [0, 0],
    sideOffsets: [-DUAL_SIDE_OFFSET, DUAL_SIDE_OFFSET],
    fireRateMs: WEAPON_DUAL_FIRE_RATE,
    bulletColor: BULLET_COLORS.dual,
    bulletShape: 'line',
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.dual,
  },
  rapid: {
    id: 'rapid',
    name: 'Rapid',
    description: 'Adds single bullets at a much higher fire rate for 10 s.',
    offsets: [0],
    fireRateMs: WEAPON_RAPID_FIRE_RATE,
    bulletColor: BULLET_COLORS.rapid,
    bulletShape: 'circle',
    bulletSize: 0.7,
    bulletLifetime: WEAPON_BULLET_LIFETIME.rapid,
  },
  nova: {
    id: 'nova',
    name: 'Nova',
    description:
      'AOE: an expanding ring around the ship damages every enemy and clears bullets within its radius.',
    // The onFire ring resolves at the ship; no travelling bullet is spawned.
    offsets: [0],
    fireRateMs: WEAPON_NOVA_FIRE_RATE,
    bulletColor: BULLET_COLORS.nova,
    bulletShape: 'circle',
    bulletSize: 1.2,
    bulletLifetime: WEAPON_BULLET_LIFETIME.nova,
    aoe: {
      trigger: 'onFire',
      radius: AOE_RADII.nova,
      damagesEnemies: true,
      clearsEnemyBullets: true,
    },
  },
  mortar: {
    id: 'mortar',
    name: 'Mortar',
    description:
      'AOE: launches a slow shell that detonates on impact, damaging enemies and clearing bullets in a blast.',
    offsets: [0],
    fireRateMs: WEAPON_MORTAR_FIRE_RATE,
    bulletColor: BULLET_COLORS.mortar,
    bulletShape: 'circle',
    bulletSize: 1.1,
    bulletLifetime: WEAPON_BULLET_LIFETIME.mortar,
    aoe: {
      trigger: 'onImpact',
      radius: AOE_RADII.mortar,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      projectileSpeed: AOE_PROJECTILE_SPEEDS.mortar,
    },
  },
  arc: {
    id: 'arc',
    name: 'Arc',
    description:
      'AOE: a chaining bolt strikes the nearest enemy and arcs to nearby targets, clearing bullets along the path.',
    // The onFire chain resolves immediately; no travelling bullet.
    offsets: [0],
    fireRateMs: WEAPON_ARC_FIRE_RATE,
    bulletColor: BULLET_COLORS.arc,
    bulletShape: 'circle',
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.arc,
    aoe: {
      trigger: 'onFire',
      radius: AOE_RADII.arc,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      chains: 2,
    },
  },
};

/**
 * The **Reset** drop — not a weapon itself, but one of the weapon-pool
 * drops: collecting it clears every timed weapon, leaving only the
 * permanent cannon. Given a catalogue-style entry so gym help can show
 * it alongside the weapons with a single source of truth.
 */
export interface ResetDropDefinition {
  /** Drop identifier (`'reset'`). */
  id: 'reset';
  /** Human-readable display name. */
  name: string;
  /** One-line player-facing effect description. */
  description: string;
}

/** The Reset drop entry (GDD §4.4). */
export const RESET_DROP: ResetDropDefinition = {
  id: 'reset',
  name: 'Reset',
  description: 'Clears all timed weapons, leaving only the Cannon.',
};

/**
 * Looks up a weapon definition by ID.
 * @throws Error if the ID is not in the catalogue.
 */
export function getWeaponById(id: WeaponId): WeaponDefinition {
  const def = WEAPON_CATALOGUE[id];
  if (!def) {
    throw new Error(`Unknown weapon: ${id}`);
  }
  return def;
}

// ── Beat-grid invariant ─────────────────────────────────────────────

/**
 * Returns true when `fireRateMs` is an exact subdivision of the beat period
 * for `bpm`: `beatPeriodMs(bpm) % fireRateMs === 0`. This is the
 * catalogue-wide invariant (AH-0MUAYB8EH005RJ8B): every weapon must fire on
 * the shared beat grid, so a future 20 BPM quarter-time weapon (or any other
 * addition) is on-grid by construction and an off-grid rate is rejected.
 *
 * @param fireRateMs - Fire interval in milliseconds.
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns True when the interval divides the beat period exactly.
 */
export function isOnBeatGrid(
  fireRateMs: number,
  bpm: number = DEFAULT_BPM,
): boolean {
  if (typeof fireRateMs !== 'number' || !Number.isFinite(fireRateMs) || fireRateMs <= 0) {
    return false;
  }
  const period = beatPeriodMs(bpm);
  // Use a small tolerance for float-safety when BPM is overridden.
  const tolerance = 1e-9 * Math.max(1, period);
  // Faster than (or equal to) the beat: the rate exactly subdivides the
  // beat period (the conventional weapons, e.g. cannon 375 ms, rapid 125 ms).
  if (period % fireRateMs < tolerance) return true;
  // Slower than the beat: the rate is an exact integer multiple of the beat
  // period (the AOE family, e.g. Nova 3000 ms = 4 beats, Mortar 1500 ms = 2).
  // This keeps an arbitrary off-grid rate (e.g. 200 ms) rejected.
  if (fireRateMs > period && Math.abs(fireRateMs % period) < tolerance) {
    return true;
  }
  return false;
}

// ── Round-robin drop order ──────────────────────────────────────────

/** The weapon-drop spawn order: spread → dual → rapid (reset handled separately). */
const WEAPON_DROP_ORDER: readonly WeaponId[] = ['spread', 'dual', 'rapid'];

/**
 * Returns a new array with the weapon-drop spawn order (spread → dual → rapid).
 */
export function weaponDropOrder(): WeaponId[] {
  return [...WEAPON_DROP_ORDER];
}

/**
 * Generates a round-robin weapon sequence of the given length.
 * Cycles spread → dual → rapid → spread → …
 *
 * @param count - Total number of spawns to generate.
 * @returns An array of weapon IDs in spawn order.
 */
export function weaponRoundRobin(count: number): WeaponId[] {
  return Array.from({ length: count }, (_, i) => WEAPON_DROP_ORDER[i % WEAPON_DROP_ORDER.length]);
}

// ── Heading math ─────────────────────────────────────────────────────

/**
 * Converts a velocity vector (vx, vy) into a heading in radians
 * (0 = right, positive = clockwise) — the same convention as Phaser's
 * angle system. Uses `atan2(vy, vx)`; zero velocity yields 0.
 *
 * @param vx - Horizontal velocity component.
 * @param vy - Vertical velocity component.
 * @returns Heading angle in radians.
 */
export function headingFromVelocity(vx: number, vy: number): number {
  return Math.atan2(vy, vx);
}

/**
 * Computes the absolute angle for a bullet given the ship's heading and
 * a relative offset: `absoluteAngle = heading + offset`.
 *
 * @param heading - The ship's heading in radians.
 * @param offset - The pattern offset in radians (relative to heading).
 * @returns Absolute angle in radians.
 */
export function absoluteAngle(heading: number, offset: number): number {
  return heading + offset;
}

/**
 * Derives a bullet velocity from an absolute angle and the bullet speed.
 *
 * @param angle - Absolute angle in radians.
 * @param speed - Bullet speed in px/s.
 * @returns Velocity vector { vx, vy }.
 */
export function bulletVelocity(
  angle: number,
  speed: number,
): { vx: number; vy: number } {
  return {
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

/**
 * Converts a heading/angle in degrees to a velocity vector.
 *
 * @param angleDeg - Angle in degrees (0 = right, positive = clockwise).
 * @param speed - Bullet speed in px/s.
 * @returns Velocity vector { vx, vy }.
 */
export function angleToVelocity(
  angleDeg: number,
  speed: number,
): { vx: number; vy: number } {
  return bulletVelocity((angleDeg * Math.PI) / 180, speed);
}

/**
 * Gets bullet creation data for one shot from a weapon at a given
 * heading (radians). Returns the absolute angle (radians) and colour
 * for the bullet at `bulletIndex` in the pattern.
 *
 * @param weapon - The weapon definition.
 * @param heading - The ship's heading in radians.
 * @param bulletIndex - Which bullet in the pattern (0-based).
 * @returns Bullet descriptor, or `null` if out of range.
 */
export interface BulletForShot {
  vx: number;
  vy: number;
  color: number;
  shape: BulletShape;
  /** World-position offset (px) from the ship, applied perpendicular to heading. */
  offsetX: number;
  /** World-position offset (px) from the ship, applied perpendicular to heading. */
  offsetY: number;
}

/**
 * Gets bullet creation data for one shot from a weapon at a given
 * heading (radians). Returns velocity, colour/shape, and the bullet's
 * perpendicular positional offset.
 *
 * @param weapon - The weapon definition.
 * @param heading - The ship's heading in radians.
 * @param bulletIndex - Which bullet in the pattern (0-based).
 * @returns Bullet descriptor, or `null` if out of range.
 */
export function bulletForShot(
  weapon: WeaponDefinition,
  heading: number,
  bulletIndex: number,
): BulletForShot | null {
  if (bulletIndex < 0 || bulletIndex >= weapon.offsets.length) {
    return null;
  }
  const offset = weapon.offsets[bulletIndex];
  const angle = absoluteAngle(heading, offset);
  const vel = bulletVelocity(angle, BULLET_SPEED);
  // Perpendicular unit vector to the heading: (-sin h, cos h).
  const side = weapon.sideOffsets?.[bulletIndex] ?? 0;
  return {
    vx: vel.vx,
    vy: vel.vy,
    color: weapon.bulletColor,
    shape: weapon.bulletShape,
    offsetX: -Math.sin(heading) * side,
    offsetY: Math.cos(heading) * side,
  };
}

/**
 * Gets all bullet creation data for one shot from a weapon at a given
 * heading (radians).
 *
 * @param weapon - The weapon definition.
 * @param heading - The ship's heading in radians.
 * @returns Array of bullet descriptors.
 */
export function allBulletsForShot(
  weapon: WeaponDefinition,
  heading: number,
): BulletForShot[] {
  const result: BulletForShot[] = [];
  for (let i = 0; i < weapon.offsets.length; i++) {
    const bullet = bulletForShot(weapon, heading, i);
    if (bullet) result.push(bullet);
  }
  return result;
}

/**
 * Creates bullet descriptors for the given weapon fired at the ship's
 * current position, with heading in **degrees** (scene-facing helper).
 *
 * @param weapon - The weapon definition.
 * @param headingDeg - The ship's heading in degrees (0 = right, clockwise).
 * @param x - Ship world x position.
 * @param y - Ship world y position.
 * @returns Bullet descriptors ({ x, y, angleDeg, color }).
 */
export function createBulletsFromHeading(
  weapon: WeaponDefinition,
  headingDeg: number,
  x: number,
  y: number,
): Array<{ x: number; y: number; angleDeg: number; color: number }> {
  const headingRad = (headingDeg * Math.PI) / 180;
  return weapon.offsets.map((offset, i) => {
    const angleDeg = headingDeg + (offset * 180) / Math.PI;
    const side = weapon.sideOffsets?.[i] ?? 0;
    return {
      // Position offset perpendicular to the heading (side-by-side bullets).
      x: x - Math.sin(headingRad) * side,
      y: y + Math.cos(headingRad) * side,
      angleDeg,
      color: weapon.bulletColor,
    };
  });
}

// ── Heading fallback ─────────────────────────────────────────────────

/**
 * Computes a heading (radians) from the current velocity, falling back
 * to a default heading when the ship is stationary (speed ≈ 0).
 *
 * @param vx - Current horizontal velocity.
 * @param vy - Current vertical velocity.
 * @param lastHeading - The most recent non-zero heading (fallback).
 * @param defaultHeading - Default heading when no movement history exists (0 = right).
 * @returns A valid heading in radians.
 */
export function computeHeading(
  vx: number,
  vy: number,
  lastHeading: number | null,
  defaultHeading: number = 0,
): number {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed > 0.01) {
    return headingFromVelocity(vx, vy);
  }
  // Ship is stationary — fall back to last heading or the default.
  return lastHeading ?? defaultHeading;
}
/**
 * Weapon catalogue + heading-relative angle math (GDD §2.3, §4.4).
 *
 * Provides pure, unit-testable weapon definitions — each with a pattern
 * (relative angle offsets), fire rate, bullet colour, and bullet shape —
 * plus utilities to convert a heading into absolute bullet angles and
 * velocities.
 *
 * Weapons are **persistent** (GDD §4.4 revision): they remain equipped
 * indefinitely until replaced by another weapon power-up. The **cannon**
 * is the starting/default weapon; a **reset** power-up returns to it.
 *
 * Four weapons:
 * - **cannon** — single bullet straight ahead (default starting weapon)
 * - **spread** — 3-bullet fan at -30° / 0° / +30° relative to heading
 * - **dual**   — 2 bullets offset perpendicular (±90°) to heading
 * - **rapid**  — single bullets at a much higher fire rate
 *
 * Distances use **radians** for math (Phaser convention, positive =
 * clockwise); the scene-facing helpers (`createBulletsFromHeading`,
 * `angleToVelocity`) accept heading in **degrees** for readability.
 */

// ── Weapon IDs ───────────────────────────────────────────────────────

/**
 * Unique weapon identifiers. `'cannon'` is the starting weapon; the
 * `'reset'` drop type returns the ship to it (not a weapon itself).
 */
export type WeaponId = 'cannon' | 'spread' | 'dual' | 'rapid';

// ── Tunable weapon constants (fire rates, bullet tuning) ────────────

/** Fire rate interval for the cannon (ms between shots). */
export const WEAPON_CANNON_FIRE_RATE = 400;

/** Fire rate interval for the spread weapon (ms). */
export const WEAPON_SPREAD_FIRE_RATE = 600;

/** Fire rate interval for the dual weapon (ms). */
export const WEAPON_DUAL_FIRE_RATE = 500;

/** Fire rate interval for the rapid weapon (ms) — markedly faster. */
export const WEAPON_RAPID_FIRE_RATE = 125;

/** Bullet speed in pixels per second (used by all weapons). */
export const BULLET_SPEED = 350;

/** Per-bullet perpendicular offset (px) for the Dual weapon's side-by-side pattern. */
export const DUAL_SIDE_OFFSET = 8;

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
};

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
    offsets: [0],
    fireRateMs: WEAPON_CANNON_FIRE_RATE,
    bulletColor: BULLET_COLORS.cannon,
    bulletShape: 'circle',
    bulletSize: 1,
  },
  spread: {
    id: 'spread',
    name: 'Spread',
    offsets: [(-30 * Math.PI) / 180, 0, (30 * Math.PI) / 180],
    fireRateMs: WEAPON_SPREAD_FIRE_RATE,
    bulletColor: BULLET_COLORS.spread,
    bulletShape: 'circle',
    bulletSize: 0.8,
  },
  dual: {
    id: 'dual',
    name: 'Dual',
    // Two parallel bullets, side-by-side across the direction of travel:
    // both fly at heading + 0° but are launched offset perpendicular to
    // the heading by ±DUAL_SIDE_OFFSET px.
    offsets: [0, 0],
    sideOffsets: [-DUAL_SIDE_OFFSET, DUAL_SIDE_OFFSET],
    fireRateMs: WEAPON_DUAL_FIRE_RATE,
    bulletColor: BULLET_COLORS.dual,
    bulletShape: 'line',
    bulletSize: 0.9,
  },
  rapid: {
    id: 'rapid',
    name: 'Rapid',
    offsets: [0],
    fireRateMs: WEAPON_RAPID_FIRE_RATE,
    bulletColor: BULLET_COLORS.rapid,
    bulletShape: 'circle',
    bulletSize: 0.7,
  },
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
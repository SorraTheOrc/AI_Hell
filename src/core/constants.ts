/**
 * Core game constants for AI_Hell (GDD §6.4).
 *
 * Includes canvas resolution, rendering settings, and tunable movement
 * physics for the Newtonian-drift model (GDD §2.2 revision).
 */

// ── Canvas ──────────────────────────────────────────────────────────

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;
export const GAME_BACKGROUND_COLOR = '#000000';

// ── Movement Physics (GDD §2.2) ─────────────────────────────────────
// Pure Newtonian drift: zero friction, acceleration via thrust, max-speed
// cap, wrap-around edges. Tunable from a single place.

/** Acceleration applied each second when a thrust direction is held (px/s²). */
export const THRUST_ACCELERATION = 600;

/** Absolute speed cap to prevent unbounded acceleration (px/s). */
export const MAX_SPEED = 350;

/** Ship size used for visual rendering and physics bounds (px). */
export const SHIP_SIZE = 20;

/** Thrust flame length multiplier relative to ship size. */
export const THRUST_FLAME_LENGTH = 0.75;

/** Ship colour — neon cyan per the GDD art direction. */
export const SHIP_COLOR = 0x00ffff;

/** Thrust flame colour — hot orange/yellow. */
export const THRUST_FLAME_COLOR = 0xff8c00;

/** Inner flame colour — bright yellow. */
export const THRUST_FLAME_INNER_COLOR = 0xffff00;

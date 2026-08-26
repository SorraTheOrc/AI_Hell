/**
 * Core game constants for AI_Hell (GDD §6.4).
 *
 * Canvas and rendering constants are declared here directly.
 * Ship physics constants are re-exported from `config.ts` (the single
 * source of truth), so the gym scene and Player can load tuned values
 * at runtime while existing imports keep working unchanged.
 */

import { DEFAULT_CONFIG } from './config';

// ── Canvas ──────────────────────────────────────────────────────────

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;
export const GAME_BACKGROUND_COLOR = '#000000';

// ── Movement Physics (GDD §2.2) — re-exported defaults ─────────────
// Tunable from the config module; gym sliders write back to it.

/** Acceleration applied each second when a thrust direction is held (px/s²). */
export const THRUST_ACCELERATION = DEFAULT_CONFIG.thrustAcceleration;

/** Absolute speed cap to prevent unbounded acceleration (px/s). */
export const MAX_SPEED = DEFAULT_CONFIG.maxSpeed;

/** Ship size used for visual rendering and physics bounds (px). */
export const SHIP_SIZE = DEFAULT_CONFIG.shipSize;

/** Thrust flame length multiplier relative to ship size. */
export const THRUST_FLAME_LENGTH = DEFAULT_CONFIG.thrustFlameLength;

/** Ship colour — neon cyan per the GDD art direction. */
export const SHIP_COLOR = DEFAULT_CONFIG.shipColor;

/** Thrust flame colour — hot orange/yellow. */
export const THRUST_FLAME_COLOR = DEFAULT_CONFIG.thrustFlameColor;

/** Inner flame colour — bright yellow. */
export const THRUST_FLAME_INNER_COLOR = DEFAULT_CONFIG.thrustFlameInnerColor;

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

/** Linear deceleration rate when no thrust is applied (px/s²). */
export const FRICTION_DECELERATION = DEFAULT_CONFIG.frictionDeceleration;

// ── Power-up lifecycle (GDD §4.4, GymPowerUps gym) ─────────────────

/** Time in seconds for a power-up drop to grow from scale 0 to full size. */
export const POWER_UP_GROW_DURATION = 0.5;

/** Time in seconds for a power-up drop to shrink from full size to 0. */
export const POWER_UP_SHRINK_DURATION = 0.5;

/** Total lifetime of a power-up drop from spawn to despawn (seconds). */
export const POWER_UP_LIFETIME = 5;

/** Collection threshold: drops are collectible only above this percentage of full size (3). */
export const POWER_UP_COLLECTION_THRESHOLD = 3;

/** Interval between spawns in a round-robin cycle (seconds). */
export const POWER_UP_SPAWN_INTERVAL = 5;

/** Base radius of a power-up drop on the field (px), scaled by its lifecycle scale. */
export const POWER_UP_DROP_SIZE = 32;

// ── Power-up drop bubble visuals (GDD §4.4, §7.1) ─────────────────
// Tunable feel constants for the glowing bubble drawn around every
// on-field drop (AH-0MTG5MGPZ00986B4). The bubble is purely visual:
// the collection radius stays `DROP_SIZE * scale + hull`.

/** Bubble ring radius as a multiple of the drop size (1.4× the drop). */
export const POWER_UP_BUBBLE_RADIUS_FACTOR = 1.4;

/** Stroke width (px) of the bubble ring. */
export const POWER_UP_BUBBLE_STROKE_WIDTH = 2;

/** Alpha of the bubble's soft outer glow halo (0–1). */
export const POWER_UP_BUBBLE_GLOW_ALPHA = 0.35;

// ── P9 Magnet (GDD §4.4) ────────────────────────────────────────────

/** Base magnet radius as a multiple of the ship size (2×). */
export const MAGNET_RADIUS_BASE_MULTIPLIER = 2;

/** Each magnet stack adds this fraction of the base radius (+50%). */
export const MAGNET_RADIUS_PER_STACK = 0.5;

/** Speed (px/s) at which the magnet pulls on-screen drops toward the ship. */
export const MAGNET_ATTRACTION_SPEED = 120;

// ── UI ───────────────────────────────────────────────────────────────

/** Render depth of the standalone HUD — above gameplay objects. */
export const HUD_DEPTH = 1000;

// ── Weapon power-ups (GDD §4.4, GymWeapons gym) ────────────────────

/**
 * Total lifetime of a weapon power-up drop from spawn to despawn
 * (seconds).  Longer than non-combat drops (7 s vs 5 s) to give
 * the player more time to see and collect weapon patterns.
 */
export const WEAPON_DROP_LIFETIME = 7;

/** Collection threshold percentage — weapon drops are collectible
 * only above this percentage of full size (3).
 */
export const WEAPON_COLLECTION_THRESHOLD = POWER_UP_COLLECTION_THRESHOLD;

/** Base radius of a weapon drop on the field (px), scaled by lifecycle.
 * Mirrors `POWER_UP_DROP_SIZE` (doubled to 32 px, AH-0MTG5MGPZ00986B4) so
 * weapon drops render at the same enlarged size as non-combat drops.
 */
export const WEAPON_DROP_SIZE = POWER_UP_DROP_SIZE;

/** Bullet speed in px/s for player weapons. */
export const PLAYER_BULLET_SPEED = 350;

/** Bullet radius in px for all player weapons. */
export const PLAYER_BULLET_RADIUS = 3;

/** Seconds the player stays invulnerable (and blinks) after respawning from a hit. */
export const PLAYER_RESPAWN_INVULNERABLE = 1.5;

/**
 * Default spawn position for the keyboard-controlled player in the
 * Enemy Gym scenes: top-right corner, clear of every formation and
 * firing rightward off-screen so boot-time auto-fire never interferes
 * with formation or wait-based tests.
 */
export const PLAYER_SPAWN = { x: 920, y: 30 } as const;

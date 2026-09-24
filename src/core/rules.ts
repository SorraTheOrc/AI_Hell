/**
 * General game-rules configuration module (GDD §4.4, §6.3).
 *
 * Single source of truth for the tunable game rules that are shared
 * across scenes — currently the power-up spawn interval, the per-ID
 * power-up drop weights and the per-weapon drop weights. Values are
 * persisted as a JSON blob in the browser's localStorage (browser-native,
 * GDD §6.3 web distribution model), so changes made live (for example via
 * a combat-gym control) survive page reloads. Falls back to built-in
 * defaults whenever no saved rules exist or the stored JSON is corrupt.
 *
 * Mirrors the `src/core/config.ts` pattern (`DEFAULT_RULES`,
 * `loadRules()`, `saveRules()`, a `storage()` guard, defaults merge over
 * partial stored values and corrupt-JSON fallback).
 *
 * NOTE: `constants.ts` re-sources `POWER_UP_SPAWN_INTERVAL` from
 * `DEFAULT_RULES` so the interval has a single source of truth.
 *
 * Consumers: the combat formation gym base (`src/scenes/gym/core/
 * GymFormationScene.ts`) reads the interval and per-ID weights to drive
 * power-up spawning, and the live spawn-interval slider
 * (`src/utils/gymPowerUpControl.ts`) persists edits through `saveRules()`.
 */

import type { PowerUpId, WeaponDropId } from '../powerups/types';

// ── Types ───────────────────────────────────────────────────────────

/** Relative drop weights for every power-up ID the game can spawn. */
export type PowerUpWeights = Record<PowerUpId, number>;

/** Relative drop weights for every weapon drop the game can spawn. */
export type WeaponWeights = Record<WeaponDropId, number>;

/** Tunable, persisted game rules. */
export interface GameRules {
  /** Seconds between power-up spawns (one drop on screen at a time). */
  powerUpSpawnInterval: number;
  /**
   * Relative weight per power-up ID (P3–P9). Higher weight ⇒ more
   * likely. These are relative, not percentages — the spawner normalises
   * them internally.
   */
  powerUpWeights: PowerUpWeights;
  /**
   * Relative weight per weapon type (spread, dual, rapid). Higher
   * weight ⇒ more likely. These are relative, not percentages — the
   * spawner normalises them internally. Reset is handled separately
   * (one Reset drop per full weapon cycle).
   */
  weaponWeights: WeaponWeights;
  /** Minerals granted per mineral absorbed by the player ship (default 1). */
  mineralCollectAmount: number;
  /** Ship's hold capacity before the hold-full power-up choice (default 20). */
  mineralHoldCapacity: number;
  /** Minimum fraction of a destroyed enemy's minerals re-dropped (default 0.25). */
  mineralRedropFractionMin: number;
  /** Maximum fraction of a destroyed enemy's minerals re-dropped (default 0.5). */
  mineralRedropFractionMax: number;
}

// ── Defaults ────────────────────────────────────────────────────────

/** Default seconds between power-up spawns (GDD §4.4). */
export const DEFAULT_POWER_UP_SPAWN_INTERVAL = 12.5;

/** Default relative weight for standard-rarity power-ups (P3–P7, P9). */
export const DEFAULT_STANDARD_POWER_UP_WEIGHT = 4;

/**
 * Default relative weight for P8 Extra Life — rarer than standard drops
 * per GDD §4.4 (a 4:1 ratio approximates the ~15–20 % standard vs ~5 %
 * Extra Life guidance).
 */
export const DEFAULT_EXTRA_LIFE_WEIGHT = 1;

/** Default relative weight for weapon drops (spread, dual, rapid, reset). */
export const DEFAULT_WEAPON_WEIGHT = 2;

/** Every power-up ID covered by the default weight table (P3–P9). */
export const POWER_UP_WEIGHT_IDS: readonly PowerUpId[] = [
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
];

/** Every weapon drop covered by the default weapon weight table. */
export const WEAPON_WEIGHT_IDS: readonly WeaponDropId[] = [
  'spread',
  'dual',
  'rapid',
  'reset',
];

/** Default minerals granted per collected mineral (GDD §4.5). */
export const DEFAULT_MINERAL_COLLECT_AMOUNT = 1;

/** Default ship's-hold capacity before the power-up choice (GDD §4.5). */
export const DEFAULT_MINERAL_HOLD_CAPACITY = 20;

/** Default minimum re-drop fraction of a destroyed enemy's minerals (25 %). */
export const DEFAULT_MINERAL_REDROP_FRACTION_MIN = 0.25;

/** Default maximum re-drop fraction of a destroyed enemy's minerals (50 %). */
export const DEFAULT_MINERAL_REDROP_FRACTION_MAX = 0.5;

/**
 * Builds a fresh default weight table: every standard ID carries
 * {@link DEFAULT_STANDARD_POWER_UP_WEIGHT}, P8 Extra Life the rarer
 * {@link DEFAULT_EXTRA_LIFE_WEIGHT}.
 */
export function defaultPowerUpWeights(): PowerUpWeights {
  const weights = {} as PowerUpWeights;
  for (const id of POWER_UP_WEIGHT_IDS) {
    weights[id] =
      id === 'P8' ? DEFAULT_EXTRA_LIFE_WEIGHT : DEFAULT_STANDARD_POWER_UP_WEIGHT;
  }
  return weights;
}

/**
 * Builds a fresh default weapon weight table: every weapon drop
 * (spread, dual, rapid, reset) carries {@link DEFAULT_WEAPON_WEIGHT}.
 */
export function defaultWeaponWeights(): WeaponWeights {
  const weights = {} as WeaponWeights;
  for (const id of WEAPON_WEIGHT_IDS) {
    weights[id] = DEFAULT_WEAPON_WEIGHT;
  }
  return weights;
}

/** Built-in defaults — the current hard-coded tuning values. */
export const DEFAULT_RULES: GameRules = {
  powerUpSpawnInterval: DEFAULT_POWER_UP_SPAWN_INTERVAL,
  powerUpWeights: defaultPowerUpWeights(),
  weaponWeights: defaultWeaponWeights(),
  mineralCollectAmount: DEFAULT_MINERAL_COLLECT_AMOUNT,
  mineralHoldCapacity: DEFAULT_MINERAL_HOLD_CAPACITY,
  mineralRedropFractionMin: DEFAULT_MINERAL_REDROP_FRACTION_MIN,
  mineralRedropFractionMax: DEFAULT_MINERAL_REDROP_FRACTION_MAX,
};

/** localStorage key under which the game-rules JSON is persisted. */
export const RULES_STORAGE_KEY = 'ai-hell-game-rules';

// ── Internals ───────────────────────────────────────────────────────

/**
 * Returns a usable Storage instance, or null when localStorage is
 * unavailable (SSR, privacy mode, or other contexts where it throws).
 */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Accessing window.localStorage can throw in restricted contexts;
    // treat storage as unavailable rather than crashing the game.
    return null;
  }
}

/** Returns a fresh, fully-populated copy of `DEFAULT_RULES`. */
function cloneDefaultRules(): GameRules {
  return {
    powerUpSpawnInterval: DEFAULT_RULES.powerUpSpawnInterval,
    powerUpWeights: { ...DEFAULT_RULES.powerUpWeights },
    weaponWeights: { ...DEFAULT_RULES.weaponWeights },
    mineralCollectAmount: DEFAULT_RULES.mineralCollectAmount,
    mineralHoldCapacity: DEFAULT_RULES.mineralHoldCapacity,
    mineralRedropFractionMin: DEFAULT_RULES.mineralRedropFractionMin,
    mineralRedropFractionMax: DEFAULT_RULES.mineralRedropFractionMax,
  };
}

/**
 * Coerces a stored value to a usable positive finite number, falling back
 * to `fallback` otherwise.
 */
function coercePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Coerces a stored fraction to a value in [0, 1], falling back to
 * `fallback` otherwise.
 */
function coerceFraction(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : fallback;
}

/**
 * Coerces a stored interval value to a usable positive finite number,
 * falling back to the default otherwise.
 */
function coerceInterval(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : DEFAULT_RULES.powerUpSpawnInterval;
}

/**
 * Merges a stored (possibly partial/invalid) weight table over the
 * defaults. Unknown or non-numeric entries are ignored, so the result is
 * always a complete, valid table.
 */
function mergeWeights(stored: unknown): PowerUpWeights {
  const result = { ...DEFAULT_RULES.powerUpWeights };
  if (stored && typeof stored === 'object') {
    const source = stored as Record<string, unknown>;
    for (const id of POWER_UP_WEIGHT_IDS) {
      const value = source[id];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[id] = value;
      }
    }
  }
  return result;
}

/**
 * Merges a stored (possibly partial/invalid) weapon weight table over
 * the defaults. Unknown or non-numeric entries are ignored.
 */
function mergeWeaponWeights(stored: unknown): WeaponWeights {
  const result = { ...DEFAULT_RULES.weaponWeights };
  if (stored && typeof stored === 'object') {
    const source = stored as Record<string, unknown>;
    for (const id of WEAPON_WEIGHT_IDS) {
      const value = source[id];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[id] = value;
      }
    }
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Loads the persisted game rules, or the defaults when nothing has been
 * saved (or the stored JSON is corrupt). A partial stored rules object is
 * merged over the defaults — including a partial `powerUpWeights` table
 * and a partial `weaponWeights` table — so the result is always complete
 * and valid.
 *
 * Always returns a fresh object; mutating it never affects the defaults
 * or later loads.
 */
export function loadRules(): GameRules {
  const store = storage();
  if (!store) return cloneDefaultRules();

  const raw = store.getItem(RULES_STORAGE_KEY);
  if (!raw) return cloneDefaultRules();

  try {
    const parsed = JSON.parse(raw) as Partial<GameRules>;
    return {
      powerUpSpawnInterval: coerceInterval(parsed.powerUpSpawnInterval),
      powerUpWeights: mergeWeights(parsed.powerUpWeights),
      weaponWeights: mergeWeaponWeights(parsed.weaponWeights),
      mineralCollectAmount: coercePositiveNumber(
        parsed.mineralCollectAmount,
        DEFAULT_MINERAL_COLLECT_AMOUNT,
      ),
      mineralHoldCapacity: coercePositiveNumber(
        parsed.mineralHoldCapacity,
        DEFAULT_MINERAL_HOLD_CAPACITY,
      ),
      mineralRedropFractionMin: coerceFraction(
        parsed.mineralRedropFractionMin,
        DEFAULT_MINERAL_REDROP_FRACTION_MIN,
      ),
      mineralRedropFractionMax: coerceFraction(
        parsed.mineralRedropFractionMax,
        DEFAULT_MINERAL_REDROP_FRACTION_MAX,
      ),
    };
  } catch {
    return cloneDefaultRules();
  }
}

/**
 * Persists the supplied rules to the rules storage as JSON.
 * No-op when storage is unavailable.
 */
export function saveRules(values: GameRules): void {
  const store = storage();
  if (!store) return;
  store.setItem(RULES_STORAGE_KEY, JSON.stringify(values));
}

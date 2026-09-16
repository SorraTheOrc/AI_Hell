/**
 * General game-rules configuration module (GDD §4.4, §6.3).
 *
 * Single source of truth for the tunable game rules that are shared
 * across scenes — currently the power-up spawn interval and the per-ID
 * drop weights. Values are persisted as a JSON blob in the browser's
 * localStorage (browser-native, GDD §6.3 web distribution model), so
 * changes made live (for example via a combat-gym control) survive page
 * reloads. Falls back to built-in defaults whenever no saved rules exist
 * or the stored JSON is corrupt.
 *
 * Mirrors the `src/core/config.ts` pattern (`DEFAULT_RULES`,
 * `loadRules()`, `saveRules()`, a `storage()` guard, defaults merge over
 * partial stored values and corrupt-JSON fallback).
 *
 * NOTE: `constants.ts` re-sources `POWER_UP_SPAWN_INTERVAL` from
 * `DEFAULT_RULES` so the interval has a single source of truth.
 */

import type { PowerUpId } from '../powerups/types';

// ── Types ───────────────────────────────────────────────────────────

/** Relative drop weights for every power-up ID the game can spawn. */
export type PowerUpWeights = Record<PowerUpId, number>;

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

/** Built-in defaults — the current hard-coded tuning values. */
export const DEFAULT_RULES: GameRules = {
  powerUpSpawnInterval: DEFAULT_POWER_UP_SPAWN_INTERVAL,
  powerUpWeights: defaultPowerUpWeights(),
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
  };
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

// ── Public API ──────────────────────────────────────────────────────

/**
 * Loads the persisted game rules, or the defaults when nothing has been
 * saved (or the stored JSON is corrupt). A partial stored rules object is
 * merged over the defaults — including a partial `powerUpWeights` table —
 * so the result is always complete and valid.
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

/**
 * General game-rules configuration module (GDD §4.4, §6.3).
 *
 * Single source of truth for the tunable game rules that are shared
 * across scenes — the power-up spawn interval, the per-ID power-up drop
 * weights, the per-weapon drop weights, the mineral-hold tunables and the
 * opt-in `sequencedWavesEnabled` toggle that switches the run to a
 * data-driven sequenced campaign (AH-0MUH6LEYY0054E63). Values are
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
import {
  DEFAULT_WEAPON_SUBDIVISIONS,
  type WeaponId,
  type WeaponSubdivisions,
} from '../utils/weapons';
import { DEFAULT_BPM } from '../utils/beat';

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
   * Tempo in beats per minute for the shared player-fire beat grid
   * (default 80, AH-0MUAYB8EH005RJ8B). Every player weapon fires on a
   * subdivision of this beat; it is a **silent internal grid** (no audio
   * or visual metronome, GDD §7.3).
   */
  beatBpm: number;
  /**
   * Shots per beat for each player weapon (defaults: cannon 2, spread 1,
   * dual 1, rapid 6). A weapon's fire interval is
   * `60000 / beatBpm / subdivision`, so every weapon stays on the beat
   * grid by construction (AH-0MUAYB8EH005RJ8B). Values are positive
   * integers.
   */
  weaponSubdivisions: WeaponSubdivisions;
  /**
   * Relative weight per power-up ID (Shield–Power Pellet). Higher weight ⇒ more
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
  /**
   * Ship's hold capacity for the **first** hold-full power-up choice
   * (default 5, AH-0MUKC6IML0082ZR4). Each resolution multiplies the
   * capacity by {@link mineralHoldGrowthMultiplier}, so the n-th hold
   * requires `mineralHoldCapacity × mineralHoldGrowthMultiplier^(n−1)`
   * minerals (5, 10, 20, 40, … by default).
   */
  mineralHoldCapacity: number;
  /**
   * Multiplier applied to {@link mineralHoldCapacity} after each hold-full
   * resolution (default 2, AH-0MUKC6IML0082ZR4). A value of 1 disables
   * growth (every hold stays at the first-hold capacity).
   */
  mineralHoldGrowthMultiplier: number;
  /**
   * Minimum additive bonus (in minerals) added to a destroyed enemy's
   * collected count before rounding to the nearest integer (default 0.25).
   */
  mineralRedropBonusMin: number;
  /**
   * Maximum additive bonus (in minerals) added to a destroyed enemy's
   * collected count before rounding to the nearest integer (default 1.25).
   */
  mineralRedropBonusMax: number;
  /**
   * Opt-in switch for runtime-generated waves (AH-0MUH6LEYY0054E63).
   * When `true`, `PlayScene` builds the campaign from the difficulty-curve
   * config via the auto-sequencer; when `false` (the default) the static
   * `LEVELS` campaign ships exactly as before. No settings UI is provided. */
  sequencedWavesEnabled: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────

/** Default seconds between power-up spawns (GDD §4.4). */
export const DEFAULT_POWER_UP_SPAWN_INTERVAL = 12.5;

/** Default tempo for the shared player-fire beat grid (80 BPM → 750 ms/beat). */
export const DEFAULT_BEAT_BPM = DEFAULT_BPM;

/**
 * Builds a fresh default per-weapon subdivision table (cannon 2, spread 1,
 * dual 1, rapid 6).
 */
export function defaultWeaponSubdivisions(): WeaponSubdivisions {
  return { ...DEFAULT_WEAPON_SUBDIVISIONS };
}

/** Default relative weight for standard-rarity power-ups (Shield–Teleport, Magnet, Mineral Scoop). */
export const DEFAULT_STANDARD_POWER_UP_WEIGHT = 4;

/**
 * Default relative weight for Extra Life — rarer than standard drops
 * per GDD §4.4. Raised from `1` to `3` (AH-0MUNS3VAQ0023L1J) so Extra Life
 * appears roughly three times as often **by weight** (≈ 2.8× normalised
 * share), giving players a meaningful recovery loop while keeping Extra Life rarer
 * than the standard drops (a 4:3 ratio rather than the former 4:1).
 */
export const DEFAULT_EXTRA_LIFE_WEIGHT = 3;

/**
 * Default relative weight for the Power Pellet (AH-0MV1BIW95004POSX). Rarer
 * than a standard drop (3 vs 4) because the fright window is a strong
 * defensive tool, without being as rare as Extra Life (which is also 3 but
 * competes with the standard pool at the same weight).
 */
export const DEFAULT_POWER_PELLET_WEIGHT = 3;

/** Default relative weight for weapon drops (spread, dual, rapid, reset). */
export const DEFAULT_WEAPON_WEIGHT = 2;

/** Every power-up ID covered by the default weight table (Shield–Power Pellet). */
export const POWER_UP_WEIGHT_IDS: readonly PowerUpId[] = [
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'power_pellet',
];

/**
 * Translation table from the legacy opaque GDD power-up codes to the
 * canonical snake_case ids (parent AH-0MUX6S20F002GHPF, F4
 * AH-0MUY0GP4Q008LYO7). Configs persisted before version 4 keyed
 * `powerUpWeights` by these codes; {@link loadRules} translates them so a
 * player's tuned drop weights survive the rename instead of silently
 * resetting to the defaults.
 */
export const LEGACY_POWER_UP_ID_BY_CODE: Readonly<Record<string, PowerUpId>> = {
  'P3': 'shield',
  'P4': 'bomb',
  'P5': 'speed_boost',
  'P6': 'phase_shift',
  'P7': 'teleport',
  'P8': 'extra_life',
  'P9': 'magnet',
  'P10': 'mineral_scoop',
};

/** Every weapon drop covered by the default weapon weight table. */
export const WEAPON_WEIGHT_IDS: readonly WeaponDropId[] = [
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  'reset',
];

/** Default minerals granted per collected mineral (GDD §4.5). */
export const DEFAULT_MINERAL_COLLECT_AMOUNT = 1;

/**
 * Default ship's-hold capacity for the first hold-full power-up choice
 * (GDD §4.5, AH-0MUKC6IML0082ZR4). The first hold fills at 5 minerals;
 * each subsequent hold doubles (5, 10, 20, 40, …).
 */
export const DEFAULT_MINERAL_HOLD_CAPACITY = 5;

/**
 * Default multiplier applied to the hold capacity after each hold-full
 * resolution (AH-0MUKC6IML0082ZR4). 2 doubles the next hold's requirement.
 */
export const DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER = 2;

/** Default minimum additive re-drop bonus in minerals (0.25). */
export const DEFAULT_MINERAL_REDROP_BONUS_MIN = 0.25;

/** Default maximum additive re-drop bonus in minerals (1.25). */
export const DEFAULT_MINERAL_REDROP_BONUS_MAX = 1.25;

/**
 * Default for the sequenced-waves toggle — **on** (AH-0MUJSUTLA006Q8E1). The
 * shipped campaign is generated from `src/data/difficulty-curves.csv` (a
 * mixed `fixed`/`curve`/`dynamic` programme) unless a designer opts out by
 * persisting `false`.
 */
export const DEFAULT_SEQUENCED_WAVES_ENABLED = true;

/**
 * Builds a fresh default weight table: every standard ID carries
 * {@link DEFAULT_STANDARD_POWER_UP_WEIGHT}, Extra Life the rarer
 * {@link DEFAULT_EXTRA_LIFE_WEIGHT}.
 */
export function defaultPowerUpWeights(): PowerUpWeights {
  const weights = {} as PowerUpWeights;
  for (const id of POWER_UP_WEIGHT_IDS) {
    if (id === 'extra_life') {
      weights[id] = DEFAULT_EXTRA_LIFE_WEIGHT;
    } else if (id === 'power_pellet') {
      weights[id] = DEFAULT_POWER_PELLET_WEIGHT;
    } else {
      weights[id] = DEFAULT_STANDARD_POWER_UP_WEIGHT;
    }
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
  beatBpm: DEFAULT_BEAT_BPM,
  weaponSubdivisions: defaultWeaponSubdivisions(),
  powerUpWeights: defaultPowerUpWeights(),
  weaponWeights: defaultWeaponWeights(),
  mineralCollectAmount: DEFAULT_MINERAL_COLLECT_AMOUNT,
  mineralHoldCapacity: DEFAULT_MINERAL_HOLD_CAPACITY,
  mineralHoldGrowthMultiplier: DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER,
  mineralRedropBonusMin: DEFAULT_MINERAL_REDROP_BONUS_MIN,
  mineralRedropBonusMax: DEFAULT_MINERAL_REDROP_BONUS_MAX,
  sequencedWavesEnabled: DEFAULT_SEQUENCED_WAVES_ENABLED,
};

/** localStorage key under which the game-rules JSON is persisted. */
export const RULES_STORAGE_KEY = 'ai-hell-game-rules';

/**
 * Persisted game-rules schema version (AH-0MUKC6IML0082ZR4).
 *
 * Version 2 introduced `mineralHoldGrowthMultiplier` and changed
 * `mineralHoldCapacity` from a fixed capacity (default 20) to the
 * first-hold capacity (default 5). Configs written by version 1 carry a
 * fixed-capacity value that would defeat the new progression, so
 * {@link loadRules} migrates them by resetting the two mineral-hold
 * tunables to the new defaults while preserving every other rule.
 *
 * Version 3 replaced the multiplicative re-drop fractions
 * (`mineralRedropFractionMin`/`Max`) with additive bonus tunables
 * (`mineralRedropBonusMin`/`Max`). Versions 1 and 2 persisted fraction
 * values that are meaningless under the new additive semantics, so
 * {@link loadRules} resets the bonus tunables to the new defaults for any
 * config older than version 3 rather than carrying the stale keys forward.
 *
 * Version 4 renamed the power-up ids from the opaque GDD codes (`Shield`–`Mineral Scoop`)
 * to the canonical snake_case names (parent AH-0MUX6S20F002GHPF).
 * {@link loadRules} translates a legacy `powerUpWeights` table keyed by the
 * old codes through {@link LEGACY_POWER_UP_ID_BY_CODE} so customised drop
 * weights survive the upgrade (F4 AH-0MUY0GP4Q008LYO7).
 */
export const RULES_SCHEMA_VERSION = 4;

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
    beatBpm: DEFAULT_RULES.beatBpm,
    weaponSubdivisions: { ...DEFAULT_RULES.weaponSubdivisions },
    powerUpWeights: { ...DEFAULT_RULES.powerUpWeights },
    weaponWeights: { ...DEFAULT_RULES.weaponWeights },
    mineralCollectAmount: DEFAULT_RULES.mineralCollectAmount,
    mineralHoldCapacity: DEFAULT_RULES.mineralHoldCapacity,
    mineralHoldGrowthMultiplier: DEFAULT_RULES.mineralHoldGrowthMultiplier,
    mineralRedropBonusMin: DEFAULT_RULES.mineralRedropBonusMin,
    mineralRedropBonusMax: DEFAULT_RULES.mineralRedropBonusMax,
    sequencedWavesEnabled: DEFAULT_RULES.sequencedWavesEnabled,
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
 * Coerces a stored value to a usable non-negative finite number, falling
 * back to `fallback` otherwise. Used for the additive re-drop bonus
 * tunables, whose defaults (0.25/1.25) can exceed 1 and are therefore not
 * fractions.
 */
function coerceNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/**
 * Coerces a stored value to a boolean, falling back to `fallback` otherwise.
 * Only a literal boolean is accepted so a corrupt string (e.g. `"true"`)
 * cannot silently enable the sequenced-wave campaign.
 */
function coerceBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
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
 * Translates a stored (possibly legacy P-keyed) power-up weight table to
 * the canonical name keys. A canonical name key already present in the
 * stored object wins over its legacy code alias; every other entry is left
 * untouched. Unknown keys pass through unchanged so {@link mergeWeights}
 * can ignore them as before.
 */
function migrateLegacyPowerUpWeights(stored: unknown): unknown {
  if (!stored || typeof stored !== 'object') return stored;
  const source = stored as Record<string, unknown>;
  const migrated: Record<string, unknown> = { ...source };
  for (const [code, name] of Object.entries(LEGACY_POWER_UP_ID_BY_CODE)) {
    if (!(code in source)) continue;
    if (!(name in source)) {
      migrated[name] = source[code];
    }
    delete migrated[code];
  }
  return migrated;
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

/**
 * Merges a stored (possibly partial/invalid) per-weapon subdivision table
 * over the defaults. Only positive integers are accepted, so a corrupt
 * entry falls back to that weapon's default and the on-grid invariant is
 * preserved (AC6).
 */
function mergeWeaponSubdivisions(stored: unknown): WeaponSubdivisions {
  const result = { ...DEFAULT_RULES.weaponSubdivisions };
  if (stored && typeof stored === 'object') {
    const source = stored as Record<string, unknown>;
    for (const id of Object.keys(
      DEFAULT_WEAPON_SUBDIVISIONS,
    ) as WeaponId[]) {
      const value = source[id];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
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
    const parsed = JSON.parse(raw) as Partial<GameRules> & {
      version?: number;
    };
    // Version 1 stored a *fixed* hold capacity; honouring it as the
    // first-hold capacity would keep the old 20-mineral grind. Reset the
    // mineral-hold tunables for pre-v2 configs only — version 2 uses the
    // first-hold semantics, so its customised values must survive.
    const legacyHold = !isVersionAtLeast(parsed.version, 2);
    // Versions 1 and 2 persisted the re-drop rule as a fraction of the
    // collected count; version 3 replaced it with an additive bonus. Reset
    // the bonus tunables for any older config so a stale fraction value is
    // never reinterpreted as a bonus.
    const legacyRedrop = !isVersionAtLeast(parsed.version, 3);
    // Versions 1–3 keyed `powerUpWeights` by the opaque GDD codes
    // (`Shield`–`Mineral Scoop`); version 4 renamed the keys to the canonical snake_case
    // names. Translate legacy keys so customised weights survive the rename.
    const legacyPowerUpWeights = !isVersionAtLeast(
      parsed.version,
      RULES_SCHEMA_VERSION,
    );
    return {
      powerUpSpawnInterval: coerceInterval(parsed.powerUpSpawnInterval),
      beatBpm: coercePositiveNumber(parsed.beatBpm, DEFAULT_BEAT_BPM),
      weaponSubdivisions: mergeWeaponSubdivisions(
        parsed.weaponSubdivisions,
      ),
      powerUpWeights: mergeWeights(
        legacyPowerUpWeights
          ? migrateLegacyPowerUpWeights(parsed.powerUpWeights)
          : parsed.powerUpWeights,
      ),
      weaponWeights: mergeWeaponWeights(parsed.weaponWeights),
      mineralCollectAmount: coercePositiveNumber(
        parsed.mineralCollectAmount,
        DEFAULT_MINERAL_COLLECT_AMOUNT,
      ),
      mineralHoldCapacity: legacyHold
        ? DEFAULT_MINERAL_HOLD_CAPACITY
        : coercePositiveNumber(
            parsed.mineralHoldCapacity,
            DEFAULT_MINERAL_HOLD_CAPACITY,
          ),
      mineralHoldGrowthMultiplier: legacyHold
        ? DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER
        : coercePositiveNumber(
            parsed.mineralHoldGrowthMultiplier,
            DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER,
          ),
      mineralRedropBonusMin: legacyRedrop
        ? DEFAULT_MINERAL_REDROP_BONUS_MIN
        : coerceNonNegativeNumber(
            parsed.mineralRedropBonusMin,
            DEFAULT_MINERAL_REDROP_BONUS_MIN,
          ),
      mineralRedropBonusMax: legacyRedrop
        ? DEFAULT_MINERAL_REDROP_BONUS_MAX
        : coerceNonNegativeNumber(
            parsed.mineralRedropBonusMax,
            DEFAULT_MINERAL_REDROP_BONUS_MAX,
          ),
      sequencedWavesEnabled: coerceBoolean(
        parsed.sequencedWavesEnabled,
        DEFAULT_SEQUENCED_WAVES_ENABLED,
      ),
    };
  } catch {
    return cloneDefaultRules();
  }
}

/**
 * Whether a persisted schema version is at least `minimum`. Anything that
 * is not a finite number ≥ `minimum` (including `undefined`, older numbers
 * or a corrupt value) is treated as legacy and migrated.
 */
function isVersionAtLeast(version: unknown, minimum: number): boolean {
  return (
    typeof version === 'number' && Number.isFinite(version) && version >= minimum
  );
}

/**
 * Persists the supplied rules to the rules storage as JSON, stamped with
 * the current {@link RULES_SCHEMA_VERSION} so a later load can tell which
 * schema wrote it. No-op when storage is unavailable.
 */
export function saveRules(values: GameRules): void {
  const store = storage();
  if (!store) return;
  store.setItem(
    RULES_STORAGE_KEY,
    JSON.stringify({ ...values, version: RULES_SCHEMA_VERSION }),
  );
}

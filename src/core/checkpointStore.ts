/**
 * Run checkpoint persistence (epic AH-0MVCC8XSS007P01Z,
 * AH-0MVCRBTNF000DK51 — GDD §6.6 save-data).
 *
 * A checkpoint is written automatically after each mini-boss defeat and lets
 * the player resume from the last one instead of starting a new game. It
 * follows the same conventions as the settings/leaderboard stores:
 *
 * - localStorage under {@link CHECKPOINT_STORAGE_KEY} alongside
 *   `ai_hell_settings` / `ai_hell_leaderboard`;
 * - an injectable {@link CheckpointStorage} so a future backend can replace
 *   localStorage;
 * - **defensive parsing**: corrupt JSON, a wrong shape, an unknown version or
 *   out-of-range values load as `null` (never throw), so a checkpoint written
 *   by an earlier build cannot crash a later one.
 *
 * @module checkpointStore
 */

// The first-hold default is imported from the canonical rules module rather
// than duplicated as a literal: `rules.ts` is a pure, cycle-free module (no
// Phaser/DOM), so the store gains one dependency and the default cannot drift
// from the gameplay value (AH-0MVT1DYO5004UC4P).
import { DEFAULT_MINERAL_HOLD_CAPACITY } from './rules';
import type { PowerUpId } from '../powerups/types';
import type { WeaponId } from '../utils/weapons';

/** localStorage key for the run checkpoint. */
export const CHECKPOINT_STORAGE_KEY = 'ai_hell_checkpoint';

/**
 * Schema version. Bump when the payload shape changes incompatibly.
 *
 * - **v1** — original payload (AH-0MVCRBTNF000DK51).
 * - **v2** — adds {@link Checkpoint.mineralHoldCapacity} so Continue keeps the
 *   hold-capacity progression the run had earned (AH-0MVT1DYO5004UC4P).
 *   Legacy v1 payloads have no field and load with the first-hold default;
 *   migration is decided by field presence, so the version itself is
 *   informational (it is stamped with the current value on parse).
 */
export const CHECKPOINT_VERSION = 2;

/** One persisted weapon's permanent level. */
export interface CheckpointWeaponLevel {
  id: WeaponId;
  level: number;
}

/** One persisted power-up's permanent level. */
export interface CheckpointPowerUpLevel {
  id: PowerUpId;
  level: number;
}

/**
 * A resumable run checkpoint captured at a mini-boss defeat.
 *
 * `level` is the campaign level the run **resumes** at (the level after the
 * defeated mini-boss, capped at the final level) and `wave` is always 1, so a
 * resumed run starts cleanly at the beginning of a level rather than mid-wave.
 */
export interface Checkpoint {
  /** Schema version (see {@link CHECKPOINT_VERSION}). */
  version: number;
  /** Campaign level to resume at (1–10). */
  level: number;
  /** Wave to resume at (always 1). */
  wave: number;
  /** Remaining lives. */
  lives: number;
  /** Current score. */
  score: number;
  /** Minerals in the hold. */
  minerals: number;
  /**
   * The hold capacity the run had earned at the checkpoint (5, 10, 20, …).
   *
   * Persisted since schema v2 so Continue restores the earned progression
   * instead of silently resetting it to the first hold. A legacy payload
   * without the field loads with {@link DEFAULT_MINERAL_HOLD_CAPACITY}, the
   * canonical first-hold default (AH-0MVT1DYO5004UC4P).
   */
  mineralHoldCapacity: number;
  /** Permanent weapon levels owned at the checkpoint. */
  weaponLevels: CheckpointWeaponLevel[];
  /** Permanent power-up levels owned at the checkpoint. */
  powerUpLevels: CheckpointPowerUpLevel[];
  /** Weapons unlocked through mini-boss rewards. */
  unlockedWeapons: WeaponId[];
  /** The run's RNG seed, so a resumed run stays reproducible. */
  runSeed: number;
  /** ISO timestamp of when the checkpoint was written. */
  savedAt: string;
}

/** Minimal key/value storage the checkpoint reads and writes through. */
export interface CheckpointStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage-backed storage, resolved lazily and guarded. */
function defaultStorage(): CheckpointStorage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  };
}

const MIN_LEVEL = 1;
const MAX_LEVEL = 10;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toLevelList<T extends string>(
  value: unknown,
  isValidId: (id: string) => boolean,
): Array<{ id: T; level: number }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ id: T; level: number }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, level } = entry as { id?: unknown; level?: unknown };
    if (typeof id !== 'string' || !isValidId(id)) continue;
    if (!isFiniteNumber(level) || level < 0) continue;
    result.push({ id: id as T, level: Math.floor(level) });
  }
  return result;
}

/**
 * Parses an arbitrary value into a {@link Checkpoint}, or `null` when the
 * shape/values are not usable. Never throws.
 */
export function parseCheckpoint(raw: unknown): Checkpoint | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;

  const level = value.level;
  if (!isFiniteNumber(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    return null;
  }
  const lives = value.lives;
  const score = value.score;
  if (!isFiniteNumber(lives) || lives < 0) return null;
  if (!isFiniteNumber(score) || score < 0) return null;

  const minerals = isFiniteNumber(value.minerals) && value.minerals >= 0
    ? Math.floor(value.minerals)
    : 0;
  // A hold capacity is validated as a positive integer size: a non-numeric,
  // non-finite, negative, zero (or otherwise sub-1) value is unusable and
  // falls back to the first-hold default, so corrupt data can never shrink the
  // hold to nothing. A missing field is the legacy schema-v1 case and takes
  // the same default (AH-0MVT1DYO5004UC4P AC2/AC4).
  const mineralHoldCapacity =
    isFiniteNumber(value.mineralHoldCapacity) && value.mineralHoldCapacity >= 1
      ? Math.floor(value.mineralHoldCapacity)
      : DEFAULT_MINERAL_HOLD_CAPACITY;
  const runSeed = isFiniteNumber(value.runSeed) ? value.runSeed : 0;
  const wave = isFiniteNumber(value.wave) && value.wave >= 1
    ? Math.floor(value.wave)
    : 1;

  return {
    version: CHECKPOINT_VERSION,
    level: Math.floor(level),
    wave,
    lives: Math.floor(lives),
    score: Math.floor(score),
    minerals,
    mineralHoldCapacity,
    weaponLevels: toLevelList<WeaponId>(value.weaponLevels, () => true),
    powerUpLevels: toLevelList<PowerUpId>(value.powerUpLevels, () => true),
    unlockedWeapons: Array.isArray(value.unlockedWeapons)
      ? value.unlockedWeapons.filter(
          (id): id is WeaponId => typeof id === 'string',
        )
      : [],
    runSeed,
    savedAt:
      typeof value.savedAt === 'string' ? value.savedAt : new Date(0).toISOString(),
  };
}

/**
 * Loads the persisted checkpoint.
 *
 * @param storage - Storage adapter (defaults to localStorage).
 * @returns The checkpoint, or `null` when absent/corrupt/unsupported.
 */
export function loadCheckpoint(
  storage: CheckpointStorage | null = defaultStorage(),
): Checkpoint | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(CHECKPOINT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return parseCheckpoint(JSON.parse(raw));
  } catch {
    // Corrupt JSON (or a storage read that returned junk) degrades to "no
    // checkpoint" rather than crashing the menu/resume path.
    return null;
  }
}

/**
 * Persists a checkpoint (overwriting any previous one).
 *
 * @param checkpoint - The checkpoint to store.
 * @param storage - Storage adapter (defaults to localStorage).
 * @returns True when it was written.
 */
export function saveCheckpoint(
  checkpoint: Checkpoint,
  storage: CheckpointStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(
      CHECKPOINT_STORAGE_KEY,
      JSON.stringify({ ...checkpoint, version: CHECKPOINT_VERSION }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Clears the persisted checkpoint (New Game). Safe when absent.
 *
 * @param storage - Storage adapter (defaults to localStorage).
 */
export function clearCheckpoint(
  storage: CheckpointStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(CHECKPOINT_STORAGE_KEY);
  } catch {
    // Nothing to do — an unavailable storage has no checkpoint to clear.
  }
}

/** Whether a usable checkpoint exists (drives the menu's Continue button). */
export function hasCheckpoint(
  storage: CheckpointStorage | null = defaultStorage(),
): boolean {
  return loadCheckpoint(storage) !== null;
}

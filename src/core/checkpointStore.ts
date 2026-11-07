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
import { isWithinSlotPool, resolveSlotState } from '../powerups/slots';
import {
  CONSUMABLE_POWER_UP_IDS,
  type DropId,
  type PowerUpId,
} from '../powerups/types';
import type {
  ConsumablePoolSnapshot,
  ConsumableRechargeTimer,
} from '../powerups/powerUpLevels';
import type { WeaponId } from '../utils/weapons';

/** localStorage key for the run checkpoint. */
export const CHECKPOINT_STORAGE_KEY = 'ai_hell_checkpoint';

/**
 * Schema version. Bump when the payload shape changes incompatibly.
 *
 * - **v1** — original payload (AH-0MVCRBTNF000DK51).
 * - **v2** — adds {@link Checkpoint.mineralHoldCapacity} so Continue keeps the
 *   hold-capacity progression the run had earned (AH-0MVT1DYO5004UC4P).
 * - **v3** — **removes `unlockedWeapons`**: the mini-boss reward became the
 *   upgrade wheel, so the run-scoped weapon-unlock feature no longer exists
 *   (parent AH-0MVLISU03006WDOD AC5). A payload stamped with any other
 *   version is rejected outright (see {@link parseCheckpoint}), so a stale
 *   pre-wheel checkpoint can never resume a run whose reward surface has
 *   changed underneath it.
 *
 * **`consumablePools` is additive and stays inside v3** (an optional field
 * introduced after the bump, AH-0MVY3IGRC00954UD): the version gate rejects
 * any payload stamped with another version, and legacy v3 payloads (which
 * predate the field) must keep resuming, so the field is optional and a
 * payload missing it loads exactly as before — the permanent-grant replay
 * leaves each owned consumable with its single granted charge and no timers.
 */
export const CHECKPOINT_VERSION = 3;

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
  /**
   * The owned consumables' charge pools and in-flight recharge timers
   * (AH-0MVY3IGRC00954UD, **additive field — schema v3 is not bumped**).
   *
   * One row per **permanently owned** consumable — the pool-backed kinds
   * (charges plus every per-charge timer) and the single-use Teleport
   * (`charges: 0`; its readiness timer in `rechargeTimers`, empty while
   * ready). Optional because every legacy v3 payload predates the field:
   * a missing list resumes exactly as before, re-deriving each owned
   * consumable's single granted charge from the permanent-grant replay and
   * persisting no timers (AC3). Types align with the store's
   * `PowerUpLevelStore` snapshot/restore seam, so the checkpoint is only a
   * serialiser — never a second charge counter.
   */
  consumablePools?: ConsumablePoolSnapshot[];
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
 * Parses a checkpoint's `rechargeTimers` array defensively: every timer must
 * carry finite, positive `duration` and `remaining` seconds, and anything
 * else is dropped (never thrown). A non-array value degrades to an empty
 * list, so an absent or corrupt timer field can never break a resume
 * (AH-0MVY3IGRC00954UD AC5).
 */
function toRechargeTimerList(value: unknown): ConsumableRechargeTimer[] {
  if (!Array.isArray(value)) return [];
  const result: ConsumableRechargeTimer[] = [];
  for (const timer of value) {
    if (typeof timer !== 'object' || timer === null) continue;
    const { duration, remaining } = timer as {
      duration?: unknown;
      remaining?: unknown;
    };
    if (!isFiniteNumber(duration) || duration <= 0) continue;
    if (!isFiniteNumber(remaining) || remaining < 0) continue;
    result.push({ duration, remaining });
  }
  return result;
}

/**
 * Parses a checkpoint's optional `consumablePools` array defensively
 * (AH-0MVY3IGRC00954UD AC5): entries whose id is not a catalogue consumable,
 * or whose charge count is negative / non-finite / non-numeric, are **dropped**
 * outright; a non-array value degrades to an empty list (the legacy resume
 * path — AC3). Timer lists are parsed through {@link toRechargeTimerList}, so
 * a malformed timer drops the timer, never the checkpoint. Over-cap charge
 * counts survive parse and are clamped by the store restore to the ceiling
 * live play can actually hold.
 */
function toConsumablePoolList(value: unknown): ConsumablePoolSnapshot[] {
  if (!Array.isArray(value)) return [];
  const result: ConsumablePoolSnapshot[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, charges, rechargeTimers } = entry as {
      id?: unknown;
      charges?: unknown;
      rechargeTimers?: unknown;
    };
    if (typeof id !== 'string') continue;
    // The same derived catalogue list the store's seam uses — a non-
    // consumable or unknown id can never carry a pool into a resumed run.
    if (!CONSUMABLE_POWER_UP_IDS.includes(id as PowerUpId)) continue;
    if (!isFiniteNumber(charges) || charges < 0) continue;
    const row: ConsumablePoolSnapshot = {
      id: id as PowerUpId,
      charges: Math.floor(charges),
      rechargeTimers: toRechargeTimerList(rechargeTimers),
    };
    // A legacy Phase Shift row carried the retired pool's charge count as
    // `phaseCharges`; carry a usable value through so the store can coerce it
    // to a valid single-use state (AH-0MW6QY8OU007JOTP AC4). A malformed
    // value drops only the field, never the row.
    const legacyPhaseCharges = (entry as { phaseCharges?: unknown })
      .phaseCharges;
    if (
      id === 'phase_shift' &&
      isFiniteNumber(legacyPhaseCharges) &&
      legacyPhaseCharges >= 0
    ) {
      row.phaseCharges = Math.floor(legacyPhaseCharges);
    }
    result.push(row);
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

  // Strict schema gate (parent AH-0MVLISU03006WDOD AC5). The mini-boss reward
  // rework removed the `unlockedWeapons` field, so a payload from another
  // schema version cannot be interpreted faithfully: it is rejected as "no
  // checkpoint" (never migrated, never thrown), which is exactly the clean
  // rejection the version bump promises.
  const version = value.version;
  if (!isFiniteNumber(version) || version !== CHECKPOINT_VERSION) {
    return null;
  }

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
    // Additive field (AH-0MVY3IGRC00954UD): a legacy payload missing it
    // keeps the field **absent** (`undefined`, so `toEqual` on a legacy
    // fixture still passes) — exactly today's resume behaviour, where the
    // restore path defaults to an empty list (AC3). A present-but-corrupt
    // value parses defensively to the empty list.
    consumablePools:
      value.consumablePools !== undefined
        ? toConsumablePoolList(value.consumablePools)
        : undefined,
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
 * Bounds a checkpoint's permanent grants to the shared six-slot pool
 * (AH-0MVVJS34M00551ES AC1, parent AH-0MVVF0POV001JNKX AC2).
 *
 * A checkpoint is written from a capped run, so in normal play every entry
 * already fits and this is a no-op. It is the **save-side gate** that makes the
 * resume surface safe: whatever a caller hands in — a legacy in-memory state, a
 * bug-induced over-cap loadout, a migrated payload — the persisted payload
 * never names more counted kinds than a run can hold, so `Continue` can never
 * restore a seventh.
 *
 * Entries are admitted in payload order through the shared predicate
 * ({@link isWithinSlotPool}), the same one the drop draw, collection gate and
 * choice use:
 *
 * - a kind already admitted (or exempt / slot-exempt) is kept with **all** its
 *   levels — levelling a held kind never opens a slot;
 * - a kind that would take the pool past {@link POWER_UP_SLOT_CAP} is dropped
 *   entirely (its levels would change the run's effects, so a partial keep is
 *   not an option).
 *
 * The gate deliberately does **not** run on load: the replay must reproduce the
 * saved run exactly for HUD/effect parity (AH-0MVSHI07B003BZIP), and a
 * hand-written `localStorage` payload is not a play surface. The documented
 * divergence is recorded in GDD §4.4 and `docs/BALANCING.md`.
 *
 * @param checkpoint - The checkpoint a caller wants to persist.
 * @returns A copy whose permanent grants fit the six-slot pool.
 */
export function capCheckpointLoadout(checkpoint: Checkpoint): Checkpoint {
  const weaponLevels: CheckpointWeaponLevel[] = [];
  const powerUpLevels: CheckpointPowerUpLevel[] = [];
  for (const entry of checkpoint.weaponLevels) {
    const state = resolveSlotState(powerUpLevels, weaponLevels);
    if (isWithinSlotPool(entry.id as DropId, state)) weaponLevels.push(entry);
  }
  for (const entry of checkpoint.powerUpLevels) {
    const state = resolveSlotState(powerUpLevels, weaponLevels);
    if (isWithinSlotPool(entry.id as DropId, state)) powerUpLevels.push(entry);
  }
  // A kind the gate drops loses its charge pool too (AH-0MVY3IGRC00954UD
  // AC5): ownership on resume is re-derived from the **bounded** power-up
  // levels, so a pool kept for a dropped kind would hand a resumed run
  // charges for a kind it does not own. The pool set is the power-up set —
  // the bounded permanent levels are exactly the kinds the replay marks
  // owned — so only entries whose id survived the gate are carried.
  const admitted = new Set(powerUpLevels.map((entry) => entry.id));
  const consumablePools = checkpoint.consumablePools
    ? checkpoint.consumablePools.filter((entry) => admitted.has(entry.id))
    : undefined;
  return { ...checkpoint, weaponLevels, powerUpLevels, consumablePools };
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
    // Save-side six-slot gate: the persisted payload can never name more
    // counted kinds than a run may hold (AH-0MVVJS34M00551ES AC1).
    const bounded = capCheckpointLoadout(checkpoint);
    storage.setItem(
      CHECKPOINT_STORAGE_KEY,
      JSON.stringify({ ...bounded, version: CHECKPOINT_VERSION }),
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

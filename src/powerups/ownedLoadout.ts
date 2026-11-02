/**
 * Currently owned permanent loadout (AH-0MVCRKAPL000L68Y, GDD §4.4.1).
 *
 * The hold-full choice overlay shows what the player is offered; this module
 * builds the other half of the picture — the permanent weapons and power-ups
 * the player already owns this run, as player-facing display rows for the
 * overlay's top-left `YOUR UPGRADES` panel.
 *
 * ## Permanent only
 *
 * The builder reads the same two **permanent-only** snapshots the choice pool
 * prices (`Player.getWeaponLevels()` and `PowerUpLevelStore.getLevels()` via
 * `Player.getPowerUpLevels()`), and never the effective levels
 * (`getWeaponLevel()` / `getPowerUpLevel()`), so a temporary field pickup can
 * neither add a row nor inflate a displayed level (AC2).
 *
 * ## One name table
 *
 * Every row's name comes from `toChoiceOption(id).name` — the same shared
 * catalogue naming the offers use — so the panel can never disagree with the
 * option it sits beside (AC3). No second name table or level arithmetic lives
 * here.
 *
 * ## Deterministic order
 *
 * Weapons first, then power-ups; catalogue order within each kind (`AC5`), so
 * the panel's order never depends on collection order or object-key churn.
 * The permanent `cannon` (never a permanent reward) and the `reset` utility
 * (which removes weapons rather than granting one) are excluded.
 *
 * @module src/powerups/ownedLoadout
 */

import type { WeaponId } from '../utils/weapons';
import { toChoiceOption } from './choice';
import {
  POWER_UP_CATALOGUE,
  WEAPON_DROP_IDS,
  isWeaponDrop,
  type DropId,
  type PowerUpId,
} from './types';

/** Whether a row describes a weapon drop or a power-up. */
export type OwnedLoadoutKind = 'weapon' | 'powerup';

/** One permanent loadout row rendered by the hold-full overlay. */
export interface OwnedLoadoutRow {
  /** The drop id the row names (always a real drop, never `cannon`/`reset`). */
  readonly id: DropId;
  /** Whether the row is a weapon drop or a power-up. */
  readonly kind: OwnedLoadoutKind;
  /** Display name from the shared choice catalogue (`toChoiceOption`). */
  readonly name: string;
  /** The item's **permanent** level (≥ 1). */
  readonly level: number;
  /** The rendered row label, e.g. `Spread Shot Lv.2`. */
  readonly label: string;
}

/**
 * Display order for weapon rows: the canonical drop catalogue order
 * (`WEAPON_DROP_IDS`) with the `reset` utility removed — it is a weapon drop
 * but never a permanent reward, so it can never own a row.
 */
const WEAPON_ROW_ORDER: readonly DropId[] = WEAPON_DROP_IDS.filter(
  (id): id is Exclude<(typeof WEAPON_DROP_IDS)[number], 'reset'> => id !== 'reset',
);

/** Display order for power-up rows: shared catalogue order. */
const POWER_UP_ROW_ORDER: readonly DropId[] = Object.keys(
  POWER_UP_CATALOGUE,
) as PowerUpId[];

/** A permanent power-up level snapshot (`Player.getPowerUpLevels()`). */
export type OwnedPowerUpLevels = ReadonlyArray<{ id: PowerUpId; level: number }>;

/** A permanent weapon level snapshot (`Player.getWeaponLevels()`). */
export type OwnedWeaponLevels = ReadonlyArray<{ id: WeaponId; level: number }>;

/**
 * Builds the display rows for the currently owned **permanent** loadout.
 *
 * Filters to real drop ids the player can permanently own — excluding the
 * permanent `cannon` (not a weapon drop) and the `reset` utility — and keeps
 * only levels ≥ 1. Rows are ordered weapons first, then power-ups, in
 * catalogue order within each kind, and each row is labelled
 * `"<Name> Lv.<N>"` so a level-1 item is as explicit as a levelled one
 * (producer Q2 = A).
 *
 * Pure: no Phaser import, no clock, no randomness, no input mutation.
 *
 * @param powerUpLevels - Permanent power-up levels for the run.
 * @param weaponLevels - Permanent weapon levels for the run.
 * @returns One row per permanently owned drop kind (empty when none).
 */
export function buildOwnedLoadout(
  powerUpLevels: OwnedPowerUpLevels = [],
  weaponLevels: OwnedWeaponLevels = [],
): OwnedLoadoutRow[] {
  const weaponLevelById = new Map<string, number>();
  for (const { id, level } of weaponLevels) {
    if (Number.isFinite(level) && level >= 1) weaponLevelById.set(id, level);
  }

  const powerUpLevelById = new Map<string, number>();
  for (const { id, level } of powerUpLevels) {
    if (Number.isFinite(level) && level >= 1) powerUpLevelById.set(id, level);
  }

  const rows: OwnedLoadoutRow[] = [];

  for (const id of WEAPON_ROW_ORDER) {
    const level = weaponLevelById.get(id);
    if (level === undefined || !isWeaponDrop(id)) continue;
    rows.push(makeOwnedRow(id, 'weapon', level));
  }

  for (const id of POWER_UP_ROW_ORDER) {
    const level = powerUpLevelById.get(id);
    if (level === undefined) continue;
    rows.push(makeOwnedRow(id, 'powerup', level));
  }

  return rows;
}

/** Builds one row, naming it through the shared choice catalogue. */
function makeOwnedRow(
  id: DropId,
  kind: OwnedLoadoutKind,
  level: number,
): OwnedLoadoutRow {
  const name = toChoiceOption(id).name;
  return { id, kind, name, level, label: `${name} Lv.${level}` };
}

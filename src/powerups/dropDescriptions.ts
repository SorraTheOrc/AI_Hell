/**
 * Phaser-free catalogue lookup for drop names and descriptions
 * (AH-0MVD1RIH2008YCNV).
 *
 * The hold-full choice (`src/powerups/choice.ts`) and the gym help overlay
 * (`src/utils/gymHelp.ts`) both resolve a drop id to its player-facing copy
 * from the shared catalogues. The *name + description* lookup is a pure
 * catalogue read; only the gym help's `drawIcon` closures need Phaser
 * graphics. This module owns the pure part so headless consumers — the eval
 * arena (`src/ai/eval/`) — can offer the exact same option copy without
 * importing Phaser (eval core stays pure: no Phaser dependency, parent
 * AH-0MV8QT7CB0060A7A non-goals).
 *
 * The help overlay reuses this single source of copy, so the overlay text
 * and the arena offerings can never drift (AH-0MV2N2591007UGPD · AC4).
 *
 * @module src/powerups/dropDescriptions
 */

import { POWER_UP_CATALOGUE, type DropId, type PowerUpId } from './types';
import { RESET_DROP, WEAPON_CATALOGUE, type WeaponId } from '../utils/weapons';

/**
 * Every drop the shared copy can describe: the field drops (`DropId`), the
 * permanent `'cannon'` and the AOE weapon family (same as the gym help's
 * `HelpDropId`).
 */
export type DescribableDropId = DropId | WeaponId;

/** Catalogue-resolved display name + one-line description for one drop id. */
export interface DropDescription {
  readonly id: DescribableDropId;
  /** Human-readable display name (from the shared catalogue). */
  readonly name: string;
  /** One-line player-facing effect description (from the shared catalogue). */
  readonly description: string;
}

/**
 * Resolves one drop id to its display name and one-line description from the
 * shared catalogues — weapon catalogue (including the AOE family and the
 * Reset entry first), then the power-up catalogue.
 *
 * @param id — a drop id (`DropId`) or the permanent `'cannon'`.
 * @throws Error if the id is not present in any catalogue.
 */
export function getDropEntry(id: DescribableDropId): DropDescription {
  if (id === 'reset') {
    return { id, name: RESET_DROP.name, description: RESET_DROP.description };
  }
  const weapon = WEAPON_CATALOGUE[id as WeaponId];
  if (weapon) {
    return { id, name: weapon.name, description: weapon.description };
  }
  const powerUp = POWER_UP_CATALOGUE[id as PowerUpId];
  if (!powerUp) throw new Error(`Unknown drop for description: ${id}`);
  return { id, name: powerUp.name, description: powerUp.description };
}

/**
 * The shared one-line player-facing description of a drop id — the single
 * copy the hold-full choice, the gym help and now the headless arena all
 * consume (gym↔game↔arena parity).
 *
 * @param id — a drop id (`DropId`) or the permanent `'cannon'`.
 * @throws Error if the id is not present in any catalogue.
 */
export function getDropDescription(id: DescribableDropId): string {
  return getDropEntry(id).description;
}

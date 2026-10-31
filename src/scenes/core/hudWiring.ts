/**
 * The single seam that wires a scene's player into the shared combat HUD
 * (AH-0MVVJRRN10038VFR, parent AH-0MVVF0POV001JNKX).
 *
 * The HUD (`src/ui/HUD.ts`) must never derive loadout occupancy itself: it
 * renders rows, and the six-slot model (`powerups/slots.ts`) owns the
 * accounting. Every scene that shows the HUD therefore supplies the **same**
 * two player read-outs through {@link combatHudOptions}:
 *
 * - `getWeaponLevel` — the run-scoped **effective** weapon level shown on a
 *   weapon row (parent AH-0MUPMPCB2009J54J);
 * - `getSlotState` — `resolvePlayerSlotState(player)`, the shared slot state
 *   the HUD's budget and non-slot markers are derived from.
 *
 * Wiring it here (rather than copying two closures into `PlayScene` and every
 * gym scene) keeps gym↔game parity structural (AH-0MUGZDTFX004RBD1): a change
 * to how a player is read into the HUD happens once, and no scene can drift.
 *
 * The provider is a **function**, so it is read every frame: the player may
 * not exist yet when the HUD is constructed, and slot occupancy churns as
 * temporary windows open and expire.
 *
 * @module scenes/core/hudWiring
 */

import type { HUDOptions } from '../../ui/HUD';
import {
  resolvePlayerSlotState,
  type SlotPlayerView,
} from '../../powerups/slots';
import type { WeaponId } from '../../utils/weapons';

/**
 * The player surface the shared HUD wiring reads. `Player` satisfies it
 * structurally; tests can pass a double.
 */
export interface HudPlayerView extends SlotPlayerView {
  /** Run-scoped effective weapon level (permanent + temporary). */
  getWeaponLevel(weaponId: WeaponId): number;
}

/**
 * Builds the HUD options every game/gym scene passes, from one player source.
 *
 * @param player — Reads the scene's live player (`null`/`undefined` before the
 *   ship spawns; the HUD then renders no budget rather than a false one).
 * @param extra — Scene-specific options (`showLives`, …) merged last, so a
 *   scene can never accidentally replace the shared providers with a copy.
 */
export function combatHudOptions(
  player: () => HudPlayerView | null | undefined,
  extra: HUDOptions = {},
): HUDOptions {
  return {
    ...extra,
    getWeaponLevel: (id) => player()?.getWeaponLevel(id as WeaponId) ?? 0,
    getSlotState: () => {
      const view = player();
      return view ? resolvePlayerSlotState(view) : null;
    },
  };
}

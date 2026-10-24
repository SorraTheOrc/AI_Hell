/**
 * Shared hold-full choice reward application (AH-0MVD1RIH2008YCNV).
 *
 * This is the **one** code path that turns a selected hold-full option into
 * a permanent in-run grant, shared by the game (`PlayScene`), every gym and
 * the headless eval arena:
 *
 * - a weapon option permanently equips the weapon, and a `weapon-level`
 *   option permanently **levels up** an owned weapon (the same
 *   `equipWeapon` path increments the run-scoped level);
 * - a power-up option (`powerup` or `power-up-level`) permanently applies
 *   the collect effect (GDD §4.5).
 *
 * The function lives in a **Phaser-free** module so the pure eval core can
 * consume the identical reward path without importing a scene or a
 * Phaser-typed entity (eval non-goal: no Phaser dependency in
 * `src/ai/eval/`). `src/scenes/core/mineralLayer.ts` re-exports it for the
 * scene consumers, keeping their import paths unchanged.
 *
 * @module src/powerups/choiceReward
 */

import type { EffectsRegistry } from './effects';
import type { ChoiceOption } from './choice';
import { isWeaponDrop, type PowerUpId } from './types';
import type { WeaponId } from '../utils/weapons';

/**
 * Minimal player contract: weapon equip for weapon/weapon-level offers.
 * Structurally satisfied by {@link Player} in both the game and every gym
 * and by the headless arena's run-scoped adapter.
 *
 * Power-up options no longer call into the player directly: the registry's
 * `applyCollect` advances the **single** run-scoped store the scene injected
 * from the player (AH-0MUV5CLW6005VF7K, Q1=A), so the level rises exactly
 * once with no double-count.
 */
export interface MineralChoicePlayer {
  equipWeapon(weaponId: WeaponId, permanent?: boolean): void;
}

/**
 * Applies a hold-full choice option permanently for the current run, so
 * the gym, the game and the eval arena grant the same effect for the same
 * choice.
 *
 * @param option — the chosen option (exactly the option offered).
 * @param effectsRegistry — the scene's effect registry.
 * @param player — the ship to equip, or null when no player exists.
 */
export function applyMineralChoiceReward(
  option: ChoiceOption,
  effectsRegistry: EffectsRegistry,
  player: MineralChoicePlayer | null,
): void {
  if (option.kind === 'weapon-level' || isWeaponDrop(option.id)) {
    const weaponId = option.id as WeaponId;
    // Permanent equip both grants the weapon and raises its run-scoped level
    // by one (`Player.equipWeapon` increments on every collection), so a
    // level-up offer permanently strengthens an already-owned weapon.
    effectsRegistry.applyWeapon(weaponId, true);
    player?.equipWeapon(weaponId, true);
  } else {
    // Power-up options (both `powerup` and `power-up-level`): the registry
    // applies the hold-full effect **and** advances the single run-scoped
    // store (it was injected from the player), so future choices can offer
    // level-ups with no double-count (parent AH-0MUV5CLVO002ZHS9;
    // AH-0MUV5CLW6005VF7K AC1/AC3).
    const powerUpId = option.id as PowerUpId;
    effectsRegistry.applyCollect(powerUpId, true);
  }
}

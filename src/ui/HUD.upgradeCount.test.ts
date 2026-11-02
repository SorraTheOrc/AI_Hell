/**
 * Upgrade-count reporting: six permanent upgrades, then runtime upgrades.
 *
 * Reproduces the operator's playtest report (AH-0MVZ0GGW1004502H): mid-run the
 * HUD list showed six upgrade rows while the `Loadout n/6` label read `5/6`
 * and the hold-full `YOUR UPGRADES` panel listed five. This suite pins the
 * three surfaces that must agree — the HUD slot budget, the HUD row list and
 * the permanent-only upgrade panel (`buildOwnedLoadout`) — and then adds
 * **runtime** (temporary field-pickup) upgrades that are not in the permanent
 * set to see how many upgrades the model reports as active.
 *
 * Everything is built through the real shipped seams (`EffectsRegistry`
 * `applyWeapon` / `applyCollect` and `Player.equipWeapon`) — the same calls
 * `CombatCoreScene._collectDrop` and `applyMineralChoiceReward` make — so the
 * test never re-implements the accounting it checks. Expected values are
 * derived from the shared model (`resolvePlayerSlotState`), never hard-coded
 * to the answer the HUD is supposed to produce.
 *
 * @module src/ui/HUD.upgradeCount.test
 */

import { describe, it, expect } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { HUD } from './HUD';
import { EffectsRegistry } from '../powerups/effects';
import { Player } from '../entities/Player';
import { resolvePlayerSlotState } from '../powerups/slots';
import { buildOwnedLoadout } from '../powerups/ownedLoadout';
import { resolveTemporaryWindow } from '../powerups/powerUpLevels';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import type { PowerUpId } from '../powerups/types';
import type { WeaponId } from '../utils/weapons';

/** A bare scene: the HUD attaches to any Phaser scene (no gym logic). */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

/** Six permanent, slot-counted upgrades (four weapons + two power-ups). */
const PERMANENT_WEAPONS: readonly WeaponId[] = [
  'spread',
  'rapid',
  'mortar',
  'arc',
];
const PERMANENT_POWER_UPS: readonly PowerUpId[] = ['magnet', 'mineral_scoop'];

/**
 * The five permanent upgrades of the reported shape: five slot-counted kinds
 * (three weapons + two power-ups). The sixth *visible* row is a residual
 * `phase_shift` charge pool, which holds no slot (producer Resolved decision
 * 1b).
 */
const FIVE_PERMANENT_WEAPONS: readonly WeaponId[] = ['spread', 'rapid', 'mortar'];
const FIVE_PERMANENT_POWER_UPS: readonly PowerUpId[] = ['magnet', 'mineral_scoop'];

/** Extra time past a temporary window so the expiry path definitely runs. */
const EXPIRY_MARGIN_SECONDS = 0.5;

/** Runtime (temporary field-pickup) upgrades, none in the permanent set. */
const RUNTIME_WEAPONS: readonly WeaponId[] = ['wave_laser', 'ricochet'];
const RUNTIME_POWER_UPS: readonly PowerUpId[] = ['speed_boost'];

/**
 * Builds a player plus the registry bound to its level store, exactly as the
 * scenes wire them (one store, so rows and slots cannot disagree).
 */
function makePlayerAndRegistry(scene: Phaser.Scene) {
  const player = new Player(scene, { x: 0, y: 0 });
  scene.add.existing(player);
  const registry = new EffectsRegistry(player.getPowerUpLevelStore());
  return { player, registry };
}

/** Grants a permanent weapon through the shipped reward seam. */
function grantPermanentWeapon(
  registry: EffectsRegistry,
  player: Player,
  weaponId: WeaponId,
): void {
  registry.applyWeapon(weaponId, true);
  player.equipWeapon(weaponId, true);
}

/** Grants a permanent power-up through the shipped reward seam. */
function grantPermanentPowerUp(
  registry: EffectsRegistry,
  powerUpId: PowerUpId,
): void {
  registry.applyCollect(powerUpId, true);
}

/** Collects a weapon as a field pickup (runtime, temporary). */
function collectRuntimeWeapon(
  registry: EffectsRegistry,
  player: Player,
  weaponId: WeaponId,
): void {
  registry.applyWeapon(weaponId);
  player.equipWeapon(weaponId);
}

/** Collects a power-up as a field pickup (runtime, temporary). */
function collectRuntimePowerUp(
  registry: EffectsRegistry,
  powerUpId: PowerUpId,
): void {
  registry.applyCollect(powerUpId);
}

/** Slot-counted rows the HUD currently renders. */
function slotCountedRowIds(hud: HUD): string[] {
  return hud
    .getLoadoutRows()
    .filter((row) => row.slotCounted)
    .map((row) => row.id)
    .sort();
}

describe('upgrade count reporting (AH-0MVZ0GGW1004502H)', () => {
  it('reports six permanent upgrades across the budget, the rows and the upgrade panel', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const { player, registry } = makePlayerAndRegistry(scene);

    for (const weaponId of PERMANENT_WEAPONS) {
      grantPermanentWeapon(registry, player, weaponId);
    }
    for (const powerUpId of PERMANENT_POWER_UPS) {
      grantPermanentPowerUp(registry, powerUpId);
    }

    const hud = new HUD(scene, registry, {
      getSlotState: () => resolvePlayerSlotState(player),
      getWeaponLevel: (weaponId) => player.getWeaponLevel(weaponId as WeaponId),
    });
    hud.refresh();

    const state = resolvePlayerSlotState(player);
    const budget = hud.getSlotBudget();
    const countedRows = slotCountedRowIds(hud);
    // The hold-full overlay's `YOUR UPGRADES` panel reads this snapshot.
    const ownedPanel = buildOwnedLoadout(
      player.getPowerUpLevels(),
      player.getWeaponLevels(),
    );

    destroy(game);

    // The model holds exactly the six permanent kinds.
    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);

    // Surface 1: the `Loadout n/6` label.
    expect(budget).toEqual({ used: 6, cap: POWER_UP_SLOT_CAP });
    expect(hud.getSlotBudgetLabel()).toBe(`Loadout 6/${POWER_UP_SLOT_CAP}`);

    // Surface 2: the HUD row list — six slot-counted rows, nothing unmarked.
    expect(countedRows).toHaveLength(6);
    expect(
      hud.getLoadoutRows().filter((row) => !row.slotCounted),
    ).toHaveLength(0);

    // Surface 3: the upgrade screen's permanent-only panel.
    expect(ownedPanel).toHaveLength(6);
    expect(ownedPanel.map((row) => row.id).sort()).toEqual(
      [...PERMANENT_WEAPONS, ...PERMANENT_POWER_UPS].sort(),
    );
  });

  it('counts runtime upgrades that are not in the permanent set as active', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const { player, registry } = makePlayerAndRegistry(scene);

    // Six permanent upgrades first — a full loadout.
    for (const weaponId of PERMANENT_WEAPONS) {
      grantPermanentWeapon(registry, player, weaponId);
    }
    for (const powerUpId of PERMANENT_POWER_UPS) {
      grantPermanentPowerUp(registry, powerUpId);
    }

    const hud = new HUD(scene, registry, {
      getSlotState: () => resolvePlayerSlotState(player),
      getWeaponLevel: (weaponId) => player.getWeaponLevel(weaponId as WeaponId),
    });
    hud.refresh();

    const permanentOnly = buildOwnedLoadout(
      player.getPowerUpLevels(),
      player.getWeaponLevels(),
    );
    const budgetBefore = hud.getSlotBudget();

    // Runtime upgrades the run did not own permanently (field pickups).
    for (const weaponId of RUNTIME_WEAPONS) {
      collectRuntimeWeapon(registry, player, weaponId);
    }
    for (const powerUpId of RUNTIME_POWER_UPS) {
      collectRuntimePowerUp(registry, powerUpId);
    }
    hud.refresh();

    const state = resolvePlayerSlotState(player);
    const budgetAfter = hud.getSlotBudget();
    const countedRowsAfter = slotCountedRowIds(hud);
    const permanentPanelAfter = buildOwnedLoadout(
      player.getPowerUpLevels(),
      player.getWeaponLevels(),
    );

    destroy(game);

    const runtimeCount =
      RUNTIME_WEAPONS.length + RUNTIME_POWER_UPS.length;

    // The permanent upgrade screen is unchanged: runtime pickups never appear
    // in the permanent-only `YOUR UPGRADES` panel.
    expect(budgetBefore).toEqual({ used: 6, cap: POWER_UP_SLOT_CAP });
    expect(permanentOnly).toHaveLength(6);
    expect(permanentPanelAfter).toHaveLength(6);

    // Runtime upgrades hold a slot while their window is open (producer Q4a),
    // so every one of them is active and counted by the model.
    expect(state.used).toBe(6 + runtimeCount);
    expect(budgetAfter.used).toBe(6 + runtimeCount);
    expect(countedRowsAfter).toHaveLength(6 + runtimeCount);

    // The HUD rows and the budget tell the same story, and the runtime kinds
    // are present as their own rows rather than folded into a permanent one.
    expect(budgetAfter.used).toBe(countedRowsAfter.length);
    for (const runtimeId of [...RUNTIME_WEAPONS, ...RUNTIME_POWER_UPS]) {
      expect(countedRowsAfter).toContain(runtimeId);
    }
  });

  it('reproduces the reported shape: six visible rows for five counted slots', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const { player, registry } = makePlayerAndRegistry(scene);

    // Five permanent slot-counted upgrades.
    for (const weaponId of FIVE_PERMANENT_WEAPONS) {
      grantPermanentWeapon(registry, player, weaponId);
    }
    for (const powerUpId of FIVE_PERMANENT_POWER_UPS) {
      grantPermanentPowerUp(registry, powerUpId);
    }

    // A Phase Shift **field pickup**, whose temporary window is then allowed
    // to expire. Its granted charges survive the expiry (Resolved decision
    // 1b), so the HUD keeps a row for it — but the kind holds no slot and is
    // not permanent, so neither the budget nor the upgrade panel counts it.
    registry.applyCollect('phase_shift');
    registry.tick(
      resolveTemporaryWindow('phase_shift', 0) + EXPIRY_MARGIN_SECONDS,
    );

    const hud = new HUD(scene, registry, {
      getSlotState: () => resolvePlayerSlotState(player),
      getWeaponLevel: (weaponId) => player.getWeaponLevel(weaponId as WeaponId),
    });
    hud.refresh();

    const state = resolvePlayerSlotState(player);
    const budget = hud.getSlotBudget();
    const allRows = hud.getLoadoutRows();
    const countedRows = slotCountedRowIds(hud);
    const ownedPanel = buildOwnedLoadout(
      player.getPowerUpLevels(),
      player.getWeaponLevels(),
    );

    destroy(game);

    // This is the operator's observation: **six** rows are visible in the
    // HUD list, while the label reads **5/6** and the upgrade panel lists
    // **five**. The numbers agree with the model — the sixth row is the
    // non-slot Phase Shift residue, not a sixth upgrade.
    expect(allRows).toHaveLength(6);
    expect(budget).toEqual({ used: 5, cap: POWER_UP_SLOT_CAP });
    expect(hud.getSlotBudgetLabel()).toBe(`Loadout 5/${POWER_UP_SLOT_CAP}`);
    expect(countedRows).toHaveLength(5);
    expect(ownedPanel).toHaveLength(5);

    // The sixth row is explicitly classifiable as non-slot: it carries the
    // `charges only` marker and is excluded from the slot count. The display
    // therefore never claims a slot the model did not give it — the residual
    // defect is legibility (a player can misread the marked row as an
    // upgrade), which is exactly what the markers exist to prevent.
    const phaseRow = allRows.find((row) => row.id === 'phase_shift');
    expect(phaseRow).toBeDefined();
    expect(phaseRow!.slotCounted).toBe(false);
    expect(phaseRow!.marker).toBe('charges only');
    expect(state.heldIds.has('phase_shift')).toBe(false);
  });
});

/** Destroys a booted game (Phaser teardown). */
function destroy(game: Phaser.Game): void {
  game.destroy(true);
}

/**
 * Upgrade-count reporting: permanent upgrades, temporary pickups and the
 * six-slot gate.
 *
 * Reproduces the operator's playtest report (AH-0MVZ0GGW1004502H): mid-run the
 * HUD list showed six upgrade rows while the `Loadout n/6` label read `5/6`
 * and the hold-full `YOUR UPGRADES` panel listed five.
 *
 * The suite pins three things:
 *
 * 1. Six **permanent** upgrades agree across the HUD budget, the HUD row list
 *    and the permanent-only upgrade panel (`buildOwnedLoadout`).
 * 2. A **temporary** field pickup needs a free slot: below the cap a new kind
 *    fills one, but at the cap a new kind is **blocked** by the shared gate
 *    (`isWithinSlotPool`) — only a pickup of a kind already held permanently
 *    is allowed, and it reuses that kind's existing slot rather than opening a
 *    seventh.
 * 3. The reported shape (six visible rows for five counted slots) is a
 *    **non-slot** residual charge-pool row, which is now de-emphasised so it
 *    cannot be mistaken for an upgrade.
 *
 * Everything is built through the real shipped seams (`EffectsRegistry`
 * `applyWeapon` / `applyCollect`, `Player.equipWeapon` and `isWithinSlotPool`)
 * — the same calls `CombatCoreScene._collectDrop` / `_canCollectDrop` make — so
 * the test never re-implements the accounting it checks. Expected values are
 * derived from the shared model, never hard-coded to a number the HUD is
 * supposed to print.
 *
 * @module src/ui/HUD.upgradeCount.test
 */

import { describe, it, expect } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { HUD, NON_SLOT_ROW_ALPHA } from './HUD';
import { EffectsRegistry } from '../powerups/effects';
import { Player } from '../entities/Player';
import { isWithinSlotPool, resolvePlayerSlotState } from '../powerups/slots';
import { buildOwnedLoadout } from '../powerups/ownedLoadout';
import { resolveTemporaryWindow } from '../powerups/powerUpLevels';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import type { DropId, PowerUpId } from '../powerups/types';
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

/** Four permanent upgrades, leaving two free slots. */
const BELOW_CAP_WEAPONS: readonly WeaponId[] = ['spread', 'rapid', 'mortar'];
const BELOW_CAP_POWER_UPS: readonly PowerUpId[] = ['magnet'];

/**
 * Five permanent slot-counted upgrades for the reported shape: three weapons
 * + two power-ups. The sixth *visible* row is a residual `phase_shift`
 * charge pool, which holds no slot (producer Resolved decision 1b).
 */
const FIVE_PERMANENT_WEAPONS: readonly WeaponId[] = ['spread', 'rapid', 'mortar'];
const FIVE_PERMANENT_POWER_UPS: readonly PowerUpId[] = ['magnet', 'mineral_scoop'];

/** Extra time past a temporary window so the expiry path definitely runs. */
const EXPIRY_MARGIN_SECONDS = 0.5;

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

/**
 * Collects a weapon **only if the shared gate allows it**, mirroring
 * `CombatCoreScene._collectDrop` behind `_canCollectDrop`. Returns whether the
 * pickup happened.
 */
function tryCollectWeapon(
  registry: EffectsRegistry,
  player: Player,
  weaponId: WeaponId,
): boolean {
  if (!isWithinSlotPool(weaponId as DropId, resolvePlayerSlotState(player))) {
    return false;
  }
  registry.applyWeapon(weaponId);
  player.equipWeapon(weaponId);
  return true;
}

/**
 * Collects a power-up **only if the shared gate allows it**, mirroring the
 * same collection gate. Returns whether the pickup happened.
 */
function tryCollectPowerUp(
  registry: EffectsRegistry,
  player: Player,
  powerUpId: PowerUpId,
): boolean {
  if (!isWithinSlotPool(powerUpId, resolvePlayerSlotState(player))) return false;
  registry.applyCollect(powerUpId);
  return true;
}

/** Boots a HUD wired to `player`'s live slot state. */
function makeHud(
  scene: Phaser.Scene,
  player: Player,
  registry: EffectsRegistry,
): HUD {
  const hud = new HUD(scene, registry, {
    getSlotState: () => resolvePlayerSlotState(player),
    getWeaponLevel: (weaponId) => player.getWeaponLevel(weaponId as WeaponId),
  });
  hud.refresh();
  return hud;
}

/** Slot-counted row ids the HUD currently renders, sorted. */
function slotCountedRowIds(hud: HUD): string[] {
  return hud
    .getLoadoutRows()
    .filter((row) => row.slotCounted)
    .map((row) => row.id)
    .sort();
}

/** Text objects currently rendered by the HUD container. */
function renderedTexts(hud: HUD): Phaser.GameObjects.Text[] {
  return (
    hud as unknown as { list: Phaser.GameObjects.GameObject[] }
  ).list.filter(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text,
  );
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

    const hud = makeHud(scene, player, registry);
    const state = resolvePlayerSlotState(player);
    const budget = hud.getSlotBudget();
    const countedRows = slotCountedRowIds(hud);
    const nonSlotRows = hud
      .getLoadoutRows()
      .filter((row) => !row.slotCounted);
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
    expect(nonSlotRows).toHaveLength(0);

    // Surface 3: the upgrade screen's permanent-only panel.
    expect(ownedPanel).toHaveLength(6);
    expect(ownedPanel.map((row) => row.id).sort()).toEqual(
      [...PERMANENT_WEAPONS, ...PERMANENT_POWER_UPS].sort(),
    );
  });

  it('below the cap, a new temporary upgrade fills a free slot', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const { player, registry } = makePlayerAndRegistry(scene);

    for (const weaponId of BELOW_CAP_WEAPONS) {
      grantPermanentWeapon(registry, player, weaponId);
    }
    for (const powerUpId of BELOW_CAP_POWER_UPS) {
      grantPermanentPowerUp(registry, powerUpId);
    }

    const hud = makeHud(scene, player, registry);
    const stateBefore = resolvePlayerSlotState(player);
    const gateOpen = isWithinSlotPool('wave_laser', stateBefore);
    const collected = tryCollectWeapon(registry, player, 'wave_laser');
    hud.refresh();
    const stateAfter = resolvePlayerSlotState(player);
    const countedAfter = slotCountedRowIds(hud);
    destroy(game);

    // Four permanent kinds leave two free slots, so the gate admits a new
    // temporary kind and it becomes a fifth counted slot.
    expect(stateBefore.used).toBe(4);
    expect(gateOpen).toBe(true);
    expect(collected).toBe(true);
    expect(stateAfter.used).toBe(5);
    expect(countedAfter).toHaveLength(5);
    expect(countedAfter).toContain('wave_laser');
  });

  it('at the cap, a new temporary kind is blocked; a same-kind pickup reuses its slot', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const { player, registry } = makePlayerAndRegistry(scene);

    for (const weaponId of PERMANENT_WEAPONS) {
      grantPermanentWeapon(registry, player, weaponId);
    }
    for (const powerUpId of PERMANENT_POWER_UPS) {
      grantPermanentPowerUp(registry, powerUpId);
    }

    const hud = makeHud(scene, player, registry);
    const stateFull = resolvePlayerSlotState(player);

    // A brand-new kind cannot be collected: there is no slot to fill.
    const newKindAdmitted = isWithinSlotPool('wave_laser', stateFull);
    const newKindCollected = tryCollectWeapon(
      registry,
      player,
      'wave_laser',
    );
    const newPowerUpAdmitted = isWithinSlotPool('speed_boost', stateFull);
    const newPowerUpCollected = tryCollectPowerUp(
      registry,
      player,
      'speed_boost',
    );

    // A kind already held permanently **is** admissible: the pickup levels the
    // existing slot rather than opening a seventh.
    const heldKindAdmitted = isWithinSlotPool('spread', stateFull);
    const levelBefore = player.getWeaponLevel('spread');
    const heldKindCollected = tryCollectWeapon(registry, player, 'spread');
    const levelAfter = player.getWeaponLevel('spread');

    hud.refresh();
    const stateAfter = resolvePlayerSlotState(player);
    const budgetAfter = hud.getSlotBudget();
    const countedAfter = slotCountedRowIds(hud);
    destroy(game);

    // New kinds are refused by the shared gate and never reach the registry.
    expect(stateFull.isFull).toBe(true);
    expect(newKindAdmitted).toBe(false);
    expect(newKindCollected).toBe(false);
    expect(newPowerUpAdmitted).toBe(false);
    expect(newPowerUpCollected).toBe(false);

    // A same-kind pickup is allowed and levels the existing permanent weapon,
    // leaving the slot count unchanged (a seventh slot is never opened).
    expect(heldKindAdmitted).toBe(true);
    expect(heldKindCollected).toBe(true);
    expect(levelAfter).toBe(levelBefore + 1);
    expect(stateAfter.used).toBe(6);
    expect(budgetAfter).toEqual({ used: 6, cap: POWER_UP_SLOT_CAP });
    expect(countedAfter).toHaveLength(6);
    expect(countedAfter).not.toContain('wave_laser');
    expect(countedAfter).not.toContain('speed_boost');
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

    // A Shield **field pickup**, whose temporary window is then allowed to
    // expire. Its granted charge survives the expiry (Resolved decision 1b),
    // so the HUD keeps a row for it — but the kind holds no slot and is not
    // permanent, so neither the budget nor the upgrade panel counts it.
    registry.applyCollect('shield');
    registry.tick(resolveTemporaryWindow('shield', 0) + EXPIRY_MARGIN_SECONDS);

    const hud = makeHud(scene, player, registry);
    const state = resolvePlayerSlotState(player);
    const budget = hud.getSlotBudget();
    const allRows = hud.getLoadoutRows();
    const countedRows = slotCountedRowIds(hud);
    const ownedPanel = buildOwnedLoadout(
      player.getPowerUpLevels(),
      player.getWeaponLevels(),
    );

    // Capture the rendered opacity before teardown: the non-slot row must be
    // de-emphasised so a player cannot read it as a loadout entry.
    const texts = renderedTexts(hud);
    const chargeRow = allRows.find((row) => row.id === 'shield');
    const slotRow = allRows.find((row) => row.id === 'spread');
    const alphaOf = (label: string | undefined): number | undefined =>
      texts.find((text) => text.text === label)?.alpha;
    const chargeAlpha = alphaOf(chargeRow?.label);
    const slotAlpha = alphaOf(slotRow?.label);

    destroy(game);

    // This is the operator's observation: **six** rows are visible in the
    // HUD list, while the label reads **5/6** and the upgrade panel lists
    // **five**. The numbers agree with the model — the sixth row is the
    // non-slot Shield charge residue, not a sixth upgrade.
    expect(allRows).toHaveLength(6);
    expect(budget).toEqual({ used: 5, cap: POWER_UP_SLOT_CAP });
    expect(hud.getSlotBudgetLabel()).toBe(`Loadout 5/${POWER_UP_SLOT_CAP}`);
    expect(countedRows).toHaveLength(5);
    expect(ownedPanel).toHaveLength(5);

    // The sixth row is a non-slot row: it carries the `charges only` marker,
    // is excluded from the slot count, and is rendered dimmed so it recedes
    // below the five slot-counted rows. A slot-counted row stays at full
    // opacity, so the loadout is visually distinct from the residue.
    expect(chargeRow).toBeDefined();
    expect(chargeRow!.slotCounted).toBe(false);
    expect(chargeRow!.marker).toBe('charges only');
    expect(state.heldIds.has('shield')).toBe(false);
    expect(chargeAlpha).toBeCloseTo(NON_SLOT_ROW_ALPHA);
    expect(slotAlpha).toBe(1);
  });
});

/** Destroys a booted game (Phaser teardown). */
function destroy(game: Phaser.Game): void {
  game.destroy(true);
}

/**
 * GymPowerUpLeveling tests (parent AH-0MUV5CLVQ006V9HR / child
 * AH-0MV7QKEEO006WFI1).
 *
 * Verifies the power-up leveling demonstration gym end-to-end: field-pickup
 * leveling, hold-full permanent leveling, the resolver-derived level/stats
 * readout at representative levels, a growing axis for every power-up, the
 * run-restart reset seam, index discovery, and that the gym consumes the
 * shared level model (no duplicated curve/catalogue/arithmetic).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import {
  GymPowerUpLeveling,
  POWER_UP_READOUT_PANEL_ID,
  type PowerUpLevelReadout,
} from './GymPowerUpLeveling';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import {
  POWER_UP_LEVEL_IDS,
  POWER_UP_LEVEL_SPECS,
  isConsumablePowerUpId,
  resolvePowerUpAtLevel,
} from '../../powerups/powerUpLevels';
import { grantPermanentPowerUp } from '../../powerups/choiceReward';
import { getPowerUpById, type PowerUpId } from '../../powerups/types';

// Boots a fresh Phaser game per scene (slow under parallel load) — give the
// file headroom, matching the weapon-leveling gym suite.
vi.setConfig({ testTimeout: 60000 });

describe('GymPowerUpLeveling', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    // The readout panel is a plain-DOM element appended to the host; remove
    // it so a later boot in the same worker starts clean.
    document.getElementById(POWER_UP_READOUT_PANEL_ID)?.remove();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<GymPowerUpLeveling> {
    booted = await bootScene([GymPowerUpLeveling, MineralChoiceScene]);
    return booted.scene as GymPowerUpLeveling;
  }

  it('AC1 — the gym is auto-discovered by GymIndex as PowerUpLeveling', async () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymPowerUpLeveling.ts': { GymPowerUpLeveling },
    });
    expect(entries).toEqual([
      {
        key: 'GymPowerUpLeveling',
        label: 'PowerUpLeveling',
        module: { GymPowerUpLeveling },
      },
    ]);
  });

  it('AC2 — the registry consumes the player store instance (one level model)', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;

    // A field collection through the shared effect path must advance the
    // player's single run-scoped store (not a registry-private copy).
    scene.getEffectsRegistry().applyCollect('speed_boost');
    expect(player.getPowerUpLevel('speed_boost')).toBe(1);

    // The readout is derived from that same store through the shared
    // resolver — the gym defines no copy of the level arithmetic.
    const row = scene
      .getReadout()
      .rows.find((r) => r.powerUpId === 'speed_boost')!;
    expect(row.stats).toEqual(resolvePowerUpAtLevel('speed_boost', 0));
  });

  it('AC4 — collecting the same field drop repeatedly raises that power-up level', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;

    for (let i = 1; i <= 3; i++) {
      const drop = scene.spawnDrop('shield', player.x, player.y);
      scene.tick(0.1);
      expect(drop.absorbing).toBe(true);
      expect(player.getPowerUpLevel('shield')).toBe(i);
      const row = scene
        .getReadout()
        .rows.find((r) => r.powerUpId === 'shield')!;
      expect(row.level).toBe(i);
    }
  });

  it('the hold-full overlay lists the run permanent loadout, weapons included (AH-0MVCRKAPL000L68Y)', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    // This gym's offer pool stays power-ups-only, but the owned-loadout panel
    // reports the run's true permanent loadout — including weapons (recorded
    // plan default; producer did not overrule it).
    grantPermanentPowerUp('shield', scene.getEffectsRegistry());
    player.equipWeapon('spread', true);
    // A temporary field pickup never reaches the panel.
    player.collectPowerUp('bomb');

    scene.openMineralChoice();
    await advanceGame(booted!.game, 80);
    const overlay = booted!.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;

    expect(overlay.getOwnedUpgradeLines()).toEqual([
      'Spread Shot Lv.1',
      'Shield Lv.1',
    ]);
  });

  it('AC4 — the hold-full choice permanently levels an owned power-up', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();

    // Fill the hold and take a base (★ New) power-up → permanent grant 1.
    scene.addMinerals(scene.getHold().capacity);
    scene.tick(0.016);
    const first = scene.getMineralChoiceOptions();
    expect(first.length).toBeGreaterThan(0);
    // Pick a kind that still levels: a consumable hold-full reward adds a
    // charge instead of a level (parent AH-0MVTQMREN009DSFW AC1).
    const fresh = first.find(
      (o) => o.kind === 'powerup' && o.isNew && !isConsumablePowerUpId(o.id as PowerUpId),
    );
    expect(fresh).toBeDefined();
    const freshId = fresh!.id as PowerUpId;
    scene.selectMineralChoice(first.indexOf(fresh!));
    expect(player.getPowerUpLevel(freshId)).toBe(1);
    expect(store.getPermanentLevel(freshId)).toBe(1);

    // Refill → the demo strategy guarantees a power-up level-up offer for the
    // now-owned power-up; choosing it permanently levels it.
    scene.addMinerals(scene.getHold().capacity);
    scene.tick(0.016);
    const offered = scene.getMineralChoiceOptions();
    const levelUp = offered.find(
      (o) => o.kind === 'power-up-level' && o.id === freshId,
    );
    expect(levelUp).toBeDefined();
    scene.selectMineralChoice(offered.indexOf(levelUp!));
    expect(player.getPowerUpLevel(freshId)).toBe(2);
    expect(store.getPermanentLevel(freshId)).toBe(2);

    // Permanent: a temporary-window expiry never claws the grant back.
    store.clearTemporary(freshId);
    expect(player.getPowerUpLevel(freshId)).toBe(2);
  });

  it('AC1 — a field pickup of an instant and a timed kind on a permanent base reverts through the scene tick', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const registry = scene.getEffectsRegistry();

    const windows: Array<{ id: PowerUpId; remaining: number }> = [];

    // One instant kind (`bomb`, no timed effect of its own) and one timed
    // kind (`shield`) land on an existing permanent base. Both then take a
    // field pickup through the shared drop path, collected by the scene tick.
    for (const id of ['bomb', 'shield'] as PowerUpId[]) {
      // Hold-full reward → permanent base, through the shared grant seam.
      grantPermanentPowerUp(id, registry);
      // Shield is a consumable: the reward owns it and banks a charge, but
      // never raises its level (parent AH-0MVTQMREN009DSFW AC1).
      const base = isConsumablePowerUpId(id) ? 0 : 1;
      expect(store.getPermanentLevel(id), `${id} permanent base`).toBe(base);

      scene.spawnDrop(id, player.x, player.y);
      scene.tick(0.1);

      expect(store.getTempStacks(id), `${id} temporary stack`).toBe(1);
      expect(player.getPowerUpLevel(id), `${id} raised`).toBe(base + 1);

      const remaining = registry.powerUpTemporaryRemaining(id);
      expect(remaining, `${id} window open`).toBeGreaterThan(0);
      windows.push({ id, remaining: remaining! });
    }

    // Expire both windows through the same scene tick — never the registry
    // API directly — so the assertion covers the real per-frame consumer.
    scene.tick(Math.max(...windows.map((w) => w.remaining)) + 0.5);

    for (const { id } of windows) {
      const base = isConsumablePowerUpId(id) ? 0 : 1;
      expect(store.getTempStacks(id), `${id} temporary cleared`).toBe(0);
      expect(player.getPowerUpLevel(id), `${id} reverted`).toBe(base);
      expect(store.getPermanentLevel(id), `${id} permanent retained`).toBe(base);
      expect(
        registry.powerUpTemporaryRemaining(id),
        `${id} window closed`,
      ).toBeUndefined();
    }

    // The permanent shield effect window is unchanged in this slice (the
    // charge-model rewiring of the effect path is AH-0MVUXH3X60078QR3), so the
    // permanent base stays active; what changed here is the **store**: the
    // kind is owned and holds one charge without being levelled.
    expect(registry.isActive('shield')).toBe(true);
    expect(store.isConsumableOwned('shield')).toBe(true);
    expect(store.consumableCharges('shield')).toBe(1);
  });

  it('AC3/AC4 — the readout matches the shared resolver at base / first upgrade / mid / cap', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();

    for (const id of POWER_UP_LEVEL_IDS) {
      const expectReadout = (expectedLevel: number): PowerUpLevelReadout => {
        const readout = scene.getReadout();
        const row = readout.rows.find((r) => r.powerUpId === id)!;
        expect(row.level, `${id} level`).toBe(expectedLevel);
        // Stats exactly as the shared pure resolver reports them — the gym
        // readout is a view over the shared model, never a recomputation.
        expect(row.stats, `${id} stats`).toEqual(
          resolvePowerUpAtLevel(id, Math.max(0, expectedLevel - 1)),
        );
        return readout;
      };

      // Base (level 0, never collected).
      expectReadout(0);
      // First collection = base strength; second = first upgrade.
      store.collect(id);
      expectReadout(1);
      store.collect(id);
      expectReadout(2);
      // Mid level (upgrade 3) and cap-saturated level (upgrade 8).
      store.collect(id);
      store.collect(id);
      expectReadout(4);
      for (let i = 0; i < 5; i++) store.collect(id);
      expectReadout(9);

      // Next power-up starts from a clean run.
      scene.restartRun();
    }
  });

  it('AC4 — every power-up P3–P10 has at least one growing axis (observable via the readout)', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;

    for (const id of POWER_UP_LEVEL_IDS) {
      const read = () =>
        scene.getReadout().rows.find((r) => r.powerUpId === id)!.stats;
      const base = { ...read() };
      // Collect far past the first upgrade so at least one catalogue
      // variable must have grown from its base value (e.g. Extra Life's
      // `livesCap` is flat by design but `lifeGain` grows).
      for (let i = 0; i < 8; i++) player.collectPowerUp(id);
      const grown = read();
      const variableGrew = POWER_UP_LEVEL_SPECS[id].some((spec) => {
        const before = (base as unknown as Record<string, number>)[spec.variable];
        const after = (grown as unknown as Record<string, number>)[spec.variable];
        return after > before;
      });
      expect(variableGrew, `${id} must demonstrate a growing level axis`).toBe(
        true,
      );
      scene.restartRun();
    }
  });

  it('AC4/AC5 — levels reset only on run restart (public restartRun seam)', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();

    // Mix field pickups (each with its own per-upgrade TTL) and a permanent
    // grant.
    player.collectPowerUp('teleport');
    player.collectPowerUp('extra_life');
    player.collectPowerUp('extra_life', true);
    expect(player.getPowerUpLevel('teleport')).toBe(1);
    expect(player.getPowerUpLevel('extra_life')).toBe(2);

    // Advancing a little time (well inside every TTL) never resets the levels
    // — only the run-restart seam does.
    scene.tick(1000);
    expect(player.getPowerUpLevel('teleport')).toBe(1);
    expect(player.getPowerUpLevel('extra_life')).toBe(2);

    scene.restartRun();
    for (const id of POWER_UP_LEVEL_IDS) {
      expect(player.getPowerUpLevel(id), `${id} reset`).toBe(0);
    }
    expect(store.getPermanentLevel('extra_life')).toBe(0);
  });

  it('AC3 — the readout panel shows the run-scoped level and resolver stats, updating as the level rises', async () => {
    const scene = await boot();
    const panel = scene.getPanel()!;
    expect(panel.id).toBe(POWER_UP_READOUT_PANEL_ID);

    const player = scene.getPlayer()!;
    const levelEl = (id: string) =>
      panel.querySelector(`[data-powerup-label="${id}"]`);
    const statsEl = (id: string) =>
      panel.querySelector(`[data-powerup-stats="${id}"]`);

    expect(levelEl('shield')!.textContent).toContain(
      `${getPowerUpById('shield').name} — Lv 0`,
    );

    // Collect through the field path and refresh the live readout.
    scene.spawnDrop('shield', player.x, player.y);
    scene.tick(0.1);
    scene.refreshReadout();
    expect(levelEl('shield')!.textContent).toContain('Lv 1');
    expect(statsEl('shield')!.textContent).toContain('Shield time');
    expect(statsEl('shield')!.textContent).toContain('Shield hits');
  });

  it('survives a stop/restart of the same instance without leaking the panel', async () => {
    const scene = await boot();
    expect(scene.getPlayer()).not.toBeNull();
    scene.scene.restart();
    await advanceGame(booted!.game, 60);
    expect(scene.getPlayer()).not.toBeNull();
    // The readout panel is rebuilt fresh (single DOM node for the instance).
    expect(
      document.querySelectorAll(`#${POWER_UP_READOUT_PANEL_ID}`).length,
    ).toBe(1);
  });
});

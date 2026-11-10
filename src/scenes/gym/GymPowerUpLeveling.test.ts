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
  RED_MINERAL_SHARE,
  type PowerUpLevelReadout,
} from './GymPowerUpLeveling';
import {
  MINERAL_COLOR,
  MINERAL_DEPOSIT_COLOR,
  MINERAL_DEPOSIT_VALUE,
} from '../../core/constants';
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
import {
  resolvePlayerSlotState,
  slotCountedHeldIds,
} from '../../powerups/slots';

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

  /** True when a spawned mineral is the shared red 10-value deposit. */
  function isRedDeposit(
    mineral: ReturnType<GymPowerUpLeveling['spawnMineral']>,
  ): boolean {
    return mineral.entity.value === MINERAL_DEPOSIT_VALUE;
  }

  it('AC1/AC2 — the periodic mineral stream guarantees >= 30% red 10-value deposits', async () => {
    const scene = await boot();
    // The guarantee is a named constant (`RED_MINERAL_SHARE`, >= 30%); the
    // fixed rotation must keep every window of ten consecutive spawns at or
    // above it rather than relying on a per-spawn probability.
    expect(RED_MINERAL_SHARE).toBeGreaterThanOrEqual(0.3);

    const stream = Array.from({ length: 30 }, () => scene.spawnMineral());
    for (let start = 0; start + 10 <= stream.length; start++) {
      const red = stream.slice(start, start + 10).filter(isRedDeposit);
      expect(red.length, `red minerals in window at ${start}`).toBeGreaterThanOrEqual(3);
    }

    // Red spawns are the existing deposit; every other spawn keeps the
    // ordinary gold 1-value mineral.
    for (const mineral of stream) {
      if (isRedDeposit(mineral)) {
        expect(mineral.entity.color).toBe(MINERAL_DEPOSIT_COLOR);
        expect(mineral.entity.value).toBe(MINERAL_DEPOSIT_VALUE);
      } else {
        expect(mineral.entity.color).toBe(MINERAL_COLOR);
        expect(mineral.entity.value).toBe(1);
      }
    }
  });

  it('AC1/AC4 — the red/gold mix is a fixed rotation, unaffected by the content RNG', async () => {
    const scene = await boot();
    // A fixed three-spawn rotation: the colour repeats every three spawns and
    // exactly one mineral in each triple is red. The absolute phase is not
    // asserted because a booted scene may already have spawned a mineral.
    const defaultPlacement = Array.from({ length: 6 }, () => scene.spawnMineral());
    for (let i = 0; i + 3 < defaultPlacement.length; i++) {
      expect(
        isRedDeposit(defaultPlacement[i + 3]),
        `spawn ${i + 3} repeats the rotation of spawn ${i}`,
      ).toBe(isRedDeposit(defaultPlacement[i]));
    }
    for (const start of [0, 1, 2]) {
      const triple = defaultPlacement.slice(start, start + 3);
      expect(triple.filter(isRedDeposit), `triple at ${start}`).toHaveLength(1);
    }

    // The colour is not drawn from `sceneRng`: spawning at explicit positions
    // (no position draws) continues the same red/gold sequence, so a capture
    // seed can never change the mix.
    const explicitPlacement = Array.from({ length: 6 }, (_, i) =>
      scene.spawnMineral(100 + i * 10, 200),
    );
    expect(explicitPlacement.map(isRedDeposit)).toEqual(
      defaultPlacement.map(isRedDeposit),
    );
  });

  it('AC1 — the periodic cadence emits the red deposit and keeps the 2.0 s interval', async () => {
    const scene = await boot();
    // The cadence spawns immediately, then one mineral every 2.0 s. Only the
    // minerals this cadence adds are inspected (a booted scene may already
    // have spawned one).
    const before = scene.getMinerals().length;
    scene.tick(2.0);
    scene.tick(2.0);
    scene.tick(2.0);

    const spawned = scene.getMinerals().slice(before);
    expect(spawned).toHaveLength(3);
    // Three consecutive spawns hold exactly one red deposit; the rest are the
    // ordinary gold 1-value minerals.
    const red = spawned.filter(isRedDeposit);
    expect(red).toHaveLength(1);
    expect(red[0].entity.color).toBe(MINERAL_DEPOSIT_COLOR);
    expect(red[0].entity.value).toBe(MINERAL_DEPOSIT_VALUE);
    for (const gold of spawned.filter((m) => !isRedDeposit(m))) {
      expect(gold.entity.color).toBe(MINERAL_COLOR);
      expect(gold.entity.value).toBe(1);
    }
  });

  it('AC3 — collecting a red mineral credits 10 in one pickup; gold still credits 1', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const hold = scene.getHold();
    // Headroom above the 3-mineral first hold so the 10-value pickup is not
    // capped by the hold (the shared overflow carry is covered elsewhere).
    hold.capacity = 30;

    const spawns = Array.from({ length: 3 }, () => scene.spawnMineral());
    const red = spawns.find(isRedDeposit);
    const gold = spawns.find((mineral) => !isRedDeposit(mineral));
    expect(red).toBeDefined();
    expect(gold).toBeDefined();

    red!.entity.setPosition(player.x, player.y);
    scene.collectMineralsOverlapping();
    expect(hold.store).toBe(MINERAL_DEPOSIT_VALUE);

    gold!.entity.setPosition(player.x, player.y);
    scene.collectMineralsOverlapping();
    expect(hold.store).toBe(MINERAL_DEPOSIT_VALUE + 1);
  });

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

    // The permanent shield effect window is gone in this conversion (parent
    // AH-0MVUVSW4J0009QUW): the pool is the whole model, so the permanent
    // base stays armed through its held charge rather than an effect window;
    // what changed here is the **store**: the kind is owned and holds one
    // charge without being levelled.
    expect(registry.isShielded).toBe(true);
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
    // The readout renders the shared specs — exactly the two retained axes
    // (the retired bubble-window axis is gone, AH-0MVVD8SXO004QLZW).
    expect(statsEl('shield')!.textContent).toContain('Shield recharge');
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

  // ── Manual assign (AH-0MW82M3LB007OQG6) ──────────────────────────

  /** Six ordinary slot-counted, non-consumable power-ups. */
  const COUNTED_KINDS: PowerUpId[] = [
    'bomb',
    'speed_boost',
    'magnet',
    'mineral_scoop',
    'smart_bomb',
    'frenzy',
  ];

  it('AC1 — every readout row renders one native Assign button', async () => {
    const scene = await boot();
    const panel = scene.getPanel()!;
    for (const id of POWER_UP_LEVEL_IDS) {
      const btn = panel.querySelector<HTMLButtonElement>(
        `[data-powerup-assign="${id}"]`,
      );
      expect(btn, `${id} assign button`).not.toBeNull();
      expect(btn!.tagName).toBe('BUTTON');
      expect(btn!.type).toBe('button');
      expect(btn!.textContent).toBe('Assign');
    }
  });

  it('AC1 — one button click assigns exactly once (no double fire)', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const btn = scene
      .getPanel()!
      .querySelector<HTMLButtonElement>('[data-powerup-assign="bomb"]')!;

    btn.click();
    expect(store.getPermanentLevel('bomb')).toBe(1);
    btn.click();
    expect(store.getPermanentLevel('bomb')).toBe(2);
  });

  it('AC2 — first Assign adds an unowned non-consumable at base level', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const id: PowerUpId = 'bomb';
    expect(player.getPowerUpLevel(id)).toBe(0);

    scene.assignPowerUp(id);

    // Base = permanent level 1 = resolver upgrade level 0.
    expect(store.getPermanentLevel(id)).toBe(1);
    expect(player.getPowerUpLevel(id)).toBe(1);
    const row = scene.getReadout().rows.find((r) => r.powerUpId === id)!;
    expect(row.upgradeLevel).toBe(0);
    expect(row.stats).toEqual(resolvePowerUpAtLevel(id, 0));

    // The row label reflects the new level immediately (same call).
    expect(
      scene
        .getPanel()!
        .querySelector(`[data-powerup-label="${id}"]`)!.textContent,
    ).toContain('Lv 1');
  });

  it('AC2 — repeat Assign raises a non-consumable permanent level, never a temporary stack', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    scene.assignPowerUp('bomb');
    scene.assignPowerUp('bomb');

    expect(store.getPermanentLevel('bomb')).toBe(2);
    expect(store.getTempStacks('bomb')).toBe(0);
    expect(player.getPowerUpLevel('bomb')).toBe(2);
  });

  it('AC2 — a consumable Assign banks one clamped charge per click, never a level', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const id: PowerUpId = 'force_field';

    scene.assignPowerUp(id);
    expect(store.isConsumableOwned(id)).toBe(true);
    expect(store.getPermanentLevel(id)).toBe(0);
    expect(store.consumableCharges(id)).toBe(1);

    scene.assignPowerUp(id);
    expect(store.getPermanentLevel(id)).toBe(0);
    expect(store.consumableCharges(id)).toBe(2);
  });

  it('AC3 — a full loadout removes exactly one slot-counted kind before adding the new one', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    for (const id of COUNTED_KINDS) player.collectPowerUp(id, true);
    expect(resolvePlayerSlotState(player).isFull).toBe(true);
    expect(resolvePlayerSlotState(player).used).toBe(6);

    scene.assignPowerUp('chrono');

    const after = resolvePlayerSlotState(player);
    // One kind out, the new kind in: still exactly six counted slots.
    expect(after.used).toBe(6);
    expect(after.heldIds.has('chrono')).toBe(true);
    const removed = COUNTED_KINDS.filter((id) => !after.heldIds.has(id));
    expect(removed).toHaveLength(1);
    // Whole-kind clear: the removed kind leaves no residual state.
    const victim = removed[0];
    expect(store.getEffectiveLevel(victim)).toBe(0);
    expect(store.getPermanentLevel(victim)).toBe(0);
    expect(store.getTempStacks(victim)).toBe(0);
  });

  it('AC4 — the victim draw is seeded/deterministic and never an exempt kind', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const exempt: PowerUpId[] = ['extra_life', 'mystery_ufo'];
    const victims = new Set<PowerUpId>();

    for (let i = 0; i < COUNTED_KINDS.length; i++) {
      player.resetPowerUpLevels();
      for (const id of COUNTED_KINDS) player.collectPowerUp(id, true);
      for (const id of exempt) player.collectPowerUp(id, true);

      // Pin the draw to index i of the sorted slot-counted held pool.
      scene.setSceneRng(() => i / COUNTED_KINDS.length);
      scene.assignPowerUp('chrono');

      for (const id of exempt) {
        // Exempt kinds stay held (Extra Life at its permanent level, Mystery
        // UFO owned through its grant) — they are never in the victim pool.
        expect(
          resolvePlayerSlotState(player).heldIds.has(id),
          `${id} never a victim`,
        ).toBe(true);
      }
      const surviving = COUNTED_KINDS.filter(
        (id) => store.getEffectiveLevel(id) > 0,
      );
      expect(surviving).toHaveLength(COUNTED_KINDS.length - 1);
      const removed = COUNTED_KINDS.find(
        (id) => store.getEffectiveLevel(id) === 0,
      );
      expect(removed).toBeDefined();
      victims.add(removed!);
    }

    // Every index selected a different victim — the draw is real, not fixed.
    expect(victims.size).toBe(COUNTED_KINDS.length);
  });

  it('AC4 — the same seed reproduces the same victim', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();

    const drawWith = (seedValue: number): PowerUpId => {
      player.resetPowerUpLevels();
      for (const id of COUNTED_KINDS) player.collectPowerUp(id, true);
      scene.setSceneRng(() => seedValue);
      scene.assignPowerUp('chrono');
      return COUNTED_KINDS.find((id) => store.getEffectiveLevel(id) === 0)!;
    };

    expect(drawWith(0.42)).toBe(drawWith(0.42));
  });

  it('AC6 — removal clears the victim’s temporary and consumable state', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    for (const id of ['bomb', 'speed_boost', 'magnet', 'mineral_scoop', 'frenzy'] as PowerUpId[]) {
      player.collectPowerUp(id, true);
    }
    // Force Field is both permanently owned (with a banked charge) and holding
    // an active temporary stack.
    player.collectPowerUp('force_field', true);
    player.collectPowerUp('force_field');
    expect(store.getTempStacks('force_field')).toBe(1);
    expect(store.consumableCharges('force_field')).toBe(1);
    expect(resolvePlayerSlotState(player).isFull).toBe(true);

    const pool = slotCountedHeldIds(resolvePlayerSlotState(player));
    const index = pool.indexOf('force_field');
    expect(index).toBeGreaterThanOrEqual(0);
    scene.setSceneRng(() => index / pool.length);
    scene.assignPowerUp('chrono');

    expect(store.getEffectiveLevel('force_field')).toBe(0);
    expect(store.getTempStacks('force_field')).toBe(0);
    expect(store.getPermanentLevel('force_field')).toBe(0);
    expect(store.consumableCharges('force_field')).toBe(0);
    expect(store.isConsumableOwned('force_field')).toBe(false);
    // The slot genuinely freed and the new kind took it.
    const after = resolvePlayerSlotState(player);
    expect(after.heldIds.has('force_field')).toBe(false);
    expect(after.heldIds.has('chrono')).toBe(true);
    expect(after.used).toBe(6);
  });

  it('AC5 — a non-consumable Assign disables once every discrete axis reaches its cap', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const id: PowerUpId = 'magnet';

    scene.assignPowerUp(id);
    expect(scene.isAssignDisabled(id)).toBe(false);

    // Magnet has one discrete axis (magnetStacks 1 → 5); upgrade level 6
    // resolves it to the cap.
    store.setPermanentLevel(id, 7);
    expect(scene.isAssignDisabled(id)).toBe(true);

    scene.refreshReadout();
    const btn = scene
      .getPanel()!
      .querySelector<HTMLButtonElement>(`[data-powerup-assign="${id}"]`)!;
    expect(btn.disabled).toBe(true);

    // At cap the click is a no-op.
    const before = store.getPermanentLevel(id);
    scene.assignPowerUp(id);
    expect(store.getPermanentLevel(id)).toBe(before);
  });

  it('AC5 — a consumable Assign disables when its charge pool is full', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const id: PowerUpId = 'force_field';

    expect(scene.isAssignDisabled(id)).toBe(false);
    scene.assignPowerUp(id);
    expect(scene.isAssignDisabled(id)).toBe(false);

    store.grantConsumableCharge(id, 99); // fill to the level-derived cap
    const cap = store.consumableChargeCap(id);
    expect(store.consumableCharges(id)).toBe(cap);
    expect(scene.isAssignDisabled(id)).toBe(true);

    scene.assignPowerUp(id);
    expect(store.consumableCharges(id)).toBe(cap);
  });

  it('AC5 — a single-use Assign disables while its ready activation is held', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const store = player.getPowerUpLevelStore();
    const id: PowerUpId = 'phase_shift';

    expect(scene.isAssignDisabled(id)).toBe(false);
    scene.assignPowerUp(id);
    expect(store.hasPhaseShift()).toBe(true);
    expect(scene.isAssignDisabled(id)).toBe(true);
  });

  it('AC5 — a power-up with no discrete variables is never disabled', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    // Chrono has only continuous axes, which asymptote and never reach cap.
    player.getPowerUpLevelStore().setPermanentLevel('chrono', 100);
    expect(scene.isAssignDisabled('chrono')).toBe(false);
  });
});

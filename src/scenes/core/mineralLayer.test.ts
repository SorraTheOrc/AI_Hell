/**
 * Shared mineral collection/reward helpers tests (AH-0MUII3DHM008L7JF, gap 5).
 *
 * `collectMinerals` and `applyMineralChoiceReward` are the single
 * implementations the game (`PlayScene`) and the gyms
 * (`GymFormationScene`) call, so these unit tests pin the shared contract:
 * player pickup, non-asteroid enemy absorption, survivor handling, and
 * permanent reward application.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Mineral } from '../../entities/Mineral';
import { EffectsRegistry } from '../../powerups/effects';
import type { ChoiceOption } from '../../powerups/choice';
import { applyMineralChoiceReward, collectMinerals } from './mineralLayer';

/** Structural fake of a `Mineral` — the routine only calls these members. */
function fakeMineral(x: number, y: number, alive = true) {
  return {
    x,
    y,
    alive,
    handleOverlap: vi.fn(),
    destroy: vi.fn(),
  };
}

/** A mineral-absorbing enemy fake (game/gym archetypes are structurally equal). */
function fakeEnemy(x: number, y: number, radius = 10) {
  return {
    x,
    y,
    alive: true,
    getHitRadius: () => radius,
    collectMineral: vi.fn(),
  };
}

function asMinerals(list: ReturnType<typeof fakeMineral>[]): Mineral[] {
  return list as unknown as Mineral[];
}

describe('collectMinerals', () => {
  it('collects a player-overlapping mineral and drops it from the field', () => {
    const mineral = fakeMineral(100, 100);
    const onPlayerCollected = vi.fn();
    const enemy = fakeEnemy(100, 100);

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 100, y: 100 },
      [enemy],
      onPlayerCollected,
    );

    expect(kept).toHaveLength(0);
    expect(mineral.handleOverlap).toHaveBeenCalledWith('player');
    expect(onPlayerCollected).toHaveBeenCalledOnce();
    expect(mineral.destroy).toHaveBeenCalledOnce();
    // The player wins the overlap — the enemy never absorbs it.
    expect(enemy.collectMineral).not.toHaveBeenCalled();
  });

  it('lets a non-asteroid enemy absorb an overlapping mineral when no player is near', () => {
    const mineral = fakeMineral(50, 50);
    const enemy = fakeEnemy(50, 50);
    const onPlayerCollected = vi.fn();

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 900, y: 900 },
      [enemy],
      onPlayerCollected,
    );

    expect(kept).toHaveLength(0);
    expect(enemy.collectMineral).toHaveBeenCalledOnce();
    expect(mineral.handleOverlap).toHaveBeenCalledWith('enemy');
    expect(onPlayerCollected).not.toHaveBeenCalled();
    expect(mineral.destroy).toHaveBeenCalledOnce();
  });

  it('keeps minerals that overlap nothing and never destroys them', () => {
    const mineral = fakeMineral(10, 10);

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 900, y: 900 },
      [fakeEnemy(800, 800)],
      vi.fn(),
    );

    expect(kept).toEqual(asMinerals([mineral]));
    expect(mineral.destroy).not.toHaveBeenCalled();
    expect(mineral.handleOverlap).not.toHaveBeenCalled();
  });

  it('skips dead minerals (they are cleared, not collected again)', () => {
    const mineral = fakeMineral(100, 100, false);
    const onPlayerCollected = vi.fn();

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 100, y: 100 },
      [],
      onPlayerCollected,
    );

    expect(kept).toHaveLength(0);
    expect(onPlayerCollected).not.toHaveBeenCalled();
    expect(mineral.destroy).toHaveBeenCalledOnce();
  });

  // ── P6 Phase Shift mineral gate (Q7, parent AH-0MUIYX1EE008FVS8) ──

  it('blocks player collection while phased and keeps the mineral on the field', () => {
    const mineral = fakeMineral(100, 100);
    const onPlayerCollected = vi.fn();

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 100, y: 100 },
      [fakeEnemy(900, 900)],
      onPlayerCollected,
      { playerPhased: true },
    );

    // The mineral survives (not collected, not destroyed) so it can be
    // picked up the moment the phase expires.
    expect(kept).toEqual(asMinerals([mineral]));
    expect(onPlayerCollected).not.toHaveBeenCalled();
    expect(mineral.handleOverlap).not.toHaveBeenCalled();
    expect(mineral.destroy).not.toHaveBeenCalled();
  });

  it('resumes player collection once the phase expires', () => {
    const mineral = fakeMineral(100, 100);
    const onPlayerCollected = vi.fn();

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 100, y: 100 },
      [],
      onPlayerCollected,
      { playerPhased: false },
    );

    expect(kept).toHaveLength(0);
    expect(onPlayerCollected).toHaveBeenCalledOnce();
    expect(mineral.handleOverlap).toHaveBeenCalledWith('player');
  });

  it('still lets enemies absorb minerals while the player is phased', () => {
    const mineral = fakeMineral(100, 100);
    const enemy = fakeEnemy(100, 100);
    const onPlayerCollected = vi.fn();

    const kept = collectMinerals(
      asMinerals([mineral]),
      { x: 100, y: 100 },
      [enemy],
      onPlayerCollected,
      { playerPhased: true },
    );

    expect(kept).toHaveLength(0);
    expect(enemy.collectMineral).toHaveBeenCalledOnce();
    expect(onPlayerCollected).not.toHaveBeenCalled();
  });
});

describe('applyMineralChoiceReward', () => {
  it('permanently equips a chosen weapon', () => {
    const registry = new EffectsRegistry();
    const applyWeapon = vi.spyOn(registry, 'applyWeapon');
    const player = { equipWeapon: vi.fn(), collectPowerUp: vi.fn() };
    const option: ChoiceOption = {
      id: 'spread',
      name: 'Spread Shot',
      kind: 'weapon',
    };

    applyMineralChoiceReward(option, registry, player);

    expect(applyWeapon).toHaveBeenCalledWith('spread', true);
    expect(player.equipWeapon).toHaveBeenCalledWith('spread', true);
  });

  it('permanently levels up a chosen owned weapon via the shared equip path (AC3)', () => {
    const registry = new EffectsRegistry();
    const applyWeapon = vi.spyOn(registry, 'applyWeapon');
    const player = { equipWeapon: vi.fn(), collectPowerUp: vi.fn() };
    const option: ChoiceOption = {
      id: 'spread',
      name: 'Spread Shot Lv.3',
      kind: 'weapon-level',
      level: 3,
    };

    applyMineralChoiceReward(option, registry, player);

    // The same permanent-equip path grants the level-up: Player.equipWeapon
    // increments the run-scoped level on every collection.
    expect(applyWeapon).toHaveBeenCalledWith('spread', true);
    expect(player.equipWeapon).toHaveBeenCalledWith('spread', true);
  });

  it('permanently applies a chosen power-up (no weapon equip)', () => {
    const registry = new EffectsRegistry();
    const applyCollect = vi.spyOn(registry, 'applyCollect');
    const collectPowerUp = vi.fn(() => 1);
    const player = { equipWeapon: vi.fn(), collectPowerUp };
    const option: ChoiceOption = {
      id: 'P5',
      name: 'Speed Boost',
      kind: 'powerup',
    };

    applyMineralChoiceReward(option, registry, player);

    expect(applyCollect).toHaveBeenCalledWith('P5', true);
    expect(collectPowerUp).toHaveBeenCalledWith('P5', true);
    expect(player.equipWeapon).not.toHaveBeenCalled();
  });

  it('applies a power-up-level offer (effect + level increment)', () => {
    const registry = new EffectsRegistry();
    const applyCollect = vi.spyOn(registry, 'applyCollect');
    const collectPowerUp = vi.fn(() => 2);
    const player = { equipWeapon: vi.fn(), collectPowerUp };
    const option: ChoiceOption = {
      id: 'P3',
      name: 'Shield Lv.2',
      kind: 'power-up-level',
      level: 2,
    };

    applyMineralChoiceReward(option, registry, player);

    expect(applyCollect).toHaveBeenCalledWith('P3', true);
    expect(collectPowerUp).toHaveBeenCalledWith('P3', true);
    expect(player.equipWeapon).not.toHaveBeenCalled();
  });

  it('applies the reward without a player (no ship) for power-ups', () => {
    const registry = new EffectsRegistry();
    const applyCollect = vi.spyOn(registry, 'applyCollect');

    applyMineralChoiceReward(
      { id: 'P3', name: 'Shield', kind: 'powerup' },
      registry,
      null,
    );

    expect(applyCollect).toHaveBeenCalledWith('P3', true);
  });
});

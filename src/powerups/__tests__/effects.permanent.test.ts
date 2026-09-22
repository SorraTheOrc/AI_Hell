/**
 * Permanent-effect support tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC4/AC5: a chosen effect
 * is applied to the player as a permanent effect for the current run —
 * including weapon drops, which normally expire — and permanence is scoped
 * to the run (cleared on reset).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { EffectsRegistry, WEAPON_EFFECT_DURATION } from '../effects';
import { Player } from '../../entities/Player';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScenePermanent');
  }
}

describe('EffectsRegistry permanent effects', () => {
  it('a normal timed power-up expires', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P5');
    registry.tick(11);
    expect(registry.isActive('P5')).toBe(false);
  });

  it('a permanent timed power-up never expires for the run', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P5', true);
    registry.tick(1000);
    expect(registry.isActive('P5')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);
  });

  it('a normal weapon drop expires', () => {
    const registry = new EffectsRegistry();
    registry.applyWeapon('spread');
    registry.tick(WEAPON_EFFECT_DURATION + 1);
    expect(registry.hasWeapon('spread')).toBe(false);
  });

  it('a permanent weapon drop never expires for the run', () => {
    const registry = new EffectsRegistry();
    registry.applyWeapon('spread', true);
    registry.tick(1000);
    expect(registry.hasWeapon('spread')).toBe(true);
  });

  it('permanence is scoped to the run — reset() clears it', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P5', true);
    registry.applyWeapon('spread', true);

    registry.reset();

    expect(registry.isActive('P5')).toBe(false);
    expect(registry.hasWeapon('spread')).toBe(false);
  });
});

describe('Player permanent weapon choices', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makePlayer(scene: Phaser.Scene): Player {
    const player = new Player(scene, { x: 100, y: 100 });
    scene.add.existing(player);
    return player;
  }

  it('a normal collected weapon expires after its timer', async () => {
    booted = await bootScene([HarnessScene]);
    const player = makePlayer(booted.scene);
    player.equipWeapon('spread');

    player.tickWeaponTimers(WEAPON_EFFECT_DURATION * 1000 + 1);

    expect(player.hasWeapon('spread')).toBe(false);
  });

  it('a permanently chosen weapon never expires for the run', async () => {
    booted = await bootScene([HarnessScene]);
    const player = makePlayer(booted.scene);
    player.equipWeapon('spread', true);

    player.tickWeaponTimers(1000 * 1000);

    expect(player.hasWeapon('spread')).toBe(true);
    expect(player.getActiveWeapons()).toContain('spread');
  });

  it('permanence is scoped to the run — resetWeapon() clears it', async () => {
    booted = await bootScene([HarnessScene]);
    const player = makePlayer(booted.scene);
    player.equipWeapon('rapid', true);

    player.resetWeapon();

    expect(player.hasWeapon('rapid')).toBe(false);
    expect(player.getActiveWeapons()).toEqual(['cannon']);
  });
});

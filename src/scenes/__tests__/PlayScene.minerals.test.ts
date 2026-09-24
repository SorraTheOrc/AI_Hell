/**
 * PlayScene mineral wiring tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC1/AC4/AC8: small
 * asteroids drop minerals, the player collects them into the hold, the
 * hold-full choice pauses play and offers three distinct options, the chosen
 * effect is permanent for the run, and non-asteroid enemies absorb minerals
 * and re-drop a fraction on death.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { PlayScene } from '../PlayScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import type { ChoiceOption, ChoiceStrategy } from '../../powerups/choice';

/** Builds a strategy that always offers the supplied options. */
function fixedStrategy(options: ChoiceOption[]): ChoiceStrategy {
  return { choose: () => options };
}

describe('PlayScene mineral wiring', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([
      PlayScene,
      MineralChoiceScene,
      GameOverScene,
      MenuScene,
    ]);
    return booted.scene as PlayScene;
  }

  it('registers a spawned mineral on the field', async () => {
    const scene = await bootPlay();
    scene.spawnMineralAt(100, 100);
    expect(scene.getMinerals()).toHaveLength(1);
  });

  it('the player collects an overlapping mineral into the hold', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const before = scene.getGameState().minerals;

    scene.spawnMineralAt(player.x, player.y);
    scene.tick(0.016);

    expect(scene.getMinerals()).toHaveLength(0);
    expect(scene.getGameState().minerals).toBe(before + 1);
  });

  it('reaching capacity pauses play and opens the choice with three distinct options', async () => {
    const scene = await bootPlay();
    scene.getGameState().mineralCapacity = 1;
    const player = scene.getPlayer()!;

    scene.spawnMineralAt(player.x, player.y);
    scene.tick(0.016);

    expect(scene.getGameState().isHoldFull()).toBe(true);
    expect(scene.isMineralChoiceOpen()).toBe(true);
    expect(scene.isPaused()).toBe(true);

    // Paused at the SceneManager level (mirrors PauseScene). The pause op is
    // applied on the next game step, so allow a frame to elapse.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(scene.scene.isPaused()).toBe(true);

    const options = scene.getMineralChoiceOptions();
    expect(options).toHaveLength(3);
    expect(new Set(options.map((o) => o.id)).size).toBe(3);
  });

  it('a chosen power-up is applied permanently for the run', async () => {
    const scene = await bootPlay();
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
        { id: 'P9', name: 'Magnet', kind: 'powerup' },
        { id: 'P3', name: 'Shield', kind: 'powerup' },
      ]),
    );
    scene.openMineralChoice();

    const chosen = scene.selectMineralChoice(0)!;

    expect(chosen.id).toBe('P5');
    const registry = scene.getEffectsRegistry();
    expect(registry.isActive('P5')).toBe(true);
    // Permanent — a long tick does not expire it.
    registry.tick(1000);
    expect(registry.isActive('P5')).toBe(true);
    expect(scene.isMineralChoiceOpen()).toBe(false);
    expect(scene.isPaused()).toBe(false);
  });

  it('a chosen weapon is applied permanently for the run', async () => {
    const scene = await bootPlay();
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
        { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
        { id: 'P9', name: 'Magnet', kind: 'powerup' },
      ]),
    );
    scene.openMineralChoice();

    const chosen = scene.selectMineralChoice(0)!;

    expect(chosen.id).toBe('spread');
    const player = scene.getPlayer()!;
    expect(player.hasWeapon('spread')).toBe(true);
    // Permanent — a long weapon-timer tick does not expire it.
    player.tickWeaponTimers(1000 * 1000);
    expect(player.hasWeapon('spread')).toBe(true);
  });

  it('resolves the hold with overflow when the choice is resolved', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();
    gs.mineralCapacity = 5;
    gs.minerals = 5;
    gs.addMinerals(3); // store = 5, overflow = 3
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
        { id: 'P9', name: 'Magnet', kind: 'powerup' },
        { id: 'P3', name: 'Shield', kind: 'powerup' },
      ]),
    );
    scene.openMineralChoice();

    scene.selectMineralChoice(0);

    expect(gs.minerals).toBe(3); // overflow carried
  });

  it('a non-asteroid enemy absorbs an overlapping mineral without damage', async () => {
    const scene = await bootPlay();
    const enemy = scene.getEnemies().find((e) => e.alive)!;

    scene.spawnMineralAt(enemy.x, enemy.y);
    scene.tick(0.016);

    // The mineral was absorbed (not left on the field) and counted.
    const stillPresent = scene
      .getMinerals()
      .some((m) => m.x === enemy.x && m.y === enemy.y);
    expect(stillPresent).toBe(false);
    expect(enemy.mineralCount).toBeGreaterThanOrEqual(1);
  });

  it('a destroyed small asteroid drops a mineral; a large one does not', async () => {
    const scene = await bootPlay();

    const large = scene.spawnAsteroidAt(120, 120, 'large');
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getMinerals()).toHaveLength(0);

    const small = scene.spawnAsteroidAt(700, 120, 'small');
    scene.spawnPlayerBullet(small.x, small.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getMinerals()).toHaveLength(1);
  });
});

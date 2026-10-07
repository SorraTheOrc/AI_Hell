/**
 * PlayScene power-up level-up choice integration tests
 * (parent AH-0MUV5CLVO002ZHS9).
 *
 * End-to-end: the hold-full choice receives the run's power-up ownership /
 * levels through `ChoiceContext.powerUpLevels`, and a chosen
 * `'power-up-level'` offer strengthens the owned power-up and raises its
 * run-scoped level via the shared `applyMineralChoiceReward` path. The game
 * consumes the same shared choice contract the gyms use, so these tests pin
 * the game-side half of the gym↔game parity requirement.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { PlayScene } from '../PlayScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import type { ChoiceContext, ChoiceOption, ChoiceStrategy } from '../../powerups/choice';

/** Builds a strategy that always offers the supplied options. */
function fixedStrategy(options: ChoiceOption[]): ChoiceStrategy {
  return { choose: () => options };
}

describe('PlayScene power-up level-up choice (AH-0MUV5CLVO002ZHS9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
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

  it('a field pickup levels the power-up in the player store (AC1/AC5)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const effects = scene.getEffectsRegistry();
    expect(player.getPowerUpLevel('speed_boost')).toBe(0);

    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);

    // The shared `applyCollect` advanced the single player-owned store, so
    // the field pickup levels the power-up exactly once.
    expect(player.getPowerUpLevel('speed_boost')).toBe(1);
    expect(effects.isActive('speed_boost')).toBe(true);
    expect(effects.speedMultiplier()).toBeGreaterThan(1);
  });

  it('a hold-full level-up raises the level by exactly one, no double-count (AC1/AC3)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const effects = scene.getEffectsRegistry();

    // Field pickup → level 1.
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(player.getPowerUpLevel('speed_boost')).toBe(1);

    // Hold-full power-up-level reward → level 2 (exactly one more).
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'speed_boost', name: 'Speed Boost Lv.2', kind: 'power-up-level', level: 2 },
      ]),
    );
    scene.openMineralChoice();
    scene.selectMineralChoice(0);

    expect(player.getPowerUpLevel('speed_boost')).toBe(2);
    expect(effects.isActive('speed_boost')).toBe(true);
  });

  it('the mineral choice receives the player permanent power-up levels (context)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    // Own a power-up permanently (the choice's ownership source). A field
    // pickup adds only a temporary stack, so it is not owned for the choice.
    player.collectPowerUp('phase_shift');
    player.collectPowerUp('speed_boost', true);

    let context: ChoiceContext | undefined;
    scene.setMineralChoiceStrategy({
      choose: (_count, _rng, ctx) => {
        context = ctx;
        return [{ id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' }];
      },
    });
    scene.openMineralChoice();

    expect(context?.powerUpLevels).toEqual([{ id: 'speed_boost', level: 1 }]);
  });

  it('a permanent power-up-level choice strengthens an owned power-up for the run', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const effects = scene.getEffectsRegistry();

    // Own Speed Boost at level 1.
    player.collectPowerUp('speed_boost');
    expect(player.getPowerUpLevel('speed_boost')).toBe(1);

    // Offer a permanent level-up and choose it.
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'speed_boost', name: 'Speed Boost Lv.2', kind: 'power-up-level', level: 2 },
      ]),
    );
    scene.openMineralChoice();
    scene.selectMineralChoice(0);

    // The level rose and the immediate effect is applied permanently.
    expect(player.getPowerUpLevel('speed_boost')).toBe(2);
    expect(effects.isActive('speed_boost')).toBe(true);
    expect(effects.speedMultiplier()).toBeGreaterThan(1);
    // Permanent — it never times out.
    effects.tick(120);
    expect(effects.isActive('speed_boost')).toBe(true);
  });

  it('a base power-up choice records ownership so future choices can offer a level-up', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const effects = scene.getEffectsRegistry();

    expect(player.getPowerUpLevel('shield')).toBe(0);

    scene.setMineralChoiceStrategy(
      fixedStrategy([{ id: 'shield', name: 'Shield', kind: 'powerup' }]),
    );
    scene.openMineralChoice();
    scene.selectMineralChoice(0);

    // Ownership is recorded (level 1) and the effect applied.
    expect(player.getPowerUpLevel('shield')).toBe(1);
    expect(effects.isActive('shield')).toBe(true);
  });

  it('a default-strategy hold-full draw never offers a base and a level-up power-up (AC2/AC4)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    // Own two power-ups permanently so the base-pool suppression path is
    // exercised.
    player.collectPowerUp('shield', true);
    player.collectPowerUp('speed_boost', true);

    for (let i = 0; i < 20; i++) {
      const options = scene.openMineralChoice();
      expect(options).toHaveLength(3);
      const ids = options.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      // An owned power-up is only ever offered as its level-up, never as a
      // bare base-pool `powerup` entry.
      expect(
        options.some(
          (o) => o.kind === 'powerup' && (o.id === 'shield' || o.id === 'speed_boost'),
        ),
      ).toBe(false);
      scene.selectMineralChoice(0);
    }
  });
});

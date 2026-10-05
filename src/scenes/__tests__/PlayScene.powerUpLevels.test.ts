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

  it('the mineral choice receives the player power-up levels (context)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    // Own a power-up (the run's ownership source).
    player.collectPowerUp('P5');

    let context: ChoiceContext | undefined;
    scene.setMineralChoiceStrategy({
      choose: (_count, _rng, ctx) => {
        context = ctx;
        return [{ id: 'P5', name: 'Speed Boost', kind: 'powerup' }];
      },
    });
    scene.openMineralChoice();

    expect(context?.powerUpLevels).toEqual([{ id: 'P5', level: 1 }]);
  });

  it('a permanent power-up-level choice strengthens an owned power-up for the run', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const effects = scene.getEffectsRegistry();

    // Own P5 at level 1.
    player.collectPowerUp('P5');
    expect(player.getPowerUpLevel('P5')).toBe(1);

    // Offer a permanent level-up and choose it.
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'P5', name: 'Speed Boost Lv.2', kind: 'power-up-level', level: 2 },
      ]),
    );
    scene.openMineralChoice();
    scene.selectMineralChoice(0);

    // The level rose and the immediate effect is applied permanently.
    expect(player.getPowerUpLevel('P5')).toBe(2);
    expect(effects.isActive('P5')).toBe(true);
    expect(effects.speedMultiplier()).toBeGreaterThan(1);
    // Permanent — it never times out.
    effects.tick(120);
    expect(effects.isActive('P5')).toBe(true);
  });

  it('a base power-up choice records ownership so future choices can offer a level-up', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const effects = scene.getEffectsRegistry();

    expect(player.getPowerUpLevel('P3')).toBe(0);

    scene.setMineralChoiceStrategy(
      fixedStrategy([{ id: 'P3', name: 'Shield', kind: 'powerup' }]),
    );
    scene.openMineralChoice();
    scene.selectMineralChoice(0);

    // Ownership is recorded (level 1) and the effect applied.
    expect(player.getPowerUpLevel('P3')).toBe(1);
    expect(effects.isActive('P3')).toBe(true);
  });
});

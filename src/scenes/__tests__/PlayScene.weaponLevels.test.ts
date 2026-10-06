/**
 * PlayScene weapon-leveling integration tests (parent AH-0MUPMPCB2009J54J).
 *
 * End-to-end: a weapon drop collected in the shipped game levels the weapon
 * up, the level persists while the weapon is active and across a timeout, and
 * a permanent hold-full choice raises the level for the rest of the run. The
 * game consumes the same shared resolver the gyms use, so these tests pin the
 * game-side half of the gym↔game parity contract.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { PlayScene } from '../PlayScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { WEAPON_CATALOGUE } from '../../utils/weapons';
import { resolveWeaponDefinition } from '../../utils/weaponLevels';
import type { ChoiceContext, ChoiceOption, ChoiceStrategy } from '../../powerups/choice';

/** Builds a strategy that always offers the supplied options. */
function fixedStrategy(options: ChoiceOption[]): ChoiceStrategy {
  return { choose: () => options };
}

describe('PlayScene weapon leveling (AH-0MUPMPCB2009J54J)', () => {
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

  it('collecting a weapon drop levels the weapon up and applies the upgrade', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    expect(player.getWeaponLevel('spread')).toBe(0);

    // First collection: base (level 1, no upgrade — AC8).
    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.tick(0.016);
    expect(player.getWeaponLevel('spread')).toBe(1);
    expect(player.getWeaponDef('spread')).toBe(WEAPON_CATALOGUE.spread);

    // Second collection: first upgrade — the shared resolver's definition.
    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.tick(0.016);
    expect(player.getWeaponLevel('spread')).toBe(2);
    const expected = resolveWeaponDefinition('spread', 1);
    expect(player.getWeaponDef('spread')).toEqual(expected);
  });

  it('the level persists across a timeout and rises on re-collection', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    scene.spawnPowerUpDrop('rapid', player.x, player.y);
    scene.tick(0.016);
    scene.spawnPowerUpDrop('rapid', player.x, player.y);
    scene.tick(0.016);
    expect(player.getWeaponLevel('rapid')).toBe(2);

    // Expire the timed weapon: the level survives.
    player.tickWeaponTimers(60_000);
    expect(player.hasWeapon('rapid')).toBe(false);
    expect(player.getWeaponLevel('rapid')).toBe(2);

    // Re-collecting keeps levelling.
    scene.spawnPowerUpDrop('rapid', player.x, player.y);
    scene.tick(0.016);
    expect(player.getWeaponLevel('rapid')).toBe(3);
  });

  it('a permanent hold-full choice levels an owned weapon for the run', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Own spread at level 1.
    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.tick(0.016);
    expect(player.getWeaponLevel('spread')).toBe(1);

    // Offer a permanent level-up and choose it.
    scene.setMineralChoiceStrategy(
      fixedStrategy([
        { id: 'spread', name: 'Spread Shot Lv.2', kind: 'weapon-level', level: 2 },
      ]),
    );
    scene.openMineralChoice();
    scene.selectMineralChoice(0);

    expect(player.getWeaponLevel('spread')).toBe(2);
    expect(player.getWeaponDef('spread')).toEqual(
      resolveWeaponDefinition('spread', 1),
    );
    // Permanent — it never times out.
    player.tickWeaponTimers(120_000);
    expect(player.hasWeapon('spread')).toBe(true);
  });

  it('a default-strategy hold-full draw never offers two options for the same item (AC1/AC4)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Own two weapons and two power-ups so both suppression paths are live.
    player.equipWeapon('spread', true);
    player.equipWeapon('dual', true);
    player.collectPowerUp('P5');
    player.collectPowerUp('P9');

    // The scene uses its default random strategy with the real player
    // context, so every draw must offer each underlying item at most once.
    for (let i = 0; i < 20; i++) {
      const options = scene.openMineralChoice();
      expect(options).toHaveLength(3);
      const ids = options.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      // An owned weapon is only ever offered as its level-up, never as a
      // bare base-pool `weapon` entry.
      expect(
        options.some(
          (o) => o.kind === 'weapon' && (o.id === 'spread' || o.id === 'dual'),
        ),
      ).toBe(false);
      scene.selectMineralChoice(0);
    }
  });

  it('the mineral choice receives the player weapon levels (context)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    scene.spawnPowerUpDrop('dual', player.x, player.y);
    scene.tick(0.016);
    scene.spawnPowerUpDrop('dual', player.x, player.y);
    scene.tick(0.016);

    let context: ChoiceContext | undefined;
    scene.setMineralChoiceStrategy({
      choose: (_count, _rng, ctx) => {
        context = ctx;
        return [{ id: 'dual', name: 'Dual Shot', kind: 'weapon' }];
      },
    });
    scene.openMineralChoice();
    expect(context?.weaponLevels).toEqual([{ id: 'dual', level: 2 }]);
  });
});

/**
 * Shared mineral layer — cross-scene equivalence and single-definition guard
 * (AH-0MUII3DHM008L7JF, gap 5).
 *
 * AC1: one shared collection routine is called by both the game and the
 * gyms (source guard).
 * AC2: the game and the gym carry the same hold overflow through the
 * hold-full choice (cross-scene behavioural test).
 * AC3: `MineralChoiceScene` exposes a single `onSelect` callback contract
 * with no `PlayScene` special case.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  collectProductionSourceFiles,
  definesFunction,
} from '../../test/duplicateBodyGuard';
import type { ChoiceOption } from '../../powerups/choice';
import { PlayScene } from '../PlayScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { GymMinerals } from '../gym/GymMinerals';

/** A fixed choice every launcher can offer and apply. */
const FIXED_OPTIONS: ChoiceOption[] = [
  { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
  { id: 'P9', name: 'Magnet', kind: 'powerup' },
  { id: 'P3', name: 'Shield', kind: 'powerup' },
];

/**
 * Overflow beyond capacity the test drives both scenes past. A single
 * mineral is placed past capacity: the canonical hold records the *last*
 * over-fill surplus (`collected − capacity`), which is 1 per pickup once
 * the store is capped (matching `GameState`'s original behaviour).
 */
const OVERFLOW = 1;

function source(relative: string): string {
  return fs.readFileSync(relative, 'utf8').replace(/\\/g, '/');
}

describe('shared mineral layer — cross-scene overflow equivalence (AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  it('the game and the gym carry the same overflow through the hold-full choice', async () => {
    // ── Game: fill the hold past capacity through gameplay collection ──
    booted = await bootScene([
      PlayScene,
      MineralChoiceScene,
      GameOverScene,
      MenuScene,
    ]);
    const play = booted.scene as PlayScene;
    play.setMineralChoiceStrategy({ choose: () => FIXED_OPTIONS });
    const capacity = play.getGameState().mineralCapacity;
    const gamePlayer = play.getPlayer()!;
    for (let i = 0; i < capacity + OVERFLOW; i++) {
      play.spawnMineralAt(gamePlayer.x, gamePlayer.y);
    }
    play.tick(0.016);

    expect(play.getGameState().isHoldFull()).toBe(true);
    play.selectMineralChoice(0);
    const gameStore = play.getGameState().minerals;

    // ── Gym: fill the hold past capacity through gameplay collection ──
    booted.game.destroy(true);
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const gym = booted.scene as GymMinerals;
    // Drop the seeded field so the fill is exact.
    (gym as unknown as { minerals: unknown[] }).minerals.length = 0;
    gym.setMineralChoiceStrategy({ choose: () => FIXED_OPTIONS });
    const gymCapacity = gym.getMineralCapacity();
    const gymPlayer = gym.getPlayer()!;
    const seeded = gym.seedMinerals(gymCapacity + OVERFLOW);
    for (const mineral of seeded) mineral.setPosition(gymPlayer.x, gymPlayer.y);
    gym.tick(0.016);

    expect(gym.isMineralChoiceOpen()).toBe(true);
    gym.selectMineralChoice(0);
    const gymStore = gym.getMineralHold();

    // Both carry the surplus (collected − capacity), not 0.
    expect(gameStore).toBe(OVERFLOW);
    expect(gymStore).toBe(OVERFLOW);
    expect(gymStore).toBe(gameStore);
  });
});

describe('shared mineral layer — single-definition guard (AC1/AC3)', () => {
  it('AC1 — collectMinerals is defined exactly once, in the shared module', () => {
    const definers = collectProductionSourceFiles('src/scenes').filter((file) =>
      definesFunction(source(file), 'collectMinerals'),
    );
    expect(definers.map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/'))).toEqual([
      'src/scenes/core/mineralLayer.ts',
    ]);
  });

  it('AC1 — the game and the gym route collection and reward through the shared helpers', () => {
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/core/GymFormationScene.ts',
    ]) {
      const src = source(file);
      expect(src).toContain('collectMinerals(');
      expect(src).toContain('applyMineralChoiceReward');
      expect(src).toMatch(/from '\S*core\/mineralLayer'/);
    }
  });

  it('AC3 — every launcher supplies the single onSelect contract', () => {
    for (const file of [
      'src/scenes/PlayScene.ts',
      'src/scenes/gym/core/GymFormationScene.ts',
    ]) {
      expect(source(file)).toContain('onSelect:');
    }
  });

  it('AC3 — MineralChoiceScene has no PlayScene special case', () => {
    const src = source('src/scenes/MineralChoiceScene.ts');
    expect(src).not.toContain("getScene('PlayScene')");
    expect(src).not.toContain('selectMineralChoice');
  });
});

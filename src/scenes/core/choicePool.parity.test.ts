/**
 * Hold-full choice pool — game ↔ gym parity (AH-0MVI4KTD8000FBJ7 AC2).
 *
 * The hold-full choice pool (`CHOICE_POOL`) was widened to every power-up and
 * weapon drop except the `reset` utility. This file boots the real
 * `PlayScene` and the real `GymMinerals` formation gym, grants each newly
 * pooled id through the same `MineralChoiceScene` → `applyMineralChoiceReward`
 * path, and compares the observable effect state.
 *
 * Both launchers consume the one shared pool and the one shared reward seam,
 * so a divergence here would mean a per-scene copy crept in (gym↔game parity,
 * AH-0MUGZDTFX004RBD1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import type { EffectsRegistry } from '../../powerups/effects';
import { toChoiceOption, type ChoiceOption } from '../../powerups/choice';
import type { Player } from '../../entities/Player';
import type { WeaponId } from '../../utils/weapons';
import { PlayScene } from '../PlayScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { GymMinerals } from '../gym/GymMinerals';

/** Two Phaser games are booted per parity test — give the file headroom. */
vi.setConfig({ testTimeout: 60000 });

/** Power-ups that were missing from the hold-full pool. */
const NEW_POWER_UP_IDS = [
  'frenzy',
  'chrono',
  'thorns',
  'salvage',
  'strike',
] as const;

/** Weapons that were missing from the hold-full pool. */
const NEW_WEAPON_IDS = [
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
] as const;

/** The observable effect state one grant produces in a booted launcher. */
interface GrantState {
  /** Permanent level of the granted drop in the player's run-scoped store. */
  level: number;
  /** Whether the permanent effect is live in the shared effects registry. */
  effectActive: boolean;
}

/**
 * Reads the shared observable state for a granted drop — the same accessors
 * the game and every gym read, so equality is meaningful.
 */
function observe(
  registry: EffectsRegistry,
  player: Player,
  id: string,
): GrantState {
  switch (id) {
    case 'frenzy':
      return { level: player.getPowerUpLevel('frenzy'), effectActive: registry.frenzyBonusHits() > 0 };
    case 'chrono':
      return { level: player.getPowerUpLevel('chrono'), effectActive: registry.enemyBulletTimeScale() < 1 };
    case 'thorns':
      return { level: player.getPowerUpLevel('thorns'), effectActive: registry.hasThornsRam() };
    case 'salvage':
      return { level: player.getPowerUpLevel('salvage'), effectActive: registry.salvageBonusMinerals() > 0 };
    case 'strike':
      return { level: player.getPowerUpLevel('strike'), effectActive: registry.isStrikePermanent() };
    default:
      return {
        level: player.getWeaponLevel(id as WeaponId),
        effectActive: registry.hasWeapon(id as WeaponId),
      };
  }
}

/** The launcher surface shared by `PlayScene` and `GymFormationScene`. */
interface ChoiceLauncher {
  setMineralChoiceStrategy(strategy: {
    choose: () => ChoiceOption[];
  }): void;
  openMineralChoice(): ChoiceOption[];
  selectMineralChoice(index: number): ChoiceOption | null;
  getPlayer(): Player | null;
  getEffectsRegistry(): EffectsRegistry;
}

/**
 * Grants every newly pooled drop through the launcher's real hold-full choice
 * path and records the observable state each grant produces.
 */
function grantEveryNewDrop(launcher: ChoiceLauncher): Record<string, GrantState> {
  const player = launcher.getPlayer();
  expect(player).not.toBeNull();
  const registry = launcher.getEffectsRegistry();
  const states: Record<string, GrantState> = {};

  for (const id of [...NEW_POWER_UP_IDS, ...NEW_WEAPON_IDS]) {
    const option = toChoiceOption(id);
    launcher.setMineralChoiceStrategy({ choose: () => [option] });
    const offered = launcher.openMineralChoice();
    expect(offered.map((o) => o.id), id).toEqual([id]);
    const chosen = launcher.selectMineralChoice(0);
    expect(chosen?.id, id).toBe(id);
    states[id] = observe(registry, player!, id);
  }

  return states;
}

describe('hold-full choice pool — game ↔ gym parity (AH-0MVI4KTD8000FBJ7 AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  it('grants every newly pooled drop identically in PlayScene and a formation gym', async () => {
    // ── Game ──
    booted = await bootScene([
      PlayScene,
      MineralChoiceScene,
      GameOverScene,
      MenuScene,
    ]);
    const gameStates = grantEveryNewDrop(booted.scene as unknown as ChoiceLauncher);

    // ── Gym ──
    booted.game.destroy(true);
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const gymStates = grantEveryNewDrop(booted.scene as unknown as ChoiceLauncher);

    // Every new id is granted identically in both launchers. A **consumable**
    // hold-full reward adds a charge instead of a level (parent
    // AH-0MVTQMREN009DSFW AC1), so thorns stays level 0 (values are compared
    // for parity between the game and the gym rather than pinned here).
    for (const id of [...NEW_POWER_UP_IDS, ...NEW_WEAPON_IDS]) {
      if (id !== 'thorns') {
        expect(gameStates[id], id).toEqual({ level: 1, effectActive: true });
      } else {
        expect(gameStates[id].level, id).toBe(0);
      }
      expect(gymStates[id], id).toEqual(gameStates[id]);
    }
  });
});

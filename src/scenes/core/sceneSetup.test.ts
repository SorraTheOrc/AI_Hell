/**
 * Unit tests for the shared scene-setup applier (AH-0MVNW8VNN004FFK1).
 *
 * The applier is the single place that turns a normalised capture setup into
 * play state. These tests drive it with a fake player + power-up store (no
 * browser), so the mapping is pinned independently of any gym scene:
 *
 * - permanent weapons are granted permanently, timed weapons with a timer;
 * - configured power-up levels become that many permanent collections;
 * - an absent setup or a scene with no player is a strict no-op (unchanged
 *   behaviour).
 *
 * The `GymLevel` integration tests exercise the same helper through a real
 * scene boot.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCENE_SETUP_PLAYER_WEAPONS,
} from '../../../scripts/capture-scenes.mjs';
import {
  DEFAULT_GYM_LEVEL_WEAPONS,
  applySceneSetup,
  type SceneSetupPlayer,
} from './sceneSetup';

/** A fake player recording every loadout call. */
function fakePlayer(): {
  player: SceneSetupPlayer;
  equipped: Array<{ id: string; permanent: boolean }>;
  collected: Array<{ id: string; permanent: boolean }>;
  levels: Map<string, number>;
} {
  const equipped: Array<{ id: string; permanent: boolean }> = [];
  const collected: Array<{ id: string; permanent: boolean }> = [];
  const levels = new Map<string, number>();
  const player: SceneSetupPlayer = {
    equipWeapon: (id, permanent = false) => {
      equipped.push({ id, permanent });
    },
    getPowerUpLevelStore: () => ({
      collect: (id, permanent = false) => {
        collected.push({ id, permanent });
        const next = (levels.get(id) ?? 0) + 1;
        levels.set(id, next);
        return next;
      },
    }),
  };
  return { player, equipped, collected, levels };
}

describe('applySceneSetup (AH-0MVNW8VNN004FFK1)', () => {
  it('grants permanent weapons permanently and timed weapons with a timer', () => {
    const { player, equipped } = fakePlayer();

    applySceneSetup(
      { getPlayer: () => player },
      {
        player: { weapons: ['spread', 'dual'], timedWeapons: ['rapid'] },
        powerUps: {},
      },
    );

    expect(equipped).toEqual([
      { id: 'spread', permanent: true },
      { id: 'dual', permanent: true },
      { id: 'rapid', permanent: false },
    ]);
  });

  it('applies configured power-up levels as that many permanent collections', () => {
    const { player, collected, levels } = fakePlayer();

    applySceneSetup(
      { getPlayer: () => player },
      { player: { weapons: [] }, powerUps: { shield: 2, smart_bomb: 1 } },
    );

    expect(collected).toEqual([
      { id: 'shield', permanent: true },
      { id: 'shield', permanent: true },
      { id: 'smart_bomb', permanent: true },
    ]);
    expect(levels.get('shield')).toBe(2);
    expect(levels.get('smart_bomb')).toBe(1);
  });

  it('is a strict no-op for an absent setup (unchanged behaviour)', () => {
    const { player, equipped, collected } = fakePlayer();

    applySceneSetup({ getPlayer: () => player }, null);
    applySceneSetup({ getPlayer: () => player }, undefined);

    expect(equipped).toEqual([]);
    expect(collected).toEqual([]);
  });

  it('is a no-op when the scene has no player', () => {
    const { equipped, collected } = fakePlayer();
    // No player to apply to — must not throw.
    expect(() =>
      applySceneSetup({ getPlayer: () => null }, {
        player: { weapons: ['spread'] },
        powerUps: { shield: 3 },
      }),
    ).not.toThrow();
    expect(equipped).toEqual([]);
    expect(collected).toEqual([]);
  });

  it('ignores non-positive or non-integer power-up levels', () => {
    const { player, collected } = fakePlayer();
    applySceneSetup(
      { getPlayer: () => player },
      { powerUps: { shield: 0, bomb: -1, thorns: 1.5, strike: 1 } },
    );
    expect(collected).toEqual([{ id: 'strike', permanent: true }]);
  });

  it('keeps its default GymLevel loadout in step with the capture module default', () => {
    // The setup-less GymLevel start must reproduce the capture schema's
    // documented default exactly, so the two defaults cannot drift.
    expect([...DEFAULT_GYM_LEVEL_WEAPONS]).toEqual([
      ...DEFAULT_SCENE_SETUP_PLAYER_WEAPONS,
    ]);
  });
});

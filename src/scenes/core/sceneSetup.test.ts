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

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SCENE_SETUP_PLAYER_WEAPONS,
} from '../../../scripts/capture-scenes.mjs';
import {
  DEFAULT_GYM_LEVEL_WEAPONS,
  applySceneSetup,
  resolveSetupSeed,
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

describe('resolveSetupSeed (AH-0MVNW90FB003H3KM)', () => {
  it('returns a valid 32-bit seed unchanged', () => {
    expect(resolveSetupSeed({ seed: 0 })).toBe(0);
    expect(resolveSetupSeed({ seed: 123456 })).toBe(123456);
    expect(resolveSetupSeed({ seed: 0xffffffff })).toBe(0xffffffff);
  });

  it('returns null when no seed is supplied (unchanged behaviour)', () => {
    expect(resolveSetupSeed(null)).toBeNull();
    expect(resolveSetupSeed(undefined)).toBeNull();
    expect(resolveSetupSeed({})).toBeNull();
  });

  it('rejects invalid seeds rather than re-seeding to a surprising value', () => {
    expect(resolveSetupSeed({ seed: -1 })).toBeNull();
    expect(resolveSetupSeed({ seed: 1.5 })).toBeNull();
    expect(resolveSetupSeed({ seed: 0x1_0000_0000 })).toBeNull();
  });
});

// ── Scripted-video arc fields (AH-0MVRMFMJP0070KTS, TEST-FIRST) ─────────────

/**
 * Contract tests for the scripted-video arc's applier half (parent
 * AH-0MVPJ3NSK008V5VB, AC2 parts (a) and (c)).
 *
 * **Delivered by F2 (AH-0MVRMFOB4002LMZS):** the applier grants weapon levels
 * and the forced hold-full reward now that `SceneSetupState` carries both
 * fields, so every test in this block runs as a normal `it` (they were
 * `it.fails` while the contract was red).
 *
 * Pinned contract:
 *
 * - `setup.player.weaponLevels[id] = N` ⇒ **N** permanent
 *   `equipWeapon(id, true)` calls (level N == N permanent grants), applied
 *   after the `player.weapons` level-1 grants.
 * - `setup.player.weapons` keeps granting exactly one permanent level.
 * - `setup.mineralReward` forces the hold-full resolution to that reward id;
 *   absent ⇒ the caller's random strategy chooses (unchanged behaviour) —
 *   pinned through `resolveMineralReward(setup, randomChoice)`.
 * - Non-positive / non-integer levels are ignored, mirroring `powerUps`.
 */
interface ArcSetupState {
  player?: {
    weapons?: readonly string[];
    timedWeapons?: readonly string[];
    weaponLevels?: Readonly<Record<string, number>>;
    heading?: number;
  };
  powerUps?: Readonly<Record<string, number>>;
  seed?: number;
  mineralReward?: string;
}

/** A fake player recording every loadout call (see {@link fakePlayer}). */
const fakeArcPlayer = fakePlayer;

/** The applier surface the arc adds, declared locally while absent. */
interface ArcSceneSetupModule {
  applySceneSetup(
    seams: { getPlayer(): SceneSetupPlayer | null },
    setup: ArcSetupState | null | undefined,
  ): void;
  resolveMineralReward(
    setup: ArcSetupState | null | undefined,
    randomChoice: () => string,
  ): string;
}

/** Loads the applier with the arc surface exposed (no import type error). */
const loadArcApplier = async (): Promise<ArcSceneSetupModule> =>
  (await import('./sceneSetup')) as unknown as ArcSceneSetupModule;

/** Applies an arc setup through the unchanged, already-typed applier. */
const applyArc = (
  seams: { getPlayer(): SceneSetupPlayer | null },
  setup: ArcSetupState,
): void =>
  applySceneSetup(
    seams,
    setup as unknown as Parameters<typeof applySceneSetup>[1],
  );

describe('scene setup — scripted-video arc fields (AH-0MVRMFMJP0070KTS)', () => {
  it('AC3 — grants weaponLevels as N permanent equips (level N == N grants)', () => {
    const { player, equipped, levels } = fakeArcPlayer();
    const store = {
      weaponLevels: {} as Record<string, number>,
    };
    // Record the per-weapon grant count alongside the call list.
    const recording: SceneSetupPlayer = {
      equipWeapon: (id, permanent = false) => {
        player.equipWeapon(id, permanent);
        store.weaponLevels[id] = (store.weaponLevels[id] ?? 0) + (permanent ? 1 : 0);
      },
      getPowerUpLevelStore: () => player.getPowerUpLevelStore(),
    };

    applyArc(
      { getPlayer: () => recording },
      { player: { weapons: [], weaponLevels: { rapid: 3 } } },
    );

    expect(equipped).toEqual([
      { id: 'rapid', permanent: true },
      { id: 'rapid', permanent: true },
      { id: 'rapid', permanent: true },
    ]);
    expect(store.weaponLevels.rapid).toBe(3);
    // No timed grants are produced by a level grant.
    expect(equipped.every((call) => call.permanent)).toBe(true);
    expect(levels.size).toBe(0);
  });

  it('AC3 — player.weapons still grants exactly level 1', () => {
    const { player, equipped } = fakeArcPlayer();

    applyArc(
      { getPlayer: () => player },
      { player: { weapons: ['spread'], weaponLevels: { spread: 2 } } },
    );

    // One level-1 grant from `weapons`, plus the two level grants.
    expect(equipped.filter((call) => call.id === 'spread')).toHaveLength(3);
    expect(equipped).toEqual([
      { id: 'spread', permanent: true },
      { id: 'spread', permanent: true },
      { id: 'spread', permanent: true },
    ]);
  });

  it('sets the stationary heading from player.heading degrees (AH-0MVTJW9JW002PHJG)', () => {
    const { player, equipped } = fakeArcPlayer();
    const headings: number[] = [];
    const recording: SceneSetupPlayer = {
      equipWeapon: (id, permanent = false) => player.equipWeapon(id, permanent),
      getPowerUpLevelStore: () => player.getPowerUpLevelStore(),
      setDefaultHeading: (radians) => headings.push(radians),
    };

    // A captured scene takes no input; `-90` degrees aims the ship up.
    applyArc({ getPlayer: () => recording }, { player: { heading: -90 } });

    expect(headings).toEqual([-Math.PI / 2]);
    // The heading is not a weapon grant.
    expect(equipped).toEqual([]);
  });

  it('leaves the heading alone when the setup has none (unchanged behaviour)', () => {
    const { player } = fakeArcPlayer();
    const headings: number[] = [];
    const recording: SceneSetupPlayer = {
      equipWeapon: (id, permanent = false) => player.equipWeapon(id, permanent),
      getPowerUpLevelStore: () => player.getPowerUpLevelStore(),
      setDefaultHeading: (radians) => headings.push(radians),
    };

    applyArc({ getPlayer: () => recording }, { player: { weapons: [] } });
    expect(headings).toEqual([]);
  });

  it('AC3 — ignores non-positive / non-integer weapon levels', () => {
    const { player, equipped } = fakeArcPlayer();

    applyArc(
      { getPlayer: () => player },
      { player: { weapons: [], weaponLevels: { rapid: 0, dual: -1, nova: 1.5, spread: 1 } } },
    );

    expect(equipped).toEqual([{ id: 'spread', permanent: true }]);
  });

  it('AC3 — a forced mineralReward selects the named reward, never a random one', async () => {
    const module = await loadArcApplier();
    const randomChoice = vi.fn(() => 'shield');

    const chosen = module.resolveMineralReward({ mineralReward: 'mineral_scoop' }, randomChoice);

    expect(chosen).toBe('mineral_scoop');
    expect(randomChoice).not.toHaveBeenCalled();
  });

  it('AC3 — an absent mineralReward keeps the random hold-full resolution', async () => {
    const module = await loadArcApplier();
    const randomChoice = vi.fn(() => 'shield');

    expect(module.resolveMineralReward({}, randomChoice)).toBe('shield');
    expect(module.resolveMineralReward(null, randomChoice)).toBe('shield');
    expect(randomChoice).toHaveBeenCalledTimes(2);
  });
});

/**
 * Player-facing acceptance for the hex-awarded weapons
 * (AH-0MWWARFUK009KQM7, consuming AH-0MWW6PNA5008NC91).
 *
 * The catalogue derivation shipped with the parent feature; this suite proves
 * the **outcome** the player was promised, hex by hex, through the real
 * capture path rather than by inspecting the save:
 *
 * - AC1/AC3 — winning a weapon hex (`hex-r1-3` and `hex-r2-4` → `rapid`,
 *   `hex-r2-1` → `arc`, `hex-r2-2` → `broadside`, `hex-r2-5` → `dual`,
 *   `hex-r2-12` → `nova`) records the id, renders a **named owned** unlock row
 *   (never gated and never "unavailable") and offers a toggleable weapon
 *   selector option.
 * - AC2 — the next sortie actually starts with the captured weapon equipped
 *   **and firing**: the live `PlayScene` emits player bullets carrying the
 *   captured weapon's id (`PlayerBullet.weaponId`), so the reward is observable
 *   in the run and not only in the save.
 * - AC4 — an existing save that already holds the ids shows every one of them
 *   owned on load, with **no re-capture, no save migration and no schema
 *   change** (`unlockedWeapons` already carried them; only the readers were
 *   blind).
 *
 * The capture is resolved by the shipped victory path: the compact campaign is
 * injected, the deployment is built from the real payload and the run is won
 * through `src/test/hangarWarWinHarness.ts`, exactly as the in-game sortie is.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createRingState } from '../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  parseHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  advanceGame,
  bootScene,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import {
  injectMiniBossCampaign,
  winLiveDeployment,
} from '../test/hangarWarWinHarness';
import { WEAPON_CATALOGUE } from '../utils/weapons';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import { buildHangarDeployment } from './hangarWar/hangarDeployment';
import {
  buildHangarUnlockRows,
  buildHangarWeaponOptions,
  toggleHangarWeapon,
} from './hangarWar/hangarScreen';

/** Every authored weapon grant and the hex that awards it (AC3). */
const HEX_WEAPON_GRANTS = [
  { hexId: 'hex-r1-3', ringIndex: 1, weaponId: 'rapid' },
  { hexId: 'hex-r2-4', ringIndex: 2, weaponId: 'rapid' },
  { hexId: 'hex-r2-1', ringIndex: 2, weaponId: 'arc' },
  { hexId: 'hex-r2-2', ringIndex: 2, weaponId: 'broadside' },
  { hexId: 'hex-r2-5', ringIndex: 2, weaponId: 'dual' },
  { hexId: 'hex-r2-12', ringIndex: 2, weaponId: 'nova' },
] as const;

/** The five distinct weapons those six hexes award. */
const HEX_GRANTED_WEAPON_IDS = [
  'rapid',
  'arc',
  'broadside',
  'dual',
  'nova',
] as const;

/** Every owned state an owned level-bearing weapon row may report. */
const OWNED_WEAPON_ROW_STATES = [
  'owned',
  'upgradable',
  'upgrade-unaffordable',
  'capped',
] as const;

/** A fresh war whose ring is materialised from the authored data. */
function ringPayload(ringIndex: number): HangarWarPayload {
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

describe('hex-awarded weapons are owned, shown, selectable and fired', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  /**
   * Boots the real `PlayScene` and wins the given hex deployment through the
   * shared victory harness. The compact campaign is injected before the
   * deployment starts, so the harness's win walk (real mini-boss defeat → death
   * sweep → capture) finalises the run exactly as the game does.
   */
  async function winHex(
    hexId: string,
    ringIndex: number,
  ): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);

    injectMiniBossCampaign(scene);
    const deployment = buildHangarDeployment(ringPayload(ringIndex), { hexId });
    scene.scene.restart({ demo: false, hangarWar: deployment });
    await advanceGame(scene.game, 200);

    winLiveDeployment(scene);
    stepGameUntil(
      scene.game,
      `the ${hexId} capture`,
      () => scene.getLastCapture() !== null,
      600,
    );
    return scene;
  }

  it.each(HEX_WEAPON_GRANTS)(
    'AC1/AC3 — capturing $hexId awards $weaponId as a named owned row and a toggleable option',
    async ({ hexId, ringIndex, weaponId }) => {
      const scene = await winHex(hexId, ringIndex);

      // The capture resolved through the shipped path and recorded the weapon.
      const capture = scene.getLastCapture();
      expect(capture, `${hexId} capture`).not.toBeNull();
      expect(capture!.ok).toBe(true);
      expect(capture!.grant).not.toBeNull();
      expect(capture!.grant!.kind).toBe('weapon');
      expect(capture!.grant!.weaponId).toBe(weaponId);

      const stored = loadHangarWarPayload();
      expect(stored, 'the capture is persisted').not.toBeNull();
      expect(stored!.hangar.unlockedWeapons).toContain(weaponId);

      // AC1 — a named, owned unlock row (not gated, not "unavailable").
      const row = buildHangarUnlockRows(stored!).find(
        (entry) => entry.id === weaponId,
      );
      expect(row, `an unlock row for ${weaponId}`).toBeDefined();
      expect(row!.kind).toBe('weapon');
      expect(row!.name.trim().length).toBeGreaterThan(0);
      expect(row!.label).toContain(row!.name);
      expect(OWNED_WEAPON_ROW_STATES).toContain(row!.state);
      // The name is the shipped weapon's own name, so the hangar and the run
      // describe the same weapon (no divergent copy).
      expect(row!.name).toBe(WEAPON_CATALOGUE[weaponId].name);

      // AC3 — the weapon selector offers it and it is toggleable.
      const option = buildHangarWeaponOptions(stored!).find(
        (entry) => entry.id === weaponId,
      );
      expect(option, `a weapon option for ${weaponId}`).toBeDefined();
      expect(option!.actionable).toBe(true);

      const toggled = toggleHangarWeapon(stored!, weaponId);
      expect(toggled.ok).toBe(true);
      expect(
        toggled.payload.hangar.activeLoadout.startingWeapons,
      ).toContain(weaponId);
    },
  );

  it('AC2 — the next sortie starts with the captured rapid equipped and firing', async () => {
    // Win the real `hex-r1-3` deployment, then select the reward in the
    // selector and launch the next sortie from the toggled payload.
    await winHex('hex-r1-3', 1);
    const stored = loadHangarWarPayload()!;
    const toggled = toggleHangarWeapon(stored, 'rapid');
    expect(toggled.ok).toBe(true);

    const deployment = buildHangarDeployment(toggled.payload, {
      hexId: 'hex-r2-4',
    });
    // The launch payload carries the reward, so the run cannot silently drop it.
    expect(deployment.startingWeapons).toContain('rapid');

    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    injectMiniBossCampaign(scene);
    scene.scene.restart({ demo: false, hangarWar: deployment });
    await advanceGame(scene.game, 200);

    // The player deployed with the reward equipped...
    expect(scene.getPlayer()!.hasWeapon('rapid')).toBe(true);

    // ...and actually fires it. Step frame by frame (the fire cadence is
    // phase-locked to the shared beat clock, so one large step can land between
    // a weapon's onsets) and read the live bullets, whose `weaponId` names the
    // weapon that fired them.
    const firedWeaponIds = new Set<string>();
    for (let frame = 0; frame < 180; frame += 1) {
      scene.tick(1 / 60);
      for (const bullet of scene.getPlayerBullets()) {
        if (typeof bullet.weaponId === 'string') {
          firedWeaponIds.add(bullet.weaponId);
        }
      }
      if (firedWeaponIds.has('rapid')) break;
    }
    expect(
      [...firedWeaponIds],
      'live bullets name their firing weapon',
    ).toContain('rapid');
  });

  it('AC4 — an existing save holding every grant shows them owned on load with no migration', () => {
    // No capture, no harness win: the save already holds the ids, exactly as a
    // player's save written before the fix does.
    const existing = createDefaultPayload(99);
    existing.hangar.unlockedWeapons = [
      ...existing.hangar.unlockedWeapons,
      ...HEX_GRANTED_WEAPON_IDS,
    ];

    const restored = parseHangarWarPayload(
      JSON.parse(JSON.stringify(existing)),
    );
    expect(restored, 'the existing save loads').not.toBeNull();
    // No schema bump: the field already carried the ids.
    expect(restored!.version).toBe(existing.version);

    const rows = buildHangarUnlockRows(restored!);
    const options = buildHangarWeaponOptions(restored!);
    for (const weaponId of HEX_GRANTED_WEAPON_IDS) {
      const row = rows.find((entry) => entry.id === weaponId);
      expect(row, `an owned row for ${weaponId}`).toBeDefined();
      expect(OWNED_WEAPON_ROW_STATES).toContain(row!.state);

      const option = options.find((entry) => entry.id === weaponId);
      expect(option, `a selector option for ${weaponId}`).toBeDefined();
      expect(option!.actionable).toBe(true);
    }

    // The pre-existing payload renders identically after the round-trip, so
    // loading it needed no migration step.
    expect(rows).toEqual(buildHangarUnlockRows(existing));
    expect(options).toEqual(buildHangarWeaponOptions(existing));
  });
});

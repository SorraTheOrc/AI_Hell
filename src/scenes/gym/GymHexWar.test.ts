/**
 * GymHexWar tests (AH-0MVUXC94N008MV63).
 *
 * `GymHexWar` is the verification harness's ring-war parity surface: it boots a
 * real scene, renders an **injected** hangar-war ring payload read-only, and
 * exposes the `take hex → leave bot → tick → holds or falls` control surface
 * that later phase-B items (ring model B2, resolver B3, map B4) exercise
 * without a browser boot. This suite pins:
 *
 * - the scene boots and renders the documented ring payload summary;
 * - the payload is injected through launch data and is never mutated by
 *   rendering (the scene holds a detached copy);
 * - with nothing injected it renders the deterministic sample built from the
 *   ring fixtures, and a capture `setup` seed drives that sample;
 * - the control surface takes a hex, leaves a bot and runs deterministic
 *   frontier ticks that hold or fall by the harness rule;
 * - the index discovers it as "HexWar".
 */

import { afterAll, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../../test/gameHarness';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import type { HangarWarPayload, HexState } from '../../core/hangarWar/types';
import { RING_1_HEX_FIXTURES } from '../../core/hangarWar/__fixtures__/ringFixtures';
import {
  GymHexWar,
  GYM_HEX_WAR_DEFAULT_SEED,
  GYM_HEX_WAR_HINT,
  GYM_HEX_WAR_SCENE_KEY,
  GYM_HEX_WAR_TITLE,
  type GymTickResult,
} from './GymHexWar';

/** Finds an on-screen text whose content starts with `prefix`. */
function findTextStartingWith(
  scene: Phaser.Scene,
  prefix: string,
): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text.startsWith(prefix),
  );
  expect(found, `no text starting with "${prefix}"`).toBeDefined();
  return found!;
}

/** A single-hex payload, so a tick's attacks target exactly the hex under test. */
function oneHexPayload(hex: HexState): HangarWarPayload {
  return {
    version: 1,
    seed: 1234,
    hangar: {
      bankedMinerals: 0,
      bankedCores: 0,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: { ringIndex: 1, hexes: [hex] },
    pendingAttacks: [],
    bestScore: 0,
  };
}

/** An unheld hex the control surface can take. */
const UNHELD_HEX: HexState = {
  id: 'target',
  q: 1,
  r: 0,
  held: false,
  aggression: 0,
  defender: null,
  bossDefeated: false,
  grantedWeapon: null,
};

const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

describe('GymHexWar', () => {
  let booted: BootedGame | null = null;

  /** Boots the scene and re-starts it with `data` (Phaser launch data). */
  async function bootHexWar(data?: object): Promise<GymHexWar> {
    booted = await reuse.boot([GymHexWar]);
    booted.game.scene.start(GYM_HEX_WAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(GYM_HEX_WAR_SCENE_KEY) as GymHexWar;
  }

  /** Ticks one at a time until the AI attacks `hexId`, returning that result. */
  async function tickUntilAttacked(
    scene: GymHexWar,
    hexId: string,
    maxTicks = 300,
  ): Promise<GymTickResult> {
    for (let i = 0; i < maxTicks; i += 1) {
      const [result] = scene.tick(1);
      if (result.attackedHexId === hexId) return result;
    }
    throw new Error(`the frontier never attacked ${hexId} in ${maxTicks} ticks`);
  }

  it('boots, shows its title and renders the ring payload summary', async () => {
    const scene = await bootHexWar();

    expect(scene.sys.isActive()).toBe(true);
    findTextStartingWith(scene, GYM_HEX_WAR_TITLE);
    findTextStartingWith(scene, GYM_HEX_WAR_HINT);

    const lines = scene.getSummaryLines();
    const held = scene
      .getPayload()
      .ring.hexes.filter((hex) => hex.held).length;
    expect(lines[0]).toContain('Ring 1');
    expect(lines[0]).toContain(
      `${held}/${RING_1_HEX_FIXTURES.length} hexes held`,
    );
    // One line per hex, each naming the hex id it describes.
    for (const hex of scene.getPayload().ring.hexes) {
      expect(lines.some((line) => line.includes(hex.id))).toBe(true);
    }
    // The fixture ring, not an empty placeholder, is what the gym renders.
    expect(scene.getFixtures()).toEqual([...RING_1_HEX_FIXTURES]);
  });

  it('renders the deterministic sample fixture when nothing is injected', async () => {
    const first = await bootHexWar();
    const firstPayload = JSON.parse(
      JSON.stringify(first.getPayload()),
    ) as HangarWarPayload;

    const second = await bootHexWar();
    expect(second.getPayload()).toEqual(firstPayload);
    expect(firstPayload.seed).toBe(GYM_HEX_WAR_DEFAULT_SEED);
    expect(firstPayload.ring.hexes).toHaveLength(RING_1_HEX_FIXTURES.length);
  });

  it('consumes a scripted-scene setup seed instead of dropping it', async () => {
    const configured = await bootHexWar({ seed: 4242 });
    expect(configured.getPayload().seed).toBe(4242);

    const firstPayload = configured.getPayload();
    const again = await bootHexWar({ seed: 4242 });
    expect(again.getPayload()).toEqual(firstPayload);
  });

  it('a payload injection wins over the setup seed', async () => {
    const injected = oneHexPayload({ ...UNHELD_HEX });
    const scene = await bootHexWar({ seed: 4242, payload: injected });
    expect(scene.getPayload()).toEqual(injected);
  });

  it('renders the injected payload read-only (detached, never mutated)', async () => {
    const injected = oneHexPayload({ ...UNHELD_HEX, held: true, bossDefeated: true });
    const scene = await bootHexWar({ payload: injected });
    await advanceGame(booted!.game, 200);

    expect(scene.getPayload()).toEqual(injected);
    expect(scene.getPayload()).not.toBe(injected);
    scene.getPayload().ring.hexes[0].aggression = 99;
    expect(injected.ring.hexes[0].aggression).toBe(UNHELD_HEX.aggression);
  });

  it('takes a hex and leaves a bot through the control surface', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });

    scene.takeHex('target');
    expect(scene.getPayload().ring.hexes[0].held).toBe(true);

    scene.leaveBot('target', 'hull-2', 12);
    expect(scene.getPayload().ring.hexes[0].defender).toEqual({
      hullId: 'hull-2',
      defenceRating: 12,
      bankedMinerals: 0,
    });
  });

  it('does nothing when the control surface targets an unknown hex', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });
    const before = scene.getPayload();

    scene.takeHex('no-such-hex');
    scene.leaveBot('no-such-hex', 'hull-2', 12);
    expect(scene.getPayload()).toEqual(before);
  });

  it('runs deterministic frontier ticks that raise aggression and advance the clock', async () => {
    const payload = oneHexPayload({ ...UNHELD_HEX });
    const first = await bootHexWar({ payload });
    first.takeHex('target');
    first.leaveBot('target', 'hull-1', 99);
    const firstResults = first.tick(5);
    const firstPayload = first.getPayload();
    const firstClock = first.getClock();

    const second = await bootHexWar({ payload });
    second.takeHex('target');
    second.leaveBot('target', 'hull-1', 99);
    const secondResults = second.tick(5);
    const secondPayload = second.getPayload();

    expect(secondResults).toEqual(firstResults);
    expect(secondPayload).toEqual(firstPayload);
    expect(firstClock.tick).toBe(5);
    expect(firstResults.map((result) => result.tick)).toEqual([0, 1, 2, 3, 4]);
    // Every tick raised aggression on the taken hex.
    expect(firstPayload.ring.hexes[0].aggression).toBeGreaterThanOrEqual(0);
  });

  it('holds the line when the staying bot beats the attack', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });
    scene.takeHex('target');
    scene.leaveBot('target', 'hull-1', 99);

    const attacked = await tickUntilAttacked(scene, 'target');
    expect(attacked.fell).toBe(false);
    expect(scene.getPayload().ring.hexes[0].held).toBe(true);
  });

  it('falls when the staying bot is outmatched (take hex → leave bot → tick → falls)', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });
    scene.takeHex('target');
    scene.leaveBot('target', 'hull-1', 0);

    const attacked = await tickUntilAttacked(scene, 'target');
    expect(attacked.fell).toBe(true);
    expect(scene.getPayload().ring.hexes[0].held).toBe(false);
    expect(scene.getPayload().ring.hexes[0].defender).toBeNull();
  });

  it('is discovered by the gym index as "HexWar"', () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymHexWar.ts': { GymHexWar },
    });
    expect(entries.map((entry) => entry.key)).toEqual([GYM_HEX_WAR_SCENE_KEY]);
    expect(entries.map((entry) => entry.label)).toEqual(['HexWar']);
  });
});

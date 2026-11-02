/**
 * Hex map scene tests (AH-0MVUXCAG90086LH2).
 *
 * The scene is a pure view: the known-ahead intel (boss, strengths,
 * weaknesses, grant, aggression, pending attack) comes from the pure model
 * (`src/core/hangarWar/hexIntel.ts`) over the stored payload and the authored
 * hex definitions, and the deployment reuses the shipped hangar deployment
 * path. This suite pins:
 *
 * - the map renders the hangar at the centre and every hex with its full intel
 *   before the player commits;
 * - ring 2's twelve generated hexes render and are selectable;
 * - focusing/activating a hex launches the shipped `PlayScene` at that hex;
 * - the hangar is one click away;
 * - an injected payload is never mutated, and a fresh war renders the
 *   generated ring.
 */

import { afterAll, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../test/gameHarness';
import {
  createDefaultPayload,
  HANGAR_WAR_STORAGE_KEY,
  loadHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { createRingState } from '../core/hangarWar/hexRing';
import {
  HEX_MAP_HANGAR_ROW_KEY,
  HEX_MAP_TITLE,
  buildHexMapModel,
  pickAttractHex,
} from '../core/hangarWar/hexIntel';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { HEX_MAP_HINT } from './hangarWar/hexMap';
import { PlayScene } from './PlayScene';

/** A payload whose ring is the generated state of `ringIndex`. */
function ringPayload(ringIndex: 1 | 2): HangarWarPayload {
  return {
    ...createDefaultPayload(11),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

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

const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

describe('HexMapScene', () => {
  let booted: BootedGame | null = null;

  /** Boots the scene and re-starts it with `data` (Phaser launch data). */
  async function bootMap(data?: object): Promise<HexMapScene> {
    booted = await reuse.boot([HexMapScene, PlayScene, HangarScene]);
    booted.game.scene.start(HEX_MAP_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
  }

  it('boots with the hangar at the centre and the ring around it', async () => {
    const scene = await bootMap({ payload: ringPayload(1), storage: null });

    expect(scene.sys.isActive()).toBe(true);
    findTextStartingWith(scene, HEX_MAP_TITLE);
    findTextStartingWith(scene, HEX_MAP_HINT);
    // The hangar marker sits at the map's centre, naming the current ring.
    findTextStartingWith(scene, 'HANGAR\nR1');

    expect(scene.getModel().ringLine).toBe('RING 1 — 0/6 HEXES HELD');
    expect(scene.getModel().hangarLine).toContain('HANGAR');
  });

  it('renders the known-ahead intel for every hex before deployment', async () => {
    const scene = await bootMap({ payload: ringPayload(1), storage: null });
    const model = scene.getModel();

    expect(model.hexes).toHaveLength(6);
    expect(scene.getRows().map((row) => row.key)).toEqual([
      ...model.hexes.map((hex) => hex.key),
      HEX_MAP_HANGAR_ROW_KEY,
    ]);

    for (const intel of model.hexes) {
      const row = scene.getRows().find((entry) => entry.key === intel.key)!;
      // The rendered tile publishes the boss, its strengths/weaknesses, the
      // granted weapon/upgrade and the aggression.
      expect(row.label).toContain(intel.id);
      expect(row.label).toContain(`AGG ${intel.aggression}`);
      expect(row.label).toContain(intel.boss!);
      expect(row.label).toContain(`W:${intel.weaknesses.join(',')}`);
      expect(row.label).toContain(`→${intel.grants}`);
      // The rendered text object carries exactly that label.
      expect(row.text.text).toBe(row.label);
      expect(scene.children.list).toContain(row.text);
    }

    // A concrete authored hex: ring 1's easiest, its boss and its grant.
    const easiest = scene
      .getRows()
      .find((row) => row.key === 'hex:hex-r1-2')!;
    expect(easiest.label).toContain('shroud-merchant');
    expect(easiest.label).toContain('W:waveLaser');
    expect(easiest.label).toContain('→extra-life');
    expect(easiest.label).toContain('AGG 1');
  });

  it('renders ring 2\u2019s twelve generated hexes and makes them selectable', async () => {
    const payload = ringPayload(2);
    const scene = await bootMap({ payload, storage: null });
    const model = scene.getModel();
    const deployable = scene
      .getRows()
      .filter((row) => row.key.startsWith('hex:') && row.actionable);

    expect(model.hexes).toHaveLength(12);
    expect(model.hexes.map((hex) => hex.id)).toEqual(
      payload.ring.hexes.map((hex) => hex.id),
    );
    // Twelve hex rows plus the hangar row.
    expect(deployable).toHaveLength(12);
    expect(model.focusOrder).toEqual([
      ...model.hexes.map((hex) => hex.key),
      HEX_MAP_HANGAR_ROW_KEY,
    ]);

    for (const intel of model.hexes) {
      const row = scene
        .getRows()
        .find((entry) => entry.key === `hex:${intel.id}`)!;
      expect(row.actionable).toBe(true);
      expect(row.text.input).not.toBeNull();
    }

    // Default focus is the attract bot's weakest adjacent hex (hex-r2-2, the
    // equal-weakest wins on sorted id); any ring-2 hex can be focused.
    expect(model.attractHexId).toBe('hex-r2-2');
    expect(scene.getFocusedKey()).toBe('hex:hex-r2-2');
    expect(scene.focusRow('hex:hex-r2-12')).toBe(true);
    expect(scene.getFocusedKey()).toBe('hex:hex-r2-12');
  });

  it('deploys at the focused hex through the shipped PlayScene path', async () => {
    const payload = ringPayload(1);
    const scene = await bootMap({ payload, storage: null });
    const weakest = pickAttractHex(payload)!;

    expect(scene.focusRow(`hex:${weakest}`)).toBe(true);
    scene.activateFocused();
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isHangarWarRun()).toBe(true);
    const deployment = play.getHangarWarDeployment()!;
    expect(deployment.hexId).toBe(weakest);
    // Ring 1's weakest hex is aggression 1 → campaign level 2.
    expect(deployment.aggression).toBe(1);
    expect(deployment.startLevel).toBe(2);
  });

  it('deploys from a pointer click on a hex tile', async () => {
    const scene = await bootMap({ payload: ringPayload(1), storage: null });
    const row = scene.getRows().find((entry) => entry.key === 'hex:hex-r1-3')!;

    row.text.emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getHangarWarDeployment()!.hexId).toBe('hex-r1-3');
  });

  it('keeps the hangar one click away', async () => {
    const payload = ringPayload(1);
    const scene = await bootMap({ payload, storage: null });

    expect(scene.focusRow(HEX_MAP_HANGAR_ROW_KEY)).toBe(true);
    scene.activateFocused();
    await advanceGame(booted!.game, 250);

    expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(true);
    const hangar = booted!.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;
    // The same war state the map showed is handed to the hangar.
    expect(hangar.getPayload()).toEqual(payload);
  });

  it('shows no deployable hex once the ring is secured', async () => {
    const payload = ringPayload(1);
    for (const hex of payload.ring.hexes) {
      hex.held = true;
      hex.defender = {
        hullId: 'hull-1',
        defenceRating: 9,
        bankedMinerals: 0,
      };
    }
    const scene = await bootMap({ payload, storage: null });
    const rows = scene.getRows();

    expect(rows.filter((row) => row.key.startsWith('hex:')).every((row) => !row.actionable)).toBe(true);
    expect(scene.getModel().ringLine).toContain('SECURED');
    expect(scene.getModel().focusOrder).toEqual([HEX_MAP_HANGAR_ROW_KEY]);
    expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
    // A held hex cannot be focused (nothing to deploy at).
    expect(scene.focusRow('hex:hex-r1-1')).toBe(false);
  });

  it('renders the generated ring for a fresh war and loads an injected store', async () => {
    const fresh = await bootMap({ payload: createDefaultPayload(0), storage: null });
    expect(fresh.getModel().hexes).toHaveLength(6);
    expect(fresh.getModel().hexes.every((hex) => !hex.held)).toBe(true);

    const stored = ringPayload(2);
    const storage: HangarWarStorage & { entries: Map<string, string> } = {
      entries: new Map([[HANGAR_WAR_STORAGE_KEY, JSON.stringify(stored)]]),
      getItem(key) {
        return this.entries.get(key) ?? null;
      },
      setItem(key, value) {
        this.entries.set(key, value);
      },
      removeItem(key) {
        this.entries.delete(key);
      },
    };
    const loaded = await bootMap({ storage });
    expect(loaded.getModel().hexes).toHaveLength(12);
    expect(loaded.getModel().ringIndex).toBe(2);
    expect(loadHangarWarPayload(storage)?.ring.ringIndex).toBe(2);
  });

  it('never mutates the injected payload and matches the pure model', async () => {
    const payload = ringPayload(1);
    const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
    const scene = await bootMap({ payload, storage: null });

    expect(scene.getPayload()).toEqual(before);
    expect(scene.getModel()).toEqual(
      buildHexMapModel(payload, { definitions: HEX_RING_DEFINITIONS }),
    );
    scene.getPayload().ring.hexes[0].held = true;
    expect(scene.getPayload().ring.hexes[0].held).toBe(false);
  });
});

/**
 * Hex map scene tests (AH-0MVUXCAG90086LH2).
 *
 * The scene is a pure view: the known-ahead intel (boss, strengths,
 * weaknesses, grant, aggression, pending attack) comes from the pure model
 * (`src/core/hangarWar/hexIntel.ts`) over the stored payload and the authored
 * hex definitions, and the deployment reuses the shipped hangar deployment
 * path. This suite pins:
 *
 * - the map renders the hangar at the centre, a readable tile label on every
 *   tile and the full intel of the focused hex in the detail panel before the
 *   player commits;
 * - the reveal is adjacency-only: ring 1 renders with zero held hexes and
 *   ring 2 appears progressively as its neighbours are held (hidden hexes are
 *   neither focusable nor deployable);
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
  UNHELD_TILE_MARKER,
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
      // The tile carries coordinates + aggression + the ownership marker at a
      // readable size; ownership is also readable without colour.
      expect(row.label).toBe(
        `(${intel.q},${intel.r}) AGG ${intel.aggression} ${UNHELD_TILE_MARKER}`,
      );
      // The rendered text object carries exactly that label.
      expect(row.text.text).toBe(row.label);
      expect(scene.children.list).toContain(row.text);
    }

    // The full intel block moved off the tiles into the detail panel, which
    // follows focus: the default focus is the attract bot's weakest hex.
    expect(scene.getPanelKey()).toBe(model.defaultFocusKey);
    const panelHex = model.hexes.find(
      (hex) => hex.key === model.defaultFocusKey,
    )!;
    const panel = scene.getPanelText();
    expect(panel).toContain(panelHex.id);
    expect(panel).toContain(panelHex.boss!);
    expect(panel).toContain(`W:${panelHex.weaknesses.join(',')}`);
    expect(panel).toContain(`→${panelHex.grants}`);
    expect(panel).toContain(`AGG ${panelHex.aggression}`);

    // A concrete authored hex: ring 1's easiest (the default focus), its boss
    // and its grant all reachable through the panel.
    const easiest = scene
      .getRows()
      .find((row) => row.key === 'hex:hex-r1-2')!;
    expect(easiest.label).toBe(`(1,-1) AGG 1 ${UNHELD_TILE_MARKER}`);
    expect(panel).toContain('shroud-merchant');
    expect(panel).toContain('W:waveLaser');
    expect(panel).toContain('→extra-life');
  });

  it('hides ring 2 with zero held hexes (adjacency-only reveal)', async () => {
    const payload = ringPayload(2);
    const scene = await bootMap({ payload, storage: null });
    const model = scene.getModel();
    const deployable = scene
      .getRows()
      .filter((row) => row.key.startsWith('hex:') && row.actionable);

    // The full stored ring is still published (reveal is progressive, not
    // removal)…
    expect(model.hexes).toHaveLength(12);
    expect(model.hexes.map((hex) => hex.id)).toEqual(
      payload.ring.hexes.map((hex) => hex.id),
    );
    // …but with no held ring-1 hex, no ring-2 hex shares an edge with the
    // hangar, so nothing is displayed, focusable or deployable.
    expect(model.hexes.every((hex) => !hex.displayed)).toBe(true);
    expect(deployable).toHaveLength(0);
    expect(model.focusOrder).toEqual([HEX_MAP_HANGAR_ROW_KEY]);
    expect(model.attractHexId).toBeNull();
    expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
    // A hidden hex is unreachable by focus, click or the attract bot.
    expect(scene.focusRow('hex:hex-r2-12')).toBe(false);
  });

  it('reveals ring 2 progressively once a ring-1 neighbour is held', async () => {
    // Hold ring-1 hex-r1-2 (1,-1); its ring-2 neighbours hex-r2-8,
    // hex-r2-10 and hex-r2-11 become displayed and deployable while the
    // other nine ring-2 hexes stay hidden (ring-2 content is not removed).
    const ring1 = createRingState(1, HEX_RING_DEFINITIONS);
    const held = ring1.hexes.find((hex) => hex.id === 'hex-r1-2')!;
    const payload: HangarWarPayload = {
      ...ringPayload(2),
      ring: {
        ringIndex: 2,
        hexes: [
          {
            ...held,
            held: true,
            defender: {
              hullId: 'hull-1',
              defenceRating: 7,
              bankedMinerals: 0,
            },
          },
          ...ringPayload(2).ring.hexes,
        ],
      },
    };
    const scene = await bootMap({ payload, storage: null });
    const model = scene.getModel();
    const deployable = scene
      .getRows()
      .filter((row) => row.key.startsWith('hex:') && row.actionable);

    expect(new Set(deployable.map((row) => row.key))).toEqual(
      new Set(['hex:hex-r2-8', 'hex:hex-r2-10', 'hex:hex-r2-11']),
    );
    expect(model.hexes).toHaveLength(13);
    expect(model.ringLine).toBe('RING 2 — 1/13 HEXES HELD');
    expect(scene.focusRow('hex:hex-r2-10')).toBe(true);
    // A hidden ring-2 hex is not focusable even though it is still stored.
    expect(scene.focusRow('hex:hex-r2-1')).toBe(false);
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
    // Held hexes are still selectable: focus order covers every displayed hex
    // (held included) plus the hangar row (contract AC2); the renderer's
    // held-hex focusability lands with the renderer item.
    expect(scene.getModel().focusOrder).toEqual([
      ...scene.getModel().hexes.map((hex) => hex.key),
      HEX_MAP_HANGAR_ROW_KEY,
    ]);
    expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
    // A held hex cannot be deployed at.
    expect(scene.focusRow('hex:hex-r1-1')).toBe(false);
    // The hangar focus is not a hex, so the panel falls back to the model's
    // first hex rather than going blank.
    expect(scene.getPanelKey()).toBe(scene.getModel().hexes[0].key);
    expect(scene.getPanelText()).toContain(scene.getModel().hexes[0].id);
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

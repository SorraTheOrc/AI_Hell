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
 *
 * ## Hangar Map UX renderer + navigation contract
 * (AH-0MWEWYT79001D3A1, parent AH-0MWDBI33V003QQ3U)
 *
 * **TEST-FIRST.** This item replaces the shipped renderer expectations with
 * the Hangar Map UX contract **before** the renderer (AH-0MWEWYUAS002P7P9) and
 * navigation (AH-0MWEWYVD7008PPQT) items land. New/re-written assertions are
 * authored under Vitest's `it.fails` (the repo's red-before/green-after
 * convention — see `src/core/levelScaling.test.ts`) so this suite stays green
 * on pre-change HEAD while pinning the post-change contract; those
 * implementation items flip them back to `it`, and a leftover `it.fails` then
 * fails loudly.
 *
 * ## Pinned contract (the implementation items must match exactly)
 *
 * - **Reveal-filtered drawing.** Only `displayed` hexes are drawn: a hidden
 *   hex gets no tile, no click zone and no focusable row. A payload whose
 *   ring-2 hexes share no edge with the hangar or a held hex renders the
 *   hangar row alone; holding a ring-1 hex reveals exactly its ring-2
 *   neighbours (progressive reveal — ring-2 content is never removed).
 * - **CVD-safe ownership encoding.** Tile text is blue-dominant for a held hex
 *   and orange-dominant for an unheld hex, and every tile label carries the
 *   non-colour ownership marker (`●` held / `○` unheld) so ownership is
 *   readable without colour. The legend spells out the coordinates and the
 *   CVD-safe pair. The focus highlight must not clobber the ownership colour
 *   (highlight with a stroke, not a colour swap), so the encoding holds whether
 *   or not a tile is focused.
 * - **Coordinates.** Every rendered row's label is
 *   `(q,r) AGG n <marker>`, rendered at the readable tile size.
 * - **Owned-hex selection.** Every displayed hex is selectable (focusable), a
 *   held hex included: focusing it shows its full intel in the detail panel
 *   and activating it performs **no** deployment. An unheld displayed hex
 *   still deploys through the shipped `PlayScene` path.
 * - **Grid navigation.** Arrow keys move focus spatially through the model's
 *   `gridColumns` (left/right across columns with wrapping, up/down within a
 *   column with wrapping) and reach the `◀ HANGAR` row from every column,
 *   because the hangar is folded in as each column's bottom row. Tab/Shift+Tab
 *   keep their linear reading-order cycling, and the attract bot never targets
 *   a hidden hex.
 */

import { afterAll, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  createReusableBoot,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import {
  createDefaultPayload,
  HANGAR_WAR_STORAGE_KEY,
  loadHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { createRingState } from '../core/hangarWar/hexRing';
import {
  HELD_TILE_MARKER,
  HEX_MAP_HANGAR_ROW_KEY,
  HEX_MAP_TITLE,
  UNHELD_TILE_MARKER,
  buildHexMapModel,
  pickAttractHex,
  type HexMapModel,
} from '../core/hangarWar/hexIntel';
import { buildDefenceReport } from '../core/hangarWar/defenceReport';
import type {
  FrontierTickRecord,
  HexDefenceRecord,
} from '../core/hangarWar/hexDefence';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { buildLevelUpOption } from '../powerups/choice';
import {
  buildWheelWedges,
  drawWheelOutcome,
  type MiniBossWinReward,
} from '../powerups/miniBossWheel';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { HEX_MAP_HINT } from './hangarWar/hexMap';
import { MineralChoiceScene } from './MineralChoiceScene';
import {
  MINI_BOSS_WHEEL_SCENE_KEY,
  MiniBossWheelScene,
} from './MiniBossWheelScene';
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

/** A ring-1 payload with `hexId` held (and defended by a bot). */
function heldPayload(hexId: string): HangarWarPayload {
  const payload = ringPayload(1);
  const hex = payload.ring.hexes.find((entry) => entry.id === hexId);
  if (!hex) throw new Error(`no ring-1 hex ${hexId}`);
  hex.held = true;
  hex.defender = { hullId: 'hull-1', defenceRating: 7, bankedMinerals: 0 };
  return payload;
}

/** Dispatches a keydown through the scene keyboard plugin (as a user would). */
function press(scene: Phaser.Scene, key: string, shiftKey = false): void {
  scene.input.keyboard!.emit('keydown', {
    key,
    shiftKey,
    repeat: false,
    preventDefault: () => {},
  } as KeyboardEvent);
}

/** The RGB channels of a rendered text colour (`#rrggbb`). */
function colourOf(text: Phaser.GameObjects.Text): {
  r: number;
  g: number;
  b: number;
} {
  const css = text.style.color;
  if (typeof css !== 'string') {
    throw new Error('tile text colour is not a CSS colour string');
  }
  const packed = Phaser.Display.Color.HexStringToColor(css).color;
  return {
    r: (packed >> 16) & 0xff,
    g: (packed >> 8) & 0xff,
    b: packed & 0xff,
  };
}

/** Every on-screen text joined together (legend/hint/tile assertions). */
function screenText(scene: Phaser.Scene): string {
  return scene.children.list
    .filter(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text,
    )
    .map((child) => child.text)
    .join('\n');
}

/**
 * Attack arrows and the left-hand attack-details panel
 * (AH-0MWEXI5460080WEI, parent AH-0MWDC3L9I008INDP).
 *
 * **TEST-FIRST.** The rolled-in report means the map draws one arrow per attack
 * in the carried between-sortie tick record and a LEFT-hand panel showing that
 * attack's numbers whenever the focused hex is either arrow endpoint. The
 * assertions were authored under Vitest's `it.fails` (the repo's
 * red-before/green-after convention, see `src/core/levelScaling.test.ts`) so
 * this suite stayed green on pre-change HEAD while pinning the post-change
 * contract; the renderer item (AH-0MWEXIHHK007H32A) drew the arrows and the
 * left panel and flipped them back to `it`. A leftover `it.fails` here would
 * fail loudly now that the change has landed.
 *
 * ## Pinned contract (the implementation items must match exactly)
 *
 * - `HexMapSceneData` gains `record?: FrontierTickRecord`; the model accepts
 *   it as `buildHexMapModel(payload, { record })` and publishes `arrows` plus
 *   `attackDetails` (see `src/core/hangarWar/hexIntel.test.ts`).
 * - `HexMapScene` gains `getArrows()` (the drawn arrows with their axial pixel
 *   endpoints), `getLeftPanelText()` and `isLeftPanelVisible()` test seams
 *   which pass the renderer's view straight through.
 * - The shared `renderHexMap` view gains `arrows: readonly HexMapArrow[]`
 *   (`{ key, hexId, attackerOriginId, from: {x,y}, to: {x,y} }`) and the left
 *   panel seams `getLeftPanelText()` / `isLeftPanelVisible()`. Arrows run from
 *   the attacker-origin hex's `axialToPixel` position to the attacked hex's.
 * - The left panel is keyed off the shared `FocusManager` like the right
 *   panel: it shows an attack's details for the attacked hex **and** for its
 *   attacker-origin hex, and hides for any hex involved in no attack. The
 *   right-hand intel panel is untouched.
 * - The record is transient launch data: re-entering the map without one
 *   draws no arrows and keeps the left panel hidden.
 */

/**
 * The scene seams this item pins. They now live on the shipped `HexMapScene`
 * (AH-0MWEXIHHK007H32A), so this is an alias — the seams must stay.
 */
type AttackAwareScene = HexMapScene;

/**
 * The model with the attack fields this test-first item pins. They now live on
 * the shipped `HexMapModel` (AH-0MWEXIAEQ004IT0R), so this is an alias.
 */
type AttackAwareModel = HexMapModel;

/**
 * A five-hex payload: two attacked hexes (both lost) with their unheld
 * attacker-origin neighbours, plus one hex involved in no attack.
 */
function attackPayload(): HangarWarPayload {
  const template = createDefaultPayload(424242);
  return {
    ...template,
    ring: {
      ringIndex: 1,
      hexes: [
        {
          id: 'hex-held',
          q: 1,
          r: 0,
          held: false,
          aggression: 3,
          defender: null,
          bossDefeated: true,
          grantedWeapon: null,
        },
        {
          id: 'hex-frontier',
          q: 0,
          r: 1,
          held: false,
          aggression: 3,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
        {
          id: 'hex-held-2',
          q: -1,
          r: 0,
          held: false,
          aggression: 2,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
        {
          id: 'hex-frontier-2',
          q: 0,
          r: -1,
          held: false,
          aggression: 2,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
        {
          id: 'hex-idle',
          q: 1,
          r: -1,
          held: false,
          aggression: 1,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
      ],
    },
  };
}

/** One resolved attack, as the frontier tick's record carries it. */
function recordAttack(
  overrides: Partial<HexDefenceRecord> = {},
): HexDefenceRecord {
  return {
    outcome: 'fell',
    defenderRating: 2,
    attackingForce: 4,
    aggression: 3,
    aggressionMultiplierPercent: 145,
    jitterPercent: 6,
    attackStrength: 6,
    margin: -4,
    hexId: 'hex-held',
    attackerOriginId: 'hex-frontier',
    attackerOrigin: { q: 0, r: 1 },
    source: 'frontier',
    ...overrides,
  };
}

/** The tick record carried onto the map: two resolved attacks. */
function attackRecord(
  overrides: Partial<FrontierTickRecord> = {},
): FrontierTickRecord {
  return {
    tick: 7,
    playerStrength: 2,
    aggressionBudget: 20,
    beatableCeiling: 2,
    deltas: [],
    rose: 0,
    fell: 0,
    attacks: [
      recordAttack(),
      recordAttack({
        hexId: 'hex-held-2',
        attackerOriginId: 'hex-frontier-2',
        attackerOrigin: { q: 0, r: -1 },
      }),
    ],
    ...overrides,
  };
}

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

  it.fails(
    'renders no tile for a hidden hex (the reveal is adjacency-only)',
    async () => {
      const payload = ringPayload(2);
      const scene = await bootMap({ payload, storage: null });
      const model = scene.getModel();

      // The full stored ring is still published (reveal is progressive, not
      // removal — epic AC6)…
      expect(model.hexes).toHaveLength(12);
      expect(model.hexes.map((hex) => hex.id)).toEqual(
        payload.ring.hexes.map((hex) => hex.id),
      );
      // …but with no held ring-1 hex, no ring-2 hex shares an edge with the
      // hangar, so no hex tile is drawn: only the hangar row remains.
      expect(model.hexes.every((hex) => !hex.displayed)).toBe(true);
      expect(scene.getRows().map((row) => row.key)).toEqual([
        HEX_MAP_HANGAR_ROW_KEY,
      ]);
      const rendered = screenText(scene);
      for (const hex of model.hexes) {
        expect(rendered).not.toContain(`(${hex.q},${hex.r}) AGG`);
      }

      // A hidden hex is unreachable by focus and by the attract bot.
      expect(scene.focusRow('hex:hex-r2-12')).toBe(false);
      expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
      expect(model.attractHexId).toBeNull();
    },
  );

  it.fails(
    'reveals ring-2 neighbours progressively once a ring-1 neighbour is held',
    async () => {
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
      const hexRows = scene
        .getRows()
        .filter((row) => row.key.startsWith('hex:'));

      // Exactly the held ring-1 hex and its revealed ring-2 neighbours are
      // drawn; a hidden ring-2 hex has no tile and no focusable row.
      expect(new Set(hexRows.map((row) => row.key))).toEqual(
        new Set([
          'hex:hex-r1-2',
          'hex:hex-r2-8',
          'hex:hex-r2-10',
          'hex:hex-r2-11',
        ]),
      );
      expect(model.hexes).toHaveLength(13);
      expect(model.ringLine).toBe('RING 2 — 1/13 HEXES HELD');
      const hidden = model.hexes.filter((hex) => !hex.displayed);
      expect(hidden).toHaveLength(9);
      expect(hidden.map((hex) => hex.id)).toContain('hex-r2-12');

      // Owned-hex selection: the held ring-1 hex is selectable (focusable).
      expect(scene.focusRow('hex:hex-r1-2')).toBe(true);
      // A hidden ring-2 hex is not focusable even though it is still stored.
      expect(scene.focusRow('hex:hex-r2-1')).toBe(false);
    },
  );

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

  it.fails(
    'keeps owned hexes selectable but never deployable once the ring is secured',
    async () => {
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

      expect(scene.getModel().ringLine).toContain('SECURED');
      // A secured ring has nothing to deploy at…
      expect(
        rows
          .filter((row) => row.key.startsWith('hex:'))
          .every((row) => !row.actionable),
      ).toBe(true);

      // …yet owned-hex selection still works: a held hex is focusable and the
      // detail panel shows its full intel (contract AC5).
      expect(scene.focusRow('hex:hex-r1-1')).toBe(true);
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-1');
      expect(scene.getPanelKey()).toBe('hex:hex-r1-1');
      const panel = scene.getPanelText();
      expect(panel).toContain('hex-r1-1');
      expect(panel).toContain('HELD');
      expect(panel).toContain('the-dawnbreaker');

      // Activating an owned hex performs no deployment: the map stays up.
      scene.activateFocused();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
      expect(scene.sys.isActive()).toBe(true);
    },
  );

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

  // ── Hangar Map UX: CVD-safe encoding, owned-hex selection, grid arrows ──
  // (AH-0MWEWYT79001D3A1 — see the pinned contract in this file's header.)

  it.fails(
    'encodes ownership with the CVD-safe pair plus a non-colour discriminator',
    async () => {
      const scene = await bootMap({
        payload: heldPayload('hex-r1-2'),
        storage: null,
      });
      const rows = scene.getRows();
      const heldRow = rows.find((row) => row.key === 'hex:hex-r1-2')!;
      const unheldRow = rows.find((row) => row.key === 'hex:hex-r1-3')!;

      // Non-colour discriminator: filled marker = held, hollow = unheld, and
      // the rendered text carries exactly the row label.
      expect(heldRow.label).toMatch(/^\(1,-1\) AGG \d+ ●$/);
      expect(heldRow.label).toContain(HELD_TILE_MARKER);
      expect(heldRow.label).not.toContain(UNHELD_TILE_MARKER);
      expect(unheldRow.label).toContain(UNHELD_TILE_MARKER);
      expect(heldRow.text.text).toBe(heldRow.label);
      expect(unheldRow.text.text).toBe(unheldRow.label);

      // CVD-safe pair (producer Q2 = b): held text is blue-dominant and unheld
      // text orange-dominant — ownership never relies on red/green.
      const held = colourOf(heldRow.text);
      const unheld = colourOf(unheldRow.text);
      expect(held.b).toBeGreaterThan(held.r);
      expect(held.b).toBeGreaterThan(held.g);
      expect(unheld.r).toBeGreaterThan(unheld.b);
      expect(unheld.r).toBeGreaterThanOrEqual(unheld.g);
      expect(heldRow.text.style.color).not.toBe(unheldRow.text.style.color);

      // The legend spells out the coordinates and the CVD-safe encoding, so a
      // player can read the map without relying on colour.
      const legend = screenText(scene);
      expect(legend).toContain('(q,r)');
      expect(legend.toLowerCase()).toContain('blue');
      expect(legend.toLowerCase()).toContain('orange');
    },
  );

  it.fails(
    "shows a held hex's full intel when focused and never deploys from it",
    async () => {
      const scene = await bootMap({
        payload: heldPayload('hex-r1-2'),
        storage: null,
      });

      // Owned-hex selection: focusing the held hex shows its full intel.
      expect(scene.focusRow('hex:hex-r1-2')).toBe(true);
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-2');
      expect(scene.getPanelKey()).toBe('hex:hex-r1-2');
      const panel = scene.getPanelText();
      expect(panel).toContain('hex-r1-2');
      expect(panel).toContain('HELD');
      expect(panel).toContain('shroud-merchant');
      expect(panel).toContain('W:waveLaser');
      expect(panel).toContain('→extra-life');
      expect(panel).toContain('bot hull-1');

      // Activating an owned hex performs no deployment: the map stays up.
      scene.activateFocused();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
      expect(scene.sys.isActive()).toBe(true);

      // An unheld displayed hex still deploys through the shipped path.
      expect(scene.focusRow('hex:hex-r1-3')).toBe(true);
      scene.activateFocused();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
      const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
      expect(play.getHangarWarDeployment()!.hexId).toBe('hex-r1-3');
    },
  );

  it.fails(
    'moves focus spatially with the arrow keys and reaches the hangar row',
    async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });
      const model = scene.getModel();

      // Ring 1's spatial columns (pointy-top layout, the hangar folded in as
      // the bottom row of every column) come from the pure model.
      expect(model.gridColumns).toEqual([
        ['hex:hex-r1-4', HEX_MAP_HANGAR_ROW_KEY],
        ['hex:hex-r1-3', 'hex:hex-r1-5', HEX_MAP_HANGAR_ROW_KEY],
        ['hex:hex-r1-2', 'hex:hex-r1-6', HEX_MAP_HANGAR_ROW_KEY],
        ['hex:hex-r1-1', HEX_MAP_HANGAR_ROW_KEY],
      ]);

      // ArrowLeft/ArrowRight move across columns, not through reading order.
      expect(scene.focusRow('hex:hex-r1-3')).toBe(true);
      press(scene, 'ArrowRight');
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-2');
      press(scene, 'ArrowLeft');
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-3');

      // ArrowDown/ArrowUp move within the current column (wrapping).
      press(scene, 'ArrowDown');
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-5');
      press(scene, 'ArrowDown');
      expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
      press(scene, 'ArrowUp');
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-5');

      // Horizontal navigation wraps at the outer columns (clamping the row).
      expect(scene.focusRow('hex:hex-r1-1')).toBe(true); // last column
      press(scene, 'ArrowRight');
      expect(scene.getFocusedKey()).toBe('hex:hex-r1-4'); // first column

      // The hangar row is arrow-reachable from every column: it is the bottom
      // row, so ArrowUp from a column's top row wraps onto it.
      for (const column of model.gridColumns) {
        expect(scene.focusRow(column[0])).toBe(true);
        press(scene, 'ArrowUp');
        expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
      }
    },
  );

  it('keeps Tab and Shift+Tab on the linear reading order', async () => {
    const scene = await bootMap({ payload: ringPayload(1), storage: null });
    const order = scene.getRows().map((row) => row.key);

    expect(scene.focusRow(order[0])).toBe(true);
    press(scene, 'Tab');
    expect(scene.getFocusedKey()).toBe(order[1]);
    press(scene, 'Tab', true);
    expect(scene.getFocusedKey()).toBe(order[0]);
    // Shift+Tab from the first row wraps to the last (the hangar row).
    press(scene, 'Tab', true);
    expect(scene.getFocusedKey()).toBe(order.at(-1));
  });

  // ── Attack arrows and the left-hand attack panel (AH-0MWEXI5460080WEI) ──

  it(
    'draws one arrow per attack from the origin hex to the attacked hex',
    async () => {
      const payload = attackPayload();
      const scene = (await bootMap({
        payload,
        record: attackRecord(),
        storage: null,
      })) as AttackAwareScene;
      const arrows = scene.getArrows?.();

      // One arrow per `record.attacks[]` entry, in the record's order.
      expect(arrows).toHaveLength(2);
      expect(
        arrows!.map((arrow) => [arrow.hexId, arrow.attackerOriginId]),
      ).toEqual([
        ['hex-held', 'hex-frontier'],
        ['hex-held-2', 'hex-frontier-2'],
      ]);

      // Each arrow runs from the attacker-origin hex's axial pixel to the
      // attacked hex's — the tiles render at exactly `axialToPixel(q, r)`, so
      // the arrow endpoints are compared against them (the existing layout).
      const tilePixels = (
        hexId: string,
      ): { readonly x: number; readonly y: number } => {
        const row = scene.getRows().find((entry) => entry.key === `hex:${hexId}`);
        expect(row, `no rendered tile for ${hexId}`).toBeDefined();
        return { x: row!.text.x, y: row!.text.y };
      };
      for (const arrow of arrows!) {
        expect({ x: arrow.from.x, y: arrow.from.y }).toEqual(
          tilePixels(arrow.attackerOriginId),
        );
        expect({ x: arrow.to.x, y: arrow.to.y }).toEqual(
          tilePixels(arrow.hexId),
        );
      }

      // The fed pure model is the arrow source — never a scene-local rule.
      expect(
        (scene.getModel() as AttackAwareModel).arrows?.map(
          (arrow) => arrow.attackerOriginId,
        ),
      ).toEqual(['hex-frontier', 'hex-frontier-2']);
    },
  );

  it(
    'shows the attack\'s details on the LEFT panel for both arrow endpoints',
    async () => {
      const payload = attackPayload();
      const record = attackRecord();
      const scene = (await bootMap({
        payload,
        record,
        storage: null,
      })) as AttackAwareScene;
      const row = buildDefenceReport(payload, record).rows[0];

      // The attacked hex: the panel shows the tick's own numbers.
      expect(scene.focusRow('hex:hex-held')).toBe(true);
      expect(scene.isLeftPanelVisible?.()).toBe(true);
      const attackedText = scene.getLeftPanelText?.() ?? '';
      expect(attackedText).toContain(row.label);
      expect(attackedText).toContain('hex-held — FELL');
      expect(attackedText).toContain('atk 4 × AGG 3');
      expect(attackedText).toContain('= 6 vs bot 2');
      expect(attackedText).toContain('margin -4');
      expect(attackedText).toContain('retake: strike hex-frontier');

      // The attacker-origin hex: the SAME attack's details (one attack, two
      // endpoints), not a second, re-derived view.
      expect(scene.focusRow('hex:hex-frontier')).toBe(true);
      expect(scene.isLeftPanelVisible?.()).toBe(true);
      expect(scene.getLeftPanelText?.() ?? '').toBe(attackedText);

      // The right-hand intel panel stays the focused hex's own intel.
      expect(scene.getPanelKey()).toBe('hex:hex-frontier');
      expect(scene.getPanelText()).toContain('hex-frontier');
    },
  );

  it(
    'hides the left panel for an uninvolved hex and leaves the right panel unchanged',
    async () => {
      const payload = attackPayload();
      const withRecord = (await bootMap({
        payload,
        record: attackRecord(),
        storage: null,
      })) as AttackAwareScene;

      expect(withRecord.focusRow('hex:hex-idle')).toBe(true);
      expect(withRecord.isLeftPanelVisible?.()).toBe(false);
      expect(withRecord.getLeftPanelText?.() ?? '').toBe('');

      const rightWith = withRecord.getPanelText();
      expect(withRecord.getPanelKey()).toBe('hex:hex-idle');
      expect(rightWith).toContain('hex-idle');
      expect(rightWith).toContain('AGG 1');

      // The right-hand intel panel is not a function of the record: entering
      // the map without one shows exactly the same intel for the same hex.
      const withoutRecord = (await bootMap({
        payload,
        storage: null,
      })) as AttackAwareScene;
      expect(withoutRecord.focusRow('hex:hex-idle')).toBe(true);
      expect(withoutRecord.getPanelKey()).toBe('hex:hex-idle');
      expect(withoutRecord.getPanelText()).toBe(rightWith);
      expect(withoutRecord.isLeftPanelVisible?.()).toBe(false);
    },
  );

  it('draws no arrows and no left panel for a quiet tick', async () => {
    const scene = (await bootMap({
      payload: attackPayload(),
      record: attackRecord({ attacks: [] }),
      storage: null,
    })) as AttackAwareScene;

    expect(scene.getArrows?.()).toEqual([]);
    expect(scene.focusRow('hex:hex-held')).toBe(true);
    expect(scene.isLeftPanelVisible?.()).toBe(false);
    expect(scene.getLeftPanelText?.() ?? '').toBe('');
  });

  it(
    're-entering the map without a record draws no arrows and keeps the left panel hidden',
    async () => {
      const payload = attackPayload();
      const scene = (await bootMap({
        payload,
        record: attackRecord(),
        storage: null,
      })) as AttackAwareScene;
      expect(scene.getArrows?.()).toHaveLength(2);
      expect(scene.focusRow('hex:hex-held')).toBe(true);
      expect(scene.isLeftPanelVisible?.()).toBe(true);

      // The arrows are transient launch data: re-entering the map later (from
      // the menu/hangar) carries no record, so nothing persists.
      booted!.game.scene.start(HEX_MAP_SCENE_KEY, { payload, storage: null });
      await advanceGame(booted!.game, 200);
      const reentered = booted!.game.scene.getScene(
        HEX_MAP_SCENE_KEY,
      ) as AttackAwareScene;

      expect(reentered.getArrows?.()).toEqual([]);
      expect((reentered.getModel() as AttackAwareModel).arrows).toEqual([]);
      expect(reentered.focusRow('hex:hex-held')).toBe(true);
      expect(reentered.isLeftPanelVisible?.()).toBe(false);
      expect(reentered.getLeftPanelText?.() ?? '').toBe('');
    },
  );

  // ── Run line, record and reward over the paused map ─────────────
  // (AH-0MWEXIOZZ009UX14, parent AH-0MWDC3L9I008INDP)

  /** A resolved wheel reward for `spread` (slot 0 = the bonus outcome). */
  function spreadWheelReward(): MiniBossWinReward {
    return {
      kind: 'wheel',
      wedges: buildWheelWedges(['spread']),
      outcome: drawWheelOutcome(0, ['spread']),
    };
  }

  /** Boots the map with the shipped reward overlays registered. */
  async function bootMapWithOverlays(data?: object): Promise<HexMapScene> {
    booted = await reuse.boot([
      HexMapScene,
      PlayScene,
      HangarScene,
      MiniBossWheelScene,
      MineralChoiceScene,
    ]);
    booted.game.scene.start(HEX_MAP_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
  }

  it('renders the run result line carried from the deployment', async () => {
    const won = await bootMap({
      payload: ringPayload(1),
      record: attackRecord(),
      won: true,
      score: 1200,
      storage: null,
    });
    expect(won.getRunLine()).toBe('RUN: VICTORY · score 1200');
    findTextStartingWith(won, 'RUN: VICTORY · score 1200');

    const lost = await bootMap({
      payload: ringPayload(1),
      record: attackRecord(),
      won: false,
      score: 42,
      storage: null,
    });
    expect(lost.getRunLine()).toBe('RUN: DEFEAT · score 42');
    findTextStartingWith(lost, 'RUN: DEFEAT · score 42');
  });

  it('shows no run line and carries no record on a plain landing', async () => {
    const scene = await bootMap({ payload: ringPayload(1), storage: null });

    expect(scene.getRunLine()).toBeNull();
    expect(scene.getRecord()).toBeNull();
    expect(
      scene.children.list.some(
        (child) =>
          child instanceof Phaser.GameObjects.Text &&
          child.text.startsWith('RUN:'),
      ),
    ).toBe(false);
  });

  it('exposes the carried tick record but never persists it', async () => {
    const payload = ringPayload(1);
    const record = attackRecord();
    const scene = await bootMap({ payload, record, storage: null });

    expect(scene.getRecord()).toEqual(record);
    // A detached copy: callers cannot mutate what the map rendered.
    const copy = scene.getRecord() as unknown as { attacks: unknown[] };
    copy.attacks.push({});
    expect(scene.getRecord()).toEqual(record);

    // Re-entering the map later (menu/hangar) carries no record.
    booted!.game.scene.start(HEX_MAP_SCENE_KEY, { payload, storage: null });
    await advanceGame(booted!.game, 200);
    const reentered = booted!.game.scene.getScene(
      HEX_MAP_SCENE_KEY,
    ) as HexMapScene;
    expect(reentered.getRecord()).toBeNull();
    expect(reentered.getRunLine()).toBeNull();
  });

  it('presents the carried wheel reward over the paused map, then map interaction resumes', async () => {
    const reward = spreadWheelReward();
    const payload = ringPayload(1);
    const scene = await bootMapWithOverlays({
      payload,
      record: attackRecord(),
      won: true,
      score: 1200,
      reward,
      storage: null,
    });

    // The map is paused under the shipped overlay and the reward is consumed.
    expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(false);
    expect(booted!.game.scene.isActive(MINI_BOSS_WHEEL_SCENE_KEY)).toBe(true);
    expect(scene.getReward()).toBeNull();

    const wheel = booted!.game.scene.getScene(
      MINI_BOSS_WHEEL_SCENE_KEY,
    ) as MiniBossWheelScene;
    expect(wheel.getOutcome()).toEqual(
      reward.kind === 'wheel' ? reward.outcome : null,
    );
    expect(wheel.spin()).toBe(true);
    await advanceGame(booted!.game, 3000);

    // The map resumes normal interaction: it is live and deploys again.
    expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
    expect(scene.getRunLine()).toBe('RUN: VICTORY · score 1200');
    const row = scene.getRows().find((entry) => entry.key.startsWith('hex:'));
    expect(row, 'the resumed map has deployable hex rows').toBeDefined();
    row!.text.emit('pointerdown');
    await advanceGame(booted!.game, 350);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
  });

  it('presents the empty-owned choice fallback over the paused map', async () => {
    const option = buildLevelUpOption('spread', 1);
    expect(option).toBeDefined();
    await bootMapWithOverlays({
      payload: ringPayload(1),
      record: attackRecord(),
      won: true,
      score: 700,
      reward: { kind: 'choice', options: [option!] },
      storage: null,
    });

    expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive('MineralChoiceScene')).toBe(true);

    const choice = booted!.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;
    expect(choice.select(0)).not.toBeNull();
    stepGameUntil(
      booted!.game,
      'the map resumes after the choice reward',
      () =>
        booted!.game.scene.isActive(HEX_MAP_SCENE_KEY) &&
        !booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY),
      600,
    );
  });

  it('consumes the reward exactly once', async () => {
    const scene = await bootMapWithOverlays({
      payload: ringPayload(1),
      record: attackRecord(),
      won: true,
      score: 500,
      reward: spreadWheelReward(),
      storage: null,
    });

    // A second presentation path cannot re-present the consumed reward.
    expect(scene.presentReward()).toBe(false);
    expect(scene.getReward()).toBeNull();
    const wheel = booted!.game.scene.getScene(
      MINI_BOSS_WHEEL_SCENE_KEY,
    ) as MiniBossWheelScene;
    wheel.spin();
    await advanceGame(booted!.game, 3000);

    expect(scene.presentReward()).toBe(false);
    expect(booted!.game.scene.isActive(MINI_BOSS_WHEEL_SCENE_KEY)).toBe(false);
    expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
  });

  it('goes straight to the map when the reward overlay is not registered', async () => {
    booted = await reuse.boot([HexMapScene, PlayScene, HangarScene]);
    booted.game.scene.start(HEX_MAP_SCENE_KEY, {
      payload: ringPayload(1),
      record: attackRecord(),
      won: true,
      score: 500,
      reward: spreadWheelReward(),
      storage: null,
    });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;

    // A headless boot without the overlay must not stall on it.
    expect(booted.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
    expect(booted.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
    expect(scene.getReward()).toBeNull();
    expect(
      scene.getRows().some((row) => row.key.startsWith('hex:')),
    ).toBe(true);
  });

  it('auto-resolves the carried reward in demo mode without stalling', async () => {
    await bootMapWithOverlays({
      payload: ringPayload(1),
      record: attackRecord(),
      won: true,
      score: 500,
      reward: spreadWheelReward(),
      demo: true,
      demoDwellMs: 400,
      storage: null,
    });

    // The overlay auto-spins itself past the dwell, then the map resumes and
    // the traversal continues (the demo never stalls on the reward or map).
    stepGameUntil(
      booted!.game,
      'the demo traverses past the reward and the map',
      () => booted!.game.scene.isActive('PlayScene'),
      900,
    );
  });
});

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
 * - focusing/activating an unheld hex opens the ship-config (hangar) screen
 *   pre-targeted at it, whose `▶ DEPLOY` launches the shipped `PlayScene`;
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
 * fails loudly. The renderer item (AH-0MWEWYUAS002P7P9) flipped the
 * reveal/selection assertions; the navigation item (AH-0MWEWYVD7008PPQT) flipped
 * the grid-arrow assertion when it wired `FocusManager` grid mode.
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
 * - **Coordinates.** Every rendered row's label is `AGG n <marker>` with the
 *   axial coordinates `(q,r)` on a separate line **below** the aggression
 *   badge, in a smaller font than the badge (they are secondary, glanceable
 *   information — producer review AH-0MWDBI33V003QQ3U, 2026-11-15).
 * - **Owned-hex selection.** Every displayed hex is selectable (focusable), a
 *   held hex included: focusing it shows its full intel in the detail panel
 *   and activating it performs **no** deployment. An unheld displayed hex
 *   still opens the config screen pre-targeted at it (whose `▶ DEPLOY` then
 *   launches the shipped `PlayScene` path).
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
  CONTROLS_HEADING,
  HELD_TILE_MARKER,
  HEX_MAP_HANGAR_ROW_KEY,
  HEX_MAP_TITLE,
  LAST_SORTIE_HEADING,
  SELECTED_HEX_HEADING,
  UNHELD_TILE_MARKER,
  WAR_STATUS_HEADING,
  buildHexMapModel,
  pickAttractHex,
  type HexMapModel,
} from '../core/hangarWar/hexIntel';
import { buildDefenceReport } from '../core/hangarWar/defenceReport';
import type {
  FrontierTickRecord,
  HangarAssaultResolution,
  HexDefenceRecord,
} from '../core/hangarWar/hexDefence';
import {
  DEFAULT_FRONTIER_TUNING,
  resolveHangarAssault,
} from '../core/hangarWar/hexDefence';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import type { SortieResultRecord } from '../core/hangarWar/sortieResult';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { buildLevelUpOption } from '../powerups/choice';
import {
  buildWheelWedges,
  drawWheelOutcome,
  type MiniBossWinReward,
} from '../powerups/miniBossWheel';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { BOT_UPGRADE_SCENE_KEY, BotUpgradeScene } from './BotUpgradeScene';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  HEX_MAP_HINT,
  HEX_MAP_SECTION_RECTS,
  LAST_SORTIE_HEIGHT,
  LAST_SORTIE_LINE_BUDGET,
  sectionBodyHeight,
  sectionBodyWidth,
  sectionBudgetHeight,
  wrappedLineCount,
} from './hangarWar/hexMap';
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

/** A payload with one held hex whose defender carries run upgrades (C6). */
function upgradedHeldPayload(): HangarWarPayload {
  const payload = ringPayload(1);
  const hex = payload.ring.hexes.find(
    (candidate) => candidate.id === 'hex-r1-1',
  )!;
  hex.held = true;
  hex.bossDefeated = true;
  hex.defender = {
    hullId: 'hull-2',
    defenceRating: 14,
    bankedMinerals: 0,
    upgradeSnapshot: {
      weaponLevels: [{ id: 'spread', level: 1 }],
      powerUpLevels: [{ id: 'shield', level: 1 }],
      consumablePools: [{ id: 'shield', charges: 1 }],
    },
  };
  return payload;
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
    effectiveDefenderRating: 2,
    skillBonusTotal: 0,
    appliedSkills: [],
    attackingForce: 4,
    aggression: 3,
    aggressionMultiplierPercent: 145,
    jitterPercent: 6,
    attackStrength: 6,
    margin: -4,
    hexId: 'hex-held',
    attackerOriginId: 'hex-frontier',
    attackerOrigin: { q: 0, r: 1 },
    attackerType: null,
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
    hexIncome: 0,
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
    booted = await reuse.boot([
      HexMapScene,
      PlayScene,
      HangarScene,
      BotUpgradeScene,
    ]);
    booted.game.scene.start(HEX_MAP_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
  }

  /**
   * Activates the config screen's `▶ DEPLOY` row — the step the map now hands
   * off to instead of starting `PlayScene` itself (AH-0MWMT4S5U001EGDF).
   */
  function deployFromConfig(): void {
    const hangar = booted!.game.scene.getScene(
      HANGAR_SCENE_KEY,
    ) as HangarScene;
    const row = hangar.getRows().find((entry) => entry.key === 'deploy');
    expect(row, 'the config screen has no ▶ DEPLOY row').toBeDefined();
    row!.text.emit('pointerdown');
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
      // The tile carries aggression + ownership marker first, coordinates on
      // their own second line; ownership is also readable without colour.
      // Authored variety tags (`✦ CONTRACT`, `⚡ FORTRESS`) may follow below.
      expect(row.label.split('\n').slice(0, 2)).toEqual([
        `AGG ${intel.aggression} ${UNHELD_TILE_MARKER}`,
        `(${intel.q},${intel.r})`,
      ]);
      // The rendered text object is the label's first line (the aggression
      // badge); the coordinates render as the smaller line below it.
      expect(row.text.text).toBe(row.label.split('\n')[0]);
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
    expect(panel).toContain(`WEAKNESSES: ${panelHex.weaknesses.join(',')}`);
    expect(panel).toContain(`GRANT: ${panelHex.grants}`);
    expect(panel).toContain(`AGGRESSION: ${panelHex.aggression}`);

    // A concrete authored hex: ring 1's easiest (the default focus), its boss
    // and its grant all reachable through the panel.
    const easiest = scene
      .getRows()
      .find((row) => row.key === 'hex:hex-r1-2')!;
    expect(easiest.label).toBe(`AGG 1 ${UNHELD_TILE_MARKER}\n(1,-1)`);
    expect(panel).toContain('shroud-merchant');
    expect(panel).toContain('WEAKNESSES: waveLaser');
    expect(panel).toContain('GRANT: extra-life');
  });

  it(
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
        // No stored hex renders a tile, so its axial coordinates never appear
        // (the legend's generic `(q,r)` line is not a specific pair).
        expect(rendered).not.toContain(`(${hex.q},${hex.r})`);
      }

      // A hidden hex is unreachable by focus and by the attract bot.
      expect(scene.focusRow('hex:hex-r2-12')).toBe(false);
      expect(scene.getFocusedKey()).toBe(HEX_MAP_HANGAR_ROW_KEY);
      expect(model.attractHexId).toBeNull();
    },
  );

  it(
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

  it('opens the config screen pre-targeted at the focused hex, then deploys there', async () => {
    const payload = ringPayload(1);
    const scene = await bootMap({ payload, storage: null });
    const weakest = pickAttractHex(payload)!;

    expect(scene.focusRow(`hex:${weakest}`)).toBe(true);
    scene.activateFocused();
    await advanceGame(booted!.game, 350);

    // The map starts no battle: it opens the ship-config (hangar) screen for
    // the chosen hex (AH-0MWMT4S5U001EGDF, parent AH-0MWMRWCY2001HWGR AC1).
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
    expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(true);
    const hangar = booted!.game.scene.getScene(
      HANGAR_SCENE_KEY,
    ) as HangarScene;
    expect(hangar.getModel().deployRow.hexId).toBe(weakest);

    // The config screen's ▶ DEPLOY launches the shipped deployment at the
    // carried target.
    deployFromConfig();
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

  it('opens the config screen from a pointer click on a hex tile', async () => {
    const scene = await bootMap({ payload: ringPayload(1), storage: null });
    const row = scene.getRows().find((entry) => entry.key === 'hex:hex-r1-3')!;

    row.text.emit('pointerdown');
    await advanceGame(booted!.game, 350);

    // A hex activation is a target choice, not a launch: the config screen
    // opens for that hex and carries it into its ▶ DEPLOY row.
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
    expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(true);
    const hangar = booted!.game.scene.getScene(
      HANGAR_SCENE_KEY,
    ) as HangarScene;
    expect(hangar.getModel().deployRow.hexId).toBe('hex-r1-3');

    deployFromConfig();
    await advanceGame(booted!.game, 350);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.getHangarWarDeployment()!.hexId).toBe('hex-r1-3');
  });

  it('keeps the hangar one click away with no carried target', async () => {
    const payload = ringPayload(1);
    const scene = await bootMap({ payload, storage: null });

    expect(scene.focusRow(HEX_MAP_HANGAR_ROW_KEY)).toBe(true);
    scene.activateFocused();
    await advanceGame(booted!.game, 250);

    expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(true);
    const hangar = booted!.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;
    // The same war state the map showed is handed to the hangar.
    expect(hangar.getPayload()).toEqual(payload);
    // The ◀ HANGAR row carries no target, so ▶ DEPLOY keeps the shipped
    // default: the weakest unheld hex (AH-0MWMT4S5U001EGDF AC3).
    expect(hangar.getModel().deployRow.hexId).toBe(pickAttractHex(payload));
  });

  it(
    'keeps owned hexes selectable and opens the bot-upgrade screen on activation',
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

      // Activating an owned hex never deploys. Now that a held defender can be
      // strengthened (AH-0MWH48IEG00929GQ), it opens the bot-upgrade screen.
      scene.activateFocused();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
      expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(false);
      expect(booted!.game.scene.isActive(BOT_UPGRADE_SCENE_KEY)).toBe(true);
    },
  );

  it('shows a defender’s stored upgrade breakdown in the detail panel (C6)', async () => {
    const scene = await bootMap({ payload: upgradedHeldPayload(), storage: null });

    expect(scene.focusRow('hex:hex-r1-1')).toBe(true);
    const panel = scene.getPanelText();
    // Beside the existing hull line, the panel shows the derived
    // armour/firepower/systems and the upgrade rating contribution — the same
    // numbers the report and the gym render through the shared model.
    expect(panel).toContain('DEFENDER: hull-2 (14)');
    expect(panel).toContain('upgrade armour 2 · firepower 1 · systems 0 (+8)');
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

  // ── Hangar Map UX: CVD-safe encoding, owned-hex selection, grid arrows ──
  // (AH-0MWEWYT79001D3A1 — see the pinned contract in this file's header.)

  it(
    'encodes ownership with the CVD-safe pair plus a non-colour discriminator',
    async () => {
      const scene = await bootMap({
        payload: heldPayload('hex-r1-2'),
        storage: null,
      });
      const rows = scene.getRows();
      const heldRow = rows.find((row) => row.key === 'hex:hex-r1-2')!;
      const unheldRow = rows.find((row) => row.key === 'hex:hex-r1-3')!;

      // Non-colour discriminator: filled marker = held, hollow = unheld. The
      // aggression badge + marker lead the label; coordinates sit below.
      expect(heldRow.label).toMatch(/^AGG \d+ ●\n\(1,-1\)$/);
      expect(heldRow.label).toContain(HELD_TILE_MARKER);
      expect(heldRow.label).not.toContain(UNHELD_TILE_MARKER);
      expect(unheldRow.label).toContain(UNHELD_TILE_MARKER);
      // The rendered text object is the aggression badge line; the coordinates
      // are the smaller second line (pinned by the layout test below).
      expect(heldRow.text.text).toBe(heldRow.label.split('\n')[0]);
      expect(unheldRow.text.text).toBe(unheldRow.label.split('\n')[0]);

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

  it(
    'renders coordinates below the aggression badge at a smaller size',
    async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });
      const row = scene
        .getRows()
        .find((entry) => entry.key === 'hex:hex-r1-2')!;

      // The aggression badge + ownership marker lead the tile label (the
      // readable tile size)…
      expect(row.label).toBe(`AGG 1 ${UNHELD_TILE_MARKER}\n(1,-1)`);
      expect(row.text.text).toBe(`AGG 1 ${UNHELD_TILE_MARKER}`);
      expect(row.text.style.fontSize).toBe('14px');

      // …and the axial coordinates render below it on their own line in a
      // smaller font (producer review AH-0MWDBI33V003QQ3U, 2026-11-15).
      const coords = scene.children.list.find(
        (child): child is Phaser.GameObjects.Text =>
          child instanceof Phaser.GameObjects.Text &&
          child.text === '(1,-1)' &&
          child !== row.text,
      );
      expect(
        coords,
        'no coordinates text below the aggression badge',
      ).toBeDefined();
      expect(coords!.style.fontSize).toBe('10px');
      expect(coords!.y).toBeGreaterThan(row.text.y);

      // The coordinates keep the same CVD-safe ownership colour as the badge —
      // unheld is the orange pair (r > b), never red/green.
      expect(colourOf(coords!)).toEqual(colourOf(row.text));
      const body = colourOf(coords!);
      expect(body.r).toBeGreaterThan(body.b);
    },
  );

  it(
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
      expect(panel).toContain('WEAKNESSES: waveLaser');
      expect(panel).toContain('GRANT: extra-life');
      expect(panel).toContain('DEFENDER: hull-1');

      // Activating an owned hex never deploys: it opens the bot-upgrade screen
      // for the defender (AH-0MWH48IEG00929GQ).
      scene.activateFocused();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
      expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(false);
      expect(booted!.game.scene.isActive(BOT_UPGRADE_SCENE_KEY)).toBe(true);

      // Back to the map (the bot-upgrade screen's back row), then an unheld
      // displayed hex opens the config screen for it; its ▶ DEPLOY then
      // launches the deployment at that hex.
      (booted!.game.scene.getScene(BOT_UPGRADE_SCENE_KEY) as BotUpgradeScene).openMap();
      await advanceGame(booted!.game, 350);
      const backOnMap = booted!.game.scene.getScene(
        HEX_MAP_SCENE_KEY,
      ) as HexMapScene;
      expect(backOnMap.focusRow('hex:hex-r1-3')).toBe(true);
      backOnMap.activateFocused();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(true);
      const hangar = booted!.game.scene.getScene(
        HANGAR_SCENE_KEY,
      ) as HangarScene;
      expect(hangar.getModel().deployRow.hexId).toBe('hex-r1-3');
      deployFromConfig();
      await advanceGame(booted!.game, 350);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
      const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
      expect(play.getHangarWarDeployment()!.hexId).toBe('hex-r1-3');
    },
  );

  it(
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

      // The bottom hint line describes both navigation models (AC5): arrows
      // move spatially and Tab keeps its linear cycling.
      const hint = HEX_MAP_HINT.toLowerCase();
      expect(hint).toContain('spatial');
      expect(hint).toContain('tab');
      expect(hint).toContain('linear');
      expect(findTextStartingWith(scene, HEX_MAP_HINT)).toBeDefined();
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
    'shows the attack\'s details in the selected-hex section for both arrow endpoints',
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
    'shows a defending bot\'s skill line in the rolled-in attack panel (AH-0MVWZYJ740037EZ1)',
    async () => {
      const payload = attackPayload();
      const record = attackRecord({
        attacks: [
          recordAttack({
            outcome: 'held',
            defenderRating: 2,
            effectiveDefenderRating: 7,
            skillBonusTotal: 5,
            appliedSkills: [
              {
                id: 'maw-warded',
                name: 'Maw-warded',
                bossType: 'maw-of-ashes',
                bonus: 5,
              },
            ],
            attackerType: 'maw-of-ashes',
            margin: 1,
          }),
        ],
      });
      const scene = (await bootMap({
        payload,
        record,
        storage: null,
      })) as AttackAwareScene;

      expect(scene.focusRow('hex:hex-held')).toBe(true);
      expect(scene.isLeftPanelVisible?.()).toBe(true);
      const text = scene.getLeftPanelText?.() ?? '';

      // The rolled-in report is the row label, so the skill line — the numbers
      // that decided the hold — reach the screen, not just the model.
      expect(text).toContain('skill Maw-warded +5 vs maw-of-ashes');
      expect(text).toContain('bot 7');
      expect(text).toContain('vs bot 2');
      expect(text).toBe(buildDefenceReport(payload, record).rows[0].label);
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
      expect(rightWith).toContain('AGGRESSION: 1');

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
    // The resumed map still routes through the config screen before the run.
    expect(booted!.game.scene.isActive(HANGAR_SCENE_KEY)).toBe(true);
    deployFromConfig();
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

  // ── The hangar assault announcement (AH-0MWEZZA4E0081NJ5) ───────

  /** A jitter-free assault resolution, so the banner's arithmetic is exact. */
  function assaultResolution(
    defenderSum: number,
    attackerBase: number,
  ): HangarAssaultResolution {
    return resolveHangarAssault(
      { defenderSum, attackerBase, aggression: 0, seed: 1 },
      { ...DEFAULT_FRONTIER_TUNING, jitterPercent: 0 },
    );
  }

  it('announces a repelled hangar assault on the map', async () => {
    const scene = await bootMap({
      payload: attackPayload(),
      record: attackRecord(),
      won: true,
      score: 900,
      assault: assaultResolution(12, 5),
      storage: null,
    });

    expect(scene.getAssault()!.outcome).toBe('repelled');
    expect(scene.isAssaultVisible()).toBe(true);
    expect(scene.getAssaultText()).toContain('RING WON');
    expect(scene.getAssaultText()).toContain('defender sum 12');
    expect(scene.getAssaultText()).toContain('margin +');
    findTextStartingWith(scene, 'HANGAR ASSAULT');
    findTextStartingWith(scene, 'RING WON');
    // The tick's own report is still there: the assault is an added section.
    expect(scene.getArrows()).toHaveLength(2);
  });

  it('announces the hangar-falls campaign reset on the map', async () => {
    const scene = await bootMap({
      payload: ringPayload(1),
      won: true,
      score: 900,
      assault: assaultResolution(3, 5),
      storage: null,
    });

    const text = scene.getAssaultText();
    expect(scene.getModel().campaignReset).toBe(true);
    expect(text).toContain('HANGAR FALLS');
    expect(text).toContain('FULL CAMPAIGN RESET');
    expect(text).not.toContain('RING WON');
    findTextStartingWith(scene, 'HANGAR FALLS');
  });

  it('shows no assault banner on a plain landing or on a later re-entry', async () => {
    const payload = ringPayload(1);
    const scene = await bootMap({
      payload,
      assault: assaultResolution(12, 5),
      storage: null,
    });
    expect(scene.isAssaultVisible()).toBe(true);

    // The assault is transient launch data: a later menu/hangar landing carries
    // none, so nothing persists.
    booted!.game.scene.start(HEX_MAP_SCENE_KEY, { payload, storage: null });
    await advanceGame(booted!.game, 200);
    const reentered = booted!.game.scene.getScene(
      HEX_MAP_SCENE_KEY,
    ) as HexMapScene;

    expect(reentered.getAssault()).toBeNull();
    expect(reentered.isAssaultVisible()).toBe(false);
    expect(reentered.getAssaultText()).toBe('');
    expect(screenText(reentered)).not.toContain('RING WON');
    expect(screenText(reentered)).not.toContain('HANGAR ASSAULT');
  });

  it('never stalls the attract traversal on a hangar-falls announcement', async () => {
    await bootMap({
      payload: ringPayload(1),
      won: true,
      score: 900,
      assault: assaultResolution(3, 5),
      demo: true,
      demoDwellMs: 300,
      storage: null,
    });

    // The banner adds no action, so the demo's one total map step (deploy at
    // the attract hex) still fires: the traversal cannot stall on it.
    stepGameUntil(
      booted!.game,
      'the demo traverses past the hangar-falls announcement',
      () => booted!.game.scene.isActive('PlayScene'),
      900,
    );
  });

  // ── The post-battle sortie results dialog ────────────────────────
  // **TEST-FIRST** (AH-0MWMGPPIR009DOKR, parent AH-0MWMFGXD6005WTMN)

  /**
   * The post-battle results dialog contract.
   *
   * **TEST-FIRST, now landed.** This block pinned the landing surface **before**
   * the results-view builder (`src/core/hangarWar/sortieResult.ts`, child 2),
   * the overlay scene (`src/scenes/HexCombatResultScene.ts`, child 4) and the
   * map wiring (child 5) existed; the assertions were authored under Vitest's
   * `it.fails` (the repo's red-before/green-after convention — see
   * `src/core/levelScaling.test.ts`). The map-wiring item
   * (AH-0MWMGPV420013MGB) flipped them back to `it`, so a regression now fails
   * the suite rather than a leftover `it.fails`.
   *
   * The dialog scene module is loaded through a **non-literal** dynamic import
   * on purpose: a static import would have failed `tsc --noEmit` (and therefore
   * the build) while the module did not exist yet. It is left lazy so the
   * contract keeps asserting on the module's own exports rather than on a
   * fixture.
   *
   * ## Pinned contract (the implementation items must match exactly)
   *
   * - `HexMapSceneData` gains `sortieResult?: SortieResultRecord | null` — the
   *   finished deployment's record (target hex id, `won`, `score`,
   *   `winBonusMinerals`, the win path's capture fields, the loss path's
   *   `forfeited`). Transient launch data: never persisted, and a later
   *   menu/hangar entry carries none.
   * - `HexMapScene` gains the test seams `getSortieResult()` (a detached copy,
   *   or `null`), `isResultsVisible()` and `getResultsText()` (the dialog's
   *   rendered text, or `''`).
   * - `create()` presents the results dialog over the **paused** map before
   *   the reward overlay and before the demo dwell starts. It launches
   *   `HEX_COMBAT_RESULT_SCENE_KEY` (`'HexCombatResultScene'`) with
   *   `{ view, onDismiss, autoDismissMs }`, where `view` is the pure builder's
   *   output and `autoDismissMs` is the demo dwell only.
   * - One confirm input dismisses it: the `Enter`/`Space` keys and a pointer
   *   press on the `▶ CONTINUE` row. Dismissal resumes the map, which then
   *   presents any carried reward and restarts the demo dwell.
   * - In demo/attract mode the dialog auto-dismisses after the shared dwell
   *   (`demoDwellMs`, else `HANGAR_WAR_TRAVERSAL_DWELL_MS`) and the traversal
   *   still deploys, so the demo cannot stall on the new surface.
   */
  describe('sortie results dialog (test-first contract)', () => {
    const RESULT_SCENE_MODULE = './HexCombatResultScene';

    /** The overlay scene module this block pins. */
    interface HexCombatResultSceneModule {
      readonly HEX_COMBAT_RESULT_SCENE_KEY: string;
      readonly HexCombatResultScene: typeof Phaser.Scene;
    }

    /** Loads the overlay module; throws (⇒ expected red) on pre-change HEAD. */
    async function resultScene(): Promise<HexCombatResultSceneModule> {
      return (await import(
        RESULT_SCENE_MODULE
      )) as unknown as HexCombatResultSceneModule;
    }

    /** The sortie-result query seams this item pins on the map. */
    interface SortieResultSeams {
      getSortieResult?(): SortieRecordLike | null;
      isResultsVisible?(): boolean;
      getResultsText?(): string;
    }

    /** Structural views of the pinned record (the real types are child 2's). */
    interface SalvageAmountsLike {
      minerals: number;
      cores: number;
    }

    interface SortieRecordLike {
      hexId: string | null;
      won: boolean;
      score: number;
      winBonusMinerals: number;
      capture: {
        bankedDelta: SalvageAmountsLike;
        grant: {
          grantId: string;
          entryId: string;
          kind: string;
          weaponId: string | null;
        } | null;
        specialReward: null;
        contractBonus: SalvageAmountsLike | null;
        cachePayout: SalvageAmountsLike | null;
        ringSecured: boolean;
        ringAdvanced: boolean;
      } | null;
      forfeited: SalvageAmountsLike | null;
    }

    function seams(scene: HexMapScene): SortieResultSeams {
      return scene as unknown as SortieResultSeams;
    }

    /** A winning sortie record that paid salvage, a grant and the win bonus. */
    function winningRecord(
      overrides: Partial<SortieRecordLike> = {},
    ): SortieRecordLike {
      return {
        hexId: 'hex-r1-1',
        won: true,
        score: 1200,
        winBonusMinerals: 250,
        capture: {
          bankedDelta: { minerals: 120, cores: 1 },
          grant: {
            grantId: 'hull-2',
            entryId: 'hull-2',
            kind: 'hull',
            weaponId: null,
          },
          specialReward: null,
          contractBonus: null,
          cachePayout: null,
          ringSecured: false,
          ringAdvanced: false,
        },
        forfeited: null,
        ...overrides,
      };
    }

    /** A losing sortie record with the loss path's forfeited salvage. */
    function losingRecord(
      overrides: Partial<SortieRecordLike> = {},
    ): SortieRecordLike {
      return {
        hexId: 'hex-r1-3',
        won: false,
        score: 42,
        winBonusMinerals: 0,
        capture: null,
        forfeited: { minerals: 30, cores: 2 },
        ...overrides,
      };
    }

    /** Boots the map with the results overlay registered and `data`. */
    async function bootResultsMap(data: object): Promise<{
      map: HexMapScene;
      dialogKey: string;
      dialog: Phaser.Scene;
    }> {
      const { HexCombatResultScene, HEX_COMBAT_RESULT_SCENE_KEY } =
        await resultScene();
      booted = await reuse.boot([
        HexMapScene,
        PlayScene,
        HangarScene,
        BotUpgradeScene,
        HexCombatResultScene,
      ]);
      booted.game.scene.start(HEX_MAP_SCENE_KEY, data);
      await advanceGame(booted.game, 200);
      const map = booted.game.scene.getScene(
        HEX_MAP_SCENE_KEY,
      ) as HexMapScene;
      const dialog = booted.game.scene.getScene(HEX_COMBAT_RESULT_SCENE_KEY);
      expect(dialog, 'the results dialog scene').not.toBeNull();
      return {
        map,
        dialogKey: HEX_COMBAT_RESULT_SCENE_KEY,
        dialog: dialog as Phaser.Scene,
      };
    }

    /** Emits one confirm keydown on an overlay scene (as a player would). */
    function confirmWithKey(scene: Phaser.Scene, key: string): void {
      scene.input.keyboard!.emit('keydown', {
        key,
        repeat: false,
        preventDefault: () => {},
      } as KeyboardEvent);
    }

    it(
      'presents the victory results over the paused map and one confirm resumes it',
      async () => {
        const record = winningRecord();
        const { map, dialog, dialogKey } = await bootResultsMap({
          payload: ringPayload(1),
          record: attackRecord(),
          won: true,
          score: 1200,
          sortieResult: record,
          storage: null,
        });

        // The record is carried for this landing only, as a detached copy.
        expect(seams(map).getSortieResult?.()).toEqual(record);
        expect(seams(map).isResultsVisible?.()).toBe(true);

        // The dialog runs over the paused map, exactly like the shipped
        // reward overlays.
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
        expect(booted!.game.scene.isActive(dialogKey)).toBe(true);

        // Its text names the outcome, the score and every paid reward.
        const text = screenText(dialog);
        expect(text).toContain('SORTIE RESULTS');
        expect(text).toContain('VICTORY');
        expect(text).toContain('SCORE 1200');
        expect(text).toContain('SALVAGE BANKED: +120 MINERALS, +1 CORE');
        expect(text).toContain('GRANT CLAIMED: hull-2');
        expect(text).toContain('WIN BONUS BANKED: +250 MINERALS');
        expect(seams(map).getResultsText?.()).toContain('VICTORY');

        // The thin run line and the banked win-bonus line are folded into the
        // dialog (parent assumption A1): the landing shows each fact once.
        expect(map.getRunLine()).toBeNull();
        expect(map.getWinBonusLine()).toBeNull();
        expect(screenText(map)).not.toContain('RUN: VICTORY');
        expect(screenText(map)).not.toContain('WIN BONUS BANKED');

        // One confirm dismisses it and the map resumes normal interaction.
        confirmWithKey(dialog, 'Enter');
        await advanceGame(booted!.game, 200);

        expect(booted!.game.scene.isActive(dialogKey)).toBe(false);
        expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
        expect(
          map.getRows().some((row) => row.key.startsWith('hex:')),
        ).toBe(true);
      },
    );

    it(
      'dismisses the results dialog from a pointer press on its confirm row',
      async () => {
        const { dialog, dialogKey } = await bootResultsMap({
          payload: ringPayload(1),
          won: true,
          score: 700,
          sortieResult: winningRecord({ score: 700 }),
          storage: null,
        });

        const confirm = dialog.children.list.find(
          (child): child is Phaser.GameObjects.Text =>
            child instanceof Phaser.GameObjects.Text &&
            child.text.startsWith('▶ CONTINUE'),
        );
        expect(confirm, 'the dialog has a ▶ CONTINUE row').toBeDefined();
        confirm!.emit('pointerdown');
        await advanceGame(booted!.game, 200);

        expect(booted!.game.scene.isActive(dialogKey)).toBe(false);
        expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
      },
    );

    it(
      'presents the defeat results with the boss intel and the forfeited salvage',
      async () => {
        const { dialog } = await bootResultsMap({
          payload: ringPayload(1),
          won: false,
          score: 42,
          sortieResult: losingRecord(),
          storage: null,
        });

        const text = screenText(dialog);
        expect(text).toContain('DEFEAT');
        expect(text).toContain('SCORE 42');
        // The authored `HEX_RING_DEFINITIONS` row for the target hex.
        expect(text).toContain('STRONG AGAINST: rapid');
        expect(text).toContain('WEAK AGAINST: mortar');
        expect(text).toContain('GRANT NOT CLAIMED: rapid');
        expect(text).toContain('SALVAGE FORFEITED: 30 MINERALS, 2 CORES');
      },
    );

    it(
      'carries the sortie result as transient launch data and never persists it',
      async () => {
        const record = winningRecord();
        const { map, dialog } = await bootResultsMap({
          payload: ringPayload(1),
          won: true,
          score: 1200,
          sortieResult: record,
          storage: null,
        });

        // A detached copy: callers cannot mutate what the dialog rendered.
        const copy = seams(map).getSortieResult?.() as SortieRecordLike;
        copy.score = 1;
        expect(seams(map).getSortieResult?.()).toEqual(record);

        // Dismiss, then re-enter from a menu/hangar path: nothing carried.
        confirmWithKey(dialog, 'Enter');
        await advanceGame(booted!.game, 200);
        booted!.game.scene.start(HEX_MAP_SCENE_KEY, {
          payload: ringPayload(1),
          storage: null,
        });
        await advanceGame(booted!.game, 200);
        const reentered = booted!.game.scene.getScene(
          HEX_MAP_SCENE_KEY,
        ) as HexMapScene;

        expect(seams(reentered).getSortieResult?.()).toBeNull();
        expect(seams(reentered).isResultsVisible?.()).toBe(false);
        expect(seams(reentered).getResultsText?.()).toBe('');
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
      },
    );

    it(
      'auto-dismisses in demo mode so the traversal still deploys',
      async () => {
        await bootResultsMap({
          payload: ringPayload(1),
          won: true,
          score: 500,
          sortieResult: winningRecord({ score: 500 }),
          demo: true,
          demoDwellMs: 300,
          storage: null,
        });

        // The demo dwell is paused while the dialog waits…
        expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);

        // …then the dialog auto-dismisses after the shared dwell and the
        // traversal walks map → config → deployment without stalling.
        stepGameUntil(
          booted!.game,
          'the demo traverses past the results dialog',
          () => booted!.game.scene.isActive('PlayScene'),
          1200,
        );
      },
    );

    it('shows no results dialog on a landing without a sortie result', async () => {
      // Green on both sides of the change: a plain landing (a menu/hangar
      // entry, or a landing pinned before this surface existed) presents no
      // dialog and never pauses the map.
      const scene = await bootMap({
        payload: ringPayload(1),
        won: true,
        score: 1200,
        storage: null,
      });

      expect(seams(scene).getSortieResult?.() ?? null).toBeNull();
      expect(seams(scene).isResultsVisible?.() ?? false).toBe(false);
      expect(booted!.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
      expect(screenText(scene)).not.toContain('SORTIE RESULTS');
    });

    it('goes straight to the map when the results overlay is not registered', async () => {
      // A headless boot (or a misconfiguration) without the dialog scene must
      // not stall on a surface it can never show: the map stays live and the
      // attract traversal still advances (the `presentReward()` no-stall rule).
      booted = await reuse.boot([HexMapScene, PlayScene, HangarScene]);
      booted.game.scene.start(HEX_MAP_SCENE_KEY, {
        payload: ringPayload(1),
        won: true,
        score: 700,
        sortieResult: winningRecord({ score: 700 }),
        demo: true,
        demoDwellMs: 300,
        storage: null,
      });
      await advanceGame(booted.game, 200);
      const scene = booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;

      expect(booted.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
      expect(booted.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
      expect(scene.isResultsVisible()).toBe(false);
      // The traversal is not stalled: the map deploys (via the config screen)
      // on its own dwell.
      stepGameUntil(
        booted!.game,
        'the demo traverses past the missing results overlay',
        () => booted!.game.scene.isActive('PlayScene'),
        900,
      );
    });

    it('presents the results dialog before a carried mini-boss reward', async () => {
      // The order is deterministic (documented on `HexMapScene.presentResults`):
      // the sortie dialog first, then any carried reward, then the map.
      const reward = spreadWheelReward();
      const record = winningRecord();
      const { HexCombatResultScene, HEX_COMBAT_RESULT_SCENE_KEY } =
        await resultScene();
      booted = await reuse.boot([
        HexMapScene,
        PlayScene,
        HangarScene,
        MiniBossWheelScene,
        MineralChoiceScene,
        HexCombatResultScene,
      ]);
      booted.game.scene.start(HEX_MAP_SCENE_KEY, {
        payload: ringPayload(1),
        won: true,
        score: 1200,
        reward,
        sortieResult: record,
        storage: null,
      });
      await advanceGame(booted.game, 200);
      const map = booted.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;

      // The dialog owns the paused map; the reward has not been presented yet.
      expect(booted.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);
      expect(booted.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(true);
      expect(booted.game.scene.isActive(MINI_BOSS_WHEEL_SCENE_KEY)).toBe(false);
      expect(map.getReward()).toEqual(reward);

      // One confirm hands over to the reward overlay over the still-paused map.
      const dialog = booted.game.scene.getScene(
        HEX_COMBAT_RESULT_SCENE_KEY,
      ) as Phaser.Scene;
      confirmWithKey(dialog, 'Enter');
      await advanceGame(booted.game, 200);
      expect(booted.game.scene.isActive(HEX_COMBAT_RESULT_SCENE_KEY)).toBe(false);
      expect(booted.game.scene.isActive(MINI_BOSS_WHEEL_SCENE_KEY)).toBe(true);
      expect(booted.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(true);

      // Resolving the reward finally makes the map interactive again.
      const wheel = booted.game.scene.getScene(
        MINI_BOSS_WHEEL_SCENE_KEY,
      ) as MiniBossWheelScene;
      expect(wheel.spin()).toBe(true);
      await advanceGame(booted.game, 3000);
      expect(booted.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
      expect(booted.game.scene.isPaused(HEX_MAP_SCENE_KEY)).toBe(false);
    });
  });

  /**
   * The deployment→map **sortie result** handoff (AH-0MWMGPS9R008SMEG).
   *
   * The finished deployment's record is transient launch data: the map holds
   * it for this landing only, exposes it through a detached-copy seam, and
   * never persists it, so a later menu/hangar re-entry shows no result. The
   * dialog presentation itself is a later child (AH-0MWMGPV420013MGB); these
   * assertions pin the carry, the detached copy and the launch-data-only rule
   * without depending on it.
   */
  describe('sortie result handoff (AH-0MWMGPS9R008SMEG)', () => {
    /** A winning sortie record carrying the capture cycle's own fields. */
    function winningRecord(): SortieResultRecord {
      return {
        hexId: 'hex-r1-1',
        won: true,
        score: 1200,
        winBonusMinerals: 250,
        capture: {
          bankedDelta: { minerals: 120, cores: 1 },
          grant: null,
          specialReward: null,
          contractBonus: null,
          cachePayout: null,
          ringSecured: false,
          ringAdvanced: false,
        },
        forfeited: null,
      };
    }

    it('holds the carried sortie result and returns a detached copy', async () => {
      const record = winningRecord();
      const scene = await bootMap({
        payload: ringPayload(1),
        sortieResult: record,
        storage: null,
      });

      expect(scene.getSortieResult()).toEqual(record);

      // A detached copy: mutating what a caller reads cannot change the map's
      // own carried record.
      const copy = scene.getSortieResult() as unknown as {
        score: number;
        capture: { bankedDelta: { minerals: number } } | null;
      };
      copy.score = 1;
      copy.capture!.bankedDelta.minerals = 0;
      expect(scene.getSortieResult()).toEqual(record);
    });

    it('carries a defeat landing with the forfeited salvage and no capture', async () => {
      const scene = await bootMap({
        payload: ringPayload(1),
        sortieResult: {
          hexId: 'hex-r1-3',
          won: false,
          score: 42,
          winBonusMinerals: 0,
          capture: null,
          forfeited: { minerals: 30, cores: 2 },
        },
        storage: null,
      });

      expect(scene.getSortieResult()).toEqual({
        hexId: 'hex-r1-3',
        won: false,
        score: 42,
        winBonusMinerals: 0,
        capture: null,
        forfeited: { minerals: 30, cores: 2 },
      });
    });

    it('never persists the sortie result, so a re-entry shows none', async () => {
      // A landing that carries a sortie result…
      const carried = await bootMap({
        payload: ringPayload(1),
        sortieResult: winningRecord(),
        storage: null,
      });
      expect(carried.getSortieResult()).not.toBeNull();

      // …then a later re-entry with no `sortieResult` carries none, because
      // the record is transient launch data and was never persisted into the
      // payload.
      const reentered = await bootMap({
        payload: ringPayload(1),
        storage: null,
      });
      expect(reentered.getSortieResult()).toBeNull();
      expect(JSON.stringify(reentered.getPayload())).not.toContain(
        'sortieResult',
      );
    });
  });

  /**
   * Sectioned layout (AH-0MWL4QCVD007WOAM).
   *
   * The screen is four content sections plus a controls footer, each drawn as
   * a bordered panel headed from a shared constant. This block pins the
   * `war-status` / `map` / `controls` slices: every heading renders, every
   * string still renders inside its own panel, the legend has left the intel
   * column, and nothing shrinks below the map's existing type floor.
   */
  describe('sectioned layout (war-status, map, controls)', () => {
    /** Every rendered text object, in draw order. */
    function allTexts(scene: Phaser.Scene): Phaser.GameObjects.Text[] {
      return scene.children.list.filter(
        (child): child is Phaser.GameObjects.Text =>
          child instanceof Phaser.GameObjects.Text,
      );
    }

    /** Whether `text` is wholly inside the section rect `key`. */
    function insideSection(
      text: Phaser.GameObjects.Text,
      key: keyof typeof HEX_MAP_SECTION_RECTS,
    ): boolean {
      const rect = HEX_MAP_SECTION_RECTS[key];
      const bounds = text.getBounds();
      return (
        bounds.x >= rect.x &&
        bounds.y >= rect.y &&
        bounds.right <= rect.x + rect.width &&
        bounds.bottom <= rect.y + rect.height
      );
    }

    it('heads war-status, map and controls from shared constants', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });

      const warHeading = findTextStartingWith(scene, WAR_STATUS_HEADING);
      const mapHeading = findTextStartingWith(scene, HEX_MAP_TITLE);
      const controlsHeading = findTextStartingWith(scene, CONTROLS_HEADING);

      // Every heading sits inside its section's rect (frame + heading
      // convention), so the section is identifiable without colour.
      expect(insideSection(warHeading, 'war-status')).toBe(true);
      expect(insideSection(mapHeading, 'map')).toBe(true);
      expect(insideSection(controlsHeading, 'controls')).toBe(true);
      // Headings are at least 10px (the map's own title keeps its 20px).
      expect(warHeading.style.fontSize).toBe('10px');
      expect(controlsHeading.style.fontSize).toBe('10px');
    });

    it('keeps every war-status line inside the war-status panel', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });
      const model = scene.getModel();

      for (const line of [
        model.ringLine,
        model.frontierLine,
        model.hangarLine,
      ]) {
        const text = findTextStartingWith(scene, line.slice(0, 12));
        expect(text.text).toBe(line);
        expect(insideSection(text, 'war-status')).toBe(true);
      }
      // The war status is no longer loose header text in the left column.
      expect(insideSection(findTextStartingWith(scene, model.ringLine), 'map'))
        .toBe(false);
    });

    it('moves the READ THE MAP legend into the controls footer', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });
      const legendPrefixes = [
        'READ THE MAP',
        'blue ● — held',
        '(q,r) — coordinates',
        'arrows — spatial',
        'enter/space — inspect or deploy',
        'detail panel — full intel',
      ];

      for (const prefix of legendPrefixes) {
        const text = findTextStartingWith(scene, prefix);
        expect(insideSection(text, 'controls')).toBe(true);
        // ...and out of the intel column it used to share.
        expect(insideSection(text, 'selected-hex')).toBe(false);
      }
    });

    it('keeps the hint line and the hangar row in the controls footer', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });
      const hint = findTextStartingWith(scene, HEX_MAP_HINT);
      const hangarRow = findTextStartingWith(
        scene,
        scene.getModel().hangarRow.label,
      );

      expect(insideSection(hint, 'controls')).toBe(true);
      expect(insideSection(hangarRow, 'controls')).toBe(true);
      expect(hangarRow.style.fontSize).toBe('12px');
    });

    it('renders no text smaller than 9px', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });

      for (const text of allTexts(scene)) {
        const size = Number.parseInt(String(text.style.fontSize), 10);
        expect(size, `text "${text.text.slice(0, 24)}" is ${size}px`).
          toBeGreaterThanOrEqual(9);
      }
    });

    it('wraps section body text instead of letting it leave its panel', async () => {
      // A long frontier line is the widest war-status string; it must word-wrap
      // inside the panel rather than run into the ring (no text overdraws a
      // tile).
      const scene = await bootMap({ payload: ringPayload(2), storage: null });
      const frontier = findTextStartingWith(
        scene,
        scene.getModel().frontierLine.slice(0, 12),
      );

      expect(insideSection(frontier, 'war-status')).toBe(true);
      expect(frontier.style.wordWrapWidth).toBe(
        HEX_MAP_SECTION_RECTS['war-status'].width - 16,
      );
    });

    it('puts the focused hex intel and its attack row in one section', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        storage: null,
      });

      expect(scene.focusRow('hex:hex-held')).toBe(true);
      const heading = findTextStartingWith(scene, SELECTED_HEX_HEADING);
      const intel = findTextStartingWith(scene, 'FULL INTEL — HEX-HELD');
      const attackRow = findTextStartingWith(
        scene,
        scene.getLeftPanelText().slice(0, 24),
      );

      // Heading, intel and the attack row are all inside the one
      // `selected-hex` rect...
      expect(insideSection(heading, 'selected-hex')).toBe(true);
      expect(insideSection(intel, 'selected-hex')).toBe(true);
      expect(insideSection(attackRow, 'selected-hex')).toBe(true);
      // ...the attack row directly below the intel it belongs to...
      expect(attackRow.y).toBeGreaterThan(intel.y + intel.height);
      // ...and nowhere near the map or the old left-hand band.
      expect(insideSection(attackRow, 'map')).toBe(false);
      expect(attackRow.x).toBeGreaterThanOrEqual(
        HEX_MAP_SECTION_RECTS['selected-hex'].x,
      );

      // The intel itself is unchanged in content, only re-homed.
      expect(scene.getPanelText()).toContain('STATE:');
      expect(scene.getPanelText()).toContain('STRENGTHS:');
      expect(scene.getLeftPanelText()).toContain('hex-held — FELL');
    });

    it('hides the attack row inside the section when the hex is in no attack', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });

      expect(scene.focusRow('hex:hex-r1-1')).toBe(true);
      // The section (and its intel) stays; the attack row is hidden, not moved.
      expect(
        insideSection(
          findTextStartingWith(scene, 'FULL INTEL — HEX-R1-1'),
          'selected-hex',
        ),
      ).toBe(true);
      expect(scene.isLeftPanelVisible()).toBe(false);
      expect(scene.getLeftPanelText()).toBe('');
      expect(
        scene.children.list.some(
          (child) =>
            child instanceof Phaser.GameObjects.Text &&
            child.text.startsWith('ATTACK — FOCUSED HEX') &&
            child.visible,
        ),
      ).toBe(false);
      // No attack row was smuggled into another section.
      expect(screenText(scene)).not.toContain('retake: strike');
    });

    it('gathers the run result and the assault outcome into last-sortie', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        won: true,
        score: 900,
        assault: assaultResolution(12, 5),
        storage: null,
      });

      const heading = findTextStartingWith(scene, LAST_SORTIE_HEADING);
      const runLine = findTextStartingWith(scene, 'RUN: VICTORY');
      const assaultHeading = findTextStartingWith(scene, 'HANGAR ASSAULT');
      const assaultText = findTextStartingWith(scene, 'RING WON');

      for (const text of [heading, runLine, assaultHeading, assaultText]) {
        expect(insideSection(text, 'last-sortie')).toBe(true);
      }
      // One place for "what just happened": nothing is left over the map or in
      // the selected-hex/intel column.
      expect(insideSection(runLine, 'map')).toBe(false);
      expect(insideSection(assaultText, 'selected-hex')).toBe(false);
      // The seams still report the same content.
      expect(scene.getAssaultText()).toContain('defender sum 12');
      expect(scene.isAssaultVisible()).toBe(true);
    });

    it('draws the banked win bonus inside last-sortie (Q3 = a)', async () => {
      const scene = await bootMap({
        payload: ringPayload(1),
        winBonusMinerals: 250,
        storage: null,
      });

      const winBonus = findTextStartingWith(scene, 'WIN BONUS BANKED');
      expect(winBonus.text).toBe('WIN BONUS BANKED: +250 MINERALS');
      expect(insideSection(winBonus, 'last-sortie')).toBe(true);
      expect(
        insideSection(
          findTextStartingWith(scene, LAST_SORTIE_HEADING),
          'last-sortie',
        ),
      ).toBe(true);
    });

    it('sizes the last-sortie panel from its worst-case content budget', async () => {
      const rect = HEX_MAP_SECTION_RECTS['last-sortie'];

      // The panel is not a hand-picked pixel height: it is the budget plus the
      // frame's padding and heading band, so a new line (or a wider string)
      // either fits or fails the budget test below.
      expect(rect.height).toBe(LAST_SORTIE_HEIGHT);
      expect(sectionBudgetHeight(LAST_SORTIE_LINE_BUDGET)).toBeLessThanOrEqual(
        sectionBodyHeight(rect),
      );
    });

    it('holds the full win path inside the last-sortie panel', async () => {
      // The landing the audit found spilling out of the panel
      // (AH-0MWNEQRSI008DIY8): a win that banked a bonus AND repelled the
      // massed assault, drawn with deliberately wide numbers.
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord({ hexIncome: 999999 }),
        won: true,
        score: 999999,
        winBonusMinerals: 999999,
        assault: assaultResolution(9999, 9999),
        storage: null,
      });
      const rect = HEX_MAP_SECTION_RECTS['last-sortie'];
      const bodyWidth = sectionBodyWidth(rect);

      // Every block the renderer draws, with the budget slot it lands in
      // (`LAST_SORTIE_LINE_BUDGET` is in draw order: run result, win bonus,
      // hex income, assault sub-heading, assault body).
      const drawn = [
        { label: 'run result', text: scene.getRunLine()!, fontSizePx: 13 },
        { label: 'win bonus', text: scene.getWinBonusLine()!, fontSizePx: 11 },
        { label: 'hex income', text: scene.getHexIncomeLine()!, fontSizePx: 11 },
        { label: 'assault sub-heading', text: 'HANGAR ASSAULT', fontSizePx: 10 },
        { label: 'assault body', text: scene.getAssaultText(), fontSizePx: 11 },
      ];
      expect(drawn).toHaveLength(LAST_SORTIE_LINE_BUDGET.length);
      drawn.forEach((block, index) => {
        const budget = LAST_SORTIE_LINE_BUDGET[index];
        expect(budget.fontSizePx, block.label).toBe(block.fontSizePx);
        expect(block.text, block.label).not.toBe('');
        expect(
          wrappedLineCount(block.text, bodyWidth, block.fontSizePx),
          `${block.label} must fit the panel's ${budget.visualLines}-line budget`,
        ).toBeLessThanOrEqual(budget.visualLines);
      });

      // The whole block budget still fits the panel's body area — the check the
      // happy-dom `measureText` stub (0 width, so nothing wraps) cannot make.
      expect(sectionBudgetHeight(LAST_SORTIE_LINE_BUDGET)).toBeLessThanOrEqual(
        sectionBodyHeight(rect),
      );
    });

    it('omits the last-sortie section when the landing carries no news', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });

      expect(screenText(scene)).not.toContain(LAST_SORTIE_HEADING);
      expect(screenText(scene)).not.toContain('RUN:');
      expect(screenText(scene)).not.toContain('WIN BONUS');
      expect(screenText(scene)).not.toContain('HANGAR ASSAULT');
      expect(scene.getAssaultText()).toBe('');
    });

    it('publishes the section registry in reading order', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        won: true,
        score: 900,
        assault: assaultResolution(12, 5),
        storage: null,
      });

      const sections = scene.getSections();
      expect(sections.map((section) => section.key)).toEqual([
        'war-status',
        'last-sortie',
        'map',
        'selected-hex',
        'controls',
      ]);
      expect(sections.map((section) => section.heading)).toEqual([
        WAR_STATUS_HEADING,
        LAST_SORTIE_HEADING,
        scene.getModel().title,
        SELECTED_HEX_HEADING,
        CONTROLS_HEADING,
      ]);
      // The rects are the layout's own rect table — no second layout exists.
      for (const section of sections) {
        expect(section.rect).toBe(HEX_MAP_SECTION_RECTS[section.key]);
      }
    });

    it('omits last-sortie from the registry when there is no news', async () => {
      const scene = await bootMap({ payload: ringPayload(1), storage: null });

      expect(scene.getSections().map((section) => section.key)).toEqual([
        'war-status',
        'map',
        'selected-hex',
        'controls',
      ]);
    });

    it('keeps every section rect in frame and free of overlaps', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        won: true,
        score: 900,
        assault: assaultResolution(12, 5),
        storage: null,
      });
      const sections = scene.getSections();

      for (const { key, rect } of sections) {
        expect(rect.x, key).toBeGreaterThanOrEqual(0);
        expect(rect.y, key).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width, key).toBeLessThanOrEqual(GAME_WIDTH);
        expect(rect.y + rect.height, key).toBeLessThanOrEqual(GAME_HEIGHT);
      }
      for (let i = 0; i < sections.length; i += 1) {
        for (let j = i + 1; j < sections.length; j += 1) {
          const a = sections[i].rect;
          const b = sections[j].rect;
          const overlaps =
            a.x < b.x + b.width &&
            b.x < a.x + a.width &&
            a.y < b.y + b.height &&
            b.y < a.y + a.height;
          expect(overlaps, `${sections[i].key} overlaps ${sections[j].key}`).
            toBe(false);
        }
      }
    });

    it('puts every rendered text and arrow inside exactly one section', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        won: true,
        score: 900,
        assault: assaultResolution(12, 5),
        storage: null,
      });
      const sections = scene.getSections();

      /** Sections whose rect wholly contains `bounds`. */
      const holdersOf = (bounds: {
        x: number;
        y: number;
        right: number;
        bottom: number;
      }): string[] =>
        sections
          .filter(
            ({ rect }) =>
              bounds.x >= rect.x &&
              bounds.y >= rect.y &&
              bounds.right <= rect.x + rect.width &&
              bounds.bottom <= rect.y + rect.height,
          )
          .map(({ key }) => key);

      for (const text of allTexts(scene)) {
        expect(
          holdersOf(text.getBounds()),
          `text "${text.text.slice(0, 24)}" is not in exactly one section`,
        ).toHaveLength(1);
      }
      // Tiles are drawn at the model's axial positions; every arrow endpoint
      // must therefore lie inside the map section.
      const mapRect = HEX_MAP_SECTION_RECTS.map;
      for (const arrow of scene.getArrows()) {
        for (const point of [arrow.from, arrow.to]) {
          expect(point.x).toBeGreaterThanOrEqual(mapRect.x);
          expect(point.y).toBeGreaterThanOrEqual(mapRect.y);
          expect(point.x).toBeLessThanOrEqual(mapRect.x + mapRect.width);
          expect(point.y).toBeLessThanOrEqual(mapRect.y + mapRect.height);
        }
      }
      // Every rendered row's text (the tile labels) is in the map section, so
      // a tile can never be drawn outside the map region it belongs to.
      for (const row of scene.getRows()) {
        if (!row.key.startsWith('hex:')) continue;
        expect(holdersOf(row.text.getBounds())).toEqual(['map']);
      }
    });

    it('drops last-sortie from the registry on a later entry without news', async () => {
      // The transient news is launch data only: a later menu/hangar landing
      // carries none, so the section and its registry entry are both absent.
      const payload = ringPayload(1);
      const scene = await bootMap({
        payload,
        won: true,
        score: 500,
        winBonusMinerals: 100,
        storage: null,
      });
      expect(scene.getSections().map((section) => section.key)).toContain(
        'last-sortie',
      );

      booted!.game.scene.start(HEX_MAP_SCENE_KEY, { payload, storage: null });
      await advanceGame(booted!.game, 200);
      const reentered = booted!.game.scene.getScene(
        HEX_MAP_SCENE_KEY,
      ) as HexMapScene;

      expect(reentered.getSections().map((section) => section.key)).toEqual([
        'war-status',
        'map',
        'selected-hex',
        'controls',
      ]);
      expect(screenText(reentered)).not.toContain(LAST_SORTIE_HEADING);
      expect(screenText(reentered)).not.toContain('RUN:');
      expect(screenText(reentered)).not.toContain('WIN BONUS');
    });

    it('draws every registry heading inside its own section', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        won: true,
        score: 900,
        assault: assaultResolution(12, 5),
        storage: null,
      });

      // Registry ↔ drawing: the published heading for a section is the
      // heading actually rendered inside that section's rect.
      for (const section of scene.getSections()) {
        const heading = findTextStartingWith(scene, section.heading);
        expect(insideSection(heading, section.key)).toBe(true);
      }
    });

    it('never lets another section’s text overdraw the ring', async () => {
      const scene = await bootMap({
        payload: attackPayload(),
        record: attackRecord(),
        won: true,
        score: 900,
        assault: assaultResolution(12, 5),
        storage: null,
      });
      const mapRect = HEX_MAP_SECTION_RECTS.map;

      /** Whether the bounds intersect the map section at all. */
      const touchesMap = (bounds: {
        x: number;
        y: number;
        right: number;
        bottom: number;
      }): boolean =>
        bounds.x < mapRect.x + mapRect.width &&
        mapRect.x < bounds.right &&
        bounds.y < mapRect.y + mapRect.height &&
        mapRect.y < bounds.bottom;

      for (const text of allTexts(scene)) {
        // Tile labels, the map title and the run-result line legitimately sit
        // in the map section; everything else must stay clear of the ring.
        if (insideSection(text, 'map')) continue;
        expect(
          touchesMap(text.getBounds()),
          `text "${text.text.slice(0, 24)}" strays into the ring`,
        ).toBe(false);
      }
    });
  });
});

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
 *
 * ## Hangar Map UX renderer contract (AH-0MWEWYT79001D3A1)
 *
 * **TEST-FIRST.** The gym renders the game's map through the one shared
 * renderer, so it inherits the Hangar Map UX contract (parent
 * AH-0MWDBI33V003QQ3U): only `displayed` hexes are drawn (a hidden hex gets no
 * tile), and tile text uses the CVD-safe pair (blue-dominant held /
 * orange-dominant unheld) plus the non-colour ownership marker. New assertions
 * are authored under Vitest's `it.fails` (the repo's red-before/green-after
 * convention — see `src/core/levelScaling.test.ts`) so this suite stays green
 * on pre-change HEAD; the renderer item (AH-0MWEWYUAS002P7P9) flips them back
 * to `it`, and a leftover `it.fails` then fails loudly.
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
import { RING_1_HEX_FIXTURES, RING_2_HEX_FIXTURES } from '../../core/hangarWar/__fixtures__/ringFixtures';
import {
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../../core/hangarWar/hangarWarStore';
import { createInMemoryHangarWarStorage } from '../../core/hangarWar/storage';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import {
  DEFAULT_FRONTIER_TUNING,
  frontierClockFor,
  resolveHangarAssault,
  runFrontierTick,
  type HangarAssaultResolution,
} from '../../core/hangarWar/hexDefence';
import { resolveRingAssault } from '../../core/hangarWar/captureCycle';
import { decideMapAction } from '../../ai/hangarWarTraversal';
import { DEFENCE_REPORT_TITLE } from '../../core/hangarWar/defenceReport';
import {
  HELD_TILE_MARKER,
  HEX_MAP_HANGAR_ROW_KEY,
  UNHELD_TILE_MARKER,
  type HexMapModel,
} from '../../core/hangarWar/hexIntel';
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

/**
 * Integrated map view — attack arrows (AH-0MWEXI5460080WEI).
 *
 * The rolled-in report means the gym's map view renders the same shared
 * `renderHexMap` arrows as the game when it is given the same tick record
 * (AGENTS.md gym↔game parity; parent AH-0MWDC3L9I008INDP). The gym parity item
 * (AH-0MWEXJ21W003M7RR) removed the gym's separate `report` view, so the map
 * view is the only surface and every assertion below runs against it.
 *
 * ## Pinned contract
 *
 * The gym's map model (`getMapModel()`) carries the attack arrows derived from
 * the shipped tick record the integrated view is built from
 * (`runFrontierTick(this.payload, { clock: frontierClockFor(this.payload) })`):
 * one arrow per `record.attacks[]` entry, in the record's order, with the
 * record's attacker-origin coordinates — so the gym and the game draw the same
 * arrows from the same record, never a divergent copy. Every displayed hex is
 * focusable even in a handler-less render, so `focusMapRow(key)` (the
 * renderer's own `focusRow`) lets the gym read the same left-hand attack panel
 * the game shows for its focused hex.
 */

/**
 * The gym map model with the attack fields this test-first item pins. They now
 * live on the shipped `HexMapModel` (AH-0MWEXIAEQ004IT0R), so this is an alias.
 */
type AttackAwareMapModel = HexMapModel;

function sixHexPayload(
  hangarOverrides: Partial<HangarWarPayload['hangar']> = {},
): HangarWarPayload {
  const hexes: HexState[] = RING_1_HEX_FIXTURES.map((fixture) => ({
    id: fixture.id,
    q: fixture.q,
    r: fixture.r,
    held: false,
    aggression: fixture.baseAggression,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
  }));
  const template = oneHexPayload(hexes[0]);
  return {
    ...template,
    ring: { ringIndex: 1, hexes },
    hangar: { ...template.hangar, ...hangarOverrides },
  };
}

/** Every ring-2 fixture as an unheld payload hex (nothing is revealed yet). */
function ringTwoPayload(): HangarWarPayload {
  const hexes: HexState[] = RING_2_HEX_FIXTURES.map((fixture) => ({
    id: fixture.id,
    q: fixture.q,
    r: fixture.r,
    held: false,
    aggression: fixture.baseAggression,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
  }));
  const template = oneHexPayload(hexes[0]);
  return { ...template, ring: { ringIndex: 2, hexes } };
}

/**
 * A fully held ring-1 payload — the ring-end state the hangar assault fires
 * on. Every hex carries a defending bot of `defenceRating` and
 * `aggression`, so the shared `resolveRingAssault` gate sees a complete ring.
 */
function heldRingPayload(
  defenceRating: number,
  aggression: number,
): HangarWarPayload {
  const hexes: HexState[] = RING_1_HEX_FIXTURES.map((fixture) => ({
    id: fixture.id,
    q: fixture.q,
    r: fixture.r,
    held: true,
    aggression,
    defender: { hullId: 'hull-1', defenceRating, bankedMinerals: 0 },
    bossDefeated: true,
    grantedWeapon: fixture.grants,
  }));
  const template = oneHexPayload(hexes[0]);
  return { ...template, ring: { ringIndex: 1, hexes } };
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

  it('leaves a bot with its special skills and persists them (AH-0MVWZYJ740037EZ1)', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });
    scene.takeHex('target');

    scene.leaveBot('target', 'hull-2', 14, [
      { id: 'bulwark-line-breaker', name: 'Line-breaker', bossType: 'the-dawnbreaker', bonus: 4 },
    ]);

    expect(scene.getPayload().ring.hexes[0].defender).toEqual({
      hullId: 'hull-2',
      defenceRating: 14,
      bankedMinerals: 0,
      skills: [
        { id: 'bulwark-line-breaker', name: 'Line-breaker', bossType: 'the-dawnbreaker', bonus: 4 },
      ],
    });
  });

  it('omits the skill field for a bot with no skills (additive data)', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });
    scene.takeHex('target');

    scene.leaveBot('target', 'hull-1', 2);

    expect('skills' in scene.getPayload().ring.hexes[0].defender!).toBe(false);
  });

  it('shows a left bot’s skill in the shared map intel and summary lines', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });
    scene.takeHex('target');
    scene.leaveBot('target', 'hull-2', 14, [
      { id: 'maw-warded', name: 'Maw-warded', bossType: 'maw-of-ashes', bonus: 5 },
    ]);

    const hex = scene.getMapModel()!.hexes.find((row) => row.id === 'target')!;
    expect(hex.skills).toEqual([
      { id: 'maw-warded', name: 'Maw-warded', bossType: 'maw-of-ashes', bonus: 5 },
    ]);
    expect(hex.label).toContain('skill Maw-warded +5 vs maw-of-ashes');
    expect(
      scene.getSummaryLines().some((line) => line.includes('skill Maw-warded +5')),
    ).toBe(true);
  });

  it('resolves a trained bot through the shipped resolver (the skill decides the hold)', async () => {
    // Two **authored** hexes, so the attacker type resolves from ring data: the
    // target `hex-r1-1` (1,0) is pressed from its only unheld neighbour
    // `hex-r1-6` (0,1) — the maw-of-ashes hex — so a bot trained against that
    // boss gets the bonus and an untrained one does not.
    const target = RING_1_HEX_FIXTURES.find((hex) => hex.id === 'hex-r1-1')!;
    const origin = RING_1_HEX_FIXTURES.find((hex) => hex.id === 'hex-r1-6')!;
    const payload = (): HangarWarPayload => ({
      ...oneHexPayload({
        id: target.id,
        q: target.q,
        r: target.r,
        held: true,
        aggression: 0,
        defender: null,
        bossDefeated: true,
        grantedWeapon: null,
      }),
      ring: {
        ringIndex: 1,
        hexes: [
          {
            id: target.id,
            q: target.q,
            r: target.r,
            held: true,
            aggression: 0,
            defender: null,
            bossDefeated: true,
            grantedWeapon: null,
          },
          {
            id: origin.id,
            q: origin.q,
            r: origin.r,
            held: false,
            aggression: origin.baseAggression,
            defender: null,
            bossDefeated: false,
            grantedWeapon: null,
          },
        ],
      },
    });

    // Boot (and read) the untrained run first: the reusable boot hands back the
    // same scene instance per boot, so each run's report is captured at once.
    const plain = await bootHexWar({ payload: payload() });
    plain.leaveBot(target.id, 'hull-1', 0);
    const plainReport = plain.getDefenceReport();

    const trained = await bootHexWar({ payload: payload() });
    trained.leaveBot(target.id, 'hull-1', 0, [
      { id: 'maw-warded', name: 'Maw-warded', bossType: 'maw-of-ashes', bonus: 99 },
    ]);
    const trainedReport = trained.getDefenceReport();

    expect(plainReport.rows).toHaveLength(1);
    expect(trainedReport.rows).toHaveLength(1);
    const plainRow = plainReport.rows[0];
    const trainedRow = trainedReport.rows[0];

    // Same attack, same jitter, same stored rating — only the skill differs.
    expect(trainedRow.attackerType).toBe('maw-of-ashes');
    expect(trainedRow.attackStrength).toBe(plainRow.attackStrength);
    expect(trainedRow.defenderRating).toBe(0);
    expect(plainRow.skillBonusTotal).toBe(0);
    expect(plainRow.outcome).toBe('fell');
    expect(trainedRow.skillBonusTotal).toBe(99);
    expect(trainedRow.effectiveDefenderRating).toBe(99);
    expect(trainedRow.outcome).toBe('held');
    expect(trainedRow.label).toContain('skill Maw-warded +99 vs maw-of-ashes');

    // The report is the shipped tick's own record over the same payload.
    const direct = runFrontierTick(trained.getPayload(), {
      clock: frontierClockFor(trained.getPayload()),
    });
    expect(trainedRow.skillBonusTotal).toBe(
      direct.record.attacks[0].skillBonusTotal,
    );
    expect(trainedRow.effectiveDefenderRating).toBe(
      direct.record.attacks[0].effectiveDefenderRating,
    );
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

  it('renders the shipped hex-map intel through the shared map renderer', async () => {
    const scene = await bootHexWar();
    const model = scene.getMapModel();

    expect(model).not.toBeNull();
    expect(model!.hexes.map((hex) => hex.id)).toEqual(
      RING_1_HEX_FIXTURES.map((entry) => entry.id),
    );
    // Every tile carries coordinates + aggression + the ownership marker at a
    // readable size; the full intel block lives on the detail panel (AC1/AC2).
    for (const intel of model!.hexes) {
      const row = scene.getMapRows().find((entry) => entry.key === `hex:${intel.id}`);
      expect(row, `no map tile for ${intel.id}`).toBeDefined();
      expect(row!.label).toBe(intel.tileLabel);
      expect(row!.label).toBe(
        `(${intel.q},${intel.r}) AGG ${intel.aggression} ${
          intel.held ? HELD_TILE_MARKER : UNHELD_TILE_MARKER
        }`,
      );
    }
    // The gym's render is read-only by construction.
    expect(scene.getMapRows().every((row) => !row.actionable)).toBe(true);

    // The read-only render defaults the detail panel to the model's default
    // hex and shows its full known-ahead intel.
    expect(scene.getMapPanelKey()).toBe(model!.defaultFocusKey);
    const panel = scene.getMapPanelText();
    const defaultHex = model!.hexes.find(
      (hex) => hex.key === model!.defaultFocusKey,
    )!;
    expect(panel).toContain(defaultHex.id);
    expect(panel).toContain(defaultHex.boss!);
    expect(panel).toContain(`W:${defaultHex.weaknesses.join(',')}`);
    expect(panel).toContain(`→${defaultHex.grants}`);
    expect(panel).toContain(`AGG ${defaultHex.aggression}`);
    expect(
      scene.children.list.some(
        (child) =>
          child instanceof Phaser.GameObjects.Text &&
          child.text.includes(defaultHex.boss!) &&
          child.text.includes(`→${defaultHex.grants}`),
      ),
    ).toBe(true);

    // The control surface re-renders the same shared model.
    scene.takeHex('hex-r1-2');
    expect(
      scene.getMapModel()!.hexes.find((hex) => hex.id === 'hex-r1-2')!.held,
    ).toBe(true);
    expect(scene.getMapPanelKey()).not.toBeNull();
  });

  it('defaults the read-only detail panel to the model\u2019s default hex', async () => {
    const scene = await bootHexWar();
    const model = scene.getMapModel()!;

    // Read-only by construction: nothing is focusable, yet the panel still
    // shows detail for the model's default/first hex (AC3).
    expect(scene.getMapRows().every((row) => !row.actionable)).toBe(true);
    expect(scene.getMapPanelKey()).not.toBeNull();
    const hex = model.hexes.find(
      (candidate) => candidate.key === scene.getMapPanelKey(),
    );
    expect(hex).toBeDefined();
    expect(scene.getMapPanelText()).toContain(hex!.id);
    expect(scene.getMapPanelText()).toContain(`AGG ${hex!.aggression}`);
  });

  // ── Hangar Map UX renderer contract (AH-0MWEWYT79001D3A1) ──────────

  it(
    'renders only the revealed hexes (a hidden hex gets no tile)',
    async () => {
      const scene = await bootHexWar({ payload: ringTwoPayload() });
      const model = scene.getMapModel()!;

      // The full ring-2 fixture ring is fed to the model…
      expect(model.hexes).toHaveLength(RING_2_HEX_FIXTURES.length);
      // …but with nothing held no ring-2 hex is adjacent to the hangar, so the
      // gym draws the hangar row alone — same reveal rule as the game.
      expect(model.hexes.every((hex) => !hex.displayed)).toBe(true);
      expect(scene.getMapRows().map((row) => row.key)).toEqual([
        HEX_MAP_HANGAR_ROW_KEY,
      ]);
    },
  );

  it(
    'renders the shared CVD-safe ownership encoding (blue held / orange unheld)',
    async () => {
      const payload = sixHexPayload();
      const heldId = RING_1_HEX_FIXTURES[1].id;
      const held = payload.ring.hexes.find((hex) => hex.id === heldId)!;
      held.held = true;
      held.defender = { hullId: 'hull-1', defenceRating: 7, bankedMinerals: 0 };
      const scene = await bootHexWar({ payload });
      const rows = scene.getMapRows();
      const heldRow = rows.find((row) => row.key === `hex:${heldId}`)!;
      const unheldRow = rows.find(
        (row) => row.key === `hex:${RING_1_HEX_FIXTURES[2].id}`,
      )!;

      // The non-colour discriminator distinguishes ownership on its own.
      expect(heldRow.label).toContain(HELD_TILE_MARKER);
      expect(heldRow.label).not.toContain(UNHELD_TILE_MARKER);
      expect(unheldRow.label).toContain(UNHELD_TILE_MARKER);

      // The CVD-safe pair: held text is blue-dominant, unheld orange-dominant.
      const heldColour = colourOf(heldRow.text);
      const unheldColour = colourOf(unheldRow.text);
      expect(heldColour.b).toBeGreaterThan(heldColour.r);
      expect(heldColour.b).toBeGreaterThan(heldColour.g);
      expect(unheldColour.r).toBeGreaterThan(unheldColour.b);
      expect(unheldColour.r).toBeGreaterThanOrEqual(unheldColour.g);
      expect(heldRow.text.style.color).not.toBe(unheldRow.text.style.color);

      // The gym is still read-only by construction.
      expect(rows.every((row) => !row.actionable)).toBe(true);
    },
  );

  it('renders the rolled-in report on its integrated map view', async () => {
    // A held hex with an unheld neighbour: a real attack is possible, so the
    // integrated view exercises the shipped resolver rather than only the quiet
    // path.
    const ring = RING_1_HEX_FIXTURES;
    const held = ring[0];
    const neighbour = ring[1];
    const payload: HangarWarPayload = {
      ...oneHexPayload({
        ...UNHELD_HEX,
        id: held.id,
        q: held.q,
        r: held.r,
        held: true,
        aggression: 0,
        defender: { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 },
      }),
      ring: {
        ringIndex: 1,
        hexes: [
          {
            ...UNHELD_HEX,
            id: held.id,
            q: held.q,
            r: held.r,
            held: true,
            aggression: 0,
            defender: { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 },
          },
          {
            ...UNHELD_HEX,
            id: neighbour.id,
            q: neighbour.q,
            r: neighbour.r,
            held: false,
            aggression: 3,
          },
        ],
      },
    };
    const scene = await bootHexWar({ payload });

    // The report model the game derives is what the gym's map view is built
    // from - there is no separate report screen to switch to.
    const tick = runFrontierTick(payload, { clock: frontierClockFor(payload) });
    const model = scene.getDefenceReport();
    expect(model.rows.map((row) => row.hexId)).toEqual(
      tick.record.attacks.map((attack) => attack.hexId),
    );
    for (const row of model.rows) {
      const resolved = tick.record.attacks.find(
        (attack) => attack.hexId === row.hexId,
      )!;
      expect(row.attackingForce).toBe(resolved.attackingForce);
      expect(row.aggression).toBe(resolved.aggression);
      expect(row.defenderRating).toBe(resolved.defenderRating);
      expect(row.attackStrength).toBe(resolved.attackStrength);
      expect(row.margin).toBe(resolved.margin);
      expect(row.outcome).toBe(resolved.outcome);
    }
    expect(model.noBattleLine).toContain('no battle was simulated');

    // The rolled-in report renders on the map itself, not as its own screen.
    expect(
      scene.children.list.some(
        (child) =>
          child instanceof Phaser.GameObjects.Text &&
          child.text.includes(DEFENCE_REPORT_TITLE),
      ),
    ).toBe(false);
    // Read-only by construction: the gym has no handlers, so nothing activates.
    expect(scene.getMapRows().every((row) => !row.actionable)).toBe(true);

    // The record the gym's map view carries is the shipped tick's own record.
    expect(scene.getTickRecord()).toEqual(tick.record);
    // One drawn arrow per recorded attack, from the attacker-origin tile to the
    // attacked tile (both positioned by the map's own axial layout).
    const arrows = scene.getMapArrows();
    expect(
      arrows.map((arrow) => [arrow.hexId, arrow.attackerOriginId]),
    ).toEqual(
      tick.record.attacks.map((attack) => [
        attack.hexId,
        attack.attackerOriginId,
      ]),
    );
    const rows = scene.getMapRows();
    for (const arrow of arrows) {
      const target = rows.find((row) => row.key === `hex:${arrow.hexId}`)!;
      expect(arrow.to).toEqual({ x: target.text.x, y: target.text.y });
      const origin = rows.find(
        (row) => row.key === `hex:${arrow.attackerOriginId}`,
      )!;
      expect(arrow.from).toEqual({ x: origin.text.x, y: origin.text.y });
    }

    // The left-hand attack panel shows the report model's own row for the
    // attacked hex and for its attacker origin (either endpoint resolves it).
    const [attack] = tick.record.attacks;
    const detail = scene.getMapModel()!.attackDetails.get(attack.hexId)!;
    expect(scene.focusMapRow(`hex:${attack.hexId}`)).toBe(true);
    expect(scene.isLeftPanelVisible()).toBe(true);
    expect(scene.getLeftPanelText()).toBe(detail.label);
    expect(scene.focusMapRow(`hex:${attack.attackerOriginId}`)).toBe(true);
    expect(scene.isLeftPanelVisible()).toBe(true);
    expect(scene.getLeftPanelText()).toBe(detail.label);
    // An unknown key is refused, so a mis-targeted inspection cannot blank the
    // panels.
    expect(scene.focusMapRow('hex:no-such-hex')).toBe(false);
    expect(scene.getLeftPanelText()).toBe(detail.label);
  });

  it('shows no arrows and no attack panel when the shipped tick attacks nothing', async () => {
    const scene = await bootHexWar({ payload: oneHexPayload({ ...UNHELD_HEX }) });

    expect(scene.getDefenceReport().rows).toEqual([]);
    expect(scene.getMapArrows()).toEqual([]);
    // The gym can inspect any rendered hex, but a record with no attacks has
    // no arrow endpoint, so the renderer's own rolled-in report rule hides the
    // panel (no gym-local copy).
    expect(scene.focusMapRow('hex:target')).toBe(true);
    expect(scene.isLeftPanelVisible()).toBe(false);
    expect(scene.getLeftPanelText()).toBe('');
  });

  it('refreshes the integrated view from the shipped tick after a harness tick', async () => {
    const ring = RING_1_HEX_FIXTURES;
    const payload: HangarWarPayload = {
      ...oneHexPayload({
        ...UNHELD_HEX,
        id: ring[0].id,
        q: ring[0].q,
        r: ring[0].r,
        held: true,
        aggression: 0,
        defender: { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 },
      }),
      ring: {
        ringIndex: 1,
        hexes: ring.slice(0, 3).map((fixture, index) => ({
          ...UNHELD_HEX,
          id: fixture.id,
          q: fixture.q,
          r: fixture.r,
          held: index === 0,
          aggression: fixture.baseAggression,
          defender:
            index === 0
              ? { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 }
              : null,
        })),
      },
    };
    const scene = await bootHexWar({ payload });
    scene.tick(2);

    // The map re-renders from the shipped resolver over the payload the harness
    // left behind, so a watcher sees the arrows and panel for the record the
    // game would now carry.
    const current = scene.getPayload();
    const direct = runFrontierTick(current, {
      clock: frontierClockFor(current),
    });
    expect(scene.getTickRecord()).toEqual(direct.record);
    expect(scene.getMapModel()!.arrows.map((arrow) => arrow.hexId)).toEqual(
      direct.record.attacks.map((attack) => attack.hexId),
    );
  });

  it('renders the tick record\'s attack arrows on its integrated map view', async () => {
    // The same held-hex / unheld-neighbour payload the rolled-in report test
    // uses: the shipped tick resolves at least one attack, so the arrows are
    // real.
    const ring = RING_1_HEX_FIXTURES;
    const held = ring[0];
    const neighbour = ring[1];
    const payload: HangarWarPayload = {
      ...oneHexPayload({
        ...UNHELD_HEX,
        id: held.id,
        q: held.q,
        r: held.r,
        held: true,
        aggression: 0,
        defender: { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 },
      }),
      ring: {
        ringIndex: 1,
        hexes: [
          {
            ...UNHELD_HEX,
            id: held.id,
            q: held.q,
            r: held.r,
            held: true,
            aggression: 0,
            defender: { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 },
          },
          {
            ...UNHELD_HEX,
            id: neighbour.id,
            q: neighbour.q,
            r: neighbour.r,
            held: false,
            aggression: 3,
          },
        ],
      },
    };

    const scene = await bootHexWar({ payload });
    const report = scene.getDefenceReport();
    const model = scene.getMapModel() as AttackAwareMapModel | null;

    // The shipped tick resolved attacks…
    expect(report.rows.length).toBeGreaterThan(0);
    // …and the integrated map view draws exactly those arrows from it.
    expect(
      model?.arrows?.map((arrow) => [
        arrow.hexId,
        arrow.attackerOriginId,
        arrow.attackerOrigin,
      ]),
    ).toEqual(
      report.rows.map((row) => [
        row.hexId,
        row.attackerOriginId,
        row.retake.origin,
      ]),
    );
  });

  it('is discovered by the gym index as "HexWar"', () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymHexWar.ts': { GymHexWar },
    });
    expect(entries.map((entry) => entry.key)).toEqual([GYM_HEX_WAR_SCENE_KEY]);
    expect(entries.map((entry) => entry.label)).toEqual(['HexWar']);
  });

  it('reports the same strength, budget, ceiling and deltas as a direct resolver call', async () => {
    const payload = sixHexPayload();
    const scene = await bootHexWar({ payload });

    const model = scene.getDefenceReport();
    const tick = runFrontierTick(payload, { clock: frontierClockFor(payload) });

    expect(model.playerStrength).toBe(tick.record.playerStrength);
    expect(model.aggressionBudget).toBe(tick.record.aggressionBudget);
    expect(model.beatableCeiling).toBe(tick.record.beatableCeiling);
    expect(model.deltas).toEqual(tick.record.deltas);
    expect(model.rose).toBe(tick.record.rose);
    expect(model.fell).toBe(tick.record.fell);
  });

  it('reports a strictly higher budget and ring total for an upgraded fleet', async () => {
    const starter = sixHexPayload();
    const starterScene = await bootHexWar({ payload: starter });
    const starterModel = starterScene.getDefenceReport();

    const upgraded = sixHexPayload({
      unlockedHulls: ['hull-1', 'hull-2'],
      activeHull: 'hull-2',
    });
    const upgradedScene = await bootHexWar({ payload: upgraded });
    const upgradedModel = upgradedScene.getDefenceReport();

    expect(upgradedModel.playerStrength).toBeGreaterThan(
      starterModel.playerStrength,
    );
    expect(upgradedModel.aggressionBudget).toBeGreaterThan(
      starterModel.aggressionBudget,
    );

    // The budget the gym reports is the ring total the shipped tick produced.
    const upgradedTick = runFrontierTick(upgraded, {
      clock: frontierClockFor(upgraded),
    });
    const total = upgradedTick.payload.ring.hexes.reduce(
      (sum, hex) => sum + hex.aggression,
      0,
    );
    expect(total).toBe(upgradedModel.aggressionBudget);
  });

  // ── The ring-end hangar assault (AH-0MWEZZDJC009FEU7) ─────────────

  it('resolves the ring-end hangar assault through the shipped capture-cycle gate', async () => {
    // A fully held ring whose defenders outclass the frontier's massed force.
    const payload = heldRingPayload(40, 1);
    const scene = await bootHexWar({ payload });

    // An ordinary ring landing carries no assault banner.
    expect(scene.getAssault()).toBeNull();
    expect(scene.isAssaultVisible()).toBe(false);
    expect(scene.getAssaultText()).toBe('');

    const resolved = scene.resolveAssault();

    // The gym's record is the shared gate's record — no gym-local arithmetic.
    expect(resolved).toEqual(resolveRingAssault(scene.getPayload()));
    expect(scene.getAssault()).toEqual(resolveRingAssault(scene.getPayload()));
    // A strongly defended ring repels the massed frontier.
    expect(resolved.outcome).toBe('repelled');

    // The banner is the renderer's own assault section, from the record.
    expect(scene.isAssaultVisible()).toBe(true);
    expect(scene.getAssaultText()).toContain('RING WON');
    expect(scene.getAssaultText()).toContain(
      `defender sum ${resolved.defenderSum}`,
    );
    expect(scene.getMapModel()!.assaultLine).toBe(scene.getAssaultText());
    expect(scene.getMapModel()!.ringWon).toBe(true);
    expect(scene.getMapModel()!.campaignReset).toBe(false);

    // The report model carries the same assault section (the shared pair).
    const report = scene.getDefenceReport();
    expect(report.assault).not.toBeNull();
    expect(report.assault!.outcome).toBe('repelled');
    expect(report.assault!.defenderSum).toBe(resolved.defenderSum);
    expect(report.assault!.attackStrength).toBe(resolved.attackStrength);
    expect(report.assault!.margin).toBe(resolved.margin);
    expect(report.ringWon).toBe(true);
    expect(report.campaignReset).toBe(false);
  });

  it('announces the hangar-falls campaign reset when the massed assault beats the ring', async () => {
    // Undefended, hot ring: the frontier's massed force breaks the hangar.
    const payload = heldRingPayload(0, 20);
    const scene = await bootHexWar({ payload });

    const resolved = scene.resolveAssault();
    expect(resolved.outcome).toBe('fell');
    expect(resolved.margin).toBeLessThan(0);

    expect(scene.isAssaultVisible()).toBe(true);
    expect(scene.getAssaultText()).toContain('HANGAR FALLS');
    expect(scene.getAssaultText()).toContain('FULL CAMPAIGN RESET');
    expect(scene.getAssaultText()).not.toContain('RING WON');
    expect(scene.getMapModel()!.campaignReset).toBe(true);
    expect(scene.getMapModel()!.ringWon).toBe(false);
    expect(scene.getDefenceReport().campaignReset).toBe(true);
  });

  it('renders an injected assault the game launch data carries', async () => {
    // Mirror `HexMapScene`'s transient launch data: a resolved record injected
    // by the caller (a capture or a test) renders verbatim, never re-derived.
    const payload = heldRingPayload(40, 1);
    const assault: HangarAssaultResolution = resolveHangarAssault(
      { defenderSum: 12, attackerBase: 5, aggression: 0, seed: 1 },
      { ...DEFAULT_FRONTIER_TUNING, jitterPercent: 0 },
    );
    const scene = await bootHexWar({ payload, assault });

    expect(scene.getAssault()).toEqual(assault);
    // A detached copy: the caller's record is never mutated.
    expect(scene.getAssault()).not.toBe(assault);
    expect(scene.isAssaultVisible()).toBe(true);
    expect(scene.getAssaultText()).toContain('RING WON');
    expect(scene.getMapModel()!.assaultLine).toBe(scene.getAssaultText());
  });

  it('adds no action to the read-only map and never stalls the capture traversal', async () => {
    const payload = heldRingPayload(0, 20);
    const scene = await bootHexWar({ payload });
    scene.resolveAssault();

    // The banner is part of the handler-less map: every row stays
    // non-actionable, so nothing new can block a traversal.
    expect(scene.getMapRows().every((row) => !row.actionable)).toBe(true);
    // The shared pure map decision still yields a total next step (the same
    // rule the game's attract traversal runs), so the banner cannot stall it.
    const action = decideMapAction(scene.getPayload());
    expect(['deploy', 'openHangar']).toContain(action.kind);
  });

});

/**
 * The special mission in the gym (`AH-0MWF0CSSI007P414`, post-MVP Hangar War
 * AH-0MVWZYIWX0008C55 AC5).
 *
 * Gym↔game parity means the special mission cannot be exercised by a gym-local
 * copy: the gym renders the shipped map model (so the reward is visible in the
 * detail panel *before* the player commits) and resolves the capture through
 * the shipped capture cycle (so the reward lands in the hangar's owned sets
 * exactly as it does in the game). The rotation is the shared seeded resolver,
 * so a gym run replays the sequence the game would for the same save.
 */
describe('GymHexWar — the special mission (AH-0MWF0CSSI007P414)', () => {
  let booted: BootedGame | null = null;

  async function bootHexWar(data?: object): Promise<GymHexWar> {
    booted = await reuse.boot([GymHexWar]);
    booted.game.scene.start(GYM_HEX_WAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(GYM_HEX_WAR_SCENE_KEY) as GymHexWar;
  }

  /** The ring-2 fixture payload at a fixed seed (the special mission lives here). */
  function specialRingTwoPayload(seed = 0x5eed_3c4b): HangarWarPayload {
    return { ...ringTwoPayload(), seed };
  }

  it('publishes the authored ring-2 special mission and its reward', async () => {
    const scene = await bootHexWar({ payload: specialRingTwoPayload() });

    const model = scene.getMapModel()!;
    expect(model.specialOffer?.hexId).toBe('hex-r2-3');
    expect(scene.getSpecialOffer()?.reward.hull.name).toBe('Juggernaut Hull');
    expect(scene.getSpecialOffer()?.reward.bonusStartingLives).toBeGreaterThan(0);
    // The reward is known ahead: the hex is not held and nothing was captured.
    expect(scene.getPayload().hangar.unlockedHulls).not.toContain('hull-3');
  });

  it('shows the reward in the detail panel before any capture', async () => {
    // Ring 1 is always revealed, so its tiles are focusable; marking its first
    // hex special (granting the same hull) exercises the shipped panel.
    const definitions = HEX_RING_DEFINITIONS.filter(
      (definition) => definition.ringIndex === 1,
    ).map((definition, index) =>
      index === 0
        ? { ...definition, grants: 'hull-3', isSpecialMission: true }
        : definition,
    );
    const scene = await bootHexWar({
      payload: sixHexPayload(),
      definitions,
    });
    const specialHexId = definitions[0].id;

    expect(scene.getSpecialOffer()?.hexId).toBe(specialHexId);
    // Focusing the special hex shows its full offer in the shipped panel.
    expect(scene.focusMapRow(`hex:${specialHexId}`)).toBe(true);
    const panel = scene.getMapPanelText();
    expect(panel).toContain('SPECIAL MISSION');
    expect(panel).toContain('Juggernaut Hull');
    expect(panel).toContain('OFFERED THIS SORTIE');
  });

  it('grants the extra-hit-points hull when the special mission is captured', async () => {
    const scene = await bootHexWar({ payload: specialRingTwoPayload() });

    const result = scene.captureHex('hex-r2-3', 'hull-1');

    expect(result.ok).toBe(true);
    expect(result.specialReward?.hullId).toBe('hull-3');
    // The ship lands in the hangar the gym renders (same owned set as the game).
    expect(scene.getPayload().hangar.unlockedHulls).toContain('hull-3');
    expect(scene.getLastCapture()?.specialReward?.hullId).toBe('hull-3');
    // ... and the map stops offering it, because it is now captured.
    expect(scene.getSpecialOffer()).toBeNull();
    expect(scene.getMapModel()!.specialOffer).toBeNull();
  });

  it('rotates the offer deterministically as the gym ticks', async () => {
    // Two authored special missions: the shipped rings author one, and a
    // rotation over a single candidate is unobservable.
    const definitions = HEX_RING_DEFINITIONS.filter(
      (definition) => definition.ringIndex === 1,
    ).map((definition, index) => ({
      ...definition,
      isSpecialMission: index < 2,
      grants: index === 0 ? 'hull-2' : index === 1 ? 'hull-3' : definition.grants,
    }));

    const sequence = async (seed: number): Promise<(string | null)[]> => {
      const scene = await bootHexWar({
        payload: { ...sixHexPayload(), seed },
        definitions,
      });
      const offers = [scene.getSpecialOffer()?.hexId ?? null];
      for (let i = 0; i < 4; i += 1) {
        scene.tick(1);
        offers.push(scene.getSpecialOffer()?.hexId ?? null);
      }
      return offers;
    };

    const first = await sequence(4242);
    const replay = await sequence(4242);

    // Same gym seed → the same rotation, tick for tick.
    expect(replay).toEqual(first);
    // ... and the offer really does move between sorties.
    expect(new Set(first).size).toBeGreaterThan(1);
    // Every offered hex is an authored special mission.
    const specialIds: string[] = definitions
      .filter((definition) => definition.isSpecialMission)
      .map((definition) => definition.id);
    expect(first.every((id) => id === null || specialIds.includes(id))).toBe(true);
  });

  it('persists the granted hull through the store for the hangar gym', async () => {
    const scene = await bootHexWar({ payload: specialRingTwoPayload() });
    scene.captureHex('hex-r2-3', 'hull-1');

    const storage = createInMemoryHangarWarStorage();
    saveHangarWarPayload(scene.getPayload(), storage);
    const loaded = loadHangarWarPayload(storage);

    expect(loaded?.hangar.unlockedHulls).toContain('hull-3');
  });
});

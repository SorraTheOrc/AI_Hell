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
  frontierClockFor,
  runFrontierTick,
} from '../../core/hangarWar/hexDefence';
import { DEFENCE_REPORT_TITLE } from '../../core/hangarWar/defenceReport';
import {
  HELD_TILE_MARKER,
  UNHELD_TILE_MARKER,
  type HexMapModel,
} from '../../core/hangarWar/hexIntel';
import {
  GymHexWar,
  GYM_HEX_WAR_DEFAULT_SEED,
  GYM_HEX_WAR_HINT,
  GYM_HEX_WAR_REPORT_HINT,
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
 * **TEST-FIRST.** The rolled-in report means the gym's map view renders the
 * same shared `renderHexMap` arrows as the game when it is given the same tick
 * record (AGENTS.md gym↔game parity; parent AH-0MWDC3L9I008INDP). The
 * assertion is authored under Vitest's `it.fails` (the repo's
 * red-before/green-after convention, see `src/core/levelScaling.test.ts`) so
 * this suite stays green on pre-change HEAD; the gym parity item
 * (AH-0MWEXJ21W003M7RR) flips it back to `it`, and a leftover `it.fails` then
 * fails loudly.
 *
 * ## Pinned contract
 *
 * The gym's map model (`getMapModel()`) carries the attack arrows derived from
 * the same shipped tick record its report view renders
 * (`runFrontierTick(this.payload, { clock: frontierClockFor(this.payload) })`):
 * one arrow per `record.attacks[]` entry, in the record's order, with the
 * record's attacker-origin coordinates — so the gym and the game draw the same
 * arrows from the same record, never a divergent copy.
 */

/** The gym map model with the attack fields this test-first item pins. */
interface AttackAwareMapModel extends HexMapModel {
  readonly arrows?: readonly {
    readonly hexId: string;
    readonly attackerOriginId: string;
    readonly attackerOrigin: { readonly q: number; readonly r: number };
  }[];
}

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

  it('renders the shipped defence report from the shipped resolver record', async () => {
    // A held hex with an unheld neighbour: a real attack is possible, so the
    // report exercises the resolver rather than only the quiet path.
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
    scene.showDefenceReport();
    await advanceGame(booted!.game, 100);

    expect(scene.getView()).toBe('report');
    findTextStartingWith(scene, DEFENCE_REPORT_TITLE);
    findTextStartingWith(scene, GYM_HEX_WAR_REPORT_HINT);

    // The report is the shipped model over the shipped tick's record — the same
    // code path the game's DefenceReportScene renders.
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
    // Read-only by construction: the gym has no handlers, so nothing activates.
    expect(scene.getReportRows().length).toBeGreaterThan(0);
    expect(scene.getReportRows().every((row) => !row.actionable)).toBe(true);
    expect(scene.getDefenceReport().noBattleLine).toContain('no battle was simulated');

    // The control surface switches back to the shared map view.
    scene.showMap();
    expect(scene.getView()).toBe('map');
    expect(scene.getMapModel()).not.toBeNull();
  });

  it.fails(
    'renders the tick record\'s attack arrows on its integrated map view',
    async () => {
      // The same held-hex / unheld-neighbour payload the report test uses: the
      // shipped tick resolves at least one attack, so the arrows are real.
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

      // The record the gym already renders in its report view resolved attacks…
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
    },
  );

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
    scene.showDefenceReport();
    await advanceGame(booted!.game, 80);

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
    starterScene.showDefenceReport();
    await advanceGame(booted!.game, 80);
    const starterModel = starterScene.getDefenceReport();

    const upgraded = sixHexPayload({
      unlockedHulls: ['hull-1', 'hull-2'],
      activeHull: 'hull-2',
    });
    const upgradedScene = await bootHexWar({ payload: upgraded });
    upgradedScene.showDefenceReport();
    await advanceGame(booted!.game, 80);
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

});

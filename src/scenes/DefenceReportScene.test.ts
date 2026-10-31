/**
 * Defence report scene tests (AH-0MVUXCBBK004EJIP).
 *
 * The screen is a pure view over the frontier tick's record and the stored
 * payload: it renders every number behind each hold/fall and offers exactly one
 * action (continue to the map). These tests pin that contract — the numbers on
 * screen, the quiet-tick case, the continue path, and the attract traversal's
 * bounded auto-advance — plus the design's no-battle rule: nothing here
 * simulates a defence.
 */

import { afterAll, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../test/gameHarness';
import { createDefaultPayload } from '../core/hangarWar/hangarWarStore';
import {
  DEFENCE_REPORT_CONTINUE_KEY,
  DEFENCE_REPORT_CONTINUE_LABEL,
  DEFENCE_REPORT_TITLE,
} from '../core/hangarWar/defenceReport';
import {
  DEFAULT_FRONTIER_TUNING,
  runFrontierTick,
  type FrontierTickRecord,
  type FrontierTuning,
} from '../core/hangarWar/hexDefence';
import { createRingState } from '../core/hangarWar/hexRing';
import type { HangarWarPayload, HexState } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { DEFENCE_REPORT_SCENE_KEY, DefenceReportScene } from './DefenceReportScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from './HexMapScene';
import { PlayScene } from './PlayScene';
import { DEFENCE_REPORT_HINT } from './hangarWar/defenceReport';

/** A two-hex payload: one held hex and the unheld neighbour attacking it. */
function twoHexPayload(): HangarWarPayload {
  const hex = (
    id: string,
    q: number,
    r: number,
    overrides: Partial<HexState> = {},
  ): HexState => ({
    id,
    q,
    r,
    held: false,
    aggression: 0,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
    ...overrides,
  });
  return {
    ...createDefaultPayload(424242),
    ring: {
      ringIndex: 1,
      hexes: [
        hex('hex-held', 1, 0, {
          held: true,
          aggression: 3,
          defender: { hullId: 'hull-1', defenceRating: 2, bankedMinerals: 5 },
        }),
        hex('hex-frontier', 0, 1, { aggression: 2 }),
      ],
    },
  };
}

/** A synthetic record: one attack that took `hex-held`. */
function fellRecord(): FrontierTickRecord {
  return {
    tick: 4,
    aggressionRise: 2,
    attacks: [
      {
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
      },
    ],
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

/** Finds an on-screen text that contains `needle` anywhere in its content. */
function findTextContaining(
  scene: Phaser.Scene,
  needle: string,
): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text.includes(needle),
  );
  expect(found, `no text containing "${needle}"`).toBeDefined();
  return found!;
}

const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

describe('DefenceReportScene', () => {
  let booted: BootedGame | null = null;

  /** Boots the scene and re-starts it with `data` (Phaser launch data). */
  async function bootReport(data?: object): Promise<DefenceReportScene> {
    booted = await reuse.boot([DefenceReportScene, HexMapScene, PlayScene]);
    booted.game.scene.start(DEFENCE_REPORT_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(
      DEFENCE_REPORT_SCENE_KEY,
    ) as DefenceReportScene;
  }

  it('renders the tick, the summary and every number behind a fallen hex', async () => {
    const payload = twoHexPayload();
    const scene = await bootReport({
      payload,
      record: fellRecord(),
      storage: null,
    });

    expect(scene.sys.isActive()).toBe(true);
    findTextStartingWith(scene, DEFENCE_REPORT_TITLE);
    findTextStartingWith(scene, 'TICK 4 · aggression +2');
    findTextStartingWith(scene, 'ATTACKED 1 · HELD 0 · FELL 1');
    findTextStartingWith(scene, DEFENCE_REPORT_HINT);

    const model = scene.getModel();
    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row.hexId).toBe('hex-held');
    expect(row.attackingForce).toBe(4);
    expect(row.aggression).toBe(3);
    expect(row.defenderRating).toBe(2);
    expect(row.attackStrength).toBe(6);
    expect(row.margin).toBe(-4);
    expect(row.outcome).toBe('fell');
    // What it would take to retake it is on screen, not just in the model. The
    // retake line is the last line of the hex's block, so it is found inside
    // that multi-line label rather than at the start of a text object.
    findTextStartingWith(scene, 'hex-held — FELL');
    findTextContaining(scene, 'retake: strike hex-frontier');
  });

  it('offers exactly one action: continue to the map', async () => {
    const scene = await bootReport({
      payload: twoHexPayload(),
      record: fellRecord(),
      storage: null,
    });

    expect(scene.getRows().map((row) => row.key)).toContain(
      DEFENCE_REPORT_CONTINUE_KEY,
    );
    expect(scene.getFocusedKey()).toBe(DEFENCE_REPORT_CONTINUE_KEY);
    // Only the continue row is actionable; the attack blocks are read-only.
    const actionable = scene
      .getRows()
      .filter((row) => row.actionable)
      .map((row) => row.key);
    expect(actionable).toEqual([DEFENCE_REPORT_CONTINUE_KEY]);
    findTextStartingWith(scene, DEFENCE_REPORT_CONTINUE_LABEL);
  });

  it('continues to the map with the same war payload', async () => {
    const payload = twoHexPayload();
    const scene = await bootReport({
      payload,
      record: fellRecord(),
      storage: null,
    });

    scene.activateFocused();
    await advanceGame(booted!.game, 200);

    expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
    const map = booted!.game.scene.getScene(HEX_MAP_SCENE_KEY) as HexMapScene;
    expect(map.getPayload().ring.hexes.map((hex) => hex.id)).toEqual([
      'hex-held',
      'hex-frontier',
    ]);
    // The report never starts a battle: no run scene is left running.
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });

  it('renders a quiet tick instead of an empty screen', async () => {
    const scene = await bootReport({
      payload: twoHexPayload(),
      record: { tick: 7, aggressionRise: 1, attacks: [] },
      storage: null,
    });
    findTextStartingWith(scene, 'QUIET — no hex was attacked this tick');
    expect(scene.getModel().quiet).toBe(true);
    // The continue action is still present, so the demo can always advance.
    expect(scene.getFocusedKey()).toBe(DEFENCE_REPORT_CONTINUE_KEY);
  });

  it('renders the numbers a real frontier tick produced (one code path)', async () => {
    // Run the shipped resolver over ring 1, then report exactly its record.
    const ring = createRingState(1, HEX_RING_DEFINITIONS);
    const target = ring.hexes[0];
    const origin = ring.hexes[1];
    const payload: HangarWarPayload = {
      ...createDefaultPayload(424242),
      ring: {
        ringIndex: 1,
        hexes: ring.hexes.map((hex) => ({
          ...hex,
          held: hex.id === target.id,
          aggression: hex.id === origin.id ? 4 : 0,
          defender:
            hex.id === target.id
              ? { hullId: 'hull-1', defenceRating: 1, bankedMinerals: 0 }
              : null,
        })),
      },
    };
    const alwaysAttack: FrontierTuning = {
      ...DEFAULT_FRONTIER_TUNING,
      attackChancePercent: 100,
      jitterPercent: 0,
    };
    const tick = runFrontierTick(payload, { tuning: alwaysAttack });
    expect(tick.record.attacks).toHaveLength(1);

    const scene = await bootReport({
      payload: tick.payload,
      record: tick.record,
      storage: null,
    });
    const row = scene.getModel().rows[0];
    const resolved = tick.record.attacks[0];
    expect(row.hexId).toBe(resolved.hexId);
    expect(row.attackingForce).toBe(resolved.attackingForce);
    expect(row.aggression).toBe(resolved.aggression);
    expect(row.defenderRating).toBe(resolved.defenderRating);
    expect(row.attackStrength).toBe(resolved.attackStrength);
    expect(row.margin).toBe(resolved.margin);
    expect(row.outcome).toBe(resolved.outcome);
    // The report is arithmetic over stored numbers — no battle was simulated.
    expect(scene.getModel().noBattleLine).toContain('no battle was simulated');
  });

  it('boots directly with a quiet report when nothing is injected', async () => {
    const scene = await bootReport({ storage: null });
    expect(scene.getModel().quiet).toBe(true);
    expect(scene.getFocusedKey()).toBe(DEFENCE_REPORT_CONTINUE_KEY);
  });

  it('shows the finished deployment result when it is supplied', async () => {
    const scene = await bootReport({
      payload: twoHexPayload(),
      record: fellRecord(),
      won: false,
      score: 1234,
      storage: null,
    });
    findTextStartingWith(scene, 'RUN: DEFEAT · score 1234');
  });

  it('auto-advances to the map in demo mode within the dwell', async () => {
    // The dwell is longer than `bootReport`'s settle (200 ms), so the report is
    // still on screen when the first assertion runs.
    const scene = await bootReport({
      payload: twoHexPayload(),
      record: fellRecord(),
      storage: null,
      demo: true,
      demoDwellMs: 1000,
    });
    expect(scene.isDemo()).toBe(true);
    // Before the dwell the report is still up.
    expect(booted!.game.scene.isActive(DEFENCE_REPORT_SCENE_KEY)).toBe(true);

    await advanceGame(booted!.game, 1200);

    // The demo leaves the report without any input (never stalls) and lands on
    // the map — not in a defence battle.
    expect(booted!.game.scene.isActive(HEX_MAP_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });

  it('never mutates the injected payload or record', async () => {
    const payload = twoHexPayload();
    const record = fellRecord();
    const payloadBefore = JSON.parse(JSON.stringify(payload));
    const recordBefore = JSON.parse(JSON.stringify(record));

    const scene = await bootReport({ payload, record, storage: null });
    scene.activateFocused();
    await advanceGame(booted!.game, 100);

    expect(payload).toEqual(payloadBefore);
    expect(record).toEqual(recordBefore);
  });
});

/**
 * GymHangar tests (AH-0MVUXC074005IGXZ).
 *
 * The hangar gym is the parity surface for the hangar slice: it boots a real
 * scene and renders an **injected** hangar-war payload read-only, so later
 * economy/ring items exercise pure logic here rather than in a bespoke
 * harness. This suite pins:
 *
 * - the scene boots and renders the documented payload summary (salvage,
 *   fleet loadout, ring progress);
 * - the payload is injected through launch data and is never mutated by
 *   rendering (read-only, no purchase logic in the scene);
 * - with nothing injected it renders the deterministic sample fixture, so the
 *   gym is useful on first load and reproducible for capture;
 * - a scripted-scene `setup` is consumed (its seed drives the sample payload)
 *   instead of being silently dropped, mirroring `GymCurveSequencer`;
 * - the index discovers it as "Hangar".
 */

import { afterAll, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../../test/gameHarness';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import {
  PARTIAL_RING_PAYLOAD,
  VALID_HANGAR_WAR_PAYLOAD,
} from '../../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  GymHangar,
  GYM_HANGAR_HINT,
  GYM_HANGAR_SCENE_KEY,
  GYM_HANGAR_TITLE,
  GYM_HANGAR_DEFAULT_SEED,
} from './GymHangar';
import { buildHangarScreenModel } from '../hangarWar/hangarScreen';
import { createRingState } from '../../core/hangarWar/hexRing';
import { resolveHexCapture } from '../../core/hangarWar/captureCycle';
import { bankedSalvageFromHangar, runSalvageFromRun } from '../../core/hangarWar/salvageBanking';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';

/** Deep, detached copy of a payload (so mutation by the scene is detectable). */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
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

describe('GymHangar', () => {
  let booted: BootedGame | null = null;

  /** Boots the scene and re-starts it with `data` (Phaser launch data). */
  async function bootHangar(data?: object): Promise<GymHangar> {
    booted = await reuse.boot([GymHangar]);
    booted.game.scene.start(GYM_HANGAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(GYM_HANGAR_SCENE_KEY) as GymHangar;
  }

  it('boots, shows its title and renders the injected payload', async () => {
    const scene = await bootHangar({ payload: VALID_HANGAR_WAR_PAYLOAD });

    expect(scene.sys.isActive()).toBe(true);
    findTextStartingWith(scene, GYM_HANGAR_TITLE);
    findTextStartingWith(scene, GYM_HANGAR_HINT);

    const lines = scene.getSummaryLines();
    expect(lines.some((line) => line.includes('240 minerals'))).toBe(true);
    expect(lines.some((line) => line.includes('hull-1'))).toBe(true);
    // The shipped hangar screen model is what the gym renders.
    expect(scene.getModel().salvageLine).toContain('240 minerals');
    expect(scene.getModel().unlockRows.length).toBeGreaterThan(0);
  });

  it('renders the shipped hangar screen read-only (same rows, no handlers)', async () => {
    const scene = await bootHangar({ payload: VALID_HANGAR_WAR_PAYLOAD });
    const shipped = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);

    expect(scene.getModel()).toEqual(shipped);
    expect(scene.getRows().map((row) => row.key)).toEqual([
      ...shipped.unlockRows.map((row) => row.key),
      ...shipped.hullOptions.map((option) => option.key),
      ...shipped.weaponOptions.map((option) => option.key),
      ...shipped.modifierOptions.map((option) => option.key),
      shipped.deployRow.key,
      shipped.mapRow.key,
      shipped.restartRow.key,
    ]);
    // Read-only: no row is actionable, so none is interactive either.
    expect(scene.getRows().every((row) => !row.actionable)).toBe(true);
    expect(scene.getRows().every((row) => row.text.input === null)).toBe(true);
  });

  it('renders the ⟲ RESTART WAR row non-actionable (same model, no handlers)', async () => {
    const scene = await bootHangar({ payload: VALID_HANGAR_WAR_PAYLOAD });
    const restart = scene.getRows().find((row) => row.key === 'restart');
    expect(restart, 'restart row not rendered').toBeDefined();
    // The gym renders the same idle row the game does, read-only.
    expect(restart!.label).toBe('⟲ RESTART WAR — start a fresh war');
    expect(restart!.actionable).toBe(false);
    expect(restart!.text.input).toBeNull();
  });

  it('renders the injected payload read-only (no purchase logic, no mutation)', async () => {
    const injected = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ payload: injected });
    await advanceGame(booted!.game, 200);

    expect(scene.getPayload()).toEqual(injected);
    // The scene's payload is a detached copy — mutating it cannot reach the
    // caller's object and vice versa.
    expect(scene.getPayload()).not.toBe(injected);
    scene.getPayload().hangar.bankedMinerals = 0;
    expect(injected.hangar.bankedMinerals).toBe(
      VALID_HANGAR_WAR_PAYLOAD.hangar.bankedMinerals,
    );
  });

  it('summarises a partial ring from the hexes it knows about', async () => {
    const scene = await bootHangar({ payload: PARTIAL_RING_PAYLOAD });

    const held = PARTIAL_RING_PAYLOAD.ring.hexes.filter((hex) => hex.held).length;
    const line = scene
      .getSummaryLines()
      .find((entry) => entry.startsWith(`Ring ${PARTIAL_RING_PAYLOAD.ring.ringIndex}`));
    expect(line).toBeDefined();
    expect(line).toContain(
      `${held}/${PARTIAL_RING_PAYLOAD.ring.hexes.length} hexes held`,
    );
  });

  it('renders the deterministic sample fixture when nothing is injected', async () => {
    const first = await bootHangar();
    const firstPayload = clonePayload(first.getPayload());

    const second = await bootHangar();
    expect(second.getPayload()).toEqual(firstPayload);
    expect(firstPayload.seed).toBe(GYM_HANGAR_DEFAULT_SEED);
    // The sample is a complete payload, not an empty placeholder.
    expect(firstPayload.hangar.unlockedHulls.length).toBeGreaterThan(0);
    expect(firstPayload.ring.hexes.length).toBeGreaterThan(0);
  });

  it('consumes a scripted-scene setup seed instead of dropping it', async () => {
    const configured = await bootHangar({ seed: 4242 });

    expect(configured.getPayload().seed).toBe(4242);
    const firstPayload = clonePayload(configured.getPayload());

    const again = await bootHangar({ seed: 4242 });
    expect(again.getPayload()).toEqual(firstPayload);
  });

  it('a payload injection wins over the setup seed', async () => {
    const scene = await bootHangar({
      seed: 4242,
      payload: VALID_HANGAR_WAR_PAYLOAD,
    });

    expect(scene.getPayload()).toEqual(VALID_HANGAR_WAR_PAYLOAD);
  });

  it('is discovered by the gym index as "Hangar"', () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymHangar.ts': { GymHangar },
    });
    expect(entries.map((entry) => entry.key)).toEqual([GYM_HANGAR_SCENE_KEY]);
    expect(entries.map((entry) => entry.label)).toEqual(['Hangar']);
  });
});

/**
 * The special-mission reward in the hangar gym
 * (`AH-0MWF0CXR4004C9CN`, post-MVP Hangar War AH-0MVWZYIWX0008C55 AC5).
 *
 * Completing the ring-2 special mission grants the extra-hit-points
 * `Juggernaut Hull` into the hangar's owned set. The hangar gym renders the
 * **shipped** screen model over whatever payload it is given, so fed the
 * payload a capture wrote it shows the reward exactly as the player sees it —
 * no gym-side grant logic, no second copy of the unlock tree.
 */
describe('GymHangar — the special-mission reward (AH-0MWF0CXR4004C9CN)', () => {
  let booted: BootedGame | null = null;

  async function bootHangar(data?: object): Promise<GymHangar> {
    booted = await reuse.boot([GymHangar]);
    booted.game.scene.start(GYM_HANGAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(GYM_HANGAR_SCENE_KEY) as GymHangar;
  }

  /** The ring-2 war, with the special mission captured by the shipped cycle. */
  function capturedSpecialMissionPayload(): HangarWarPayload {
    const payload: HangarWarPayload = {
      ...VALID_HANGAR_WAR_PAYLOAD,
      ring: createRingState(2, HEX_RING_DEFINITIONS),
    };
    const result = resolveHexCapture(payload, {
      hexId: 'hex-r2-3',
      defenderHullId: 'hull-1',
      salvage: runSalvageFromRun({
        runId: 'gym-hangar',
        checkpointId: 'boss-victory',
        minerals: 0,
        cores: 0,
      }),
      definitions: HEX_RING_DEFINITIONS,
      banked: bankedSalvageFromHangar(payload.hangar),
    });
    expect(result.ok).toBe(true);
    return result.payload;
  }

  it('shows the granted Juggernaut Hull as an owned unlock', async () => {
    const captured = capturedSpecialMissionPayload();
    expect(captured.hangar.unlockedHulls).toContain('hull-3');

    const scene = await bootHangar({ payload: captured });
    const row = scene.getModel().unlockRows.find((entry) => entry.id === 'hull-3');

    expect(row, 'hull-3 unlock row not rendered').toBeDefined();
    expect(row!.name).toBe('Juggernaut Hull');
    // Owned, not buyable: the reward arrives through the capture, not the shop.
    expect(row!.actionLabel).toBe('OWNED');
    expect(row!.actionable).toBe(false);
    // The reward is also a deployable hull option (it is a real ship).
    expect(
      scene.getModel().hullOptions.some((option) => option.id === 'hull-3'),
    ).toBe(true);
  });

  it('renders the same reward row the game’s own screen model builds', async () => {
    const captured = capturedSpecialMissionPayload();
    const scene = await bootHangar({ payload: captured });

    // Gym↔game parity: the gym renders the shipped model verbatim.
    expect(scene.getModel()).toEqual(buildHangarScreenModel(captured));
  });
});

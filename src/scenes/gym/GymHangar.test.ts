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
import {
  buildHangarScreenModel,
  buildHangarRightColumnEntries,
  HANGAR_RIGHT_VIEWPORT_BOTTOM_Y,
  HANGAR_RIGHT_VIEWPORT_TOP_Y,
  HANGAR_RIGHT_VISIBLE_ROWS,
  HANGAR_STRONG_MARKER,
  HANGAR_UNLOCK_VIEWPORT_BOTTOM_Y,
  HANGAR_UNLOCK_VISIBLE_ROWS,
  HANGAR_WEAK_MARKER,
  hangarRightMaxScroll,
  hangarUnlockMaxScroll,
} from '../hangarWar/hangarScreen';
import {
  HANGAR_CATALOGUE,
  isPurchasableEntry,
  type HangarEntry,
} from '../../data/hangarCatalogue';
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
      ...shipped.powerUpOptions.map((option) => option.key),
      ...shipped.modifierOptions.map((option) => option.key),
      ...shipped.savedBuildRows.map((row) => row.key),
      shipped.buildoutRow.key,
      shipped.deployRow.key,
      shipped.mapRow.key,
      shipped.restartRow.key,
    ]);
    // Read-only: no row is actionable, so none is interactive either.
    expect(scene.getRows().every((row) => !row.actionable)).toBe(true);
    expect(scene.getRows().every((row) => row.text.input === null)).toBe(true);
  });

  it('renders the same scrolling unlock tree the game does (AH-0MWWI3ONJ004QRR9)', async () => {
    // A catalogue where every weapon is for sale holds the full 23-row tree
    // while the right-hand loadout stays at the owned weapons. The gym is
    // read-only, so this proves the shared renderer — not a gym copy — windows
    // and scrolls the grown tree.
    const catalogue: HangarEntry[] = HANGAR_CATALOGUE.map((entry) =>
      entry.kind === 'weapon' && !isPurchasableEntry(entry)
        ? { ...entry, minRing: 1, price: { minerals: 1, cores: 0 } }
        : entry,
    );
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.hangar.unlockedHulls = [
      'hull-1',
      'hull-2',
      'hull-3',
      'hull-4',
    ];
    payload.hangar.unlockedWeapons = [
      'spread',
      'wave_laser',
      'ricochet',
      'cluster',
    ];
    payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];

    const scene = await bootHangar({ payload, catalogue });
    const model = scene.getModel();
    expect(model.unlockRows).toHaveLength(23);
    // Read-only: the same rows, none actionable.
    expect(scene.getRows().every((row) => !row.actionable)).toBe(true);

    const unlockRows = model.unlockRows.map(
      (row) => scene.getRows().find((candidate) => candidate.key === row.key)!,
    );
    // The window starts on the first page; the rest is hidden, not drawn over
    // the fixed bottom block.
    const visible = unlockRows.filter((row) => row.text.visible);
    expect(visible).toHaveLength(HANGAR_UNLOCK_VISIBLE_ROWS);
    for (const row of visible) {
      expect(row.text.y).toBeLessThanOrEqual(HANGAR_UNLOCK_VIEWPORT_BOTTOM_Y);
    }

    // Scrolling the shared screen reaches the last row (pointer navigation).
    expect(scene.scrollUnlockRows(HANGAR_UNLOCK_VISIBLE_ROWS)).toBe(
      hangarUnlockMaxScroll(model),
    );
    const lastRow = unlockRows.at(-1)!;
    expect(lastRow.text.visible).toBe(true);
    expect(lastRow.text.y).toBeLessThanOrEqual(
      HANGAR_UNLOCK_VIEWPORT_BOTTOM_Y,
    );
  });

  it('renders the same scrolling right column the game does (AH-0MWWRQ8PX0088NQR)', async () => {
    // A veteran hangar: four hulls, every shipped weapon, two modifiers and a
    // saved build. The right column would overflow the fixed block unscrolled,
    // so the shared renderer windows it — and the gym, which owns no second
    // renderer, renders that identical window read-only (gym↔game parity).
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
    payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3', 'hull-4'];
    payload.hangar.unlockedWeapons = [
      'spread',
      'dual',
      'rapid',
      'wave_laser',
      'ricochet',
      'cluster',
      'options',
      'nova',
      'mortar',
      'arc',
      'rear_guard',
      'broadside',
      'railgun',
      'shard_swarm',
      'heavy_slug',
    ];
    payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
    payload.hangar.activeHull = 'hull-1';
    payload.hangar.activeLoadout = {
      startingWeapons: ['spread'],
      modifiers: [],
    };
    payload.hangar.savedBuilds = [
      {
        id: 'saved-1',
        name: 'Saved One',
        hullId: 'hull-1',
        startingWeapons: ['spread'],
        modifiers: [],
      },
    ];

    const scene = await bootHangar({ payload });
    const model = scene.getModel();

    // One shared code path: the gym's model is the game's model.
    expect(model).toEqual(buildHangarScreenModel(payload));
    expect(model.weaponOptions).toHaveLength(15);
    expect(hangarRightMaxScroll(model)).toBeGreaterThan(0);
    // Read-only: the same rows, none actionable.
    expect(scene.getRows().every((row) => !row.actionable)).toBe(true);

    const rightRows = buildHangarRightColumnEntries(model)
      .filter((entry) => entry.kind !== 'heading')
      .map((entry) => scene.getRows().find((row) => row.key === entry.key)!);
    const visible = rightRows.filter((row) => row.text.visible);
    expect(visible.length).toBeGreaterThan(0);
    for (const row of visible) {
      expect(row.text.y).toBeGreaterThanOrEqual(HANGAR_RIGHT_VIEWPORT_TOP_Y);
      expect(row.text.y).toBeLessThanOrEqual(HANGAR_RIGHT_VIEWPORT_BOTTOM_Y);
    }

    // The gym pages the shared right-column window to the last row.
    expect(scene.scrollRightRows(HANGAR_RIGHT_VISIBLE_ROWS * 10)).toBe(
      hangarRightMaxScroll(model),
    );
    const lastRow = rightRows.at(-1)!;
    expect(lastRow.text.visible).toBe(true);
    expect(lastRow.text.y).toBeLessThanOrEqual(
      HANGAR_RIGHT_VIEWPORT_BOTTOM_Y,
    );
  });

  it('renders the installable power-up rows from the same model, read-only (AH-0MWOV8SMI006W52Z)', async () => {
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.hangar.unlockedPowerUps = ['bomb', 'magnet'];
    payload.hangar.powerUpLevels = [
      { id: 'bomb', level: 1 },
      { id: 'magnet', level: 1 },
    ];

    const scene = await bootHangar({ payload });
    const shipped = buildHangarScreenModel(payload);

    // The gym model is the game's model, power-up rows included.
    expect(scene.getModel()).toEqual(shipped);
    expect(scene.getModel().powerUpOptions.map((option) => option.id)).toEqual([
      'bomb',
      'magnet',
    ]);
    // No handler supplies `onTogglePowerUp`, so the rows render read-only.
    for (const id of ['bomb', 'magnet']) {
      const row = scene.getRows().find((entry) => entry.key === `power-up:${id}`);
      expect(row, `power-up row ${id}`).toBeDefined();
      expect(row!.actionable).toBe(false);
      expect(row!.text.input).toBeNull();
    }
  });

  it('publishes the target intel through the shared model, read-only (AH-0MWMT4QXF0095CBN)', async () => {
    // The fixture ring's ids are not in the authored table, so the shared model
    // publishes the explicit unknown fallback — the gym renders exactly that,
    // and invents no intel of its own. The known-hex parity case lives below.
    const scene = await bootHangar({ payload: VALID_HANGAR_WAR_PAYLOAD });
    const shipped = buildHangarScreenModel(VALID_HANGAR_WAR_PAYLOAD);

    expect(scene.getModel()).toEqual(shipped);
    expect(scene.getModel().bossIntel).toEqual({
      hexId: 'hex-2',
      boss: null,
      strengths: [],
      weaknesses: [],
      known: false,
    });
    findTextStartingWith(scene, 'TARGET INTEL — hex-2');
    expect(findTextStartingWith(scene, 'BOSS: ').text).toBe('BOSS: unknown');
    expect(findTextStartingWith(scene, 'STRENGTHS: ').text).toBe(
      'STRENGTHS: unknown',
    );
    expect(findTextStartingWith(scene, 'WEAKNESSES: ').text).toBe(
      'WEAKNESSES: unknown',
    );
    // No row is marked strong/weak for an unknown boss, and the render stays
    // read-only (no handlers), so the intel changes nothing it can activate.
    expect(
      scene
        .getRows()
        .every((row) => row.matchup !== 'strong' && row.matchup !== 'weak'),
    ).toBe(true);
    expect(scene.getRows().every((row) => !row.actionable)).toBe(true);
  });

  it('renders the known target intel and ▲/▼ matchup marks read-only (AH-0MWMT4STK001PSK4)', async () => {
    // The authored ring makes the default target a hex the shipped definition
    // table knows, so the intel is populated and every owned weapon row carries
    // a matchup verdict. The gym must render the *identical* shared model —
    // intel and marks included — with no handlers, so nothing on the screen can
    // act on the advice.
    //
    // `hex-r1-1` is held so the default target falls to `hex-r1-2`
    // (`shroud-merchant`): since AH-0MWW28ET2002PNI8 both hexes author
    // aggression 1 and the sorted-id tie-break would otherwise pick
    // `hex-r1-1` (`the-dawnbreaker`), which resists none of the owned weapons
    // and so would render no ▲/▼ marks at all.
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
    const heldHex = payload.ring.hexes.find((hex) => hex.id === 'hex-r1-1')!;
    heldHex.held = true;
    payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3', 'hull-4'];
    payload.hangar.unlockedWeapons = [
      'spread',
      'wave_laser',
      'ricochet',
      'cluster',
    ];
    payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
    payload.hangar.activeHull = 'hull-1';
    payload.hangar.activeLoadout = { startingWeapons: ['spread'], modifiers: [] };
    payload.hangar.bankedMinerals = 0;
    payload.hangar.bankedCores = 0;

    const scene = await bootHangar({ payload });
    const shipped = buildHangarScreenModel(payload);

    // One shared code path: the gym's model is the game's model, intel and all.
    expect(scene.getModel()).toEqual(shipped);
    expect(scene.getModel().bossIntel).toEqual({
      hexId: 'hex-r1-2',
      boss: 'shroud-merchant',
      strengths: ['spread'],
      weaknesses: ['waveLaser'],
      known: true,
    });

    // The authored intel renders through the shared renderer.
    findTextStartingWith(scene, 'TARGET INTEL — hex-r1-2');
    expect(findTextStartingWith(scene, 'BOSS: ').text).toBe('BOSS: shroud-merchant');
    expect(findTextStartingWith(scene, 'STRENGTHS: ').text).toBe(
      'STRENGTHS: spread',
    );
    expect(findTextStartingWith(scene, 'WEAKNESSES: ').text).toBe(
      'WEAKNESSES: waveLaser',
    );

    // `spread` is resisted by this boss, `wave_laser` counters it (via the
    // `waveLaser` ring spelling) — the marks are on the rendered rows.
    const weak = scene.getRows().find((row) => row.key === 'buy:spread')!;
    expect(weak, 'spread unlock row').toBeDefined();
    expect(weak.matchup).toBe('weak');
    expect(weak.label).toContain(HANGAR_WEAK_MARKER);

    const strong = scene.getRows().find((row) => row.key === 'buy:wave_laser')!;
    expect(strong, 'wave_laser unlock row').toBeDefined();
    expect(strong.matchup).toBe('strong');
    expect(strong.label).toContain(HANGAR_STRONG_MARKER);

    // The loadout selector carries the same verdicts.
    const loadout = scene.getRows().find((row) => row.key === 'weapon:spread')!;
    expect(loadout.matchup).toBe('weak');
    expect(loadout.label).toContain(HANGAR_WEAK_MARKER);

    // Read-only: the intel and marks change nothing the screen can activate.
    expect(scene.getRows().every((row) => !row.actionable)).toBe(true);
    expect(scene.getRows().every((row) => row.text.input === null)).toBe(true);
  });

  it('renders the owned-row upgrade affordance through the same shared model (parent AC3, AC6)', async () => {
    // A seeded permanent weapon level (the shape a hangar purchase writes
    // through `buyHangarUpgrade`) renders through the shipped model builder and
    // renderer — the gym owns no second upgrade path, and it stays read-only.
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.hangar.weaponLevels = [{ id: 'spread', level: 2 }];
    const scene = await bootHangar({ payload });

    const shipped = buildHangarScreenModel(payload);
    expect(scene.getModel()).toEqual(shipped);
    const row = scene
      .getModel()
      .unlockRows.find((entry) => entry.id === 'spread')!;
    expect(row.state).toBe('upgradable');
    expect(row.label).toBe('Spread — LV 2/5 — UPGRADE · 200 min · 1 cores');
    // The model reports the row actionable, exactly as the game's does; the
    // read-only render still activates nothing (no handlers), so a watcher can
    // never buy or upgrade from the gym.
    expect(row.actionable).toBe(true);
    const rendered = scene.getRows().find((entry) => entry.key === 'buy:spread')!;
    expect(rendered.label).toBe(row.label);
    expect(rendered.actionable).toBe(false);
    expect(rendered.text.input).toBeNull();
    expect(scene.getPayload()).toEqual(payload);
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

  it('hides the ring-1 grant-only reward from the shop until it is granted', async () => {
    // Before the ring-1 special mission is secured, `hull-4` is not for sale:
    // no purchase row exists, so the hull can only arrive through the mission.
    const scene = await bootHangar({ payload: VALID_HANGAR_WAR_PAYLOAD });
    expect(
      scene.getModel().unlockRows.some((entry) => entry.id === 'hull-4'),
    ).toBe(false);
    expect(
      scene.getModel().hullOptions.some((option) => option.id === 'hull-4'),
    ).toBe(false);
  });

  it('shows the granted Vanguard Hull as an owned unlock (AH-0MWJ51KUS005WQK6)', async () => {
    // The ring-1 special sits on a fortress, so the shipped capture cycle
    // needs its two passes; the hull lands in the owned set on the second.
    const ringOne: HangarWarPayload = {
      ...VALID_HANGAR_WAR_PAYLOAD,
      ring: createRingState(1, HEX_RING_DEFINITIONS),
    };
    const capture = (payload: HangarWarPayload) =>
      resolveHexCapture(payload, {
        hexId: 'hex-r1-5',
        defenderHullId: 'hull-1',
        salvage: runSalvageFromRun({
          runId: 'gym-hangar-r1',
          checkpointId: 'boss-victory',
          minerals: 0,
          cores: 0,
        }),
        definitions: HEX_RING_DEFINITIONS,
        banked: bankedSalvageFromHangar(payload.hangar),
      });
    const firstPass = capture(ringOne);
    const secured = capture(firstPass.payload);
    expect(secured.ok).toBe(true);
    expect(secured.payload.hangar.unlockedHulls).toContain('hull-4');

    const scene = await bootHangar({ payload: secured.payload });
    const row = scene.getModel().unlockRows.find((entry) => entry.id === 'hull-4');

    expect(row, 'hull-4 unlock row not rendered').toBeDefined();
    expect(row!.name).toBe('Vanguard Hull');
    // Owned, not buyable: it arrived through the special mission.
    expect(row!.actionLabel).toBe('OWNED');
    expect(row!.actionable).toBe(false);
    // The reward is also a deployable hull option (it is a real ship).
    expect(
      scene.getModel().hullOptions.some((option) => option.id === 'hull-4'),
    ).toBe(true);
  });

  it('lists the authored power-up unlock rows read-only (AH-0MWKT12BT001106T)', async () => {
    // The tree's fourth purchasable kind flows through the **same** shared
    // hangar screen model the game renders; the gym adds no purchase path and
    // no second renderer, so it lists the identical power-up rows read-only.
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    const scene = await bootHangar({ payload });
    const shipped = buildHangarScreenModel(payload);

    expect(scene.getModel()).toEqual(shipped);

    const powerUpRows = scene
      .getModel()
      .unlockRows.filter((row) => (row.kind as string) === 'power-up');
    // The catalogue authors at least one power-up unlock (AC2/Q3 = (1)).
    expect(powerUpRows.length).toBeGreaterThan(0);

    for (const row of powerUpRows) {
      const rendered = scene
        .getRows()
        .find((entry) => entry.key === `buy:${row.id}`);
      expect(rendered, `power-up row buy:${row.id}`).toBeDefined();
      // Read-only: the gym renders the row but never makes it actionable.
      expect(rendered!.label).toBe(row.label);
      expect(rendered!.actionable).toBe(false);
      expect(rendered!.text.input).toBeNull();
    }
    expect(scene.getPayload()).toEqual(payload);
  });
});

/**
 * The apply-suggested-buildout row the auto-loadout epic adds to the shared
 * model (AH-0MWOWDWAG007MBY1, parent AH-0MWOROJYT004WPSD).
 *
 * RED until the model slice (AH-0MWOWEF3Q008BO5J) publishes the row and the
 * screen slice (AH-0MWOWEPO2004B0MR) renders it. The gym must render the
 * **identical** model read-only: the row is present, carries the same label,
 * activates nothing and is absent from the gym's interactive focus order.
 * The new export is loaded through a non-literal specifier so `tsc --noEmit`
 * stays clean while `BUILDOUT_ROW_KEY` does not exist yet.
 */
interface HangarBuildoutRowRenderContract {
  readonly key: string;
  readonly label: string;
  readonly actionable: boolean;
}

interface HangarModelWithBuildout {
  readonly suggestedLoadout: { readonly startingWeapons: readonly string[] };
  readonly buildoutRow: HangarBuildoutRowRenderContract;
}

/** Non-literal specifier: TypeScript never resolves the absent export. */
const HANGAR_SCREEN_MODULE = '../hangarWar/hangarScreen';

interface HangarScreenBuildoutExport {
  readonly BUILDOUT_ROW_KEY?: string;
}

describe('GymHangar — apply suggested buildout row is rendered read-only (AH-0MWOWDWAG007MBY1)', () => {
  let booted: BootedGame | null = null;

  async function bootHangar(data?: object): Promise<GymHangar> {
    booted = await reuse.boot([GymHangar]);
    booted.game.scene.start(GYM_HANGAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(GYM_HANGAR_SCENE_KEY) as GymHangar;
  }

  /** The authored ring 1 with every catalogue kind owned and `spread` picked. */
  function authoredPayload(): HangarWarPayload {
    const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
    payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
    payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3', 'hull-4'];
    payload.hangar.unlockedWeapons = [
      'spread',
      'wave_laser',
      'ricochet',
      'cluster',
    ];
    payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
    payload.hangar.activeHull = 'hull-1';
    payload.hangar.activeLoadout = {
      startingWeapons: ['spread'],
      modifiers: [],
    };
    payload.hangar.bankedMinerals = 0;
    payload.hangar.bankedCores = 0;
    return payload;
  }

  it('renders the identical model with the buildout row present but non-actionable', async () => {
    const { BUILDOUT_ROW_KEY } = (await import(
      HANGAR_SCREEN_MODULE
    )) as HangarScreenBuildoutExport;
    expect(typeof BUILDOUT_ROW_KEY).toBe('string');

    const payload = authoredPayload();
    const scene = await bootHangar({ payload });

    // One shared model: the gym is the game's model, buildout row included.
    expect(scene.getModel()).toEqual(buildHangarScreenModel(payload));
    const model = scene.getModel() as unknown as HangarModelWithBuildout;
    expect(model.suggestedLoadout.startingWeapons.length).toBeGreaterThan(0);
    expect(model.buildoutRow.key).toBe(BUILDOUT_ROW_KEY);

    const rendered = scene
      .getRows()
      .find((row) => row.key === BUILDOUT_ROW_KEY);
    expect(rendered, 'buildout row not rendered').toBeDefined();
    expect(rendered!.label).toBe(model.buildoutRow.label);
    expect(rendered!.label).toContain('APPLY SUGGESTED BUILDOUT');

    // Read-only: the gym can never apply the suggestion.
    expect(rendered!.actionable).toBe(false);
    expect(rendered!.text.input).toBeNull();
    // The row is absent from the gym's interactive focus order: a read-only
    // render makes no row focusable, so the key can never be reached.
    const focusableKeys = scene
      .getRows()
      .filter((row) => row.actionable)
      .map((row) => row.key);
    expect(focusableKeys).not.toContain(BUILDOUT_ROW_KEY);
  });
});

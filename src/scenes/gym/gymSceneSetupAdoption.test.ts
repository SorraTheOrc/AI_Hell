/**
 * Scripted-scene `setup` adoption across the gyms (AH-0MVRMHYJR000Y9H8).
 *
 * Every `CombatScene`/`CombatCoreScene`-derived gym (and the curve editor)
 * consumes the one shared `applySceneSetup` applier and `resolveSetupSeed`
 * through `CombatCoreScene._adoptCaptureSetup`. These tests pin, per gym, that:
 *
 * - a supplied setup's player loadout and power-up levels are live in the
 *   scene's first observed frame (AC2);
 * - a supplied seed re-seeds the scene's content RNG, so the same setup
 *   reproduces the same content (AC2) — sampled through the actual seeded
 *   content where the gym has random content, and through the live content
 *   stream where it does not;
 * - no setup is a no-op: the historical bare-cannon loadout and the dynamic
 *   `Math.random` stream are unchanged (AC3).
 *
 * `GymCurveSequencer` has no player and no intrinsic random content; its
 * adoption is pinned by the end-to-end test at the bottom: a setup supplied to
 * the editor is forwarded to the `GymLevel` it launches, where the loadout and
 * the seeded mineral field take effect (AC1/AC4).
 *
 * Uses the shared deterministic boot harness (README § Testing conventions).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../../test/gameHarness';
import { createSeededRng } from '../../core/rng';
import { DEFAULT_CONFIG } from '../../core/config';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import type { Player } from '../../entities/Player';
import type { SceneSetupState } from '../core/sceneSetup';
import { GymPlayer } from './GymPlayer';
import { GymWeapons } from './GymWeapons';
import { GymFodderEnemies } from './GymFodderEnemies';
import { GymPowerUpsCombat } from './GymPowerUpsCombat';
import { GymPowerUpsUtility } from './GymPowerUpsUtility';
import { GymWeaponLeveling } from './GymWeaponLeveling';
import { GymPowerUpLeveling } from './GymPowerUpLeveling';
import {
  CURVE_LAUNCH_LEVEL_LABEL,
  GymCurveSequencer,
} from './GymCurveSequencer';
import { GymLevel } from './GymLevel';

vi.setConfig({ testTimeout: 60000 });

/** Determinism seed used by the adoption tests. */
const SEED = 0x5eed_1234;

/** A setup touching the three fields every setup-capable gym consumes. */
const SETUP: SceneSetupState = {
  player: { weapons: ['rapid'], timedWeapons: [] },
  powerUps: { shield: 2 },
  seed: SEED,
};

/** The player + content-RNG surface the shared adoption helper provides. */
interface SetupAwareScene extends Phaser.Scene {
  getPlayer(): Player | null;
  getContentRng(): () => number;
}

/** A world position, optionally wrapped in the leveling gyms' mineral record. */
type MaybeWrappedPosition =
  | { x: number; y: number }
  | { entity: { x: number; y: number } };

/** Rounded world positions of a gym's content, for run-to-run comparison. */
function positions(items: readonly MaybeWrappedPosition[]): Array<[number, number]> {
  return items.map((item) => {
    const point = 'entity' in item ? item.entity : item;
    return [Math.round(point.x), Math.round(point.y)] as [number, number];
  });
}

/**
 * One row per setup-capable gym. `sampleContent` draws a fresh sample of the
 * gym's seeded content; when omitted the gym has no random content, so the
 * live content stream itself is compared against the seeded stream.
 */
interface GymCase {
  name: string;
  Class: new () => SetupAwareScene;
  sampleContent?: (scene: SetupAwareScene) => unknown;
}

const GYM_CASES: readonly GymCase[] = [
  {
    name: 'GymPlayer',
    Class: GymPlayer,
  },
  {
    name: 'GymWeapons',
    Class: GymWeapons,
  },
  {
    name: 'GymPowerUpsCombat',
    Class: GymPowerUpsCombat,
  },
  {
    name: 'GymPowerUpsUtility',
    Class: GymPowerUpsUtility,
    sampleContent: (scene) =>
      positions((scene as GymPowerUpsUtility).getMinerals()),
  },
  {
    name: 'GymWeaponLeveling',
    Class: GymWeaponLeveling,
    sampleContent: (scene) => {
      const gym = scene as GymWeaponLeveling;
      // Two draws from the live content stream: the seeded positions must
      // reproduce run to run, and diverge for a different seed.
      gym.spawnMineral();
      gym.spawnMineral();
      return positions(gym.getMinerals());
    },
  },
  {
    name: 'GymPowerUpLeveling',
    Class: GymPowerUpLeveling,
    sampleContent: (scene) => {
      const gym = scene as GymPowerUpLeveling;
      gym.spawnMineral();
      gym.spawnMineral();
      return positions(gym.getMinerals());
    },
  },
];

/**
 * One Phaser game shell per file, rebooted into a fresh scene instance per
 * test (AH-0MVF6VZG9000AN6E), matching the other gym suites.
 */
const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

let booted: BootedGame | null = null;

beforeEach(() => {
  document.body.innerHTML = '<div id="game-container"></div>';
  window.localStorage.clear();
  resetConfigStore();
  seedConfigStore(Object.values(DEFAULT_ENEMY_CONFIGS), DEFAULT_CONFIG);
});

afterEach(() => {
  booted = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * The launch-data shape the scenario tests use: the shared setup plus the
 * `GymFodderEnemies` roster selector (which lives outside the loadout schema).
 */
type BootSetup = SceneSetupState & { enemy?: string; enemyKey?: string };

/**
 * Boots `SceneClass`, restarts it with `setup` as its launch data (the same
 * path the capture director uses), and returns the settled scene.
 */
async function bootGym<T extends SetupAwareScene>(
  SceneClass: new () => T,
  setup?: BootSetup,
): Promise<T> {
  booted = await reuse.boot([SceneClass as unknown as typeof Phaser.Scene]);
  const manager = booted.game.scene;
  manager.start(SceneClass.name, setup);
  await advanceGame(booted.game, 200);
  return manager.getScene(SceneClass.name) as unknown as T;
}

describe.each(GYM_CASES)(
  '$name — scripted-scene setup adoption (AH-0MVRMHYJR000Y9H8)',
  ({ Class, sampleContent }) => {
    it('applies the setup loadout and power-up levels before the first frame', async () => {
      const scene = await bootGym(Class, SETUP);
      const player = scene.getPlayer();

      expect(player).not.toBeNull();
      // An explicit `player` overrides the gym's bare-cannon default.
      expect(player!.getActiveWeapons()).toEqual(['cannon', 'rapid']);
      expect(
        player!.getPowerUpLevelStore().getEffectiveLevel('shield'),
      ).toBe(2);
    });

    it('seeds the scene content RNG from the setup', async () => {
      const first = await bootGym(Class, SETUP);
      if (sampleContent) {
        const firstSample = sampleContent(first);
        const secondSample = sampleContent(await bootGym(Class, SETUP));
        expect(firstSample).toEqual(secondSample);

        const otherSeed = sampleContent(
          await bootGym(Class, { ...SETUP, seed: SEED + 1 }),
        );
        expect(otherSeed).not.toEqual(firstSample);
        return;
      }

      // No intrinsic random content: the live content stream itself must be
      // the seeded one (same seed ⇒ same stream from the same position).
      const rng = first.getContentRng();
      const expected = createSeededRng(SEED);
      expect([rng(), rng(), rng()]).toEqual([expected(), expected(), expected()]);
    });

    it('keeps the historical behaviour when no setup is supplied', async () => {
      const scene = await bootGym(Class);
      const player = scene.getPlayer();

      expect(player).not.toBeNull();
      expect(player!.getActiveWeapons()).toEqual(['cannon']);
      expect(
        player!.getPowerUpLevelStore().getEffectiveLevel('shield'),
      ).toBe(0);

      // No setup ⇒ the historical dynamic `Math.random` stream, not a seed.
      vi.spyOn(Math, 'random').mockReturnValue(0.375);
      expect(scene.getContentRng()()).toBe(0.375);
    });
  },
);

describe('GymCurveSequencer — setup adoption (AH-0MVRMHYJR000Y9H8)', () => {
  /** Finds the first "Launch Level" preview button. */
  function launchLevelButton(scene: GymCurveSequencer): Phaser.GameObjects.Text {
    const button = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.getData('curveLaunch') === true &&
        child.text === CURVE_LAUNCH_LEVEL_LABEL,
    );
    expect(button, 'no Launch Level button rendered').toBeDefined();
    return button!;
  }

  /**
   * Starts the editor with `setup`, launches its first level, and returns the
   * launched level gym plus the mineral field it seeded.
   */
  async function launchFirstLevel(
    setup: SceneSetupState,
  ): Promise<{ level: GymLevel; minerals: Array<[number, number]> }> {
    booted = await reuse.boot([GymCurveSequencer, GymLevel]);
    const manager = booted.game.scene;
    manager.start('GymCurveSequencer', setup);
    await advanceGame(booted.game, 150);

    const sequencer = manager.getScene('GymCurveSequencer') as GymCurveSequencer;
    launchLevelButton(sequencer).emit('pointerdown');
    await advanceGame(booted.game, 200);

    const level = manager.getScene('GymLevel') as GymLevel;
    return { level, minerals: positions(level.getMinerals()) };
  }

  it('forwards the setup to the launched GymLevel instead of ignoring it', async () => {
    const { level } = await launchFirstLevel(SETUP);
    const player = level.getPlayer();

    expect(player).not.toBeNull();
    expect(player!.getActiveWeapons()).toEqual(['cannon', 'rapid']);
    expect(player!.getPowerUpLevelStore().getEffectiveLevel('shield')).toBe(2);
  });

  it('forwards the resolved seed so the launched level is reproducible', async () => {
    const first = await launchFirstLevel(SETUP);
    const second = await launchFirstLevel(SETUP);

    expect(first.minerals.length).toBeGreaterThan(0);
    expect(second.minerals).toEqual(first.minerals);
  });
});

describe('gym scenario parameters (AH-0MVRMI0Q7001KG4Y)', () => {
  it('GymPlayer — obstacles:false omits the course, absent keeps it', async () => {
    const without = await bootGym(GymPlayer, { obstacles: false });
    expect(without.getObstacles()).toEqual([]);

    const withCourse = await bootGym(GymPlayer, { obstacles: true });
    const withCourseCount = withCourse.getObstacles().length;
    expect(withCourseCount).toBeGreaterThan(0);

    // Absent keeps the historical course exactly (no behaviour change).
    const historical = await bootGym(GymPlayer);
    expect(historical.getObstacles()).toHaveLength(withCourseCount);
  });

  it('GymWeapons — practiceTargets:false omits the targets, absent keeps them', async () => {
    const without = await bootGym(GymWeapons, { practiceTargets: false });
    expect(without.getTargets()).toEqual([]);

    const withTargets = await bootGym(GymWeapons, { practiceTargets: true });
    const withTargetsCount = withTargets.getTargets().length;
    expect(withTargetsCount).toBeGreaterThan(0);

    const historical = await bootGym(GymWeapons);
    expect(historical.getTargets()).toHaveLength(withTargetsCount);
  });

  it('GymPowerUpsCombat — applies the SHOOT state and threat-wave size', async () => {
    const configured = await bootGym(GymPowerUpsCombat, {
      shootEnabled: false,
      threatCount: 5,
    });
    expect(configured.shootingEnabled).toBe(false);
    expect(configured.getScouts()).toHaveLength(5);
    expect(configured.getScouts().every((scout) => scout.shootEnabled === false))
      .toBe(true);

    // Absent keeps the historical 3-scout, firing-by-default wave.
    const historical = await bootGym(GymPowerUpsCombat);
    expect(historical.shootingEnabled).toBe(true);
    expect(historical.getScouts()).toHaveLength(3);
  });

  it('GymPowerUpsUtility — applies the seeded mineral-field size', async () => {
    const empty = await bootGym(GymPowerUpsUtility, { minerals: 0 });
    expect(empty.getMinerals()).toEqual([]);

    const configured = await bootGym(GymPowerUpsUtility, { minerals: 12 });
    expect(configured.getMinerals()).toHaveLength(12);

    const historical = await bootGym(GymPowerUpsUtility);
    expect(historical.getMinerals().length).toBeGreaterThan(12);
  });

  it('formation gyms — applies the initial SHOOT state to HUD and entities', async () => {
    // A config-driven formation enemy (Scout) honours `shootEnabled`; the
    // Centipede deliberately ignores writes (it never fires), so it is not a
    // valid probe for this scenario parameter (AH-0MVRMI0Q7001KG4Y).
    const on = await bootGym(GymFodderEnemies, {
      enemy: 'scout',
      shootEnabled: true,
    });
    expect(on.shootingEnabled).toBe(true);
    const states = on.getEntityShootingStates();
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === true)).toBe(true);

    // Absent keeps the historical OFF start for the formation family.
    const historical = await bootGym(GymFodderEnemies, { enemy: 'scout' });
    expect(historical.shootingEnabled).toBe(false);
    expect(
      historical.getEntityShootingStates().every((state) => state === false),
    ).toBe(true);
  });
});

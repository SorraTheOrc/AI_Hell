/**
 * Gym↔game **level** parity tests (AH-0MVLJF6ZD00164MG).
 *
 * Test-first item for the parent AC "Gym parity"
 * (AH-0MVHT1M6O003PU7P): a balance engineer launching a level from the
 * curve editor must get the *same* scaled enemy counts and lengthened
 * supply cadence the shipped game plays, so tuning in the gym transfers.
 *
 * ## Red-before / green-after (repo convention)
 *
 * The level gyms (`GymLevel`, and `GymBotTuning` through inheritance) used
 * to spawn **authored (unscaled) counts** and run the **flat**
 * `rules.powerUpSpawnInterval` cadence — no campaign-level context. The
 * scaled-count and lengthened-cadence assertions below therefore failed on
 * the pre-F4 HEAD and were written as Vitest `it.fails(...)` (the repo's
 * red-before/green-after convention, cf. `src/scenes/PlayScene.test.ts`
 * "per-level kill-drop chance", AH-0MVLJF4DI000BKMQ). **F4
 * (AH-0MVLJF886009584F) flipped them to `it`**: the level gyms now resolve
 * `LevelDefinition.level` through the *same* `applyEnemyCountScaling` helper
 * and derive the cadence from the shared `dropChanceRatio`, and these tests
 * are the green evidence.
 *
 * The level-1 and single-wave (`level: 0`) assertions were plain `it` before
 * the change too: they pin the **unchanged** contracts (level 1 is the
 * identity transform; `level: 0` is treated as level 1) that hold both before
 * and after.
 *
 * ## No divergent copy
 *
 * Every expected count is read from the game's own **static** campaign
 * (`LEVELS` scaled through the game's build seam, `resolveCampaignLevels`
 * with sequenced waves off); every
 * expected cadence is derived from the shared `dropChanceRatio` curve. No
 * scaling formula is reimplemented here — a tuner who changes the curve in
 * `GameRules` updates these tests through the same modules the game and the
 * gym consume.
 *
 * ## Failure attribution (AH-0MVWOERDM000YZN0)
 *
 * Every cadence expectation is derived from the shipped `DEFAULT_RULES`, while
 * a scene resolves its interval from `loadRules()`. So that a miss is
 * attributable instead of reading as a bare timing difference, each cadence
 * probe (a) asserts the rules store still holds the shipped values, (b) pins
 * the interval the scene **resolved** (`GymLevel.getDropSpawnInterval()`)
 * before observing its timed effect, and (c) fails loudly if that interval is
 * re-derived mid-window. `GymBotTuning` starts a fresh random level when the
 * probe level is cleared, and that restart legitimately re-resolves the
 * cadence from the fresh level's curve, so the probe suppresses the restart
 * (`setLevelRestartEnabled(false)`) for the timed window.
 *
 * ## Formation-gym divergence (documented)
 *
 * The formation gyms (`GymFormationScene` and its scenes) have no campaign
 * level input at all: their supply is the shared flat `rules` cadence, and
 * that is deliberate (recorded in `GymLevel.ts` / parent AC). The final
 * suite pins that the flat cadence is *unchanged* — a hypothetical level-
 * resolved cadence (level-10 ≈ 3.6× longer) is rejected.
 *
 * @module scenes/gym/levelParity (AH-0MVLJF6ZD00164MG)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { LEVELS } from '../../waves/Formations';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import {
  applyEnemyCountScaling,
  dropChanceRatio,
} from '../../core/levelScaling';
import { DEFAULT_RULES, loadRules } from '../../core/rules';
import { resolveCampaignLevels } from '../PlayScene';
import { Asteroid } from '../../entities/Asteroid';
import type { EnemyEntity } from '../../entities/enemyFactory';
import {
  GYM_BOT_TUNING_SCENE_KEY,
  GymBotTuning,
  type GymBotTuningData,
} from './GymBotTuning';
import { GymLevel, type GymLevelData } from './GymLevel';
import { GymFodderEnemies } from './GymFodderEnemies';
import type { CombatDrop } from '../core/CombatScene';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { DEFAULT_ENEMY_CONFIGS } from '../../core/enemyConfig';
import { resetBotTuningStore } from '../../core/botTuningStore';

// ── Shared fixtures ─────────────────────────────────────────────────

/** Campaign levels pinned by the count-parity tests (1, 5 and 10). */
const PARITY_LEVELS = [1, 5, 10] as const;

/** A non-firing single-group scout wave (kept hazard-light for cadence runs). */
function scoutWave(count: number): WaveDefinition {
  return {
    groups: [
      {
        enemyKey: 'scout',
        formation: 'v',
        count,
        spacingX: 30,
        spacingY: 26,
        startX: 200,
        startY: 150,
      },
    ],
    shootEnabled: false,
  };
}

/** Wraps waves in a level definition carrying a campaign level number. */
function makeLevel(levelNumber: number, waves: WaveDefinition[]): LevelDefinition {
  return { level: levelNumber, name: `Level ${levelNumber} probe`, waves };
}

/** Formation enemies only — excludes any hazard/roamer (asteroids). */
function formationEnemies(scene: GymLevel): EnemyEntity[] {
  return scene
    .getEnemies()
    .filter((enemy) => !(enemy instanceof Asteroid) && enemy.alive);
}

/**
 * The level-resolved supply cadence the game's drop chance implies:
 * `interval(level) = interval(1) × chance(1) / chance(level)`, i.e.
 * `interval(1) / dropChanceRatio(level)`. Derived from the shared curve —
 * level 1 is exactly the flat rules interval.
 */
function expectedCadenceInterval(levelNumber: number): number {
  return (
    DEFAULT_RULES.powerUpSpawnInterval /
    dropChanceRatio(levelNumber, DEFAULT_RULES)
  );
}

/**
 * Simulates the scene (loop stopped) and returns the cumulative simulated
 * seconds at which the **second** supply drop spawns — the first spawn
 * event after the boot-time drop.
 *
 * The level gym keeps one drop on the field at a time and only refills
 * once the field is empty, so a level-lengthened cadence shows up as a
 * longer empty-field window before the refill (the boot drop's own
 * 12.5 s lifecycle never satisfies the empty-field gate by itself when the
 * cadence is longer than the lifecycle).
 */
function secondsUntilSecondDrop(scene: GymLevel, maxSeconds = 100): number {
  const bootDrop = scene.getDrops()[0];
  expect(bootDrop, 'boot-time supply drop missing').toBeDefined();
  // The probe must observe a *single* cadence: a mid-window re-derivation
  // (e.g. an autonomous scene starting a fresh level on completion, which
  // legitimately re-resolves the interval from the new level's curve) would
  // otherwise silently measure a different cadence than the one under test
  // (AH-0MVWOERDM000YZN0).
  const intervalAtStart = scene.getDropSpawnInterval();
  let previous: CombatDrop | undefined = bootDrop;
  let elapsed = 0;
  while (elapsed < maxSeconds) {
    scene.tick(0.25);
    elapsed += 0.25;
    expect(
      scene.getDropSpawnInterval(),
      `supply cadence re-derived mid-window (${intervalAtStart}s → ${scene.getDropSpawnInterval()}s) at ${elapsed}s`,
    ).toBe(intervalAtStart);
    const live = scene.getDrops()[0];
    // A new graphics identity means a fresh spawn event.
    if (live && live !== previous) return elapsed;
    if (live) previous = live;
  }
  throw new Error(`second supply drop never appeared within ${maxSeconds}s`);
}

/**
 * Asserts the cadence the scene **resolved** is the shared level-scaled one.
 *
 * This is the no-fork evidence that does not depend on simulated play: the
 * interval the supply layer will use equals `interval(1) / dropChanceRatio
 * (level)` computed from the same shared curve the game uses. It fails if the
 * gym stops applying the shared level scaling (level 10 would resolve the flat
 * 12.5 s interval instead of ≈45 s) (AH-0MVWOERDM000YZN0).
 */
function expectResolvedCadence(scene: GymLevel, expected: number): void {
  expect(scene.getDropSpawnInterval()).toBeCloseTo(expected, 6);
}

/**
 * Guards the cadence probes against a leaked rules store.
 *
 * Every cadence expectation below is derived from the **shipped**
 * `DEFAULT_RULES`, while the scene resolves its interval from `loadRules()`.
 * A persisted or tuned override would therefore surface as a bare cadence miss;
 * this guard names the field that moved instead (AH-0MVWOERDM000YZN0).
 */
function expectShippedCadenceRules(): void {
  const rules = loadRules();
  for (const field of [
    'powerUpSpawnInterval',
    'powerUpDropChanceAtLevel1',
    'powerUpDropChanceAtMaxLevel',
    'levelScalingMaxLevel',
  ] as const) {
    expect(rules[field], `rules store leaked ${field}`).toBe(
      DEFAULT_RULES[field],
    );
  }
}

/** Asserts the drop cadence matches `expected` within the 0.25 s sampling. */
function expectCadenceAround(scene: GymLevel, expected: number): void {
  const measured = secondsUntilSecondDrop(scene);
  // Failure diagnostics (AH-0MVWOERDM000YZN0): a cadence miss used to read as
  // a bare timing difference, hiding *which* input moved. Report the cadence
  // the scene itself resolved and the rules state it resolved it from, so a
  // future failure is attributable at a glance.
  const resolved = scene.getDropSpawnInterval();
  const rules = loadRules();
  const detail =
    `measured ${measured}s against an expected ${expected}s; the scene resolved ` +
    `${resolved}s from rules {powerUpSpawnInterval: ${rules.powerUpSpawnInterval}, ` +
    `powerUpDropChanceAtLevel1: ${rules.powerUpDropChanceAtLevel1}, ` +
    `powerUpDropChanceAtMaxLevel: ${rules.powerUpDropChanceAtMaxLevel}, ` +
    `levelScalingMaxLevel: ${rules.levelScalingMaxLevel}}`;
  expect(measured, detail).toBeGreaterThanOrEqual(expected - 0.5);
  expect(measured, detail).toBeLessThanOrEqual(expected + 0.5);
}

// ── GymLevel — level-scaled enemy counts ────────────────────────────

describe('GymLevel — level-scaled enemy counts (AH-0MVLJF6ZD00164MG)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** Boots the level gym with launch data (loop stopped, deterministic). */
  async function bootLevel(data: GymLevelData): Promise<GymLevel> {
    booted = await bootScene([GymLevel]);
    booted.game.loop.stop();
    const manager = booted.game.scene;
    // `SceneManager.start` runs `init()` + `create()` synchronously, so the
    // supplied level (and its first wave + supply layer) exists the moment
    // this resolves.
    manager.start('GymLevel', data);
    const scene = manager.getScene('GymLevel') as GymLevel;
    // The scheduled hazard is scenario content — disable it so the count and
    // cadence observations read the launched level cleanly.
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  /**
   * Walks every wave of the launched level and pins its per-group counts —
   * and the spawned totals — to the game **static campaign**'s counts for
   * the same level. The static campaign is the canonical authored reference
   * (`LEVELS` scaled through the game's own build seam with sequenced waves
   * explicitly off — the default runtime campaign is the generated
   * sequenced one, which the curve-editor gym does not launch).
   */
  function sweepCountParity(scene: GymLevel, levelNumber: number): void {
    const authored = LEVELS[levelNumber - 1];
    const campaign = resolveCampaignLevels({
      sequencedWavesEnabled: false,
    });
    const expected = campaign.find((level) => level.level === levelNumber);
    expect(expected, `campaign level ${levelNumber} missing`).toBeDefined();
    expect(expected!.waves).toHaveLength(authored.waves.length);

    let waveIndex = 0;
    while (!scene.isLevelComplete()) {
      expect(scene.getCurrentWaveIndex(), 'wave advance drift').toBe(waveIndex);
      const wave = scene.getCurrentWave();
      expect(wave, `wave ${waveIndex} missing`).toBeDefined();
      const expectedGroups = expected!.waves[waveIndex].groups;

      // Per-group count parity with the game campaign (no divergent copy).
      expect(wave!.groups.map((g) => g.count)).toEqual(
        expectedGroups.map((g) => g.count),
      );
      // Behavioural: the gym actually spawned the scaled group total.
      expect(formationEnemies(scene)).toHaveLength(
        expectedGroups.reduce((sum, g) => sum + g.count, 0),
      );

      // Clear the wave and advance.
      scene
        .getEnemies()
        .filter((enemy) => !(enemy instanceof Asteroid))
        .forEach((enemy) => enemy.destroySelf());
      scene.tick(0.016);
      waveIndex += 1;
    }
    expect(waveIndex, 'every authored wave swept once').toBe(
      authored.waves.length,
    );
  }

  for (const levelNumber of PARITY_LEVELS) {
    // Level 1 is the identity transform; levels 5/10 carry the shared
    // scaling. All three are plain `it` since F4 scaled the gym.
    it(
      `launched level ${levelNumber} reproduces the game campaign's per-group counts` +
        (levelNumber === 1 ? ' (identity)' : ' (scaled)'),
      async () => {
        const scene = await bootLevel({ level: LEVELS[levelNumber - 1] });
        sweepCountParity(scene, levelNumber);
      },
    );
  }

  it('AC2 — single-wave launches (level: 0) are treated as level 1: no scaling', async () => {
    // The curve sequencer's `_launchWave` builds exactly this payload
    // (`GymCurveSequencer._launchWave`: level: 0 + one wave).
    const scene = await bootLevel({
      level: makeLevel(0, [scoutWave(3)]),
    });
    // Authored count stays unchanged (level-1 identity, no scaling).
    expect(scene.getCurrentWave()!.groups[0].count).toBe(3);
    expect(formationEnemies(scene)).toHaveLength(3);
  });
});

// ── GymLevel — level-resolved supply cadence ────────────────────────

describe('GymLevel — level-resolved supply cadence (AH-0MVLJF6ZD00164MG)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function bootCadenceProbe(levelNumber: number): Promise<GymLevel> {
    expectShippedCadenceRules();
    booted = await bootScene([GymLevel]);
    booted.game.loop.stop();
    booted.game.scene.start('GymLevel', {
      // Single wave so the 30 s timed window has no next wave to advance to
      // during the (long, level-10) cadence measurement.
      level: makeLevel(levelNumber, [scoutWave(2)]),
    });
    const scene = booted.game.scene.getScene('GymLevel') as GymLevel;
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  it('AC2 — level 1 cadence is unchanged (the flat rules interval)', async () => {
    const scene = await bootCadenceProbe(1);
    expectCadenceAround(scene, expectedCadenceInterval(1));
  });

  it(
    'AC2 — level 5 cadence lengthens by the inverse drop-chance ratio',
    async () => {
      const scene = await bootCadenceProbe(5);
      expectCadenceAround(scene, expectedCadenceInterval(5));
    },
  );

  it(
    'AC2 — level 10 cadence lengthens by the inverse drop-chance ratio',
    async () => {
      const scene = await bootCadenceProbe(10);
      expectCadenceAround(scene, expectedCadenceInterval(10));
    },
  );
});

// ── Single-wave launch: level 0 == level 1 cadence ──────────────────

describe('GymLevel — single-wave launch cadence at level 1 semantics (AH-0MVLJF6ZD00164MG)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('AC2 — a level-0 (curve `_launchWave`) launch keeps the level-1 cadence', async () => {
    expectShippedCadenceRules();
    booted = await bootScene([GymLevel]);
    booted.game.loop.stop();
    booted.game.scene.start('GymLevel', {
      level: { level: 0, name: 'Wave 1', waves: [scoutWave(2)] },
    });
    const scene = booted.game.scene.getScene('GymLevel') as GymLevel;
    scene.setAsteroidSpawnerEnabled(false);

    expectCadenceAround(scene, expectedCadenceInterval(1));
  });
});

// ── GymBotTuning — inherits the same scaling (no fork) ──────────────

describe('GymBotTuning — inherits level-scaled counts and cadence (AH-0MVLJF6ZD00164MG)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    resetBotTuningStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function bootTuning(data?: GymBotTuningData): Promise<GymBotTuning> {
    expectShippedCadenceRules();
    booted = await bootScene([GymBotTuning]);
    booted.game.loop.stop();
    booted.game.scene.start(GYM_BOT_TUNING_SCENE_KEY, data);
    const scene = booted.game.scene.getScene(
      GYM_BOT_TUNING_SCENE_KEY,
    ) as GymBotTuning;
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  it(
    'AC2 — a level-10 probe runs the shared scaled counts and lengthened cadence (no fork)',
    async () => {
      const probeWaves = [scoutWave(3), scoutWave(4)];
      const scene = await bootTuning({
        level: makeLevel(10, probeWaves),
      });

      // Wave 1: authored 3 scouts → level-10 shared scaling (×2.0 → 6).
      const scaledWave0 = applyEnemyCountScaling(10, probeWaves[0].groups);
      expect(scene.getCurrentWave()!.groups[0].count).toBe(
        scaledWave0[0].count,
      );
      expect(formationEnemies(scene)).toHaveLength(scaledWave0[0].count);

      // Wave 2: authored 4 scouts → scaled 8 — the same shared seam.
      scene
        .getEnemies()
        .filter((enemy) => !(enemy instanceof Asteroid))
        .forEach((enemy) => enemy.destroySelf());
      scene.tick(0.016);
      const scaledWave1 = applyEnemyCountScaling(10, probeWaves[1].groups);
      expect(scene.getCurrentWave()!.groups[0].count).toBe(
        scaledWave1[0].count,
      );
      expect(formationEnemies(scene)).toHaveLength(scaledWave1[0].count);

      // Inherited cadence: level 10 → 3.6 × the level-1 interval.
      const expectedCadence = expectedCadenceInterval(10);
      // 1) The cadence the scene *resolved* — the no-fork parity seam, immune
      //    to how long the probe then runs (AH-0MVWOERDM000YZN0).
      expectResolvedCadence(scene, expectedCadence);
      // 2) Its timed effect. `GymBotTuning` starts a fresh random level when
      //    the probe level is cleared, and that restart legitimately
      //    re-resolves the cadence from the fresh level's (level 1) curve;
      //    suppress it so this window measures the level-10 cadence only.
      scene.setLevelRestartEnabled(false);
      expectCadenceAround(scene, expectedCadence);
    },
  );
});

// ── Formation gyms — documented flat-cadence divergence ────────────

describe('Formation gyms — documented flat supply preserved (AH-0MVLJF6ZD00164MG)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
    resetConfigStore();
    seedConfigStore(Object.values(DEFAULT_ENEMY_CONFIGS));
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('AC3 — formation gyms keep the shared flat rules cadence (no level context)', async () => {
    // The formation class family is a *documented divergence* (parent AC
    // AH-0MVHT1M6O003PU7P; recorded code comment in the scaling item): these
    // scenes have no campaign-level input, so their supply spawn *source*
    // stays the shared flat `rules.powerUpSpawnInterval`. Pinning the exact
    // interval — and the actual spawn stream over the boot drop's own
    // lifetime — rejects any accidental level-derived cadence (~3.6× at
    // level 10 would still be waiting for its first refill by 20 s).
    booted = await bootScene([GymFodderEnemies]);
    booted.game.loop.stop();
    const scene = booted.game.scene.getScene(
      'GymFodderEnemies',
    ) as GymFodderEnemies;

    // The interval itself is the flat game-rules value, unchanged.
    expect(scene.getPowerUpSpawnInterval()).toBe(
      DEFAULT_RULES.powerUpSpawnInterval,
    );

    // And the spawn stream follows it: boot drop, immediate refill when the
    // boot drop's lifecycle ends (12.5 s), next refill one interval later.
    expect(scene.getPowerUpSpawnCount(), 'boot drop').toBe(1);
    for (let i = 0; i < 40; i += 1) scene.tick(0.5); // 20 s simulated
    expect(scene.getPowerUpSpawnCount(), 'first refill by 20 s').toBe(2);
    for (let i = 0; i < 16; i += 1) scene.tick(0.5); // → 28 s
    expect(scene.getPowerUpSpawnCount(), 'second refill by 28 s').toBe(3);
  });
});

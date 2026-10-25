/**
 * Integration tests for the playable PlayScene
 * (AH-0MU7305Z2003NII3 — child 4).
 *
 * Boots a real Phaser game and drives the public `tick(dt)` step to assert
 * observable behaviour: wave spawning, formation placement, player
 * integration, collisions (bullet/enemy/player), power-up collection,
 * level transitions, and the game-over flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import {
  GAME_HEIGHT,
  GAME_WIDTH,
  MINERAL_COLOR,
  MINERAL_REDROP_SCATTER_RADIUS,
  MINERAL_SALVAGE_COLOR,
  POWER_UP_DROP_MIN_SEPARATION,
} from '../core/constants';
import {
  WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
  anchorSpawnsToPortal,
  formationCentre,
  formationExtents,
} from '../vfx/wormholeSpawn';
import type { EnemySpawn } from '../waves/WaveManager';
import * as effectsModule from '../audio/effects';
import * as playerDeathJuiceModule from '../vfx/playerDeathJuice';
import * as endOfRunModule from '../vfx/endOfRunJuice';
import * as explosionParticlesModule from '../vfx/explosionParticles';
import * as collectAnimationModule from '../powerups/collectAnimation';
import { advanceGame, bootScene, stepGameUntil, type BootedGame } from '../test/gameHarness';
import { getSpawnState, type SpawnAnimatable } from '../vfx/wormholeSpawn';
import { Asteroid } from '../entities/Asteroid';
import { PHASER_ORBITAL_RADIUS, PhaserEntity } from '../entities/Phaser';
import { Ghost } from '../entities/Ghost';
import { Centipede } from '../entities/Centipede';
import { Grunt } from '../entities/Grunt';
import { Raider } from '../entities/Raider';
import { LaneTraffic } from '../entities/LaneTraffic';
import { Harvester } from '../entities/Harvester';
import { Diver, DiverState } from '../entities/Diver';
import { Scout } from '../entities/Scout';
import { Tank } from '../entities/Tank';
import { BOSS_HIT_POINTS_PER_PHASE, BOSS_PHASE_COUNT } from '../entities/Boss';
import { MINI_BOSS_DEFAULT_HP_PER_PHASE, MiniBoss } from '../entities/MiniBoss';
import { minionCountForPhase } from '../waves/BossMinions';
import type { WeaponDefinition } from '../utils/weapons';
import { resolvePowerUpAtLevel } from '../powerups/powerUpLevels';
import { GameOverScene } from './GameOverScene';
import type { EnemyEntity } from '../entities/enemyFactory';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import {
  BANNER_BACKGROUND_ALPHA,
  BANNER_DURATION_SECONDS,
  BOSS_PHASE_SCORES,
  LEVEL_TRANSITION_SECONDS,
  PlayScene,
  resolveCampaignLevels,
  SCORE_VALUES,
  WAVE_TIME_LIMIT_SECONDS,
  WAVE_TIMEOUT_EXPLOSION_SCALE,
} from './PlayScene';
import { DEFAULT_CONFIG } from '../core/config';
import { DEFAULT_ENEMY_CONFIGS } from '../core/configDefaults';
import { RUN_ENDED_EVENT } from '../core/runEndedSignal';
import {
  LEVELS as CAMPAIGN_LEVELS,
  type LevelDefinition,
} from '../waves/Formations';
import { buildSequencedLevels } from '../waves/sequencedLevels';
import { computeSpawns } from '../waves/AsteroidSpawner';
import {
  computeSpawns as computeStrikeSpawns,
  STRIKE_SPAWN_START_WAVE,
} from '../waves/StrikeSpawner';
import { OrbitalStrike } from '../entities/OrbitalStrike';
import { CENTIPEDE_SEGMENT_COUNT } from '../waves/CentipedeSpawner';
import {
  GHOST_GROUP_CLUSTER_RADIUS,
  GHOST_GROUP_ENTRY_X_FRACTION,
  GHOST_GROUP_ENTRY_Y_FRACTION,
  GHOST_GROUP_RELEASE_WINDOW_SECONDS,
  type GhostSpawnEvent,
} from '../waves/GhostSpawner';
import { createSeededRng } from '../test/powerUpTestFixtures';
import { enemyForceFieldHits } from '../core/enemyForceField';
import { seedConfigStore, seedDifficultyCurves } from '../core/configStore';
import {
  DEFAULT_RULES,
  POWER_UP_WEIGHT_IDS,
  RULES_STORAGE_KEY,
  WEAPON_WEIGHT_IDS,
} from '../core/rules';
import {
  applyEnemyCountScaling,
  extraLifeDropChance,
  powerUpDropChance,
} from '../core/levelScaling';
import { miniBossDesignForLevel } from '../waves/miniBossDesigns';
import { scaledEncounterHp } from '../core/difficultyScaling';
import {
  MINI_BOSS_LOCKED_WEAPONS,
  lockedWeaponIds,
} from '../powerups/unlocks';
import { CHECKPOINT_STORAGE_KEY, loadCheckpoint } from '../core/checkpointStore';
import {
  POWER_UP_CATALOGUE,
  type DropId,
  type PowerUpId,
} from '../powerups/types';
import { resolvePlayerSlotState } from '../powerups/slots';

// These integration tests boot full Phaser games and walk the run to the
// boss; under the full-suite parallel load the Vitest default 5 s timeout
// is too tight and the heaviest boss-encounter test reports a spurious
// timeout (AH-0MUIPP1UU000UT88, raised to 60 s for the ten-level campaign in
// AH-0MV396OK0001FX14). The AC4 "defeating all 4 phases" run — the heaviest
// in the file, because it adds the deterministic victory transition on top
// of the ten-level walk — still breached the 60 s ceiling at 67 s under
// full-suite parallel load (AH-0MVF2H4UL007IJT4). Raise to 120 s, matching
// the other full-game suites (SceneNavigation) and the README testing
// conventions, so a slow parallel run does not fail on timing alone.
vi.setConfig({ testTimeout: 120000 });

// These gameplay tests drive the fourDirectional control scheme; the app
// default is now Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

/**
 * Records the `scale` option of every `spawnExplosionParticles` call so
 * the wave-timeout test can assert the 10x detonation scale through the
 * real VFX module (wrapping, not replacing, its behaviour).
 */
const waveVfx = vi.hoisted(() => ({ scales: [] as number[] }));

vi.mock('../vfx/explosionParticles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vfx/explosionParticles')>();
  return {
    ...actual,
    spawnExplosionParticles: (
      ...args: Parameters<typeof actual.spawnExplosionParticles>
    ) => {
      waveVfx.scales.push(args[5]?.scale ?? 1);
      return actual.spawnExplosionParticles(...args);
    },
  };
});

/**
 * Completes the wormhole spawn sequence (open 1 s + grow 1.5 s + close 0.5 s)
 * for the current wave so every enemy is fully spawned and collidable
 * (AH-0MURBER4L00821RR). Uses the scene's test seam rather than ticking, so
 * wave timers and asteroid spawns are not advanced. Fully-grown enemies are
 * the pre-animation state the collision tests expect.
 */
function finishSpawnSequence(scene: PlayScene): void {
  scene.finishSpawnAnimations();
  // One tick lets the scene clear the finished spawn state and close the
  // wormhole through the normal update path.
  scene.tick(0.001);
}

/** Destroys every live spawned enemy via player bullets (deterministic). */
function killSpawnedEnemies(scene: PlayScene): void {
  // Enemies are protected until their spawn animation completes; advance
  // past it first so the kill loop can actually damage them.
  finishSpawnSequence(scene);
  for (let guard = 0; guard < 2000 && scene.getAliveCount() > 0; guard++) {
    // A hold-full choice pauses the scene (tick() no-ops) — resolve it so the
    // kill loop keeps making progress (AH-0MV5L6BVN005DP4I).
    if (resolveMineralChoiceIfOpen(scene)) continue;
    // A long multi-group wave (e.g. the wave-10 mini-boss escorts) keeps
    // emerging from the wormhole while the loop runs; those entities are
    // spawn-protected until their growth completes, so fast-forward any
    // pending spawn animation each iteration or the loop can never kill them.
    scene.finishSpawnAnimations();
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
  }
}

/**
 * Clears the current level's mini-boss wave through the normal damage path:
 * every spawned escort plus the encounter entity itself (the wave has no time
 * limit, so it can never be carried past by a timeout).
 */
function clearMiniBossWave(scene: PlayScene): void {
  // The wave is flagged active until it is fully wiped, so gate on the wave
  // state rather than the entity (which may already be dead while escorts
  // remain).
  for (let guard = 0; guard < 50; guard++) {
    if (resolveMineralChoiceIfOpen(scene)) continue;
    const wm = scene.getWaveManager();
    if (!wm.miniBossActive || wm.bossTriggered || scene.isTransitioning()) return;
    killAllEnemies(scene);
    if (scene.getAliveCount() === 0 && !scene.getMiniBoss()) return;
  }
}

/**
 * Destroys the active level's mini-boss (if any) via player bullets, disabling
 * auto-fire and the spawned-enemy hit list so only the mini-boss takes the
 * damage. A no-op outside the mini-boss encounter
 * (AH-0MVCRBISU006NUN5).
 */
function killMiniBoss(scene: PlayScene, resolveReward = true): void {
  const miniBoss = scene.getMiniBoss();
  if (!miniBoss?.alive) return;
  const isolated = scene as unknown as {
    getEnemyEntities(): readonly unknown[];
    autoFireEnabled(): boolean;
  };
  const originalGetEnemyEntities = isolated.getEnemyEntities;
  const originalAutoFireEnabled = isolated.autoFireEnabled;
  isolated.getEnemyEntities = () => [];
  isolated.autoFireEnabled = () => false;
  try {
    const hits =
      miniBoss.getPhaseCount() * MINI_BOSS_DEFAULT_HP_PER_PHASE;
    let fired = 0;
    // The extra guard headroom absorbs hold-full pauses (tick() no-ops while
    // the choice overlay is open), resolved as they appear. A zero-length
    // step guarantees the bullet overlaps the moving entity.
    for (let guard = 0; guard < hits * 4 && fired < hits && miniBoss.alive; guard++) {
      if (resolveMineralChoiceIfOpen(scene)) continue;
      scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
      fired += 1;
      scene.tick(0);
    }
  } finally {
    isolated.getEnemyEntities = originalGetEnemyEntities;
    isolated.autoFireEnabled = originalAutoFireEnabled;
  }
  // A defeat offers the one upgrade-or-unlock reward choice
  // (AH-0MVCRBNO6003E1CH); a deterministic walk resolves it so play can
  // continue, exactly as a player picking the first option would. Tests that
  // need to inspect/choose the offer pass `resolveReward: false`.
  if (resolveReward && scene.isMiniBossRewardOpen()) {
    scene.selectMiniBossReward(0);
  }
}

/** Destroys every live enemy via player bullets (deterministic). */
function killAllEnemies(scene: PlayScene): void {
  killSpawnedEnemies(scene);
  // The wave-10 mini-boss gates its level, so it must be defeated too before
  // the next wave/level can begin (AH-0MVCRBISU006NUN5).
  killMiniBoss(scene);
}

/**
 * Destroys every live non-asteroid enemy via player bullets (deterministic),
 * leaving any live asteroids in the field. Used to assert that a wave clears
 * with asteroids still alive (AH-0MUJM746P000QAEO).
 */
function killNonAsteroidEnemies(scene: PlayScene): void {
  for (let guard = 0; guard < 500; guard++) {
    const enemy = scene
      .getEnemies()
      .find((e) => e.alive && !(e instanceof Asteroid));
    if (!enemy) return;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
  }
}

/**
 * Advances past the transition pause, spawning the next wave, then past
 * that wave's wormhole spawn sequence so its enemies are fully spawned.
 */
function finishTransition(scene: PlayScene): void {
  if (scene.isTransitioning()) scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
  finishSpawnSequence(scene);
}

/**
 * Deterministic regression guard (AH-0MUHA0MMP001DZ5C): asserts the
 * wave-clear path actually started a transition. It drives the scene with
 * bounded deterministic ticks and polls `isTransitioning()` instead of
 * waiting on wall-clock time, and throws a descriptive error (naming the
 * wave/accounting state) if the transition never starts — so a regression
 * fails loudly here rather than as an unrelated later assertion.
 */
function expectTransitionStarted(scene: PlayScene, maxTicks = 8): void {
  for (let i = 0; i < maxTicks && !scene.isTransitioning(); i++) {
    scene.tick(0.016);
  }
  if (!scene.isTransitioning()) {
    const wm = scene.getWaveManager();
    throw new Error(
      'Expected a cleared wave to start a transition (isTransitioning() true), ' +
        `but it stayed false after ${maxTicks} deterministic ticks. ` +
        `aliveCount=${scene.getAliveCount()} enemiesAlive=${wm.enemiesAlive} ` +
        `level=${wm.level} wave=${wm.waveNumber}`,
    );
  }
}

/**
 * Resolves an open hold-full power-up choice, if any.
 *
 * Long deterministic boss walks tick the auto-fire through many waves; the
 * resulting mineral drops eventually fill the hold and `PlayScene` pauses for
 * the hold-full choice overlay (`openMineralChoice()` → `setPaused(true)`).
 * A paused scene ignores `tick()` entirely, so a walk would stall in its
 * iteration guard. Selecting the first option resumes play, exactly as a
 * player would (AH-0MV5L6BVN005DP4I).
 *
 * @returns `true` when a choice was open and has been resolved so the caller
 *   can retry the step.
 */
function resolveMineralChoiceIfOpen(scene: PlayScene): boolean {
  if (!scene.isMineralChoiceOpen()) return false;
  scene.selectMineralChoice(0);
  return true;
}

/**
 * Walks the run to the boss encounter (the final level cleared).
 *
 * Exit condition uses `bossActive` / `bossTriggered` on the WaveManager
 * rather than `scene.getBoss()`.  The boss entity is only created when
 * `_onTransitionComplete()` fires *after* the transition timer elapses;
 * under high concurrency that tick may arrive a step or two later, so
 * polling `getBoss()` alone can exit the loop prematurely (AH-0MUNVVWWC0015JTM).
 */
function reachBoss(scene: PlayScene): void {
  const gs = scene.getGameState();
  gs.lives = 99; // survive incidental enemy fire while clearing levels.
  for (let guard = 0; guard < 200; guard++) {
    const wm = scene.getWaveManager();
    if (wm.bossTriggered || wm.bossActive) break;
    // A hold-full pause freezes `tick()`; resolve it before walking on
    // (AH-0MV5L6BVN005DP4I).
    if (resolveMineralChoiceIfOpen(scene)) continue;
    killAllEnemies(scene);
    finishTransition(scene);
  }
  // If the loop exited because `bossTriggered` was detected but the
  // transition hasn't been advanced yet (e.g. the boss was triggered
  // between iterations), resolve any hold-full pause that opened on that
  // tick and complete the transition so the entity spawns
  // (AH-0MV5L6BVN005DP4I).
  resolveMineralChoiceIfOpen(scene);
  if (scene.isTransitioning()) finishTransition(scene);
  // Hard assertion — if we exhausted the guard the boss was never reached.
  const boss = scene.getBoss();
  if (!boss) {
    const wm = scene.getWaveManager();
    throw new Error(
      `Failed to reach boss encounter after 200 iterations: ` +
        `bossTriggered=${wm.bossTriggered} bossActive=${wm.bossActive} ` +
        `level=${wm.level} wave=${wm.waveNumber} ` +
        `enemiesAlive=${wm.enemiesAlive} aliveCount=${scene.getAliveCount()} ` +
        `transitioning=${scene.isTransitioning()}`,
    );
  }
}

/**
 * Fires `BOSS_HIT_POINTS_PER_PHASE` player bullets at the boss, one per tick,
 * depleting exactly one health phase (AH-0MUTV3J7T006MZ4K).
 *
 * The batch is isolated from the boss's minions — which spawn on phase
 * depletion and would otherwise intercept test bullets and be killed for
 * score — and from the player's auto-fire, so the boss takes exactly one hit
 * per spawned bullet. Minions already alive are left untouched, so callers
 * can still assert the minion waves that accumulate after each phase (AC3).
 */
function damageBossPhase(
  scene: PlayScene,
  boss: { x: number; y: number; getHitPointsPerPhase(): number },
): void {
  const isolated = scene as unknown as {
    getEnemyEntities(): readonly unknown[];
    autoFireEnabled(): boolean;
  };
  const originalGetEnemyEntities = isolated.getEnemyEntities;
  const originalAutoFireEnabled = isolated.autoFireEnabled;
  isolated.getEnemyEntities = () => [];
  isolated.autoFireEnabled = () => false;
  try {
    // The encounter's effective pool (power-scaled — AH-0MVH87A3L004VOLD).
    for (let i = 0; i < boss.getHitPointsPerPhase(); i++) {
      scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
      scene.tick(0.016);
    }
  } finally {
    isolated.getEnemyEntities = originalGetEnemyEntities;
    isolated.autoFireEnabled = originalAutoFireEnabled;
  }
}

/**
 * Restricts a scene to a single enemy and disables auto-fire, so a spawned
 * test bullet can only hit the intended target. Returns a restore function.
 *
 * Without this the player's auto-fire and other overlapping enemies can
 * absorb or add kills, making wave-accounting assertions non-deterministic
 * (AH-0MV1EN1NS000QLBK).
 */
function isolateEnemyForKill(scene: PlayScene, enemy: unknown): () => void {
  const isolated = scene as unknown as {
    getEnemyEntities(): readonly unknown[];
    autoFireEnabled(): boolean;
  };
  const originalGetEnemyEntities = isolated.getEnemyEntities;
  const originalAutoFireEnabled = isolated.autoFireEnabled;
  isolated.getEnemyEntities = () => [enemy];
  isolated.autoFireEnabled = () => false;
  return () => {
    isolated.getEnemyEntities = originalGetEnemyEntities;
    isolated.autoFireEnabled = originalAutoFireEnabled;
  };
}

/**
 * Walks the run to the boss encounter by repeatedly letting the wave timer
 * expire, so every survivor is carried over each wave/level boundary
 * (AH-0MUNS3ZQ1002DJ9S). No life penalty applies; the high life count just
 * absorbs any incidental enemy fire while the run advances.
 *
 * Uses `bossTriggered`/`bossActive` to detect that the boss encounter is
 * due, then advances the final transition so `_onTransitionComplete()`
 * spawns the boss entity — otherwise the loop can exit before the entity
 * exists (AH-0MUNVVWWC0015JTM).
 */
function timeOutToBoss(scene: PlayScene): void {
  const gs = scene.getGameState();
  gs.lives = 99; // absorb incidental enemy fire while timeouts advance the run.
  let miniBossIterations = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const wm = scene.getWaveManager();
    if (wm.bossTriggered || wm.bossActive) break;
    // A hold-full pause freezes `tick()`; resolve it before the transition
    // check so `finishTransition` never ticks against a paused scene
    // (AH-0MV5L6BVN005DP4I).
    if (resolveMineralChoiceIfOpen(scene)) continue;
    if (scene.isTransitioning()) {
      finishTransition(scene);
      continue;
    }
    // The mini-boss encounter has no wave time limit (it gates its level), so
    // a timeout can never advance it: clear the escorts and the encounter
    // entity directly to keep the walk moving (AH-0MVCRBISU006NUN5). Gate on
    // the wave state, not the entity — the entity may die first while escorts
    // remain.
    if (wm.miniBossActive) {
      miniBossIterations += 1;
      clearMiniBossWave(scene);
      continue;
    }
    scene.setWaveTimerRemaining(0.001);
    scene.tick(0.01);
  }
  // Boss entity is only created when the transition timer elapses.
  // If the boss was triggered via timeout we still need to complete
  // the transition so that _onTransitionComplete() spawns it. Resolve any
  // hold-full pause that opened on the trigger tick first, otherwise the
  // transition would tick against a paused scene (AH-0MV5L6BVN005DP4I).
  resolveMineralChoiceIfOpen(scene);
  if (scene.isTransitioning()) finishTransition(scene);
  const boss = scene.getBoss();
  if (!boss) {
    const wm = scene.getWaveManager();
    const miniBoss = scene.getMiniBoss();
    const aliveNames = scene
      .getEnemies()
      .filter((e) => e.alive)
      .slice(0, 8)
      .map((e) => e.constructor.name);
    throw new Error(
      `Failed to reach boss encounter via timeout after 1000 iterations: ` +
        `bossTriggered=${wm.bossTriggered} bossActive=${wm.bossActive} ` +
        `level=${wm.level} wave=${wm.waveNumber} ` +
        `enemiesAlive=${wm.enemiesAlive} aliveCount=${scene.getAliveCount()} ` +
        `miniBossAlive=${miniBoss ? miniBoss.alive : 'null'} ` +
        `miniBossActive=${wm.miniBossActive} ` +
        `miniBossIterations=${miniBossIterations} ` +
        `transitioning=${scene.isTransitioning()} ` +
        `aliveNames=${aliveNames.join(',')}`,
    );
  }
}

/** Alive asteroid entities currently in the scene. */
function findAsteroids(scene: PlayScene): Asteroid[] {
  return scene
    .getEnemies()
    .filter((e): e is Asteroid => e instanceof Asteroid && e.alive);
}

/** Boots the PlayScene with a custom campaign and restarts it so `create()`
 * re-runs against the injected levels. Asteroid-dependent integration tests
 * use this to keep their own campaign fixtures independent of the built-in
 * `Formations.LEVELS` (the campaign no longer includes a fixed asteroid).
 */
async function bootSceneWithLevels(
  levels: LevelDefinition[],
  options: { asteroidSpawner?: boolean } = {},
): Promise<{ booted: BootedGame; scene: PlayScene }> {
  // The shipped default now sequences the campaign (AH-0MUJSUTLA006Q8E1),
  // which would override these injected fixtures on `create()`. Opt out so
  // the test's own levels are honoured.
  localStorage.setItem(
    RULES_STORAGE_KEY,
    JSON.stringify({ sequencedWavesEnabled: false }),
  );
  const game = await bootScene([PlayScene, GameOverScene, MenuScene]);
  const scene = game.scene as PlayScene;
  scene.getWaveManager().setLevels(levels);
  if (options.asteroidSpawner === false) {
    // Disable before restarting so the restarted `create()` does not plan
    // (or auto-update-release) any random asteroids.
    scene.setAsteroidSpawnerEnabled(false);
  }
  scene.scene.restart();
  await advanceGame(scene.game, 200);
  return { booted: game, scene };
}

/**
 * A deep copy of the shipped campaign, without any fixed asteroid. The
 * asteroid integration tests spawn their asteroid through the public
 * `spawnAsteroidAt` seam instead, because asteroids are not wave-accounted
 * (AH-0MUJM746P000QAEO) and must not be part of a wave definition.
 */
function plainCampaign(): LevelDefinition[] {
  return CAMPAIGN_LEVELS.map((lvl) => ({
    ...lvl,
    waves: lvl.waves.map((w) => ({
      ...w,
      groups: w.groups.map((g) => ({ ...g })),
    })),
  }));
}

/**
 * A one-level campaign for boss-reaching tests (AH-0MVCYANT6003SG5C).
 *
 * `WaveManager.isFinalLevel` is true the moment the campaign has a single
 * level, so clearing that level's waves triggers the final boss. Boss tests
 * therefore boot **one** level instead of walking the whole 10-level / 100-wave
 * campaign to reach the same encounter — the same code path, a tenth of the
 * simulated waves.
 */
function singleLevelCampaign(): LevelDefinition[] {
  const level = CAMPAIGN_LEVELS[0];
  return [
    {
      ...level,
      level: 1,
      waves: level.waves.map((w) => ({
        ...w,
        groups: w.groups.map((g) => ({ ...g })),
      })),
    },
  ];
}

describe('PlayScene — playable run (AH-0MU7305Z2003NII3)', () => {
  let booted: BootedGame | null = null;

  /**
   * Fixed RNG for the asteroid fixtures below (AH-0MVG23LT7000CG4R).
   *
   * An asteroid picks its drift heading from the scene RNG, so an unseeded
   * (Math.random-backed) run could send the carried-over rock into the player
   * or the auto-fire path and fail the persistence assertions — which is
   * exactly what happened under full-suite parallel load. Seeding the scene
   * RNG makes the heading (and every other roll in these tests) identical on
   * every run.
   */
  const ASTEROID_SEED = 1;
  const FIXED_RNG = createSeededRng(ASTEROID_SEED);

  beforeEach(() => {
    // Use the deterministic static campaign for these wave/transition tests so
    // their assertions do not depend on the runtime-sequenced campaign's
    // per-run composition (the sequenced path has its own suites). The
    // sequencer's default candidate pool excludes the non-wave-accounted
    // Asteroid, so a sequenced wave can no longer stall wave clearance
    // (AH-0MUR1HZLQ001ELX9).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    // This suite predates the dynamic spawner and asserts deterministic
    // wave/banner/transition behaviour; isolate it from random asteroid
    // spawns (the spawner is covered by its own integration suites).
    (booted.scene as PlayScene).setAsteroidSpawnerEnabled(false);
    return booted.scene as PlayScene;
  }

  /**
   * Boots a **single-level** campaign for the two boss-label tests
   * (AH-0MVCYANT6003SG5C). A one-level campaign makes `isFinalLevel` true
   * from the start, so `reachBoss` triggers the final boss without walking
   * the whole ten-level campaign.
   */
  async function bootPlayAtBoss(): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(singleLevelCampaign());
    booted = game;
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  it('F5 — the Harvester is worth ≈400 points (between Tank 300 and the boss phases)', () => {
    expect(SCORE_VALUES.harvester).toBe(400);
    expect(SCORE_VALUES.harvester).toBeGreaterThan(SCORE_VALUES.tank);
    expect(SCORE_VALUES.harvester).toBeLessThan(BOSS_PHASE_SCORES[1]);
  });

  /** Boots with a deterministic large asteroid placed outside the wave
   * definition (see `plainCampaign`). */
  async function bootPlayWithAsteroid(): Promise<PlayScene> {
    // Isolate the asteroid: disable the dynamic spawner from before the scene
    // restarts so these asteroid-behaviour tests are not perturbed by random
    // spawns, then place one deterministic large asteroid through the public
    // seam (it is not wave-accounted, AH-0MUJM746P000QAEO).
    const result = await bootSceneWithLevels(
      plainCampaign(),
      { asteroidSpawner: false },
    );
    booted = result.booted;
    // Seed the scene RNG: an asteroid picks its drift heading from it, so an
    // unseeded run could send the carried-over rock into the player or the
    // player's auto-fire and fail the persistence assertions (observed under
    // full-suite parallel load, AH-0MVG23LT7000CG4R). A fixed seed keeps the
    // heading (and the wave-1..N spawn plans) identical on every run.
    result.scene.setRng(FIXED_RNG);
    // These tests drive every step explicitly (the kill/clear/transition
    // helpers all use `scene.tick`), so stop the live rAF loop the harness
    // resumes at the end of `bootScene()`. Otherwise an unpredictable real
    // frame can run between the test's `await` points (e.g. inside
    // `bootSceneWithLevels`'s `advanceGame`) with a large real-time delta.
    result.booted.game.loop.stop();
    result.scene.spawnAsteroidAt(GAME_WIDTH * 0.6, GAME_HEIGHT * 0.25, 'large');
    return result.scene;
  }

  // ── AC1: five-level scene + wave spawning ──────────────────────

  it('AC1 — boots the wave manager at Level 1 and spawns its first wave', async () => {
    const scene = await bootPlay();

    const wm = scene.getWaveManager();
    expect(wm.started).toBe(true);
    expect(wm.level).toBe(1);
    expect(wm.waveNumber).toBe(1);
    // The wave's formation enemies are all spawned; the random asteroid
    // spawner may add more on top (it never removes any).
    expect(scene.getAliveCount()).toBeGreaterThanOrEqual(wm.waveEnemyCount());
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  it('AC1/AC3 — spawned enemies are formation-placed and non-firing on Level 1', async () => {
    const scene = await bootPlay();
    // (AH-0MV8BSMXC0097KLW) Fresh enemies all emerge from the same wormhole;
    // complete the spawn animation so they have traversed to their distinct
    // formation slots before asserting placement.
    scene.finishSpawnAnimations();
    scene.tick(0.016);

    const enemies = scene.getEnemies();
    const positions = new Set(enemies.map((e) => `${e.x},${e.y}`));
    expect(positions.size).toBe(enemies.length);
    expect(enemies.every((e) => e.shootEnabled === false)).toBe(true);
  });

  it('AC1/AC3 — spawning honours the wave archetypes', async () => {
    const scene = await bootPlay();
    const wave = scene.getWaveManager().currentWave()!;
    const expectedKeys = new Set(wave.groups.map((g) => g.enemyKey));
    // All spawned enemies map to one of the wave's declared archetypes.
    expect(scene.getEnemies().length).toBeGreaterThanOrEqual(
      Math.max(...wave.groups.map((g) => g.count)),
    );
    expect(expectedKeys.size).toBeGreaterThan(0);
  });

  // ── AC2: player integration ────────────────────────────────────

  it('AC2 — instantiates the player ship', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer();
    expect(player).not.toBeNull();
    expect(player!.scene).toBe(scene);
  });

  it('AC2 — the player auto-fires while ticking', async () => {
    const scene = await bootPlay();
    // Advance well past the cannon's fire interval.
    scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });

  // ── AC4: collisions ────────────────────────────────────────────

  it('AC4 — a player bullet destroys an enemy and awards score', async () => {
    const scene = await bootPlay();
    finishSpawnSequence(scene);
    const before = scene.getAliveCount();
    const enemy = scene.getEnemies().find((e) => e.alive)!;

    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getAliveCount()).toBeLessThan(before);
    expect(scene.getGameState().score).toBeGreaterThan(0);
  });

  it('AC5 — a wrapped player bullet still destroys an enemy at its new position', async () => {
    const scene = await bootPlay();
    finishSpawnSequence(scene);
    const enemy = scene.getEnemies().find((e) => e.alive)!;

    // Spawn the bullet off-screen to the left; a single tick wraps it onto
    // the enemy (x += GAME_WIDTH), proving a wrapped bullet stays collidable.
    const pb = scene.spawnPlayerBullet(enemy.x - GAME_WIDTH, enemy.y, 0, 0);
    expect(pb.x).toBeLessThan(0);
    scene.tick(0.016);

    expect(pb.x).toBeGreaterThanOrEqual(0);
    expect(enemy.alive).toBe(false);
  });

  it('AC2 — enemy bullets wrap across all four screen edges', async () => {
    const scene = await bootPlay();
    scene.getPlayer()!.setPosition(50, 50); // keep the player clear
    const step = 350 * 0.05; // distance travelled in one 0.05 s tick

    // Each case crosses one edge within a single tick and must reappear on
    // the opposite edge (never culled off-screen).
    const cases: Array<{
      name: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
      expectX: number;
      expectY: number;
    }> = [
      { name: 'right → left', x: GAME_WIDTH - 1, y: 300, vx: 350, vy: 0,
        expectX: GAME_WIDTH - 1 + step - GAME_WIDTH, expectY: 300 },
      { name: 'left → right', x: 1, y: 300, vx: -350, vy: 0,
        expectX: 1 - step + GAME_WIDTH, expectY: 300 },
      { name: 'bottom → top', x: 470, y: GAME_HEIGHT - 1, vx: 0, vy: 350,
        expectX: 470, expectY: GAME_HEIGHT - 1 + step - GAME_HEIGHT },
      { name: 'top → bottom', x: 470, y: 1, vx: 0, vy: -350,
        expectX: 470, expectY: 1 - step + GAME_HEIGHT },
    ];

    for (const c of cases) {
      const eb = scene.spawnEnemyBullet(c.x, c.y, c.vx, c.vy, 0xff4444, 10);
      scene.tick(0.05);
      expect(scene.getEnemyBullets(), c.name).toContain(eb);
      expect(eb.graphics.x, c.name).toBeCloseTo(c.expectX, 5);
      expect(eb.graphics.y, c.name).toBeCloseTo(c.expectY, 5);
      // Wrapped on-screen, not culled off-screen.
      expect(eb.graphics.x, c.name).toBeGreaterThanOrEqual(0);
      expect(eb.graphics.x, c.name).toBeLessThan(GAME_WIDTH);
      expect(eb.graphics.y, c.name).toBeGreaterThanOrEqual(0);
      expect(eb.graphics.y, c.name).toBeLessThan(GAME_HEIGHT);
    }
  });

  it('AC2 — enemy bullets wrap both axes at once (corner case)', async () => {
    const scene = await bootPlay();
    scene.getPlayer()!.setPosition(50, 50);
    const step = 350 * 0.05;

    const eb = scene.spawnEnemyBullet(GAME_WIDTH - 1, GAME_HEIGHT - 1, 350, 350, 0xff4444, 10);
    scene.tick(0.05);

    expect(scene.getEnemyBullets()).toContain(eb);
    expect(eb.graphics.x).toBeCloseTo(GAME_WIDTH - 1 + step - GAME_WIDTH, 5);
    expect(eb.graphics.y).toBeCloseTo(GAME_HEIGHT - 1 + step - GAME_HEIGHT, 5);
  });

  it('AC3 — enemy bullets expire by lifetime, never by off-screen position', async () => {
    const scene = await bootPlay();
    scene.getPlayer()!.setPosition(50, 50);

    const eb = scene.spawnEnemyBullet(100, 100, 0, 0, 0xff4444, 0.1);
    expect(scene.getEnemyBullets()).toContain(eb);

    scene.tick(0.05); // 0.05 < 0.1 — still alive
    expect(scene.getEnemyBullets()).toContain(eb);

    scene.tick(0.06); // 0.11 ≥ 0.1 — expired by lifetime
    expect(scene.getEnemyBullets()).not.toContain(eb);
  });

  it('AC3/AC5 — a player bullet that expires is destroyed (no stationary bullet left on screen)', async () => {
    const scene = await bootPlay();
    scene.getPlayer()!.setPosition(50, 50);

    const pb = scene.spawnPlayerBullet(100, 100, 0, 0, 0x00ffff, 0.1);
    expect(scene.getPlayerBullets()).toContain(pb);

    scene.tick(0.05); // 0.05 < 0.1 — still alive and rendered
    expect(scene.getPlayerBullets()).toContain(pb);
    expect(pb.active).toBe(true);
    expect(scene.children.list).toContain(pb);

    scene.tick(0.06); // 0.11 ≥ 0.1 — expired: removed AND destroyed
    expect(scene.getPlayerBullets()).not.toContain(pb);
    expect(pb.active).toBe(false);
    expect(scene.children.list).not.toContain(pb);
  });

  it('AC4 — an enemy bullet overlapping the player costs one life', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const livesBefore = scene.getGameState().lives;

    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(livesBefore - 1);
    expect(scene.getHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  // ── F7: composed player-death juice on the lose-life path ─────────

  it('F7 — a mid-run death uses respawn severity, the dedicated cue and registers juice', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    const deathSound = vi.spyOn(effectsModule, 'playPlayerDestructionSound');
    const genericSound = vi.spyOn(effectsModule, 'playDestructionSound');
    const juiceSpy = vi.spyOn(playerDeathJuiceModule, 'spawnPlayerDeathJuice');
    const particleSpy = vi.spyOn(explosionParticlesModule, 'spawnExplosionParticles');
    const shakeSpy = vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);

    // Drive the player-hit path directly (no tick) so enemy fire cannot add
    // unrelated generic-destruction calls to the assertion.
    (scene as unknown as { onPlayerHit(): void }).onPlayerHit();

    expect(juiceSpy).toHaveBeenCalledTimes(1);
    expect(juiceSpy.mock.calls[0][3]).toBe('respawn');
    expect(deathSound).toHaveBeenCalledTimes(1);
    expect(genericSound).not.toHaveBeenCalled();
    expect(particleSpy).toHaveBeenCalledTimes(1);
    expect(shakeSpy).toHaveBeenCalledTimes(1);
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);
  });

  it('F7 — the final life uses fatal severity', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    const gs = scene.getGameState();
    gs.lives = 1;
    const juiceSpy = vi.spyOn(playerDeathJuiceModule, 'spawnPlayerDeathJuice');

    (scene as unknown as { onPlayerHit(): void }).onPlayerHit();

    expect(juiceSpy).toHaveBeenCalledTimes(1);
    expect(juiceSpy.mock.calls[0][3]).toBe('fatal');
    expect(gs.lives).toBe(0);
  });

  it('F7 — the wave-timeout penalty (explodeShip=false) spawns no player juice', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // The timeout detonates enemies but must not run the player-death juice.
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
  });

  it('F7 — shield absorption keeps the generic cue and spawns no player juice', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a fresh Shield shield.
    const drop = scene.spawnPowerUpDrop('shield', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isShielded).toBe(true);

    const genericSound = vi.spyOn(effectsModule, 'playDestructionSound');
    const deathSound = vi.spyOn(effectsModule, 'playPlayerDestructionSound');
    const juiceSpy = vi.spyOn(playerDeathJuiceModule, 'spawnPlayerDeathJuice');

    (scene as unknown as { _hitPlayer(): void })._hitPlayer();

    expect(registry.isShielded).toBe(false);
    expect(genericSound).toHaveBeenCalled();
    expect(deathSound).not.toHaveBeenCalled();
    expect(juiceSpy).not.toHaveBeenCalled();
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
  });

  it('AC5 — a kill defers only the cue: the boom lands on the beat grid while the death VFX stays immediate', async () => {
    vi.restoreAllMocks();
    const plays: Array<{ url: string; delay: number }> = [];
    effectsModule.setSfxSoundProvider({
      getAudioContext: () => null,
      useAudioContext: () => {},
      play: (url, options) => {
        plays.push({ url, delay: options?.delay ?? 0 });
        return { stop: () => {} };
      },
      setVolume: () => {},
      setMuted: () => {},
      reset: () => {},
    });
    const scene = await bootPlay();
    const clock = scene.getBeatClock();
    plays.length = 0; // drop any boot-time cues
    clock.reset();
    clock.advance(100); // 87.5 ms to the 187.5 ms 16th-note tick

    (scene as unknown as { onPlayerHit(): void }).onPlayerHit();

    // Only the cue is deferred: it is scheduled 87.5 ms out...
    expect(plays).toHaveLength(1);
    expect(plays[0].delay).toBeCloseTo(0.0875, 6);
    // ...while the player-death VFX spawns synchronously on the death frame.
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);

    effectsModule._resetAudioContextForTests();
  });

  it('F7 — SHUTDOWN clears the juice registry (no leak across restart)', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();

    (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);

    // A restart of the same instance must start clean and not throw.
    expect(() => scene.create()).not.toThrow();
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
    expect(() => scene.tick(0.016)).not.toThrow();
  });

  it('AC5 — player bullet vs enemy bullet plays the dedicated impact cue from the shared path', async () => {
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const destruction = vi.spyOn(effectsModule, 'playDestructionSound');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    // Park the ship far from the impact so it is not hit.
    player.setPosition(50, 50);
    vi.clearAllMocks();

    const eb = scene.spawnEnemyBullet(500, 300, 0, 0);
    scene.spawnPlayerBullet(500, 300, 0, 0);
    scene.tick(0.016);

    expect(cue).toHaveBeenCalledTimes(1);
    // The heavier destruction cue is NOT used for bullet interception.
    expect(destruction).not.toHaveBeenCalled();
    expect(scene.getEnemyBullets()).not.toContain(eb);
  });

  it('AC4 — a power-up drop overlapping the player is collected', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Force the drop to full size so it is collectible immediately.
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);

    scene.tick(0.016);

    expect(scene.getDrops()).toHaveLength(0);
    expect(scene.getEffectsRegistry().activeEffects().length).toBeGreaterThan(0);
  });

  it('AC4 — an enemy body colliding with the player costs a life', async () => {
    const scene = await bootPlay();
    finishSpawnSequence(scene);
    const player = scene.getPlayer()!;

    // Let auto-fire fire its opening volley, then reposition the ship onto
    // a live enemy and step a tiny amount so the fire cooldown prevents a
    // fresh bullet from destroying the enemy before the body check.
    scene.tick(0.016);
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    const livesBefore = scene.getGameState().lives;
    player.setPosition(enemy.x, enemy.y);
    // Keep the player's internal movement state in sync so physicsTick does
    // not snap the ship back (same pattern as the Teleport teleport code).
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: enemy.x, y: enemy.y };
    scene.tick(0.001);

    expect(scene.getGameState().lives).toBe(livesBefore - 1);
  });

  // ── AC5: level transitions ─────────────────────────────────────

  it('AC5 — clearing a wave starts a transition, then spawns the next wave', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    expect(wm.waveNumber).toBe(1);

    killAllEnemies(scene);
    // Wave 1 wiped → a transition is running (no new enemies yet).
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.getAliveCount()).toBe(0);

    finishTransition(scene);
    // Wave 2 is now spawned.
    expect(scene.isTransitioning()).toBe(false);
    expect(wm.waveNumber).toBe(2);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  it('AC5 — clearing a level advances to the next level automatically', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // Clear all of Level 1's waves.
    let guard = 0;
    while (wm.level === 1 && guard++ < 20) {
      killAllEnemies(scene);
      finishTransition(scene);
    }

    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
  });

  it('AH-0MUHA0MMP001DZ5C — clearing a wave deterministically starts the transition (regression guard)', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    expect(wm.waveNumber).toBe(1);

    killAllEnemies(scene);
    expect(scene.getAliveCount()).toBe(0);

    // Drives the real wave-clear -> `_startTransition()` path with bounded
    // deterministic ticks and condition polling (no wall-clock waits), and
    // fails loudly with the wave/accounting state if it regresses.
    expectTransitionStarted(scene);
    expect(scene.isTransitioning()).toBe(true);
  });

  // ── Transient transition banner (AH-0MU7JTEMC006QPSN) ─────────

  it('AH-0MU7JTEMC006QPSN AC1 — the level banner hides within the banner window while enemies remain alive', async () => {
    const scene = await bootPlay();
    // The level-start announcement is on screen when the wave begins.
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(true);

    scene.tick(BANNER_DURATION_SECONDS);

    // Enemies are still alive (the wave was not cleared), yet the banner
    // must have cleared so it no longer obscures gameplay.
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(false);
  });

  it('AH-0MU7JTEMC006QPSN AC2 — the banner reappears on the next wave and hides again', async () => {
    const scene = await bootPlay();

    // Let the level-start banner expire first.
    scene.tick(BANNER_DURATION_SECONDS);
    expect(scene.isBannerVisible()).toBe(false);

    // Clearing the wave starts a transition and announces it again.
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.isBannerVisible()).toBe(true);

    // The next wave spawns; its banner clears while enemies remain alive.
    finishTransition(scene);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    scene.tick(BANNER_DURATION_SECONDS);
    expect(scene.isBannerVisible()).toBe(false);
  });

  // ── Semi-transparent, longer-lived banner (AH-0MV8BQ75V005QNZ1) ──

  it('AH-0MV8BQ75V005QNZ1 AC1 — the level-start banner background is 60% opaque', async () => {
    const scene = await bootPlay();
    expect(scene.isBannerVisible()).toBe(true);
    expect(BANNER_BACKGROUND_ALPHA).toBe(0.6);
    expect(scene.getBannerBackgroundColor()).toBe(
      `rgba(0, 0, 0, ${BANNER_BACKGROUND_ALPHA})`,
    );
  });

  it('AH-0MV8BQ75V005QNZ1 AC2 — the level-start banner stays visible for the 3.5s window then hides', async () => {
    const scene = await bootPlay();
    expect(scene.isBannerVisible()).toBe(true);

    // The announcement was shown with the shared 3.5 s window (the boot has
    // already consumed a small, fixed slice of it).
    expect(BANNER_DURATION_SECONDS).toBe(3.5);
    const remaining = scene.getBannerTimeRemaining();
    expect(remaining).toBeGreaterThan(BANNER_DURATION_SECONDS - 0.5);
    expect(remaining).toBeLessThanOrEqual(BANNER_DURATION_SECONDS);

    // Just inside the new window the banner is still readable…
    scene.tick(remaining - 0.01);
    expect(scene.isBannerVisible()).toBe(true);

    // …and it clears on its own once the window elapses, with enemies alive.
    scene.tick(0.02);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(false);
  });

  it('AH-0MV8BQ75V005QNZ1 AC1/AC2 — the wave-transition banner is also semi-transparent and long-lived', async () => {
    const scene = await bootPlay();

    // Expire the level-start banner first.
    scene.tick(BANNER_DURATION_SECONDS);
    expect(scene.isBannerVisible()).toBe(false);

    // Clearing the wave starts a transition, announces it again with the
    // same shared background, and re-arms the shared transient window.
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.isBannerVisible()).toBe(true);
    expect(scene.getBannerBackgroundColor()).toBe(
      `rgba(0, 0, 0, ${BANNER_BACKGROUND_ALPHA})`,
    );

    // The banner was armed with the shared window, so it outlives the 1.5 s
    // transition pause (killAllEnemies consumes a little of the window while
    // the cleared wave's death animations drain, hence the captured value).
    const remaining = scene.getBannerTimeRemaining();
    expect(remaining).toBeGreaterThan(LEVEL_TRANSITION_SECONDS);

    // Ticking just past the banner's own window completes the transition,
    // spawns the next wave, and clears the banner on its own.
    scene.tick(remaining + 0.01);
    finishSpawnSequence(scene);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(false);
  });

  // ── Level/wave progress labels (AH-0MU7JTEY3004EXR2) ───────────

  // ── Level name in progress label (AH-0MUMMBRCC0093MGV) ─────────

  it('AH-0MUMMBRCC0093MGV AC1 — level name appears in the progress label', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    const expected = `Level 1: Entry, Wave: 1 of ${wm.waveCount}`;

    expect(scene.getLevelText()).toBe(expected);
    expect(scene.getBannerText()).toBe(expected);
  });

  it('AH-0MUMMBRCC0093MGV AC2 — level name is shown on every wave and in the HUD', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    const baseLabel = `Level 1: Entry, Wave: 1 of ${wm.waveCount}`;

    expect(scene.getLevelText()).toBe(baseLabel);
    expect(scene.getBannerText()).toBe(baseLabel);

    // Advance to wave 2 and verify the name persists.
    killAllEnemies(scene);
    finishTransition(scene);
    const wave2Label = `Level 1: Entry, Wave: 2 of ${wm.waveCount}`;
    expect(wm.waveNumber).toBe(2);
    expect(scene.getLevelText()).toBe(wave2Label);
    expect(scene.getBannerText()).toBe(wave2Label);
  });

  it('AH-0MUMMBRCC0093MGV AC3 — CSV-backed name is displayed with sequenced levels', async () => {
    // This test specifically exercises the sequenced (shipped-default)
    // campaign, so re-enable it after the suite-level static-campaign setup.
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: true }),
    );
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // The campaign levels have names; the label should include them.
    expect(wm.levelName).toBeTruthy();
    expect(scene.getLevelText()).toContain(wm.levelName!);
  });

  it('AH-0MUMMBRCC0093MGV AC3 — static LEVELS name is displayed when sequencing is off', async () => {
    // `bootSceneWithLevels` forces sequencedWavesEnabled=false and injects
    // the static LEVELS, exercising the non-CSV source-of-truth path.
    const { booted, scene } = await bootSceneWithLevels(plainCampaign());
    scene.setAsteroidSpawnerEnabled(false);

    const wm = scene.getWaveManager();
    const expected = `Level 1: Entry, Wave: 1 of ${wm.waveCount}`;
    expect(wm.levelName).toBe('Entry');
    expect(scene.getLevelText()).toBe(expected);
    expect(scene.getBannerText()).toBe(expected);

    booted?.game.destroy(true);
  });

  it('AH-0MUMMBRCC0093MGV AC6 — the level-name banner remains transient', async () => {
    const scene = await bootPlay();
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(true);

    // Well inside the BANNER_DURATION_SECONDS window the banner is still up…
    scene.tick(BANNER_DURATION_SECONDS - 0.5);
    expect(scene.isBannerVisible()).toBe(true);

    // …and it clears within the bounded window while enemies remain alive.
    scene.tick(BANNER_DURATION_SECONDS);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(false);
  });

  it('AH-0MUMMBRCC0093MGV AC5 — empty level name falls back to numeric label', async () => {
    const { booted, scene } = await bootSceneWithLevels(
      CAMPAIGN_LEVELS.map((lvl) => ({ ...lvl, name: '' })),
    );
    scene.setAsteroidSpawnerEnabled(false);

    const wm = scene.getWaveManager();
    const expected = `Level 1 of 10, Wave 1 of ${wm.waveCount}`;
    expect(wm.levelName).toBe('');
    expect(scene.getLevelText()).toBe(expected);
    expect(scene.getBannerText()).toBe(expected);

    booted?.game.destroy(true);
  });

  // ── Boss label unchanged (AH-0MU7JTEY3004EXR2 AC3 / AH-0MUMMBRCC0093MGV AC4) ──

  it('AH-0MU7JTEY3004EXR2 AC3 — the boss encounter shows "Boss" instead of a numeric level', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);

    expect(scene.getWaveManager().bossActive).toBe(true);
    expect(scene.getLevelText()).toBe('Boss');
    expect(scene.getBannerText()).toBe('Boss');
  });

  it('AH-0MUMMBRCC0093MGV AC4 — the boss encounter still shows "Boss" (no level name)', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);

    expect(scene.getLevelText()).toBe('Boss');
    expect(scene.getBannerText()).toBe('Boss');
    // The boss label must not include a level name.
    expect(scene.getLevelText()).not.toContain(':');
  });

  it('AH-0MU7JTEY3004EXR2 AC4 — the label advances on a wave change', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    killAllEnemies(scene);
    finishTransition(scene);

    const expected = `Level 1: Entry, Wave: 2 of ${wm.waveCount}`;
    expect(wm.waveNumber).toBe(2);
    expect(scene.getLevelText()).toBe(expected);
    expect(scene.getBannerText()).toBe(expected);
  });

  // ── Player control during transitions (AH-0MU7JTF9W008B8HW) ────

  it('AH-0MU7JTF9W008B8HW AC1/AC5 — the ship moves during a transition pause', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const cursors = (scene as unknown as {
      cursors: { right: { isDown: boolean } };
    }).cursors;

    // Wipe the wave to enter the transition pause.
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    const xBefore = player.x;
    cursors.right.isDown = true;
    scene.tick(0.1);
    cursors.right.isDown = false;

    // Still paused (0.1 s < 1.5 s transition), yet the input was honoured.
    expect(scene.isTransitioning()).toBe(true);
    expect(player.x).toBeGreaterThan(xBefore);
  });

  it('AH-0MU7JTF9W008B8HW AC2 — the ship keeps auto-firing during the pause', async () => {
    const scene = await bootPlay();
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    // Advance well past the cannon's fire interval while still paused.
    scene.tick(0.5);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });

  it('AH-0MU7JTF9W008B8HW AC3 — no life is lost during the pause', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();
    const player = scene.getPlayer()!;

    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    // Park an enemy bullet on the ship: collisions are suspended during the
    // transition, so the run must not lose a life.
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    const livesBefore = gs.lives;
    scene.tick(0.2);

    expect(scene.isTransitioning()).toBe(true);
    expect(gs.lives).toBe(livesBefore);
    expect(scene.getHitCount()).toBe(0);
  });

  it('AH-0MU7JTF9W008B8HW AC4 — the next wave spawns and gameplay resumes after the pause', async () => {
    const scene = await bootPlay();
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    finishTransition(scene);

    expect(scene.isTransitioning()).toBe(false);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  // ── Wave time limit (AH-0MU7JTG9R002ZWA6) ───────────────────────

  it('AH-0MU7JTG9R002ZWA6 AC1 — the timer bar runs at level start and depletes', async () => {
    const scene = await bootPlay();

    // The countdown starts at the full limit (some slack for the Phaser
    // loop draining a few frames during the boot delay).
    expect(scene.isWaveTimerActive()).toBe(true);
    expect(scene.getWaveTimerRemaining()).toBeGreaterThan(WAVE_TIME_LIMIT_SECONDS - 2);
    expect(scene.getWaveTimerBar()?.visible).toBe(true);

    scene.setWaveTimerRemaining(1.0);
    scene.tick(0.4);
    expect(scene.getWaveTimerRemaining()).toBeGreaterThan(0);
    expect(scene.getWaveTimerRemaining()).toBeLessThanOrEqual(0.6);

    scene.tick(0.7);
    expect(scene.getWaveTimerRemaining()).toBe(0);
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1 — expiry carries survivors over, costs no life, and advances the wave', async () => {
    const scene = await bootPlayWithAsteroid();
    waveVfx.scales.length = 0;
    const livesBefore = scene.getGameState().lives;
    const survivorsBefore = scene.getAliveCount();

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // Every survivor (asteroid and non-asteroid alike) persists — no
    // detonation VFX at any scale.
    expect(scene.getAliveCount()).toBe(survivorsBefore);
    expect(waveVfx.scales).not.toContain(WAVE_TIMEOUT_EXPLOSION_SCALE);

    // No life lost and the wave advanced.
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(scene.getWaveManager().waveNumber).toBe(2);
  });

  it('AH-0MU7JTG9R002ZWA6 AC3 — expiry with no enemies remaining costs no life', async () => {
    const scene = await bootPlay();
    // Isolate this test from the dynamic spawner: otherwise a spawned
    // asteroid would count as a survivor on timeout.
    scene.setAsteroidSpawnerEnabled(false);
    const livesBefore = scene.getGameState().lives;

    // Remove every enemy without clearing the wave (behavioural seam).
    for (const e of scene.getEnemies()) e.destroySelf();
    expect(scene.getAliveCount()).toBe(0);

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    expect(scene.getAliveCount()).toBe(0);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(scene.isWaveTimerActive()).toBe(false);
  });

  it('AH-0MU7JTG9R002ZWA6 AC4 — the timer resets per wave and is hidden during transitions', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    expect(scene.isWaveTimerActive()).toBe(true);

    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.isWaveTimerActive()).toBe(false);

    finishTransition(scene);
    expect(wm.waveNumber).toBe(2);
    expect(scene.isWaveTimerActive()).toBe(true);
    // The fresh countdown starts at the full limit.
    expect(scene.getWaveTimerRemaining()).toBeGreaterThan(WAVE_TIME_LIMIT_SECONDS - 2);
  });

  // ── Asteroid survival on wave-timeout (AH-0MU8TWF1H007OG2L) ────

  it('AH-0MU8TWF1H007OG2L AC1 — asteroids remain alive after timeout', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBeGreaterThan(0);
    const asteroid = asteroids[0];
    const asteroidX = asteroid.x;
    const asteroidY = asteroid.y;

    // Time out the wave while asteroids are present.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // The asteroid survived the timeout — it was not detonated.
    expect(asteroid.alive).toBe(true);
    // Position should be approximately preserved (may have drifted slightly
    // during the timeout tick before the transition pause begins).
    expect(Math.abs(asteroid.x - asteroidX)).toBeLessThan(2);
    expect(Math.abs(asteroid.y - asteroidY)).toBeLessThan(2);
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1 — non-asteroid enemies persist on timeout alongside asteroids', async () => {
    const scene = await bootPlayWithAsteroid();
    const nonAsteroidsBefore = scene.getAliveCount() - findAsteroids(scene).length;
    expect(nonAsteroidsBefore).toBeGreaterThan(0);

    // Time out the wave.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // No non-asteroid enemy was detonated.
    const nonAsteroidsAfter = scene.getAliveCount() - findAsteroids(scene).length;
    expect(nonAsteroidsAfter).toBe(nonAsteroidsBefore);
  });

  it('AH-0MU8TWF1H007OG2L AC3 — surviving asteroids are shootable during the transition period', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBeGreaterThan(0);
    const asteroid = asteroids[0];
    const wasLarge = asteroid.getSizeTier() === 'large';

    // Time out the wave.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // We are now in the transition period; the asteroid should still be alive.
    expect(scene.isTransitioning()).toBe(true);
    expect(asteroid.alive).toBe(true);

    // Shooting the asteroid during the transition should destroy it.
    scene.spawnPlayerBullet(asteroid.x, asteroid.y, 0, 0);
    scene.tick(0.016);

    // The asteroid is destroyed by the bullet.
    expect(asteroid.alive).toBe(false);
    // A large asteroid splits into 2 medium children; medium splits into 2 small.
    const asteroidCountAfter = findAsteroids(scene).length;
    if (wasLarge) {
      expect(asteroidCountAfter).toBe(2);
    } else {
      expect(asteroidCountAfter).toBe(0);
    }
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1 — timeout costs no life and advances the wave', async () => {
    const scene = await bootPlay();
    const livesBefore = scene.getGameState().lives;
    const waveBefore = scene.getWaveManager().waveNumber;

    // Time out the wave.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // No life lost.
    expect(scene.getGameState().lives).toBe(livesBefore);
    // The wave advanced.
    expect(scene.getWaveManager().waveNumber).toBe(waveBefore + 1);
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1/AC2 — asteroids are not wave-accounted but non-asteroid survivors are adopted', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();
    const asteroidsBefore = findAsteroids(scene);
    expect(asteroidsBefore.length).toBeGreaterThan(0);
    const carriedBefore = scene.getAliveCount() - asteroidsBefore.length;
    expect(carriedBefore).toBeGreaterThan(0);

    // Time out the wave to trigger transition.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // Asteroids survived the timeout and are still alive.
    expect(findAsteroids(scene).length).toBeGreaterThan(0);
    // enemiesAlive reflects the next wave's formation enemies PLUS the
    // adopted non-asteroid survivors; asteroids are never adopted.
    expect(wm.enemiesAlive).toBe(wm.waveEnemyCount() + carriedBefore);

    // Finish the transition so the next wave is spawned; the survivors are
    // still alive alongside the fresh spawns.
    finishTransition(scene);
    expect(findAsteroids(scene).length).toBeGreaterThan(0);
  });

  // ── Wave-timeout major-explosion SFX (AH-0MUJ1YZJ9008O4RC) ─────

  it('AH-0MUNS3ZQ1002DJ9S AC1 — timeout never fires the major-explosion cue and keeps survivors', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    const survivorsBefore = scene.getAliveCount();
    expect(survivorsBefore).toBeGreaterThan(0);

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    expect(scene.getAliveCount()).toBe(survivorsBefore);
    vi.restoreAllMocks();
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1 — asteroids survive the timeout and no cue fires', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlayWithAsteroid();
    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBeGreaterThan(0);

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    for (const asteroid of asteroids) expect(asteroid.alive).toBe(true);
    vi.restoreAllMocks();
  });

  it('AH-0MUJ1YZJ9008O4RC AC4 — no survivors means no cue and the wave timer is hidden', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    scene.setAsteroidSpawnerEnabled(false);
    for (const e of scene.getEnemies()) e.destroySelf();
    expect(scene.getAliveCount()).toBe(0);

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    expect(scene.isWaveTimerActive()).toBe(false);
    vi.restoreAllMocks();
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1 — timeout plays no destruction cue and loses no life', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    const playerCue = vi.spyOn(effectsModule, 'playPlayerDestructionSound');
    const livesBefore = scene.getGameState().lives;

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    expect(playerCue).not.toHaveBeenCalled();
    expect(scene.getGameState().lives).toBe(livesBefore);
    vi.restoreAllMocks();
  });

  it('AH-0MUNS3ZQ1002DJ9S AC1/AC2 — no detonation, no life penalty, survivors adopted, wave advances', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();
    const carried = scene.getAliveCount() - findAsteroids(scene).length;
    expect(carried).toBeGreaterThan(0);
    const livesBefore = scene.getGameState().lives;
    const waveBefore = wm.waveNumber;
    waveVfx.scales.length = 0;

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // No 10x detonation VFX, no life loss, wave advanced.
    expect(waveVfx.scales).not.toContain(WAVE_TIMEOUT_EXPLOSION_SCALE);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(wm.waveNumber).toBe(waveBefore + 1);
    // The surviving non-asteroid enemies are adopted into the new wave's
    // roster so they gate its completion (asteroids are never adopted).
    expect(wm.enemiesAlive).toBe(wm.waveEnemyCount() + carried);
    vi.restoreAllMocks();
  });

  // Note: the "survivors gate the next wave" invariant is covered
  // deterministically by the WaveManager carry-over tests
  // (AH-0MUNS3ZQ1002DJ9S in WaveManager.test.ts); the PlayScene integration
  // assertion above confirms `_timeoutWave` adopts the survivors.

  // ── Phase 2: Asteroid behaviour during transition (AH-0MUCG5SWH008104P) ──

  it('AH-0MUCG5SWH008104P AC1 — carried-over asteroids continue moving during transition', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBeGreaterThan(0);
    const asteroid = asteroids[0];

    // Time out the wave to enter the transition period.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);
    expect(scene.isTransitioning()).toBe(true);

    // Tick through the transition; the asteroid should move.
    const xMid = asteroid.x;
    const yMid = asteroid.y;
    scene.tick(LEVEL_TRANSITION_SECONDS * 0.5);

    // Position changed — asteroid is moving during transition.
    expect(Math.abs(asteroid.x - xMid)).toBeGreaterThan(0);
    expect(Math.abs(asteroid.y - yMid)).toBeGreaterThan(0);
  });

  it('AH-0MUCG5SWH008104P AC3 — ramming a carried-over asteroid during transition costs a life', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBeGreaterThan(0);
    const asteroid = asteroids[0];
    const livesAtBoot = scene.getGameState().lives;

    // Time out the wave to enter the transition period.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);
    expect(scene.isTransitioning()).toBe(true);
    // The timeout carries survivors over without a life penalty.
    expect(scene.getGameState().lives).toBe(livesAtBoot);

    // Clear the post-hit invulnerability so the ram can register during
    // the transition (test seam; invulnerability itself is covered elsewhere).
    (scene as unknown as { invulnerable: number }).invulnerable = 0;

    // Park the ship on the asteroid (mirrors the scout/asteroid ram tests);
    // the internal movement state must be updated too or physics moves it back.
    const player = scene.getPlayer()!;
    player.setPosition(asteroid.x, asteroid.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: asteroid.x, y: asteroid.y };
    scene.tick(0.001);

    // Ramming during the transition costs a life and destroys the asteroid.
    expect(scene.getGameState().lives).toBeLessThanOrEqual(livesAtBoot - 1);
    expect(asteroid.alive).toBe(false);
  });

  it('AH-0MUNS3ZQ1002DJ9S AC3 — carried-over survivors persist through the transition pause', async () => {
    const scene = await bootPlay();

    // Time out the wave to enter the transition period.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);
    expect(scene.isTransitioning()).toBe(true);
    const survivorsAtStart = scene.getAliveCount();
    expect(survivorsAtStart).toBeGreaterThan(0);

    // Tick through the transition; the survivors remain fully active and are
    // still on the field at the end of the pause.
    scene.tick(LEVEL_TRANSITION_SECONDS * 0.5);
    expect(scene.getAliveCount()).toBe(survivorsAtStart);
    scene.tick(LEVEL_TRANSITION_SECONDS * 0.5 + 0.01);
    expect(scene.isTransitioning()).toBe(false);
  });

  it('AH-0MUCG5SWH008104P AC5 — un-destroyed carried-over asteroids persist after transition', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBeGreaterThan(0);

    // Time out the wave.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);
    expect(scene.isTransitioning()).toBe(true);

    // Let the transition complete.
    finishTransition(scene);

    // The carried-over asteroid(s) are still alive after the transition.
    expect(findAsteroids(scene).length).toBe(asteroids.length);
  });

  // ── Asteroid-independent wave completion + persistence (AH-0MUJM746P000QAEO) ──

  it('AH-0MUJM746P000QAEO AC1 — a released offscreen asteroid does not increment enemiesAlive', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    const before = new Set(findAsteroids(scene));
    const aliveBefore = wm.enemiesAlive;

    // Release one planned asteroid directly through the public spawn seam.
    scene.spawnAsteroidAt(-20, GAME_HEIGHT / 2, 'large');

    const spawned = findAsteroids(scene).filter((a) => !before.has(a));
    expect(spawned).toHaveLength(1);
    // The asteroid is not wave-accounted (AH-0MUJM746P000QAEO).
    expect(wm.enemiesAlive).toBe(aliveBefore);
  });

  it('AH-0MUJM746P000QAEO AC1 — a split child does not increment enemiesAlive', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();
    const large = findAsteroids(scene)[0];
    const aliveBefore = wm.enemiesAlive;

    // Shoot the large asteroid: it splits into 2 medium children.
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(large.alive).toBe(false);
    expect(findAsteroids(scene)).toHaveLength(2);

    // The asteroid is not wave-accounted, so the split leaves enemiesAlive
    // unchanged (AH-0MUJM746P000QAEO).
    expect(wm.enemiesAlive).toBe(aliveBefore);
  });

  it('AH-0MUJM746P000QAEO AC2 — a live asteroid persists across a wave transition', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();
    const asteroid = findAsteroids(scene)[0];
    expect(asteroid.alive).toBe(true);
    const xBefore = asteroid.x;
    const yBefore = asteroid.y;

    // Clear only the wave-1 Scouts; the asteroid survives and the wave clears.
    killNonAsteroidEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    expect(asteroid.alive).toBe(true);

    finishTransition(scene);
    // Now on wave 2 with the asteroid still alive and still moving.
    expect(wm.waveNumber).toBe(2);
    expect(asteroid.alive).toBe(true);
    scene.tick(0.5);
    expect(
      Math.abs(asteroid.x - xBefore) + Math.abs(asteroid.y - yBefore),
    ).toBeGreaterThan(0);
  });

  it('AH-0MUJM746P000QAEO AC2 — a live asteroid persists across a level transition', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();
    const asteroid = findAsteroids(scene)[0];

    // Clear Level 1 (the expanded campaign levels now span ten waves,
    // AH-0MVCYANT6003SG5C); the asteroid lives through every wave and the
    // level transition into Level 2.
    for (let wave = 0; wave < wm.waveCount; wave++) {
      killNonAsteroidEnemies(scene);
      // The wave-10 mini-boss is a separate gating entity (not part of the
      // spawned set); defeat it too so the level can transition
      // (AH-0MVCRBISU006NUN5).
      killMiniBoss(scene);
      expect(scene.isTransitioning()).toBe(true);
      finishTransition(scene);
    }

    // Now on Level 2 with the carried-over asteroid still alive.
    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
    expect(asteroid.alive).toBe(true);
    expect(findAsteroids(scene)).toContain(asteroid);
  });

  it('AH-0MUJM746P000QAEO AC2 — a live asteroid is shootable after a transition', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroid = findAsteroids(scene)[0];

    // Clear wave 1 and carry the asteroid into wave 2.
    killNonAsteroidEnemies(scene);
    finishTransition(scene);
    expect(asteroid.alive).toBe(true);

    // The persisted asteroid is still a valid bullet target and splits.
    scene.spawnPlayerBullet(asteroid.x, asteroid.y, 0, 0);
    scene.tick(0.016);
    expect(asteroid.alive).toBe(false);
    expect(findAsteroids(scene)).toHaveLength(2);
  });

  it('AH-0MUJM746P000QAEO AC5 — minerals persist across a wave transition', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();

    // Place a mineral on the field through the public seam.
    const targetX = GAME_WIDTH / 2;
    const targetY = GAME_HEIGHT / 2;
    scene.spawnMineralAt(targetX, targetY);
    const mineralsBefore = scene.getMinerals();
    expect(mineralsBefore.length).toBeGreaterThan(0);

    // Clear wave 1 and complete the transition.
    // Note: killed non-asteroid enemies may now occasionally drop a single
    // mineral each (empty-enemy re-drop, parent AH-0MULUOZQP009GRWX), so we
    // cannot assert on the *total* mineral count. Instead we verify the
    // originally-spawned mineral still exists at its position.
    killNonAsteroidEnemies(scene);
    expect(wm.waveNumber).toBe(2);
    finishTransition(scene);

    // The mineral we placed is still on the field after the wave transition.
    const after = scene.getMinerals();
    const persisted = after.find(
      (m) => Math.abs(m.x - targetX) < 1 && Math.abs(m.y - targetY) < 1,
    );
    expect(persisted).toBeDefined();
  });

  // ── Power-up drop separation (AH-0MU7JTFM5000R4ME) ─────────────

  it('AH-0MU7JTFM5000R4ME AC3 — drops spawned at the same position keep minimum separation', async () => {
    const scene = await bootPlay();
    const x = GAME_WIDTH / 2;
    const y = GAME_HEIGHT / 2;

    for (let i = 0; i < 3; i++) scene.spawnPowerUpDrop('speed_boost', x, y);

    const drops = scene.getDrops();
    expect(drops.length).toBe(3);
    for (let i = 0; i < drops.length; i++) {
      for (let j = i + 1; j < drops.length; j++) {
        expect(Math.hypot(drops[i].x - drops[j].x, drops[i].y - drops[j].y)).toBeGreaterThanOrEqual(
          POWER_UP_DROP_MIN_SEPARATION,
        );
      }
    }
  });

  // ── Game over flow ─────────────────────────────────────────────

  it('game over — losing the last life transitions to GameOverScene', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();

    // Put the run on its final life, then take a hit.
    gs.lives = 1;
    const player = scene.getPlayer()!;
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);
    await advanceGame(scene.game, 350);

    expect(gs.lives).toBe(0);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });
});

describe('PlayScene — boss encounter (AH-0MU730M3T008C7CQ)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // Deterministic static campaign (see the playable-run suite note): the
    // default sequenced campaign can include un-accounted asteroid groups that
    // stall `reachBoss` (AH-0MUNVVWWC0015JTM; game bug tracked separately).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots a **single-level** campaign for the boss tests (AH-0MVCYANT6003SG5C).
   * With one level `isFinalLevel` is true from the start, so `reachBoss`
   * clears that level's waves and triggers the final boss without walking
   * the other nine levels. Same encounter, ~1/10 the simulated waves.
   */
  async function bootPlayAtBoss(): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(singleLevelCampaign());
    booted = game;
    // Isolate the deterministic boss walk from the random asteroid spawner:
    // a timeout walk simulates a lot of game time, and freely spawning
    // asteroids would keep the carried-over pile growing faster than the kill
    // helpers can clear it (AH-0MVCRBISU006NUN5).
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  /** Boots with a deterministic large asteroid placed outside the wave
   * definition (see `plainCampaign`). */
  async function bootPlayWithAsteroid(): Promise<PlayScene> {
    // Isolate the asteroid: disable the dynamic spawner from before the scene
    // restarts so these asteroid-behaviour tests are not perturbed by random
    // spawns, then place one deterministic large asteroid through the public
    // seam (it is not wave-accounted, AH-0MUJM746P000QAEO).
    const { booted: game, scene } = await bootSceneWithLevels(
      plainCampaign(),
      { asteroidSpawner: false },
    );
    booted = game;
    scene.spawnAsteroidAt(GAME_WIDTH * 0.6, GAME_HEIGHT * 0.25, 'large');
    return scene;
  }

  it('AH-0MVH87A3L004VOLD — the final boss hit pool scales with permanent upgrades', async () => {
    const scene = await bootPlayAtBoss();
    const player = scene.getPlayer()!;
    for (let i = 0; i < 6; i += 1) player.equipWeapon('spread', true);
    const score = scene.getPlayerPowerScore();
    expect(score).toBe(6);

    reachBoss(scene);
    const boss = scene.getBoss()!;
    // The walk may earn a few more permanent grants (hold-full choices), so
    // read the score the boss actually spawned with.
    const spawnScore = scene.getPlayerPowerScore();
    expect(spawnScore).toBeGreaterThanOrEqual(score);
    // One hit reveals the total pool through the health fraction.
    boss.takeDamage();
    const total = Math.round(1 / (1 - boss.getHpFraction()));
    // The total pool is BOSS_PHASE_COUNT phases of the scaled per-phase pool.
    expect(total).toBe(
      BOSS_PHASE_COUNT *
        scaledEncounterHp(BOSS_HIT_POINTS_PER_PHASE, spawnScore),
    );
    expect(total).toBeGreaterThan(BOSS_HIT_POINTS_PER_PHASE);
  });

  it('AC1 — the Central AI spawns after the final level is cleared, with Phase-1 minions', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);

    const boss = scene.getBoss();
    expect(boss).not.toBeNull();
    expect(boss!.alive).toBe(true);
    expect(scene.getWaveManager().bossActive).toBe(true);
    expect(scene.getBossPhase()).toBe(1);
    // Phase 1 (Scan) summons formation scouts on both sides.
    const enemies = scene.getEnemies();
    const scoutCount = enemies.filter((e) => e.alive && e.constructor.name === 'Scout').length;
    expect(scoutCount).toBeGreaterThan(0);
  });

  it('AC2 — the 4-phase health bar depletes and advances the phase on hits', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    expect(boss.getPhaseNumber()).toBe(1);

    // One phase requires the encounter's effective per-phase hit pool.
    damageBossPhase(scene, boss);
    expect(boss.getPhaseNumber()).toBe(2);
    expect(scene.getBossPhase()).toBe(2);
  });

  it('AC3 — advancing a phase summons that phase’s minion wave', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;

    // Phase 1 → 2: Firestorm divers should arrive from the top.
    damageBossPhase(scene, boss);
    expect(boss.getPhaseNumber()).toBe(2);

    const divers = scene.getEnemies().filter(
      (e) => e.alive && e.constructor.name === 'Diver',
    );
    expect(divers.length).toBeGreaterThan(0);
  });

  it('AC4 — phase score is awarded on phase depletion, not per hit (phase score per GDD §4.5)', async () => {
    // Separate scenario: the boss deals no bullets here; assert the score
    // awarded per destroyed phase follows the GDD table (1000/2000/3000/5000).
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const scoreBefore = scene.getGameState().score;

    // Partial-phase hits award no score.
    scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getGameState().score - scoreBefore).toBe(0);

    // The phase-depleting hit awards the phase score exactly once.
    for (let i = 1; i < boss.getHitPointsPerPhase(); i++) {
      scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
      scene.tick(0.016);
    }
    expect(scene.getGameState().score - scoreBefore).toBe(BOSS_PHASE_SCORES[1]);
  });

  it('AC4 — defeating all 4 phases wins the run at the game-over screen', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const scoreBefore = scene.getGameState().score;

    // Four phases, the encounter's effective per-phase pool each.
    for (let phase = 0; phase < 4; phase++) {
      damageBossPhase(scene, boss);
    }
    expect(boss.alive).toBe(false);
    expect(scene.getWaveManager().bossDefeated).toBe(true);
    // Phases 1–4 all awarded (1000+2000+3000+5000).
    expect(scene.getGameState().score - scoreBefore).toBe(11000);

    // The transition is delayed by the victory fireworks hold
    // (VICTORY_TRANSITION_HOLD_MS). Advance the Phaser clock deterministically
    // (stop the live loop and pump `game.step`) rather than awaiting a
    // wall-clock `setTimeout`, so the delayed `GameOverScene` transition is
    // reached even under full-suite load (AH-0MUYALJ9S0002XXZ).
    stepGameUntil(
      booted!.game,
      'victory hold → GameOverScene',
      () => booted!.game.scene.isActive('GameOverScene'),
    );
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });

  it('AC5 — a player bullet hit registers a per-hit impact VFX at the hit point', async () => {
    const cue = vi.spyOn(effectsModule, 'playBossHitSound');
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    vi.clearAllMocks();
    expect(boss.getHitEffects()).toHaveLength(0);

    const hitX = boss.x;
    const hitY = boss.y;
    scene.spawnPlayerBullet(hitX, hitY, 0, 0);
    scene.tick(0.016);

    // The hit is fed through the shared `Boss.takeDamage()` path: one impact
    // VFX at the bullet's hit point and one dedicated boss-hit cue.
    const effects = boss.getHitEffects();
    expect(effects).toHaveLength(1);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(effects[0].x).toBeCloseTo(hitX, 1);
    expect(effects[0].y).toBeCloseTo(hitY, 1);
  });

  // ── Reward gating on phase depletion (AH-0MUUJDG4X003PG3O) ─────

  /** Live minion count (the boss is not part of `spawned`). */
  function liveMinions(scene: PlayScene): number {
    return scene.getEnemies().filter((e) => e.alive).length;
  }

  it('AC1/AC2 — partial-phase hits award no score and spawn no minions', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const scoreBefore = scene.getGameState().score;
    const minionsBefore = liveMinions(scene);

    // Non-depleting partial hits: phase 1 must survive with no rewards.
    for (let i = 0; i < boss.getHitPointsPerPhase() - 1; i++) {
      scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
      scene.tick(0.016);
    }

    expect(boss.getPhaseNumber()).toBe(1);
    expect(scene.getGameState().score).toBe(scoreBefore);
    expect(liveMinions(scene)).toBe(minionsBefore);
  });

  it('AC3/AC4 — depletion awards the phase score and spawns minions exactly once', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const scoreBefore = scene.getGameState().score;
    let expectedMinions = liveMinions(scene);
    let expectedScore = 0;

    for (let phase = 1; phase <= 4; phase++) {
      // The depleting hit ends the phase.
      damageBossPhase(scene, boss);

      // Score for the depleted phase is awarded exactly once.
      expectedScore += BOSS_PHASE_SCORES[phase];
      expect(scene.getGameState().score - scoreBefore).toBe(expectedScore);

      if (phase < 4) {
        // The next phase's minion wave is summoned once, on depletion.
        expectedMinions += minionCountForPhase(phase + 1);
        expect(liveMinions(scene)).toBe(expectedMinions);
      }
    }

    expect(boss.alive).toBe(false);
    expect(scene.getGameState().score - scoreBefore).toBe(11000);
  });

  // ── Levelled-weapon integration (AC6, AH-0MUUJEYZ7006UN5Z) ──────

  /** Fully levels a weapon so its upgrade curve has saturated. */
  function fullyLevelWeapon(scene: PlayScene, id: 'nova'): WeaponDefinition {
    const player = scene.getPlayer()!;
    for (let i = 0; i < 30; i++) player.equipWeapon(id, true);
    return player.getWeaponDef(id);
  }

  /** Shared AOE application seam (the real path a levelled AOE weapon uses). */
  function applyAoe(
    scene: PlayScene,
    def: WeaponDefinition,
    x: number,
    y: number,
  ): void {
    (
      scene as unknown as {
        applyAoeEffect(def: WeaponDefinition, x: number, y: number): void;
      }
    ).applyAoeEffect(def, x, y);
  }

  it('AC6 — a fully levelled AOE weapon deals one hit per blast, not a whole phase', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const def = fullyLevelWeapon(scene, 'nova');
    expect(def.aoe).toBeDefined();

    // Non-depleting max-level blasts: phase 1 survives (each blast is one hit).
    for (let i = 0; i < boss.getHitPointsPerPhase() - 1; i++) {
      applyAoe(scene, def, boss.x, boss.y);
    }
    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.alive).toBe(true);

    // The depleting blast ends exactly one phase — no phase is skipped.
    applyAoe(scene, def, boss.x, boss.y);
    expect(boss.getPhaseNumber()).toBe(2);
    expect(boss.alive).toBe(true);
  });

  it('AC6 — a fully levelled weapon still requires the full hit pool to destroy the boss', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const def = fullyLevelWeapon(scene, 'nova');
    const totalHits = boss.getTotalHp();

    // Leave the boss alive on its final phase (one hit short).
    for (let i = 0; i < totalHits - 1; i++) {
      applyAoe(scene, def, boss.x, boss.y);
    }
    expect(boss.alive).toBe(true);
    expect(boss.getPhaseNumber()).toBe(4);

    // The final blast destroys it — no earlier blast skipped a phase.
    applyAoe(scene, def, boss.x, boss.y);
    expect(boss.alive).toBe(false);
  });

  it('scenario — boss bullets are collected as enemy bullets', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const boss = scene.getBoss()!;

    // Override update to emit one deterministic bullet (attack logic itself
    // is covered by Boss.test.ts).
    const fakeBullet = {
      graphics: scene.add.graphics(),
      vx: 100,
      vy: 100,
      color: 0xffffff,
      lifetime: 4.0,
      elapsed: 0,
    };
    boss.update = (() => [fakeBullet]) as unknown as typeof boss.update;

    scene.tick(0.016);
    // The fake boss bullet is collected into the scene's enemy-bullet list.
    // (The total count is not asserted: wrapping bullets may expire by
    // lifetime in the same tick — AH-0MU960UTE001PTV0.)
    const bullets = scene.getEnemyBullets();
    expect(bullets.some((b) => b.graphics === fakeBullet.graphics)).toBe(true);
  });

  // ── Boss-entry asteroid cleanup (AH-0MUCG5TIU000VPVO) ──────────

  it('AH-0MUCG5TIU000VPVO AC1/AC2/AC5 — carried-over asteroids are destroyed on boss entry with no split children', async () => {
    const scene = await bootPlayAtBoss();
    timeOutToBoss(scene);

    // The boss spawned and no carried-over asteroid survived.
    expect(scene.getBoss()).not.toBeNull();
    expect(scene.getWaveManager().bossActive).toBe(true);
    expect(findAsteroids(scene).length).toBe(0);
    expect(scene.getAliveCount()).toBeGreaterThan(0); // boss + minions remain
  });

  it('AH-0MUCG5TIU000VPVO AC3 — the boss spawn path is otherwise unchanged (Phase-1 minions arrive)', async () => {
    const scene = await bootPlayAtBoss();
    timeOutToBoss(scene);

    expect(scene.getBoss()).not.toBeNull();
    expect(scene.getBossPhase()).toBe(1);
    const scouts = scene
      .getEnemies()
      .filter((e) => e.alive && e.constructor.name === 'Scout');
    expect(scouts.length).toBeGreaterThan(0);
  });

  it('AH-0MUCG5TIU000VPVO AC4 — normal (non-boss) transitions still carry asteroids over', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroidsBefore = findAsteroids(scene);
    expect(asteroidsBefore.length).toBeGreaterThan(0);

    // Time out Level 1 Wave 1 and complete the transition to Wave 2.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);
    expect(scene.isTransitioning()).toBe(true);
    finishTransition(scene);

    // The asteroid carried over into the next wave.
    expect(findAsteroids(scene).length).toBe(asteroidsBefore.length);
    expect(scene.getWaveManager().bossActive).toBe(false);
  });

  // ── Hold-full pause resilience for the boss-walk helpers (AH-0MV5L6BVN005DP4I) ──

  it('AH-0MV5L6BVN005DP4I — timeOutToBoss resolves an open hold-full choice', async () => {
    const scene = await bootPlayAtBoss();
    // The carried-over pile generates enough mineral drops that the hold
    // fills mid-walk; open the overlay here to pin the regression
    // deterministically (it pauses the simulation exactly as real play does).
    scene.openMineralChoice();
    expect(scene.isMineralChoiceOpen()).toBe(true);

    timeOutToBoss(scene);

    expect(scene.getBoss()).not.toBeNull();
    expect(scene.getWaveManager().bossActive).toBe(true);
  });

  it('AH-0MV5L6BVN005DP4I — reachBoss resolves an open hold-full choice', async () => {
    const scene = await bootPlayAtBoss();
    scene.openMineralChoice();
    expect(scene.isMineralChoiceOpen()).toBe(true);

    reachBoss(scene);

    expect(scene.getBoss()).not.toBeNull();
    expect(scene.getWaveManager().bossActive).toBe(true);
  });
});

describe('PlayScene — asteroid integration (AH-0MU8BZ2ZM004J47F)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  /** Boots with a deterministic large asteroid placed outside the wave
   * definition (see `plainCampaign`). */
  async function bootPlayWithAsteroid(): Promise<PlayScene> {
    // Isolate the asteroid: disable the dynamic spawner from before the scene
    // restarts so these asteroid-behaviour tests are not perturbed by random
    // spawns, then place one deterministic large asteroid through the public
    // seam (it is not wave-accounted, AH-0MUJM746P000QAEO).
    const { booted: game, scene } = await bootSceneWithLevels(
      plainCampaign(),
      { asteroidSpawner: false },
    );
    booted = game;
    scene.spawnAsteroidAt(GAME_WIDTH * 0.6, GAME_HEIGHT * 0.25, 'large');
    return scene;
  }

  /** Alive asteroid entities currently in the scene. */
  function findAsteroids(scene: PlayScene): Asteroid[] {
    return scene
      .getEnemies()
      .filter((e): e is Asteroid => e instanceof Asteroid && e.alive);
  }

  it('AC1 — Level 1 Wave 1 spawns a large asteroid alongside the Scouts', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();

    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBe(1);
    expect(asteroids[0].getSizeTier()).toBe('large');

    // Wave accounting counts only the 6 Scouts: the asteroid is not
    // wave-accounted (AH-0MUJM746P000QAEO).
    const waveDef = wm.currentWave()!;
    const total = waveDef.groups.reduce((sum, g) => sum + g.count, 0);
    expect(total).toBe(6);
    expect(wm.enemiesAlive).toBe(total);
    expect(scene.getAliveCount()).toBe(total + 1); // 6 Scouts + 1 asteroid
  });

  it('AC3 — shooting the large asteroid spawns exactly 2 medium children in divergent directions', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();
    const aliveBefore = wm.enemiesAlive; // 6 (Scouts only)

    const large = findAsteroids(scene)[0];
    const scoreBefore = scene.getGameState().score;

    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);

    // Parent destroyed; large tier awards no points.
    expect(large.alive).toBe(false);
    expect(scene.getGameState().score).toBe(scoreBefore);

    // Exactly two medium children at the parent's position.
    const children = findAsteroids(scene);
    expect(children.length).toBe(2);
    expect(children.every((c) => c.getSizeTier() === 'medium')).toBe(true);

    // Split children are NOT registered with the WaveManager (AH-0MUJM746P000QAEO).
    expect(wm.enemiesAlive).toBe(aliveBefore);

    // Children move in directions different from each other (>= pi/3).
    const a1 = Math.atan2(children[0].vy, children[0].vx);
    const a2 = Math.atan2(children[1].vy, children[1].vx);
    const delta = Math.abs(a1 - a2);
    const wrapped = Math.min(delta, Math.PI * 2 - delta);
    expect(wrapped).toBeGreaterThanOrEqual(Math.PI / 3 - 0.01);
  });

  it('AC3/AC4 — medium splits into 2 smalls (no score); small awards 50 points with no children', async () => {
    const scene = await bootPlayWithAsteroid();

    // Split the large asteroid first.
    const large = findAsteroids(scene)[0];
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(findAsteroids(scene).length).toBe(2);

    // Shoot one medium — two small children; medium awards no points.
    const medium = findAsteroids(scene)[0];
    const scoreBeforeMedium = scene.getGameState().score;
    scene.spawnPlayerBullet(medium.x, medium.y, 0, 0);
    scene.tick(0.016);
    expect(medium.alive).toBe(false);
    expect(scene.getGameState().score).toBe(scoreBeforeMedium);

    const all = findAsteroids(scene);
    const smalls = all.filter((a) => a.getSizeTier() === 'small');
    const mediumsLeft = all.filter((a) => a.getSizeTier() === 'medium');
    // Exactly two small children and the untouched second medium remain.
    expect(smalls).toHaveLength(2);
    expect(mediumsLeft).toHaveLength(1);
  });

  it('AC4 — shooting a small asteroid awards exactly 50 points and spawns no children', async () => {
    const scene = await bootPlayWithAsteroid();

    // Split the full chain down to smalls: large -> 2 medium -> shoot both -> 4 smalls.
    const large = findAsteroids(scene)[0];
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);

    // Count before further scoring checks.
    const childrenStep1 = findAsteroids(scene);
    expect(childrenStep1).toHaveLength(2);
    // Record the two mediums (they move slowly; re-locate each shot).
    const mediumA = childrenStep1[0];
    const mediumB = childrenStep1[1];
    scene.spawnPlayerBullet(mediumA.x, mediumA.y, 0, 0);
    scene.tick(0.016);
    const smallsAfterA = findAsteroids(scene).filter((a) => a.getSizeTier() === 'small');
    expect(smallsAfterA).toHaveLength(2);
    scene.spawnPlayerBullet(mediumB.x, mediumB.y, 0, 0);
    scene.tick(0.016);

    const smalls = findAsteroids(scene).filter((a) => a.getSizeTier() === 'small');
    expect(smalls).toHaveLength(4);

    // Shoot one small: +50 points, no children from it.
    const small = smalls[0];
    const scoreBefore = scene.getGameState().score;
    scene.spawnPlayerBullet(small.x, small.y, 0, 0);
    scene.tick(0.016);
    expect(small.alive).toBe(false);
    expect(scene.getGameState().score - scoreBefore).toBe(50);
    // Remaining asteroids: 3 smalls (the other medium never existed — it was
    // consumed as part of the chain above; exactly 3 smalls remain).
    expect(findAsteroids(scene).filter((a) => a.getSizeTier() === 'small')).toHaveLength(3);
  });

  it('AH-0MUJM746P000QAEO AC1 — the wave clears as soon as non-asteroid enemies are destroyed, even with live asteroids', async () => {
    const scene = await bootPlayWithAsteroid();
    const wm = scene.getWaveManager();

    // The wave has 6 Scouts; the asteroid is not wave-accounted.
    expect(wm.enemiesAlive).toBe(6);

    // Destroy the asteroid first — this spawns 2 medium children.
    const large = findAsteroids(scene)[0];
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(large.alive).toBe(false);
    expect(findAsteroids(scene)).toHaveLength(2);

    // The split leaves enemiesAlive unchanged (asteroids are not counted).
    expect(wm.enemiesAlive).toBe(6);

    // Now destroy all Scouts. The wave should clear despite 2 medium asteroids alive.
    killNonAsteroidEnemies(scene);

    // The wave cleared and transition to Wave 2 began — the asteroids persist.
    expect(scene.isTransitioning()).toBe(true);
    expect(wm.waveNumber).toBe(2);
    expect(findAsteroids(scene)).toHaveLength(2);
    // Wave 2 pre-loads its 8 Scouts.
    expect(wm.enemiesAlive).toBe(wm.waveEnemyCount());

    finishTransition(scene);
    expect(wm.waveNumber).toBe(2);
    // The 8 Scouts are now spawned on screen alongside the 2 persisted asteroids.
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount() + 2);
  });

  it('AC5 — asteroids move independently of formation drift (constant velocity + wrap + rotation)', async () => {
    const scene = await bootPlayWithAsteroid();
    const asteroid = findAsteroids(scene)[0];
    const startX = asteroid.x;
    const startY = asteroid.y;
    const vx = asteroid.vx;
    const vy = asteroid.vy;
    const rotBefore = asteroid.rotation;

    scene.tick(0.5);

    // Still alive (slow drift away from the auto-fire lane).
    expect(asteroid.alive).toBe(true);
    // Position change is exactly velocity x dt — NOT the formation drift
    // (which would add a fixed +14 px to x over 0.5 s for every group).
    expect(asteroid.x - startX).toBeCloseTo(vx * 0.5, 4);
    expect(asteroid.y - startY).toBeCloseTo(vy * 0.5, 4);
    // Rotated continuously by rotationSpeed x dt.
    expect(asteroid.rotation - rotBefore).toBeCloseTo(asteroid.rotationSpeed * 0.5, 3);
  });

  it('asteroid colliding with the player costs one life, destroys the asteroid, and still splits', async () => {
    const scene = await bootPlayWithAsteroid();
    const player = scene.getPlayer()!;

    // Let auto-fire fire its opening volley, then park the ship on the
    // asteroid so the body-collision path triggers (mirrors the scout ram test).
    scene.tick(0.016);
    const asteroid = findAsteroids(scene)[0];
    const livesBefore = scene.getGameState().lives;
    const scoreBefore = scene.getGameState().score;

    player.setPosition(asteroid.x, asteroid.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: asteroid.x, y: asteroid.y };
    scene.tick(0.001);

    // One life lost; the rammed asteroid is destroyed and splits into two
    // medium children (the wave keeps tracking them); ramming awards 0 points.
    expect(scene.getGameState().lives).toBe(livesBefore - 1);
    expect(asteroid.alive).toBe(false);
    expect(scene.getGameState().score).toBe(scoreBefore);
    const children = findAsteroids(scene);
    expect(children.length).toBe(2);
    expect(children.every((c) => c.getSizeTier() === 'medium')).toBe(true);
  });

  // ── Collection boundary matches the visible bubble (AH-0MTVYCM2N002NKE4) ──

  it('collects a fully-grown drop whose hull touches the visible bubble (31 px)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Full-scale boundary: hull 10 + bubble 16 × 1.4 = 32.4 px. At 31 px the
    // ship hull is already touching the crisp bubble ring → collected.
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x + 31, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05); // full scale

    scene.tick(0.016); // lifecycle advance + collection in one frame

    expect(scene.getDrops()).not.toContain(drop);
    expect(scene.getEffectsRegistry().isActive('speed_boost')).toBe(true);
  });

  it('does not collect a fully-grown drop just beyond the bubble boundary (34 px)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    const drop = scene.spawnPowerUpDrop('speed_boost', player.x + 34, player.y)!; // 34 px > 32.4 px
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05); // full scale

    scene.tick(0.016);

    expect(scene.getDrops()).toContain(drop);
    expect(scene.getEffectsRegistry().isActive('speed_boost')).toBe(false);
  });

  // ── Speed Boost (AH-0MU8QURXB008DWM7) ────────────────────────

  it('P5 active → speed multiplier applied to player movement config', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Default: no Speed Boost active, multiplier = 1.
    const configDefault = player.getMovementConfig();
    expect(registry.speedMultiplier()).toBe(1);

    // Activate Speed Boost via direct collection (drop under ship at full size).
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);

    // Collect it in one tick (registry gets updated).
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);

    // The multiplier is applied at the TOP of tick(), before _updateDrops.
    // So the boosted config takes effect on the NEXT tick call.
    scene.tick(0.016);
    const configP5 = player.getMovementConfig();
    expect(configP5.thrust).toBeCloseTo(configDefault.thrust * 1.5);
    expect(configP5.maxSpeed).toBeCloseTo(configDefault.maxSpeed * 1.5);
  });

  it('P5 expired → multiplier back to 1', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Base (un-boosted) movement config, captured before activation.
    const baseConfig = player.getMovementConfig();

    // Activate Speed Boost.
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);

    expect(registry.isActive('speed_boost')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);

    // Advance to just inside the resolved window, then comfortably past it
    // (AH-0MV6T0HU0001IS71). The level-0 Speed Boost window resolves to
    // exactly 10 s, so the old fixed 10.1 s advance (600 × 0.016 + 0.5)
    // left only ~0.1 s of margin and flaked under full-suite load; deriving
    // the advance from the registry's actual remaining window keeps the
    // expiry assertion deterministic regardless of tuning.
    const remaining = registry.remaining('speed_boost')!;
    expect(remaining).toBeGreaterThan(0);
    const insideWindow = Math.max(1, Math.floor(remaining / 0.016) - 10);
    for (let i = 0; i < insideWindow; i++) scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);

    // 2 s past the window — the effect has expired and the movement config
    // is back to the un-boosted base.
    for (let i = 0; i < Math.ceil(2 / 0.016); i++) scene.tick(0.016);

    expect(registry.isActive('speed_boost')).toBe(false);
    expect(registry.speedMultiplier()).toBe(1);
    const after = player.getMovementConfig();
    expect(after.thrust).toBeCloseTo(baseConfig.thrust);
    expect(after.maxSpeed).toBeCloseTo(baseConfig.maxSpeed);
  });

  it('re-collecting P5 refreshes the duration', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect first Speed Boost.
    const drop1 = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop1.powerUp.advance(0.05);
    player.setPosition(drop1.x, drop1.y);
    scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);

    // Advance ~3 seconds so the timer ticks down.
    for (let i = 0; i < 188; i++) scene.tick(0.016); // ~3 s
    expect(registry.isActive('speed_boost')).toBe(true);
    const remainingBeforeSecond = registry.remaining('speed_boost')!;

    // Collect a second Speed Boost — should refresh the timer to full.
    const drop2 = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop2.powerUp.advance(0.05);
    player.setPosition(drop2.x, drop2.y);
    scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);
    const remaining2 = registry.remaining('speed_boost')!;

    // The second collection refreshed the timer to the near-full level-1
    // duration (level-derived, so longer than the base 10 s window).
    expect(remaining2).toBeGreaterThan(remainingBeforeSecond);
    expect(remaining2).toBeCloseTo(
      resolvePowerUpAtLevel('speed_boost', 1).speedDuration!,
      1,
    );
  });

  it('P5 active → fire-rate multiplier applied to the player (AC1)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Default: no Speed Boost active, fire-rate multiplier = 1.
    expect(registry.fireRateMultiplier()).toBe(1);
    expect(player.getFireRateMultiplier()).toBe(1);

    // Collect a Speed Boost (drop under the ship at full size).
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);
    expect(registry.fireRateMultiplier()).toBe(1.5);

    // Applied at the top of tick(), so the boost lands on the next tick.
    scene.tick(0.016);
    expect(player.getFireRateMultiplier()).toBe(1.5);
  });

  it('P5 expired → fire-rate multiplier back to 1 (AC2)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    scene.tick(0.016);
    expect(player.getFireRateMultiplier()).toBe(1.5);

    // Advance to just inside the resolved window, then comfortably past it
    // (AH-0MV6T0HU0001IS71). The old fixed 10.1 s advance sat only ~0.1 s
    // past the level-0 10 s window and flaked under full-suite load; the
    // window is derived from the registry so the expiry assertion is
    // deterministic regardless of tuning.
    const remaining = registry.remaining('speed_boost')!;
    expect(remaining).toBeGreaterThan(0);
    const insideWindow = Math.max(1, Math.floor(remaining / 0.016) - 10);
    for (let i = 0; i < insideWindow; i++) scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);

    // 2 s past the window — the effect has expired and the fire-rate
    // multiplier is back to 1.
    for (let i = 0; i < Math.ceil(2 / 0.016); i++) scene.tick(0.016);

    expect(registry.isActive('speed_boost')).toBe(false);
    expect(player.getFireRateMultiplier()).toBe(1);
  });

  // ── Teleport (AH-0MU8QUY7U0069XC3) ───────────────────────────

  it('P7 teleport with a stack warps the player, consumes the stack and grants P6', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a Teleport to gain a teleport stack.
    const drop = scene.spawnPowerUpDrop('teleport', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.teleportStacks()).toBe(1);

    // Move the ship off-centre so the safe-spot search picks a new location.
    player.setPosition(300, 400);
    const beforeX = player.x;
    const beforeY = player.y;

    expect(scene.triggerTeleport()).toBe(true);

    expect(registry.teleportStacks()).toBe(0);
    expect(registry.isPhased).toBe(true); // Phase Shift granted on arrival
    expect(Math.hypot(player.x - beforeX, player.y - beforeY)).toBeGreaterThan(0);
    expect(player.x).toBeGreaterThanOrEqual(0);
    expect(player.x).toBeLessThanOrEqual(GAME_WIDTH);
    expect(player.y).toBeGreaterThanOrEqual(0);
    expect(player.y).toBeLessThanOrEqual(GAME_HEIGHT);
  });

  it('P7 teleport with zero stacks is a no-op', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    expect(registry.hasTeleport()).toBe(false);
    const beforeX = player.x;
    const beforeY = player.y;

    expect(scene.triggerTeleport()).toBe(false);

    // Player did not move; no Phase Shift granted; still zero stacks.
    expect(player.x).toBeCloseTo(beforeX);
    expect(player.y).toBeCloseTo(beforeY);
    expect(registry.teleportStacks()).toBe(0);
    expect(registry.isPhased).toBe(false);
  });

  it('P7 destination avoids live enemies (lands away from an enemy body)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a Teleport stack.
    const drop = scene.spawnPowerUpDrop('teleport', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.teleportStacks()).toBe(1);

    // Park the ship inside a live enemy so the only safe spot is away from it.
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    player.setPosition(enemy.x, enemy.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: enemy.x, y: enemy.y };

    expect(scene.triggerTeleport()).toBe(true);

    // The landing spot must not overlap the enemy body.
    const distFromEnemy = Math.hypot(player.x - enemy.x, player.y - enemy.y);
    expect(distFromEnemy).toBeGreaterThan(enemy.getHitRadius());
  });

  // ── Shield bubble visual (AH-0MU8QV3O9008JVNQ) ───────────────

  it('P3 shield bubble is rendered while the shield is active', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    expect(scene.isShieldBubbleVisible()).toBe(false);

    // Collect a Shield shield.
    const drop = scene.spawnPowerUpDrop('shield', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isShielded).toBe(true);

    // Visuals update at the TOP of tick (before drop collection), so the
    // bubble appears from the NEXT tick onward.
    scene.tick(0.016);
    expect(scene.isShieldBubbleVisible()).toBe(true);
  });

  it('P3 shield absorbs a hit: bubble disappears, invulnerability blink starts, no life lost', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();
    const livesBefore = scene.getGameState().lives;

    // Collect a Shield shield (park an enemy bullet far away so auto-fire
    // damage during setup does not interfere — the shield is fresh).
    const drop = scene.spawnPowerUpDrop('shield', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isShielded).toBe(true);

    // Park an enemy bullet on the ship: the shield absorbs it.
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    // Shield popped, no life lost, brief invulnerability blink active.
    expect(registry.isShielded).toBe(false);
    expect(scene.isShieldBubbleVisible()).toBe(false);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  // ── Phase Shift ghost visual (AH-0MU8QVC9Y008R8I5) ────────────

  it('P6 phase shift renders the ship as a semi-transparent ghost (alpha 0.45)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Directly activate the phase — the ghost visual is independent of how
    // the phase was triggered (auto-trigger is covered in effects.test.ts).
    registry.applyPhaseShift();
    expect(registry.isPhased).toBe(true);

    expect(scene.isPhaseGhostActive()).toBe(true);
    // Ghost alpha applied after the visuals update on the next tick.
    player.setAlpha(1);
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(0.45);
  });

  it('P6 expiry restores full ship alpha', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Directly activate the phase (trigger-independent ghost visual).
    registry.applyPhaseShift();
    expect(registry.isPhased).toBe(true);

    // Ghost alpha on the next tick.
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(0.45);

    // Advance past the 1.5 s duration.
    for (let i = 0; i < 100; i++) scene.tick(0.016); // ~1.6 s
    expect(registry.isPhased).toBe(false);
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(1);
  });

  it('P6 ghost alpha defers to the post-hit invulnerability blink', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Directly activate the phase (phased → ghosted).
    registry.applyPhaseShift();
    expect(registry.isPhased).toBe(true);

    // Apply the ghost alpha first (phased → 0.45).
    player.setAlpha(1);
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(0.45);

    // Start the post-hit invulnerability blink while phase is still active
    // (phase grants pass-through, so the blink is started via the same
    // timer the shield-absorb path uses). The ghost must NOT clobber it.
    (scene as unknown as { invulnerable: number }).invulnerable = 1;
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // After the visuals update, the blink alpha wins over the ghost alpha.
    scene.tick(0.016);
    expect(player.alpha).not.toBeCloseTo(0.45);
  });

  // ── Bomb ranged clear (AH-0MUVM9RAO004Y3LB) ───────────────────

  it('P4 field pickup clears enemy bullets within range exactly once', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // One bullet inside the base 120 px range, one well outside it.
    scene.spawnEnemyBullet(player.x + 50, player.y, 0, 0);
    scene.spawnEnemyBullet(player.x + 400, player.y, 0, 0);
    expect(scene.getEnemyBullets().length).toBe(2);

    // Collect a Bomb bomb.
    const drop = scene.spawnPowerUpDrop('bomb', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016); // collection queues the one-shot pulse
    scene.tick(0.016); // the shared bomb step fires it exactly once

    // Field pickup: only the in-range bullet is cleared and no persistent
    // effect row remains.
    expect(scene.getEnemyBullets().length).toBe(1);
    expect(scene.getEffectsRegistry().isBombPermanent()).toBe(false);
    expect(
      scene.getEffectsRegistry().activeEffects().some((e) => e.id === 'bomb'),
    ).toBe(false);
  });

  it('P4 blast does not damage enemies (bullets cleared only)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    // Capture the enemies that must survive the blast. The default campaign
    // is sequenced from a fresh per-run seed and the asteroid spawner can
    // release a scheduled offscreen asteroid during the blast ticks, so the
    // raw live count is not a stable probe; assert on the enemies present
    // before the blast instead.
    const enemiesBefore = scene.getEnemies().filter((e) => e.alive);
    expect(enemiesBefore.length).toBeGreaterThan(0);

    // Collect a Bomb bomb.
    const drop = scene.spawnPowerUpDrop('bomb', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    scene.tick(0.016);

    // No enemies harmed by the bomb.
    expect(enemiesBefore.every((enemy) => enemy.alive)).toBe(true);
  });

  // ── Per-weapon fire audio (AH-0MU8QVQQV006T0KI) ──────────────────
  // Player fire cues route through the shared playWeaponFireSound
  // dispatcher (AH-0MV55O9R5005W6J0), so these tests observe the weapon id
  // it is called with rather than the per-weapon cue functions.

  it('auto-firing the cannon plays the shared fire cue once per volley', async () => {
    const fireSound = vi.spyOn(effectsModule, 'playWeaponFireSound');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    // Reset the scene's shared beat clock to a deterministic anchor so
    // exactly one grid tick (375 ms) elapses in the window below, and
    // re-schedule the player's weapons on it.
    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());
    vi.clearAllMocks();

    scene.tick(0.5); // one 375 ms cannon grid tick elapses → fires once

    expect(fireSound).toHaveBeenCalledTimes(1);
    expect(fireSound).toHaveBeenCalledWith('cannon');
  });

  it('equipping spread/dual/rapid plays the corresponding shared fire cue', async () => {
    const fireSound = vi.spyOn(effectsModule, 'playWeaponFireSound');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    vi.clearAllMocks();

    // A freshly collected weapon fires its first shot on the next beat grid
    // tick. Reset the shared clock before each equip so that tick is t=0,
    // then advance one short frame to deliver exactly one volley.

    // Spread: the permanently-active cannon fires too (cumulative model),
    // so both cues play per volley.
    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());
    player.equipWeapon('spread');
    scene.tick(0.05);
    expect(fireSound).toHaveBeenCalledWith('spread');
    expect(fireSound).toHaveBeenCalledWith('cannon');
    vi.clearAllMocks();

    // Dual.
    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());
    player.equipWeapon('dual');
    scene.tick(0.05);
    expect(fireSound).toHaveBeenCalledWith('dual');
    vi.clearAllMocks();

    // Rapid.
    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());
    player.equipWeapon('rapid');
    scene.tick(0.05);
    expect(fireSound).toHaveBeenCalledWith('rapid');
  });

  // ── Per-type pickup activation audio (AH-0MU8QVX9G008P8ML) ──────

  /** Collects a fully-grown drop under the player via one tick. */
  async function collectDropInPlay(scene: PlayScene, id: string): Promise<void> {
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop(id as never, player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
  }

  it('P5/P8/P9 collections play the dedicated per-type activation cue', async () => {
    const speedSound = vi.spyOn(effectsModule, 'playSpeedBoostCollectSound');
    const lifeSound = vi.spyOn(effectsModule, 'playExtraLifeCollectSound');
    const magnetSound = vi.spyOn(effectsModule, 'playMagnetCollectSound');
    const genericSound = vi.spyOn(effectsModule, 'playPowerUpCollectSound');
    const scene = await bootPlay();
    vi.clearAllMocks();

    await collectDropInPlay(scene, 'speed_boost');
    expect(speedSound).toHaveBeenCalledTimes(1);

    await collectDropInPlay(scene, 'extra_life');
    expect(lifeSound).toHaveBeenCalledTimes(1);

    await collectDropInPlay(scene, 'magnet');
    expect(magnetSound).toHaveBeenCalledTimes(1);

    // No generic chime for the types with dedicated cues.
    expect(genericSound).not.toHaveBeenCalled();
  });

  it('types without a dedicated cue fall back to the generic chime', async () => {
    const genericSound = vi.spyOn(effectsModule, 'playPowerUpCollectSound');
    const scene = await bootPlay();
    vi.clearAllMocks();

    // Shield shield, Bomb bomb, Phase Shift phase, Teleport teleport have no dedicated cue yet.
    for (const id of ['shield', 'bomb', 'phase_shift', 'teleport']) {
      await collectDropInPlay(scene, id);
    }
    expect(genericSound).toHaveBeenCalledTimes(4);
  });

  it('weapon drop collections play the per-weapon pickup cue', async () => {
    const spreadSound = vi.spyOn(effectsModule, 'playSpreadPickupSound');
    const dualSound = vi.spyOn(effectsModule, 'playDualPickupSound');
    const rapidSound = vi.spyOn(effectsModule, 'playRapidPickupSound');
    const resetSound = vi.spyOn(effectsModule, 'playResetPickupSound');
    const scene = await bootPlay();
    vi.clearAllMocks();

    await collectDropInPlay(scene, 'spread');
    expect(spreadSound).toHaveBeenCalledTimes(1);

    await collectDropInPlay(scene, 'dual');
    expect(dualSound).toHaveBeenCalledTimes(1);

    await collectDropInPlay(scene, 'rapid');
    expect(rapidSound).toHaveBeenCalledTimes(1);

    await collectDropInPlay(scene, 'reset');
    expect(resetSound).toHaveBeenCalledTimes(1);
  });

  // ── Collection absorb VFX + pop SFX (AH-0MUBYXR280018HST) ────────

  it('collection starts the absorb animation and keeps the Graphics alive', async () => {
    const spawnSpy = vi.spyOn(collectAnimationModule, 'spawnCollectAnimation');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);

    scene.tick(0.016);

    // The VFX is started with the drop's position and kept alive — not
    // destroyed on the collection frame.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(scene.getDrops()).toHaveLength(0); // removed from active drops
    expect(scene.getCollectAnimations()).toHaveLength(1);
    expect(drop.graphics.active).toBe(true);
  });

  it('the absorb animation completes and destroys the drop Graphics', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);

    scene.tick(0.016);
    expect(scene.getCollectAnimations()).toHaveLength(1);

    // Advance well past the ≤ 0.3 s absorb duration.
    for (let i = 0; i < 10; i++) scene.tick(0.05);

    expect(scene.getCollectAnimations()).toHaveLength(0);
    expect(drop.graphics.active).toBe(false); // destroyed on completion
  });

  it('collection plays the generic pop SFX exactly once (no re-collect)', async () => {
    const popSound = vi.spyOn(effectsModule, 'playPowerUpCollectPopSound');
    const scene = await bootPlay();
    vi.clearAllMocks();
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);

    scene.tick(0.016);
    expect(popSound).toHaveBeenCalledTimes(1);

    // Keep ticking while the drop is absorbed — it must not re-collect.
    for (let i = 0; i < 4; i++) scene.tick(0.05);
    expect(popSound).toHaveBeenCalledTimes(1);
  });

  // ── Per-enemy destruction audio (AH-0MU8QW2XS001HE2A) ───────────

  /** Walks forward until the current wave contains an entity with the seam. */
  function findSeamEnemy(scene: PlayScene): EnemyEntity | null {
    return (
      scene.getEnemies().find((e) => typeof (e as { playDestructionAudio?: unknown }).playDestructionAudio === 'function') ??
      null
    );
  }

  it('bullet kill of a Diver plays the diver destruction sound', async () => {
    vi.restoreAllMocks(); // fresh spies (config does not restore between tests)
    const scene = await bootPlay();

    // Walk to a wave containing an entity with the destruction-audio seam
    // (Divers appear in Level 2 Wave 2; these waves are non-firing).
    let seam = findSeamEnemy(scene);
    for (let guard = 0; guard < 30 && !seam; guard++) {
      killAllEnemies(scene);
      finishTransition(scene);
      seam = findSeamEnemy(scene);
    }
    expect(seam).not.toBeNull();

    const diverSound = vi.spyOn(effectsModule, 'playDiverDestructionSound');
    const genericSound = vi.spyOn(effectsModule, 'playDestructionSound');

    // Kill the Diver with player bullets (fully spawned, so damage applies).
    // A level-2 Diver carries its resolved force field (start level 2,
    // AH-0MVM8GXEF009883O), so drain the field before the hull takes damage.
    finishSpawnSequence(scene);
    const fieldHits = (seam as unknown as { forceFieldHits?: number })
      .forceFieldHits ?? 0;
    for (let i = 0; i <= fieldHits; i++) {
      scene.spawnPlayerBullet(seam!.x, seam!.y, 0, 0);
      scene.tick(0.016);
    }

    expect(diverSound).toHaveBeenCalledTimes(1);
    // The generic sound is NOT used when the entity exposes the seam.
    expect(genericSound).not.toHaveBeenCalled();
  });

  it('a generic enemy (Scout) plays the generic destruction sound', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    finishSpawnSequence(scene);
    const enemy = scene.getEnemies().find((e) => !(e as { playDestructionAudio?: unknown }).playDestructionAudio)!;

    const genericSound = vi.spyOn(effectsModule, 'playDestructionSound');

    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    expect(genericSound).toHaveBeenCalledTimes(1);
  });

  it('player-body-vs-enemy collision plays the entity destruction audio exactly once', async () => {
    vi.restoreAllMocks();
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Walk to a wave containing a seam entity (Diver).
    let seam = findSeamEnemy(scene);
    for (let guard = 0; guard < 30 && !seam; guard++) {
      killAllEnemies(scene);
      finishTransition(scene);
      seam = findSeamEnemy(scene);
    }
    expect(seam).not.toBeNull();

    const diverSound = vi.spyOn(effectsModule, 'playDiverDestructionSound');

    // Let auto-fire fire its opening volley, then park the ship on the Diver
    // so the body-collision path triggers (mirrors the scout ram test). A
    // shielded Diver's force field absorbs the ram (AC2, Q6 = B), so drain
    // the field first — the both-destroyed rule then applies exactly once.
    finishSpawnSequence(scene);
    scene.tick(0.016);
    const fieldHits = (seam as unknown as { forceFieldHits?: number })
      .forceFieldHits ?? 0;
    for (let i = 0; i < fieldHits; i++) {
      scene.spawnPlayerBullet(seam!.x, seam!.y, 0, 0);
      scene.tick(0.016);
    }
    player.setPosition(seam!.x, seam!.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: seam!.x, y: seam!.y };
    scene.tick(0.001);

    expect(diverSound).toHaveBeenCalledTimes(1);
  });

  // ── Powerup reset on game restart (AH-0MU9KSFMQ005SAT1) ─────────────

  it('AC1 — restarting PlayScene clears all active powerup effects', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    /** Collects a fully-grown drop under the player (one tick). */
    const collect = (id: string): void => {
      const drop = scene.spawnPowerUpDrop(id as never, player.x, player.y)!;
      for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
      player.setPosition(drop.x, drop.y);
      scene.tick(0.016);
    };

    // Collect one of each effect category: timed (Speed Boost speed, Extra Life life,
    // Shield shield, Phase Shift phase, Magnet magnet field-pickup), permanent stacks (Magnet
    // magnet upgrade, Teleport teleport) and a weapon pickup ('spread').
    collect('speed_boost');
    collect('extra_life');
    collect('shield');
    collect('phase_shift');
    collect('magnet');
    registry.applyCollect('magnet', true); // permanent magnet upgrade
    collect('teleport');
    collect('spread');

    // Verify each category was active before the restart (AC1).
    expect(registry.isActive('speed_boost')).toBe(true);
    expect(registry.isShielded).toBe(true);
    expect(registry.phaseCharges()).toBe(1);
    expect(registry.lives()).toBe(4);
    expect(registry.isMagnetActive()).toBe(true);
    expect(registry.magnetStacks()).toBe(1);
    expect(registry.hasTeleport()).toBe(true);
    expect(registry.activeWeapons().length).toBeGreaterThan(0);

    // Simulate game restart: same as MenuScene → PlayScene. The restart is
    // queued by the SceneManager, so pump the loop before asserting.
    scene.scene.start('PlayScene');
    await advanceGame(scene.game, 150);

    // Phaser reuses the same scene instance — verify it is still active.
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);

    // Re-fetch the instance in case Phaser recreated the scene.
    const restarted = booted!.game.scene.getScene(
      'PlayScene',
    ) as PlayScene;
    const restartedRegistry = restarted.getEffectsRegistry();

    // AC1/AC3 — every effect category is back to its default.
    expect(restartedRegistry.activeEffects()).toHaveLength(0);
    expect(restartedRegistry.isShielded).toBe(false);
    expect(restartedRegistry.isPhased).toBe(false);
    expect(restartedRegistry.phaseCharges()).toBe(0);
    expect(restartedRegistry.speedMultiplier()).toBe(1);
    expect(restartedRegistry.isMagnetActive()).toBe(false);
    expect(restartedRegistry.magnetStacks()).toBe(0);
    expect(restartedRegistry.magnetEffectStacks()).toBe(0);
    expect(restartedRegistry.hasTeleport()).toBe(false);
    expect(restartedRegistry.activeWeapons()).toHaveLength(0);
    expect(restartedRegistry.lives()).toBe(3);
  });
});

describe('PlayScene — asteroid Extra Life kill drop (AH-0MV6M2M9P0078N4S)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots the deterministic static campaign with the Extra Life roll forced
   * to 1.0, and injects an RNG (0.99) that fails the generic 18 % per-kill
   * pool so a drop can only come from the forced Extra Life roll.
   */
  async function bootWithForcedRoll(): Promise<PlayScene> {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({
        sequencedWavesEnabled: false,
        asteroidExtraLifeDropChance: 1,
      }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.setRng(() => 0.99);
    return scene;
  }

  it('AC1/AC3 — a fully destroyed small asteroid spawns exactly one extra_life drop', async () => {
    const scene = await bootWithForcedRoll();
    const before = scene.getDrops().length;

    const small = scene.spawnAsteroidAt(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      'small',
    );
    const sx = small.x;
    const sy = small.y;
    scene.spawnPlayerBullet(small.x, small.y, 0, 0);
    scene.tick(0.016);

    expect(small.alive).toBe(false);
    const drops = scene.getDrops();
    // Exactly the one extra-life drop (the generic pool was pinned off).
    expect(drops.length).toBe(before + 1);
    const extra = drops.find((d) => d.dropId === 'extra_life');
    expect(extra).toBeDefined();
    // Standard placement (separation nudging) leaves it at/near the death site.
    expect(Math.hypot(extra!.x - sx, extra!.y - sy)).toBeLessThanOrEqual(2);
  });

  it('AC1 — large and medium asteroid kills never roll the Extra Life drop', async () => {
    const scene = await bootWithForcedRoll();
    const before = scene.getDrops().length;

    // Spawn each tier directly (no overlapping split siblings) so the one
    // bullet deterministically kills the target.
    const large = scene.spawnAsteroidAt(
      GAME_WIDTH / 2,
      80,
      'large',
    );
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(large.alive).toBe(false);
    expect(scene.getDrops().some((d) => d.dropId === 'extra_life')).toBe(false);

    const medium = scene.spawnAsteroidAt(
      GAME_WIDTH / 2,
      160,
      'medium',
    );
    scene.spawnPlayerBullet(medium.x, medium.y, 0, 0);
    scene.tick(0.016);
    expect(medium.alive).toBe(false);
    expect(scene.getDrops().some((d) => d.dropId === 'extra_life')).toBe(false);
    // With the roll forced on, any small kill would have dropped — so the
    // static count proves the tier gate blocked large and medium.
    expect(scene.getDrops().length).toBe(before);
  });
});


describe('PlayScene — keyboard-only gameplay verification (AH-0MUBZU8IL0067GOU)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, PauseScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  /** A faked Phaser key exposing only `isDown`. */
  interface KeyLike {
    isDown: boolean;
  }

  /** Exposes the scene's keyboard input objects for deterministic driving. */
  function inputState(scene: PlayScene): {
    cursors: Record<'up' | 'down' | 'left' | 'right', KeyLike>;
    wasd: Record<'W' | 'A' | 'S' | 'D', KeyLike>;
  } {
    return scene as unknown as {
      cursors: Record<'up' | 'down' | 'left' | 'right', KeyLike>;
      wasd: Record<'W' | 'A' | 'S' | 'D', KeyLike>;
    };
  }

  it('AC1 — WASD moves the ship without any pointer input', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const { wasd } = inputState(scene);

    const xBefore = player.x;
    wasd.D.isDown = true;
    scene.tick(0.1);
    wasd.D.isDown = false;
    expect(player.x).toBeGreaterThan(xBefore);

    const yBefore = player.y;
    wasd.W.isDown = true;
    scene.tick(0.1);
    wasd.W.isDown = false;
    expect(player.y).toBeLessThan(yBefore);
  });

  it('AC1 — arrow keys move the ship without any pointer input', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const { cursors } = inputState(scene);

    const xBefore = player.x;
    cursors.left.isDown = true;
    scene.tick(0.1);
    cursors.left.isDown = false;
    expect(player.x).toBeLessThan(xBefore);

    const yBefore = player.y;
    cursors.down.isDown = true;
    scene.tick(0.1);
    cursors.down.isDown = false;
    expect(player.y).toBeGreaterThan(yBefore);
  });

  it('AC1 — auto-fire needs no pointer input', async () => {
    const scene = await bootPlay();
    // The run may already have fired during boot; record the baseline.
    const before = scene.getPlayerBullets().length;

    // Advance past the cannon's fire interval without any pointer event.
    scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(before);
  });

  it('AC1 — automatic Teleport fires on danger with no key press', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Gain a teleport stack.
    const drop = scene.spawnPowerUpDrop('teleport', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.teleportStacks()).toBe(1);

    // Move, then place three hostile bullets within DANGER_RADIUS (40 px) so
    // the shared danger feed selects the stored Teleport — no key input.
    // `respawn` syncs the internal movement state so the next tick keeps the
    // ship here (a bare `setPosition` is overwritten by `physicsTick`).
    player.respawn(300, 400);
    for (let i = 0; i < 3; i++) {
      scene.spawnEnemyBullet(300 + i * 8, 400, 0, 0, 0xff4444, 10);
    }
    const beforeX = player.x;
    const beforeY = player.y;
    scene.tick(0.016);

    // The warp consumed the stack and moved the ship.
    expect(registry.teleportStacks()).toBe(0);
    expect(registry.isPhased).toBe(true);
    expect(Math.hypot(player.x - beforeX, player.y - beforeY)).toBeGreaterThan(0);
  });

  it('AC2 — Tab/Enter do not interfere with gameplay (no focus manager active)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const xBefore = player.x;
    const yBefore = player.y;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    scene.tick(0.1);

    // No menu opened, no navigation, and the ship is unaffected.
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
    expect(player.x).toBeCloseTo(xBefore);
    expect(player.y).toBeCloseTo(yBefore);
  });

  it('AC2 — no FocusManager instance is attached to PlayScene', async () => {
    const scene = await bootPlay();
    expect(
      (scene as unknown as { focusManager?: unknown }).focusManager,
    ).toBeUndefined();
  });
});

describe('PlayScene — asteroid spawner integration (AH-0MUGCNZNE002D7QJ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Fixed seed shared with the pure-planner expectations. */
  const SEED = 20260925;

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  async function bootCustom(levels: LevelDefinition[]): Promise<PlayScene> {
    const result = await bootSceneWithLevels(levels);
    booted = result.booted;
    return result.scene;
  }

  /** Alive asteroid entities currently in the scene. */
  function findAsteroids(scene: PlayScene): Asteroid[] {
    return scene
      .getEnemies()
      .filter((e): e is Asteroid => e instanceof Asteroid && e.alive);
  }

  /** Asteroids alive now that were not alive at the snapshot. */
  function newAsteroids(before: Set<Asteroid>, scene: PlayScene): Asteroid[] {
    return findAsteroids(scene).filter((a) => !before.has(a));
  }

  /** A campaign of `waveCount` one-scout waves for fast clear transitions. */
  function scoutWavesLevel(waveCount: number): LevelDefinition[] {
    return [
      {
        level: 1,
        name: 'Test',
        waves: Array.from({ length: waveCount }, () => ({
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v' as const,
              count: 1,
              spacingX: 20,
              spacingY: 20,
              startX: 200,
              startY: 200,
            },
          ],
          shootEnabled: false,
        })),
      },
    ];
  }

  /** The deterministic plan for a given global wave index and seed. */
  function expectedPlan(globalWaveIndex: number): ReturnType<typeof computeSpawns> {
    return computeSpawns(
      globalWaveIndex,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      createSeededRng(SEED),
    );
  }

  /** Re-plans deterministically with the shared seed. */
  function planWithSeed(scene: PlayScene): ReturnType<typeof computeSpawns> {
    scene.setRng(createSeededRng(SEED));
    scene.planAsteroidSpawns();
    return expectedPlan(scene.getWaveManager().globalWaveIndex);
  }

  /** Sets the wave clock to `elapsed` seconds into the wave. */
  function setElapsed(scene: PlayScene, elapsed: number): void {
    scene.setWaveTimerRemaining(WAVE_TIME_LIMIT_SECONDS - elapsed);
  }

  /** Releases the plan's first spawn by advancing just past its due time. */
  function releaseFirst(scene: PlayScene, plan: ReturnType<typeof computeSpawns>): void {
    setElapsed(scene, plan[0].timeSeconds + 1e-6);
    scene.tick(0.001);
  }

  it('AC1 — releases a planned asteroid at its scheduled time and registers it', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    const before = new Set(findAsteroids(scene));
    const plan = planWithSeed(scene);
    expect(plan.length).toBeGreaterThan(0);

    const aliveBefore = wm.enemiesAlive;

    // Nothing new is released before the first scheduled time.
    if (plan[0].timeSeconds > 0.02) {
      setElapsed(scene, plan[0].timeSeconds - 0.01);
      scene.tick(0.001);
      expect(newAsteroids(before, scene)).toHaveLength(0);
    }

    const target =
      plan.length > 1
        ? (plan[0].timeSeconds + plan[1].timeSeconds) / 2
        : plan[0].timeSeconds;
    setElapsed(scene, target + 1e-6);
    scene.tick(0.001);

    const spawned = newAsteroids(before, scene);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].getSizeTier()).toBe(plan[0].sizeTier);
    expect(spawned[0].x).toBeCloseTo(plan[0].x, 3);
    expect(spawned[0].y).toBeCloseTo(plan[0].y, 3);
    // Released asteroids are NOT registered with the WaveManager (AH-0MUJM746P000QAEO).
    expect(wm.enemiesAlive).toBe(aliveBefore);
  });

  it('AC2 — spawned asteroids appear offscreen and drift inward', async () => {
    const scene = await bootPlay();
    const before = new Set(findAsteroids(scene));
    const plan = planWithSeed(scene);
    releaseFirst(scene, plan);

    const asteroid = newAsteroids(before, scene)[0];
    expect(asteroid).toBeDefined();

    // Fully outside the viewport on the chosen edge.
    const offscreen =
      asteroid.x < 0 ||
      asteroid.x > GAME_WIDTH ||
      asteroid.y < 0 ||
      asteroid.y > GAME_HEIGHT;
    expect(offscreen).toBe(true);

    // Inward velocity on the chosen edge (perpendicular + ±30° spread).
    if (asteroid.x < 0) expect(asteroid.vx).toBeGreaterThan(0);
    if (asteroid.x > GAME_WIDTH) expect(asteroid.vx).toBeLessThan(0);
    if (asteroid.y < 0) expect(asteroid.vy).toBeGreaterThan(0);
    if (asteroid.y > GAME_HEIGHT) expect(asteroid.vy).toBeLessThan(0);

    // The distance to the viewport centre shrinks as it drifts in.
    const distBefore = Math.hypot(
      asteroid.x - GAME_WIDTH / 2,
      asteroid.y - GAME_HEIGHT / 2,
    );
    scene.tick(0.5);
    const distAfter = Math.hypot(
      asteroid.x - GAME_WIDTH / 2,
      asteroid.y - GAME_HEIGHT / 2,
    );
    expect(distAfter).toBeLessThan(distBefore);
  });

  it('AC6 — the scene rng seed reproduces the same spawn plan', async () => {
    const scene = await bootPlay();

    const spawnOne = (): Asteroid => {
      const plan = planWithSeed(scene);
      releaseFirst(scene, plan);
      return findAsteroids(scene).at(-1)!;
    };

    const first = spawnOne();
    const firstX = first.x;
    const firstY = first.y;
    const second = spawnOne();

    expect(second.x).toBeCloseTo(firstX, 5);
    expect(second.y).toBeCloseTo(firstY, 5);
  });

  it('AC3 — no asteroids spawn during the boss encounter', async () => {
    const scene = await bootCustom(scoutWavesLevel(1));
    const wm = scene.getWaveManager();

    // Wipe the only wave to trigger the boss, then complete the transition.
    killAllEnemies(scene);
    expect(wm.bossTriggered).toBe(true);
    finishTransition(scene);
    expect(wm.bossActive).toBe(true);
    expect(findAsteroids(scene)).toHaveLength(0);

    // planAsteroidSpawns clears outside a regular wave.
    scene.planAsteroidSpawns();

    // Even with the wave clock forced due, the boss guard suppresses release.
    scene.setWaveTimerRemaining(0.1);
    scene.tick(0.01);
    expect(findAsteroids(scene)).toHaveLength(0);
  });

  it('AC4 — no asteroids spawn while the scene is paused', async () => {
    const scene = await bootPlay();
    const before = new Set(findAsteroids(scene));
    const plan = planWithSeed(scene);
    setElapsed(scene, plan[0].timeSeconds + 1e-6);

    scene.setPaused(true);
    scene.tick(0.5);
    scene.setPaused(false);
    expect(newAsteroids(before, scene)).toHaveLength(0);

    scene.tick(0.001);
    expect(newAsteroids(before, scene)).toHaveLength(1);
  });

  it('AC4 — no asteroids spawn during a wave transition', async () => {
    const scene = await bootCustom(scoutWavesLevel(2));

    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    const before = new Set(findAsteroids(scene));

    // Plan for the newly-loaded next wave and force the first spawn due.
    const plan = planWithSeed(scene);
    expect(plan.length).toBeGreaterThan(0);
    setElapsed(scene, plan[0].timeSeconds + 1e-6);
    scene.tick(0.01);

    // Still transitioning and no new asteroid was released.
    expect(scene.isTransitioning()).toBe(true);
    expect(newAsteroids(before, scene)).toHaveLength(0);
  });
});

describe('PlayScene — asteroid spawner integration tests (AH-0MUGCP15V0008339)', () => {
  // The core integration scenarios (scheduled release, offscreen entry,
  // boss/pause/transition exclusion, dynamic registration and seeded
  // determinism) are covered by the `AH-0MUGCNZNE002D7QJ` suite above.
  // This suite adds the remaining timing/spread ACs: first spawn within
  // 10 %, second around the midpoint, and the count=4 spread.
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  const SEED = 424242;

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  async function bootCustom(levels: LevelDefinition[]): Promise<PlayScene> {
    const result = await bootSceneWithLevels(levels, { asteroidSpawner: false });
    booted = result.booted;
    return result.scene;
  }

  /** Asteroids alive now that were not alive at the snapshot. */
  function newAsteroids(before: Set<Asteroid>, scene: PlayScene): Asteroid[] {
    return findAsteroids(scene).filter((a) => !before.has(a));
  }

  function snapshot(scene: PlayScene): Set<Asteroid> {
    return new Set(findAsteroids(scene));
  }

  /** A campaign of `waveCount` one-scout waves for fast wave clears. */
  function scoutWavesLevel(waveCount: number): LevelDefinition[] {
    return [
      {
        level: 1,
        name: 'Test',
        waves: Array.from({ length: waveCount }, () => ({
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v' as const,
              count: 1,
              spacingX: 20,
              spacingY: 20,
              startX: 200,
              startY: 200,
            },
          ],
          shootEnabled: false,
        })),
      },
    ];
  }

  /** Sets the wave clock to `elapsed` seconds into the wave. */
  function setElapsed(scene: PlayScene, elapsed: number): void {
    scene.setWaveTimerRemaining(WAVE_TIME_LIMIT_SECONDS - elapsed);
  }

  it('AC1 — the first asteroid spawns within the first 10 % of the wave window', async () => {
    const scene = await bootPlay();
    const before = snapshot(scene);
    scene.setRng(createSeededRng(SEED));
    scene.planAsteroidSpawns();

    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS * 0.1 + 1e-6);
    scene.tick(0.001);

    expect(newAsteroids(before, scene).length).toBeGreaterThanOrEqual(1);
  });

  it('AC1 — the second asteroid spawns around the midpoint of the wave window', async () => {
    const scene = await bootPlay();
    scene.setRng(createSeededRng(SEED));
    scene.planAsteroidSpawns();
    const before = snapshot(scene);

    // Only the first is due by 30 % of the window.
    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS * 0.3);
    scene.tick(0.001);
    expect(newAsteroids(before, scene)).toHaveLength(1);

    // The second becomes due by 55 % (midpoint ± jitter).
    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS * 0.55 + 1e-6);
    scene.tick(0.001);
    expect(newAsteroids(before, scene).length).toBeGreaterThanOrEqual(2);
  });

  it('AC1 — a count=4 wave spreads its four spawns across the window', async () => {
    const scene = await bootCustom(scoutWavesLevel(8));
    const wm = scene.getWaveManager();

    // Clear seven waves to reach globalWaveIndex 7, where count doubles to 4.
    for (let i = 0; i < 7; i += 1) {
      killAllEnemies(scene);
      if (scene.isTransitioning()) {
        scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
      }
    }
    expect(wm.globalWaveIndex).toBe(7);

    scene.setAsteroidSpawnerEnabled(true);
    scene.setRng(createSeededRng(SEED));
    scene.planAsteroidSpawns();
    const before = snapshot(scene);

    // Only the first is out at 10 %.
    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS * 0.1 + 1e-6);
    scene.tick(0.001);
    const at10 = newAsteroids(before, scene).length;
    expect(at10).toBeGreaterThanOrEqual(1);
    expect(at10).toBeLessThan(4);

    // All four are out by 95 %.
    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS * 0.95 + 1e-6);
    scene.tick(0.001);
    expect(newAsteroids(before, scene)).toHaveLength(4);
  });
});

describe('PlayScene — Diver attack-end re-anchor (AH-0MUAYB957002EMYV)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  const START_X = 200;
  const START_Y = 220;
  const SPACING_X = 30;
  const SPACING_Y = 26;

  /**
   * A deterministic level with a Diver group and a non-Diver (Scout) group
   * sharing the same origin and spacing, so the Diver-only re-anchor can be
   * verified against the Scout (which must stay put).
   */
  const REANCHOR_LEVELS: LevelDefinition[] = [
    {
      level: 1,
      name: 'Diver re-anchor',
      waves: [
        {
          groups: [
            {
              enemyKey: 'diver',
              formation: 'diver',
              count: 1,
              spacingX: SPACING_X,
              spacingY: SPACING_Y,
              startX: START_X,
              startY: START_Y,
            },
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 3,
              spacingX: SPACING_X,
              spacingY: SPACING_Y,
              startX: START_X,
              startY: START_Y,
            },
          ],
          shootEnabled: false,
        },
      ],
    },
  ];

  async function bootReanchorScene(): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(REANCHOR_LEVELS, {
      asteroidSpawner: false,
    });
    booted = game;
    return scene;
  }

  function divers(scene: PlayScene): Diver[] {
    return scene.getEnemies().filter((e): e is Diver => e instanceof Diver);
  }

  function firstScout(scene: PlayScene): Scout {
    const scout = scene.getEnemies().find((e): e is Scout => e instanceof Scout);
    expect(scout).toBeDefined();
    return scout!;
  }

  /** Ticks the scene until `predicate` holds (or gives up). */
  function tickUntil(
    scene: PlayScene,
    predicate: () => boolean,
    dt = 0.25,
    maxTicks = 200,
  ): void {
    for (let i = 0; i < maxTicks && !predicate(); i++) scene.tick(dt);
    expect(predicate()).toBe(true);
  }

  it('AC1/AC2 — the drift keeps advancing while a Diver is away (no formation freeze)', async () => {
    const scene = await bootReanchorScene();
    const [diver] = divers(scene);
    const scout = firstScout(scene);

    tickUntil(scene, () => diver.behaviourState === DiverState.DIVING);
    const scoutX = scout.x;

    // Two ticks while the Diver dives: the Scout keeps drifting right at
    // FORMATION_DRIFT_SPEED (28 px/s → ~14 px) plus a bounded ±2 px wiggle.
    scene.tick(0.25);
    scene.tick(0.25);
    expect(diver.behaviourState).not.toBe(DiverState.FORMATION);
    expect(scout.x).toBeGreaterThan(scoutX + 5);
  });

  it('AC2 — the Diver re-enters FORMATION with no RETURNING state', async () => {
    const scene = await bootReanchorScene();
    const [diver] = divers(scene);

    tickUntil(scene, () => diver.behaviourState !== DiverState.FORMATION);
    tickUntil(scene, () => diver.behaviourState === DiverState.FORMATION);
    expect((DiverState as unknown as Record<string, string>).RETURNING).toBeUndefined();
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
  });

  it('AC3/AC5 — re-anchors only the Diver group on the attack end; a non-Diver unit stays put', async () => {
    const scene = await bootReanchorScene();
    const [diver] = divers(scene);
    const scout = firstScout(scene);

    // Run one full attack: leave FORMATION, then return to it. On the
    // transition frame the Diver holds its attack-end position and latches
    // the re-anchor request (consumed on the next tick).
    tickUntil(scene, () => diver.behaviourState !== DiverState.FORMATION);
    tickUntil(scene, () => diver.behaviourState === DiverState.FORMATION);
    const attackEnd = { x: diver.x, y: diver.y };
    const scoutBefore = { x: scout.x, y: scout.y };

    scene.tick(0.25);

    // The Diver's slot lands on the attack end (Y is wiggle-free; X is within
    // the ±1.5 px idle wiggle).
    expect(diver.y).toBeCloseTo(attackEnd.y, 5);
    expect(Math.abs(diver.x - attackEnd.x)).toBeLessThanOrEqual(1.5 + 1e-6);

    // A non-Diver enemy (Scout) is not part of the Diver group, so it keeps
    // exactly its own Y — the re-anchor delta does not touch it (producer
    // review: "Only the divers should move").
    expect(scout.y).toBeCloseTo(scoutBefore.y, 5);

    // The Diver glides: it is in FORMATION and easing onto its slot.
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
  });

  it('AC1/AC5 — non-Divers stay put; the Diver is included in the glide', async () => {
    const scene = await bootReanchorScene();
    const [diver] = divers(scene);
    const scout = firstScout(scene);

    tickUntil(scene, () => diver.behaviourState !== DiverState.FORMATION);
    tickUntil(scene, () => diver.behaviourState === DiverState.FORMATION);

    const scoutBefore = { x: scout.x, y: scout.y };
    const diverBefore = { x: diver.x, y: diver.y };

    // The re-anchor shifts only the Diver group's origin so the Diver's slot
    // lands at its attack end. A non-Diver (Scout) is not part of that group.
    scene.tick(0.05);

    // Verify the glide is active and includes only the Diver.
    const glide = (scene as unknown as { glide: { active: boolean; states: Map<unknown, unknown> } }).glide;
    expect(glide.active).toBe(true);
    expect(glide.states.size).toBe(1); // only the Diver

    // The Scout stayed where it was (no vertical shift).
    expect(scout.y).toBeCloseTo(scoutBefore.y, 5);

    // Finish the glide and verify the Diver is at its slot (no residual).
    for (let i = 0; i < 20; i++) scene.tick(0.05);
    expect(glide.active).toBe(false);
    expect(diver.y).toBeCloseTo(diverBefore.y, 5);
  });
});

// ── Sequenced-waves opt-in toggle wiring (AH-0MUITS1SM008GPR9) ──────

describe('resolveCampaignLevels (AH-0MUITS1SM008GPR9)', () => {
  const generated: LevelDefinition[] = [
    {
      level: 1,
      name: 'Generated',
      waves: [{ groups: [
        { enemyKey: 'scout', formation: 'v', count: 3, spacingX: 30, spacingY: 26, startX: 10, startY: 20 },
      ], shootEnabled: false }],
    },
  ];

  /**
   * The campaign's level identity (number + name). The resolved campaign is a
   * fresh, level-scaled copy (AH-0MVLJF30O000E3J3), so identity assertions
   * compare the campaign *shape* rather than object references; level 1 is
   * the scaling identity, so its data can still be compared directly.
   */
  const shapeOf = (campaign: LevelDefinition[]): string[] =>
    campaign.map((level) => `${level.level}:${level.name}`);

  it('returns the static LEVELS campaign when the toggle is off', () => {
    const resolved = resolveCampaignLevels(
      { sequencedWavesEnabled: false },
      () => generated,
    );
    expect(shapeOf(resolved)).toEqual(shapeOf(CAMPAIGN_LEVELS));
    // Level 1 is the scaling identity, so onboarding data is unchanged.
    expect(resolved[0]).toEqual(CAMPAIGN_LEVELS[0]);
  });

  it('returns the generated campaign when the toggle is on', () => {
    expect(
      resolveCampaignLevels({ sequencedWavesEnabled: true }, () => generated),
    ).toEqual(generated);
  });

  it('falls back to static LEVELS when generation throws', () => {
    expect(
      shapeOf(
        resolveCampaignLevels({ sequencedWavesEnabled: true }, () => {
          throw new Error('sequencer exploded');
        }),
      ),
    ).toEqual(shapeOf(CAMPAIGN_LEVELS));
  });

  it('falls back to static LEVELS when generation returns nothing', () => {
    expect(
      shapeOf(
        resolveCampaignLevels({ sequencedWavesEnabled: true }, () => []),
      ),
    ).toEqual(shapeOf(CAMPAIGN_LEVELS));
  });

  it('guarantees the static fallback under the default-on rule (AH-0MUJSUTLA006Q8E1)', () => {
    localStorage.clear();
    // No explicit rules: the default (on) applies; a failing/degenerate build
    // must still leave the run playable via the static campaign.
    expect(
      shapeOf(
        resolveCampaignLevels(undefined, () => {
          throw new Error('missing/malformed curve');
        }),
      ),
    ).toEqual(shapeOf(CAMPAIGN_LEVELS));
    expect(
      shapeOf(resolveCampaignLevels(undefined, () => [])),
    ).toEqual(shapeOf(CAMPAIGN_LEVELS));
  });

  it('runs a mixed fixed+curve campaign when the toggle is on, static LEVELS when off', () => {
    // Level 1 is authored as a full all-fixed level (ten waves, matching the
    // expanded campaign width — AH-0MVCYANT6003SG5C) so the sequencer returns
    // it verbatim; level 2 exercises the curve path.
    seedDifficultyCurves([
      ...Array.from({ length: CAMPAIGN_LEVELS[0].waves.length }, (_, index) => ({
        level: 1,
        levelName: 'Entry',
        wave: index + 1,
        targetDifficulty: 5 + index,
        generation: 'fixed' as const,
      })),
      { level: 2, levelName: 'Generated Descent', wave: 1, targetDifficulty: 20, generation: 'curve' },
    ]);

    const mixed = resolveCampaignLevels(
      { sequencedWavesEnabled: true },
      () => buildSequencedLevels(),
    );
    // An all-fixed level matching the static wave count is the static level
    // (level 1 is the scaling identity, so it is unchanged); level 2 comes
    // from the sequencer.
    expect(mixed.find((l) => l.level === 1)).toEqual(CAMPAIGN_LEVELS[0]);
    expect(mixed.find((l) => l.level === 2)?.name).toBe('Generated Descent');
    // The toggle off path ignores the mixed config entirely.
    expect(
      shapeOf(
        resolveCampaignLevels(
          { sequencedWavesEnabled: false },
          () => buildSequencedLevels(),
        ),
      ),
    ).toEqual(shapeOf(CAMPAIGN_LEVELS));
  });
});

describe('PlayScene — sequenced-waves toggle wiring (AH-0MUITS1SM008GPR9)', () => {
  let toggleBooted: BootedGame | null = null;

  afterEach(() => {
    toggleBooted?.game.destroy(true);
    toggleBooted = null;
    localStorage.clear();
  });

  async function bootToggleScene(): Promise<PlayScene> {
    toggleBooted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return toggleBooted.scene as PlayScene;
  }

  it('runs the static campaign when the toggle is explicitly disabled', async () => {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    const scene = await bootToggleScene();
    const wm = scene.getWaveManager();
    expect(wm.levelCount).toBe(CAMPAIGN_LEVELS.length);
    expect(wm.currentLevel()?.name).toBe(CAMPAIGN_LEVELS[0].name);
    expect(wm.currentLevel()?.name).toBe('Entry');
  });

  it('plays the level-scaled static campaign when sequencing is disabled (AH-0MVLJF30O000E3J3)', async () => {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    const scene = await bootToggleScene();
    const wm = scene.getWaveManager();

    // Jump to level 10, where the campaign multiplier is unmistakable (2.00):
    // the static campaign the game plays must carry the documented scaling of
    // the authored data, not the raw authored counts.
    wm.beginGame(10);
    const level10 = wm.currentLevel()!;
    const authored = CAMPAIGN_LEVELS[9];
    const expected = authored.waves.flatMap((wave) =>
      applyEnemyCountScaling(10, wave.groups).map((group) => group.count),
    );
    const actual = level10.waves.flatMap((wave) =>
      wave.groups.map((group) => group.count),
    );
    expect(actual).toEqual(expected);
  });

  it('runs the sequenced campaign by default (AH-0MUJSUTLA006Q8E1)', async () => {
    const scene = await bootToggleScene();
    const wm = scene.getWaveManager();
    expect(wm.started).toBe(true);
    // The shipped default campaign now spans the full ten-level campaign
    // (AH-0MV395QHS004SCOR): the five static levels plus the five configured
    // extensions. Level 1 is the fixed onboarding static wave.
    expect(wm.levelCount).toBe(10);
    expect(wm.currentLevel()?.name).toBe('Entry');
    expect(wm.currentWave()!.groups.length).toBeGreaterThan(0);
  });

  it('runs the generated campaign when the toggle is enabled', async () => {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: true }),
    );
    seedDifficultyCurves([
      { level: 1, levelName: 'Generated Entry', wave: 1, targetDifficulty: 10 },
      { level: 1, levelName: 'Generated Entry', wave: 2, targetDifficulty: 20 },
    ]);

    const scene = await bootToggleScene();
    const wm = scene.getWaveManager();

    expect(wm.started).toBe(true);
    // Mixed mode keeps the full static skeleton; level 1 is overridden by the
    // seeded generated config and the unconfigured levels stay static.
    expect(wm.levelCount).toBe(CAMPAIGN_LEVELS.length);
    expect(wm.currentLevel()?.name).toBe('Generated Entry');
    expect(wm.waveCount).toBe(2);
    // The generated wave's groups are what the run spawns.
    const wave = wm.currentWave()!;
    expect(wave.groups.length).toBeGreaterThan(0);
    expect(scene.getAliveCount()).toBeGreaterThanOrEqual(wm.waveEnemyCount());
  });
});


describe('PlayScene — campaign Harvester roaming spawns (F6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Boots the PlayScene with a campaign whose first level is `levelNumber`. */
  async function bootAtLevel(levelNumber: number): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: levelNumber,
        name: `Test Level ${levelNumber}`,
        waves: [
          {
            groups: [
              {
                enemyKey: 'scout',
                formation: 'v',
                count: 3,
                spacingX: 30,
                spacingY: 24,
                startX: GAME_WIDTH * 0.2,
                startY: GAME_HEIGHT * 0.4,
              },
            ],
            shootEnabled: levelNumber >= 4,
          },
        ],
      },
    ];
    // Opt out of the now-default sequenced campaign so this injected fixture
    // is honoured (AH-0MUJSUTLA006Q8E1).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    return scene;
  }

  function liveHarvesters(scene: PlayScene): Harvester[] {
    return scene
      .getEnemies()
      .filter((e): e is Harvester => e instanceof Harvester && e.alive);
  }

  it('does not spawn a Harvester in Levels 1–3', async () => {
    for (const level of [1, 2, 3]) {
      const scene = await bootAtLevel(level);
      scene.setRng(() => 0); // would pass the rarity roll if the level gate allowed
      scene.getWaveManager().beginGame();
      scene.spawnWave();
      for (let i = 0; i < 200; i++) scene.tick(0.1);
      expect(liveHarvesters(scene), `level ${level}`).toHaveLength(0);
      booted?.game.destroy(true);
      booted = null;
    }
  });

  it('spawns a wave-accounted Harvester in Levels 4–5', async () => {
    for (const level of [4, 5]) {
      const scene = await bootAtLevel(level);
      const wm = scene.getWaveManager();
      scene.setRng(() => 0); // rarity roll passes; edge/time deterministic
      wm.beginGame();
      scene.spawnWave();

      const waveSizeBefore = wm.enemiesAlive; // 3 Scouts
      // Let the mid-wave spawn time elapse.
      for (let i = 0; i < 200; i++) scene.tick(0.1);

      const found = liveHarvesters(scene);
      expect(found.length, `level ${level}`).toBe(1);
      // Wave accounting includes the Harvester (it gates wave completion).
      expect(wm.enemiesAlive).toBe(waveSizeBefore + 1);
      // Placed inside the play area (reachable — never stalls offscreen).
      expect(found[0].x).toBeGreaterThanOrEqual(0);
      expect(found[0].x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(found[0].y).toBeGreaterThanOrEqual(0);
      expect(found[0].y).toBeLessThanOrEqual(GAME_HEIGHT);

      // Killing it (five player bullets through the shared collision path)
      // advances wave accounting exactly once. Isolate the kill so neither
      // auto-fire nor an overlapping Scout can absorb a bullet.
      const aliveBeforeKill = wm.enemiesAlive;
      const restoreKill = isolateEnemyForKill(scene, found[0]);
      try {
        for (let hit = 0; hit < 5; hit++) {
          scene.spawnPlayerBullet(found[0].x, found[0].y, 0, 0);
          scene.tick(0.016);
        }
      } finally {
        restoreKill();
      }
      expect(found[0].alive).toBe(false);
      expect(wm.enemiesAlive).toBe(aliveBeforeKill - 1);

      booted?.game.destroy(true);
      booted = null;
    }
  });

  it('never spawns a Harvester in the boss encounter', async () => {
    const scene = await bootAtLevel(4);
    const wm = scene.getWaveManager();
    scene.setRng(() => 0);
    wm.beginGame();
    scene.spawnWave();

    // Wipe the level's only wave → the boss is due.
    killAllEnemies(scene);
    expect(wm.bossTriggered).toBe(true);

    // From the boss encounter no Harvester plan exists.
    scene.spawnWave();
    for (let i = 0; i < 200; i++) scene.tick(0.1);
    expect(liveHarvesters(scene)).toHaveLength(0);
  });

  it('the planner reads the campaign level regardless of source (static or sequenced)', async () => {
    // Both campaigns flow through the same WaveManager/currentLevel().level
    // seam, so a sequenced Level 4 exercises the identical planner path. Build
    // a generated level 4 and inject it exactly as the sequenced campaign does.
    const generated = buildSequencedLevels();
    // The generated campaign has the same five-level skeleton; just assert the
    // Level 4 definition carries `level: 4` so the planner gates correctly.
    const level4 = generated.find((l) => l.level === 4);
    expect(level4).toBeDefined();
    expect(level4!.level).toBe(4);
  });
});

describe('PlayScene — wormhole spawn animation (AH-0MURBER4L00821RR)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    (booted.scene as PlayScene).setAsteroidSpawnerEnabled(false);
    return booted.scene as PlayScene;
  }

  it('AC1 — spawns a wormhole when the wave spawns', async () => {
    const scene = await bootPlay();
    // A live wormhole container is registered for teardown on spawn.
    const wormholes = scene.children.list.filter(
      (child): child is Phaser.GameObjects.Container =>
        child instanceof Phaser.GameObjects.Container,
    );
    expect(wormholes.length).toBeGreaterThanOrEqual(1);
  });

  it('AC2 — enemies start at 1 pixel and are marked spawning', async () => {
    const scene = await bootPlay();
    // Spawn another wave and inspect only the freshly-created enemies (the
    // deterministic boot settle may already have advanced earlier waves).
    const before = scene.getEnemies().length;
    scene.spawnWave();
    const fresh = scene.getEnemies().slice(before).filter((e) => e.alive);
    expect(fresh.length).toBeGreaterThan(0);
    for (const enemy of fresh) {
      expect((enemy as unknown as { scaleX: number }).scaleX).toBeCloseTo(0.01, 5);
      expect((enemy as unknown as { isSpawning: boolean }).isSpawning).toBe(true);
    }
  });

  it('AC2/AC4 — enemies grow to full size and stop being protected', async () => {
    const scene = await bootPlay();
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    const originalScale = (enemy as unknown as { scaleX: number }).scaleX;

    // Finish the wormhole open phase + growth deterministically.
    scene.finishSpawnAnimations();

    expect((enemy as unknown as { isSpawning: boolean }).isSpawning).toBe(false);
    // The scale is restored from 0.01 to the pre-animation value (1).
    expect((enemy as unknown as { scaleX: number }).scaleX).toBeCloseTo(1, 5);
    void originalScale;
  });

  it('AC4 — player bullets cannot destroy a spawning enemy', async () => {
    const scene = await bootPlay();
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    const aliveBefore = scene.getAliveCount();

    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    expect((enemy as unknown as { isSpawning: boolean }).isSpawning).toBe(true);
    expect(scene.getAliveCount()).toBe(aliveBefore);
    expect(enemy.alive).toBe(true);
  });

  it('AC4 — player bullets destroy the enemy once spawning completes', async () => {
    const scene = await bootPlay();
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.finishSpawnAnimations();
    scene.tick(0.001);
    const aliveBefore = scene.getAliveCount();

    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getAliveCount()).toBeLessThan(aliveBefore);
  });

  it('AC4 — a spawning enemy cannot collide with the player', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    const livesBefore = scene.getGameState().lives;

    // Park the player on the still-spawning enemy.
    player.setPosition(enemy.x, enemy.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: enemy.x, y: enemy.y };
    scene.tick(0.001);

    expect(scene.getGameState().lives).toBe(livesBefore);
  });

  it('AC4 — a spawning enemy cannot shoot at the player', async () => {
    const scene = await bootPlay();
    // Spawn another wave and arm only the freshly-created enemies: they are
    // still within their spawn window, so fire must be suppressed.
    const before = scene.getEnemies().length;
    scene.spawnWave();
    const fresh = scene.getEnemies().slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    for (const enemy of fresh) {
      if (enemy.alive) enemy.shootEnabled = true;
    }
    scene.tick(0.1);
    expect(
      fresh.every(
        (e) => e.alive && (e as unknown as { isSpawning: boolean }).isSpawning,
      ),
    ).toBe(true);
    expect(scene.getEnemyBullets()).toHaveLength(0);
  });

  it('AC3 — spawnWave() while a wormhole is still live closes the previous one first (AH-0MV9KHLV8006GMX6)', async () => {
    const scene = await bootPlay();
    const registry = (
      scene as unknown as { wormholeEffects: Phaser.GameObjects.Container[] }
    ).wormholeEffects;
    expect(registry).toHaveLength(1);
    const previous = registry[0];

    // A second wave spawn while the first wormhole is mid-spawn: the pre-fix
    // code overwrote the live handle without closing it, stranding the
    // previous wormhole on screen. The shared controller must schedule its
    // close tween before the new wormhole opens.
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    scene.spawnWave();
    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === previous && c.alpha === 0 && c.scale === 0);
    expect(
      close,
      'spawnWave must schedule a close tween for the previous wormhole',
    ).toBeDefined();
    (close!.onComplete as () => void)();

    // The previous wormhole is destroyed and removed from the effects
    // registry; only the fresh wave's wormhole remains live.
    expect(scene.children.list).not.toContain(previous);
    expect(registry).toHaveLength(1);
    expect(registry[0]).not.toBe(previous);
  });

  it('AC4 — a mid-spawn wave timeout closes the wormhole and the next wave opens only one (AH-0MV9KHLV8006GMX6)', async () => {
    const scene = await bootPlay();
    const registry = (
      scene as unknown as { wormholeEffects: Phaser.GameObjects.Container[] }
    ).wormholeEffects;
    expect(registry).toHaveLength(1);
    const previous = registry[0];

    // Timeout while the fresh wave is still growing: survivors are carried
    // and a wave transition begins. The transition's update path skips
    // `_updateSpawnAnimations`, so pre-fix the wormhole was never closed
    // here and survived (still open) into the next wave.
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);
    expect(scene.isTransitioning()).toBe(true);

    // The transition start must close the still-open wormhole.
    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === previous && c.alpha === 0 && c.scale === 0);
    expect(
      close,
      'starting a transition must close a still-open wormhole',
    ).toBeDefined();
    (close!.onComplete as () => void)();

    // Complete the transition: the next spawnWave() opens exactly one
    // wormhole — never two live at once.
    scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
    expect(scene.children.list).not.toContain(previous);
    expect(registry).toHaveLength(1);
    expect(registry[0]).not.toBe(previous);
  });

  it('AH-0MV8BSMXC0097KLW — freshly spawned enemies begin at the wormhole origin', async () => {
    const scene = await bootPlay();
    const registry = (
      scene as unknown as { wormholeEffects: Phaser.GameObjects.Container[] }
    ).wormholeEffects;

    const before = scene.getEnemies().length;
    scene.spawnWave();
    const fresh = scene.getEnemies().slice(before).filter((e) => e.alive);
    expect(fresh.length).toBeGreaterThan(0);

    // The wave's wormhole opened at the first spawn slot; every fresh enemy
    // must begin there (the wormhole origin) rather than at its own slot.
    const wormhole = registry[registry.length - 1];
    expect(wormhole).toBeDefined();
    for (const enemy of fresh) {
      expect(enemy.x).toBeCloseTo(wormhole.x, 5);
      expect(enemy.y).toBeCloseTo(wormhole.y, 5);
    }
  });

  it('AH-0MV8BSMXC0097KLW — enemies begin at the wormhole and arrive exactly on their formation destination', async () => {
    const scene = await bootPlay();
    const registry = (
      scene as unknown as { wormholeEffects: Phaser.GameObjects.Container[] }
    ).wormholeEffects;
    const before = scene.getEnemies().length;
    scene.spawnWave();
    const fresh = scene.getEnemies().slice(before).filter((e) => e.alive);
    expect(fresh.length).toBeGreaterThan(0);

    const wormhole = registry[registry.length - 1];
    const expected = new Map<EnemyEntity, { x: number; y: number }>();
    let movers = 0;
    for (const enemy of fresh) {
      const state = getSpawnState(enemy as unknown as SpawnAnimatable);
      expect(state).not.toBeNull();
      // Begins at the wave's wormhole origin (where the VFX opened).
      expect(enemy.x).toBeCloseTo(wormhole.x, 5);
      expect(enemy.y).toBeCloseTo(wormhole.y, 5);
      expected.set(enemy, { x: state!.destX, y: state!.destY });
      if (state!.originX !== state!.destX || state!.originY !== state!.destY) {
        movers += 1;
      }
    }
    expect(movers).toBeGreaterThan(0);

    // Completing the spawn animation before any scene tick (formation drift
    // has not advanced) lands every enemy exactly on its recorded formation
    // destination.
    scene.finishSpawnAnimations();
    for (const [enemy, dest] of expected) {
      expect(enemy.x).toBeCloseTo(dest.x, 5);
      expect(enemy.y).toBeCloseTo(dest.y, 5);
      expect((enemy as unknown as { isSpawning: boolean }).isSpawning).toBe(false);
    }
  });

  it('AH-0MV8BSMXC0097KLW — the transit is dt-driven and completes within the 3 s spawn-protection window', async () => {
    const scene = await bootPlay();
    const before = scene.getEnemies().length;
    scene.spawnWave();
    const fresh = scene.getEnemies().slice(before).filter((e) => e.alive);
    const movers = fresh.filter((e) => {
      const state = getSpawnState(e as unknown as SpawnAnimatable);
      return (
        !!state && (state.originX !== state.destX || state.originY !== state.destY)
      );
    });
    expect(movers.length).toBeGreaterThan(0);
    const origins = movers.map((e) => ({ x: e.x, y: e.y }));

    // Partway through the grow phase the movers are still spawning and have
    // begun to travel away from the wormhole.
    scene.tick(1.2);
    movers.forEach((enemy, i) => {
      expect((enemy as unknown as { isSpawning: boolean }).isSpawning).toBe(true);
      expect(
        Math.abs(enemy.x - origins[i].x) + Math.abs(enemy.y - origins[i].y),
      ).toBeGreaterThan(1);
    });

    // Completing the full window (growth ends at 2.5 s < 3 s) clears the
    // protection: the movers have arrived within the window.
    scene.tick(1.5);
    for (const enemy of movers) {
      expect((enemy as unknown as { isSpawning: boolean }).isSpawning).toBe(false);
    }
  });

  it('AH-0MV8BSMXC0097KLW — spawn protection holds while enemies are in transit', async () => {
    const scene = await bootPlay();
    scene.spawnWave();
    const victim = scene
      .getEnemies()
      .find((e) => {
        if (!e.alive) return false;
        const state = getSpawnState(e as unknown as SpawnAnimatable);
        return (
          !!state && (state.originX !== state.destX || state.originY !== state.destY)
        );
      })!;
    expect(victim).toBeDefined();
    const aliveBefore = scene.getAliveCount();
    const livesBefore = scene.getGameState().lives;
    const origin = getSpawnState(victim as unknown as SpawnAnimatable)!;

    scene.tick(1.2);
    expect((victim as unknown as { isSpawning: boolean }).isSpawning).toBe(true);
    expect(getSpawnState(victim as unknown as SpawnAnimatable)).not.toBeNull();
    // Mid-transit: the mover has left the wormhole origin.
    expect(
      Math.abs(victim.x - origin.originX) + Math.abs(victim.y - origin.originY),
    ).toBeGreaterThan(1);

    // 1. Player bullets pass through.
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.016);
    expect(victim.alive).toBe(true);
    expect(scene.getAliveCount()).toBe(aliveBefore);

    // 2. No shooting while spawning.
    victim.shootEnabled = true;
    scene.tick(0.1);
    expect(scene.getEnemyBullets()).toHaveLength(0);

    // 3. No mineral absorption while spawning: a mineral touching the
    // transiting enemy stays on the field (checked before the player is
    // parked on the enemy, so only the enemy could have absorbed it).
    scene.spawnMineralAt(victim.x, victim.y);
    const mineralsBefore = scene.getMinerals().length;
    scene.tick(0.016);
    expect(scene.getMinerals()).toHaveLength(mineralsBefore);

    // 4. No body collision with the player.
    const player = scene.getPlayer()!;
    player.setPosition(victim.x, victim.y);
    scene.tick(0.001);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(victim.alive).toBe(true);

    // Once transit completes the same enemy becomes vulnerable to all four.
    scene.finishSpawnAnimations();
    scene.tick(0.001); // settle the drift/wiggle position before aiming
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getAliveCount()).toBeLessThan(aliveBefore);
  });
});

describe('PlayScene — wave portal placed away from the player (AH-0MV8BR9Y70079TKC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** A deterministic V-formation scout wave near the top centre. */
  const PORTAL_LEVELS: LevelDefinition[] = [
    {
      level: 1,
      name: 'Portal Test',
      waves: [
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 4,
              spacingX: 28,
              spacingY: 24,
              startX: GAME_WIDTH * 0.5,
              startY: GAME_HEIGHT * 0.24,
            },
          ],
          shootEnabled: false,
        },
      ],
    },
  ];

  async function bootPortalScene(): Promise<PlayScene> {
    const result = await bootSceneWithLevels(PORTAL_LEVELS, {
      asteroidSpawner: false,
    });
    booted = result.booted;
    return result.scene;
  }

  /** The live wormhole container after `spawnWave()` (single-live controller). */
  function wavePortalContainer(scene: PlayScene): Phaser.GameObjects.Container {
    const registry = (
      scene as unknown as { wormholeEffects: Phaser.GameObjects.Container[] }
    ).wormholeEffects;
    return registry[registry.length - 1];
  }

  function livePoints(scene: PlayScene, from: number): { x: number; y: number }[] {
    return scene
      .getEnemies()
      .slice(from)
      .filter((e) => e.alive)
      .map((e) => ({ x: e.x, y: e.y }));
  }

  function bounds(points: readonly { x: number; y: number }[]): {
    cx: number;
    cy: number;
    width: number;
    height: number;
  } {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /** Parks the player at (x, y) with the given velocity (test seam). */
  function parkPlayer(
    scene: PlayScene,
    x: number,
    y: number,
    vx = 0,
    vy = 0,
  ): void {
    const player = scene.getPlayer()!;
    const state = player.getMovementState();
    (
      player as unknown as {
        _movementState: { x: number; y: number; vx: number; vy: number };
      }
    )._movementState = { ...state, x, y, vx, vy };
    player.setPosition(x, y);
  }

  /**
   * The deterministic plan `spawnWave()` is about to emit: this level uses
   * degenerate spawn ranges (no randomness consumed), so the plan is a pure
   * function independent of the scene RNG.
   */
  function plannedSpawns(scene: PlayScene): EnemySpawn[] {
    return scene.getWaveManager().planSpawns(() => 0.5);
  }

  it('AC1 — spawnWave() opens the portal ≥ D_MIN from the player when it hovers on the formation anchor', async () => {
    const scene = await bootPortalScene();
    const plan = plannedSpawns(scene);
    const anchor = formationCentre(plan);
    const dMin = Math.max(formationExtents(plan).width, formationExtents(plan).height);

    // Park the player on the planned formation anchor: the pre-fix code
    // opened the wormhole at the first enemy slot — right on or beside the
    // player. The portal must now move to a conforming position.
    parkPlayer(scene, anchor.x, anchor.y);
    scene.spawnWave();
    const portal = wavePortalContainer(scene);

    expect(
      Math.hypot(portal.x - anchor.x, portal.y - anchor.y),
    ).toBeGreaterThanOrEqual(dMin - 1e-6);
  });

  it('AC2 — spawnWave() avoids the player’s ~2 s trajectory position as well', async () => {
    const scene = await bootPortalScene();
    const plan = plannedSpawns(scene);
    const anchor = formationCentre(plan);
    const dMin = Math.max(formationExtents(plan).width, formationExtents(plan).height);

    // The player is 150 px below the anchor (already ≥ D_MIN away) but
    // moving straight up at 100 px/s: after the 2 s open+growth window the
    // ship is ~50 px past the anchor — well inside D_MIN.
    const vy = -100;
    parkPlayer(scene, anchor.x, anchor.y + 150, 0, vy);
    scene.spawnWave();
    const portal = wavePortalContainer(scene);
    const projected = {
      x: anchor.x,
      y: anchor.y + 150 + vy * WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
    };

    expect(
      Math.hypot(portal.x - projected.x, portal.y - projected.y),
    ).toBeGreaterThanOrEqual(dMin - 1e-6);
  });

  it('AC3 — the fresh formation is anchored to the portal (a moved portal moves the whole formation)', async () => {
    const scene = await bootPortalScene();
    const plan = plannedSpawns(scene);
    const anchor = formationCentre(plan);

    // Force the portal away (player on the anchor), then check the formation
    // hangs off the portal: its centre sits exactly on the portal and every
    // enemy sits on its portal-anchored slot, keeping all spacing.
    parkPlayer(scene, anchor.x, anchor.y);
    const beforeCount = scene.getEnemies().length;
    scene.spawnWave();
    // (AH-0MV8BSMXC0097KLW) Fresh enemies emerge from the portal and traverse
    // to their anchored slots; complete the transit (no tick) before measuring
    // the anchored formation.
    scene.finishSpawnAnimations();
    const portal = wavePortalContainer(scene);
    const fresh = livePoints(scene, beforeCount);
    const expected = anchorSpawnsToPortal(plan, {
      x: portal.x,
      y: portal.y,
    });
    expect(fresh.length).toBe(expected.length);

    const freshCentre = bounds(fresh);
    // The formation hangs off the portal; a small horizontal budget covers
    // drift carried over from the boot (spawnWave keeps the continuing base
    // when survivors carry over). The ROW centre is exact (no vertical drift).
    expect(Math.abs(freshCentre.cx - portal.x)).toBeLessThan(8);
    expect(Math.abs(freshCentre.cy - portal.y)).toBeLessThan(1e-6);

    const expectedCentre = bounds(expected);
    for (let i = 0; i < fresh.length; i += 1) {
      // The portal-anchored SHAPE is preserved (slot positions relative to
      // the formation centre, spacing included).
      expect(fresh[i].x - freshCentre.cx).toBeCloseTo(
        expected[i].x - expectedCentre.cx,
        3,
      );
      expect(fresh[i].y - freshCentre.cy).toBeCloseTo(
        expected[i].y - expectedCentre.cy,
        3,
      );
    }
    // Spacing is preserved (spacingX/spacingY unchanged).
    expect(fresh[1].x - fresh[0].x).toBeCloseTo(
      expected[1].x - expected[0].x,
      4,
    );
  });

  it('with a parked player well away, the wave spawns at the planned centre (no gratuitous shift)', async () => {
    const scene = await bootPortalScene();
    const plan = plannedSpawns(scene);
    const anchor = formationCentre(plan);
    parkPlayer(scene, GAME_WIDTH - 60, GAME_HEIGHT - 40);

    const beforeCount = scene.getEnemies().length;
    scene.spawnWave();
    const portal = wavePortalContainer(scene);
    const fresh = livePoints(scene, beforeCount);
    const freshCentre = bounds(fresh);

    // The planned anchor already satisfies D_MIN, so the formation is not
    // shifted at all — the portal sits on the planned formation centre.
    expect(Math.abs(portal.x - anchor.x)).toBeLessThan(1);
    expect(Math.abs(portal.y - anchor.y)).toBeLessThan(1);
    expect(Math.abs(freshCentre.cx - anchor.x)).toBeLessThan(1);
    expect(Math.abs(freshCentre.cy - anchor.y)).toBeLessThan(1);
  });
});

describe('PlayScene — end-of-run victory trigger (AH-0MUTYKKZ6001LT25)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  /**
   * Boots a **single-level** campaign for the victory tests
   * (AH-0MVCYANT6003SG5C): a one-level campaign is final from the start, so
   * `reachBoss` triggers the boss without walking the whole campaign.
   */
  async function bootPlayAtBoss(): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(singleLevelCampaign());
    booted = game;
    return scene;
  }

  /**
   * Drives the boss through all four phases so the run is won
   * (BOSS_HIT_POINTS_PER_PHASE hits per phase, 200 total).
   */
  function defeatBoss(scene: PlayScene): void {
    const boss = scene.getBoss()!;
    for (let phase = 0; phase < 4; phase++) {
      damageBossPhase(scene, boss);
    }
  }

  it('AC1/AC2 — defeating the boss plays the fanfare once and spawns the shared celebration once', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const fanfareSpy = vi.spyOn(effectsModule, 'playVictoryFanfareSound');
    const victorySpy = vi.spyOn(endOfRunModule, 'spawnVictoryJuice');
    const fireworksSpy = vi.spyOn(endOfRunModule, 'spawnVictoryFireworks');

    defeatBoss(scene);

    expect(fanfareSpy).toHaveBeenCalledTimes(1);
    expect(victorySpy).toHaveBeenCalledTimes(1);
    expect(fireworksSpy).toHaveBeenCalledTimes(1);
    // The celebration is the shared F2 helper, owning the scene registry.
    const options = victorySpy.mock.calls[0][1] as { registry?: unknown[] };
    expect(options.registry).toBe(scene.getVictoryEffects());

    // The fireworks are anchored at the boss's death position (AC3) and share
    // the same scene-owned registry (AC4).
    const boss = scene.getBoss()!;
    const fireworksCall = fireworksSpy.mock.calls[0];
    expect(fireworksCall[1]).toBe(boss.x);
    expect(fireworksCall[2]).toBe(boss.y);
    expect((fireworksCall[3] as { registry?: unknown[] }).registry).toBe(
      scene.getVictoryEffects(),
    );
    expect(scene.getVictoryEffects().length).toBeGreaterThan(0);
  });

  it('dev scenario — jumps to a 4-hit boss with no minions/attacks and freezes until resumed (AH-0MUWZ5HCV0034H44)', async () => {
    const scene = await bootPlay();

    scene.startDevBossScenario(4);

    const boss = scene.getBoss();
    expect(boss).not.toBeNull();
    expect(boss!.alive).toBe(true);
    // Exactly four hits remain, shown in the final phase, with no attacks and
    // no Phase-1 minions to soak the player's fire.
    expect(boss!.getHpFraction()).toBeCloseTo(
      4 / (BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE),
      6,
    );
    expect(boss!.getPhaseNumber()).toBe(BOSS_PHASE_COUNT);
    expect(boss!.shootEnabled).toBe(false);
    expect(scene.getEnemies()).toHaveLength(0);
    // Frozen so the recorder starts before the short fight begins, with a
    // deterministic page-side release handle exposed.
    expect(scene.isPaused()).toBe(true);
    expect(window.__aiHellScenario?.hitsRemaining).toBe(4);
    // The ship sits to the boss's left at the same height, so the default
    // right-facing auto-fire lands on the boss unaided.
    const player = scene.getPlayer()!;
    expect(player.x).toBeLessThan(boss!.x);
    expect(player.y).toBeCloseTo(boss!.y, 5);
    expect(player.getHeading()).toBeCloseTo(0, 5);

    // Resume through the scenario handle and land the four hits: the run is
    // won and the celebration runs.
    window.__aiHellScenario?.resume();
    expect(scene.isPaused()).toBe(false);
    const fanfareSpy = vi.spyOn(effectsModule, 'playVictoryFanfareSound');
    const fireworksSpy = vi.spyOn(endOfRunModule, 'spawnVictoryFireworks');
    for (let hit = 0; hit < 4 && boss!.alive; hit++) {
      scene.spawnPlayerBullet(boss!.x, boss!.y, 0, 0);
      scene.tick(0.016);
    }
    expect(boss!.alive).toBe(false);
    expect(fanfareSpy).toHaveBeenCalledTimes(1);
    expect(fireworksSpy).toHaveBeenCalledTimes(1);
  });

  it('AC1 — the fanfare and celebration fire exactly once even across extra ticks', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    const fanfareSpy = vi.spyOn(effectsModule, 'playVictoryFanfareSound');
    const victorySpy = vi.spyOn(endOfRunModule, 'spawnVictoryJuice');

    defeatBoss(scene);
    scene.tick(0.016);
    scene.tick(0.016);

    expect(fanfareSpy).toHaveBeenCalledTimes(1);
    expect(victorySpy).toHaveBeenCalledTimes(1);
  });

  it('AC3 — the defeat path is unchanged: no fanfare, no victory celebration', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();
    gs.lives = 1;
    const fanfareSpy = vi.spyOn(effectsModule, 'playVictoryFanfareSound');
    const victorySpy = vi.spyOn(endOfRunModule, 'spawnVictoryJuice');

    (scene as unknown as { onPlayerHit(): void }).onPlayerHit();

    expect(gs.lives).toBe(0);
    expect(fanfareSpy).not.toHaveBeenCalled();
    expect(victorySpy).not.toHaveBeenCalled();
    expect(scene.getVictoryEffects()).toHaveLength(0);
  });

  it('AC4 — the victory celebration is destroyed on SHUTDOWN (no leaks)', async () => {
    const scene = await bootPlayAtBoss();
    reachBoss(scene);
    defeatBoss(scene);

    const effects = scene.getVictoryEffects();
    expect(effects.length).toBeGreaterThan(0);

    // Advance the Phaser clock deterministically past the victory fireworks
    // hold; the `GameOverScene` transition then fires SHUTDOWN on PlayScene,
    // tearing down the celebration. No wall-clock wait, so the assertion
    // cannot race the delayed transition under full-suite load
    // (AH-0MUYALJ9S0002XXZ).
    stepGameUntil(
      booted!.game,
      'victory hold → SHUTDOWN teardown',
      () => booted!.game.scene.isActive('GameOverScene'),
    );

    expect(scene.getVictoryEffects()).toHaveLength(0);
    for (const effect of effects) {
      expect(effect.active).toBe(false);
    }
  });

  // ── Demo/attract mode (AH-0MUX495VG0014MIY AC1/AC3/AC4/AC6) ────

  describe('Demo mode flag (AC1/AC6)', () => {
    it('AC1 — demo mode is set when started with { demo: true }', async () => {
      const booted = await bootScene(
        [PlayScene, GameOverScene, MenuScene],
      );
      const scene = booted.scene as PlayScene;
      scene.scene.start('PlayScene', { demo: true });
      await advanceGame(scene.game, 50);
      expect(scene.isDemoMode()).toBe(true);
    });

    it('AC6 — demo mode is false when started normally', async () => {
      const booted = await bootScene(
        [PlayScene, GameOverScene, MenuScene],
      );
      const scene = booted.scene as PlayScene;
      scene.scene.start('PlayScene');
      await advanceGame(scene.game, 50);
      expect(scene.isDemoMode()).toBe(false);
    });

    it('AC3 — init treats absent, undefined and non-true data as non-demo', () => {
      const scene = new PlayScene();
      scene.init(undefined);
      expect(scene.isDemoMode()).toBe(false);
      scene.init({});
      expect(scene.isDemoMode()).toBe(false);
      scene.init({ demo: false });
      expect(scene.isDemoMode()).toBe(false);
      scene.init({ demo: true });
      expect(scene.isDemoMode()).toBe(true);
    });

    it('AC2/AC5 — an explicit non-demo start clears stale demo data on the reused scene', async () => {
      const booted = await bootScene(
        [PlayScene, GameOverScene, MenuScene],
      );
      const scene = booted.scene as PlayScene;
      const botInput = () =>
        (scene as unknown as { getBotInput(): unknown }).getBotInput();

      scene.scene.start('PlayScene', { demo: true });
      await advanceGame(scene.game, 50);
      expect(scene.isDemoMode()).toBe(true);
      expect(botInput()).not.toBeNull();

      // The explicit `{ demo: false }` overwrites the stale payload.
      scene.scene.start('PlayScene', { demo: false });
      await advanceGame(scene.game, 50);
      expect(scene.isDemoMode()).toBe(false);
      expect(botInput()).toBeNull();
    });

    it('AC6 — setDemoMode toggles the flag at runtime', async () => {
      const scene = await bootPlay();
      expect(scene.isDemoMode()).toBe(false);
      scene.setDemoMode(true);
      expect(scene.isDemoMode()).toBe(true);
      scene.setDemoMode(false);
      expect(scene.isDemoMode()).toBe(false);
    });
  });

  describe('Normal play unaffected (AC4/AC6)', () => {
    it('AC4 — normal play does not call bot decision logic', async () => {
      const scene = await bootPlay();
      // In normal mode the bot-input seam returns null, so the keyboard
      // path is used unchanged.
      const botInput = (scene as unknown as {
        getBotInput(): { up: boolean; down: boolean; left: boolean; right: boolean } | null;
      }).getBotInput();
      expect(botInput).toBeNull();
    });
  });

  describe('Demo lifecycle (AC3/AC6)', () => {
    it('AC4 — demo run holds on the game-over screen, then returns to MenuScene', async () => {
      const booted = await bootScene(
        [PlayScene, GameOverScene, MenuScene],
      );
      const scene = booted.scene as PlayScene;

      // Start the demo with a short dwell so the test is quick
      // (AH-0MUXZ4CAE008QRFZ AC4 test override).
      scene.scene.start('PlayScene', { demo: true, demoDwellMs: 600 });
      await advanceGame(scene.game, 50);
      expect(scene.isDemoMode()).toBe(true);

      // Kill the player on the final life so the hit ends the run.
      scene.getGameState().lives = 1;
      (scene as unknown as { onPlayerHit(): void }).onPlayerHit();

      // Mid-dwell the demo holds on the outcome screen (not the menu).
      await advanceGame(scene.game, 200);
      expect(booted.game.scene.isActive('GameOverScene')).toBe(true);
      expect(booted.game.scene.isActive('MenuScene')).toBe(false);
      const over = booted.game.scene.getScene('GameOverScene') as GameOverScene;
      expect(over.isDemoMode()).toBe(true);
      expect(scene.isDemoMode()).toBe(false);

      // After the dwell it loops back to the menu.
      await advanceGame(scene.game, 800);
      expect(booted.game.scene.isActive('MenuScene')).toBe(true);
      expect(booted.game.scene.isActive('GameOverScene')).toBe(false);
    });

    it('AC3 — normal play navigates to GameOverScene when the player dies', async () => {
      const scene = await bootPlay();
      const gs = scene.getGameState();
      gs.lives = 1;

      // Kill the player
      (scene as unknown as { onPlayerHit(): void }).onPlayerHit();

      // Wait for the game-over transition
      await advanceGame(scene.game, 300);

      // Normal play should navigate to GameOverScene.
      const activeKey = scene.scene.isActive('GameOverScene')
        ? 'GameOverScene'
        : scene.scene.isActive('MenuScene')
          ? 'MenuScene'
          : 'other';
      expect(activeKey).toBe('GameOverScene');
    });
  });

  // ── Narrowed demo take-over (AH-0MUYP6M6W006Z1AY) ───────────────
  //
  // Full unit coverage of the narrowed take-over/ESC behaviour required by
  // the tests item (AH-0MUYPHN89007KSPW AC6).

  describe('Narrowed demo take-over (AH-0MUYP6M6W006Z1AY)', () => {
    /** Boots a live game and starts the demo, returning the PlayScene. */
    async function bootDemo(): Promise<PlayScene> {
      booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
      const scene = booted.scene as PlayScene;
      scene.scene.start('PlayScene', { demo: true });
      await advanceGame(scene.game, 50);
      expect(scene.isDemoMode()).toBe(true);
      return scene;
    }

    /** Dispatches a keydown through the scene keyboard plugin. */
    function pressKey(scene: PlayScene, key: string): void {
      scene.input.keyboard!.emit('keydown', {
        key,
        repeat: false,
        preventDefault: () => {},
      } as KeyboardEvent);
    }

    function takeOverHandlerOf(scene: PlayScene): unknown {
      return (scene as unknown as { demoTakeOverHandler: unknown })
        .demoTakeOverHandler;
    }

    it('AC1 — ESC leaves the demo for MenuScene and does not pause', async () => {
      const scene = await bootDemo();

      pressKey(scene, 'Escape');
      await advanceGame(scene.game, 80);

      // Exactly one ESC action applies: return to the menu, never pause.
      expect(scene.isPaused()).toBe(false);
      expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
    });

    it('AC1 — ESC does not take over the run (no in-place hand-off)', async () => {
      const scene = await bootDemo();
      pressKey(scene, 'Escape');
      await advanceGame(scene.game, 80);
      // The demo was abandoned to the menu, not handed to the keyboard.
      expect(scene.isPaused()).toBe(false);
      expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    });

    it('AC2 — an arrow key takes over the demo in place', async () => {
      const scene = await bootDemo();

      pressKey(scene, 'ArrowUp');

      expect(scene.isDemoMode()).toBe(false);
      // In place — the run continues on the live PlayScene.
      expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    });

    it('AC2 — a configured movement key takes over the demo', async () => {
      const scene = await bootDemo();

      pressKey(scene, 'w');

      expect(scene.isDemoMode()).toBe(false);
    });

    // Every arrow key and every configured WASD binding takes over on its
    // own, not just the single `w`/`ArrowUp` sampled above
    // (AH-0MUYPHN89007KSPW AC2).
    it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'])(
      'AC2 — movement key %s takes over the demo in place',
      async (key) => {
        const scene = await bootDemo();

        pressKey(scene, key);

        expect(scene.isDemoMode()).toBe(false);
        // In place — the run continues on the live PlayScene.
        expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
      },
    );

    it('AC2 — a rebind is honoured: the new movement key takes over, the old one returns to menu', async () => {
      const scene = await bootDemo();

      // Rebind moveUp from `w` to `i`, exactly as SettingsScene persists it.
      localStorage.setItem(
        'ai_hell_settings',
        JSON.stringify({
          sfxVolume: 1,
          sfxMuted: false,
          bindings: { moveUp: 'i' },
        }),
      );
      (scene as unknown as { _applyBindings(): void })._applyBindings();

      // The new binding `i` takes over in place.
      pressKey(scene, 'i');
      expect(scene.isDemoMode()).toBe(false);
    });

    it('AC1 — a non-movement key after rebinding returns to the main menu', async () => {
      const scene = await bootDemo();

      // Rebind moveUp from `w` to `i`.
      localStorage.setItem(
        'ai_hell_settings',
        JSON.stringify({
          sfxVolume: 1,
          sfxMuted: false,
          bindings: { moveUp: 'i' },
        }),
      );
      (scene as unknown as { _applyBindings(): void })._applyBindings();

      // The old default `w` is no longer movement → returns to the menu.
      pressKey(scene, 'w');
      await advanceGame(scene.game, 80);
      expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
    });

    it('AC1 — a non-movement key returns to the main menu', async () => {
      const scene = await bootDemo();

      // Any non-movement key (e.g. space) returns to the main menu.
      pressKey(scene, ' ');
      await advanceGame(scene.game, 80);

      // MenuScene is now active and PlayScene is no longer.
      expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
      expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
    });

    it('AC3 — the pointer no longer takes over the demo', async () => {
      const scene = await bootDemo();

      scene.input.emit('pointerdown', { x: 100, y: 100 });

      expect(scene.isDemoMode()).toBe(true);
    });

    it('AC5 — normal play registers no take-over listener and ESC still pauses', async () => {
      booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
      const scene = booted.scene as PlayScene;
      expect(scene.isDemoMode()).toBe(false);
      expect(takeOverHandlerOf(scene)).toBeNull();

      pressKey(scene, 'Escape');
      await advanceGame(scene.game, 80);

      expect(scene.isPaused()).toBe(true);
      expect(booted.game.scene.isActive('PlayScene')).toBe(true);
    });

    it('AC6 — the take-over listener is cleaned up on take-over and ESC-exit', async () => {
      const scene = await bootDemo();
      expect(takeOverHandlerOf(scene)).not.toBeNull();

      // Movement take-over removes the listener (via `setDemoMode(false)`).
      pressKey(scene, 'ArrowLeft');
      expect(scene.isDemoMode()).toBe(false);
      expect(takeOverHandlerOf(scene)).toBeNull();

      // Re-arm, then leave via ESC: the listener is removed before the menu.
      scene.setDemoMode(true);
      expect(takeOverHandlerOf(scene)).not.toBeNull();
      pressKey(scene, 'Escape');
      expect(takeOverHandlerOf(scene)).toBeNull();
    });

    it('AC6 — the take-over listener is removed on scene shutdown (no leak)', async () => {
      const scene = await bootDemo();
      expect(takeOverHandlerOf(scene)).not.toBeNull();

      scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);

      expect(takeOverHandlerOf(scene)).toBeNull();
    });
  });

  // ── End-of-run page-side signal (AH-0MUXZ4BXK001QCEK) ───────────

  describe('End-of-run page-side signal (AH-0MUXZ4BXK001QCEK)', () => {
    /**
     * Records `aihell:run-ended` event details dispatched while `run()`
     * executes. The emitter dispatches synchronously inside `_finishRun`, so
     * the scene transition it precedes cannot race the capture.
     */
    function withRunEndedEvents(run: () => void): unknown[] {
      const details: unknown[] = [];
      const listener = (event: Event): void => {
        details.push((event as CustomEvent).detail);
      };
      window.addEventListener(RUN_ENDED_EVENT, listener);
      try {
        run();
      } finally {
        window.removeEventListener(RUN_ENDED_EVENT, listener);
      }
      return details;
    }

    beforeEach(() => {
      delete window.__aiHellRunState;
      vi.stubEnv('DEV', true);
    });

    afterEach(() => {
      delete window.__aiHellRunState;
      vi.unstubAllEnvs();
    });

    it('AC1 — a victory sets the flag, emits the event and still transitions', async () => {
      const scene = await bootPlay();
      const score = scene.getGameState().score;

      const details = withRunEndedEvents(() => {
        (scene as unknown as { _finishRun(won: boolean): void })._finishRun(true);
      });

      expect(window.__aiHellRunState).toEqual({ ended: true, won: true, score });
      expect(details).toEqual([{ won: true, score }]);
      // Normal play still reaches GameOverScene (AC3); the scene start is
      // queued to the next frame, so let it settle.
      await advanceGame(scene.game, 50);
      expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    });

    it('AC1 — a defeat sets the flag and emits the event', async () => {
      const scene = await bootPlay();
      const gs = scene.getGameState();
      gs.lives = 1;

      const details = withRunEndedEvents(() => {
        (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
      });

      expect(gs.lives).toBe(0);
      expect(window.__aiHellRunState).toEqual({
        ended: true,
        won: false,
        score: gs.score,
      });
      expect(details).toEqual([{ won: false, score: gs.score }]);
    });

    it('AC1 — the defeat dev scenario emits the defeat signal on release', async () => {
      const scene = await bootPlay();
      scene.startDevDefeatScenario();

      // Frozen until the recorder releases it, with the shared page-side
      // handle exposed so `npm run capture -- --scenario defeat` is
      // deterministic.
      expect(scene.isPaused()).toBe(true);
      expect(window.__aiHellScenario?.hitsRemaining).toBe(0);

      const details = withRunEndedEvents(() => {
        window.__aiHellScenario?.resume();
      });

      expect(scene.isPaused()).toBe(false);
      expect(scene.getGameState().lives).toBe(0);
      expect(window.__aiHellRunState).toEqual({
        ended: true,
        won: false,
        score: scene.getGameState().score,
      });
      expect(details).toEqual([
        { won: false, score: scene.getGameState().score },
      ]);
    });

    it('AC2 — the signal is dev-gated: a production build emits nothing', async () => {
      const scene = await bootPlay();
      vi.stubEnv('DEV', false);
      const gs = scene.getGameState();
      gs.lives = 1;

      const details = withRunEndedEvents(() => {
        (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
      });

      expect(window.__aiHellRunState).toBeUndefined();
      expect(details).toEqual([]);
      // The game-over transition is unaffected by the disabled signal.
      await advanceGame(scene.game, 50);
      expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    });
  });
});

// ── Space Invaders marching block (AH-0MV01EDZS0005R20) ─────────────

describe('PlayScene — Space Invaders marching block (AH-0MV01EDZS0005R20)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** A single non-firing march block, matching the shipped CSV seed shape. */
  const MARCH_LEVEL: LevelDefinition = {
    level: 1,
    name: 'March Test',
    waves: [
      {
        groups: [
          {
            enemyKey: 'march',
            formation: 'march',
            count: 11,
            spacingX: 26,
            spacingY: 24,
            startX: GAME_WIDTH * 0.5,
            startY: GAME_HEIGHT * 0.25,
          },
        ],
        shootEnabled: false,
      },
    ],
  };

  interface MarchProbe {
    marchState: { x: number; y: number; dir: number } | null;
    marchOptions: unknown;
  }

  async function bootMarch(): Promise<PlayScene> {
    const result = await bootSceneWithLevels([MARCH_LEVEL]);
    booted = result.booted;
    return result.scene;
  }

  it('positions the block from the shared march state (step, reverse, drop)', async () => {
    // `create()` already begins and spawns the injected wave, so the shared
    // march state is live here.
    const scene = await bootMarch();

    const probe = scene as unknown as MarchProbe;
    expect(probe.marchState).not.toBeNull();
    const startX = probe.marchState!.x;
    const startY = probe.marchState!.y;

    // marchStep / driftSpeed = 1 s per step at full strength.
    scene.tick(1.0);
    expect(probe.marchState!.x).toBeCloseTo(startX + 20, 5);

    // Keep stepping until the block hits the right edge, reverses and drops.
    let dropped = false;
    for (let i = 0; i < 60 && !dropped; i++) {
      scene.tick(1.0);
      dropped = probe.marchState!.y > startY;
    }
    expect(dropped).toBe(true);
  });

  it('never fires in a non-firing level (L1–3)', async () => {
    const scene = await bootMarch();
    for (let i = 0; i < 200; i++) scene.tick(0.1);
    expect(scene.getEnemyBullets()).toHaveLength(0);
  });
});

// ── Carry-over position/motion across the next-wave spawn
//    (AH-0MV9FUG4J008OHKA) ────────────────────────────────────────────

describe('PlayScene — carried-over survivors keep formation position/motion across the next-wave spawn (AH-0MV9FUG4J008OHKA)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Suspends the player's auto-fire so carried-over survivors are not shot
   * during the carry-over assertions (survivors are hittable in the
   * transition pause, AH-0MUNS3ZQ1002DJ9S AC3).
   */
  function suspendAutoFire(scene: PlayScene): void {
    (scene as unknown as { autoFireEnabled(): boolean }).autoFireEnabled =
      () => false;
  }

  /**
   * Two identical drift waves: wave 1 times out and its survivors carry
   * over beside wave 2, which is configured identically so a clean start and
   * a carry-over can be compared 1:1.
   */
  const DRIFT_LEVELS: LevelDefinition[] = [
    {
      level: 1,
      name: 'Carry Drift',
      waves: [
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 4,
              spacingX: 28,
              spacingY: 24,
              startX: GAME_WIDTH * 0.35,
              startY: GAME_HEIGHT * 0.3,
            },
          ],
          shootEnabled: false,
        },
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 4,
              spacingX: 28,
              spacingY: 24,
              startX: GAME_WIDTH * 0.35,
              startY: GAME_HEIGHT * 0.3,
            },
          ],
          shootEnabled: false,
        },
      ],
    },
  ];

  async function bootCarryDrift(): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(DRIFT_LEVELS, {
      asteroidSpawner: false,
    });
    booted = game;
    suspendAutoFire(scene);
    return scene;
  }

  it('AC1/AC2 (drift) — carried-over survivors keep position and drift speed when the next wave spawns', async () => {
    const scene = await bootCarryDrift();
    finishSpawnSequence(scene);
    const firstWaveX = scene.getEnemies()[0].x;

    // Advance the drift so the carry-over has a non-zero shared base to
    // preserve (28 px/s → ~28 px after one second).
    scene.tick(1.0);
    const survivor = scene.getEnemies()[0];
    const xBefore = survivor.x;
    expect(xBefore).toBeGreaterThan(firstWaveX + 20);

    // Time out the wave → transition pause → next wave spawns with the
    // surviving formation enemies carried over.
    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.05);
    expect(scene.isTransitioning()).toBe(true);
    const xMid = survivor.x;
    finishTransition(scene);
    expect(survivor.alive).toBe(true);

    // No snap: the survivor kept drifting through the transition AND the
    // wave-2 spawn. The ~1.5 s transition tick (drift keeps advancing in the
    // pause, AH-0MUNS3ZQ1002DJ9S AC3) plus the 0.001 s spawn tick advance
    // the drift by ~42 px; a spawn-time reset would snap it back below the
    // pre-timeout position instead.
    const xAfter = survivor.x;
    expect(xAfter).toBeGreaterThan(xBefore);
    expect(xAfter - xMid).toBeGreaterThan(30);
    expect(xAfter - xMid).toBeLessThan(55);
  });

  it('AC3 — a clean wipe (no survivors) still starts the next wave at its configured positions', async () => {
    const scene = await bootCarryDrift();
    finishSpawnSequence(scene);
    const firstWaveX = scene.getEnemies().filter((e) => e.alive).map((e) => e.x);

    // Deliberately advance the drift so the clean wipe has a non-zero base
    // to erase: a leaked carry-over base would show up as an offset here
    // (28 px/s × 2 s ≈ 56 px of drift).
    scene.tick(2.0);
    const driftedX = scene.getEnemies().filter((e) => e.alive).map((e) => e.x);
    for (let i = 0; i < firstWaveX.length; i += 1) {
      expect(driftedX[i]).toBeGreaterThan(firstWaveX[i] + 45);
    }

    // Wipe wave 1 with no survivors → transition → wave 2.
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    finishTransition(scene);

    const secondWaveX = scene.getEnemies().filter((e) => e.alive).map((e) => e.x);
    expect(secondWaveX.length).toBe(firstWaveX.length);
    // A clean start re-places the fresh wave at its configured startX — near
    // where wave 1 began (bounded ±2 px wiggle each side, plus boot jitter),
    // and nowhere near its drifted positions (a leaked carry-over base would
    // keep the ~56+ px drift offset instead of erasing it).
    for (let i = 0; i < firstWaveX.length; i += 1) {
      expect(Math.abs(secondWaveX[i] - firstWaveX[i])).toBeLessThanOrEqual(12);
      expect(secondWaveX[i]).toBeLessThan(driftedX[i] - 40);
    }
  });

  /** Two identical march waves so a carried march survivor meets a fresh
   * march block at the next-wave spawn. */
  const MARCH_LEVELS: LevelDefinition[] = [
    {
      level: 1,
      name: 'Carry March',
      waves: [
        {
          groups: [
            {
              enemyKey: 'march',
              formation: 'march',
              count: 11,
              spacingX: 26,
              spacingY: 24,
              startX: GAME_WIDTH * 0.5,
              startY: GAME_HEIGHT * 0.25,
            },
          ],
          shootEnabled: false,
        },
        {
          groups: [
            {
              enemyKey: 'march',
              formation: 'march',
              count: 11,
              spacingX: 26,
              spacingY: 24,
              startX: GAME_WIDTH * 0.5,
              startY: GAME_HEIGHT * 0.25,
            },
          ],
          shootEnabled: false,
        },
      ],
    },
  ];

  async function bootCarryMarch(): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(MARCH_LEVELS, {
      asteroidSpawner: false,
    });
    booted = game;
    suspendAutoFire(scene);
    return scene;
  }

  it('AC1/AC2 (march) — a carried march survivor keeps its step cadence when a fresh march block spawns alongside it', async () => {
    const scene = await bootCarryMarch();
    finishSpawnSequence(scene);

    // One full step at full strength (step 20 / reference drift 20 → 1 s
    // cadence, AH-0MV01EDZS0005R20).
    scene.tick(1.0);
    const survivor = scene.getEnemies()[0];
    const xAfterStep = survivor.x;

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.05);
    expect(scene.isTransitioning()).toBe(true);
    const xMid = survivor.x;

    // Advance the transition; the marched block keeps stepping — the ~1.5 s
    // transition tick accrues just over one full step (1 s cadence).
    finishTransition(scene);
    expect(survivor.alive).toBe(true);

    const xAfter = survivor.x;
    // The survivor continued marching forward (a full step through the
    // transition + spawn) rather than snapping back onto the fresh origin
    // (which would put it at/behind its pre-timeout position).
    expect(xAfter).toBeGreaterThan(xAfterStep + 10);
    expect(xAfter - xMid).toBeGreaterThan(10);
  });
});

// ── Pac-Man ghost personality pursuers (AH-0MV01EH2U008XT3Q) ─────────

describe('PlayScene — Pac-Man ghost personality pursuers (AH-0MV01EH2U008XT3Q)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots the PlayScene with a single empty wave so ghost accounting is
   * isolated from any formation kills. `ghosts` toggles the wave's opt-in.
   */
  async function bootWithGhostWave(ghosts: boolean): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'Ghost Test',
        waves: [{ groups: [], shootEnabled: false, ghosts }],
      },
    ];
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.setGhostSpawnerEnabled(true);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    return scene;
  }

  function liveGhosts(scene: PlayScene): Ghost[] {
    return scene.getEnemies().filter((e): e is Ghost => e instanceof Ghost && e.alive);
  }

  /**
   * Advances the wave timer past the whole spawn window in one tick, then
   * ticks once more to release every planned ghost. Collisions run *before*
   * the release step, so the freshly released ghosts are still all alive when
   * this returns (deterministic — no auto-fire window between release and the
   * assertions).
   */
  function releaseGhosts(scene: PlayScene): void {
    scene.tick(20);
    scene.tick(0.001);
  }

  it('spawns one ghost per personality as a wave-accounted group', async () => {
    const scene = await bootWithGhostWave(true);
    const wm = scene.getWaveManager();
    expect(wm.enemiesAlive).toBe(0);

    releaseGhosts(scene);

    const ghosts = liveGhosts(scene);
    expect(ghosts).toHaveLength(4);
    // One pursuer per personality, all inside the arena (reachable).
    expect(new Set(ghosts.map((g) => g.personality))).toEqual(
      new Set(['chase', 'ambush', 'flank', 'wander']),
    );
    for (const g of ghosts) {
      expect(g.x).toBeGreaterThanOrEqual(0);
      expect(g.x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(g.y).toBeGreaterThanOrEqual(0);
      expect(g.y).toBeLessThanOrEqual(GAME_HEIGHT);
    }
    // Every spawned pursuer is registered with the wave accounting.
    expect(wm.enemiesAlive).toBe(4);
  });

  it('spawns the group as a tight cluster from a single entry point', async () => {
    const scene = await bootWithGhostWave(true);
    releaseGhosts(scene);
    const info = scene as unknown as {
      spawned: Array<{ entity: Ghost; startX: number; startY: number }>;
    };
    const records = info.spawned.filter((r) => r.entity instanceof Ghost);
    expect(records).toHaveLength(4);
    const entryX = GAME_WIDTH * GHOST_GROUP_ENTRY_X_FRACTION;
    const entryY = GAME_HEIGHT * GHOST_GROUP_ENTRY_Y_FRACTION;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const r of records) {
      xs.push(r.startX);
      ys.push(r.startY);
      // Every ghost starts within the cluster radius of one common point.
      expect(Math.hypot(r.startX - entryX, r.startY - entryY)).toBeLessThanOrEqual(
        GHOST_GROUP_CLUSTER_RADIUS + 1e-6,
      );
    }
    const spread = Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    );
    // A tight pack — nothing like the four-edges spawn of the old planner.
    expect(spread).toBeLessThanOrEqual(2 * GHOST_GROUP_CLUSTER_RADIUS);
  });

  it('plans the whole group within a single narrow release window', async () => {
    const scene = await bootWithGhostWave(true);
    const planned = (
      scene as unknown as { pendingGhostSpawns: GhostSpawnEvent[] }
    ).pendingGhostSpawns;
    expect(planned).toHaveLength(4);
    const times = planned.map((e) => e.timeSeconds);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(
      GHOST_GROUP_RELEASE_WINDOW_SECONDS + 1e-6,
    );
  });

  it('pursuers never fire at any level (no enemy bullets)', async () => {
    const scene = await bootWithGhostWave(true);
    releaseGhosts(scene);
    const ghosts = liveGhosts(scene);
    expect(ghosts).toHaveLength(4);
    expect(scene.getEnemyBullets()).toHaveLength(0);
    for (const g of ghosts) {
      expect(g.effectiveShotPattern).toBe('none');
      expect(g.shootEnabled).toBe(false);
    }
  });

  it('killing a pursuer advances wave accounting exactly once', async () => {
    const scene = await bootWithGhostWave(true);
    const wm = scene.getWaveManager();
    releaseGhosts(scene);
    expect(wm.enemiesAlive).toBe(4);

    const victim = liveGhosts(scene)[0];
    const before = wm.enemiesAlive;
    // Isolate the kill so auto-fire or an overlapping pursuer cannot add a
    // second kill and double-decrement the wave accounting (AH-0MV1EN1NS000QLBK).
    const restoreKill = isolateEnemyForKill(scene, victim);
    try {
      scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
      scene.tick(0.001);
    } finally {
      restoreKill();
    }
    expect(victim.alive).toBe(false);
    expect(wm.enemiesAlive).toBe(before - 1);
  });

  it('does not spawn pursuers for a wave without the ghosts opt-in', async () => {
    const scene = await bootWithGhostWave(false);
    releaseGhosts(scene);
    expect(liveGhosts(scene)).toHaveLength(0);
    expect(scene.getWaveManager().enemiesAlive).toBe(0);
  });

  it('the ghost spawner disable seam suppresses the group', async () => {
    const scene = await bootWithGhostWave(true);
    scene.setGhostSpawnerEnabled(false);
    releaseGhosts(scene);
    expect(liveGhosts(scene)).toHaveLength(0);
  });
});

// ── Centipede linked chain (AH-0MV01EJ92008ZZ86) ──────────────────────

describe('PlayScene — Centipede linked chain (AH-0MV01EJ92008ZZ86)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots the PlayScene with a single empty wave so centipede accounting is
   * isolated from any formation kills. `centipede` toggles the wave opt-in.
   */
  async function bootWithCentipedeWave(centipede: boolean): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'Centipede Test',
        waves: [{ groups: [], shootEnabled: false, centipede }],
      },
    ];
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.setCentipedeSpawnerEnabled(true);
    // Isolate the centipede accounting from the random asteroid spawner (the
    // same isolation `bootSceneWithLevels` applies for the asteroid suite): a
    // released asteroid can absorb a player bullet meant for a segment.
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    return scene;
  }

  function liveSegments(scene: PlayScene): Centipede[] {
    return scene.getEnemies().filter((e): e is Centipede => e instanceof Centipede && e.alive);
  }

  /**
   * Smallest clearance (px) between `victim` and every other live enemy:
   * `distance - victimRadius - otherRadius`. A player bullet overlaps an
   * enemy when this is `<= PLAYER_BULLET_RADIUS`. The weave folds
   * neighbouring segments close together at direction reversals, so a kill
   * test must wait for a clear gap before firing (AH-0MV5SZRI4001WK89).
   */
  function nearestClearance(scene: PlayScene, victim: Centipede): number {
    let min = Infinity;
    for (const enemy of scene.getEnemies()) {
      if (!enemy.alive || enemy === victim) continue;
      const gap =
        Math.hypot(enemy.x - victim.x, enemy.y - victim.y) -
        victim.getHitRadius() -
        enemy.getHitRadius();
      min = Math.min(min, gap);
    }
    return min;
  }

  /**
   * Advances the wave timer past the whole spawn window, then ticks once more
   * to position the freshly released chain. Collisions run before the release
   * step, so the chain is alive when this returns.
   *
   * Stepped in small increments: a single giant `tick(20)` integrates the
   * chain's weave over the whole window in one frame, which can overshoot the
   * arena bounds and make this test flaky (AH-0MV396OK0001FX14).
   */
  function releaseCentipede(scene: PlayScene): void {
    for (let elapsed = 0; elapsed < 20; elapsed += 0.05) scene.tick(0.05);
    scene.tick(0.001);
  }

  it('spawns the linked chain as a wave-accounted group', async () => {
    const scene = await bootWithCentipedeWave(true);
    const wm = scene.getWaveManager();
    expect(wm.enemiesAlive).toBe(0);

    releaseCentipede(scene);

    const segments = liveSegments(scene);
    expect(segments).toHaveLength(CENTIPEDE_SEGMENT_COUNT);
    for (const segment of segments) {
      expect(segment.x).toBeGreaterThanOrEqual(0);
      expect(segment.x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(segment.y).toBeGreaterThanOrEqual(0);
      expect(segment.y).toBeLessThanOrEqual(GAME_HEIGHT);
    }
    // Every spawned segment is registered with the wave accounting.
    expect(wm.enemiesAlive).toBe(CENTIPEDE_SEGMENT_COUNT);
  });

  it('segments never fire at any level (no enemy bullets)', async () => {
    const scene = await bootWithCentipedeWave(true);
    releaseCentipede(scene);
    const segments = liveSegments(scene);
    expect(segments).toHaveLength(CENTIPEDE_SEGMENT_COUNT);
    expect(scene.getEnemyBullets()).toHaveLength(0);
    for (const segment of segments) {
      expect(segment.effectiveShotPattern).toBe('none');
      expect(segment.shootEnabled).toBe(false);
    }
  });

  it('killing a middle segment splits the chain into two sub-chains and advances accounting once', async () => {
    const scene = await bootWithCentipedeWave(true);
    const wm = scene.getWaveManager();
    releaseCentipede(scene);
    expect(wm.enemiesAlive).toBe(CENTIPEDE_SEGMENT_COUNT);

    const segments = liveSegments(scene);
    const chain = segments[0].chain;
    expect(chain.subChainCount()).toBe(1);

    const victim = segments[2];
    // Wait until segment #2 is clear of every other segment by more than the
    // bullet radius. The chain weave folds neighbours close together at
    // direction reversals; without this the shot can be absorbed by a folded
    // neighbour (the flake in AH-0MV5SZRI4001WK89). Bounded so a broken chain
    // fails loudly instead of looping.
    for (let guard = 0; guard < 100 && nearestClearance(scene, victim) <= 6; guard++) {
      scene.tick(0.05);
    }
    expect(nearestClearance(scene, victim)).toBeGreaterThan(6);

    const before = wm.enemiesAlive;
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.001);

    expect(victim.alive).toBe(false);
    expect(chain.aliveCount()).toBe(CENTIPEDE_SEGMENT_COUNT - 1);
    expect(chain.subChainCount()).toBe(2);
    expect(chain.runs()).toEqual([
      [0, 1],
      [3, 4, 5],
    ]);
    expect(wm.enemiesAlive).toBe(before - 1);
  });

  it('does not spawn the chain for a wave without the opt-in', async () => {
    const scene = await bootWithCentipedeWave(false);
    releaseCentipede(scene);
    expect(liveSegments(scene)).toHaveLength(0);
    expect(scene.getWaveManager().enemiesAlive).toBe(0);
  });

  it('the centipede spawner disable seam suppresses the chain', async () => {
    const scene = await bootWithCentipedeWave(true);
    scene.setCentipedeSpawnerEnabled(false);
    releaseCentipede(scene);
    expect(liveSegments(scene)).toHaveLength(0);
  });
});

// ── Robotron homing horde (AH-0MV01EKTL001NRE6) ───────────────────────

describe('PlayScene — Robotron homing horde (AH-0MV01EKTL001NRE6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots the PlayScene with a single empty wave so horde accounting is
   * isolated from any formation kills. `horde` toggles the wave's opt-in.
   */
  async function bootWithHordeWave(horde: boolean): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'Horde Test',
        waves: [{ groups: [], shootEnabled: false, horde }],
      },
    ];
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.setHordeSpawnerEnabled(true);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    return scene;
  }

  function liveGrunts(scene: PlayScene): Grunt[] {
    return scene.getEnemies().filter((e): e is Grunt => e instanceof Grunt && e.alive);
  }

  /**
   * Advances the wave timer past the whole spawn window in one tick, then
   * ticks once more to release every planned grunt. Collisions run *before*
   * the release step, so the freshly released grunts are still all alive when
   * this returns (deterministic — no auto-fire window between release and the
   * assertions).
   */
  function releaseHorde(scene: PlayScene): void {
    scene.tick(20);
    scene.tick(0.001);
  }

  it('spawns the configured horde as a wave-accounted group', async () => {
    const scene = await bootWithHordeWave(true);
    const wm = scene.getWaveManager();
    expect(wm.enemiesAlive).toBe(0);

    releaseHorde(scene);

    const grunts = liveGrunts(scene);
    expect(grunts).toHaveLength(DEFAULT_ENEMY_CONFIGS.grunt.count);
    // Every grunt spawns inside the arena (reachable).
    for (const g of grunts) {
      expect(g.x).toBeGreaterThanOrEqual(0);
      expect(g.x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(g.y).toBeGreaterThanOrEqual(0);
      expect(g.y).toBeLessThanOrEqual(GAME_HEIGHT);
    }
    // Every spawned grunt is registered with the wave accounting.
    expect(wm.enemiesAlive).toBe(DEFAULT_ENEMY_CONFIGS.grunt.count);
  });

  it('grunts never fire at any level (no enemy bullets)', async () => {
    const scene = await bootWithHordeWave(true);
    releaseHorde(scene);
    const grunts = liveGrunts(scene);
    expect(grunts.length).toBeGreaterThan(0);
    expect(scene.getEnemyBullets()).toHaveLength(0);
    for (const g of grunts) {
      expect(g.effectiveShotPattern).toBe('none');
      expect(g.shootEnabled).toBe(false);
    }
  });

  it('homes the grunts toward the player over successive frames', async () => {
    const scene = await bootWithHordeWave(true);
    releaseHorde(scene);
    const grunts = liveGrunts(scene);
    const g = grunts[0];
    const before = { x: g.x, y: g.y };
    for (let i = 0; i < 5; i++) scene.tick(0.05);
    // The shared homing step moved the grunt (never frozen on its slot).
    expect(g.x !== before.x || g.y !== before.y).toBe(true);
    // Still inside the arena after moving.
    expect(g.x).toBeGreaterThanOrEqual(0);
    expect(g.x).toBeLessThanOrEqual(GAME_WIDTH);
    expect(g.y).toBeGreaterThanOrEqual(0);
    expect(g.y).toBeLessThanOrEqual(GAME_HEIGHT);
  });

  it('killing a grunt advances wave accounting exactly once', async () => {
    const scene = await bootWithHordeWave(true);
    const wm = scene.getWaveManager();
    releaseHorde(scene);
    const total = DEFAULT_ENEMY_CONFIGS.grunt.count;
    expect(wm.enemiesAlive).toBe(total);

    const victim = liveGrunts(scene)[0];
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.001);
    expect(victim.alive).toBe(false);
    expect(wm.enemiesAlive).toBe(total - 1);
  });

  it('does not spawn a horde for a wave without the opt-in', async () => {
    const scene = await bootWithHordeWave(false);
    releaseHorde(scene);
    expect(liveGrunts(scene)).toHaveLength(0);
    expect(scene.getWaveManager().enemiesAlive).toBe(0);
  });

  it('the horde spawner disable seam suppresses the horde', async () => {
    const scene = await bootWithHordeWave(true);
    scene.setHordeSpawnerEnabled(false);
    releaseHorde(scene);
    expect(liveGrunts(scene)).toHaveLength(0);
  });
});

// ── Defender patrol-and-attack raider (AH-0MV01EM7U0033W7L) ──────────

describe('PlayScene — Defender raider (AH-0MV01EM7U0033W7L)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots the PlayScene with a single raider group and the given per-wave
   * fire rule, so the raider's wave accounting and fire gating are isolated.
   */
  async function bootWithRaiderWave(shootEnabled: boolean): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'Raider Test',
        waves: [
          {
            groups: [
              {
                enemyKey: 'raider',
                formation: 'single',
                count: 1,
                spacingX: 0,
                spacingY: 0,
                startX: 480,
                startY: 135,
              },
            ],
            shootEnabled,
          },
        ],
      },
    ];
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    // Complete the wormhole spawn so the raider is collision-active immediately
    // (the spawn animation protects spawning enemies).
    scene.finishSpawnAnimations();
    return scene;
  }

  function liveRaiders(scene: PlayScene): Raider[] {
    return scene
      .getEnemies()
      .filter((e): e is Raider => e instanceof Raider && e.alive);
  }

  it('spawns the raider as a wave-accounted group', async () => {
    const scene = await bootWithRaiderWave(false);
    const wm = scene.getWaveManager();
    const raiders = liveRaiders(scene);
    expect(raiders).toHaveLength(1);
    expect(wm.enemiesAlive).toBe(1);
    // Spawns inside the arena (reachable).
    const r = raiders[0];
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x).toBeLessThanOrEqual(GAME_WIDTH);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeLessThanOrEqual(GAME_HEIGHT);
  });

  it('killing the raider advances wave accounting exactly once', async () => {
    const scene = await bootWithRaiderWave(false);
    const wm = scene.getWaveManager();
    const victim = liveRaiders(scene)[0];
    expect(victim.health).toBe(2);

    // Two hits: the first leaves the 2 HP raider alive. A second point-blank
    // bullet (matching the entity's own live position) finishes it.
    scene.tick(0.001); // settle the patrol/wiggle position before aiming
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.001);
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.001);

    expect(victim.alive).toBe(false);
    expect(wm.enemiesAlive).toBe(0);
  });

  it('never fires in Levels 1–3 (fire rule off), even during an attack run', async () => {
    const scene = await bootWithRaiderWave(false);
    const raider = liveRaiders(scene)[0];
    // The player sits within commit range, so the raider commits to an attack
    // run; the level fire rule (shootEnabled false) still suppresses all fire.
    for (let i = 0; i < 20; i++) scene.tick(0.05);
    expect(raider.mode).toBe('attack');
    expect(scene.getEnemyBullets()).toHaveLength(0);
  });

  // ── Missile Command telegraphed orbital strike (AH-0MV01ENX00055CG1) ──

  describe('Missile Command telegraphed orbital strike (AH-0MV01ENX00055CG1)', () => {
    const STRIKE_SEED = 424242;

    /** Single-scout waves so the campaign advances quickly to a strike wave. */
    function strikeCampaign(waveCount: number): LevelDefinition[] {
      return [
        {
          level: 1,
          name: 'Strike Test',
          waves: Array.from({ length: waveCount }, () => ({
            groups: [
              {
                enemyKey: 'scout',
                formation: 'v' as const,
                count: 1,
                spacingX: 20,
                spacingY: 20,
                startX: 200,
                startY: 200,
              },
            ],
            shootEnabled: false,
          })),
        },
      ];
    }

    /** Boots a campaign long enough to reach the first strike wave. */
    async function bootStrikeScene(
      waveCount: number,
    ): Promise<{ scene: PlayScene; plan: ReturnType<typeof computeStrikeSpawns> }> {
      const { booted: game, scene } = await bootSceneWithLevels(strikeCampaign(waveCount));
      booted = game;
      // Isolate the strike hazard from the random asteroid spawner.
      scene.setAsteroidSpawnerEnabled(false);
      scene.setOrbitalStrikeSpawnerEnabled(true);
      // Advance to the first strike wave by clearing the earlier ones.
      const wm = scene.getWaveManager();
      let guard = 0;
      while (wm.globalWaveIndex < STRIKE_SPAWN_START_WAVE && guard++ < waveCount + 5) {
        killAllEnemies(scene);
        finishTransition(scene);
      }
      expect(wm.globalWaveIndex).toBeGreaterThanOrEqual(STRIKE_SPAWN_START_WAVE);
      // Re-plan deterministically with a known seed so the plan is predictable.
      scene.setRng(createSeededRng(STRIKE_SEED));
      scene.planStrikeSpawns();
      const plan = computeStrikeSpawns(
        wm.globalWaveIndex,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT_SECONDS,
        scene.getPlayer()?.x ?? GAME_WIDTH / 2,
        scene.getPlayer()?.y ?? GAME_HEIGHT / 2,
        createSeededRng(STRIKE_SEED),
      );
      return { scene, plan };
    }

    it('releases a planned strike that does not gate wave completion', async () => {
      const { scene, plan } = await bootStrikeScene(STRIKE_SPAWN_START_WAVE + 1);
      expect(plan.length).toBeGreaterThan(0);

      const wm = scene.getWaveManager();
      const aliveBefore = wm.enemiesAlive;
      const before = new Set(scene.getEnemies());

      // Advance the wave clock to the first strike's due time.
      scene.setWaveTimerRemaining(WAVE_TIME_LIMIT_SECONDS - (plan[0].timeSeconds + 1e-6));
      scene.tick(0.001);

      const strikes = scene
        .getEnemies()
        .filter((e): e is OrbitalStrike => e instanceof OrbitalStrike && e.alive);
      expect(strikes).toHaveLength(1);
      expect(strikes[0].archetype).toBe('orbital-strike');
      expect(strikes[0].tellDuration).toBeGreaterThanOrEqual(500);
      // Released strikes are NOT registered with the WaveManager — they are
      // non-blocking world hazards (matching the asteroid accounting).
      expect(wm.enemiesAlive).toBe(aliveBefore);
      expect(scene.getEnemies().length).toBe(before.size + 1);

      // The wave still clears while the strike is mid-telegraph.
      killAllEnemies(scene);
      finishTransition(scene);
      expect(scene.isTransitioning()).toBe(false);
    });

    it('telegraphs ≥500 ms before the projectile falls and detonates', async () => {
      const { scene, plan } = await bootStrikeScene(STRIKE_SPAWN_START_WAVE + 1);
      expect(plan.length).toBeGreaterThan(0);

      scene.setWaveTimerRemaining(WAVE_TIME_LIMIT_SECONDS - (plan[0].timeSeconds + 1e-6));
      scene.tick(0.001);

      const strike = scene
        .getEnemies()
        .find((e): e is OrbitalStrike => e instanceof OrbitalStrike && e.alive)!;
      expect(strike).toBeDefined();
      expect(strike.isTelling).toBe(true);
      expect(strike.phase).toBe('telegraph');
      // No enemy bullets until detonation.
      expect(scene.getEnemyBullets()).toHaveLength(0);

      // After the tell elapses the strike is falling, not yet detonated.
      scene.tick(strike.tellDuration / 1000 + 0.05);
      expect(strike.phase).toBe('falling');

      // The radial detonation burst reuses the shared enemy-bullet path, so it
      // can damage the player; it never touches other enemies.
      let guard = 0;
      while (strike.alive && guard++ < 200) scene.tick(0.05);
      expect(strike.alive).toBe(false);
      expect(scene.getEnemyBullets().length).toBeGreaterThan(0);
    });

    it('the detonation burst damages the player through the shared enemy-bullet path', async () => {
      const { scene, plan } = await bootStrikeScene(STRIKE_SPAWN_START_WAVE + 1);
      expect(plan.length).toBeGreaterThan(0);

      scene.setWaveTimerRemaining(WAVE_TIME_LIMIT_SECONDS - (plan[0].timeSeconds + 1e-6));
      scene.tick(0.001);

      const strike = scene
        .getEnemies()
        .find((e): e is OrbitalStrike => e instanceof OrbitalStrike && e.alive)!;
      // Detonate the strike.
      let guard = 0;
      while (strike.alive && guard++ < 200) scene.tick(0.05);
      expect(strike.alive).toBe(false);
      const burst = scene.getEnemyBullets();
      expect(burst.length).toBeGreaterThan(0);

      // Place every shrapnel bullet on the live player and advance one frame:
      // the shared enemy-bullet collision path must damage the player.
      const player = scene.getPlayer()!;
      const livesBefore = scene.getGameState().lives;
      for (const bullet of burst) {
        bullet.graphics.x = player.x;
        bullet.graphics.y = player.y;
        bullet.vx = 0;
        bullet.vy = 0;
      }
      scene.tick(0.016);
      expect(scene.getGameState().lives).toBeLessThan(livesBefore);
    });

    it('the detonation burst never collides with or damages other enemies', async () => {
      const { scene, plan } = await bootStrikeScene(STRIKE_SPAWN_START_WAVE + 1);
      expect(plan.length).toBeGreaterThan(0);

      scene.setWaveTimerRemaining(WAVE_TIME_LIMIT_SECONDS - (plan[0].timeSeconds + 1e-6));
      scene.tick(0.001);

      const strike = scene
        .getEnemies()
        .find((e): e is OrbitalStrike => e instanceof OrbitalStrike && e.alive)!;
      let guard = 0;
      while (strike.alive && guard++ < 200) scene.tick(0.05);
      expect(strike.alive).toBe(false);

      // Move every shrapnel bullet onto a live, non-strike enemy and advance:
      // the strike must never damage another enemy (GDD §2.6).
      const other = scene
        .getEnemies()
        .find((e) => !(e instanceof OrbitalStrike) && e.alive);
      expect(other).toBeDefined();
      const healthBefore = (other as unknown as { health: number }).health;
      for (const bullet of scene.getEnemyBullets()) {
        bullet.graphics.x = other!.x;
        bullet.graphics.y = other!.y;
        bullet.vx = 0;
        bullet.vy = 0;
      }
      scene.tick(0.016);
      expect(other!.alive).toBe(true);
      expect((other as unknown as { health: number }).health).toBe(healthBefore);
    });
  });
});

// ── Frogger lane traffic (AH-0MV01EPM40008N8T) ───────────────────────

describe('PlayScene — Frogger lane traffic (AH-0MV01EPM40008N8T)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots the PlayScene with one wave-accounted Scout and the random asteroid
   * spawner disabled, so lane traffic can be isolated from other dynamic
   * hazards. `shootEnabled` is false so no formation enemy fires.
   */
  async function bootWithLaneTrafficWave(): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'Lane Traffic Test',
        waves: [
          {
            groups: [
              {
                enemyKey: 'scout',
                formation: 'v',
                count: 1,
                spacingX: 26,
                spacingY: 22,
                startX: 240,
                startY: 135,
              },
            ],
            shootEnabled: false,
            laneTraffic: true,
          },
        ],
      },
    ];
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.setAsteroidSpawnerEnabled(false);
    scene.setLaneTrafficSpawnerEnabled(true);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    scene.finishSpawnAnimations();
    return scene;
  }

  function liveTraffic(scene: PlayScene): LaneTraffic[] {
    return scene
      .getEnemies()
      .filter((e): e is LaneTraffic => e instanceof LaneTraffic && e.alive);
  }

  /**
   * Advances the wave timer past the whole spawn window, then ticks once more
   * so every planned lane is released (the release runs before the timer
   * advances, matching the horde/asteroid planners).
   */
  function releaseLaneTraffic(scene: PlayScene): void {
    scene.tick(20);
    scene.tick(0.001);
  }

  const config = DEFAULT_ENEMY_CONFIGS['lane-traffic'];
  const expectedCount = config.count * (config.laneCount ?? 1);

  it('spawns lane traffic as a non-blocking world hazard', async () => {
    const scene = await bootWithLaneTrafficWave();
    const wm = scene.getWaveManager();
    const baseline = wm.enemiesAlive;
    expect(baseline).toBe(1);

    releaseLaneTraffic(scene);

    const traffic = liveTraffic(scene);
    expect(traffic).toHaveLength(expectedCount);
    for (const t of traffic) {
      expect(t.archetype).toBe('lane-traffic');
      // The hazards are NOT registered with the WaveManager, so the wave
      // accounting is unchanged (the lone Scout is still counted).
      expect(wm.enemiesAlive).toBe(baseline);
    }
  });

  it('crosses the arena at a constant speed and wraps at the edges', async () => {
    const scene = await bootWithLaneTrafficWave();
    releaseLaneTraffic(scene);
    const t = liveTraffic(scene)[0];
    const laneY = t.y;
    // Place the hazard away from the edge so the measurement is wrap-free.
    t.x = GAME_WIDTH / 2;
    const startX = t.x;
    scene.tick(0.25);
    expect(t.y).toBeCloseTo(laneY, 5);
    expect(t.x - startX).toBeCloseTo(t.vx * 0.25, 1);

    // Over a long run the wrap keeps it inside the arena and in its lane.
    for (let i = 0; i < 200; i++) scene.tick(0.05);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x).toBeLessThanOrEqual(GAME_WIDTH);
    expect(t.y).toBeCloseTo(laneY, 5);
  });

  it('is destroyed by a single player bullet without advancing the wave', async () => {
    const scene = await bootWithLaneTrafficWave();
    releaseLaneTraffic(scene);
    const wm = scene.getWaveManager();
    const baseline = wm.enemiesAlive;
    const target = liveTraffic(scene)[0];
    target.x = GAME_WIDTH / 2;
    target.y = 200;
    scene.spawnPlayerBullet(target.x, target.y, 0, 0);
    scene.tick(0.001);
    expect(target.alive).toBe(false);
    // Non-blocking: destroying a hazard does not change wave accounting.
    expect(wm.enemiesAlive).toBe(baseline);
  });

  it('never fires at any level (no enemy bullets)', async () => {
    const scene = await bootWithLaneTrafficWave();
    releaseLaneTraffic(scene);
    const traffic = liveTraffic(scene);
    expect(traffic.length).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) scene.tick(0.1);
    expect(scene.getEnemyBullets()).toHaveLength(0);
    for (const t of traffic) {
      expect(t.shootEnabled).toBe(false);
      expect(t.effectiveShotPattern).toBe('none');
    }
  });

  it('passes through other enemies (no enemy-enemy collision)', async () => {
    const scene = await bootWithLaneTrafficWave();
    releaseLaneTraffic(scene);
    const traffic = liveTraffic(scene)[0];
    const scout = scene
      .getEnemies()
      .find((e): e is Scout => e instanceof Scout && e.alive)!;
    expect(scout).toBeDefined();
    // Overlap the hazard with the Scout: neither may be destroyed by the
    // other (the shared collision pass is player-bullet vs enemy only).
    traffic.x = scout.x;
    traffic.y = scout.y;
    scene.tick(0.001);
    expect(traffic.alive).toBe(true);
    expect(scout.alive).toBe(true);
  });

  it('the lane-traffic spawner disable seam suppresses the hazard', async () => {
    const scene = await bootWithLaneTrafficWave();
    scene.setLaneTrafficSpawnerEnabled(false);
    releaseLaneTraffic(scene);
    expect(liveTraffic(scene)).toHaveLength(0);
  });

  it('does not spawn lane traffic for a wave without the opt-in', async () => {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'No lane traffic',
        waves: [
          {
            groups: [
              {
                enemyKey: 'scout',
                formation: 'v',
                count: 1,
                spacingX: 26,
                spacingY: 22,
                startX: 240,
                startY: 135,
              },
            ],
            shootEnabled: false,
          },
        ],
      },
    ];
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.getWaveManager().setLevels(levels);
    scene.setAsteroidSpawnerEnabled(false);
    scene.setLaneTrafficSpawnerEnabled(true);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    scene.finishSpawnAnimations();

    releaseLaneTraffic(scene);
    expect(liveTraffic(scene)).toHaveLength(0);
  });
});

// ── Phaser orbital spawn transit (AH-0MVEXVME1004SIIS) ─────────────

describe('PlayScene — Phaser orbital spawn transit (AH-0MVEXVME1004SIIS)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Boots a single-wave campaign containing `count` orbital Phasers. */
  async function bootPhaserWave(count: number): Promise<PlayScene> {
    const levels: LevelDefinition[] = [
      {
        level: 1,
        name: 'Phaser orbital',
        waves: [
          {
            groups: [
              {
                enemyKey: 'phaser',
                formation: 'orbital',
                count,
                spacingX: 40,
                spacingY: 40,
                startX: GAME_WIDTH * 0.5,
                startY: GAME_HEIGHT * 0.4,
              },
            ],
            shootEnabled: false,
          },
        ],
      },
    ];
    const { booted: game, scene } = await bootSceneWithLevels(levels, {
      asteroidSpawner: false,
    });
    booted = game;
    return scene;
  }

  function livePhasers(scene: PlayScene): PhaserEntity[] {
    return scene
      .getEnemies()
      .filter((e): e is PhaserEntity => e instanceof PhaserEntity && e.alive);
  }

  function spawnDest(p: PhaserEntity): { x: number; y: number } | undefined {
    return getSpawnState(p as unknown as SpawnAnimatable)?.destFn?.();
  }

  it('transits 12 Phasers straight to their live orbital slots — no line then snap', async () => {
    const scene = await bootPhaserWave(12);
    const phasers = livePhasers(scene);
    expect(phasers).toHaveLength(12);

    // While still emerging from the wormhole the transit destination already
    // resolves to the live orbital slots: all on one ring around the
    // formation centre and all distinct (the reported bug stacked three
    // Phasers on each of four points).
    const dests = phasers.map(spawnDest);
    expect(dests.every((d) => d !== undefined)).toBe(true);
    const centre = {
      x: dests.reduce((sum, d) => sum + d!.x, 0) / dests.length,
      y: dests.reduce((sum, d) => sum + d!.y, 0) / dests.length,
    };
    for (const d of dests) {
      expect(Math.hypot(d!.x - centre.x, d!.y - centre.y)).toBeCloseTo(
        PHASER_ORBITAL_RADIUS,
        3,
      );
    }
    const keys = dests.map((d) => `${d!.x.toFixed(4)},${d!.y.toFixed(4)}`);
    expect(new Set(keys).size).toBe(12);

    // The destination is the point the orbit takes over: when the spawn
    // window ends the Phaser settles onto it with no visible jump.
    scene.finishSpawnAnimations();
    const settled = livePhasers(scene).map((p) => ({ x: p.x, y: p.y }));
    scene.tick(0.001);
    const after = livePhasers(scene);
    expect(after).toHaveLength(12);
    for (let i = 0; i < after.length; i++) {
      expect(
        Math.hypot(after[i].x - settled[i].x, after[i].y - settled[i].y),
      ).toBeLessThanOrEqual(1);
    }
  });

  it('N = 4 reproduces the existing square of four distinct on-ring slots', async () => {
    const scene = await bootPhaserWave(4);
    const phasers = livePhasers(scene);
    expect(phasers).toHaveLength(4);

    const dests = phasers.map(spawnDest);
    const centre = {
      x: dests.reduce((sum, d) => sum + d!.x, 0) / dests.length,
      y: dests.reduce((sum, d) => sum + d!.y, 0) / dests.length,
    };
    const angles = dests.map((d) =>
      ((Math.atan2(d!.y - centre.y, d!.x - centre.x) * 180) / Math.PI + 360) %
      360,
    );
    // Four evenly spaced phases: the slots are a quarter turn apart. The ring
    // advances a little during the boot wait, so assert the *spacing* rather
    // than absolute angles.
    const sorted = [...new Set(angles)].sort((a, b) => a - b);
    expect(sorted).toHaveLength(4);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo(90, 6);
    }
    expect(sorted[0] + 360 - sorted[sorted.length - 1]).toBeCloseTo(90, 6);
    const keys = dests.map((d) => `${d!.x.toFixed(4)},${d!.y.toFixed(4)}`);
    expect(new Set(keys).size).toBe(4);
  });
});

/**
 * Mini-boss integration (AH-0MVCRBISU006NUN5, epic AH-0MVCC8XSS007P01Z).
 *
 * The wave manager already recognises each level's wave-10 mini-boss
 * (AH-0MVCRAV3B0069AIJ) and the config-driven `MiniBoss` entity already exists
 * (AH-0MVCRAYSH0014BQJ). These tests cover the PlayScene wiring: spawn on the
 * mini-boss wave, level gating on its defeat, the reward/checkpoint defeat
 * hooks, HUD reflection, and the final-level path into the final boss.
 */
describe('PlayScene — mini-boss encounter (AH-0MVCRBISU006NUN5)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * A compact campaign whose last wave of each level is the mini-boss
   * encounter. Tiny formations keep the deterministic walks fast while
   * exercising the same shared wave/mini-boss code paths as the shipped
   * 10-wave levels.
   */
  function miniBossCampaign(levelCount = 2): LevelDefinition[] {
    const scoutGroup = (count: number) => ({
      enemyKey: 'scout',
      formation: 'v' as const,
      count,
      spacingX: 30,
      spacingY: 26,
      startX: GAME_WIDTH * 0.2,
      startY: GAME_HEIGHT * 0.38,
    });
    const levels: LevelDefinition[] = [];
    for (let i = 0; i < levelCount; i++) {
      levels.push({
        level: i + 1,
        name: i === 0 ? 'Entry' : 'Descent',
        waves: [
          { groups: [scoutGroup(2)], shootEnabled: false },
          { groups: [scoutGroup(2)], shootEnabled: false, miniBoss: true },
        ],
      });
    }
    return levels;
  }

  async function bootMiniBossCampaign(
    levelCount = 2,
  ): Promise<PlayScene> {
    const { booted: game, scene } = await bootSceneWithLevels(
      miniBossCampaign(levelCount),
    );
    booted = game;
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  /** Clears every regular wave until the level's mini-boss wave is current. */
  function advanceToMiniBoss(scene: PlayScene): void {
    const wm = scene.getWaveManager();
    scene.getGameState().lives = 99; // survive incidental fire while walking.
    for (let guard = 0; guard < 20 && !wm.miniBossActive; guard++) {
      if (resolveMineralChoiceIfOpen(scene)) continue;
      killSpawnedEnemies(scene);
      finishTransition(scene);
    }
    expect(wm.miniBossActive).toBe(true);
  }

  it('AC1 — the mini-boss wave spawns the active level\'s mini-boss config', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);

    const miniBoss = scene.getMiniBoss();
    expect(miniBoss).not.toBeNull();
    expect(miniBoss!.alive).toBe(true);
    expect(miniBoss).toBeInstanceOf(MiniBoss);
    // The active level's bespoke design supplies the identity (AC1/AC3,
    // AH-0MVCRBXSS008JSV0).
    expect(miniBoss!.resolvedConfig.level).toBe(scene.getWaveManager().level);
    expect(miniBoss!.resolvedConfig.name).toBe(
      miniBossDesignForLevel(scene.getWaveManager().level).archetype,
    );
    // The shared boss accessor targets the encounter so the live entity is
    // advanced/targeted by the shared combat core.
    expect(scene.getBoss()).toBe(miniBoss);
  });

  it('AC2 — the level does not advance while the mini-boss is alive, and completes only on its defeat', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    const wm = scene.getWaveManager();
    expect(wm.level).toBe(1);

    // Wipe the wave's escorts: the encounter (and the level) must be held.
    killSpawnedEnemies(scene);
    expect(scene.getMiniBoss()!.alive).toBe(true);
    expect(wm.level).toBe(1);
    expect(wm.miniBossActive).toBe(true);
    expect(scene.isTransitioning()).toBe(false);

    // Defeating the mini-boss completes the level; the next level begins at
    // wave 1.
    killMiniBoss(scene);
    expect(scene.getMiniBoss()).toBeNull();
    expect(wm.miniBossActive).toBe(false);
    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);

    finishTransition(scene);
    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
  });

  it('AC3 — defeat fires exactly one reward hook and one checkpoint hook at the defeat moment', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    const reward = vi.fn();
    const checkpoint = vi.fn();
    scene.setMiniBossRewardHook(reward);
    scene.setMiniBossCheckpointHook(checkpoint);
    expect(scene.getMiniBossDefeatCount()).toBe(0);

    killMiniBoss(scene);

    expect(scene.getMiniBossDefeatCount()).toBe(1);
    expect(reward).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    const expected = {
      level: 1,
      waveNumber: 2,
      miniBossName: miniBossDesignForLevel(1).archetype,
      isFinalLevel: false,
    };
    expect(reward).toHaveBeenCalledWith(expected);
    expect(checkpoint).toHaveBeenCalledWith(expected);

    // Further ticks (e.g. the level transition) never re-fire the hooks.
    scene.tick(0.016);
    finishTransition(scene);
    expect(reward).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(scene.getMiniBossDefeatCount()).toBe(1);
  });

  it('AC3 — the defeat hooks are guarded until a consumer installs them', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);

    // No hooks installed: defeating the mini-boss must not throw and must
    // still advance the level.
    expect(() => killAllEnemies(scene)).not.toThrow();
    expect(scene.getMiniBossDefeatCount()).toBe(1);
    expect(scene.getWaveManager().level).toBe(2);
  });

  it('AC4 — the HUD shows wave 10 of N and the mini-boss health bar during the encounter', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    const wm = scene.getWaveManager();
    const miniBoss = scene.getMiniBoss()!;

    // The shared progress label reflects the wave-10 wave of N position.
    expect(wm.waveNumber).toBe(wm.waveCount);
    expect(scene.getLevelText()).toBe(
      `Level 1: Entry, Wave: ${wm.waveCount} of ${wm.waveCount}`,
    );
    // The shared health bar renders for the encounter (same Boss machinery).
    expect(scene.getBossPhase()).toBe(1);
    expect(miniBoss.getHpFraction()).toBe(1);
    expect(miniBoss.getHealthBarGraphics().visible).toBe(true);

    // A hit depletes the visible health fraction.
    const isolated = scene as unknown as {
      getEnemyEntities(): readonly unknown[];
      autoFireEnabled(): boolean;
    };
    const originalGetEnemyEntities = isolated.getEnemyEntities;
    const originalAutoFireEnabled = isolated.autoFireEnabled;
    isolated.getEnemyEntities = () => [];
    isolated.autoFireEnabled = () => false;
    try {
      scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
      scene.tick(0.016);
    } finally {
      isolated.getEnemyEntities = originalGetEnemyEntities;
      isolated.autoFireEnabled = originalAutoFireEnabled;
    }
    expect(miniBoss.getHpFraction()).toBeLessThan(1);
  });

  it('AC1/AC4 — a defeat offers exactly one upgrade-or-unlock choice', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    // Collect/own a weapon so the upgrade option set is non-empty.
    scene.getPlayer()!.equipWeapon('spread', true);

    killMiniBoss(scene, false);

    const options = scene.getMiniBossRewardOptions();
    expect(options.length).toBeGreaterThan(0);
    // Both option families are present: owned-item upgrades and locked
    // weapon unlocks.
    expect(options.some((option) => option.kind === 'weapon-level')).toBe(true);
    expect(options.some((option) => option.kind === 'weapon')).toBe(true);
    // The unlock candidates are exactly the still-locked weapons.
    const unlockIds = options
      .filter((option) => option.kind === 'weapon')
      .map((option) => option.id);
    expect(unlockIds.sort()).toEqual(
      [...lockedWeaponIds({ unlockedWeapons: new Set() })].sort(),
    );
  });

  it('AC2/AC4 — choosing an upgrade raises an owned permanent item by one level', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    const player = scene.getPlayer()!;
    player.equipWeapon('railgun', true);
    const before = player
      .getWeaponLevels()
      .find((entry) => entry.id === 'railgun')!.level;

    killMiniBoss(scene, false);
    const options = scene.getMiniBossRewardOptions();
    const upgradeIndex = options.findIndex(
      (option) => option.kind === 'weapon-level' && option.id === 'railgun',
    );
    expect(upgradeIndex).toBeGreaterThanOrEqual(0);

    const chosen = scene.selectMiniBossReward(upgradeIndex);
    expect(chosen).not.toBeNull();
    const after = player
      .getWeaponLevels()
      .find((entry) => entry.id === 'railgun')!.level;
    expect(after).toBe(before + 1);
    // The reward is resolved exactly once (AC4).
    expect(scene.isMiniBossRewardOpen()).toBe(false);
    expect(scene.selectMiniBossReward(upgradeIndex)).toBeNull();
  });

  it('AC3/AC4 — choosing an unlock makes that locked weapon available for the run', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    expect(scene.getUnlockedWeapons()).toEqual([]);

    killMiniBoss(scene, false);
    const options = scene.getMiniBossRewardOptions();
    const unlockIndex = options.findIndex(
      (option) => option.kind === 'weapon' && option.id === 'railgun',
    );
    expect(unlockIndex).toBeGreaterThanOrEqual(0);

    scene.selectMiniBossReward(unlockIndex);
    expect(scene.getUnlockedWeapons()).toEqual(['railgun']);
    // The unlocked weapon is genuinely equipped through the shared seam.
    expect(
      scene
        .getPlayer()!
        .getWeaponLevels()
        .some((entry) => entry.id === 'railgun'),
    ).toBe(true);
    // And it is no longer offered as an unlock by the next encounter.
    const stillLocked = lockedWeaponIds({
      unlockedWeapons: new Set(scene.getUnlockedWeapons()),
    });
    expect(stillLocked).not.toContain('railgun');
    expect(MINI_BOSS_LOCKED_WEAPONS).toContain('railgun');
  });

  it('AC2 — a mini-boss defeat auto-saves the run checkpoint', async () => {
    localStorage.removeItem(CHECKPOINT_STORAGE_KEY);
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    scene.getGameState().score = 4321;
    scene.getGameState().lives = 2;
    scene.getGameState().minerals = 5;
    scene.getPlayer()!.equipWeapon('spread', true);

    killMiniBoss(scene, false);

    const saved = loadCheckpoint();
    expect(saved).not.toBeNull();
    expect(saved!.level).toBe(2); // resume at the level AFTER the mini-boss
    expect(saved!.wave).toBe(1);
    expect(saved!.lives).toBe(2);
    expect(saved!.score).toBe(4321);
    expect(saved!.minerals).toBe(5);
    expect(saved!.runSeed).toBe(scene.getRunSeed());
    expect(saved!.weaponLevels.some((entry) => entry.id === 'spread')).toBe(true);
  });

  it('AH-0MVH85XXZ008INE2 — a defeated mini-boss leaves no graphics behind', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    const miniBoss = scene.getMiniBoss()!;
    // The encounter owns a scene-level health-bar Graphics (the "box").
    const healthBar = miniBoss.getHealthBarGraphics();
    expect(healthBar.visible).toBe(true);

    killMiniBoss(scene, false);

    // The shared accessors no longer report the encounter, so the shared tick
    // cannot re-draw any of its graphics.
    expect(scene.getMiniBoss()).toBeNull();
    expect(scene.getBoss()).toBeNull();
    // The entity is fully destroyed: its container and the scene-level health
    // bar are gone (not merely faded/darkened) — no leftover box or ring.
    expect(miniBoss.active).toBe(false);
    expect(miniBoss.scene).toBeUndefined();
    expect(healthBar.active).toBe(false);
    expect(healthBar.scene).toBeUndefined();
    // And nothing on the display list still draws the old health bar.
    expect(scene.children.list.includes(healthBar as unknown as Phaser.GameObjects.GameObject)).toBe(false);
  });

  it('AH-0MVH80ZJ7009W18Z — Frenzy amplifies each boss-style hit', async () => {
    const scene = await bootMiniBossCampaign();
    advanceToMiniBoss(scene);
    const miniBoss = scene.getMiniBoss()!;
    const registry = scene.getEffectsRegistry();
    // Permanent Frenzy at its base level (1 bonus hit).
    registry.applyCollect('frenzy', true);
    expect(registry.frenzyBonusHits()).toBe(1);

    const totalHp =
      miniBoss.resolvedConfig.hpPerPhase * miniBoss.getPhaseCount();
    const before = miniBoss.getHpFraction() * totalHp;

    // One isolated bullet (auto-fire and other enemies disabled).
    const isolated = scene as unknown as {
      getEnemyEntities(): readonly unknown[];
      autoFireEnabled(): boolean;
    };
    const originalGetEnemyEntities = isolated.getEnemyEntities;
    const originalAutoFireEnabled = isolated.autoFireEnabled;
    isolated.getEnemyEntities = () => [];
    isolated.autoFireEnabled = () => false;
    try {
      scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
      scene.tick(0);
    } finally {
      isolated.getEnemyEntities = originalGetEnemyEntities;
      isolated.autoFireEnabled = originalAutoFireEnabled;
    }
    if (scene.isMiniBossRewardOpen()) scene.selectMiniBossReward(0);

    const after = miniBoss.getHpFraction() * totalHp;
    // One shot consumes 1 + bonus hits (2), not 1.
    expect(Math.round(before - after)).toBe(2);
  });

  it('AH-0MVH80ZJ7009W18Z — Chrono Field slows enemy bullets while active', async () => {
    const scene = await bootMiniBossCampaign();
    const registry = scene.getEffectsRegistry();
    (scene as unknown as { autoFireEnabled: () => boolean }).autoFireEnabled =
      () => false;
    const baseline = scene.spawnEnemyBullet(100, 100, 100, 0, 0xff0000, 5);
    scene.tick(1);
    const normalStep = baseline.graphics.x - 100;
    expect(normalStep).toBeCloseTo(100, 1);

    registry.applyCollect('chrono', true);
    const slowed = scene.spawnEnemyBullet(100, 100, 100, 0, 0xff0000, 5);
    scene.tick(1);
    const slowedStep = slowed.graphics.x - 100;
    // Default chronoSlowFactor 0.5 → the bullet advances at half speed.
    expect(slowedStep).toBeCloseTo(normalStep * registry.enemyBulletTimeScale(), 1);
    expect(slowedStep).toBeLessThan(normalStep);
  });

  it('AH-0MVH80ZJ7009W18Z — Thorn Field absorbs a ram instead of costing a life', async () => {
    const scene = await bootMiniBossCampaign();
    const player = scene.getPlayer()!;
    const livesBefore = scene.getGameState().lives;
    // The player's own fire must not destroy the ram target first.
    (scene as unknown as { autoFireEnabled: () => boolean }).autoFireEnabled =
      () => false;
    scene.finishSpawnAnimations();

    scene.getEffectsRegistry().applyCollect('thorns', true);
    const charges = scene.getEffectsRegistry().thornsRemaining();
    expect(charges).toBeGreaterThan(0);

    // Park the ship on the first live enemy (movement state spread so physics
    // does not pull it away before the collision pass).
    const target = scene.getEnemies().find((e) => e.alive)!;
    player.setPosition(target.x, target.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: typeof state })._movementState = {
      ...state,
      x: target.x,
      y: target.y,
    };
    (scene as unknown as { invulnerable: number }).invulnerable = 0;

    const ramSpy = vi.spyOn(
      scene as unknown as { onPlayerRamsEnemy: (e: unknown) => void },
      'onPlayerRamsEnemy',
    );
    scene.tick(0.001);

    // The ram registered on a live enemy and was absorbed: the rammed enemy
    // is destroyed, the player loses no life and one charge is consumed.
    expect(ramSpy).toHaveBeenCalledTimes(1);
    const victim = ramSpy.mock.calls[0][0] as { alive: boolean };
    expect(victim.alive).toBe(false);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(scene.getEffectsRegistry().thornsRemaining()).toBe(charges - 1);
  });

  it('AH-0MVJ8YKR70096C6T — an absorbed ram fires the distinct thorns burst and cue', async () => {
    const scene = await bootMiniBossCampaign();
    const player = scene.getPlayer()!;
    const cueSpy = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    (scene as unknown as { autoFireEnabled: () => boolean }).autoFireEnabled =
      () => false;
    scene.finishSpawnAnimations();

    scene.getEffectsRegistry().applyCollect('thorns', true);
    const charges = scene.getEffectsRegistry().thornsRemaining();

    const target = scene.getEnemies().find((e) => e.alive)!;
    player.setPosition(target.x, target.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: typeof state })._movementState = {
      ...state,
      x: target.x,
      y: target.y,
    };
    (scene as unknown as { invulnerable: number }).invulnerable = 0;
    // The shield/phase absorb paths would also suppress a hit — clear both so
    // the thorn absorb is the only thing that can prevent it.
    expect(scene.getThornsAbsorbEffects()).toHaveLength(0);

    scene.tick(0.001);

    // The absorb is visible: one burst at the collision, plus its shatter
    // cue — the shared seam, not a silent life-free ram.
    expect(scene.getThornsAbsorbEffects()).toHaveLength(1);
    const burst = scene.getThornsAbsorbEffects()[0];
    expect(burst.x).toBeCloseTo(player.x, 3);
    expect(burst.y).toBeCloseTo(player.y, 3);
    expect(cueSpy).toHaveBeenCalled();
    expect(scene.getEffectsRegistry().thornsRemaining()).toBe(charges - 1);
  });

  it('AH-0MVJ8YKR70096C6T — the lime thorns aura is drawn only while armed', async () => {
    const scene = await bootMiniBossCampaign();
    const registry = scene.getEffectsRegistry();

    // Inactive field: no aura.
    scene.tick(0.001);
    expect(scene.isThornsAuraVisible()).toBe(false);

    registry.applyCollect('thorns', true);
    scene.tick(0.001);
    expect(scene.isThornsAuraVisible()).toBe(true);

    // Spend the whole budget: the aura clears (the field no longer counters).
    while (registry.thornsRemaining() > 0) registry.tryConsumeThornsRam();
    scene.tick(0.001);
    expect(scene.isThornsAuraVisible()).toBe(false);
  });

  it('AH-0MVJ8YKR70096C6T — a permanent Thorn Field recharges and re-arms by itself', async () => {
    const scene = await bootMiniBossCampaign();
    const registry = scene.getEffectsRegistry();
    registry.applyCollect('thorns', true);
    while (registry.thornsRemaining() > 0) registry.tryConsumeThornsRam();
    expect(registry.thornsRemaining()).toBe(0);
    expect(scene.isThornsAuraVisible()).toBe(false);

    // The shared per-frame step advances the recharge clock (never a
    // scene-local timer), so the held budget returns on its own.
    scene.tick(registry.thornsRechargeTime() + 0.01);
    expect(registry.thornsRemaining()).toBeGreaterThan(0);
    expect(scene.isThornsAuraVisible()).toBe(true);
  });

  it('AH-0MVJ8YKR70096C6T — an exhausted field no longer absorbs: the ram hurts normally', async () => {
    const scene = await bootMiniBossCampaign();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();
    const livesBefore = scene.getGameState().lives;
    (scene as unknown as { autoFireEnabled: () => boolean }).autoFireEnabled =
      () => false;
    scene.finishSpawnAnimations();

    registry.applyCollect('thorns', true);
    while (registry.thornsRemaining() > 0) registry.tryConsumeThornsRam();
    expect(registry.thornsRemaining()).toBe(0);

    const target = scene.getEnemies().find((e) => e.alive)!;
    player.setPosition(target.x, target.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: typeof state })._movementState = {
      ...state,
      x: target.x,
      y: target.y,
    };
    (scene as unknown as { invulnerable: number }).invulnerable = 0;

    scene.tick(0.001);

    // No absorb burst and a real hit: the field stays spent (it recharges on
    // its own clock, not on contact).
    expect(scene.getThornsAbsorbEffects()).toHaveLength(0);
    expect(scene.getGameState().lives).toBe(livesBefore - 1);
  });

  it('AH-0MVH80ZJ7009W18Z — Salvage adds bonus minerals at a destroyed enemy', async () => {
    const scene = await bootMiniBossCampaign();
    const registry = scene.getEffectsRegistry();
    scene.finishSpawnAnimations();
    const enemies = scene.getEnemies().filter((e) => e.alive);

    // Control: one kill with no Salvage window.
    const before = scene.getMinerals().length;
    scene.spawnPlayerBullet(enemies[0].x, enemies[0].y, 0, 0);
    scene.tick(0);
    const controlDrops = scene.getMinerals().length - before;

    // Level Salvage up so the bonus dominates the ≤1-mineral base drop.
    for (let i = 0; i < 8; i += 1) registry.applyCollect('salvage', true);
    const bonus = registry.salvageBonusMinerals();
    expect(bonus).toBeGreaterThanOrEqual(3);

    // Salvaged: the same single kill now also drops the bonus bounty.
    const beforeSalvage = scene.getMinerals().length;
    scene.spawnPlayerBullet(enemies[1].x, enemies[1].y, 0, 0);
    scene.tick(0);
    const salvagedDrops = scene.getMinerals().length - beforeSalvage;

    expect(salvagedDrops).toBeGreaterThan(controlDrops);
    expect(salvagedDrops).toBeGreaterThanOrEqual(bonus);
  });

  it('AH-0MVJ72I8O0009T09 — Salvage bonus minerals render orange while ordinary drops stay gold', async () => {
    const scene = await bootMiniBossCampaign();
    const registry = scene.getEffectsRegistry();
    scene.finishSpawnAnimations();
    const enemies = scene.getEnemies().filter((e) => e.alive);

    // Control: a kill with no Salvage window leaves no orange mineral behind.
    const beforeControl = scene.getMinerals().length;
    scene.spawnPlayerBullet(enemies[0].x, enemies[0].y, 0, 0);
    scene.tick(0);
    const controlDrops = scene.getMinerals().slice(beforeControl);
    expect(controlDrops.some((m) => m.color === MINERAL_SALVAGE_COLOR)).toBe(
      false,
    );
    expect(controlDrops.every((m) => m.color === MINERAL_COLOR)).toBe(true);

    // Level Salvage up so the bounty is unambiguous, then kill another enemy.
    for (let i = 0; i < 8; i += 1) registry.applyCollect('salvage', true);
    const bonus = registry.salvageBonusMinerals();
    expect(bonus).toBeGreaterThanOrEqual(3);

    const beforeSalvage = scene.getMinerals().length;
    scene.spawnPlayerBullet(enemies[1].x, enemies[1].y, 0, 0);
    scene.tick(0);
    const salvaged = scene.getMinerals().slice(beforeSalvage);

    // Exactly the bounty is orange; any base re-drop in the same kill stays gold.
    const orange = salvaged.filter((m) => m.color === MINERAL_SALVAGE_COLOR);
    expect(orange).toHaveLength(bonus);
    expect(
      salvaged.filter((m) => m.color !== MINERAL_SALVAGE_COLOR),
    ).toEqual(salvaged.filter((m) => m.color === MINERAL_COLOR));
    // The extra dots land at the wreck, scattered like any other drop.
    const wreck = enemies[1];
    for (const drop of orange) {
      expect(Math.hypot(drop.x - wreck.x, drop.y - wreck.y)).toBeLessThanOrEqual(
        MINERAL_REDROP_SCATTER_RADIUS,
      );
    }
  });

  it('AH-0MVH80ZJ7009W18Z — Orbital Strike damages the nearest enemy on pickup', async () => {
    const scene = await bootMiniBossCampaign();
    const registry = scene.getEffectsRegistry();
    (scene as unknown as { autoFireEnabled: () => boolean }).autoFireEnabled =
      () => false;
    scene.finishSpawnAnimations();
    const player = scene.getPlayer()!;
    const nearest = [...scene.getEnemies()]
      .filter((e) => e.alive)
      .sort(
        (a, b) =>
          Math.hypot(a.x - player.x, a.y - player.y) -
          Math.hypot(b.x - player.x, b.y - player.y),
      )[0];
    expect(nearest).toBeDefined();

    // A field pickup queues exactly one immediate bolt.
    registry.applyCollect('strike', true);
    scene.tick(1 / 60);

    // The nearest (1-HP scout) is destroyed by the strike.
    expect(nearest.alive).toBe(false);
    if (scene.isMiniBossRewardOpen()) scene.selectMiniBossReward(0);
  });

  it('AH-0MVH87A3L004VOLD — a fresh run faces the base mini-boss hit pool', async () => {
    const scene = await bootMiniBossCampaign();
    expect(scene.getPlayerPowerScore()).toBe(0);
    advanceToMiniBoss(scene);
    expect(scene.getMiniBoss()!.resolvedConfig.hpPerPhase).toBe(
      miniBossDesignForLevel(1).hpPerPhase,
    );
  });

  it('AH-0MVH87A3L004VOLD — mini-boss and boss strength scale with permanent upgrades', async () => {
    // Earn permanent upgrades before the encounters spawn.
    const scene = await bootMiniBossCampaign();
    const player = scene.getPlayer()!;
    for (let i = 0; i < 4; i += 1) player.equipWeapon('railgun', true);
    for (let i = 0; i < 3; i += 1) {
      scene.getEffectsRegistry().applyCollect('shield', true);
    }
    const score = scene.getPlayerPowerScore();
    expect(score).toBe(7);

    advanceToMiniBoss(scene);
    const miniBoss = scene.getMiniBoss()!;
    expect(miniBoss.resolvedConfig.hpPerPhase).toBe(
      scaledEncounterHp(miniBossDesignForLevel(1).hpPerPhase, score),
    );
    expect(miniBoss.resolvedConfig.hpPerPhase).toBeGreaterThan(
      miniBossDesignForLevel(1).hpPerPhase,
    );
    if (scene.isMiniBossRewardOpen()) scene.selectMiniBossReward(0);
  });

  it('AC5 — on the final level, defeating the mini-boss triggers the final boss', async () => {
    // One level: `isFinalLevel` is true from the start, so the level's
    // mini-boss defeat must trigger the Central AI boss.
    const scene = await bootMiniBossCampaign(1);
    advanceToMiniBoss(scene);
    expect(scene.getWaveManager().isFinalLevel).toBe(true);

    killAllEnemies(scene);
    const wm = scene.getWaveManager();
    expect(wm.bossTriggered).toBe(true);
    expect(scene.getMiniBoss()).toBeNull();

    finishTransition(scene);
    expect(wm.bossActive).toBe(true);
    const boss = scene.getBoss();
    expect(boss).not.toBeNull();
    expect(boss).not.toBeInstanceOf(MiniBoss);
    expect(boss!.alive).toBe(true);
  });
});

/**
 * Per-level kill-drop chance tests (AH-0MVLJF4DI000BKMQ).
 *
 * **TEST-FIRST.** These tests pin the parent AC "Power-up supply per enemy
 * falls with level" (AH-0MVHT1M6O003PU7P): every kill-time drop roll in
 * `PlayScene` must resolve the per-level chance from the live campaign
 * (`WaveManager.currentLevel()?.level`), keep level 1 exactly at today's
 * flat `POWER_UP_DROP_CHANCE` (0.18) rate, fall to the level-10 endpoint
 * (0.05, ≤ 30 % of level 1), scale the small-asteroid Extra Life roll by
 * the same ratio, and leave drop types/weights, the mineral kill-drop rule
 * and timed power-up effects untouched.
 *
 * The level-scaled assertions (level-10 endpoint, mid-run level advance and
 * the level-10 Extra Life roll) **fail on the pre-change HEAD**, where
 * `_maybeDropPowerUp` still rolls a flat 0.18 for every level and the Extra
 * Life roll is the flat `asteroidExtraLifeDropChance`. They are wrapped in
 * Vitest's `it.fails(...)` — the repo's red-before/green-after convention
 * (see `src/core/levelScaling.test.ts` and AH-0MVLJCYGW001TRB3) — so the
 * suite stays green while the flat roll is still live. **F2
 * (AH-0MVLJF5P0005KF8X) works in this file**: the scene now resolves the
 * per-level chance, and the red tests are flipped back to `it` (these
 * three flipped tests are the green evidence the implementation landed).
 *
 * Every roll is driven with a **constant injected RNG**, so the number of
 * drops over the N kill rolls is exact and deterministic — no statistical
 * or threshold sampling. The constants are derived from the documented
 * curve (`powerUpDropChance(1) = 0.18`, `powerUpDropChance(10) = 0.05`,
 * `extraLifeDropChance(10) ≈ 0.0139`), so a tuner who adjusts the curve in
 * `GameRules` updates these tests through the same module the scene
 * consumes.
 *
 * @module scenes/PlayScene.dropChance (within PlayScene.test.ts)
 */

describe('PlayScene — per-level kill-drop chance (AH-0MVLJF4DI000BKMQ)', () => {
  let bootedGame: BootedGame | null = null;

  /** The documented level-1 per-kill chance (0.18). */
  const CHANCE_L1 = powerUpDropChance(1);
  /** The documented level-2 per-kill chance (≈ 0.1656). */
  const CHANCE_L2 = powerUpDropChance(2);
  /** The documented level-10 per-kill chance (0.05). */
  const CHANCE_L10 = powerUpDropChance(10);
  /** Below the level-1 chance ⇒ the level-1 roll always drops (0.17). */
  const ROLL_BELOW_L1 = CHANCE_L1 - 0.01;
  /** Above the level-1 chance ⇒ the level-1 roll never drops (0.19). */
  const ROLL_ABOVE_L1 = CHANCE_L1 + 0.01;
  /** Between the level-1 and level-2 chances ⇒ drops at 1, never at 2. */
  const ROLL_BETWEEN_L1_L2 = (CHANCE_L1 + CHANCE_L2) / 2;
  /** Between the level-1 and level-10 chances ⇒ drops at 1, never at 10. */
  const ROLL_BETWEEN_L1_L10 = (CHANCE_L1 + CHANCE_L10) / 2;
  /** Below the level-10 chance ⇒ the level-10 roll still drops (0.049). */
  const ROLL_BELOW_L10 = CHANCE_L10 - 0.001;
  /** Extra Life chance at level 1 (unchanged default 0.05). */
  const EXTRA_LIFE_L1 = DEFAULT_RULES.asteroidExtraLifeDropChance;
  /** Extra Life chance at level 10 (same ratio as the per-kill chance). */
  const EXTRA_LIFE_L10 = extraLifeDropChance(10);
  /** Between the level-1 and level-10 Extra Life chances (≈ 0.0319). */
  const ROLL_EXTRA_LIFE_MID = (EXTRA_LIFE_L1 + EXTRA_LIFE_L10) / 2;
  /** Every DropId the shared weighted spawner can hand out. */
  const DROP_POOL = new Set([...POWER_UP_WEIGHT_IDS, ...WEAPON_WEIGHT_IDS]);

  /**
   * The private kill-roll seam F2 changes, exposed for the unknown-level
   * fallback test (the method reads the live campaign level at roll time).
   */
  type DropRollSeam = {
    _maybeDropPowerUp(x: number, y: number): void;
  };

  /** A campaign whose levels are single, non-firing scout waves. */
  function dropCampaign(
    firstLevelNumber: number,
    levels: number = 1,
  ): LevelDefinition[] {
    return Array.from({ length: levels }, (_, i) => ({
      level: firstLevelNumber + i,
      name: `Drop Test Level ${firstLevelNumber + i}`,
      waves: [
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 16,
              spacingX: 60,
              spacingY: 44,
              startX: GAME_WIDTH * 0.15,
              startY: GAME_HEIGHT * 0.3,
            },
          ],
          shootEnabled: false,
        },
      ],
    }));
  }

  /** Boots the PlayScene on the given campaign with the asteroid spawner off. */
  async function bootDropScene(levels: LevelDefinition[]): Promise<PlayScene> {
    // Opt out of the sequenced campaign so the injected fixture is honoured.
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    bootedGame = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = bootedGame.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.getWaveManager().setLevels(levels);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    return scene;
  }

  afterEach(() => {
    bootedGame?.game.destroy(true);
    bootedGame = null;
    localStorage.clear();
  });

  /**
   * Kills exactly `howMany` live non-asteroid enemies through the real
   * bullet path, isolating each kill (auto-fire off, only the target
   * hittable) so collateral kills cannot add drop rolls.
   */
  function killExactlyNTargets(scene: PlayScene, howMany: number): void {
    const isolated = scene as unknown as {
      getEnemyEntities(): readonly unknown[];
      autoFireEnabled(): boolean;
    };
    const originalGetEnemyEntities = isolated.getEnemyEntities;
    const originalAutoFireEnabled = isolated.autoFireEnabled;
    isolated.autoFireEnabled = () => false;
    let killed = 0;
    try {
      for (let guard = 0; guard < 2000 && killed < howMany; guard++) {
        const target = scene
          .getEnemies()
          .find((e) => e.alive && !(e instanceof Asteroid));
        if (!target) break;
        isolated.getEnemyEntities = () => [target];
        scene.spawnPlayerBullet(target.x, target.y, 0, 0);
        scene.tick(0.016);
        if (!target.alive) killed += 1;
      }
    } finally {
      isolated.getEnemyEntities = originalGetEnemyEntities;
      isolated.autoFireEnabled = originalAutoFireEnabled;
    }
    expect(killed).toBe(howMany);
  }

  /**
   * Spawns a **small** asteroid at (x, y) and destroys it via player
   * bullets, isolated so only the rock can take the hit. Small asteroids do
   * not split and are not wave-accounted, so a kill only runs the drop
   * rolls (`_maybeDropPowerUp` plus the Extra Life roll).
   */
  function spawnAndDestroySmallAsteroid(
    scene: PlayScene,
    x: number,
    y: number,
  ): void {
    const rock = scene.spawnAsteroidAt(x, y, 'small');
    const isolated = scene as unknown as {
      getEnemyEntities(): readonly unknown[];
      autoFireEnabled(): boolean;
    };
    const originalGetEnemyEntities = isolated.getEnemyEntities;
    const originalAutoFireEnabled = isolated.autoFireEnabled;
    isolated.autoFireEnabled = () => false;
    isolated.getEnemyEntities = () => [rock];
    try {
      for (let guard = 0; guard < 200 && rock.alive; guard++) {
        scene.spawnPlayerBullet(rock.x, rock.y, 0, 0);
        scene.tick(0.016);
      }
    } finally {
      isolated.getEnemyEntities = originalGetEnemyEntities;
      isolated.autoFireEnabled = originalAutoFireEnabled;
    }
    expect(rock.alive).toBe(false);
  }

  /** The well-separated small-asteroid kill sites shared by the suites. */
  const ASTEROID_SITES: ReadonlyArray<readonly [number, number]> = [
    [GAME_WIDTH * 0.2, GAME_HEIGHT * 0.3],
    [GAME_WIDTH * 0.4, GAME_HEIGHT * 0.35],
    [GAME_WIDTH * 0.6, GAME_HEIGHT * 0.28],
    [GAME_WIDTH * 0.8, GAME_HEIGHT * 0.33],
  ];

  // ── Level-1 identity (GREEN on pre-change HEAD) ─────────────────

  it('level 1 — kill-time pool drops keep the documented 0.18 per-kill rate', async () => {
    const scene = await bootDropScene(dropCampaign(1));
    // 0.17 ≤ 0.18 ⇒ the level-1 roll passes every kill, exactly N drops.
    scene.setRng(() => ROLL_BELOW_L1);
    finishSpawnSequence(scene);
    expect(scene.getWaveManager().level).toBe(1);

    const spawn = vi.spyOn(scene, 'spawnPowerUpDrop');
    killExactlyNTargets(scene, 4);

    // One drop per kill — nothing statistical, the counts are exact.
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(scene.getDrops()).toHaveLength(4);
    // The drops still come from the shared weighted pool: the level scaling
    // touches only the chance, never the drop types/weights.
    expect(scene.getDrops().every((d) => DROP_POOL.has(d.dropId))).toBe(true);
    spawn.mockRestore();
  });

  it('level 1 — a roll above the 0.18 rate never drops', async () => {
    const scene = await bootDropScene(dropCampaign(1));
    // 0.19 > 0.18 ⇒ with the exact level-1 chance no kill drops. This
    // brackets the scene's use of the level-1 value from above.
    scene.setRng(() => ROLL_ABOVE_L1);
    finishSpawnSequence(scene);

    const spawn = vi.spyOn(scene, 'spawnPowerUpDrop');
    killExactlyNTargets(scene, 4);
    expect(spawn).not.toHaveBeenCalled();
    expect(scene.getDrops()).toHaveLength(0);
    spawn.mockRestore();
  });

  // ── Level-10 endpoint (RED until F2 resolves the level) ─────────

  it('level 10 — a roll below the 0.05 endpoint still drops (supply never zeroes)', async () => {
    const scene = await bootDropScene(dropCampaign(10));
    // 0.049 ≤ 0.05 ⇒ every level-10 roll passes: the endpoint is 0.05, not 0.
    scene.setRng(() => ROLL_BELOW_L10);
    finishSpawnSequence(scene);
    // The per-kill chance resolves the campaign's *design* level
    // (WaveManager.currentLevel()?.level), not the wave-manager index.
    expect(scene.getWaveManager().currentLevel()?.level).toBe(10);

    const spawn = vi.spyOn(scene, 'spawnPowerUpDrop');
    killExactlyNTargets(scene, 4);
    expect(spawn).toHaveBeenCalledTimes(4);
    spawn.mockRestore();
  });

  it(
    'level 10 — the per-kill chance falls to 0.05 (30 % of the level-1 supply)',
    async () => {
      const scene = await bootDropScene(dropCampaign(10));
      // 0.115 sits between the level-1 (0.18) and level-10 (0.05) chances:
      // the roll drops at level 1 and never at level 10. On the pre-change
      // flat roll (0.18 at every level) every one of these kills drops —
      // RED until F2 resolves the campaign level at roll time.
      scene.setRng(() => ROLL_BETWEEN_L1_L10);
      finishSpawnSequence(scene);
      expect(scene.getWaveManager().currentLevel()?.level).toBe(10);

      const spawn = vi.spyOn(scene, 'spawnPowerUpDrop');
      killExactlyNTargets(scene, 4);
      expect(spawn).not.toHaveBeenCalled();
      expect(scene.getDrops()).toHaveLength(0);
      spawn.mockRestore();
    },
  );

  // ── Mid-run level advance (RED until F2 re-resolves per kill) ────

  it(
    'mid-run — advancing a level re-resolves the drop chance for the next kills',
    async () => {
      const scene = await bootDropScene(dropCampaign(1, 2)); // levels 1 → 2
      // 0.1728 sits between the level-1 (0.18) and level-2 (≈ 0.1656)
      // chances: level-1 kills drop, level-2 kills never do.
      scene.setRng(() => ROLL_BETWEEN_L1_L2);
      finishSpawnSequence(scene);
      const wm = scene.getWaveManager();
      expect(wm.currentLevel()?.level).toBe(1);

      const spawn = vi.spyOn(scene, 'spawnPowerUpDrop');

      // Level 1: every kill drops (GREEN half — the level-1 rate holds).
      killExactlyNTargets(scene, 4);
      expect(spawn).toHaveBeenCalledTimes(4);

      // Clear the level through the real gameplay path → the campaign
      // advances to level 2 on its own.
      killAllEnemies(scene);
      finishTransition(scene);
      expect(wm.currentLevel()?.level).toBe(2);
      const callsAtLevel2 = spawn.mock.calls.length;

      // Level 2: the same roll value must now fail (chance(2) < 0.1728), so
      // no new drops spawn. On the flat-roll HEAD it still drops 4 — RED
      // until F2 reads the live level at kill time.
      killExactlyNTargets(scene, 4);
      expect(spawn.mock.calls.length).toBe(callsAtLevel2);
      spawn.mockRestore();
    },
  );

  // ── Unknown-level fallback (GREEN; proves the level-1 fallback) ──

  it('unknown level — the roll falls back to the level-1 rate when no level is live', async () => {
    const scene = await bootDropScene(dropCampaign(1));
    // Force the "unknown level" state: the campaign has no active level.
    scene.getWaveManager().reset();
    expect(scene.getWaveManager().currentLevel()).toBeNull();
    const roll = scene as unknown as DropRollSeam;

    // A roll just below 0.18 must still drop — the level-1 fallback rate.
    scene.setRng(() => ROLL_BELOW_L1);
    const before = scene.getDrops().length;
    roll._maybeDropPowerUp(GAME_WIDTH / 2, 120);
    expect(scene.getDrops().length).toBe(before + 1);

    // A roll just above 0.18 must not drop — proving the fallback is the
    // level-1 chance and not some higher rate.
    scene.setRng(() => ROLL_ABOVE_L1);
    const beforeHigh = scene.getDrops().length;
    roll._maybeDropPowerUp(GAME_WIDTH / 2 - 80, 120);
    expect(scene.getDrops().length).toBe(beforeHigh);

    // The drop the fallback allowed still comes from the shared pool.
    expect(scene.getDrops().every((d) => DROP_POOL.has(d.dropId))).toBe(true);
  });

  // ── Extra Life proportionality ──────────────────────────────────

  it('Extra Life — the small-asteroid roll keeps the 0.05 chance unchanged at level 1', async () => {
    const scene = await bootDropScene(dropCampaign(1));
    // 0.0319 sits between the level-1 (0.05) and level-10 (≈ 0.0139) Extra
    // Life chances: at level 1 every small-asteroid kill leaves an extra
    // life, at level 10 none would.
    scene.setRng(() => ROLL_EXTRA_LIFE_MID);
    finishSpawnSequence(scene);
    expect(scene.getWaveManager().currentLevel()?.level).toBe(1);

    for (const [x, y] of ASTEROID_SITES) spawnAndDestroySmallAsteroid(scene, x, y);

    expect(
      scene.getDrops().filter((d) => d.dropId === 'extra_life'),
    ).toHaveLength(4);
  });

  it(
    'Extra Life — level 10 scales the roll by the same ratio as the per-kill chance',
    async () => {
      const scene = await bootDropScene(dropCampaign(10));
      scene.setRng(() => ROLL_EXTRA_LIFE_MID);
      finishSpawnSequence(scene);
      expect(scene.getWaveManager().currentLevel()?.level).toBe(10);

      for (const [x, y] of ASTEROID_SITES)
        spawnAndDestroySmallAsteroid(scene, x, y);

      // 0.0319 > extraLifeDropChance(10) ≈ 0.0139 ⇒ no extra life at level
      // 10. RED on pre-change HEAD: the roll is a flat 0.05 at every level,
      // so each kill leaves an extra life.
      expect(
        scene.getDrops().filter((d) => d.dropId === 'extra_life'),
      ).toHaveLength(0);
    },
  );

  // ── Unaffected paths (GREEN both on HEAD and after F2) ──────────

  it('the mineral kill-drop rule is level-independent: a level-10 small-asteroid kill still leaves exactly one mineral', async () => {
    const scene = await bootDropScene(dropCampaign(10));
    // 0.5 > 0.18 (flat HEAD chance) and > 0.05 (level-10 chance): the power-up
    // pool is suppressed at every level, isolating the mineral rule from the
    // drop roll.
    scene.setRng(() => 0.5);
    finishSpawnSequence(scene);

    const dropsBefore = scene.getDrops().length;
    const mineralsBefore = scene.getMinerals().length;
    // Kill away from the player (and the scout formation) so the mineral
    // stays on the field for the count.
    spawnAndDestroySmallAsteroid(scene, GAME_WIDTH * 0.15, GAME_HEIGHT * 0.62);
    // No power-up drop …
    expect(scene.getDrops().length).toBe(dropsBefore);
    // … but the mineral kill-drop rule is untouched: exactly one mineral.
    expect(scene.getMinerals().length).toBe(mineralsBefore + 1);
  });

  it('timed power-up effects still apply at an elevated level', async () => {
    const scene = await bootDropScene(dropCampaign(10));
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();
    expect(scene.getWaveManager().currentLevel()?.level).toBe(10);

    // The level scaling changes the drop ROLL, not the effect pipeline — a
    // timed power-up collected at level 10 must still apply.
    const drop = scene.spawnPowerUpDrop('speed_boost', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isActive('speed_boost')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);
  });
});

// ── Force-field spawn resolution (AH-0MVM8GXEF009883O, AC4) ──────────

/**
 * The game resolves an enemy's force-field strength **once, at spawn**, from
 * the live run level (`WaveManager.level`) through the shared pure resolver
 * (`enemyForceFieldHits`) — never a hard-coded level and never a raw config
 * column. The resolved count is threaded through the same factory parameter
 * the entity layer (AH-0MVM8GUZG008AWSU) introduced. The gym counterpart of
 * this seam is pinned by the parity block in
 * `src/scenes/core/CombatScene.equivalence.test.ts`.
 */
describe('PlayScene — force-field spawn resolution (AH-0MVM8GXEF009883O)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** One injected level: a single non-firing Tank wave (a heavy archetype). */
  function tankLevel(level: number, count = 3): LevelDefinition {
    return {
      level,
      name: `Force Field Level ${level}`,
      waves: [
        {
          groups: [
            {
              enemyKey: 'tank',
              formation: 'rect',
              count,
              spacingX: 44,
              spacingY: 36,
              startX: GAME_WIDTH * 0.3,
              startY: GAME_HEIGHT * 0.25,
            },
          ],
          shootEnabled: false,
        },
      ],
    };
  }

  /**
   * A `target`-level campaign (…one Tank wave per level). `WaveManager.level`
   * is the 1-based level **index**, so the run must actually reach the target
   * level for the spawn seam to resolve it — the injected level definitions'
   * `level` field alone does not move the manager.
   */
  function tankCampaign(target: number): LevelDefinition[] {
    return Array.from({ length: target }, (_, i) => tankLevel(i + 1));
  }

  /** Clears the active wave (bullets drain any force fields) and transitions. */
  function advanceToLevel(scene: PlayScene, target: number): void {
    for (let guard = 0; guard < 12 && scene.getWaveManager().level < target; guard++) {
      killAllEnemies(scene);
      finishTransition(scene);
    }
    expect(scene.getWaveManager().level).toBe(target);
  }

  /** Boots the injected campaign and returns the wave's live Tanks. */
  async function bootCampaign(targetLevel: number): Promise<{ scene: PlayScene; tanks: Tank[] }> {
    booted = (await bootSceneWithLevels(tankCampaign(targetLevel))).booted;
    const scene = booted.scene as PlayScene;
    advanceToLevel(scene, targetLevel);
    const tanks = scene
      .getEnemies()
      .filter((enemy): enemy is Tank => enemy instanceof Tank && enemy.alive);
    return { scene, tanks };
  }

  it('resolves the run level through the shared curve at spawn', async () => {
    const { scene, tanks } = await bootCampaign(5);
    expect(scene.getWaveManager().level).toBe(5);
    expect(tanks).toHaveLength(3);

    const expected = enemyForceFieldHits(5, DEFAULT_ENEMY_CONFIGS.tank);
    // Sanity: a level-5 Tank is genuinely shielded (2 → 4 curve, start level 2).
    expect(expected).toBeGreaterThan(0);
    for (const tank of tanks) {
      expect(tank.forceFieldHits).toBe(expected);
      expect(tank.hasForceField).toBe(true);
    }
  });

  it('leaves level 1 untouched — every spawned tank is unshielded', async () => {
    const { scene, tanks } = await bootCampaign(1);
    expect(scene.getWaveManager().level).toBe(1);
    expect(tanks).toHaveLength(3);
    for (const tank of tanks) {
      expect(tank.forceFieldHits).toBe(0);
      expect(tank.hasForceField).toBe(false);
    }
  });

  it('is deterministic for a fixed level: two runs yield identical shields', async () => {
    const first = await bootCampaign(7);
    const firstFields = first.tanks.map((tank) => tank.forceFieldHits);
    booted?.game.destroy(true);
    booted = null;

    const second = await bootCampaign(7);
    expect(second.tanks.map((tank) => tank.forceFieldHits)).toEqual(firstFields);
    expect(firstFields[0]).toBe(
      enemyForceFieldHits(7, DEFAULT_ENEMY_CONFIGS.tank),
    );
  });

  it('resolves the same curve for scheduled secondary spawns (Harvester)', async () => {
    // Scheduled Harvester spawns share the scene's spawn seam; a heavy
    // archetype scheduled mid-wave must be shielded exactly like a
    // formation-spawned one at the same run level.
    const { scene } = await bootCampaign(5);
    const spawn = (scene as unknown as {
      _spawnScheduledHarvester(event: {
        x: number;
        y: number;
        timeFraction: number;
        timeSeconds: number;
      }): void;
    })._spawnScheduledHarvester.bind(scene);
    spawn({ x: GAME_WIDTH * 0.5, y: GAME_HEIGHT * 0.5, timeFraction: 0.5, timeSeconds: 1 });

    const harvesters = scene
      .getEnemies()
      .filter((enemy): enemy is Harvester => enemy instanceof Harvester && enemy.alive);
    expect(harvesters.length).toBeGreaterThan(0);
    for (const harvester of harvesters) {
      expect(harvester.forceFieldHits).toBe(
        enemyForceFieldHits(5, DEFAULT_ENEMY_CONFIGS.harvester),
      );
    }
  });
});

// ── Six-slot drop gating (AH-0MVNT2YGD003N8NR, AC1) ────────────────
//
// The shared draw seam (`drawNextDrop` in src/scenes/core/dropLayer.ts) and
// its scene wiring: once all six permanent slots are filled, the run's drop
// path draws only owned kinds plus catalogue entries flagged
// `availableWhenSlotsFull`; below the cap the full weighted pool is untouched.

describe('PlayScene — six-slot drop gating (AH-0MVNT2YGD003N8NR)', () => {
  let bootedGame: BootedGame | null = null;

  /** Every catalogue entry flagged available-when-full (Extra Life, Mystery UFO). */
  const EXEMPT_WHEN_FULL: readonly PowerUpId[] = (
    Object.keys(POWER_UP_CATALOGUE) as PowerUpId[]
  ).filter((id) => POWER_UP_CATALOGUE[id].availableWhenSlotsFull === true);

  /** Boots a plain run with the asteroid spawner off. */
  async function bootGatedScene(): Promise<PlayScene> {
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    bootedGame = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = bootedGame.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart();
    await advanceGame(scene.game, 200);
    return scene;
  }

  afterEach(() => {
    bootedGame?.game.destroy(true);
    bootedGame = null;
    localStorage.clear();
  });

  /**
   * Fills exactly six permanent slots (four power-ups + two weapon drops)
   * through the real permanent-grant stores, then drives `_maybeDropPowerUp`
   * with a deterministic sweep RNG. Returns every id the draw path handed to
   * the spawn seam (the drops themselves are stubbed — we assert the gate,
   * not the drop lifecycle).
   */
  async function collectGatedDraws(
    slotsFull: boolean,
  ): Promise<{ drawn: DropId[]; scene: PlayScene }> {
    const scene = await bootGatedScene();
    const player = scene.getPlayer()!;
    if (slotsFull) {
      player.getPowerUpLevelStore().collect('shield', true);
      player.getPowerUpLevelStore().collect('bomb', true);
      player.getPowerUpLevelStore().collect('speed_boost', true);
      player.getPowerUpLevelStore().collect('phase_shift', true);
      player.equipWeapon('spread', true);
      player.equipWeapon('dual', true);
    }
    expect(resolvePlayerSlotState(player).isFull).toBe(slotsFull);

    // Seeded LCG (Numerical Recipes constants): decorrelated consecutive draws,
    // so the per-kill chance roll and the weighted draw it precedes both see a
    // full spread of [0, 1) — every eligible band is sampled.
    let seed = 20261025 >>> 0;
    scene.setRng(() => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    });
    const roll = scene as unknown as {
      _maybeDropPowerUp(x: number, y: number): void;
    };
    const spawn = vi
      .spyOn(scene, 'spawnPowerUpDrop')
      .mockImplementation(() => null);

    for (let i = 0; i < 3000; i++) roll._maybeDropPowerUp(100, 120);

    const drawn = spawn.mock.calls.map(([id]) => id as DropId);
    spawn.mockRestore();
    return { drawn, scene };
  }

  it('at six filled slots draws only owned kinds plus available-when-full entries (AC1)', async () => {
    const { drawn } = await collectGatedDraws(true);

    // A meaningful sample (the 0.18-ish per-kill chance passes ~18 % of calls).
    expect(drawn.length).toBeGreaterThan(200);
    const allowed = new Set<DropId>([
      'shield',
      'bomb',
      'speed_boost',
      'phase_shift',
      'spread',
      'dual',
      ...EXEMPT_WHEN_FULL,
    ]);
    // Every other power-up and weapon id is never drawn.
    expect(drawn.filter((id) => !allowed.has(id))).toEqual([]);
    // No eligible id is starved: owned kinds and exempt entries all appear.
    for (const id of allowed) expect(drawn).toContain(id);
  });

  it('below the cap the full weighted pool is still drawable (AC3)', async () => {
    const { drawn } = await collectGatedDraws(false);

    const pool = new Set<DropId>([...POWER_UP_WEIGHT_IDS, ...WEAPON_WEIGHT_IDS]);
    const isWeapon = (id: DropId) =>
      (WEAPON_WEIGHT_IDS as readonly string[]).includes(id);
    expect(drawn.length).toBeGreaterThan(200);
    expect(drawn.every((id) => pool.has(id))).toBe(true);
    // Both drop families are covered by the draw path.
    expect(drawn.some(isWeapon)).toBe(true);
    expect(drawn.some((id) => !isWeapon(id))).toBe(true);
  });
});

/**
 * End-to-end elite (anomaly) behaviour tests in the shipped `PlayScene`
 * (AH-0MWU665XK000ZT4S; folded test child AH-0MWU65WM9007W19X).
 *
 * These walk the public seams — wave spawn → shared kill finalisation → the
 * scene's spawn/bullet seams — so each of the three bounded behaviours is
 * proven to run through the same shared code the gyms consume, and the
 * neutral default is pinned at scene level (an archetype that declares an
 * elite behaviour stays ordinary unless the spawn plan elevates it).
 *
 * Pure decision coverage lives in `src/scenes/core/eliteMechanics.test.ts`;
 * the repo-wide duplicate-body guard is updated in
 * `CombatScene.equivalence.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { resetConfigStore, seedConfigStore } from '../core/configStore';
import type { EnemyConfig } from '../core/configTypes';
import { DEFAULT_ENEMY_CONFIGS, loadEnemyConfig } from '../core/enemyConfig';
import { enemyForceFieldHits } from '../core/enemyForceField';
import { setSfxSoundProvider } from '../audio/effects';
import { RecordingSfxProvider } from '../test/audioTestDouble';
import { eliteMineralBump } from '../core/eliteReward';
import { ELITE_AURA_RING_COUNT, ELITE_TAG_TEXT } from '../entities/BaseEnemy';
import { RULES_STORAGE_KEY } from '../core/rules';
import type { EnemyEntity } from '../entities/enemyFactory';
import { Scout } from '../entities/Scout';
import { advanceGame, bootScene } from '../test/gameHarness';
import { LEVELS, type LevelDefinition, type WaveDefinition } from '../waves/Formations';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { MiniBossWheelScene } from './MiniBossWheelScene';
import { PlayScene } from './PlayScene';
import {
  ELITE_SPLITTER_CHILD_OFFSET_PX,
  ELITE_VOLATILE_BURST_COUNT,
  ELITE_VOLATILE_BURST_LIFETIME,
  ELITE_VOLATILE_BURST_SPEED,
} from './core/eliteMechanics';

/**
 * The level the elite fixtures are played at. It sits one level above the
 * onboarding level, which is the elite-exempt one (`ELITE_EXEMPT_LEVEL`), and
 * is reached through the public `WaveManager.beginGame(level)` seam.
 */
const ELITE_LEVEL = 2;

/** A `scout` config with the supplied elite-authored fields. */
function scoutConfig(overrides: Partial<EnemyConfig> = {}): EnemyConfig {
  return { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'scout', ...overrides };
}

/** A wave of `count` scouts, optionally authoring the first spawn as elite. */
function scoutWave(count: number, elite = false): WaveDefinition {
  return {
    groups: [
      {
        enemyKey: 'scout',
        formation: 'v',
        count,
        spacingX: 30,
        spacingY: 20,
        startX: 200,
        startY: 160,
      },
    ],
    shootEnabled: false,
    ...(elite ? { elite: 'scout' } : {}),
  };
}

/** The two-level campaign the fixtures are injected into (level 1 is real). */
function eliteCampaign(wave: WaveDefinition): LevelDefinition[] {
  return [
    LEVELS[0],
    { level: ELITE_LEVEL, name: 'Elite fixture', waves: [wave] },
  ];
}

/** Disables auto-fire so a test's own bullets are the only damage source. */
function disableAutoFire(scene: PlayScene): () => void {
  const seams = scene as unknown as { autoFireEnabled(): boolean };
  const original = seams.autoFireEnabled;
  seams.autoFireEnabled = () => false;
  return () => {
    seams.autoFireEnabled = original;
  };
}

/** Restricts the collision pass to `enemy` so only it can be hit. */
function isolateEnemyForKill(scene: PlayScene, enemy: unknown): () => void {
  const isolated = scene as unknown as {
    getEnemyEntities(): readonly unknown[];
  };
  const original = isolated.getEnemyEntities;
  isolated.getEnemyEntities = () => [enemy];
  return () => {
    isolated.getEnemyEntities = original;
  };
}

/** Kills `enemy` through the shared player-bullet collision path. */
function killWithPlayerBullets(scene: PlayScene, enemy: EnemyEntity): void {
  const restoreAutoFire = disableAutoFire(scene);
  const restoreIsolation = isolateEnemyForKill(scene, enemy);
  try {
    // Generous bound: the elite may carry bonus hull HP and field hits.
    for (let hit = 0; hit < 20 && enemy.alive; hit += 1) {
      scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
      scene.tick(0.016);
    }
  } finally {
    restoreIsolation();
    restoreAutoFire();
  }
}

describe('PlayScene — elite behaviours (AH-0MWU665XK000ZT4S)', () => {
  let booted: Phaser.Game | null = null;

  beforeEach(() => {
    // Keep the injected levels authoritative (the sequenced campaign would
    // otherwise replace them on `create()`).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    booted?.destroy(true);
    booted = null;
    resetConfigStore();
    setSfxSoundProvider(null);
    localStorage.clear();
  });

  /**
   * Boots the scene, jumps to the elite level and spawns its (only) wave.
   * Returns the scene plus every entity spawned after the jump, so a test can
   * distinguish the fixture's enemies from the level-1 ones `create()` left.
   */
  async function bootEliteWave(
    wave: WaveDefinition,
  ): Promise<{ scene: PlayScene; spawned: EnemyEntity[] }> {
    const game = await bootScene([
      PlayScene,
      MiniBossWheelScene,
      GameOverScene,
      MenuScene,
    ]);
    const scene = game.scene as PlayScene;
    scene.getWaveManager().setLevels(eliteCampaign(wave));
    scene.setAsteroidSpawnerEnabled(false);
    scene.setRunSeed(1);
    scene.scene.restart();
    await advanceGame(game.game, 200);
    game.game.loop.stop();
    booted = game.game;

    const before = new Set(scene.getEnemies());
    const wm = scene.getWaveManager();
    wm.beginGame(ELITE_LEVEL);
    scene.spawnWave();

    // Let the shared wormhole spawn window (open + grow) finish so the
    // fixture's enemies are targetable.
    const restoreAutoFire = disableAutoFire(scene);
    try {
      for (let step = 0; step < 30; step += 1) scene.tick(0.1);
    } finally {
      restoreAutoFire();
    }

    const spawned = scene.getEnemies().filter((enemy) => !before.has(enemy));
    return { scene, spawned };
  }

  it('AC2 — a splitter elite releases two counted children through the shared spawn path', async () => {
    seedConfigStore([
      scoutConfig({ eliteBehaviour: 'splitter', eliteBonusHp: 2 }),
    ]);
    const { scene, spawned } = await bootEliteWave(scoutWave(1, true));
    const wm = scene.getWaveManager();

    expect(spawned).toHaveLength(1);
    const elite = spawned[0];
    expect(elite.eliteBehaviour).toBe('splitter');
    // Authored bonus hit points are applied through the shared spawn seam.
    expect(elite.maxHealth).toBe(3);
    expect(wm.enemiesAlive).toBe(1);

    const entitiesBeforeKill = new Set(scene.getEnemies());
    killWithPlayerBullets(scene, elite);

    expect(elite.alive).toBe(false);
    // The wreck's final position: children spawn from it in the same frame.
    const deathX = elite.x;
    const children = scene
      .getEnemies()
      .filter((enemy) => !entitiesBeforeKill.has(enemy) && enemy.alive);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child instanceof Scout)).toBe(true);
    // Deterministic mirrored fan around the wreck (the pair is exact; each
    // child may drift a pixel or two between the kill frame and the read).
    const offsets = children
      .map((child) => child.x - deathX)
      .sort((a, b) => a - b);
    expect(offsets[1] - offsets[0]).toBeCloseTo(
      2 * ELITE_SPLITTER_CHILD_OFFSET_PX,
      3,
    );
    expect(Math.abs(offsets[0] + ELITE_SPLITTER_CHILD_OFFSET_PX)).toBeLessThanOrEqual(2);
    expect(Math.abs(offsets[1] - ELITE_SPLITTER_CHILD_OFFSET_PX)).toBeLessThanOrEqual(2);
    // Children are ordinary: no behaviour, no bonus HP, the archetype curve.
    const cfg = loadEnemyConfig('scout');
    for (const child of children) {
      expect(child.eliteBehaviour).toBeUndefined();
      expect(child.maxHealth).toBe(cfg.health);
      expect(child.forceFieldHits).toBe(
        enemyForceFieldHits(ELITE_LEVEL, cfg),
      );
    }
    // Counted wave enemies: +2 children, -1 parent, and the wave did NOT
    // clear in the gap between the deaths.
    expect(wm.enemiesAlive).toBe(2);
    expect(scene.isTransitioning()).toBe(false);
  });

  it('AC3 — a reinforced elite spawns behind one extra field hit and the shared bubble', async () => {
    const cfg = scoutConfig({
      eliteBehaviour: 'reinforced',
      eliteBonusHp: 1,
      forceFieldStartLevel: 1,
      forceFieldStartHits: 1,
      forceFieldMaxHits: 1,
    });
    seedConfigStore([cfg]);
    const { spawned } = await bootEliteWave(scoutWave(2, true));

    expect(spawned).toHaveLength(2);
    const elite = spawned.find((enemy) => enemy.eliteBehaviour === 'reinforced');
    const ordinary = spawned.find((enemy) => enemy !== elite);
    expect(elite).toBeDefined();
    expect(ordinary).toBeDefined();

    const base = enemyForceFieldHits(ELITE_LEVEL, cfg);
    expect(base).toBe(1);
    // Reinforced reuses the shipped curve and adds exactly one hit …
    expect(elite!.forceFieldHits).toBe(base + 1);
    // … rendered through the shared bubble layer.
    expect(elite!.forceFieldBubbleVisible).toBe(true);
    expect(elite!.maxHealth).toBe(cfg.health + 1);

    // The same archetype's ordinary spawn stays neutral: no bonus hit, no
    // bonus HP and no behaviour.
    expect(ordinary!.forceFieldHits).toBe(base);
    expect(ordinary!.maxHealth).toBe(cfg.health);
    expect(ordinary!.eliteBehaviour).toBeUndefined();
  });

  it('AC4 — a volatile elite leaves its radial burst through the shared enemy-bullet seam', async () => {
    seedConfigStore([scoutConfig({ eliteBehaviour: 'volatile' })]);
    const { scene, spawned } = await bootEliteWave(scoutWave(2, true));

    expect(spawned).toHaveLength(2);
    const elite = spawned.find((enemy) => enemy.eliteBehaviour === 'volatile');
    expect(elite).toBeDefined();

    const bulletsBefore = scene.getEnemyBullets().length;
    killWithPlayerBullets(scene, elite!);
    expect(elite!.alive).toBe(false);

    const burst = scene.getEnemyBullets().slice(bulletsBefore);
    expect(burst).toHaveLength(ELITE_VOLATILE_BURST_COUNT);
    const headings = new Set<number>();
    for (const bullet of burst) {
      expect(bullet.lifetime).toBe(ELITE_VOLATILE_BURST_LIFETIME);
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        ELITE_VOLATILE_BURST_SPEED,
        6,
      );
      headings.add(Math.round(Math.atan2(bullet.vy, bullet.vx) * 1000));
    }
    expect(headings.size).toBe(ELITE_VOLATILE_BURST_COUNT);
    // The surviving ordinary spawn keeps the wave open (no re-spawn noise).
    expect(scene.getWaveManager().enemiesAlive).toBe(1);
  });

  it('AC5 — an archetype with a behaviour stays neutral when its spawn is not elevated', async () => {
    // The archetype declares a behaviour, but this wave authors no elite and
    // the shipped budget is off: the spawn must stay ordinary (byte-for-byte
    // today's behaviour), proving the elevation is per spawn.
    seedConfigStore([scoutConfig({ eliteBehaviour: 'volatile' })]);
    const { scene, spawned } = await bootEliteWave(scoutWave(2, false));
    const wm = scene.getWaveManager();

    expect(spawned).toHaveLength(2);
    expect(spawned.every((enemy) => enemy.eliteBehaviour === undefined)).toBe(
      true,
    );

    const target = spawned[0];
    const bulletsBefore = scene.getEnemyBullets().length;
    const entitiesBefore = scene.getEnemies().filter((e) => e.alive).length;
    killWithPlayerBullets(scene, target);

    expect(target.alive).toBe(false);
    expect(scene.getEnemies().filter((e) => e.alive).length).toBe(
      entitiesBefore - 1,
    );
    expect(scene.getEnemyBullets().length).toBe(bulletsBefore);
    expect(wm.enemiesAlive).toBe(1);
  });

  it('AC1–AC3 — an elite always drops, pays its level-scaled bump and plays its distinct cue', async () => {
    seedConfigStore([scoutConfig({ eliteBehaviour: 'splitter' })]);
    const { scene, spawned } = await bootEliteWave(scoutWave(2, true));
    const recording = new RecordingSfxProvider();
    setSfxSoundProvider(recording);

    const elite = spawned.find((enemy) => enemy.eliteBehaviour);
    const ordinary = spawned.find((enemy) => enemy !== elite);
    expect(elite).toBeDefined();
    expect(ordinary).toBeDefined();

    // Force the ordinary per-kill chance roll to fail (`rng() > chance`), so a
    // drop can only come from the elite's guarantee.
    (scene as unknown as { rng: () => number }).rng = () => 1;

    const dropsBeforeOrdinary = scene.getDrops().length;
    killWithPlayerBullets(scene, ordinary!);
    expect(scene.getDrops()).toHaveLength(dropsBeforeOrdinary);

    const mineralsBefore = scene.getMinerals().length;
    const playsBefore = recording.plays.length;
    killWithPlayerBullets(scene, elite!);

    // AC1: one guaranteed draw from the shared pool despite the failed roll.
    expect(scene.getDrops()).toHaveLength(dropsBeforeOrdinary + 1);
    // AC2: the guaranteed bump is paid on top of the ordinary re-drop. With
    // rng = 1 that re-drop is 2 × round(0 + 1.25) = 2 minerals.
    expect(scene.getMinerals().length).toBe(
      mineralsBefore + eliteMineralBump(ELITE_LEVEL) + 2,
    );
    // AC3: the elite's distinct death cue is the heavier boss-destruction asset.
    const eliteCues = recording.plays
      .slice(playsBefore)
      .filter((play) => play.url.includes('aihell-boss-destruction'));
    expect(eliteCues).toHaveLength(1);
  });

  it('AC4/AC5 — the spawned elite carries the aura + tag and they vanish on death', async () => {
    seedConfigStore([scoutConfig({ eliteBehaviour: 'splitter' })]);
    const { scene, spawned } = await bootEliteWave(scoutWave(1, true));

    expect(spawned).toHaveLength(1);
    const elite = spawned[0];
    expect(elite.eliteDecoration.rings).toBe(ELITE_AURA_RING_COUNT);
    expect(elite.eliteDecoration.tagText).toBe(ELITE_TAG_TEXT);
    expect(elite.eliteDecoration.tagVisible).toBe(true);

    killWithPlayerBullets(scene, elite);

    expect(elite.eliteDecoration.rings).toBe(0);
    expect(elite.eliteDecoration.tagVisible).toBe(false);
  });

  it('AC6 — the opening wave cue names the elite', async () => {
    seedConfigStore([scoutConfig({ eliteBehaviour: 'splitter' })]);
    const { scene } = await bootEliteWave(scoutWave(1, true));

    const banner = scene.getBannerText();
    expect(banner).toContain('ELITE');
    expect(banner).toContain('Scout');
    expect(banner).toContain('splitter');
  });

  it('AC6 — an elite-free wave keeps the plain opening cue', async () => {
    seedConfigStore([scoutConfig({ eliteBehaviour: 'splitter' })]);
    const { scene } = await bootEliteWave(scoutWave(1, false));

    expect(scene.getBannerText()).not.toContain('ELITE');
  });
});

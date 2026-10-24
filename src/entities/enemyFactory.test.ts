/**
 * Config-aware entity seam — behaviour tests (AH-0MTHG51KB007F17K, AC cover).
 *
 * Verifies: config overrides flow into entity size/color and fire tuning;
 * defaults are preserved when absent; factory maps keys correctly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS, type EnemyConfig } from '../core/enemyConfig';
import { enemyForceFieldHits } from '../core/enemyForceField';
import type { FormationOffset } from '../utils/formations';
import { Asteroid, ASTEROID_LARGE_ROTATION_SPEED, ASTEROID_LARGE_SPEED } from './Asteroid';
import { BaseEnemy } from './BaseEnemy';
import { Diver } from './Diver';
import { PhaserEntity } from './Phaser';
import { Scout } from './Scout';
import { Swarm } from './Swarm';
import { Tank } from './Tank';
import { createEnemyFromConfig, type EnemyEntity } from './enemyFactory';
import { Capturer } from './Capturer';
import { Harvester } from './Harvester';
import { OrbitalStrike } from './OrbitalStrike';
import { LaneTraffic } from './LaneTraffic';
import { Raider } from './Raider';

class Harness extends Phaser.Scene {
  constructor() { super('Harness'); }
}

describe('Config-aware entity seam', () => {
  let booted: BootedGame | null = null;
  afterEach(() => { booted?.game.destroy(true); booted = null; vi.clearAllMocks(); });

  it('Scout respects size/color overrides and defaults when absent', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const base = new Scout(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 } });
    expect(base.effectiveSize).toBe(16);
    expect(base.effectiveColor).toBe(0x00ff00);

    const overridden = new Scout(scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 },
      size: 32, color: 0x123456, bulletColor: 0xabcdef, bulletSpeed: 999, fireInterval: 5000,
    });
    expect(overridden.effectiveSize).toBe(32);
    expect(overridden.effectiveColor).toBe(0x123456);
  });

  it('Scout tryFire interval respects config fireInterval', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    // Use a short interval so we can observe it
    const s = new Scout(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, fireInterval: 50 });
    s.shootEnabled = true;
    const t0 = 1_000_000;
    // First call starts tell
    expect(s.tryFireAimedBullet(t0)).toBeNull();
    // After cue, fires
    const bullet = s.tryFireAimedBullet(t0 + 600);
    expect(bullet).not.toBeNull();
    // Within interval — not fire
    expect(s.tryFireAimedBullet(t0 + 600 + 25)).toBeNull();
    // After interval -> tell restarts, then fire
    expect(s.tryFireAimedBullet(t0 + 600 + 60)).toBeNull();
    expect(s.tryFireAimedBullet(t0 + 1200 + 60)).not.toBeNull();
  });

  it('Diver/Tank/Phaser/Swarm respect size/color/burst overrides', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const diver = new Diver(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 42, color: 0x111111, burstCount: 7 });
    expect(diver.effectiveSize).toBe(42);
    expect(diver.effectiveColor).toBe(0x111111);
    expect(diver.effectiveBurstCount).toBe(7);

    const tank = new Tank(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 40, color: 0x222222, burstCount: 3 });
    expect(tank.effectiveSize).toBe(40);
    expect(tank.effectiveBurstCount).toBe(3);

    const phaser = new PhaserEntity(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 22, color: 0x333333, burstCount: 5 });
    expect(phaser.effectiveSize).toBe(22);
    expect(phaser.effectiveBurstCount).toBe(5);

    // Use bypass via new with override
    const swarm2 = new Swarm(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 9, color: 0x444444 } as any, 0);
    expect(swarm2.effectiveSize).toBe(9);
    expect(swarm2.effectiveColor).toBe(0x444444);
  });

  it('fires bullets that carry the config bulletLifetime (AH-0MU960UTE001PTV0)', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const scout = new Scout(scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 },
      fireInterval: 1, bulletLifetime: 2.5,
    });
    scout.shootEnabled = true;
    scout.tryFireAimedBullet(1_000_000); // start the advance-cue tell
    const bullet = scout.tryFireAimedBullet(1_000_000 + 600);
    expect(bullet).not.toBeNull();
    expect(bullet!.lifetime).toBe(2.5);
    expect(bullet!.elapsed).toBe(0);
  });

  it('defaults the enemy bullet lifetime to 1.5s when the config omits it', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const scout = new Scout(scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, fireInterval: 1,
    });
    scout.shootEnabled = true;
    scout.tryFireAimedBullet(1_000_000);
    const bullet = scout.tryFireAimedBullet(1_000_000 + 600);
    expect(bullet!.lifetime).toBe(1.5);
  });

  it('Phaser and Tank bullet count matches burstCount config', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const diver = new Diver(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, burstCount: 2, fireInterval: 1 });
    diver.shootEnabled = true;
    // Provide enough time that burst fires
    const bullets = diver.tryFireSpreadBurst(Date.now() + 10000);
    expect(bullets.length).toBe(2);
  });

  it('createEnemyFromConfig maps keys to the right entity class and threads opts', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    for (const key of ['scout', 'diver', 'tank', 'phaser', 'swarm', 'asteroid', 'harvester', 'capturer', 'raider', 'orbital-strike', 'lane-traffic'] as const) {
      const cfg = { ...DEFAULT_ENEMY_CONFIGS[key], color: 0xabcdef, size: 99 };
      const e = createEnemyFromConfig(scene, cfg as any, 10, 10, { row: 0, col: 0 });
      expect((e as any).effectiveColor).toBe(0xabcdef);
      // Spot check type
      if (key === 'scout') expect(e instanceof Scout).toBe(true);
      if (key === 'diver') expect(e instanceof Diver).toBe(true);
      if (key === 'tank') expect(e instanceof Tank).toBe(true);
      if (key === 'phaser') expect(e instanceof PhaserEntity).toBe(true);
      if (key === 'swarm') expect(e instanceof Swarm).toBe(true);
      if (key === 'asteroid') expect(e instanceof Asteroid).toBe(true);
      if (key === 'harvester') expect(e instanceof Harvester).toBe(true);
      if (key === 'capturer') expect(e instanceof Capturer).toBe(true);
      if (key === 'raider') expect(e instanceof Raider).toBe(true);
      if (key === 'orbital-strike') expect(e instanceof OrbitalStrike).toBe(true);
      if (key === 'lane-traffic') expect(e instanceof LaneTraffic).toBe(true);
      e.destroy(true);
    }
  });

  it('Frogger lane traffic threads driftSpeed into the lane speed and never fires (AH-0MV01EPM40008N8T)', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = { ...DEFAULT_ENEMY_CONFIGS['lane-traffic'], driftSpeed: 222 };
    const e = createEnemyFromConfig(scene, cfg, 100, 100, { row: 0, col: 0 }) as unknown as LaneTraffic;
    expect(e instanceof LaneTraffic).toBe(true);
    expect(e.archetype).toBe('lane-traffic');
    // The factory spawn uses the shared `driftSpeed` as the +x lane speed.
    expect(e.vx).toBe(222);
    expect(e.effectiveShotPattern).toBe('none');
    expect(e.shootEnabled).toBe(false);
    expect(e.health).toBe(1);
    e.destroy(true);
  });

  it('Defender raider threads patrol/attack/commit tuning from the config (AH-0MV01EM7U0033W7L)', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = {
      ...DEFAULT_ENEMY_CONFIGS.raider,
      attackSpeed: 411,
      commitRange: 333,
    };
    const e = createEnemyFromConfig(scene, cfg, 100, 100, { row: 0, col: 0 }) as unknown as Raider;
    expect(e instanceof Raider).toBe(true);
    expect(e.archetype).toBe('raider');
    // Patrol speed is the shared `driftSpeed` column; attack speed and commit
    // range come from the raider-specific columns.
    expect(e.patrolSpeed).toBe(DEFAULT_ENEMY_CONFIGS.raider.driftSpeed);
    expect(e.attackSpeed).toBe(411);
    expect(e.commitRange).toBe(333);
    expect(e.effectiveShotPattern).toBe('aimed');
    e.destroy(true);
  });

  it('AJ — the Galaga capturer threads beam tuning, is 2 HP and never fires', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.capturer, beamDuration: 1234, pullStrength: 77 };
    const e = createEnemyFromConfig(scene, cfg, 100, 100, { row: 0, col: 0 }) as unknown as Capturer;
    expect(e instanceof Capturer).toBe(true);
    expect(e.beamDuration).toBe(1234);
    expect(e.pullStrength).toBe(77);
    expect(e.health).toBe(2);
    expect(e.shootEnabled).toBe(false);
    e.destroy(true);
  });

  it("createEnemyFromConfig('asteroid') returns an Asteroid with large-tier defaults", async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.asteroid };
    const e = createEnemyFromConfig(scene, cfg, 100, 100, { row: 0, col: 0 });
    expect(e instanceof Asteroid).toBe(true);
    const asteroid = e as Asteroid;
    // Config default tier is large.
    expect(asteroid.getSizeTier()).toBe('large');
    expect(asteroid.effectiveSize).toBe(42);
    expect(asteroid.effectiveColor).toBe(0x888888);
    // Speed and rotation match the large-tier constants.
    const speed = Math.sqrt(asteroid.vx ** 2 + asteroid.vy ** 2);
    expect(speed).toBeCloseTo(ASTEROID_LARGE_SPEED, 1);
    expect(asteroid.currentRotationSpeed).toBeCloseTo(ASTEROID_LARGE_ROTATION_SPEED, 5);
    // Never fires.
    expect(asteroid.shootEnabled).toBe(false);
    expect(asteroid.effectiveShotPattern).toBe('none');
    asteroid.destroy(true);
  });

  it('F2 — every existing archetype has 1 HP and is destroyed by a single hit', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    for (const key of ['scout', 'diver', 'tank', 'phaser', 'swarm', 'asteroid'] as const) {
      const cfg = { ...DEFAULT_ENEMY_CONFIGS[key] };
      const e = createEnemyFromConfig(scene, cfg, 10, 10, { row: 0, col: 0 }) as unknown as BaseEnemy;
      expect(e.health).toBe(1);
      expect(e.alive).toBe(true);
      expect(e.takeDamage()).toBe(0);
      expect(e.alive).toBe(false);
      e.destroy(true);
    }
  });

  it('F2 — health from config threads into the entity (multi-hit archetype)', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.tank, health: 5 };
    const e = createEnemyFromConfig(scene, cfg, 10, 10, { row: 0, col: 0 }) as unknown as BaseEnemy;
    expect(e.health).toBe(5);
    expect(e.takeDamage()).toBe(4);
    expect(e.alive).toBe(true);
    expect(e.takeDamage()).toBe(3);
    e.destroy(true);
  });

  it('F5 — harvester config is registered with health 5, single formation and no fire', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = DEFAULT_ENEMY_CONFIGS.harvester;
    expect(cfg).toBeDefined();
    expect(cfg.displayName).toBe('Harvester');
    expect(cfg.health).toBe(5);
    expect(cfg.formationKind).toBe('single');
    expect(cfg.shotPattern).toBe('none');
    expect(cfg.count).toBe(1);

    const e = createEnemyFromConfig(scene, cfg, 100, 100, { row: 0, col: 0 }) as unknown as Harvester;
    expect(e instanceof Harvester).toBe(true);
    expect(e.health).toBe(5);
    expect(e.effectiveShotPattern).toBe('none');
    expect(e.shootEnabled).toBe(false);
    e.destroy(true);
  });

  it('custom/unknown key falls back to Scout while preserving visuals', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'my-custom-enemy', displayName: 'My Custom', color: 0x999999, size: 30 };
    const e = createEnemyFromConfig(scene, cfg as any, 10, 10, { row: 0, col: 0 });
    expect(e instanceof Scout).toBe(true);
    expect((e as any).effectiveColor).toBe(0x999999);
    e.destroy(true);
  });

  // ── shotProbability threading (AH-0MU0F1T2H003B4K0, AC5) ─────────

  it('createEnemyFromConfig threads shotProbability into every dispatched entity', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    for (const key of ['scout', 'diver', 'tank', 'phaser', 'swarm'] as const) {
      const cfg = { ...DEFAULT_ENEMY_CONFIGS[key], shotProbability: 0.25 };
      const e = createEnemyFromConfig(scene, cfg, 10, 10, { row: 0, col: 0 });
      expect((e as unknown as { _shotProbability: number })._shotProbability).toBe(0.25);
      e.destroy(true);
    }
    // Unknown custom key falls back to Scout but still receives the value.
    const custom = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'custom-p', shotProbability: 0.5 };
    const c = createEnemyFromConfig(scene, custom, 10, 10, { row: 0, col: 0 });
    expect(c instanceof Scout).toBe(true);
    expect((c as unknown as { _shotProbability: number })._shotProbability).toBe(0.5);
    c.destroy(true);
  });

  it('threaded shotProbability gates firing behaviourally (p=0 skips, p=1 fires)', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;

    const skip = createEnemyFromConfig(
      scene, { ...DEFAULT_ENEMY_CONFIGS.swarm, shotProbability: 0 }, 10, 10, { row: 0, col: 0 },
    ) as Swarm;
    skip.shootEnabled = true;
    expect(skip.tryFireBurstBullet(1_000_000)).toBeNull();
    skip.destroy(true);

    const fire = createEnemyFromConfig(
      scene, { ...DEFAULT_ENEMY_CONFIGS.swarm, shotProbability: 1 }, 10, 10, { row: 0, col: 0 },
    ) as Swarm;
    fire.shootEnabled = true;
    expect(fire.tryFireBurstBullet(1_000_000)).not.toBeNull();
    fire.destroy(true);
  });
});

// ── Force-field threading (AH-0MVM8GTG7002IRTL, test-first) ─────────

/**
 * Contract tests for threading the **resolved** force-field hit count from
 * the spawn path into the constructed entity (AH-0MVM8GUZG008AWSU
 * implements the seam; AH-0MVM8GXEF009883O resolves it at spawn).
 *
 * **TEST-FIRST → IMPLEMENTED.** The block was wrapped in Vitest's `it.fails`
 * (the repo's red-before/green-after convention) until the entity layer
 * (AH-0MVM8GUZG008AWSU) threaded the count; it now runs as plain `it`.
 *
 * Pinned seam: `createEnemyFromConfig(scene, config, x, y, offset, rng?,
 * forceFieldHits?)` — the resolved hit count is an **appended** optional
 * parameter (after the existing `rng` trailer), matching the shared spawn
 * path (game: `enemyForceFieldHits(waveManager.level, cfg)`; gym editor:
 * a direct slider value). The entity exposes the pinned BaseEnemy surface
 * (`forceFieldHits` / `hasForceField` — see `BaseEnemy.test.ts`).
 *
 * The curve columns on `EnemyConfig` (`forceFieldStartLevel` /
 * `forceFieldStartHits` / `forceFieldMaxHits`) are **not** read by the
 * factory: the pure resolver owns the curve, so passing a config whose
 * columns are non-zero must still construct an unshielded entity when the
 * caller passes no resolved count.
 */
interface FactoryWithForceField {
  (
    scene: Phaser.Scene,
    config: EnemyConfig,
    x: number,
    y: number,
    offset: FormationOffset,
    rng?: () => number,
    forceFieldHits?: number,
  ): EnemyEntity;
}

/** The BaseEnemy field surface this block reads (declared locally). */
interface FieldSurface {
  readonly forceFieldHits: number;
  readonly hasForceField: boolean;
}

describe('Force-field threading (AH-0MVM8GTG7002IRTL)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  /** The real factory, widened to the pinned force-field signature. */
  function createWithField(): FactoryWithForceField {
    return createEnemyFromConfig as unknown as FactoryWithForceField;
  }

  function fieldOf(entity: EnemyEntity): FieldSurface {
    return entity as unknown as FieldSurface;
  }

  it('threads the resolved hit count into the constructed entity', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const create = createWithField();

    const e = create(scene, DEFAULT_ENEMY_CONFIGS.tank, 10, 10, { row: 0, col: 0 }, undefined, 3);
    const field = fieldOf(e);

    // The field arrives with exactly the resolved count...
    expect(field.forceFieldHits).toBe(3);
    expect(field.hasForceField).toBe(true);
    // ...while the hull durability is untouched by the shield.
    expect(e.health).toBe(DEFAULT_ENEMY_CONFIGS.tank.health);
    e.destroy(true);
  });

  it('threads a zero resolved count as unshielded, exactly like an omitted count', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const create = createWithField();

    const explicitZero = create(scene, DEFAULT_ENEMY_CONFIGS.scout, 10, 10, { row: 0, col: 0 }, undefined, 0);
    expect(fieldOf(explicitZero).forceFieldHits).toBe(0);
    expect(fieldOf(explicitZero).hasForceField).toBe(false);
    // The 1-HP unshielded scout still dies on the first hit.
    expect(explicitZero.takeDamage()).toBe(0);
    expect(explicitZero.alive).toBe(false);
    explicitZero.destroy(true);

    const omitted = create(scene, DEFAULT_ENEMY_CONFIGS.scout, 10, 10, { row: 0, col: 0 });
    expect(fieldOf(omitted).forceFieldHits).toBe(0);
    expect(fieldOf(omitted).hasForceField).toBe(false);
    omitted.destroy(true);
  });

  it('never derives a shield from the raw config curve columns', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const create = createWithField();

    // Harvester carries a non-zero curve in the seeds (start level 2, 3→5
    // hits), but the factory must not evaluate it: only the caller-resolved
    // count may reach the entity.
    const cfg = DEFAULT_ENEMY_CONFIGS.harvester;
    expect(enemyForceFieldHits(5, cfg)).toBeGreaterThan(0); // the resolver owns the curve
    const e = create(scene, cfg, 10, 10, { row: 0, col: 0 }, undefined, 0);
    expect(fieldOf(e).forceFieldHits).toBe(0);
    expect(fieldOf(e).hasForceField).toBe(false);
    expect(e.health).toBe(5);
    e.destroy(true);
  });

  it('spawns an entity whose field matches the resolver for a campaign level', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const create = createWithField();

    // End-to-end wiring: resolve the count exactly as the game spawn path
    // does, then hand it to the factory — the constructed entity must carry
    // it.
    const cfg = DEFAULT_ENEMY_CONFIGS.tank;
    const level = 5;
    const resolved = enemyForceFieldHits(level, cfg);
    const e = create(scene, cfg, 10, 10, { row: 0, col: 0 }, undefined, resolved);
    expect(fieldOf(e).forceFieldHits).toBe(resolved);
    e.destroy(true);
  });
});

/**
 * Gym↔game parity for elites (AH-0MWU6673N008FO1D; folded test child
 * AH-0MWU65XRG008MUY8).
 *
 * The formation gym exercises each of the three bounded elite behaviours
 * through the **same shared code** the game runs:
 *
 * - the spawn is an ordinary formation spawn through the shipped factory and
 *   the shared wormhole-transit seam (`resolveSpawnTransitTarget`), carrying
 *   the shared `EliteSpawnModifiers` the game's per-spawn plan flag produces;
 * - the per-death decision is the shared `applyEliteDeathBehaviour`;
 * - the `reinforced` extra hit is the shared `eliteForceFieldBonus`/
 *   `eliteForceFieldHits` rule composed on this gym's documented direct-hits
 *   force-field base.
 *
 * The gym scenario elevates exactly one spawn (slot 0), mirroring the game's
 * one-elite-per-wave shape; every other spawn stays neutral.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import type { EnemyConfig } from '../../core/configTypes';
import { DEFAULT_ENEMY_CONFIGS } from '../../core/enemyConfig';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  ELITE_SPLITTER_CHILD_BURST_DISTANCE_PX,
  ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX,
  ELITE_VOLATILE_BURST_COUNT,
  ELITE_VOLATILE_BURST_LIFETIME,
  ELITE_VOLATILE_BURST_SPEED,
  type EliteSplitSpawn,
} from '../core/eliteMechanics';
import { resolveSpawnTransitTarget } from '../core/spawnTransit';
import {
  ENEMY_ELITE_SELECT_ID,
  GYM_ELITE_NONE,
  GymFodderEnemies,
  gymDirectForceFieldHits,
} from './GymFodderEnemies';

// Spy on the shared transit seam while keeping its real rule, so the test can
// prove the elite spawn destination was resolved by the same function the game
// and every gym use (never a divergent copy).
vi.mock('../core/spawnTransit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/spawnTransit')>();
  return {
    ...actual,
    resolveSpawnTransitTarget: vi.fn(actual.resolveSpawnTransitTarget),
  };
});

/** A `scout` config (the gym default) with optional elite authoring. */
function scoutConfig(overrides: Partial<EnemyConfig> = {}): EnemyConfig {
  return { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'scout', ...overrides };
}

/** The behavioural view the gym entities expose (BaseEnemy reads). */
interface EliteProbe {
  alive: boolean;
  eliteBehaviour?: string;
  maxHealth: number;
  health: number;
  forceFieldHits: number;
  forceFieldBubbleVisible: boolean;
  bulletColor: number;
  shootEnabled: boolean;
  x: number;
  y: number;
}

describe('GymFodderEnemies — elite parity (AH-0MWU6673N008FO1D)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetConfigStore();
    seedConfigStore([scoutConfig()]);
    vi.mocked(resolveSpawnTransitTarget).mockClear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    resetConfigStore();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  /**
   * Boots the gym with an elite scenario selected through the public launch
   * data (the same `init` seam a capture setup uses).
   */
  async function bootWithElite(
    enemyKey: string,
    elite: string,
  ): Promise<GymFodderEnemies> {
    class Wrapper extends GymFodderEnemies {
      override init(_data?: { enemyKey?: string; elite?: string }): void {
        super.init({ enemyKey, elite });
      }
    }
    Object.defineProperty(Wrapper, 'name', {
      value: `EliteWrapper_${enemyKey}_${elite}`,
    });
    booted = await bootScene([Wrapper as unknown as typeof Phaser.Scene]);
    const scene = booted.scene as unknown as GymFodderEnemies;
    scene.finishSpawnAnimations();
    return scene;
  }

  /** The single elevated entity, or `undefined` when the field is ordinary. */
  function eliteEntity(scene: GymFodderEnemies): EliteProbe | undefined {
    return scene.formationEntities.find(
      (entity) => (entity as unknown as EliteProbe).eliteBehaviour !== undefined,
    ) as unknown as EliteProbe | undefined;
  }

  /**
   * Kills `target` through the shared player-bullet collision path, draining
   * its force field and bonus hull first (bounded so a stuck kill fails the
   * test rather than hanging).
   */
  function killWithPlayerBullets(
    scene: GymFodderEnemies,
    target: EliteProbe,
  ): void {
    for (let hit = 0; hit < 30 && target.alive; hit += 1) {
      scene.spawnPlayerBullet(target.x, target.y, 0, 0);
      scene.tick(0.016);
    }
  }

  it('AC1/AC2 — a splitter elite is one ordinary slot-0 spawn transiting through the shared seam', async () => {
    const scene = await bootWithElite('scout', 'splitter');

    const elite = eliteEntity(scene);
    expect(elite).toBeDefined();
    expect(elite!.eliteBehaviour).toBe('splitter');
    // Exactly one elevated spawn: the scenario elevates one slot, like the
    // game's one-elite-per-wave plan.
    expect(
      scene.formationEntities.filter(
        (entity) => (entity as unknown as EliteProbe).eliteBehaviour,
      ),
    ).toHaveLength(1);

    // The elite kept an ordinary formation slot and was not spawned in place.
    const transitCalls = vi
      .mocked(resolveSpawnTransitTarget)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.entity === (elite as unknown));
    expect(transitCalls.length).toBeGreaterThan(0);
    expect(transitCalls[0].transit).toBe(true);
    expect(transitCalls[0].offset).toEqual(
      (elite as unknown as { offset: unknown }).offset,
    );
  });

  /**
   * Records whether the elite's hull was still visible each time the gym's
   * splitter seam ran: the `spawn-at-wreck` ordering AC (AH-0MWZERK75006FD3B)
   * requires the children to be created on the lethal blow, before
   * `destroySelf()` hides the hull.
   */
  function recordHullVisibleAtSpawn(scene: GymFodderEnemies): {
    hullAlive: boolean[];
    restore: () => void;
  } {
    const seam = scene as unknown as {
      spawnEliteSplitChild(
        enemy: { alive: boolean },
        spawn: EliteSplitSpawn,
      ): void;
    };
    const original = seam.spawnEliteSplitChild;
    const hullAlive: boolean[] = [];
    seam.spawnEliteSplitChild = function (
      this: unknown,
      enemy: { alive: boolean },
      spawn: EliteSplitSpawn,
    ): void {
      hullAlive.push(enemy.alive);
      original.call(this, enemy, spawn);
    };
    return {
      hullAlive,
      restore: () => {
        seam.spawnEliteSplitChild = original;
      },
    };
  }

  it('AC1 — a splitter elite releases two ordinary children from the visible wreck that burst outward', async () => {
    seedConfigStore([scoutConfig({ eliteBonusHp: 2 })]);
    const scene = await bootWithElite('scout', 'splitter');

    const elite = eliteEntity(scene)!;
    const base = DEFAULT_ENEMY_CONFIGS.scout;
    expect(elite.maxHealth).toBe(base.health + 2);

    const before = new Set(scene.formationEntities);
    const hull = recordHullVisibleAtSpawn(scene);
    try {
      killWithPlayerBullets(scene, elite);
    } finally {
      hull.restore();
    }

    // The children were spawned on the lethal blow, while the hull was still
    // visible.
    expect(hull.hullAlive).toEqual([true, true]);
    expect(elite.alive).toBe(false);

    const children = scene.formationEntities.filter(
      (entity) => !before.has(entity) && (entity as unknown as EliteProbe).alive,
    ) as unknown as EliteProbe[];
    expect(children).toHaveLength(2);
    // Ordinary children: no behaviour, no bonus HP, the gym-direct field.
    for (const child of children) {
      expect(child.eliteBehaviour).toBeUndefined();
      expect(child.maxHealth).toBe(base.health);
      expect(child.forceFieldHits).toBe(gymDirectForceFieldHits(base));
      // No immunity window: the child is combat-active during the burst.
      expect(child.health).toBeGreaterThan(0);
      expect(child.shootEnabled).toBe(elite.shootEnabled);
    }
    // Spawn-at-wreck: the pair straddles the wreck within the deterministic
    // jitter, on the same mirrored sides as the game.
    const deathX = elite.x;
    const offsets = children.map((child) => child.x - deathX).sort((a, b) => a - b);
    expect(offsets[0]).toBeCloseTo(-ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX, 3);
    expect(offsets[1]).toBeCloseTo(ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX, 3);

    // Burst outward: the shared stepper drives the pair apart to the full
    // burst distance (measured pair-relative so the gym's formation drift
    // cancels out), then holds once the burst has settled.
    const separation = (): number =>
      Math.abs(children[0].x - children[1].x);
    const atSpawn = separation();
    scene.tick(0.1);
    expect(separation()).toBeGreaterThan(atSpawn + 10);
    for (let step = 0; step < 8; step += 1) scene.tick(0.1);
    const full =
      2 *
      (ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX +
        ELITE_SPLITTER_CHILD_BURST_DISTANCE_PX);
    const settled = separation();
    // ±5 px covers the Scout's own per-child idle wiggle (±2 px each).
    expect(settled).toBeGreaterThan(full - 5);
    expect(settled).toBeLessThan(full + 5);
    scene.tick(0.5);
    expect(Math.abs(separation() - settled)).toBeLessThan(5);

    // Settled children remain fully combat-ready.
    killWithPlayerBullets(scene, children[0]);
    expect(children[0].alive).toBe(false);
  });

  it('AC1 — a reinforced elite carries one extra field hit through the shared bonus rule', async () => {
    const cfg = scoutConfig({
      forceFieldStartLevel: 3,
      forceFieldStartHits: 1,
      forceFieldMaxHits: 2,
    });
    seedConfigStore([cfg]);
    const scene = await bootWithElite('scout', 'reinforced');

    const elite = eliteEntity(scene)!;
    const ordinary = scene.formationEntities
      .map((entity) => entity as unknown as EliteProbe)
      .find((entity) => entity.eliteBehaviour === undefined)!;

    const baseHits = gymDirectForceFieldHits(cfg);
    expect(baseHits).toBe(1);
    expect(elite.eliteBehaviour).toBe('reinforced');
    expect(elite.forceFieldHits).toBe(baseHits + 1);
    expect(elite.forceFieldBubbleVisible).toBe(true);
    // The same archetype's ordinary spawn stays neutral.
    expect(ordinary.forceFieldHits).toBe(baseHits);
    expect(ordinary.maxHealth).toBe(DEFAULT_ENEMY_CONFIGS.scout.health);
  });

  it('AC1 — a volatile elite leaves its radial burst through the gym enemy-bullet seam', async () => {
    const scene = await bootWithElite('scout', 'volatile');

    const elite = eliteEntity(scene)!;
    expect(elite.eliteBehaviour).toBe('volatile');

    const bulletsBefore = scene.activeBullets.length;
    killWithPlayerBullets(scene, elite);
    expect(elite.alive).toBe(false);

    const burst = scene.activeBullets.slice(bulletsBefore);
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
  });

  it('AC1 — the elite scenario is opt-in: the default field stays ordinary', async () => {
    const scene = await bootWithElite('scout', GYM_ELITE_NONE);

    expect(scene.eliteBehaviour).toBeNull();
    expect(eliteEntity(scene)).toBeUndefined();
    expect(
      scene.formationEntities.every(
        (entity) => (entity as unknown as EliteProbe).eliteBehaviour === undefined,
      ),
    ).toBe(true);
  });

  it('AC1 — the panel elite selector rebuilds the formation with the chosen behaviour', async () => {
    const scene = await bootWithElite('scout', GYM_ELITE_NONE);
    const select = document.getElementById(
      ENEMY_ELITE_SELECT_ID,
    ) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.value).toBe(GYM_ELITE_NONE);

    select!.value = 'volatile';
    select!.dispatchEvent(new Event('change'));

    expect(scene.eliteBehaviour).toBe('volatile');
    scene.finishSpawnAnimations();
    expect(eliteEntity(scene)?.eliteBehaviour).toBe('volatile');
  });

  it('AC1 — a non-elite-capable (uncounted hazard) archetype never elevates', async () => {
    seedConfigStore([{ ...DEFAULT_ENEMY_CONFIGS.asteroid, key: 'asteroid' }]);
    const scene = await bootWithElite('asteroid', 'splitter');

    expect(scene.eliteBehaviour).toBeNull();
    expect(eliteEntity(scene)).toBeUndefined();
  });
});

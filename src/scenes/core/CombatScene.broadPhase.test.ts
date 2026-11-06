/**
 * Equivalence and cost tests for the shared collision broad phase
 * (AH-0MVXV0EMF001WVQ1, parent AH-0MVWJQUN6009IS87).
 *
 * The change being pinned is a *pure* candidate filter: the bullet-vs-bullet
 * pass no longer compares every player bullet with every enemy bullet, it
 * compares each enemy bullet with the bullets in neighbouring grid cells. Two
 * things must therefore hold, and this file asserts both:
 *
 * 1. **Identical outcomes (AC2/AC4).** The same fixture, run through the same
 *    resolution code with a real grid and with a degenerate single-cell grid
 *    (which is exactly the nested loop the broad phase replaced), must produce
 *    the identical result — including first-hit selection, destruction order,
 *    hook order, AOE detonation, splitting projectiles and Force Field
 *    reflections.
 * 2. **Collapsed cost (AC3).** At high bullet density the pass must hand a
 *    large majority of the `n × m` pairs straight to the bin without testing
 *    them.
 *
 * Equivalence is proved by *degenerating the grid*, not by re-implementing the
 * old pass: only the cell size differs between the two runs, so the resolution
 * semantics under test are the shipped ones in both.
 *
 * Scene coverage is not re-asserted here: the repo-wide duplicate-body guard
 * in `CombatScene.equivalence.test.ts` already fails if any gym or
 * `PlayScene` defines its own `_handleCollisions`, which is what makes this
 * shared pass the one every scene runs (AC1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { PLAYER_BULLET_RADIUS } from '../../core/constants';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import { WEAPON_CATALOGUE } from '../../utils/weapons';
import {
  CombatScene,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatScene';

// The scene reads the active control scheme; seed it like the sibling suites.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
  BroadPhaseStubScene.cellSizeOverride = null;
});

/** Minimal enemy satisfying the shared entity contract. */
class StubEnemy extends Phaser.GameObjects.Container implements CombatEnemyEntity {
  alive = true;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly hitRadius = 10,
  ) {
    super(scene, x, y);
  }

  destroySelf(): void {
    this.alive = false;
  }

  getHitRadius(): number {
    return this.hitRadius;
  }
}

/** Minimal enemy bullet (cached-texture sprite + velocity wrapper). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Image;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    this.graphics = scene.add.image(x, y, '__DEFAULT');
  }
}

/**
 * Stub scene that records every collision hook in dispatch order and can
 * degenerate the broad phase for the equivalence comparison.
 */
class BroadPhaseStubScene extends CombatScene<StubEnemy, StubBullet> {
  /** `null` = the shipped cell size; a value degenerates the grid. */
  static cellSizeOverride: number | null = null;

  entities: StubEnemy[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();
  hooks: string[] = [];

  constructor() {
    super({ key: 'CombatBroadPhaseStub' });
  }

  protected override getPlayer(): Player | null {
    return this.playerRef;
  }

  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }

  protected override getEnemyEntities(): readonly StubEnemy[] {
    return this.entities;
  }

  protected override getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }

  protected override setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  protected override collisionBroadPhaseCellSize(): number {
    const override = BroadPhaseStubScene.cellSizeOverride;
    return override ?? super.collisionBroadPhaseCellSize();
  }

  protected override onBulletVsBulletImpact(
    enemyBullet: StubBullet,
    playerBullet: PlayerBullet,
  ): void {
    this.hooks.push(
      `impact:${enemyBullet.graphics.x},${enemyBullet.graphics.y}->${playerBullet.x},${playerBullet.y}`,
    );
  }

  protected override onPlayerHit(player: Player): void {
    this.hooks.push(`playerHit:${player.x},${player.y}`);
    super.onPlayerHit(player);
  }

  protected override onPlayerRamsEnemy(enemy: StubEnemy): void {
    this.hooks.push(`ram:${enemy.x},${enemy.y}`);
    super.onPlayerRamsEnemy(enemy);
  }

  protected override onEnemyDestroyed(enemy: StubEnemy): void {
    this.hooks.push(`enemyDestroyed:${enemy.x},${enemy.y}`);
  }

  // ── Test seams ───────────────────────────────────────────────────
  runCollisions(): void {
    this._handleCollisions();
  }

  runFlushSplits(): void {
    this.flushPendingSplitWarheads();
  }

  getPlayerBullets(): readonly PlayerBullet[] {
    return this.playerBullets;
  }

  addPlayer(x: number, y: number): Player {
    const player = new Player(this, { x, y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }

  addEnemy(x: number, y: number, hitRadius = 10): StubEnemy {
    const enemy = new StubEnemy(this, x, y, hitRadius);
    this.entities.push(enemy);
    return enemy;
  }

  addEnemyBullet(x: number, y: number): StubBullet {
    const bullet = new StubBullet(this, x, y);
    this.bullets.push(bullet);
    return bullet;
  }

  addPlayerBullet(x: number, y: number): PlayerBullet {
    return this.spawnPlayerBullet(x, y, 0, 0);
  }
}

/** Observable result of one collision pass — the whole comparison surface. */
interface Outcome {
  /** Surviving player bullets, in array order, as `x,y`. */
  playerBullets: string[];
  /** Surviving enemy bullets, in array order, as `x,y`. */
  enemyBullets: string[];
  /** Alive flags of the scene's enemies, in creation order. */
  enemiesAlive: boolean[];
  /** Every recorded hook, in dispatch order. */
  hooks: string[];
  playerHits: number;
  aoeEffects: number;
}

let booted: BootedGame | null = null;

/** Tears down the booted game (safe to call when nothing is booted). */
function destroyBooted(): void {
  booted?.game.destroy(true);
  booted = null;
}

afterEach(destroyBooted);

/**
 * Boots a fresh scene, applies `fixture`, runs one collision pass and returns
 * the outcome plus the broad-phase counters for that pass.
 */
async function runPass(
  fixture: (scene: BroadPhaseStubScene) => void,
): Promise<{ outcome: Outcome; stats: { candidateTests: number; naivePairTests: number } }> {
  booted = await bootScene([BroadPhaseStubScene]);
  const scene = booted.scene as BroadPhaseStubScene;
  fixture(scene);
  scene.runCollisions();
  scene.runFlushSplits();

  return {
    outcome: {
      playerBullets: scene
        .getPlayerBullets()
        .map((bullet) => `${bullet.x},${bullet.y}`),
      enemyBullets: scene.bullets.map(
        (bullet) => `${bullet.graphics.x},${bullet.graphics.y}`,
      ),
      enemiesAlive: scene.entities.map((enemy) => enemy.alive),
      hooks: [...scene.hooks],
      playerHits: (
        scene as unknown as { playerHitCount: number }
      ).playerHitCount,
      aoeEffects: (
        scene as unknown as { aoeEffects: Phaser.GameObjects.Graphics[] }
      ).aoeEffects.length,
    },
    stats: { ...scene.getCollisionBroadPhaseStats() },
  };
}

/** Runs `fixture` twice: shipped grid vs degenerate single-cell grid. */
async function expectEquivalent(
  fixture: (scene: BroadPhaseStubScene) => void,
): Promise<void> {
  const shipped = await runPass(fixture);
  destroyBooted();

  BroadPhaseStubScene.cellSizeOverride = Number.MAX_SAFE_INTEGER;
  const degenerate = await runPass(fixture);

  expect(degenerate.outcome).toEqual(shipped.outcome);
  // The degenerate grid *is* the nested loop: it must test every pair, which
  // proves the candidate counts are measured rather than assumed.
  expect(degenerate.stats.candidateTests).toBe(degenerate.stats.naivePairTests);
  expect(shipped.stats.naivePairTests).toBe(degenerate.stats.naivePairTests);
}

/** Deterministic fixture generator (AC4 — identical on every run). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('CombatScene — shared collision broad phase (AH-0MVXV0EMF001WVQ1)', () => {
  // ── AC2 — outcome equivalence ─────────────────────────────────────

  it('AC2 — destroys the same bullets in the same order when bullets are stacked', async () => {
    // Ordering trap: the first enemy bullet overlaps bullets 0 and 1 at the
    // same point, so a broad phase that returned candidates in hash order
    // would sometimes consume bullet 1 instead of bullet 0. The first-hit rule
    // is "lowest index", and the pass must preserve it.
    const fixture = (scene: BroadPhaseStubScene) => {
      scene.addPlayerBullet(100, 100);
      scene.addPlayerBullet(100, 100);
      scene.addPlayerBullet(400, 400);
      scene.addEnemyBullet(100, 100);
      scene.addEnemyBullet(400, 400);
      scene.addEnemyBullet(700, 600);
    };

    await expectEquivalent(fixture);

    destroyBooted();
    const { outcome } = await runPass(fixture);

    expect(outcome.playerBullets).toEqual(['100,100']);
    expect(outcome.enemyBullets).toEqual(['700,600']);
    expect(outcome.hooks).toEqual([
      'impact:100,100->100,100',
      'impact:400,400->400,400',
    ]);
  });

  it('AC2 — enemy-bullet-vs-player still lands exactly one hit', async () => {
    const fixture = (scene: BroadPhaseStubScene) => {
      scene.addPlayer(100, 100);
      scene.addEnemyBullet(100, 100);
      scene.addEnemyBullet(300, 300);
      scene.addPlayerBullet(600, 100);
    };

    await expectEquivalent(fixture);

    destroyBooted();
    const { outcome } = await runPass(fixture);

    expect(outcome.enemyBullets).toEqual(['300,300']);
    expect(outcome.playerHits).toBe(1);
    expect(outcome.hooks.filter((hook) => hook.startsWith('playerHit:'))).toHaveLength(1);
  });

  it('AC2 — body-vs-body ram resolution is unchanged', async () => {
    // Two enemies overlap the hull; the pass resolves the first one and stops.
    const fixture = (scene: BroadPhaseStubScene) => {
      scene.addPlayer(100, 100);
      scene.addEnemy(104, 100, 10);
      scene.addEnemy(96, 100, 10);
      scene.addEnemy(600, 600, 10);
    };

    await expectEquivalent(fixture);

    destroyBooted();
    const { outcome } = await runPass(fixture);

    expect(outcome.enemiesAlive).toEqual([false, true, true]);
    expect(outcome.playerHits).toBe(1);
    expect(outcome.hooks).toContain('ram:104,100');
  });

  it('AC2 — Force Field reflect intercepts the same bullets on the same path', async () => {
    const fixture = (scene: BroadPhaseStubScene) => {
      scene.effects.applyCollect('force_field');
      scene.effects.applyCollect('force_field');
      const player = scene.addPlayer(100, 100);
      // Inside the reflect bubble (SHIP_SIZE × 1.8 = 36 px + 5 px bullet).
      scene.addEnemyBullet(player.x + 20, player.y);
      scene.addEnemyBullet(player.x, player.y + 24);
      scene.addEnemyBullet(600, 600);
    };

    await expectEquivalent(fixture);

    destroyBooted();
    const { outcome } = await runPass(fixture);

    // Both intercepted bullets come back as player-owned fire; nothing hits.
    expect(outcome.playerBullets).toHaveLength(2);
    expect(outcome.enemyBullets).toEqual(['600,600']);
    expect(outcome.playerHits).toBe(0);
  });

  it('AC2 — an interposed AOE projectile detonates at the same point', async () => {
    const fixture = (scene: BroadPhaseStubScene) => {
      const aoe = scene.addPlayerBullet(200, 200);
      aoe.aoeWeapon = WEAPON_CATALOGUE.mortar;
      scene.addPlayerBullet(900, 700);
      scene.addEnemy(200, 200, 10);
      scene.addEnemy(215, 200, 10);
      scene.addEnemy(1200, 700, 10);
      scene.addEnemyBullet(200, 200);
    };

    await expectEquivalent(fixture);

    destroyBooted();
    const { outcome } = await runPass(fixture);

    // The interception consumed the projectile and its blast killed the two
    // enemies in range; the far enemy and the stray player bullet survive.
    expect(outcome.enemiesAlive).toEqual([false, false, true]);
    expect(outcome.playerBullets).toEqual(['900,700']);
    expect(outcome.aoeEffects).toBeGreaterThan(0);
  });

  it('AC2 — a splitting projectile bursts into the same warheads', async () => {
    const fixture = (scene: BroadPhaseStubScene) => {
      const cluster = scene.addPlayerBullet(300, 300);
      cluster.splitWeapon = WEAPON_CATALOGUE.cluster;
      scene.addEnemyBullet(300, 300);
    };

    await expectEquivalent(fixture);

    destroyBooted();
    const { outcome } = await runPass(fixture);

    // The parent shell is consumed by the interception and its warheads are
    // queued for the next player tick (they are flushed by the harness).
    expect(outcome.enemyBullets).toEqual([]);
    expect(outcome.playerBullets.length).toBeGreaterThan(1);
    expect(
      outcome.playerBullets.every((position) => position === '300,300'),
    ).toBe(true);
  });

  it('AC2/AC4 — a seeded dense field resolves identically and deterministically', async () => {
    // The seeded fixture is also the determinism guard (AC4): every run of
    // this test builds the identical field, and the two grids agree on it.
    const fixture = (scene: BroadPhaseStubScene) => {
      const random = seededRandom(0x5eed);
      for (let i = 0; i < 60; i += 1) {
        scene.addPlayerBullet(random() * 800, random() * 600);
      }
      for (let i = 0; i < 90; i += 1) {
        scene.addEnemyBullet(random() * 800, random() * 600);
      }
    };

    await expectEquivalent(fixture);

    // Re-run with the shipped grid only: the same seed must give the same
    // outcome twice in a row, with no dependence on hash layout.
    destroyBooted();
    BroadPhaseStubScene.cellSizeOverride = null;
    const first = await runPass(fixture);
    destroyBooted();
    const second = await runPass(fixture);

    expect(second.outcome).toEqual(first.outcome);
  });

  // ── AC3 — measured candidate-pair collapse ────────────────────────

  it('AC3 — at 300 × 300 bullets the broad phase tests at least 10× fewer pairs', async () => {
    const fixture = (scene: BroadPhaseStubScene) => {
      const random = seededRandom(0xb011e7);
      for (let i = 0; i < 300; i += 1) {
        scene.addPlayerBullet(random() * 1200, random() * 700);
      }
      for (let i = 0; i < 300; i += 1) {
        scene.addEnemyBullet(random() * 1200, random() * 700);
      }
    };

    const shipped = await runPass(fixture);
    destroyBooted();

    BroadPhaseStubScene.cellSizeOverride = Number.MAX_SAFE_INTEGER;
    const naive = await runPass(fixture);

    // The degenerate grid is the nested loop, so this is the *measured*
    // all-pairs count for the same fixture, not `300 × 300` asserted from a
    // formula.
    expect(naive.stats.candidateTests).toBe(300 * 300);
    expect(shipped.stats.naivePairTests).toBe(300 * 300);

    // Measured for this fixture: 699 candidate pairs against the 90 000 the
    // nested loop tests (a 128.8x reduction); the assertion keeps a 10x floor
    // so retuning the cell size cannot silently undo the win.
    expect(shipped.stats.candidateTests).toBeGreaterThan(0);
    expect(shipped.stats.candidateTests * 10).toBeLessThanOrEqual(
      shipped.stats.naivePairTests,
    );
  });

  it('AC3 — an empty player-bullet list costs nothing (the stress gym case)', async () => {
    // `GymPerformance` disables the player's auto-fire, so the bullet-vs-bullet
    // pass runs with no player bullets at all and must not build an index.
    booted = await bootScene([BroadPhaseStubScene]);
    const scene = booted.scene as BroadPhaseStubScene;
    for (let i = 0; i < 50; i += 1) scene.addEnemyBullet(i * 10, 300);

    scene.runCollisions();

    expect(scene.getCollisionBroadPhaseStats()).toEqual({
      candidateTests: 0,
      naivePairTests: 0,
    });
    expect(scene.bullets).toHaveLength(50);
  });

  it('AC3 — a sparse pass tests only the neighbouring bullets', async () => {
    // Two bullets far apart: the nested loop tests 2 pairs, the broad phase
    // tests at most the one candidate in the querying bullet's own cell.
    booted = await bootScene([BroadPhaseStubScene]);
    const scene = booted.scene as BroadPhaseStubScene;
    scene.addPlayerBullet(0, 0);
    scene.addPlayerBullet(1200, 700);
    scene.addEnemyBullet(5, 0);
    scene.addEnemyBullet(1195, 700);

    scene.runCollisions();

    const stats = scene.getCollisionBroadPhaseStats();
    expect(stats.naivePairTests).toBe(4);
    expect(stats.candidateTests).toBeLessThan(stats.naivePairTests);
    expect(scene.getPlayerBullets()).toHaveLength(0);
    expect(scene.bullets).toHaveLength(0);
  });

  // ── Narrow-phase radius sanity ────────────────────────────────────

  it('finds overlap at the exact narrow-phase radius boundary', async () => {
    // The broad phase must never drop a pair the scalar test accepts: a
    // bullet exactly `PLAYER_BULLET_RADIUS + enemyBulletRadius` away overlaps
    // (`<=`), and the query box must be wide enough to include it.
    booted = await bootScene([BroadPhaseStubScene]);
    const scene = booted.scene as BroadPhaseStubScene;
    const radius = (scene as unknown as { getEnemyBulletRadius(): number })
      .getEnemyBulletRadius();
    scene.addPlayerBullet(100, 100);
    scene.addEnemyBullet(100 + PLAYER_BULLET_RADIUS + radius, 100);

    scene.runCollisions();

    expect(scene.getPlayerBullets()).toHaveLength(0);
    expect(scene.bullets).toHaveLength(0);
  });
});

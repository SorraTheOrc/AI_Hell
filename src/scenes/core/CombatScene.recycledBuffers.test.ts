/**
 * Recycled survivor buffers in the shared collision pass
 * (AH-0MVXV0F0Y004NENT, parent AH-0MVWJQUN6009IS87).
 *
 * `_handleCollisions` used to build fresh `kept*` arrays (and a filtered copy
 * of the player-bullet list) on every frame, so an idle frame still produced
 * garbage. It now writes survivors into a recycled buffer and hands it to
 * `setEnemyBullets`, keeping the array the scene just released as the next
 * frame's buffer — a double buffer per list.
 *
 * Two properties must hold, and this file asserts both:
 *
 * 1. **Buffer reuse (AC3).** Across many frames the scene's live bullet-list
 *    identity is drawn from a small, fixed set of arrays — it is reused, not
 *    rebuilt.
 * 2. **Unchanged ordering (AC3/AC4).** Survivors keep their original relative
 *    order, so the resolution order (and therefore the gameplay outcome) is
 *    identical to the filtered copy the buffer replaces. Equivalence of the
 *    *outcome* against the nested-loop semantics is pinned separately in
 *    `CombatScene.broadPhase.test.ts`; here the subject is the buffer itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import {
  CombatScene,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatScene';

// The scene reads the active control scheme; seed it like the sibling suites.
seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });

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
  lifetime = 10;
  elapsed = 0;

  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    this.graphics = scene.add.image(x, y, '__DEFAULT');
  }
}

/**
 * Scene that owns plain arrays (so `setEnemyBullets` assigns, exactly like
 * every shipped scene) and exposes the pass plus its live lists.
 */
class RecycledBufferStubScene extends CombatScene<StubEnemy, StubBullet> {
  entities: StubEnemy[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();

  constructor() {
    super({ key: 'CombatRecycledBufferStub' });
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

  // ── Test seams ───────────────────────────────────────────────────
  runCollisions(): void {
    this._handleCollisions();
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

  addEnemyBullet(x: number, y: number): StubBullet {
    const bullet = new StubBullet(this, x, y);
    this.bullets.push(bullet);
    return bullet;
  }

  addPlayerBullet(x: number, y: number): PlayerBullet {
    return this.spawnPlayerBullet(x, y, 0, 0);
  }
}

let booted: BootedGame | null = null;

afterEach(() => {
  booted?.game.destroy(true);
  booted = null;
});

/** Boots the stub scene and returns it. */
async function bootStub(): Promise<RecycledBufferStubScene> {
  booted = await bootScene([RecycledBufferStubScene]);
  return booted.scene as RecycledBufferStubScene;
}

describe('shared collision pass — recycled survivor buffers', () => {
  it('reuses a fixed set of enemy-bullet arrays across many frames', async () => {
    const scene = await bootStub();
    // Far from every bullet, so nothing is consumed and no hook fires.
    scene.addPlayer(900, 500);
    for (let i = 0; i < 4; i += 1) scene.addEnemyBullet(100 + i * 40, 100);

    const identities = new Set<readonly StubBullet[]>();
    for (let frame = 0; frame < 12; frame += 1) {
      scene.runCollisions();
      identities.add(scene.bullets);
    }

    // Twelve frames, at most three buffers (pass 2 hands over, pass 3 hands
    // back): the live list is recycled rather than rebuilt every frame.
    expect(identities.size).toBeLessThanOrEqual(3);
    expect(identities.size).toBeGreaterThanOrEqual(2);
    expect(scene.bullets).toHaveLength(4);
  });

  it('reuses the player-bullet survivor buffer across frames', async () => {
    const scene = await bootStub();
    scene.addPlayer(900, 500);
    scene.addPlayerBullet(100, 100);
    scene.addPlayerBullet(140, 100);

    const identities = new Set<readonly PlayerBullet[]>();
    for (let frame = 0; frame < 6; frame += 1) {
      scene.runCollisions();
      identities.add(scene.getPlayerBullets());
    }

    expect(identities.size).toBeLessThanOrEqual(2);
    expect(scene.getPlayerBullets()).toHaveLength(2);
  });

  it('keeps enemy-bullet survivors in their original order', async () => {
    const scene = await bootStub();
    // The player sits on the third bullet only, so pass 3 must drop that one
    // and keep the rest in array order.
    const first = scene.addEnemyBullet(100, 100);
    const second = scene.addEnemyBullet(140, 100);
    const doomed = scene.addEnemyBullet(500, 300);
    const last = scene.addEnemyBullet(180, 100);
    scene.addPlayer(500, 300);

    scene.runCollisions();

    expect(scene.bullets).toEqual([first, second, last]);
    expect(scene.bullets).not.toContain(doomed);
  });

  it('keeps player-bullet survivors in their original order when one is spent', async () => {
    const scene = await bootStub();
    scene.addPlayer(900, 500);
    // A single enemy at the middle bullet's position: pass 1 consumes only
    // that bullet, and the survivors keep their order.
    scene.entities.push(new StubEnemy(scene, 140, 100, 10));
    const first = scene.addPlayerBullet(100, 100);
    const spent = scene.addPlayerBullet(140, 100);
    const last = scene.addPlayerBullet(180, 100);

    scene.runCollisions();

    expect(scene.getPlayerBullets()).toEqual([first, last]);
    expect(scene.getPlayerBullets()).not.toContain(spent);
  });

  it('does not leak stale survivors into a later, emptier frame', async () => {
    // A recycled buffer whose tail is not truncated would resurrect the
    // previous frame's bullets; the pass must publish exactly this frame's
    // survivors.
    const scene = await bootStub();
    scene.addPlayer(900, 500);
    scene.addEnemyBullet(100, 100);
    scene.addEnemyBullet(140, 100);
    scene.addEnemyBullet(180, 100);
    scene.runCollisions();
    expect(scene.bullets).toHaveLength(3);

    // One bullet remains this frame; the two recycled ones must not come back.
    const survivor = scene.bullets[1];
    scene.bullets.length = 1;
    scene.bullets[0] = survivor;

    scene.runCollisions();
    expect(scene.bullets).toEqual([survivor]);
  });
});

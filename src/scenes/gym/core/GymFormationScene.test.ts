import { afterEach, describe, expect, it, vi } from 'vitest';
import * as effectsModule from '../../../audio/effects';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../../../core/constants';
import {
  PLAYER_BULLET_RADIUS,
  PLAYER_BULLET_SPEED,
} from '../../../core/constants';
import { Player } from '../../../entities/Player';
import { BACK_TO_INDEX_LABEL } from '../../../utils/gymNavigation';
import { FormationOffset } from '../../../utils/formations';
import {
  EnemyFormationConfig,
  FormationSceneBullet,
  FormationSceneEntity,
  GymFormationScene,
} from './GymFormationScene';

/** Minimal entity the base class drives (mirrors the real enemy contract). */
class StubEnemy extends Phaser.GameObjects.Container implements FormationSceneEntity {
  alive = true;
  shootEnabled = false;
  readonly offset: FormationOffset;

  constructor(scene: Phaser.Scene, offset: FormationOffset) {
    super(scene, 0, 0);
    this.offset = offset;
  }

  destroySelf(): void {
    this.alive = false;
  }

  applyFormationPosition(
    baseX: number,
    baseY: number,
    _dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    this.setPosition(
      baseX + this.offset.col * spacingX,
      baseY + this.offset.row * spacingY,
    );
  }
}

/** A bullet the base class advances and removes off-screen. */
class StubBullet implements FormationSceneBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;

  constructor(scene: Phaser.Scene, vx = 0, vy = 0) {
    this.graphics = scene.add.graphics();
    this.vx = vx;
    this.vy = vy;
  }
}

/** Stub that implements the optional live-aim seam and records every push. */
class AimStubEnemy extends StubEnemy {
  aimCalls: Array<{ x: number; y: number }> = [];

  setAimTarget(x: number, y: number): void {
    this.aimCalls.push({ x, y });
  }
}

const FORMATION_COUNT = 6;
const SPACING_X = 26;
const SPACING_Y = 22;
const DRIFT_SPEED = 40;
const START_X = GAME_WIDTH * 0.25;
const START_Y = GAME_HEIGHT * 0.5;

/** Deterministic V-shaped offsets so geometry assertions stay predictable. */
function vOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  let remaining = count;
  let row = 0;
  while (remaining > 0) {
    const rowWidth = Math.min(remaining, row + 1);
    const startCol = -row;
    for (let col = 0; col < rowWidth; col++) {
      offsets.push({ row, col: startCol + col * 2 });
    }
    remaining -= rowWidth;
    row += 1;
  }
  return offsets;
}

/** Builds a config-less scene class (harness instantiates with `new`). */
function makeStubScene(
  collect: (enemy: StubEnemy, now: number) => StubBullet[] = () => [],
  player?: { x: number; y: number },
  collision?: { entityHitRadius?: number; bulletHitRadius?: number },
  entityType: typeof StubEnemy = StubEnemy,
): new () => GymFormationScene<StubEnemy, StubBullet> {
  const config: EnemyFormationConfig<StubEnemy, StubBullet> = {
    sceneKey: player ? 'StubFormationWithPlayer' : 'StubFormation',
    count: FORMATION_COUNT,
    spacingX: SPACING_X,
    spacingY: SPACING_Y,
    driftSpeed: DRIFT_SPEED,
    startX: START_X,
    startY: START_Y,
    statusLabel: 'stubs',
    hintText: 'stub gym — formation demo',
    player,
    entityHitRadius: collision?.entityHitRadius,
    bulletHitRadius: collision?.bulletHitRadius,
    buildOffsets: vOffsets,
    createEntity: (scene, x, y, offset) => {
      const enemy = new entityType(scene, offset);
      enemy.setPosition(x, y);
      return enemy;
    },
    collectBullets: collect,
  };
  return class StubFormationScene extends GymFormationScene<StubEnemy, StubBullet> {
    constructor() {
      super(config);
    }
  };
}

type BootedScene = GymFormationScene<StubEnemy, StubBullet>;

describe('GymFormationScene — shared gym formation-scene base class', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(
    collect: (enemy: StubEnemy, now: number) => StubBullet[] = () => [],
    player?: { x: number; y: number },
  ): Promise<BootedScene> {
    booted = await bootScene([makeStubScene(collect, player)]);
    return booted!.scene as BootedScene;
  }

  it('AC1 — spawns the configured formation count and adds every entity to the display list', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationEntities.length).toBe(FORMATION_COUNT);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);

    // Without add.existing the entities would never render (project
    // convention regression — see GymScout.ts).
    const allOnDisplayList = scene.formationEntities.every((e) =>
      scene.children.list.includes(e),
    );
    expect(allOnDisplayList).toBe(true);
  });

  it('AC1 — positions each entity from the formation base + its own offset', async () => {
    const scene = await bootGym();
    const offsets = vOffsets(FORMATION_COUNT);

    for (const [index, entity] of scene.formationEntities.entries()) {
      const { row, col } = offsets[index];
      expect(entity.x).toBeCloseTo(scene.formationX + col * SPACING_X, 5);
      expect(entity.y).toBeCloseTo(scene.formationY + row * SPACING_Y, 5);
    }
  });

  it('AC1 — shows the EXPLODE/SHOOT buttons, status line, hint, and shared ← INDEX button', async () => {
    const scene = await bootGym();

    const labels = scene.children.list
      .filter((c) => c instanceof Phaser.GameObjects.Text)
      .map((t) => (t as Phaser.GameObjects.Text).text);
    expect(labels).toContain('EXPLODE');
    expect(labels).toContain('SHOOT: OFF');
    expect(labels).toContain(`SCORE: n/a — stubs: ${FORMATION_COUNT}`);
    expect(labels).toContain('stub gym — formation demo');
    expect(labels).toContain(BACK_TO_INDEX_LABEL);
  });

  it('AC1 — formation advances at the configured drift speed', async () => {
    const scene = await bootGym();
    const baseBefore = scene.formationX;

    await new Promise((r) => setTimeout(r, 350));

    const baseAfter = scene.formationX;
    expect(baseAfter).toBeGreaterThan(baseBefore);
    expect(baseAfter - baseBefore).toBeGreaterThan(DRIFT_SPEED * 0.25);
  });

  it('AC1 — EXPLODE destroys one random alive entity; no-op once none remain', async () => {
    const scene = await bootGym();
    const explode = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === 'EXPLODE',
    );
    expect(explode).toBeDefined();

    explode!.emit('pointerdown');
    expect(scene.aliveCount).toBe(FORMATION_COUNT - 1);

    for (let remaining = FORMATION_COUNT - 1; remaining > 0; remaining--) {
      explode!.emit('pointerdown');
      expect(scene.aliveCount).toBe(remaining - 1);
    }
    expect(() => explode!.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('AC1 — SHOOT toggle propagates to every entity and updates the button label', async () => {
    const scene = await bootGym();
    const shoot = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === 'SHOOT: OFF',
    );
    expect(shoot).toBeDefined();

    shoot!.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationEntities.every((e) => e.shootEnabled)).toBe(true);
    expect(
      scene.children.list.some(
        (c): c is Phaser.GameObjects.Text =>
          c instanceof Phaser.GameObjects.Text && c.text === 'SHOOT: ON',
      ),
    ).toBe(true);

    shoot!.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationEntities.every((e) => !e.shootEnabled)).toBe(true);
  });

  it('AC3 — collects bullets from the fire callback and advances them each frame', async () => {
    const scene = await bootGym((enemy) => [
      new StubBullet(enemy.scene, 0, 60),
    ]);

    await new Promise((r) => setTimeout(r, 250));
    expect(scene.activeBullets.length).toBeGreaterThan(0);

    const first = scene.activeBullets[0];
    const xBefore = first.graphics.x;
    const yBefore = first.graphics.y;
    await new Promise((r) => setTimeout(r, 150));
    const moved = scene.activeBullets.find((b) => b.graphics === first.graphics);
    // The bullet the base class owns moves downward each frame (vy > 0).
    expect(moved).toBeDefined();
    expect(moved!.graphics.x).toBe(xBefore);
    expect(moved!.graphics.y).toBeGreaterThan(yBefore);
  });

  it('AC3 — removes bullets that leave the screen bounds', async () => {
    // Gate firing like the real enemies (interval-based): one fast bullet
    // per 500ms — far fewer than the base class can clean up per frame.
    let lastFire = 0;
    const scene = await bootGym((enemy, now) => {
      if (now - lastFire < 500) return [];
      lastFire = now;
      return [new StubBullet(enemy.scene, 0, 2000)]; // fast downward
    });

    await new Promise((r) => setTimeout(r, 300));
    // The fast bullet exits the screen well inside the wait window; the
    // base class must have removed it (not left it in flight forever).
    expect(scene.activeBullets.length).toBe(0);
  });
});

describe('GymFormationScene — player spawn (core scene AC1)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(
    collect: (enemy: StubEnemy, now: number) => StubBullet[] = () => [],
  ): Promise<BootedScene> {
    booted = await bootScene([makeStubScene(collect)]);
    return booted!.scene as BootedScene;
  }

  it('spawns the configured Player entity and adds it to the display list', async () => {
    booted = await bootScene([
      makeStubScene(() => [], { x: 200, y: 300 }),
    ]);
    const scene = booted!.scene as BootedScene;

    const player = scene.getPlayer();
    expect(player).toBeInstanceOf(Player);
    expect(player).not.toBeNull();
    // The player is part of the scene (display list) so it renders.
    expect(scene.children.list).toContain(player!);
    expect(player!.x).toBeCloseTo(200, 5);
    expect(player!.y).toBeCloseTo(300, 5);
  });

  it('spawns no player when the config omits `player` (backward compatible)', async () => {
    const scene = await bootGym();
    expect(scene.getPlayer()).toBeNull();
    // Existing formation behaviour is untouched.
    expect(scene.formationEntities.length).toBe(FORMATION_COUNT);
  });

  it('instantiates the player in create() while the formation is also present', async () => {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 480 }),
    ]);
    const scene = booted!.scene as BootedScene;
    expect(scene.getPlayer()).toBeInstanceOf(Player);
    // The formation is unaffected by the player's presence.
    expect(scene.formationEntities.length).toBe(FORMATION_COUNT);
  });
});

describe('GymFormationScene — player keyboard input (core scene AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWithPlayer(): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 270 }),
    ]);
    return booted!.scene as BootedScene;
  }

  it('binds the arrow keys (cursors) to the player', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    const yBefore = player.y;
    const xBefore = player.x;

    // Hold the up arrow key: the scene maps cursors → player thrust.
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);

    expect(player.y).toBeLessThan(yBefore); // moved up
    expect(player.x).toBe(xBefore);
    scene.getCursors()!.up.isDown = false;
  });

  it('binds the WASD keys to the player', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    const xBefore = player.x;
    const yBefore = player.y;

    // Hold the D key (WASD → right via keysToInput).
    scene.getWasd()!.D.isDown = true;
    scene.tick(0.25);

    expect(player.x).toBeGreaterThan(xBefore);
    expect(player.y).toBe(yBefore);
    scene.getWasd()!.D.isDown = false;
  });

  it('drives movement in the direction of travel while a key is held', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    const xBefore = player.x;

    scene.getCursors()!.right.isDown = true;
    for (let i = 0; i < 4; i++) scene.tick(0.25);
    expect(player.x - xBefore).toBeGreaterThan(40);
    scene.getCursors()!.right.isDown = false;
  });
});

describe('GymFormationScene — player auto-fire (core scene AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootWithPlayer(): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 270 }),
    ]);
    return booted!.scene as BootedScene;
  }

  it('auto-fires bullets in the direction of travel', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Move right to establish a heading, then keep firing while moving.
    scene.getCursors()!.right.isDown = true;
    scene.tick(0.5);

    const bullets = scene.getPlayerBullets();
    expect(bullets.length).toBeGreaterThan(0);
    // Fired in direction of travel (right → positive vx).
    expect(bullets.every((b) => b.vx > 0)).toBe(true);
    expect(bullets.every((b) => Math.abs(b.vy) < 1)).toBe(true);
    scene.getCursors()!.right.isDown = false;
  });

  it('fires in the direction of upward travel (vy < 0)', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    const before = scene.getPlayerBullets();
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.5);

    const after = scene.getPlayerBullets();
    const fresh = after.filter((b) => !before.includes(b));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((b) => b.vy < 0)).toBe(true);
    scene.getCursors()!.up.isDown = false;
  });

  it('respects the weapon fire rate (no new bullets before the cooldown elapses)', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    const before = scene.getPlayerBullets().length;
    scene.getCursors()!.right.isDown = true;
    scene.tick(0.05); // well under the cannon cooldown
    expect(scene.getPlayerBullets()).toHaveLength(before);

    scene.tick(0.4); // past the cooldown → fires
    expect(scene.getPlayerBullets().length).toBeGreaterThan(before);
    scene.getCursors()!.right.isDown = false;
  });

  it('uses the shared player-bullet contract (PlayerBullet graphics, PLAYER_BULLET_SPEED)', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.getCursors()!.right.isDown = true;
    scene.tick(0.5);

    const playerBullets = scene.getPlayerBullets();
    expect(playerBullets.length).toBeGreaterThan(0);
    for (const bullet of playerBullets) {
      expect(bullet.radius).toBe(PLAYER_BULLET_RADIUS);
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        PLAYER_BULLET_SPEED,
        5,
      );
      expect(scene.children.list).toContain(bullet);
    }
    scene.getCursors()!.right.isDown = false;
  });

  it('culls player bullets that leave the screen', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    scene.getCursors()!.right.isDown = true;
    scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);

    // 350 px/s × 4 s = 1,400 px → well past the right edge (960).
    scene.tick(4.0);
    expect(scene.getPlayerBullets()).toHaveLength(0);
    scene.getCursors()!.right.isDown = false;
  });
});

describe('GymFormationScene — collision detection and player hit/respawn (core scene AC1–AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Player spawn far from the formation so auto-fire bullets never
   *  interfere with collision assertions (bullets fly right/off-screen,
   *  away from the formation at x ≈ 240–360). */
  const PLAYER_SPAWN = { x: 920, y: 30 };

  /**
   * Boots a scene with a one-shot enemy-bullet "parking" collect: only
   * when `armed` is set does the collect emit a single stationary bullet
   * at `parkAt`. All tests below run entirely synchronously (no
   * real-time waits), so bullet placement is fully deterministic.
   */
  async function bootParked(
    collide?: { entityHitRadius?: number; bulletHitRadius?: number },
  ): Promise<{
    scene: BootedScene;
    parkAt: { x: number; y: number };
    armed: () => void;
    parked: () => StubBullet | null;
  }> {
    let armedFlag = false;
    let parkedBullet: StubBullet | null = null;
    const parkAt = { x: 0, y: 0 };

    const collect = (enemy: StubEnemy): StubBullet[] => {
      if (!armedFlag) return [];
      armedFlag = false; // one-shot
      const b = new StubBullet(enemy.scene, 0, 0);
      b.graphics.setPosition(parkAt.x, parkAt.y);
      parkedBullet = b;
      return [b];
    };

    booted = await bootScene([
      makeStubScene(collect, PLAYER_SPAWN, collide),
    ]);
    const scene = booted!.scene as BootedScene;
    return {
      scene,
      parkAt,
      armed: () => {
        armedFlag = true;
      },
      parked: () => parkedBullet,
    };
  }

  it('AC1 — a player bullet overlapping an enemy destroys it via destroySelf and is consumed', async () => {
    const { scene } = await bootParked();
    const target = scene.formationEntities[0];
    expect(target.alive).toBe(true);

    const pb = scene.spawnPlayerBullet(target.x, target.y, 0, 0);
    scene.tick(0.05); // formation drifts ~2 px — well inside hit radius

    // The enemy dies via the standard destroySelf/explosion path and the
    // bullet is consumed (not left in flight).
    expect(target.alive).toBe(false);
    expect(scene.aliveCount).toBe(FORMATION_COUNT - 1);
    expect(scene.getPlayerBullets()).not.toContain(pb);
  });

  it('AC1 — bullets that miss an enemy stay in flight (no false positives)', async () => {
    const { scene } = await bootParked();
    const target = scene.formationEntities[0];

    // Spawn a bullet with zero velocity, but offset it horizontally so it
    // never reaches the enemy (hit radius 20 + bullet radius 3 = 23 px).
    const pb = scene.spawnPlayerBullet(target.x - 60, target.y, 0, 0);
    for (let i = 0; i < 5; i++) scene.tick(0.05);

    expect(target.alive).toBe(true);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
    expect(scene.getPlayerBullets()).toContain(pb);
  });

  it('AC2 — a player bullet destroys an enemy bullet (both consumed)', async () => {
    const { scene, parkAt, armed, parked } = await bootParked();
    // Far from both the formation (x ≈ 240+) and the player (920, 30).
    parkAt.x = 120;
    parkAt.y = 100;

    const pb = scene.spawnPlayerBullet(parkAt.x, parkAt.y, 0, 0);
    armed();
    scene.tick(0.05);

    expect(parked()).not.toBeNull();
    expect(scene.activeBullets).not.toContain(parked());
    expect(scene.getPlayerBullets()).not.toContain(pb);
    // The player is nowhere near the exchange: no player hit.
    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
  });

  it('AC5 — hit test uses the summed radii boundary (rA + rB, inclusive <=)', async () => {
    const { scene } = await bootParked({ entityHitRadius: 10 });
    const target = scene.formationEntities[0];

    // 10 (entity) + 3 (PLAYER_BULLET_RADIUS) = 13 px. Ensure no formation
    // drift (>0.04 px at dt=0.001) flips the boundary case.
    // 10 (entity) + 3 (PLAYER_BULLET_RADIUS) = 13 px. The enemy drifts
    // 0.04 px right during dt=0.001, so a bullet exactly 13 px left sits
    // at 13.04 (a clean miss); 12.9 px lands at 12.94 — just inside.
    const outside = scene.spawnPlayerBullet(target.x - 13, target.y, 0, 0);
    scene.tick(0.001);
    expect(target.alive).toBe(true); // outside
    expect(scene.getPlayerBullets()).toContain(outside);

    const inside = scene.spawnPlayerBullet(target.x - 12.9, target.y, 0, 0);
    scene.tick(0.001);
    expect(target.alive).toBe(false); // inside (inclusive <= boundary)
    expect(scene.getPlayerBullets()).not.toContain(inside);
  });

  it('AC5 — hit test uses Euclidean distance (hypot), not rectilinear', async () => {
    const { scene } = await bootParked({ entityHitRadius: 10 });
    const target = scene.formationEntities[0];

    // (±9, ±9) → hypot ≈ 12.73 ≤ 13 → hits, while a rectilinear check
    // (|dx|+|dy| = 18) would wrongly report a miss.
    const diag = scene.spawnPlayerBullet(
      target.x - 9,
      target.y - 9,
      0,
      0,
    );
    scene.tick(0.001);
    expect(target.alive).toBe(false);
    expect(scene.getPlayerBullets()).not.toContain(diag);
  });

  it('AC5 — bullets just outside the summed radii do not hit', async () => {
    const { scene } = await bootParked({ entityHitRadius: 10 });
    const target = scene.formationEntities[0];

    // (±14, ±14) → hypot ≈ 19.8 > 13 → miss.
    const outside = scene.spawnPlayerBullet(
      target.x - 14,
      target.y - 14,
      0,
      0,
    );
    for (let i = 0; i < 5; i++) scene.tick(0.001);
    expect(target.alive).toBe(true);
    expect(scene.getPlayerBullets()).toContain(outside);
  });

  it('AC3 — an enemy bullet hitting the player triggers explosion VFX/SFX + respawn + invulnerability blink', async () => {
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const { scene, parkAt, armed } = await bootParked();
    const player = scene.getPlayer()!;

    // Move the ship away from spawn so respawn is observable.
    scene.getCursors()!.down.isDown = true;
    for (let i = 0; i < 4; i++) scene.tick(0.25);
    scene.getCursors()!.down.isDown = false;
    expect(player.y).toBeGreaterThan(PLAYER_SPAWN.y + 10);

    // Park an enemy bullet exactly on the ship.
    parkAt.x = player.x;
    parkAt.y = player.y;
    const callsBefore = vi.mocked(destroySound).mock.calls.length;
    armed();
    scene.tick(0.05);

    // Hit: VFX/SFX fired, hit counter incremented, respawned at spawn.
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.getPlayerExplosions().length).toBeGreaterThan(0);
    expect(vi.mocked(destroySound).mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
    expect(player.x).toBe(PLAYER_SPAWN.x);
    expect(player.y).toBe(PLAYER_SPAWN.y);
    expect(scene.isPlayerInvulnerable()).toBe(true);
    expect(scene.getPlayerInvulnerableRemaining()).toBeGreaterThan(0);

    // Blink: after 0.11s of invulnerability the alpha is < 1 (hidden
    // phase of the blink), then back to fully visible.
    scene.tick(0.11);
    expect(player.alpha).toBeLessThan(1);
    scene.tick(0.11);
    expect(player.alpha).toBe(1);
  });

  it('AC4 — invulnerability prevents a second hit, then expires; the player is never destroyed and the score never changes', async () => {
    const { scene, parkAt, armed } = await bootParked();
    const player = scene.getPlayer()!;

    const statusLabels = (): string[] =>
      scene.children.list
        .filter((c) => c instanceof Phaser.GameObjects.Text)
        .map((t) => (t as Phaser.GameObjects.Text).text);
    const labelsBefore = statusLabels();
    const enemiesBefore = scene.aliveCount;

    // First hit: parked bullet directly on the spawn position.
    parkAt.x = PLAYER_SPAWN.x;
    parkAt.y = PLAYER_SPAWN.y;
    armed();
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // Same-spot bullet while invulnerable: no second hit — the bullet is
    // left in flight, untouched.
    armed();
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // Wait out the invulnerability window (pure tick time). Once it
    // expires the parked bullet from above hits again — exactly one more
    // hit (the new invulnerability window re-engages and the consumed
    // bullet is gone, so no third hit).
    for (let i = 0; i < 20; i++) scene.tick(0.2); // 4s total
    expect(scene.getPlayerHitCount()).toBe(2);
    expect(scene.getPlayerInvulnerableRemaining()).toBe(0); // window expired again

    // Infinite respawns: the player object is never destroyed, the ship
    // returns to spawn, and the HUD/score line never changes.
    expect(scene.getPlayer()).not.toBeNull();
    expect(player.x).toBe(PLAYER_SPAWN.x);
    expect(player.y).toBe(PLAYER_SPAWN.y);
    expect(player.alpha).toBe(1);
    expect(statusLabels()).toEqual(labelsBefore);
    expect(scene.aliveCount).toBe(enemiesBefore);
  });
});

describe('GymFormationScene — enemy live aim tracking (parent AC1–AC3)', () => {
  let booted: BootedGame | null = null;

  // Upper-area spawn, far from the bottom-centre stand-in.
  const PLAYER_AIM_SPAWN = { x: 700, y: 120 };

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(
    player?: { x: number; y: number },
  ): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], player, undefined, AimStubEnemy),
    ]);
    return booted!.scene as BootedScene;
  }

  it('AC1 — pushes the LIVE player position to every entity each frame (not the bottom-centre stand-in)', async () => {
    const scene = await bootGym(PLAYER_AIM_SPAWN);
    const player = scene.getPlayer()!;
    const entities = scene.formationEntities as unknown as AimStubEnemy[];

    // Boot ticks may already have pushed the spawn position; reset the
    // ledger so only our deterministic ticks count.
    for (const e of entities) e.aimCalls = [];

    // Player rests at spawn: the aim pushed this frame is the player's
    // live position (top-right), never the bottom-centre stand-in.
    scene.tick(0.25);
    const expected = { x: PLAYER_AIM_SPAWN.x, y: PLAYER_AIM_SPAWN.y };
    expect(player.x).toBeCloseTo(expected.x, 5);
    expect(player.y).toBeCloseTo(expected.y, 5);
    for (const e of entities) {
      expect(e.aimCalls).toHaveLength(1);
      expect(e.aimCalls[0]).toEqual(expected);
    }
    expect(expected).not.toEqual({ x: GAME_WIDTH / 2, y: GAME_HEIGHT - 40 });
  });

  it('AC2 — tracks the player after live movement (aim updated each frame)', async () => {
    const scene = await bootGym(PLAYER_AIM_SPAWN);
    const player = scene.getPlayer()!;
    const entities = scene.formationEntities as unknown as AimStubEnemy[];
    for (const e of entities) e.aimCalls = [];

    // Hold course and fly for several frames — the aim must follow the
    // player's changing world position frame by frame.
    scene.getCursors()!.right.isDown = true;
    const seen: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 4; i++) {
      seen.push({ x: player.x, y: player.y });
      scene.tick(0.25);
    }
    scene.getCursors()!.right.isDown = false;

    expect(player.x).toBeGreaterThan(PLAYER_AIM_SPAWN.x + 10); // really moved
    for (const e of entities) {
      expect(e.aimCalls).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        expect(e.aimCalls[i]).toEqual(seen[i]);
      }
    }
  });

  it('AC3 — relocation between frames is picked up on the next tick (live position each frame)', async () => {
    const scene = await bootGym(PLAYER_AIM_SPAWN);
    const player = scene.getPlayer()!;
    const entities = scene.formationEntities as unknown as AimStubEnemy[];
    for (const e of entities) e.aimCalls = [];

    // Deterministic teleport-style relocation (respawn seam); the aim
    // must reflect the new position on the very next frame.
    player.respawn(300, 450);
    scene.tick(0.25);
    for (const e of entities) {
      expect(e.aimCalls.at(-1)).toEqual({ x: 300, y: 450 });
    }
  });

  it('AC6 — backward compatible: no player means no aim push at all', async () => {
    const scene = await bootGym();
    const entities = scene.formationEntities as unknown as AimStubEnemy[];
    for (const e of entities) e.aimCalls = [];

    scene.tick(0.25);
    scene.tick(0.25);
    for (const e of entities) expect(e.aimCalls).toEqual([]);
    // The scene still ticks normally without a player.
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
  });

  it('AC6 — a plain entity without the seam never breaks the tick when a player IS present', async () => {
    booted = await bootScene([makeStubScene(() => [], PLAYER_AIM_SPAWN)]);
    const scene = booted!.scene as BootedScene;
    expect(scene.getPlayer()).not.toBeNull();
    expect(() => scene.tick(0.25)).not.toThrow();
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
  });
});

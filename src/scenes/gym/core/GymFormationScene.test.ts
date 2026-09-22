import { afterEach, describe, expect, it, vi } from 'vitest';
import * as effectsModule from '../../../audio/effects';
import * as explosionModule from '../../../vfx/explosionParticles';
import * as collectAnimationModule from '../../../powerups/collectAnimation';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../../test/gameHarness';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  SHIP_COLOR,
} from '../../../core/constants';
import {
  PLAYER_BULLET_RADIUS,
  PLAYER_BULLET_SPEED,
  SHIP_SIZE,
} from '../../../core/constants';
import { Player } from '../../../entities/Player';
import { BACK_TO_INDEX_LABEL } from '../../../utils/gymNavigation';
import { FormationOffset } from '../../../utils/formations';
import {
  EnemyFormationConfig,
  FormationSceneBullet,
  FormationSceneEntity,
  GymFormationScene,
  type PowerUpLayerConfig,
} from './GymFormationScene';
import { RoundRobinSpawner, WeightedRandomSpawner } from '../../../powerups/spawner';
import {
  RandomAvoidingPlacement,
  type PowerUpPlacement,
} from '../../../powerups/placement';
import {
  isWeaponDrop,
  WEAPON_DROP_IDS,
  type DropId,
  type PowerUpId,
} from '../../../powerups/types';
import {
  createSeededRng,
  isClearOfBodies,
  stubBody,
} from '../../../test/powerUpTestFixtures';

/** Minimal entity the base class drives (mirrors the real enemy contract). */
class StubEnemy extends Phaser.GameObjects.Container implements FormationSceneEntity {
  alive = true;
  shootEnabled = false;
  readonly offset: FormationOffset;
  private readonly _hitRadius: number;

  constructor(
    scene: Phaser.Scene,
    offset: FormationOffset,
    hitRadius = 10,
  ) {
    super(scene, 0, 0);
    this.offset = offset;
    this._hitRadius = hitRadius;
  }

  destroySelf(): void {
    this.alive = false;
  }

  getHitRadius(): number {
    return this._hitRadius;
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
  powerUps?: PowerUpLayerConfig,
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
    powerUps,
    buildOffsets: vOffsets,
    createEntity: (scene, x, y, offset) => {
      const hitRadius = collision?.entityHitRadius ?? 10;
      const enemy = new entityType(scene, offset, hitRadius);
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

  it('AC — entities WITHOUT the destruction-audio hook keep the shared sound exactly once (backward compatible)', async () => {
    const scene = await bootGym();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const diverSound = vi.spyOn(effectsModule, 'playDiverDestructionSound');

    // StubEnemy omits `playDestructionAudio?()` — the base scene must
    // fall back to the shared sound (once per destruction, no change for
    // Scout/Tank/Swarm/Phaser).
    const explode = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === 'EXPLODE',
    );
    explode!.emit('pointerdown');
    expect(scene.aliveCount).toBe(FORMATION_COUNT - 1);
    expect(destroySound).toHaveBeenCalledTimes(1);
    expect(diverSound).not.toHaveBeenCalled();
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

    // Hold the D key (WASD → right).
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

describe('GymFormationScene — scheme-aware input routing (parent AC1/AC2/AC3)', () => {
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

  /** Re-installs a fresh AsteroidsModel with facing reset to 0. */
  function resetToAsteroids(player: Player): void {
    player.setScheme('fourDirectional');
    player.setScheme('asteroids');
  }

  it('asteroids: Up arrow / W = forward thrust — the ship moves in its facing direction, never upward (regression: asteroids player never receives 4-directional input)', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setScheme('asteroids');
    player.setPosition(480, 270);
    const x0 = player.x;
    const y0 = player.y;

    // Up arrow → forward. Facing starts at 0 (right), so forward thrust
    // moves the ship rightward — never upward (a 4-directional-shape input
    // would be ignored entirely by the AsteroidsModel).
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.up.isDown = false;
    expect(player.x).toBeGreaterThan(x0); // forward thrust applied
    expect(player.y).toBeCloseTo(y0, 5); // NOT upward — no 4-directional shape

    // W key → forward as well (WASD path).
    const x1 = player.x;
    scene.getWasd()!.W.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.W.isDown = false;
    expect(player.x).toBeGreaterThan(x1);
    expect(player.y).toBeCloseTo(y0, 5);
  });

  it('asteroids: A/Left = turnLeft — the ship rotates counter-clockwise', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setScheme('asteroids');
    expect(player.getHeading()).toBe(0);

    // WASD path: A → turnLeft. 3 rad/s × 0.25 s = 0.75 rad CCW (wraps to 2π−0.75).
    scene.getWasd()!.A.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.A.isDown = false;
    expect(player.getHeading()).toBeCloseTo(2 * Math.PI - 0.75, 3);

    // Arrow path: Left → turnLeft as well.
    resetToAsteroids(player);
    scene.getCursors()!.left.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.left.isDown = false;
    expect(player.getHeading()).toBeCloseTo(2 * Math.PI - 0.75, 3);
  });

  it('asteroids: D/Right = turnRight — the ship rotates clockwise (AH-0MTFORPJ2003RWWQ)', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setScheme('asteroids');
    expect(player.getHeading()).toBe(0);

    // WASD path: D → turnRight (+0.75 rad).
    scene.getWasd()!.D.isDown = true;
    scene.tick(0.25);
    scene.getWasd()!.D.isDown = false;
    expect(player.getHeading()).toBeCloseTo(0.75, 3);

    // Arrow path: Right → turnRight as well.
    resetToAsteroids(player);
    scene.getCursors()!.right.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.right.isDown = false;
    expect(player.getHeading()).toBeCloseTo(0.75, 3);
  });

  it('routes input by the player scheme at read time — the same held Up arrow maps differently per scheme (AC2/AC3)', async () => {
    const scene = await bootWithPlayer();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // Asteroids: Up arrow = forward → thrust in the facing direction (right).
    player.setScheme('asteroids');
    const x0 = player.x;
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.up.isDown = false;
    expect(player.x).toBeGreaterThan(x0);
    expect(player.y).toBeCloseTo(270, 5);

    // 4-directional: the same Up arrow moves the ship up (backward compatible).
    player.setScheme('fourDirectional');
    const y1 = player.y;
    scene.getCursors()!.up.isDown = true;
    scene.tick(0.25);
    scene.getCursors()!.up.isDown = false;
    expect(player.y).toBeLessThan(y1);
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
  const PLAYER_SPAWN = { x: 480, y: 270 };

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

  it('AC — player-bullet destruction WITHOUT the hook falls back to the shared sound (backward compatible)', async () => {
    const { scene } = await bootParked();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const diverSound = vi.spyOn(effectsModule, 'playDiverDestructionSound');
    // This describe block has no clearAllMocks in afterEach, so the same
    // module mocks accumulate across tests — measure the delta instead.
    const sharedBefore = vi.mocked(destroySound).mock.calls.length;
    const diverBefore = vi.mocked(diverSound).mock.calls.length;
    const target = scene.formationEntities[0];

    scene.spawnPlayerBullet(target.x, target.y, 0, 0);
    scene.tick(0.05);

    expect(target.alive).toBe(false);
    expect(vi.mocked(destroySound).mock.calls.length).toBe(sharedBefore + 1);
    expect(vi.mocked(diverSound).mock.calls.length).toBe(diverBefore);
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

  it('AC3 — an enemy bullet hitting the player triggers explosion VFX/SFX + in-place respawn + invulnerability blink', async () => {
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const { scene, parkAt, armed } = await bootParked();
    const player = scene.getPlayer()!;

    // Move the player away from spawn so respawn in-place is observable.
    // We use a single tick with cursors pressed, then park the bullet
    // and tick again — all in a controlled way.
    const cursors = scene.getCursors()!;
    cursors.down.isDown = true;
    cursors.right.isDown = true;
    for (let i = 0; i < 20; i++) scene.tick(0.1);
    cursors.down.isDown = false;
    cursors.right.isDown = false;
    // Decay residual velocity so the player is stationary.
    for (let i = 0; i < 20; i++) scene.tick(0.05);

    // Park an enemy bullet at the player's current position.
    const preHitX = player.x;
    const preHitY = player.y;
    const preHitState = player.getMovementState();
    const preHitFacing = preHitState.facing ?? 0;
    parkAt.x = preHitX;
    parkAt.y = preHitY;
    const callsBefore = vi.mocked(destroySound).mock.calls.length;
    armed();
    scene.tick(0.05);

    // Hit: VFX/SFX fired, hit counter incremented, respawned in-place.
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.getPlayerExplosions().length).toBeGreaterThan(0);
    expect(vi.mocked(destroySound).mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
    // AC1: player is at the SAME position (not relocated to spawn).
    // Small drift during tick(0.05) from friction/physics is acceptable.
    expect(Math.abs(player.x - preHitX)).toBeLessThan(3);
    expect(Math.abs(player.y - preHitY)).toBeLessThan(3);
    // AC3: facing preserved exactly.
    const postState = player.getMovementState();
    expect(postState.facing).toBe(preHitFacing);
    // AC3: velocity zeroed.
    expect(postState.vx).toBe(0);
    expect(postState.vy).toBe(0);
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
    const preHitX = player.x;
    const preHitY = player.y;
    armed();
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // AC1: player stays at hit position (in-place respawn).
    expect(Math.abs(player.x - preHitX)).toBeLessThan(3);
    expect(Math.abs(player.y - preHitY)).toBeLessThan(3);

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
    // is at the last hit position, and the HUD/score line never changes.
    expect(scene.getPlayer()).not.toBeNull();
    expect(player.x).toBe(preHitX);
    expect(player.y).toBe(preHitY);
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

describe('GymFormationScene — wipe detection, 3s countdown and respawn (AH-0MTFXKA5Q003LBH5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(
    player?: { x: number; y: number },
  ): Promise<BootedScene> {
    booted = await bootScene([makeStubScene(() => [], player)]);
    return booted!.scene as BootedScene;
  }

  function killAll(scene: BootedScene): void {
    for (const e of scene.formationEntities) e.destroySelf();
  }

  it('AC1 — when aliveCount transitions to 0 the scene enters the respawn countdown within one tick', async () => {
    const scene = await bootGym();
    expect(scene.isRespawnCountdownActive()).toBe(false);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);

    killAll(scene);
    expect(scene.aliveCount).toBe(0);
    // Wipe is only observed on the next tick (collision tick creates the
    // aliveCount === 0 state, the following tick starts the countdown).
    expect(scene.isRespawnCountdownActive()).toBe(false);
    scene.tick(0.016);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    expect(scene.getRespawnCountdownRemaining()).toBeGreaterThan(2.9);
    expect(scene.getRespawnCountdownRemaining()).toBeLessThanOrEqual(3);
  });

  it('AC1 — countdown overlay text is visible and centred while active', async () => {
    const scene = await bootGym();
    killAll(scene);
    scene.tick(0.016);

    const overlay = scene.getRespawnCountdownText();
    expect(overlay).not.toBeNull();
    expect(overlay!.visible).toBe(true);
    expect(overlay!.text).toMatch(/Respawning in 3/);
    expect(overlay!.x).toBeCloseTo(GAME_WIDTH / 2, 5);
    expect(overlay!.y).toBeCloseTo(GAME_HEIGHT / 2, 5);
  });

  it('AC2 — countdown ticks once per second: 3 → 2 → 1 over wall-clock seconds', async () => {
    const scene = await bootGym();
    killAll(scene);
    scene.tick(0.016);
    expect(scene.getRespawnCountdownText()!.text).toMatch(/Respawning in 3/);

    scene.tick(1.0);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    expect(scene.getRespawnCountdownRemaining()).toBeCloseTo(2, 1);
    expect(scene.getRespawnCountdownText()!.text).toMatch(/Respawning in 2/);

    scene.tick(1.0);
    expect(scene.getRespawnCountdownRemaining()).toBeCloseTo(1, 1);
    expect(scene.getRespawnCountdownText()!.text).toMatch(/Respawning in 1/);
  });

  it('AC2 — after exactly 3 seconds the formation respawns and the countdown is removed', async () => {
    const scene = await bootGym();
    const offsetsBefore = vOffsets(FORMATION_COUNT);
    killAll(scene);
    scene.tick(0.016); // start countdown

    // Advance to just before expiry — still counting down.
    scene.tick(1.0);
    scene.tick(1.0);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    expect(scene.aliveCount).toBe(0);

    const spawnSound = vi.spyOn(effectsModule, 'playSpawnSound');
    const callsBefore = spawnSound.mock.calls.length;
    scene.tick(1.0); // expiry → respawn

    expect(scene.isRespawnCountdownActive()).toBe(false);
    expect(scene.getRespawnCountdownRemaining()).toBe(0);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
    expect(scene.formationEntities.every((e) => e.alive)).toBe(true);
    // Countdown overlay hidden (not destroyed, so a second wipe can reuse it).
    expect(scene.getRespawnCountdownText()!.visible).toBe(false);
    expect(spawnSound.mock.calls.length).toBeGreaterThan(callsBefore);

    // Formation reset to startX/startY-derived positions.
    expect(scene.formationX).toBeCloseTo(START_X, 5);
    expect(scene.formationY).toBeCloseTo(START_Y, 5);
    for (const [i, entity] of scene.formationEntities.entries()) {
      const { row, col } = offsetsBefore[i];
      expect(entity.x).toBeCloseTo(START_X + col * SPACING_X, 5);
      expect(entity.y).toBeCloseTo(START_Y + row * SPACING_Y, 5);
    }
  });

  it('AC4 — enemy bullets in flight are cleared on respawn; player bullets persist', async () => {
    // Stationary enemy bullet via collect, parked at a known spot.
    let armed = false;
    const collect = (enemy: StubEnemy): StubBullet[] => {
      if (!armed) return [];
      armed = false;
      const b = new StubBullet(enemy.scene, 0, 0);
      b.graphics.setPosition(10, 10);
      return [b];
    };
    booted = await bootScene([
      makeStubScene(collect, { x: 480, y: 270 }),
    ]);
    const scene = booted!.scene as BootedScene;

    // Arm one enemy bullet before the wipe, then kill the formation.
    armed = true;
    scene.tick(0.016);
    expect(scene.activeBullets.length).toBe(1);
    const enemyBullet = scene.activeBullets[0];

    killAll(scene);
    scene.tick(0.016); // start countdown
    // Park a player bullet far from the formation so it never collides.
    const pb = scene.spawnPlayerBullet(900, 500, 0, 0);
    expect(scene.getPlayerBullets()).toContain(pb);

    // Fast-forward past the 3s countdown.
    scene.tick(1.0);
    scene.tick(1.0);
    scene.tick(1.0);

    expect(scene.activeBullets.length).toBe(0);
    expect(scene.activeBullets).not.toContain(enemyBullet);
    // Player bullet survives the respawn.
    expect(scene.getPlayerBullets()).toContain(pb);
  });

  it('AC5 — shootEnabled state carries over across the respawn', async () => {
    const scene = await bootGym();
    // Enable shooting before the wipe.
    const shoot = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text === 'SHOOT: OFF',
    )!;
    shoot.emit('pointerdown');
    expect(scene.shootingEnabled).toBe(true);

    killAll(scene);
    scene.tick(0.016);
    scene.tick(1.0);
    scene.tick(1.0);
    scene.tick(1.0);

    expect(scene.shootingEnabled).toBe(true);
    expect(scene.formationEntities.every((e) => e.shootEnabled)).toBe(true);
    // Button label still reflects ON.
    expect(
      scene.children.list.some(
        (c): c is Phaser.GameObjects.Text =>
          c instanceof Phaser.GameObjects.Text && c.text === 'SHOOT: ON',
      ),
    ).toBe(true);
  });

  it('AC5 — OFF shooting also carries over (no surprise toggle)', async () => {
    const scene = await bootGym();
    expect(scene.shootingEnabled).toBe(false);
    killAll(scene);
    scene.tick(0.016);
    scene.tick(1.0);
    scene.tick(1.0);
    scene.tick(1.0);
    expect(scene.shootingEnabled).toBe(false);
    expect(scene.formationEntities.every((e) => !e.shootEnabled)).toBe(true);
  });

  it('countdown restarts correctly if the scene is torn down mid-countdown (no crash or stale state)', async () => {
    const scene = await bootGym();
    killAll(scene);
    scene.tick(0.016);
    scene.tick(1.0);
    expect(scene.isRespawnCountdownActive()).toBe(true);

    // Simulate the Phaser SHUTDOWN that the scene listens for — it must
    // cancel the countdown without throwing, so a re-boot starts clean.
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    expect(scene.getRespawnCountdownRemaining()).toBe(0);

    // Destroy and re-boot a fresh scene — no stale countdown.
    booted!.game.destroy(true);
    booted = await bootScene([makeStubScene(() => [], undefined)]);
    const fresh = booted!.scene as BootedScene;
    expect(fresh.isRespawnCountdownActive()).toBe(false);
    expect(fresh.aliveCount).toBe(FORMATION_COUNT);
  });

  it('no countdown starts while enemies remain alive', async () => {
    const scene = await bootGym();
    // Kill all but one.
    for (let i = 0; i < FORMATION_COUNT - 1; i++) {
      scene.formationEntities[i].destroySelf();
    }
    expect(scene.aliveCount).toBe(1);
    scene.tick(0.5);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    scene.tick(0.5);
    expect(scene.isRespawnCountdownActive()).toBe(false);
  });

  it('wipe → respawn loop is repeatable: a second wipe after respawn starts a fresh countdown', async () => {
    const scene = await bootGym();
    // First wipe → respawn.
    killAll(scene);
    scene.tick(0.016);
    scene.tick(1.0);
    scene.tick(1.0);
    scene.tick(1.0);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);

    // Second wipe of the fresh formation.
    killAll(scene);
    expect(scene.aliveCount).toBe(0);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    scene.tick(0.016);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    scene.tick(1.0);
    scene.tick(1.0);
    scene.tick(1.0);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
    expect(scene.isRespawnCountdownActive()).toBe(false);
  });
});

describe('GymFormationScene — stop/restart of the same instance clears stale entities (AH-0MTPLHLZ3006MOC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<BootedScene> {
    booted = await bootScene([makeStubScene(() => [])]);
    return booted!.scene as BootedScene;
  }

  it('AC4 — emitting SHUTDOWN clears entities/bullets/playerBullets so a second create() starts clean (no crash, no doubling)', async () => {
    const scene = await bootGym();
    expect(scene.formationEntities.length).toBe(FORMATION_COUNT);

    // Simulate the Phaser stop: DisplayList.shutdown destroys children and
    // sets their `scene` to undefined; the scene's own SHUTDOWN hook then
    // clears the bookkeeping arrays (the fix under test).
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);

    // After the SHUTDOWN teardown the arrays are empty — a later restart
    // (same instance) will push only the fresh formation.
    expect(scene.formationEntities).toHaveLength(0);
    expect(scene.activeBullets).toHaveLength(0);
    expect(scene.getPlayerBullets()).toHaveLength(0);

    // Re-run create() on the SAME instance (the gym-index restart vector).
    // This must spawn exactly FORMATION_COUNT fresh entities and the tick
    // must not iterate stale destroyed objects.
    expect(() => scene.create()).not.toThrow();
    expect(scene.formationEntities).toHaveLength(FORMATION_COUNT);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
    expect(() => scene.tick(0.016)).not.toThrow();
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
  });

  it('AC4 — with a player: SHUTDOWN teardown nulls the player and clears player bullets; restart spawns a fresh ship', async () => {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 270 }),
    ]);
    const scene = booted!.scene as BootedScene;
    expect(scene.getPlayer()).not.toBeNull();

    // Fire an extra player bullet (boot may already have auto-fired some).
    scene.spawnPlayerBullet(100, 100, 0, 100);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.getPlayer()).toBeNull();
    expect(scene.getPlayerBullets()).toHaveLength(0);
    expect(scene.formationEntities).toHaveLength(0);

    expect(() => scene.create()).not.toThrow();
    expect(scene.getPlayer()).not.toBeNull();
    expect(scene.formationEntities).toHaveLength(FORMATION_COUNT);
    expect(() => scene.tick(0.016)).not.toThrow();
  });

  it('AC4 — SHUTDOWN mid-countdown drops the stale overlay reference; a same-instance restart re-creates a working overlay', async () => {
    const scene = await bootGym();

    // Enter a wipe → countdown cycle so an overlay text exists on the display list.
    for (const e of scene.formationEntities) e.destroySelf();
    scene.tick(0.016);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    expect(scene.getRespawnCountdownText()).not.toBeNull();

    // Tear down mid-countdown (the gym-index restart vector).
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    // The stale overlay object (destroyed with the display list) must no
    // longer be referenced, so the next respawn builds a fresh one.
    expect(scene.getRespawnCountdownText()).toBeNull();

    // Restart the SAME instance: a fresh wipe → countdown cycle creates a
    // brand-new visible overlay on the new display list (no stale text reuse).
    scene.create();
    expect(scene.formationEntities).toHaveLength(FORMATION_COUNT);
    for (const e of scene.formationEntities) e.destroySelf();
    scene.tick(0.016);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    const overlay = scene.getRespawnCountdownText();
    expect(overlay).not.toBeNull();
    expect(overlay!.visible).toBe(true);
    expect(() => scene.tick(1.0)).not.toThrow();
  });
});

describe('GymFormationScene — player-vs-enemy-body collision (AH-0MTV7JOLU006W8PT)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  const PLAYER_SPAWN = { x: 480, y: 270 };

  async function bootWithPlayer(): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], PLAYER_SPAWN),
    ]);
    return booted!.scene as BootedScene;
  }

  /** Helper: position the player at an entity's post-tick coordinates
   *  and sync the internal physics state so `tick()` doesn't reset it.
   *  During tick the formation base drifts right by `DRIFT_SPEED * dt`.
   */
  function placePlayerAtEntity(scene: BootedScene, entity: FormationSceneEntity): void {
    const player = scene.getPlayer()!;
    const postTickX = scene.formationX + DRIFT_SPEED * 0.05
      + entity.offset.col * SPACING_X;
    const postTickY = scene.formationY + entity.offset.row * SPACING_Y;
    player.setPosition(postTickX, postTickY);
    (player as any)._movementState = {
      x: postTickX,
      y: postTickY,
      vx: 0,
      vy: 0,
      facing: 0,
    };
  }

  it('AC1 — when player overlaps an enemy entity, the enemy is destroyed via destroySelf()', async () => {
    const scene = await bootWithPlayer();
    const target = scene.formationEntities[0];

    expect(target.alive).toBe(true);

    // Position the player at the entity's post-tick location and sync physics state.
    placePlayerAtEntity(scene, target);
    scene.tick(0.05);

    expect(target.alive).toBe(false);
    expect(scene.aliveCount).toBe(FORMATION_COUNT - 1);
  });

  it('AC1 — the enemy destruction sound plays on player-vs-enemy collision', async () => {
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const scene = await bootWithPlayer();
    const target = scene.formationEntities[0];

    const callsBefore = vi.mocked(destroySound).mock.calls.length;
    placePlayerAtEntity(scene, target);
    scene.tick(0.05);

    expect(vi.mocked(destroySound).mock.calls.length).toBe(callsBefore + 1);
  });

  it('AC2 — the player is treated as "hit": explosion VFX/SFX + respawn + invulnerability', async () => {
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const spawnSpy = vi.spyOn(explosionModule, 'spawnExplosionParticles');
    const scene = await bootWithPlayer();
    const target = scene.formationEntities[0];

    const callsBefore = vi.mocked(destroySound).mock.calls.length;
    placePlayerAtEntity(scene, target);
    const hitX = scene.getPlayer()!.x;
    const hitY = scene.getPlayer()!.y;
    scene.tick(0.05);

    // Hit counter incremented.
    expect(scene.getPlayerHitCount()).toBe(1);
    // Explosion VFX spawned.
    expect(scene.getPlayerExplosions().length).toBeGreaterThan(0);
    // Destruction sound played (enemy destruction).
    expect(vi.mocked(destroySound).mock.calls.length).toBeGreaterThan(callsBefore);
    // The player burst is spawned through the shared particle helper with
    // the ship colour/size and the 'player' pattern assignment (AC2).
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const playerCall = spawnSpy.mock.calls[0];
    expect(playerCall).toBeDefined();
    expect(playerCall[0]).toBe(scene);
    expect(playerCall[1]).toBeCloseTo(hitX, 0);
    expect(playerCall[2]).toBeCloseTo(hitY, 0);
    expect(playerCall[3]).toBe(SHIP_COLOR);
    expect(playerCall[4]).toBe(SHIP_SIZE);
    expect(playerCall[5]?.patterns).toEqual(['radial', 'ring']);
    expect(playerCall[5]?.registry).toBeDefined();
    // Player respawned in-place (same position and facing).
    expect(scene.getPlayer()!.x).toBeCloseTo(hitX, 0);
    expect(scene.getPlayer()!.y).toBeCloseTo(hitY, 0);
    // Invulnerability window engaged.
    expect(scene.isPlayerInvulnerable()).toBe(true);
    expect(scene.getPlayerInvulnerableRemaining()).toBeGreaterThan(0);
  });

  it('AC4 — SHUTDOWN destroys active player particle Graphics; restart leaks none', async () => {
    const scene = await bootWithPlayer();
    const target = scene.formationEntities[0];

    placePlayerAtEntity(scene, target);
    scene.tick(0.05);

    // A player particle burst is active and registered for teardown.
    const active = scene.getPlayerExplosions();
    expect(active.length).toBeGreaterThan(0);

    // Simulate the Phaser stop/restart vector.
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.getPlayerExplosions()).toHaveLength(0);

    // Restarting the same instance must not throw and must start clean.
    expect(() => scene.create()).not.toThrow();
    expect(scene.getPlayerExplosions()).toHaveLength(0);
    expect(() => scene.tick(0.016)).not.toThrow();
  });

  it('AC2 — player-vs-enemy collision while invulnerable does not trigger another hit', async () => {
    const scene = await bootWithPlayer();
    const target = scene.formationEntities[1];

    // Directly set the invulnerability window so the player-vs-enemy-body
    // collision below is ignored. (Enemy-bullet → player collision would
    // also work, but the stub has no enemy fire.)
    (scene as any).invulnerable = 1.0;
    (scene as any).blinkPhase = 0;

    // Now push the player into a different enemy — should be ignored due to invulnerability.
    placePlayerAtEntity(scene, target);
    const hitCountBefore = scene.getPlayerHitCount();
    const aliveBefore = scene.aliveCount;
    scene.tick(0.05);

    expect(scene.getPlayerHitCount()).toBe(hitCountBefore);
    expect(scene.aliveCount).toBe(aliveBefore); // enemy NOT destroyed
    expect(target.alive).toBe(true);
  });

  it('AC3 — collision uses the entity hit radius from getHitRadius()', async () => {
    // Use a custom (small) entity hit radius via getHitRadius().
    const smallRadius = 5;
    booted = await bootScene([
      makeStubScene(() => [], PLAYER_SPAWN, { entityHitRadius: smallRadius }),
    ]);
    const scene = booted!.scene as BootedScene;
    const target = scene.formationEntities[0];

    const playerHull = SHIP_SIZE / 2;
    const dist = playerHull + smallRadius;
    const entityBaseX = scene.formationX + DRIFT_SPEED * 0.05 + target.offset.col * SPACING_X;

    // ── Tick 1: player just outside the collision radius ──────────
    placePlayerAtEntity(scene, target);
    const player = scene.getPlayer()!;
    player.x = entityBaseX - dist - 1;
    (player as any)._movementState.x = entityBaseX - dist - 1;
    scene.tick(0.05);
    expect(target.alive).toBe(true);

    // ── Tick 2: player just inside ────────────────────────────────
    // The entity drifts one more tick (another 2 px), so shift the
    // player right by that amount to stay just inside.
    player.x = entityBaseX + DRIFT_SPEED * 0.05 - dist + 1;
    (player as any)._movementState.x = entityBaseX + DRIFT_SPEED * 0.05 - dist + 1;
    scene.tick(0.05);
    expect(target.alive).toBe(false);
  });

  it('AC4 — playerHitCount increments on each collision', async () => {
    const scene = await bootWithPlayer();

    // Player starts at spawn — hit count is zero.
    expect(scene.getPlayerHitCount()).toBe(0);

    // Push into first enemy.
    const e1 = scene.formationEntities[0];
    placePlayerAtEntity(scene, e1);
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(1);

    // Clear the invulnerability window set by the first hit so the
    // second collision is not silently skipped.
    (scene as any).invulnerable = 0;

    // Push into second enemy.
    const e2 = scene.formationEntities[1];
    placePlayerAtEntity(scene, e2);
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(2);
  });

  it('AC — player misses enemy when not overlapping (no false positives)', async () => {
    const scene = await bootWithPlayer();
    const target = scene.formationEntities[0];

    const aliveBefore = target.alive;
    // Position player far outside the hit radius.
    const entityBaseX = scene.formationX + DRIFT_SPEED * 0.05 + target.offset.col * SPACING_X;
    const player = scene.getPlayer()!;
    player.x = entityBaseX - 100;
    (player as any)._movementState.x = entityBaseX - 100;
    scene.tick(0.05);

    expect(target.alive).toBe(aliveBefore);
    expect(scene.aliveCount).toBe(FORMATION_COUNT);
    expect(scene.getPlayerHitCount()).toBe(0);
  });
});

describe('GymFormationScene — power-up layer (AH-0MU44M9CA007GBTZ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  const INTERVAL = 15;

  /** Deterministic layer: round-robin IDs, seeded placement, short interval. */
  function deterministicLayer(): PowerUpLayerConfig {
    return {
      spawner: new RoundRobinSpawner<PowerUpId>(['P3', 'P4', 'P6', 'P7']),
      placement: new RandomAvoidingPlacement({ rng: createSeededRng(1) }),
      spawnInterval: INTERVAL,
    };
  }

  async function bootWithLayer(powerUps: PowerUpLayerConfig): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 270 }, undefined, StubEnemy, powerUps),
    ]);
    return booted.scene as BootedScene;
  }

  it('AC1 — is disabled by default (no drops without a config block)', async () => {
    booted = await bootScene([makeStubScene(() => [], { x: 480, y: 270 })]);
    const scene = booted.scene as BootedScene;

    expect(scene.isPowerUpLayerEnabled()).toBe(false);
    expect(scene.getPowerUpDrops()).toHaveLength(0);
    scene.tick(INTERVAL * 2);
    expect(scene.getPowerUpSpawnCount()).toBe(0);
  });

  it('AC1 — spawns exactly one drop immediately when enabled', async () => {
    const scene = await bootWithLayer(deterministicLayer());

    expect(scene.isPowerUpLayerEnabled()).toBe(true);
    expect(scene.getPowerUpDrops()).toHaveLength(1);
    expect(scene.getPowerUpSpawnCount()).toBe(1);
  });

  it('AC1 — keeps one drop at a time and re-spawns on the configured interval', async () => {
    const scene = await bootWithLayer(deterministicLayer());
    expect(scene.getPowerUpSpawnCount()).toBe(1);

    scene.tick(INTERVAL);
    expect(scene.getPowerUpDrops()).toHaveLength(1);
    expect(scene.getPowerUpSpawnCount()).toBe(2);

    scene.tick(INTERVAL);
    expect(scene.getPowerUpDrops()).toHaveLength(1);
    expect(scene.getPowerUpSpawnCount()).toBe(3);
  });

  it('AC1 — never exposes more than one drop when ticked in small steps', async () => {
    const scene = await bootWithLayer(deterministicLayer());

    for (let i = 0; i < 300; i += 1) {
      scene.tick(0.1); // 30 s total — several spawn cycles
      expect(scene.getPowerUpDrops().length).toBeLessThanOrEqual(1);
    }
  });

  it('AC2 — selects the spawn ID through the injected PowerUpSpawner', async () => {
    const scene = await bootWithLayer(deterministicLayer());

    const ids = [scene.getPowerUpDrops()[0].id];
    for (let i = 0; i < 3; i += 1) {
      scene.tick(INTERVAL);
      ids.push(scene.getPowerUpDrops()[0].id);
    }

    expect(ids).toEqual(['P3', 'P4', 'P6', 'P7']);
  });

  it('AC3 — positions the drop through the injected placement strategy', async () => {
    const fixed: PowerUpPlacement = { place: () => ({ x: 123, y: 45 }) };
    const scene = await bootWithLayer({
      spawner: new RoundRobinSpawner<PowerUpId>(['P3']),
      placement: fixed,
      spawnInterval: INTERVAL,
    });

    const drop = scene.getPowerUpDrops()[0];
    expect(drop.x).toBe(123);
    expect(drop.y).toBe(45);
    expect(drop.graphics.x).toBe(123);
    expect(drop.graphics.y).toBe(45);
  });

  it('AC3 — never places a drop on a live enemy or the player', async () => {
    const scene = await bootWithLayer(deterministicLayer());

    // Tick to a fresh spawn each cycle so the enemy positions are final
    // for the frame in which the drop was placed.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      scene.tick(INTERVAL);
      const drop = scene.getPowerUpDrops()[0];
      const bodies = scene.formationEntities
        .filter((enemy) => enemy.alive)
        .map((enemy) => stubBody(enemy.x, enemy.y, enemy.getHitRadius()));
      const player = scene.getPlayer();
      if (player) bodies.push(stubBody(player.x, player.y, SHIP_SIZE / 2));

      expect(
        isClearOfBodies(stubBody(drop.x, drop.y, POWER_UP_DROP_SIZE), bodies),
      ).toBe(true);
    }
  });

  it('AC6 — applies a live interval change via setPowerUpSpawnInterval', async () => {
    const scene = await bootWithLayer({
      ...deterministicLayer(),
      spawnInterval: 1000,
    });
    expect(scene.getPowerUpSpawnInterval()).toBe(1000);

    scene.setPowerUpSpawnInterval(5);
    expect(scene.getPowerUpSpawnInterval()).toBe(5);

    const before = scene.getPowerUpSpawnCount();
    scene.tick(20); // despawns the current drop and triggers the next spawn
    expect(scene.getPowerUpSpawnCount()).toBe(before + 1);
  });
});

describe('GymFormationScene — power-up collection, effects and HUD (AH-0MU44M9NQ0006613)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  // Long interval so cadence spawns never interfere with the assertions.
  const INTERVAL = 1000;
  const CLEAR: PowerUpPlacement = { place: () => ({ x: 10, y: 10 }) };

  async function boot(
    powerUps: PowerUpLayerConfig,
    collect: (enemy: StubEnemy, now: number) => StubBullet[] = () => [],
  ): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(collect, { x: 480, y: 270 }, undefined, StubEnemy, powerUps),
    ]);
    return booted.scene as BootedScene;
  }

  function layer(id: PowerUpId, placement: PowerUpPlacement): PowerUpLayerConfig {
    return {
      spawner: new RoundRobinSpawner<PowerUpId>([id]),
      placement,
      spawnInterval: INTERVAL,
    };
  }

  it('AC1 — fly-over collection is gated at 3% scale and hull overlap', async () => {
    const scene = await boot(layer('P3', CLEAR));
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop('P3', player.x, player.y)!;

    // Scale 0: on the ship but below the 3% collection threshold.
    expect(drop.powerUp.canCollect()).toBe(false);
    scene.tick(0.01); // 2% — still below the threshold
    expect(drop.powerUp.canCollect()).toBe(false);
    expect(scene.getPowerUpDrops()).toContain(drop);

    scene.tick(0.1); // 22% — collectible and overlapping the hull
    expect(scene.getPowerUpDrops()).not.toContain(drop);
  });

  it('AC2 — collecting applies the effect through the shared EffectsRegistry', async () => {
    const scene = await boot(layer('P9', CLEAR));
    const player = scene.getPlayer()!;
    expect(scene.getEffectsRegistry().magnetStacks()).toBe(0);

    scene.spawnPowerUpDrop('P9', player.x, player.y);
    scene.tick(0.1);

    expect(scene.getEffectsRegistry().magnetStacks()).toBe(1);
  });

  it('AC3 — renders the standalone HUD with lives counter and active-effect rows', async () => {
    const scene = await boot(layer('P9', CLEAR));
    const hud = scene.getHUD();
    expect(hud).not.toBeNull();
    expect(hud!.getLivesLabel()).toBe('Lives: 3');

    const player = scene.getPlayer()!;
    scene.spawnPowerUpDrop('P9', player.x, player.y);
    scene.tick(0.1);
    hud!.refresh();

    expect(hud!.getRows().some((row) => row.id === 'P9')).toBe(true);
  });

  it('AC4 — P8 updates the lives counter', async () => {
    const scene = await boot(layer('P8', CLEAR));
    const player = scene.getPlayer()!;
    expect(scene.getEffectsRegistry().lives()).toBe(3);

    scene.spawnPowerUpDrop('P8', player.x, player.y);
    scene.tick(0.1);

    expect(scene.getEffectsRegistry().lives()).toBe(4);
  });

  it('AC4 — P9 stacks (capped at five)', async () => {
    const scene = await boot(layer('P9', CLEAR));
    const player = scene.getPlayer()!;

    for (let i = 0; i < 6; i += 1) {
      scene.spawnPowerUpDrop('P9', player.x, player.y);
      scene.tick(0.1);
    }

    expect(scene.getEffectsRegistry().magnetStacks()).toBe(5);
  });

  it('AC4 — P4 clears on-screen enemy bullets without damaging enemies', async () => {
    const collect = (enemy: StubEnemy) => [new StubBullet(enemy.scene, 0, 0)];
    const scene = await boot(layer('P4', CLEAR), collect);

    // Let the formation produce a batch of on-screen enemy bullets.
    scene.tick(0.05);
    expect(scene.activeBullets.length).toBeGreaterThan(0);
    const aliveBefore = scene.aliveCount;

    // Collect a P4 on the ship — the bomb clears every on-screen bullet.
    const player = scene.getPlayer()!;
    scene.spawnPowerUpDrop('P4', player.x, player.y);
    scene.tick(0.05);

    expect(scene.activeBullets).toHaveLength(0);
    expect(scene.aliveCount).toBe(aliveBefore);
  });

  it('AC4 — P7 teleport consumes a stack, moves the ship and grants P6', async () => {
    const scene = await boot(layer('P7', CLEAR));
    const player = scene.getPlayer()!;

    // Collect a P7 to gain a teleport stack.
    scene.spawnPowerUpDrop('P7', player.x, player.y);
    scene.tick(0.1);

    const registry = scene.getEffectsRegistry();
    expect(registry.teleportStacks()).toBe(1);

    // Move the ship off the grid-centre fallback so the safe-spot search
    // must pick a genuinely different landing position.
    player.setPosition(300, 400);
    const beforeX = player.x;
    const beforeY = player.y;
    expect(scene.triggerTeleport()).toBe(true);

    expect(registry.teleportStacks()).toBe(0);
    expect(registry.isPhased).toBe(true);
    expect(Math.hypot(player.x - beforeX, player.y - beforeY)).toBeGreaterThan(0);
    expect(player.x).toBeGreaterThanOrEqual(0);
    expect(player.x).toBeLessThanOrEqual(GAME_WIDTH);
    expect(player.y).toBeGreaterThanOrEqual(0);
    expect(player.y).toBeLessThanOrEqual(GAME_HEIGHT);
  });
});

describe('GymFormationScene — weapon drops in the combat power-up layer (AH-0MU3VOQKH005YOBH)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  const INTERVAL = 1000;
  const CLEAR: PowerUpPlacement = { place: () => ({ x: 10, y: 10 }) };

  async function boot(powerUps: PowerUpLayerConfig): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 270 }, undefined, StubEnemy, powerUps),
    ]);
    return booted.scene as BootedScene;
  }

  /** A placement that drops the next drop straight on the ship. */
  function atPlayer(): PowerUpPlacement {
    return { place: (context) => ({ x: context.player.x, y: context.player.y }) };
  }

  it('AC — the default spawner includes every weapon drop in its pool', async () => {
    // No injected spawner: the scene builds the default weighted-random
    // spawner from the rules weights, which must now include weapon IDs.
    const scene = await boot({
      placement: new RandomAvoidingPlacement({ rng: createSeededRng(7) }),
      rng: createSeededRng(42),
      spawnInterval: 1,
    });

    const seen = new Set<DropId>();
    // Drive many spawn cycles through the default spawner. Each tick
    // (> 12.5 s) despawns the current drop and spawns the next.
    for (let i = 0; i < 400; i += 1) {
      scene.tick(13);
      const drop = scene.getPowerUpDrops()[0];
      if (drop) seen.add(drop.dropId);
    }

    // Every weapon drop ID must be reachable from the default pool.
    for (const weaponId of WEAPON_DROP_IDS) {
      expect(seen.has(weaponId)).toBe(true);
    }
    // Power-up IDs remain in the pool.
    expect([...seen].some((id) => id.startsWith('P'))).toBe(true);
  });

  it('AC — a weapon drop is rendered with the weapon icon and carries weaponDropId', async () => {
    const scene = await boot({
      spawner: new RoundRobinSpawner<DropId>(['spread']),
      placement: CLEAR,
      spawnInterval: INTERVAL,
    });

    const drop = scene.getPowerUpDrops()[0];
    expect(drop).toBeDefined();
    expect(drop.dropId).toBe('spread');
    expect(drop.weaponDropId).toBe('spread');
    expect(isWeaponDrop(drop.dropId)).toBe(true);
  });

  it('AC — collecting a weapon drop equips it through the shared EffectsRegistry', async () => {
    const scene = await boot({
      spawner: new RoundRobinSpawner<DropId>(['spread']),
      placement: atPlayer(),
      spawnInterval: INTERVAL,
    });
    const player = scene.getPlayer()!;

    // Spawn a deterministic weapon drop on the ship and collect it.
    scene.spawnPowerUpDrop('dual', player.x, player.y);
    scene.tick(0.1);

    const registry = scene.getEffectsRegistry();
    expect(registry.hasWeapon('dual')).toBe(true);
    expect(registry.activeWeapons().map((w) => w.weaponId)).toContain('dual');
    // The player ship's active set is updated so the weapon actually fires.
    expect(player.hasWeapon('dual')).toBe(true);
  });

  it('AC — an equipped weapon expires in both the registry and on the ship after 10 s', async () => {
    const scene = await boot({
      spawner: new RoundRobinSpawner<DropId>(['spread']),
      placement: atPlayer(),
      spawnInterval: 1000,
    });
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.tick(0.1);
    expect(registry.hasWeapon('spread')).toBe(true);
    expect(player.hasWeapon('spread')).toBe(true);

    // Advance past the 10 s weapon duration.
    scene.tick(10.1);
    expect(registry.hasWeapon('spread')).toBe(false);
    expect(player.hasWeapon('spread')).toBe(false);
  });

  it('AC — the Reset drop clears every active weapon', async () => {
    const scene = await boot({
      spawner: new RoundRobinSpawner<DropId>(['spread']),
      placement: atPlayer(),
      spawnInterval: INTERVAL,
    });
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.spawnPowerUpDrop('rapid', player.x, player.y);
    scene.tick(0.1);
    expect(registry.activeWeapons()).toHaveLength(2);
    expect(player.hasWeapon('spread')).toBe(true);
    expect(player.hasWeapon('rapid')).toBe(true);

    scene.spawnPowerUpDrop('reset', player.x, player.y);
    scene.tick(0.1);
    expect(registry.activeWeapons()).toHaveLength(0);
    expect(player.hasWeapon('spread')).toBe(false);
    expect(player.hasWeapon('rapid')).toBe(false);
  });

  it('AC — weapon drops are positioned through the placement strategy (never on bodies)', async () => {
    const scene = await boot({
      spawner: new WeightedRandomSpawner<DropId>(
        [...WEAPON_DROP_IDS, 'P3'],
        createSeededRng(3),
      ),
      placement: new RandomAvoidingPlacement({ rng: createSeededRng(1) }),
      spawnInterval: INTERVAL,
    });

    for (let cycle = 0; cycle < 6; cycle += 1) {
      scene.tick(INTERVAL);
      const drop = scene.getPowerUpDrops()[0];
      expect(drop).toBeDefined();
      const bodies = scene.formationEntities
        .filter((enemy) => enemy.alive)
        .map((enemy) => stubBody(enemy.x, enemy.y, enemy.getHitRadius()));
      const player = scene.getPlayer();
      if (player) bodies.push(stubBody(player.x, player.y, SHIP_SIZE / 2));
      expect(
        isClearOfBodies(stubBody(drop.x, drop.y, POWER_UP_DROP_SIZE), bodies),
      ).toBe(true);
    }
  });

  it('AC — the HUD renders active weapon rows alongside power-up rows', async () => {
    const scene = await boot({
      spawner: new RoundRobinSpawner<DropId>(['spread']),
      placement: atPlayer(),
      spawnInterval: INTERVAL,
    });
    const player = scene.getPlayer()!;
    const hud = scene.getHUD();
    expect(hud).not.toBeNull();

    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.tick(0.1);
    hud!.refresh();

    expect(
      (
        hud as unknown as {
          list: Phaser.GameObjects.GameObject[];
        }
      ).list.some(
        (c) =>
          c instanceof Phaser.GameObjects.Text &&
          c.text === 'Weapon: spread',
      ),
    ).toBe(true);
  });
});

describe('GymFormationScene — collection absorb VFX + pop SFX (AH-0MUBYXRFT005Y30S)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  const INTERVAL = 1000;
  const CLEAR: PowerUpPlacement = { place: () => ({ x: 10, y: 10 }) };

  async function boot(powerUps: PowerUpLayerConfig): Promise<BootedScene> {
    booted = await bootScene([
      makeStubScene(() => [], { x: 480, y: 270 }, undefined, StubEnemy, powerUps),
    ]);
    return booted.scene as BootedScene;
  }

  function layer(id: PowerUpId): PowerUpLayerConfig {
    return {
      spawner: new RoundRobinSpawner<PowerUpId>([id]),
      placement: CLEAR,
      spawnInterval: INTERVAL,
    };
  }

  it('collection starts the absorb animation and keeps the Graphics alive', async () => {
    const spawnSpy = vi.spyOn(collectAnimationModule, 'spawnCollectAnimation');
    const scene = await boot(layer('P9'));
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop('P9', player.x, player.y)!;

    scene.tick(0.1);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(scene.getPowerUpDrops()).not.toContain(drop);
    expect(scene.getCollectAnimations()).toHaveLength(1);
    expect(drop.graphics.active).toBe(true);
  });

  it('the absorb animation completes and destroys the drop Graphics', async () => {
    const scene = await boot(layer('P9'));
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop('P9', player.x, player.y)!;

    scene.tick(0.1);
    expect(scene.getCollectAnimations()).toHaveLength(1);

    // Advance well past the ≤ 0.3 s absorb duration.
    for (let i = 0; i < 10; i++) scene.tick(0.05);

    expect(scene.getCollectAnimations()).toHaveLength(0);
    expect(drop.graphics.active).toBe(false);
  });

  it('collection plays the generic pop SFX exactly once (no re-collect)', async () => {
    const popSound = vi.spyOn(effectsModule, 'playPowerUpCollectPopSound');
    const scene = await boot(layer('P9'));
    vi.clearAllMocks();
    const player = scene.getPlayer()!;
    scene.spawnPowerUpDrop('P9', player.x, player.y);

    scene.tick(0.1);
    expect(popSound).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i++) scene.tick(0.05);
    expect(popSound).toHaveBeenCalledTimes(1);
  });
});

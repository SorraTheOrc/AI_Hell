/**
 * Unit tests for the wormhole spawn VFX and the enemy growth animation
 * (AH-0MURBER4L00821RR).
 *
 * Assert observable behaviour of the public API — spawn position, tween
 * parameters, registry lifecycle, handle completion, and the dt-driven
 * growth curve — rather than pixel output.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  ENEMY_GROWTH_DURATION,
  TOTAL_SPAWN_PROTECTION_WINDOW,
  WAVE_PORTAL_PLAYER_SAFETY_MARGIN,
  WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
  WORMHOLE_CLOSE_DURATION,
  WORMHOLE_OPEN_DURATION,
  WormholeController,
  anchorSpawnsToPortal,
  formationCentre,
  formationExtents,
  getSpawnState,
  isEnemySpawning,
  placeWavePortal,
  spawnWormholeClose,
  spawnWormholeOpen,
  startSpawnAnimation,
  updateSpawnAnimation,
} from './wormholeSpawn';

/** Minimal bootable scene for the VFX helpers. */
class WormholeVfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'WormholeVfxStubScene' });
  }
}

describe('wormholeSpawn — wormhole open/close VFX', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('spawns a wormhole at the given position, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnWormholeOpen(scene, 100, 120, { registry });

    expect(handle.container.x).toBe(100);
    expect(handle.container.y).toBe(120);
    expect(registry).toContain(handle.container);
    expect(scene.children.list).toContain(handle.container);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    expect(handle.isComplete()).toBe(false);
  });

  it('opens over the configured duration with an ease-out', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeOpen(scene, 10, 20);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(WORMHOLE_OPEN_DURATION * 1000);
    expect(config.scale).toBe(1);
  });

  it('closes by scaling to zero and fading over the close duration', async () => {
    const scene = await boot();
    const handle = spawnWormholeOpen(scene, 10, 20);
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeClose(scene, handle);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(WORMHOLE_CLOSE_DURATION * 1000);
    expect(config.scale).toBe(0);
    expect(config.alpha).toBe(0);

    // Invoke the completion callback to observe teardown.
    (config.onComplete as () => void)();
    expect(handle.isComplete()).toBe(true);
    expect(handle.container.active).toBe(false);
  });

  it('removes the wormhole from the registry on close completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const handle = spawnWormholeOpen(scene, 10, 20, { registry });
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeClose(scene, handle, registry);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();
    expect(registry).not.toContain(handle.container);
  });

  it('exposes the documented spawn-protection timeline total', () => {
    expect(TOTAL_SPAWN_PROTECTION_WINDOW).toBeCloseTo(3, 5);
    expect(WORMHOLE_OPEN_DURATION + ENEMY_GROWTH_DURATION + WORMHOLE_CLOSE_DURATION).toBeCloseTo(
      TOTAL_SPAWN_PROTECTION_WINDOW,
      5,
    );
  });
});

describe('wormholeSpawn — WormholeController single-live lifecycle (AH-0MV9KHLV8006GMX6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('open() opens a single live wormhole and registers it for teardown', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];

    const handle = controller.open(100, 120, registry);

    expect(controller.isOpen).toBe(true);
    expect(handle.container.x).toBe(100);
    expect(handle.container.y).toBe(120);
    expect(registry).toContain(handle.container);
    expect(scene.children.list).toContain(handle.container);
  });

  it('open() first closes any still-open wormhole — at most one live', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];
    const previous = controller.open(10, 10, registry);
    expect(controller.isOpen).toBe(true);

    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const next = controller.open(20, 20, registry);

    // A close tween is scheduled for the previous wormhole before the new one
    // opens — no path may overwrite a live wormhole.
    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === previous.container && c.alpha === 0);
    expect(close).toBeDefined();
    (close!.onComplete as () => void)();

    // Previous destroyed and unregistered; only the new wormhole is live.
    expect(registry).toEqual([next.container]);
    expect(controller.isOpen).toBe(true);
    expect(previous.isComplete()).toBe(true);
  });

  it('close() is idempotent and clears the live slot', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];
    expect(controller.isOpen).toBe(false);

    controller.close(registry); // no-op when nothing is live
    const handle = controller.open(10, 10, registry);
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    controller.close(registry);
    expect(controller.isOpen).toBe(false);
    controller.close(registry); // idempotent

    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === handle.container && c.alpha === 0);
    expect(close).toBeDefined();
    (close!.onComplete as () => void)();
    expect(registry).toHaveLength(0);
    expect(handle.isComplete()).toBe(true);
  });
});

describe('wormholeSpawn — enemy growth animation (AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('starts the enemy at 1 pixel (0.01 scale)', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);

    startSpawnAnimation(enemy, 1);

    expect(enemy.scaleX).toBeCloseTo(0.01, 5);
    expect(isEnemySpawning(enemy)).toBe(true);
    expect(getSpawnState(enemy)).not.toBeNull();
  });

  it('holds at 1 pixel through the wormhole-open delay', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 1);

    // Advance halfway through the open window — growth has not started.
    const stillSpawning = updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION / 2);
    expect(stillSpawning).toBe(true);
    expect(enemy.scaleX).toBeCloseTo(0.01, 5);
    expect(getSpawnState(enemy)?.growing).toBe(false);
  });

  it('grows from 1 pixel to the full size over the growth duration', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 2);

    // Skip the open delay.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);

    // Halfway through growth the scale is strictly between 1 px and full.
    updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 2);
    expect(enemy.scaleX).toBeGreaterThan(0.01);
    expect(enemy.scaleX).toBeLessThan(2);
    expect(isEnemySpawning(enemy)).toBe(true);

    // Completing growth restores the full scale and clears the spawn state.
    const stillSpawning = updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION);
    expect(stillSpawning).toBe(false);
    expect(enemy.scaleX).toBeCloseTo(2, 5);
    expect(isEnemySpawning(enemy)).toBe(false);
  });

  it('uses a smooth ease (monotonic growth, faster early than late)', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 1, 0); // no open delay

    updateSpawnAnimation(enemy, 0.25);
    const quarter = enemy.scaleX;
    updateSpawnAnimation(enemy, 0.25);
    const half = enemy.scaleX;
    updateSpawnAnimation(enemy, 0.25);
    const threeQuarter = enemy.scaleX;

    // Ease-out cubic: the first quarter gains more than each later quarter.
    expect(quarter - 0.01).toBeGreaterThan(half - quarter);
    expect(half - quarter).toBeGreaterThan(threeQuarter - half);
  });

  it('is a no-op on an entity that is not spawning', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    enemy.setScale(1);

    expect(updateSpawnAnimation(enemy, 1)).toBe(false);
    expect(enemy.scaleX).toBe(1);
    expect(getSpawnState(enemy)).toBeNull();
  });
});

describe('wormholeSpawn — wormhole-to-formation transit movement (AH-0MV8BSMXC0097KLW)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  it('records the wormhole origin and the formation destination in the spawn state', async () => {
    const scene = await boot();
    const enemy = scene.add.container(100, 80);

    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 400, y: 260 });

    const state = getSpawnState(enemy);
    expect(state).not.toBeNull();
    expect(state?.originX).toBeCloseTo(100, 5);
    expect(state?.originY).toBeCloseTo(80, 5);
    expect(state?.destX).toBeCloseTo(400, 5);
    expect(state?.destY).toBeCloseTo(260, 5);
  });

  it('starts at the wormhole origin and holds there through the wormhole-open delay', async () => {
    const scene = await boot();
    const enemy = scene.add.container(100, 80);
    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 400, y: 260 });

    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION / 2);

    // The wormhole is still opening — the enemy has not begun to move yet.
    expect(enemy.x).toBeCloseTo(100, 5);
    expect(enemy.y).toBeCloseTo(80, 5);
  });

  it('moves from the wormhole toward the formation position in lock-step with growth', async () => {
    const scene = await boot();
    const enemy = scene.add.container(100, 80);
    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 400, y: 260 });

    // Transit begins with the grow phase, after the open delay.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);
    updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 2);

    expect(enemy.x).toBeGreaterThan(100);
    expect(enemy.x).toBeLessThan(400);
    expect(enemy.y).toBeGreaterThan(80);
    expect(enemy.y).toBeLessThan(260);
    expect(isEnemySpawning(enemy)).toBe(true);
  });

  it('reaches the formation position by the end of the spawn-protection window', async () => {
    const scene = await boot();
    const enemy = scene.add.container(0, 0);
    startSpawnAnimation(enemy, 1, WORMHOLE_OPEN_DURATION, { x: 640, y: 360 });

    const stillSpawning = updateSpawnAnimation(enemy, TOTAL_SPAWN_PROTECTION_WINDOW);

    expect(stillSpawning).toBe(false);
    expect(enemy.x).toBeCloseTo(640, 5);
    expect(enemy.y).toBeCloseTo(360, 5);
  });

  it('is dt-driven, monotonic and never overshoots the destination', async () => {
    const scene = await boot();
    const enemy = scene.add.container(0, 0);
    startSpawnAnimation(enemy, 1, 0, { x: 100, y: 0 }); // no open delay

    let previous = enemy.x;
    for (let i = 0; i < 6; i++) {
      updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 6);
      expect(enemy.x).toBeGreaterThanOrEqual(previous);
      expect(enemy.x).toBeLessThanOrEqual(100);
      previous = enemy.x;
    }
    expect(enemy.x).toBeCloseTo(100, 5);
  });

  it('keeps the entity in place when no destination is supplied', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 60);
    startSpawnAnimation(enemy, 1);

    updateSpawnAnimation(enemy, TOTAL_SPAWN_PROTECTION_WINDOW);

    expect(enemy.x).toBeCloseTo(50, 5);
    expect(enemy.y).toBeCloseTo(60, 5);
  });

  it('does not move an entity that is not spawning', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 60);

    expect(updateSpawnAnimation(enemy, 1)).toBe(false);
    expect(enemy.x).toBeCloseTo(50, 5);
    expect(enemy.y).toBeCloseTo(60, 5);
  });
});

describe('wormholeSpawn — wave portal placement (AH-0MV8BR9Y70079TKC)', () => {
  const FIELD = { width: 960, height: 540 };
  const DETERMINISTIC_RNG = () => 0;
  // Player hull radius + the documented portal safety margin.
  const HULL_SAFE_RADIUS = 10 + WAVE_PORTAL_PLAYER_SAFETY_MARGIN;

  /** Euclidean distance between two points (px). */
  function distance(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  it('derives the formation extents and centre from the planned spawn points', () => {
    const points = [
      { x: 100, y: 40 },
      { x: 140, y: 80 },
      { x: 60, y: 80 },
    ];

    // D_MIN = max(width, height), derived from the planned wave (AC1/AC4).
    expect(formationExtents(points)).toEqual({ width: 80, height: 40 });
    expect(formationCentre(points)).toEqual({ x: 100, y: 60 });
    // Empty plans are degenerate but well-defined.
    expect(formationExtents([])).toEqual({ width: 0, height: 0 });
    expect(formationCentre([])).toEqual({ x: 0, y: 0 });
  });

  it('AC1 (a) — keeps the planned anchor when it is already well away from the player', () => {
    const formation = { width: 84, height: 48 };
    const anchor = { x: 200, y: 100 };
    const player = { x: 480, y: 460 };

    const portal = placeWavePortal({
      formation,
      anchor,
      playfield: FIELD,
      player,
      rng: DETERMINISTIC_RNG,
    });

    expect(portal).toEqual(anchor);
    expect(distance(portal, player)).toBeGreaterThanOrEqual(84);
  });

  it('AC1 (b) — rejects a candidate that is too close to the player', () => {
    const formation = { width: 84, height: 48 };
    const anchor = { x: 466, y: 144 };
    const player = { x: 466, y: 144 }; // Player sitting on the planned anchor.

    const portal = placeWavePortal({
      formation,
      anchor,
      playfield: FIELD,
      player,
      rng: DETERMINISTIC_RNG,
    });

    // D_MIN = max(84, 48) = 84 away from the player's live position.
    expect(distance(portal, player)).toBeGreaterThanOrEqual(84);
    // The whole formation still fits inside the playfield (edge margin).
    expect(portal.x).toBeGreaterThanOrEqual(20 + 84 / 2);
    expect(portal.x).toBeLessThanOrEqual(960 - 20 - 84 / 2);
    expect(portal.y).toBeGreaterThanOrEqual(20 + 48 / 2);
    expect(portal.y).toBeLessThanOrEqual(540 - 20 - 48 / 2);
  });

  it('AC2 (c) — projects the player along its velocity and avoids that position too', () => {
    const formation = { width: 120, height: 40 };
    const anchor = { x: 480, y: 120 };
    // Moving straight up at 95 px/s: the 2 s projection lands at (480, 210),
    // only 90 px from the anchor — inside D_MIN even though the live position
    // (480, 400) is 280 px away.
    const movingPlayer = { x: 480, y: 400, vx: 0, vy: -95 };
    const projected = {
      x: movingPlayer.x + movingPlayer.vx * WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
      y: movingPlayer.y + movingPlayer.vy * WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS,
    };
    expect(distance(anchor, projected)).toBeLessThan(120);
    expect(distance(anchor, movingPlayer)).toBeGreaterThanOrEqual(120);

    const portal = placeWavePortal({
      formation,
      anchor,
      playfield: FIELD,
      player: movingPlayer,
      rng: DETERMINISTIC_RNG,
    });

    // Both the live position and the projected position are D_MIN clear.
    expect(distance(portal, movingPlayer)).toBeGreaterThanOrEqual(120);
    expect(distance(portal, projected)).toBeGreaterThanOrEqual(120);

    // A stationary player at the same spot would keep the planned anchor —
    // proving the projection (not just the live position) drove the move.
    const stationary = placeWavePortal({
      formation,
      anchor,
      playfield: FIELD,
      player: { x: 480, y: 400 },
      rng: DETERMINISTIC_RNG,
    });
    expect(stationary).toEqual(anchor);
  });

  it('AC4 (d) — falls back to the furthest available candidate and never enters the player hull', () => {
    // A formation almost as wide as the playfield: the portal is pinned near
    // the horizontal centre and D_MIN (900) can never be met.
    const formation = { width: 900, height: 100 };
    const player = { x: 480, y: 100 };
    const anchor = { x: 480, y: 100 };

    const portal = placeWavePortal({
      formation,
      anchor,
      playfield: FIELD,
      player,
      rng: DETERMINISTIC_RNG,
    });

    // The furthest available candidate is at the far vertical edge.
    expect(portal.y).toBeGreaterThan(400);
    expect(portal.y).toBeLessThanOrEqual(540 - 20);
    // Never inside the player's hull radius + safety margin (AC4).
    expect(distance(portal, player)).toBeGreaterThanOrEqual(HULL_SAFE_RADIUS);
  });

  it('AC4 — is deterministic for identical inputs and accepts an injected RNG', () => {
    const request = {
      formation: { width: 84, height: 48 },
      anchor: { x: 466, y: 144 },
      playfield: FIELD,
      player: { x: 466, y: 144 },
      rng: DETERMINISTIC_RNG,
    };
    const first = placeWavePortal(request);
    const second = placeWavePortal(request);
    expect(second).toEqual(first);
  });

  it('AC3 (e) — anchors the whole formation relative to a translated portal', () => {
    const spawns = [
      { x: 100, y: 40, startX: 100, startY: 40, enemyKey: 'a' },
      { x: 160, y: 40, startX: 100, startY: 40, enemyKey: 'b' },
      { x: 130, y: 90, startX: 100, startY: 90, enemyKey: 'c' },
    ];
    const portal = { x: 640, y: 260 };

    const anchored = anchorSpawnsToPortal(spawns, portal);

    // The formation's bounding-box centre now sits exactly on the portal.
    expect(formationCentre(anchored)).toEqual(portal);
    // Spacing/offsets are unchanged — a moved portal moves the whole
    // formation with it.
    expect(anchored[1].x - anchored[0].x).toBe(spawns[1].x - spawns[0].x);
    expect(anchored[2].y - anchored[0].y).toBe(spawns[2].y - spawns[0].y);
    // Formation bases translate with the slots (drift stays anchored).
    const dx = portal.x - formationCentre(spawns).x;
    const dy = portal.y - formationCentre(spawns).y;
    for (const [index, spawn] of anchored.entries()) {
      expect(spawn.x).toBe(spawns[index].x + dx);
      expect(spawn.y).toBe(spawns[index].y + dy);
      expect(spawn.startX).toBe(spawns[index].startX + dx);
      expect(spawn.startY).toBe(spawns[index].startY + dy);
      expect(spawn.enemyKey).toBe(spawns[index].enemyKey);
    }
    // The plan passed in is not mutated.
    expect(spawns[0]).toMatchObject({ x: 100, y: 40, startX: 100, startY: 40 });
    // An empty plan stays empty.
    expect(anchorSpawnsToPortal([], portal)).toEqual([]);
  });

  it('AC5 (f) — with no player (gym), the portal stays at the formation base', () => {
    // A gym has no in-game player ship, so the base is returned untouched —
    // no clamping and no distance rule (behaviour unchanged).
    const anchor = { x: 480, y: 120 };
    expect(
      placeWavePortal({
        formation: { width: 84, height: 48 },
        anchor,
        playfield: FIELD,
        player: null,
      }),
    ).toEqual(anchor);
  });
});

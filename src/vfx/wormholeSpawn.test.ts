/**
 * Unit tests for the wormhole spawn VFX and the enemy growth animation
 * (AH-0MURBER4L00821RR).
 *
 * Assert observable behaviour of the public API — spawn position, tween
 * parameters, registry lifecycle, handle completion, and the dt-driven
 * growth curve — rather than pixel output.
 *
 * The file ends with the test-first contract for the *unmistakable* emergence
 * treatment (AH-0MVNTXTYN001ZXM6): the per-entity outline/flicker/burst
 * contract and the wormhole ring/shockwave contract. The per-entity cases
 * landed with AH-0MVNTXXTA0081S38 and now run as plain `it`s; the wormhole ring
 * cases remain `it.fails` until AH-0MVNTXZ4X00031AU lands (see the block
 * comment before them).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { PHASE_SHIFT_SPLIT_COLOR_CYAN, PHASE_SHIFT_SPLIT_COLOR_RED } from './phaseShiftJuice';
import { PLAYER_DEATH_FLASH_COLOR } from './playerDeathJuice';
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
  type SpawnAnimatable,
  type WormholeHandle,
} from './wormholeSpawn';
import * as wormholeSpawnModule from './wormholeSpawn';

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
    // One tween for the wormhole open animation. (The ring pulse —
    // AH-0MVD2N6AW0073X5M — and the open shockwave add further tweens, so the
    // open animation is pinned by target rather than by a fragile total count.)
    expect(
      tweenSpy.mock.calls.filter(
        (c) =>
          (c[0] as Phaser.Types.Tweens.TweenBuilderConfig).targets ===
          handle.container,
      ),
    ).toHaveLength(1);
    expect(handle.isComplete()).toBe(false);
  });

  it('opens over the configured duration with an ease-out', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnWormholeOpen(scene, 10, 20);

    const config = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === handle.container)!;
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

// ── Emergence shimmer + wormhole glow/pulse ring — test-first contract (AH-0MVD2MTEI002MVIS) ──
//
// Test-first companion for the "Per-enemy emergence shimmer" (AH-0MVD2N333004VDA9)
// and "Wormhole glow/pulse ring" (AH-0MVD2N6AW0073X5M) features of the
// improved Phase Shift epic (AH-0MV8BUKFK003Z23S). Both implementations have
// now landed, so every case below runs as a plain `it` against the real
// helpers/tunables (the RED `it.fails` form was flipped when each feature
// shipped).
//
// Predicted API the upgrade must expose (the contract):
//   constants: ENEMY_SHIMMER_BURST_DURATION_MS (150–250), ENEMY_SHIMMER_FLICKER_HZ
//     (2–4), ENEMY_SHIMMER_ALPHA_MIN/MAX (0..1, min<max), ENEMY_SHIMMER_SCALE_AMOUNT
//     (>0, subtle), ENEMY_SHIMMER_COLOUR_PULSE_RANGE ([min,max] within 0..1),
//     ENEMY_SHIMMER_ENABLE_BURST / ENEMY_SHIMMER_ENABLE_SHIMMER (default on),
//     WORMHOLE_RING_ENABLE (default on), WORMHOLE_RING_COLOR, WORMHOLE_RING_RADIUS,
//     WORMHOLE_RING_PULSE_RANGE ([min,max] scale multipliers), WORMHOLE_RING_GLOW_ALPHA.
//   helpers: updateEnemyShimmer(enemy, dt) -> boolean — drives the per-entity
//     treatment from the spawn-state window (true while growing), never touches
//     the player ship, works headless (no Phaser scene facilities needed).
//
// All steps use deterministic dt ticks (1/60 s or 0.016 s); no wall-clock
// sleeps or randomness.
describe('wormholeSpawn — enemy emergence shimmer (AH-0MVD2MTEI002MVIS, RED until AH-0MVD2N333004VDA9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  // Predicted shimmer helper + constants, read through the module namespace
  // (cast) so the contract compiles before the production interface grows.
  const mod = wormholeSpawnModule as unknown as {
    updateEnemyShimmer: (enemy: SpawnAnimatable, dt: number) => boolean;
    ENEMY_SHIMMER_BURST_DURATION_MS: number;
    ENEMY_SHIMMER_FLICKER_HZ: number;
    ENEMY_SHIMMER_ALPHA_MIN: number;
    ENEMY_SHIMMER_ALPHA_MAX: number;
    ENEMY_SHIMMER_SCALE_AMOUNT: number;
    ENEMY_SHIMMER_COLOUR_PULSE_RANGE: readonly [number, number];
    ENEMY_SHIMMER_ENABLE_BURST: boolean;
    ENEMY_SHIMMER_ENABLE_SHIMMER: boolean;
  };

  function startGrowth(scene: Phaser.Scene) {
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 1);
    // Skip the wormhole-open delay so growth begins on the next call.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);
    return enemy;
  }

  it('activates at the growing edge and sustains until the spawn window ends', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    startSpawnAnimation(enemy, 1);

    // During the wormhole-open delay growth has not begun — no shimmer yet.
    expect(mod.updateEnemyShimmer(enemy, 0.016)).toBe(false);

    // Skip the delay: growth starts → the shimmer treatment becomes active.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);
    expect(mod.updateEnemyShimmer(enemy, 0.016)).toBe(true);

    // Sustains while the enemy keeps growing.
    updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 2);
    expect(mod.updateEnemyShimmer(enemy, 0.016)).toBe(true);

    // Growth completes → spawn state cleared → shimmer stops.
    updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION);
    expect(mod.updateEnemyShimmer(enemy, 0.016)).toBe(false);
  });

  it('applies a subtle alpha flicker between ticks while shimmering (no jump, stays in (0,1])', async () => {
    const scene = await boot();
    const enemy = startGrowth(scene);
    enemy.setAlpha(1);

    mod.updateEnemyShimmer(enemy, 0.016);
    const first = enemy.alpha;
    mod.updateEnemyShimmer(enemy, 0.016);
    const second = enemy.alpha;

    // The flicker must visibly move the alpha (≈2–4 Hz shimmer)…
    expect(second).not.toBe(first);
    // …but stay subtle and bounded.
    expect(Math.abs(second - first)).toBeLessThanOrEqual(0.25);
    expect(enemy.alpha).toBeGreaterThan(0);
    expect(enemy.alpha).toBeLessThanOrEqual(1);
  });

  it('is a no-op on an enemy that is not spawning (alpha untouched)', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50);
    enemy.setAlpha(0.7);

    expect(mod.updateEnemyShimmer(enemy, 0.016)).toBe(false);
    expect(enemy.alpha).toBe(0.7);
  });

  it('exposes the documented tunable ranges and per-layer toggles (default on)', () => {
    // Burst lifetime ≈150–250 ms.
    expect(mod.ENEMY_SHIMMER_BURST_DURATION_MS).toBeGreaterThanOrEqual(150);
    expect(mod.ENEMY_SHIMMER_BURST_DURATION_MS).toBeLessThanOrEqual(250);
    // Subtle alpha flicker ≈2–4 Hz.
    expect(mod.ENEMY_SHIMMER_FLICKER_HZ).toBeGreaterThanOrEqual(2);
    expect(mod.ENEMY_SHIMMER_FLICKER_HZ).toBeLessThanOrEqual(4);
    // Alpha range within (0,1] with min < max.
    expect(mod.ENEMY_SHIMMER_ALPHA_MIN).toBeGreaterThan(0);
    expect(mod.ENEMY_SHIMMER_ALPHA_MIN).toBeLessThan(mod.ENEMY_SHIMMER_ALPHA_MAX);
    expect(mod.ENEMY_SHIMMER_ALPHA_MAX).toBeLessThanOrEqual(1);
    // Subtle scale pulse amount (non-zero, small — must not fight the growth curve).
    expect(mod.ENEMY_SHIMMER_SCALE_AMOUNT).toBeGreaterThan(0);
    expect(mod.ENEMY_SHIMMER_SCALE_AMOUNT).toBeLessThan(0.1);
    // Soft colour-pulse range inside 0..1, min < max.
    const [pulseMin, pulseMax] = mod.ENEMY_SHIMMER_COLOUR_PULSE_RANGE;
    expect(pulseMin).toBeGreaterThanOrEqual(0);
    expect(pulseMax).toBeLessThanOrEqual(1);
    expect(pulseMax).toBeGreaterThan(pulseMin);
    // Both shimmer layers default on.
    expect(mod.ENEMY_SHIMMER_ENABLE_BURST).toBe(true);
    expect(mod.ENEMY_SHIMMER_ENABLE_SHIMMER).toBe(true);
  });

  it('is a safe no-op headless (a bare container-like object never throws)', () => {
    const bare = {
      alpha: 1,
      scaleX: 1,
      getData: () => null,
      setData: () => bare,
      setAlpha: (a: number) => {
        bare.alpha = a;
        return bare;
      },
      setScale: () => bare,
    } as unknown as SpawnAnimatable;

    expect(() => mod.updateEnemyShimmer(bare, 0.016)).not.toThrow();
    expect(mod.updateEnemyShimmer(bare, 0.016)).toBe(false);
  });
});

describe('wormholeSpawn — wormhole glow/pulse ring (ring landed in AH-0MVD2N6AW0073X5M)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WormholeVfxStubScene]);
    return booted.scene;
  }

  const mod = wormholeSpawnModule as unknown as {
    WORMHOLE_RING_ENABLE: boolean;
    WORMHOLE_RING_COLOR: number;
    WORMHOLE_RING_RADIUS: number;
    WORMHOLE_RING_PULSE_RANGE: readonly [number, number];
    WORMHOLE_RING_GLOW_ALPHA: number;
  };

  it('draws one glow/pulse ring as a child of the wormhole container on open', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];

    const handle = spawnWormholeOpen(scene, 100, 120, { registry });

    const ring = handle.container.list.find(
      (o) => o instanceof Phaser.GameObjects.Graphics && o.getData('wormholeRing') === true,
    );
    expect(ring).toBeDefined();
    // Exactly one ring per wormhole (drawn once, not per frame).
    expect(
      handle.container.list.filter((o) => o.getData?.('wormholeRing') === true),
    ).toHaveLength(1);
    expect(registry).toContain(handle.container);
  });

  it('pulses the ring radius with a yoyo tween on open (breathe, not static)', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnWormholeOpen(scene, 0, 0, { registry: [] });

    const pulse = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets !== handle.container && c.repeat === -1);
    expect(pulse).toBeDefined();
    expect(pulse!.yoyo).toBe(true);
  });

  it('stops the ring pulse before destroying the wormhole on close (no tween on a dead object)', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const handle = spawnWormholeOpen(scene, 5, 5, { registry });
    const ring = handle.container.list.find(
      (o) => o.getData?.('wormholeRing') === true,
    )!;
    const killSpy = vi.spyOn(scene.tweens, 'killTweensOf');
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeClose(scene, handle, registry);
    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === handle.container && c.alpha === 0);
    (close!.onComplete as () => void)();

    expect(killSpy).toHaveBeenCalledWith(ring);
    expect(handle.isComplete()).toBe(true);
    expect(registry).toHaveLength(0);
  });

  it('removes and destroys the wormhole exactly once when the close completes; a second close does not double-remove (teardown-clean lifecycle the ring will share)', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const handle = spawnWormholeOpen(scene, 10, 20, { registry });
    const destroySpy = vi.spyOn(handle.container, 'destroy');
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnWormholeClose(scene, handle, registry);
    const close = tweenSpy.mock.calls
      .map((c) => c[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((c) => c.targets === handle.container && c.alpha === 0);
    expect(close).toBeDefined();
    (close!.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(registry).toHaveLength(0);

    // Idempotent teardown: a second close on the same handle never re-removes
    // or destroys a second time (no double-remove / no leak).
    expect(() => spawnWormholeClose(scene, handle, registry)).not.toThrow();
    expect(registry).toHaveLength(0);
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('exposes the ring tunables with documented magnitudes and the enable toggle', () => {
    expect(mod.WORMHOLE_RING_ENABLE).toBe(true);
    // A visible-but-subtle glow colour (neither the phase-shift cyan split
    // nor the player-death palette) and a positive radius.
    expect(mod.WORMHOLE_RING_COLOR).toBeGreaterThan(0);
    expect(mod.WORMHOLE_RING_RADIUS).toBeGreaterThan(0);
    // Radius pulse multipliers that breathe around 1.0 (min < max).
    const [ringMin, ringMax] = mod.WORMHOLE_RING_PULSE_RANGE;
    expect(ringMin).toBeGreaterThan(0);
    expect(ringMax).toBeGreaterThan(ringMin);
    // Soft glow alpha within (0,1].
    expect(mod.WORMHOLE_RING_GLOW_ALPHA).toBeGreaterThan(0);
    expect(mod.WORMHOLE_RING_GLOW_ALPHA).toBeLessThanOrEqual(1);
  });

  it('a wormhole that never opened leaves the registry empty and close() stays a clean no-op (no ring to leak)', async () => {
    const scene = await boot();
    const controller = new WormholeController(scene);
    const registry: Phaser.GameObjects.Container[] = [];

    expect(controller.isOpen).toBe(false);
    controller.close(registry);
    expect(registry).toHaveLength(0);
  });
});

// ── Unmistakable enemy emergence + wormhole ring — test-first contract ──
//
// Contract owner: AH-0MVNTXTYN001ZXM6. The per-entity emergence cases below
// were implemented by AH-0MVNTXXTA0081S38 (per-enemy unmistakable emergence
// shimmer) and now run as plain `it`s; the wormhole ring/shockwave cases stay
// `it.fails` until AH-0MVNTXZ4X00031AU lands — a leftover `it.fails` fails the
// suite (vitest reports a passing `it.fails` as a failure).
//
// Pinned treatment (approach C of AH-0MVNTR89P0022JIU: the emergence path
// stays per-entity — no screen-space effect on it):
//
// Per enemy, while `SpawnState.growing`:
//   - one outline/silhouette ring parented to the entity (never a scene-wide
//     overlay), created on the first shimmering frame, its alpha pulsing
//     between ENEMY_SHIMMER_OUTLINE_ALPHA_MIN/MAX at
//     ENEMY_SHIMMER_OUTLINE_PULSE_HZ, marked with
//     ENEMY_SHIMMER_OUTLINE_DATA_KEY;
//   - the widened alpha flicker (ENEMY_SHIMMER_ALPHA_MIN/MAX, raised to the
//     unmistakable range);
//   - the strengthened leading-edge ripple burst
//     (ENEMY_SHIMMER_BURST_ALPHA_BOOST / ENEMY_SHIMMER_BURST_SCALE_BOOST)
//     decaying to zero within ENEMY_SHIMMER_BURST_DURATION_MS.
// When growth ends: alpha/blend/scale restored, outline destroyed, the
// per-entity shimmer clock dropped.
//
// Wormhole, on open (`spawnWormholeOpen`):
//   - the single ring (existing) at the unmistakable magnitudes;
//   - one one-shot open shockwave child marked with
//     WORMHOLE_SHOCKWAVE_DATA_KEY, expanding and fading over
//     WORMHOLE_SHOCKWAVE_DURATION_MS.
// Both are children of the wormhole container, so the caller's
// `wormholeEffects` registry tracks them for free; the close stops both
// tweens before destroying the container exactly once (a second close is a
// full no-op, and a scene SHUTDOWN never double-removes).
//
// All steps use deterministic dt ticks; no sleeps, wall-clock or randomness.

/** Tunable/toggle reader over the module namespace (widened for the contract). */
const contractModule = wormholeSpawnModule as unknown as {
  updateEnemyShimmer: (enemy: SpawnAnimatable, dt: number) => boolean;
} & Record<string, unknown>;

/** Reads an exported numeric tunable, failing loudly when it is missing. */
function numberTunable(name: string): number {
  const value = contractModule[name];
  expect(typeof value, `${name} must be an exported number`).toBe('number');
  return value as number;
}

/** Reads an exported string tunable, failing loudly when it is missing. */
function stringTunable(name: string): string {
  const value = contractModule[name];
  expect(typeof value, `${name} must be an exported string`).toBe('string');
  return value as string;
}

/** The per-entity shimmer clock data key (private, but part of the contract). */
const SHIMMER_STATE_DATA_KEY = '__shimmerState';

describe('wormholeSpawn — unmistakable enemy emergence (AH-0MVNTXTYN001ZXM6)', () => {
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

  /** Starts growth immediately (skips the wormhole-open delay). */
  function startGrowth(scene: Phaser.Scene, originalScale = 1): SpawnAnimatable {
    const enemy = scene.add.container(50, 50) as SpawnAnimatable;
    startSpawnAnimation(enemy, originalScale);
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);
    return enemy;
  }

  /** The outline/silhouette child of `enemy`, when the layer exists. */
  function outlineOf(
    enemy: SpawnAnimatable,
  ): (Phaser.GameObjects.GameObject & { alpha: number }) | undefined {
    const key = contractModule.ENEMY_SHIMMER_OUTLINE_DATA_KEY;
    if (typeof key !== 'string') return undefined;
    return (
      enemy.list.find((child) => child.getData?.(key) === true) as
        | (Phaser.GameObjects.GameObject & { alpha: number })
        | undefined
    );
  }

  it('creates exactly one pulsing outline/silhouette layer on the first shimmering frame', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50) as SpawnAnimatable;
    startSpawnAnimation(enemy, 1);

    // During the wormhole-open delay growth has not begun — no outline yet.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION / 2);
    expect(contractModule.updateEnemyShimmer(enemy, 0.016)).toBe(false);
    expect(outlineOf(enemy)).toBeUndefined();

    // First growing frame: exactly one outline, parented to the entity.
    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION / 2);
    expect(contractModule.updateEnemyShimmer(enemy, 0.016)).toBe(true);
    const outlineKey = stringTunable('ENEMY_SHIMMER_OUTLINE_DATA_KEY');
    expect(enemy.list.filter((child) => child.getData?.(outlineKey) === true)).toHaveLength(1);

    // Pulses between ticks — but never allocates a second layer.
    const outline = outlineOf(enemy)!;
    const alphas: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      contractModule.updateEnemyShimmer(enemy, 0.02);
      alphas.push(outline.alpha);
    }
    expect(new Set(alphas).size).toBeGreaterThan(1);
    expect(enemy.list.filter((child) => child.getData?.(outlineKey) === true)).toHaveLength(1);

    // The layer is a documented, togglable tunable set (default on).
    expect(contractModule.ENEMY_SHIMMER_ENABLE_OUTLINE).toBe(true);
    expect(numberTunable('ENEMY_SHIMMER_OUTLINE_RADIUS')).toBeGreaterThan(0);
    expect(numberTunable('ENEMY_SHIMMER_OUTLINE_LINE_WIDTH')).toBeGreaterThan(0);
    expect(numberTunable('ENEMY_SHIMMER_OUTLINE_PULSE_HZ')).toBeGreaterThan(0);
    const outlineAlphaMin = numberTunable('ENEMY_SHIMMER_OUTLINE_ALPHA_MIN');
    const outlineAlphaMax = numberTunable('ENEMY_SHIMMER_OUTLINE_ALPHA_MAX');
    expect(outlineAlphaMax).toBeGreaterThan(outlineAlphaMin);
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(outlineAlphaMin - 1e-6);
      expect(alpha).toBeLessThanOrEqual(outlineAlphaMax + 1e-6);
    }
  });

  it('widens the alpha flicker to the unmistakable range, driven verbatim from its tunables', async () => {
    const scene = await boot();
    const enemy = startGrowth(scene);

    const alphaMin = numberTunable('ENEMY_SHIMMER_ALPHA_MIN');
    const alphaMax = numberTunable('ENEMY_SHIMMER_ALPHA_MAX');
    // Unmistakable widening: a deep trough and a full crest.
    expect(alphaMin).toBeLessThanOrEqual(0.35);
    expect(alphaMax).toBeGreaterThanOrEqual(0.95);

    // Let the leading-edge burst decay first (it adds on top of the flicker).
    const burstSeconds = numberTunable('ENEMY_SHIMMER_BURST_DURATION_MS') / 1000;
    contractModule.updateEnemyShimmer(enemy, burstSeconds * 1.25);

    // Sample one full flicker period in fine, deterministic ticks.
    const flickerHz = numberTunable('ENEMY_SHIMMER_FLICKER_HZ');
    const step = 1 / (flickerHz * 64);
    const samples: number[] = [];
    for (let elapsed = 0; elapsed <= 1.5 / flickerHz; elapsed += step) {
      contractModule.updateEnemyShimmer(enemy, step);
      samples.push(enemy.alpha);
    }

    const observedMin = Math.min(...samples);
    const observedMax = Math.max(...samples);
    // The flicker sweeps the range the exported tunables document.
    expect(observedMin).toBeLessThanOrEqual(alphaMin + 0.02);
    expect(observedMax).toBeGreaterThanOrEqual(alphaMax - 0.02);
    expect(observedMax - observedMin).toBeGreaterThanOrEqual(alphaMax - alphaMin - 0.05);
  });

  it('strengthens the leading-edge ripple burst (verbatim tunables) and decays it to zero', async () => {
    const scene = await boot();
    const enemy = startGrowth(scene);

    const burstAlphaBoost = numberTunable('ENEMY_SHIMMER_BURST_ALPHA_BOOST');
    const burstScaleBoost = numberTunable('ENEMY_SHIMMER_BURST_SCALE_BOOST');
    const alphaMax = numberTunable('ENEMY_SHIMMER_ALPHA_MAX');
    // Strengthened, unmistakable magnitudes (up from the subtle 0.15 / 0.06).
    expect(burstAlphaBoost).toBeGreaterThanOrEqual(0.3);
    expect(burstScaleBoost).toBeGreaterThanOrEqual(0.12);

    // Leading edge: a tiny first tick keeps the burst at (almost) full strength.
    contractModule.updateEnemyShimmer(enemy, 0.001);
    const leadingEdgeAlpha = enemy.alpha;

    // One full flicker period later the flicker phase is identical, but the
    // burst window has closed — its contribution is gone.
    const flickerPeriod = 1 / numberTunable('ENEMY_SHIMMER_FLICKER_HZ');
    contractModule.updateEnemyShimmer(enemy, flickerPeriod);
    const settledAlpha = enemy.alpha;

    expect(leadingEdgeAlpha - settledAlpha).toBeGreaterThanOrEqual(0.1);
    // No residual burst after the documented window: back inside the flicker range.
    expect(settledAlpha).toBeLessThanOrEqual(alphaMax + 0.02);
    expect(settledAlpha).toBeGreaterThan(numberTunable('ENEMY_SHIMMER_ALPHA_MIN') - 0.02);
  });

  it('fully restores the entity and destroys the outline when growth ends (no residual state)', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50) as SpawnAnimatable;
    enemy.setAlpha(0.8);
    const originalBlend = enemy.blendMode;
    startSpawnAnimation(enemy, 1.5);

    updateSpawnAnimation(enemy, WORMHOLE_OPEN_DURATION);
    for (let i = 0; i < 5; i += 1) {
      updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION / 10);
      contractModule.updateEnemyShimmer(enemy, ENEMY_GROWTH_DURATION / 10);
    }
    // Mid-growth the treatment is visibly applied (outline + altered alpha).
    expect(outlineOf(enemy)).toBeDefined();
    expect(enemy.alpha).not.toBeCloseTo(0.8, 3);

    // Finish the growth window.
    expect(updateSpawnAnimation(enemy, ENEMY_GROWTH_DURATION)).toBe(false);
    expect(contractModule.updateEnemyShimmer(enemy, 0.016)).toBe(false);

    // Exactly restored, with no leftover layer or clock.
    expect(enemy.alpha).toBeCloseTo(0.8, 5);
    expect(enemy.blendMode).toBe(originalBlend);
    expect(enemy.scaleX).toBeCloseTo(1.5, 5);
    expect(outlineOf(enemy)).toBeUndefined();
    expect(enemy.getData(SHIMMER_STATE_DATA_KEY)).toBeUndefined();
  });

  it('writes the growth scale absolutely within a frame — two shimmer ticks of dt equal one tick of 2·dt', async () => {
    const scene = await boot();
    const step = ENEMY_GROWTH_DURATION / 20;
    const twice = startGrowth(scene);
    const once = startGrowth(scene);

    // Identical growth, then the same total shimmer time in one call versus
    // two calls (same elapsed → same factor → same absolute scale).
    updateSpawnAnimation(twice, step);
    updateSpawnAnimation(once, step);
    const controlScale = once.scaleX; // the pure, un-shimmered growth scale

    contractModule.updateEnemyShimmer(twice, step / 2);
    contractModule.updateEnemyShimmer(twice, step / 2);
    contractModule.updateEnemyShimmer(once, step);

    expect(twice.scaleX).toBeCloseTo(once.scaleX, 6);

    // The pulse stays layered on the growth scale — never rescales it.
    const scaleAmount = numberTunable('ENEMY_SHIMMER_SCALE_AMOUNT');
    const burstScaleBoost = numberTunable('ENEMY_SHIMMER_BURST_SCALE_BOOST');
    expect(twice.scaleX).toBeGreaterThanOrEqual(controlScale * (1 - scaleAmount - 1e-6));
    expect(twice.scaleX).toBeLessThanOrEqual(
      controlScale * (1 + scaleAmount + burstScaleBoost + 1e-6),
    );
  });

  it('never drifts the growth scale across interleaved frames (the real spawn+shimmer call pattern)', async () => {
    // Every spawning entity is updated as
    //   updateSpawnAnimation(entity, dt)   → an ABSOLUTE growth-scale write
    //   updateEnemyShimmer(entity, dt)     → layers its pulse on top
    // each frame (see PlayScene/GymFormationScene/GymLevel `_updateSpawnAnimations`).
    // The shimmered scale must stay inside the documented envelope around the
    // pure growth scale every frame — recovering the growth scale by dividing
    // by a stale per-entity factor (as today) multiplies the pulse factors
    // and drifts the scale outside that envelope. The implementation child
    // (AH-0MVNTXXTA0081S38) must adopt an absolute-value write so the
    // recorded growth scale is the one the spawn animation actually wrote.
    const scene = await boot();
    const step = ENEMY_GROWTH_DURATION / 20;
    const shimmered = startGrowth(scene);
    const control = startGrowth(scene);
    const scaleAmount = numberTunable('ENEMY_SHIMMER_SCALE_AMOUNT');
    const burstScaleBoost = numberTunable('ENEMY_SHIMMER_BURST_SCALE_BOOST');

    for (let i = 0; i < 10; i += 1) {
      updateSpawnAnimation(shimmered, step);
      updateSpawnAnimation(control, step);
      contractModule.updateEnemyShimmer(shimmered, step);
      const ratio = shimmered.scaleX / control.scaleX;
      expect(ratio).toBeGreaterThanOrEqual(1 - scaleAmount - 1e-6);
      expect(ratio).toBeLessThanOrEqual(1 + scaleAmount + burstScaleBoost + 1e-6);
    }
  });

  it('introduces no screen-wide overlay on the emergence path', async () => {
    const scene = await boot();
    const enemy = startGrowth(scene);
    const sceneChildren = scene.children.list.length;
    const camera = scene.cameras.main as Phaser.Cameras.Scene2D.Camera & {
      filters?: { internal?: { list?: unknown[] } };
    };
    const filtersBefore = camera.filters?.internal?.list?.length ?? 0;

    for (let i = 0; i < 20; i += 1) {
      contractModule.updateEnemyShimmer(enemy, 0.016);
    }

    // Every layer stays inside the entity — nothing new at scene level and no
    // camera filter (the emergence path is deliberately not a screen effect).
    expect(scene.children.list).toHaveLength(sceneChildren);
    expect(camera.filters?.internal?.list?.length ?? 0).toBe(filtersBefore);
  });

  it('leaves an entity that never shimmered completely untouched', async () => {
    const scene = await boot();
    const enemy = scene.add.container(50, 50) as SpawnAnimatable;
    enemy.setAlpha(0.6);
    const childrenBefore = enemy.list.length;

    expect(contractModule.updateEnemyShimmer(enemy, 0.016)).toBe(false);

    expect(enemy.alpha).toBeCloseTo(0.6, 5);
    expect(enemy.list).toHaveLength(childrenBefore);
    expect(enemy.getData(SHIMMER_STATE_DATA_KEY)).toBeUndefined();
  });

  it('is a safe no-op headless when the entity cannot host the outline layer', () => {
    // A bare container-like entity with real spawn state but no scene/`add`
    // (so the outline layer cannot be constructed) and no `setBlendMode`.
    const data = new Map<string, unknown>();
    const scaleHolder = { scaleX: 0.01 };
    const bare = {
      alpha: 1,
      x: 0,
      y: 0,
      get scaleX() {
        return scaleHolder.scaleX;
      },
      getData: (key: string) => data.get(key),
      setData: (key: string, value: unknown) => {
        data.set(key, value);
        return bare;
      },
      setAlpha: (alpha: number) => {
        bare.alpha = alpha;
        return bare;
      },
      setScale: (scale: number) => {
        scaleHolder.scaleX = scale;
        return bare;
      },
    } as unknown as SpawnAnimatable;
    startSpawnAnimation(bare, 1, 0);
    updateSpawnAnimation(bare, 0);

    expect(() => contractModule.updateEnemyShimmer(bare, 0.016)).not.toThrow();
    expect(contractModule.updateEnemyShimmer(bare, 0.016)).toBe(true);
  });
});

describe('wormholeSpawn — unmistakable wormhole ring + open shockwave (AH-0MVNTXTYN001ZXM6)', () => {
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

  /** The open-shockwave child of the wormhole container, when the layer exists. */
  function shockwaveOf(handle: WormholeHandle): Phaser.GameObjects.GameObject | undefined {
    const key = contractModule.WORMHOLE_SHOCKWAVE_DATA_KEY;
    if (typeof key !== 'string') return undefined;
    return handle.container.list.find((child) => child.getData?.(key) === true);
  }

  /** The glow/pulse ring child (existing layer) of the wormhole container. */
  function ringOf(handle: WormholeHandle): Phaser.GameObjects.GameObject | undefined {
    return handle.container.list.find((child) => child.getData?.('wormholeRing') === true);
  }

  /** A minimal headless scene stub: add factories but no tween manager. */
  function stubHeadlessScene(): Phaser.Scene {
    const makeGraphics = () => ({
      alpha: 1,
      scale: 1,
      lineStyle: () => undefined,
      strokeCircle: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      strokePath: () => undefined,
      setData: () => undefined,
      getData: () => true,
      setAlpha: () => undefined,
      setScale: () => undefined,
      destroy: () => undefined,
    });
    const makeContainer = (x: number, y: number) => {
      const node = {
        x,
        y,
        alpha: 1,
        active: true,
        list: [] as unknown[],
        add: (child: unknown) => {
          node.list.push(child);
          return node;
        },
        setScale: () => node,
        setAlpha: () => node,
        setData: () => node,
        getData: () => undefined,
        destroy: () => {
          node.active = false;
        },
      };
      return node;
    };
    return {
      add: { container: makeContainer, graphics: makeGraphics },
      // Deliberately no `tweens`: the helpers must degrade to static layers.
    } as unknown as Phaser.Scene;
  }

  it.fails('raises the ring to the unmistakable magnitudes and documents the shockwave tunables', () => {
    // Brighter and larger than the pre-upgrade ring (r 52 / 3 px / α 0.45).
    expect(numberTunable('WORMHOLE_RING_RADIUS')).toBeGreaterThan(52);
    expect(numberTunable('WORMHOLE_RING_RADIUS')).toBeGreaterThanOrEqual(64);
    expect(numberTunable('WORMHOLE_RING_LINE_WIDTH')).toBeGreaterThan(3);
    expect(numberTunable('WORMHOLE_RING_LINE_WIDTH')).toBeGreaterThanOrEqual(4);
    expect(numberTunable('WORMHOLE_RING_GLOW_ALPHA')).toBeGreaterThan(0.45);
    expect(numberTunable('WORMHOLE_RING_GLOW_ALPHA')).toBeGreaterThanOrEqual(0.7);
    expect(numberTunable('WORMHOLE_RING_GLOW_ALPHA')).toBeLessThanOrEqual(1);

    // One-shot open shockwave: documented, togglable, and bounded.
    expect(contractModule.WORMHOLE_SHOCKWAVE_ENABLE).toBe(true);
    expect(numberTunable('WORMHOLE_SHOCKWAVE_RADIUS')).toBeGreaterThan(0);
    expect(numberTunable('WORMHOLE_SHOCKWAVE_LINE_WIDTH')).toBeGreaterThan(0);
    expect(numberTunable('WORMHOLE_SHOCKWAVE_ALPHA')).toBeGreaterThan(0);
    expect(numberTunable('WORMHOLE_SHOCKWAVE_ALPHA')).toBeLessThanOrEqual(1);
    expect(numberTunable('WORMHOLE_SHOCKWAVE_DURATION_MS')).toBeGreaterThanOrEqual(150);
    expect(numberTunable('WORMHOLE_SHOCKWAVE_DURATION_MS')).toBeLessThanOrEqual(1000);
    expect(typeof stringTunable('WORMHOLE_SHOCKWAVE_DATA_KEY')).toBe('string');
    const scaleRange = contractModule.WORMHOLE_SHOCKWAVE_SCALE_RANGE as readonly [number, number];
    expect(Array.isArray(scaleRange)).toBe(true);
    expect(scaleRange[1]).toBeGreaterThan(scaleRange[0]);

    // Distinct palette: neither the phase-shift split nor the player-death flash.
    const ringColour = numberTunable('WORMHOLE_RING_COLOR');
    const shockwaveColour = numberTunable('WORMHOLE_SHOCKWAVE_COLOR');
    for (const colour of [ringColour, shockwaveColour]) {
      expect(colour).toBeGreaterThan(0);
      expect(colour).not.toBe(PHASE_SHIFT_SPLIT_COLOR_CYAN);
      expect(colour).not.toBe(PHASE_SHIFT_SPLIT_COLOR_RED);
      expect(colour).not.toBe(PLAYER_DEATH_FLASH_COLOR);
    }
  });

  it.fails('fires exactly one expanding open shockwave pulse per wormhole', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnWormholeOpen(scene, 120, 90, { registry: [] });

    const shockwaves = handle.container.list.filter(
      (child) => child.getData?.(stringTunable('WORMHOLE_SHOCKWAVE_DATA_KEY')) === true,
    );
    expect(shockwaves).toHaveLength(1);
    expect(shockwaves[0]).toBeInstanceOf(Phaser.GameObjects.Graphics);

    const pulse = tweenSpy.mock.calls
      .map((call) => call[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((config) => config.targets === shockwaves[0]);
    expect(pulse).toBeDefined();
    expect(pulse!.duration).toBe(numberTunable('WORMHOLE_SHOCKWAVE_DURATION_MS'));
    // One-shot: it must not loop like the ring's breathing pulse.
    expect(pulse!.repeat === -1).toBe(false);
    // Expands and fades out.
    expect(pulse!.scale).toBeDefined();
    const alphaTarget = pulse!.alpha as number | { to?: number } | undefined;
    const endsAtZero =
      typeof alphaTarget === 'number' ? alphaTarget === 0 : alphaTarget?.to === 0;
    expect(endsAtZero).toBe(true);
  });

  it.fails('stops the ring and shockwave tweens, then destroys them exactly once on close', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const handle = spawnWormholeOpen(scene, 10, 20, { registry });
    const ring = ringOf(handle);
    const shockwave = shockwaveOf(handle);
    expect(ring).toBeDefined();
    expect(shockwave).toBeDefined();

    const killSpy = vi.spyOn(scene.tweens, 'killTweensOf');
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const destroySpy = vi.spyOn(handle.container, 'destroy');

    spawnWormholeClose(scene, handle, registry);
    const closeTweens = () =>
      tweenSpy.mock.calls
        .map((call) => call[0] as Phaser.Types.Tweens.TweenBuilderConfig)
        .filter((config) => config.targets === handle.container && config.alpha === 0);

    const close = closeTweens()[0];
    expect(close).toBeDefined();
    (close.onComplete as () => void)();

    // Both loops are stopped before the container (and its children) go.
    expect(killSpy).toHaveBeenCalledWith(ring);
    expect(killSpy).toHaveBeenCalledWith(shockwave);
    expect(handle.isComplete()).toBe(true);
    expect(registry).toHaveLength(0);
    expect(destroySpy).toHaveBeenCalledTimes(1);

    // A second close on a complete handle is a full no-op: no second close
    // tween, no double-remove, no second destroy, no re-kill.
    const closeTweenCount = closeTweens().length;
    expect(() => spawnWormholeClose(scene, handle, registry)).not.toThrow();
    expect(closeTweens()).toHaveLength(closeTweenCount);
    expect(registry).toHaveLength(0);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls.filter((call) => call[0] === shockwave)).toHaveLength(1);
  });

  it('tolerates a scene SHUTDOWN that destroys the wormhole before the close completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Container[] = [];
    const handle = spawnWormholeOpen(scene, 10, 20, { registry });
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    spawnWormholeClose(scene, handle, registry);
    const close = tweenSpy.mock.calls
      .map((call) => call[0] as Phaser.Types.Tweens.TweenBuilderConfig)
      .find((config) => config.targets === handle.container && config.alpha === 0);

    // CombatScene teardown destroys every registered effect and empties the list.
    for (const effect of registry) effect.destroy();
    registry.length = 0;

    // The late close completion must not double-remove, re-destroy or throw.
    expect(() => (close!.onComplete as () => void)()).not.toThrow();
    expect(registry).toHaveLength(0);
  });

  it.fails('constructs and closes with a stubbed scene that has no tween manager (headless no-op)', () => {
    const scene = stubHeadlessScene();
    const registry: Phaser.GameObjects.Container[] = [];

    let handle: WormholeHandle | undefined;
    expect(() => {
      handle = spawnWormholeOpen(scene, 10, 20, { registry });
    }).not.toThrow();
    expect(handle?.container).toBeDefined();

    expect(() => spawnWormholeClose(scene, handle!, registry)).not.toThrow();
  });
});

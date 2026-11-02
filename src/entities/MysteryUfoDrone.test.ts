/**
 * Mystery UFO collector-drone entity tests (parent AH-0MV9G113S009B37I,
 * child AH-0MVBMPZFE00382DA).
 *
 * The drone is the visible reward behind the `mystery_ufo` power-up: a
 * scaled-down copy of the player ship that seeks the nearest mineral,
 * vacuums minerals whose centre enters its collector radius, flies home when
 * the hold is full or the lifetime expires, and pays exactly the held
 * minerals into the sink before disappearing.
 *
 * Every test asserts observable behaviour through the entity's public API
 * (state, held minerals, position, payout sink, rendered graphics) — no
 * source-grepping and no re-implementation of production logic.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { resolvePowerUpAtLevel } from '../powerups/powerUpLevels';
import {
  MINERAL_DEPOSIT_COLOR,
  MINERAL_DEPOSIT_VALUE,
  SHIP_COLOR,
  SHIP_SIZE,
} from '../core/constants';
import { bootScene, BootedGame } from '../test/gameHarness';
import { Mineral } from './Mineral';
import {
  MYSTERY_UFO_DRONE_ARRIVE_DISTANCE,
  MYSTERY_UFO_DRONE_COLOR,
  MYSTERY_UFO_DRONE_DOME_COLOR,
  MYSTERY_UFO_DRONE_LIGHT_COLOR,
  MYSTERY_UFO_DRONE_LIGHT_COUNT,
  saucerGeometry,
  MYSTERY_UFO_DRONE_DEPTH,
  MYSTERY_UFO_DRONE_SIZE,
  MYSTERY_UFO_DRONE_SPEED,
  MysteryUfoDrone,
  MysteryUfoDroneConfig,
} from './MysteryUfoDrone';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('MysteryUfoDroneHarness');
  }
}

/** Phaser Graphics command ids (src/gameobjects/graphics/Commands.js). */
const LINE_STYLE = 6;

/** Level-0 resolved tuning from the shared curve (parent AC3 defaults). */
function levelZeroConfig(
  overrides: Partial<MysteryUfoDroneConfig> = {},
): MysteryUfoDroneConfig {
  const stats = resolvePowerUpAtLevel('mystery_ufo', 0);
  return {
    x: 100,
    y: 100,
    lifetime: stats.mysteryUfoLifetime ?? 5,
    capacity: stats.mysteryUfoCapacity ?? 10,
    collectorRadius: stats.mysteryUfoRadius ?? 20,
    ...overrides,
  };
}

function makeMineral(scene: Phaser.Scene, x: number, y: number): Mineral {
  return new Mineral(scene, { x, y });
}

/** A red deposit worth `MINERAL_DEPOSIT_VALUE` (AH-0MVJ79739008396I). */
function makeDeposit(scene: Phaser.Scene, x: number, y: number): Mineral {
  return new Mineral(scene, {
    x,
    y,
    color: MINERAL_DEPOSIT_COLOR,
    value: MINERAL_DEPOSIT_VALUE,
  });
}

describe('MysteryUfoDrone collector entity', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HarnessScene]);
    return booted.scene;
  }

  function makeDrone(
    scene: Phaser.Scene,
    overrides: Partial<MysteryUfoDroneConfig> = {},
  ): MysteryUfoDrone {
    return new MysteryUfoDrone(scene, levelZeroConfig(overrides));
  }

  // ── Level-0 tuning ───────────────────────────────────────────────

  it('takes its level-0 tuning from the shared power-up curve (5 s / 10 / 20 px)', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);

    expect(drone.lifetimeSeconds).toBe(5);
    expect(drone.capacity).toBe(10);
    expect(drone.collectorRadius).toBe(20);
    expect(drone.droneState).toBe('seek');
    expect(drone.alive).toBe(true);
    expect(drone.heldMinerals).toBe(0);
  });

  it('accepts resolved higher-level values over the level-0 defaults', async () => {
    const scene = await boot();
    const stats = resolvePowerUpAtLevel('mystery_ufo', 6);
    const drone = makeDrone(scene, {
      lifetime: stats.mysteryUfoLifetime,
      capacity: stats.mysteryUfoCapacity,
      collectorRadius: stats.mysteryUfoRadius,
    });

    expect(drone.lifetimeSeconds).toBe(stats.mysteryUfoLifetime);
    expect(drone.capacity).toBe(stats.mysteryUfoCapacity);
    expect(drone.collectorRadius).toBe(stats.mysteryUfoRadius);
    expect(drone.lifetimeSeconds).toBeGreaterThan(5);
    expect(drone.capacity).toBeGreaterThan(10);
    expect(drone.collectorRadius).toBeGreaterThan(20);
  });

  // ── Rendering: a code-drawn scaled-down ship ─────────────────────

  it('renders a code-drawn neon saucer hull (no external art)', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);

    // The drone is itself the drawn entity, added to the scene's display
    // list (no texture/sprite asset is involved).
    expect(drone).toBeInstanceOf(Phaser.GameObjects.Graphics);
    expect(scene.children.exists(drone)).toBe(true);
    expect(drone.visible).toBe(true);
    expect(drone.depth).toBe(MYSTERY_UFO_DRONE_DEPTH);

    // The hull keeps the ship's cyan palette at a smaller size.
    expect(MYSTERY_UFO_DRONE_COLOR).toBe(SHIP_COLOR);
    expect(MYSTERY_UFO_DRONE_SIZE).toBeLessThan(SHIP_SIZE);

    const buf = drone.commandBuffer as number[];
    expect(buf).toContain(LINE_STYLE);
    expect(buf).toContain(MYSTERY_UFO_DRONE_COLOR);
  });

  it('AH-0MVH7ZC5N003JS92 — renders a classic flying saucer (rim, dome, lights)', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);

    // Geometry: a wide disc, a domed hull above it and a ring of lights.
    const g = saucerGeometry(MYSTERY_UFO_DRONE_SIZE);
    expect(g.rimHalfWidth).toBeGreaterThan(g.rimHalfHeight);
    expect(g.domeRadius).toBeGreaterThan(0);
    expect(g.domeOffsetY).toBeLessThan(0);
    expect(g.lights).toHaveLength(MYSTERY_UFO_DRONE_LIGHT_COUNT);
    for (const light of g.lights) {
      expect(light.radius).toBeGreaterThan(0);
      expect(Math.abs(light.x)).toBeLessThanOrEqual(g.rimHalfWidth);
      expect(Math.abs(light.y)).toBeLessThanOrEqual(g.rimHalfHeight);
    }
    // The lights are distinct points around the rim (not stacked).
    const unique = new Set(g.lights.map((l) => `${l.x.toFixed(3)},${l.y.toFixed(3)}`));
    expect(unique.size).toBe(g.lights.length);

    // The draw call emits the saucer's parts: rim + dome strokes in the hull/
    // dome colours, plus the warm running lights.
    const buf = drone.commandBuffer as number[];
    expect(buf).toContain(MYSTERY_UFO_DRONE_COLOR);
    expect(buf).toContain(MYSTERY_UFO_DRONE_DOME_COLOR);
    expect(buf).toContain(MYSTERY_UFO_DRONE_LIGHT_COLOR);
    expect(buf.length).toBeGreaterThan(20);
  });

  // ── Seeking ──────────────────────────────────────────────────────

  it('seeks the nearest live mineral when several are supplied', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);
    const far = makeMineral(scene, 400, 100);
    const near = makeMineral(scene, 160, 100);

    drone.setSeekTargets([far, near]);

    expect(drone.seekTargetX).toBe(near.x);
    expect(drone.seekTargetY).toBe(near.y);
  });

  it('ignores already-collected minerals when choosing a target', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);
    const collected = makeMineral(scene, 120, 100);
    collected.handleOverlap('player');
    const live = makeMineral(scene, 300, 100);

    drone.setSeekTargets([collected, live]);

    expect(drone.seekTargetX).toBe(live.x);
    expect(drone.seekTargetY).toBe(live.y);
  });

  it('clears its target and holds station on an empty field', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);
    drone.setSeekTargets([]);

    drone.updatePosition(0.5);

    expect(drone.seekTargetX).toBeNull();
    expect(drone.seekTargetY).toBeNull();
    expect(drone.x).toBe(100);
    expect(drone.y).toBe(100);
    expect(drone.droneState).toBe('seek');
  });

  it('steers toward the nearest live mineral while seeking', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);
    const mineral = makeMineral(scene, 130, 100);
    drone.setSeekTargets([mineral]);

    drone.updatePosition(0.1); // 0.1 s at 120 px/s ⇒ 12 px

    expect(drone.x).toBeCloseTo(100 + MYSTERY_UFO_DRONE_SPEED * 0.1, 5);
    expect(drone.y).toBe(100);
    expect(drone.droneState).toBe('seek');
    expect(drone.heldMinerals).toBe(0);
  });

  // ── Collecting ───────────────────────────────────────────────────

  it('vacuums a mineral whose centre enters the collector radius', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);
    // Exactly on the collector-radius boundary: `<= radius` counts.
    const mineral = makeMineral(scene, 120, 100);
    drone.setSeekTargets([mineral]);

    drone.updatePosition(0.01);

    expect(drone.heldMinerals).toBe(1);
    expect(drone.droneState).toBe('collect');
    expect(mineral.alive).toBe(false);
    expect(mineral.visible).toBe(false);
  });

  it('leaves a mineral outside the collector radius on the field', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);
    const mineral = makeMineral(scene, 125, 100); // 25 px away > 20 px radius
    drone.setSeekTargets([mineral]);

    drone.updatePosition(0.01);

    expect(drone.heldMinerals).toBe(0);
    expect(drone.droneState).toBe('seek');
    expect(mineral.alive).toBe(true);
    expect(mineral.visible).toBe(true);
  });

  // ── Red deposits: overflow is lost (AH-0MVJ79739008396I) ────────

  it('credits a deposit only up to the remaining capacity and destroys the surplus', async () => {
    const scene = await boot();
    const drone = makeDrone(scene); // capacity 10, collector radius 20
    // Four ordinary dots (hold 4) then a 10-value deposit: only 6 fit.
    const ordinary = [
      makeMineral(scene, 110, 100),
      makeMineral(scene, 90, 100),
      makeMineral(scene, 100, 110),
      makeMineral(scene, 100, 90),
    ];
    const deposit = makeDeposit(scene, 105, 100);
    drone.setSeekTargets([...ordinary, deposit]);

    drone.updatePosition(0.01);

    // Hold grows by at most the free space — the surplus 4 is destroyed with
    // the deposit, never paid into the hold.
    expect(drone.heldMinerals).toBe(10);
    expect(drone.isFull).toBe(true);
    // The deposit is off the field: the surplus is not left behind either.
    expect(deposit.alive).toBe(false);
    expect(deposit.visible).toBe(false);
  });

  it('a deposit that exactly fills the hold credits exactly its value (no doubling)', async () => {
    const scene = await boot();
    const payouts: number[] = [];
    const drone = makeDrone(scene, {
      onPayout: (minerals) => payouts.push(minerals),
    });
    const deposit = makeDeposit(scene, 110, 100);
    drone.setSeekTargets([deposit]);

    drone.updatePosition(0.01); // vacuum the deposit → hold 10 (not 20)
    expect(drone.heldMinerals).toBe(MINERAL_DEPOSIT_VALUE);
    expect(deposit.alive).toBe(false);

    drone.updatePosition(0.01); // home at the spawn point → payout

    expect(payouts).toEqual([MINERAL_DEPOSIT_VALUE]);
  });

  // ── Return and payout ────────────────────────────────────────────

  it('returns and pays out exactly the held minerals once the hold is full', async () => {
    const scene = await boot();
    const payouts: number[] = [];
    const drone = makeDrone(scene, {
      capacity: 2,
      onPayout: (minerals) => payouts.push(minerals),
    });
    drone.setSeekTargets([
      makeMineral(scene, 110, 100),
      makeMineral(scene, 90, 100),
      makeMineral(scene, 100, 115), // third stays on the field (capacity 2)
    ]);

    drone.updatePosition(0.01);

    expect(drone.heldMinerals).toBe(2);
    expect(drone.droneState).toBe('return');
    expect(payouts).toEqual([]);

    // Home defaults to the spawn position — the next tick arrives and pays.
    drone.updatePosition(0.01);

    expect(payouts).toEqual([2]);
    expect(drone.droneState).toBe('gone');
    expect(drone.alive).toBe(false);
    expect(drone.visible).toBe(false);
  });

  it('returns home and pays out when the lifetime expires with a partial hold', async () => {
    const scene = await boot();
    const payouts: number[] = [];
    const drone = makeDrone(scene, {
      lifetime: 1,
      homeX: 400,
      homeY: 100,
      onPayout: (minerals) => payouts.push(minerals),
    });
    // One mineral in radius, then nothing else reachable before the lifetime.
    const mineral = makeMineral(scene, 110, 100);
    drone.setSeekTargets([mineral]);

    drone.updatePosition(0.5); // collect 1, 0.5 s elapsed
    expect(drone.heldMinerals).toBe(1);
    expect(drone.droneState).toBe('collect');
    expect(payouts).toEqual([]);

    drone.updatePosition(0.6); // 1.1 s elapsed ⇒ lifetime expired ⇒ return
    expect(drone.droneState).toBe('return');
    expect(payouts).toEqual([]);

    // Fly the return leg home; payout fires on arrival with exactly 1.
    // Home is ~290 px away at 120 px/s (≈ 2.5 s), so step generously past it.
    for (let i = 0; i < 1000 && drone.alive; i += 1) {
      drone.updatePosition(1 / 60);
    }

    expect(payouts).toEqual([1]);
    expect(drone.droneState).toBe('gone');
    expect(drone.alive).toBe(false);
    // Payout fires on arrival — within the drone's documented arrival
    // threshold of home (it stops on the tick it enters that disc).
    expect(
      Math.hypot(drone.x - 400, drone.y - 100),
    ).toBeLessThanOrEqual(MYSTERY_UFO_DRONE_ARRIVE_DISTANCE);
  });

  it('pays out exactly once — later ticks are no-ops', async () => {
    const scene = await boot();
    const payouts: number[] = [];
    const drone = makeDrone(scene, {
      capacity: 1,
      onPayout: (minerals) => payouts.push(minerals),
    });
    drone.setSeekTargets([makeMineral(scene, 110, 100)]);

    drone.updatePosition(0.01); // full ⇒ return
    drone.updatePosition(0.01); // arrive ⇒ payout
    drone.updatePosition(1);
    drone.updatePosition(1);

    expect(payouts).toEqual([1]);
    expect(drone.droneState).toBe('gone');
  });

  it('tracks the live player position as its return target', async () => {
    const scene = await boot();
    const payouts: number[] = [];
    const drone = makeDrone(scene, {
      capacity: 1,
      onPayout: (minerals) => payouts.push(minerals),
    });
    drone.setSeekTargets([makeMineral(scene, 110, 100)]);
    drone.updatePosition(0.01); // full ⇒ return

    drone.setHomeTarget(100, 400); // the ship moved

    for (let i = 0; i < 200; i += 1) {
      drone.updatePosition(0.05);
      if (payouts.length > 0) break;
    }

    expect(payouts).toEqual([1]);
    expect(drone.x).toBeCloseTo(100, 5);
    expect(drone.y).toBeCloseTo(400, 5);
  });

  // ── Destruction contract ─────────────────────────────────────────

  it('is destroyed by an enemy bullet, keeping its hold readable for the drop', async () => {
    const scene = await boot();
    const payouts: number[] = [];
    const drone = makeDrone(scene, {
      onPayout: (minerals) => payouts.push(minerals),
    });
    drone.setSeekTargets([makeMineral(scene, 110, 100)]);
    drone.updatePosition(0.01);
    expect(drone.heldMinerals).toBe(1);

    const destroyed = drone.onEnemyBullet();

    expect(destroyed).toBe(true);
    expect(drone.destroyed).toBe(true);
    expect(drone.droneState).toBe('destroyed');
    expect(drone.alive).toBe(false);
    expect(drone.visible).toBe(false);
    // The hold is still readable so the shared pass can spill it.
    expect(drone.heldMinerals).toBe(1);
    // Destruction never pays out into the ship's hold.
    expect(payouts).toEqual([]);
  });

  it('is destroyed by an enemy body collision exactly like a bullet', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);

    const destroyed = drone.onEnemyBody();

    expect(destroyed).toBe(true);
    expect(drone.destroyed).toBe(true);
    expect(drone.droneState).toBe('destroyed');
    expect(drone.alive).toBe(false);
  });

  it("cannot be destroyed by the player's own fire", async () => {
    const scene = await boot();
    const drone = makeDrone(scene);

    const destroyed = drone.onPlayerBullet();

    expect(destroyed).toBe(false);
    expect(drone.destroyed).toBe(false);
    expect(drone.alive).toBe(true);
    expect(drone.visible).toBe(true);
    expect(drone.droneState).toBe('seek');
  });

  it('is not destroyed twice by repeated enemy hits', async () => {
    const scene = await boot();
    const drone = makeDrone(scene);

    expect(drone.onEnemyBullet()).toBe(true);
    expect(drone.onEnemyBody()).toBe(false);
    expect(drone.onEnemyBullet()).toBe(false);
  });
});

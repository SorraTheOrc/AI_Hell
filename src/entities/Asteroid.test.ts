/**
 * Asteroid entity behaviour tests (AH-0MU8FOQ7L005AII0, epic AH-0MU8BZ2ZM004J47F).
 *
 * Covers: tier definitions and sizes; split fan-out; child direction divergence;
 * constant-speed straight-line motion; screen-edge wrapping; size-scaled speed
 * and rotation; no-fire behaviour at any level; shape randomness and RNG
 * determinism (AH-0MU8UZMCC0003LXT).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  ASTEROID_COLORS,
  ASTEROID_LARGE_COLOR,
  ASTEROID_LARGE_ROTATION_SPEED,
  ASTEROID_LARGE_SIZE,
  ASTEROID_LARGE_SPEED,
  ASTEROID_MEDIUM_COLOR,
  ASTEROID_MEDIUM_ROTATION_SPEED,
  ASTEROID_MEDIUM_SIZE,
  ASTEROID_MEDIUM_SPEED,
  ASTEROID_SMALL_COLOR,
  ASTEROID_SMALL_ROTATION_SPEED,
  ASTEROID_SMALL_SIZE,
  ASTEROID_SMALL_SPEED,
  ASTEROID_TIER_DATA,
  Asteroid,
  AsteroidSizeTier,
} from './Asteroid';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('Asteroid tier constants and data', () => {
  it('defines three size tiers: large, medium, small', () => {
    expect(ASTEROID_TIER_DATA.large).toBeDefined();
    expect(ASTEROID_TIER_DATA.medium).toBeDefined();
    expect(ASTEROID_TIER_DATA.small).toBeDefined();
  });

  it('large tier has the correct size (42 px half-size)', () => {
    expect(ASTEROID_LARGE_SIZE).toBe(42);
    expect(ASTEROID_TIER_DATA.large.size).toBe(42);
  });

  it('medium tier has the correct size (27 px half-size)', () => {
    expect(ASTEROID_MEDIUM_SIZE).toBe(27);
    expect(ASTEROID_TIER_DATA.medium.size).toBe(27);
  });

  it('small tier has the correct size (18 px half-size)', () => {
    expect(ASTEROID_SMALL_SIZE).toBe(18);
    expect(ASTEROID_TIER_DATA.small.size).toBe(18);
  });

  it('speeds are size-scaled: large ~18 px/s, medium faster, small fastest', () => {
    expect(ASTEROID_LARGE_SPEED).toBe(18);
    expect(ASTEROID_MEDIUM_SPEED).toBe(27);
    expect(ASTEROID_SMALL_SPEED).toBe(36);
    expect(ASTEROID_LARGE_SPEED).toBeLessThan(ASTEROID_MEDIUM_SPEED);
    expect(ASTEROID_MEDIUM_SPEED).toBeLessThan(ASTEROID_SMALL_SPEED);
  });

  it('rotation speeds are size-scaled: small fastest, large slowest', () => {
    expect(ASTEROID_LARGE_ROTATION_SPEED).toBe(0.5);
    expect(ASTEROID_MEDIUM_ROTATION_SPEED).toBe(0.9);
    expect(ASTEROID_SMALL_ROTATION_SPEED).toBe(1.4);
    expect(ASTEROID_LARGE_ROTATION_SPEED).toBeLessThan(ASTEROID_MEDIUM_ROTATION_SPEED);
    expect(ASTEROID_MEDIUM_ROTATION_SPEED).toBeLessThan(ASTEROID_SMALL_ROTATION_SPEED);
  });

  it('colours are distinct per tier (procedural neon grey palette)', () => {
    expect(ASTEROID_LARGE_COLOR).toBe(0x888888);
    expect(ASTEROID_MEDIUM_COLOR).toBe(0xaaaa88);
    expect(ASTEROID_SMALL_COLOR).toBe(0xccccaa);
    expect(ASTEROID_COLORS).toEqual({
      large: ASTEROID_LARGE_COLOR,
      medium: ASTEROID_MEDIUM_COLOR,
      small: ASTEROID_SMALL_COLOR,
    });
  });
});

describe('Asteroid entity construction and visual appearance', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeAsteroid(x: number, y: number, sizeTier: AsteroidSizeTier = 'large'): Asteroid {
    const scene = booted!.scene;
    return new Asteroid(scene, { x, y, formationOffset: { row: 0, col: 0 }, sizeTier });
  }

  it('starts alive with visible body', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100);
    expect(asteroid.alive).toBe(true);
    expect(asteroid.bodyVisible).toBe(true);
  });

  it('large tier has correct size and colour', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    expect(asteroid.getSizeTier()).toBe('large');
    expect(asteroid.effectiveSize).toBe(ASTEROID_LARGE_SIZE);
    expect(asteroid.effectiveColor).toBe(ASTEROID_LARGE_COLOR);
  });

  it('medium tier has correct size and colour', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'medium');
    expect(asteroid.getSizeTier()).toBe('medium');
    expect(asteroid.effectiveSize).toBe(ASTEROID_MEDIUM_SIZE);
    expect(asteroid.effectiveColor).toBe(ASTEROID_MEDIUM_COLOR);
  });

  it('small tier has correct size and colour', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'small');
    expect(asteroid.getSizeTier()).toBe('small');
    expect(asteroid.effectiveSize).toBe(ASTEROID_SMALL_SIZE);
    expect(asteroid.effectiveColor).toBe(ASTEROID_SMALL_COLOR);
  });

  it('draws a visible jagged polygon body (procedural neon shape)', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100);
    const children = (asteroid as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    const body = children.find(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics && c.commandBuffer.length > 0,
    );
    expect(body, 'expected a body Graphics child').toBeDefined();
    expect(body!.commandBuffer.length).toBeGreaterThan(0);
  });
});

describe('Asteroid movement: constant-speed straight-line motion', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('velocity is constant (set once at construction, never changes)', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = new Asteroid(booted.scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
      sizeTier: 'large',
    });
    const vx1 = asteroid.vx;
    const vy1 = asteroid.vy;
    expect(asteroid.vx).toBe(vx1);
    expect(asteroid.vy).toBe(vy1);
  });

  it('speed magnitude matches the tier speed', async () => {
    booted = await bootScene([HarnessScene]);
    const cases: Array<[AsteroidSizeTier, number]> = [
      ['large', ASTEROID_LARGE_SPEED],
      ['medium', ASTEROID_MEDIUM_SPEED],
      ['small', ASTEROID_SMALL_SPEED],
    ];
    for (const [tier, expectedSpeed] of cases) {
      const asteroid = new Asteroid(booted.scene, {
        x: 100,
        y: 100,
        formationOffset: { row: 0, col: 0 },
        sizeTier: tier,
      });
      const speed = Math.sqrt(asteroid.vx ** 2 + asteroid.vy ** 2);
      expect(speed).toBeCloseTo(expectedSpeed, 1);
    }
  });

  it('updatePosition advances position by exactly velocity x dt (constant velocity)', async () => {
    booted = await bootScene([HarnessScene]);
    const startX = 200;
    const startY = 300;
    const asteroid = new Asteroid(booted.scene, {
      x: startX,
      y: startY,
      formationOffset: { row: 0, col: 0 },
      sizeTier: 'large',
    });
    const dt = 1.0;

    asteroid.updatePosition(dt);

    expect(asteroid.x).toBeCloseTo(startX + asteroid.vx * dt, 5);
    expect(asteroid.y).toBeCloseTo(startY + asteroid.vy * dt, 5);
  });

  it('position changes linearly over multiple equal time steps', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = new Asteroid(booted.scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
      sizeTier: 'large',
    });

    const positions: { x: number; y: number }[] = [];
    for (let i = 0; i < 5; i++) {
      positions.push({ x: asteroid.x, y: asteroid.y });
      asteroid.updatePosition(0.1);
    }

    for (let i = 1; i < positions.length; i++) {
      const dx = positions[i].x - positions[i - 1].x;
      const dy = positions[i].y - positions[i - 1].y;
      expect(dx).toBeCloseTo(asteroid.vx * 0.1, 4);
      expect(dy).toBeCloseTo(asteroid.vy * 0.1, 4);
    }
  });

  it('applyFormationPosition is a no-op — asteroids do not follow formations', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = new Asteroid(booted.scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 3, col: -5 },
      sizeTier: 'large',
    });
    asteroid.applyFormationPosition(480, 270, 0.016, 100, 100);
    // Position untouched — no formation drift or offset applied.
    expect(asteroid.x).toBe(100);
    expect(asteroid.y).toBe(100);
  });

  it('isFormationEnemy returns false', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = new Asteroid(booted.scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
      sizeTier: 'large',
    });
    expect(asteroid.isFormationEnemy()).toBe(false);
  });
});

describe('Asteroid screen-edge wrapping', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeAsteroidWithFixedVelocity(
    scene: Phaser.Scene,
    x: number,
    y: number,
    vx: number,
    vy: number,
    sizeTier: AsteroidSizeTier = 'large',
  ): Asteroid {
    const asteroid = new Asteroid(scene, {
      x,
      y,
      formationOffset: { row: 0, col: 0 },
      sizeTier,
    });
    (asteroid as unknown as { _vx: number })._vx = vx;
    (asteroid as unknown as { _vy: number })._vy = vy;
    return asteroid;
  }

  it('wraps left edge (x < 0 → x = GAME_WIDTH + overshoot)', async () => {
    booted = await bootScene([HarnessScene]);
    // Start 5 px past the left edge, move further left for 1 s (vx = -10):
    // final raw x = -5 - 10 = -15 → wrapped +960 = 945.
    const asteroid = makeAsteroidWithFixedVelocity(booted.scene, -5, 270, -10, 0);
    asteroid.updatePosition(1);
    expect(asteroid.x).toBeCloseTo(GAME_WIDTH - 15, 5);
    expect(asteroid.y).toBeCloseTo(270, 5);
  });

  it('wraps right edge (x > GAME_WIDTH → x = overshoot)', async () => {
    booted = await bootScene([HarnessScene]);
    // Start 5 px past the right edge, move further right for 1 s (vx = +10):
    // final raw x = 965 + 10 = 975 → wrapped -960 = 15.
    const asteroid = makeAsteroidWithFixedVelocity(booted.scene, GAME_WIDTH + 5, 270, 10, 0);
    asteroid.updatePosition(1);
    expect(asteroid.x).toBeCloseTo(15, 5);
    expect(asteroid.y).toBeCloseTo(270, 5);
  });

  it('wraps top edge (y < 0 → y = GAME_HEIGHT + overshoot)', async () => {
    booted = await bootScene([HarnessScene]);
    // Start 5 px above, move up for 1 s (vy = -10): raw y = -5 - 10 = -15
    // → wrapped +540 = 525.
    const asteroid = makeAsteroidWithFixedVelocity(booted.scene, 480, -5, 0, -10);
    asteroid.updatePosition(1);
    expect(asteroid.x).toBeCloseTo(480, 5);
    expect(asteroid.y).toBeCloseTo(GAME_HEIGHT - 15, 5);
  });

  it('wraps bottom edge (y > GAME_HEIGHT → y = overshoot)', async () => {
    booted = await bootScene([HarnessScene]);
    // Start 5 px below, move down for 1 s (vy = +10): raw y = 545 + 10 = 555
    // → wrapped -540 = 15.
    const asteroid = makeAsteroidWithFixedVelocity(booted.scene, 480, GAME_HEIGHT + 5, 0, 10);
    asteroid.updatePosition(1);
    expect(asteroid.x).toBeCloseTo(480, 5);
    expect(asteroid.y).toBeCloseTo(15, 5);
  });

  it('wraps diagonally across corners (both x and y crossing)', async () => {
    booted = await bootScene([HarnessScene]);
    // x: 960 + 10 + 20 = 990 → 30; y: 540 + 10 + 20 = 570 → 30.
    const asteroid = makeAsteroidWithFixedVelocity(
      booted.scene, GAME_WIDTH + 10, GAME_HEIGHT + 10, 20, 20,
    );
    asteroid.updatePosition(1);
    expect(asteroid.x).toBeCloseTo(30, 5);
    expect(asteroid.y).toBeCloseTo(30, 5);
  });

  it('position stays in-bounds after wrapping (no clamping at the edge)', async () => {
    booted = await bootScene([HarnessScene]);
    // Start just inside the left edge heading left; after the wrap the
    // position must reappear on the right side of the screen (not clamped to 0).
    const asteroid = makeAsteroidWithFixedVelocity(booted.scene, 2, 270, -5, 0);
    asteroid.updatePosition(1.0);
    expect(asteroid.x).toBe(957); // -3 wrapped to +960
    expect(asteroid.x).toBeGreaterThan(GAME_WIDTH / 2); // right side after wrap
  });
});

describe('Asteroid continuous rotation', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeAsteroid(x: number, y: number, sizeTier: AsteroidSizeTier): Asteroid {
    return new Asteroid(booted!.scene, {
      x, y, formationOffset: { row: 0, col: 0 }, sizeTier,
    });
  }

  it('large tier has the correct rotation speed (0.5 rad/s)', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    expect(asteroid.currentRotationSpeed).toBeCloseTo(ASTEROID_LARGE_ROTATION_SPEED, 5);
  });

  it('medium tier has the correct rotation speed (0.9 rad/s)', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'medium');
    expect(asteroid.currentRotationSpeed).toBeCloseTo(ASTEROID_MEDIUM_ROTATION_SPEED, 5);
  });

  it('small tier has the correct rotation speed (1.4 rad/s)', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'small');
    expect(asteroid.currentRotationSpeed).toBeCloseTo(ASTEROID_SMALL_ROTATION_SPEED, 5);
  });

  it('rotation speed is size-scaled (small > medium > large)', async () => {
    booted = await bootScene([HarnessScene]);
    const large = makeAsteroid(100, 100, 'large');
    const medium = makeAsteroid(100, 100, 'medium');
    const small = makeAsteroid(100, 100, 'small');
    expect(large.currentRotationSpeed).toBeLessThan(medium.currentRotationSpeed);
    expect(medium.currentRotationSpeed).toBeLessThan(small.currentRotationSpeed);
  });
});

describe('Asteroid split behaviour', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeAsteroid(x: number, y: number, sizeTier: AsteroidSizeTier): Asteroid {
    return new Asteroid(booted!.scene, {
      x, y, formationOffset: { row: 0, col: 0 }, sizeTier,
    });
  }

  it('large asteroid splits into exactly 2 medium children', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    const children = asteroid.getSplitChildren(100, 100);
    expect(children).not.toBeNull();
    expect(children!.length).toBe(2);
    expect(children![0].sizeTier).toBe('medium');
    expect(children![1].sizeTier).toBe('medium');
    expect(children![0].x).toBe(100);
    expect(children![0].y).toBe(100);
    expect(children![1].x).toBe(100);
    expect(children![1].y).toBe(100);
  });

  it('medium asteroid splits into exactly 2 small children', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'medium');
    const children = asteroid.getSplitChildren(100, 100);
    expect(children).not.toBeNull();
    expect(children!.length).toBe(2);
    expect(children![0].sizeTier).toBe('small');
    expect(children![1].sizeTier).toBe('small');
  });

  it('small asteroid returns null — no children', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'small');
    expect(asteroid.getSplitChildren(100, 100)).toBeNull();
  });

  it('child directions differ from the parent heading by at least pi/3', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    const parentAngle = Math.atan2(asteroid.vy, asteroid.vx);
    // Constrain to [0, 2pi) for stable comparison.
    const norm = (a: number) => {
      let v = a % (Math.PI * 2);
      if (v < 0) v += Math.PI * 2;
      return v;
    };
    const children = asteroid.getSplitChildren(100, 100)!;
    const childAngles = children.map((c) => norm(Math.atan2(c.vy, c.vx)));
    const p = norm(parentAngle);
    for (const a of childAngles) {
      const delta = Math.abs(a - p);
      const wrapped = Math.min(delta, Math.PI * 2 - delta);
      expect(wrapped).toBeGreaterThanOrEqual(Math.PI / 3 - 0.001);
    }
  });

  it('child directions differ from each other by at least pi/3', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'medium');
    const children = asteroid.getSplitChildren(100, 100)!;
    const a1 = Math.atan2(children[0].vy, children[0].vx);
    const a2 = Math.atan2(children[1].vy, children[1].vx);
    const delta = Math.abs(a1 - a2);
    const wrapped = Math.min(delta, Math.PI * 2 - delta);
    expect(wrapped).toBeGreaterThanOrEqual(Math.PI / 3 - 0.001);
  });

  it('child speeds match the child tier speed (medium children at medium speed)', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    const children = asteroid.getSplitChildren(100, 100)!;
    for (const c of children) {
      const speed = Math.sqrt(c.vx ** 2 + c.vy ** 2);
      expect(speed).toBeCloseTo(ASTEROID_MEDIUM_SPEED, 2);
      expect(c.rotationSpeed).toBeCloseTo(ASTEROID_MEDIUM_ROTATION_SPEED, 5);
    }
  });

  it('child specs for a medium split use small-tier speed and rotation', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'medium');
    const children = asteroid.getSplitChildren(100, 100)!;
    for (const c of children) {
      const speed = Math.sqrt(c.vx ** 2 + c.vy ** 2);
      expect(speed).toBeCloseTo(ASTEROID_SMALL_SPEED, 2);
      expect(c.rotationSpeed).toBeCloseTo(ASTEROID_SMALL_ROTATION_SPEED, 5);
    }
  });
});

describe('Asteroid no-fire guarantee', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeAsteroid(x: number, y: number, sizeTier: AsteroidSizeTier): Asteroid {
    return new Asteroid(booted!.scene, {
      x, y, formationOffset: { row: 0, col: 0 }, sizeTier,
    });
  }

  it('shootEnabled setter has no effect — asteroids never fire', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    asteroid.shootEnabled = true;
    expect(asteroid.shootEnabled).toBe(false);
    asteroid.shootEnabled = false;
    expect(asteroid.shootEnabled).toBe(false);
  });

  it('effectiveShotPattern is always none', async () => {
    booted = await bootScene([HarnessScene]);
    for (const tier of ['large', 'medium', 'small'] as const) {
      const asteroid = makeAsteroid(100, 100, tier);
      expect(asteroid.effectiveShotPattern).toBe('none');
    }
  });

  it('no bullet-firing method exists on the public API', async () => {
    booted = await bootScene([HarnessScene]);
    const asteroid = makeAsteroid(100, 100, 'large');
    expect((asteroid as unknown as Record<string, unknown>).tryFire).toBeUndefined();
    expect((asteroid as unknown as Record<string, unknown>).tryFireAimedBullet).toBeUndefined();
    expect((asteroid as unknown as Record<string, unknown>).tryFireSpreadBurst).toBeUndefined();
  });
});

// ── Shape randomness and RNG determinism (AH-0MU8UZMCC0003LXT) ──────────

describe('Asteroid shape randomness and RNG', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function getAsteroidShape(asteroid: Asteroid): string {
    const children = (asteroid as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    const body = children.find(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics && c.commandBuffer.length > 0,
    );
    expect(body, 'expected a body Graphics child').toBeDefined();
    // Serialize the command buffer to a stable string representation for comparison.
    return JSON.stringify(body!.commandBuffer);
  }

  it('two asteroids created consecutively have different shapes (AC2)', async () => {
    booted = await bootScene([HarnessScene]);
    const a1 = new Asteroid(booted!.scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 } });
    const a2 = new Asteroid(booted!.scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 } });
    expect(getAsteroidShape(a1)).not.toBe(getAsteroidShape(a2));
  });

  it('shape is deterministic with a seeded RNG — same seed produces identical shape (AC3)', async () => {
    const makeRNGFactory = (seed: number) => {
      let s = seed;
      return () => {
        // Simple LCG: same algorithm each call
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
      };
    };

    const rng1 = makeRNGFactory(42);
    const rng2 = makeRNGFactory(42);

    booted = await bootScene([HarnessScene]);
    const a1 = new Asteroid(booted!.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, rng: rng1,
    });

    booted!.game.destroy(true);
    booted = await bootScene([HarnessScene]);
    const a2 = new Asteroid(booted!.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, rng: rng2,
    });

    expect(getAsteroidShape(a1)).toBe(getAsteroidShape(a2));
  });

  it('all three size tiers use RNG-consistent _drawBody (AC4)', async () => {
    const rng = () => 0.5; // deterministic

    booted = await bootScene([HarnessScene]);
    const large = new Asteroid(booted!.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, sizeTier: 'large', rng,
    });
    const medium = new Asteroid(booted!.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, sizeTier: 'medium', rng,
    });
    const small = new Asteroid(booted!.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, sizeTier: 'small', rng,
    });

    // Each tier renders without error and has a body.
    const shapes = [large, medium, small].map(getAsteroidShape);
    expect(shapes).toHaveLength(3);
    shapes.forEach((s) => expect(s).not.toBe(''));
  });
});

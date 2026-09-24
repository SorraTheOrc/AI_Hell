/**
 * Tests for the shared collect (absorb) animation module (AH-0MUBYU600004YU4T).
 *
 * Two layers are covered:
 * - Pure state stepper (`stepCollectAnimation`) — convergence, scale shrink,
 *   shear/rotation morph, completion, determinism (AC1, AC2, AC4).
 * - Thin Phaser entry point (`spawnCollectAnimation`) — Graphics sync,
 *   destruction on completion, and safe no-op when Graphics is null (AC3, AC5).
 */

import { describe, expect, it } from 'vitest';

import {
  COLLECT_ANIMATION_ATTRACT_SPEED,
  COLLECT_ANIMATION_DEFAULT_DURATION,
  COLLECT_ANIMATION_MAX_SHEAR,
  createCollectAnimationState,
  stepCollectAnimation,
  spawnCollectAnimation,
  type CollectGraphics,
} from './collectAnimation';

/** Distance helper (plain maths, no Phaser). */
function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** A recording stub Graphics object. */
function makeGraphics(): CollectGraphics & {
  positions: Array<[number, number]>;
  scales: Array<[number, number | undefined]>;
  rotations: number[];
  destroyed: boolean;
} {
  const g = {
    positions: [] as Array<[number, number]>,
    scales: [] as Array<[number, number | undefined]>,
    rotations: [] as number[],
    destroyed: false,
    setPosition(x: number, y: number): void {
      g.positions.push([x, y]);
    },
    setScale(x: number, y?: number): void {
      g.scales.push([x, y]);
    },
    setRotation(radians: number): void {
      g.rotations.push(radians);
    },
    destroy(): void {
      g.destroyed = true;
    },
  };
  return g;
}

// ── AC1/AC2/AC4: pure state stepper ────────────────────────────────

describe('collectAnimation — pure state stepper (AC1, AC2, AC4)', () => {
  it('creates a deterministic initial state with sensible defaults', () => {
    const state = createCollectAnimationState(100, 50, 10, 20);
    expect(state.x).toBe(100);
    expect(state.y).toBe(50);
    expect(state.startX).toBe(100);
    expect(state.startY).toBe(50);
    expect(state.shipX).toBe(10);
    expect(state.shipY).toBe(20);
    expect(state.elapsed).toBe(0);
    expect(state.duration).toBe(COLLECT_ANIMATION_DEFAULT_DURATION);
    expect(state.progress).toBe(0);
    expect(state.scale).toBe(1);
    expect(state.shear).toBe(0);
    expect(state.complete).toBe(false);
  });

  it('default duration targets ≤ 0.3 s (AC2)', () => {
    expect(COLLECT_ANIMATION_DEFAULT_DURATION).toBeGreaterThan(0);
    expect(COLLECT_ANIMATION_DEFAULT_DURATION).toBeLessThanOrEqual(0.3);
  });

  it('converges on the ship position and completes exactly (AC1)', () => {
    const state = createCollectAnimationState(100, 100, 0, 0, 0.25);
    let prev = dist(state.x, state.y, 0, 0);

    // Step through the animation; distance must not increase.
    for (let i = 0; i < 5; i++) {
      stepCollectAnimation(state, 0, 0, 0.05);
      const d = dist(state.x, state.y, 0, 0);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }

    expect(state.complete).toBe(true);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  it('shrinks scale from 1 toward 0 as it progresses (AC1)', () => {
    const state = createCollectAnimationState(100, 0, 0, 0, 0.2);
    expect(state.scale).toBe(1);
    stepCollectAnimation(state, 0, 0, 0.1);
    expect(state.scale).toBeCloseTo(0.5, 5);
    stepCollectAnimation(state, 0, 0, 0.1);
    expect(state.scale).toBe(0);
  });

  it('advances shear and orients rotation toward the ship (AC4)', () => {
    // Ship directly to the right of the drop → rotation points along +x.
    const state = createCollectAnimationState(50, 0, 150, 0, 0.2);
    stepCollectAnimation(state, 150, 0, 0.1);
    expect(state.shear).toBeGreaterThan(0);
    expect(state.shear).toBeLessThanOrEqual(COLLECT_ANIMATION_MAX_SHEAR);
    expect(state.rotation).toBeCloseTo(0, 3);

    // Full progression reaches the maximum shear.
    stepCollectAnimation(state, 150, 0, 0.1);
    expect(state.shear).toBe(COLLECT_ANIMATION_MAX_SHEAR);
  });

  it('rotation follows the ship direction (downward)', () => {
    const state = createCollectAnimationState(0, 0, 0, 100, 0.2);
    stepCollectAnimation(state, 0, 100, 0.1);
    // Pointing down (+y) in screen space is +π/2.
    expect(state.rotation).toBeCloseTo(Math.PI / 2, 3);
  });

  it('tracks a moving attractor passed to the step (AC1)', () => {
    const state = createCollectAnimationState(100, 100, 0, 0, 0.2);
    stepCollectAnimation(state, 100, 100, 0.1);
    expect(state.shipX).toBe(100);
    expect(state.shipY).toBe(100);
    // Moved toward the new attractor rather than the original origin.
    expect(state.x).toBeGreaterThan(50);
  });

  it('is deterministic for identical inputs (AC2)', () => {
    const a = createCollectAnimationState(80, 40, 10, 10, 0.2);
    const b = createCollectAnimationState(80, 40, 10, 10, 0.2);
    for (let i = 0; i < 4; i++) {
      stepCollectAnimation(a, 10, 10, 0.05);
      stepCollectAnimation(b, 10, 10, 0.05);
    }
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.scale).toBe(b.scale);
    expect(a.shear).toBe(b.shear);
    expect(a.rotation).toBe(b.rotation);
    expect(a.complete).toBe(b.complete);
  });

  it('honours a custom duration (AC2)', () => {
    const state = createCollectAnimationState(100, 0, 0, 0, 0.5);
    stepCollectAnimation(state, 0, 0, 0.25);
    expect(state.progress).toBeCloseTo(0.5, 5);
    expect(state.complete).toBe(false);
    stepCollectAnimation(state, 0, 0, 0.25);
    expect(state.complete).toBe(true);
  });

  it('dt ≤ 0 is a safe no-op', () => {
    const state = createCollectAnimationState(100, 100, 0, 0, 0.2);
    stepCollectAnimation(state, 0, 0, 0);
    stepCollectAnimation(state, 0, 0, -1);
    expect(state.elapsed).toBe(0);
    expect(state.x).toBe(100);
    expect(state.y).toBe(100);
    expect(state.complete).toBe(false);
  });

  it('exposes an attraction speed constant used by the stepper (AC2)', () => {
    expect(COLLECT_ANIMATION_ATTRACT_SPEED).toBeGreaterThan(0);
  });
});

// ── AC3/AC5: Phaser entry point ────────────────────────────────────

describe('spawnCollectAnimation — Phaser entry point (AC3, AC5)', () => {
  it('returns a handle that syncs position, scale, rotation and redraws (AC3)', () => {
    const graphics = makeGraphics();
    const handle = spawnCollectAnimation(graphics, 100, 0, 0, 0, 0.2);

    expect(handle.isComplete()).toBe(false);
    handle.update(0.1);

    expect(graphics.positions.length).toBeGreaterThan(0);
    const [px, py] = graphics.positions[graphics.positions.length - 1];
    expect(px).toBe(handle.state.x);
    expect(py).toBe(handle.state.y);
    expect(graphics.scales.length).toBeGreaterThan(0);
    // scaleY tracks the shrink; scaleX is elongated by shear.
    const [sx, sy] = graphics.scales[graphics.scales.length - 1];
    expect(sy).toBe(handle.state.scale);
    expect(sx!).toBeGreaterThan(sy!);
    expect(graphics.rotations.length).toBeGreaterThan(0);
  });

  it('destroys the Graphics once the animation completes (AC3)', () => {
    const graphics = makeGraphics();
    const handle = spawnCollectAnimation(graphics, 100, 0, 0, 0, 0.2);

    handle.update(0.1);
    expect(graphics.destroyed).toBe(false);

    handle.update(0.1);
    expect(handle.isComplete()).toBe(true);
    expect(graphics.destroyed).toBe(true);
  });

  it('destroy() tears the Graphics down immediately and is idempotent (AC3)', () => {
    const graphics = makeGraphics();
    const handle = spawnCollectAnimation(graphics, 100, 0, 0, 0, 0.2);
    handle.destroy();
    expect(graphics.destroyed).toBe(true);
    expect(() => handle.destroy()).not.toThrow();
  });

  it('update() after completion does not touch the Graphics again (AC3)', () => {
    const graphics = makeGraphics();
    const handle = spawnCollectAnimation(graphics, 100, 0, 0, 0, 0.2);
    handle.update(0.2); // completes and destroys
    const positionsAfterComplete = graphics.positions.length;
    handle.update(0.1); // no-op
    expect(graphics.positions.length).toBe(positionsAfterComplete);
  });

  it('setAttractor re-points the animation at a moving ship (AC3)', () => {
    const graphics = makeGraphics();
    const handle = spawnCollectAnimation(graphics, 100, 100, 0, 0, 0.2);
    handle.setAttractor(200, 200);
    expect(handle.state.shipX).toBe(200);
    expect(handle.state.shipY).toBe(200);
    handle.update(0.1);
    // Pulled toward the new attractor (down-right), not the origin.
    expect(handle.state.x).toBeGreaterThan(100);
    expect(handle.state.y).toBeGreaterThan(100);
  });

  it('is a safe no-op when Graphics is null (AC5)', () => {
    const handle = spawnCollectAnimation(null, 100, 100, 0, 0, 0.2);
    expect(() => handle.update(0.1)).not.toThrow();
    expect(() => handle.setAttractor(1, 2)).not.toThrow();
    expect(() => handle.destroy()).not.toThrow();
    // Nothing to animate → complete immediately, no crash.
    expect(handle.isComplete()).toBe(true);
  });

  it('is a safe no-op when Graphics is undefined (AC5)', () => {
    const handle = spawnCollectAnimation(undefined, 100, 100, 0, 0, 0.2);
    expect(() => handle.update(0.1)).not.toThrow();
    expect(handle.isComplete()).toBe(true);
  });

  it('uses the default duration when none is supplied (AC2, AC3)', () => {
    const graphics = makeGraphics();
    const handle = spawnCollectAnimation(graphics, 100, 0, 0, 0);
    expect(handle.state.duration).toBe(COLLECT_ANIMATION_DEFAULT_DURATION);
  });
});

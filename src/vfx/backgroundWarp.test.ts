/**
 * Unit tests for the hyperspace warp transition VFX
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEBCNC005G7XW).
 *
 * Assert observable behaviour of the public API — the exported single-source
 * timeline, the deterministic plan, the per-layer toggles and the
 * `update(dt)` / `isComplete()` / `destroy()` lifecycle — rather than pixel
 * output, mirroring `splitBurst.test.ts` and `phaseShiftJuice.test.ts`.
 *
 * No wall-clock waits and no randomness: every step advances the effect with an
 * explicit `update(dt)` tick, which is the contract the `PlayScene` wiring
 * (AH-0MVSEBW8L009O3JD) consumes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import {
  BACKGROUND_DIM_DEPTH,
  BACKGROUND_WARP_DEPTH,
  GAME_HEIGHT,
  GAME_WIDTH,
  LEVEL_TRANSITION_SECONDS,
} from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  BACKGROUND_WARP_DISTORTION_COLOR,
  BACKGROUND_WARP_DISTORTION_PHASE_SECONDS,
  BACKGROUND_WARP_DISTORTION_SCALE_FROM,
  BACKGROUND_WARP_DISTORTION_SCALE_TO,
  BACKGROUND_WARP_DISTORTION_START_SECONDS,
  BACKGROUND_WARP_DURATION_SECONDS,
  BACKGROUND_WARP_ENABLE_DISTORTION,
  BACKGROUND_WARP_ENABLE_FLASH,
  BACKGROUND_WARP_ENABLE_STREAKS,
  BACKGROUND_WARP_FLASH_ALPHA,
  BACKGROUND_WARP_FLASH_COLOR,
  BACKGROUND_WARP_FLASH_END_SECONDS,
  BACKGROUND_WARP_FLASH_PHASE_SECONDS,
  BACKGROUND_WARP_FLASH_START_SECONDS,
  BACKGROUND_WARP_MAX_STREAKS,
  BACKGROUND_WARP_STREAK_COLOR_INNER,
  BACKGROUND_WARP_STREAK_COLOR_OUTER,
  BACKGROUND_WARP_STREAK_COUNT,
  BACKGROUND_WARP_STREAK_PHASE_SECONDS,
  BACKGROUND_WARP_STREAK_SPEED,
  BACKGROUND_WARP_STREAK_START_SECONDS,
  createBackgroundWarp,
  planBackgroundWarp,
  resolveBackgroundWarpLayers,
  warpPhaseAt,
} from './backgroundWarp';
import { PLAYER_DEATH_FLASH_COLOR } from './playerDeathJuice';

/** Minimal bootable scene for the warp VFX. */
class WarpStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'WarpStubScene' });
  }
}

/** Every phase start/end in timeline order, for the ordering assertions. */
const PHASE_BOUNDARIES: readonly number[] = [
  BACKGROUND_WARP_STREAK_START_SECONDS,
  BACKGROUND_WARP_STREAK_START_SECONDS + BACKGROUND_WARP_STREAK_PHASE_SECONDS,
  BACKGROUND_WARP_DISTORTION_START_SECONDS,
  BACKGROUND_WARP_DISTORTION_START_SECONDS + BACKGROUND_WARP_DISTORTION_PHASE_SECONDS,
  BACKGROUND_WARP_FLASH_START_SECONDS,
  BACKGROUND_WARP_FLASH_END_SECONDS,
];

describe('backgroundWarp — timeline is a single source of truth', () => {
  it('derives its duration from LEVEL_TRANSITION_SECONDS (no duplicated literal)', () => {
    expect(BACKGROUND_WARP_DURATION_SECONDS).toBe(LEVEL_TRANSITION_SECONDS);
    expect(BACKGROUND_WARP_DURATION_SECONDS).toBeGreaterThan(0);
  });

  it('orders the three phases, keeps them non-overlapping and sums to the duration', () => {
    // Ordered: every boundary is at or after the previous one.
    for (let i = 1; i < PHASE_BOUNDARIES.length; i++) {
      expect(PHASE_BOUNDARIES[i]).toBeGreaterThanOrEqual(PHASE_BOUNDARIES[i - 1]);
    }

    // Non-overlapping: each phase starts where the previous one ends.
    expect(BACKGROUND_WARP_DISTORTION_START_SECONDS).toBeCloseTo(
      BACKGROUND_WARP_STREAK_START_SECONDS + BACKGROUND_WARP_STREAK_PHASE_SECONDS,
      10,
    );
    expect(BACKGROUND_WARP_FLASH_START_SECONDS).toBeCloseTo(
      BACKGROUND_WARP_DISTORTION_START_SECONDS + BACKGROUND_WARP_DISTORTION_PHASE_SECONDS,
      10,
    );

    // Sum: the flash phase closes the window exactly on the transition pause,
    // so the effect can never outlive the level transition.
    expect(
      BACKGROUND_WARP_STREAK_PHASE_SECONDS +
        BACKGROUND_WARP_DISTORTION_PHASE_SECONDS +
        BACKGROUND_WARP_FLASH_PHASE_SECONDS,
    ).toBeCloseTo(BACKGROUND_WARP_DURATION_SECONDS, 10);
    expect(BACKGROUND_WARP_FLASH_END_SECONDS).toBeCloseTo(
      BACKGROUND_WARP_DURATION_SECONDS,
      10,
    );
  });

  it('gives every phase a positive length', () => {
    expect(BACKGROUND_WARP_STREAK_PHASE_SECONDS).toBeGreaterThan(0);
    expect(BACKGROUND_WARP_DISTORTION_PHASE_SECONDS).toBeGreaterThan(0);
    expect(BACKGROUND_WARP_FLASH_PHASE_SECONDS).toBeGreaterThan(0);
  });

  it('reports the phase for a given elapsed time, ending in complete', () => {
    expect(warpPhaseAt(0)).toBe('streaks');
    expect(warpPhaseAt(BACKGROUND_WARP_DISTORTION_START_SECONDS - 0.01)).toBe('streaks');
    expect(warpPhaseAt(BACKGROUND_WARP_DISTORTION_START_SECONDS)).toBe('distortion');
    expect(warpPhaseAt(BACKGROUND_WARP_FLASH_START_SECONDS - 0.01)).toBe('distortion');
    expect(warpPhaseAt(BACKGROUND_WARP_FLASH_START_SECONDS)).toBe('flash');
    expect(warpPhaseAt(BACKGROUND_WARP_DURATION_SECONDS)).toBe('complete');
    expect(warpPhaseAt(BACKGROUND_WARP_DURATION_SECONDS + 5)).toBe('complete');
  });
});

describe('backgroundWarp — exported magnitudes and per-layer toggles', () => {
  it('draws a fixed, bounded number of streaks', () => {
    expect(Number.isInteger(BACKGROUND_WARP_STREAK_COUNT)).toBe(true);
    expect(BACKGROUND_WARP_STREAK_COUNT).toBeGreaterThan(0);
    expect(BACKGROUND_WARP_STREAK_COUNT).toBeLessThanOrEqual(BACKGROUND_WARP_MAX_STREAKS);
    // A hard cap keeps the full-screen effect bounded on low-end hardware.
    expect(BACKGROUND_WARP_MAX_STREAKS).toBeLessThanOrEqual(200);
    expect(BACKGROUND_WARP_STREAK_SPEED).toBeGreaterThan(0);
  });

  it('uses the wormhole/phase-shift violet→cyan language, distinct from death juice', () => {
    expect(BACKGROUND_WARP_STREAK_COLOR_OUTER).not.toBe(BACKGROUND_WARP_STREAK_COLOR_INNER);
    expect(BACKGROUND_WARP_FLASH_COLOR).not.toBe(PLAYER_DEATH_FLASH_COLOR);
    expect(BACKGROUND_WARP_DISTORTION_COLOR).not.toBe(BACKGROUND_WARP_STREAK_COLOR_INNER);
  });

  it('exports a scale range and a flash peak alpha within (0, 1]', () => {
    expect(BACKGROUND_WARP_DISTORTION_SCALE_FROM).toBe(1);
    expect(BACKGROUND_WARP_DISTORTION_SCALE_TO).toBeGreaterThan(
      BACKGROUND_WARP_DISTORTION_SCALE_FROM,
    );
    expect(BACKGROUND_WARP_FLASH_ALPHA).toBeGreaterThan(0);
    expect(BACKGROUND_WARP_FLASH_ALPHA).toBeLessThanOrEqual(1);
  });

  it('sits just above the background layer and below gameplay', () => {
    expect(BACKGROUND_WARP_DEPTH).toBeGreaterThan(BACKGROUND_DIM_DEPTH);
    expect(BACKGROUND_WARP_DEPTH).toBeLessThan(0);
  });

  it('exposes the three layer toggles as booleans, on by default', () => {
    expect(typeof BACKGROUND_WARP_ENABLE_STREAKS).toBe('boolean');
    expect(typeof BACKGROUND_WARP_ENABLE_DISTORTION).toBe('boolean');
    expect(typeof BACKGROUND_WARP_ENABLE_FLASH).toBe('boolean');
    expect(BACKGROUND_WARP_ENABLE_STREAKS).toBe(true);
    expect(BACKGROUND_WARP_ENABLE_DISTORTION).toBe(true);
    expect(BACKGROUND_WARP_ENABLE_FLASH).toBe(true);
  });

  it('resolves the layer set from the toggles, with per-call overrides', () => {
    expect(resolveBackgroundWarpLayers()).toEqual({
      streaks: BACKGROUND_WARP_ENABLE_STREAKS,
      distortion: BACKGROUND_WARP_ENABLE_DISTORTION,
      flash: BACKGROUND_WARP_ENABLE_FLASH,
    });
    expect(resolveBackgroundWarpLayers({ enableFlash: false })).toEqual({
      streaks: true,
      distortion: true,
      flash: false,
    });
  });
});

describe('backgroundWarp — deterministic plan', () => {
  it('produces byte-identical layer parameters for the same level pair', () => {
    const first = planBackgroundWarp(3, 4);
    const second = planBackgroundWarp(3, 4);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('varies with the level pair (each jump looks slightly different)', () => {
    const forward = JSON.stringify(planBackgroundWarp(1, 2));
    const reverse = JSON.stringify(planBackgroundWarp(2, 1));
    const later = JSON.stringify(planBackgroundWarp(7, 8));

    expect(forward).not.toBe(reverse);
    expect(forward).not.toBe(later);
  });

  it('never calls Math.random (seeded generator only)', () => {
    const randomSpy = vi.spyOn(Math, 'random');

    planBackgroundWarp(5, 6);
    planBackgroundWarp(6, 7);

    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it('plans bounded, well-formed streak geometry', () => {
    const plan = planBackgroundWarp(2, 3);

    expect(plan.streaks.length).toBe(BACKGROUND_WARP_STREAK_COUNT);
    expect(plan.streaks.length).toBeLessThanOrEqual(BACKGROUND_WARP_MAX_STREAKS);
    for (const streak of plan.streaks) {
      expect(Number.isFinite(streak.angle)).toBe(true);
      expect(streak.angle).toBeGreaterThanOrEqual(0);
      expect(streak.angle).toBeLessThan(Math.PI * 2);
      expect(streak.outerRadius).toBeGreaterThan(streak.innerRadius);
      expect(streak.innerRadius).toBeGreaterThanOrEqual(0);
      expect(streak.width).toBeGreaterThan(0);
      expect([BACKGROUND_WARP_STREAK_COLOR_OUTER, BACKGROUND_WARP_STREAK_COLOR_INNER]).toContain(
        streak.colour,
      );
    }
    expect(plan.durationSeconds).toBe(BACKGROUND_WARP_DURATION_SECONDS);
  });

  it('accepts out-of-range levels without throwing (total function)', () => {
    expect(() => planBackgroundWarp(0, 0)).not.toThrow();
    expect(() => planBackgroundWarp(Number.NaN, Number.POSITIVE_INFINITY)).not.toThrow();
  });
});

describe('createBackgroundWarp — layers', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WarpStubScene]);
    return booted.scene;
  }

  it('renders every layer inside one container above the background', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 1, toLevel: 2 });

    expect(scene.children.list).toContain(warp.container);
    expect(warp.container.depth).toBe(BACKGROUND_WARP_DEPTH);
    expect(warp.container.scrollFactorX).toBe(0);
    expect(warp.container.scrollFactorY).toBe(0);
    // Three layers: streaks + distortion are Graphics, the flash is a Rectangle.
    expect(warp.container.list).toHaveLength(3);
    expect(warp.container.list.filter((child) => child instanceof Phaser.GameObjects.Graphics))
      .toHaveLength(2);
    expect(warp.container.list.filter((child) => child instanceof Phaser.GameObjects.Rectangle))
      .toHaveLength(1);
    // The flash covers the whole canvas.
    const flash = warp.container.list.find(
      (child) => child instanceof Phaser.GameObjects.Rectangle,
    ) as Phaser.GameObjects.Rectangle;
    expect(flash.width).toBe(GAME_WIDTH);
    expect(flash.height).toBe(GAME_HEIGHT);

    warp.destroy();
  });

  it('drops a layer when its toggle is overridden off', async () => {
    const scene = await boot();
    const full = createBackgroundWarp(scene, { fromLevel: 1, toLevel: 2 });
    const noFlash = createBackgroundWarp(scene, {
      fromLevel: 1,
      toLevel: 2,
      enableFlash: false,
    });
    const noStreaks = createBackgroundWarp(scene, {
      fromLevel: 1,
      toLevel: 2,
      enableStreaks: false,
    });

    expect(noFlash.container.list).toHaveLength(full.container.list.length - 1);
    expect(noStreaks.container.list).toHaveLength(full.container.list.length - 1);

    // A disabled layer never contributes a value.
    noFlash.update(BACKGROUND_WARP_FLASH_START_SECONDS);
    expect(noFlash.flashAlpha).toBe(0);

    full.destroy();
    noFlash.destroy();
    noStreaks.destroy();
  });

  it('keeps the background at native scale when the distortion layer is off', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, {
      fromLevel: 1,
      toLevel: 2,
      enableDistortion: false,
    });

    warp.update(BACKGROUND_WARP_DISTORTION_START_SECONDS + 0.05);

    expect(warp.distortionScale).toBe(1);
    warp.destroy();
  });
});

describe('createBackgroundWarp — time-boxed lifecycle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WarpStubScene]);
    return booted.scene;
  }

  it('is not complete before the duration and completes exactly at it', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 4, toLevel: 5 });

    expect(warp.isComplete()).toBe(false);

    warp.update(BACKGROUND_WARP_DURATION_SECONDS - 0.01);
    expect(warp.isComplete()).toBe(false);
    expect(scene.children.list).toContain(warp.container);

    warp.update(0.01);
    expect(warp.isComplete()).toBe(true);
  });

  it('tears the container and every child down on completion (no leaks)', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 4, toLevel: 5 });
    const container = warp.container;

    warp.update(BACKGROUND_WARP_DURATION_SECONDS);

    expect(warp.isComplete()).toBe(true);
    expect(scene.children.list).not.toContain(container);
    expect(container.list).toHaveLength(0);
    expect(container.active).toBe(false);
  });

  it('clamps at completion and ignores further ticks', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 4, toLevel: 5 });

    warp.update(BACKGROUND_WARP_DURATION_SECONDS);
    expect(() => warp.update(10)).not.toThrow();
    expect(warp.isComplete()).toBe(true);
    expect(warp.elapsedSeconds).toBeCloseTo(BACKGROUND_WARP_DURATION_SECONDS, 10);
    expect(warp.flashAlpha).toBe(0);
  });

  it('ignores non-positive and non-finite deltas', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 4, toLevel: 5 });

    warp.update(0);
    warp.update(-1);
    warp.update(Number.NaN);
    warp.update(Number.POSITIVE_INFINITY);

    expect(warp.elapsedSeconds).toBe(0);
    expect(warp.isComplete()).toBe(false);
    warp.destroy();
  });

  it('survives an early destroy mid-warp, idempotently', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 4, toLevel: 5 });
    const container = warp.container;

    warp.update(BACKGROUND_WARP_STREAK_PHASE_SECONDS * 0.5);
    warp.destroy();

    expect(scene.children.list).not.toContain(container);
    expect(container.list).toHaveLength(0);
    // The warp never ran to completion, so it is not "complete".
    expect(warp.isComplete()).toBe(false);

    expect(() => warp.destroy()).not.toThrow();
    expect(() => warp.update(BACKGROUND_WARP_DURATION_SECONDS)).not.toThrow();
    expect(warp.isComplete()).toBe(false);
  });
});

describe('createBackgroundWarp — phase-driven values', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([WarpStubScene]);
    return booted.scene;
  }

  it('holds native scale through the streak phase and zooms during distortion', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 1, toLevel: 2 });

    warp.update(BACKGROUND_WARP_STREAK_PHASE_SECONDS - 0.01);
    expect(warp.distortionScale).toBe(BACKGROUND_WARP_DISTORTION_SCALE_FROM);

    warp.update(0.01 + BACKGROUND_WARP_DISTORTION_PHASE_SECONDS * 0.5);
    expect(warp.distortionScale).toBeGreaterThan(BACKGROUND_WARP_DISTORTION_SCALE_FROM);
    expect(warp.distortionScale).toBeLessThan(BACKGROUND_WARP_DISTORTION_SCALE_TO);

    // The incoming background is shown at native scale during the crossfade.
    warp.update(BACKGROUND_WARP_FLASH_START_SECONDS - warp.elapsedSeconds);
    expect(warp.distortionScale).toBe(BACKGROUND_WARP_DISTORTION_SCALE_FROM);
    warp.destroy();
  });

  it('flashes only inside its own phase, peaking at its start and fading to zero', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 1, toLevel: 2 });

    warp.update(BACKGROUND_WARP_FLASH_START_SECONDS - 0.01);
    expect(warp.flashAlpha).toBe(0);

    warp.update(0.02);
    expect(warp.flashAlpha).toBeLessThan(BACKGROUND_WARP_FLASH_ALPHA);
    expect(warp.flashAlpha).toBeGreaterThan(BACKGROUND_WARP_FLASH_ALPHA * 0.9);

    warp.update(BACKGROUND_WARP_FLASH_PHASE_SECONDS * 0.5);
    expect(warp.flashAlpha).toBeGreaterThan(0);
    expect(warp.flashAlpha).toBeLessThan(BACKGROUND_WARP_FLASH_ALPHA * 0.5);

    warp.update(BACKGROUND_WARP_FLASH_PHASE_SECONDS);
    expect(warp.flashAlpha).toBe(0);
    expect(warp.isComplete()).toBe(true);
  });

  it('peaks at exactly the flash-phase start', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 1, toLevel: 2 });

    warp.update(BACKGROUND_WARP_FLASH_START_SECONDS);

    expect(warp.flashAlpha).toBeCloseTo(BACKGROUND_WARP_FLASH_ALPHA, 10);
    warp.destroy();
  });

  it('renders the streak set converging over the streak phase only', async () => {
    const scene = await boot();
    const warp = createBackgroundWarp(scene, { fromLevel: 1, toLevel: 2 });
    const streaks = warp.container.list[0] as Phaser.GameObjects.Graphics;

    warp.update(BACKGROUND_WARP_STREAK_PHASE_SECONDS * 0.5);
    const midway = streaks.scaleX;
    expect(midway).toBeLessThan(1);
    expect(midway).toBeGreaterThan(0);

    warp.update(BACKGROUND_WARP_STREAK_PHASE_SECONDS * 0.5);
    expect(streaks.scaleX).toBeLessThan(midway);
    expect(streaks.scaleX).toBeGreaterThan(0);
    warp.destroy();
  });
});

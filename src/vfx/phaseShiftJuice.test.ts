/**
 * Phase Shift juice — parameter model + layer/clear contract
 * (parent AH-0MUIYX1EE008FVS8).
 *
 * Exercises the pure parameter model and the edge-triggered controller using
 * the shared Phaser test harness (`VfxStubScene`), so headless tests do not
 * break.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  PHASE_SHIFT_DIM_ALPHA,
  PHASE_SHIFT_DIM_COLOR,
  PHASE_SHIFT_ENABLE_DIM,
  PHASE_SHIFT_ENABLE_SHAKE,
  PHASE_SHIFT_ENABLE_SPLIT,
  PHASE_SHIFT_OVERLAY_DEPTH,
  PHASE_SHIFT_SHAKE_DURATION_MS,
  PHASE_SHIFT_SHAKE_INTENSITY,
  PHASE_SHIFT_SPLIT_ALPHA,
  PHASE_SHIFT_SPLIT_COLOR_CYAN,
  PHASE_SHIFT_SPLIT_COLOR_RED,
  PHASE_SHIFT_SPLIT_OFFSET,
  PhaseShiftJuice,
  resolvePhaseShiftJuiceParams,
} from './phaseShiftJuice';

/** Minimal bootable scene for the VFX helpers. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'VfxStubScene' });
  }
}

describe('resolvePhaseShiftJuiceParams — pure parameter model', () => {
  it('maps every tunable and toggle verbatim', () => {
    const params = resolvePhaseShiftJuiceParams();

    expect(params.overlayDepth).toBe(PHASE_SHIFT_OVERLAY_DEPTH);
    expect(params.dimColor).toBe(PHASE_SHIFT_DIM_COLOR);
    expect(params.dimAlpha).toBe(PHASE_SHIFT_DIM_ALPHA);
    expect(params.dimEnabled).toBe(PHASE_SHIFT_ENABLE_DIM);
    expect(params.splitColorCyan).toBe(PHASE_SHIFT_SPLIT_COLOR_CYAN);
    expect(params.splitColorRed).toBe(PHASE_SHIFT_SPLIT_COLOR_RED);
    expect(params.splitAlpha).toBe(PHASE_SHIFT_SPLIT_ALPHA);
    expect(params.splitOffset).toBe(PHASE_SHIFT_SPLIT_OFFSET);
    expect(params.splitEnabled).toBe(PHASE_SHIFT_ENABLE_SPLIT);
    expect(params.shakeIntensity).toBe(PHASE_SHIFT_SHAKE_INTENSITY);
    expect(params.shakeDurationMs).toBe(PHASE_SHIFT_SHAKE_DURATION_MS);
    expect(params.shakeEnabled).toBe(PHASE_SHIFT_ENABLE_SHAKE);
  });

  it('enables every layer by default', () => {
    expect(PHASE_SHIFT_ENABLE_DIM).toBe(true);
    expect(PHASE_SHIFT_ENABLE_SPLIT).toBe(true);
    expect(PHASE_SHIFT_ENABLE_SHAKE).toBe(true);
    const params = resolvePhaseShiftJuiceParams();
    expect(params.dimEnabled).toBe(true);
    expect(params.splitEnabled).toBe(true);
    expect(params.shakeEnabled).toBe(true);
  });

  it('keeps magnitudes subtle but non-zero', () => {
    const params = resolvePhaseShiftJuiceParams();
    expect(params.dimAlpha).toBeGreaterThan(0);
    expect(params.dimAlpha).toBeLessThanOrEqual(0.5);
    expect(params.splitAlpha).toBeGreaterThan(0);
    expect(params.splitAlpha).toBeLessThanOrEqual(0.5);
    expect(params.shakeIntensity).toBeGreaterThan(0);
    expect(params.shakeIntensity).toBeLessThanOrEqual(0.02);
    expect(params.shakeDurationMs).toBeGreaterThan(0);
    expect(params.splitOffset).toBeGreaterThan(0);
  });
});

describe('PhaseShiftJuice — edge-triggered overlays and shake', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  function spyShake(scene: Phaser.Scene) {
    return vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);
  }

  it('is inactive and creates nothing before the phase activates', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    expect(juice.update(false, 0.016)).toBe(false);
    expect(juice.isActive).toBe(false);
    expect(juice.activeOverlays).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });

  it('applies dim + chromatic split overlays and one shake on activation', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });
    const params = resolvePhaseShiftJuiceParams();

    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.isActive).toBe(true);
    // 1 dim + 2 split overlays.
    expect(juice.activeOverlays).toHaveLength(3);
    expect(registry).toHaveLength(3);
    expect(shake).toHaveBeenCalledTimes(1);
    expect(shake).toHaveBeenCalledWith(
      params.shakeDurationMs,
      params.shakeIntensity,
    );

    for (const overlay of juice.activeOverlays) {
      expect(overlay.depth).toBe(params.overlayDepth);
      expect(overlay.scrollFactorX).toBe(0);
      expect(overlay.scrollFactorY).toBe(0);
    }
  });

  it('does not re-create overlays or re-shake while the phase stays active', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    juice.update(true, 0.016);
    const first = [...juice.activeOverlays];
    juice.update(true, 0.016);
    juice.update(true, 0.016);

    expect(juice.activeOverlays).toHaveLength(3);
    expect(juice.activeOverlays).toEqual(first);
    expect(shake).toHaveBeenCalledTimes(1);
  });

  it('clears every overlay and the registry on expiry', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    juice.update(true, 0.016);
    const overlays = [...juice.activeOverlays];
    const destroySpies = overlays.map((o) => vi.spyOn(o, 'destroy'));

    expect(juice.update(false, 0.016)).toBe(false);
    expect(juice.isActive).toBe(false);
    expect(juice.activeOverlays).toHaveLength(0);
    expect(registry).toHaveLength(0);
    for (const spy of destroySpies) expect(spy).toHaveBeenCalled();
  });

  it('re-applies cleanly on a second phase episode', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    juice.update(true, 0.016);
    juice.update(false, 0.016);
    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.activeOverlays).toHaveLength(3);
    expect(registry).toHaveLength(3);
    expect(shake).toHaveBeenCalledTimes(2);
  });

  it('honours per-layer toggles', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolvePhaseShiftJuiceParams();
    const juice = new PhaseShiftJuice(scene, {
      registry,
      params: { ...params, dimEnabled: false, splitEnabled: false, shakeEnabled: false },
    });

    juice.update(true, 0.016);

    expect(juice.activeOverlays).toHaveLength(0);
    expect(registry).toHaveLength(0);
    expect(shake).not.toHaveBeenCalled();
  });

  it('disabling only the split layer leaves just the dim overlay', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, {
      registry,
      params: { ...resolvePhaseShiftJuiceParams(), splitEnabled: false },
    });

    juice.update(true, 0.016);

    expect(juice.activeOverlays).toHaveLength(1);
    expect(registry).toHaveLength(1);
  });

  it('destroy() clears overlays and resets the active flag', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    juice.update(true, 0.016);
    juice.destroy();

    expect(juice.isActive).toBe(false);
    expect(juice.activeOverlays).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });

  it('is a safe no-op with a scene that has no rendering facilities', () => {
    const fakeScene = {} as unknown as Phaser.Scene;
    const juice = new PhaseShiftJuice(fakeScene);

    expect(() => juice.update(true, 0.016)).not.toThrow();
    expect(juice.isActive).toBe(true);
    expect(juice.activeOverlays).toHaveLength(0);
    expect(() => juice.update(false, 0.016)).not.toThrow();
    expect(() => juice.destroy()).not.toThrow();
  });
});

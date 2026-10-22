/**
 * Phase Shift juice — parameter model + layer/clear contract
 * (parent AH-0MUIYX1EE008FVS8).
 *
 * Exercises the pure parameter model and the edge-triggered controller using
 * the shared Phaser test harness (`VfxStubScene`), so headless tests do not
 * break.
 *
 * The camera-shake layer was deliberately removed after a producer review
 * rejected the first cut because the shake made Phase Shift read like the
 * player-death juice. The suite therefore includes an explicit regression
 * test that the phase treatment never shakes the camera.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  PHASE_SHIFT_DIM_ALPHA,
  PHASE_SHIFT_DIM_COLOR,
  PHASE_SHIFT_ENABLE_DIM,
  PHASE_SHIFT_ENABLE_SPLIT,
  PHASE_SHIFT_OVERLAY_DEPTH,
  PHASE_SHIFT_SPLIT_ALPHA,
  PHASE_SHIFT_SPLIT_COLOR_CYAN,
  PHASE_SHIFT_SPLIT_COLOR_RED,
  PHASE_SHIFT_SPLIT_OFFSET,
  PhaseShiftJuice,
  resolvePhaseShiftJuiceParams,
  type PhaseShiftJuiceParams,
} from './phaseShiftJuice';
import * as phaseShiftJuiceModule from './phaseShiftJuice';

/** Minimal bootable scene for the VFX helpers. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'VfxStubScene' });
  }
}

// ── Phase Shift juice upgrade — test-first contract (AH-0MVD2MPJ1005O53Z) ──
//
// Test-first companion for the "Player phase-shift juice: vivid split +
// activation burst + shimmer" upgrade (AH-0MVD2MXAB004K0V4, parent epic
// AH-0MV8BUKFK003Z23S). RED against today's module (split α 0.10 / 3 px,
// no oscillation, no flicker, no burst, no colour-pulse), so every case runs
// under Vitest's `it.fails(...)` — the repo's expected-failure convention
// (see `src/waves/campaignInvariants.test.ts`): the assertion genuinely
// fails now while the suite stays green at the build → test → commit gate.
// When the juice upgrade lands, flip each `it.fails` back to a plain `it`.
//
// Predicted API the upgrade must expose (the contract):
//   constants: PHASE_SHIFT_SPLIT_ALPHA (~0.20), PHASE_SHIFT_SPLIT_OFFSET (~6),
//     PHASE_SHIFT_OSCILLATION_PERIOD, PHASE_SHIFT_FLICKER_HZ (2–4),
//     PHASE_SHIFT_BURST_DURATION_MS (150–250), PHASE_SHIFT_BURST_ALPHA,
//     PHASE_SHIFT_COLOUR_PULSE_RANGE ([min, max] within 0..1),
//     PHASE_SHIFT_ENABLE_BURST, PHASE_SHIFT_ENABLE_SHIMMER.
//   params fields mirror each constant camelCased; the resolved params map
//     every tunable/toggle verbatim from the exported constants.
//
// All steps use deterministic dt ticks (0.016 s); no sleeps or randomness.
//
// Read the params through this predicted shape (cast) today so the contract
// tests compile before the production interface grows.
interface PredictedJuiceParams extends PhaseShiftJuiceParams {
  /** Slow oscillation period (s) of the pulsing split. */
  oscillationPeriod?: number;
  /** Subtle alpha flicker rate (Hz), ≈2–4. */
  flickerHz?: number;
  /** Activation burst lifetime (ms), ≈150–250. */
  burstDurationMs?: number;
  /** Activation burst peak alpha. */
  burstAlpha?: number;
  /** Soft colour-pulse range [min, max] between the two split hues. */
  colourPulseRange?: readonly [number, number];
  /** Whether the activation-burst layer set is enabled. */
  burstEnabled?: boolean;
  /** Whether the continuous shimmer layers are enabled. */
  shimmerEnabled?: boolean;
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
  });

  it('enables both visual layers by default', () => {
    expect(PHASE_SHIFT_ENABLE_DIM).toBe(true);
    expect(PHASE_SHIFT_ENABLE_SPLIT).toBe(true);
    const params = resolvePhaseShiftJuiceParams();
    expect(params.dimEnabled).toBe(true);
    expect(params.splitEnabled).toBe(true);
  });

  it('exposes no camera-shake layer (keeps Phase Shift distinct from player death)', () => {
    const params = resolvePhaseShiftJuiceParams() as unknown as Record<string, unknown>;
    expect(Object.keys(params)).not.toContain('shakeEnabled');
    expect(Object.keys(params)).not.toContain('shakeIntensity');
    expect(Object.keys(params)).not.toContain('shakeDurationMs');
  });

  it('keeps magnitudes subtle but non-zero', () => {
    const params = resolvePhaseShiftJuiceParams();
    expect(params.dimAlpha).toBeGreaterThan(0);
    expect(params.dimAlpha).toBeLessThanOrEqual(0.5);
    expect(params.splitAlpha).toBeGreaterThan(0);
    expect(params.splitAlpha).toBeLessThanOrEqual(0.5);
    expect(params.splitOffset).toBeGreaterThan(0);
  });
});

describe('PhaseShiftJuice — edge-triggered overlays', () => {
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

  it('applies dim + chromatic split overlays on activation without shaking the camera', async () => {
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
    // Regression: Phase Shift must not shake the camera (player-death overlap).
    expect(shake).not.toHaveBeenCalled();

    for (const overlay of juice.activeOverlays) {
      expect(overlay.depth).toBe(params.overlayDepth);
      expect(overlay.scrollFactorX).toBe(0);
      expect(overlay.scrollFactorY).toBe(0);
    }
  });

  it('does not re-create overlays while the phase stays active', async () => {
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
    expect(shake).not.toHaveBeenCalled();
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

  it('re-applies cleanly on a second phase episode without ever shaking', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    juice.update(true, 0.016);
    juice.update(false, 0.016);
    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.activeOverlays).toHaveLength(3);
    expect(registry).toHaveLength(3);
    expect(shake).not.toHaveBeenCalled();
  });

  it('honours per-layer toggles', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolvePhaseShiftJuiceParams();
    const juice = new PhaseShiftJuice(scene, {
      registry,
      params: { ...params, dimEnabled: false, splitEnabled: false },
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

  it('stays a safe headless no-op when the upgrade layers are enabled (green regression)', () => {
    const fakeScene = {} as unknown as Phaser.Scene;
    const params = {
      ...resolvePhaseShiftJuiceParams(),
      burstEnabled: true,
      shimmerEnabled: true,
      burstDurationMs: 200,
      burstAlpha: 0.5,
    } as unknown as PhaseShiftJuiceParams;
    const juice = new PhaseShiftJuice(fakeScene, { params });

    expect(() => juice.update(true, 0.016)).not.toThrow();
    expect(juice.activeOverlays).toHaveLength(0);
    expect(() => juice.update(false, 0.016)).not.toThrow();
    expect(() => juice.destroy()).not.toThrow();
  });

  // ── Upgrade contract — params model (RED until AH-0MVD2MXAB004K0V4) ──

  it.fails('maps the new vivid-split / oscillation / flicker / burst / colour-pulse tunables verbatim', () => {
    const mod = phaseShiftJuiceModule as unknown as Record<string, unknown>;
    const params = resolvePhaseShiftJuiceParams() as unknown as PredictedJuiceParams;

    // Vivid split: alpha raised from 0.10 toward ~0.20, offset from 3 px toward ~6 px.
    expect(params.splitAlpha).toBeGreaterThanOrEqual(0.15);
    expect(params.splitAlpha).toBeLessThanOrEqual(0.3);
    expect(params.splitOffset).toBeGreaterThanOrEqual(5);
    expect(params.splitOffset).toBeLessThanOrEqual(9);
    // Both still map verbatim to their exported constants.
    expect(params.splitAlpha).toBe(mod.PHASE_SHIFT_SPLIT_ALPHA);
    expect(params.splitOffset).toBe(mod.PHASE_SHIFT_SPLIT_OFFSET);

    // Slow oscillation period (s) of the pulsing split.
    expect(params.oscillationPeriod as number).toBeGreaterThan(0);
    expect(params.oscillationPeriod).toBe(mod.PHASE_SHIFT_OSCILLATION_PERIOD);

    // Subtle alpha flicker ≈2–4 Hz.
    expect(params.flickerHz as number).toBeGreaterThanOrEqual(2);
    expect(params.flickerHz as number).toBeLessThanOrEqual(4);
    expect(params.flickerHz).toBe(mod.PHASE_SHIFT_FLICKER_HZ);

    // Activation burst ≈150–250 ms.
    expect(params.burstDurationMs as number).toBeGreaterThanOrEqual(150);
    expect(params.burstDurationMs as number).toBeLessThanOrEqual(250);
    expect(params.burstDurationMs).toBe(mod.PHASE_SHIFT_BURST_DURATION_MS);
    expect(params.burstAlpha as number).toBeGreaterThan(0);
    expect(params.burstAlpha).toBe(mod.PHASE_SHIFT_BURST_ALPHA);

    // Soft colour-pulse range [min, max] inside 0..1 with min < max.
    expect(params.colourPulseRange).toBeDefined();
    const [pulseMin, pulseMax] = params.colourPulseRange ?? [0, 0];
    expect(pulseMin).toBeGreaterThanOrEqual(0);
    expect(pulseMax).toBeLessThanOrEqual(1);
    expect(pulseMax).toBeGreaterThan(pulseMin);
  });

  it.fails('exposes and honours the new per-layer burst/shimmer toggles (default on)', () => {
    const mod = phaseShiftJuiceModule as unknown as Record<string, unknown>;
    const params = resolvePhaseShiftJuiceParams() as unknown as PredictedJuiceParams;

    expect(params.burstEnabled).toBe(true);
    expect(params.burstEnabled).toBe(mod.PHASE_SHIFT_ENABLE_BURST);
    expect(params.shimmerEnabled).toBe(true);
    expect(params.shimmerEnabled).toBe(mod.PHASE_SHIFT_ENABLE_SHIMMER);
  });

  it.fails('rising edge creates the burst + shimmer layers; steady update does not duplicate; falling edge clears everything', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, { registry });

    expect(juice.update(true, 0.016)).toBe(true);
    // 1 dim + 2 split + activation-burst layer set + continuous shimmer layers.
    expect(juice.activeOverlays.length).toBeGreaterThan(3);
    const applied = [...juice.activeOverlays];

    // A steady `update(true)` on the same episode must not re-create/duplicate.
    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.activeOverlays).toEqual(applied);
    expect(juice.activeOverlays).toHaveLength(applied.length);
    // The burst/shimmer path must never shake the camera (player-death overlap).
    expect(shake).not.toHaveBeenCalled();

    // Per-layer toggles gate the new layers: both off → base 3-overlay set only.
    const gated = new PhaseShiftJuice(scene, {
      registry: [],
      params: {
        ...resolvePhaseShiftJuiceParams(),
        burstEnabled: false,
        shimmerEnabled: false,
      } as unknown as PhaseShiftJuiceParams,
    });
    gated.update(true, 0.016);
    expect(gated.activeOverlays).toHaveLength(3);

    // Falling edge clears every layer and empties the effect registry.
    expect(juice.update(false, 0.016)).toBe(false);
    expect(juice.activeOverlays).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });
});

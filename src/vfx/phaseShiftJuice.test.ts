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
  type PhaseShiftJuiceOptions,
  type PhaseShiftJuiceParams,
} from './phaseShiftJuice';
import * as phaseShiftJuiceModule from './phaseShiftJuice';
import { PLAYER_DEATH_FLASH_COLOR } from './playerDeathJuice';

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
// AH-0MV8BUKFK003Z23S). The upgrade has now landed: the contract cases below
// run as plain `it` against the real tunables (split α 0.20 / 6 px, slow
// oscillation, ≈2–4 Hz flicker, ~200 ms activation burst, colour-pulse, and
// the per-layer `PHASE_SHIFT_ENABLE_BURST` / `PHASE_SHIFT_ENABLE_SHIMMER`
// toggles).
//
// The resolved params map every tunable/toggle verbatim from the exported
// constants; the default overlay set on the rising edge is
// 1 dim + 2 chromatic split + 2 activation-burst overlays (5).
//
// All steps use deterministic dt ticks (0.016 s); no sleeps or randomness.
//
// `PredictedJuiceParams` is kept as the contract's named type: the fields
// child 1 predicted are now real members of `PhaseShiftJuiceParams`, so the
// erased sub-type is just a readable alias over the real interface.
interface PredictedJuiceParams extends PhaseShiftJuiceParams {}

/**
 * Params with the unmistakable layers (flash / vignette / distortion /
 * sustained filter) explicitly disabled, so the *base* layer-set tests below
 * keep pinning the pre-existing dim + split + activation-surge composition
 * exactly (5 overlays) both before and after the unmistakable treatment lands.
 * The unmistakable default set (7 overlays) is pinned by the contract block at
 * the end of this file.
 */
function baseOnlyParams(): PhaseShiftJuiceParams {
  return {
    ...resolvePhaseShiftJuiceParams(),
    flashEnabled: false,
    vignetteEnabled: false,
  } as unknown as PhaseShiftJuiceParams;
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
    const params = baseOnlyParams();
    const juice = new PhaseShiftJuice(scene, { registry, params });

    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.isActive).toBe(true);
    // 1 dim + 2 split + 2 activation-burst overlays (base set, new layers off).
    expect(juice.activeOverlays).toHaveLength(5);
    expect(registry).toHaveLength(5);
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
    const juice = new PhaseShiftJuice(scene, { registry, params: baseOnlyParams() });

    juice.update(true, 0.016);
    const first = [...juice.activeOverlays];
    juice.update(true, 0.016);
    juice.update(true, 0.016);

    expect(juice.activeOverlays).toHaveLength(5);
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
    const juice = new PhaseShiftJuice(scene, { registry, params: baseOnlyParams() });

    juice.update(true, 0.016);
    juice.update(false, 0.016);
    expect(juice.update(true, 0.016)).toBe(true);
    expect(juice.activeOverlays).toHaveLength(5);
    expect(registry).toHaveLength(5);
    expect(shake).not.toHaveBeenCalled();
  });

  it('honours per-layer toggles', async () => {
    const scene = await boot();
    const shake = spyShake(scene);
    const registry: Phaser.GameObjects.GameObject[] = [];
    const juice = new PhaseShiftJuice(scene, {
      registry,
      params: {
        ...resolvePhaseShiftJuiceParams(),
        dimEnabled: false,
        splitEnabled: false,
        flashEnabled: false,
        vignetteEnabled: false,
      } as unknown as PhaseShiftJuiceParams,
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
      params: {
        ...resolvePhaseShiftJuiceParams(),
        splitEnabled: false,
        flashEnabled: false,
        vignetteEnabled: false,
      } as unknown as PhaseShiftJuiceParams,
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

  it('maps the new vivid-split / oscillation / flicker / burst / colour-pulse tunables verbatim', () => {
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

  it('exposes and honours the new per-layer burst/shimmer toggles (default on)', () => {
    const mod = phaseShiftJuiceModule as unknown as Record<string, unknown>;
    const params = resolvePhaseShiftJuiceParams() as unknown as PredictedJuiceParams;

    expect(params.burstEnabled).toBe(true);
    expect(params.burstEnabled).toBe(mod.PHASE_SHIFT_ENABLE_BURST);
    expect(params.shimmerEnabled).toBe(true);
    expect(params.shimmerEnabled).toBe(mod.PHASE_SHIFT_ENABLE_SHIMMER);
  });

  it('rising edge creates the burst + shimmer layers; steady update does not duplicate; falling edge clears everything', async () => {
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
        flashEnabled: false,
        vignetteEnabled: false,
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

// ── Unmistakable player treatment — test-first contract ─────────────
//
// Contract owner: AH-0MVNTXSQ1000QO12. Implemented by the sibling item
// AH-0MVNTXWJP004DBCW (which flips every `it.fails` below back to a plain
// `it` once the treatment lands — a leftover `it.fails` fails the suite).
//
// Pinned treatment (approach C of AH-0MVNTR89P0022JIU: aggressive activation
// edge / soft sustained state, never camera shake):
//
// Rising edge, in the same frame, exactly once — seven overlays:
//   1 dim           (existing)                NORMAL, params.dimColor / dimAlpha
//   2 split         (existing, widened)       ADD,    params.splitColor* / splitAlpha at ±splitOffset
//   2 surge pair    (existing, strengthened)  ADD,    params.burstAlpha at ±burstOffset
//   1 flash         (new)                     full-screen rectangle in
//                                             params.flashColor / flashAlpha that
//                                             decays to 0 within flashDurationMs
//                                             of deterministic dt ticks
//   1 vignette      (new)                     a Graphics drawing
//                                             params.vignetteBands stroked
//                                             rectangles inward from the screen
//                                             edge in params.vignetteColor /
//                                             vignetteAlpha
// plus the camera-filter distortion burst + sustained filter layers, driven
// through an injected `PhaseFilterDriver` (see `cameraFilters.test.ts`).
//
// Sustained state: the split oscillation / flicker / colour pulse keep running
// and the filter driver's `update(dt)` is ticked every frame — no new game
// objects, no per-frame allocation.
//
// Falling edge: every overlay destroyed, every filter controller cleared
// through `driver.clear()`, the registry emptied. Re-activation creates a
// fresh seven-overlay set (no leaked or duplicated layer).
//
// Renderer fallback: a scene whose renderer is not WebGL (the headless boot
// used here) gets the overlay-only layers and never touches a camera filter
// API. `camera.shake` is never called in any phase.

/** The camera-filter driver surface the treatment consumes (test-first). */
interface PhaseFilterDriver {
  readonly supported: boolean;
  applyBurst(): boolean;
  applySustained(): boolean;
  update(dtSeconds: number): void;
  clear(): void;
}

/** The new unmistakable tunables / toggles the params model must map. */
interface UnmistakableParams {
  flashColor?: number;
  flashAlpha?: number;
  flashDurationMs?: number;
  flashEnabled?: boolean;
  vignetteColor?: number;
  vignetteAlpha?: number;
  vignetteBands?: number;
  vignetteBandWidth?: number;
  vignetteEnabled?: boolean;
  distortionEnabled?: boolean;
  sustainedFilterEnabled?: boolean;
}

/** Juice options widened with the injected filter driver (test-first). */
interface UnmistakableJuiceOptions extends PhaseShiftJuiceOptions {
  filters?: PhaseFilterDriver;
}

/** Reads a (not yet declared) exported tunable by name. */
function tunable(name: string): unknown {
  return (phaseShiftJuiceModule as unknown as Record<string, unknown>)[name];
}

/** Reads a numeric tunable, failing loudly when it is missing. */
function numberTunable(name: string): number {
  const value = tunable(name);
  expect(typeof value, `${name} must be an exported number`).toBe('number');
  return value as number;
}

/** Resolves the params through the unmistakable contract shape. */
function unmistakableParams(): PhaseShiftJuiceParams & UnmistakableParams {
  return resolvePhaseShiftJuiceParams() as PhaseShiftJuiceParams & UnmistakableParams;
}

/** Every live overlay, seen as the loosest object shape the assertions need. */
type LiveOverlay = Phaser.GameObjects.GameObject & {
  alpha: number;
  x: number;
  fillColor?: number;
};

/** The live overlays widened for generic assertions. */
function liveOverlays(juice: PhaseShiftJuice): LiveOverlay[] {
  return juice.activeOverlays as unknown as LiveOverlay[];
}

/** The default unmistakable layer-set size (see the contract above). */
const UNMISTAKABLE_OVERLAY_COUNT = 7;

/** Records the filter-driver calls the treatment makes. */
function makeFakeFilterDriver(supported = true): {
  driver: PhaseFilterDriver;
  calls: { burst: number; sustained: number; updates: number[]; clears: number };
} {
  const calls: { burst: number; sustained: number; updates: number[]; clears: number } = {
    burst: 0,
    sustained: 0,
    updates: [],
    clears: 0,
  };
  const driver: PhaseFilterDriver = {
    supported,
    applyBurst() {
      calls.burst += 1;
      return supported;
    },
    applySustained() {
      calls.sustained += 1;
      return supported;
    },
    update(dt: number) {
      calls.updates.push(dt);
    },
    clear() {
      calls.clears += 1;
    },
  };
  return { driver, calls };
}

describe('resolvePhaseShiftJuiceParams — unmistakable tunables (AH-0MVNTXSQ1000QO12)', () => {
  it.fails('maps every new tunable and toggle verbatim', () => {
    const params = unmistakableParams();

    expect(params.flashColor).toBe(numberTunable('PHASE_SHIFT_FLASH_COLOR'));
    expect(params.flashAlpha).toBe(numberTunable('PHASE_SHIFT_FLASH_ALPHA'));
    expect(params.flashDurationMs).toBe(numberTunable('PHASE_SHIFT_FLASH_DURATION_MS'));
    expect(params.flashEnabled).toBe(tunable('PHASE_SHIFT_ENABLE_FLASH'));
    expect(params.vignetteColor).toBe(numberTunable('PHASE_SHIFT_VIGNETTE_COLOR'));
    expect(params.vignetteAlpha).toBe(numberTunable('PHASE_SHIFT_VIGNETTE_ALPHA'));
    expect(params.vignetteBands).toBe(numberTunable('PHASE_SHIFT_VIGNETTE_BANDS'));
    expect(params.vignetteBandWidth).toBe(numberTunable('PHASE_SHIFT_VIGNETTE_BAND_WIDTH'));
    expect(params.vignetteEnabled).toBe(tunable('PHASE_SHIFT_ENABLE_VIGNETTE'));
    expect(params.distortionEnabled).toBe(tunable('PHASE_SHIFT_ENABLE_DISTORTION'));
    expect(params.sustainedFilterEnabled).toBe(tunable('PHASE_SHIFT_ENABLE_SUSTAINED_FILTER'));
  });

  it.fails('enables every unmistakable layer by default', () => {
    const params = unmistakableParams();

    expect(params.flashEnabled).toBe(true);
    expect(params.vignetteEnabled).toBe(true);
    expect(params.distortionEnabled).toBe(true);
    expect(params.sustainedFilterEnabled).toBe(true);
  });

  it.fails('raises the split and activation-surge magnitudes to the unmistakable range', () => {
    const params = unmistakableParams();

    // Widened chromatic split: α 0.20 → ≈0.45, offset 6 px → ≈14 px.
    expect(params.splitAlpha).toBeGreaterThanOrEqual(0.4);
    expect(params.splitAlpha).toBeLessThanOrEqual(0.6);
    expect(params.splitOffset).toBeGreaterThanOrEqual(12);
    expect(params.splitOffset).toBeLessThanOrEqual(20);
    // Stronger/wider activation surge: α 0.35 → ≈0.7, offset 12 px → ≈26 px.
    expect(params.burstAlpha).toBeGreaterThanOrEqual(0.6);
    expect(params.burstAlpha).toBeLessThanOrEqual(0.85);
    expect(params.burstOffset).toBeGreaterThanOrEqual(20);
    expect(params.burstOffset).toBeLessThanOrEqual(32);
    // Both still map verbatim to their exported constants.
    expect(params.splitAlpha).toBe(numberTunable('PHASE_SHIFT_SPLIT_ALPHA'));
    expect(params.splitOffset).toBe(numberTunable('PHASE_SHIFT_SPLIT_OFFSET'));
    expect(params.burstAlpha).toBe(numberTunable('PHASE_SHIFT_BURST_ALPHA'));
    expect(params.burstOffset).toBe(numberTunable('PHASE_SHIFT_BURST_OFFSET'));
  });

  it.fails('uses a flash / vignette palette distinct from the player-death flash', () => {
    const params = unmistakableParams();

    expect(params.flashColor).not.toBe(PLAYER_DEATH_FLASH_COLOR);
    expect(params.vignetteColor).not.toBe(PLAYER_DEATH_FLASH_COLOR);
    // Magnitudes stay non-zero and bounded so the layers actually read.
    expect(params.flashAlpha).toBeGreaterThan(0);
    expect(params.flashAlpha).toBeLessThanOrEqual(0.8);
    expect(params.flashDurationMs).toBeGreaterThanOrEqual(120);
    expect(params.flashDurationMs).toBeLessThanOrEqual(400);
    expect(params.vignetteAlpha).toBeGreaterThan(0);
    expect(params.vignetteAlpha).toBeLessThanOrEqual(0.7);
    expect(params.vignetteBands).toBeGreaterThanOrEqual(3);
    expect(params.vignetteBandWidth).toBeGreaterThanOrEqual(8);
  });
});

describe('PhaseShiftJuice — unmistakable activation edge and teardown', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  /** Builds the juice with an injected fake filter driver (test seat). */
  function juiceWithFilters(
    scene: Phaser.Scene,
    driver: PhaseFilterDriver,
    params?: PhaseShiftJuiceParams,
  ): { juice: PhaseShiftJuice; registry: Phaser.GameObjects.GameObject[] } {
    const registry: Phaser.GameObjects.GameObject[] = [];
    const options = {
      registry,
      filters: driver,
      ...(params ? { params } : {}),
    } as unknown as UnmistakableJuiceOptions;
    return { juice: new PhaseShiftJuice(scene, options), registry };
  }

  it.fails('creates the full seven-layer activation set exactly once on the rising edge', async () => {
    const scene = await boot();
    const shake = vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);
    const { driver, calls } = makeFakeFilterDriver();
    const { juice, registry } = juiceWithFilters(scene, driver);
    const params = unmistakableParams();

    expect(juice.update(true, 0.016)).toBe(true);
    expect(liveOverlays(juice)).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
    expect(registry).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);

    // The camera-filter burst and the sustained layer fire once, in the same frame.
    expect(calls.burst).toBe(1);
    expect(calls.sustained).toBe(1);

    // The full-screen flash and the vignette are part of the same layer set.
    const flash = liveOverlays(juice).find((o) => o.fillColor === params.flashColor);
    expect(flash).toBeDefined();
    expect(flash?.alpha).toBeGreaterThan(0);
    expect(
      liveOverlays(juice).some((o) => o instanceof Phaser.GameObjects.Graphics),
    ).toBe(true);

    // A second update in the same episode duplicates nothing.
    const applied = liveOverlays(juice);
    juice.update(true, 0.016);
    expect(liveOverlays(juice)).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
    expect(liveOverlays(juice)).toEqual(applied);
    expect(calls.burst).toBe(1);
    expect(calls.sustained).toBe(1);
    expect(registry).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
    // No camera shake in any phase (player-death distinctness).
    expect(shake).not.toHaveBeenCalled();
  });

  it.fails('decays the activation flash to zero within its documented duration', async () => {
    const scene = await boot();
    const { driver } = makeFakeFilterDriver();
    const { juice } = juiceWithFilters(scene, driver);
    const params = unmistakableParams();
    const flashDurationMs = params.flashDurationMs ?? 0;

    juice.update(true, 0.016);
    const flash = liveOverlays(juice).find((o) => o.fillColor === params.flashColor);
    expect(flash).toBeDefined();
    expect(flash!.alpha).toBeGreaterThan(0);

    // Deterministic ticks totalling the documented duration.
    const ticks = 8;
    for (let i = 0; i < ticks; i += 1) {
      juice.update(true, flashDurationMs / 1000 / ticks);
    }

    expect(flash!.alpha).toBeLessThanOrEqual(0.01);
    // The flash object is reused, never re-created mid-episode.
    expect(liveOverlays(juice)).toContain(flash);
  });

  it.fails('ticks the sustained filter layer on every steady update', async () => {
    const scene = await boot();
    const { driver, calls } = makeFakeFilterDriver();
    const { juice } = juiceWithFilters(scene, driver);

    juice.update(true, 0.016);
    juice.update(true, 0.5);
    juice.update(true, 0.25);

    // Every steady tick advances the sustained layer with the frame delta.
    expect(calls.updates.length).toBeGreaterThanOrEqual(2);
    expect(calls.updates.slice(-2)).toEqual([0.5, 0.25]);
    expect(calls.burst).toBe(1);
    expect(calls.sustained).toBe(1);
  });

  it.fails('drives the sustained split oscillation and flicker without allocating objects', async () => {
    const scene = await boot();
    const { driver } = makeFakeFilterDriver();
    const { juice } = juiceWithFilters(scene, driver);

    juice.update(true, 0.016);
    const applied = liveOverlays(juice);
    const initialXs = applied.map((o) => o.x);
    const initialAlphas = applied.map((o) => o.alpha);

    for (let i = 0; i < 12; i += 1) juice.update(true, 0.05);

    // Object-count and identity stability across N ticks (no per-frame allocation).
    expect(liveOverlays(juice)).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
    expect(liveOverlays(juice)).toEqual(applied);
    // The split "breathes": positions and alphas both change over time.
    expect(liveOverlays(juice).map((o) => o.x)).not.toEqual(initialXs);
    expect(liveOverlays(juice).map((o) => o.alpha)).not.toEqual(initialAlphas);
  });

  it('honours the per-layer toggles of the new layers', async () => {
    const scene = await boot();
    const { driver, calls } = makeFakeFilterDriver();
    // All four new layers off: the pre-existing five-overlay set only.
    const disabled = {
      ...unmistakableParams(),
      flashEnabled: false,
      vignetteEnabled: false,
      distortionEnabled: false,
      sustainedFilterEnabled: false,
    } as unknown as PhaseShiftJuiceParams;
    const { juice } = juiceWithFilters(scene, driver, disabled);

    juice.update(true, 0.016);

    expect(liveOverlays(juice)).toHaveLength(5);
    expect(calls.burst).toBe(0);
    expect(calls.sustained).toBe(0);
    expect(calls.updates).toHaveLength(0);
  });

  it.fails('tears the whole unmistakable set down exactly and re-activates fresh', async () => {
    const scene = await boot();
    const shake = vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);
    const { driver, calls } = makeFakeFilterDriver();
    const { juice, registry } = juiceWithFilters(scene, driver);

    juice.update(true, 0.016);
    const first = liveOverlays(juice);
    const destroySpies = first.map((o) => vi.spyOn(o, 'destroy'));

    expect(juice.update(false, 0.016)).toBe(false);
    expect(liveOverlays(juice)).toHaveLength(0);
    expect(registry).toHaveLength(0);
    expect(calls.clears).toBe(1);
    for (const spy of destroySpies) expect(spy).toHaveBeenCalledTimes(1);

    // A second expiry/destroy is a safe no-op (no double teardown).
    juice.destroy();
    for (const spy of destroySpies) expect(spy).toHaveBeenCalledTimes(1);

    // Re-activation produces a fresh, single layer set — no duplicates, no leak.
    juice.update(true, 0.016);
    const second = liveOverlays(juice);
    expect(second).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
    expect(registry).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
    expect(second.some((overlay) => first.includes(overlay))).toBe(false);
    expect(calls.burst).toBe(2);
    expect(calls.sustained).toBe(2);
    expect(shake).not.toHaveBeenCalled();
  });

  it.fails(
    'falls back to the overlay-only layers on a non-WebGL renderer and never touches a filter API',
    async () => {
      const scene = await boot();
      // The headless harness boots a canvas renderer. Present a filter list
      // anyway: the probe must refuse it and nothing may be added to it.
      const touched = vi.fn(() => {
        throw new Error('camera filter API must not be touched on a non-WebGL renderer');
      });
      // The stub mirrors the surface Phaser's `Camera.destroy` teardown needs
      // (`destroy`, `remove`, `clear`) so game teardown stays clean.
      const stubFilterList = () => ({
        list: [] as unknown[],
        addPixelate: touched,
        addBarrel: touched,
        remove: touched,
        clear: touched,
        destroy: () => undefined,
      });
      const internal = stubFilterList();
      const external = stubFilterList();
      Object.defineProperty(scene.cameras.main, 'filters', {
        value: { internal, external },
        configurable: true,
      });

      const registry: Phaser.GameObjects.GameObject[] = [];
      const juice = new PhaseShiftJuice(scene, { registry });

      expect(() => juice.update(true, 0.016)).not.toThrow();
      // Overlay-only: the full seven overlay layers still apply...
      expect(liveOverlays(juice)).toHaveLength(UNMISTAKABLE_OVERLAY_COUNT);
      // ...and no camera filter was added (or even probed destructively).
      expect(internal.list).toHaveLength(0);
      expect(external.list).toHaveLength(0);
      expect(touched).not.toHaveBeenCalled();

      expect(() => {
        for (let i = 0; i < 5; i += 1) juice.update(true, 0.05);
        juice.update(false, 0.016);
      }).not.toThrow();
      expect(touched).not.toHaveBeenCalled();
    },
  );
});

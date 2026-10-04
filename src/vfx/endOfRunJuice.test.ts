/**
 * Tests for the end-of-run juice parameter model
 * (parent AH-0MUTV7632000ZWCB, feature F1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  resolveEndOfRunJuiceParams,
  spawnVictoryFlash,
  spawnVictoryRings,
  spawnVictoryConfetti,
  spawnVictoryJuice,
  ENDOFRUN_VICTORY_RING_COUNT,
  ENDOFRUN_DEFAULT_OUTCOME,
  ENDOFRUN_ENABLE_VICTORY_FLASH,
  ENDOFRUN_ENABLE_VICTORY_PARTICLES,
  ENDOFRUN_ENABLE_VICTORY_RING,
  ENDOFRUN_ENABLE_DEFEAT_VIGNETTE,
  ENDOFRUN_ENABLE_DEFEAT_GLITCH,
  ENDOFRUN_ENABLE_DEFEAT_RING,
  ENDOFRUN_ENABLE_SOUND,
  ENDOFRUN_VICTORY_FLASH_ALPHA,
  ENDOFRUN_VICTORY_PARTICLE_COUNT,
  ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS,
  ENDOFRUN_VICTORY_PARTICLE_VELOCITY,
  ENDOFRUN_VICTORY_PARTICLE_SCALE,
  ENDOFRUN_VICTORY_RING_RADIUS,
  ENDOFRUN_RING_DURATION_MS,
  ENDOFRUN_RING_START_SCALE,
  ENDOFRUN_RING_LINE_WIDTH,
  ENDOFRUN_DEFEAT_VIGNETTE_ALPHA,
  ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS,
  ENDOFRUN_DEFEAT_GLITCH_STEPS,
  ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS,
  ENDOFRUN_DEFEAT_GLITCH_ALPHA,
  ENDOFRUN_DEFEAT_RING_RADIUS,
  ENDOFRUN_VICTORY_COLOR,
  ENDOFRUN_VICTORY_GREEN,
  ENDOFRUN_VICTORY_SPARKLE,
  ENDOFRUN_DEFEAT_COLOR,
  ENDOFRUN_DEFEAT_RED,
  ENDOFRUN_DEFEAT_GRAY,
} from './endOfRunJuice';

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Resolves params for `outcome` and returns the result.
 * A thin wrapper so tests that exercise the outcome values stay readable.
 */
function paramsFor(outcome: string | null | undefined) {
  return resolveEndOfRunJuiceParams(outcome);
}

// ── Outcome coverage ────────────────────────────────────────────────

describe('resolveEndOfRunJuiceParams', () => {
  it('returns victory parameters for "victory"', () => {
    const p = paramsFor('victory');
    expect(p.victoryFlashEnabled).toBe(true);
    expect(p.victoryParticleCount).toBeGreaterThan(0);
    expect(p.victoryRingRadius).toBeGreaterThan(0);
    expect(p.victoryParticlesEnabled).toBe(true);
    expect(p.victoryRingEnabled).toBe(true);
    expect(p.soundEnabled).toBe(true);
  });

  it('returns defeat parameters for "defeat"', () => {
    const p = paramsFor('defeat');
    expect(p.defeatVignetteEnabled).toBe(true);
    expect(p.defeatGlitchEnabled).toBe(true);
    expect(p.defeatRingEnabled).toBe(true);
    expect(p.defeatVignetteAlpha).toBeGreaterThan(0);
    expect(p.defeatGlitchSteps).toBeGreaterThan(0);
    expect(p.soundEnabled).toBe(true);
  });

  it('defaults to victory for unknown strings', () => {
    const p = paramsFor('unknown');
    expect(p.victoryParticlesEnabled).toBe(true);
    expect(p.victoryFlashEnabled).toBe(true);
  });

  it('defaults to victory for null', () => {
    const p = paramsFor(null);
    expect(p.victoryParticlesEnabled).toBe(true);
  });

  it('defaults to victory for undefined', () => {
    const p = paramsFor(undefined);
    expect(p.victoryParticlesEnabled).toBe(true);
  });

  it('defaults to victory for empty string', () => {
    const p = paramsFor('');
    expect(p.victoryParticlesEnabled).toBe(true);
  });

  // ── Victory palette colours ──────────────────────────────────────

  it('victory params carry the correct palette colours', () => {
    const p = paramsFor('victory');
    expect(p.victoryColor).toBe(ENDOFRUN_VICTORY_COLOR);
    expect(p.victoryGreen).toBe(ENDOFRUN_VICTORY_GREEN);
    expect(p.victorySparkle).toBe(ENDOFRUN_VICTORY_SPARKLE);
  });

  // ── Defeat palette colours ───────────────────────────────────────

  it('defeat params carry the correct palette colours', () => {
    const p = paramsFor('defeat');
    expect(p.defeatColor).toBe(ENDOFRUN_DEFEAT_COLOR);
    expect(p.defeatRed).toBe(ENDOFRUN_DEFEAT_RED);
    expect(p.defeatGray).toBe(ENDOFRUN_DEFEAT_GRAY);
  });

  // ── Tunable values are wired into params ─────────────────────────

  it('victory flash params reflect tunable constants', () => {
    const p = paramsFor('victory');
    expect(p.victoryFlashAlpha).toBe(ENDOFRUN_VICTORY_FLASH_ALPHA);
    expect(p.victoryFlashDurationMs).toBeGreaterThan(0);
    expect(p.victoryParticleCount).toBe(ENDOFRUN_VICTORY_PARTICLE_COUNT);
    expect(p.victoryParticleLifespanMs).toBe(ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS);
    expect(p.victoryParticleVelocity).toBe(ENDOFRUN_VICTORY_PARTICLE_VELOCITY);
    expect(p.victoryParticleScale).toBe(ENDOFRUN_VICTORY_PARTICLE_SCALE);
    expect(p.victoryRingRadius).toBe(ENDOFRUN_VICTORY_RING_RADIUS);
  });

  it('defeat params reflect tunable constants', () => {
    const p = paramsFor('defeat');
    expect(p.defeatVignetteAlpha).toBe(ENDOFRUN_DEFEAT_VIGNETTE_ALPHA);
    expect(p.defeatVignetteDurationMs).toBe(ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS);
    expect(p.defeatGlitchSteps).toBe(ENDOFRUN_DEFEAT_GLITCH_STEPS);
    expect(p.defeatGlitchStepDurationMs).toBe(ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS);
    expect(p.defeatGlitchAlpha).toBe(ENDOFRUN_DEFEAT_GLITCH_ALPHA);
    expect(p.defeatRingRadius).toBe(ENDOFRUN_DEFEAT_RING_RADIUS);
  });

  // ── Shared ring params are identical for both outcomes ───────────

  it('ring shared params are the same for victory and defeat', () => {
    const v = paramsFor('victory');
    const d = paramsFor('defeat');
    expect(v.ringDurationMs).toBe(d.ringDurationMs);
    expect(v.ringStartScale).toBe(d.ringStartScale);
    expect(v.ringLineWidth).toBe(d.ringLineWidth);
    expect(v.ringDurationMs).toBe(ENDOFRUN_RING_DURATION_MS);
    expect(v.ringStartScale).toBe(ENDOFRUN_RING_START_SCALE);
    expect(v.ringLineWidth).toBe(ENDOFRUN_RING_LINE_WIDTH);
  });

  // ── Per-layer toggles ────────────────────────────────────────────

  it('all toggles reflect their exported constants on victory', () => {
    const p = paramsFor('victory');
    expect(p.victoryFlashEnabled).toBe(ENDOFRUN_ENABLE_VICTORY_FLASH);
    expect(p.victoryParticlesEnabled).toBe(ENDOFRUN_ENABLE_VICTORY_PARTICLES);
    expect(p.victoryRingEnabled).toBe(ENDOFRUN_ENABLE_VICTORY_RING);
    expect(p.soundEnabled).toBe(ENDOFRUN_ENABLE_SOUND);
  });

  it('all toggles reflect their exported constants on defeat', () => {
    const p = paramsFor('defeat');
    expect(p.defeatVignetteEnabled).toBe(ENDOFRUN_ENABLE_DEFEAT_VIGNETTE);
    expect(p.defeatGlitchEnabled).toBe(ENDOFRUN_ENABLE_DEFEAT_GLITCH);
    expect(p.defeatRingEnabled).toBe(ENDOFRUN_ENABLE_DEFEAT_RING);
    expect(p.soundEnabled).toBe(ENDOFRUN_ENABLE_SOUND);
  });

  // ── Outcome distinctness ─────────────────────────────────────────

  it('victory and defeat return clearly distinct parameter sets', () => {
    const v = paramsFor('victory');
    const d = paramsFor('defeat');

    // Different primary colours
    expect(v.victoryColor).not.toBe(d.defeatColor);
    expect(v.victoryColor).not.toBe(d.defeatRed);

    // Different particle / ring radii
    expect(v.victoryRingRadius).not.toBe(d.defeatRingRadius);

    // Victory has flash enabled; defeat has vignette + glitch instead
    expect(v.victoryFlashAlpha).toBeGreaterThan(0);
    expect(d.defeatVignetteAlpha).toBeGreaterThan(0);
    expect(d.defeatGlitchSteps).toBeGreaterThan(0);

    // Victory uses bright colours; defeat uses dark/desaturated
    expect(v.victoryColor).not.toBe(d.defeatGray);
  });

  // ── Determinism ──────────────────────────────────────────────────

  it('is deterministic — same outcome always returns identical params', () => {
    const v1 = paramsFor('victory');
    const v2 = paramsFor('victory');
    expect(v1).toEqual(v2);

    const d1 = paramsFor('defeat');
    const d2 = paramsFor('defeat');
    expect(d1).toEqual(d2);
  });

  // ── Default outcome constant ─────────────────────────────────────

  it('ENDOFRUN_DEFAULT_OUTCOME is "victory"', () => {
    expect(ENDOFRUN_DEFAULT_OUTCOME).toBe('victory');
  });

  // ── Sound toggle ─────────────────────────────────────────────────

  it('sound toggle is present on both outcomes', () => {
    const v = paramsFor('victory');
    const d = paramsFor('defeat');
    expect(v.soundEnabled).toBe(d.soundEnabled);
    expect(v.soundEnabled).toBe(ENDOFRUN_ENABLE_SOUND);
  });
});

// ── F2: victory celebration VFX layers ──────────────────────────────

/**
 * Minimal Phaser scene double — no gameplay, just the add/tweens/scale
 * facilities the juice layers use. Booted with the real Phaser harness.
 */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'EndOfRunVfxStubScene' });
  }
}

describe('spawnVictoryFlash — full-screen fade (F2, parent AC2/AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('creates the flash with the resolved alpha and colour', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolveEndOfRunJuiceParams('victory');

    const flash = spawnVictoryFlash(scene, params, registry);

    expect(flash).not.toBeNull();
    expect(registry).toContain(flash);
    expect((flash as Phaser.GameObjects.Rectangle).fillColor).toBe(params.victoryColor);
    expect((flash as Phaser.GameObjects.Rectangle).fillAlpha).toBeCloseTo(
      params.victoryFlashAlpha,
      5,
    );
    expect(flash?.getData('juiceLayer')).toBe('victoryFlash');
  });

  it('tweens the flash to alpha 0 over the resolved duration', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const params = resolveEndOfRunJuiceParams('victory');

    spawnVictoryFlash(scene, params, registry);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(params.victoryFlashDurationMs);
    expect(config.alpha).toBe(0);
  });

  it('destroys the flash and removes it from the registry on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnVictoryFlash(scene, resolveEndOfRunJuiceParams('victory'), registry);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(flash);
    expect(flash?.active).toBe(false);
  });

  it('is a no-op when the victory flash toggle is off', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const flash = spawnVictoryFlash(
      scene,
      { ...resolveEndOfRunJuiceParams('victory'), victoryFlashEnabled: false },
      registry,
    );

    expect(flash).toBeNull();
    expect(registry).toHaveLength(0);
  });
});

describe('spawnVictoryRings — expanding celebration rings (F2, parent AC2/AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns the configured number of rings, all registered', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const rings = spawnVictoryRings(
      scene,
      100,
      100,
      resolveEndOfRunJuiceParams('victory'),
      registry,
    );

    expect(rings).toHaveLength(ENDOFRUN_VICTORY_RING_COUNT);
    expect(registry).toHaveLength(ENDOFRUN_VICTORY_RING_COUNT);
    for (const ring of rings) expect(registry).toContain(ring);
    expect(rings[0].getData('juiceLayer')).toBe('victoryRing');
  });

  it('starts every ring at the resolved start scale', async () => {
    const scene = await boot();
    const params = resolveEndOfRunJuiceParams('victory');

    const rings = spawnVictoryRings(scene, 0, 0, params);

    for (const ring of rings) expect(ring.scale).toBeCloseTo(params.ringStartScale, 5);
  });

  it('destroys each ring and removes it from the registry on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnVictoryRings(scene, 0, 0, resolveEndOfRunJuiceParams('victory'), registry);
    // The last tween call belongs to the last ring.
    const config = tweenSpy.mock.calls[tweenSpy.mock.calls.length - 1][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).toHaveLength(ENDOFRUN_VICTORY_RING_COUNT - 1);
  });

  it('is a no-op when the victory ring toggle is off', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const rings = spawnVictoryRings(
      scene,
      0,
      0,
      { ...resolveEndOfRunJuiceParams('victory'), victoryRingEnabled: false },
      registry,
    );

    expect(rings).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });
});

describe('spawnVictoryConfetti — celebration particle burst (F2, parent AC2/AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns params.victoryParticleCount confetti pieces, all registered', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolveEndOfRunJuiceParams('victory');

    const confetti = spawnVictoryConfetti(scene, 0, 0, params, registry, { seed: 1 });

    expect(confetti).toHaveLength(params.victoryParticleCount);
    expect(registry).toHaveLength(params.victoryParticleCount);
    for (const piece of confetti) expect(registry).toContain(piece);
    expect(confetti[0].getData('juiceLayer')).toBe('victoryConfetti');
  });

  it('cycles the victory palette across confetti pieces', async () => {
    const scene = await boot();
    const params = resolveEndOfRunJuiceParams('victory');

    const confetti = spawnVictoryConfetti(scene, 0, 0, params, undefined, { seed: 2 });

    expect(confetti[0].fillColor).toBe(params.victoryColor);
    expect(confetti[1].fillColor).toBe(params.victoryGreen);
    expect(confetti[2].fillColor).toBe(params.victorySparkle);
    expect(confetti[3].fillColor).toBe(params.victoryColor);
  });

  it('is deterministic for a fixed seed', async () => {
    const scene = await boot();
    const params = resolveEndOfRunJuiceParams('victory');
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const first = spawnVictoryConfetti(scene, 0, 0, params, undefined, { seed: 9 });
    const firstConfigs = tweenSpy.mock.calls.map(
      (call) => call[0] as Phaser.Types.Tweens.TweenBuilderConfig,
    );
    tweenSpy.mockClear();

    const second = spawnVictoryConfetti(scene, 0, 0, params, undefined, { seed: 9 });
    const secondConfigs = tweenSpy.mock.calls.map(
      (call) => call[0] as Phaser.Types.Tweens.TweenBuilderConfig,
    );

    // Same seed → identical burst geometry.
    expect(second).toHaveLength(first.length);
    expect(secondConfigs[0].x).toBe(firstConfigs[0].x);
    expect(secondConfigs[0].y).toBe(firstConfigs[0].y);
    expect(second[0].fillColor).toBe(first[0].fillColor);
  });

  it('destroys a confetti piece and removes it from the registry on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const params = resolveEndOfRunJuiceParams('victory');

    spawnVictoryConfetti(scene, 0, 0, params, registry, { seed: 3 });
    const config = tweenSpy.mock.calls[tweenSpy.mock.calls.length - 1][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).toHaveLength(params.victoryParticleCount - 1);
  });

  it('is a no-op when the victory particle toggle is off', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const confetti = spawnVictoryConfetti(
      scene,
      0,
      0,
      { ...resolveEndOfRunJuiceParams('victory'), victoryParticlesEnabled: false },
      registry,
    );

    expect(confetti).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });
});

describe('spawnVictoryJuice — composition entry point (F2, parent AC2/AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('composes the flash, rings and confetti layers in one call', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolveEndOfRunJuiceParams('victory');

    const handle = spawnVictoryJuice(scene, { registry, seed: 1 });

    expect(handle.params).toEqual(params);
    expect(handle.flash).not.toBeNull();
    expect(handle.rings).toHaveLength(ENDOFRUN_VICTORY_RING_COUNT);
    expect(handle.confetti).toHaveLength(params.victoryParticleCount);
    const expected =
      1 + ENDOFRUN_VICTORY_RING_COUNT + params.victoryParticleCount;
    expect(registry).toHaveLength(expected);
  });

  it('defaults the origin to the scene centre', async () => {
    const scene = await boot();
    const width = scene.scale.width;
    const height = scene.scale.height;

    const handle = spawnVictoryJuice(scene, { seed: 1 });

    expect(handle.rings[0].x).toBe(width / 2);
    expect(handle.rings[0].y).toBe(height / 2);
    expect(handle.confetti[0].x).toBe(width / 2);
    expect(handle.confetti[0].y).toBe(height / 2);
  });

  it('renders every juice layer below the default-depth GameOverScene UI', async () => {
    const scene = await boot();

    const handle = spawnVictoryJuice(scene, { seed: 1 });

    expect(handle.flash?.depth).toBeLessThan(0);
    for (const ring of handle.rings) expect(ring.depth).toBeLessThan(0);
    for (const piece of handle.confetti) expect(piece.depth).toBeLessThan(0);
  });

  it('honours the per-layer toggles independently', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolveEndOfRunJuiceParams('victory');
    const disabled = {
      ...params,
      victoryFlashEnabled: false,
      victoryRingEnabled: false,
      victoryParticlesEnabled: false,
    };

    // Directly exercise the layer helpers to confirm each toggle is independent.
    expect(spawnVictoryFlash(scene, disabled, registry)).toBeNull();
    expect(spawnVictoryRings(scene, 0, 0, disabled, registry)).toHaveLength(0);
    expect(spawnVictoryConfetti(scene, 0, 0, disabled, registry)).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });

  it('destroys all juice objects when the registry is drained on teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const handle = spawnVictoryJuice(scene, { registry, seed: 1 });
    expect(registry.length).toBeGreaterThan(0);

    // Simulate the scene SHUTDOWN teardown: destroy every registry member.
    for (const obj of [...registry]) {
      (obj as Phaser.GameObjects.GameObject & { destroy(): void }).destroy();
    }
    registry.length = 0;

    expect(registry).toHaveLength(0);
    expect(handle.flash?.active).toBe(false);
  });
});

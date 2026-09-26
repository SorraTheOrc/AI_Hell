/**
 * Player-death juice parameter model — pure-logic contract (F1,
 * parent AH-0MUAYB4R3002ZIZY).
 *
 * This file is the test-first spec: `playerDeathJuice.ts` must satisfy
 * every acceptance criterion below. It exercises only the pure parameter
 * model (no Phaser import), so it runs headless with no rendering.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  PLAYER_DEATH_DEBRIS_COUNT,
  PLAYER_DEATH_DEBRIS_LIFESPAN_MS,
  PLAYER_DEATH_FLASH_ALPHA,
  PLAYER_DEATH_FLASH_COLOR,
  PLAYER_DEATH_FLASH_DURATION_MS,
  PLAYER_DEATH_PARTICLE_LIFESPAN_MS,
  PLAYER_DEATH_PARTICLE_SCALE,
  PLAYER_DEATH_SEVERITY_FATAL_DEBRIS_COUNT_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_FLASH_ALPHA_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_SHAKE_DURATION_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_SHAKE_INTENSITY_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_SHOCKWAVE_RADIUS_MULT,
  PLAYER_DEATH_SHAKE_DURATION_MS,
  PLAYER_DEATH_SHAKE_INTENSITY,
  PLAYER_DEATH_SHOCKWAVE_DURATION_MS,
  PLAYER_DEATH_SHOCKWAVE_RADIUS,
  PLAYER_DEATH_ENABLE_DEBRIS,
  PLAYER_DEATH_ENABLE_FLASH,
  PLAYER_DEATH_ENABLE_SHAKE,
  PLAYER_DEATH_ENABLE_SHOCKWAVE,
  resolveJuiceParams,
  applyShake,
  spawnDeathFlash,
  spawnDeathDebris,
  spawnDeathShockwave,
  PLAYER_DEATH_DEBRIS_TRAVEL,
  PLAYER_DEATH_SHOCKWAVE_START_SCALE,
  type PlayerDeathJuiceParams,
} from './playerDeathJuice';
import { SHIP_COLOR } from '../core/constants';

/** Minimal bootable scene for the VFX helpers. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'VfxStubScene' });
  }
}

/** Every field that must be populated on a resolved parameter set. */
const REQUIRED_FIELDS: Array<keyof PlayerDeathJuiceParams> = [
  'shakeIntensity',
  'shakeDurationMs',
  'shakeEnabled',
  'flashAlpha',
  'flashDurationMs',
  'flashColor',
  'flashEnabled',
  'particleCount',
  'particleLifespanMs',
  'particleScale',
  'particlesEnabled',
  'debrisCount',
  'debrisLifespanMs',
  'debrisEnabled',
  'shockwaveRadius',
  'shockwaveDurationMs',
  'shockwaveEnabled',
  'soundEnabled',
];

describe('resolveJuiceParams — pure player-death parameter model (F1)', () => {
  it('returns a complete parameter set for both severities', () => {
    for (const severity of ['respawn', 'fatal'] as const) {
      const params = resolveJuiceParams(severity);
      for (const field of REQUIRED_FIELDS) {
        expect(params[field], `${severity}.${field}`).toBeDefined();
      }
    }
  });

  it('is deterministic — repeated calls return equal values', () => {
    expect(resolveJuiceParams('fatal')).toEqual(resolveJuiceParams('fatal'));
    expect(resolveJuiceParams('respawn')).toEqual(resolveJuiceParams('respawn'));
  });

  it('scales every asserted magnitude heavier for fatal than respawn', () => {
    const respawn = resolveJuiceParams('respawn');
    const fatal = resolveJuiceParams('fatal');

    expect(fatal.shakeIntensity).toBeGreaterThan(respawn.shakeIntensity);
    expect(fatal.shakeDurationMs).toBeGreaterThan(respawn.shakeDurationMs);
    expect(fatal.flashAlpha).toBeGreaterThan(respawn.flashAlpha);
    expect(fatal.debrisCount).toBeGreaterThan(respawn.debrisCount);
    expect(fatal.shockwaveRadius).toBeGreaterThan(respawn.shockwaveRadius);
  });

  it('applies the documented severity multipliers to the base constants', () => {
    const fatal = resolveJuiceParams('fatal');

    expect(fatal.shakeIntensity).toBeCloseTo(
      PLAYER_DEATH_SHAKE_INTENSITY * PLAYER_DEATH_SEVERITY_FATAL_SHAKE_INTENSITY_MULT,
      10,
    );
    expect(fatal.shakeDurationMs).toBe(
      PLAYER_DEATH_SHAKE_DURATION_MS * PLAYER_DEATH_SEVERITY_FATAL_SHAKE_DURATION_MULT,
    );
    expect(fatal.flashAlpha).toBeCloseTo(
      PLAYER_DEATH_FLASH_ALPHA * PLAYER_DEATH_SEVERITY_FATAL_FLASH_ALPHA_MULT,
      10,
    );
    expect(fatal.debrisCount).toBe(
      PLAYER_DEATH_DEBRIS_COUNT * PLAYER_DEATH_SEVERITY_FATAL_DEBRIS_COUNT_MULT,
    );
    expect(fatal.shockwaveRadius).toBe(
      PLAYER_DEATH_SHOCKWAVE_RADIUS * PLAYER_DEATH_SEVERITY_FATAL_SHOCKWAVE_RADIUS_MULT,
    );
  });

  it('returns the respawn set for unknown or invalid severity and never throws', () => {
    const respawn = resolveJuiceParams('respawn');
    expect(resolveJuiceParams('nope' as never)).toEqual(respawn);
    expect(resolveJuiceParams('' as never)).toEqual(respawn);
    expect(resolveJuiceParams(undefined as never)).toEqual(respawn);
    expect(resolveJuiceParams(null as never)).toEqual(respawn);
  });

  it('keeps the base tuning inside the intake-specified bounds', () => {
    // Intake assumptions: shake intensity ~0.008–0.02, duration ~250–400 ms,
    // flash duration ~120–200 ms.
    expect(PLAYER_DEATH_SHAKE_INTENSITY).toBeGreaterThanOrEqual(0.008);
    expect(PLAYER_DEATH_SHAKE_INTENSITY).toBeLessThanOrEqual(0.02);
    expect(PLAYER_DEATH_SHAKE_DURATION_MS).toBeGreaterThanOrEqual(250);
    expect(PLAYER_DEATH_SHAKE_DURATION_MS).toBeLessThanOrEqual(400);
    expect(PLAYER_DEATH_FLASH_DURATION_MS).toBeGreaterThanOrEqual(120);
    expect(PLAYER_DEATH_FLASH_DURATION_MS).toBeLessThanOrEqual(200);
  });

  it('centres flash and debris colours on SHIP_COLOR', () => {
    expect(PLAYER_DEATH_FLASH_COLOR).toBe(SHIP_COLOR);
    expect(resolveJuiceParams('respawn').flashColor).toBe(SHIP_COLOR);
    expect(resolveJuiceParams('fatal').flashColor).toBe(SHIP_COLOR);
  });

  it('carries particle overrides for the delegated particle burst', () => {
    const params = resolveJuiceParams('respawn');
    expect(params.particleLifespanMs).toBe(PLAYER_DEATH_PARTICLE_LIFESPAN_MS);
    expect(params.particleScale).toBe(PLAYER_DEATH_PARTICLE_SCALE);
    expect(params.particleCount).toBeGreaterThan(0);
  });

  it('exposes per-layer toggles that default to enabled', () => {
    expect(PLAYER_DEATH_ENABLE_SHAKE).toBe(true);
    expect(PLAYER_DEATH_ENABLE_FLASH).toBe(true);
    expect(PLAYER_DEATH_ENABLE_DEBRIS).toBe(true);
    expect(PLAYER_DEATH_ENABLE_SHOCKWAVE).toBe(true);

    const params = resolveJuiceParams('respawn');
    expect(params.shakeEnabled).toBe(PLAYER_DEATH_ENABLE_SHAKE);
    expect(params.flashEnabled).toBe(PLAYER_DEATH_ENABLE_FLASH);
    expect(params.debrisEnabled).toBe(PLAYER_DEATH_ENABLE_DEBRIS);
    expect(params.shockwaveEnabled).toBe(PLAYER_DEATH_ENABLE_SHOCKWAVE);
    expect(params.particlesEnabled).toBe(true);
    expect(params.soundEnabled).toBe(true);
  });

  it('keeps lengths finite positive numbers suitable for tweens', () => {
    const params = resolveJuiceParams('fatal');
    expect(params.debrisLifespanMs).toBe(PLAYER_DEATH_DEBRIS_LIFESPAN_MS);
    expect(params.shockwaveDurationMs).toBe(PLAYER_DEATH_SHOCKWAVE_DURATION_MS);
    for (const value of [params.shakeDurationMs, params.flashDurationMs, params.debrisLifespanMs, params.shockwaveDurationMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

// ── F3: screen shake and flash layers ───────────────────────────────

describe('applyShake — scene-camera shake (F3, parent AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it("fires camera.shake once with the configured 'respawn' params", async () => {
    const scene = await boot();
    const shake = vi.spyOn(scene.cameras.main, 'shake').mockImplementation(() => scene.cameras.main as never);
    const params = resolveJuiceParams('respawn');

    applyShake(scene, params);

    expect(shake).toHaveBeenCalledTimes(1);
    expect(shake).toHaveBeenCalledWith(params.shakeDurationMs, params.shakeIntensity);
  });

  it("fires camera.shake once with the heavier 'fatal' params", async () => {
    const scene = await boot();
    const shake = vi.spyOn(scene.cameras.main, 'shake').mockImplementation(() => scene.cameras.main as never);
    const params = resolveJuiceParams('fatal');

    applyShake(scene, params);

    expect(shake).toHaveBeenCalledTimes(1);
    expect(shake).toHaveBeenCalledWith(params.shakeDurationMs, params.shakeIntensity);
  });

  it('is a no-op when the shake toggle is disabled', async () => {
    const scene = await boot();
    const shake = vi.spyOn(scene.cameras.main, 'shake').mockImplementation(() => scene.cameras.main as never);

    applyShake(scene, { ...resolveJuiceParams('respawn'), shakeEnabled: false });

    expect(shake).not.toHaveBeenCalled();
  });
});

describe('spawnDeathFlash — full-screen fade (F3, parent AC4/AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('creates the flash at the configured alpha/colour and tween duration', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const params = resolveJuiceParams('fatal');

    const flash = spawnDeathFlash(scene, params, registry);

    expect(flash).not.toBeNull();
    expect(registry).toContain(flash);
    expect((flash as Phaser.GameObjects.Rectangle).fillColor).toBe(params.flashColor);
    expect((flash as Phaser.GameObjects.Rectangle).fillAlpha).toBeCloseTo(params.flashAlpha, 5);
    expect(flash?.getData('juiceLayer')).toBe('flash');

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(params.flashDurationMs);
  });

  it('destroys the flash and removes it from the registry on tween completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnDeathFlash(scene, resolveJuiceParams('respawn'), registry);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(flash);
    expect(flash?.active).toBe(false);
  });

  it('is a no-op when the flash toggle is disabled', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const flash = spawnDeathFlash(
      scene,
      { ...resolveJuiceParams('respawn'), flashEnabled: false },
      registry,
    );

    expect(flash).toBeNull();
    expect(registry).toHaveLength(0);
  });
});

// ── F4: debris shards and shockwave ring ────────────────────────────

describe('spawnDeathDebris — outward shards (F4, parent AC4/AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns one shard per resolved debris count and registers each', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const params = resolveJuiceParams('fatal');

    const shards = spawnDeathDebris(scene, 100, 100, params, registry, { seed: 1 });

    expect(shards).toHaveLength(params.debrisCount);
    expect(registry).toHaveLength(params.debrisCount);
    for (const shard of shards) expect(registry).toContain(shard);
  });

  it('tweens each shard for the resolved debris lifespan and travels outward', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const params = resolveJuiceParams('respawn');

    const shards = spawnDeathDebris(scene, 10, 20, params, registry, { seed: 7 });

    expect(tweenSpy).toHaveBeenCalledTimes(params.debrisCount);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(params.debrisLifespanMs);

    // Every shard is tweened to an outward target within [0.6, 1.0] × travel.
    const targets = tweenSpy.mock.calls.map(
      (call) => call[0] as Phaser.Types.Tweens.TweenBuilderConfig,
    );
    for (const target of targets) {
      const distance = Math.hypot(
        (target.x as number) - 10,
        (target.y as number) - 20,
      );
      expect(distance).toBeGreaterThanOrEqual(PLAYER_DEATH_DEBRIS_TRAVEL * 0.6 - 1e-6);
      expect(distance).toBeLessThanOrEqual(PLAYER_DEATH_DEBRIS_TRAVEL + 1e-6);
    }
    expect(shards.length).toBe(targets.length);
  });

  it('destroys shards and removes them from the registry on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnDeathDebris(scene, 0, 0, resolveJuiceParams('respawn'), registry, { seed: 3 });
    const shard = registry[0] as Phaser.GameObjects.Graphics;
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(shard);
    expect(shard.active).toBe(false);
  });

  it('is a no-op when the debris toggle is disabled', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const shards = spawnDeathDebris(
      scene,
      0,
      0,
      { ...resolveJuiceParams('respawn'), debrisEnabled: false },
      registry,
    );

    expect(shards).toHaveLength(0);
    expect(registry).toHaveLength(0);
  });
});

describe('spawnDeathShockwave — expanding ring (F4, parent AC4/AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('draws a ring at the resolved radius and tweens for the resolved duration', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const params = resolveJuiceParams('fatal');

    const ring = spawnDeathShockwave(scene, 5, 6, params, registry);

    expect(ring).not.toBeNull();
    expect(registry).toContain(ring);
    expect(ring?.getData('shockwaveRadius')).toBe(params.shockwaveRadius);
    expect(ring?.getData('juiceLayer')).toBe('shockwave');

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(params.shockwaveDurationMs);
    expect(ring?.scale).toBe(PLAYER_DEATH_SHOCKWAVE_START_SCALE);
  });

  it('destroys the ring and removes it from the registry on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const ring = spawnDeathShockwave(scene, 0, 0, resolveJuiceParams('respawn'), registry);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(ring);
    expect(ring?.active).toBe(false);
  });

  it('is a no-op when the shockwave toggle is disabled', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.GameObject[] = [];

    const ring = spawnDeathShockwave(
      scene,
      0,
      0,
      { ...resolveJuiceParams('respawn'), shockwaveEnabled: false },
      registry,
    );

    expect(ring).toBeNull();
    expect(registry).toHaveLength(0);
  });

  it('shard travel and shockwave start scale are positive tunables', () => {
    expect(PLAYER_DEATH_DEBRIS_TRAVEL).toBeGreaterThan(0);
    expect(PLAYER_DEATH_SHOCKWAVE_START_SCALE).toBeGreaterThan(0);
    expect(PLAYER_DEATH_SHOCKWAVE_START_SCALE).toBeLessThan(1);
  });
});

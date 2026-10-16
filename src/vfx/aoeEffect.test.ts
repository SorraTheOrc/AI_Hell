/**
 * Unit tests for the AOE VFX helpers (parent AH-0MUOOB3OR001V8CD, F2 AC3/AC7).
 *
 * Assert observable behaviour of the public API — spawn position, tween
 * parameters (expansion + fade), registry lifecycle and handle completion —
 * rather than pixel output.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { BULLET_COLORS } from '../utils/weapons';
import {
  ARC_CHAIN_COLOR,
  ARC_CHAIN_DURATION,
  MORTAR_BURST_COLOR,
  MORTAR_BURST_DURATION,
  MORTAR_BURST_SPIKE_COUNT,
  MORTAR_BURST_START_SCALE,
  NOVA_RING_COLOR,
  NOVA_RING_DURATION,
  NOVA_RING_START_SCALE,
  spawnArcChain,
  spawnMortarBurst,
  spawnNovaRing,
} from './aoeEffect';

/** Minimal bootable scene for the VFX helpers. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'AoeVfxStubScene' });
  }
}

describe('aoeEffect — Nova expanding ring (F2 AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns a ring at the ship position, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnNovaRing(scene, 100, 120, 90, { registry });

    expect(handle.radius).toBe(90);
    expect(handle.graphics.x).toBe(100);
    expect(handle.graphics.y).toBe(120);
    expect(handle.graphics.scale).toBeCloseTo(NOVA_RING_START_SCALE, 5);
    expect(registry).toContain(handle.graphics);
    expect(scene.children.list).toContain(handle.graphics);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
  });

  it('expands outward and fades over the configured duration', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnNovaRing(scene, 10, 20, 70);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(NOVA_RING_DURATION * 1000);
    // The ring grows from its start scale to full radius while fading to 0.
    expect((config as { scale?: number }).scale).toBe(1);
    expect((config as { alpha?: number }).alpha).toBe(0);
  });

  it('removes itself from the registry and destroys on completion', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnNovaRing(scene, 10, 20, 70, { registry });
    expect(handle.isComplete()).toBe(false);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('works without a registry (fire-and-forget effect)', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnNovaRing(scene, 0, 0, 50);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(() => (config.onComplete as () => void)()).not.toThrow();

    expect(handle.isComplete()).toBe(true);
    expect(handle.graphics.active).toBe(false);
  });

  it('is visually distinct from the standard bullet colours', async () => {
    // The ring colour must not collide with any *conventional* bullet colour
    // (it intentionally matches the Nova weapon's own colour).
    const conventional = [
      BULLET_COLORS.cannon,
      BULLET_COLORS.spread,
      BULLET_COLORS.dual,
      BULLET_COLORS.rapid,
    ];
    for (const bulletColor of conventional) {
      expect(NOVA_RING_COLOR).not.toBe(bulletColor);
    }
    // ...nor with the Bomb bomb icon red (0xff3333).
    expect(NOVA_RING_COLOR).not.toBe(0xff3333);
  });

  it('draws a bright white-hot flash core in addition to the stroked rings (AH-0MV822BPT002GF17)', async () => {
    const scene = await boot();

    const handle = spawnNovaRing(scene, 100, 120, 90);

    // Phaser Graphics opcodes: the ring is composed of stroked circles (the
    // expanding ring edge) *plus* a filled white-hot core flash so the shot
    // reads as a bright ring flash, not a hairline outline. The flash core is
    // a FILL_PATH command; the two rings are STROKE_PATH commands.
    const buf = handle.graphics.commandBuffer as number[];
    // Arg widths for the opcodes the ring emits (opcode + args = stride).
    const widths: Record<number, number> = { 0: 7, 1: 0, 6: 3, 7: 2 };
    const count = (target: number): number => {
      let n = 0;
      for (let i = 0; i < buf.length; i += 1 + (widths[buf[i]] ?? 0)) {
        if (buf[i] === target) n += 1;
      }
      return n;
    };
    // Both stroked rings (outer + inner echo) and at least one filled flash.
    expect(count(9)).toBeGreaterThanOrEqual(2); // STROKE_PATH
    expect(count(8)).toBeGreaterThanOrEqual(1); // FILL_PATH (flash core)
  });
});

describe('aoeEffect — Mortar detonation burst (F3 AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('spawns a burst at the impact point, registered for teardown', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnMortarBurst(scene, 200, 210, 70, { registry });

    expect(handle.radius).toBe(70);
    expect(handle.graphics.x).toBe(200);
    expect(handle.graphics.y).toBe(210);
    expect(handle.graphics.scale).toBeCloseTo(MORTAR_BURST_START_SCALE, 5);
    expect(registry).toContain(handle.graphics);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(MORTAR_BURST_DURATION * 1000);
  });

  it('tears down on completion and reports the completed handle', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnMortarBurst(scene, 10, 20, 70, { registry });
    expect(handle.isComplete()).toBe(false);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('is visually distinct from the Nova ring (colour + burst geometry)', async () => {
    expect(MORTAR_BURST_COLOR).not.toBe(NOVA_RING_COLOR);
    // The two effects intentionally differ in both colour and lifetime, so the
    // Mortar blast never reads as a Nova pulse.
    expect(MORTAR_BURST_DURATION).not.toBe(NOVA_RING_DURATION);
  });

  /** Count Graphics command-buffer opcodes (8 = FILL_PATH, 9 = STROKE_PATH). */
  function countOpcode(
    graphics: Phaser.GameObjects.Graphics,
    target: number,
  ): number {
    const buf = graphics.commandBuffer as number[];
    // Per-opcode argument counts (Phaser Commands.js): ARC has 7, LINE_TO and
    // MOVE_TO 2 each, LINE_STYLE 3, FILL_STYLE 2; the path/terminator commands
    // carry none. Walking with these strides keeps the counter aligned.
    const widths: Record<number, number> = {
      0: 7,
      1: 0,
      2: 0,
      3: 4,
      4: 2, // LINE_TO
      5: 2, // MOVE_TO
      6: 3,
      7: 2,
      8: 0,
      9: 0,
    };
    let n = 0;
    for (let i = 0; i < buf.length; i += 1 + (widths[buf[i]] ?? 0)) {
      if (buf[i] === target) n += 1;
    }
    return n;
  }

  it('draws a bright white-hot blast flash core in addition to the spikes (AH-0MV822C250051OVN)', async () => {
    const scene = await boot();
    const handle = spawnMortarBurst(scene, 200, 210, 70);

    // The burst reads as a bright blast flash: a white-hot FILL_PATH core over
    // the weapon-coloured fill, plus the radiating spikes.
    expect(countOpcode(handle.graphics, 8)).toBeGreaterThanOrEqual(1); // FILL_PATH
    expect(countOpcode(handle.graphics, 9)).toBe(MORTAR_BURST_SPIKE_COUNT); // spikes
  });

  it('draws an inbound arcing shell trail from the launcher origin when supplied (AH-0MV822C250051OVN)', async () => {
    const scene = await boot();
    // A real arc: the origin is off the blast point.
    const handle = spawnMortarBurst(scene, 200, 260, 35, {
      origin: { x: 120, y: 120 },
    });

    // Beyond the burst's spikes, the burst now carries the trail's stroked arc
    // segments, so the onRandom detonation reads as an arcing shell landing.
    expect(countOpcode(handle.graphics, 9)).toBeGreaterThan(
      MORTAR_BURST_SPIKE_COUNT,
    );
  });

  it('draws no trail without an origin (the generic burst is spikes + flash only) (AH-0MV822C250051OVN)', async () => {
    const scene = await boot();
    const handle = spawnMortarBurst(scene, 200, 260, 35);

    // Without a launcher origin there is no arc to draw: exactly the spikes.
    expect(countOpcode(handle.graphics, 9)).toBe(MORTAR_BURST_SPIKE_COUNT);
  });
});

describe('aoeEffect — Arc chaining bolt (F4 AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('draws a bolt through every chain vertex and registers it', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnArcChain(
      scene,
      [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 40 },
      ],
      { registry },
    );

    expect(registry).toContain(handle.graphics);
    expect(scene.children.list).toContain(handle.graphics);
    // Reach is the farthest vertex from the origin: sqrt(50² + 40²).
    expect(handle.radius).toBeCloseTo(Math.hypot(50, 40), 5);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(ARC_CHAIN_DURATION * 1000);
  });

  it('tears down on completion and reports the completed handle', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnArcChain(
      scene,
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      { registry },
    );
    expect(handle.isComplete()).toBe(false);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('handles a single-vertex path (no segments) without throwing', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const handle = spawnArcChain(scene, [{ x: 10, y: 10 }]);
    expect(handle.radius).toBe(0);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
  });

  it('is visually distinct from Nova and Mortar (colour)', () => {
    expect(ARC_CHAIN_COLOR).not.toBe(NOVA_RING_COLOR);
    expect(ARC_CHAIN_COLOR).not.toBe(MORTAR_BURST_COLOR);
  });
});

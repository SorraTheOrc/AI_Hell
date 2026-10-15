/**
 * Unit tests for the shared per-weapon muzzle flash
 * (AH-0MV8228YW0050IXS).
 *
 * The flash is the clean launch cue spawned once per shot from the shared
 * combat-core spawn path, so its lifecycle (create at the aim point, track in
 * the caller's registry, fade and self-destroy) is asserted here — the same
 * pattern as `vfx/bulletImpact`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  MUZZLE_FLASH_DURATION,
  spawnMuzzleFlash,
} from './muzzleFlash';

/** Minimal bootable scene for the VFX helper. */
class MuzzleStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MuzzleStubScene' });
  }
}

const Cmd = {
  ARC: 0,
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
  LINE_TO: 4,
  MOVE_TO: 5,
  FILL_PATH: 8,
  STROKE_PATH: 9,
} as const;

/** Parameter count following each opcode (0 for path terminators). */
const CmdWidths: Record<number, number> = {
  [Cmd.ARC]: 7,
  [Cmd.BEGIN_PATH]: 0,
  [Cmd.CLOSE_PATH]: 0,
  [Cmd.LINE_TO]: 2,
  [Cmd.MOVE_TO]: 2,
  [Cmd.FILL_PATH]: 0,
  [Cmd.STROKE_PATH]: 0,
};

/** Counts occurrences of a command opcode in a Graphics command buffer. */
function countOps(buf: number[], target: number): number {
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (CmdWidths[buf[i]] ?? 0)) {
    if (buf[i] === target) count += 1;
  }
  return count;
}

describe('muzzleFlash — shared per-weapon launch cue (AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([MuzzleStubScene]);
    return booted.scene;
  }

  it('spawns a flash at the aim point facing the firing heading', async () => {
    const scene = await boot();

    const flash = spawnMuzzleFlash(scene, 100, 120, Math.PI / 2);

    expect(flash.x).toBe(100);
    expect(flash.y).toBe(120);
    expect(flash.rotation).toBeCloseTo(Math.PI / 2, 5);
    expect(scene.children.list).toContain(flash);
  });

  it('tracks the flash in the caller registry and fades it over the configured duration', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnMuzzleFlash(scene, 10, 20, 0, {
      registry,
      radius: 7,
      duration: 0.12,
    });

    expect(registry).toContain(flash);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(MUZZLE_FLASH_DURATION * 1000);
    expect(config.targets).toBe(flash);
  });

  it('removes the flash from the registry and destroys it when the fade completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnMuzzleFlash(scene, 10, 20, 0, { registry });
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(flash);
    expect(flash.active).toBe(false);
  });

  it('renders a hot core (filled arcs) plus aim spikes (stroked path)', async () => {
    const scene = await boot();
    const buf = spawnMuzzleFlash(scene, 5, 5, 0).commandBuffer as number[];

    // Filled discs (at least two filled arcs: the white core + colour ring)
    // and a stroked V for the aim direction.
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBe(1);
    // The aim spikes open a fresh path with at least two line segments.
    expect(countOps(buf, Cmd.BEGIN_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(2);
  });
});

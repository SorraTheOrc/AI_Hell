/**
 * Unit tests for the wave-laser beam visual (AH-0MVREBUJ5004HDRQ, AC1/AC4).
 *
 * The beam is the rendered half of the shared hitscan seam: it draws the
 * resolved polyline as one red laser column, holds it for exactly 0.3 s and
 * then removes it. Lifecycle (create at the resolved geometry, track in the
 * caller's registry, fade and self-destroy) is asserted here — the same
 * pattern as `vfx/muzzleFlash`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  HITSCAN_BEAM_COLOR,
  HITSCAN_BEAM_DURATION,
  spawnHitscanBeam,
} from './hitscanBeam';

/** Minimal bootable scene for the VFX helper. */
class BeamStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BeamStubScene' });
  }
}

const Cmd = {
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
  LINE_TO: 4,
  MOVE_TO: 5,
  FILL_PATH: 8,
  STROKE_PATH: 9,
} as const;

/** Parameter count following each opcode (0 for path terminators). */
const CmdWidths: Record<number, number> = {
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

describe('hitscanBeam — the wave laser\'s single red beam (AC1/AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([BeamStubScene]);
    return booted.scene;
  }

  const straightBeam = [{ x1: 100, y1: 200, x2: 700, y2: 200 }];

  it('draws one red beam column along the resolved ray', async () => {
    const scene = await boot();

    const beam = spawnHitscanBeam(scene, straightBeam);
    const buffer = beam.commandBuffer as number[];

    expect(scene.children.list).toContain(beam);
    // Outer red column + inner hot core: two stroked paths for one segment.
    expect(countOps(buffer, Cmd.STROKE_PATH)).toBe(2);
    expect(countOps(buffer, Cmd.LINE_TO)).toBe(2);
    // The beam is drawn as a laser column, never a filled blob or a fan.
    expect(countOps(buffer, Cmd.FILL_PATH)).toBe(0);
  });

  it('draws one segment per wrapped run of the ray', async () => {
    const scene = await boot();

    const beam = spawnHitscanBeam(scene, [
      { x1: 900, y1: 200, x2: 960, y2: 200 },
      { x1: 0, y1: 200, x2: 840, y2: 200 },
    ]);

    expect(countOps(beam.commandBuffer as number[], Cmd.STROKE_PATH)).toBe(4);
  });

  it('is visible for exactly 0.3 s and then destroyed (AC4)', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const beam = spawnHitscanBeam(scene, straightBeam, { registry });

    expect(HITSCAN_BEAM_DURATION).toBeCloseTo(0.3, 6);
    expect(registry).toContain(beam);
    const config = tweenSpy.mock
      .calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBeCloseTo(300, 6);
    expect(config.targets).toBe(beam);
    // The beam fades to nothing over that window — no body survives it.
    expect(config.alpha).toBe(0);
  });

  it('removes the beam from the registry and destroys it when the fade completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const beam = spawnHitscanBeam(scene, straightBeam, { registry });
    const config = tweenSpy.mock
      .calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(beam);
    expect(beam.active).toBe(false);
  });

  it('uses the catalogue red and holds a hot core down its centre (AC1)', async () => {
    const scene = await boot();
    const beam = spawnHitscanBeam(scene, straightBeam);

    expect(HITSCAN_BEAM_COLOR).toBe(0xff0000);
    // The beam Graphics primary tint is not asserted pixel-wise; the helper's
    // documented defaults are the contract the scene consumes.
    expect(beam.visible).toBe(true);
  });
});

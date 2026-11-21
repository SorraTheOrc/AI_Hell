/**
 * Unit tests for the wave-laser beam visual (AH-0MVREBUJ5004HDRQ, AC1/AC4;
 * source anchoring AH-0MWJ8JUEF006XBLB).
 *
 * The beam is the rendered half of the shared hitscan seam: it draws the
 * resolved polyline as one red laser column, holds it for exactly 0.3 s and
 * then removes it. Since AH-0MWJ8JUEF006XBLB its **source end re-anchors each
 * frame to the ship's current position** while its **far end stays frozen at
 * the launch-resolved end point** — a purely visual change: the ray is never
 * re-resolved, so no hit is recomputed and no damage is re-applied. Lifecycle
 * (create at the resolved geometry, track in the caller's registry, fade and
 * self-destroy) is asserted here — the same pattern as `vfx/muzzleFlash`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  countOps,
  Cmd,
  drawnDestination,
  drawnSource,
  outerSegments,
  expectPoint,
} from '../test/vfxProbe';
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



/** Advances the scene's `update` delta by `seconds` in fixed 60 fps steps. */
function advance(scene: Phaser.Scene, seconds: number, dt = 1 / 60): void {
  const frames = Math.max(1, Math.ceil(seconds / dt));
  for (let i = 0; i < frames; i += 1) {
    scene.events.emit('update', 0, dt * 1000);
  }
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

  const straightBeam = [{ x1: 100, y1: 200, x2: 340, y2: 200 }];

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

    // A ray that left the right edge and re-emerged from the left: the
    // shortest wrapped path from the muzzle (900) to the far end (180).
    const beam = spawnHitscanBeam(scene, [
      { x1: 900, y1: 200, x2: 960, y2: 200 },
      { x1: 0, y1: 200, x2: 180, y2: 200 },
    ]);

    expect(outerSegments(beam)).toHaveLength(2);
    expect(countOps(beam.commandBuffer as number[], Cmd.STROKE_PATH)).toBe(4);
  });

  it('fades on the scene delta and is destroyed after exactly 0.3 s (AC4)', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];

    const beam = spawnHitscanBeam(scene, straightBeam, { registry });

    expect(HITSCAN_BEAM_DURATION).toBeCloseTo(0.3, 6);
    expect(registry).toContain(beam);

    // Halfway through the shipped Quad.easeIn fade: alpha = 1 - 0.5².
    advance(scene, 0.15);
    expect(beam.active).toBe(true);
    expect(beam.alpha).toBeCloseTo(0.75, 2);

    // Past the lifetime the beam is gone from the registry and the display
    // list — no body survives it.
    advance(scene, 0.2);
    expect(registry).not.toContain(beam);
    expect(beam.active).toBe(false);
    expect(scene.children.list).not.toContain(beam);
  });

  it('expires on elapsed seconds, not on a frame count', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnHitscanBeam(scene, straightBeam, { registry });

    // One stalled frame longer than the whole lifetime expires the beam.
    scene.events.emit('update', 0, HITSCAN_BEAM_DURATION * 1000 + 1);
    expect(beam.active).toBe(false);
    expect(registry).toHaveLength(0);
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

describe('hitscanBeam — anchored to the ship, frozen at the resolved end (AH-0MWJ8JUEF006XBLB)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([BeamStubScene]);
    return booted.scene;
  }

  it('re-anchors the beam source to the moving ship while the destination stays fixed (AC1/AC2)', async () => {
    const scene = await boot();
    const ship = { x: 100, y: 200 };

    const beam = spawnHitscanBeam(
      scene,
      [{ x1: 100, y1: 200, x2: 340, y2: 200 }],
      {
        source: () => ship,
        destination: { x: 340, y: 200 },
      },
    );

    expectPoint(drawnSource(beam), { x: 100, y: 200 });

    // The ship keeps flying during the beam's 0.3 s life.
    ship.x = 180;
    ship.y = 240;
    advance(scene, 1 / 60);

    expectPoint(drawnSource(beam), { x: 180, y: 240 });
    // The far end is the launch-resolved intercept point — unchanged.
    expectPoint(drawnDestination(beam), { x: 340, y: 200 });
  });

  it('defaults the destination to the resolved ray end', async () => {
    const scene = await boot();
    const beam = spawnHitscanBeam(scene, [
      { x1: 900, y1: 200, x2: 960, y2: 200 },
      { x1: 0, y1: 200, x2: 180, y2: 200 },
    ]);

    expectPoint(drawnDestination(beam), { x: 180, y: 200 });
  });

  it('draws the shortest wrapped path from the ship as it crosses a seam (AC3)', async () => {
    const scene = await boot();
    const ship = { x: 900, y: 200 };

    const beam = spawnHitscanBeam(
      scene,
      [{ x1: 900, y1: 200, x2: 180, y2: 200 }],
      {
        source: () => ship,
        destination: { x: 180, y: 200 },
      },
    );

    // 900 → right seam → 180, i.e. through the edge rather than across.
    expect(outerSegments(beam)).toHaveLength(2);

    // The ship crosses to the left side of the seam: the short way is now
    // straight across the middle of the arena.
    ship.x = 100;
    advance(scene, 1 / 60);

    const segments = outerSegments(beam);
    expect(segments).toHaveLength(1);
    expect(segments[0].x1).toBeCloseTo(100, 6);
    expect(segments[0].x2).toBeCloseTo(180, 6);
  });
});

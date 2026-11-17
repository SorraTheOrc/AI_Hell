/**
 * Unit tests for the shared anchored-beam VFX seam (AH-0MWJ8JUEF006XBLB).
 *
 * The two beam weapons (Wave Laser, Mining Laser) draw through this seam, so
 * the contract pinned here is consumed by both:
 *
 * - the source end re-anchors to the ship's **current** position each frame,
 *   while the destination is frozen at spawn (AC1/AC2/AC6);
 * - the polyline is the **shortest wrapped path**, re-derived every frame, so
 *   it changes shape when the ship crosses an arena seam mid-beam (AC3);
 * - the life is delta-driven and self-cleaning: one Graphics, cleared and
 *   re-stroked in place, destroyed on expiry and on scene shutdown (AC4);
 * - a source provider that stops yielding (ship destroyed) keeps the last
 *   resolved point instead of jumping to the origin (R3).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { GAME_WIDTH } from '../core/constants';
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
  spawnAnchoredBeam,
  wrappedBeamSegments,
  type BeamPoint,
} from './anchoredBeam';

/** Minimal bootable scene for the VFX helper. */
class AnchoredBeamStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'AnchoredBeamStubScene' });
  }
}



/** Advances the scene's `update` delta by `seconds` in fixed 60 fps steps. */
function advance(scene: Phaser.Scene, seconds: number, dt = 1 / 60): void {
  const frames = Math.max(1, Math.ceil(seconds / dt));
  for (let i = 0; i < frames; i += 1) {
    scene.events.emit('update', 0, dt * 1000);
  }
}

describe('anchoredBeam — shortest wrapped path geometry', () => {
  it('draws one straight segment when both ends are on the same side', () => {
    const segments = wrappedBeamSegments(
      { x: 100, y: 270 },
      { x: 340, y: 200 },
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].x1).toBeCloseTo(100, 6);
    expect(segments[0].y1).toBeCloseTo(270, 6);
    expect(segments[0].x2).toBeCloseTo(340, 6);
    expect(segments[0].y2).toBeCloseTo(200, 6);
  });

  it('travels through the nearest seam rather than across the arena', () => {
    const segments = wrappedBeamSegments(
      { x: GAME_WIDTH - 60, y: 270 },
      { x: 20, y: 270 },
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].x2).toBeCloseTo(GAME_WIDTH, 6);
    expect(segments[1].x1).toBeCloseTo(0, 6);
    expect(segments[1].x2).toBeCloseTo(20, 6);
  });

  it('honours an arena override', () => {
    const segments = wrappedBeamSegments(
      { x: 390, y: 100 },
      { x: 10, y: 100 },
      { arenaWidth: 400, arenaHeight: 200 },
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].x2).toBeCloseTo(400, 6);
    expect(segments[1].x1).toBeCloseTo(0, 6);
    expect(segments[1].x2).toBeCloseTo(10, 6);
  });
});

describe('anchoredBeam — the source follows, the destination does not', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([AnchoredBeamStubScene]);
    return booted.scene;
  }

  it('stitches the beam from the current source to the fixed destination on spawn', async () => {
    const scene = await boot();
    const ship = { x: 100, y: 200 };

    const beam = spawnAnchoredBeam(scene, {
      source: () => ship,
      destination: { x: 340, y: 200 },
    });

    expect(scene.children.list).toContain(beam);
    expectPoint(drawnSource(beam), { x: 100, y: 200 });
    expectPoint(drawnDestination(beam), { x: 340, y: 200 });
    // A column plus a hot core: two stroked passes over one run.
    expect(countOps(beam.commandBuffer as number[], Cmd.STROKE_PATH)).toBe(2);
    expect(countOps(beam.commandBuffer as number[], Cmd.FILL_PATH)).toBe(0);
  });

  it('re-anchors the source to the ship each frame while the destination stays put (AC1/AC2)', async () => {
    const scene = await boot();
    const ship = { x: 100, y: 200 };

    const beam = spawnAnchoredBeam(scene, {
      source: () => ship,
      destination: { x: 600, y: 200 },
    });

    // The ship flies on while the beam is still alive.
    ship.x = 220;
    ship.y = 140;
    advance(scene, 1 / 60);

    expectPoint(drawnSource(beam), { x: 220, y: 140 });
    // The far end never moves — the beam is not re-aimed at anything.
    expectPoint(drawnDestination(beam), { x: 600, y: 200 });
  });

  it('snapshots the destination so a drifting target cannot drag the far end (AC2)', async () => {
    const scene = await boot();
    const ship = { x: 100, y: 200 };
    const rock = { x: 600, y: 200 };

    const beam = spawnAnchoredBeam(scene, {
      source: () => ship,
      destination: rock,
    });

    // The caller's object drifts after the shot resolved.
    rock.x = 700;
    rock.y = 260;
    advance(scene, 1 / 60);

    expectPoint(drawnDestination(beam), { x: 600, y: 200 });
  });

  it('keeps the last resolved source when the ship disappears mid-beam (R3)', async () => {
    const scene = await boot();
    let ship: BeamPoint | null = { x: 150, y: 220 };

    const beam = spawnAnchoredBeam(scene, {
      source: () => ship,
      destination: { x: 500, y: 220 },
    });

    ship = null; // The player was destroyed while the beam is still on screen.
    advance(scene, 1 / 60);

    expectPoint(drawnSource(beam), { x: 150, y: 220 });
    expectPoint(drawnDestination(beam), { x: 500, y: 220 });
    expect(beam.active).toBe(true);
  });

  it('falls back to the supplied origin until the provider yields a point', async () => {
    const scene = await boot();

    const beam = spawnAnchoredBeam(scene, {
      source: () => null,
      origin: { x: 40, y: 60 },
      destination: { x: 500, y: 60 },
    });

    expectPoint(drawnSource(beam), { x: 40, y: 60 });
  });

  it('re-derives the wrapped path when the ship crosses a seam mid-beam (AC3)', async () => {
    const scene = await boot();
    const ship = { x: 390, y: 100 };

    const beam = spawnAnchoredBeam(scene, {
      source: () => ship,
      destination: { x: 10, y: 100 },
      arenaWidth: 400,
      arenaHeight: 200,
    });

    // Through the right seam: 390 → 400 then 0 → 10.
    expect(outerSegments(beam)).toHaveLength(2);
    expectPoint(drawnSource(beam), { x: 390, y: 100 });
    expectPoint(drawnDestination(beam), { x: 10, y: 100 });

    // The ship crosses the seam: the shortest path is now a straight run and
    // the beam must be redrawn, not left on the old through-the-edge geometry.
    ship.x = 100;
    advance(scene, 1 / 60);

    const segments = outerSegments(beam);
    expect(segments).toHaveLength(1);
    expect(segments[0].x1).toBeCloseTo(100, 6);
    expect(segments[0].x2).toBeCloseTo(10, 6);
  });
});

describe('anchoredBeam — delta-driven lifetime and cleanup', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([AnchoredBeamStubScene]);
    return booted.scene;
  }

  it('fades on elapsed seconds and destroys itself when its life runs out', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnAnchoredBeam(scene, {
      source: { x: 100, y: 200 },
      destination: { x: 600, y: 200 },
      duration: 0.3,
      registry,
    });

    expect(registry).toContain(beam);
    expect(beam.alpha).toBeCloseTo(1, 6);

    advance(scene, 0.15);
    // Halfway through a linear fade.
    expect(beam.alpha).toBeCloseTo(0.5, 1);
    expect(beam.active).toBe(true);

    advance(scene, 0.2);
    expect(beam.active).toBe(false);
    expect(registry).not.toContain(beam);
    expect(scene.children.list).not.toContain(beam);
  });

  it('expires on a single long frame rather than on a frame count', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnAnchoredBeam(scene, {
      source: { x: 100, y: 200 },
      destination: { x: 600, y: 200 },
      duration: 0.1,
      registry,
    });

    scene.events.emit('update', 0, 101);
    expect(beam.active).toBe(false);
    expect(registry).toHaveLength(0);
  });

  it('tears the beam down when the scene shuts down mid-life', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnAnchoredBeam(scene, {
      source: { x: 100, y: 200 },
      destination: { x: 600, y: 200 },
      registry,
    });

    scene.events.emit('shutdown');

    expect(beam.active).toBe(false);
    expect(registry).toHaveLength(0);
  });
});

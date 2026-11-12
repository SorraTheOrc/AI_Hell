/**
 * Mining Laser beam VFX + cue tests (AH-0MW9QMQ7B005WFH9, parent **Mining
 * laser** AH-0MW81181P007BDRU).
 *
 * The Mining Laser fires rapidly (up to one shot per sixteenth note), so its
 * feedback has to be cheap, short and self-cleaning:
 *
 * - a thin code-drawn beam ship → target, aged by the scene **delta** (never a
 *   frame/tick count) and destroyed when it expires;
 * - the short way round the wrapped arena (through-the-edge segments, never a
 *   line across the whole screen);
 * - repeated shots at the same target leave no game object or registry entry
 *   behind — including when the scene shuts down mid-life;
 * - the module itself plays the dedicated cutting tick, once per shot.
 *
 * The beam is never asserted pixel-wise: the exported constants, the geometry
 * helper and the lifecycle (registry + display list + destruction) are the
 * contract the shared firing seam consumes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../audio/effects';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import { HITSCAN_BEAM_COLOR } from './hitscanBeam';
import { ORBITAL_STRIKE_COLOR } from './orbitalStrike';
import {
  MINING_LASER_BEAM_COLOR,
  MINING_LASER_BEAM_DURATION,
  MINING_LASER_BEAM_WIDTH,
  miningLaserBeamSegments,
  spawnMiningLaserBeam,
} from './miningLaserBeam';

/** Minimal bootable scene for the VFX helper. */
class MiningBeamStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MiningBeamStubScene' });
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

/** Advances the scene's `update` delta by `seconds` in fixed 60 fps steps. */
function advance(scene: Phaser.Scene, seconds: number, dt = 1 / 60): void {
  // `ceil` so the stepped time always reaches (or passes) the requested span.
  const frames = Math.max(1, Math.ceil(seconds / dt));
  for (let i = 0; i < frames; i += 1) {
    scene.events.emit('update', 0, dt * 1000);
  }
}

describe('miningLaserBeam — wrapped aim geometry', () => {
  it('draws one straight segment when the target is on the same side of the arena', () => {
    const segments = miningLaserBeamSegments(
      { x: 100, y: 270 },
      { x: 340, y: 200 },
    );

    expect(segments).toHaveLength(1);
    expect(segments[0].x1).toBeCloseTo(100, 6);
    expect(segments[0].y1).toBeCloseTo(270, 6);
    expect(segments[0].x2).toBeCloseTo(340, 6);
    expect(segments[0].y2).toBeCloseTo(200, 6);
  });

  it('travels through the right seam instead of across the screen', () => {
    // Taxi across the right edge (x = 960) rather than 880 px back to the left.
    const segments = miningLaserBeamSegments(
      { x: GAME_WIDTH - 60, y: 270 },
      { x: 20, y: 270 },
    );

    expect(segments).toHaveLength(2);
    // Ship → right edge.
    expect(segments[0].x1).toBeCloseTo(GAME_WIDTH - 60, 6);
    expect(segments[0].x2).toBeCloseTo(GAME_WIDTH, 6);
    // Left edge → target (the re-emerged beam).
    expect(segments[1].x1).toBeCloseTo(0, 6);
    expect(segments[1].x2).toBeCloseTo(20, 6);
    // Every run is the short wrapped step, never the long way round.
    for (const segment of segments) {
      expect(Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)).toBeLessThanOrEqual(80);
    }
  });

  it('travels through the left seam for a target just past the left edge', () => {
    const segments = miningLaserBeamSegments(
      { x: 20, y: 270 },
      { x: GAME_WIDTH - 20, y: 270 },
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].x1).toBeCloseTo(20, 6);
    expect(segments[0].x2).toBeCloseTo(0, 6);
    expect(segments[1].x1).toBeCloseTo(GAME_WIDTH, 6);
    expect(segments[1].x2).toBeCloseTo(GAME_WIDTH - 20, 6);
  });

  it('travels through the top seam for a target just above the play area', () => {
    const segments = miningLaserBeamSegments(
      { x: 480, y: 20 },
      { x: 480, y: GAME_HEIGHT - 20 },
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].y1).toBeCloseTo(20, 6);
    expect(segments[0].y2).toBeCloseTo(0, 6);
    expect(segments[1].y1).toBeCloseTo(GAME_HEIGHT, 6);
    expect(segments[1].y2).toBeCloseTo(GAME_HEIGHT - 20, 6);
  });

  it('travels through the bottom seam for a target just below the play area', () => {
    const segments = miningLaserBeamSegments(
      { x: 480, y: GAME_HEIGHT - 20 },
      { x: 480, y: 20 },
    );

    expect(segments).toHaveLength(2);
    expect(segments[0].y1).toBeCloseTo(GAME_HEIGHT - 20, 6);
    expect(segments[0].y2).toBeCloseTo(GAME_HEIGHT, 6);
    expect(segments[1].y1).toBeCloseTo(0, 6);
    expect(segments[1].y2).toBeCloseTo(20, 6);
  });

  it('honours an arena override (gyms may size their own playfield)', () => {
    const segments = miningLaserBeamSegments(
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

describe('miningLaserBeam — the shot is visible and cheap', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([MiningBeamStubScene]);
    return booted.scene;
  }

  it('draws a thin amber column with a hot core along the wrapped path', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];

    const beam = spawnMiningLaserBeam(
      scene,
      { x: GAME_WIDTH - 60, y: 270 },
      { x: 20, y: 270 },
      { registry },
    );

    expect(scene.children.list).toContain(beam);
    expect(registry).toContain(beam);
    const buffer = beam.commandBuffer as number[];
    // Two passes (outer column + hot core) over two wrapped segments.
    expect(countOps(buffer, Cmd.STROKE_PATH)).toBe(4);
    expect(countOps(buffer, Cmd.MOVE_TO)).toBe(4);
    expect(countOps(buffer, Cmd.LINE_TO)).toBe(4);
    // A beam, never a filled blob or a fan.
    expect(countOps(buffer, Cmd.FILL_PATH)).toBe(0);
    // Thin by design: a rapid cadence must not become a screen wash.
    expect(MINING_LASER_BEAM_WIDTH).toBeLessThanOrEqual(2);
  });

  it('keeps the beam identity distinct from the wave laser and the strike', () => {
    expect(MINING_LASER_BEAM_COLOR).toBe(0xffa53a);
    expect(MINING_LASER_BEAM_COLOR).not.toBe(HITSCAN_BEAM_COLOR);
    expect(MINING_LASER_BEAM_COLOR).not.toBe(ORBITAL_STRIKE_COLOR);
  });

  it('uses a very short lifetime so shots never overlap into a wash', () => {
    expect(MINING_LASER_BEAM_DURATION).toBeGreaterThan(0);
    expect(MINING_LASER_BEAM_DURATION).toBeLessThan(0.2);
  });
});

describe('miningLaserBeam — delta-driven lifetime and cleanup', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([MiningBeamStubScene]);
    return booted.scene;
  }

  it('stays visible for the documented lifetime and then destroys itself', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnMiningLaserBeam(
      scene,
      { x: 100, y: 270 },
      { x: 340, y: 270 },
      { registry },
    );

    // A frame short of the lifetime: still alive and still registered.
    advance(scene, MINING_LASER_BEAM_DURATION * 0.9);
    expect(beam.active).toBe(true);
    expect(registry).toContain(beam);

    // Past the lifetime: gone from the display list and the registry.
    advance(scene, MINING_LASER_BEAM_DURATION * 0.2);
    expect(beam.active).toBe(false);
    expect(registry).not.toContain(beam);
    expect(scene.children.list).not.toContain(beam);
  });

  it('expires on elapsed seconds, not on a frame count (one long frame is enough)', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnMiningLaserBeam(
      scene,
      { x: 100, y: 270 },
      { x: 340, y: 270 },
      { registry },
    );

    // A single stalled frame longer than the whole lifetime expires the beam.
    scene.events.emit('update', 0, MINING_LASER_BEAM_DURATION * 1000 + 1);
    expect(beam.active).toBe(false);
    expect(registry).toHaveLength(0);
  });

  it('repeated shots at the same target leave no objects behind', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const baseline = scene.children.list.length;

    // A burst of shots in one instant (the worst case for object churn).
    const shots: Phaser.GameObjects.Graphics[] = [];
    for (let i = 0; i < 20; i += 1) {
      shots.push(
        spawnMiningLaserBeam(
          scene,
          { x: 100, y: 270 },
          { x: 340, y: 270 },
          { registry },
        ),
      );
    }
    expect(registry).toHaveLength(20);
    expect(scene.children.list.length).toBe(baseline + 20);

    // One lifetime later every shot has cleaned itself up — no growth.
    advance(scene, MINING_LASER_BEAM_DURATION * 1.1);
    expect(registry).toHaveLength(0);
    expect(scene.children.list.length).toBe(baseline);
    for (const shot of shots) expect(shot.active).toBe(false);
  });

  it('tears the beam down when the scene shuts down mid-life', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const beam = spawnMiningLaserBeam(
      scene,
      { x: 100, y: 270 },
      { x: 340, y: 270 },
      { registry },
    );

    scene.events.emit('shutdown');

    expect(beam.active).toBe(false);
    expect(registry).toHaveLength(0);
  });
});

describe('miningLaserBeam — the module owns its cue', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('plays the dedicated cutting tick exactly once per shot', async () => {
    booted = await bootScene([MiningBeamStubScene]);
    const scene = booted.scene;
    const cueSpy = vi.spyOn(effectsModule, 'playMiningLaserFireSound');

    spawnMiningLaserBeam(scene, { x: 100, y: 270 }, { x: 340, y: 270 });
    expect(cueSpy).toHaveBeenCalledTimes(1);

    // One cue per shot, so the sound rate can never outrun the shot cadence.
    spawnMiningLaserBeam(scene, { x: 100, y: 270 }, { x: 340, y: 270 });
    expect(cueSpy).toHaveBeenCalledTimes(2);

    cueSpy.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { createBullet } from './bulletUtils';

let game: Phaser.Game | undefined;

afterEach(async () => {
  if (game) {
    await game.destroy(true);
    game = undefined;
  }
});

describe('createBullet', () => {
  it('creates a bullet with the correct color', async () => {
    class HarnessScene extends Phaser.Scene {
      constructor() { super('HarnessScene'); }
    }
    const result = await bootScene([HarnessScene]);
    game = result.game;

    const bullet = createBullet({
      scene: result.scene,
      color: 0xff0000,
      size: 4,
      x: 100,
      y: 200,
    });

    expect(bullet.color).toBe(0xff0000);
  });

  it('returns a valid graphics object', async () => {
    class HarnessScene extends Phaser.Scene {
      constructor() { super('HarnessScene'); }
    }
    const result = await bootScene([HarnessScene]);
    game = result.game;

    const bullet = createBullet({
      scene: result.scene,
      color: 0x00ff00,
      size: 3,
      x: 0,
      y: 0,
    });

    expect(bullet.graphics).toBeDefined();
    expect(bullet.graphics.fillStyle).toBeDefined();
  });

  it('creates the graphics object via scene.add.graphics()', async () => {
    class HarnessScene extends Phaser.Scene {
      constructor() { super('HarnessScene'); }
    }
    const result = await bootScene([HarnessScene]);
    game = result.game;

    const addSpy = vi.spyOn(result.scene.add, 'graphics');

    createBullet({
      scene: result.scene,
      color: 0x0000ff,
      size: 5,
      x: 50,
      y: 50,
    });

    expect(addSpy).toHaveBeenCalled();
  });
});

// ── Shared bullet-shape rendering seam (AH-0MV8228MD009UBF7) ─────

const Cmd = {
  ARC: 0,
  LINE_TO: 4,
  MOVE_TO: 5,
  LINE_STYLE: 6,
  FILL_STYLE: 7,
  FILL_PATH: 8,
  STROKE_PATH: 9,
  FILL_TRIANGLE: 10,
} as const;

function countCmd(buf: number[], target: number): number {
  const widths: Record<number, number> = {
    [Cmd.ARC]: 7,
    [Cmd.LINE_TO]: 2,
    [Cmd.MOVE_TO]: 2,
    [Cmd.LINE_STYLE]: 3,
    [Cmd.FILL_STYLE]: 2,
    [Cmd.FILL_TRIANGLE]: 6,
  };
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (widths[buf[i]] ?? 0)) {
    if (buf[i] === target) count += 1;
  }
  return count;
}

describe('createBullet — shape seam (AH-0MV8228MD009UBF7)', () => {
  async function bulletWith(
    shape: Parameters<typeof createBullet>[0]['shape'],
  ) {
    class ShapeScene extends Phaser.Scene {
      constructor() { super('ShapeScene'); }
    }
    const result = await bootScene([ShapeScene]);
    game = result.game;
    return createBullet({
      scene: result.scene,
      color: 0x00ccff,
      size: 3,
      x: 10,
      y: 20,
      shape,
    });
  }

  it('defaults to a filled disc (legacy fillCircle behaviour preserved)', async () => {
    const bullet = await bulletWith(undefined);
    const buf = bullet.graphics.commandBuffer as number[];
    expect(countCmd(buf, Cmd.ARC)).toBeGreaterThanOrEqual(1);
    expect(countCmd(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('renders a spark shape with a filled multi-segment path', async () => {
    const bullet = await bulletWith('spark');
    const buf = bullet.graphics.commandBuffer as number[];
    expect(countCmd(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(6);
    expect(countCmd(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('renders a line/beam shape (capturer tractor-beam identity) as a stroked segment', async () => {
    const bullet = await bulletWith('line');
    const buf = bullet.graphics.commandBuffer as number[];
    expect(countCmd(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
  });

  it('rotates the Graphics to a supplied travel angle', async () => {
    class AngleScene extends Phaser.Scene {
      constructor() { super('AngleScene'); }
    }
    const result = await bootScene([AngleScene]);
    game = result.game;
    const bullet = createBullet({
      scene: result.scene,
      color: 0x00ccff,
      size: 3,
      x: 0,
      y: 0,
      shape: 'line',
      angle: Math.PI / 2,
    });
    expect(bullet.graphics.rotation).toBeCloseTo(Math.PI / 2, 5);
  });
});

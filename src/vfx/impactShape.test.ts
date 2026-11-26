/**
 * Impact-flash **shape** rendering (AH-0MWL88YYO0053DWH — parent AC8).
 *
 * `ImpactFxShape` is what makes the matchup states readable with colour
 * removed: `'circle'` (today's per-weapon flash), `'shard'` (the effective
 * critical burst) and `'spall'` (the resisted armour ring). This suite pins
 * that each shape draws a genuinely different primitive set through
 * `spawnBulletImpact`, and that the absent-shape default stays the original
 * single filled disc.
 *
 * @module vfx/impactShape.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { BULLET_IMPACT_COLOR, spawnBulletImpact } from './bulletImpact';

class ShapeHarnessScene extends Phaser.Scene {
  constructor() {
    super('ImpactShapeHarness');
  }
}

describe('impact flash shapes (AH-0MWL88YYO0053DWH)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([ShapeHarnessScene]);
    return booted.scene;
  }

  it('defaults to the original single filled disc', async () => {
    const scene = await boot();
    const fillCircle = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'fillCircle',
    );
    const strokeCircle = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'strokeCircle',
    );
    const fillRect = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'fillRect',
    );
    const lineTo = vi.spyOn(Phaser.GameObjects.Graphics.prototype, 'lineTo');

    spawnBulletImpact(scene, 10, 20);

    expect(fillCircle).toHaveBeenCalledTimes(1);
    expect(strokeCircle).not.toHaveBeenCalled();
    expect(fillRect).not.toHaveBeenCalled();
    expect(lineTo).not.toHaveBeenCalled();
  });

  it('a shard burst draws radiating triangles, not a hollow ring', async () => {
    const scene = await boot();
    const lineTo = vi.spyOn(Phaser.GameObjects.Graphics.prototype, 'lineTo');
    const strokeCircle = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'strokeCircle',
    );
    const fillRect = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'fillRect',
    );

    spawnBulletImpact(scene, 10, 20, { shape: 'shard', color: 0xfff6cc });

    // A hot core plus six shard triangles: two `lineTo` edges per triangle.
    expect(lineTo.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(strokeCircle).not.toHaveBeenCalled();
    expect(fillRect).not.toHaveBeenCalled();
  });

  it('a spall ring draws a hollow ring and chips, not a filled disc', async () => {
    const scene = await boot();
    const fillCircle = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'fillCircle',
    );
    const strokeCircle = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'strokeCircle',
    );
    const fillRect = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'fillRect',
    );

    spawnBulletImpact(scene, 10, 20, { shape: 'spall', color: 0x8a8f99 });

    expect(strokeCircle).toHaveBeenCalledTimes(1);
    expect(fillRect.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fillCircle).not.toHaveBeenCalled();
  });

  it('keeps the requested colour on the default disc', async () => {
    const scene = await boot();
    const fillStyle = vi.spyOn(
      Phaser.GameObjects.Graphics.prototype,
      'fillStyle',
    );

    spawnBulletImpact(scene, 1, 2, { color: 0xabcdef });

    expect(fillStyle).toHaveBeenCalledWith(0xabcdef, 0.9);
    // Explicit colour overrides the default.
    expect(fillStyle).not.toHaveBeenCalledWith(BULLET_IMPACT_COLOR, 0.9);
  });
});

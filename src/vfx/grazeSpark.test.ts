/**
 * Unit tests for the shared graze spark fan (AH-0MWL7ORK8007LXJI AC5).
 *
 * The spark is the visual half of a graze: it must appear at the nearest point
 * of the grazed hostile and it must carry the danger tier as **shape** (more,
 * longer, wider-spread ticks), never colour alone — a colour-blind player has
 * to be able to read the chain from the cue.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  GRAZE_SPARK_ALPHA,
  GRAZE_SPARK_COLOR,
  GRAZE_SPARK_DEPTH,
  GRAZE_SPARK_DURATION,
  GRAZE_SPARK_LINE_WIDTH,
  GRAZE_SPARK_MIN_TICKS,
  grazeSparkLength,
  grazeSparkSpread,
  grazeSparkTicks,
  spawnGrazeSpark,
} from './grazeSpark';

/** Minimal bootable scene for the VFX helper. */
class VfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GrazeSparkStubScene' });
  }
}

/** Counts MOVE_TO/LINE_TO pairs in a Graphics command buffer (one tick each). */
function countTicks(buf: number[]): number {
  let ticks = 0;
  for (const op of buf) if (op === 5) ticks += 1; // 5 = MOVE_TO
  return ticks;
}

describe('grazeSpark — shared graze spark fan (AH-0MWL7ORK8007LXJI)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([VfxStubScene]);
    return booted.scene;
  }

  it('pins the shared appearance constants', () => {
    expect(GRAZE_SPARK_COLOR).toBeGreaterThan(0);
    expect(GRAZE_SPARK_LINE_WIDTH).toBeGreaterThan(0);
    expect(GRAZE_SPARK_ALPHA).toBeGreaterThan(0);
    expect(GRAZE_SPARK_ALPHA).toBeLessThanOrEqual(1);
    expect(GRAZE_SPARK_DURATION).toBeGreaterThan(0);
    expect(GRAZE_SPARK_DEPTH).toBeGreaterThan(50); // above the ship visuals
    expect(GRAZE_SPARK_MIN_TICKS).toBeGreaterThanOrEqual(1);
  });

  it('grows its shape monotonically with the danger tier', () => {
    for (let tier = 1; tier < 5; tier += 1) {
      expect(grazeSparkTicks(tier)).toBeGreaterThan(grazeSparkTicks(tier - 1));
      expect(grazeSparkLength(tier)).toBeGreaterThan(
        grazeSparkLength(tier - 1),
      );
      expect(grazeSparkSpread(tier)).toBeGreaterThan(
        grazeSparkSpread(tier - 1),
      );
    }
    // Never colour-only: the top tier is a visibly different shape.
    expect(grazeSparkTicks(4)).toBeGreaterThan(grazeSparkTicks(0) * 2);
  });

  it('clamps a degenerate tier instead of drawing nonsense', () => {
    expect(grazeSparkTicks(-5)).toBe(grazeSparkTicks(0));
    expect(grazeSparkTicks(99)).toBe(grazeSparkTicks(4));
    expect(Number.isFinite(grazeSparkSpread(Number.NaN))).toBe(true);
  });

  it('spawns the fan at the nearest band point and tracks it in the registry', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const spark = spawnGrazeSpark(scene, 300, 200, { registry, tierIndex: 2 });

    expect(spark.x).toBe(300);
    expect(spark.y).toBe(200);
    expect(spark.depth).toBe(GRAZE_SPARK_DEPTH);
    expect(registry).toContain(spark);
    expect(scene.children.list).toContain(spark);
    expect(tweenSpy).toHaveBeenCalledTimes(1);

    // The tier is drawn as shape: more ticks at a higher tier.
    const low = spawnGrazeSpark(scene, 0, 0, { tierIndex: 0 });
    expect(countTicks(spark.commandBuffer)).toBe(grazeSparkTicks(2));
    expect(countTicks(low.commandBuffer)).toBe(grazeSparkTicks(0));
    expect(countTicks(spark.commandBuffer)).toBeGreaterThan(
      countTicks(low.commandBuffer),
    );
  });

  it('points the fan along the ship→hostile direction', async () => {
    const scene = await boot();
    // Fan due right (angle 0): every tick's line ends at a non-negative x.
    const spark = spawnGrazeSpark(scene, 0, 0, { tierIndex: 4, angle: 0 });
    const buf = spark.commandBuffer;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== 4) continue; // 4 = LINE_TO
      expect(buf[i + 1]).toBeGreaterThan(0);
    }
  });

  it('removes itself from the registry when the tween completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const spark = spawnGrazeSpark(scene, 10, 10, { registry });
    expect(registry).toHaveLength(1);

    // Drive the configured completion callback deterministically.
    const config = tweenSpy.mock
      .calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).toHaveLength(0);
    expect(spark.active).toBe(false);
    expect(config.duration).toBe(GRAZE_SPARK_DURATION * 1000);
  });
});

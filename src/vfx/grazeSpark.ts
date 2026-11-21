/**
 * Graze spark arc (AH-0MWL7ORK8007LXJI AC5).
 *
 * A graze is a near miss the player can feel but not see: the hull art is
 * wider than the collision footprint, so the band between "hit" and "near
 * miss" is invisible. This module is the single shared cue for it — a short
 * arc of sparks struck at the nearest point of the grazed hostile, so the
 * reward always reads *at the closest approach* rather than on the ship.
 *
 * The cue carries the danger tier in its **shape**, never in colour alone:
 * the arc's tick count and sweep grow with the tier, so a `×5` graze reads
 * as a visibly longer, denser arc than a `×1` one for a colour-blind player
 * (AC5 accessibility).
 *
 * Built on the shared Phaser Graphics + tween pattern (`spawnBulletImpact`,
 * `spawnThornsAbsorbBurst`) and spawned from the shared graze pass in
 * `CombatScene`, so the game and every combat gym fire the identical spark
 * (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * @module vfx/grazeSpark
 */

import Phaser from 'phaser';

/** Spark colour — a bright cyan-white, deliberately unlike any threat colour. */
export const GRAZE_SPARK_COLOR = 0xbfefff;

/** Spark depth — under the HUD, over the collision it marks. */
export const GRAZE_SPARK_DEPTH = 58;

/** Spark ticks at the bottom tier (`×1`). */
export const GRAZE_SPARK_MIN_TICKS = 3;

/** Extra ticks per tier above the bottom — the tier is legible as shape. */
export const GRAZE_SPARK_TICKS_PER_TIER = 2;

/** Base tick length (px) at the bottom tier. */
export const GRAZE_SPARK_MIN_LENGTH = 6;

/** Extra tick length (px) per tier (the arc visibly grows). */
export const GRAZE_SPARK_LENGTH_PER_TIER = 2.5;

/** Half-angle (radians) swept by the spark fan at the bottom tier. */
export const GRAZE_SPARK_MIN_SPREAD = Math.PI / 6;

/** Extra half-angle (radians) per tier (the fan opens as the chain climbs). */
export const GRAZE_SPARK_SPREAD_PER_TIER = Math.PI / 12;

/** Spark stroke width (px). */
export const GRAZE_SPARK_LINE_WIDTH = 2;

/** Peak stroke alpha of the sparks. */
export const GRAZE_SPARK_ALPHA = 0.9;

/** Spark lifetime (seconds) — brief so a dense graze run does not smear. */
export const GRAZE_SPARK_DURATION = 0.22;

/** Final scale the sparks expand to while fading. */
export const GRAZE_SPARK_END_SCALE = 1.35;

/**
 * Highest danger tier index the cue renders (`×5`). A tier beyond it clamps
 * rather than drawing an unbounded fan.
 */
export const GRAZE_SPARK_MAX_TIER = 4;

/** Clamps a tier index into `[0, GRAZE_SPARK_MAX_TIER]` (non-finite → 0). */
function clampTier(tierIndex: number): number {
  if (!Number.isFinite(tierIndex)) return 0;
  return Math.max(0, Math.min(GRAZE_SPARK_MAX_TIER, Math.floor(tierIndex)));
}

/**
 * Half-angle of the spark fan the scene anchors the fan on. The fan points
 * away from the ship (the sparks strike the hostile's near face), so the
 * caller passes the angle from ship to hostile.
 *
 * @param tierIndex — current danger tier (0 = `×1`).
 */
export function grazeSparkTicks(tierIndex: number): number {
  return GRAZE_SPARK_MIN_TICKS + clampTier(tierIndex) * GRAZE_SPARK_TICKS_PER_TIER;
}

/** Tick length (px) for the tier — grows with the chain. */
export function grazeSparkLength(tierIndex: number): number {
  return (
    GRAZE_SPARK_MIN_LENGTH + clampTier(tierIndex) * GRAZE_SPARK_LENGTH_PER_TIER
  );
}

/** Half-angle (radians) of the spark fan for the tier. */
export function grazeSparkSpread(tierIndex: number): number {
  return (
    GRAZE_SPARK_MIN_SPREAD + clampTier(tierIndex) * GRAZE_SPARK_SPREAD_PER_TIER
  );
}

/** Options for {@link spawnGrazeSpark}. */
export interface GrazeSparkOptions {
  /**
   * Optional registry the spawned sparks are added to while alive (removed on
   * completion) — lets scenes track/tear down the effect and tests observe it
   * without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Danger tier the cue renders (0 = `×1`); drives ticks/length/sweep. */
  tierIndex?: number;
  /**
   * Direction (radians) the fan points in — the angle from the ship to the
   * hostile. Defaults to 0 (fan to the right).
   */
  angle?: number;
  /** Spark colour override (Phaser integer). */
  color?: number;
  /** Lifetime override (seconds). */
  duration?: number;
}

/**
 * Spawns the graze spark fan at (x, y) — the nearest point of the grazed
 * hostile — expanding and fading, then destroying itself.
 *
 * @returns The spark Graphics (destroyed when the tween completes).
 */
export function spawnGrazeSpark(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: GrazeSparkOptions = {},
): Phaser.GameObjects.Graphics {
  const tierIndex = options.tierIndex ?? 0;
  const angle = options.angle ?? 0;
  const color = options.color ?? GRAZE_SPARK_COLOR;
  const duration = options.duration ?? GRAZE_SPARK_DURATION;
  const registry = options.registry;

  const ticks = grazeSparkTicks(tierIndex);
  const length = grazeSparkLength(tierIndex);
  const spread = grazeSparkSpread(tierIndex);

  const spark = scene.add.graphics();
  spark.setPosition(x, y);
  spark.setDepth(GRAZE_SPARK_DEPTH);
  spark.lineStyle(GRAZE_SPARK_LINE_WIDTH, color, GRAZE_SPARK_ALPHA);
  for (let i = 0; i < ticks; i += 1) {
    // Fan the ticks evenly across the sweep: one tick at the centre for the
    // bottom tier, more as the chain climbs — the tier is read as shape.
    const offset =
      ticks === 1 ? 0 : -spread + (2 * spread * i) / Math.max(1, ticks - 1);
    const tickAngle = angle + offset;
    // Alternate long/short ticks so the arc reads ragged, not geometric.
    const tickLength = length * (i % 2 === 0 ? 1 : 0.65);
    spark.beginPath();
    spark.moveTo(0, 0);
    spark.lineTo(
      Math.cos(tickAngle) * tickLength,
      Math.sin(tickAngle) * tickLength,
    );
    spark.strokePath();
  }
  registry?.push(spark);

  scene.tweens.add({
    targets: spark,
    alpha: 0,
    scale: GRAZE_SPARK_END_SCALE,
    duration: duration * 1000,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(spark);
        if (index >= 0) registry.splice(index, 1);
      }
      spark.destroy();
    },
  });

  return spark;
}

/**
 * Cluster/MIRV split-burst VFX (AH-0MV1BIVIJ007KYXU).
 *
 * A distinct, code-drawn neon-vector burst for the Missile Command cluster
 * missile's split point. It is deliberately **not** an `AoEDescriptor`
 * effect — the split is a projectile seam, not an area effect — so it lives
 * in its own helper rather than `vfx/aoeEffect.ts`. The shared combat core
 * spawns it through `CombatCoreScene.splitProjectile`, so the game and every
 * gym show the identical split feedback.
 *
 * The burst is a bright centre flash with the same number of radiating
 * fragment spokes as the warheads spawned, expanding and fading out. The
 * helper returns a handle exposing the Graphics and a completion flag, and
 * appends the Graphics to an optional caller-owned registry (removed on
 * completion) so scenes can clean up on shutdown and tests can observe the
 * effect without pixel assertions.
 *
 * @module vfx/splitBurst
 */

import type Phaser from 'phaser';

/** Split-burst flash/spoke colour — matches the cluster bullet colour. */
export const SPLIT_BURST_COLOR = 0xff3366;

/** Split-burst expansion/fade duration (seconds). */
export const SPLIT_BURST_DURATION = 0.3;

/** Split-burst starting scale (fraction of the final radius). */
export const SPLIT_BURST_START_SCALE = 0.35;

/** Options for {@link spawnSplitBurst}. */
export interface SplitBurstOptions {
  /**
   * Optional registry the spawned Graphics is added to while alive and
   * removed from on completion — lets scenes clean up on shutdown and tests
   * observe the effect without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Effect duration override (seconds). */
  duration?: number;
  /** Effect colour override (Phaser integer). */
  color?: number;
}

/** Handle returned by {@link spawnSplitBurst}. */
export interface SplitBurstHandle {
  /** The effect Graphics (destroyed when the effect completes). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** The effect radius in px (the drawn burst's un-scaled radius). */
  readonly radius: number;
  /** True once the effect has finished and been torn down. */
  isComplete(): boolean;
}

/**
 * Spawns the cluster split burst at (x, y): a bright centre flash ringed by
 * `spokes` radiating fragment lines, expanding to `radius` while fading.
 *
 * The warheads are spawned before this is called — the burst is the split
 * point's visual feedback.
 *
 * @param scene - The owning scene (tween owner).
 * @param x - Split centre x.
 * @param y - Split centre y.
 * @param radius - Final burst radius in px.
 * @param spokes - Number of radiating fragment spokes (usually the warhead count).
 * @param options - Optional registry/duration/colour overrides.
 * @returns A {@link SplitBurstHandle} for observation/teardown.
 */
export function spawnSplitBurst(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  spokes: number,
  options: SplitBurstOptions = {},
): SplitBurstHandle {
  const duration = options.duration ?? SPLIT_BURST_DURATION;
  const color = options.color ?? SPLIT_BURST_COLOR;
  const registry = options.registry;

  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  graphics.setScale(SPLIT_BURST_START_SCALE);
  // Flash core — the bright split centre.
  graphics.fillStyle(color, 0.4);
  graphics.fillCircle(0, 0, radius * 0.35);
  // Radiating fragment spokes — the cluster signature (distinct from the
  // Nova ring and the Mortar's explosion spikes by its driven spoke count).
  graphics.lineStyle(2, color, 1);
  const count = Math.max(1, Math.round(spokes));
  const inner = radius * 0.3;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    graphics.beginPath();
    graphics.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    graphics.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    graphics.strokePath();
  }

  registry?.push(graphics);

  let complete = false;
  scene.tweens.add({
    targets: graphics,
    scale: 1,
    alpha: 0,
    duration: duration * 1000,
    ease: 'Cubic.easeOut',
    onComplete: () => {
      complete = true;
      if (registry) {
        const index = registry.indexOf(graphics);
        if (index >= 0) registry.splice(index, 1);
      }
      graphics.destroy();
    },
  });

  return {
    graphics,
    radius,
    isComplete: () => complete,
  };
}

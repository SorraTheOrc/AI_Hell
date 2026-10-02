/**
 * Area-of-effect weapon VFX helpers (parent AH-0MUOOB3OR001V8CD).
 *
 * Distinct, code-drawn neon-vector effects for the AOE weapon family, built
 * on the shared Phaser Graphics + tween pattern (`spawnBulletImpact`). The
 * game and every gym spawn these through the shared `CombatScene` dispatch
 * hook, so the feedback cannot drift between scenes.
 *
 * Each helper returns an {@link AoeEffectHandle} exposing the effect's
 * Graphics and a completion flag, and appends the Graphics to an optional
 * caller-owned registry (removed on completion) so tests can observe the
 * effect without pixel assertions — matching the shared teardown pattern.
 *
 * F2 ships the Nova expanding ring; F3/F4 add the Mortar detonation and Arc
 * chain helpers alongside it.
 *
 * @module vfx/aoeEffect
 */

import type Phaser from 'phaser';

/** Nova ring colour — pale cyan, matching the Nova bullet colour. */
export const NOVA_RING_COLOR = 0x66ffff;

/** Nova ring total expansion/fade duration (seconds). */
export const NOVA_RING_DURATION = 0.5;

/** Nova ring stroke width (px) for the outer ring. */
export const NOVA_RING_LINE_WIDTH = 3;

/** Nova ring starting scale (fraction of the final radius) — grows outward. */
export const NOVA_RING_START_SCALE = 0.15;

/** Options common to the AOE VFX helpers. */
export interface AoeEffectOptions {
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

/** Handle returned by the AOE VFX helpers. */
export interface AoeEffectHandle {
  /** The effect Graphics (destroyed when the effect completes). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** The effect radius in px (the drawn ring's un-scaled radius). */
  readonly radius: number;
  /** True once the effect has finished and been torn down. */
  isComplete(): boolean;
}

/**
 * Spawns the Nova expanding ring at (x, y): two concentric neon rings that
 * grow from the ship position outward to `radius` while fading out. The
 * damage/clear resolves instantly at trigger time — the ring is purely
 * cosmetic feedback that reads as "a pulse expanded from the ship".
 *
 * @param scene - The owning scene (tween owner).
 * @param x - Ring centre x (the ship position at fire time).
 * @param y - Ring centre y.
 * @param radius - Final ring radius in px (the AOE effect radius).
 * @param options - Optional registry/duration/colour overrides.
 * @returns An {@link AoeEffectHandle} for observation/teardown.
 */
export function spawnNovaRing(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  options: AoeEffectOptions = {},
): AoeEffectHandle {
  const duration = options.duration ?? NOVA_RING_DURATION;
  const color = options.color ?? NOVA_RING_COLOR;
  const registry = options.registry;

  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  graphics.setScale(NOVA_RING_START_SCALE);
  // Outer ring — the primary pulse edge.
  graphics.lineStyle(NOVA_RING_LINE_WIDTH, color, 1);
  graphics.strokeCircle(0, 0, radius);
  // Inner ring — a fainter echo for depth, expanding with the outer ring.
  graphics.lineStyle(1, color, 0.5);
  graphics.strokeCircle(0, 0, radius * 0.72);

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

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

// ── Mortar detonation burst (F3) ────────────────────────────────────

/** Mortar burst colour — deep orange, matching the Mortar shell colour. */
export const MORTAR_BURST_COLOR = 0xff6600;

/** Mortar burst expansion/fade duration (seconds). */
export const MORTAR_BURST_DURATION = 0.4;

/** Mortar burst starting scale (fraction of the final radius). */
export const MORTAR_BURST_START_SCALE = 0.3;

/** Number of radiating spikes in the Mortar burst. */
export const MORTAR_BURST_SPIKE_COUNT = 8;

/**
 * Spawns the Mortar detonation burst at (x, y): a filled flash core ringed by
 * radiating spikes, expanding to `radius` while fading. Visually distinct from
 * the Nova concentric rings and from the P4 bomb icon.
 *
 * The blast's damage/clear resolves before this is called — the burst is the
 * impact-point feedback.
 *
 * @param scene - The owning scene (tween owner).
 * @param x - Detonation centre x (the projectile's impact/expiry point).
 * @param y - Detonation centre y.
 * @param radius - Final burst radius in px (the AOE effect radius).
 * @param options - Optional registry/duration/colour overrides.
 * @returns An {@link AoeEffectHandle} for observation/teardown.
 */
export function spawnMortarBurst(
  scene: Phaser.Scene,
  x: number,
  y: number,
  radius: number,
  options: AoeEffectOptions = {},
): AoeEffectHandle {
  const duration = options.duration ?? MORTAR_BURST_DURATION;
  const color = options.color ?? MORTAR_BURST_COLOR;
  const registry = options.registry;

  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  graphics.setScale(MORTAR_BURST_START_SCALE);
  // Flash core — the bright blast centre.
  graphics.fillStyle(color, 0.35);
  graphics.fillCircle(0, 0, radius);
  // Radiating spikes — the explosion-burst signature (distinct from a ring).
  graphics.lineStyle(2, color, 1);
  const inner = radius * 0.5;
  for (let i = 0; i < MORTAR_BURST_SPIKE_COUNT; i++) {
    const angle = (i / MORTAR_BURST_SPIKE_COUNT) * Math.PI * 2;
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

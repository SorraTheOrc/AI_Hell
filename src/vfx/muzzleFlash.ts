/**
 * Per-weapon muzzle flash / launch cue (AH-0MV8228YW0050IXS).
 *
 * The clean short flash a weapon shows at the ship when it fires. It is
 * deliberately cheap — a small code-drawn Graphics burst with a short fade —
 * and is spawned ONCE per shot from the shared combat-core spawn path
 * (`CombatCoreScene._autoFire`, driven by the weapon's `muzzleFlash`
 * metadata), so the game and every gym show the identical launch cue with no
 * per-scene copy. Shapes with no `muzzleFlash` metadata (every enemy and the
 * AOE weapons) spawn nothing — the flash is opt-in per weapon.
 *
 * `spawnMuzzleFlash` returns the live Graphics and appends it to an optional
 * caller-owned registry (removed on completion) so scenes can clean up on
 * shutdown and tests can observe the effect without pixel assertions — the
 * same pattern as `vfx/bulletImpact` and `vfx/splitBurst`.
 *
 * @module vfx/muzzleFlash
 */

import type Phaser from 'phaser';

/** Default muzzle-flash core radius (px). */
export const MUZZLE_FLASH_RADIUS = 7;

/** Default muzzle-flash fade duration (s) — brief so rapid fire stays clean. */
export const MUZZLE_FLASH_DURATION = 0.12;

/** Default muzzle-flash colour (bright white — the "hot launch" centre). */
export const MUZZLE_FLASH_COLOR = 0xffffff;

/** Options for {@link spawnMuzzleFlash}. */
export interface MuzzleFlashOptions {
  /**
   * Optional registry the flash is added to while alive (removed on
   * completion) — lets scenes clean up and tests observe the VFX.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Flash core radius (px). Defaults to {@link MUZZLE_FLASH_RADIUS}. */
  radius?: number;
  /** Flash fade duration (s). Defaults to {@link MUZZLE_FLASH_DURATION}. */
  duration?: number;
  /** Flash colour (Phaser integer). Defaults to {@link MUZZLE_FLASH_COLOR}. */
  color?: number;
}

/**
 * Spawns a clean muzzle flash at (x, y) facing `heading` (radians): a bright
 * white-hot disc core ringed by the weapon's colour, with two short forward
 * spikes along the aim. The flash grows and fades, then destroys itself.
 *
 * @returns The flash Graphics (destroyed when the tween completes).
 */
export function spawnMuzzleFlash(
  scene: Phaser.Scene,
  x: number,
  y: number,
  heading: number,
  options: MuzzleFlashOptions = {},
): Phaser.GameObjects.Graphics {
  const radius = options.radius ?? MUZZLE_FLASH_RADIUS;
  const duration = options.duration ?? MUZZLE_FLASH_DURATION;
  const registry = options.registry;
  const color = options.color ?? MUZZLE_FLASH_COLOR;

  const flash = scene.add.graphics();
  flash.setPosition(x, y);
  flash.setRotation(heading);
  // Hot white core inside the weapon-coloured burst — a clean launch, not a
  // fog of shapes.
  flash.fillStyle(0xffffff, 0.9);
  flash.fillCircle(0, 0, radius * 0.35);
  flash.fillStyle(color, 0.85);
  flash.fillCircle(0, 0, radius * 0.55);
  // Two short forward spikes mark the aim direction.
  flash.lineStyle(2, color, 0.9);
  flash.beginPath();
  flash.moveTo(radius * 0.2, 0);
  flash.lineTo(radius * 1.2, radius * 0.5);
  flash.moveTo(radius * 0.2, 0);
  flash.lineTo(radius * 1.2, -radius * 0.5);
  flash.strokePath();
  registry?.push(flash);

  scene.tweens.add({
    targets: flash,
    alpha: 0,
    scale: 1.5,
    duration: duration * 1000,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(flash);
        if (index >= 0) registry.splice(index, 1);
      }
      flash.destroy();
    },
  });

  return flash;
}

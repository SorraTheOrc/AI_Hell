/**
 * Shared enemy fire-time launch pop (AH-0MV822CQL005R4MM).
 *
 * The small pop an enemy shows at its body when a shot leaves — the enemy
 * side of the player's per-weapon `spawnMuzzleFlash`. It is deliberately
 * cheap: a compact code-drawn burst (hot core + tinted ring + aim spike)
 * with a short fade, spawned once per shot.
 *
 * Spawned from the entity's **shared fire method** (`tryFireAimedBullet` via
 * the `fireForEnemy` seam every scene drives), keyed by the identity's
 * `muzzle` metadata in `ENEMY_BULLET_VISUALS` — so the game and every gym
 * pop identically with no per-scene copy, exactly the shipment the player
 * weapons get from `CombatCoreScene._autoFire`. The pop returns the live
 * Graphics and appends it to an optional caller-owned registry (removed on
 * completion), the same pattern as `vfx/muzzleFlash` and `vfx/bulletImpact`.
 *
 * @module vfx/enemyMuzzleFlash
 */

import Phaser from 'phaser';

/** Default launch-pop core radius (px). */
export const ENEMY_MUZZLE_FLASH_RADIUS = 5;

/** Default launch-pop fade duration (s) — brief, like the player's flash. */
export const ENEMY_MUZZLE_FLASH_DURATION = 0.12;

/** Default launch-pop colour (bright white-hot centre). */
export const ENEMY_MUZZLE_FLASH_COLOR = 0xffffff;

/** Options for {@link spawnEnemyMuzzleFlash}. */
export interface EnemyMuzzleFlashOptions {
  /**
   * Optional registry the pop is added to while alive (removed on
   * completion) — lets scenes clean up and tests observe the VFX.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Launch-pop core radius (px). Defaults to {@link ENEMY_MUZZLE_FLASH_RADIUS}. */
  radius?: number;
  /** Launch-pop fade duration (s). Defaults to {@link ENEMY_MUZZLE_FLASH_DURATION}. */
  duration?: number;
  /** Pop colour (Phaser integer). Defaults to {@link ENEMY_MUZZLE_FLASH_COLOR}. */
  color?: number;
}

/**
 * Spawns a compact launch pop at (x, y) facing `heading` (radians): a hot
 * white core inside the enemy-coloured burst, a faint tinted ring, and a
 * short spike along the aim. The pop fades and destroys itself.
 *
 * @returns The pop Graphics (destroyed when the tween completes).
 */
export function spawnEnemyMuzzleFlash(
  scene: Phaser.Scene,
  x: number,
  y: number,
  heading: number,
  options: EnemyMuzzleFlashOptions = {},
): Phaser.GameObjects.Graphics {
  const radius = options.radius ?? ENEMY_MUZZLE_FLASH_RADIUS;
  const duration = options.duration ?? ENEMY_MUZZLE_FLASH_DURATION;
  const registry = options.registry;
  const color = options.color ?? ENEMY_MUZZLE_FLASH_COLOR;

  const pop = scene.add.graphics();
  pop.setPosition(x, y);
  pop.setRotation(heading);
  // Hot white launch core inside the enemy-coloured burst — a compact pop,
  // not a fog of shapes.
  pop.fillStyle(0xffffff, 0.9);
  pop.fillCircle(0, 0, radius * 0.4);
  pop.fillStyle(color, 0.8);
  pop.fillCircle(0, 0, radius * 0.6);
  // Faint tinted ring + aim spike mark the fire heading.
  pop.lineStyle(1, color, 0.55);
  pop.strokeCircle(0, 0, radius * 1.15);
  pop.lineStyle(1.5, color, 0.85);
  pop.beginPath();
  pop.moveTo(radius * 0.2, -radius * 0.5);
  pop.lineTo(radius * 1.1, 0);
  pop.lineTo(radius * 0.2, radius * 0.5);
  pop.strokePath();
  registry?.push(pop);

  scene.tweens.add({
    targets: pop,
    alpha: 0,
    scale: 1.6,
    duration: duration * 1000,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(pop);
        if (index >= 0) registry.splice(index, 1);
      }
      pop.destroy();
    },
  });

  return pop;
}

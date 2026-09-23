/**
 * Small bullet-vs-bullet impact flash (AH-0MU43IIQV001S5JR, hosted by the
 * shared combat core AH-0MUD8E015004C4JO AC5).
 *
 * When a player bullet intercepts an enemy bullet, both projectiles are
 * destroyed. This module provides the brief, small flash/glow that confirms
 * the interception visually — deliberately NOT the full
 * `spawnExplosionParticles()` burst (bullets are only ~3 px radius).
 *
 * `resolveBulletVsBulletImpact` is the single shared entry point: it plays
 * the dedicated {@link playBulletDestructionSound} cue and spawns the flash.
 * Both `PlayScene` and `GymFormationScene` reach it through the shared
 * `CombatScene.onBulletVsBulletImpact` hook, so the feedback cannot diverge.
 *
 * @module vfx/bulletImpact
 */

import Phaser from 'phaser';

import { playBulletDestructionSound } from '../audio/effects';

/** Default flash radius (px) — small, sized for a ~3 px bullet. */
export const BULLET_IMPACT_RADIUS = 7;

/** Default flash lifetime (s) — brief so dense interceptions do not stack. */
export const BULLET_IMPACT_DURATION = 0.12;

/** Flash colour (warm white-yellow). */
export const BULLET_IMPACT_COLOR = 0xfff2a0;

/** Options for {@link spawnBulletImpact}. */
export interface BulletImpactOptions {
  /**
   * Optional registry the spawned flash is added to while alive (removed on
   * completion) — lets tests observe the VFX without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Flash radius (px). Defaults to {@link BULLET_IMPACT_RADIUS}. */
  radius?: number;
  /** Flash lifetime (s). Defaults to {@link BULLET_IMPACT_DURATION}. */
  duration?: number;
}

/**
 * Spawns a brief impact flash at (x, y) that fades and destroys itself.
 *
 * @returns The flash Graphics (destroyed when the tween completes).
 */
export function spawnBulletImpact(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: BulletImpactOptions = {},
): Phaser.GameObjects.Graphics {
  const radius = options.radius ?? BULLET_IMPACT_RADIUS;
  const duration = options.duration ?? BULLET_IMPACT_DURATION;
  const registry = options.registry;

  const flash = scene.add.graphics();
  flash.setPosition(x, y);
  flash.fillStyle(BULLET_IMPACT_COLOR, 0.9);
  flash.fillCircle(0, 0, radius);
  registry?.push(flash);

  scene.tweens.add({
    targets: flash,
    alpha: 0,
    scale: 1.6,
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

/**
 * Resolves a player-bullet vs enemy-bullet interception: plays the dedicated
 * bullet-destruction cue and spawns the small impact flash. Shared by both
 * combat scenes through the base-class hook.
 *
 * @returns The impact flash Graphics.
 */
export function resolveBulletVsBulletImpact(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: BulletImpactOptions = {},
): Phaser.GameObjects.Graphics {
  playBulletDestructionSound();
  return spawnBulletImpact(scene, x, y, options);
}

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
import type { ImpactFxShape } from '../utils/weapons';

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
  /** Flash colour (number). Defaults to {@link BULLET_IMPACT_COLOR}. */
  color?: number;
  /**
   * Flash shape (AH-0MWL88YYO0053DWH). Absent → `'circle'`, today's generic /
   * per-weapon flash. `'shard'` draws a bright radial shard burst (effective
   * matchup state) and `'spall'` a dull ring with armour chips (resisted), so
   * the state reads with colour removed.
   */
  shape?: ImpactFxShape;
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
  const color = options.color ?? BULLET_IMPACT_COLOR;
  const shape = options.shape ?? 'circle';

  const flash = scene.add.graphics();
  flash.setPosition(x, y);
  drawImpactShape(flash, shape, radius, color);
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
 * Draws one impact flash in the requested shape (AH-0MWL88YYO0053DWH).
 *
 * `'circle'` is the original single filled disc, unchanged for every existing
 * caller. `'shard'` adds a hot core plus a radial burst of triangular shards;
 * `'spall'` draws a dull hollow ring with a few armour chips. Shape carries
 * the matchup state for a colour-blind player, so it is never colour-only.
 */
function drawImpactShape(
  flash: Phaser.GameObjects.Graphics,
  shape: ImpactFxShape,
  radius: number,
  color: number,
): void {
  if (shape === 'shard') {
    flash.fillStyle(color, 0.9);
    flash.fillCircle(0, 0, radius * 0.45);
    // Six shards flung outward — a bright, sharp critical burst.
    const shards = 6;
    for (let i = 0; i < shards; i += 1) {
      const angle = (Math.PI * 2 * i) / shards;
      const inner = radius * 0.35;
      const tip = radius * (i % 2 === 0 ? 1.35 : 1.05);
      const spread = Math.PI / shards;
      flash.fillStyle(color, 0.85);
      flash.beginPath();
      flash.moveTo(Math.cos(angle) * tip, Math.sin(angle) * tip);
      flash.lineTo(
        Math.cos(angle - spread) * inner,
        Math.sin(angle - spread) * inner,
      );
      flash.lineTo(
        Math.cos(angle + spread) * inner,
        Math.sin(angle + spread) * inner,
      );
      flash.closePath();
      flash.fillPath();
    }
    return;
  }
  if (shape === 'spall') {
    // A dull hollow ring — no bright filled core, so it reads as a clang
    // rather than a hit — plus four small chips spalling off the rim.
    flash.lineStyle(Math.max(2, radius * 0.25), color, 0.8);
    flash.strokeCircle(0, 0, radius);
    flash.fillStyle(color, 0.7);
    for (let i = 0; i < 4; i += 1) {
      const angle = Math.PI / 4 + (Math.PI / 2) * i;
      const chipX = Math.cos(angle) * radius * 1.05;
      const chipY = Math.sin(angle) * radius * 1.05;
      flash.fillRect(chipX - 1, chipY - 1, 2.5, 2.5);
    }
    return;
  }
  // Default: today's single filled disc.
  flash.fillStyle(color, 0.9);
  flash.fillCircle(0, 0, radius);
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

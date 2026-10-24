/**
 * Thorn Field absorb burst (AH-0MVJ8YKR70096C6T).
 *
 * When an armed Thorn Field absorbs a ram, the enemy is destroyed but the
 * player takes no hit. Without feedback that exchange is invisible — the ram
 * looks like a normal collision. This module is the single shared "absorb"
 * seam: a lime spike-shatter burst plus a short, sharp cue at the collision
 * point, deliberately different from the warm player-hit destruction cue so
 * the player can tell "the field ate that" from "I got hit".
 *
 * Built on the shared Phaser Graphics + tween pattern (`spawnBulletImpact`),
 * and spawned from the shared ram branch in `CombatScene`, so the game and
 * every combat gym fire the identical burst (gym↔game parity,
 * AH-0MUGZDTFX004RBD1).
 *
 * The cue reuses the existing bullet-destruction tick rather than adding a
 * new baked ToneForge cue: it is already a short, bright shatter and it is
 * distinct from the player-hit cue (`playDestructionSound`), so the absorb
 * reads as its own event without shipping an unrendered audio asset.
 *
 * @module vfx/thornsAbsorb
 */

import Phaser from 'phaser';

import { playBulletDestructionSound } from '../audio/effects';
import { ICON_COLORS } from '../powerups/icons';

/** Burst colour — the Thorn Field's neon lime (shared with its drop icon). */
export const THORNS_ABSORB_COLOR = ICON_COLORS.thorns;

/** Burst depth — above the ship so the shatter reads over the collision. */
export const THORNS_ABSORB_DEPTH = 60;

/** Outer spike radius (px) of the shatter. */
export const THORNS_ABSORB_RADIUS = 26;

/** Spike count of the shatter — a ragged star, not a clean ring. */
export const THORNS_ABSORB_SPIKE_COUNT = 10;

/** Spike line width (px). */
export const THORNS_ABSORB_LINE_WIDTH = 2;

/** Peak stroke alpha of the shatter. */
export const THORNS_ABSORB_ALPHA = 0.95;

/** Burst lifetime (seconds) — brief so dense rams do not stack into a blur. */
export const THORNS_ABSORB_DURATION = 0.3;

/** Final scale the burst expands to while fading. */
export const THORNS_ABSORB_END_SCALE = 1.8;

/** Options for {@link spawnThornsAbsorbBurst}. */
export interface ThornsAbsorbOptions {
  /**
   * Optional registry the spawned burst is added to while alive (removed on
   * completion) — lets scenes track/tear down the effect and tests observe
   * it without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Burst radius override (px). Defaults to {@link THORNS_ABSORB_RADIUS}. */
  radius?: number;
  /** Burst lifetime override (seconds). Defaults to {@link THORNS_ABSORB_DURATION}. */
  duration?: number;
  /** Burst colour override (Phaser integer). Defaults to {@link THORNS_ABSORB_COLOR}. */
  color?: number;
}

/**
 * Spawns the lime spike-shatter burst at (x, y): a ragged star of outward
 * spikes that expands and fades, then destroys itself.
 *
 * @returns The burst Graphics (destroyed when the tween completes).
 */
export function spawnThornsAbsorbBurst(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: ThornsAbsorbOptions = {},
): Phaser.GameObjects.Graphics {
  const radius = options.radius ?? THORNS_ABSORB_RADIUS;
  const duration = options.duration ?? THORNS_ABSORB_DURATION;
  const registry = options.registry;
  const color = options.color ?? THORNS_ABSORB_COLOR;

  const burst = scene.add.graphics();
  burst.setPosition(x, y);
  burst.setDepth(THORNS_ABSORB_DEPTH);
  burst.lineStyle(THORNS_ABSORB_LINE_WIDTH, color, THORNS_ABSORB_ALPHA);
  for (let i = 0; i < THORNS_ABSORB_SPIKE_COUNT; i++) {
    // Alternate long/short spikes so the shatter reads as ragged lime shards.
    const angle = (i / THORNS_ABSORB_SPIKE_COUNT) * Math.PI * 2;
    const inner = radius * (i % 2 === 0 ? 0.15 : 0.3);
    const outer = radius * (i % 2 === 0 ? 1 : 0.72);
    burst.beginPath();
    burst.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    burst.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    burst.strokePath();
  }
  registry?.push(burst);

  scene.tweens.add({
    targets: burst,
    alpha: 0,
    scale: THORNS_ABSORB_END_SCALE,
    duration: duration * 1000,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(burst);
        if (index >= 0) registry.splice(index, 1);
      }
      burst.destroy();
    },
  });

  return burst;
}

/**
 * Resolves a Thorn Field absorb: plays the short shatter cue and spawns the
 * lime spike burst. Called from the shared ram branch whenever
 * `tryConsumeThornsRam()` returns true, so the game and every gym share one
 * implementation.
 *
 * @returns The burst Graphics.
 */
export function resolveThornsAbsorb(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: ThornsAbsorbOptions = {},
): Phaser.GameObjects.Graphics {
  playBulletDestructionSound();
  return spawnThornsAbsorbBurst(scene, x, y, options);
}

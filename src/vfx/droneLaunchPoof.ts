/**
 * Mystery UFO launch poof — the first lifecycle VFX moment of the saucer
 * (parent AH-0MVI4J8R4002WTT6, slice AH-0MVSAJZOI008TRBB).
 *
 * One short, code-drawn burst at the drone's spawn position: an expanding
 * neon ring ringed by a handful of jittered puffs. It is deliberately small
 * (the saucer is a scaled-down ship) and short-lived, so a launch reads as a
 * "pop" into the field rather than a second explosion.
 *
 * Conventions follow `explosionParticles.ts`: pure Phaser Graphics (no
 * external art), one Graphics per effect destroyed when its tween completes,
 * an optional caller-owned registry for shutdown teardown, injected rng for
 * deterministic geometry, and a record call into the shared
 * {@link recordDroneVfxSpawn} registry so the fixtures can count the moment.
 *
 * @module vfx/droneLaunchPoof
 */

import type Phaser from 'phaser';

import {
  DRONE_VFX_DATA_PROPERTY,
  recordDroneVfxSpawn,
} from './droneVfxCounts';

/** Render depth of the poof: above the saucer/minerals, below explosions. */
export const DRONE_LAUNCH_POOF_DEPTH = 4;

/** Poof lifespan (ms) — a quick launch pop, never a lingering cloud. */
export const DRONE_LAUNCH_POOF_DURATION_MS = 380;

/** Ring radius as a multiple of the drone's half-size. */
export const DRONE_LAUNCH_POOF_RADIUS_FACTOR = 3.5;

/** Smallest poof radius (px) so a tiny saucer still reads on launch. */
export const DRONE_LAUNCH_POOF_MIN_RADIUS = 6;

/** Starting scale of the poof (fraction of its final radius). */
export const DRONE_LAUNCH_POOF_START_SCALE = 0.3;

/** Number of puff dots flung around the expanding ring. */
export const DRONE_LAUNCH_POOF_PUFF_COUNT = 9;

/** Fallback poof colour (neon cyan) when the caller passes none. */
export const DRONE_LAUNCH_POOF_COLOR = 0x33ffee;

/** Optional overrides for {@link spawnDroneLaunchPoof}. */
export interface DroneLaunchPoofOptions {
  /** Effect colour (Phaser integer, default {@link DRONE_LAUNCH_POOF_COLOR}). */
  color?: number;
  /** Drone half-size in px — scales the ring/puffs (default 6). */
  size?: number;
  /** Lifespan override (ms, default {@link DRONE_LAUNCH_POOF_DURATION_MS}). */
  durationMs?: number;
  /** Injectable random source for puff jitter (default `Math.random`). */
  rng?: () => number;
  /**
   * Optional Graphics registry — the effect is pushed on spawn and spliced on
   * completion, so a scene SHUTDOWN handler can destroy leftovers and tests
   * can observe the effect without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
}

/** Handle returned by {@link spawnDroneLaunchPoof}. */
export interface DroneLaunchPoofHandle {
  /** The poof Graphics (destroyed when the effect completes). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** Final ring radius in px. */
  readonly radius: number;
  /** Whether the poof is still animating. */
  readonly alive: boolean;
  /** Destroys the poof immediately (teardown path). */
  destroy(): void;
}

/**
 * Spawns the one-per-launch poof at `(x, y)`.
 *
 * The effect is a single expanding, fading Graphics: a ring plus
 * {@link DRONE_LAUNCH_POOF_PUFF_COUNT} jittered puffs. A `null` scene is a
 * safe no-op (headless/teardown calls never throw), matching
 * `spawnExplosionParticles`' belt-and-braces guard.
 *
 * @param scene — the scene that owns the effect (and its tween).
 * @param x — spawn x (the poof's centre).
 * @param y — spawn y.
 * @param options — optional colour/size/duration/rng/registry overrides.
 * @returns the poof handle, or `null` when there is no scene.
 */
export function spawnDroneLaunchPoof(
  scene: Phaser.Scene | null | undefined,
  x: number,
  y: number,
  options: DroneLaunchPoofOptions = {},
): DroneLaunchPoofHandle | null {
  if (!scene) return null;

  const color = options.color ?? DRONE_LAUNCH_POOF_COLOR;
  const size = Math.max(1, options.size ?? 6);
  const duration = options.durationMs ?? DRONE_LAUNCH_POOF_DURATION_MS;
  const rng = options.rng ?? Math.random;
  const registry = options.registry;
  const radius = Math.max(DRONE_LAUNCH_POOF_MIN_RADIUS, size * DRONE_LAUNCH_POOF_RADIUS_FACTOR);

  const graphics = scene.add.graphics({ x, y });
  graphics.setDepth(DRONE_LAUNCH_POOF_DEPTH);
  graphics.setData(DRONE_VFX_DATA_PROPERTY, 'launchPoof');

  // The expanding ring — the poof's read at speed.
  graphics.lineStyle(2, color, 0.9);
  graphics.strokeCircle(0, 0, radius);
  // Puff dots around the ring, jittered so repeat launches differ.
  graphics.fillStyle(color, 0.55);
  for (let i = 0; i < DRONE_LAUNCH_POOF_PUFF_COUNT; i += 1) {
    const angle =
      (i / DRONE_LAUNCH_POOF_PUFF_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.4;
    const distance = radius * (0.4 + rng() * 0.45);
    const puffRadius = Math.max(0.8, size * (0.16 + rng() * 0.14));
    graphics.fillCircle(
      Math.cos(angle) * distance,
      Math.sin(angle) * distance,
      puffRadius,
    );
  }
  graphics.setScale(DRONE_LAUNCH_POOF_START_SCALE);

  registry?.push(graphics);

  let alive = true;
  const finish = (): void => {
    if (!alive) return;
    alive = false;
    if (registry) {
      const index = registry.indexOf(graphics);
      if (index >= 0) registry.splice(index, 1);
    }
    graphics.destroy();
  };

  scene.tweens.add({
    targets: graphics,
    scale: 1,
    alpha: 0,
    duration,
    ease: 'Cubic.easeOut',
    onComplete: finish,
  });

  // Count the moment as a *spawn* (the effect itself may already have faded
  // when a test asserts the launch), mirroring the shared VFX registry.
  recordDroneVfxSpawn('launchPoof');

  return {
    graphics,
    radius,
    get alive(): boolean {
      return alive;
    },
    destroy: finish,
  };
}

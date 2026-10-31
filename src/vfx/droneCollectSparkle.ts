/**
 * Mystery UFO collect sparkle — the per-mineral vacuum VFX of the saucer
 * (parent AH-0MVI4J8R4002WTT6, slice AH-0MVSAJZOI008TRBB).
 *
 * Each mineral a drone vacuums pops a small sparkle ring at the mineral's
 * last position: a short ring plus a few radiating sparks, gone in a quarter
 * of a second. It is deliberately tiny — a busy field at the maximum 40 px
 * collector radius can feed several minerals in one tick, so the shared pass
 * caps the per-tick spawns at {@link DRONE_COLLECT_SPARKLE_MAX_PER_TICK};
 * combined with the short lifespan that makes the emitter bounded (never an
 * unbounded particle source).
 *
 * Conventions follow `explosionParticles.ts`: pure Phaser Graphics (no
 * external art), one Graphics per sparkle destroyed when its tween completes,
 * an optional caller-owned registry for teardown, injected rng for
 * deterministic geometry, and a record call into the shared
 * {@link recordDroneVfxSpawn} registry.
 *
 * @module vfx/droneCollectSparkle
 */

import type Phaser from 'phaser';

import {
  DRONE_VFX_DATA_PROPERTY,
  recordDroneVfxSpawn,
} from './droneVfxCounts';

/** Render depth of a sparkle: above the saucer/minerals, below explosions. */
export const DRONE_COLLECT_SPARKLE_DEPTH = 4;

/** Sparkle lifespan (ms) — small and short-lived, never a lingering cloud. */
export const DRONE_COLLECT_SPARKLE_DURATION_MS = 260;

/**
 * Maximum sparkles a single drone may spawn in one tick. The vacuum can take
 * several minerals in one frame at the maximum 40 px collector radius; this
 * cap keeps that burst bounded regardless of how dense the field is.
 */
export const DRONE_COLLECT_SPARKLE_MAX_PER_TICK = 4;

/** Ring radius as a multiple of the drone's half-size. */
export const DRONE_COLLECT_SPARKLE_RADIUS_FACTOR = 1.6;

/** Smallest sparkle radius (px) so the effect is still visible. */
export const DRONE_COLLECT_SPARKLE_MIN_RADIUS = 3;

/** Starting scale of the sparkle (fraction of its final radius). */
export const DRONE_COLLECT_SPARKLE_START_SCALE = 0.4;

/** Number of radiating spark dots per collect. */
export const DRONE_COLLECT_SPARKLE_SPARK_COUNT = 5;

/** Fallback sparkle colour (warm gold) when the caller passes none. */
export const DRONE_COLLECT_SPARKLE_COLOR = 0xffdd66;

/** Optional overrides for {@link spawnDroneCollectSparkle}. */
export interface DroneCollectSparkleOptions {
  /** Effect colour (Phaser integer, default {@link DRONE_COLLECT_SPARKLE_COLOR}). */
  color?: number;
  /** Drone half-size in px — scales the ring/sparks (default 6). */
  size?: number;
  /** Lifespan override (ms, default {@link DRONE_COLLECT_SPARKLE_DURATION_MS}). */
  durationMs?: number;
  /** Injectable random source for spark jitter (default `Math.random`). */
  rng?: () => number;
  /** Optional Graphics registry (pushed on spawn, spliced on completion). */
  registry?: Phaser.GameObjects.Graphics[];
}

/** Handle returned by {@link spawnDroneCollectSparkle}. */
export interface DroneCollectSparkleHandle {
  /** The sparkle Graphics (destroyed when the effect completes). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** Final ring radius in px. */
  readonly radius: number;
  /** Whether the sparkle is still animating. */
  readonly alive: boolean;
  /** Destroys the sparkle immediately (teardown path). */
  destroy(): void;
}

/**
 * Clamps one tick's vacuumed minerals to the per-tick sparkle budget
 * ({@link DRONE_COLLECT_SPARKLE_MAX_PER_TICK} by default).
 *
 * The budget is coerced to a non-negative integer, so a caller can pass a
 * configured cap directly; `0` (or any non-finite value) spawns nothing. It
 * returns the first `limit` entries of the tick's collection list — the order
 * the vacuum took them, which is the order they should sparkle.
 *
 * @param collected — the tick's vacuumed mineral positions.
 * @param limit — sparkle budget for the tick (default the module cap).
 * @returns at most `limit` entries (the input array itself when it fits).
 */
export function capDroneCollectSparkles<T>(
  collected: readonly T[],
  limit: number = DRONE_COLLECT_SPARKLE_MAX_PER_TICK,
): readonly T[] {
  const budget = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return collected.length <= budget ? collected : collected.slice(0, budget);
}

/**
 * Spawns one collect sparkle at `(x, y)` — called once per mineral the vacuum
 * takes, from the shared collector-drone pass (so the game and every gym
 * sparkle identically). A `null` scene is a safe no-op.
 *
 * @param scene — the scene that owns the effect (and its tween).
 * @param x — sparkle x (the vacuumed mineral's position).
 * @param y — sparkle y.
 * @param options — optional colour/size/duration/rng/registry overrides.
 * @returns the sparkle handle, or `null` when there is no scene.
 */
export function spawnDroneCollectSparkle(
  scene: Phaser.Scene | null | undefined,
  x: number,
  y: number,
  options: DroneCollectSparkleOptions = {},
): DroneCollectSparkleHandle | null {
  if (!scene) return null;

  const color = options.color ?? DRONE_COLLECT_SPARKLE_COLOR;
  const size = Math.max(1, options.size ?? 6);
  const duration = options.durationMs ?? DRONE_COLLECT_SPARKLE_DURATION_MS;
  const rng = options.rng ?? Math.random;
  const registry = options.registry;
  const radius = Math.max(
    DRONE_COLLECT_SPARKLE_MIN_RADIUS,
    size * DRONE_COLLECT_SPARKLE_RADIUS_FACTOR,
  );

  const graphics = scene.add.graphics({ x, y });
  graphics.setDepth(DRONE_COLLECT_SPARKLE_DEPTH);
  graphics.setData(DRONE_VFX_DATA_PROPERTY, 'collectSparkle');

  // A small bright ring with radiating sparks — a mineral "ping".
  graphics.lineStyle(1, color, 0.95);
  graphics.strokeCircle(0, 0, radius);
  graphics.fillStyle(color, 0.85);
  graphics.fillCircle(0, 0, Math.max(0.6, radius * 0.28));
  for (let i = 0; i < DRONE_COLLECT_SPARKLE_SPARK_COUNT; i += 1) {
    const angle =
      (i / DRONE_COLLECT_SPARKLE_SPARK_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const distance = radius * (0.75 + rng() * 0.55);
    graphics.fillCircle(
      Math.cos(angle) * distance,
      Math.sin(angle) * distance,
      Math.max(0.5, size * 0.09),
    );
  }
  graphics.setScale(DRONE_COLLECT_SPARKLE_START_SCALE);

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

  // Cumulative spawn counter (one per mineral sparkled).
  recordDroneVfxSpawn('collectSparkle');

  return {
    graphics,
    radius,
    get alive(): boolean {
      return alive;
    },
    destroy: finish,
  };
}

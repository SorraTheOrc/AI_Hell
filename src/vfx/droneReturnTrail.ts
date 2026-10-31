/**
 * Mystery UFO return-leg trail/glow (parent AH-0MVI4J8R4002WTT6, slice
 * AH-0MVSAJZOI008TRBB).
 *
 * While the saucer flies home it drags a short glowing trail: a warm head
 * glow plus a fading streak of the positions it has just flown through. The
 * trail is deliberately **one** Graphics per return leg (not one particle per
 * frame): the pass pushes the drone's position into a bounded history ring
 * and the streak is redrawn from it, so the trail is capped by
 * {@link DRONE_RETURN_TRAIL_MAX_POINTS} however long the return leg is.
 *
 * Lifecycle is caller-owned and explicit ({@link DroneReturnTrailHandle.stop})
 * rather than tween-driven, so the shared pass can guarantee the trail
 * *disappears at payout* (the drone leaving RETURN tears the Graphics down on
 * the same tick) as well as on destruction and scene teardown.
 *
 * Conventions follow `explosionParticles.ts`: pure Phaser Graphics (no
 * external art), an optional caller-owned registry for teardown, and a record
 * call into the shared {@link recordDroneVfxSpawn} registry per return leg.
 *
 * @module vfx/droneReturnTrail
 */

import type Phaser from 'phaser';

import {
  DRONE_VFX_DATA_PROPERTY,
  recordDroneVfxSpawn,
} from './droneVfxCounts';

/** Render depth of the trail: above minerals, below the saucer and bursts. */
export const DRONE_RETURN_TRAIL_DEPTH = 3;

/** Maximum recorded trail points — the streak length cap (no unbounded trail). */
export const DRONE_RETURN_TRAIL_MAX_POINTS = 14;

/** Minimum distance (px) the saucer must travel before another point is kept. */
export const DRONE_RETURN_TRAIL_POINT_SPACING = 3;

/** Head glow radius as a multiple of the drone's half-size. */
export const DRONE_RETURN_TRAIL_HEAD_RADIUS_FACTOR = 1.7;

/** Tail dot radius as a multiple of the drone's half-size (newest dot). */
export const DRONE_RETURN_TRAIL_DOT_RADIUS_FACTOR = 0.5;

/** Head glow alpha — soft, so the saucer still reads on top of it. */
export const DRONE_RETURN_TRAIL_HEAD_ALPHA = 0.32;

/** Alpha of the newest tail dot (older dots fade towards zero). */
export const DRONE_RETURN_TRAIL_TAIL_ALPHA = 0.5;

/** Fallback trail colour (neon cyan) when the caller passes none. */
export const DRONE_RETURN_TRAIL_COLOR = 0x33ffee;

/** Optional overrides for {@link createDroneReturnTrail}. */
export interface DroneReturnTrailOptions {
  /** Effect colour (Phaser integer, default {@link DRONE_RETURN_TRAIL_COLOR}). */
  color?: number;
  /** Drone half-size in px — scales the glow and dots (default 6). */
  size?: number;
  /** History cap override (default {@link DRONE_RETURN_TRAIL_MAX_POINTS}). */
  maxPoints?: number;
  /**
   * Optional Graphics registry — the trail Graphics is pushed on creation and
   * spliced on {@link DroneReturnTrailHandle.stop}, so a scene SHUTDOWN
   * handler can destroy leftovers.
   */
  registry?: Phaser.GameObjects.Graphics[];
}

/** Handle returned by {@link createDroneReturnTrail}. */
export interface DroneReturnTrailHandle {
  /** The trail Graphics (destroyed by {@link stop}). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** Whether the trail is still live (not stopped). */
  readonly alive: boolean;
  /** Number of recorded streak points (bounded by the history cap). */
  readonly pointCount: number;
  /** Advances the trail head to the saucer's current position. */
  update(x: number, y: number): void;
  /** Tears the trail down immediately (payout / destruction / teardown). */
  stop(): void;
}

/** One recorded position in the streak history. */
interface TrailPoint {
  x: number;
  y: number;
}

/**
 * Creates the return-leg trail at the saucer's current position.
 *
 * The returned handle draws nothing until {@link DroneReturnTrailHandle.update}
 * is called, which the shared pass does every tick of the RETURN phase — and
 * {@link DroneReturnTrailHandle.stop} is called the moment the drone leaves
 * RETURN (payout, destruction or scene teardown), so the trail can never
 * outlive the return leg.
 *
 * A `null` scene is a safe no-op (returns `null`).
 *
 * @param scene — the scene that owns the trail Graphics.
 * @param x — saucer x at the start of the return leg.
 * @param y — saucer y.
 * @param options — optional colour/size/history-cap/registry overrides.
 * @returns the trail handle, or `null` when there is no scene.
 */
export function createDroneReturnTrail(
  scene: Phaser.Scene | null | undefined,
  x: number,
  y: number,
  options: DroneReturnTrailOptions = {},
): DroneReturnTrailHandle | null {
  if (!scene) return null;

  const color = options.color ?? DRONE_RETURN_TRAIL_COLOR;
  const size = Math.max(1, options.size ?? 6);
  const maxPoints = Math.max(
    2,
    Math.floor(options.maxPoints ?? DRONE_RETURN_TRAIL_MAX_POINTS),
  );
  const registry = options.registry;

  const headRadius = Math.max(1.5, size * DRONE_RETURN_TRAIL_HEAD_RADIUS_FACTOR);
  const dotRadius = Math.max(0.6, size * DRONE_RETURN_TRAIL_DOT_RADIUS_FACTOR);

  const graphics = scene.add.graphics();
  graphics.setDepth(DRONE_RETURN_TRAIL_DEPTH);
  graphics.setData(DRONE_VFX_DATA_PROPERTY, 'returnTrail');

  // Streak history, oldest first; the head is tracked separately so the glow
  // hugs the saucer even on frames too short to record a new dot.
  const points: TrailPoint[] = [{ x, y }];
  let headX = x;
  let headY = y;
  let alive = true;

  const draw = (): void => {
    graphics.clear();
    // Head glow — the saucer's wake, drawn behind the drone (depth 3 vs 2
    // is a deliberate above-mineral/behind-burst choice, not the saucer).
    graphics.fillStyle(color, DRONE_RETURN_TRAIL_HEAD_ALPHA);
    graphics.fillCircle(headX, headY, headRadius);
    // Fading streak: the newest dot is brightest and largest, the oldest
    // almost invisible, which reads as a tail trailing off behind the ship.
    for (let i = 0; i < points.length; i += 1) {
      const ageFactor = (i + 1) / points.length;
      const point = points[i];
      graphics.fillStyle(color, DRONE_RETURN_TRAIL_TAIL_ALPHA * ageFactor);
      graphics.fillCircle(
        point.x,
        point.y,
        Math.max(0.4, dotRadius * ageFactor),
      );
    }
  };

  draw();
  registry?.push(graphics);

  const stop = (): void => {
    if (!alive) return;
    alive = false;
    if (registry) {
      const index = registry.indexOf(graphics);
      if (index >= 0) registry.splice(index, 1);
    }
    graphics.destroy();
  };

  const update = (nextX: number, nextY: number): void => {
    if (!alive) return;
    headX = nextX;
    headY = nextY;
    const last = points[points.length - 1];
    if (
      Math.hypot(nextX - last.x, nextY - last.y) >=
      DRONE_RETURN_TRAIL_POINT_SPACING
    ) {
      points.push({ x: nextX, y: nextY });
      if (points.length > maxPoints) points.shift();
    }
    draw();
  };

  // One counter per return leg (not per drawn dot) — the "return trail"
  // moment fires when the trail begins, exactly like the launch poof.
  recordDroneVfxSpawn('returnTrail');

  return {
    graphics,
    get alive(): boolean {
      return alive;
    },
    get pointCount(): number {
      return points.length;
    },
    update,
    stop,
  };
}

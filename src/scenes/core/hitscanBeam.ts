/**
 * Shared hitscan-beam geometry (AH-0MVREBUJ5004HDRQ, AC11).
 *
 * The Wave Laser is an **instant hitscan ray**, not a travelling projectile:
 * it resolves at launch, deals exactly 1 damage to the first entity it
 * intercepts and stops there; with nothing in its path it runs for its whole
 * length budget (240 px at level 0 — a quarter of the arena width —
 * AH-0MW10J31B0053E56), **wrapping** at the arena edges so a ray fired near
 * the right edge re-emerges from the left and keeps extending.
 *
 * Everything about that ray that affects gameplay is defined **once here**,
 * pure and side-effect free (no Phaser, no globals):
 *
 * - {@link traceWrappedRay} — the wrapped polyline a ray covers (one segment
 *   per arena crossing);
 * - {@link resolveHitscanRay} — the same polyline truncated at the **first**
 *   intercept, plus the intercepted target and the intercept point.
 *
 * The shared combat core (`CombatCoreScene.fireHitscanBeam`) consumes these
 * helpers and resolves the hit through the shared damage seam, so the game and
 * every gym run the *same* beam (gym↔game parity). No other weapon's
 * travelling-bullet flight or collision path is touched — the ray is a
 * dedicated seam.
 *
 * @module scenes/core/hitscanBeam
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';

/** A point on the wrapped ray (arena coordinates in px). */
export interface HitscanPoint {
  x: number;
  y: number;
}

/** One straight segment of the wrapped ray (arena coordinates in px). */
export interface HitscanSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Structural contract a beam-interceptable entity must satisfy. The shared
 * enemy list satisfies it directly; `PlayScene` adds its boss-style entities.
 */
export interface HitscanTarget {
  x: number;
  y: number;
  readonly alive: boolean;
  getHitRadius(): number;
}

/** One ray trace request. */
export interface HitscanRayInput {
  /** Ray origin x (px) — the ship's muzzle. */
  originX: number;
  /** Ray origin y (px) — the ship's muzzle. */
  originY: number;
  /** Firing heading in radians (Phaser convention, 0 = +x). */
  angleRad: number;
  /** Total ray length (px) the beam travels before it stops. */
  length: number;
  /** Arena width (px). Defaults to {@link GAME_WIDTH}. */
  width?: number;
  /** Arena height (px). Defaults to {@link GAME_HEIGHT}. */
  height?: number;
}

/** The first entity a ray intercepts, with where and how far along it met. */
export interface HitscanHit<T extends HitscanTarget> {
  /** The intercepted entity (the nearest one along the ray). */
  target: T;
  /** Intercept x (px). */
  x: number;
  /** Intercept y (px). */
  y: number;
  /** Distance along the wrapped ray from the origin (px). */
  distance: number;
}

/** The resolved ray: the visible polyline plus what (if anything) it hit. */
export interface HitscanResolution<T extends HitscanTarget> {
  /** The visible polyline, already truncated at the first intercept. */
  segments: HitscanSegment[];
  /** The visible ray's end point (the intercept point, or the full extent). */
  end: HitscanPoint;
  /** The first intercepted entity, or `null` when the ray met nothing. */
  hit: HitscanHit<T> | null;
  /** The requested ray length (px) — the weapon's length budget (240 px at level 0). */
  length: number;
}

/** Length of one segment (px). */
function segmentLength(segment: HitscanSegment): number {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

/** Wraps one axis coordinate into `[0, span)`. */
function wrapCoord(value: number, span: number): number {
  if (!(span > 0)) return value;
  const wrapped = value % span;
  return wrapped < 0 ? wrapped + span : wrapped;
}

/**
 * The distance (px) from `(x, y)` to the arena edge it leaves first along the
 * unit direction `(dx, dy)`, or `Infinity` when it never leaves (a zero
 * direction on both axes). The boundary is treated as the half-open range
 * `[0, width)` / `[0, height)` so a ray continuing past an edge always makes
 * positive progress.
 */
function distanceToEdge(
  x: number,
  y: number,
  dx: number,
  dy: number,
  width: number,
  height: number,
): number {
  let distance = Infinity;
  if (dx > 0) distance = Math.min(distance, (width - x) / dx);
  else if (dx < 0) distance = Math.min(distance, x / -dx);
  if (dy > 0) distance = Math.min(distance, (height - y) / dy);
  else if (dy < 0) distance = Math.min(distance, y / -dy);
  return distance;
}

/**
 * Traces a ray of `length` px from `(originX, originY)` along `angleRad`,
 * **wrapping at the arena edges**: every time the ray leaves the arena it
 * re-enters from the opposite edge and keeps extending for the remainder of
 * its length budget. The result is the polyline the beam is drawn along — one
 * segment per straight run between edge crossings.
 *
 * The origin is wrapped into the arena first, an exact-edge start continues
 * from the opposite edge (so the trace always makes progress), and a
 * zero-length ray yields a single degenerate segment at the origin.
 */
export function traceWrappedRay(input: HitscanRayInput): HitscanSegment[] {
  const width = input.width ?? GAME_WIDTH;
  const height = input.height ?? GAME_HEIGHT;
  const length = Math.max(0, input.length);
  const dx = Math.cos(input.angleRad);
  const dy = Math.sin(input.angleRad);
  let x = wrapCoord(input.originX, width);
  let y = wrapCoord(input.originY, height);

  const segments: HitscanSegment[] = [];
  let remaining = length;

  // A long beam wraps at most a handful of times at shipped lengths; the
  // guard keeps a degenerate direction (or a zero-size arena) from looping.
  for (let guard = 0; guard < 64; guard += 1) {
    if (!(remaining > 1e-9)) break;
    // An exact-edge start with an outward direction continues from the far
    // edge instead of consuming a zero-length step.
    if (dx < 0 && x <= 0) x = width;
    else if (dx > 0 && x >= width) x = 0;
    if (dy < 0 && y <= 0) y = height;
    else if (dy > 0 && y >= height) y = 0;

    const toEdge = distanceToEdge(x, y, dx, dy, width, height);
    const step = Math.min(remaining, toEdge);
    if (!Number.isFinite(step) || step <= 0) {
      // No further progress is possible (zero direction): stop with whatever
      // has been traced so far.
      if (segments.length === 0) {
        segments.push({ x1: x, y1: y, x2: x, y2: y });
      }
      break;
    }

    const nx = x + dx * step;
    const ny = y + dy * step;
    segments.push({ x1: x, y1: y, x2: nx, y2: ny });
    remaining -= step;

    if (step < toEdge) break; // The budget ran out inside the arena.
    // Crossed an edge: re-enter from the opposite side and keep going.
    x = nx <= 0 ? nx + width : nx >= width ? nx - width : nx;
    y = ny <= 0 ? ny + height : ny >= height ? ny - height : ny;
  }

  if (segments.length === 0) {
    segments.push({ x1: x, y1: y, x2: x, y2: y });
  }
  return segments;
}

/**
 * The distance along `segment` at which it first enters the circle
 * `(cx, cy, radius)`, or `null` when it misses. A segment that starts inside
 * the circle reports `0` (the muzzle is already touching the target).
 */
export function segmentCircleEntry(
  segment: HitscanSegment,
  cx: number,
  cy: number,
  radius: number,
): number | null {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const fx = segment.x1 - cx;
  const fy = segment.y1 - cy;
  const r = Math.max(0, radius);

  if (lengthSquared === 0) {
    return fx * fx + fy * fy <= r * r ? 0 : null;
  }

  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const discriminant = b * b - 4 * lengthSquared * c;
  if (discriminant < 0) return null;

  const root = Math.sqrt(discriminant);
  const entry = (-b - root) / (2 * lengthSquared);
  const exit = (-b + root) / (2 * lengthSquared);
  if (entry >= 0 && entry <= 1) return entry * Math.sqrt(lengthSquared);
  // The segment starts inside the circle (entry < 0 < exit).
  if (exit >= 0 && exit <= 1) return 0;
  return null;
}

/**
 * Truncates a wrapped polyline at `distance` px from its start, returning the
 * visible portion (the last segment is cut at the intercept point).
 */
export function truncateRay(
  segments: readonly HitscanSegment[],
  distance: number,
): HitscanSegment[] {
  const limit = Math.max(0, distance);
  const visible: HitscanSegment[] = [];
  let remaining = limit;
  for (const segment of segments) {
    const length = segmentLength(segment);
    if (length === 0) continue;
    if (remaining >= length) {
      visible.push({ ...segment });
      remaining -= length;
      continue;
    }
    const t = remaining / length;
    visible.push({
      x1: segment.x1,
      y1: segment.y1,
      x2: segment.x1 + (segment.x2 - segment.x1) * t,
      y2: segment.y1 + (segment.y2 - segment.y1) * t,
    });
    remaining = 0;
    break;
  }
  if (visible.length === 0) {
    const first = segments[0];
    const x = first ? first.x1 : 0;
    const y = first ? first.y1 : 0;
    visible.push({ x1: x, y1: y, x2: x, y2: y });
  }
  return visible;
}

/** The end point of a polyline (its last segment's far end). */
export function rayEnd(segments: readonly HitscanSegment[]): HitscanPoint {
  const last = segments[segments.length - 1];
  return last ? { x: last.x2, y: last.y2 } : { x: 0, y: 0 };
}

/**
 * Resolves a wrapped hitscan ray against `targets`: traces the full ray,
 * finds the **nearest** interception along it (never passing through a
 * target), and returns the polyline truncated at that intercept together with
 * the intercepted entity and point.
 *
 * Exactly one target is ever returned — the first one the ray meets — so a
 * beam stops at the first intercept and never damages the entities behind it
 * (AC2). With no interception the full-length ray is returned unmodified
 * (AC3).
 */
export function resolveHitscanRay<T extends HitscanTarget>(
  input: HitscanRayInput & { targets: readonly T[] },
): HitscanResolution<T> {
  const segments = traceWrappedRay(input);
  let best: { hit: HitscanHit<T> } | null = null;
  let travelled = 0;

  for (const segment of segments) {
    for (const target of input.targets) {
      if (!target.alive) continue;
      const entry = segmentCircleEntry(
        segment,
        target.x,
        target.y,
        target.getHitRadius(),
      );
      if (entry === null) continue;
      const distance = travelled + entry;
      if (best === null || distance < best.hit.distance) {
        const length = segmentLength(segment);
        const t = length > 0 ? entry / length : 0;
        best = {
          hit: {
            target,
            x: segment.x1 + (segment.x2 - segment.x1) * t,
            y: segment.y1 + (segment.y2 - segment.y1) * t,
            distance,
          },
        };
      }
    }
    travelled += segmentLength(segment);
  }

  const hit = best ? best.hit : null;
  const visible = hit ? truncateRay(segments, hit.distance) : segments;
  return {
    segments: visible,
    end: hit ? { x: hit.x, y: hit.y } : rayEnd(visible),
    hit,
    length: Math.max(0, input.length),
  };
}

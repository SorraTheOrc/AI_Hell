/**
 * Wave-laser hitscan beam visual (AH-0MVREBUJ5004HDRQ, AC1/AC4; source
 * anchoring AH-0MWJ8JUEF006XBLB).
 *
 * The beam is a **single red laser column** and it is **anchored to the ship**:
 * its source end re-anchors every frame to the ship's current position while
 * its far end stays frozen at the point the ray resolved at launch (the
 * first-intercept point, or the full-extent endpoint). Because the geometry
 * comes from `scenes/core/hitscanBeam` and the per-frame re-draw comes from the
 * shared `vfx/anchoredBeam` seam, the beam the player sees is exactly the ray
 * that resolved its damage — the game and every gym draw the same shape from
 * the same shared seam, and a flying ship never leaves its beam behind.
 *
 * The effect is deliberately cheap and self-cleaning: a code-drawn Graphics
 * with a short fade, appended to an optional caller-owned registry (removed on
 * completion) so scenes can clean up on shutdown and tests can observe the
 * beam without pixel assertions — the same pattern as `vfx/muzzleFlash`.
 *
 * @module vfx/hitscanBeam
 */

import type Phaser from 'phaser';

import {
  rayEnd,
  type HitscanSegment,
} from '../scenes/core/hitscanBeam';
import {
  spawnAnchoredBeam,
  type BeamPoint,
  type BeamSource,
} from './anchoredBeam';

/** Seconds the beam stays visible after launch (AC4). */
export const HITSCAN_BEAM_DURATION = 0.3;

/** Default beam colour — pure red, the wave laser's identity (AC1, A5). */
export const HITSCAN_BEAM_COLOR = 0xff0000;

/** Default hot core colour (the white-hot centre of the beam). */
export const HITSCAN_BEAM_CORE_COLOR = 0xffffff;

/** Default beam half-thickness (px) at the outer edge of the column. */
export const HITSCAN_BEAM_WIDTH = 6;

/** Options for {@link spawnHitscanBeam}. */
export interface HitscanBeamOptions {
  /**
   * Optional registry the beam is added to while alive (removed on
   * completion) — lets scenes clean up and tests observe the VFX.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Beam colour (Phaser integer). Defaults to {@link HITSCAN_BEAM_COLOR}. */
  color?: number;
  /** Hot-core colour. Defaults to {@link HITSCAN_BEAM_CORE_COLOR}. */
  coreColor?: number;
  /** Outer beam width (px). Defaults to {@link HITSCAN_BEAM_WIDTH}. */
  width?: number;
  /** Visible duration (s). Defaults to {@link HITSCAN_BEAM_DURATION}. */
  duration?: number;
  /**
   * Live source anchor — the ship's current position, read each frame so the
   * beam stays attached as the ship flies (AC1). Defaults to the resolved
   * ray's origin, which reproduces the old static beam for callers that only
   * want the drawn geometry.
   */
  source?: BeamSource;
  /**
   * Frozen far end. Defaults to the resolved ray's end point (the intercept
   * point, or the full-extent endpoint) — the value the shared fire path
   * passes explicitly (AC2).
   */
  destination?: BeamPoint;
  /**
   * Fallback source used until a live `source` provider yields its first
   * point — the launch muzzle. Defaults to the ray's origin.
   */
  origin?: BeamPoint;
}

/**
 * Spawns the rendered beam along `segments`: a red column with a white-hot
 * core along the same polyline, anchored to `options.source` (the ship) at one
 * end and to the frozen `options.destination` (the resolved end point) at the
 * other, faded out over `duration` and destroyed when the fade completes.
 *
 * The far end never moves for the beam's whole visible life, and nothing is
 * re-resolved: this is a rendering seam only, so no damage is re-applied and
 * no hit is recomputed (AC2).
 *
 * @returns The beam Graphics (destroyed when the fade completes).
 */
export function spawnHitscanBeam(
  scene: Phaser.Scene,
  segments: readonly HitscanSegment[],
  options: HitscanBeamOptions = {},
): Phaser.GameObjects.Graphics {
  const first = segments[0];
  const rayOrigin: BeamPoint = first
    ? { x: first.x1, y: first.y1 }
    : { x: 0, y: 0 };
  const origin = options.origin ?? rayOrigin;

  return spawnAnchoredBeam(scene, {
    source: options.source ?? origin,
    // The launch muzzle keeps the beam drawn from where it resolved until a
    // provider supplies the ship's first live position.
    origin,
    destination: options.destination ?? rayEnd(segments),
    color: options.color ?? HITSCAN_BEAM_COLOR,
    coreColor: options.coreColor ?? HITSCAN_BEAM_CORE_COLOR,
    width: options.width ?? HITSCAN_BEAM_WIDTH,
    coreWidthRatio: 0.35,
    duration: options.duration ?? HITSCAN_BEAM_DURATION,
    // The shipped fade was a Quad.easeIn to zero; keep that curve.
    fade: (progress: number) => 1 - progress * progress,
    registry: options.registry,
  });
}

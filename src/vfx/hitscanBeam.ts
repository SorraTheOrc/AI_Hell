/**
 * Wave-laser hitscan beam visual (AH-0MVREBUJ5004HDRQ, AC1/AC4).
 *
 * The beam is a **single red laser column** drawn along the polyline the
 * shared ray resolver produced (one segment per arena wrap) and held on screen
 * for {@link HITSCAN_BEAM_DURATION} seconds before it is removed. Because the
 * geometry comes from `scenes/core/hitscanBeam`, the beam the player sees is
 * exactly the ray that resolved its damage — the game and every gym draw the
 * same shape from the same shared seam.
 *
 * The effect is deliberately cheap and self-cleaning: a code-drawn Graphics
 * with a short fade, appended to an optional caller-owned registry (removed on
 * completion) so scenes can clean up on shutdown and tests can observe the
 * beam without pixel assertions — the same pattern as `vfx/muzzleFlash`.
 *
 * @module vfx/hitscanBeam
 */

import type Phaser from 'phaser';

import type { HitscanSegment } from '../scenes/core/hitscanBeam';

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
}

/**
 * Spawns the rendered beam along `segments`: a red column with a white-hot
 * core along the same polyline, faded out over `duration` and destroyed when
 * the fade completes.
 *
 * @returns The beam Graphics (destroyed when the fade completes).
 */
export function spawnHitscanBeam(
  scene: Phaser.Scene,
  segments: readonly HitscanSegment[],
  options: HitscanBeamOptions = {},
): Phaser.GameObjects.Graphics {
  const color = options.color ?? HITSCAN_BEAM_COLOR;
  const coreColor = options.coreColor ?? HITSCAN_BEAM_CORE_COLOR;
  const width = options.width ?? HITSCAN_BEAM_WIDTH;
  const duration = options.duration ?? HITSCAN_BEAM_DURATION;
  const registry = options.registry;

  const beam = scene.add.graphics();
  // Outer red column, then the hot white core down the middle of the same
  // polyline, so the beam reads as one bright laser rather than a thin line.
  beam.lineStyle(width, color, 1);
  for (const segment of segments) {
    beam.beginPath();
    beam.moveTo(segment.x1, segment.y1);
    beam.lineTo(segment.x2, segment.y2);
    beam.strokePath();
  }
  beam.lineStyle(Math.max(1, width * 0.35), coreColor, 0.95);
  for (const segment of segments) {
    beam.beginPath();
    beam.moveTo(segment.x1, segment.y1);
    beam.lineTo(segment.x2, segment.y2);
    beam.strokePath();
  }
  registry?.push(beam);

  scene.tweens.add({
    targets: beam,
    alpha: 0,
    duration: duration * 1000,
    ease: 'Quad.easeIn',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(beam);
        if (index >= 0) registry.splice(index, 1);
      }
      beam.destroy();
    },
  });

  return beam;
}

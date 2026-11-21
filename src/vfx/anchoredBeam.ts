/**
 * Anchored beam VFX seam (AH-0MWJ8JUEF006XBLB).
 *
 * ## Why this exists
 *
 * The Wave Laser (`vfx/hitscanBeam`) and the Mining Laser
 * (`vfx/miningLaserBeam`) both render a **frozen** polyline drawn once at fire
 * time. The ship keeps flying while the beam is on screen, so the beam's source
 * end visibly detaches from the ship (up to ~50 px over the Wave Laser's 0.3 s
 * life at max speed). This module is the single shared fix: an
 * **anchored beam** takes a **source provider** (a point, or a function
 * returning the ship's current position) plus a **fixed destination**, and
 * **re-draws the wrapped shortest path every frame** from the current source to
 * that frozen far end.
 *
 * ## What must not change
 *
 * - **The destination is frozen at spawn.** It is snapshotted here, so a caller
 *   that passes a live object (an asteroid that drifts) cannot make the beam's
 *   far end follow it (AC2/AC6). Nothing is ever re-resolved or re-damaging:
 *   this module only draws; aim, cadence and damage stay with the shared fire
 *   path that already resolved them at launch.
 * - **The wrapped path is the shortest one.** {@link wrappedBeamSegments}
 *   traces the through-the-seam route (one segment per arena-edge crossing),
 *   the same geometry the Mining Laser already used, so a beam never spans the
 *   whole screen when its end is a few pixels past a seam (AC3).
 *
 * ## Cheap by construction, and safe when the ship vanishes
 *
 * One code-drawn Graphics per shot, cleared and re-stroked in place each frame
 * (no object per frame, no tween accumulation), aged on the scene's `update`
 * **delta** so its life is wall-clock seconds, and torn down idempotently on
 * expiry *and* on scene `shutdown`. The source provider is allowed to return
 * `null` (the ship was destroyed mid-beam): the beam then keeps drawing from
 * the last position it resolved rather than throwing or collapsing to the
 * origin (R3), falling back to the caller's `origin` if it has never resolved
 * one.
 *
 * The game and every gym consume this seam through the two weapon VFX modules,
 * so they cannot fork the anchoring behaviour (gym↔game parity).
 *
 * @module vfx/anchoredBeam
 */

import type Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  traceWrappedRay,
  type HitscanSegment,
} from '../scenes/core/hitscanBeam';
import { wrappedAxisDelta } from '../utils/wrapGeometry';

/** A world point the beam is drawn between. */
export interface BeamPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The beam's source: a fixed point or a provider returning the ship's current
 * position (`null` when there is no ship to anchor to any more).
 */
export type BeamSource = BeamPoint | (() => BeamPoint | null);

/** Arena dimensions used for the wrapped shortest path. */
export interface BeamArena {
  /** Arena width (px). Defaults to {@link GAME_WIDTH}. */
  arenaWidth?: number;
  /** Arena height (px). Defaults to {@link GAME_HEIGHT}. */
  arenaHeight?: number;
}

/** Default beam colour — the Wave Laser's red (overridable per weapon). */
export const ANCHORED_BEAM_COLOR = 0xff0000;

/** Default hot core colour (the white-hot centre of the beam). */
export const ANCHORED_BEAM_CORE_COLOR = 0xffffff;

/** Default outer column width (px). */
export const ANCHORED_BEAM_WIDTH = 6;

/** Default visible lifetime (s). */
export const ANCHORED_BEAM_DURATION = 0.3;

/** Options for {@link spawnAnchoredBeam}. */
export interface AnchoredBeamOptions extends BeamArena {
  /**
   * Where the beam starts each frame: a point or a provider returning the
   * ship's **current** position (AC1/AC6).
   */
  source: BeamSource;
  /** The frozen far end (snapshotted at spawn — never re-read). */
  destination: BeamPoint;
  /**
   * Fallback source used until a provider yields its first point (e.g. the
   * launch muzzle), and `{ x: 0, y: 0 }` when absent.
   */
  origin?: BeamPoint;
  /**
   * Optional registry the beam is added to while alive and removed from on
   * completion — lets scenes tear the effect down on shutdown and lets tests
   * observe it without pixel assertions (the shared `src/vfx/` pattern).
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Beam colour (Phaser integer). Defaults to {@link ANCHORED_BEAM_COLOR}. */
  color?: number;
  /** Hot-core colour. Defaults to {@link ANCHORED_BEAM_CORE_COLOR}. */
  coreColor?: number;
  /** Outer beam width (px). Defaults to {@link ANCHORED_BEAM_WIDTH}. */
  width?: number;
  /** Hot core width as a fraction of the outer width. Defaults to `0.35`. */
  coreWidthRatio?: number;
  /** Visible lifetime (s). Defaults to {@link ANCHORED_BEAM_DURATION}. */
  duration?: number;
  /** Optional render depth. */
  depth?: number;
  /**
   * Alpha at a normalised age (`0` = just fired, `1` = expiring). Defaults to
   * a linear fade; a caller may pass another curve to keep its shipped look.
   */
  fade?: (progress: number) => number;
}

/**
 * The polyline the beam covers between `from` and `to` on the wrapped arena:
 * the **shortest** path along the torus, one segment per arena crossing.
 *
 * Pure and scene-agnostic (no Phaser), so the wrapping is unit-testable on its
 * own and the drawn beam is provably the geometry the tests pin.
 *
 * @param from - Beam origin (the ship's current position).
 * @param to - Beam end (the frozen destination).
 * @param options - Optional arena dimensions (defaults to the shipped playfield).
 * @returns One segment per straight run between arena-edge crossings.
 */
export function wrappedBeamSegments(
  from: BeamPoint,
  to: BeamPoint,
  options: BeamArena = {},
): HitscanSegment[] {
  const width = options.arenaWidth ?? GAME_WIDTH;
  const height = options.arenaHeight ?? GAME_HEIGHT;
  const dx = wrappedAxisDelta(from.x, to.x, width);
  const dy = wrappedAxisDelta(from.y, to.y, height);

  return traceWrappedRay({
    originX: from.x,
    originY: from.y,
    angleRad: Math.atan2(dy, dx),
    length: Math.hypot(dx, dy),
    width,
    height,
  });
}

/** Strokes `segments` once in the current line style. */
function strokeSegments(
  beam: Phaser.GameObjects.Graphics,
  segments: readonly HitscanSegment[],
): void {
  for (const segment of segments) {
    beam.beginPath();
    beam.moveTo(segment.x1, segment.y1);
    beam.lineTo(segment.x2, segment.y2);
    beam.strokePath();
  }
}

/**
 * Spawns a source-anchored beam from the **current** source to the **frozen**
 * destination and re-draws it every frame.
 *
 * The Graphics is stitched immediately (so the beam is visible on the launch
 * frame), then re-stitched on each scene `update` along
 * {@link wrappedBeamSegments}'s shortest wrapped path and faded by the
 * `fade` curve as its `duration` runs out. On expiry the Graphics is removed
 * from `options.registry` (when given) and destroyed; the same teardown runs on
 * scene `shutdown`, so a scene that ends mid-life never leaves a listener, a
 * registry entry or a display-list object behind.
 *
 * @param scene - The owning scene (owns the Graphics and the `update`/`shutdown` hooks).
 * @param options - Source, frozen destination, styling and lifetime.
 * @returns The beam Graphics (destroyed when its lifetime ends).
 */
export function spawnAnchoredBeam(
  scene: Phaser.Scene,
  options: AnchoredBeamOptions,
): Phaser.GameObjects.Graphics {
  const color = options.color ?? ANCHORED_BEAM_COLOR;
  const coreColor = options.coreColor ?? ANCHORED_BEAM_CORE_COLOR;
  const width = options.width ?? ANCHORED_BEAM_WIDTH;
  const coreWidthRatio = options.coreWidthRatio ?? 0.35;
  const duration = Math.max(0, options.duration ?? ANCHORED_BEAM_DURATION);
  const fade = options.fade ?? ((progress: number) => 1 - progress);
  const registry = options.registry;
  // Snapshot the destination: the far end never moves, even if the caller
  // handed us a live object that later drifts (AC2/AC6).
  const destination: BeamPoint = {
    x: options.destination.x,
    y: options.destination.y,
  };
  const arena: BeamArena = {
    arenaWidth: options.arenaWidth,
    arenaHeight: options.arenaHeight,
  };

  // The last position the source resolved to. A provider that starts
  // returning `null` (the ship died mid-beam) leaves the beam where it was
  // rather than jumping to the origin.
  let sourceX = options.origin?.x ?? 0;
  let sourceY = options.origin?.y ?? 0;

  /** Resolves the ship's current position, keeping the last good one. */
  const resolveSource = (): BeamPoint => {
    const next =
      typeof options.source === 'function' ? options.source() : options.source;
    if (next) {
      sourceX = next.x;
      sourceY = next.y;
    }
    return { x: sourceX, y: sourceY };
  };

  const beam = scene.add.graphics();
  if (options.depth !== undefined) beam.setDepth(options.depth);

  /** Clears and re-stitches the beam along the shortest wrapped path. */
  const draw = (): void => {
    const segments = wrappedBeamSegments(resolveSource(), destination, arena);
    beam.clear();
    // Outer column, then the hot core down the same polyline: one crisp beam.
    beam.lineStyle(width, color, 1);
    strokeSegments(beam, segments);
    beam.lineStyle(Math.max(1, width * coreWidthRatio), coreColor, 0.95);
    strokeSegments(beam, segments);
  };

  // Visible on the launch frame, then re-anchored every frame.
  draw();
  registry?.push(beam);

  let remaining = duration;
  let done = false;

  /**
   * Idempotent teardown: detaches both scene hooks, drops the registry entry
   * and destroys the Graphics. Runs exactly once, from the delta timer, the
   * scene's `shutdown`, or both.
   */
  const cleanup = (): void => {
    if (done) return;
    done = true;
    scene.events.off('update', onUpdate);
    scene.events.off('shutdown', cleanup);
    if (registry) {
      const index = registry.indexOf(beam);
      if (index >= 0) registry.splice(index, 1);
    }
    beam.destroy();
  };

  /** Ages the beam by the frame delta (seconds), re-anchors it, fades it. */
  const onUpdate = (_time: number, deltaMs: number): void => {
    if (done) return;
    remaining -= Math.max(0, deltaMs) / 1000;
    if (remaining <= 0) {
      cleanup();
      return;
    }
    draw();
    const progress = duration > 0 ? 1 - remaining / duration : 1;
    beam.setAlpha(fade(progress));
  };

  scene.events.on('update', onUpdate);
  // A scene that shuts down mid-life (restart, gym teardown) tears the beam
  // down with it instead of leaking the listener and the object.
  scene.events.on('shutdown', cleanup);

  return beam;
}

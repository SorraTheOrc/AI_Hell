/**
 * Mining Laser beam VFX + cue (AH-0MW9QMQ7B005WFH9, parent **Mining laser**
 * AH-0MW81181P007BDRU).
 *
 * ## Why this exists
 *
 * The Mining Laser auto-fires at the nearest live asteroid on a rapid beat-grid
 * cadence (up to one shot per sixteenth note). Damage alone was invisible: the
 * player could not tell the power-up was working, nor which rock it was cutting.
 * This module is the shot's whole feedback: a **thin amber beam** drawn from the
 * ship to the target for a very short life, plus the laser's own **cutting
 * tick** cue.
 *
 * ## Cheap by construction (it fires constantly)
 *
 * - **One Graphics per shot, code-drawn.** No textures, no new assets and no
 *   runtime dependencies — the neon-vector house style of
 *   `vfx/hitscanBeam.ts` (a coloured column with a hot core), in an amber /
 *   copper "cutting" tone deliberately distinct from the wave laser's red beam
 *   and the Orbital Strike's cyan bolt.
 * - **A delta-driven lifetime, not a tween per shot.** The beam ages on the
 *   scene's `update` delta and removes itself when the remaining lifetime runs
 *   out, so its life is wall-clock seconds (frame-rate independent) and a
 *   sustained mining run never piles up tweens. The life is deliberately short:
 *   at the fastest level cadence (0.1875 s) at most one beam is alive at a
 *   time, and the screen is never washed.
 * - **Self-cleaning.** The Graphics is appended to an optional caller-owned
 *   registry (removed when the beam dies) and is destroyed — with its scene
 *   listeners — on completion *and* on scene shutdown, so repeated shots at the
 *   same target can never leak a game object or grow the display list
 *   unboundedly.
 *
 * ## Wrapped-aware aim, from the shared geometry
 *
 * Asteroids wrap at the arena edges, and the target rule selects the nearest
 * rock by **wrapped** distance — so a rock just past the seam can be the
 * target. The beam therefore traces the **shortest wrapped path** from the ship
 * to the target with the shared `scenes/core/hitscanBeam.traceWrappedRay`
 * helper ({@link miningLaserBeamSegments}): a target across the seam renders as
 * the short through-the-edge segment(s), never as a line spanning the whole
 * screen.
 *
 * ## The module owns its cue
 *
 * Following `vfx/orbitalStrike.ts` and `vfx/thornsAbsorb.ts`, the module plays
 * {@link playMiningLaserFireSound} itself — once per shot, at the shot instant.
 * The shared firing seam (`CombatScene.onMiningLaserFire`) is the only caller,
 * so `PlayScene` and every gym show the identical beam and hear the identical
 * tick, no call site can forget the sound, and the cue can never outrun the
 * shot cadence.
 *
 * @module vfx/miningLaserBeam
 */

import type Phaser from 'phaser';

import { playMiningLaserFireSound } from '../audio/effects';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  traceWrappedRay,
  type HitscanSegment,
} from '../scenes/core/hitscanBeam';
import { wrappedAxisDelta } from '../utils/wrapGeometry';

/**
 * The beam's colour — an amber / copper "cutting" tone. Deliberately distinct
 * from the wave laser's red ({@link HITSCAN_BEAM_COLOR} in `vfx/hitscanBeam`)
 * and the Orbital Strike's cyan (`ORBITAL_STRIKE_COLOR` in
 * `vfx/orbitalStrike`), so a mining shot never reads as a hostile beam.
 */
export const MINING_LASER_BEAM_COLOR = 0xffa53a;

/** Hot-white core colour of the beam (the bright centre line). */
export const MINING_LASER_BEAM_CORE_COLOR = 0xfff3d6;

/**
 * Beam half-thickness (px) of the outer column. Thin by design: three times
 * thinner than the wave laser's column, so a rapid cadence reads as a crisp
 * tick between ship and rock and never as a screen-spanning laser.
 */
export const MINING_LASER_BEAM_WIDTH = 2;

/**
 * Visible lifetime in **seconds**. Short (< 0.2 s) so it clears the fastest
 * level cadence (0.1875 s = one sixteenth note at 80 BPM) with room to spare —
 * at most one beam is ever alive, and the tick reads as instantaneous.
 */
export const MINING_LASER_BEAM_DURATION = 0.12;

/** Render depth — above the fight, below the strike's bolt column. */
export const MINING_LASER_BEAM_DEPTH = 62;

/** A world point the beam is drawn between (the ship, the target asteroid). */
export interface MiningLaserBeamPoint {
  readonly x: number;
  readonly y: number;
}

/** Options for {@link spawnMiningLaserBeam}. */
export interface MiningLaserBeamOptions {
  /**
   * Optional registry the beam is added to while alive and removed from on
   * completion — lets scenes tear the effect down on shutdown and lets tests
   * observe it without pixel assertions (the shared `src/vfx/` pattern).
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Beam colour (Phaser integer). Defaults to {@link MINING_LASER_BEAM_COLOR}. */
  color?: number;
  /** Hot-core colour. Defaults to {@link MINING_LASER_BEAM_CORE_COLOR}. */
  coreColor?: number;
  /** Outer beam width (px). Defaults to {@link MINING_LASER_BEAM_WIDTH}. */
  width?: number;
  /** Visible lifetime (s). Defaults to {@link MINING_LASER_BEAM_DURATION}. */
  duration?: number;
  /** Arena width (px) used for the wrapped aim. Defaults to {@link GAME_WIDTH}. */
  arenaWidth?: number;
  /** Arena height (px) used for the wrapped aim. Defaults to {@link GAME_HEIGHT}. */
  arenaHeight?: number;
}

/**
 * The polyline the beam covers between `from` and `to` on the wrapped arena:
 * the **shortest** path along the torus, one segment per arena crossing.
 *
 * A target just past a seam therefore yields the short through-the-edge
 * segment(s) — e.g. a ship at x = 900 firing at a rock at x = 20 on a 960 px
 * arena draws 900 → 960 and 0 → 20, never 900 → 20 across the whole screen.
 *
 * Pure and scene-agnostic (no Phaser), so the wrapping is unit-testable on its
 * own and the drawn beam is provably the geometry the tests pin.
 *
 * @param from - Beam origin (the ship).
 * @param to - Beam end (the target's current position).
 * @param options - Optional arena dimensions (defaults to the shipped playfield).
 * @returns One segment per straight run between arena-edge crossings.
 */
export function miningLaserBeamSegments(
  from: MiningLaserBeamPoint,
  to: MiningLaserBeamPoint,
  options: Pick<MiningLaserBeamOptions, 'arenaWidth' | 'arenaHeight'> = {},
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

/**
 * Spawns the Mining Laser beam from `from` (the ship) to `to` (the target
 * asteroid) and plays the laser's cutting tick once.
 *
 * The beam is a thin amber column with a hot core along
 * {@link miningLaserBeamSegments}'s wrapped polyline, held for `duration`
 * seconds and aged by the scene's `update` **delta** (frame-rate independent —
 * one long frame expires it just as surely as many short ones). On expiry the
 * Graphics is removed from `options.registry` (when given) and destroyed; the
 * same teardown runs on scene `shutdown`, so a scene that ends mid-life never
 * leaves a listener, a registry entry or a display-list object behind.
 *
 * The cue ({@link playMiningLaserFireSound}) is fired here, at the shot
 * instant, so every consumer of the shared firing seam gets the sound exactly
 * once per shot and no call site can forget it.
 *
 * @param scene - The owning scene (owns the Graphics and the `update`/`shutdown` hooks).
 * @param from - Beam origin (the ship's current position).
 * @param to - Beam end (the target's **current** position).
 * @param options - Optional registry, colour/width/duration and arena overrides.
 * @returns The beam Graphics (destroyed when its lifetime ends).
 */
export function spawnMiningLaserBeam(
  scene: Phaser.Scene,
  from: MiningLaserBeamPoint,
  to: MiningLaserBeamPoint,
  options: MiningLaserBeamOptions = {},
): Phaser.GameObjects.Graphics {
  const color = options.color ?? MINING_LASER_BEAM_COLOR;
  const coreColor = options.coreColor ?? MINING_LASER_BEAM_CORE_COLOR;
  const width = options.width ?? MINING_LASER_BEAM_WIDTH;
  const duration = Math.max(0, options.duration ?? MINING_LASER_BEAM_DURATION);
  const registry = options.registry;
  const segments = miningLaserBeamSegments(from, to, options);

  const beam = scene.add.graphics();
  beam.setDepth(MINING_LASER_BEAM_DEPTH);
  // Outer amber column, then the hot core down the same polyline: one crisp
  // beam rather than a hairline.
  beam.lineStyle(width, color, 1);
  for (const segment of segments) {
    beam.beginPath();
    beam.moveTo(segment.x1, segment.y1);
    beam.lineTo(segment.x2, segment.y2);
    beam.strokePath();
  }
  beam.lineStyle(Math.max(1, width * 0.5), coreColor, 0.95);
  for (const segment of segments) {
    beam.beginPath();
    beam.moveTo(segment.x1, segment.y1);
    beam.lineTo(segment.x2, segment.y2);
    beam.strokePath();
  }
  registry?.push(beam);

  // The module owns the cue: one tick per shot, at the shot instant.
  playMiningLaserFireSound();

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

  /** Ages the beam by the frame delta (seconds), then fades it out. */
  const onUpdate = (_time: number, deltaMs: number): void => {
    if (done) return;
    remaining -= Math.max(0, deltaMs) / 1000;
    if (remaining <= 0) {
      cleanup();
      return;
    }
    beam.setAlpha(remaining / duration);
  };

  scene.events.on('update', onUpdate);
  // A scene that shuts down mid-life (restart, gym teardown) tears the beam down
  // with it instead of leaking the listener and the object.
  scene.events.on('shutdown', cleanup);

  // A zero-length life (a caller override) expires on the next frame; the
  // Graphics is still returned so the caller can observe it immediately.
  return beam;
}

/**
 * Orbital Strike bolt VFX (parent AH-0MVRE6N08001TE4V, this module
 * AH-0MVS2SXTM000H5PL).
 *
 * ## Why this exists
 *
 * The reward Orbital Strike used to render through `spawnNovaRing` — the very
 * same concentric-ring helper, in the same colour family, that the Smart Bomb
 * pulse uses. Nothing in that composition said *"a bolt came down from orbit"*,
 * so a strike read as a faint cyan Smart Bomb ring.
 *
 * This module owns the strike's own composition instead: a **descending bolt**
 * — a tapered, glowing column drawn only in the target's column that streaks
 * from above the top of the play area down to the impact point — a **target
 * marker** (a bracketed reticle with a lock-on ring) that holds on the target
 * while the bolt falls, and an **impact flash plus a brief outward shock ring**
 * on arrival.
 *
 * ## How it differs from the Smart Bomb ring
 *
 * The difference is **geometric, not chromatic**: `spawnNovaRing` emits
 * concentric arcs that expand outward from the ship, whereas this effect draws
 * a vertical column above the target and never widens past the target's
 * column. A recoloured Nova ring therefore cannot be mistaken for a strike
 * (see `orbitalStrike.test.ts`, which forces both effects to one colour to
 * prove the shapes — not the palette — carry the identity).
 *
 * ## Shared, scene-agnostic by construction
 *
 * Like its peers (`aoeEffect.ts`, `thornsAbsorb.ts`, `wormholeSpawn.ts`) this
 * is a pure helper: it takes a scene, a target position and an options object
 * and traces nothing scene-specific. The shared strike path in
 * `src/scenes/core/CombatScene.ts` calls it once, so `PlayScene` and every
 * combat gym render the identical bolt (gym↔game parity,
 * AH-0MUGZDTFX004RBD1). The strike's colour and geometry constants live here
 * so there is a single source of truth for them.
 *
 * Everything is code-drawn Phaser Graphics plus tweens — no textures, no new
 * assets, no runtime dependencies — and the effect is cosmetic only: it applies
 * no damage and awards no score.
 *
 * @module vfx/orbitalStrike
 */

import type Phaser from 'phaser';

/**
 * The strike's colour — a cyan-white bolt that reads as reflected orbital
 * light. Exported so the strike path (and its HUD/impact accents) consume one
 * definition rather than restating the value.
 */
export const ORBITAL_STRIKE_COLOR = 0x9ffcff;

/**
 * Total effect lifetime in **seconds** (descent + impact). Kept ≤ 0.35 s so a
 * permanent strike's pulses never overlap into a screen-wide wash in a crowded
 * wave.
 */
export const ORBITAL_STRIKE_DURATION = 0.32;

/**
 * Widest drawn extent of the descending bolt **column** in px. The bolt is
 * drawn only within `±ORBITAL_STRIKE_BOLT_WIDTH / 2` of the target's column, so
 * a full-height descent can never become a full-screen flash.
 */
export const ORBITAL_STRIKE_BOLT_WIDTH = 14;

/**
 * Radius (px) of the target marker and of every impact accent (flash core,
 * shock ring). Nothing in the composition is drawn further than this from the
 * impact point in x.
 */
export const ORBITAL_STRIKE_MARKER_RADIUS = 18;

/** Render depth — above the fight so the bolt reads over ships and bullets. */
export const ORBITAL_STRIKE_DEPTH = 64;

// ── Internal composition tunables ───────────────────────────────────

/**
 * Shortest bolt descent (px). The bolt normally starts from the top of the
 * scene (see {@link spawnOrbitalStrike}); this floor keeps the descent reading
 * as "from orbit" even in a tiny scene or for a target at the very top.
 */
const BOLT_MIN_DESCENT = 160;

/** Fraction of the scene height added above the target so the bolt starts off-screen. */
const BOLT_OFFSCREEN_MARGIN_RATIO = 0.1;

/** Half-width (px) of the tapered column at its head (the impact end). */
const BOLT_HEAD_HALF_WIDTH = ORBITAL_STRIKE_BOLT_WIDTH / 2;

/** Half-width (px) of the tapered column at its tail (the off-screen end). */
const BOLT_TAIL_HALF_WIDTH = 1.5;

/** Stroke width (px) of the column's straight core line. */
const BOLT_CORE_LINE_WIDTH = 2;

/** Radius (px) of the bright bolt head that streaks down the column. */
const BOLT_HEAD_RADIUS = 4.5;

/** Fill alpha of the tapered column body. */
const BOLT_BODY_ALPHA = 0.2;

/** Stroke alpha of the column's core line. */
const BOLT_CORE_ALPHA = 0.55;

/**
 * Marker geometry, as fractions of {@link ORBITAL_STRIKE_MARKER_RADIUS}: the
 * outward chevron tip / base offsets, the base half-spread, and the lock-on
 * ring radius. Every vertex stays inside the marker radius.
 */
const MARKER_TIP_RATIO = 0.94;
/** See {@link MARKER_TIP_RATIO}. */
const MARKER_BASE_RATIO = 0.44;
/** See {@link MARKER_TIP_RATIO}. */
const MARKER_SPREAD_RATIO = 0.44;
/** See {@link MARKER_TIP_RATIO}. */
const MARKER_CORE_RING_RATIO = 0.28;

/** Marker stroke width (px). */
const MARKER_LINE_WIDTH = 2;

/** Impact flash core radius (px) as a fraction of {@link ORBITAL_STRIKE_MARKER_RADIUS}. */
const FLASH_RADIUS_RATIO = 0.45;

/** Impact flash wash radius (px) as a fraction of {@link ORBITAL_STRIKE_MARKER_RADIUS}. */
const FLASH_WASH_RADIUS_RATIO = 0.72;

/** Shock ring radius (px) as a fraction of {@link ORBITAL_STRIKE_MARKER_RADIUS}. */
const SHOCK_RING_RADIUS_RATIO = 0.6;

/** Shock ring stroke width (px). */
const SHOCK_RING_LINE_WIDTH = 3;

/** Fraction of the total lifetime spent descending; the remainder is the impact. */
const DESCENT_FRACTION = 0.65;

/** Options for {@link spawnOrbitalStrike}. */
export interface OrbitalStrikeOptions {
  /**
   * Optional registry the spawned Graphics is added to while alive and
   * removed from on completion — lets scenes track/tear down the effect and
   * tests observe it without pixel assertions (the shared `src/vfx/` pattern).
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Effect lifetime override (seconds). Defaults to {@link ORBITAL_STRIKE_DURATION}. */
  duration?: number;
  /** Effect colour override (Phaser integer). Defaults to {@link ORBITAL_STRIKE_COLOR}. */
  color?: number;
}

/** Handle returned by {@link spawnOrbitalStrike}. */
export interface OrbitalStrikeHandle {
  /** The effect Graphics (destroyed when the effect completes). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** True once the effect has finished and been torn down. */
  isComplete(): boolean;
}

/**
 * Spawns the Orbital Strike bolt at `(x, y)` — the impact point.
 *
 * The Graphics is positioned at the impact point and every part of the
 * composition is drawn in local coordinates around that origin:
 *
 * 1. **Descent** ({@link DESCENT_FRACTION} of `duration`) — a tapered glowing
 *    column drawn from above the top of the play area down to the target,
 *    with a bright bolt head streaking down it, over the target marker.
 * 2. **Impact** (the remainder) — a white-hot flash plus an outward shock ring
 *    at the impact point while the marker fades away.
 *
 * The bolt column is only ever drawn within `±ORBITAL_STRIKE_BOLT_WIDTH / 2`
 * of the target's column, so the effect never becomes a screen-wide flash.
 * On completion the Graphics is removed from `options.registry` (when given)
 * and destroyed, and only then does {@link OrbitalStrikeHandle.isComplete}
 * report true.
 *
 * @param scene - The owning scene (tween owner).
 * @param x - Impact point x (the target's world x).
 * @param y - Impact point y (the target's world y).
 * @param options - Optional registry/duration/colour overrides.
 * @returns An {@link OrbitalStrikeHandle} for observation/teardown.
 */
export function spawnOrbitalStrike(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: OrbitalStrikeOptions = {},
): OrbitalStrikeHandle {
  const duration = options.duration ?? ORBITAL_STRIKE_DURATION;
  const color = options.color ?? ORBITAL_STRIKE_COLOR;
  const registry = options.registry;

  // The bolt comes from above the play area: its tail starts off-screen (a
  // scene-generic `scale` read, never a hard-coded play-area height), with a
  // floor so a target at the very top still gets a readable descent.
  const sceneHeight = scene.scale?.height ?? 0;
  const descent = Math.max(
    BOLT_MIN_DESCENT,
    y + sceneHeight * BOLT_OFFSCREEN_MARGIN_RATIO,
  );

  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  graphics.setDepth(ORBITAL_STRIKE_DEPTH);

  /**
   * Draws the target marker: a bracketed reticle built from four self-contained
   * triangles, so each bracket is a discrete stroked shape sitting at the
   * impact point (no vertex of the reticle reaches further than
   * {@link ORBITAL_STRIKE_MARKER_RADIUS} in any direction).
   *
   * Self-contained shapes rather than one multi-segment path keep the reticle
   * readable as "this exact point is the target" and keep the whole composition
   * inside the marker radius — the bolt column above it is the only part that
   * reaches up the screen.
   */
  const drawMarker = (): void => {
    graphics.lineStyle(MARKER_LINE_WIDTH, color, 0.9);
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Each bracket: an outward-pointing chevron — a single self-contained
      // stroked triangle, so the reticle stays a set of discrete marks on the
      // target rather than one sprawling path.
      const tip = ORBITAL_STRIKE_MARKER_RADIUS * MARKER_TIP_RATIO;
      const base = ORBITAL_STRIKE_MARKER_RADIUS * MARKER_BASE_RATIO;
      const spread = ORBITAL_STRIKE_MARKER_RADIUS * MARKER_SPREAD_RATIO;
      graphics.strokeTriangle(
        cos * tip,
        sin * tip,
        cos * base - sin * spread,
        sin * base + cos * spread,
        cos * base + sin * spread,
        sin * base - cos * spread,
      );
    }
    // Lock-on ring — the centre of the reticle, so the marker still reads as
    // "aimed here" once the brackets have faded.
    graphics.lineStyle(1, color, 0.7);
    graphics.strokeCircle(
      0,
      0,
      ORBITAL_STRIKE_MARKER_RADIUS * MARKER_CORE_RING_RATIO,
    );
  };

  /**
   * Draws one descent frame: the full tapered column (so the incoming bolt is
   * visible), the brighter travelled section, the bolt head at `headY` and the
   * target marker underneath.
   */
  const drawDescent = (headY: number): void => {
    graphics.clear();
    // Tapered column body — narrow at the tail, widest at the head.
    graphics.fillStyle(color, BOLT_BODY_ALPHA);
    graphics.beginPath();
    graphics.moveTo(-BOLT_TAIL_HALF_WIDTH, -descent);
    graphics.lineTo(BOLT_TAIL_HALF_WIDTH, -descent);
    graphics.lineTo(BOLT_HEAD_HALF_WIDTH, 0);
    graphics.lineTo(-BOLT_HEAD_HALF_WIDTH, 0);
    graphics.closePath();
    graphics.fillPath();
    // Straight vertical core: the column's spine, at the target's x only.
    graphics.lineStyle(BOLT_CORE_LINE_WIDTH, color, BOLT_CORE_ALPHA);
    graphics.beginPath();
    graphics.moveTo(0, -descent);
    graphics.lineTo(0, 0);
    graphics.strokePath();
    // Travelled section — brighter behind the head, so it reads as a bolt
    // streaking down rather than a lamp switched on.
    if (headY > -descent) {
      graphics.lineStyle(BOLT_CORE_LINE_WIDTH, 0xffffff, 0.85);
      graphics.beginPath();
      graphics.moveTo(0, -descent);
      graphics.lineTo(0, headY);
      graphics.strokePath();
    }
    // Bolt head — the bright tip of the descending bolt.
    graphics.fillStyle(0xffffff, 0.95);
    graphics.fillCircle(0, headY, BOLT_HEAD_RADIUS);
    drawMarker();
  };

  /** Draws the arrival: white-hot flash core, coloured wash and shock ring. */
  const drawImpact = (): void => {
    graphics.clear();
    drawMarker();
    graphics.fillStyle(color, 0.5);
    graphics.fillCircle(
      0,
      0,
      ORBITAL_STRIKE_MARKER_RADIUS * FLASH_WASH_RADIUS_RATIO,
    );
    graphics.fillStyle(0xffffff, 0.95);
    graphics.fillCircle(0, 0, ORBITAL_STRIKE_MARKER_RADIUS * FLASH_RADIUS_RATIO);
    graphics.lineStyle(SHOCK_RING_LINE_WIDTH, color, 0.9);
    graphics.strokeCircle(
      0,
      0,
      ORBITAL_STRIKE_MARKER_RADIUS * SHOCK_RING_RADIUS_RATIO,
    );
  };

  drawDescent(-descent);
  registry?.push(graphics);

  let complete = false;
  const descentMs = duration * DESCENT_FRACTION * 1000;
  const impactMs = duration * (1 - DESCENT_FRACTION) * 1000;

  // Stage 1 — the bolt falls: the column stays put, the bright head travels
  // from off-screen down to the impact point.
  const head = { y: -descent };
  scene.tweens.add({
    targets: head,
    y: 0,
    duration: descentMs,
    ease: 'Quad.easeIn',
    onUpdate: () => drawDescent(head.y),
    onComplete: () => {
      // Stage 2 — arrival: flash + shock ring, then fade the whole effect out.
      drawImpact();
      scene.tweens.add({
        targets: graphics,
        alpha: 0,
        scale: 1.25,
        duration: impactMs,
        ease: 'Power2',
        onComplete: () => {
          complete = true;
          if (registry) {
            const index = registry.indexOf(graphics);
            if (index >= 0) registry.splice(index, 1);
          }
          graphics.destroy();
        },
      });
    },
  });

  return {
    graphics,
    isComplete: () => complete,
  };
}

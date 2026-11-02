/**
 * Hyperspace warp transition VFX (parent AH-0MVIB7PD50029ZY1, slice
 * AH-0MVSEBCNC005G7XW).
 *
 * The unmistakable "jump through space" that plays while the background changes
 * between campaign levels (producer answer Q2, 2026-10-25: **Option A** —
 * hyperspace-style one-shot). The whole effect is exactly
 * {@link BACKGROUND_WARP_DURATION_SECONDS} long, which is derived from
 * {@link LEVEL_TRANSITION_SECONDS}, so the warp can never outlive the existing
 * level-transition pause (parent AC3).
 *
 * ## Three layers, each independently switchable
 *
 * 1. **Converging streaks** ({@link BACKGROUND_WARP_ENABLE_STREAKS}) — the
 *    hyperspace star lines, seeded per level pair and converging toward the
 *    screen centre (exponential in {@link BACKGROUND_WARP_STREAK_SPEED}).
 * 2. **Radial scale distortion** ({@link BACKGROUND_WARP_ENABLE_DISTORTION}) —
 *    a radial ring grid plus the {@link BackgroundWarp.distortionScale} value
 *    the background layer should be drawn at (a zoom-in over the phase). The
 *    value is exposed rather than applied here because this module must not
 *    know about the background layer (`scenes/core/backgroundLayer.ts`); the
 *    `PlayScene` wiring slice (AH-0MVSEBW8L009O3JD) applies it.
 * 3. **Flash / crossfade** ({@link BACKGROUND_WARP_ENABLE_FLASH}) — a
 *    full-canvas white peak at the start of the final phase that fades to zero,
 *    hiding the background swap and handing over to the incoming background.
 *
 * Every toggle defaults from an exported `BACKGROUND_WARP_ENABLE_*` constant
 * (the `ENDOFRUN_ENABLE_*` house pattern) and can be overridden per call, so a
 * layer can be disabled without code surgery.
 *
 * ## Determinism (parent AC3, slice AC4)
 *
 * There is no `Math.random()` anywhere: {@link planBackgroundWarp} seeds a
 * {@link createSeededRng} generator with `(fromLevel, toLevel)`, so the same
 * level pair always produces the same streak geometry while each jump looks
 * slightly different. Animation is driven by an explicit
 * {@link BackgroundWarp.update} tick (seconds), not by wall-clock tweens, so a
 * test can advance exactly `BACKGROUND_WARP_DURATION_SECONDS` and assert
 * completion.
 *
 * ## Bounded and disposable (slice AC5)
 *
 * One {@link Phaser.GameObjects.Container} holds every display object, the
 * streak count is capped at {@link BACKGROUND_WARP_MAX_STREAKS}, and both
 * completion and {@link BackgroundWarp.destroy} tear the container (and its
 * children) down exactly once — a scene restart mid-warp leaks nothing.
 *
 * ## Layering
 *
 * The container sits at {@link BACKGROUND_WARP_DEPTH} — above the background
 * photo and its dim overlay, below the juice layers and gameplay — so the warp
 * reads as part of the backdrop while enemies, bullets and the ship stay
 * legible on top of it.
 *
 * @module vfx/backgroundWarp
 */

import Phaser from 'phaser';

import {
  BACKGROUND_WARP_DEPTH,
  GAME_HEIGHT,
  GAME_WIDTH,
  LEVEL_TRANSITION_SECONDS,
} from '../core/constants';
import { createSeededRng } from '../core/rng';

// ── Timeline (single source of truth) ───────────────────────────────

/**
 * Total warp duration — exactly the level-transition pause, so the effect
 * always finishes when the incoming level becomes playable.
 */
export const BACKGROUND_WARP_DURATION_SECONDS = LEVEL_TRANSITION_SECONDS;

/** Length of the converging-streak phase (the "accelerate" read). */
export const BACKGROUND_WARP_STREAK_PHASE_SECONDS = 0.7;

/** Length of the radial scale-distortion phase (the "stretch" read). */
export const BACKGROUND_WARP_DISTORTION_PHASE_SECONDS = 0.4;

/**
 * Length of the flash/crossfade phase, derived so the three phases always sum
 * to {@link BACKGROUND_WARP_DURATION_SECONDS} (never a duplicated literal).
 */
export const BACKGROUND_WARP_FLASH_PHASE_SECONDS =
  BACKGROUND_WARP_DURATION_SECONDS -
  BACKGROUND_WARP_STREAK_PHASE_SECONDS -
  BACKGROUND_WARP_DISTORTION_PHASE_SECONDS;

/** Absolute start of the streak phase (seconds from the warp's first tick). */
export const BACKGROUND_WARP_STREAK_START_SECONDS = 0;

/** Absolute start of the distortion phase (the streak phase's end). */
export const BACKGROUND_WARP_DISTORTION_START_SECONDS =
  BACKGROUND_WARP_STREAK_START_SECONDS + BACKGROUND_WARP_STREAK_PHASE_SECONDS;

/** Absolute start of the flash/crossfade phase (the distortion phase's end). */
export const BACKGROUND_WARP_FLASH_START_SECONDS =
  BACKGROUND_WARP_DISTORTION_START_SECONDS +
  BACKGROUND_WARP_DISTORTION_PHASE_SECONDS;

/** Absolute end of the warp (the flash phase's end = the total duration). */
export const BACKGROUND_WARP_FLASH_END_SECONDS =
  BACKGROUND_WARP_FLASH_START_SECONDS + BACKGROUND_WARP_FLASH_PHASE_SECONDS;

/** One of the warp's three ordered, non-overlapping phases (or `'complete'`). */
export type BackgroundWarpPhase = 'streaks' | 'distortion' | 'flash' | 'complete';

/**
 * Resolves which phase a given elapsed time falls in.
 *
 * Phase boundaries belong to the phase that starts at them, so
 * `warpPhaseAt(BACKGROUND_WARP_FLASH_START_SECONDS)` is `'flash'` and
 * `warpPhaseAt(BACKGROUND_WARP_DURATION_SECONDS)` is `'complete'`. Negative
 * and `NaN` inputs resolve to `'streaks'` (a not-yet-started warp), never
 * throwing.
 *
 * @param elapsedSeconds - Seconds advanced since the warp started.
 */
export function warpPhaseAt(elapsedSeconds: number): BackgroundWarpPhase {
  // `>=` so the boundary belongs to the phase that starts at it (see the
  // contract above); the negated form also keeps `NaN`/negative input in
  // 'streaks' without throwing.
  if (!(elapsedSeconds >= BACKGROUND_WARP_DISTORTION_START_SECONDS)) {
    return 'streaks';
  }
  if (elapsedSeconds < BACKGROUND_WARP_FLASH_START_SECONDS) return 'distortion';
  if (elapsedSeconds < BACKGROUND_WARP_DURATION_SECONDS) return 'flash';
  return 'complete';
}

// ── Layer toggles (ENDOFRUN_ENABLE_* house pattern) ─────────────────

/** Whether the converging-streak layer renders. */
export const BACKGROUND_WARP_ENABLE_STREAKS = true;

/** Whether the radial scale-distortion layer renders (and exports its scale). */
export const BACKGROUND_WARP_ENABLE_DISTORTION = true;

/** Whether the flash/crossfade layer renders. */
export const BACKGROUND_WARP_ENABLE_FLASH = true;

// ── Streak magnitudes ───────────────────────────────────────────────

/**
 * Hard cap on the number of streak lines drawn — keeps the full-screen effect
 * bounded on low-end hardware regardless of tuning.
 */
export const BACKGROUND_WARP_MAX_STREAKS = 120;

/** Number of streak lines drawn per warp (always ≤ {@link BACKGROUND_WARP_MAX_STREAKS}). */
export const BACKGROUND_WARP_STREAK_COUNT = 96;

/**
 * Convergence speed of the streak set: its scale decays exponentially as
 * `e^(-speed × secondsInPhase)`, so the lines accelerate toward the centre
 * instead of sliding at a constant rate. At the default the set reaches ≈11 %
 * of its starting scale by the end of the streak phase.
 */
export const BACKGROUND_WARP_STREAK_SPEED = 3.2;

/** Peak alpha of the streak lines (they fade as they converge). */
export const BACKGROUND_WARP_STREAK_ALPHA = 0.9;

/** Outer (tail) streak colour — deep violet, matching the wormhole portal. */
export const BACKGROUND_WARP_STREAK_COLOR_OUTER = 0x8833cc;

/** Inner (head) streak colour — bright cyan, matching the wormhole swirl. */
export const BACKGROUND_WARP_STREAK_COLOR_INNER = 0x33ccff;

/** Minimum streak stroke width (px). */
export const BACKGROUND_WARP_STREAK_MIN_WIDTH = 1;

/** Maximum streak stroke width (px). */
export const BACKGROUND_WARP_STREAK_MAX_WIDTH = 3;

// ── Distortion magnitudes ───────────────────────────────────────────

/** Colour of the radial distortion rings — a violet that reads between the two streak colours. */
export const BACKGROUND_WARP_DISTORTION_COLOR = 0x9a4dff;

/** Background scale at the start of the distortion phase (native scale). */
export const BACKGROUND_WARP_DISTORTION_SCALE_FROM = 1;

/** Background scale at the end of the distortion phase (zoomed in under the flash). */
export const BACKGROUND_WARP_DISTORTION_SCALE_TO = 1.5;

/** Number of concentric rings that sell the radial distortion. */
export const BACKGROUND_WARP_DISTORTION_RING_COUNT = 5;

/** Peak alpha of the distortion rings. */
export const BACKGROUND_WARP_DISTORTION_RING_ALPHA = 0.55;

/** Ring-grid scale at the start of the distortion phase (contracted). */
export const BACKGROUND_WARP_DISTORTION_RING_SCALE_FROM = 0.4;

/** Ring-grid scale at the end of the distortion phase (expanded past the canvas). */
export const BACKGROUND_WARP_DISTORTION_RING_SCALE_TO = 1.7;

// ── Flash magnitudes ────────────────────────────────────────────────

/** Colour of the flash/crossfade overlay — white, distinct from death juice. */
export const BACKGROUND_WARP_FLASH_COLOR = 0xffffff;

/** Peak alpha of the flash at the start of the flash phase (fades 1 → 0). */
export const BACKGROUND_WARP_FLASH_ALPHA = 0.9;

// ── Plan (pure, deterministic) ──────────────────────────────────────

/** One converging streak line in a {@link BackgroundWarpPlan}. */
export interface BackgroundWarpStreak {
  /** Angle around the centre, radians in `[0, 2π)`. */
  readonly angle: number;
  /** Inner (head) radius along {@link angle}, px from the screen centre. */
  readonly innerRadius: number;
  /** Outer (tail) radius along {@link angle}, px from the screen centre. */
  readonly outerRadius: number;
  /** Stroke width, px in `[BACKGROUND_WARP_STREAK_MIN_WIDTH, MAX_WIDTH]`. */
  readonly width: number;
  /** One of the two streak colours, so the fan reads as a violet→cyan gradient. */
  readonly colour: number;
}

/**
 * The complete, deterministic parameter set for one warp.
 *
 * Two calls with the same `(fromLevel, toLevel)` return byte-identical plans,
 * so a recorded demo, a repeat test run and a captured video all look the
 * same (determinism contract, slice AC4).
 */
export interface BackgroundWarpPlan {
  /** The seed the plan's geometry was drawn from. */
  readonly seed: number;
  /** Total duration, seconds ({@link BACKGROUND_WARP_DURATION_SECONDS}). */
  readonly durationSeconds: number;
  /** Bounded streak geometry, `≤ BACKGROUND_WARP_MAX_STREAKS` entries. */
  readonly streaks: readonly BackgroundWarpStreak[];
  /** Background scale range over the distortion phase. */
  readonly distortion: {
    readonly fromScale: number;
    readonly toScale: number;
  };
  /** Flash/crossfade appearance. */
  readonly flash: {
    readonly colour: number;
    readonly peakAlpha: number;
  };
}

/** Clamps a level identifier into a finite, positive integer (never throws). */
function normaliseLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.max(1, Math.trunc(level));
}

/** Derives the deterministic seed for a level pair (order matters). */
function warpSeed(fromLevel: number, toLevel: number): number {
  const from = normaliseLevel(fromLevel);
  const to = normaliseLevel(toLevel);
  return (Math.imul(from, 73856093) ^ Math.imul(to, 19349663)) >>> 0;
}

/**
 * Builds the deterministic layer parameters for the warp from `fromLevel` to
 * `toLevel`.
 *
 * Pure and total: no `Math.random()`, no wall-clock time, and out-of-range or
 * non-finite levels are normalised instead of throwing. The same level pair
 * always yields byte-identical output (`JSON.stringify` equal).
 *
 * @param fromLevel - The level being left (any number; normalised).
 * @param toLevel - The level being entered (any number; normalised).
 */
export function planBackgroundWarp(
  fromLevel: number,
  toLevel: number,
): BackgroundWarpPlan {
  const seed = warpSeed(fromLevel, toLevel);
  const rng = createSeededRng(seed);
  // Half the canvas diagonal: the radius at which a streak leaves the screen.
  const maxRadius = Math.hypot(GAME_WIDTH, GAME_HEIGHT) / 2;
  const streaks: BackgroundWarpStreak[] = [];

  for (let i = 0; i < BACKGROUND_WARP_STREAK_COUNT; i++) {
    // Evenly spaced with a seed-driven jitter, always inside [0, 2π).
    const angle =
      ((i + rng() * 0.8) / BACKGROUND_WARP_STREAK_COUNT) * Math.PI * 2;
    const innerRadius = maxRadius * (0.06 + rng() * 0.14);
    const outerRadius = maxRadius * (0.55 + rng() * 0.65);
    const width =
      BACKGROUND_WARP_STREAK_MIN_WIDTH +
      Math.floor(
        rng() * (BACKGROUND_WARP_STREAK_MAX_WIDTH - BACKGROUND_WARP_STREAK_MIN_WIDTH + 1),
      );
    const colour =
      rng() < 0.5
        ? BACKGROUND_WARP_STREAK_COLOR_OUTER
        : BACKGROUND_WARP_STREAK_COLOR_INNER;

    streaks.push({ angle, innerRadius, outerRadius, width, colour });
  }

  return {
    seed,
    durationSeconds: BACKGROUND_WARP_DURATION_SECONDS,
    streaks,
    distortion: {
      fromScale: BACKGROUND_WARP_DISTORTION_SCALE_FROM,
      toScale: BACKGROUND_WARP_DISTORTION_SCALE_TO,
    },
    flash: {
      colour: BACKGROUND_WARP_FLASH_COLOR,
      peakAlpha: BACKGROUND_WARP_FLASH_ALPHA,
    },
  };
}

// ── Layer resolution ────────────────────────────────────────────────

/** Per-call layer enable overrides (each defaults to its `BACKGROUND_WARP_ENABLE_*`). */
export interface BackgroundWarpLayerOverrides {
  /** Override {@link BACKGROUND_WARP_ENABLE_STREAKS}. */
  enableStreaks?: boolean;
  /** Override {@link BACKGROUND_WARP_ENABLE_DISTORTION}. */
  enableDistortion?: boolean;
  /** Override {@link BACKGROUND_WARP_ENABLE_FLASH}. */
  enableFlash?: boolean;
}

/** The effective per-layer enable flags for one warp. */
export interface BackgroundWarpLayers {
  streaks: boolean;
  distortion: boolean;
  flash: boolean;
}

/**
 * Resolves the effective layer set: exported toggles by default, per-call
 * overrides on top. Pure and total.
 *
 * @param overrides - Optional per-layer overrides.
 */
export function resolveBackgroundWarpLayers(
  overrides: BackgroundWarpLayerOverrides = {},
): BackgroundWarpLayers {
  return {
    streaks: overrides.enableStreaks ?? BACKGROUND_WARP_ENABLE_STREAKS,
    distortion: overrides.enableDistortion ?? BACKGROUND_WARP_ENABLE_DISTORTION,
    flash: overrides.enableFlash ?? BACKGROUND_WARP_ENABLE_FLASH,
  };
}

// ── Handle ──────────────────────────────────────────────────────────

/** Options for {@link createBackgroundWarp}. */
export interface BackgroundWarpOptions extends BackgroundWarpLayerOverrides {
  /** The level being left (seeds the streak geometry). */
  fromLevel: number;
  /** The level being entered (seeds the streak geometry). */
  toLevel: number;
}

/**
 * Handle to one running warp — the entire lifecycle surface a scene consumes.
 */
export interface BackgroundWarp {
  /** The single container holding every warp display object. */
  readonly container: Phaser.GameObjects.Container;
  /** The deterministic parameter set this warp renders. */
  readonly plan: BackgroundWarpPlan;
  /** Seconds advanced so far (clamped to the total duration). */
  readonly elapsedSeconds: number;
  /**
   * The radial scale the background should currently be drawn at.
   *
   * `1` outside the distortion phase (and after it, so the incoming background
   * is shown at native scale) and `BACKGROUND_WARP_DISTORTION_SCALE_FROM →
   * _TO` across it. Always `1` when the distortion layer is disabled.
   */
  readonly distortionScale: number;
  /** Current flash alpha; `0` outside the flash phase and always `0` when the flash layer is disabled. */
  readonly flashAlpha: number;
  /**
   * Advances the warp by `dtSeconds` (seconds). Non-positive and non-finite
   * deltas are ignored; the elapsed time clamps at the total duration, at which
   * point the effect tears itself down.
   */
  update(dtSeconds: number): void;
  /** `true` once {@link BACKGROUND_WARP_DURATION_SECONDS} has elapsed (never before). */
  isComplete(): boolean;
  /** Removes every display object this warp created; idempotent. */
  destroy(): void;
}

/** Clamps `value` into `[0, 1]` (total: non-finite input resolves to 0). */
function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value < 1 ? value : 1;
}

/** The single implementation behind {@link BackgroundWarp}. */
class WarpEffect implements BackgroundWarp {
  private readonly containerRef: Phaser.GameObjects.Container;
  private readonly planRef: BackgroundWarpPlan;
  private readonly layers: BackgroundWarpLayers;
  private readonly streaks: Phaser.GameObjects.Graphics | null;
  private readonly distortion: Phaser.GameObjects.Graphics | null;
  private readonly flash: Phaser.GameObjects.Rectangle | null;
  private elapsed = 0;
  private complete = false;
  private destroyed = false;
  private scaleValue = BACKGROUND_WARP_DISTORTION_SCALE_FROM;
  private flashValue = 0;

  constructor(scene: Phaser.Scene, options: BackgroundWarpOptions) {
    this.planRef = planBackgroundWarp(options.fromLevel, options.toLevel);
    this.layers = resolveBackgroundWarpLayers(options);

    const centreX = GAME_WIDTH / 2;
    const centreY = GAME_HEIGHT / 2;
    const maxRadius = Math.hypot(GAME_WIDTH, GAME_HEIGHT) / 2;

    this.containerRef = scene.add
      .container(0, 0)
      .setDepth(BACKGROUND_WARP_DEPTH)
      .setScrollFactor(0);

    // Layer 1 — converging streaks, drawn once and animated by scale/alpha.
    if (this.layers.streaks) {
      const graphics = scene.add.graphics();
      graphics.setPosition(centreX, centreY);
      for (const streak of this.planRef.streaks) {
        const cos = Math.cos(streak.angle);
        const sin = Math.sin(streak.angle);
        graphics.lineStyle(streak.width, streak.colour, 1);
        graphics.beginPath();
        graphics.moveTo(cos * streak.innerRadius, sin * streak.innerRadius);
        graphics.lineTo(cos * streak.outerRadius, sin * streak.outerRadius);
        graphics.strokePath();
      }
      graphics.setAlpha(0);
      this.containerRef.add(graphics);
      this.streaks = graphics;
    } else {
      this.streaks = null;
    }

    // Layer 2 — radial distortion ring grid.
    if (this.layers.distortion) {
      const graphics = scene.add.graphics();
      graphics.setPosition(centreX, centreY);
      graphics.lineStyle(2, BACKGROUND_WARP_DISTORTION_COLOR, 1);
      for (let i = 0; i < BACKGROUND_WARP_DISTORTION_RING_COUNT; i++) {
        const radius = maxRadius * (0.2 + i * 0.18);
        graphics.strokeCircle(0, 0, radius);
      }
      graphics.setScale(BACKGROUND_WARP_DISTORTION_RING_SCALE_FROM);
      graphics.setAlpha(0);
      this.containerRef.add(graphics);
      this.distortion = graphics;
    } else {
      this.distortion = null;
    }

    // Layer 3 — the full-canvas flash/crossfade.
    if (this.layers.flash) {
      const rect = scene.add
        .rectangle(
          0,
          0,
          GAME_WIDTH,
          GAME_HEIGHT,
          this.planRef.flash.colour,
          this.planRef.flash.peakAlpha,
        )
        .setOrigin(0)
        .setAlpha(0);
      this.containerRef.add(rect);
      this.flash = rect;
    } else {
      this.flash = null;
    }

    this.applyValues(0);
  }

  get container(): Phaser.GameObjects.Container {
    return this.containerRef;
  }

  get plan(): BackgroundWarpPlan {
    return this.planRef;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  get distortionScale(): number {
    return this.scaleValue;
  }

  get flashAlpha(): number {
    return this.flashValue;
  }

  update(dtSeconds: number): void {
    if (this.destroyed || this.complete) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

    this.elapsed = Math.min(
      this.elapsed + dtSeconds,
      this.planRef.durationSeconds,
    );
    this.applyValues(this.elapsed);

    if (this.elapsed >= this.planRef.durationSeconds) {
      this.complete = true;
      this.teardown();
    }
  }

  isComplete(): boolean {
    return this.complete;
  }

  destroy(): void {
    this.teardown();
  }

  /** Applies the phase-local visual state for `elapsed` seconds. */
  private applyValues(elapsed: number): void {
    const phase = warpPhaseAt(elapsed);

    // Streaks: exponential convergence with a fade-out, frozen once the phase ends.
    if (this.streaks !== null) {
      const progress = clamp01(
        (elapsed - BACKGROUND_WARP_STREAK_START_SECONDS) /
          BACKGROUND_WARP_STREAK_PHASE_SECONDS,
      );
      const convergence = Math.exp(
        -BACKGROUND_WARP_STREAK_SPEED *
          Math.min(progress, 1) *
          BACKGROUND_WARP_STREAK_PHASE_SECONDS,
      );
      this.streaks.setScale(convergence);
      this.streaks.setAlpha(
        phase === 'streaks'
          ? BACKGROUND_WARP_STREAK_ALPHA *
              Math.min(1, progress / 0.15) *
              (1 - progress)
          : 0,
      );
    }

    // Distortion: ring grid expands while the background value zooms in.
    const distortionProgress = clamp01(
      (elapsed - BACKGROUND_WARP_DISTORTION_START_SECONDS) /
        BACKGROUND_WARP_DISTORTION_PHASE_SECONDS,
    );
    const distorting = phase === 'distortion';
    if (this.distortion !== null) {
      const ringScale = distorting
        ? BACKGROUND_WARP_DISTORTION_RING_SCALE_FROM +
          (BACKGROUND_WARP_DISTORTION_RING_SCALE_TO -
            BACKGROUND_WARP_DISTORTION_RING_SCALE_FROM) *
            distortionProgress
        : BACKGROUND_WARP_DISTORTION_RING_SCALE_FROM;
      this.distortion.setScale(ringScale);
      this.distortion.setAlpha(
        distorting
          ? BACKGROUND_WARP_DISTORTION_RING_ALPHA * (1 - distortionProgress)
          : 0,
      );
    }
    this.scaleValue =
      this.layers.distortion && distorting
        ? this.planRef.distortion.fromScale +
          (this.planRef.distortion.toScale - this.planRef.distortion.fromScale) *
            distortionProgress
        : BACKGROUND_WARP_DISTORTION_SCALE_FROM;

    // Flash: instant peak at the start of its phase, then a linear fade to zero.
    if (this.flash !== null && phase === 'flash') {
      const flashProgress = clamp01(
        (elapsed - BACKGROUND_WARP_FLASH_START_SECONDS) /
          BACKGROUND_WARP_FLASH_PHASE_SECONDS,
      );
      this.flashValue = this.planRef.flash.peakAlpha * (1 - flashProgress);
      this.flash.setAlpha(this.flashValue);
    } else {
      this.flashValue = 0;
      this.flash?.setAlpha(0);
    }
  }

  /** Destroys the container (and with it every child) exactly once. */
  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.containerRef.destroy();
  }
}

/**
 * Creates the hyperspace warp transition for `scene` and returns its handle.
 *
 * The caller owns the lifecycle: feed it the scene's frame delta through
 * {@link BackgroundWarp.update} (seconds) and read
 * {@link BackgroundWarp.distortionScale} to scale the background layer. The
 * warp tears itself down on completion; {@link BackgroundWarp.destroy} is for
 * an early teardown (scene shutdown/restart mid-warp).
 *
 * Never throws and never uses `Math.random()`; the level pair only seeds the
 * deterministic streak geometry.
 *
 * @param scene - The scene that owns the warp (and its display list).
 * @param options - Level pair plus optional per-layer overrides.
 */
export function createBackgroundWarp(
  scene: Phaser.Scene,
  options: BackgroundWarpOptions,
): BackgroundWarp {
  return new WarpEffect(scene, options);
}

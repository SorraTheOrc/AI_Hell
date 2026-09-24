/**
 * Shared "sucked into the ship" collect animation (AH-0MUBYU600004YU4T).
 *
 * Collection currently destroys a drop's Graphics on the same frame, giving
 * no visual confirmation of the pickup. This module provides the tactile
 * absorb VFX used by every collection path (PlayScene and all gym scenes):
 *
 * - { stepCollectAnimation} — a pure state stepper (no Phaser types) that
 *   moves the drop toward the ship, shrinks its scale toward zero, and
 *   applies a shear/rotation morph over a tunable duration.
 * - { spawnCollectAnimation} — a thin Phaser-facing entry point that creates
 *   a handle (`update(dt)`, `isComplete()`, `destroy()`) and destroys the
 *   drop's Graphics when the animation completes.
 *
 * Mirrors the architecture of `src/powerups/magnet.ts` (pure logic + scene
 * seam) and `src/vfx/explosionParticles.ts` (pure state + thin Phaser entry
 * point). One generic treatment is used for all drop types — no per-type
 * variants.
 *
 * The gameplay effect (registry/lives/weapon updates, bullet clear) must be
 * applied immediately on overlap; this animation is cosmetic only and never
 * gates the applied effect.
 *
 * @module powerups/collectAnimation
 */

// ── Tunable constants (AC2) ────────────────────────────────────────

/** Default animation duration in seconds — short and snappy (≤ 0.3 s). */
export const COLLECT_ANIMATION_DEFAULT_DURATION = 0.25;

/**
 * Exponential attraction rate (1/s) used to pull the drop toward the ship.
 * Higher values converge faster; the duration bounds the visible window.
 */
export const COLLECT_ANIMATION_ATTRACT_SPEED = 14;

/** Maximum horizontal shear/elongation applied at the end of the animation. */
export const COLLECT_ANIMATION_MAX_SHEAR = 0.6;

// ── Pure state (AC1) ───────────────────────────────────────────────

/**
 * Plain-object state for the absorb animation. No Phaser types — the pure
 * stepper only reads/writes numbers and booleans so it is trivially
 * deterministic and unit-testable.
 */
export interface CollectAnimationState {
  /** Current X position (world space). */
  x: number;
  /** Current Y position (world space). */
  y: number;
  /** Initial X position (start of the animation). */
  startX: number;
  /** Initial Y position (start of the animation). */
  startY: number;
  /** Current attractor X (the ship's world position). */
  shipX: number;
  /** Current attractor Y (the ship's world position). */
  shipY: number;
  /** Seconds elapsed since the animation started. */
  elapsed: number;
  /** Total animation duration in seconds. */
  duration: number;
  /** Linear progress in [0, 1]. */
  progress: number;
  /** Scale in [0, 1] — 1 at the start, 0 when fully absorbed. */
  scale: number;
  /** Horizontal elongation in [0, COLLECT_ANIMATION_MAX_SHEAR]. */
  shear: number;
  /** Rotation in radians — orients the elongated drop toward the ship. */
  rotation: number;
  /** True once the animation has run its full duration. */
  complete: boolean;
}

/**
 * Creates the initial absorb-animation state for a drop.
 *
 * @param dropX    — drop's starting X (world space).
 * @param dropY    — drop's starting Y (world space).
 * @param shipX    — ship's X (the attractor).
 * @param shipY    — ship's Y (the attractor).
 * @param duration — animation duration in seconds (default ≤ 0.3 s).
 */
export function createCollectAnimationState(
  dropX: number,
  dropY: number,
  shipX: number,
  shipY: number,
  duration: number = COLLECT_ANIMATION_DEFAULT_DURATION,
): CollectAnimationState {
  return {
    x: dropX,
    y: dropY,
    startX: dropX,
    startY: dropY,
    shipX,
    shipY,
    elapsed: 0,
    duration: duration > 0 ? duration : COLLECT_ANIMATION_DEFAULT_DURATION,
    progress: 0,
    scale: 1,
    shear: 0,
    rotation: Math.atan2(shipY - dropY, shipX - dropX),
    complete: false,
  };
}

/**
 * Advances the absorb animation by `dt` seconds (AC1, AC2, AC4).
 *
 * - Position is pulled toward the ship with an exponential lerp governed by
 *   {@link COLLECT_ANIMATION_ATTRACT_SPEED}, then snapped exactly onto the
 *   ship on completion.
 * - Scale shrinks linearly from 1 toward 0.
 * - Shear grows linearly from 0 to {@link COLLECT_ANIMATION_MAX_SHEAR}.
 * - Rotation tracks the ship direction so the elongated drop reads as being
 *   sucked toward the ship.
 *
 * The stepper mutates and returns `state`. `dt ≤ 0` is a no-op. The result
 * is deterministic for identical inputs.
 *
 * @param state  — the mutable animation state.
 * @param shipX  — current ship X (the attractor may move between frames).
 * @param shipY  — current ship Y.
 * @param dt     — elapsed time in seconds (frame delta).
 */
export function stepCollectAnimation(
  state: CollectAnimationState,
  shipX: number,
  shipY: number,
  dt: number,
): CollectAnimationState {
  // Keep the attractor in sync — the ship can move during the animation.
  state.shipX = shipX;
  state.shipY = shipY;

  if (dt <= 0 || state.complete) return state;

  state.elapsed += dt;
  state.progress = Math.min(1, state.elapsed / state.duration);

  // Exponential attraction toward the ship (frame-rate independent).
  const alpha = 1 - Math.exp(-COLLECT_ANIMATION_ATTRACT_SPEED * dt);
  state.x += (shipX - state.x) * alpha;
  state.y += (shipY - state.y) * alpha;

  // Scale shrinks to zero; shear/morph grows; rotation points at the ship.
  state.scale = 1 - state.progress;
  state.shear = COLLECT_ANIMATION_MAX_SHEAR * state.progress;
  state.rotation = Math.atan2(shipY - state.y, shipX - state.x);
  state.complete = state.progress >= 1;

  // Snap exactly onto the ship on completion for deterministic convergence.
  if (state.complete) {
    state.x = shipX;
    state.y = shipY;
    state.scale = 0;
  }

  return state;
}

// ── Phaser entry point (AC3) ───────────────────────────────────────

/**
 * Minimal structural Graphics surface needed by the entry point. Kept
 * structural (not `Phaser.GameObjects.Graphics`) so unit tests can inject a
 * plain double and the real Phaser Graphics is structurally assignable.
 */
export interface CollectGraphics {
  setPosition(x: number, y: number): void;
  setScale(x: number, y?: number): void;
  setRotation?(radians: number): void;
  destroy(): void;
}

/** Live handle for a spawned absorb animation. */
export interface CollectAnimationHandle {
  /** The pure animation state (for tests/inspection). */
  readonly state: CollectAnimationState;
  /** Advances the animation by `dt` seconds and syncs the Graphics. */
  update(dt: number): void;
  /** Whether the animation has completed (Graphics destroyed). */
  isComplete(): boolean;
  /** Re-points the animation at a moving ship. */
  setAttractor(x: number, y: number): void;
  /** Destroys the Graphics immediately (teardown path); idempotent. */
  destroy(): void;
}

/**
 * Starts the "sucked into the ship" absorb animation on a drop's Graphics.
 *
 * Every frame the scene calls `handle.update(dt)`; on completion the Graphics
 * is destroyed. The ship is the attractor — use `setAttractor` to track its
 * world position each frame.
 *
 * Safe no-op when `graphics` is null/undefined (e.g. a drop whose Graphics
 * was already torn down): the returned handle completes immediately and
 * never throws.
 *
 * @param graphics — the drop's Graphics (nullable for a safe no-op).
 * @param dropX    — drop's starting X (world space).
 * @param dropY    — drop's starting Y (world space).
 * @param shipX    — ship's X (attractor).
 * @param shipY    — ship's Y (attractor).
 * @param duration — animation duration in seconds (default ≤ 0.3 s).
 */
export function spawnCollectAnimation(
  graphics: CollectGraphics | null | undefined,
  dropX: number,
  dropY: number,
  shipX: number,
  shipY: number,
  duration: number = COLLECT_ANIMATION_DEFAULT_DURATION,
): CollectAnimationHandle {
  // Safe no-op: without Graphics there is nothing to animate or destroy.
  if (!graphics) {
    const state = createCollectAnimationState(dropX, dropY, shipX, shipY, duration);
    state.complete = true;
    state.scale = 0;
    return {
      state,
      update: () => { /* nothing to animate */ },
      isComplete: () => true,
      setAttractor: () => { /* nothing to animate */ },
      destroy: () => { /* nothing to destroy */ },
    };
  }

  const state = createCollectAnimationState(dropX, dropY, shipX, shipY, duration);
  let destroyed = false;

  const applyToGraphics = (): void => {
    graphics.setPosition(state.x, state.y);
    graphics.setRotation?.(state.rotation);
    // Elongate horizontally by the shear while the whole drop shrinks.
    graphics.setScale(state.scale * (1 + state.shear), state.scale);
  };

  const handle: CollectAnimationHandle = {
    state,
    update(dt: number): void {
      if (destroyed || state.complete) return;
      stepCollectAnimation(state, state.shipX, state.shipY, dt);
      applyToGraphics();
      if (state.complete && !destroyed) {
        destroyed = true;
        graphics.destroy();
      }
    },
    isComplete: () => state.complete,
    setAttractor(x: number, y: number): void {
      state.shipX = x;
      state.shipY = y;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      state.complete = true;
      graphics.destroy();
    },
  };

  return handle;
}

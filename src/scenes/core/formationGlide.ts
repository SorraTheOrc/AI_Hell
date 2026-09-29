/**
 * Shared formation glide helper (AH-0MUL15N63003PUDB).
 *
 * When a Diver's attack ends and the unit re-anchors, every enemy must ease
 * from its current position to its new formation slot rather than snapping
 * (GDD §4.1 E2). This module provides a scene-agnostic glide manager that:
 *
 * - Captures each entity's current position when the re-anchor triggers.
 * - Each frame, after `applyFormationPosition` sets the live target, overrides
 *   the display position with `target + residual * easingFactor` so the entity
 *   eases smoothly from the old to the new slot.
 * - The live target is re-evaluated every frame (drift is tracked), so the
 *   unit keeps drifting and lands on the current slot, not a stale snapshot.
 *
 * Pure and side-effect free outside the state map — fully unit-testable.
 * Consumed by both `GymFormationScene` and `PlayScene` for gym↔game parity
 * (duplicate-body guard: this is a single helper, no duplicated scene code).
 */

/**
 * Duration in seconds of the formation glide. Tunable in one place
 * (AH-0MUL15N63003PUDB — "Use the existing `DIVER_*` constants or a small
 * new named constant for the glide duration; keep it tunable in one place").
 */
export const FORMATION_GLIDE_SECONDS = 0.32;

/** Smooth easing: 0 → 0, 1 → 1, smooth start and end. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * A minimal position-capable object that the glide helper manipulates.
 * Used by both the gym scene (real entities) and the test stubs.
 */
export interface GlideTarget {
  x: number;
  y: number;
  /** Sets the display position (Phaser Game Object or Container). */
  setPosition(x: number, y: number): void;
}

/** Internal state for one entity's glide. */
interface GlideState {
  /** Position at the moment the glide began. */
  fromX: number;
  fromY: number;
  /** Live target position captured on the first update frame (after positioning). */
  target0X: number | null;
  target0Y: number | null;
  /** Elapsed time in the glide. */
  elapsed: number;
}

/**
 * A shared glide manager for formation re-anchors.
 *
 * Usage pattern (in the scene's entity positioning loop):
 * ```
 * if (reanchorApplied) {
 *   glide.begin(entities);
 * }
 * for (entity of entities) {
 *   entity.applyFormationPosition(baseX, baseY, dt, spacingX, spacingY);
 * }
 * glide.update(dt);
 * ```
 */
export class FormationGlide {
  private readonly states = new Map<GlideTarget, GlideState>();

  /**
   * Capture the current position of every entity as the glide "from" point.
   * Call immediately after a re-anchor is applied and before the positioning
   * pass runs. Entities whose `applyFormationPosition` is a no-op (asteroids,
   * harvesters) will have a zero residual and remain stationary — safe.
   */
  begin(targets: Iterable<GlideTarget>): void {
    for (const target of targets) {
      this.states.set(target, {
        fromX: target.x,
        fromY: target.y,
        target0X: null,
        target0Y: null,
        elapsed: 0,
      });
    }
  }

  /**
   * Advance all active glides by `dt`, applied after the positioning pass.
   * For each tracked entity, the live target is read from `entity.x/y`
   * (already set by `applyFormationPosition`). On the first frame,
   * `target0` is captured and the entity is displayed at the from position
   * (fully eased residual). On subsequent frames the residual decays via
   * smoothstep, so the entity glides smoothly and tracks the live (drifting)
   * slot. When elapsed ≥ FORMATION_GLIDE_SECONDS the glide is complete and
   * the entity is left at the exact live target (residual = 0).
   */
  update(dt: number): void {
    const toRemove: GlideTarget[] = [];

    for (const [target, state] of this.states) {
      state.elapsed += dt;

      // Capture the live target on the first update frame.
      if (state.target0X === null) {
        state.target0X = target.x;
        state.target0Y = target.y;
      }

      // If the glide is complete, leave the entity at the live target.
      if (state.elapsed >= FORMATION_GLIDE_SECONDS) {
        toRemove.push(target);
        continue;
      }

      const progress = smoothstep(state.elapsed / FORMATION_GLIDE_SECONDS);
      const residualFactor = 1 - progress;
      const residualX = (state.fromX - (state.target0X ?? target.x)) * residualFactor;
      const residualY = (state.fromY - (state.target0Y ?? target.y)) * residualFactor;
      target.setPosition(target.x + residualX, target.y + residualY);
    }

    // Remove completed glides (after iteration to avoid mutation during).
    for (const target of toRemove) {
      this.states.delete(target);
    }
  }

  /** Whether any glide is currently active. */
  get active(): boolean {
    return this.states.size > 0;
  }

  /** Clear all glide state (e.g. on scene shutdown). */
  clear(): void {
    this.states.clear();
  }
}

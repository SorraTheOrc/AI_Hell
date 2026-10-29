/**
 * Shared Diver formation re-anchor + glide seam (docs/GYM_PARITY.md D2).
 *
 * A Diver's dive attack ends wherever the entity finishes, and the whole Diver
 * group must re-base so the requester's formation slot lands on that point;
 * the Divers then glide to their new slots instead of snapping (GDD §4.1 E2,
 * AH-0MUL15N63003PUDB). The rule used to be implemented scene-side in
 * `PlayScene` and `GymFormationScene` and was **missing entirely** from
 * `GymLevel`, so a Diver in a launched level returned to a stale base.
 *
 * This module owns the rule once:
 *
 * - {@link consumeFormationReanchor} — consume the pending re-anchor requests
 *   from a set of candidates (most recent wins when Divers are desynchronised),
 *   resolve the anchor delta through the shared pure
 *   `computeFormationReanchorDelta`, and report it.
 * - {@link FormationReanchorController} — the long-lived per-scene state: the
 *   Diver-only anchor offset plus the {@link FormationGlide} that eases the
 *   Divers from their old to their new slot. `consumed by PlayScene,
 *   GymFormationScene and GymLevel, so the three scenes cannot drift.
 *
 * The positioning pass itself stays scene-side: it is already built on the
 * shared `applyFormationPosition` seam and the scenes intentionally differ in
 * how they select marching / roaming / hazard entities. What is shared here is
 * exactly the re-anchor + glide rule that had diverged.
 *
 * @module scenes/core/formationReanchor
 */

import {
  computeFormationReanchorDelta,
  type FormationReanchorRequest,
} from '../../utils/formations';
import { FormationGlide, type GlideTarget } from './formationGlide';

/** The optional entity seam a re-anchor-capable enemy (the Diver) exposes. */
export interface FormationReanchorSeam {
  consumeFormationReanchor?(): FormationReanchorRequest | null;
}

/**
 * One candidate for re-anchoring: the entity plus the formation origin its
 * slot is currently positioned from (drift/march base, without the Diver
 * anchor) and that formation's spacing.
 */
export interface FormationReanchorCandidate {
  entity: FormationReanchorSeam & GlideTarget;
  /** Formation origin x the entity's slot is computed from (px). */
  originX: number;
  /** Formation origin y the entity's slot is computed from (px). */
  originY: number;
  spacingX: number;
  spacingY: number;
}

/** The translation a re-anchor applies to the Diver-group origin. */
export interface FormationReanchorDelta {
  dx: number;
  dy: number;
}

/**
 * Consumes every pending re-anchor request among `candidates` and resolves the
 * anchor translation for the most recent one (the documented
 * desynchronised-Diver assumption carried over from the original scenes).
 *
 * Consuming is intentional: an entity's request is single-use, so the caller
 * must invoke this exactly once per frame, before the positioning pass.
 *
 * @param candidates — live, re-anchor-capable candidates (the caller filters).
 * @param anchorX — the current Diver-only anchor offset x (px).
 * @param anchorY — the current Diver-only anchor offset y (px).
 * @returns the delta to add to the anchor, or `null` when nothing requested.
 */
export function consumeFormationReanchor(
  candidates: readonly FormationReanchorCandidate[],
  anchorX: number,
  anchorY: number,
): FormationReanchorDelta | null {
  let latest: {
    request: FormationReanchorRequest;
    candidate: FormationReanchorCandidate;
  } | null = null;

  for (const candidate of candidates) {
    const request = candidate.entity.consumeFormationReanchor?.();
    if (request) latest = { request, candidate };
  }
  if (!latest) return null;

  const { request, candidate } = latest;
  return computeFormationReanchorDelta(
    request,
    candidate.originX + anchorX,
    candidate.originY + anchorY,
    candidate.spacingX,
    candidate.spacingY,
  );
}

/**
 * Per-scene Diver re-anchor state: the anchor offset plus the glide that eases
 * the Divers to their new slots. One instance per scene, reset with the run.
 */
export class FormationReanchorController {
  private readonly glide = new FormationGlide();
  private _anchorX = 0;
  private _anchorY = 0;

  /** Current Diver-only anchor offset x (px). */
  get anchorX(): number {
    return this._anchorX;
  }

  /** Current Diver-only anchor offset y (px). */
  get anchorY(): number {
    return this._anchorY;
  }

  /** Whether a glide is currently easing Divers to their new slots. */
  get isGliding(): boolean {
    return this.glide.active;
  }

  /** Number of entities tracked by the active glide (test seam). */
  get glideTargetCount(): number {
    return this.glide.active ? this.glideStates.size : 0;
  }

  /** Test seam exposing the glide's internal state map size. */
  get glideStates(): Map<GlideTarget, unknown> {
    return (this.glide as unknown as {
      states: Map<GlideTarget, unknown>;
    }).states;
  }

  /** Clears the anchor and any active glide (run reset / fresh base). */
  reset(): void {
    this._anchorX = 0;
    this._anchorY = 0;
    this.glide.clear();
  }

  /** Drops any active glide but keeps the current anchor offset. */
  clearGlide(): void {
    this.glide.clear();
  }

  /**
   * Consumes pending requests, applies the resulting anchor delta and begins
   * the glide for every re-anchor-capable candidate.
   *
   * @returns `true` when a re-anchor was applied, `false` otherwise.
   */
  apply(candidates: readonly FormationReanchorCandidate[]): boolean {
    const delta = consumeFormationReanchor(
      candidates,
      this._anchorX,
      this._anchorY,
    );
    if (!delta) return false;

    this._anchorX += delta.dx;
    this._anchorY += delta.dy;

    // Only the re-anchor-capable (Diver) entities glide to their new slots;
    // every other enemy did not move, so it is not tracked.
    this.glide.begin(
      candidates
        .filter((candidate) => candidate.entity.consumeFormationReanchor != null)
        .map((candidate) => candidate.entity),
    );
    return true;
  }

  /**
   * Advances an active glide after the positioning pass set each entity's live
   * target for the frame. A no-op when nothing is gliding.
   *
   * @param dt — frame delta in seconds.
   * @param justApplied — whether a re-anchor was applied this frame.
   */
  afterPositioning(dt: number, justApplied: boolean): void {
    if (justApplied || this.glide.active) this.glide.update(dt);
  }
}

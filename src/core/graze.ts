/**
 * Graze band and danger multiplier (AH-0MWL7ORK8007LXJI, GDD §4.5).
 *
 * Dodging used to be unpaid: score was a flat per-kill sum plus a per-level
 * time bonus, so a skilful player threading a bullet pattern and a cautious
 * player at the back of the screen were separated only by survival time. This
 * module is the one pure rule that makes near misses worth points:
 *
 * 1. **Graze band** — a live hostile passes within
 *    `contactRadius + grazeBand` of the ship's collision centre, but outside
 *    the contact distance that would be a hit.
 * 2. **Once per pass** — each hostile is credited once, keyed by a stable
 *    per-object id, and is only re-creditable after it leaves the band by
 *    more than {@link GRAZE_HYSTERESIS}, is destroyed or expires.
 * 3. **Danger multiplier** — grazes build a five-tier multiplier
 *    (`×1 → ×1.5 → ×2 → ×3 → ×5`) that kill score is multiplied by; it
 *    decays one tier per {@link GRAZE_DECAY_SECONDS} of inactivity and resets
 *    on a player hit.
 *
 * The module is Phaser-free, allocation-free on the hot path and consumes no
 * RNG, so the same seed and input trace always produce the same graze count
 * and score. `CombatCoreScene` owns one {@link GrazeTracker} per run and
 * `CombatScene` feeds it from the shared collision pipeline, so the game and
 * every gym resolve identical values (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * Score-only: grazes never touch damage, movement, lives or drops, so no
 * balance baseline moves (AC8).
 *
 * @module core/graze
 */

/**
 * Width (px) of the graze band beyond the contact distance — a hostile whose
 * centre is inside `contactRadius + GRAZE_BAND` but outside `contactRadius`
 * is a near miss. Tunable in one place (AC1).
 */
export const GRAZE_BAND = 12;

/**
 * Hysteresis (px) a credited hostile must leave the band by before it becomes
 * creditable again, so a hostile hovering at the band edge cannot farm score
 * (AC2).
 */
export const GRAZE_HYSTERESIS = 4;

/** Multiplier progress one graze contributes (AC3). */
export const GRAZE_TIER_PROGRESS = 1;

/**
 * Seconds of inactivity before the multiplier loses one tier (AC4). Refreshed
 * by every graze.
 */
export const GRAZE_DECAY_SECONDS = 2;

/**
 * The five multiplier tiers, lowest first: `×1 → ×1.5 → ×2 → ×3 → ×5`
 * (AC3). The multiplier is the only thing that changes kill score.
 */
export const GRAZE_TIERS: readonly number[] = [1, 1.5, 2, 3, 5];

/**
 * Cumulative graze progress required to *enter* each tier, aligned with
 * {@link GRAZE_TIERS}. Tier 0 is the run-start state; the top tier (`×5`)
 * is reached at 15 grazes. Designer-owned (the tunables record is the only
 * place the feel lives).
 */
export const GRAZE_TIER_THRESHOLDS: readonly number[] = [0, 3, 6, 10, 15];

/** Explicit tunables record for the whole rule (AC1). */
export interface GrazeTunables {
  /** Band width beyond the contact distance (px). */
  readonly grazeBand: number;
  /** Distance (px) a credited hostile must leave the band by to re-credit. */
  readonly hysteresis: number;
  /** Multiplier progress added by one graze. */
  readonly tierProgress: number;
  /**
   * The multiplier per tier, lowest first (same length as
   * {@link tierThresholds}).
   */
  readonly tiers: readonly number[];
  /** Cumulative progress at which each tier is entered. */
  readonly tierThresholds: readonly number[];
  /** Seconds of inactivity before one tier decays. */
  readonly decaySeconds: number;
}

/** One credited hostile's bookkeeping. */
interface CreditedHostile {
  /** Distance observed at the last pass (diagnostic / test seam). */
  distance: number;
  /** The observation pass that last saw this hostile alive. */
  pass: number;
}

/** The shipped tunables — retune the feel here, never in a scene. */
export const DEFAULT_GRAZE_TUNABLES: GrazeTunables = {
  grazeBand: GRAZE_BAND,
  hysteresis: GRAZE_HYSTERESIS,
  tierProgress: GRAZE_TIER_PROGRESS,
  tiers: GRAZE_TIERS,
  tierThresholds: GRAZE_TIER_THRESHOLDS,
  decaySeconds: GRAZE_DECAY_SECONDS,
};

/**
 * Where a hostile sits relative to the ship:
 * - `hit` — inside the contact distance (the collision pipeline's own test);
 * - `graze` — outside the contact distance but inside the graze band;
 * - `clear` — outside both.
 */
export type GrazeZone = 'hit' | 'graze' | 'clear';

/** The graze band's outer edge (px) for a given contact distance. */
export function grazeRadiusFor(
  contactRadius: number,
  tunables: GrazeTunables = DEFAULT_GRAZE_TUNABLES,
): number {
  return contactRadius + tunables.grazeBand;
}

/**
 * Resolves which zone a centre-to-centre distance falls in. Judged on the
 * shared collision centre and radii (never sprite bounds), so a graze is
 * exactly the band between "would hit" and "near miss" (AC2).
 */
export function resolveGrazeZone(
  distance: number,
  contactRadius: number,
  tunables: GrazeTunables = DEFAULT_GRAZE_TUNABLES,
): GrazeZone {
  if (distance <= contactRadius) return 'hit';
  if (distance <= grazeRadiusFor(contactRadius, tunables)) return 'graze';
  return 'clear';
}

/**
 * The point on the hostile's collision circle nearest the ship — the anchor
 * for the graze spark arc, so the cue always reads at the closest approach
 * (AC5). Degenerate (concentric) input returns the hostile's own centre.
 */
export function nearestGrazePoint(
  playerX: number,
  playerY: number,
  x: number,
  y: number,
  radius: number,
): { x: number; y: number } {
  const dx = x - playerX;
  const dy = y - playerY;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x, y };
  return {
    x: x - (dx / distance) * radius,
    y: y - (dy / distance) * radius,
  };
}

/**
 * Applies the danger multiplier to a score award, rounded half up
 * (`3 × 1.5 = 4.5 → 5`). Non-positive and non-finite awards pass through
 * unchanged, so an unawarded kill stays 0 (AC3).
 */
export function applyGrazeMultiplier(base: number, multiplier: number): number {
  if (!Number.isFinite(base) || base <= 0) return base > 0 ? base : 0;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return base;
  return Math.floor(base * multiplier + 0.5);
}

/**
 * The whole graze rule as one run-scoped state machine.
 *
 * The scene feeds it one `observe()` per live hostile per frame, one
 * `update(dt)` per frame (decay), `onPlayerHit()` when the ship is hit and
 * `reset()` at run start. It owns no display objects, no audio and no RNG.
 */
export class GrazeTracker {
  /** The tunables this tracker resolves with. */
  readonly tunables: GrazeTunables;

  /** Grazes credited this run (AC7 determinism reads this). */
  private _grazeCount = 0;
  /** Cumulative tier progress (clamped to the top threshold). */
  private _progress = 0;
  /** Current tier index into `tunables.tiers`. */
  private _tierIndex = 0;
  /** Seconds accumulated since the last graze at the current tier. */
  private _decayElapsed = 0;
  /**
   * Hostiles currently credited — keyed by the scene's stable per-object id.
   * Only hostiles that have entered the band are tracked, so a wide-open
   * screen allocates nothing. `pass` records the last observation pass that
   * saw the hostile, so {@link endPass} can drop the records of hostiles that
   * are gone (destroyed, expired or removed) without the scene enumerating
   * every destruction site.
   */
  private _credited = new Map<number, CreditedHostile>();

  /** Monotonic observation-pass counter (see {@link beginPass}). */
  private _pass = 0;

  constructor(tunables: Partial<GrazeTunables> = {}) {
    this.tunables = { ...DEFAULT_GRAZE_TUNABLES, ...tunables };
  }

  /** Grazes credited this run. */
  get grazeCount(): number {
    return this._grazeCount;
  }

  /** Current tier index (0 = `×1`). */
  get tierIndex(): number {
    return this._tierIndex;
  }

  /** Current danger multiplier (`tunables.tiers[tierIndex]`). */
  get multiplier(): number {
    return this.tunables.tiers[this._tierIndex] ?? 1;
  }

  /** Cumulative tier progress, clamped to the top tier's threshold. */
  get progress(): number {
    return this._progress;
  }

  /** Hostiles currently credited (one record per hostile in the band). */
  get creditedCount(): number {
    return this._credited.size;
  }

  /**
   * Fraction of the current tier's decay window still remaining, `1 → 0`
   * (0 at `×1`, which cannot decay). The HUD tacho drains by this.
   */
  get decayFraction(): number {
    if (this._tierIndex === 0) return 0;
    const window = this.tunables.decaySeconds;
    if (!(window > 0)) return 0;
    return Math.max(0, Math.min(1, 1 - this._decayElapsed / window));
  }

  /**
   * Opens an observation pass. The scene calls this once per frame before
   * feeding every live hostile to {@link observe} and {@link endPass} after —
   * so a credited hostile that no longer exists (destroyed, expired, removed
   * from the field) is dropped without the scene having to enumerate every
   * destruction site (AC2).
   */
  beginPass(): void {
    this._pass += 1;
  }

  /**
   * Closes the current observation pass, dropping the credit records of any
   * hostile not observed in it — the object is gone, so its credit must clear.
   */
  endPass(): void {
    if (this._credited.size === 0) return;
    for (const [id, record] of this._credited) {
      if (record.pass !== this._pass) this._credited.delete(id);
    }
  }

  /**
   * Observes one live hostile for one frame.
   *
   * @param objectId — the scene's stable per-object id (never reused while
   *   the hostile lives).
   * @param distance — centre-to-centre distance from the ship.
   * @param contactRadius — the contact distance that would be a hit (the
   *   same radius the collision pass tests).
   * @returns `true` when this observation credited a graze.
   */
  observe(objectId: number, distance: number, contactRadius: number): boolean {
    const bandEdge = grazeRadiusFor(contactRadius, this.tunables);
    const releaseEdge = bandEdge + this.tunables.hysteresis;

    if (distance <= contactRadius) {
      // Inside the hit radius: the pass ended in contact, not a near miss, so
      // the credit record is dropped (it cannot farm on the way out).
      this._credited.delete(objectId);
      return false;
    }

    const credited = this._credited.get(objectId);
    if (credited !== undefined) {
      // Already paid for this pass: stays paid until it clears the band by
      // more than the hysteresis margin (AC2).
      if (distance > releaseEdge) {
        this._credited.delete(objectId);
        return false;
      }
      credited.distance = distance;
      credited.pass = this._pass;
      return false;
    }

    if (distance > bandEdge) return false;

    // A fresh entry into the band — credit it once, add tier progress and
    // restart the decay window (AC2/AC3).
    this._credited.set(objectId, { distance, pass: this._pass });
    this._grazeCount += 1;
    this._addProgress(this.tunables.tierProgress);
    this._decayElapsed = 0;
    return true;
  }

  /**
   * Drops an object's credit record because it is gone (destroyed, expired or
   * removed from the field). Called by the scene at the same seam that
   * destroys the object, so a reused id can never inherit a stale credit
   * (AC2).
   */
  forget(objectId: number): void {
    this._credited.delete(objectId);
  }

  /**
   * Advances the decay clock by `dtSeconds`. Inactivity loses one tier per
   * `decaySeconds`; each loss snaps progress down to that tier's threshold so
   * a decayed tier cannot instantly re-promote (AC4). Never goes below `×1`.
   */
  update(dtSeconds: number): void {
    if (this._tierIndex === 0) {
      this._decayElapsed = 0;
      return;
    }
    if (!(dtSeconds > 0)) return;
    this._decayElapsed += dtSeconds;
    const window = this.tunables.decaySeconds;
    if (!(window > 0)) {
      this._progress = 0;
      this._tierIndex = 0;
      this._decayElapsed = 0;
      return;
    }
    while (this._decayElapsed >= window && this._tierIndex > 0) {
      this._decayElapsed -= window;
      this._tierIndex -= 1;
      this._progress = this.tunables.tierThresholds[this._tierIndex] ?? 0;
      if (this._tierIndex === 0) {
        this._decayElapsed = 0;
        break;
      }
    }
  }

  /**
   * A player hit ends the chain: the multiplier resets to `×1` (AC4). The
   * per-object credit records are deliberately kept — the hostiles in the
   * band did not change, so they must not pay twice for the same pass.
   */
  onPlayerHit(): void {
    this._progress = 0;
    this._tierIndex = 0;
    this._decayElapsed = 0;
  }

  /** Resets the run: chain, counters and every credit record (AC4/AC7). */
  reset(): void {
    this._grazeCount = 0;
    this._progress = 0;
    this._tierIndex = 0;
    this._decayElapsed = 0;
    this._credited.clear();
    this._pass = 0;
  }

  /** Applies the current multiplier to a score award (AC3). */
  applyScore(base: number): number {
    return applyGrazeMultiplier(base, this.multiplier);
  }

  /** Adds tier progress and re-resolves the tier (clamped at the top). */
  private _addProgress(amount: number): void {
    if (!(amount > 0)) return;
    const top = this.tunables.tierThresholds.length - 1;
    const ceiling = this.tunables.tierThresholds[top] ?? 0;
    this._progress = Math.min(ceiling, this._progress + amount);
    this._tierIndex = this._tierIndexFor(this._progress);
  }

  /** The highest tier whose threshold the progress has reached. */
  private _tierIndexFor(progress: number): number {
    let index = 0;
    const thresholds = this.tunables.tierThresholds;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (progress >= thresholds[i]) index = i;
    }
    return Math.min(index, this.tunables.tiers.length - 1);
  }
}

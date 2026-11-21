/**
 * Bot-side hazard-motion estimation.
 *
 * Original single-difference tracker: AH-0MVI4QDN90037DIN · AC1. Second-order
 * (velocity **and curvature**) fit: AH-0MWM0C7ZR001YJRE · AC1/AC2/AC3/AC4/AC5.
 *
 * The snapshot seam deliberately exposes no per-archetype entity velocity for
 * formation enemies (only physics-body entities such as asteroids and lane
 * traffic carry one, and that feeds the aim-lead consumer). Predictive hazard
 * avoidance instead derives motion **bot-side**: each decision tick the
 * tracker records every live hazard's position in {@link BotMemory} and fits
 * its motion from the recent-position window.
 *
 * ## The fit
 *
 * A single position delta can only represent a straight line, so the motion
 * model keeps a **fixed-capacity ring** of a hazard's most recent positions in
 * `BotMemory` and fits a second-order estimate from it:
 *
 * - **velocity** — the last position delta divided by `dt` (a straight-line
 *   hazard's estimate, unchanged from the original tracker);
 * - **curvature** — the signed turn rate (rad/s) between the two trailing
 *   deltas, i.e. `atan2(v_prev × v_now, v_prev · v_now) / dt`. It is exactly
 *   `0` for a straight-line hazard (the cross product is zero) and for a
 *   stationary one.
 *
 * The ring holds three samples (two consecutive deltas — the minimum a
 * second-order fit needs) and is reused in place, so the window is bounded per
 * hazard and a steady-state tick allocates nothing.
 *
 * ## Properties
 *
 * - **Deterministic and wall-clock free.** The estimate advances only on the
 *   injected snapshot sequence and `dt`; no `Math.random()` / `Date.now()`.
 *   It is reset with the brain (`resetBotMemory`) so a run replays
 *   bit-for-bit.
 * - **Clamped.** Spurious jumps (wrap-around, respawn, a teleport) would
 *   otherwise imply an absurd velocity or turn rate, so the velocity is
 *   clamped to {@link HAZARD_MAX_ESTIMATED_SPEED} and the curvature to
 *   {@link HAZARD_MAX_CURVATURE}; a jump that trips the velocity clamp yields
 *   zero curvature (a teleport has no meaningful turn rate).
 * - **Cold-start safe.** A hazard seen for the first time — or one whose
 *   window was reset by a missed tick — has no velocity/curvature yet and is
 *   treated as stationary, exactly today's positional behaviour.
 * - **Backwards compatible.** With `motionModelEnabled` off the tracker runs
 *   today's single-difference path verbatim (no history ring, curvature
 *   always `0`), so the disabled estimate is bit-for-bit identical to the
 *   pre-change output.
 * - **Bounded.** A hazard missing from a tick keeps its last estimate until it
 *   is re-seen; entries unseen for longer than
 *   {@link HAZARD_VELOCITY_STALE_TICKS} are dropped (history ring included), so
 *   memory neither grows without bound nor leaks a despawned hazard.
 *
 * @module src/ai/framework/hazardVelocity
 */

import type { BotSnapshot } from '../botSnapshot';
import type {
  BotMemory,
  HazardHistoryRing,
  HazardMotionVector,
  HazardVelocityEstimate,
} from './memory';
import { wrappedAxisDelta } from '../../utils/wrapGeometry';

/**
 * Upper bound (px/s) on an estimated hazard velocity. The fastest shipped
 * hazards move an order of magnitude below this, so the clamp only ever
 * catches nonsensical deltas (wrap/respawn/teleport).
 */
export const HAZARD_MAX_ESTIMATED_SPEED = 900;

/**
 * Upper bound (rad/s) on a fitted turn rate (≈344°/s). Shipped hazards turn a
 * small fraction of this; the clamp only catches a wrap/respawn jump that
 * survives the velocity clamp.
 */
export const HAZARD_MAX_CURVATURE = 6;

/**
 * Samples kept in each hazard's position-history ring. Three is the minimum a
 * second-order fit needs (two consecutive deltas), and keeping the window
 * minimal keeps the per-hazard footprint bounded and the fit cheap
 * (AH-0MWM0C7ZR001YJRE · AC4).
 */
export const HAZARD_HISTORY_CAPACITY = 3;

/**
 * Decision ticks an unseen hazard's estimate is retained before it is pruned.
 * One missed tick is common (a hazard briefly filtered out), so the estimate
 * survives short gaps but a despawned hazard cannot leak memory forever.
 */
export const HAZARD_VELOCITY_STALE_TICKS = 30;

/** Tracker key for the (singleton) boss hazard. */
export const BOSS_HAZARD_KEY = 'boss';

/** Tracker key for a live enemy/asteroid with the given stable bot-side id. */
export function enemyHazardKey(id: number): string {
  return `enemy:${id}`;
}

/** Optional tracker behaviour (AH-0MWM0C7ZR001YJRE). */
export interface HazardTrackerOptions {
  /**
   * Whether the tracker fits curvature from the bounded position history
   * (the second-order motion model, the hybrid default). `false` runs today's
   * single-difference path verbatim, so the output is bit-identical to the
   * pre-change tracker (the sweep's control arm).
   *
   * @default true
   */
  readonly motionModelEnabled?: boolean;
}

/** Lazily creates (once) the hazard's fixed-capacity history ring. */
function ensureHistory(estimate: HazardVelocityEstimate): HazardHistoryRing {
  const existing = estimate.history;
  if (existing) return existing;
  const created: HazardHistoryRing = {
    x: new Float64Array(HAZARD_HISTORY_CAPACITY),
    y: new Float64Array(HAZARD_HISTORY_CAPACITY),
    count: 0,
    head: 0,
  };
  estimate.history = created;
  return created;
}

/**
 * Appends one sample to a full-or-partial ring, overwriting the oldest sample
 * once the window is full. Never allocates: the arrays are fixed-capacity and
 * only the sample counter/index move.
 */
function pushSample(
  ring: HazardHistoryRing,
  x: number,
  y: number,
): void {
  const capacity = ring.x.length;
  if (ring.count < capacity) {
    ring.x[ring.count] = x;
    ring.y[ring.count] = y;
    ring.count += 1;
    return;
  }
  ring.x[ring.head] = x;
  ring.y[ring.head] = y;
  ring.head = (ring.head + 1) % capacity;
}

/** Ring index of the sample `offset` places after the oldest (`offset < count`). */
function ringIndex(ring: HazardHistoryRing, offset: number): number {
  return (ring.head + offset) % ring.x.length;
}

/**
 * Advances the hazard-motion tracker for one decision tick and returns the
 * current estimate for every tracked hazard, keyed by
 * {@link enemyHazardKey}/{@link BOSS_HAZARD_KEY}.
 *
 * The returned velocities (and fitted turn rates) are the estimates the world
 * model carries onto `BotWorld.hazards`, so steering can predict where a
 * moving hazard will be.
 *
 * @param memory — the run's memory; its `hazardVelocities` map is updated.
 * @param snapshot — the read-only game state for this tick.
 * @param dt — injected seconds since the previous decision tick.
 * @param world — optional torus; when supplied the position delta is wrapped
 *   per axis, so a hazard that legitimately crosses a seam yields its true
 *   velocity instead of a seam-sized jump that the clamp would floor
 *   (AH-0MVT2W2D9002BOHO). Respawns/teleports are still clamped.
 * @param options — optional tracker behaviour; omit for the second-order
 *   motion model (the hybrid default). `motionModelEnabled: false` reproduces
 *   the pre-change single-difference estimate bit-for-bit
 *   (AH-0MWM0C7ZR001YJRE · AC2).
 */
export function trackHazardVelocities(
  memory: BotMemory,
  snapshot: BotSnapshot,
  dt: number,
  world?: { readonly width: number; readonly height: number },
  options?: HazardTrackerOptions,
): ReadonlyMap<string, HazardMotionVector> {
  const motionModelEnabled = options?.motionModelEnabled ?? true;
  const tick = memory.ticks;
  // Reuse the tracker's Set/Map across ticks instead of allocating fresh ones
  // every decision tick (AH-0MWGUN4P2003003P). Created lazily, reset with the
  // brain.
  const scratch =
    memory.hazardTracking ??
    (memory.hazardTracking = { seen: new Set<string>(), view: new Map() });
  const seen = scratch.seen;
  seen.clear();

  const record = (key: string, x: number, y: number): void => {
    seen.add(key);
    const previous = memory.hazardVelocities[key];
    if (!previous) {
      // Cold start: no movement history yet, so the hazard is stationary.
      const estimate: HazardVelocityEstimate = {
        tick,
        x,
        y,
        vx: 0,
        vy: 0,
        curvature: 0,
      };
      if (motionModelEnabled) {
        pushSample(ensureHistory(estimate), x, y);
      }
      memory.hazardVelocities[key] = estimate;
      return;
    }
    // Only consecutive ticks give a meaningful delta; after a gap keep the
    // last estimate rather than dividing a multi-tick displacement by one dt.
    const consecutive = previous.tick === tick - 1;
    const usable = consecutive && Number.isFinite(dt) && dt > 0;
    if (!motionModelEnabled) {
      // Today's single-difference path, verbatim (AH-0MWM0C7ZR001YJRE · AC2):
      // no history ring, curvature always zero.
      let vx = previous.vx;
      let vy = previous.vy;
      if (usable) {
        const dx = world
          ? wrappedAxisDelta(previous.x, x, world.width)
          : x - previous.x;
        const dy = world
          ? wrappedAxisDelta(previous.y, y, world.height)
          : y - previous.y;
        vx = dx / dt;
        vy = dy / dt;
        const speed = Math.hypot(vx, vy);
        if (speed > HAZARD_MAX_ESTIMATED_SPEED) {
          const scale = HAZARD_MAX_ESTIMATED_SPEED / speed;
          vx *= scale;
          vy *= scale;
        }
      }
      previous.tick = tick;
      previous.x = x;
      previous.y = y;
      previous.vx = vx;
      previous.vy = vy;
      previous.curvature = 0;
      return;
    }
    if (!usable) {
      // Gap (or an unusable dt): keep the last estimate, drop the curvature
      // (the window no longer spans consecutive ticks) and restart the window
      // at this sample so it can refill deterministically.
      const ring = ensureHistory(previous);
      ring.count = 0;
      ring.head = 0;
      pushSample(ring, x, y);
      previous.tick = tick;
      previous.x = x;
      previous.y = y;
      previous.curvature = 0;
      return;
    }

    const dx = world
      ? wrappedAxisDelta(previous.x, x, world.width)
      : x - previous.x;
    const dy = world
      ? wrappedAxisDelta(previous.y, y, world.height)
      : y - previous.y;
    let vx = dx / dt;
    let vy = dy / dt;
    let curvature = 0;

    const ring = ensureHistory(previous);
    pushSample(ring, x, y);
    if (ring.count >= 3) {
      // The two trailing deltas give the turn rate. `vPrev` is the delta the
      // ring held one tick ago; `vNow` is this tick's raw (pre-clamp) delta.
      const i0 = ringIndex(ring, ring.count - 3);
      const i1 = ringIndex(ring, ring.count - 2);
      const pdx = world
        ? wrappedAxisDelta(ring.x[i0], ring.x[i1], world.width)
        : ring.x[i1] - ring.x[i0];
      const pdy = world
        ? wrappedAxisDelta(ring.y[i0], ring.y[i1], world.height)
        : ring.y[i1] - ring.y[i0];
      const pvx = pdx / dt;
      const pvy = pdy / dt;
      if (
        Math.hypot(pvx, pvy) <= HAZARD_MAX_ESTIMATED_SPEED &&
        Math.hypot(vx, vy) <= HAZARD_MAX_ESTIMATED_SPEED
      ) {
        // Signed angle between the consecutive velocity vectors, per second.
        const cross = pvx * vy - pvy * vx;
        const dot = pvx * vx + pvy * vy;
        const angle = Math.atan2(cross, dot);
        if (Number.isFinite(angle)) {
          curvature = angle / dt;
          if (curvature > HAZARD_MAX_CURVATURE) {
            curvature = HAZARD_MAX_CURVATURE;
          } else if (curvature < -HAZARD_MAX_CURVATURE) {
            curvature = -HAZARD_MAX_CURVATURE;
          }
        }
      }
    }

    const speed = Math.hypot(vx, vy);
    if (speed > HAZARD_MAX_ESTIMATED_SPEED) {
      const scale = HAZARD_MAX_ESTIMATED_SPEED / speed;
      vx *= scale;
      vy *= scale;
    }
    // Mutate the existing estimate in place: a steady-state tick allocates no
    // per-hazard object (AH-0MWGUN4P2003003P). Values are identical.
    previous.tick = tick;
    previous.x = x;
    previous.y = y;
    previous.vx = vx;
    previous.vy = vy;
    previous.curvature = curvature;
  };

  for (const enemy of snapshot.enemies) {
    if (!enemy.alive || typeof enemy.id !== 'number') continue;
    record(enemyHazardKey(enemy.id), enemy.x, enemy.y);
  }
  const boss = snapshot.boss;
  if (boss && boss.alive) record(BOSS_HAZARD_KEY, boss.x, boss.y);

  // Drop long-unseen hazards so despawns cannot grow the tracker forever (the
  // bounded history ring goes with the estimate).
  for (const key of Object.keys(memory.hazardVelocities)) {
    if (seen.has(key)) continue;
    const estimate = memory.hazardVelocities[key];
    if (tick - estimate.tick > HAZARD_VELOCITY_STALE_TICKS) {
      delete memory.hazardVelocities[key];
    }
  }

  // Refill the reused view from the (in-place-updated) estimates. Entries for
  // hazards that were pruned are removed; surviving entries are mutated in
  // place so no per-tick Map or `{x,y}` object is allocated.
  const view = scratch.view;
  for (const key of view.keys()) {
    if (!(key in memory.hazardVelocities)) view.delete(key);
  }
  for (const key of Object.keys(memory.hazardVelocities)) {
    const estimate = memory.hazardVelocities[key];
    const point = view.get(key);
    if (point) {
      point.x = estimate.vx;
      point.y = estimate.vy;
      point.curvature = estimate.curvature;
    } else {
      view.set(key, {
        x: estimate.vx,
        y: estimate.vy,
        curvature: estimate.curvature,
      });
    }
  }
  return view;
}

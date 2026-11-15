/**
 * Bot-side hazard-velocity estimation (AH-0MVI4QDN90037DIN · AC1).
 *
 * The snapshot seam deliberately exposes no per-archetype entity velocity for
 * formation enemies (only physics-body entities such as asteroids and lane
 * traffic carry one, and that feeds the aim-lead consumer). Predictive hazard
 * avoidance instead derives a velocity **bot-side**: each decision tick the
 * tracker records every live hazard's position in {@link BotMemory} and
 * estimates its velocity from the position delta across consecutive decision
 * ticks, divided by the injected `dt`.
 *
 * ## Properties
 *
 * - **Deterministic and wall-clock free.** The estimate advances only on the
 *   injected snapshot sequence and `dt`; no `Math.random()` / `Date.now()`.
 *   It is reset with the brain (`resetBotMemory`) so a run replays
 *   bit-for-bit.
 * - **Clamped.** Spurious jumps (wrap-around, respawn, a teleport) would
 *   otherwise imply an absurd velocity, so the estimate is clamped to
 *   {@link HAZARD_MAX_ESTIMATED_SPEED}.
 * - **Cold-start safe.** A hazard seen for the first time has no delta and is
 *   treated as stationary (velocity zero) — exactly today's positional
 *   behaviour. A hazard missing from a tick keeps its last estimate until it
 *   is re-seen; entries unseen for longer than
 *   {@link HAZARD_VELOCITY_STALE_TICKS} are dropped so memory does not grow
 *   without bound.
 *
 * @module src/ai/framework/hazardVelocity
 */

import type { BotSnapshot } from '../botSnapshot';
import type { BotMemory } from './memory';
import type { BotWorldPoint } from './worldModel';
import { wrappedAxisDelta } from '../../utils/wrapGeometry';

/**
 * Upper bound (px/s) on an estimated hazard velocity. The fastest shipped
 * hazards move an order of magnitude below this, so the clamp only ever
 * catches nonsensical deltas (wrap/respawn/teleport).
 */
export const HAZARD_MAX_ESTIMATED_SPEED = 900;

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

/**
 * Advances the hazard-velocity tracker for one decision tick and returns the
 * current estimate for every tracked hazard, keyed by
 * {@link enemyHazardKey}/{@link BOSS_HAZARD_KEY}.
 *
 * The returned velocities are the estimates the world model carries onto
 * `BotWorld.hazards`, so steering can predict where a moving hazard will be.
 *
 * @param memory — the run's memory; its `hazardVelocities` map is updated.
 * @param snapshot — the read-only game state for this tick.
 * @param dt — injected seconds since the previous decision tick.
 * @param world — optional torus; when supplied the position delta is wrapped
 *   per axis, so a hazard that legitimately crosses a seam yields its true
 *   velocity instead of a seam-sized jump that the clamp would floor
 *   (AH-0MVT2W2D9002BOHO). Respawns/teleports are still clamped.
 */
export function trackHazardVelocities(
  memory: BotMemory,
  snapshot: BotSnapshot,
  dt: number,
  world?: { readonly width: number; readonly height: number },
): ReadonlyMap<string, BotWorldPoint> {
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
      memory.hazardVelocities[key] = { tick, x, y, vx: 0, vy: 0 };
      return;
    }
    // Only consecutive ticks give a meaningful delta; after a gap keep the
    // last estimate rather than dividing a multi-tick displacement by one dt.
    const consecutive = previous.tick === tick - 1;
    let vx = previous.vx;
    let vy = previous.vy;
    if (consecutive && Number.isFinite(dt) && dt > 0) {
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
    // Mutate the existing estimate in place: a steady-state tick allocates no
    // per-hazard object (AH-0MWGUN4P2003003P). Values are identical.
    previous.tick = tick;
    previous.x = x;
    previous.y = y;
    previous.vx = vx;
    previous.vy = vy;
  };

  for (const enemy of snapshot.enemies) {
    if (!enemy.alive || typeof enemy.id !== 'number') continue;
    record(enemyHazardKey(enemy.id), enemy.x, enemy.y);
  }
  const boss = snapshot.boss;
  if (boss && boss.alive) record(BOSS_HAZARD_KEY, boss.x, boss.y);

  // Drop long-unseen hazards so despawns cannot grow the tracker forever.
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
    } else {
      view.set(key, { x: estimate.vx, y: estimate.vy });
    }
  }
  return view;
}

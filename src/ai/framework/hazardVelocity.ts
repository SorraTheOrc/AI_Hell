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
 */
export function trackHazardVelocities(
  memory: BotMemory,
  snapshot: BotSnapshot,
  dt: number,
): ReadonlyMap<string, BotWorldPoint> {
  const tick = memory.ticks;
  const seen = new Set<string>();

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
      vx = (x - previous.x) / dt;
      vy = (y - previous.y) / dt;
      const speed = Math.hypot(vx, vy);
      if (speed > HAZARD_MAX_ESTIMATED_SPEED) {
        const scale = HAZARD_MAX_ESTIMATED_SPEED / speed;
        vx *= scale;
        vy *= scale;
      }
    }
    memory.hazardVelocities[key] = { tick, x, y, vx, vy };
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

  const velocities = new Map<string, BotWorldPoint>();
  for (const [key, estimate] of Object.entries(memory.hazardVelocities)) {
    velocities.set(key, { x: estimate.vx, y: estimate.vy });
  }
  return velocities;
}

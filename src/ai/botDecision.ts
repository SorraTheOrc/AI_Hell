/**
 * Bot decision logic — survival-first heuristic.
 *
 * `decideBotInput(snapshot)` is a **pure function** that takes a read-only
 * `BotSnapshot` and returns a `FourDirectionalInput`.  The decision follows a
 * strict priority ladder:
 *
 * 1. **Survive** — never steer into bullets, asteroids, enemies or walls when
 *    a safe alternative exists.  This tier also performs best-effort
 *    **fire-pattern avoidance**: a direction is rejected when the player is
 *    predicted to cross an in-flight bullet's path within
 *    {@link BotDecisionTunables.firePredictionHorizon} seconds, or when it
 *    crosses the aim line of an enemy that is inside a fire **tell**
 *    (`BotEnemy.isTelling`).  Survival dominates every lower tier, so the bot
 *    never trades its life for a power-up.
 * 2. **Threat response** — if a live enemy, asteroid or boss is within
 *    {@link BotDecisionTunables.engagementRadius}, steer toward it; when it is
 *    already closer than {@link BotDecisionTunables.dangerMargin}, back away
 *    instead (approach the threat at a safe distance).
 * 3. **Power-ups** — with no nearby threat, seek the nearest drop within
 *    {@link BotDecisionTunables.powerUpSeekRange}.
 * 4. **Minerals** — collect the nearest mineral within
 *    {@link BotDecisionTunables.mineralSeekRange}; a mineral lying on the way
 *    to a power-up is collected by the same direction.
 * 5. **Idle** — nothing to pursue and no danger: return an all-false input.
 *
 * The module deliberately has **no Phaser or scene dependency** so it can be
 * unit-tested with plain stubbed snapshots.  Every tunable lives in
 * {@link BotDecisionTunables} (AC5) — there are no scattered magic numbers.
 *
 * @module src/ai/botDecision
 */

import type { FourDirectionalInput } from '../utils/movementModel';
import type { BotSnapshot } from './botSnapshot';

// ── Tunables (AC5) ──────────────────────────────────────────────────

/**
 * Shared tuning parameters for the bot decision heuristic.
 *
 * All distances are in canvas pixels; times are in seconds.
 */
export interface BotDecisionTunables {
  /** Distance (px) within which a live threat is engaged. */
  engagementRadius: number;
  /**
   * Minimum distance (px) the bot keeps from a hazard.  When a hazard is
   * closer than this and the bot is moving toward it, that direction is
   * unsafe; when engaged, the bot backs away to this distance.
   */
  dangerMargin: number;
  /**
   * Radius (px) around the player within which an in-flight bullet counts as
   * an immediate (reactive) threat.
   */
  bulletDangerRadius: number;
  /** Distance (px) from a screen edge that the bot treats as a wall hazard. */
  wallMargin: number;
  /** Radius (px) within which the bot seeks power-up drops. */
  powerUpSeekRange: number;
  /** Radius (px) within which the bot collects minerals. */
  mineralSeekRange: number;
  /** Assumed player speed (px/s) used for bullet-path prediction. */
  playerSpeed: number;
  /**
   * Look-ahead window (seconds) for predicted bullet paths.  `0` disables
   * prediction (reactive-only baseline).
   */
  firePredictionHorizon: number;
  /**
   * Assumed bullet speed (px/s) for the aim line of an enemy that is inside
   * a fire tell — the tell has no specific bullet it precedes yet, so the
   * bot estimates one.  Best-effort.
   */
  assumedBulletSpeed: number;
  /** Playfield width (px) — the right wall sits at this x. */
  playfieldWidth: number;
  /** Playfield height (px) — the bottom wall sits at this y. */
  playfieldHeight: number;
}

/**
 * Default tunable values.  Override per-call via the optional second
 * parameter of {@link decideBotInput}.
 */
export const BOT_DECISION_TUNABLES: BotDecisionTunables = {
  engagementRadius: 300,
  dangerMargin: 70,
  bulletDangerRadius: 55,
  wallMargin: 40,
  powerUpSeekRange: 500,
  mineralSeekRange: 500,
  playerSpeed: 175,
  firePredictionHorizon: 0.9,
  assumedBulletSpeed: 200,
  playfieldWidth: 960,
  playfieldHeight: 540,
};

// ── Direction primitives ────────────────────────────────────────────

/** The four cardinal directions the bot can choose. */
export const BOT_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type BotDirection = (typeof BOT_DIRECTIONS)[number];

/** Unit vector for each cardinal direction (screen coordinates: +y down). */
const DIR_VECTORS: Record<BotDirection, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

/** Epsilon for float comparisons. */
const EPS = 1e-6;

/**
 * Step (px) used when comparing how much a cardinal direction reduces or
 * increases the distance to a target.  It is a relative-comparison step, not
 * a gameplay range, so it is a named constant rather than a tunable.
 */
const STEER_EVALUATION_STEP = 10;

// ── Geometry helpers ────────────────────────────────────────────────

function distance(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function dot(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  return ax * bx + ay * by;
}

/**
 * Closest approach between the player (moving with velocity `pv`) and a
 * hazard (moving with velocity `qv`) over `horizon` seconds.
 *
 * Returns the time of closest approach `t` (clamped to `[0, horizon]`) and
 * the separation at that time.  When the bodies are receding the returned
 * `t` is `0` (i.e. "now" is closest).
 */
function closestApproach(
  px: number,
  py: number,
  pvx: number,
  pvy: number,
  qx: number,
  qy: number,
  qvx: number,
  qvy: number,
  horizon: number,
): { t: number; distance: number } {
  const rx = qx - px;
  const ry = qy - py;
  const rvx = qvx - pvx;
  const rvy = qvy - pvy;
  const denom = rvx * rvx + rvy * rvy;

  let t = 0;
  if (denom > EPS) {
    t = -dot(rx, ry, rvx, rvy) / denom;
    if (t < 0) t = 0;
    if (t > horizon) t = horizon;
  }

  const cx = rx + rvx * t;
  const cy = ry + rvy * t;
  return { t, distance: Math.hypot(cx, cy) };
}

// ── Direction safety ────────────────────────────────────────────────

/** Per-direction safety evaluation result. */
interface DirectionSafety {
  /** Whether taking this direction risks a collision. */
  safe: boolean;
  /** Predicted minimum clearance (px) along this direction; higher is safer. */
  clearance: number;
}

/** Returns the distance from the player to the wall in the given direction. */
function wallClearance(
  dir: BotDirection,
  px: number,
  py: number,
  t: BotDecisionTunables,
): number {
  switch (dir) {
    case 'left':
      return px;
    case 'right':
      return t.playfieldWidth - px;
    case 'up':
      return py;
    case 'down':
      return t.playfieldHeight - py;
  }
}

/**
 * Evaluates whether a direction is safe and how much clearance it offers.
 *
 * A direction is unsafe when it either:
 * - moves into a wall within `wallMargin`;
 * - moves toward an alive hazard (enemy/asteroid/boss) closer than
 *   `dangerMargin`;
 * - moves toward a bullet already within `bulletDangerRadius`; or
 * - is predicted to cross an in-flight bullet's path within
 *   `firePredictionHorizon` (fire-pattern avoidance).
 */
function evaluateDirection(
  dir: BotDirection,
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
): DirectionSafety {
  const vec = DIR_VECTORS[dir];
  const pvx = vec.dx * t.playerSpeed;
  const pvy = vec.dy * t.playerSpeed;

  // Walls: only moving into the near wall is unsafe.
  const wall = wallClearance(dir, px, py, t);
  let clearance = wall;
  let safe = wall >= t.wallMargin;

  // Hazards (enemies, asteroids, boss): reactive keep-away.
  for (const hazard of collectHazards(snapshot)) {
    const d = distance(px, py, hazard.x, hazard.y);
    if (d < clearance) clearance = d;
    const toX = hazard.x - px;
    const toY = hazard.y - py;
    if (d < t.dangerMargin && dot(toX, toY, vec.dx, vec.dy) > 0) {
      safe = false;
    }
  }

  // Enemies inside a fire tell are about to shoot; treat the tell as an
  // aimed shot and reject directions that cross its line (fire-pattern
  // avoidance using tell/interval cues, best-effort).
  for (const enemy of snapshot.enemies) {
    if (!enemy.alive || enemy.isTelling !== true) continue;
    const dx = px - enemy.x;
    const dy = py - enemy.y;
    const len = Math.hypot(dx, dy) || 1;
    const ca = closestApproach(
      px,
      py,
      pvx,
      pvy,
      enemy.x,
      enemy.y,
      (dx / len) * t.assumedBulletSpeed,
      (dy / len) * t.assumedBulletSpeed,
      t.firePredictionHorizon,
    );
    if (ca.distance < clearance) clearance = ca.distance;
    if (ca.t > EPS && ca.distance < t.bulletDangerRadius) safe = false;
  }

  // Bullets: reactive proximity plus predictive path crossing.
  for (const bullet of snapshot.enemyBullets) {
    const d = distance(px, py, bullet.x, bullet.y);
    if (d < clearance) clearance = d;

    // Reactive: moving toward a bullet that is already close is unsafe.
    if (d < t.bulletDangerRadius && dot(
      bullet.x - px,
      bullet.y - py,
      vec.dx,
      vec.dy,
    ) > 0) {
      safe = false;
    }

    // Predictive: reject directions that cross the bullet's future path.
    if (t.firePredictionHorizon > 0) {
      const ca = closestApproach(
        px,
        py,
        pvx,
        pvy,
        bullet.x,
        bullet.y,
        bullet.vx,
        bullet.vy,
        t.firePredictionHorizon,
      );
      if (ca.distance < clearance) clearance = ca.distance;
      if (ca.t > EPS && ca.distance < t.bulletDangerRadius) {
        safe = false;
      }
    }
  }

  return { safe, clearance };
}

/** Collects the alive hazards (enemies plus the boss) from the snapshot. */
function collectHazards(snapshot: BotSnapshot): Array<{ x: number; y: number }> {
  const hazards: Array<{ x: number; y: number }> = [];
  for (const enemy of snapshot.enemies) {
    if (enemy.alive) hazards.push({ x: enemy.x, y: enemy.y });
  }
  if (snapshot.boss && snapshot.boss.alive) {
    hazards.push({ x: snapshot.boss.x, y: snapshot.boss.y });
  }
  return hazards;
}

// ── Target selection ────────────────────────────────────────────────

/** A candidate target with its current distance from the player. */
interface Target {
  x: number;
  y: number;
  distance: number;
}

function nearestWithin(
  candidates: ReadonlyArray<{ x: number; y: number }>,
  px: number,
  py: number,
  maxRange: number,
): Target | null {
  let best: Target | null = null;
  for (const c of candidates) {
    const d = distance(px, py, c.x, c.y);
    if (d <= maxRange && (best === null || d < best.distance)) {
      best = { x: c.x, y: c.y, distance: d };
    }
  }
  return best;
}

/**
 * Chooses the safe direction that best changes the distance to `target`.
 *
 * @param direction — `+1` to approach (minimise distance), `-1` to retreat
 *   (maximise distance).
 * @returns the best direction, or `null` when no safe direction improves the
 *   objective.
 */
function steerToward(
  target: Target,
  safeDirections: readonly BotDirection[],
  px: number,
  py: number,
  direction: 1 | -1,
): BotDirection | null {
  let best: BotDirection | null = null;
  let bestGain = 0;

  for (const dir of safeDirections) {
    const vec = DIR_VECTORS[dir];
    const nextX = px + vec.dx * STEER_EVALUATION_STEP;
    const nextY = py + vec.dy * STEER_EVALUATION_STEP;
    const newDistance = distance(nextX, nextY, target.x, target.y);
    const gain = (target.distance - newDistance) * direction;
    if (gain > bestGain + EPS) {
      bestGain = gain;
      best = dir;
    }
  }

  return best;
}

// ── Core decision logic ─────────────────────────────────────────────

/**
 * Decides the next input for the bot from a read-only snapshot.
 *
 * @param snapshot — a read-only `BotSnapshot`.
 * @param tunableOverrides — optional partial override of
 *   {@link BOT_DECISION_TUNABLES}.
 * @returns a `FourDirectionalInput` (up/down/left/right booleans).
 */
export function decideBotInput(
  snapshot: BotSnapshot,
  tunableOverrides?: Partial<BotDecisionTunables>,
): FourDirectionalInput {
  const t: BotDecisionTunables = {
    ...BOT_DECISION_TUNABLES,
    ...(tunableOverrides ?? {}),
  };

  // No ship: nothing to control.
  if (!snapshot.player) return idle();

  const px = snapshot.player.x;
  const py = snapshot.player.y;

  // ── 1. SURVIVE: partition directions and record clearances ──────
  const safety: Record<BotDirection, DirectionSafety> = {
    up: evaluateDirection('up', snapshot, t, px, py),
    down: evaluateDirection('down', snapshot, t, px, py),
    left: evaluateDirection('left', snapshot, t, px, py),
    right: evaluateDirection('right', snapshot, t, px, py),
  };

  const safeDirections = BOT_DIRECTIONS.filter((dir) => safety[dir].safe);

  // Cornered: no safe direction exists.  Pick the one with the most
  // clearance — it is the least-bad escape and the bot must still move.
  if (safeDirections.length === 0) {
    return pickMostClearDirection(safety);
  }

  // ── 2. THREAT RESPONSE ──────────────────────────────────────────
  const threat = findNearestThreat(snapshot, px, py, t.engagementRadius);
  if (threat) {
    if (threat.distance < t.dangerMargin) {
      const retreat = steerToward(threat, safeDirections, px, py, -1);
      if (retreat) return buildInput(retreat);
    } else {
      const approach = steerToward(threat, safeDirections, px, py, 1);
      if (approach) return buildInput(approach);
    }
  }

  // ── 3. POWER-UPS ────────────────────────────────────────────────
  const powerUp = nearestWithin(snapshot.drops, px, py, t.powerUpSeekRange);
  if (powerUp) {
    const approach = steerToward(powerUp, safeDirections, px, py, 1);
    if (approach) return buildInput(approach);
  }

  // ── 4. MINERALS ─────────────────────────────────────────────────
  const mineral = nearestWithin(snapshot.minerals, px, py, t.mineralSeekRange);
  if (mineral) {
    const approach = steerToward(mineral, safeDirections, px, py, 1);
    if (approach) return buildInput(approach);
  }

  // ── 5. IDLE ─────────────────────────────────────────────────────
  // Nothing to pursue; hold position rather than wander into danger.
  return idle();
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Returns the nearest live threat within `maxRange`, or `null`. */
function findNearestThreat(
  snapshot: BotSnapshot,
  px: number,
  py: number,
  maxRange: number,
): Target | null {
  let best: Target | null = null;
  for (const hazard of collectHazards(snapshot)) {
    const d = distance(px, py, hazard.x, hazard.y);
    if (d <= maxRange && (best === null || d < best.distance)) {
      best = { x: hazard.x, y: hazard.y, distance: d };
    }
  }
  return best;
}

/** Returns the input for the direction with the greatest clearance. */
function pickMostClearDirection(
  safety: Record<BotDirection, DirectionSafety>,
): FourDirectionalInput {
  let best: BotDirection = BOT_DIRECTIONS[0];
  let bestClearance = -Infinity;
  for (const dir of BOT_DIRECTIONS) {
    const clearance = safety[dir].clearance;
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = dir;
    }
  }
  return buildInput(best);
}

/** Builds a `FourDirectionalInput` from a direction. */
function buildInput(dir: BotDirection): FourDirectionalInput {
  return {
    up: dir === 'up',
    down: dir === 'down',
    left: dir === 'left',
    right: dir === 'right',
  };
}

/** An all-false input (hold position). */
function idle(): FourDirectionalInput {
  return { up: false, down: false, left: false, right: false };
}

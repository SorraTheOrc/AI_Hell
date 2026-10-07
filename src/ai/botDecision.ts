/**
 * Bot decision logic — survival-first heuristic.
 *
 * `decideBotIntent(snapshot)` is a **pure function** that takes a read-only
 * `BotSnapshot` and returns a `BotSteeringIntent`: the four-directional
 * cardinal approximation (kept for the `fourDirectional` scheme and the
 * legacy tests) **plus** the precise unit travel direction the bot actually
 * wants.  The decision is:
 *
 * 1. **Survive** — never steer into bullets, asteroids, enemies or walls when
 *    a safe alternative exists.  This tier also performs best-effort
 *    **fire-pattern avoidance**: a direction is rejected when the player is
 *    predicted to cross an in-flight bullet's path within
 *    {@link BotDecisionTunables.firePredictionHorizon} seconds, or when it
 *    crosses the aim line of an enemy that is inside a fire **tell**
 *    (`BotEnemy.isTelling`).  Survival dominates every lower tier, so the bot
 *    never trades its life for a power-up.
 * 2. **Clear the wave** (default) — pursue the nearest live non-asteroid
 *    enemy so the wave can be destroyed before its time limit carries
 *    survivors over (AC14).
 * 3. **Opportunistic diversion** — divert from combat to a pickup only when
 *    its **willingness** clears a threshold: a mineral must belong to a
 *    **cluster** (a lone mineral never diverts — AC11), willingness falls off
 *    with distance (AC12), and a power-up is a little more diverting than a
 *    lone mineral (AC13).  As the wave timer runs down the threshold rises,
 *    so the bot stops detouring and focuses fire (AC14).
 * 4. **Asteroids** — engage the nearest live asteroid within
 *    {@link BotDecisionTunables.engagementRadius} (they drop minerals too).
 * 5. **Idle** — nothing to pursue and no danger: return an all-false intent.
 *
 * Because destroying enemies and asteroids drops more minerals, chasing a
 * lone scattered mineral is normally a net loss — the willingness model
 * encodes that: combat is the default and pickups have to earn a detour.
 * The survival tier still bounds every choice.
 *
 * ## Precise aiming ("point towards it and thrust forward")
 *
 * A cardinal-only intent cannot express an arbitrary bearing, so under the
 * rotational `asteroids` control scheme the ship could only ever point at
 * N/E/S/W and would hunt between adjacent cardinals — the "oscillating
 * left/right rotation thrusters" the operator observed.  The decision
 * therefore also returns the exact bearing to the chosen target
 * (`dirX`/`dirY`); {@link BotSteeringIntent} carries it and the human-like
 * governor aims the hull at it (see `src/ai/botHumanLike.ts`).  The cardinal
 * booleans remain the nearest-cardinal projection, so the
 * `fourDirectional` scheme and existing consumers are unchanged.
 *
 * `decideBotInput(snapshot)` is the four-directional projection of the same
 * intent, retained for the `fourDirectional` scheme and legacy callers.
 *
 * The module deliberately has **no Phaser or scene dependency** so it can be
 * unit-tested with plain stubbed snapshots.  Every tunable lives in
 * {@link BotDecisionTunables} (AC5) — there are no scattered magic numbers.
 *
 * ## Forward model (AC10 — no thruster overshoot)
 *
 * The ship is Newtonian and has no brakes, so a bot that simply points at its
 * target and holds the throttle flies past it.  `decideBotIntent` therefore
 * plans its own **stopping distance** ahead: the ship sheds speed at
 * {@link BotDecisionTunables.frictionDeceleration} when coasting, so from
 * speed `v` it needs `v² / (2a)` to stop.  Thrusting is suppressed whenever
 * that stopping distance would carry the ship past the target (into
 * {@link BotDecisionTunables.collectArrivalRadius} for pickups, or the
 * engagement standoff for hazards); the intent still **aims** at the target
 * while `thrust` is `false`, so the ship coasts to a controlled stop rather
 * than overshooting.  The governor re-evaluates this thrust flag every tick
 * (a fast reflex) while the chosen heading stays committed for the human
 * reaction window.
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
  /** Distance (px) within which a live **asteroid** is engaged. */
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
  /**
   * Standoff hysteresis multiplier for engagement.  The bot starts backing
   * away at {@link BotDecisionTunables.dangerMargin} and only resumes
   * approaching once the target is this multiple of the margin away, so a
   * target on the margin boundary does not flip the intent every decision
   * tick (the approach/retreat oscillation the operator observed).
   */
  engagementHysteresis: number;
  /**
   * The ship's friction deceleration (px/s²) — how fast it sheds speed when
   * no thrust is applied.  Used to plan the braking distance ahead of a
   * target so the bot stops instead of overshooting.  Defaults to the
   * shipped ship config (100 px/s²).
   */
  frictionDeceleration: number;
  /**
   * Distance (px) from a collection target within which it counts as reached.
   * The bot aims to arrive (near-zero speed) inside this radius rather than
   * barrelling through the target.
   */
  collectArrivalRadius: number;
  /**
   * Radius (px) within which the bot pursues live non-asteroid enemies.  It is
   * deliberately larger than {@link BotDecisionTunables.engagementRadius} so
   * the bot crosses the field to clear a wave before the time limit carries
   * survivors over (AC14).
   */
  enemySeekRange: number;
  /**
   * Maximum gap (px) between two minerals for them to count as the **same
   * cluster**.  A lone, isolated mineral is not a cluster and never diverts
   * the bot from combat (AC11).
   */
  mineralClusterRadius: number;
  /** Minimum cluster size that can divert the bot from combat (inclusive). */
  mineralGroupMinSize: number;
  /** Willingness scale for a full mineral cluster at zero distance (AC11/AC12). */
  mineralDivertWeight: number;
  /**
   * Willingness scale for a power-up at zero distance.  Slightly above the
   * mineral weight so upgrades are a little more diverting (AC13).
   */
  powerUpDivertWeight: number;
  /** Base willingness a pickup must reach to divert the bot from combat. */
  divertThreshold: number;
  /**
   * Multiplier added to {@link BotDecisionTunables.divertThreshold} at full
   * wave pressure (timer nearly expired), so the bot stops detouring and
   * focuses on clearing the wave (AC14).
   */
  waveClearBoost: number;
  /** Playfield width (px) — the right wall sits at this x. */
  playfieldWidth: number;
  /** Playfield height (px) — the bottom wall sits at this y. */
  playfieldHeight: number;
}

/**
 * Default tunable values.  Override per-call via the optional second
 * parameter of {@link decideBotIntent}.
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
  engagementHysteresis: 1.6,
  frictionDeceleration: 100,
  collectArrivalRadius: 18,
  enemySeekRange: 800,
  mineralClusterRadius: 70,
  mineralGroupMinSize: 2,
  mineralDivertWeight: 1,
  powerUpDivertWeight: 1.4,
  divertThreshold: 0.5,
  waveClearBoost: 1,
  playfieldWidth: 960,
  playfieldHeight: 540,
};

// ── Steering intent ─────────────────────────────────────────────────

/**
 * A steering intent: the four-directional cardinal approximation (for the
 * `fourDirectional` scheme and existing consumers) **plus** the precise unit
 * travel direction (`dirX`, `dirY`) the bot wants.  `(0, 0)` means idle.
 *
 * The rotational `asteroids` scheme aims the hull at `(dirX, dirY)` so the
 * ship points straight at its target and thrusts forward; the
 * four-directional scheme uses the booleans.
 *
 * `thrust` is the **forward-model** decision (AC10): the bot plans its own
 * stopping distance, so when continuing to thrust would overshoot the target
 * it sets `thrust: false` (coast) while still aiming.  Defaults to `true` so
 * callers that do not plan can omit it.
 */
export interface BotSteeringIntent extends FourDirectionalInput {
  /** Precise unit x component of the desired travel direction (0 when idle). */
  readonly dirX: number;
  /** Precise unit y component of the desired travel direction (0 when idle). */
  readonly dirY: number;
  /**
   * Whether to apply forward thrust toward `(dirX, dirY)`.  `false` = coast
   * (aim but do not accelerate) — used when thrusting would overshoot.
   */
  readonly thrust: boolean;
}

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

/**
 * Evaluates whether moving along the unit direction `(dirX, dirY)` is safe
 * and how much clearance it offers.
 *
 * A direction is unsafe when it either:
 * - reaches a wall within `wallMargin`;
 * - moves toward an alive hazard (enemy/asteroid/boss) closer than
 *   `dangerMargin`;
 * - moves toward a bullet already within `bulletDangerRadius`; or
 * - is predicted to cross an in-flight bullet's path within
 *   `firePredictionHorizon` (fire-pattern avoidance).
 *
 * Generalising the check to an arbitrary unit vector is what lets the bot
 * validate a precise aiming direction (not just the four cardinals).
 */
function evaluateVector(
  dirX: number,
  dirY: number,
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
): DirectionSafety {
  const pvx = dirX * t.playerSpeed;
  const pvy = dirY * t.playerSpeed;

  // Walls: distance travelled along the direction to the first wall it
  // reaches; reaching one inside `wallMargin` is unsafe.
  let wall = Infinity;
  if (dirX < -EPS) wall = Math.min(wall, px / -dirX);
  if (dirX > EPS) wall = Math.min(wall, (t.playfieldWidth - px) / dirX);
  if (dirY < -EPS) wall = Math.min(wall, py / -dirY);
  if (dirY > EPS) wall = Math.min(wall, (t.playfieldHeight - py) / dirY);
  let clearance = wall;
  let safe = wall >= t.wallMargin;

  // Hazards (enemies, asteroids, boss): reactive keep-away.
  for (const hazard of collectHazards(snapshot)) {
    const d = distance(px, py, hazard.x, hazard.y);
    if (d < clearance) clearance = d;
    const toX = hazard.x - px;
    const toY = hazard.y - py;
    if (d < t.dangerMargin && dot(toX, toY, dirX, dirY) > 0) {
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
      dirX,
      dirY,
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

/** Evaluates a cardinal direction via {@link evaluateVector}. */
function evaluateDirection(
  dir: BotDirection,
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
): DirectionSafety {
  const vec = DIR_VECTORS[dir];
  return evaluateVector(vec.dx, vec.dy, snapshot, t, px, py);
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
 * Chooses the safe cardinal direction that best changes the distance to
 * `target`.
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

// ── Utility / willingness model ─────────────────────────────────────

/** A target with its diversion willingness score. */
interface ScoredTarget extends Target {
  score: number;
}

/** Clamps a number into `[0, 1]`. */
function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Willingness falloff with distance: 1 at the player, 0 at `range`. */
function proximity(dist: number, range: number): number {
  if (range <= 0) return 0;
  return clamp01(1 - dist / range);
}

/**
 * Fraction of full willingness a mineral cluster of `count` earns.  Zero
 * below {@link BotDecisionTunables.mineralGroupMinSize} — a lone mineral
 * never earns a diversion (AC11).
 */
function mineralGroupFactor(count: number, t: BotDecisionTunables): number {
  if (count < t.mineralGroupMinSize) return 0;
  return Math.min(1, 0.5 + 0.25 * (count - t.mineralGroupMinSize));
}

/**
 * Groups minerals into clusters of mutually-near neighbours (a gap no larger
 * than `radius`), via an `O(n²)` breadth-first flood fill.  The live mineral
 * field is small, so the simple approach is fine and deterministic.
 */
function clusterMinerals(
  minerals: readonly { x: number; y: number }[],
  radius: number,
): Array<Array<{ x: number; y: number }>> {
  const n = minerals.length;
  const visited = new Array<boolean>(n).fill(false);
  const clusters: Array<Array<{ x: number; y: number }>> = [];

  for (let i = 0; i < n; i += 1) {
    if (visited[i]) continue;
    const stack = [i];
    visited[i] = true;
    const cluster: Array<{ x: number; y: number }> = [];
    while (stack.length > 0) {
      const a = stack.pop() as number;
      cluster.push(minerals[a]);
      for (let b = 0; b < n; b += 1) {
        if (visited[b]) continue;
        if (
          distance(minerals[a].x, minerals[a].y, minerals[b].x, minerals[b].y) <=
          radius
        ) {
          visited[b] = true;
          stack.push(b);
        }
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Wave pressure in `[0, 1]`: `0` at the start of a timed wave, rising to `1`
 * as the wave time-limit approaches (survivors then carry over).  No timed
 * wave (boss, transition, between waves) → `0`.
 */
function computeWavePressure(snapshot: BotSnapshot): number {
  const wave = snapshot.wave;
  if (!wave || !wave.active || wave.timeLimit <= 0) return 0;
  return clamp01(1 - wave.timeRemaining / wave.timeLimit);
}

/**
 * Scores every mineral cluster and power-up for the **willingness to divert**
 * from combat and returns the best-scoring candidate (or `null`).
 *
 * - A mineral cluster only scores when it meets
 *   {@link BotDecisionTunables.mineralGroupMinSize}; the score grows with
 *   cluster size (AC11) and falls off with distance (AC12).
 * - A power-up scores on its own (higher) weight, also falling off with
 *   distance (AC13).
 */
function bestDiversion(
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
): ScoredTarget | null {
  let best: ScoredTarget | null = null;

  for (const cluster of clusterMinerals(
    snapshot.minerals,
    t.mineralClusterRadius,
  )) {
    const factor = mineralGroupFactor(cluster.length, t);
    if (factor <= 0) continue;
    const nearest = nearestWithin(cluster, px, py, t.mineralSeekRange);
    if (!nearest) continue;
    const score =
      t.mineralDivertWeight *
      factor *
      proximity(nearest.distance, t.mineralSeekRange);
    if (!best || score > best.score) {
      best = { x: nearest.x, y: nearest.y, distance: nearest.distance, score };
    }
  }

  for (const drop of snapshot.drops) {
    const d = distance(px, py, drop.x, drop.y);
    if (d > t.powerUpSeekRange) continue;
    const score = t.powerUpDivertWeight * proximity(d, t.powerUpSeekRange);
    if (!best || score > best.score) {
      best = { x: drop.x, y: drop.y, distance: d, score };
    }
  }

  return best;
}

/**
 * Nearest mineral or power-up of any size — the fallback target when there is
 * no combat objective (or its approach is unsafe), so the bot still sweeps up
 * loose pickups between fights.
 */
function nearestCollectible(
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
): Target | null {
  const mineral = nearestWithin(snapshot.minerals, px, py, t.mineralSeekRange);
  const drop = nearestWithin(snapshot.drops, px, py, t.powerUpSeekRange);
  if (mineral && drop) return mineral.distance <= drop.distance ? mineral : drop;
  return mineral ?? drop;
}

// ── Core decision logic ─────────────────────────────────────────────

/**
 * Decides the next steering intent for the bot from a read-only snapshot.
 *
 * @param snapshot — a read-only `BotSnapshot`.
 * @param tunableOverrides — optional partial override of
 *   {@link BOT_DECISION_TUNABLES}.
 * @returns a {@link BotSteeringIntent} (cardinal booleans + precise bearing +
 *   the forward-model thrust flag).
 */
export function decideBotIntent(
  snapshot: BotSnapshot,
  tunableOverrides?: Partial<BotDecisionTunables>,
): BotSteeringIntent {
  const t: BotDecisionTunables = {
    ...BOT_DECISION_TUNABLES,
    ...(tunableOverrides ?? {}),
  };

  // No ship: nothing to control.
  if (!snapshot.player) return idleIntent();

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
    return buildCardinalIntent(mostClearDirection(safety));
  }

  // ── 2. GOAL SELECTION: utility / willingness model ─────────────
  //
  // Clearing the wave is the default objective; pickups must **earn** a
  // diversion.  A lone mineral never earns one (only a cluster can);
  // willingness falls off with distance; and as the wave timer runs down the
  // diversion threshold rises so the bot focuses fire on the survivors
  // (AC11–AC14).
  const wavePressure = computeWavePressure(snapshot);
  const diversion = bestDiversion(snapshot, t, px, py);
  const fallbackPickup = nearestCollectible(snapshot, t, px, py);

  const enemy = nearestWithin(
    liveEnemyTargets(snapshot),
    px,
    py,
    t.enemySeekRange,
  );
  const asteroid = nearestWithin(
    liveAsteroidTargets(snapshot),
    px,
    py,
    t.engagementRadius,
  );
  const hasCombatTarget = enemy !== null || asteroid !== null;
  const effectiveThreshold =
    t.divertThreshold * (1 + wavePressure * t.waveClearBoost);

  if (
    diversion &&
    (!hasCombatTarget || diversion.score >= effectiveThreshold - EPS)
  ) {
    const intent = approachIntent(
      diversion,
      1,
      snapshot,
      t,
      px,
      py,
      safeDirections,
      t.collectArrivalRadius,
    );
    if (intent) return intent;
  }

  if (enemy) {
    const direction = engageDirection(enemy, snapshot, t, px, py);
    const intent = approachIntent(
      enemy,
      direction,
      snapshot,
      t,
      px,
      py,
      safeDirections,
      t.dangerMargin,
    );
    if (intent) return intent;
  }

  if (asteroid) {
    const direction = engageDirection(asteroid, snapshot, t, px, py);
    const intent = approachIntent(
      asteroid,
      direction,
      snapshot,
      t,
      px,
      py,
      safeDirections,
      t.dangerMargin,
    );
    if (intent) return intent;
  }

  // No combat target (or its approach was unsafe): collect the nearest pickup
  // even when it is a lone mineral.
  if (fallbackPickup) {
    const intent = approachIntent(
      fallbackPickup,
      1,
      snapshot,
      t,
      px,
      py,
      safeDirections,
      t.collectArrivalRadius,
    );
    if (intent) return intent;
  }

  // ── 3. IDLE ─────────────────────────────────────────────────────
  // Nothing to pursue; hold position rather than wander into danger.
  return idleIntent();
}

/**
 * Four-directional projection of {@link decideBotIntent}, retained for the
 * `fourDirectional` scheme and existing callers.  The precise `dirX`/`dirY`
 * and the `thrust` flag are dropped; the returned object is exactly the four
 * booleans.
 */
export function decideBotInput(
  snapshot: BotSnapshot,
  tunableOverrides?: Partial<BotDecisionTunables>,
): FourDirectionalInput {
  const {
    dirX: _dirX,
    dirY: _dirY,
    thrust: _thrust,
    ...cardinal
  } = decideBotIntent(snapshot, tunableOverrides);
  return cardinal;
}

// ── Steering helpers ────────────────────────────────────────────────

/**
 * Builds the intent for pursuing `target` in `direction` (`+1` approach,
 * `-1` retreat).
 *
 * Prefers the precise bearing to the target when that bearing is safe, so
 * the ship points straight at it ("point towards it and thrust forward").
 * When the direct bearing is blocked by the survival tier, falls back to the
 * safe cardinal direction that best improves the objective, and `null` when
 * no safe direction helps.
 */
function approachIntent(
  target: Target,
  direction: 1 | -1,
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
  safeDirections: readonly BotDirection[],
  arrivalRadius: number,
): BotSteeringIntent | null {
  const rx = target.x - px;
  const ry = target.y - py;
  const d = Math.hypot(rx, ry) || 1;
  const dirX = (direction * rx) / d;
  const dirY = (direction * ry) / d;
  // Forward model (AC10): only accelerate when the ship can still shed the
  // speed it has by the time it reaches the target; otherwise coast.  A
  // retreat always thrusts (it is trying to escape, not arrive).
  const thrust =
    direction === 1
      ? mayThrust(snapshot, t, target.distance, arrivalRadius)
      : true;

  if (evaluateVector(dirX, dirY, snapshot, t, px, py).safe) {
    return buildIntent(dirX, dirY, thrust);
  }

  const safe = steerToward(target, safeDirections, px, py, direction);
  return safe ? buildCardinalIntent(safe, thrust) : null;
}

/**
 * Forward model (AC10): whether continuing to thrust is safe given the
 * target's remaining distance and the ship's current speed.
 *
 * The ship sheds speed at {@link BotDecisionTunables.frictionDeceleration}
 * when coasting, so the distance it needs to stop from speed `v` is
 * `v² / (2a)`.  Thrusting is only safe while that stopping distance fits in
 * the remaining gap (target distance minus the arrival radius); otherwise the
 * bot would overshoot, so it coasts and lets friction bring it to rest on
 * target.  This is re-evaluated every tick by the governor (the throttle is a
 * fast reflex) even while the chosen heading stays committed.
 */
function mayThrust(
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  distance: number,
  arrivalRadius: number,
): boolean {
  const player = snapshot.player;
  if (!player) return false;
  // No friction -> the ship cannot brake by coasting; keep thrusting.
  if (t.frictionDeceleration <= 0) return true;
  const speed = Math.hypot(player.vx, player.vy);
  const gap = Math.max(0, distance - arrivalRadius);
  const stoppingDistance = (speed * speed) / (2 * t.frictionDeceleration);
  return stoppingDistance <= gap;
}

/**
 * Chooses whether to approach (`+1`) or retreat (`-1`) an engaged target.
 *
 * The bot backs away inside {@link BotDecisionTunables.dangerMargin}.  To
 * stop the approach/retreat flip-flop at the boundary, it only resumes
 * approaching once the target is beyond `dangerMargin *
 * engagementHysteresis` **and** the ship is no longer moving away from it
 * (radial closing speed non-negative).
 */
function engageDirection(
  target: Target,
  snapshot: BotSnapshot,
  t: BotDecisionTunables,
  px: number,
  py: number,
): 1 | -1 {
  if (target.distance >= t.dangerMargin * t.engagementHysteresis) return 1;
  if (target.distance >= t.dangerMargin) {
    // In the hysteresis band: keep retreating while still separating.
    const rx = target.x - px;
    const ry = target.y - py;
    const d = target.distance || 1;
    const radialSpeed =
      (snapshot.player!.vx * rx + snapshot.player!.vy * ry) / d;
    return radialSpeed < 0 ? -1 : 1;
  }
  return -1;
}

// ── Intent builders ─────────────────────────────────────────────────

/** Returns the live non-asteroid enemies plus the live boss as targets. */
function liveEnemyTargets(
  snapshot: BotSnapshot,
): Array<{ x: number; y: number }> {
  const targets: Array<{ x: number; y: number }> = [];
  for (const enemy of snapshot.enemies) {
    if (enemy.alive && enemy.archetype !== 'asteroid') {
      targets.push({ x: enemy.x, y: enemy.y });
    }
  }
  if (snapshot.boss && snapshot.boss.alive) {
    targets.push({ x: snapshot.boss.x, y: snapshot.boss.y });
  }
  return targets;
}

/** Returns the live asteroids as targets. */
function liveAsteroidTargets(
  snapshot: BotSnapshot,
): Array<{ x: number; y: number }> {
  return snapshot.enemies
    .filter((enemy) => enemy.alive && enemy.archetype === 'asteroid')
    .map((enemy) => ({ x: enemy.x, y: enemy.y }));
}

/** Returns the input for the direction with the greatest clearance. */
function mostClearDirection(
  safety: Record<BotDirection, DirectionSafety>,
): BotDirection {
  let best: BotDirection = BOT_DIRECTIONS[0];
  let bestClearance = -Infinity;
  for (const dir of BOT_DIRECTIONS) {
    const clearance = safety[dir].clearance;
    if (clearance > bestClearance) {
      bestClearance = clearance;
      best = dir;
    }
  }
  return best;
}

/**
 * Builds a {@link BotSteeringIntent} from a precise direction.  The vector is
 * normalised and the cardinal booleans are its nearest-cardinal projection,
 * so `decideBotInput` stays a faithful four-directional approximation.
 */
function buildIntent(dirX: number, dirY: number, thrust = true): BotSteeringIntent {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  const cardinal: FourDirectionalInput =
    Math.abs(ux) >= Math.abs(uy)
      ? ux >= 0
        ? { up: false, down: false, left: false, right: true }
        : { up: false, down: false, left: true, right: false }
      : uy >= 0
        ? { up: false, down: true, left: false, right: false }
        : { up: true, down: false, left: false, right: false };
  return { ...cardinal, dirX: ux, dirY: uy, thrust };
}

/** Builds an intent along a cardinal direction. */
function buildCardinalIntent(dir: BotDirection, thrust = true): BotSteeringIntent {
  const vec = DIR_VECTORS[dir];
  return { ...buildInput(dir), dirX: vec.dx, dirY: vec.dy, thrust };
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

/** An all-false intent (hold position). */
function idleIntent(): BotSteeringIntent {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    dirX: 0,
    dirY: 0,
    thrust: false,
  };
}

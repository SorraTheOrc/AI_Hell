/**
 * Pure planner for Frogger lane-traffic spawns (classic-arcade archetype,
 * AH-0MV01EPM40008N8T).
 *
 * Each wave plans one or more horizontal "road lanes" of fast-moving,
 * non-firing hazards. A lane is a train of `perLaneCount` entities that
 * enter from an arena edge, cross at a constant speed and wrap at the far
 * edge. Lanes alternate travel direction so the player must read both.
 *
 * This module has **no Phaser dependency**, so the lane schedule is fully
 * unit-testable and deterministic for a fixed RNG. The lane count, per-lane
 * count, speed and spacing come from the data-driven `lane-traffic` CSV row
 * (`count` = per-lane members, `driftSpeed` = lane speed, `spacingX` =
 * within-lane gap, `laneCount`/`laneSpacing` = multi-lane tuning).
 *
 * Lane traffic is a **non-blocking world hazard** (the Asteroid accounting):
 * the scene spawns these events directly and never registers them with the
 * `WaveManager`, so a wave neither stalls nor clears early because of the
 * traffic.
 *
 * @module LaneTrafficSpawner
 */

// ── Archetype + tuning ──────────────────────────────────────────────

/** Enemy-config/archetype key for the Frogger lane traffic. */
export const LANE_TRAFFIC_ENEMY_KEY = 'lane-traffic';

/** Default number of lanes when the config omits `laneCount`. */
export const LANE_TRAFFIC_DEFAULT_LANE_COUNT = 2;

/** Default members per lane when the config omits `count`. */
export const LANE_TRAFFIC_DEFAULT_PER_LANE = 4;

/** Default lane speed in px/s when the config omits `driftSpeed`. */
export const LANE_TRAFFIC_DEFAULT_SPEED = 180;

/** Default within-lane horizontal gap (px) when `spacingX` is omitted. */
export const LANE_TRAFFIC_DEFAULT_SPACING = 140;

/** Default vertical gap (px) between lanes when `laneSpacing` is omitted. */
export const LANE_TRAFFIC_DEFAULT_LANE_SPACING = 120;

/** Offscreen margin (px) beyond the arena edge the lane train enters from. */
export const LANE_TRAFFIC_SPAWN_MARGIN = 30;

/** Earliest spawn time fraction within the wave (keeps the wave start clear). */
export const LANE_TRAFFIC_MIN_TIME_FRACTION = 0.05;

/** Latest spawn time fraction within the wave (leaves time to fight). */
export const LANE_TRAFFIC_MAX_TIME_FRACTION = 0.85;

/** Maximum ± jitter (fraction of the wave) applied to a lane's spawn time. */
export const LANE_TRAFFIC_TIME_JITTER_FRACTION = 0.04;

// ── Types ───────────────────────────────────────────────────────────

/** A single lane-traffic spawn event computed by the planner. */
export interface LaneTrafficSpawnEvent {
  /** Enemy-config key (`'lane-traffic'`). */
  enemyKey: string;
  /** Zero-based lane index (members in the same lane share a y and cadence). */
  laneIndex: number;
  /** Spawn x (px), offscreen at the lane's entry edge. */
  x: number;
  /** Lane y (px). */
  y: number;
  /** Horizontal velocity (px/s); positive = right, negative = left. */
  vx: number;
  /** Fraction of the wave time limit at which this lane enters. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

/** The data-driven inputs for one wave's lane-traffic plan. */
export interface LaneTrafficSpawnPlan {
  /** Viewport width in px. */
  gameWidth: number;
  /** Viewport height in px. */
  gameHeight: number;
  /** Wave duration in seconds. */
  waveTimeLimitSeconds: number;
  /** Number of lanes to plan. */
  laneCount: number;
  /** Members per lane. */
  perLaneCount: number;
  /** Within-lane horizontal gap (px). */
  spacing: number;
  /** Vertical gap between lanes (px). */
  laneSpacing: number;
  /** Lane speed magnitude (px/s). */
  speed: number;
  /** Deterministic RNG returning [0, 1). */
  rng: () => number;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Clamp a possibly-fractional/NaN value to a safe integer in `[lo, hi]`. */
function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}

/** Clamp a possibly-NaN value to a non-negative finite number. */
function clampFinite(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes the lane-traffic spawn events for one wave.
 *
 * Rules:
 *
 * - Exactly `laneCount × perLaneCount` events are planned (sanitised to
 *   non-negative integers; `0` lanes yields no events).
 * - Lanes are centred vertically and separated by `laneSpacing` px.
 * - Travel direction alternates per lane (even lanes rightwards, odd lanes
 *   leftwards) so the player must read both directions.
 * - Within a lane, members are spaced `spacing` px apart behind the entry
 *   point, so they enter as a train with consistent gaps.
 * - Every lane's entry time is inside
 *   [`LANE_TRAFFIC_MIN_TIME_FRACTION`, `LANE_TRAFFIC_MAX_TIME_FRACTION`] of
 *   the wave, spread across the wave with a small deterministic jitter.
 *
 * @param plan — the resolved lane plan (see {@link LaneTrafficSpawnPlan}).
 * @returns the spawn events, ordered by spawn time.
 */
export function computeLaneTrafficSpawns(
  plan: LaneTrafficSpawnPlan,
): LaneTrafficSpawnEvent[] {
  const laneCount = clampInt(plan.laneCount, 0, 8);
  if (laneCount === 0) return [];

  const perLane = clampInt(plan.perLaneCount, 1, 24);
  const spacing = clampFinite(plan.spacing, LANE_TRAFFIC_DEFAULT_SPACING);
  const laneSpacing = clampFinite(
    plan.laneSpacing,
    LANE_TRAFFIC_DEFAULT_LANE_SPACING,
  );
  const speed = clampFinite(plan.speed, LANE_TRAFFIC_DEFAULT_SPEED);
  const waveTime = Number.isFinite(plan.waveTimeLimitSeconds)
    ? Math.max(0, plan.waveTimeLimitSeconds)
    : 0;
  const rng = plan.rng;

  // Centre the lane stack vertically and keep it inside the arena.
  const totalLaneHeight = (laneCount - 1) * laneSpacing;
  const minY = laneSpacing / 2;
  const maxY = Math.max(minY, plan.gameHeight - laneSpacing / 2);
  const centredY = plan.gameHeight / 2 - totalLaneHeight / 2;
  const firstY = Math.min(maxY, Math.max(minY, centredY));

  const events: LaneTrafficSpawnEvent[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const y = firstY + lane * laneSpacing;
    const direction = lane % 2 === 0 ? 1 : -1;
    const vx = direction * speed;
    const entryX =
      direction === 1
        ? -LANE_TRAFFIC_SPAWN_MARGIN
        : plan.gameWidth + LANE_TRAFFIC_SPAWN_MARGIN;

    // Spread the lane entry points across the usable wave window.
    const span = LANE_TRAFFIC_MAX_TIME_FRACTION - LANE_TRAFFIC_MIN_TIME_FRACTION;
    const anchor =
      LANE_TRAFFIC_MIN_TIME_FRACTION +
      (laneCount > 1 ? (lane / laneCount) * span : 0);
    const jitter = (rng() * 2 - 1) * LANE_TRAFFIC_TIME_JITTER_FRACTION;
    const timeFraction = Math.max(
      LANE_TRAFFIC_MIN_TIME_FRACTION,
      Math.min(LANE_TRAFFIC_MAX_TIME_FRACTION, anchor + jitter),
    );
    const timeSeconds = timeFraction * waveTime;

    for (let member = 0; member < perLane; member++) {
      // Members trail behind the entry point so they stream in as a train.
      const x = direction === 1
        ? entryX - member * spacing
        : entryX + member * spacing;

      events.push({
        enemyKey: LANE_TRAFFIC_ENEMY_KEY,
        laneIndex: lane,
        x,
        y,
        vx,
        timeFraction,
        timeSeconds,
      });
    }
  }

  // Order by spawn time so the scene's release loop can stop at the first
  // not-yet-due event.
  events.sort(
    (a, b) => a.timeSeconds - b.timeSeconds || a.laneIndex - b.laneIndex,
  );
  return events;
}

/** Number of events a plan produces (for tests/diagnostics). */
export function laneTrafficSpawnCount(
  laneCount: number,
  perLaneCount: number,
): number {
  const lanes = clampInt(laneCount, 0, 8);
  const perLane = clampInt(perLaneCount, 1, 24);
  return lanes * perLane;
}

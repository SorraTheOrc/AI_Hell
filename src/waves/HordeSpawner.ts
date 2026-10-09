/**
 * Pure planner for the Robotron homing-horde spawn (classic-arcade
 * archetype, AH-0MV01EKTL001NRE6).
 *
 * The horde is a timed, edge-spawning group rather than a formation, so it
 * is delivered by a dynamic spawner (the same pattern as the
 * Ghost/Centipede/Harvester spawners, and unlike the Asteroid). Grunts pour
 * in from every arena edge in groups spread across the wave; every spawned
 * grunt is registered with the `WaveManager` by the scene, so the wave
 * neither clears early nor stalls while a grunt is alive.
 *
 * This module has **no Phaser dependency**, so the spawn schedule is fully
 * unit-testable and deterministic for a fixed RNG. The group/cadence/speed
 * inputs come from the data-driven `grunt` CSV row.
 *
 * @module HordeSpawner
 */

// ── Archetype + tuning ──────────────────────────────────────────────

/** Enemy-config/archetype key for the horde grunt. */
export const GRUNT_ENEMY_KEY = 'grunt';

/** Default horde size (grunts per wave) when the config omits it. */
export const HORDE_DEFAULT_COUNT = 16;

/** Default grunts released per spawn group. */
export const HORDE_DEFAULT_GROUP_SIZE = 4;

/** Default seconds between spawn groups. */
export const HORDE_DEFAULT_SPAWN_INTERVAL_SECONDS = 1.6;

/** Inset from the arena edge at which a grunt spawns (px) — always reachable. */
export const HORDE_SPAWN_EDGE_INSET = 36;

/** Maximum +/- jitter (seconds) applied to a group's spawn time. */
export const HORDE_SPAWN_TIME_JITTER_SECONDS = 0.25;

/**
 * Earliest spawn time fraction within the wave. Keeps the first group from
 * popping the instant the wave starts (matching the ghost/centipede
 * spawners), so the player sees the wave begin before the horde arrives.
 */
export const HORDE_SPAWN_MIN_TIME_FRACTION = 0.05;

/** Latest spawn time fraction within the wave (leaves time to fight). */
export const HORDE_MAX_TIME_FRACTION = 0.85;

// ── Types ───────────────────────────────────────────────────────────

/** A single grunt spawn event computed by the planner. */
export interface HordeSpawnEvent {
  /** Enemy-config key (`'grunt'`). */
  enemyKey: string;
  /** Spawn x (px), inside the play area on an arena edge. */
  x: number;
  /** Spawn y (px), inside the play area on an arena edge. */
  y: number;
  /** Zero-based spawn-group index (grunts in the same group share a cadence slot). */
  groupIndex: number;
  /** Fraction of the wave time limit at which this grunt should spawn. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

/** The data-driven plan inputs for one horde. */
export interface HordeSpawnPlan {
  /** Viewport width in px. */
  gameWidth: number;
  /** Viewport height in px. */
  gameHeight: number;
  /** Wave duration in seconds. */
  waveTimeLimitSeconds: number;
  /** Total grunts in the horde. */
  count: number;
  /** Grunts released per spawn group. */
  groupSize: number;
  /** Seconds between spawn groups. */
  spawnIntervalSeconds: number;
  /** Deterministic RNG returning [0, 1). */
  rng: () => number;
}

// ── Core algorithm ──────────────────────────────────────────────────

/** Clamp a possibly-fractional/NaN value to a safe integer in `[lo, hi]`. */
function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}

/**
 * Computes the grunt spawn events for one wave.
 *
 * Rules:
 *
 * - Exactly `count` grunts are planned (sanitised to a non-negative integer;
 *   `0` yields no events).
 * - Grunts are released in `ceil(count / groupSize)` groups; group `g`
 *   spawns at `g × spawnInterval` seconds (with a small deterministic jitter
 *   within the group).
 * - Groups cycle through the four arena edges (top, right, bottom, left), so
 *   a horde surrounds the player. Each grunt is placed on its group's edge,
 *   inside the play area, so it is immediately reachable and can never stall
 *   wave completion.
 * - No grunt is scheduled before {@link HORDE_SPAWN_MIN_TIME_FRACTION} or
 *   after {@link HORDE_MAX_TIME_FRACTION} of the wave.
 *
 * @param plan — the resolved horde plan (see {@link HordeSpawnPlan}).
 * @returns the spawn events, ordered by spawn time.
 */
export function computeHordeSpawns(plan: HordeSpawnPlan): HordeSpawnEvent[] {
  const count = clampInt(plan.count, 0, 200);
  if (count === 0) return [];

  const groupSize = clampInt(plan.groupSize, 1, count);
  const interval = Number.isFinite(plan.spawnIntervalSeconds)
    ? Math.max(0, plan.spawnIntervalSeconds)
    : 0;
  const waveTime = Number.isFinite(plan.waveTimeLimitSeconds)
    ? Math.max(0, plan.waveTimeLimitSeconds)
    : 0;
  const rng = plan.rng;

  // Usable edge band: inset inside the viewport so every spawn is on-screen.
  const inset = HORDE_SPAWN_EDGE_INSET;
  const minX = Math.min(inset, plan.gameWidth / 2);
  const maxX = Math.max(minX, plan.gameWidth - inset);
  const minY = Math.min(inset, plan.gameHeight / 2);
  const maxY = Math.max(minY, plan.gameHeight - inset);

  const events: HordeSpawnEvent[] = [];
  for (let i = 0; i < count; i++) {
    const groupIndex = Math.floor(i / groupSize);

    // Edge cycles per group so the horde enters from all four sides.
    const edge = groupIndex % 4;
    let x: number;
    let y: number;
    switch (edge) {
      case 0: // top
        x = minX + rng() * (maxX - minX);
        y = minY;
        break;
      case 1: // right
        x = maxX;
        y = minY + rng() * (maxY - minY);
        break;
      case 2: // bottom
        x = minX + rng() * (maxX - minX);
        y = maxY;
        break;
      default: // left
        x = minX;
        y = minY + rng() * (maxY - minY);
        break;
    }

    const jitter = (rng() * 2 - 1) * HORDE_SPAWN_TIME_JITTER_SECONDS;
    const rawSeconds = groupIndex * interval + jitter;
    const timeSeconds = Math.max(
      waveTime * HORDE_SPAWN_MIN_TIME_FRACTION,
      Math.min(waveTime * HORDE_MAX_TIME_FRACTION, rawSeconds),
    );
    const timeFraction = waveTime > 0 ? timeSeconds / waveTime : 0;

    events.push({
      enemyKey: GRUNT_ENEMY_KEY,
      x,
      y,
      groupIndex,
      timeFraction,
      timeSeconds,
    });
  }

  // Keep the plan time-ordered so the scene's release loop can stop at the
  // first not-yet-due event. (Groups are already ordered, but the jitter can
  // reorder adjacent group members, so sort explicitly.)
  events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.groupIndex - b.groupIndex);
  return events;
}

/** Number of spawn groups a plan produces (for tests/diagnostics). */
export function hordeGroupCount(count: number, groupSize: number): number {
  const n = clampInt(count, 0, 200);
  if (n === 0) return 0;
  const size = clampInt(groupSize, 1, n);
  return Math.ceil(n / size);
}

/**
 * Pure planner for telegraphed orbital strike spawning (Missile Command
 * archetype, AH-0MV01ENX00055CG1).
 *
 * Computes when and where orbital strikes should spawn based on the global
 * wave index. No Phaser runtime dependency — all logic is pure TypeScript so
 * it is fully unit-testable.
 *
 * The strike is a **non-blocking hazard**: it does not count toward wave
 * completion (matching the asteroid accounting convention, GDD §2.4). Waves
 * clear when their registered formation enemies are destroyed, regardless of
 * whether strikes are still active.
 *
 * @module waves/StrikeSpawner
 */

// ── Tuning constants ───────────────────────────────────────────────

/**
 * Baseline strikes spawned per wave. Starts at 0 — the first strike appears
 * at wave 3 and escalates from there.
 */
export const STRIKE_SPAWN_BASE_COUNT = 0;

/** Strikes begin appearing at this wave index. */
export const STRIKE_SPAWN_START_WAVE = 3;

/** Increment added to strike count every 5 waves. */
export const STRIKE_SPAWN_COUNT_INCREMENT = 1;

/** Maximum strikes allowed per wave. */
export const STRIKE_SPAWN_MAX_PER_WAVE = 4;

/** Jitter fraction applied to spawn timing (±10 %). */
export const STRIKE_SPAWN_JITTER_FRACTION = 0.1;

/** Minimum spawn time fraction (first 15 % of wave is safe). */
export const STRIKE_SPAWN_MIN_FRACTION = 0.15;

/** Maximum spawn time fraction. */
export const STRIKE_SPAWN_MAX_FRACTION = 0.90;

/** Margin in px beyond the viewport for offscreen spawn. */
export const STRIKE_SPAWN_OUTWARD_MARGIN = 50;

// ── Types ───────────────────────────────────────────────────────────

/**
 * A single orbital strike spawn event computed by the planner.
 */
export interface SpawnEvent {
  /** Spawn x coordinate (px), within viewport bounds. */
  x: number;
  /** Spawn y coordinate (px), within viewport bounds. */
  y: number;
  /** Number of radial burst bullets. */
  burstCount: number;
  /** Fraction of the wave time limit at which this strike should spawn. */
  timeFraction: number;
  /** Absolute spawn time in seconds (`timeFraction * waveTimeLimit`). */
  timeSeconds: number;
}

// ── Core algorithm ──────────────────────────────────────────────────

/**
 * Computes spawn events for a single wave.
 *
 * The algorithm:
 *
 * 1. **Count** starts at 0 and increases by 1 every 5 waves, capped at 4.
 * 2. **Timing**: N strikes divide the wave into N equal segments with
 *    ±10 % jitter, clamped to [0.15, 0.90].
 * 3. **Position**: random x within viewport bounds, y near the player
 *    (lower third of screen) to create a telegraphed threat the player
 *    must react to.
 *
 * @param globalWaveIndex — cumulative 0-based wave index across the campaign.
 * @param gameWidth — viewport width in px.
 * @param gameHeight — viewport height in px.
 * @param waveTimeLimit — wave duration in seconds.
 * @param playerX — approximate player x position (for targeting).
 * @param playerY — approximate player y position (for targeting).
 * @param rng — deterministic random number generator (returns [0, 1)).
 * @returns spawn events for this wave (empty before wave 3).
 */
export function computeSpawns(
  globalWaveIndex: number,
  gameWidth: number,
  gameHeight: number,
  waveTimeLimit: number,
  playerX: number,
  playerY: number,
  rng: () => number,
): SpawnEvent[] {
  // No strikes before wave 3.
  if (globalWaveIndex < STRIKE_SPAWN_START_WAVE) {
    return [];
  }

  // 1. Per-wave count (increases every 5 waves, capped at 4).
  const cycles = Math.floor((globalWaveIndex - STRIKE_SPAWN_START_WAVE) / 5);
  const count = Math.min(
    STRIKE_SPAWN_BASE_COUNT + (cycles + 1) * STRIKE_SPAWN_COUNT_INCREMENT,
    STRIKE_SPAWN_MAX_PER_WAVE,
  );

  if (count === 0) {
    return [];
  }

  // 2. Generate spawn events.
  const events: SpawnEvent[] = [];

  for (let i = 0; i < count; i++) {
    // Base time fraction (equal spacing).
    const baseFraction = (i + 1) / (count + 1);

    // Add jitter.
    const jitter = (rng() - 0.5) * 2 * STRIKE_SPAWN_JITTER_FRACTION;
    const timeFraction = Math.max(
      STRIKE_SPAWN_MIN_FRACTION,
      Math.min(STRIKE_SPAWN_MAX_FRACTION, baseFraction + jitter),
    );

    // Position: near the player but within viewport bounds.
    // X: within ±100 px of player X, clamped to viewport.
    const xOffset = (rng() - 0.5) * 200;
    const x = Math.max(
      50,
      Math.min(gameWidth - 50, playerX + xOffset),
    );

    // Y: lower third of screen (where the player operates).
    const y = Math.max(
      gameHeight * 0.6,
      Math.min(gameHeight - 50, playerY + (rng() - 0.5) * 100),
    );

    // Burst count: 6 by default, can vary.
    const burstCount = 6;

    events.push({
      x,
      y,
      burstCount,
      timeFraction,
      timeSeconds: timeFraction * waveTimeLimit,
    });
  }

  return events;
}

/**
 * Checks whether a strike should spawn at the current time in a wave.
 *
 * @param events — spawn events for this wave.
 * @param currentTime — current time in seconds within the wave.
 * @returns the next spawn event if ready, otherwise null.
 */
export function getNextSpawn(
  events: SpawnEvent[],
  currentTime: number,
): SpawnEvent | null {
  for (const event of events) {
    if (currentTime >= event.timeSeconds) {
      return event;
    }
  }
  return null;
}

/**
 * Marks a spawn event as consumed.
 *
 * @param events — spawn events array (mutated in place).
 * @param event — the event to mark as consumed.
 */
export function markSpawnConsumed(
  events: SpawnEvent[],
  event: SpawnEvent,
): void {
  // Remove the consumed event.
  const index = events.indexOf(event);
  if (index !== -1) {
    events.splice(index, 1);
  }
}

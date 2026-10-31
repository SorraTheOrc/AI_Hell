/**
 * Shared spawn-count registry for the Mystery UFO saucer's lifecycle VFX
 * (parent AH-0MVI4J8R4002WTT6, test-seam item AH-0MVSAJJ8F000ZD5Q).
 *
 * The saucer's feel layer (AH-0MVSAJZOI008TRBB) adds four code-drawn VFX
 * moments — a launch poof, a per-mineral collect sparkle, a return-leg trail
 * and a destruction burst. Counting them through one module-level registry,
 * exactly like `getExplosionVfxCounts` / `resetExplosionVfxCounts` in
 * `explosionParticles.ts`, gives the shared fixtures a single observation
 * point: a test asserts *what the saucer spawned* instead of inspecting
 * private display objects, and the counters reset cleanly between tests.
 *
 * Registry semantics:
 *
 * - **Cumulative spawns, not live objects.** Every {@link recordDroneVfxSpawn}
 *   call adds to its moment's total, so a test can assert "exactly one poof
 *   per launch" after the effect itself has already faded out. (The explosion
 *   registry tracks *live* bursts because the action-intensity metric needs
 *   concurrency; this one answers "how many times did this moment fire".)
 * - **One moment, one counter.** A launched drone increments `launchPoof`
 *   once, each vacuumed mineral increments `collectSparkle` once, the return
 *   leg increments `returnTrail` once per trail spawn, and an enemy
 *   destruction increments `destruction` once for the burst. The destruction
 *   *particles* themselves stay owned by `explosionParticles.ts`; this counter
 *   counts drone destructions, never individual particles.
 * - **Shared by the game and every gym.** The record calls live in the shared
 *   collector-drone pass (`src/scenes/core/combatDrone.ts`) and the shared VFX
 *   modules, so a gym can never drift from the game (AGENTS.md parity rule).
 *
 * The `destruction` counter is recorded by the terminal-feedback slice
 * (AH-0MVSAJVHF007QO6V) from the shared `hitDrone` destructor; the other three
 * moments still read zero until the saucer VFX slice lands — the documented
 * silent baseline the test seams pin (see `src/test/collectorDroneFixtures.ts`).
 *
 * @module vfx/droneVfxCounts
 */

/** The four saucer lifecycle moments that spawn VFX, in lifecycle order. */
export const DRONE_VFX_MOMENTS = [
  'launchPoof',
  'collectSparkle',
  'returnTrail',
  'destruction',
] as const;

/** One saucer VFX moment (see {@link DRONE_VFX_MOMENTS}). */
export type DroneVfxMoment = (typeof DRONE_VFX_MOMENTS)[number];

/** Cumulative spawn count per saucer VFX moment. */
export type DroneVfxCounts = Readonly<Record<DroneVfxMoment, number>>;

/** Module-level counts, shared by the game and every gym. */
const DRONE_VFX_COUNTS: Record<DroneVfxMoment, number> = {
  launchPoof: 0,
  collectSparkle: 0,
  returnTrail: 0,
  destruction: 0,
};

/**
 * Returns a snapshot of the cumulative saucer VFX spawn counts.
 *
 * @returns A fresh object — mutating it never changes the registry.
 */
export function getDroneVfxCounts(): DroneVfxCounts {
  return { ...DRONE_VFX_COUNTS };
}

/**
 * Records `amount` spawn(s) of the given saucer VFX moment.
 *
 * `amount` is coerced to a non-negative integer (fractional or negative
 * values never subtract spawns), so a caller can pass a per-frame count such
 * as "minerals vacuumed this tick" directly. Recording a moment is
 * side-effect free beyond the counter itself: the caller still spawns the
 * visual effect.
 *
 * @param moment - The lifecycle moment that spawned VFX.
 * @param amount - How many spawns to add (default 1).
 */
export function recordDroneVfxSpawn(
  moment: DroneVfxMoment,
  amount = 1,
): void {
  const increment = Number.isFinite(amount) ? Math.floor(Math.max(0, amount)) : 0;
  if (increment === 0) return;
  DRONE_VFX_COUNTS[moment] += increment;
}

/** Resets the shared saucer VFX counts (run-scope reset / test seam). */
export function resetDroneVfxCounts(): void {
  for (const moment of DRONE_VFX_MOMENTS) {
    DRONE_VFX_COUNTS[moment] = 0;
  }
}

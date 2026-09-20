/**
 * Shared deterministic test fixtures for the power-up spawning work
 * (parent AH-0MU3VOQKH005YOBH, feature AH-0MU44M8EI000CPB0).
 *
 * This module is **test infrastructure only** — nothing here is imported
 * by production code. It exists so the downstream items (game-rules
 * config, avoiding placement, combat-gym spawning, live controls) can
 * write deterministic tests without re-inventing:
 *
 * - a seeded / scripted RNG factory (usable by `WeightedRandomSpawner`
 *   and, later, `RandomAvoidingPlacement`);
 * - a stub enemy/player position provider plus an independent overlap
 *   oracle for placement assertions;
 * - helpers that boot each combat gym (`GymEnemies`, `GymBoss`) through
 *   `src/test/gameHarness.ts`.
 *
 * @module test/powerUpTestFixtures
 */

import Phaser from 'phaser';

import { bootScene } from './gameHarness';
import { WeightedRandomSpawner } from '../powerups/spawner';
import type { PowerUpId } from '../powerups/types';
import { GymEnemies, GYM_ENEMIES_DEFAULT_KEY } from '../scenes/gym/GymEnemies';
import { GymBoss } from '../scenes/gym/GymBoss';

// ── Seeded / scripted RNG ───────────────────────────────────────────

/**
 * Creates a deterministic pseudo-random number generator (mulberry32)
 * seeded by *seed*.
 *
 * The returned function yields values in the half-open interval
 * `[0, 1)`, matching the `() => number` contract accepted by
 * `WeightedRandomSpawner` (and, later, the placement strategy). Two
 * generators constructed with the same seed always produce the same
 * sequence — the property that makes the downstream spawn/placement
 * tests reproducible.
 *
 * @param seed - Any 32-bit integer (coerced to unsigned).
 * @returns A deterministic `() => number` RNG.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates an RNG that returns *values* in order, repeating the final
 * value once the script is exhausted.
 *
 * Useful for exercising a specific code path (for example a placement
 * retry that only succeeds on the second attempt) without relying on
 * statistics. An empty script yields `0` every call.
 *
 * @param values - The scripted values, in call order.
 * @returns A scripted `() => number` RNG.
 */
export function createSequenceRng(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    if (values.length === 0) return 0;
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

/**
 * Creates a `WeightedRandomSpawner` over *ids* driven by a seeded RNG,
 * optionally overriding individual weights.
 *
 * The returned spawner is deterministic for a given seed/ids/weights
 * combination, so callers can assert exact drop sequences.
 *
 * @param seed    - Seed for the injected RNG.
 * @param ids     - Power-up IDs the spawner may yield.
 * @param weights - Optional per-ID weight overrides (unset IDs keep the
 *                  spawner's equal default weight of 1).
 * @returns A seeded `WeightedRandomSpawner`.
 */
export function createSeededWeightedSpawner(
  seed: number,
  ids: readonly PowerUpId[],
  weights: Partial<Record<PowerUpId, number>> = {},
): WeightedRandomSpawner {
  const spawner = new WeightedRandomSpawner([...ids], createSeededRng(seed));
  for (const [id, weight] of Object.entries(weights)) {
    if (weight === undefined) continue;
    spawner.setWeight(id as PowerUpId, weight);
  }
  return spawner;
}

// ── Stub enemy/player positions ─────────────────────────────────────

/** A circular body (enemy or player) used by placement assertions. */
export interface StubBody {
  /** World-space centre x (px). */
  x: number;
  /** World-space centre y (px). */
  y: number;
  /** Collision radius (px). */
  radius: number;
}

/** A snapshot of the bodies a placement strategy must avoid. */
export interface StubCombatPositions {
  /** Live enemy bodies (may be empty). */
  enemies: StubBody[];
  /** The player body. */
  player: StubBody;
}

/**
 * Creates a stub body with the given centre and (optional) radius.
 *
 * @param x      - Centre x (px).
 * @param y      - Centre y (px).
 * @param radius - Collision radius (px); defaults to 20.
 * @returns A `StubBody`.
 */
export function stubBody(x: number, y: number, radius = 20): StubBody {
  return { x, y, radius };
}

/**
 * Creates a stub combat-positions snapshot for placement tests.
 *
 * Defaults to an empty enemy list and a centred player body; pass
 * overrides to model a specific scene layout.
 *
 * @param overrides - Optional partial overrides for `enemies`/`player`.
 * @returns A `StubCombatPositions` snapshot.
 */
export function createStubCombatPositions(
  overrides: Partial<StubCombatPositions> = {},
): StubCombatPositions {
  return {
    enemies: overrides.enemies ?? [],
    player: overrides.player ?? stubBody(480, 270, 10),
  };
}

/**
 * Independent overlap oracle: whether two stub bodies overlap.
 *
 * Bodies are treated as circles; they overlap when the centre distance is
 * strictly less than the sum of their radii. Kept deliberately separate
 * from any production collision code so placement tests assert against an
 * independent expectation rather than the implementation under test.
 *
 * @param a - First body.
 * @param b - Second body.
 * @returns True when the bodies overlap.
 */
export function bodiesOverlap(a: StubBody, b: StubBody): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius;
}

/**
 * Whether *candidate* is clear of every body in *bodies*.
 *
 * @param candidate - The candidate body to test.
 * @param bodies    - The bodies that must not overlap the candidate.
 * @returns True when no body overlaps the candidate.
 */
export function isClearOfBodies(
  candidate: StubBody,
  bodies: readonly StubBody[],
): boolean {
  return bodies.every((body) => !bodiesOverlap(candidate, body));
}

// ── Combat-gym boot helpers ─────────────────────────────────────────

/** A booted game plus its typed active scene (caller must destroy `game`). */
export interface BootedGym<TScene> {
  game: Phaser.Game;
  scene: TScene;
}

/**
 * Boots `GymEnemies` through the shared game harness for *enemyKey*.
 *
 * A one-off wrapper subclass injects `init({ enemyKey })` before
 * `create()`, because the harness starts the scene without init data
 * (mirrors the existing `GymEnemies.test.ts` per-seed boot idiom).
 *
 * @param enemyKey - The enemy config key to load; defaults to `scout`.
 * @returns The booted game and its `GymEnemies` scene.
 */
export async function bootCombatGymEnemies(
  enemyKey: string = GYM_ENEMIES_DEFAULT_KEY,
): Promise<BootedGym<GymEnemies>> {
  class GymEnemiesByKey extends GymEnemies {
    override init(): void {
      super.init({ enemyKey });
    }
  }
  // Unique class name avoids Phaser collisions across repeated boots.
  Object.defineProperty(GymEnemiesByKey, 'name', {
    value: `GymEnemiesByKey_${enemyKey}`,
  });
  const booted = await bootScene([
    GymEnemiesByKey as unknown as typeof Phaser.Scene,
  ]);
  return { game: booted.game, scene: booted.scene as unknown as GymEnemies };
}

/**
 * Boots `GymBoss` through the shared game harness.
 *
 * @returns The booted game and its `GymBoss` scene.
 */
export async function bootCombatGymBoss(): Promise<BootedGym<GymBoss>> {
  const booted = await bootScene([GymBoss]);
  return { game: booted.game, scene: booted.scene as unknown as GymBoss };
}

/**
 * Shared deterministic test fixtures for the visible collector-drone path
 * (parent AH-0MV9G113S009B37I, leading task AH-0MVBMPYPB004RP0P).
 *
 * This module is **test infrastructure only** — nothing here is imported by
 * production code. It exists so the downstream drone items (level variables,
 * `MysteryUfoDrone` entity, shared-core lifecycle pass, spawn wiring,
 * gym parity) can write focused, non-duplicated tests without re-inventing:
 *
 * - {@link resolveSeededMineralPositions} / {@link createSeededMineralField}
 *   build a deterministic mineral field, always placed clear of the ship
 *   start, so a seeker never begins by instantly vacuuming a mineral;
 * - {@link createSteppedClock} provides a stepped/mock clock for the
 *   permanent-spawn-timer and lifetime tests (parent AC4);
 * - {@link createMysteryUfoDrop} manufactures a `mystery_ufo` drop that the
 *   shared drop path can collect, so pickup tests drive the same seam the
 *   game and every gym use.
 *
 * ## Test matrix (parent ACs of AH-0MV9G113S009B37I → verifying test)
 *
 * | Parent AC | Behaviour pinned | Verifying test | Lands in |
 * |---|---|---|---|
 * | AC1 | field pickup spawns one drone, never a direct instant mineral payout | `effects.test.ts` mystery_ufo group (survivor contract) + spawn-seam unit test | this item (survivor reframe) + AH-0MVBMQ04X0051002 |
 * | AC2 | seek → collect → return → pay out; lifetime/capacity termination | `MysteryUfoDrone.test.ts` / `src/scenes/core/combatDrone.test.ts` (shared-core) | AH-0MVBMPZFE00382DA, AH-0MVBMPZS90038715 |
 * | AC3 | lifetime/capacity/radius/spawn-interval resolve on the shared curve, monotonic | `powerUpLevels.test.ts` new-axis + monotonic tests | AH-0MVBMPZ2C0008VAE |
 * | AC4 | permanent timer fires at the resolved interval; field pickup spawns exactly one drone | `effects.test.ts` / `CombatCoreScene.test.ts` mock-clock test (`createSteppedClock`) | AH-0MVBMQ04X0051002 |
 * | AC5 | enemy bullet / enemy body destroy; player fire passes through; minerals + 2×level drop | shared-core destruction test | AH-0MVBMPZS90038715 |
 * | AC6 | one shared implementation in `PlayScene` + `GymPowerUpsUtility`; equivalence + gym-parity-docs green | `CombatScene.equivalence.test.ts`, `gymParityDocs.test.ts`, `GymPowerUpsUtility.test.ts` | AH-0MVBMQ0HR0064THH |
 * | AC7 | docs (research §8, GDD catalogue, README, help/HUD) | docs + HUD copy checks | AH-0MVBMQ0UT007O2MX |
 * | AC8 | full project suite passes after the drone lands | `/skill:test` full-suite gate | AH-0MVBMRS4K000TTTP |
 *
 * Fixture → feature consumption: the mineral field is consumed by the
 * seek/collect/destruction tests (AC2/AC5); the stepped clock by the
 * permanent-timer test (AC4); the drop manufacture by the pickup tests
 * (AC1/AC4) and the gym lifecycle test (AC6).
 *
 * @module test/collectorDroneFixtures
 */

import Phaser from 'phaser';

import {
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_SPAWN,
  POWER_UP_DROP_SIZE,
} from '../core/constants';
import { createSeededRng } from '../core/rng';
import { Mineral } from '../entities/Mineral';
import { PowerUp } from '../powerups/PowerUp';
import { drawPowerUpDrop } from '../powerups/icons';
import { bootScene } from './gameHarness';

// ── Seeded mineral-field builder ────────────────────────────────────

/**
 * Default clearance between a seeded mineral and the ship start, matching
 * the gym mineral-field convention (`MINERAL_SEED_CLEARANCE = 60`): a field
 * mineral is never silently collected the moment the scene opens, and the
 * ring stays inside the play area from the centre (PLAYER_SPAWN is centred).
 */
export const COLLECTOR_DRONE_MINERAL_CLEARANCE = 60;

/** Play-area margins kept clear for the seeded field (mirrors the gyms). */
const HUD_TOP_MARGIN = 20;
const EDGE_MARGIN = 20;
const BOTTOM_MARGIN = 120;

/** Options controlling where the seeded mineral field is placed. */
export interface SeededMineralFieldOptions {
  /** Number of minerals to place (default 8). */
  count?: number;
  /** Seed for the deterministic RNG (default 1). */
  seed?: number;
  /** Position the field must keep clear of (default the ship start). */
  clearOf?: { x: number; y: number };
  /** Minimum distance (px) between every mineral and `clearOf`. */
  clearance?: number;
  /** Explicit sampling bounds (defaults to the play area minus margins). */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

/** Resolved play-area bounds used when `options.bounds` is omitted. */
export const DEFAULT_MINERAL_FIELD_BOUNDS = {
  minX: EDGE_MARGIN,
  maxX: GAME_WIDTH - EDGE_MARGIN,
  minY: HUD_TOP_MARGIN,
  maxY: GAME_HEIGHT - BOTTOM_MARGIN,
} as const;

/**
 * Resolves a deterministic set of mineral-field positions from the seed,
 * each at least `clearance` px from `clearOf` and inside `bounds`.
 *
 * A sample that lands inside the clearance disc is pushed radially out
 * onto the clearance ring (deterministic, always in bounds — mirrors the
 * gym `seedMinerals` push-out), so callers never need to re-draw and the
 * returned positions are reproducible for a given seed.
 *
 * @param options - Field options (see {@link SeededMineralFieldOptions}).
 * @returns `count` positions in deterministic order.
 */
export function resolveSeededMineralPositions(
  options: SeededMineralFieldOptions = {},
): Array<{ x: number; y: number }> {
  const count = options.count ?? 8;
  const seed = options.seed ?? 1;
  const clearOf = options.clearOf ?? PLAYER_SPAWN;
  const clearance = options.clearance ?? COLLECTOR_DRONE_MINERAL_CLEARANCE;
  const bounds = options.bounds ?? DEFAULT_MINERAL_FIELD_BOUNDS;
  const rng = createSeededRng(seed);

  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const x = bounds.minX + rng() * (bounds.maxX - bounds.minX);
    const y = bounds.minY + rng() * (bounds.maxY - bounds.minY);
    const distance = Math.hypot(x - clearOf.x, y - clearOf.y);
    // Push a too-close sample radially out onto the clearance ring instead
    // of re-drawing: deterministic, and in bounds because the ring radius
    // stays below the nearest play-area edge from `clearOf`.
    let px = x;
    let py = y;
    if (distance < clearance) {
      if (distance === 0) {
        px = clearOf.x + clearance;
      } else {
        const scale = clearance / distance;
        px = clearOf.x + (x - clearOf.x) * scale;
        py = clearOf.y + (y - clearOf.y) * scale;
      }
    }
    positions.push({ x: px, y: py });
  }
  return positions;
}

/**
 * Independent clearance oracle: whether a point lies at least `clearance`
 * px from `clearOf`. Kept separate from the builder so tests assert the
 * field against an expectation, not the builder's own math.
 */
export function isClearOf(
  point: { x: number; y: number },
  clearOf: { x: number; y: number },
  clearance: number = COLLECTOR_DRONE_MINERAL_CLEARANCE,
): boolean {
  return Math.hypot(point.x - clearOf.x, point.y - clearOf.y) >= clearance;
}

/**
 * Creates `count` live `Mineral`s in `scene` at the deterministic seeded
 * positions (see {@link resolveSeededMineralPositions}). Callers must
 * `game.destroy()` after use.
 *
 * @param scene   - A booted Phaser scene that will own the minerals.
 * @param options - Field options (see {@link SeededMineralFieldOptions}).
 * @returns The created `Mineral` entities (positions mirror the solver).
 */
export function createSeededMineralField(
  scene: Phaser.Scene,
  options: SeededMineralFieldOptions = {},
): Mineral[] {
  const positions = resolveSeededMineralPositions(options);
  return positions.map(
    ({ x, y }) => new Mineral(scene, { x, y }),
  );
}

// ── Stepped / mock clock ────────────────────────────────────────────

/** A deterministic stepped clock sized in seconds for simulation tests. */
export interface SteppedClock {
  /** Current simulated time in seconds. */
  now(): number;
  /** Advances the clock by `dt` seconds and returns the new time. */
  advance(dt: number): number;
  /** Advances one fixed step (default 1/60 s) and returns that dt. */
  step(): number;
  /**
   * Runs `onTick(now)` every fixed step until `seconds` of simulated time
   * have elapsed — the "stepped update" driving the permanent-timer and
   * lifetime assertions (parent AC4). Returns the new clock time.
   */
  run(seconds: number, onTick: (now: number) => void): number;
  /** Resets the clock to zero. */
  reset(): void;
}

/**
 * Creates a stepped/mock clock for timer tests.
 *
 * Time only advances through explicit `advance`/`step`/`run` calls, so a
 * permanent spawn timer, lifetime counter or recharge timer can be driven
 * deterministically without a wall clock or a live Phaser loop.
 *
 * @param stepSeconds - Fixed step size (default 1/60 s ≈ one frame).
 * @returns A `SteppedClock`.
 */
export function createSteppedClock(stepSeconds = 1 / 60): SteppedClock {
  let elapsed = 0;
  return {
    now: () => elapsed,
    advance: (dt: number) => {
      elapsed += dt;
      return elapsed;
    },
    step: () => {
      elapsed += stepSeconds;
      return stepSeconds;
    },
    run: (seconds: number, onTick: (now: number) => void) => {
      const steps = Math.max(0, Math.ceil(seconds / stepSeconds));
      for (let i = 0; i < steps; i += 1) {
        elapsed += stepSeconds;
        onTick(elapsed);
      }
      return elapsed;
    },
    reset: () => {
      elapsed = 0;
    },
  };
}

// ── Mystery UFO drop manufacture ────────────────────────────────────

/** Structural shape of a manufactured `mystery_ufo` drop (mirrors the gym's
 * `ActiveDrop`: lifecycle + position + visuals + unified drop id). */
export interface MysteryUfoDrop {
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
  /** Graphics rendering the glowing bubble + saucer icon (scaled by lifecycle). */
  graphics: Phaser.GameObjects.Graphics;
  /** The drop's grow/hold/shrink/collect lifecycle. */
  powerUp: PowerUp;
  /** Unified drop id the shared collect path dispatches on. */
  dropId: 'mystery_ufo';
  /** True once collected and playing its absorb VFX. */
  absorbing?: boolean;
}

/**
 * Manufactures a `mystery_ufo` drop at `(x, y)`, constructed exactly like
 * the gym's `_spawnDrop` (bubble + saucer icon drawn in local space,
 * starting at scale 0). The drop satisfies the shared `DropLifecycleDrop`
 * seam, so a test can collect it through the same code the game and every
 * gym use (`collectOverlappingDrops` / the scene's collect step).
 *
 * @param scene - The scene owning the drop's graphics.
 * @param x     - World x position (px).
 * @param y     - World y position (px).
 * @returns The manufactured drop.
 */
export function createMysteryUfoDrop(
  scene: Phaser.Scene,
  x: number,
  y: number,
): MysteryUfoDrop {
  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  drawPowerUpDrop(graphics, 'mystery_ufo', 0, 0, POWER_UP_DROP_SIZE);
  graphics.setScale(0);
  return { x, y, graphics, dropId: 'mystery_ufo', powerUp: new PowerUp('mystery_ufo') };
}

/**
 * Advances `drop`'s lifecycle until it is collectible (past the grow phase),
 * so pickup tests can drive the real shared collection gate without
 * hand-advancing a loop everywhere. Returns the same drop for chaining.
 *
 * @param drop  - The manufactured drop to mature.
 * @param dt    - Lifecycle step in seconds (default 0.05 s, like the gym tests).
 * @param steps - Max steps (default 40 → 2 s, comfortably past grow 0.5 s).
 * @returns The same drop, now collectible.
 */
export function makeDropCollectible(
  drop: MysteryUfoDrop,
  dt = 0.05,
  steps = 40,
): MysteryUfoDrop {
  for (let i = 0; i < steps; i += 1) {
    drop.powerUp.advance(dt);
  }
  return drop;
}

// ── Boot harness for fixture smoke tests ────────────────────────────

/** A booted game plus its typed harness scene (caller destroys the game). */
export interface BootedCollectorDroneScene {
  game: Phaser.Game;
  scene: HarnessScene;
}

/** Minimal scene used to own minerals/drop graphics in fixture tests. */
export class HarnessScene extends Phaser.Scene {
  constructor() {
    super('CollectorDroneHarnessScene');
  }
}

/**
 * Boots a `HarnessScene` through the shared game harness.
 *
 * @returns The booted game and its harness scene.
 */
export async function bootCollectorDroneScene(): Promise<BootedCollectorDroneScene> {
  const booted = await bootScene([HarnessScene]);
  return { game: booted.game, scene: booted.scene as unknown as HarnessScene };
}

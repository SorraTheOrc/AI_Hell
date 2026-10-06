/**
 * Shared deterministic test fixtures for the P3/P4 effect-path work
 * (parent AH-0MUVM9RAO004Y3LB).
 *
 * This module is **test infrastructure only** — nothing here is imported by
 * production code. It exists so the multi-hit shield (F2), the bomb model
 * (F3) and the ranged-pulse effect path (F4) can write focused,
 * non-duplicated tests against the same harness:
 *
 * - {@link createEffectRegistry} / {@link createSeededLevelStore} construct
 *   an `EffectsRegistry` bound to a `PowerUpLevelStore` at a chosen upgrade
 *   level, without re-deriving the collection arithmetic in every test.
 * - {@link activateEffectAtUpgradeLevel} starts/refreshes a power-up's timed
 *   effect at a requested upgrade level (field or permanent) and returns the
 *   resolved stats the assertion can compare against.
 * - {@link isWithinBlastRange} / {@link partitionByBlastRange} /
 *   {@link expectRangedClear} give the P4 ranged clear one independent
 *   geometry oracle, so a test asserts observable behaviour rather than
 *   re-implementing the production radius filter.
 * - {@link StubEnemyBullet} / {@link RangedClearTestScene} /
 *   {@link bootRangedClearScene} own the minimal `CombatCoreScene`
 *   participant wiring for a bullet field, so ranged-clear tests never
 *   duplicate scene setup.
 *
 * ## "Within range" contract
 *
 * A bullet is **within** a bomb blast centred on `(cx, cy)` with radius
 * `range` when `distance ≤ range` (inclusive boundary). The oracle and the
 * production `_clearEnemyBulletsInRange` must agree on this convention; a
 * dedicated boundary case pins it.
 *
 * @module test/powerUpEffectFixtures
 */

import { expect } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from './gameHarness';
import { EffectsRegistry } from '../powerups/effects';
import {
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  type PowerUpLevelStats,
} from '../powerups/powerUpLevels';
import type { PowerUpId } from '../powerups/types';
import {
  CombatCoreScene,
  type CombatEnemyBullet,
} from '../scenes/core/CombatCoreScene';

// ── Registry / level-store fixtures ─────────────────────────────────

/** A fresh effects registry plus the run-scoped store it consumes. */
export interface EffectRegistryFixture {
  /** The registry under test. */
  registry: EffectsRegistry;
  /** The level store the registry is bound to. */
  store: PowerUpLevelStore;
}

/** The requested upgrade level per power-up (0 = base). */
export type PowerUpUpgradeLevels = Partial<Record<PowerUpId, number>>;

/** Normalises a level map to `[id, non-negative integer]` entries. */
function levelEntries(
  levels: PowerUpUpgradeLevels,
): Array<[PowerUpId, number]> {
  return Object.entries(levels)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([id, level]) => [id as PowerUpId, Math.max(0, Math.floor(level))]);
}

/**
 * Collects `id` through `store` until its **upgrade level** reaches
 * `upgradeLevel` (0 = base = one collection, per the weapon-parity level
 * semantics documented in `powerUpLevels.ts`).
 *
 * Collections go through the store only, so no timed effect is activated —
 * use {@link activateEffectAtUpgradeLevel} when the effect itself must be
 * live. Idempotent: an already-high-enough level is left untouched.
 *
 * @param store        - The run-scoped store to seed.
 * @param id           - The power-up to level.
 * @param upgradeLevel - The target upgrade level (0 = base).
 */
export function seedUpgradeLevel(
  store: PowerUpLevelStore,
  id: PowerUpId,
  upgradeLevel: number,
): void {
  const targetCollections = Math.max(0, Math.floor(upgradeLevel)) + 1;
  while (store.getLevel(id) < targetCollections) {
    store.collect(id);
  }
}

/**
 * Creates a fresh `PowerUpLevelStore` with the requested upgrade levels
 * pre-applied (no timed effect — this is the pure model fixture used by the
 * bomb range/frequency resolver tests).
 *
 * @param levels - Requested upgrade level per power-up (0 = base).
 * @returns A seeded `PowerUpLevelStore`.
 */
export function createSeededLevelStore(
  levels: PowerUpUpgradeLevels = {},
): PowerUpLevelStore {
  const store = new PowerUpLevelStore();
  for (const [id, level] of levelEntries(levels)) {
    seedUpgradeLevel(store, id, level);
  }
  return store;
}

/**
 * Creates an `EffectsRegistry` bound to a fresh `PowerUpLevelStore` seeded
 * to the requested upgrade levels. No timed effect is activated by the
 * seeding; call {@link activateEffectAtUpgradeLevel} to start one.
 *
 * @param levels - Requested upgrade level per power-up (0 = base).
 * @returns The registry and its store.
 */
export function createEffectRegistry(
  levels: PowerUpUpgradeLevels = {},
): EffectRegistryFixture {
  const store = createSeededLevelStore(levels);
  return { registry: new EffectsRegistry(store), store };
}

/**
 * Collects `id` through the registry until its store's upgrade level
 * reaches `upgradeLevel`, starting (or refreshing) the power-up's timed
 * effect at that level. Intended for a freshly created fixture where the
 * requested power-up has not yet been collected; an already-higher level is
 * left as-is.
 *
 * @param fixture      - The registry/store pair under test.
 * @param id           - The power-up to activate.
 * @param upgradeLevel - The target upgrade level (0 = base).
 * @param options      - `permanent: true` makes the **final** collection the
 *   hold-full (never-expiring) reward, so the effect ends active in its
 *   permanent form with exactly one permanent grant — the realistic run
 *   shape (level up by field pickups, then choose the reward).
 * @returns The resolved stats at the resulting upgrade level.
 */
export function activateEffectAtUpgradeLevel(
  fixture: EffectRegistryFixture,
  id: PowerUpId,
  upgradeLevel: number,
  options: { permanent?: boolean } = {},
): PowerUpLevelStats {
  const targetCollections = Math.max(0, Math.floor(upgradeLevel)) + 1;
  const pending = Math.max(0, targetCollections - fixture.store.getLevel(id));
  for (let i = 0; i < pending; i += 1) {
    const isFinal = i === pending - 1;
    fixture.registry.applyCollect(id, (options.permanent ?? false) && isFinal);
  }
  return fixture.store.stats(id);
}

/** The starting lives count, re-exported so fixtures and tests agree. */
export const FIXTURE_LIVES_START = POWER_UP_LIVES_START;

// ── Ranged-clear geometry oracle ────────────────────────────────────

/** The minimum position/destruction state a ranged-clear assertion reads. */
export interface BlastBulletState {
  /** World-space centre x (px). */
  x: number;
  /** World-space centre y (px). */
  y: number;
  /** True once the bullet has been destroyed by the clear. */
  readonly destroyed: boolean;
}

/** A position-only bullet-like object (for the partition helper). */
export interface PositionedBullet {
  x: number;
  y: number;
}

/**
 * Whether a bullet at `(x, y)` lies within a blast centred on `(cx, cy)`
 * with radius `range`. **Inclusive** boundary (`distance ≤ range`) — the
 * canonical "within range" definition for the P4 bomb.
 */
export function isWithinBlastRange(
  x: number,
  y: number,
  cx: number,
  cy: number,
  range: number,
): boolean {
  return Math.hypot(x - cx, y - cy) <= range;
}

/**
 * Splits `bullets` into those a blast at `(cx, cy, range)` should clear and
 * those it should spare, using the shared inclusive-range oracle.
 *
 * Kept deliberately independent of the production radius filter so a test
 * asserts against an expectation rather than the implementation under test.
 */
export function partitionByBlastRange<T extends PositionedBullet>(
  bullets: readonly T[],
  cx: number,
  cy: number,
  range: number,
): { cleared: T[]; spared: T[] } {
  const cleared: T[] = [];
  const spared: T[] = [];
  for (const bullet of bullets) {
    if (isWithinBlastRange(bullet.x, bullet.y, cx, cy, range)) {
      cleared.push(bullet);
    } else {
      spared.push(bullet);
    }
  }
  return { cleared, spared };
}

/**
 * Asserts a ranged clear behaved correctly: every bullet inside the blast
 * was destroyed and every bullet outside it survived. Uses only observable
 * bullet state, so it works against any bullet field without scene setup.
 *
 * @param bullets - Every bullet present before the clear.
 * @param cx      - Blast centre x (px).
 * @param cy      - Blast centre y (px).
 * @param range   - Blast radius (px, inclusive).
 */
export function expectRangedClear(
  bullets: readonly BlastBulletState[],
  cx: number,
  cy: number,
  range: number,
): void {
  for (const bullet of bullets) {
    const within = isWithinBlastRange(bullet.x, bullet.y, cx, cy, range);
    const expected = within ? 'destroyed' : 'spared';
    expect(
      bullet.destroyed,
      `bullet at (${bullet.x}, ${bullet.y}) should have been ${expected} ` +
        `by a blast at (${cx}, ${cy}) r=${range}`,
    ).toBe(within);
  }
}

// ── Bullet-field scene fixture ──────────────────────────────────────

/**
 * Minimal enemy bullet (graphics + velocity) for the ranged-clear tests.
 * `destroyed` reads Phaser's `GameObject.active`, which `destroy()` clears,
 * so no spy is needed to observe a bullet leaving the field.
 */
export class StubEnemyBullet implements CombatEnemyBullet {
  /** The bullet's display object (destroyed by the clear). */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** Velocity x (px/s) — unused by the clear, present for the contract. */
  vx = 0;
  /** Velocity y (px/s) — unused by the clear, present for the contract. */
  vy = 0;

  constructor(
    scene: Phaser.Scene,
    public x: number,
    public y: number,
  ) {
    this.graphics = scene.add.graphics();
    this.graphics.setPosition(x, y);
  }

  /** True once the bullet's graphics have been destroyed. */
  get destroyed(): boolean {
    return !this.graphics.active;
  }
}

/**
 * A bootable `CombatCoreScene` owning a field of {@link StubEnemyBullet}s.
 *
 * Games/gyms add ranged-clear behaviour through the shared
 * `_clearEnemyBulletsInRange`; this fixture supplies only the minimal
 * participant wiring (`getEnemyBullets`/`setEnemyBullets`) plus bookkeeping,
 * so a ranged-clear test never duplicates scene setup. Subclass it to expose
 * a public wrapper around the protected clear under test.
 */
export class RangedClearTestScene extends CombatCoreScene {
  /** Bullets still on the field (the clear replaces this list). */
  private field: StubEnemyBullet[] = [];
  /** Every bullet ever added, so destroyed ones remain observable. */
  private readonly created: StubEnemyBullet[] = [];

  protected override getEnemyBullets(): readonly StubEnemyBullet[] {
    return this.field;
  }

  protected override setEnemyBullets(bullets: StubEnemyBullet[]): void {
    this.field = bullets;
  }

  /** Adds a bullet at `(x, y)` and returns it. */
  addEnemyBullet(x: number, y: number): StubEnemyBullet {
    const bullet = new StubEnemyBullet(this, x, y);
    this.created.push(bullet);
    this.field.push(bullet);
    return bullet;
  }

  /** Every bullet ever added (destroyed and surviving). */
  createdBullets(): readonly StubEnemyBullet[] {
    return this.created;
  }

  /** Bullets still on the field after a clear. */
  survivingBullets(): readonly StubEnemyBullet[] {
    return this.field;
  }

  /** Bullets removed by a clear (identity comparison against survivors). */
  destroyedBullets(): StubEnemyBullet[] {
    return this.created.filter((bullet) => !this.field.includes(bullet));
  }

  /**
   * Public wrapper for the shared whole-field clear, used to exercise the
   * fixture's bookkeeping without touching the range logic under test.
   */
  runClearEnemyBullets(): void {
    this._clearEnemyBullets();
  }
}

/** A booted game plus its typed {@link RangedClearTestScene}. */
export interface BootedRangedClearScene {
  game: Phaser.Game;
  scene: RangedClearTestScene;
}

/**
 * Boots a {@link RangedClearTestScene} through the shared game harness.
 * Callers must `game.destroy()` after use.
 */
export async function bootRangedClearScene(): Promise<BootedRangedClearScene> {
  const booted = await bootScene([RangedClearTestScene]);
  return {
    game: booted.game,
    scene: booted.scene as unknown as RangedClearTestScene,
  };
}

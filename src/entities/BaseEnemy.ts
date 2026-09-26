/**
 * Shared base class for regular enemy entities.
 *
 * Extracts ~60 % of boilerplate shared across Scout, Diver, Tank, Phaser and
 * Swarm: construction state, destruction teardown, explosion handling,
 * hit-radius calculation, body visibility, aim-target management, and
 * formation-position calculation.
 *
 * Each concrete subclass still defines:
 * - its own config type with type-specific fields / defaults
 * - its `_drawBody()` implementation (unique shape)
 * - its movement modifier (wiggle, dive state machine, hold/move, orbit, drift)
 * - its firing pattern (`tryFire*` methods)
 *
 * @module src/entities/BaseEnemy
 */

import Phaser from 'phaser';

import { HIT_RADIUS_BUFFER_PX } from '../core/constants';
import { loadRules } from '../core/rules';
import {
  FormationOffset,
  FormationPosition,
  computeFormationPosition,
} from '../utils/formations';
import { resolvePatterns, spawnExplosionParticles } from '../vfx/explosionParticles';
import type { ExplosionHandle } from '../vfx/explosionParticles';
import { Mineral, scatterMineralDrops } from './Mineral';

/**
 * Minimal shared config fields accepted by every regular enemy subclass.
 * Type-specific fields (burst count, pause duration, etc.) live on the
 * subclass's config type.
 */
export interface BaseEnemyConfig {
  /** Position within the formation. */
  formationOffset: FormationOffset;
  /** Entity visual half-size in px. */
  size?: number;
  /** Body colour (hex number). */
  color?: number;
  /** Bullet colour (hex number). */
  bulletColor?: number;
  /** Bullet radius in px. */
  bulletSize?: number;
  /** Bullet speed in px/s. */
  bulletSpeed?: number;
  /**
   * Bullet lifetime in seconds (bullets wrap and expire; AH-0MU960UTE001PTV0).
   * Defaults to 1.5 s when omitted.
   */
  bulletLifetime?: number;
  /** Minimum milliseconds between fire attempts. */
  fireInterval?: number;
  /** Probability that a fire cycle produces a shot (0–1). */
  shotProbability?: number;
  /** Random-number generator (defaults to `Math.random`). */
  rng?: () => number;
}

/**
 * Abstract base for all regular (non-Boss) enemy entities.
 *
 * Extends `Phaser.GameObjects.Container` directly — Phaser 3 requires
 * Container inheritance for display-list children.
 */
export abstract class BaseEnemy extends Phaser.GameObjects.Container {
  // ── Shared state (declared here, initialised in subclass constructors) ─

  /** Whether the enemy is currently alive (not yet destroyed). */
  protected _alive = true;

  /** Whether the enemy is allowed to fire. */
  protected _shootEnabled = false;

  /** Timestamp of the last fire attempt (ms). */
  protected _lastFireTime = 0;

  /** Position within the formation, assigned from config. */
  protected readonly formationOffset: FormationOffset;

  // ── Graphics (shared across all regular enemies) ────────────────────

  /** Body rendering layer — unique shape drawn by each subclass. */
  protected readonly bodyGraphics: Phaser.GameObjects.Graphics;

  /** Separate explosion particle layer. */
  protected readonly explosionGraphics: Phaser.GameObjects.Graphics;

  /** Live particle-explosion handles (SHUTDOWN-safe teardown in destroy()). */
  protected readonly explosionHandles: ExplosionHandle[] = [];

  // ── Common config fields (with shared defaults) ────────────────────

  /** Entity visual half-size in px. */
  protected readonly _size: number;

  /** Body colour (hex number). */
  protected readonly _color: number;

  /** Bullet colour (hex number). */
  protected readonly _bulletColor: number;

  /** Bullet radius in px. */
  protected readonly _bulletSize: number;

  /** Bullet speed in px/s. */
  protected readonly _bulletSpeed: number;

  /** Bullet lifetime in seconds (wrap + expiry; AH-0MU960UTE001PTV0). */
  protected readonly _bulletLifetime: number;

  /** Minimum milliseconds between fire attempts. */
  protected readonly _fireInterval: number;

  /** Probability that a fire cycle produces a shot (0–1). */
  protected readonly _shotProbability: number;

  /** Random-number generator. */
  protected readonly _rng: () => number;

  // ── Abstract method: pattern name for explosion VFX ────────────────

  /**
   * Returns the VFX pattern name used by `spawnExplosionParticles` for
   * this enemy type (e.g. `'scout'`, `'diver'`, `'tank'`, `'phaser'`, `'swarm'`).
   */
  protected abstract getExplosionPatternName(): string;

  // ── Constructor ────────────────────────────────────────────────────

  /**
   * Create the shared base. Subclasses call `super()` with `scene, x, y, config`
   * then set up their type-specific fields and graphics.
   *
   * @param scene — Phaser scene
   * @param x — initial x position
   * @param y — initial y position
   * @param config — shared config fields (type-specific fields are subclass-only)
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    config: BaseEnemyConfig,
  ) {
    super(scene, x, y);

    this.formationOffset = config.formationOffset;
    this._size = config.size ?? 16;
    this._color = config.color ?? 0x000000;
    this._bulletColor = config.bulletColor ?? 0xffffff;
    this._bulletSize = config.bulletSize ?? 3;
    this._bulletSpeed = config.bulletSpeed ?? 200;
    this._bulletLifetime = config.bulletLifetime ?? 1.5;
    this._fireInterval = config.fireInterval ?? 1000;
    this._shotProbability = config.shotProbability ?? 1.0;
    this._rng = config.rng ?? Math.random;

    // Shared graphics — created here but NOT added to the container.
    // Each subclass adds them in the correct render order (body first,
    // then explosion) to preserve the original visual layering.
    this.bodyGraphics = scene.add.graphics();
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(2);
  }

  /**
   * Adds the shared body + explosion graphics to this container in the
   * canonical render order (body first, explosion second). Subclasses
   * with extra graphics layers call this before adding their own layers.
   */
  protected addSharedGraphics(): void {
    this.bodyGraphics.setDepth(1);
    this.add(this.bodyGraphics);
    this.add(this.explosionGraphics);
  }

  // ── Subclass hook: draw unique body shape ──────────────────────────

  /**
   * Each subclass overrides this to draw its unique body shape
   * (chevron, dart, hexagon, ring, diamond). Called once during
   * construction and optionally re-called if the body needs redrawing.
   */
  protected abstract _drawBody(): void;

  // ── Shared lifecycle ───────────────────────────────────────────────

  /**
   * Mark this enemy as destroyed: set alive flag, hide body, trigger explosion.
   * This is the single entry point for destruction — the scene calls it
   * when the enemy collides with a player bullet. Subclasses may override
   * `hideBody()` to hide type-specific graphics.
   */
  destroySelf(scale = 1): void {
    if (!this._alive) return;
    this._alive = false;
    this.hideBody();
    this.playExplosion(scale);
  }

  /**
   * Hook for subclasses to hide body graphics on destruction.
   * The default implementation hides `bodyGraphics`.
   */
  protected hideBody(): void {
    this.bodyGraphics.setAlpha(0);
  }

  /**
   * Play the destruction explosion animation.
   * Audio is played by the scene at destruction time, not here
   * (design doc §7).
   *
   * @param scale — explosion geometry scale factor (1 = normal; the wave
   *   time-limit penalty uses 10, AH-0MU7JTG9R002ZWA6).
   */
  playExplosion(scale = 1): void {
    // Belt-and-braces null-scene guard (AH-0MTPLHLZ3006MOC4): a destroyed
    // display-list child has `scene === undefined`; animating it here would
    // dereference undefined. Normal single-run destruction keeps the old
    // behaviour exactly (the guard never triggers on a live object).
    if (!this.scene) return;
    const scene = this.scene as Phaser.Scene;
    const handle = spawnExplosionParticles(
      scene,
      this.x,
      this.y,
      this._color,
      this._size,
      { patterns: resolvePatterns(this.getExplosionPatternName()), scale },
    );
    if (handle) this.explosionHandles.push(handle);
  }

  /** Hit radius for collision detection. */
  getHitRadius(): number {
    return Math.ceil(this._size / 2 + HIT_RADIUS_BUFFER_PX);
  }

  /** Whether the body graphics is currently visible. */
  get bodyVisible(): boolean {
    return this.bodyGraphics.alpha > 0 && this.bodyGraphics.visible;
  }

  /** Whether the enemy is alive. */
  get alive(): boolean {
    return this._alive;
  }

  // ── Mineral accounting (AH-0MUBVGI62004ED9Q) ─────────────────────

  /** Number of minerals this enemy has absorbed. */
  private _mineralCount = 0;

  /** Number of minerals this enemy has absorbed (for tests/scene wiring). */
  get mineralCount(): number {
    return this._mineralCount;
  }

  /**
   * Absorb one mineral, incrementing the tracked count. Asteroids override
   * this as a no-op — they are excluded from mineral collection.
   */
  collectMineral(): void {
    this._mineralCount += 1;
  }

  /**
   * Number of minerals to re-drop when this enemy is destroyed — a value in
   * the configured 25–50 % fraction range of the collected count, never
   * exceeding it. An enemy that collected nothing re-drops nothing.
   *
   * @param rng — random-number generator (defaults to `Math.random`);
   *   injected by tests for deterministic bounds checking.
   */
  mineralRedropCount(rng: () => number = Math.random): number {
    if (this._mineralCount <= 0) return 0;

    const rules = loadRules();
    const low = Math.floor(this._mineralCount * rules.mineralRedropFractionMin);
    const high = Math.floor(this._mineralCount * rules.mineralRedropFractionMax);

    // Clamp the inclusive integer range to the collected count.
    const cappedHigh = Math.min(high, this._mineralCount);
    const cappedLow = Math.min(Math.max(low, 0), cappedHigh);
    if (cappedHigh <= cappedLow) return cappedLow;

    const draw = cappedLow + Math.floor(rng() * (cappedHigh - cappedLow + 1));
    return Math.min(Math.max(draw, cappedLow), cappedHigh);
  }

  /**
   * Spawn the re-dropped minerals scattered at the explosion site. Each drop
   * lands within {@link MINERAL_REDROP_SCATTER_RADIUS} px of `(x, y)`. Returns
   * the spawned minerals, or an empty array when nothing is to be re-dropped
   * (or the enemy is no longer attached to a scene).
   *
   * @param x — explosion-site x position
   * @param y — explosion-site y position
   * @param rng — random-number generator (defaults to `Math.random`)
   */
  spawnMineralDrops(
    x: number,
    y: number,
    rng: () => number = Math.random,
  ): Mineral[] {
    const count = this.mineralRedropCount(rng);
    const scene = this.scene as Phaser.Scene | undefined;
    if (!scene) return [];
    // Shared scatter maths (single definition in Mineral.ts, also used by the
    // shared kill-drop rule) keeps the RNG draw order unchanged.
    return scatterMineralDrops(scene, x, y, count, rng);
  }

  /** Whether the enemy is allowed to fire. */
  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  /** Set whether the enemy is allowed to fire. */
  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
  }

  /**
   * Full destruction teardown. Each subclass overrides `destroyGraphics()`
   * to destroy its type-specific graphics objects; the base class handles
   * the shared ones.
   */
  destroy(fromScene?: boolean): void {
    this.destroyGraphics();
    this.explosionGraphics.destroy();
    for (const handle of this.explosionHandles) handle.destroy();
    this.explosionHandles.length = 0;
    super.destroy(fromScene);
  }

  /**
   * Hook for subclasses to destroy type-specific graphics.
   * The default implementation destroys only `bodyGraphics`.
   */
  protected destroyGraphics(): void {
    this.bodyGraphics.destroy();
  }

  // ── Formation position ─────────────────────────────────────────────

  /**
   * Compute the base formation position for this enemy.
   * Each subclass adds its own movement modifier on top.
   */
  computeFormationPosition(
    baseX: number,
    baseY: number,
    spacingX: number,
    spacingY: number,
  ): FormationPosition {
    return computeFormationPosition(
      baseX, baseY,
      this.formationOffset,
      spacingX, spacingY,
    );
  }

  /** Current formation offset (copy). */
  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }
}

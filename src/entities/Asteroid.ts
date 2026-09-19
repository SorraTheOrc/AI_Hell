/**
 * Asteroid enemy entity (GDD §4.1 — E6 Asteroid).
 *
 * Renders as a jagged procedural neon polygon. Moves in a straight line at
 * constant speed (no formation drift, no wiggle, no state machine), wraps
 * around all four screen edges, rotates continuously, and never fires.
 *
 * Comes in three size tiers — `large`, `medium`, `small` — each with distinct
 * sizes, speeds, rotation rates, and colours. Destroying a `large` asteroid
 * spawns two `medium` children; destroying a `medium` spawns two `small`
 * children. `small` asteroids destroy cleanly with no children. The total
 * chain from one large asteroid is 1 + 2 + 4 = 7 destroyed enemies.
 *
 * Asteroids never fire bullets, including at Level 4+ (`shootEnabled` has no
 * effect; effective shot pattern is always `'none'`). They pass through other
 * enemies (GDD §2.6 — no enemy–enemy collision) but a collision with the
 * player is destructive to the player (reuses the existing enemy-body
 * collision model, GDD §2.3).
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation, and is
 * removed.
 *
 * Audio (GDD §7.3): destruction audio is owned by the base scene
 * (`playDestructionSound()`), not by this entity (no double-play).
 *
 * @module src/entities/Asteroid
 */

import Phaser from 'phaser';

import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import type { FormationOffset } from '../utils/formations';
import { EnemyShotPattern } from '../core/enemyConfig';

// ── Visual / behaviour tuning (per ACs) ────────────────────────────

/** Asteroid body colour — neon grey per GDD §4.1 art direction. */
export const ASTEROID_COLOR = 0x888888;

// ── Size tier constants ────────────────────────────────────────────

/** Large asteroid half-size in px. */
export const ASTEROID_LARGE_SIZE = 28;
/** Large asteroid speed in px/s. */
export const ASTEROID_LARGE_SPEED = 18;
/** Large asteroid rotation speed in rad/s. */
export const ASTEROID_LARGE_ROTATION_SPEED = 0.5;
/** Large asteroid colour. */
export const ASTEROID_LARGE_COLOR = 0x888888;

/** Medium asteroid half-size in px. */
export const ASTEROID_MEDIUM_SIZE = 18;
/** Medium asteroid speed in px/s. */
export const ASTEROID_MEDIUM_SPEED = 27;
/** Medium asteroid rotation speed in rad/s. */
export const ASTEROID_MEDIUM_ROTATION_SPEED = 0.9;
/** Medium asteroid colour. */
export const ASTEROID_MEDIUM_COLOR = 0xaaaa88;

/** Small asteroid half-size in px. */
export const ASTEROID_SMALL_SIZE = 12;
/** Small asteroid speed in px/s. */
export const ASTEROID_SMALL_SPEED = 36;
/** Small asteroid rotation speed in rad/s. */
export const ASTEROID_SMALL_ROTATION_SPEED = 1.4;
/** Small asteroid colour. */
export const ASTEROID_SMALL_COLOR = 0xccccaa;

/** Asteroid colour mapping by size tier. */
export const ASTEROID_COLORS: Record<AsteroidSizeTier, number> = {
  large: ASTEROID_LARGE_COLOR,
  medium: ASTEROID_MEDIUM_COLOR,
  small: ASTEROID_SMALL_COLOR,
};

// ── Size tier type ─────────────────────────────────────────────────

/** The three size tiers for asteroids. */
export type AsteroidSizeTier = 'large' | 'medium' | 'small';

// ── Tier data lookup ───────────────────────────────────────────────

interface AsteroidTierData {
  size: number;
  speed: number;
  rotationSpeed: number;
  color: number;
}

export const ASTEROID_TIER_DATA: Record<AsteroidSizeTier, AsteroidTierData> = {
  large: {
    size: ASTEROID_LARGE_SIZE,
    speed: ASTEROID_LARGE_SPEED,
    rotationSpeed: ASTEROID_LARGE_ROTATION_SPEED,
    color: ASTEROID_LARGE_COLOR,
  },
  medium: {
    size: ASTEROID_MEDIUM_SIZE,
    speed: ASTEROID_MEDIUM_SPEED,
    rotationSpeed: ASTEROID_MEDIUM_ROTATION_SPEED,
    color: ASTEROID_MEDIUM_COLOR,
  },
  small: {
    size: ASTEROID_SMALL_SIZE,
    speed: ASTEROID_SMALL_SPEED,
    rotationSpeed: ASTEROID_SMALL_ROTATION_SPEED,
    color: ASTEROID_SMALL_COLOR,
  },
};

// ── Split child spec ───────────────────────────────────────────────

/** Specification for a child asteroid spawned by a split. */
export interface AsteroidSplitChild {
  /** The size tier of the child. */
  sizeTier: AsteroidSizeTier;
  /** Velocity vector (px/s). */
  vx: number;
  vy: number;
  /** Rotation speed in rad/s. */
  rotationSpeed: number;
  /** The x position where the child should be spawned. */
  x: number;
  /** The y position where the child should be spawned. */
  y: number;
}

// ── Config ─────────────────────────────────────────────────────────

export interface AsteroidConfig {
  x: number;
  y: number;
  /** Offset within the (non-existent) formation; required by the base class. */
  formationOffset: FormationOffset;
  /** Optional config-driven overrides; when absent the tier defaults are used. */
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  fireInterval?: number;
  shotProbability?: number;
  rng?: () => number;
  /** Size tier — overrides the default for this entity. */
  sizeTier?: AsteroidSizeTier;
  /** Initial velocity x (px/s); honours split-child specs (default: random heading). */
  vx?: number;
  /** Initial velocity y (px/s); honours split-child specs (default: random heading). */
  vy?: number;
  /** Rotation speed in rad/s (default: tier-derived). */
  rotationSpeed?: number;
}

// ── Asteroid entity class ──────────────────────────────────────────

/**
 * A free-roaming, splitting asteroid enemy.
 *
 * Moves in a straight line at constant speed with four-edge screen wrap
 * (matching the classic Asteroids model). Never fires bullets. Splits into
 * two smaller asteroids when destroyed (for large and medium tiers).
 */
export class Asteroid extends BaseEnemy {
  /** The current size tier of this asteroid. */
  readonly sizeTier: AsteroidSizeTier;

  /** Rotation speed in radians per second (size-scaled). */
  readonly rotationSpeed: number;

  /** Current velocity vector (constant; does not change over time). */
  private readonly _vx: number;
  private readonly _vy: number;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: AsteroidConfig) {
    // Determine the size tier (config override or default to large).
    const tier = config.sizeTier ?? 'large';
    const tierData = ASTEROID_TIER_DATA[tier];

    // Build the shared base config, applying tier defaults for omitted fields.
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? tierData.size,
      color: config.color ?? tierData.color,
      bulletColor: config.bulletColor,
      bulletSize: config.bulletSize,
      bulletSpeed: config.bulletSpeed,
      fireInterval: config.fireInterval,
      shotProbability: config.shotProbability,
      rng: config.rng,
    };

    super(scene, config.x, config.y, baseConfig);

    this.sizeTier = tier;
    const size = config.size ?? tierData.size;

    // Rotation/speed scale proportionally to the effective size so a
    // custom size (config override) preserves the tier's feel; with the
    // canonical tier size the ratio is 1 and the tier constants win.
    const scale = size / tierData.size;
    this.rotationSpeed =
      config.rotationSpeed ?? tierData.rotationSpeed * scale;

    // Split-child spawns supply an exact velocity vector; otherwise a
    // constant velocity vector is computed from a random heading.
    if (config.vx !== undefined && config.vy !== undefined) {
      this._vx = config.vx;
      this._vy = config.vy;
    } else {
      const angle = Math.random() * Math.PI * 2;
      const speed = tierData.speed * scale;
      this._vx = Math.cos(angle) * speed;
      this._vy = Math.sin(angle) * speed;
    }

    // Draw the unique body shape and add the shared graphics in the
    // canonical render order (body then explosion).
    this._drawBody();
    this.addSharedGraphics();
  }

  /** VFX pattern name for Asteroid explosions. */
  protected getExplosionPatternName(): string {
    return 'swarm'; // Reuse the swarm particle pattern — it's a good fit for rock explosions.
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draw a jagged polygon to represent the asteroid body.
   * The shape is procedurally generated from a small set of vertices
   * with randomised offsets, giving each asteroid a distinctive
   * rocky appearance.
   */
  protected _drawBody(): void {
    this.bodyGraphics.clear();
    const half = this._size / 2;

    this.bodyGraphics.lineStyle(2, this._color, 1);

    // Generate 7–9 jagged vertices for the polygon.
    const numVertices = 7 + Math.floor(this._rng() * 3);
    const radius = half;
    const angles: number[] = [];

    // Distribute angles somewhat evenly with some jitter.
    for (let i = 0; i < numVertices; i++) {
      const baseAngle = (i / numVertices) * Math.PI * 2;
      const jitter = (Math.random() - 0.5) * 0.4; // ±0.2 rad jitter
      angles.push(baseAngle + jitter);
    }

    // Compute vertices with radial variation.
    const vertices: { x: number; y: number }[] = [];
    for (const angle of angles) {
      const radialVariation = 0.7 + Math.random() * 0.3; // 0.7–1.0 × radius
      vertices.push({
        x: Math.cos(angle) * radius * radialVariation,
        y: Math.sin(angle) * radius * radialVariation,
      });
    }

    // Draw the jagged polygon.
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(vertices[0].x, vertices[0].y);
    for (let i = 1; i < vertices.length; i++) {
      this.bodyGraphics.lineTo(vertices[i].x, vertices[i].y);
    }
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
  }

  // ── Public state ─────────────────────────────────────────────────

  /** Effective config-driven size (for tests). */
  get effectiveSize(): number {
    return this._size;
  }

  /** Effective config-driven body colour (for tests). */
  get effectiveColor(): number {
    return this._color;
  }

  /** The current size tier. */
  getSizeTier(): AsteroidSizeTier {
    return this.sizeTier;
  }

  /** Current velocity x (px/s). */
  get vx(): number {
    return this._vx;
  }

  /** Current velocity y (px/s). */
  get vy(): number {
    return this._vy;
  }

  /** Rotation speed in rad/s. */
  get currentRotationSpeed(): number {
    return this.rotationSpeed;
  }

  // ── No-fire guarantee ────────────────────────────────────────────

  /**
   * Override the shootEnabled getter/setter pair: asteroids never fire
   * bullets regardless of the value passed in. Overriding only the setter
   * would shadow the base accessor pair and leave reads undefined, so both
   * halves of the pair are overridden (setter is a no-op, getter is false).
   */
  get shootEnabled(): boolean {
    return false;
  }

  set shootEnabled(_value: boolean) {
    // No-op — asteroids never fire.
  }

  /**
   * Effective shot pattern is always 'none' for asteroids.
   * This is a read-only getter that cannot be overridden.
   */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'none';
  }

  /** Whether this enemy uses formation-based movement. Asteroids do not. */
  isFormationEnemy(): boolean {
    return false;
  }

  // ── Split behaviour ──────────────────────────────────────────────

  /**
   * Returns split child specifications for this asteroid based on its size tier.
   *
   * - `large` → 2 medium children with different directions
   * - `medium` → 2 small children with different directions
   * - `small` → null (no children, clean destruction)
   *
   * Child directions are computed to differ from the parent's heading
   * by at least π/3 radians, and from each other by at least π/3 radians.
   *
   * @param x — x position for the children to spawn at
   * @param y — y position for the children to spawn at
   */
  getSplitChildren(x: number, y: number): AsteroidSplitChild[] | null {
    if (this.sizeTier === 'small') {
      return null;
    }

    // Determine the child tier.
    const childTier: AsteroidSizeTier =
      this.sizeTier === 'large' ? 'medium' : 'small';
    const childData = ASTEROID_TIER_DATA[childTier];

    // Compute two new directions that differ from the parent's heading
    // and from each other (angular separation ≥ π/3).
    const parentAngle = Math.atan2(this._vy, this._vx);
    const deviation = Math.PI / 3 + (Math.random() * Math.PI) / 3; // π/3 to 2π/3

    const angle1 = parentAngle + deviation;
    const angle2 = parentAngle - deviation;

    // Use the child tier's speed.
    const childSpeed = childData.speed;

    return [
      {
        sizeTier: childTier,
        vx: Math.cos(angle1) * childSpeed,
        vy: Math.sin(angle1) * childSpeed,
        rotationSpeed: childData.rotationSpeed,
        x,
        y,
      },
      {
        sizeTier: childTier,
        vx: Math.cos(angle2) * childSpeed,
        vy: Math.sin(angle2) * childSpeed,
        rotationSpeed: childData.rotationSpeed,
        x,
        y,
      },
    ];
  }

  // ── Movement ─────────────────────────────────────────────────────

  /**
   * Constant-speed straight-line motion with screen-edge wrapping.
   *
   * Updates the asteroid's position based on its constant velocity
   * vector and wraps around all four screen edges (matching the
   * player ship's existing wrap model).
   *
   * @param dt — elapsed time in seconds
   */
  updatePosition(dt: number): void {
    if (!this._alive) return;

    // Get screen dimensions from the scene.
    if (!this.scene) return;
    const scene = this.scene as Phaser.Scene;
    const gameWidth = scene.scale.width;
    const gameHeight = scene.scale.height;

    // Rotate continuously (size-scaled: small rotates fastest).
    this.rotation += this.rotationSpeed * dt;

    // Update position.
    this.x += this._vx * dt;
    this.y += this._vy * dt;

    // Screen-edge wrapping.
    if (this.x < 0) this.x += gameWidth;
    if (this.x > gameWidth) this.x -= gameWidth;
    if (this.y < 0) this.y += gameHeight;
    if (this.y > gameHeight) this.y -= gameHeight;
  }

  /**
   * Override: asteroids do not participate in formation movement.
   * This method is a no-op — the asteroid manages its own position
   * via `updatePosition()`.
   */
  applyFormationPosition(
    _baseX: number,
    _baseY: number,
    _dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    // No-op — asteroids move independently.
  }
}

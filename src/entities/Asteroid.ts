/**
 * Asteroid enemy entity (GDD §4.1 — E6 Asteroid).
 *
 * Renders a jagged neon polygon drawn from a **shared silhouette palette**:
 * each size tier owns a fixed set of 8–12 seeded shapes baked once into one
 * texture atlas (`src/utils/asteroidTextures.ts`), and each asteroid picks its
 * variant deterministically from its own seeded RNG
 * (AH-0MW5088LA007XYQM). Every rock therefore renders as one batched sprite
 * sharing a single texture instead of a unique baked texture (or a per-frame
 * `Graphics` fallback) per rock. Moves in a straight line at
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

import { BaseEnemy, BaseEnemyConfig, BakedBodyFrame } from './BaseEnemy';
import type { FormationOffset } from '../utils/formations';
import {
  acquireAsteroidPalette,
  asteroidPaletteShapes,
  asteroidVariantFromDraws,
  drawAsteroidSilhouette,
} from '../utils/asteroidTextures';
import { EnemyShotPattern } from '../core/enemyConfig';

// ── Visual / behaviour tuning (per ACs) ────────────────────────────

/** Asteroid body colour — neon grey per GDD §4.1 art direction. */
export const ASTEROID_COLOR = 0x888888;

// ── Size tier constants ────────────────────────────────────────────

/** Large asteroid half-size in px. */
export const ASTEROID_LARGE_SIZE = 42;
/** Large asteroid speed in px/s. */
export const ASTEROID_LARGE_SPEED = 18;
/** Large asteroid rotation speed in rad/s. */
export const ASTEROID_LARGE_ROTATION_SPEED = 0.5;
/** Large asteroid colour. */
export const ASTEROID_LARGE_COLOR = 0x888888;

/** Medium asteroid half-size in px. */
export const ASTEROID_MEDIUM_SIZE = 27;
/** Medium asteroid speed in px/s. */
export const ASTEROID_MEDIUM_SPEED = 27;
/** Medium asteroid rotation speed in rad/s. */
export const ASTEROID_MEDIUM_ROTATION_SPEED = 0.9;
/** Medium asteroid colour. */
export const ASTEROID_MEDIUM_COLOR = 0xaaaa88;

/** Small asteroid half-size in px. */
export const ASTEROID_SMALL_SIZE = 18;
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
  /**
   * Hit points before the enemy is destroyed (data-driven;
   * AH-0MUI820PM0038HS2). Defaults to `1` (single-hit).
   */
  /**
   * Remaining enemy force-field hits at spawn (epic AH-0MVJ8W4GE007OMNT
   * AC2; resolved once by `enemyForceFieldHits`). Defaults to `0`
   * (unshielded), so an entity built without a field behaves exactly as
   * today.
   */
  forceFieldHits?: number;
  health?: number;
  /**
   * Whether this enemy is aware of the playfield seam (AH-0MV9G3DZ9003P7P8).
   * Absent resolves to `true` (seam-awareness is the default); the classic
   * arcade exclusions (`march`, `centipede`) carry an explicit `false` via
   * the shared factory thread.
   */
  wrapAware?: boolean;
  rng?: () => number;
  /** Size tier — overrides the default for this entity. */
  sizeTier?: AsteroidSizeTier;
  /** Initial velocity x (px/s); honours split-child specs (default: random heading). */
  vx?: number;
  /** Initial velocity y (px/s); honours split-child specs (default: random heading). */
  vy?: number;
  /** Rotation speed in rad/s (default: tier-derived). */
  rotationSpeed?: number;
  /**
   * When true, the asteroid spawns fully offscreen and does not wrap until
   * its centre has entered the viewport, so it visibly drifts inward
   * instead of being teleported to the opposite edge. Defaults to false
   * (wrapping from the first frame), preserving onscreen spawns.
   */
  enterFromOffscreen?: boolean;
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

  /**
   * Asteroids advance their own constant straight-line motion, so the
   * wormhole transit interpolation must not override their position; they
   * still emerge at the wormhole origin and drift out from there
   * (AH-0MV8BSMXC0097KLW).
   */
  readonly autonomousPositioning = true;

  /**
   * True once an offscreen spawn has entered the viewport (or immediately
   * for onscreen spawns). While false, `updatePosition` skips wrapping so
   * the asteroid can drift in from beyond the edge.
   */
  private _enteredViewport: boolean;

  /**
   * Index of this asteroid's silhouette in the shared per-tier palette
   * (AH-0MW5088LA007XYQM). Derived from the draws this asteroid takes from its
   * own seeded RNG stream — see `_drawBody()` — so a seeded run reproduces
   * every rock's look without consuming any extra randomness.
   */
  private _shapeVariant = 0;

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
      health: config.health,
      forceFieldHits: config.forceFieldHits,
      wrapAware: config.wrapAware,
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
    // constant velocity vector is computed from a seeded random heading
    // (AH-0MUY08V6W001SJJN).
    if (config.vx !== undefined && config.vy !== undefined) {
      this._vx = config.vx;
      this._vy = config.vy;
    } else {
      const angle = this._rng() * Math.PI * 2;
      const speed = tierData.speed * scale;
      this._vx = Math.cos(angle) * speed;
      this._vy = Math.sin(angle) * speed;
    }

    // Offscreen spawns defer wrapping until the centre enters the viewport.
    this._enteredViewport = !config.enterFromOffscreen;

    // Draw this asteroid's palette silhouette (the atlas bake source/record)
    // and add the shared graphics in the canonical render order (body then
    // explosion).
    this._drawBody();
    this.addSharedGraphics();
  }

  /** VFX pattern name for Asteroid explosions. */
  /** Archetype key (`'asteroid'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'asteroid';
  }

  protected getExplosionPatternName(): string {
    return 'swarm'; // Reuse the swarm particle pattern — it's a good fit for rock explosions.
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draw the asteroid body, selecting one silhouette from the **shared**
   * per-tier palette (AH-0MW5088LA007XYQM).
   *
   * The shape is no longer unique per rock: the palette holds 8–12 jagged
   * silhouettes per tier, baked once into one texture atlas, and each asteroid
   * picks its variant from its own seeded RNG. The drawn `Graphics` below is
   * the silhouette's record — the same polygon the atlas frame is baked from —
   * and is what the entity renders only when the scene cannot bake textures.
   *
   * **RNG determinism (AC4):** the draws consumed here are exactly the draws
   * the pre-palette unique-shape generator took — one for the vertex count plus
   * two per vertex — because only *how the shape is chosen* changed, not how
   * much randomness it spends. The next consumer of the stream (the next
   * asteroid's heading, a split fan, an enemy fire roll) therefore sees the
   * same values it always did.
   */
  protected _drawBody(): void {
    this.bodyGraphics.clear();

    const draws: number[] = [];
    const numVertices = 7 + Math.floor(this._rng() * 3);
    draws.push(numVertices);
    for (let index = 0; index < numVertices; index += 1) {
      draws.push(this._rng()); // angular jitter
      draws.push(this._rng()); // radial variation
    }
    this._shapeVariant = asteroidVariantFromDraws(draws);

    const tierData = ASTEROID_TIER_DATA[this.sizeTier];
    const silhouette = asteroidPaletteShapes(ASTEROID_TIER_DATA)[
      this.sizeTier
    ][this._shapeVariant];
    drawAsteroidSilhouette(
      this.bodyGraphics,
      silhouette,
      this._size / tierData.size,
      this._color,
    );
  }

  /**
   * Render the body from the shared asteroid atlas (AC1/AC3).
   *
   * Every asteroid renders from the **one** palette texture, so the field
   * batches into a single texture bind and never grows the per-silhouette
   * `enemy-body-*` cache. A custom body colour has no cell in the atlas (the
   * palette bakes the tier colour), so it falls back to the shared
   * per-silhouette bake — still a batched sprite, just not the shared palette.
   */
  protected override bakedBodyFrame(): BakedBodyFrame | null {
    const tierData = ASTEROID_TIER_DATA[this.sizeTier];
    if (this._color !== tierData.color) return null;

    const scene = this.scene as Phaser.Scene | undefined;
    const palette = acquireAsteroidPalette(scene, ASTEROID_TIER_DATA);
    if (!palette) return null;

    const tierPalette = palette.tiers[this.sizeTier];
    // Custom `size` overrides keep the tier's look by scaling the cell.
    const scale = this._size / tierData.size;
    return {
      textureKey: palette.key,
      frame: tierPalette.frames[this._shapeVariant],
      displayWidth: tierPalette.cellSize * scale,
      displayHeight: tierPalette.cellSize * scale,
    };
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

  /**
   * Index of this asteroid's silhouette in the shared per-tier palette
   * (0-based). Exposed for tests/consumers that verify palette boundedness and
   * deterministic assignment (AH-0MW5088LA007XYQM).
   */
  get shapeVariant(): number {
    return this._shapeVariant;
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

  /**
   * Asteroids never collect minerals (GDD §4.5): they are excluded from the
   * mineral mechanic, so an overlap is a no-op and the tracked count stays 0.
   */
  override collectMineral(): void {
    // No-op — asteroids do not absorb minerals.
  }

  /**
   * Asteroids never drop re-dropped minerals — they are excluded from the
   * re-drop rule. Small asteroids drop a single mineral directly via the
   * asteroid branch in `resolveMineralKillDrops`, not via `mineralRedropCount`.
   */
  override mineralRedropCount(_rng?: () => number): number {
    return 0;
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
    // Seeded so a destroyed asteroid's children split identically on a
    // replay (AH-0MUY08V6W001SJJN).
    const deviation = Math.PI / 3 + (this._rng() * Math.PI) / 3; // π/3 to 2π/3

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

    // An offscreen-spawned asteroid must reach the viewport before it can
    // wrap, otherwise the first step would teleport it to the far edge.
    if (!this._enteredViewport) {
      if (
        this.x >= 0 &&
        this.x <= gameWidth &&
        this.y >= 0 &&
        this.y <= gameHeight
      ) {
        this._enteredViewport = true;
      }
      return;
    }

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

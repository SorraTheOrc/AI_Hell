/**
 * Lane-traffic hazard entity (Frogger archetype, AH-0MV01EPM40008N8T).
 *
 * A "vehicle" in a Frogger-style road lane: it crosses the arena at a
 * constant horizontal speed, wraps at the arena edges, and never fires. The
 * player must weave through the gaps between lane members (or shoot them —
 * they are 1 HP) rather than being homed on.
 *
 * The hazard is a **world hazard**, e.g. the Asteroid: it is *not* registered
 * with wave completion (non-blocking accounting), so destroying one never
 * advances the wave. It passes through other enemies (GDD §2.6 — no
 * enemy-enemy collision) and through other lane members. A body collision
 * with the player is destructive to the player through the shared
 * enemy-body collision model (GDD §2.3, "enemies are the bullets" §2.4).
 *
 * Movement lives here so the game (`PlayScene._moveEnemies`) and the gym
 * (`GymFormationScene`) run the *same* code — the gym calls the shared
 * `updatePosition` seam for every roaming entity.
 *
 * @module src/entities/LaneTraffic
 */

import Phaser from 'phaser';

import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import type { FormationOffset } from '../utils/formations';
import { EnemyShotPattern } from '../core/enemyConfig';

// ── Visual / behaviour tuning ──────────────────────────────────────

/** Lane-traffic body colour (neon amber). */
export const LANE_TRAFFIC_COLOR = 0xffb020;

/** Default body half-size in px. */
export const LANE_TRAFFIC_DEFAULT_SIZE = 22;

/** Default lane speed in px/s (the archetype's `driftSpeed`). */
export const LANE_TRAFFIC_DEFAULT_SPEED = 180;

/** Inset beyond the arena edge at which a wrapping lane member reappears. */
export const LANE_TRAFFIC_WRAP_MARGIN = 0;

// ── Config ─────────────────────────────────────────────────────────

export interface LaneTrafficConfig {
  x: number;
  y: number;
  /** Offset within the (non-existent) formation; required by the base class. */
  formationOffset: FormationOffset;
  /** Optional config-driven overrides for visual tuning. */
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  /**
   * Horizontal velocity in px/s (positive = right, negative = left). When
   * omitted, `speed` × `direction` is used; when both are omitted the entity
   * defaults to `LANE_TRAFFIC_DEFAULT_SPEED` to the right.
   */
  vx?: number;
  /** Lane speed magnitude in px/s (the data-driven `driftSpeed`). */
  speed?: number;
  /** Travel direction: `1` right (default) or `-1` left. */
  direction?: 1 | -1;
  /**
   * Hit points before the enemy is destroyed (data-driven;
   * AH-0MUI820PM0038HS2). Defaults to `1` (single-hit).
   */
  health?: number;
  /** Injectable random source (unused today; kept for the shared entity seam). */
  rng?: () => number;
}

// ── Entity ─────────────────────────────────────────────────────────

/**
 * A single Frogger lane-traffic hazard.
 *
 * Constant-speed horizontal motion with edge wrap; never fires; 1 HP;
 * non-blocking for wave completion.
 */
export class LaneTraffic extends BaseEnemy {
  /** Constant horizontal velocity (px/s). */
  private readonly _vx: number;

  constructor(scene: Phaser.Scene, config: LaneTrafficConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? LANE_TRAFFIC_DEFAULT_SIZE,
      color: config.color ?? LANE_TRAFFIC_COLOR,
      bulletColor: config.bulletColor,
      bulletSize: config.bulletSize,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    const speed = Math.abs(config.speed ?? LANE_TRAFFIC_DEFAULT_SPEED);
    const direction = config.direction ?? 1;
    this._vx = config.vx ?? speed * direction;

    this._drawBody();
    this.addSharedGraphics();
  }

  /** Archetype key (`'lane-traffic'`), matching the scene's enemy key. */
  get archetype(): string {
    return 'lane-traffic';
  }

  /** Effective config-driven size (for tests). */
  get effectiveSize(): number {
    return this._size;
  }

  /** Effective config-driven body colour (for tests). */
  get effectiveColor(): number {
    return this._color;
  }

  /** Constant horizontal velocity (px/s). */
  get vx(): number {
    return this._vx;
  }

  /** VFX pattern name for lane-traffic explosions. */
  protected getExplosionPatternName(): string {
    return 'swarm';
  }

  // ── Drawing ───────────────────────────────────────────────────────

  /** Draws a simple neon "vehicle" chevron pointing in the travel direction. */
  protected _drawBody(): void {
    this.bodyGraphics.clear();
    const half = this._size / 2;

    this.bodyGraphics.lineStyle(2, this._color, 1);
    // A rounded rectangle body with a leading nose, oriented by travel.
    this.bodyGraphics.beginPath();
    const nose = this._vx >= 0 ? half : -half;
    const tail = -nose;
    this.bodyGraphics.moveTo(nose, 0);
    this.bodyGraphics.lineTo(tail, -half);
    this.bodyGraphics.lineTo(tail, half);
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
  }

  // ── No-fire guarantee ─────────────────────────────────────────────

  /**
   * Lane traffic never fires, at any level. Both halves of the
   * `shootEnabled` accessor pair are overridden so reads are always `false`
   * and writes are a no-op (mirrors the Asteroid hazard).
   */
  get shootEnabled(): boolean {
    return false;
  }

  set shootEnabled(_value: boolean) {
    // No-op — lane traffic never fires.
  }

  /** Effective shot pattern is always `'none'`. */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'none';
  }

  /** Lane traffic is a moving hazard, not a formation enemy. */
  isFormationEnemy(): boolean {
    return false;
  }

  // ── Mineral inertness ─────────────────────────────────────────────

  /**
   * Lane traffic never collects minerals (it is a hazard, like the
   * Asteroid), so an overlap is a no-op and the tracked count stays 0.
   */
  override collectMineral(): void {
    // No-op — lane traffic does not absorb minerals.
  }

  /** Lane traffic never re-drops minerals (hazard, like the Asteroid). */
  override mineralRedropCount(_rng?: () => number): number {
    return 0;
  }

  // ── Movement ──────────────────────────────────────────────────────

  /**
   * Constant-speed horizontal motion with screen-edge wrapping.
   *
   * The lane's `y` never changes; only `x` advances. Wrapping keeps the
   * hazard on the field indefinitely (matching the Asteroid's edge wrap).
   *
   * @param dt — elapsed time in seconds.
   */
  updatePosition(dt: number): void {
    if (!this._alive) return;
    if (!this.scene) return;
    const scene = this.scene as Phaser.Scene;
    const gameWidth = scene.scale.width;
    const wrapWidth = gameWidth + 2 * LANE_TRAFFIC_WRAP_MARGIN;
    if (wrapWidth <= 0) return;

    this.x += this._vx * dt;

    // Horizontal wrap at the left/right arena edges. The modulo keeps the
    // result correct for arbitrary `dt` (a large gym tick advances many
    // widths at once), not just a single frame's motion.
    this.x =
      ((((this.x + LANE_TRAFFIC_WRAP_MARGIN) % wrapWidth) + wrapWidth) %
        wrapWidth) -
      LANE_TRAFFIC_WRAP_MARGIN;
  }

  /**
   * Override: lane traffic does not participate in formation movement — it
   * owns its position through {@link updatePosition}. A no-op so the shared
   * gym positioning pass cannot drag it back onto a formation slot.
   */
  applyFormationPosition(
    _baseX: number,
    _baseY: number,
    _dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    // No-op — lane traffic moves independently.
  }
}

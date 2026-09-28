/**
 * Harvester enemy entity (parent AH-0MUI820PM0038HS2, GDD §4.1 — E7).
 *
 * A large, slow, durable roamer that actively hunts the mineral field: it
 * always steers toward the nearest live mineral anywhere on the field and
 * absorbs it on overlap through the shared enemy-absorption rule
 * (`collectMinerals`). It never fires, cannot take minerals from the
 * player's hold, and survives five player-bullet hits.
 *
 * Movement follows the {@link Asteroid} roamer pattern (`formationKind:
 * 'single'`, `updatePosition(dt)` + no-op `applyFormationPosition`), so the
 * shared tick drives it identically in the game and the gym. Seeking is
 * supplied by the shared `setSeekTargets` seam (feature F4), keeping the
 * behaviour single-sourced.
 *
 * The entity deliberately contains no collision/mineral-accounting logic of
 * its own: absorption is the shared `collectMinerals` pass and health/kill
 * finalisation is the shared `CombatScene` path (feature F2).
 *
 * @module src/entities/Harvester
 */

import Phaser from 'phaser';

import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import type { EnemyShotPattern } from '../core/configTypes';
import { FormationOffset } from '../utils/formations';
import type { Mineral } from './Mineral';

// ── Visual / behaviour tuning (indicative; tuned in the gym) ────────

/** Body colour — a vivid mineral-denial violet. */
export const HARVESTER_COLOR = 0x9b30ff;

/** Bullet colour (unused — the Harvester never fires; kept for the shared config shape). */
export const HARVESTER_BULLET_COLOR = 0xcc88ff;

/** Half-size of the Harvester — large (bigger than the Tank's 28 px). */
export const HARVESTER_SIZE = 44;

/** Slow seek/drift speed (px/s) — deliberately slower than the Scout. */
export const HARVESTER_SPEED = 24;

/** Hit points before destruction (five player bullets). */
export const HARVESTER_HEALTH = 5;

/** Body rotation speed while drifting (rad/s) — slow, heavy turn. */
export const HARVESTER_ROTATION_SPEED = 0.4;

/** Config accepted by the Harvester (config-driven visuals + health). */
export interface HarvesterConfig {
  x: number;
  y: number;
  /** Offset within the (non-existent) formation; required by the base class. */
  formationOffset: FormationOffset;
  /** Optional config-driven overrides; when absent the constants above win. */
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  bulletLifetime?: number;
  fireInterval?: number;
  /** Hit points before destruction (data-driven; defaults to 1). */
  health?: number;
  rng?: () => number;
}

/**
 * Large, slow, mineral-seeking roamer.
 *
 * Seeks the nearest live mineral via {@link setSeekTargets}; absorption is
 * handled by the shared `collectMinerals` pass. Never fires.
 */
export class Harvester extends BaseEnemy {
  /** Formation kind reported to config consumers — always a solitary roamer. */
  readonly formationKind = 'single' as const;

  /** Current seek target x (null when no live mineral is known). */
  private _targetX: number | null = null;
  private _targetY: number | null = null;

  /** Live mineral field supplied by the shared seek seam. */
  private _targets: readonly Mineral[] = [];

  private _rotation = 0;

  constructor(scene: Phaser.Scene, config: HarvesterConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? HARVESTER_SIZE,
      color: config.color ?? HARVESTER_COLOR,
      bulletColor: config.bulletColor ?? HARVESTER_BULLET_COLOR,
      bulletSize: config.bulletSize,
      bulletSpeed: config.bulletSpeed,
      bulletLifetime: config.bulletLifetime,
      fireInterval: config.fireInterval,
      health: config.health ?? HARVESTER_HEALTH,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this._drawBody();
    this.addSharedGraphics();
  }

  /** VFX pattern name for Harvester explosions. */
  protected getExplosionPatternName(): string {
    return 'tank';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draw the body: a large angular "collector" shell with a glowing core.
   *
   * The original mineral-intake chevron was a pure-white inner accent; it was
   * removed after producer review (parent AH-0MUI820PM0038HS2) because the
   * white inner glyph read as a separate object and competed with the hit
   * feedback. The body is now the colour-driven hexagonal shell plus core only.
   */
  protected _drawBody(): void {
    const g = this.bodyGraphics;
    const r = this._size / 2;
    g.clear();

    // Outer hexagonal shell.
    g.lineStyle(3, this._color, 1);
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 2;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.strokePath();

    // Glowing core.
    g.fillStyle(this._color, 0.7);
    g.fillCircle(0, 0, r * 0.28);
  }

  // ── Effective config (for tests / gym tuning) ────────────────────

  /** Effective config-driven size (for tests). */
  get effectiveSize(): number {
    return this._size;
  }

  /** Effective config-driven body colour (for tests). */
  get effectiveColor(): number {
    return this._color;
  }

  // ── No-fire guarantee ────────────────────────────────────────────

  /**
   * Both halves of the shootEnabled accessor pair are overridden so reads
   * stay false and writes are ignored (the Harvester never fires).
   */
  get shootEnabled(): boolean {
    return false;
  }

  set shootEnabled(_value: boolean) {
    // No-op — the Harvester never fires.
  }

  /** Effective shot pattern is always 'none'. */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'none';
  }

  /** Whether this enemy uses formation-based movement. The Harvester does not. */
  isFormationEnemy(): boolean {
    return false;
  }

  // ── Seek target seam (shared with F4) ────────────────────────────

  /**
   * Receive the live mineral field. The Harvester picks the nearest live
   * mineral as its target; with no live mineral it clears the target and
   * holds station. Called from the shared tick in the game and the gyms.
   *
   * @param minerals — live minerals on the field (dead/collected excluded).
   */
  setSeekTargets(minerals: readonly Mineral[]): void {
    this._targets = minerals;
    this._selectNearestTarget();
  }

  /** Current target x, or null when no live mineral is known. */
  get seekTargetX(): number | null {
    return this._targetX;
  }

  /** Current target y, or null when no live mineral is known. */
  get seekTargetY(): number | null {
    return this._targetY;
  }

  /** Select the nearest live mineral as the target (clears when none). */
  private _selectNearestTarget(): void {
    let best: Mineral | null = null;
    let bestDist = Infinity;
    for (const mineral of this._targets) {
      if (!mineral.alive) continue;
      const d = Math.hypot(mineral.x - this.x, mineral.y - this.y);
      if (d < bestDist) {
        bestDist = d;
        best = mineral;
      }
    }
    this._targetX = best ? best.x : null;
    this._targetY = best ? best.y : null;
  }

  // ── Movement ─────────────────────────────────────────────────────

  /**
   * Steer toward the current target at the configured slow speed, with
   * four-edge screen wrap. With no target the Harvester holds station
   * (continuing its slow rotation only).
   *
   * @param dt — elapsed time in seconds
   */
  updatePosition(dt: number): void {
    if (!this._alive) return;

    // Keep the target fresh: a mineral absorbed this frame clears the target.
    this._selectNearestTarget();

    // Slow continuous rotation for a "heavy" feel.
    this._rotation += HARVESTER_ROTATION_SPEED * dt;
    this.rotation = this._rotation;

    if (this._targetX === null || this._targetY === null) return;

    const dx = this._targetX - this.x;
    const dy = this._targetY - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;

    const step = Math.min(HARVESTER_SPEED * dt, dist);
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
    this._wrapIntoViewport();
  }

  /** Wrap across all four screen edges (matching the Asteroid model). */
  private _wrapIntoViewport(): void {
    if (!this.scene) return;
    const scene = this.scene as Phaser.Scene;
    const w = scene.scale.width;
    const h = scene.scale.height;
    if (this.x < 0) this.x += w;
    if (this.x > w) this.x -= w;
    if (this.y < 0) this.y += h;
    if (this.y > h) this.y -= h;
  }

  /**
   * Override: the Harvester does not participate in formation movement —
   * it manages its own seek motion via {@link updatePosition}.
   */
  applyFormationPosition(
    _baseX: number,
    _baseY: number,
    _dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    // No-op — the Harvester seeks independently.
  }
}

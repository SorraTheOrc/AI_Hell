/**
 * Tank enemy entity (GDD §4.1 — E3 Tank).
 *
 * Renders as a larger, hexagonal/blocky neon-orange shape. Moves slowly
 * in formation and holds position longer than other enemy types (2–3 s
 * between movements). Acts as an immovable obstacle / formation anchor.
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation, and
 * is removed. Tanks never collide with each other (GDD §2.6).
 *
 * At Level 4+ (simulated by shoot mode) the Tank fires radial bursts —
 * 8–12 projectiles in all directions at slower intervals than other
 * enemy types.
 */

import Phaser from 'phaser';

import { FormationOffset } from '../utils/formations';

export type { FormationOffset } from '../utils/formations';

export { buildRectFormationOffsets } from '../utils/formations';
// ── Visual / behaviour tuning (per GDD §4.1) ────────────────────────

/** Orange body colour per GDD §4.1 art direction. */
export const TANK_COLOR = 0xff6600;

/** Half-size of the tank — larger than Scout (SCOUT_SIZE = 16). */
export const TANK_SIZE = 28;

/** Radial-burst bullet colour (amber, distinct from the orange body). */
export const TANK_BULLET_COLOR = 0xffaa00;

/** Bullet radius in px. */
export const TANK_BULLET_SIZE = 4;

/** Bullet speed in px/s. */
export const TANK_BULLET_SPEED = 150;

/** Number of projectiles in a radial burst (8–12 range). */
export const TANK_BURST_COUNT = 10;

/** Milliseconds between radial bursts — slower than Scout's 1200 ms. */
export const TANK_FIRE_INTERVAL = 2400;

/** Seconds a Tank holds its formation position before moving. */
export const TANK_HOLD_POSITION_SECONDS = 2.5;

/** Formation drift speed — slower than Scout (40 px/s). */
export const TANK_FORMATION_DRIFT_SPEED = 18;

export interface TankConfig {
  x: number;
  y: number;
  /** Offset within the rectangular formation. */
  formationOffset: FormationOffset;
}

/**
 * A bullet fired by a tank in a radial burst.
 */
export interface TankBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
}

export class Tank extends Phaser.GameObjects.Container {
  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private readonly explosionGraphics: Phaser.GameObjects.Graphics;
  private readonly formationOffset: FormationOffset;

  private _alive = true;
  private _shootEnabled = false;
  private _lastFireTime = 0;
  private _holdTimer = 0;
  private _moveInterval = TANK_HOLD_POSITION_SECONDS;
  private _driftPhase = 0;
  private _directionX = 1;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: TankConfig) {
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;

    // Body — larger hexagonal shape in orange.
    this.bodyGraphics = scene.add.graphics();
    this.bodyGraphics.lineStyle(2.5, TANK_COLOR, 1);
    this._drawBody();
    this.bodyGraphics.setDepth(1);
    this.add(this.bodyGraphics);

    // Explosion layer.
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(2);
    this.add(this.explosionGraphics);
  }

  // ── Drawing ──────────────────────────────────────────────────────

  private _drawBody(): void {
    this.bodyGraphics.clear();
    const half = TANK_SIZE / 2;

    // Hexagon pointing right (blocky/tank-like silhouette).
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(half, 0);             // right tip
    this.bodyGraphics.lineTo(half * 0.6, -half);    // top-right
    this.bodyGraphics.lineTo(-half * 0.4, -half);   // top-left
    this.bodyGraphics.lineTo(-half, -half * 0.5);   // far-left-top
    this.bodyGraphics.lineTo(-half, half * 0.5);    // far-left-bottom
    this.bodyGraphics.lineTo(-half * 0.4, half);    // bottom-left
    this.bodyGraphics.lineTo(half * 0.6, half);     // bottom-right
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();

    // Inner detail lines for a "blocky" look.
    this.bodyGraphics.lineStyle(1, TANK_COLOR, 0.5);
    this.bodyGraphics.moveTo(half * 0.2, -half * 0.6);
    this.bodyGraphics.lineTo(half * 0.2, half * 0.6);
    this.bodyGraphics.strokePath();
  }

  /**
   * Plays the destruction animation: expanding, fading rings.
   */
  playExplosion(): void {
    const scene = this.scene as Phaser.Scene;
    scene.tweens.add({
      targets: this.explosionGraphics,
      alpha: { from: 1, to: 0 },
      duration: 500,
      onUpdate: () => {
        const alpha = this.explosionGraphics.alpha;
        const radius = TANK_SIZE * 2.5 * (1 - alpha) + TANK_SIZE * 0.3;
        this.explosionGraphics.clear();
        this.explosionGraphics.lineStyle(
          Math.max(1, Math.round(4 * alpha)),
          TANK_COLOR,
          alpha,
        );
        this.explosionGraphics.strokeCircle(0, 0, radius);
        this.explosionGraphics.beginPath();
        this.explosionGraphics.moveTo(-radius, 0);
        this.explosionGraphics.lineTo(radius, 0);
        this.explosionGraphics.moveTo(0, -radius);
        this.explosionGraphics.lineTo(0, radius);
        this.explosionGraphics.strokePath();
      },
      onComplete: () => {
        this.explosionGraphics.destroy();
      },
    });
  }

  // ── Public state ─────────────────────────────────────────────────

  get alive(): boolean {
    return this._alive;
  }

  get bodyVisible(): boolean {
    return this.bodyGraphics.alpha > 0 && this.bodyGraphics.visible;
  }

  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
    if (!value) this._lastFireTime = 0;
  }

  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }

  /** Speed at which this tank's formation drifts (px/s). */
  get driftSpeed(): number {
    return TANK_FORMATION_DRIFT_SPEED;
  }

  // ── Behaviour ────────────────────────────────────────────────────

  destroySelf(): void {
    if (!this._alive) return;
    this._alive = false;
    this.bodyGraphics.setAlpha(0);
    this.playExplosion();
  }

  /**
   * Fires a radial burst if shoot mode is on, alive, and interval elapsed.
   * Returns the bullets spawned (0 if no shot fired).
   */
  tryFireRadialBurst(now: number): TankBullet[] {
    if (!this._shootEnabled || !this._alive) return [];
    if (now - this._lastFireTime < TANK_FIRE_INTERVAL) return [];
    this._lastFireTime = now;

    const bullets: TankBullet[] = [];
    for (let i = 0; i < TANK_BURST_COUNT; i++) {
      const angle = (Math.PI * 2 * i) / TANK_BURST_COUNT;
      const vx = Math.cos(angle) * TANK_BULLET_SPEED;
      const vy = Math.sin(angle) * TANK_BULLET_SPEED;

      const graphics = this.scene.add.graphics();
      graphics.fillStyle(TANK_BULLET_COLOR, 1);
      graphics.fillCircle(0, 0, TANK_BULLET_SIZE);
      graphics.setPosition(this.x, this.y);
      graphics.setDepth(3);

      bullets.push({ graphics, color: TANK_BULLET_COLOR, vx, vy });
    }
    return bullets;
  }

  /**
   * Applies slow, deliberate formation movement with extended hold position.
   * Tanks hold their position longer (2–3 s) before transitioning to a new
   * direction, and drift more slowly overall than lighter enemies.
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;

    this._holdTimer += dt;

    // Subtle idle bob (slower than Scout's wiggle). X-only like Scout.
    this._driftPhase += dt * 0.5;
    const bobX = Math.cos(this._driftPhase * 0.7) * 2;

    // Periodically change direction (hold position for configured interval).
    if (this._holdTimer >= this._moveInterval) {
      this._holdTimer = 0;
      // Pick a new random slow direction (horizontal only — Y is
      // purely grid-based to keep formation geometry verifiable).
      this._directionX = Math.random() < 0.5 ? -1 : 1;
      // Re-randomise interval within the 2–3 s range.
      this._moveInterval = 2 + Math.random();
    }

    const slowX = this._directionX * TANK_FORMATION_DRIFT_SPEED * 0.3 * dt;

    const x = baseX + this.formationOffset.col * spacingX + bobX + slowX;
    const y = baseY + this.formationOffset.row * spacingY;
    this.setPosition(x, y);
  }

  destroy(fromScene?: boolean): void {
    this.bodyGraphics.destroy();
    this.explosionGraphics.destroy();
    super.destroy(fromScene);
  }
}

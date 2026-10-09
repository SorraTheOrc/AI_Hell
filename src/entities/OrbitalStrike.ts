/**
 * Orbital strike entity (Missile Command archetype, AH-0MV01ENX00055CG1).
 *
 * A single non-firing hazard that telegraphs its impact point with a visible
 * marker for at least 500 ms before a projectile falls from off-screen and
 * detonates in a radial burst. The strike is a world hazard — it is not
 * registered with wave completion (non-blocking, matching the asteroid
 * accounting convention, GDD §2.4).
 *
 * Lifecycle (per GDD §7.3 telegraph convention):
 *
 * 1. **Telegraph** — a visible marker appears at the predicted impact point.
 *    The marker holds for `TELEGRAPH_DURATION` ms (≥500 ms). During this
 *    phase the entity plays an advance-cue sound.
 * 2. **Fall** — the projectile falls from off-screen toward the impact point
 *    at `FALL_SPEED` px/s. This phase is short and fast.
 * 3. **Detonate** — a radial burst of shrapnel bullets sprays outward from
 *    the impact point.
 *
 * The entity is a single `single`-formation entity that the dynamic
 * `StrikeSpawner` places at random positions. It is non-firing
 * (`shotPattern: 'none'`) — the radial burst is a detonation event, not a
 * per-cycle fire action.
 *
 * Audio: the advance cue uses `playScoutAdvanceCue` (reused from Scout's
 * ≥500 ms tell convention). Destruction audio is owned by the scene
 * (`playDestructionSound()`), not by this entity.
 *
 * @module entities/OrbitalStrike
 */

import Phaser from 'phaser';

import { createBullet } from './bulletUtils';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { FormationOffset } from '../utils/formations';
import { playScoutAdvanceCue } from '../audio/effects';
import type { ExplosionHandle } from '../vfx/explosionParticles';

// ── Visual / behaviour tuning ───────────────────────────────────────

/** Body colour (deep purple, distinct from other archetypes). */
export const ORBITAL_STRIKE_COLOR = 0x8800cc;

/** Telegraph marker colour (bright white, highly visible). */
export const ORBITAL_STRIKE_TELEGRAPH_COLOR = 0xffffff;

/** Telegraph marker radius (px). */
export const ORBITAL_STRIKE_TELEGRAPH_SIZE = 12;

/** Telegraph hold duration (ms) — ≥500 ms per GDD §7.3. */
export const TELEGRAPH_DURATION = 600;

/** Projectile body colour (red, distinct from the white telegraph). */
export const ORBITAL_STRIKE_BULLET_COLOR = 0xff4444;

/** Projectile bullet radius (px). */
export const ORBITAL_STRIKE_BULLET_SIZE = 4;

/** Projectile fall speed (px/s). */
export const ORBITAL_STRIKE_FALL_SPEED = 400;

/** Radial burst bullet radius (px). */
export const ORBITAL_STRIKE_BURST_BULLET_SIZE = 3;

/** Radial burst bullet speed (px/s). */
export const ORBITAL_STRIKE_BURST_BULLET_SPEED = 120;

/** Radial burst bullet lifetime (seconds). */
export const ORBITAL_STRIKE_BURST_BULLET_LIFETIME = 1.5;

// ── Types ───────────────────────────────────────────────────────────

export interface OrbitalStrikeConfig {
  x: number;
  y: number;
  formationOffset: FormationOffset;
  /** Optional config-driven overrides for visual tuning. */
  size?: number;
  color?: number;
  /** Colour of the telegraph marker. */
  telegraphColor?: number;
  /** Size of the telegraph marker in px. */
  telegraphSize?: number;
  /** Bullet colour for the falling projectile. */
  bulletColor?: number;
  /** Bullet radius for the falling projectile. */
  bulletSize?: number;
  /** Fall speed in px/s. */
  fallSpeed?: number;
  /** Radial burst bullet radius. */
  burstBulletSize?: number;
  /** Radial burst bullet speed (px/s). */
  burstBulletSpeed?: number;
  /** Bullet lifetime in seconds. */
  bulletLifetime?: number;
  /**
   * Hit points before the enemy is destroyed (data-driven;
   * AH-0MUI820PM0038HS2). Defaults to `1`.
   */
  health?: number;
  /** Injectable random source for deterministic burst direction (optional). */
  rng?: () => number;
}

/** A bullet emitted during the radial burst detonation. */
export interface OrbitalStrikeBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
  /** Bullet lifetime in seconds. */
  lifetime: number;
  /** Elapsed time since creation (seconds). */
  elapsed: number;
}

/** Internal state machine phases for the orbital strike. */
export type StrikePhase = 'telegraph' | 'falling' | 'detonated';

/**
 * The impact point where the strike will detonate.
 */
export interface ImpactPoint {
  x: number;
  y: number;
}

export class OrbitalStrike extends BaseEnemy {
  // ── State ────────────────────────────────────────────────────────

  private _phase: StrikePhase = 'telegraph';
  private _tellStartTime = 0;

  /** The impact point (resolved when the strike enters the falling phase). */
  private _impactPoint: ImpactPoint | null = null;

  /** The falling projectile. */
  private _fallingBullet: OrbitalStrikeBullet | null = null;

  /** VFX handles for explosion particles. */
  private _burstHandles: ExplosionHandle[] = [];

  /** Telegraph marker graphics. */
  private _telegraphGraphics: Phaser.GameObjects.Graphics | null = null;

  /** Pulse phase for the telegraph marker (visual emphasis). */
  private _pulsePhase = 0;

  /** Target position (near player). */
  private _targetX = 0;
  private _targetY = 0;

  /** Spawn position (off-screen top, used during fall phase). */
  private _spawnY = 0;

  /** Number of radial burst bullets. */
  private _burstCount = 6;

  /** Injectable RNG (optional, for determinism in tests). */
  private _rng?: () => number;

  /** Burst bullets produced by the last detonation. */
  private _burstBullets: OrbitalStrikeBullet[] = [];

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: OrbitalStrikeConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? 20,
      color: config.color ?? ORBITAL_STRIKE_COLOR,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    // Draw the body.
    this._drawBody();

    // Create the telegraph marker graphics.
    this._telegraphGraphics = this.scene.add.graphics();

    // Add shared graphics (explosion particles).
    this.addSharedGraphics();
  }

  /** Archetype key (`'orbital-strike'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'orbital-strike';
  }

  /** VFX pattern name for orbital strike explosions. */
  protected getExplosionPatternName(): string {
    return 'orbital-strike';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  protected _drawBody(): void {
    this.bodyGraphics.clear();
    const half = this._size / 2;

    this.bodyGraphics.lineStyle(2, this._color, 1);
    // Diamond shape — distinct from all other archetypes.
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(0, -half);
    this.bodyGraphics.lineTo(half, 0);
    this.bodyGraphics.lineTo(0, half);
    this.bodyGraphics.lineTo(-half, 0);
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
  }

  /** Live particle-explosion handles (copy — for tests). */
  getExplosionHandles(): ExplosionHandle[] {
    return this._burstHandles.slice();
  }

  // ── Public state ─────────────────────────────────────────────────

  /** Current internal phase. */
  get phase(): StrikePhase {
    return this._phase;
  }

  /** Whether this strike is currently in its telegraph phase. */
  get isTelling(): boolean {
    return this._isTelling;
  }

  /** The configured tell duration in ms. */
  get tellDuration(): number {
    return TELEGRAPH_DURATION;
  }

  /** The impact point (null until detonation phase). */
  get impactPoint(): ImpactPoint | null {
    return this._impactPoint;
  }

  /** The spawn position (off-screen top). */
  get spawnY(): number {
    return this._spawnY;
  }

  /** The target position (near player). */
  get targetPosition(): { x: number; y: number } {
    return { x: this._targetX, y: this._targetY };
  }

  // ── Initialisation ───────────────────────────────────────────────

  /**
   * Initialise this strike with its target position, RNG, and bullet count.
   * Called by the spawner after construction.
   *
   * @param targetX — x-coordinate of the impact point.
   * @param targetY — y-coordinate of the impact point.
   * @param burstCount — number of radial shrapnel bullets.
   * @param rng — seeded random source (optional).
   */
  initStrike(
    targetX: number,
    targetY: number,
    burstCount: number,
    rng?: () => number,
  ): void {
    this._targetX = targetX;
    this._targetY = targetY;
    this._burstCount = burstCount;
    this._rng = rng;
    // Start from off-screen top.
    this._spawnY = -(this._size + 10);
    this.y = this._spawnY;
    // Start the telegraph phase.
    this._phase = 'telegraph';
    this._isTelling = true;
    this._tellStartTime = this.scene.time.now;
    // Draw the telegraph marker.
    this._drawTelegraphMarker();
    // Play the advance cue.
    playScoutAdvanceCue();
  }

  // ── Update ───────────────────────────────────────────────────────

  /**
   * Update the strike's lifecycle state each frame.
   *
   * @param now — current time in ms.
   */
  update(now: number): void {
    if (!this._alive) return;

    // Update the telegraph marker pulse (visual emphasis).
    if (this._phase === 'telegraph') {
      this._pulsePhase += 0.05;
      this._drawTelegraphMarker();
      // Check if the tell duration has elapsed.
      if (now - this._tellStartTime >= TELEGRAPH_DURATION) {
        this._startFall();
      }
    } else if (this._phase === 'falling') {
      this._updateFall(now);
    }
  }

  // ── Telegraph ────────────────────────────────────────────────────

  /**
   * Draw the telegraph marker at the impact point.
   * Pulses in radius and alpha for visual emphasis.
   */
  private _drawTelegraphMarker(): void {
    if (!this._telegraphGraphics) return;
    this._telegraphGraphics.clear();

    const pulse = Math.sin(this._pulsePhase) * 0.3 + 0.7; // 0.4–1.0
    const pulseSize = ORBITAL_STRIKE_TELEGRAPH_SIZE * (0.8 + 0.2 * pulse);
    const color = this._config?.telegraphColor ?? ORBITAL_STRIKE_TELEGRAPH_COLOR;

    this._telegraphGraphics.lineStyle(2, color, pulse);
    this._telegraphGraphics.strokeCircle(
      this._targetX,
      this._targetY,
      pulseSize,
    );

    // Inner crosshair lines for extra visibility.
    this._telegraphGraphics.lineStyle(1, color, pulse * 0.7);
    const crossSize = pulseSize * 1.5;
    this._telegraphGraphics.beginPath();
    this._telegraphGraphics.moveTo(this._targetX - crossSize, this._targetY);
    this._telegraphGraphics.lineTo(this._targetX + crossSize, this._targetY);
    this._telegraphGraphics.moveTo(this._targetX, this._targetY - crossSize);
    this._telegraphGraphics.lineTo(this._targetX, this._targetY + crossSize);
    this._telegraphGraphics.strokePath();
  }

  // ── Fall ─────────────────────────────────────────────────────────

  /**
   * Transition from telegraph to falling phase.
   * Removes the marker and creates the falling projectile.
   */
  private _startFall(): void {
    // Remove the telegraph marker.
    this._telegraphGraphics?.clear();

    // Compute impact point.
    this._impactPoint = {
      x: this._targetX,
      y: this._targetY,
    };

    // Transition to falling phase.
    this._phase = 'falling';
    this._isTelling = false;

    // Create the falling projectile.
    this._fallingBullet = this._createFallingProjectile();
    // Set the projectile to start from off-screen top at the target X.
    this._fallingBullet.graphics.position.set(this._targetX, this._spawnY);
    this.y = this._spawnY;
  }

  /**
   * Create the falling projectile (a single bullet heading toward the impact).
   */
  private _createFallingProjectile(): OrbitalStrikeBullet {
    const bullet = createBullet({
      scene: this.scene,
      color: ORBITAL_STRIKE_BULLET_COLOR,
      size: ORBITAL_STRIKE_BULLET_SIZE,
      x: this._targetX,
      y: this._spawnY,
    });

    return {
      graphics: bullet.graphics,
      color: ORBITAL_STRIKE_BULLET_COLOR,
      vx: 0,
      vy: ORBITAL_STRIKE_FALL_SPEED,
      lifetime: ORBITAL_STRIKE_BURST_BULLET_LIFETIME,
      elapsed: 0,
    };
  }

  /**
   * Update the falling projectile's position and check for arrival.
   */
  private _updateFall(_now: number): void {
    if (!this._fallingBullet || !this._impactPoint) return;

    // Move the projectile downward.
    const dt = this.scene.time.physicsElapsedMS / 1000;
    this._fallingBullet.graphics.position.y += this._fallingBullet.vy * dt;
    this.y = this._fallingBullet.graphics.position.y;

    // Check if the projectile has reached the impact point.
    if (this._fallingBullet.graphics.position.y >= this._impactPoint.y) {
      this._detonate();
    }
  }

  // ── Detonation ───────────────────────────────────────────────────

  /**
   * Detonate at the impact point: create the radial burst and destroy self.
   */
  private _detonate(): void {
    if (!this._impactPoint) return;

    // Clean up the falling projectile.
    this._fallingBullet?.graphics.destroy();
    this._fallingBullet = null;

    // Remove the telegraph marker.
    this._telegraphGraphics?.destroy();
    this._telegraphGraphics = null;

    // Transition to detonated phase.
    this._phase = 'detonated';
    this._isTelling = false;

    // Create the radial burst.
    this._burstBullets = this._createRadialBurst();

    // Trigger destruction — the scene will handle cleanup.
    this.triggerDestruction();
  }

  /**
   * Create a radial burst of shrapnel bullets from the impact point.
   */
  private _createRadialBurst(): OrbitalStrikeBullet[] {
    const bullets: OrbitalStrikeBullet[] = [];
    const angleStep = (Math.PI * 2) / this._burstCount;

    for (let i = 0; i < this._burstCount; i++) {
      const angle = i * angleStep;
      const vx = Math.cos(angle) * ORBITAL_STRIKE_BURST_BULLET_SPEED;
      const vy = Math.sin(angle) * ORBITAL_STRIKE_BURST_BULLET_SPEED;

      const bullet = createBullet({
        scene: this.scene,
        color: ORBITAL_STRIKE_BULLET_COLOR,
        size: ORBITAL_STRIKE_BURST_BULLET_SIZE,
        x: this._impactPoint!.x,
        y: this._impactPoint!.y,
      });

      bullets.push({
        graphics: bullet.graphics,
        color: ORBITAL_STRIKE_BULLET_COLOR,
        vx,
        vy,
        lifetime: ORBITAL_STRIKE_BURST_BULLET_LIFETIME,
        elapsed: 0,
      });
    }

    return bullets;
  }

  /**
   * Get the burst bullets produced by the last detonation.
   * Called by the owning scene after `update()`.
   */
  getBurstBullets(): OrbitalStrikeBullet[] {
    return this._burstBullets.slice();
  }

  /**
   * Reset burst bullets after they have been collected.
   * Called by the owning scene after collecting the burst.
   */
  clearBurstBullets(): void {
    this._burstBullets.length = 0;
  }

  /**
   * Apply formation position — for single-entity, this just keeps it at
   * the impact point during detonation.
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    _dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;

    if (this._phase === 'telegraph') {
      // During telegraph, stay at the target position.
      this.setPosition(this._targetX, this._targetY);
    } else if (this._phase === 'falling') {
      // During fall, follow the projectile position.
      this._fallingBullet && this.setPosition(
        this._fallingBullet.graphics.position.x,
        this._fallingBullet.graphics.position.y,
      );
    } else {
      // During detonation or after, stay at the impact point.
      this.setPosition(baseX, baseY);
    }
  }

  /**
   * Clean up all Phaser objects. Called on destruction.
   */
  override destroy(): void {
    this._telegraphGraphics?.destroy();
    this._telegraphGraphics = null;
    this._fallingBullet?.graphics.destroy();
    this._fallingBullet = null;
    super.destroy();
  }

  /**
   * Check if the entity is still active (not detonated and not dead).
   */
  isActive(): boolean {
    return this._alive && this._phase !== 'detonated';
  }
}

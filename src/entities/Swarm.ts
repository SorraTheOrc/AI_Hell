/**
 * Swarm enemy entity (GDD §4.1 — E5 Swarm).
 *
 * Renders as a small, diamond-shaped neon-blue entity that moves in tight,
 * fast-moving clusters with sudden direction changes. Groups of 3–5 enemies
 * slide past one another, split and rejoin — creating the unpredictable,
 * chaotic cluster movement that defines the E5 Swarm.
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation.
 * At Level 4+ (simulated by shoot mode) Swarms fire coordinated burst shots:
 * multiple entities fire simultaneously toward a shared target direction.
 *
 * Swarms never collide with each other (GDD §2.6).
 */

import Phaser from 'phaser';

import { createBullet } from './bulletUtils';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { playSwarmBurstSound } from '../audio/effects';
import { FormationOffset } from '../utils/formations';
import { type ExplosionHandle } from '../vfx/explosionParticles';

export type { FormationOffset } from '../utils/formations';

export { buildSwarmClusterOffsets } from '../utils/formations';

// ── Visual / behaviour tuning (per GDD §4.1) ────────────────────────

/** Neon-blue body colour per GDD §4.1 art direction. */
export const SWARM_COLOR = 0x0066ff;

/** Full corner-to-corner span of the diamond in px (drawing uses ±SWARM_SIZE/2 offsets). */
export const SWARM_SIZE = 15;

/** Coordinated-burst bullet colour (cyan, distinct from the blue body). */
export const SWARM_BULLET_COLOR = 0x00ccff;

/** Bullet radius in px. */
export const SWARM_BULLET_SIZE = 3;

/** Bullet speed in px/s for coordinated bursts. */
export const SWARM_BULLET_SPEED = 180;

/** Milliseconds between coordinated burst volleys. */
export const SWARM_BURST_INTERVAL = 900;

/** How many distinct clusters to divide a swarm into. */
export const SWARM_CLUSTER_COUNT = 3;

/** Maximum cluster-drift bias in formation slots (controls spread). */
const CLUSTER_MAX_SPREAD = 1.25;

/** Cluster-direction-change frequency (radians per second on the phase). */
const CLUSTER_PHASE_SPEED = 0.7;

export interface SwarmConfig {
  x: number;
  y: number;
  /** Offset within the swarm formation; the scene computes absolute position. */
  formationOffset: FormationOffset;
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  /** Bullet lifetime in seconds (wrap + expiry; AH-0MU960UTE001PTV0). */
  bulletLifetime?: number;
  fireInterval?: number;
  /**
   * Chance (fraction `0.0`–`1.0`) that this member fires when the burst
   * interval elapses (per shot cycle). Defaults to `1.0` (current
   * behaviour). A failed roll consumes the cycle with no bullet.
   */
  shotProbability?: number;
  /** Injectable random source for the per-cycle shot roll (defaults to `Math.random`). */
  rng?: () => number;
}

/**
 * A bullet fired by a swarm member during a coordinated burst volley.
 */
export interface SwarmBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
  /** Bullet lifetime in seconds (AH-0MU960UTE001PTV0). */
  lifetime: number;
  /** Elapsed time since creation (seconds). */
  elapsed: number;
}

/**
 * A Swarm enemy entity that moves in tight, fast-moving clusters with
 * sudden direction changes.
 */
export class Swarm extends BaseEnemy {
  // ── Swarm-specific fields ────────────────────────────────────────

  private readonly target: Phaser.Math.Vector2;
  /** Which cluster this member belongs to (0..SWARM_CLUSTER_COUNT-1). */
  private readonly clusterIdx: number;

  // Per-cluster phase — each cluster drifts with a different angular phase
  // so members weave around each other naturally.
  private readonly clusterPhase: number;
  // Randomised direction-change bias so clusters split/rejoin organically.
  private clusterBias: number;
  private clusterDriftPhase = 0;
  // When this member's cluster will next split/rejoin (seconds).
  private nextSplitTime = 1 + Math.random() * 2;

  // ── Construction ─────────────────────────────────────────────────

  constructor(
    scene: Phaser.Scene,
    config: SwarmConfig,
    clusterIndex: number,
  ) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? SWARM_SIZE,
      color: config.color ?? SWARM_COLOR,
      bulletColor: config.bulletColor ?? SWARM_BULLET_COLOR,
      bulletSize: config.bulletSize ?? SWARM_BULLET_SIZE,
      bulletSpeed: config.bulletSpeed ?? SWARM_BULLET_SPEED,
      bulletLifetime: config.bulletLifetime,
      fireInterval: config.fireInterval ?? SWARM_BURST_INTERVAL,
      shotProbability: config.shotProbability,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this.clusterIdx = clusterIndex;

    // Each cluster gets a unique angular phase so they weave differently.
    const phaseStep = (Math.PI * 2) / SWARM_CLUSTER_COUNT;
    this.clusterPhase = this.clusterIdx * phaseStep + Math.random() * 0.3;
    this.clusterBias = (Math.random() - 0.5) * CLUSTER_MAX_SPREAD;

    // Aim target is bottom-centre (simulated player position).
    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // Draw the unique shape and add shared graphics in canonical order.
    this._drawBody();
    this.addSharedGraphics();
  }

  /** VFX pattern name for Swarm explosions. */
  protected getExplosionPatternName(): string {
    return 'swarm';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draws a diamond shape (square rotated 45°) centred at (0, 0).
   * Style is applied AFTER clear() (see note in _drawBody).
   */
  protected _drawBody(): void {
    this.bodyGraphics.clear();
    const half = this._size / 2;

    // lineStyle MUST come after clear() — Graphics is command-buffered and
    // clear() wipes prior styles (project gotcha, see §4.2 of the enemy doc).
    this.bodyGraphics.lineStyle(2, this._color, 1);
    this.bodyGraphics.fillStyle(this._color, 0.35);

    // Diamond: top → right → bottom → left → close.
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(0, -half);
    this.bodyGraphics.lineTo(half, 0);
    this.bodyGraphics.lineTo(0, half);
    this.bodyGraphics.lineTo(-half, 0);
    this.bodyGraphics.closePath();
    this.bodyGraphics.fillPath();
    this.bodyGraphics.strokePath();
  }

  /** Live particle-explosion handles (copy — for tests/SHUTDOWN checks). */
  getExplosionHandles(): ExplosionHandle[] {
    return this.explosionHandles.slice();
  }

  // ── Public state ─────────────────────────────────────────────────

  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
    if (!value) this._lastFireTime = 0;
  }

  /** The position aimed at when firing (defaults to the bottom-centre stand-in). */
  get aimTarget(): Phaser.Math.Vector2 {
    return this.target.clone();
  }

  /**
   * Live aim tracking: retargets the coordinated burst to the player's
   * current position (replaces the fixed bottom-centre stand-in default).
   */
  setAimTarget(x: number, y: number): void {
    this.target.set(x, y);
  }

  get effectiveSize(): number { return this._size; }
  get effectiveColor(): number { return this._color; }

  get clusterIndex(): number {
    return this.clusterIdx;
  }

  // ── Behaviour ────────────────────────────────────────────────────

  /**
   * Fires a coordinated burst volley: multiple swarm members fire
   * simultaneously toward the target. Returns a single bullet (the
   * scene collects from every entity and the volley is the result
   * of all entities returning bullets in the same frame).
   *
   * The bullet travels in a direction shared by all members of the
   * volley (toward the target position), so the "coordinated burst"
   * is a set of bullets fanning slightly from each emitter position.
   *
   * The bullet is created immediately once the burst interval elapses;
   * the scene plays the volley-level burst sound at the point of shooting.
   */
  tryFireBurstBullet(now: number): SwarmBullet | null {
    if (!this._shootEnabled || !this._alive) return null;
    if (now - this._lastFireTime < this._fireInterval) return null;
    // Per-cycle probability gate: consume the cycle first so a failed roll
    // cannot retry-until-success within the same cycle (average volley
    // density = shotProbability × member count per cycle for the swarm).
    this._lastFireTime = now;
    if (!(this._rng() < this._shotProbability)) return null;

    // Swarm coordinated burst: single buzzing whoosh per volley.
    playSwarmBurstSound();

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const baseAngle = Math.atan2(dy, dx);
    // Spread angle: ±~17° around the aim direction for a tight burst.
    const spread = (Math.random() - 0.5) * 0.3;
    const angle = baseAngle + spread;

    const { graphics, color } = createBullet({
      scene: this.scene,
      color: this._bulletColor,
      size: this._bulletSize,
      x: this.x,
      y: this.y,
    });

    return {
      graphics,
      color,
      vx: Math.cos(angle) * this._bulletSpeed,
      vy: Math.sin(angle) * this._bulletSpeed,
      lifetime: this._bulletLifetime,
      elapsed: 0,
    };
  }

  /**
   * Applies the formation translation for this frame. Each swarm member
   * adds its cluster-specific drift on top of the base formation position.
   *
   * Cluster movement: members in the same cluster share a similar phase so
   * they move together, but the phase drifts over time causing the cluster
   * to split and rejoin. The result is a tight, fast-moving, unpredictable
   * cluster that stays together but can split and rejoin — per GDD §4.1.
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;

    // Base formation position from the scene.

    // ── Cluster drift ─────────────────────────────────────────────
    // Phase advances each frame; the sine wave produces smooth
    // oscillation that causes the cluster to weave back and forth.
    this.clusterDriftPhase += dt * CLUSTER_PHASE_SPEED;
    // Split/rejoin: every so often the cluster "decides" to drift
    // further from or closer to its neighbours.
    if (this.nextSplitTime <= 0) {
      // Flip bias direction (toward or away from cluster centre).
      this.clusterBias = this.clusterBias * (-0.7 + Math.random() * 0.4); // decay toward 0
      this.nextSplitTime = 1.5 + Math.random() * 3;
    }
    this.nextSplitTime -= dt;

    // Sinusoidal drift: x and y oscillate at slightly different
    // frequencies to produce chaotic-looking (but deterministic) paths.
    // Amplitudes are a fraction of the slot spacing so members stay a
    // tight pack while still visibly weaving (GDD §4.1 "tight, fast-moving
    // clusters").
    const driftX =
      Math.sin(this.clusterDriftPhase + this.clusterPhase) *
        spacingX *
        0.3 +
      this.clusterBias * spacingX * 0.2;
    const driftY =
      Math.cos(this.clusterDriftPhase * 1.37 + this.clusterPhase) *
      spacingY *
      0.25;

    // ── Final position ────────────────────────────────────────────
    const base = this.computeFormationPosition(baseX, baseY, spacingX, spacingY);
    this.setPosition(base.x + driftX, base.y + driftY);

    // Diamond rotation: slight tilt based on movement direction.
    this.bodyGraphics.rotation = Math.atan2(driftY, driftX) * 0.15;
  }
}

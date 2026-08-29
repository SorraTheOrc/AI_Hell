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

import { FormationOffset } from '../utils/formations';

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
}

/**
 * A bullet fired by a swarm member during a coordinated burst volley.
 */
export interface SwarmBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
}

/**
 * A Swarm enemy entity that moves in tight, fast-moving clusters with
 * sudden direction changes.
 */
export class Swarm extends Phaser.GameObjects.Container {
  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private readonly explosionGraphics: Phaser.GameObjects.Graphics;
  private readonly target: Phaser.Math.Vector2;
  private readonly formationOffset: FormationOffset;
  /** Which cluster this member belongs to (0..SWARM_CLUSTER_COUNT-1). */
  private readonly clusterIdx: number;

  private _alive = true;
  private _shootEnabled = false;
  private _lastBurstTime = 0;

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
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;
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

    // Body — small diamond (rotated square) in neon blue.
    this.bodyGraphics = scene.add.graphics();
    this._drawBody();
    this.bodyGraphics.setDepth(1);
    this.add(this.bodyGraphics);

    // Explosion bursts.
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(2);
    this.add(this.explosionGraphics);
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draws a diamond shape (square rotated 45°) centred at (0, 0).
   * Style is applied AFTER clear() (see note in _drawBody).
   */
  private _drawBody(): void {
    this.bodyGraphics.clear();
    const half = SWARM_SIZE / 2;

    // lineStyle MUST come after clear() — Graphics is command-buffered and
    // clear() wipes prior styles (project gotcha, see §4.2 of the enemy doc).
    this.bodyGraphics.lineStyle(2, SWARM_COLOR, 1);
    this.bodyGraphics.fillStyle(SWARM_COLOR, 0.35);

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

  /**
   * Plays the destruction animation: expanding, fading rings.
   * The body is hidden immediately and the explosion graphics are
   * cleaned up when the tween completes.
   */
  playExplosion(): void {
    const scene = this.scene as Phaser.Scene;
    scene.tweens.add({
      targets: this.explosionGraphics,
      alpha: { from: 1, to: 0 },
      duration: 400,
      onUpdate: () => {
        const alpha = this.explosionGraphics.alpha;
        const radius = SWARM_SIZE * 2 * (1 - alpha) + SWARM_SIZE * 0.25;
        this.explosionGraphics.clear();
        this.explosionGraphics.lineStyle(
          Math.max(1, Math.round(3 * alpha)),
          SWARM_COLOR,
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
    if (!value) this._lastBurstTime = 0;
  }

  get offset(): FormationOffset {
    return { ...this.formationOffset };
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

  get clusterIndex(): number {
    return this.clusterIdx;
  }

  // ── Behaviour ────────────────────────────────────────────────────

  destroySelf(): void {
    if (!this._alive) return;
    this._alive = false;
    this.bodyGraphics.setAlpha(0);
    this.playExplosion();
  }

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
    if (now - this._lastBurstTime < SWARM_BURST_INTERVAL) return null;
    this._lastBurstTime = now;

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const baseAngle = Math.atan2(dy, dx);
    // Spread angle: ±~17° around the aim direction for a tight burst.
    const spread = (Math.random() - 0.5) * 0.3;
    const angle = baseAngle + spread;

    const graphics = this.scene.add.graphics();
    graphics.fillStyle(SWARM_BULLET_COLOR, 1);
    graphics.fillCircle(0, 0, SWARM_BULLET_SIZE);
    graphics.setPosition(this.x, this.y);
    graphics.setDepth(3);

    return {
      graphics,
      color: SWARM_BULLET_COLOR,
      vx: Math.cos(angle) * SWARM_BULLET_SPEED,
      vy: Math.sin(angle) * SWARM_BULLET_SPEED,
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
    const baseOffsetCol = this.formationOffset.col;
    const baseOffsetRow = this.formationOffset.row;

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
    const x = baseX + baseOffsetCol * spacingX + driftX;
    const y = baseY + baseOffsetRow * spacingY + driftY;
    this.setPosition(x, y);

    // Diamond rotation: slight tilt based on movement direction.
    this.bodyGraphics.rotation = Math.atan2(driftY, driftX) * 0.15;
  }

  destroy(fromScene?: boolean): void {
    this.bodyGraphics.destroy();
    this.explosionGraphics.destroy();
    super.destroy(fromScene);
  }
}

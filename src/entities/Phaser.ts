/**
 * Phaser enemy entity (GDD §4.1 — E4 Phaser, Level 5 exclusive).
 *
 * Renders as a circular neon ring (magenta `#ff00ff`) with a central core.
 * Moves in fixed orbital paths around the formation centre. Fires in
 * predictable, repeating radial patterns with clear tell animations and
 * advance audio cues (≥ 500 ms lead time) before each firing cycle.
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation, and
 * is removed. Phasers never collide with each other (GDD §2.6): the scene
 * does not install any collision between Phasers.
 */

import Phaser from 'phaser';

import { FormationOffset } from '../utils/formations';
import { playDestructionSound } from '../audio/effects';

// ── Visual / behaviour tuning (per GDD §4.1) ────────────────────────

/** Magenta body colour per GDD §4.1 art direction. */
export const PHASER_COLOR = '#ff00ff';

/** Magenta colour as a number for Phaser fillStyle (hex RGB). */
export const PHASER_COLOR_NUMBER = 0xff00ff;

/** Outer ring radius in px. */
export const PHASER_SIZE = 14;

/** Inner core radius in px. */
export const PHASER_CORE_SIZE = 5;

/** Orbital radius — how far each Phaser orbits from the formation centre (px). */
export const PHASER_ORBITAL_RADIUS = 80;

/** Orbital angular speed (radians/s). */
export const PHASER_ORBITAL_SPEED = 0.4;

/** Firing interval (ms) — how often Phasers fire in predictable cycles. */
export const PHASER_FIRE_INTERVAL = 2000;

/** Advance audio cue duration (ms) — minimum 500 ms lead time per GDD. */
export const PHASER_ADVANCE_CUE_DURATION = 600;

/** Bullet colour (red, distinct from the magenta body). */
export const PHASER_BULLET_COLOR = 0xff4444;

/** Bullet radius in px. */
export const PHASER_BULLET_SIZE = 3;

/** Bullet speed in px/s. */
export const PHASER_BULLET_SPEED = 180;

/** Ring stroke width in px. */
export const PHASER_RING_WIDTH = 2;

/** Number of Phasers in the orbital formation. */
export const PHASER_FORMATION_COUNT = 4;

/** Orbital spacing — phase offset between Phasers (fraction of 2π). */
export const PHASER_ORBITAL_PHASE_SPACING = Math.PI / 2;

export interface PhaserConfig {
  x: number;
  y: number;
  /** Offset within the orbital formation; used to determine orbit phase. */
  formationOffset: FormationOffset;
}

/**
 * A bullet fired by a Phaser. Drawn as a small filled circle; travels
 * in a straight line until it leaves the screen bounds.
 */
export interface PhaserBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
}

export class PhaserEntity extends Phaser.GameObjects.Container {
  private readonly ringGraphics: Phaser.GameObjects.Graphics;
  private readonly coreGraphics: Phaser.GameObjects.Graphics;
  private readonly explosionGraphics: Phaser.GameObjects.Graphics;
  private readonly tellGraphics: Phaser.GameObjects.Graphics;
  private readonly formationOffset: FormationOffset;

  private _alive = true;
  private _shootEnabled = false;
  private _lastFireTime = 0;
  private _tellStartTime = 0;
  private _isTelling = false;
  private _orbitalPhase: number;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: PhaserConfig) {
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;
    // Each Phaser gets a unique orbital phase based on its offset index.
    this._orbitalPhase = this._computeOrbitalPhase(config.formationOffset);

    // Outer ring — magenta neon circle.
    this.ringGraphics = scene.add.graphics();
    this._drawBody();
    this.ringGraphics.setDepth(1);
    this.add(this.ringGraphics);

    // Inner core — solid magenta circle.
    this.coreGraphics = scene.add.graphics();
    this.coreGraphics.fillStyle(PHASER_COLOR_NUMBER, 0.8);
    this.coreGraphics.fillCircle(0, 0, PHASER_CORE_SIZE);
    this.coreGraphics.setDepth(2);
    this.add(this.coreGraphics);

    // Explosion graphics.
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(3);
    this.add(this.explosionGraphics);

    // Tell graphics — visual warning before firing.
    this.tellGraphics = scene.add.graphics();
    this.tellGraphics.setDepth(0);
    this.add(this.tellGraphics);
  }

  /**
   * Computes the orbital phase for this Phaser based on its formation
   * offset. The phase determines where in the orbit this Phaser sits.
   */
  private _computeOrbitalPhase(offset: FormationOffset): number {
    const index = offset.row * 10 + offset.col;
    return index * PHASER_ORBITAL_PHASE_SPACING;
  }

  // ── Drawing ──────────────────────────────────────────────────────

  private _drawBody(): void {
    this.ringGraphics.clear();
    const half = PHASER_SIZE / 2;

    // Style must be set AFTER clear(): Graphics is command-buffered.
    this.ringGraphics.lineStyle(PHASER_RING_WIDTH, PHASER_COLOR_NUMBER, 1);

    // Circular neon ring.
    this.ringGraphics.strokeCircle(0, 0, half + 4);
  }

  /**
   * Plays the destruction animation: expanding, fading rings.
   * The body is hidden immediately and the explosion graphics are
   * cleaned up when the tween completes.
   */
  playExplosion(): void {
    playDestructionSound();

    const scene = this.scene as Phaser.Scene;
    scene.tweens.add({
      targets: this.explosionGraphics,
      alpha: { from: 1, to: 0 },
      duration: 400,
      onUpdate: () => {
        const alpha = this.explosionGraphics.alpha;
        const radius = PHASER_SIZE * 2 * (1 - alpha) + PHASER_SIZE * 0.25;
        this.explosionGraphics.clear();
        this.explosionGraphics.lineStyle(
          Math.max(1, Math.round(3 * alpha)),
          PHASER_COLOR_NUMBER,
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

  /** Whether this Phaser is alive (not yet destroyed). */
  get alive(): boolean {
    return this._alive;
  }

  /** Whether this Phaser currently fires. */
  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
    if (!value) {
      this._lastFireTime = 0;
      this._isTelling = false;
      this._tellStartTime = 0;
      this.tellGraphics.clear();
    } else {
      // When enabling, set _lastFireTime so the first cycle starts immediately.
      // The check in tryFireRadialBullets is (now - _lastFireTime < FIRE_INTERVAL).
      // Setting to (now - FIRE_INTERVAL) makes the difference equal to FIRE_INTERVAL,
      // so the condition fails and we proceed to start the tell.
      this._lastFireTime = (this.scene as Phaser.Scene).time.now - PHASER_FIRE_INTERVAL;
    }
  }

  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }

  /** Whether the Phaser is currently in its tell (warning) state. */
  get isTelling(): boolean {
    return this._isTelling;
  }

  // ── Behaviour ────────────────────────────────────────────────────

  /**
   * Destroys the Phaser: hides the body and plays the explosion animation.
   * No-op if already destroyed.
   */
  destroySelf(): void {
    if (!this._alive) return;
    this._alive = false;
    this.ringGraphics.setAlpha(0);
    this.coreGraphics.setAlpha(0);
    this.playExplosion();
  }

  /**
   * Fires a radial burst pattern of bullets. All Phasers fire simultaneously
   * in 8 directions (up, down, left, right, and 4 diagonals).
   *
   * Returns bullets on success, empty array if none.
   */
  tryFireRadialBullets(now: number): PhaserBullet[] {
    if (!this._shootEnabled || !this._alive) return [];
    if (now - this._lastFireTime < PHASER_FIRE_INTERVAL) return [];

    // Check if we're in tell state — if so, fire now.
    if (this._isTelling) {
      this._isTelling = false;
      this.tellGraphics.clear();
      this._lastFireTime = now;

      // Fire in 8 radial directions.
      const bullets: PhaserBullet[] = [];
      const directions = [
        { dx: 0, dy: -1 },    // up
        { dx: 0, dy: 1 },     // down
        { dx: -1, dy: 0 },    // left
        { dx: 1, dy: 0 },     // right
        { dx: -1, dy: -1 },   // up-left
        { dx: 1, dy: -1 },    // up-right
        { dx: -1, dy: 1 },    // down-left
        { dx: 1, dy: 1 },     // down-right
      ];

      for (const dir of directions) {
        const graphics = this.scene.add.graphics();
        graphics.fillStyle(PHASER_BULLET_COLOR, 1);
        graphics.fillCircle(0, 0, PHASER_BULLET_SIZE);
        graphics.setPosition(this.x, this.y);
        graphics.setDepth(3);

        // Normalise direction.
        const mag = Math.sqrt(dir.dx * dir.dx + dir.dy * dir.dy) || 1;
        bullets.push({
          graphics,
          color: PHASER_BULLET_COLOR,
          vx: (dir.dx / mag) * PHASER_BULLET_SPEED,
          vy: (dir.dy / mag) * PHASER_BULLET_SPEED,
        });
      }
      return bullets;
    }

    // Start the tell animation — this is the warning phase.
    this._isTelling = true;
    this._tellStartTime = now;
    // The actual firing happens on the next call after the tell duration.
    return [];
  }

  /**
   * Applies the orbital movement for this frame. Instead of a flat
   * grid translation, each Phaser orbits around the formation centre
   * at its assigned phase offset.
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    _dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;

    // The orbital centre is the formation base.
    const centerX = baseX;
    const centerY = baseY;

    // Advance orbital angle using the scene's time.
    const sceneTime = (this.scene as Phaser.Scene).time.now;
    const currentAngle = this._orbitalPhase + sceneTime * 0.001 * PHASER_ORBITAL_SPEED;

    // Compute orbital position.
    const x = centerX + PHASER_ORBITAL_RADIUS * Math.cos(currentAngle);
    const y = centerY + PHASER_ORBITAL_RADIUS * Math.sin(currentAngle);
    this.setPosition(x, y);

    // Handle tell animation if firing is enabled.
    if (this._shootEnabled && this._isTelling) {
      const elapsed = sceneTime - this._tellStartTime;
      if (elapsed < PHASER_ADVANCE_CUE_DURATION) {
        // During the tell, pulse the ring to warn the player.
        this._drawTell(elapsed);
        // Play advance audio cue at the start of the tell (once).
        if (elapsed < 50) {
          this._playAdvanceCue();
        }
      }
    }
  }

  /** Draws the visual tell (warning) animation. */
  private _drawTell(elapsed: number): void {
    this.tellGraphics.clear();
    const progress = elapsed / PHASER_ADVANCE_CUE_DURATION;
    const alpha = 0.5 + 0.5 * Math.sin(progress * Math.PI * 4);
    const radius = PHASER_SIZE + 8 + 4 * Math.sin(progress * Math.PI * 2);

    this.tellGraphics.lineStyle(2, PHASER_COLOR_NUMBER, alpha);
    this.tellGraphics.strokeCircle(0, 0, radius);
  }

  /** Plays the advance audio cue (≥ 500 ms before fire). */
  private _playAdvanceCue(): void {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(1, 880),
      ctx.currentTime + PHASER_ADVANCE_CUE_DURATION / 1000,
    );

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + PHASER_ADVANCE_CUE_DURATION / 1000);

    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + PHASER_ADVANCE_CUE_DURATION / 1000 + 0.02);
  }

  destroy(fromScene?: boolean): void {
    this.ringGraphics.destroy();
    this.coreGraphics.destroy();
    this.explosionGraphics.destroy();
    this.tellGraphics.destroy();
    super.destroy(fromScene);
  }
}

/** Lazily creates the shared AudioContext, or returns null if unavailable. */
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    return new Ctor();
  } catch {
    return null;
  }
}

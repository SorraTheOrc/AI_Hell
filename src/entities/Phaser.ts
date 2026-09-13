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
 *
 * Audio (GDD §7.3): destruction audio is owned by the base scene
 * (`playDestructionSound()`), not by this entity (no double-play). The
 * helper lives in `src/audio/effects.ts` and degrades to a safe no-op
 * without an AudioContext.
 */

import Phaser from 'phaser';

import { HIT_RADIUS_BUFFER_PX } from '../core/constants';
import { FormationOffset } from '../utils/formations';
import {
  resolvePatterns,
  spawnExplosionParticles,
  type ExplosionHandle,
} from '../vfx/explosionParticles';

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
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  fireInterval?: number;
  burstCount?: number;
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
  /** Live particle-explosion handles (SHUTDOWN-safe teardown in destroy()). */
  private readonly explosionHandles: ExplosionHandle[] = [];
  private readonly tellGraphics: Phaser.GameObjects.Graphics;
  private readonly formationOffset: FormationOffset;

  private _alive = true;
  private _shootEnabled = false;
  private _lastFireTime = 0;
  /** Seconds (local phase) when the tell (warning) animation started. */
  private _tellStartTime = 0;
  private _isTelling = false;
  private _orbitalPhase: number;
  /** Local phase accumulator for orbital rotation (seconds, dt-driven;
   *  replaces `scene.time.now`).  Allows the entity to compute its orbital
   *  position without a `scene` ref, which is required for correctness when
   *  the entity is stale after a scene restart (its `this.scene` is
   *  undefined). */
  private _localPhase = 0;
  /** Aim point for the radial pattern — the fixed bottom-centre stand-in by default. */
  private readonly target: Phaser.Math.Vector2;
  private readonly _size: number;
  private readonly _colorNumber: number;
  private readonly _bulletColor: number;
  private readonly _bulletSize: number;
  private readonly _bulletSpeed: number;
  private readonly _fireInterval: number;
  private readonly _burstCount: number;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: PhaserConfig) {
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;
    // Each Phaser gets a unique orbital phase based on its offset index.
    this._orbitalPhase = this._computeOrbitalPhase(config.formationOffset);
    this._size = config.size ?? PHASER_SIZE;
    this._colorNumber = config.color ?? PHASER_COLOR_NUMBER;
    this._bulletColor = config.bulletColor ?? PHASER_BULLET_COLOR;
    this._bulletSize = config.bulletSize ?? PHASER_BULLET_SIZE;
    this._bulletSpeed = config.bulletSpeed ?? PHASER_BULLET_SPEED;
    this._fireInterval = config.fireInterval ?? PHASER_FIRE_INTERVAL;
    this._burstCount = config.burstCount ?? 8;
    // Aim point defaults to the bottom-centre stand-in (simulated player).
    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // Outer ring — magenta neon circle.
    this.ringGraphics = scene.add.graphics();
    this._drawBody();
    this.ringGraphics.setDepth(1);
    this.add(this.ringGraphics);

    // Inner core — solid magenta circle.
    this.coreGraphics = scene.add.graphics();
    this.coreGraphics.fillStyle(this._colorNumber, 0.8);
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
    const half = this._size / 2;

    // Style must be set AFTER clear(): Graphics is command-buffered.
    this.ringGraphics.lineStyle(PHASER_RING_WIDTH, this._colorNumber, 1);

    // Circular neon ring.
    this.ringGraphics.strokeCircle(0, 0, half + 4);
  }

  /**
   * Plays the destruction animation: expanding, fading rings.
   * The body is hidden immediately and the explosion graphics are
   * cleaned up when the tween completes.
   *
   * NOTE: intentionally plays NO destruction sound here — the shared
   * `playDestructionSound()` is owned by `GymFormationScene.explodeRandom()`
   * and is already called once per destruction (design doc §7 no-double-play
   * rule). Adding a call here would double-play.
   *
   * Belt-and-braces null-scene guard (AH-0MTPLHLZ3006MOC4): a destroyed
   * display-list child has `scene === undefined`; animating it here would
   * dereference undefined. Normal single-run destruction keeps the old
   * behaviour exactly (the guard never triggers on a live object).
   */
  playExplosion(): void {
    if (!this.scene) return;
    const scene = this.scene as Phaser.Scene;
    const handle = spawnExplosionParticles(
      scene,
      this.x,
      this.y,
      this._colorNumber,
      this._size,
      { patterns: resolvePatterns('phaser') },
    );
    if (handle) this.explosionHandles.push(handle);
  }

  /** Live particle-explosion handles (copy — for tests/SHUTDOWN checks). */
  getExplosionHandles(): ExplosionHandle[] {
    return this.explosionHandles.slice();
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
      // When enabling, arm the first cycle to start immediately.  The
      // interval gate in tryFireRadialBullets is
      //   (now - _lastFireTime < _fireInterval) → blocked
      // so a large negative sentinel makes now - _lastFireTime always
      // exceed the interval for any scene clock value (which starts at 0
      // and grows).  This replaces the old `scene.time.now - interval`
      // (which read this.scene — a crash vector for stale entities)
      // without changing the observable behaviour: the first eligible
      // call starts the tell right away.
      this._lastFireTime = -this._fireInterval;
    }
  }

  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }

  get effectiveSize(): number { return this._size; }
  get effectiveColor(): number { return this._colorNumber; }
  get effectiveBurstCount(): number { return this._burstCount; }

  /**
   * Hit radius (px) used for collision checks against this entity.
   *
   * Returns `Math.ceil(visualHalfSize + HIT_RADIUS_BUFFER_PX)` so the
   * hit circle is proportionally sized to the entity's visual half-size
   * with a small gameplay buffer (default 2 px) for visual stroke
   * thickness.
   */
  getHitRadius(): number {
    return Math.ceil(this._size / 2 + HIT_RADIUS_BUFFER_PX);
  }
  /** Whether the Phaser is currently in its tell (warning) state. */
  get isTelling(): boolean {
    return this._isTelling;
  }

  /** The position the radial pattern is aimed at (stand-in by default). */
  get aimTarget(): Phaser.Math.Vector2 {
    return this.target.clone();
  }

  /**
   * Live aim tracking: rotates the radial pattern so one spoke points at
   * the player's current position (replaces the bottom-centre stand-in
   * default). The 8-spoke radial shape, speed, tell, and fire interval are
   * unchanged.
   */
  setAimTarget(x: number, y: number): void {
    this.target.set(x, y);
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
    if (now - this._lastFireTime < this._fireInterval) return [];

    // Check if we're in tell state — if so, fire now.
    if (this._isTelling) {
      this._isTelling = false;
      this.tellGraphics.clear();
      this._lastFireTime = now;

      // Fire in 8 radial directions, rotated so one spoke points exactly
      // at the aim target (stand-in by default, live player position when
      // the scene pushes it). The 8-spoke radial shape is unchanged.
      const bullets: PhaserBullet[] = [];
      const baseAngle = Math.atan2(
        this.target.y - this.y,
        this.target.x - this.x,
      );
      const directions = Array.from({ length: this._burstCount }, (_, k) => {
        const angle = baseAngle + (k * Math.PI * 2) / this._burstCount;
        return { dx: Math.cos(angle), dy: Math.sin(angle) };
      });

      for (const dir of directions) {
        const graphics = this.scene.add.graphics();
        graphics.fillStyle(this._bulletColor, 1);
        graphics.fillCircle(0, 0, this._bulletSize);
        graphics.setPosition(this.x, this.y);
        graphics.setDepth(3);

        // Normalise direction.
        const mag = Math.sqrt(dir.dx * dir.dx + dir.dy * dir.dy) || 1;
        bullets.push({
          graphics,
          color: this._bulletColor,
          vx: (dir.dx / mag) * this._bulletSpeed,
          vy: (dir.dy / mag) * this._bulletSpeed,
        });
      }
      return bullets;
    }

    // Start the tell animation — this is the warning phase.
    this._isTelling = true;
    // Store the local phase (in seconds) so applyFormationPosition can
    // compute tell elapsed without accessing scene.time.now.
    this._tellStartTime = this._localPhase;
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
    dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;

    // The orbital centre is the formation base.
    const centerX = baseX;
    const centerY = baseY;

    // Advance orbital angle using a local phase accumulator instead of
    // `scene.time.now` so the entity does not crash when its `scene` is
    // undefined (stale after a scene restart — the SHUTDOWN teardown
    // destroys it first).
    this._localPhase += dt;
    const currentAngle =
      this._orbitalPhase + this._localPhase * PHASER_ORBITAL_SPEED;

    // Compute orbital position.
    const x = centerX + PHASER_ORBITAL_RADIUS * Math.cos(currentAngle);
    const y = centerY + PHASER_ORBITAL_RADIUS * Math.sin(currentAngle);
    this.setPosition(x, y);

    // Handle tell animation if firing is enabled.
    if (this._shootEnabled && this._isTelling) {
      // Tell elapsed in ms (local phase is in seconds).
      const tellElapsed =
        Math.max(0, this._localPhase - this._tellStartTime) * 1000;
      if (tellElapsed < PHASER_ADVANCE_CUE_DURATION) {
        // During the tell, pulse the ring to warn the player.
        this._drawTell(tellElapsed);
        // Play advance audio cue at the start of the tell (once).
        if (tellElapsed < 50) {
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
    const radius = this._size + 8 + 4 * Math.sin(progress * Math.PI * 2);

    this.tellGraphics.lineStyle(2, this._colorNumber, alpha);
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
    // Scene-level particle Graphics are NOT display-list children —
    // destroy them explicitly so SHUTDOWN/stop→restart leaks nothing.
    for (const handle of this.explosionHandles) handle.destroy();
    this.explosionHandles.length = 0;
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

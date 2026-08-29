/**
 * Scout enemy entity (GDD §4.1 — E1 Scout).
 *
 * Renders as a small, angular neon-green chevron. Flies in a V-formation
 * with other scouts (formation geometry is defined by the offset passed
 * from the scene). At Level 4+ (simulated by shoot mode) it fires aimed
 * shots toward a target position.
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation, and
 * is removed. Scouts never collide with each other (GDD §2.6): the scene
 * does not install any collision between scouts.
 *
 * Audio (GDD §7.3): each aimed shot is telegraphed by a ≥ 500 ms advance
 * cue (two-phase tell) followed by a sharp Scout fire sound at the shot;
 * destruction audio is owned by the base scene (`playDestructionSound()`),
 * not by this entity (no double-play). Both helpers live in
 * `src/audio/effects.ts` and degrade to safe no-ops without an
 * AudioContext.
 */

import Phaser from 'phaser';

import { FormationOffset } from '../utils/formations';
import { playScoutAdvanceCue, playScoutFireSound } from '../audio/effects';

export type { FormationOffset } from '../utils/formations';

export { buildVFormationOffsets } from '../utils/formations';

// ── Visual / behaviour tuning (per GDD §4.1) ────────────────────────

/** Neon-green body colour per GDD §4.1 art direction. */
export const SCOUT_COLOR = 0x00ff00;

/** Half-size of the scout (the chevron spans SCOUT_SIZE px). */
export const SCOUT_SIZE = 16;

/** Aimed-bullet colour (red, distinct from the green body). */
export const SCOUT_BULLET_COLOR = 0xff4444;

/** Bullet radius in px. */
export const SCOUT_BULLET_SIZE = 3;

/** Bullet speed in px/s. */
export const SCOUT_BULLET_SPEED = 200;

/** Milliseconds a scout waits between aimed shots. */
export const SCOUT_FIRE_INTERVAL = 1200;

/**
 * Advance audio cue duration (ms) — the per-entity tell before each
 * aimed shot. At least 500 ms lead time per GDD §7.3 and at most the
 * fire interval so cues never overlap shots. Mirrors the Phaser tell
 * (PHASER_ADVANCE_CUE_DURATION = 600) and matches playScoutAdvanceCue()
 * in src/audio/effects.ts (declare both 600).
 */
export const SCOUT_ADVANCE_CUE_DURATION = 600;

export interface ScoutConfig {
  x: number;
  y: number;
  /** Offset within the V-formation; the scene computes absolute position. */
  formationOffset: FormationOffset;
}

/**
 * A bullet fired by a scout. Drawn as a small filled circle; travelled
 * purely from physics (no collision with anything) until it leaves the
 * screen bounds.
 */
export interface ScoutBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
}

export class Scout extends Phaser.GameObjects.Container {
  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private readonly explosionGraphics: Phaser.GameObjects.Graphics;
  private readonly target: Phaser.Math.Vector2;
  private readonly formationOffset: FormationOffset;

  private _alive = true;
  private _shootEnabled = false;
  private _lastFireTime = 0;
  private _tellStartTime = 0;
  private _isTelling = false;
  private _wigglePhase = Math.random() * Math.PI * 2;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: ScoutConfig) {
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;
    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // Body — small angular neon-green chevron pointing "down". The stroke
    // style is applied inside _drawBody() AFTER clear() (see note there).
    this.bodyGraphics = scene.add.graphics();
    this._drawBody();
    this.bodyGraphics.setDepth(1);
    this.add(this.bodyGraphics);

    // Explosion bursts drawn on a separate graphics layer.
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(2);
    this.add(this.explosionGraphics);
  }

  // ── Drawing ──────────────────────────────────────────────────────

  private _drawBody(): void {
    this.bodyGraphics.clear();
    const half = SCOUT_SIZE / 2;

    // Style must be set AFTER clear(): Graphics is command-buffered and
    // clear() wipes any styles queued before it (it only re-applies the
    // default white 1px stroke). The original code called lineStyle()
    // before clear(), so the chevron was stroked with the default style
    // and rendered invisible in a real browser (headless tests cannot
    // see pixels, so the suite stayed green).
    this.bodyGraphics.lineStyle(2, SCOUT_COLOR, 1);

    // Angular chevron pointing down (inverted player-ship silhouette).
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(0, half);
    this.bodyGraphics.lineTo(half, -half * 0.4);
    this.bodyGraphics.lineTo(0, -half * 0.2);
    this.bodyGraphics.lineTo(-half, -half * 0.4);
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
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
   */
  playExplosion(): void {
    const scene = this.scene as Phaser.Scene;
    scene.tweens.add({
      targets: this.explosionGraphics,
      alpha: { from: 1, to: 0 },
      duration: 400,
      onUpdate: () => {
        // Read the tweened property directly (Phaser 4 tweens it in place).
        const alpha = this.explosionGraphics.alpha;
        const radius = SCOUT_SIZE * 2 * (1 - alpha) + SCOUT_SIZE * 0.25;
        this.explosionGraphics.clear();
        this.explosionGraphics.lineStyle(Math.max(1, Math.round(3 * alpha)), SCOUT_COLOR, alpha);
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

  /** Whether this scout is alive (not yet destroyed). */
  get alive(): boolean {
    return this._alive;
  }

  /** Whether the scout body is currently visible (hidden on destruction). */
  get bodyVisible(): boolean {
    return this.bodyGraphics.alpha > 0 && this.bodyGraphics.visible;
  }

  /** Whether this scout currently fires aimed shots. */
  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  /** Whether the scout is currently in its firing tell (advance cue) state. */
  get isTelling(): boolean {
    return this._isTelling;
  }

  /** Enable/disable aimed firing (simulates Level 4+ behaviour). */
  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
    if (!value) {
      this._lastFireTime = 0;
      this._isTelling = false;
      this._tellStartTime = 0;
    }
  }

  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }

  /** The position aimed at when firing. */
  get aimTarget(): Phaser.Math.Vector2 {
    return this.target.clone();
  }

  /**
   * Live aim tracking: retargets aimed shots to the player's current
   * position (replaces the fixed bottom-centre stand-in used as default).
   */
  setAimTarget(x: number, y: number): void {
    this.target.set(x, y);
  }

  // ── Behaviour ────────────────────────────────────────────────────

  /**
   * Destroys the scout: hides the body and plays the explosion animation.
   * No-op if already destroyed.
   */
  destroySelf(): void {
    if (!this._alive) return;
    this._alive = false;
    this.bodyGraphics.setAlpha(0);
    this.playExplosion();
  }

  /**
   * Fires an aimed shot toward the target if shoot mode is on, the scout
   * is alive, and the fire interval has elapsed. Returns the bullet on
   * success, null otherwise (no shot) — lets the scene stay unaware of
   * firing policy.
   *
   * Two-phase tell (mirrors the Phaser entity, GDD §7.3): once the fire
   * interval elapses the first call STARTS the tell — plays the ≥ 500 ms
   * advance audio cue and returns no bullet; a later call made after the
   * tell duration completes fires the shot and plays the Scout fire sound
   * exactly once. This telegraphes aimed shots so players can react.
   */
  tryFireAimedBullet(now: number): ScoutBullet | null {
    if (!this._shootEnabled || !this._alive) return null;
    if (now - this._lastFireTime < SCOUT_FIRE_INTERVAL) return null;

    if (this._isTelling) {
      // Still inside the tell window — the shot has not been announced
      // for the full ≥ 500 ms lead yet; wait for the cue to complete.
      if (now - this._tellStartTime < SCOUT_ADVANCE_CUE_DURATION) return null;
      // Tell complete → fire this shot now.
      this._isTelling = false;
      this._tellStartTime = 0;
      this._lastFireTime = now;
    } else {
      // Interval elapsed, not telling — start the tell (advance cue).
      this._isTelling = true;
      this._tellStartTime = now;
      playScoutAdvanceCue();
      return null;
    }

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    const graphics = this.scene.add.graphics();
    graphics.fillStyle(SCOUT_BULLET_COLOR, 1);
    graphics.fillCircle(0, 0, SCOUT_BULLET_SIZE);
    graphics.setPosition(this.x, this.y);
    graphics.setDepth(3);

    playScoutFireSound();

    return {
      graphics,
      color: SCOUT_BULLET_COLOR,
      vx: (dx / dist) * SCOUT_BULLET_SPEED,
      vy: (dy / dist) * SCOUT_BULLET_SPEED,
    };
  }

  /**
   * Applies the formation translation for this frame: the V-formation
   * geometry (offset relative to the formation base) plus a subtle
   * side-to-side wiggle for visual life.
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;

    this._wigglePhase += dt * 2;
    const wiggle = Math.sin(this._wigglePhase) * 2;

    const x = baseX + this.formationOffset.col * spacingX + wiggle;
    const y = baseY + this.formationOffset.row * spacingY;
    this.setPosition(x, y);
  }

  destroy(fromScene?: boolean): void {
    this.bodyGraphics.destroy();
    this.explosionGraphics.destroy();
    super.destroy(fromScene);
  }
}


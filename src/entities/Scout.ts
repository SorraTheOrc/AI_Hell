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
 * cue (two-phase tell); the cue flows directly into the sharp Scout fire
 * sound with no dead gap — both are scheduled at tell start, with the
 * fire sound landing exactly at the cue's end (Tank-style no-gap
 * treatment). Destruction audio is owned by the base scene
 * (`playDestructionSound()`), not by this entity (no double-play).
 * Both helpers live in `src/audio/effects.ts` and degrade to safe no-ops
 * without an AudioContext.
 */

import Phaser from 'phaser';

import { createBullet } from './bulletUtils';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { FormationOffset } from '../utils/formations';
import { playScoutAdvanceCue, playScoutFireSound } from '../audio/effects';
import { type ExplosionHandle } from '../vfx/explosionParticles';

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
 * (PHASER_ADVANCE_CUE_DURATION = 600) and the Scout analog in
 * src/audio/effects.ts (`SCOUT_ADVANCE_CUE_DURATION = 0.6` s, used by
 * `playScoutAdvanceCue()` and to schedule the fire sound at the cue's
 * end — keep both at 600 ms / 0.6 s).
 */
export const SCOUT_ADVANCE_CUE_DURATION = 600;

export interface ScoutConfig {
  x: number;
  y: number;
  /** Offset within the V-formation; the scene computes absolute position. */
  formationOffset: FormationOffset;
  /** Optional config-driven overrides; when absent the hard-coded defaults are used (no regression). */
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  fireInterval?: number;
  /**
   * Chance (fraction `0.0`–`1.0`) that this scout fires when the interval
   * elapses (per shot cycle). Defaults to `1.0` (current behaviour). A
   * failed roll consumes the cycle — no tell cue, no shot.
   */
  shotProbability?: number;
  /** Injectable random source for the per-cycle shot roll (defaults to `Math.random`). */
  rng?: () => number;
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

export class Scout extends BaseEnemy {
  // ── Scout-specific fields ────────────────────────────────────────

  private _tellStartTime = 0;
  private _isTelling = false;
  private _wigglePhase = Math.random() * Math.PI * 2;
  /** Current aim target. */
  protected readonly target: Phaser.Math.Vector2;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: ScoutConfig) {
    // Extract shared config fields for the base class, applying the
    // Scout-specific defaults for any omitted field.
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? SCOUT_SIZE,
      color: config.color ?? SCOUT_COLOR,
      bulletColor: config.bulletColor ?? SCOUT_BULLET_COLOR,
      bulletSize: config.bulletSize ?? SCOUT_BULLET_SIZE,
      bulletSpeed: config.bulletSpeed ?? SCOUT_BULLET_SPEED,
      fireInterval: config.fireInterval ?? SCOUT_FIRE_INTERVAL,
      shotProbability: config.shotProbability,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // Scout-specific initialisation — draw the unique shape and add the
    // shared graphics in the canonical render order (body then explosion).
    this._drawBody();
    this.addSharedGraphics();
  }

  /** VFX pattern name for Scout explosions. */
  protected getExplosionPatternName(): string {
    return 'scout';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  protected _drawBody(): void {
    this.bodyGraphics.clear();
    const half = this._size / 2;

    // Style must be set AFTER clear(): Graphics is command-buffered and
    // clear() wipes any styles queued before it (it only re-applies the
    // default white 1px stroke). The original code called lineStyle()
    // before clear(), so the chevron was stroked with the default style
    // and rendered invisible in a real browser (headless tests cannot
    // see pixels, so the suite stayed green).
    this.bodyGraphics.lineStyle(2, this._color, 1);

    // Angular chevron pointing down (inverted player-ship silhouette).
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(0, half);
    this.bodyGraphics.lineTo(half, -half * 0.4);
    this.bodyGraphics.lineTo(0, -half * 0.2);
    this.bodyGraphics.lineTo(-half, -half * 0.4);
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
  }

  /** Live particle-explosion handles (copy — for tests/SHUTDOWN checks). */
  getExplosionHandles(): ExplosionHandle[] {
    return this.explosionHandles.slice();
  }

  // ── Public state ─────────────────────────────────────────────────

  /** Effective config-driven size (for tests). */
  get effectiveSize(): number { return this._size; }
  /** Effective config-driven body colour. */
  get effectiveColor(): number { return this._color; }

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

  // ── Aim target ──────────────────────────────────────────────────

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
    // Belt-and-braces null-scene guard (AH-0MTVYBELZ000EZ1Y): when a scene is
    // restarted the old display-list children have `scene === undefined`;
    // ticking them here would dereference undefined (crash).
    if (!this.scene) return null;
    if (!this._shootEnabled || !this._alive) return null;
    if (now - this._lastFireTime < this._fireInterval) return null;

    if (this._isTelling) {
      // Still inside the tell window — the shot has not been announced
      // for the full ≥ 500 ms lead yet; wait for the cue to complete.
      if (now - this._tellStartTime < SCOUT_ADVANCE_CUE_DURATION) return null;
      // Tell complete → fire this shot now.
      this._isTelling = false;
      this._tellStartTime = 0;
      this._lastFireTime = now;
    } else {
      // Interval elapsed, not telling — roll the shot probability at the
      // decision point BEFORE starting the tell. A failed roll consumes
      // the cycle and never plays an advance cue that would produce no
      // shot (constraint: tell/RNG interaction).
      if (!(this._rng() < this._shotProbability)) {
        this._lastFireTime = now;
        return null;
      }
      // Start the tell (advance cue).
      // Schedule cue + fire sound back-to-back: the fire sound is
      // scheduled at currentTime + SCOUT_ADVANCE_CUE_DURATION so it
      // lands exactly as the cue ends, flowing with no dead gap.
      this._isTelling = true;
      this._tellStartTime = now;
      playScoutAdvanceCue();
      playScoutFireSound();
      return null;
    }

    const dx = this.target.x - this.x;
    const dy = this.target.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

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
      vx: (dx / dist) * this._bulletSpeed,
      vy: (dy / dist) * this._bulletSpeed,
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

    const base = this.computeFormationPosition(baseX, baseY, spacingX, spacingY);
    this.setPosition(base.x + wiggle, base.y);
  }
}


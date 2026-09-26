/**
 * Diver enemy entity (GDD §4.2 — E2 Diver).
 *
 * Renders as a medium, dart-shaped neon-yellow entity. Periodically breaks
 * from formation and dives toward the player position along a parabolic
 * arc (diagonal — x and y follow the full quadratic bezier from the
 * formation slot to the player's position at dive start), then returns
 * smoothly to its current formation slot — ending exactly on the slot as
 * it exists when the return completes, so the diver rejoins the drifting
 * formation without a horizontal snap.
 *
 * While the diver is detached from the formation (`DIVING`, `PAUSING` or
 * `RETURNING`) it reports `requiresFormationHold() === true` through the
 * shared entity seam, so the owning scene holds the whole cluster in
 * place for the entire attack; normal drift resumes once every diver has
 * rejoined. A destroyed diver reports `false`, so a mid-dive kill can
 * never freeze the cluster forever (GDD §4.1 — E2).
 *
 * During the formation hold phase the diver smoothly rotates its container
 * to visually face the player (nose points toward the target). The dart
 * sprite is drawn with its nose pointing "up" (negative y) so that the
 * container rotation aligns the nose toward the player.
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation, and
 * is removed. Divers never collide with each other (GDD §2.6).
 *
 * At Level 4+ (simulated by shoot mode) the Diver fires short-burst spread
 * shots — 3–5 projectiles at slight angles — during its dive trajectory.
 */

import Phaser from 'phaser';

import { createBullet } from './bulletUtils';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { GAME_HEIGHT } from '../core/constants';
import {
  playDiverDestructionSound,
  playDiverDiveStartSound,
  playDiveSound,
  stopDiveSound,
  playDiverFireSound,
} from '../audio/effects';
import { FormationOffset } from '../utils/formations';
import { type ExplosionHandle } from '../vfx/explosionParticles';

export type { FormationOffset } from '../utils/formations';

export { buildDiverFormationOffsets } from '../utils/formations';

// ── Visual / behaviour tuning (per GDD §4.1 + §4.2) ─────────────────

/** Yellow body colour per GDD §4.1 art direction. */
export const DIVER_COLOR = 0xffff00;

/** Half-size of the diver — medium between Scout (16) and Tank (28). */
export const DIVER_SIZE = 18;

/** Spread-shot bullet colour (light yellow, distinct from the yellow body). */
export const DIVER_BULLET_COLOR = 0xffee88;

/** Bullet radius in px. */
export const DIVER_BULLET_SIZE = 3;

/** Bullet speed in px/s. */
export const DIVER_BULLET_SPEED = 220;

/** Number of projectiles in a spread burst (3–5 range). */
export const DIVER_BURST_COUNT = 4;

/** Angle spread between the outermost projectiles in a burst (radians). */
export const DIVER_BURST_SPREAD_ANGLE = Math.PI / 6; // 30° total spread

/** Milliseconds between spread bursts — faster than Tank. */
export const DIVER_FIRE_INTERVAL = 1000;

/** Seconds the Diver holds formation before diving. */
export const DIVER_HOLD_FORMATION_SECONDS = 3;

/** Seconds the Diver spends on a dive (arc toward player). */
export const DIVER_DIVE_DURATION = 2;

/** Dive apex height (fraction of screen height) — how far the dive arcs. */
export const DIVER_DIVE_APEX_FRACTION = 0.3;

/** Formation drift speed — slightly faster than Tank. */
export const DIVER_FORMATION_DRIFT_SPEED = 30;

/** Duration (ms) the Diver pauses at the bottom of the dive arc before returning. */
export const DIVER_PAUSE_DURATION = 500;


export interface DiverConfig {
  x: number;
  y: number;
  /** Offset within the formation. */
  formationOffset: FormationOffset;
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  /** Bullet lifetime in seconds (wrap + expiry; AH-0MU960UTE001PTV0). */
  bulletLifetime?: number;
  fireInterval?: number;
  burstCount?: number;
  /** Custom pause duration in ms at the bottom of the dive arc. Defaults to 500 ms. */
  pauseDuration?: number;
  /**
   * Chance (fraction `0.0`–`1.0`) that this diver fires when the interval
   * elapses (per shot cycle). Defaults to `1.0` (current behaviour). The
   * gate sits at the interval check so a failed roll does not corrupt
   * dive state.
   */
  shotProbability?: number;
  /** Injectable random source for the per-cycle shot roll (defaults to `Math.random`). */
  rng?: () => number;
}

/**
 * A bullet fired by a diver in a spread burst.
 */
export interface DiverBullet {
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
 * State machine for the Diver's behaviour.
 */
export enum DiverState {
  FORMATION = 'formation',
  DIVING = 'diving',
  PAUSING = 'pausing',
  RETURNING = 'returning',
}

export class Diver extends BaseEnemy {
  // ── Diver-specific fields ────────────────────────────────────────

  private readonly target: Phaser.Math.Vector2;
  private _state = DiverState.FORMATION;
  private _holdTimer = 0;
  private _divePhase = 0;
  private _diveStartX = 0;
  private _diveStartY = 0;
  private _diveTargetX = 0;
  private _diveTargetY = 0;
  private _diveApexX = 0;
  private _diveApexY = 0;
  private _diveCol = 0;
  private _diveRow = 0;
  private _returnProgress = 0;
  /** Tracks whether a sustained dive sound is active (for no-leak on destroy). */
  private _diveSoundActive = false;
  /** Local phase accumulator for the idle wiggle (replaces `scene.time.now`.
   *  Allows the entity to compute its wiggle offset without a `scene` ref,
   *  which is required for correctness when the entity is stale after a
   *  scene restart (its `this.scene` is undefined). */
  private _localPhase = 0;
  /** Timer for the pause phase (accumulates dt in seconds). */
  private _pauseTimer = 0;
  /** Pause duration in seconds (configured or default). */
  private _pauseDuration = DIVER_PAUSE_DURATION / 1000;
  private readonly _burstCount: number;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: DiverConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? DIVER_SIZE,
      color: config.color ?? DIVER_COLOR,
      bulletColor: config.bulletColor ?? DIVER_BULLET_COLOR,
      bulletSize: config.bulletSize ?? DIVER_BULLET_SIZE,
      bulletSpeed: config.bulletSpeed ?? DIVER_BULLET_SPEED,
      bulletLifetime: config.bulletLifetime,
      fireInterval: config.fireInterval ?? DIVER_FIRE_INTERVAL,
      shotProbability: config.shotProbability,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this._burstCount = config.burstCount ?? DIVER_BURST_COUNT;
    this._pauseDuration =
      (config.pauseDuration ?? DIVER_PAUSE_DURATION) / 1000;
    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // Draw the unique shape and add shared graphics in canonical order.
    this._drawBody();
    this.addSharedGraphics();
  }

  /** VFX pattern name for Diver explosions. */
  protected getExplosionPatternName(): string {
    return 'diver';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  protected _drawBody(): void {
    this.bodyGraphics.clear();
    // Style must be set AFTER clear(): Graphics is command-buffered and
    // clear() wipes any styles queued before it (it only re-applies the
    // default white 1px stroke). The original code called lineStyle()
    // before clear(), so the dart was stroked with the default style
    // and rendered invisible in a real browser (headless tests cannot
    // see pixels, so the suite stayed green).
    this.bodyGraphics.lineStyle(2, this._color, 1);
    const half = this._size / 2;

    // Dart shape — elongated chevron pointing "up" (nose at negative y in
    // local space). Positive container rotation then aligns the nose toward
    // the target (desired = atan2(dx, -dy)).
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(0, -half);            // nose tip (up)
    this.bodyGraphics.lineTo(half * 0.5, half);  // bottom-right wing
    this.bodyGraphics.lineTo(0, half * 0.3);     // notch
    this.bodyGraphics.lineTo(-half * 0.5, half); // bottom-left wing
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
  }

  /** Live particle-explosion handles (copy — for tests/SHUTDOWN checks). */
  getExplosionHandles(): ExplosionHandle[] {
    return this.explosionHandles.slice();
  }

  // ── Public state ─────────────────────────────────────────────────

  get effectiveSize(): number { return this._size; }
  get effectiveColor(): number { return this._color; }
  get effectiveBurstCount(): number { return this._burstCount; }

  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
    if (!value) this._lastFireTime = 0;
  }

  /** Current behaviour state (formation, diving, or returning). */
  get behaviourState(): DiverState {
    return this._state;
  }

  /**
   * Optional entity seam (shared by `FormationSceneEntity` / `EnemyEntity`):
   * true while this diver is away from its formation and the owning scene
   * must hold the cluster's drift. Every detached state
   * (`DIVING`/`PAUSING`/`RETURNING`) holds; `FORMATION` does not. Destroyed
   * divers report `false` so a mid-dive kill releases the hold immediately.
   */
  requiresFormationHold(): boolean {
    return this.alive && this._state !== DiverState.FORMATION;
  }

  /** The position aimed at when diving (defaults to the bottom-centre stand-in). */
  get aimTarget(): Phaser.Math.Vector2 {
    return this.target.clone();
  }

  /**
   * Computes the container rotation that points the diver's nose (local
   * -y / up) toward the target position. Exposed for tests and
   * observability. 0 = up, PI/2 = right, PI = down.
   */
  static computeFacingRotation(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): number {
    const dx = toX - fromX;
    const dy = toY - fromY;
    return Math.atan2(dx, -dy);
  }

  /**
   * Live aim tracking: retargets the dive to the player's current position.
   * The dive snapshots this position at dive start (`_startDive`), so aim
   * changes mid-dive do not alter an in-flight dive.
   */
  setAimTarget(x: number, y: number): void {
    this.target.set(x, y);
  }

  /** Speed at which this diver's formation drifts (px/s). */
  get driftSpeed(): number {
    return DIVER_FORMATION_DRIFT_SPEED;
  }

  // ── Optional destruction-audio seam ──────────────────────────────

  /**
   * Plays the Diver-specific destruction sound.
   *
   * Implements the optional `playDestructionAudio?()` seam on
   * `FormationSceneEntity`. The base `GymFormationScene` prefers this
   * over the shared `playDestructionSound()`, so the diver's destruction
   * sound plays exactly once per destruction (no double-play).
   *
   * `playExplosion()` intentionally does NOT call any audio — the base
   * scene owns destruction audio timing (design doc §7).
   */
  playDestructionAudio(): void {
    playDiverDestructionSound();
  }

  // ── Behaviour ────────────────────────────────────────────────────

  /**
   * Hides the body and silences any sustained dive sound (prevents
   * oscillator leak on destruction).
   */
  protected hideBody(): void {
    super.hideBody();
    if (this._diveSoundActive) {
      stopDiveSound();
      this._diveSoundActive = false;
    }
  }

  /**
   * Fires a spread burst if shoot mode is on, alive, and interval elapsed.
   * Returns the bullets spawned (0 if no shot fired).
   * The burst fires downward toward the default player position.
   */
  tryFireSpreadBurst(now: number): DiverBullet[] {
    if (!this._shootEnabled || !this._alive) return [];
    if (now - this._lastFireTime < this._fireInterval) return [];
    // Per-cycle probability gate at the interval check: consume the cycle
    // first so a failed roll produces no burst and leaves dive state
    // untouched (the Diver fires via tryFireSpreadBurst alongside its dive
    // cycle, so the gate must not sit inside the dive handlers).
    this._lastFireTime = now;
    if (!(this._rng() < this._shotProbability)) return [];

    const bullets: DiverBullet[] = [];
    // Play the fire sound exactly once per spread burst (not per
    // projectile — the 3-5 bullet volley shares a single sound).
    playDiverFireSound();

    // Aim direction: straight down (toward bottom-centre / player).
    const baseAngle = 0; // straight down in screen coords (y increases downward)

    for (let i = 0; i < this._burstCount; i++) {
      // Distribute projectiles evenly across the spread angle.
      const t = (i / (this._burstCount - 1 || 1)) * 2 - 1; // -1 to +1
      const angle = baseAngle + t * (DIVER_BURST_SPREAD_ANGLE / 2);

      const vx = Math.sin(angle) * this._bulletSpeed;
      const vy = Math.cos(angle) * this._bulletSpeed;

      const { graphics, color } = createBullet({
        scene: this.scene,
        color: this._bulletColor,
        size: this._bulletSize,
        x: this.x,
        y: this.y,
      });

      bullets.push({ graphics, color, vx, vy, lifetime: this._bulletLifetime, elapsed: 0 });
    }
    return bullets;
  }

  /**
   * Returns the formation-relative target position for this diver.
   */
  getFormationPosition(
    baseX: number,
    baseY: number,
    spacingX: number,
    spacingY: number,
  ): Phaser.Math.Vector2 {
    const base = this.computeFormationPosition(baseX, baseY, spacingX, spacingY);
    return new Phaser.Math.Vector2(base.x, base.y);
  }

  /**
   * Computes the parabolic dive trajectory point at a given progress (0–1).
   * The curve starts at (startX, startY), peaks at (apexX, apexY), and
   * ends at (targetX, targetY).
   */
  static computeDivePoint(
    startX: number,
    startY: number,
    apexX: number,
    apexY: number,
    targetX: number,
    targetY: number,
    progress: number,
  ): Phaser.Math.Vector2 {
    // Quadratic bezier: P(t) = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2
    const t = progress;
    const oneMinusT = 1 - t;
    const x = oneMinusT * oneMinusT * startX + 2 * oneMinusT * t * apexX + t * t * targetX;
    const y = oneMinusT * oneMinusT * startY + 2 * oneMinusT * t * apexY + t * t * targetY;
    return new Phaser.Math.Vector2(x, y);
  }

  /**
   * Updates the diver's position based on its current state.
   * Handles formation hold (with smooth rotation toward player), diving
   * (diagonal parabolic arc toward the snapshotted player position), and
   * returning (smooth re-entry onto the current formation slot).
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;

    // Idle-wiggle phase advances every frame while alive (dt-driven
    // replacement for the old `scene.time.now` wall-clock wiggle, kept
    // ticking across dive/return so re-entering FORMATION has no phase
    // jump). Never dereferences `this.scene`.
    this._localPhase += dt;

    const formationPos = this.getFormationPosition(baseX, baseY, spacingX, spacingY);

    switch (this._state) {
      case DiverState.FORMATION:
        this._handleFormation(formationPos, dt);
        break;

      case DiverState.DIVING:
        this._handleDive(dt);
        break;

      case DiverState.PAUSING:
        this._handlePause(dt);
        break;

      case DiverState.RETURNING:
        this._handleReturn(baseX, baseY, spacingX, spacingY, dt);
        break;
    }
  }

  // ── State machine handlers ───────────────────────────────────────

  /**
   * Update the diver's rotation to face the player.
   *
   * Uses the same exponential-smoothing pattern in every state so the
   * diver always visually tracks the player regardless of behaviour.
   */
  private _updateFacingRotation(dt: number): void {
    const desired = Diver.computeFacingRotation(
      this.x, this.y, this.target.x, this.target.y,
    );
    // Shortest angular difference, wrapped to (-PI, PI].
    let diff = desired - this.rotation;
    if (Phaser.Math.Angle && typeof Phaser.Math.Angle.Wrap === 'function') {
      diff = Phaser.Math.Angle.Wrap(diff);
    } else {
      diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
      if (diff < -Math.PI) diff += 2 * Math.PI;
    }
    const lerpFactor = 1 - Math.exp(-5 * dt);
    this.rotation += diff * lerpFactor;
  }

  private _handleFormation(
    formationPos: Phaser.Math.Vector2,
    dt: number,
  ): void {
    // Subtle idle wiggle (similar to Scout).
    // Uses the local phase accumulator instead of `scene.time.now` so the
    // entity does not crash when its `scene` is undefined (stale after
    // a scene restart — the SHUTDOWN teardown destroys it first).
    const phase = (this.formationOffset.row + this.formationOffset.col) * 0.7;
    const wiggle = Math.sin(this._localPhase + phase) * 1.5;

    this.setPosition(
      formationPos.x + wiggle,
      formationPos.y,
    );

    // Always face the player during formation hold.
    this._updateFacingRotation(dt);

    // After hold timer reaches threshold, initiate a dive.
    this._holdTimer += dt;
    if (this._holdTimer >= DIVER_HOLD_FORMATION_SECONDS) {
      this._startDive(formationPos);
    }
  }

  private _startDive(
    formationPos: Phaser.Math.Vector2,
  ): void {
    this._state = DiverState.DIVING;
    this._holdTimer = 0;
    this._divePhase = 0;

    // Play the dive-start cue exactly once at the FORMATION→DIVING transition.
    playDiverDiveStartSound();

    // Start the sustained dive sound — plays for the full dive duration.
    playDiveSound();
    this._diveSoundActive = true;

    this._diveStartX = formationPos.x;
    this._diveStartY = formationPos.y;

    // Target is the player position (snapshotted at dive start).
    this._diveTargetX = this.target.x;
    this._diveTargetY = this.target.y;

    // Apex: midway between start and target horizontally, high on screen.
    this._diveApexX = (this._diveStartX + this._diveTargetX) / 2;
    this._diveApexY = GAME_HEIGHT * DIVER_DIVE_APEX_FRACTION;

    // Remember which formation slot we dove from. The return re-enters this
    // slot at its CURRENT (drifted) position so there is no snap on re-entry.
    this._diveCol = this.formationOffset.col;
    this._diveRow = this.formationOffset.row;
  }

  private _handleDive(dt: number): void {
    this._divePhase += dt / DIVER_DIVE_DURATION;
    if (this._divePhase >= 1) {
      this._divePhase = 1;
      // Move to PAUSING state, not directly to RETURNING.
      this._state = DiverState.PAUSING;
      this._pauseTimer = 0;
      // Stop the sustained dive sound when the dive ends.
      stopDiveSound();
      this._diveSoundActive = false;
      return;
    }

    const point = Diver.computeDivePoint(
      this._diveStartX,
      this._diveStartY,
      this._diveApexX,
      this._diveApexY,
      this._diveTargetX,
      this._diveTargetY,
      this._divePhase,
    );
    // Diagonal parabolic dive — both x and y follow the bezier from the
    // formation slot to the snapshotted player position.
    this.setPosition(point.x, point.y);

    // Always face the player during the dive.
    this._updateFacingRotation(dt);

    // Fire spread shots during the dive if shoot mode is enabled.
    if (this._shootEnabled) {
      // Fire at roughly the midpoint of the dive for best visual effect.
      if (this._divePhase > 0.3 && this._divePhase < 0.7) {
        // Already handled by tryFireSpreadBurst via fire interval.
      }
    }
  }

  /**
   * Handles the pause phase: holds position while facing the player,
   * then transitions to RETURNING after the pause duration elapses.
   */
  private _handlePause(dt: number): void {
    this._pauseTimer += dt;

    // Always face the player during the pause.
    this._updateFacingRotation(dt);

    // If pause duration has elapsed, transition to RETURNING.
    if (this._pauseTimer >= this._pauseDuration) {
      this._state = DiverState.RETURNING;
      this._returnProgress = 0;
      this._holdTimer = 0;
    }
  }

  /**
   * Returns the diver to its formation slot, ending exactly on the slot's
   * CURRENT position (the formation kept drifting while the diver was away).
   * Both x and y ease smoothly toward the current slot so the diver rejoins
   * the formation without a horizontal snap when the return completes.
   */
  private _handleReturn(
    baseX: number,
    baseY: number,
    spacingX: number,
    spacingY: number,
    dt: number,
  ): void {
    this._returnProgress += dt * 1.2; // slightly faster return
    const t = Math.min(this._returnProgress, 1);

    // The slot we must re-enter is its current position (base + offset).
    const slotX = baseX + this._diveCol * spacingX;
    const slotY = baseY + this._diveRow * spacingY;

    // Glide from the dive-end position (snapshotted target) onto the current
    // slot. Evaluating the slot each frame absorbs the formation drift, so at
    // t=1 the diver lands exactly on the slot and the next formation update
    // continues seamlessly.
    this.setPosition(
      this._diveTargetX + (slotX - this._diveTargetX) * t,
      this._diveTargetY + (slotY - this._diveTargetY) * t,
    );

    // Always face the player during the return.
    this._updateFacingRotation(dt);

    if (this._returnProgress >= 1) {
      this._returnProgress = 1;
      this._state = DiverState.FORMATION;
      this._holdTimer = 0;
      this.setPosition(slotX, slotY);
    }
  }

  destroy(fromScene?: boolean): void {
    // Silence any sustained dive sound to prevent oscillator leak on
    // scene teardown / stop→restart (AH-0MTPLHLZ3006MOC4 precedent).
    if (this._diveSoundActive) {
      stopDiveSound();
      this._diveSoundActive = false;
    }
    super.destroy(fromScene);
  }
}

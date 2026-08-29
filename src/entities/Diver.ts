/**
 * Diver enemy entity (GDD §4.2 — E2 Diver).
 *
 * Renders as a medium, dart-shaped neon-yellow entity. Periodically breaks
 * from formation and dives straight down (x locked at its formation slot)
 * along a parabolic vertical arc toward the player position (bottom-centre
 * of screen), then returns smoothly to its current formation slot — ending
 * exactly on the slot as it exists when the return completes, so the diver
 * rejoins the drifting formation without a horizontal snap.
 *
 * 1 HP — destroyed by a single bullet, plays an explosion animation, and
 * is removed. Divers never collide with each other (GDD §2.6).
 *
 * At Level 4+ (simulated by shoot mode) the Diver fires short-burst spread
 * shots — 3–5 projectiles at slight angles — during its dive trajectory.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT } from '../core/constants';
import { FormationOffset } from '../utils/formations';

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


export interface DiverConfig {
  x: number;
  y: number;
  /** Offset within the formation. */
  formationOffset: FormationOffset;
}

/**
 * A bullet fired by a diver in a spread burst.
 */
export interface DiverBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
}

/**
 * State machine for the Diver's behaviour.
 */
export enum DiverState {
  FORMATION = 'formation',
  DIVING = 'diving',
  RETURNING = 'returning',
}

export class Diver extends Phaser.GameObjects.Container {
  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private readonly explosionGraphics: Phaser.GameObjects.Graphics;
  private readonly formationOffset: FormationOffset;
  private readonly target: Phaser.Math.Vector2;

  private _alive = true;
  private _shootEnabled = false;
  private _lastFireTime = 0;
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

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: DiverConfig) {
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;
    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // Body — medium dart shape in yellow.
    this.bodyGraphics = scene.add.graphics();
    this.bodyGraphics.lineStyle(2, DIVER_COLOR, 1);
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
    // Style must be set AFTER clear(): Graphics is command-buffered and
    // clear() wipes any styles queued before it (it only re-applies the
    // default white 1px stroke). The original code called lineStyle()
    // before clear(), so the dart was stroked with the default style
    // and rendered invisible in a real browser (headless tests cannot
    // see pixels, so the suite stayed green).
    this.bodyGraphics.lineStyle(2, DIVER_COLOR, 1);
    const half = DIVER_SIZE / 2;

    // Dart shape — elongated chevron pointing "down" (toward player).
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(0, half);            // nose tip
    this.bodyGraphics.lineTo(half * 0.5, -half);  // top-right wing
    this.bodyGraphics.lineTo(0, -half * 0.3);     // notch
    this.bodyGraphics.lineTo(-half * 0.5, -half); // top-left wing
    this.bodyGraphics.closePath();
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
      duration: 450,
      onUpdate: () => {
        const alpha = this.explosionGraphics.alpha;
        const radius = DIVER_SIZE * 2 * (1 - alpha) + DIVER_SIZE * 0.25;
        this.explosionGraphics.clear();
        this.explosionGraphics.lineStyle(
          Math.max(1, Math.round(3 * alpha)),
          DIVER_COLOR,
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

  /** Current behaviour state (formation, diving, or returning). */
  get behaviourState(): DiverState {
    return this._state;
  }

  /** Speed at which this diver's formation drifts (px/s). */
  get driftSpeed(): number {
    return DIVER_FORMATION_DRIFT_SPEED;
  }

  // ── Behaviour ────────────────────────────────────────────────────

  destroySelf(): void {
    if (!this._alive) return;
    this._alive = false;
    this.bodyGraphics.setAlpha(0);
    this.playExplosion();
  }

  /**
   * Fires a spread burst if shoot mode is on, alive, and interval elapsed.
   * Returns the bullets spawned (0 if no shot fired).
   * The burst fires downward toward the default player position.
   */
  tryFireSpreadBurst(now: number): DiverBullet[] {
    if (!this._shootEnabled || !this._alive) return [];
    if (now - this._lastFireTime < DIVER_FIRE_INTERVAL) return [];
    this._lastFireTime = now;

    const bullets: DiverBullet[] = [];

    // Aim direction: straight down (toward bottom-centre / player).
    const baseAngle = 0; // straight down in screen coords (y increases downward)

    for (let i = 0; i < DIVER_BURST_COUNT; i++) {
      // Distribute projectiles evenly across the spread angle.
      const t = (i / (DIVER_BURST_COUNT - 1 || 1)) * 2 - 1; // -1 to +1
      const angle = baseAngle + t * (DIVER_BURST_SPREAD_ANGLE / 2);

      const vx = Math.sin(angle) * DIVER_BULLET_SPEED;
      const vy = Math.cos(angle) * DIVER_BULLET_SPEED;

      const graphics = this.scene.add.graphics();
      graphics.fillStyle(DIVER_BULLET_COLOR, 1);
      graphics.fillCircle(0, 0, DIVER_BULLET_SIZE);
      graphics.setPosition(this.x, this.y);
      graphics.setDepth(3);

      bullets.push({ graphics, color: DIVER_BULLET_COLOR, vx, vy });
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
    return new Phaser.Math.Vector2(
      baseX + this.formationOffset.col * spacingX,
      baseY + this.formationOffset.row * spacingY,
    );
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
   * Handles formation hold, diving (vertical parabolic arc), and returning
   * (smooth re-entry onto the current formation slot).
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;

    const formationPos = this.getFormationPosition(baseX, baseY, spacingX, spacingY);

    switch (this._state) {
      case DiverState.FORMATION:
        this._handleFormation(formationPos, dt);
        break;

      case DiverState.DIVING:
        this._handleDive(dt);
        break;

      case DiverState.RETURNING:
        this._handleReturn(baseX, baseY, spacingX, spacingY, dt);
        break;
    }
  }

  // ── State machine handlers ───────────────────────────────────────

  private _handleFormation(
    formationPos: Phaser.Math.Vector2,
    dt: number,
  ): void {
    // Subtle idle wiggle (similar to Scout).
    const phase = (this.formationOffset.row + this.formationOffset.col) * 0.7;
    const wiggle = Math.sin((this.scene as Phaser.Scene).time.now / 1000 + phase) * 1.5;

    this.setPosition(
      formationPos.x + wiggle,
      formationPos.y,
    );

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

    this._diveStartX = formationPos.x;
    this._diveStartY = formationPos.y;

    // Target is the player position (bottom-centre).
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
      this._state = DiverState.RETURNING;
      this._returnProgress = 0;
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
    // AC1: the dive is a straight vertical drop — x stays locked at the
    // formation slot the diver dove from; only y follows the parabolic arc.
    // The horizontal target/apex coordinates are intentionally unused here.
    this.setPosition(this._diveStartX, point.y);

    // Fire spread shots during the dive if shoot mode is enabled.
    if (this._shootEnabled) {
      // Fire at roughly the midpoint of the dive for best visual effect.
      if (this._divePhase > 0.3 && this._divePhase < 0.7) {
        // Already handled by tryFireSpreadBurst via fire interval.
      }
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

    // Glide from the dive-end position onto the current slot. Evaluating the
    // slot each frame absorbs the formation drift, so at t=1 the diver lands
    // exactly on the slot and the next formation update continues seamlessly.
    this.setPosition(
      this._diveStartX + (slotX - this._diveStartX) * t,
      this._diveTargetY + (slotY - this._diveTargetY) * t,
    );

    if (this._returnProgress >= 1) {
      this._returnProgress = 1;
      this._state = DiverState.FORMATION;
      this._holdTimer = 0;
      this.setPosition(slotX, slotY);
    }
  }

  destroy(fromScene?: boolean): void {
    this.bodyGraphics.destroy();
    this.explosionGraphics.destroy();
    super.destroy(fromScene);
  }
}

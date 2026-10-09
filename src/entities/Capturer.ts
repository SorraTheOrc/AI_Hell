/**
 * Capturer enemy entity — the Galaga tractor-beam archetype
 * (AH-0MV01EFII008298D).
 *
 * Renders as a small magenta emitter craft. It holds formation, then breaks
 * away and **descends toward the player's row** along a straight approach,
 * projects a short-lived vertical tractor beam, and withdraws back to its
 * formation slot. While the beam is active it drags the player off course;
 * if the player is held in the beam long enough the shared core triggers the
 * temporary, non-fatal capture effect and tells this entity to withdraw.
 *
 * The gameplay maths (the beam lifecycle, the bounded pull and the capture
 * hold) is defined once in the shared core
 * (`src/scenes/core/captureBeam.ts`) and applied by
 * `CombatCoreScene._updateCaptureBeams`, so the game and every player-bearing
 * gym run the same implementation (gym↔game parity). This class only owns:
 *
 * - the placement state machine (FORMATION → APPROACH → BEAM → WITHDRAW);
 * - the beam presentation (the drawn corridor); and
 * - the two seams the shared core consumes (`getCaptureBeam`,
 *   `notifyPlayerCaptured`).
 *
 * 2 HP (config `health`), never fires (the beam is the hazard), and never
 * collides with another enemy (GDD §2.6).
 *
 * @module entities/Capturer
 */

import Phaser from 'phaser';

import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { FormationOffset } from '../utils/formations';
import { type ExplosionHandle } from '../vfx/explosionParticles';
import {
  advanceCaptureBeam,
  createCaptureBeam,
  type CaptureBeamState,
} from '../scenes/core/captureBeam';

export type { FormationOffset } from '../utils/formations';

// ── Visual / behaviour tuning ───────────────────────────────────────

/** Magenta body colour — distinct from every other archetype. */
export const CAPTURER_COLOR = 0xff33cc;

/** Half-size of the capturer. */
export const CAPTURER_SIZE = 18;

/** Translucent beam colour (bright magenta). */
export const CAPTURER_BEAM_COLOR = 0xff88ff;

/** Beam width in px (horizontal capture corridor). */
export const CAPTURER_BEAM_WIDTH = 52;

/** Beam length in px (from the capturer down past the player's row). */
export const CAPTURER_BEAM_LENGTH = 220;

/** Vertical gap (px) the capturer holds above the player's row while beaming. */
export const CAPTURER_HOVER_GAP = 100;

/** Seconds the capturer holds formation before breaking away. */
export const CAPTURER_HOLD_FORMATION_SECONDS = 3.5;

/** Seconds spent descending toward the player's row. */
export const CAPTURER_APPROACH_SECONDS = 1.4;

/** Seconds spent withdrawing back to the formation slot. */
export const CAPTURER_WITHDRAW_SECONDS = 1.2;

/** Playwright-independent fallback: default beam cadence (ms). */
export const CAPTURER_BEAM_DURATION_MS = 1800;

/** Default pull strength (px/s). */
export const CAPTURER_PULL_STRENGTH = 90;

/**
 * Capturer attack state. `FORMATION → APPROACH → BEAM → WITHDRAW →
 * FORMATION`; the beam exists only in the `BEAM` state.
 */
export enum CapturerState {
  FORMATION = 'formation',
  APPROACH = 'approach',
  BEAM = 'beam',
  WITHDRAW = 'withdraw',
}

export interface CapturerConfig {
  x: number;
  y: number;
  /** Offset within the formation. */
  formationOffset: FormationOffset;
  size?: number;
  color?: number;
  /** Beam lifetime in ms (config `beamDuration`, or the default). */
  beamDuration?: number;
  /** Bounded pull speed in px/s (config `pullStrength`, or the default). */
  pullStrength?: number;
  /**
   * Hit points before destruction (data-driven). Defaults to `1`, but the
   * seeded archetype uses `2` so the beam is a meaningful threat.
   */
  health?: number;
  /** Injectable random source (defaults to `Math.random`). */
  rng?: () => number;
}

export class Capturer extends BaseEnemy {
  // ── Capturer-specific fields ─────────────────────────────────────

  private _state = CapturerState.FORMATION;
  private _holdTimer = 0;
  /** Progress through the approach/withdraw lerp (0–1). */
  private _movePhase = 0;
  private _moveStartX = 0;
  private _moveStartY = 0;
  private _moveTargetX = 0;
  private _moveTargetY = 0;
  /** Local idle-wiggle phase (no `scene.time.now` dependency). */
  private _localPhase = 0;
  /** The live beam state while beaming, or null otherwise. */
  private _beam: CaptureBeamState | null = null;
  /** Latched when the shared core reports a completed capture. */
  private _captureEnded = false;
  /** Resolved beam tuning. */
  private _beamDuration: number;
  private _pullStrength: number;
  /** Live aim target (the player's position), updated by the scene. */
  private readonly target: Phaser.Math.Vector2;
  /** Beam presentation layer (child of the container, local coords). */
  private readonly beamGraphics: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, config: CapturerConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? CAPTURER_SIZE,
      color: config.color ?? CAPTURER_COLOR,
      bulletColor: 0xff8888,
      bulletSize: 3,
      bulletSpeed: 0,
      bulletLifetime: 1,
      fireInterval: 1000,
      shotProbability: 0,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this._beamDuration = Math.max(
      0,
      config.beamDuration ?? CAPTURER_BEAM_DURATION_MS,
    );
    this._pullStrength = Math.max(
      0,
      config.pullStrength ?? CAPTURER_PULL_STRENGTH,
    );
    this.target = new Phaser.Math.Vector2(
      scene.scale.width / 2,
      scene.scale.height - 40,
    );

    // The beam renders behind the hull so the craft reads as the emitter.
    this.beamGraphics = scene.add.graphics();
    this.beamGraphics.setDepth(0);
    this.add(this.beamGraphics);
    this._drawBody();
    this.addSharedGraphics();
  }

  /** Archetype key (`'capturer'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'capturer';
  }

  protected getExplosionPatternName(): string {
    return 'capturer';
  }

  // ── Drawing ────────────────────────────────────────────────────────

  protected _drawBody(): void {
    this.bodyGraphics.clear();
    // Style must be set AFTER clear() (Graphics is command-buffered).
    this.bodyGraphics.lineStyle(2, this._color, 1);
    const half = this._size / 2;

    // Wide emitter hull with two downward prongs — reads as a beam projector.
    this.bodyGraphics.beginPath();
    this.bodyGraphics.moveTo(-half, -half * 0.6);
    this.bodyGraphics.lineTo(half, -half * 0.6);
    this.bodyGraphics.lineTo(half * 0.5, half * 0.2);
    this.bodyGraphics.lineTo(half * 0.25, half * 0.9); // right prong
    this.bodyGraphics.lineTo(0, half * 0.2);
    this.bodyGraphics.lineTo(-half * 0.25, half * 0.9); // left prong
    this.bodyGraphics.lineTo(-half * 0.5, half * 0.2);
    this.bodyGraphics.closePath();
    this.bodyGraphics.strokePath();
  }

  /** Redraws the translucent beam corridor from the capturer's centre. */
  private _drawBeam(): void {
    this.beamGraphics.clear();
    const beam = this._beam;
    if (!beam || !beam.active) return;
    this.beamGraphics.fillStyle(CAPTURER_BEAM_COLOR, 0.22);
    this.beamGraphics.fillRect(-beam.width / 2, 0, beam.width, beam.length);
    // Bright core line down the axis.
    this.beamGraphics.lineStyle(2, CAPTURER_BEAM_COLOR, 0.7);
    this.beamGraphics.beginPath();
    this.beamGraphics.moveTo(0, 0);
    this.beamGraphics.lineTo(0, beam.length);
    this.beamGraphics.strokePath();
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
  /** Resolved beam lifetime (ms). */
  get beamDuration(): number { return this._beamDuration; }
  /** Resolved bounded pull strength (px/s). */
  get pullStrength(): number { return this._pullStrength; }

  /** Current behaviour state (formation, approach, beam or withdraw). */
  get behaviourState(): CapturerState {
    return this._state;
  }

  // ── Aim target ────────────────────────────────────────────────────

  /** The position aimed at when breaking away. */
  get aimTarget(): Phaser.Math.Vector2 {
    return this.target.clone();
  }

  /**
   * Live aim tracking: retargets the attack to the player's current position
   * (the approach snapshots this position at break-away, so aim changes
   * mid-approach do not alter an in-flight attack).
   */
  setAimTarget(x: number, y: number): void {
    this.target.set(x, y);
  }

  // ── Shared capture-core seams ─────────────────────────────────────

  /**
   * The live beam, or null when the capturer is not beaming. Consumed by
   * `CombatCoreScene._updateCaptureBeams`, which resolves the pull and the
   * capture effect from it.
   */
  getCaptureBeam(): CaptureBeamState | null {
    if (!this._alive) return null;
    return this._beam;
  }

  /**
   * Tells the capturer that the shared core completed the capture: it snaps
   * the beam off and begins withdrawing back to formation. A no-op when the
   * capturer is not currently beaming (idempotent).
   */
  notifyPlayerCaptured(): void {
    if (this._state !== CapturerState.BEAM) return;
    this._captureEnded = true;
  }

  // ── Behaviour ─────────────────────────────────────────────────────

  protected hideBody(): void {
    super.hideBody();
    this.beamGraphics.setAlpha(0);
  }

  protected destroyGraphics(): void {
    this.beamGraphics.destroy();
    super.destroyGraphics();
  }

  /**
   * Advances the placement state machine for this frame: formation hold →
   * approach → beam → withdraw → formation. The scene calls this from its
   * positioning pass (the same seam the Diver uses).
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void {
    if (!this._alive) return;
    this._localPhase += dt;
    const formationPos = this.computeFormationPosition(
      baseX,
      baseY,
      spacingX,
      spacingY,
    );

    switch (this._state) {
      case CapturerState.FORMATION:
        this._handleFormation(formationPos.x, formationPos.y, dt);
        break;
      case CapturerState.APPROACH:
        this._handleApproach(dt);
        break;
      case CapturerState.BEAM:
        this._handleBeam(dt);
        break;
      case CapturerState.WITHDRAW:
        this._handleWithdraw(formationPos.x, formationPos.y, dt);
        break;
    }
  }

  private _handleFormation(x: number, y: number, dt: number): void {
    const phase = (this.formationOffset.row + this.formationOffset.col) * 0.7;
    const wiggle = Math.sin(this._localPhase + phase) * 1.5;
    this.setPosition(x + wiggle, y);

    this._holdTimer += dt;
    if (this._holdTimer >= CAPTURER_HOLD_FORMATION_SECONDS) {
      this._startApproach(x + wiggle, y);
    }
  }

  private _startApproach(x: number, y: number): void {
    this._state = CapturerState.APPROACH;
    this._movePhase = 0;
    this._moveStartX = x;
    this._moveStartY = y;
    this._moveTargetX = this.target.x;
    this._moveTargetY = this.target.y - CAPTURER_HOVER_GAP;
  }

  private _handleApproach(dt: number): void {
    this._movePhase += dt / CAPTURER_APPROACH_SECONDS;
    if (this._movePhase >= 1) {
      this._movePhase = 1;
      this.setPosition(this._moveTargetX, this._moveTargetY);
      this._startBeam();
      return;
    }
    this.setPosition(
      this._moveStartX + (this._moveTargetX - this._moveStartX) * this._movePhase,
      this._moveStartY + (this._moveTargetY - this._moveStartY) * this._movePhase,
    );
  }

  private _startBeam(): void {
    this._state = CapturerState.BEAM;
    this._captureEnded = false;
    this._beam = createCaptureBeam(this.x, this.y, {
      durationMs: this._beamDuration,
      length: CAPTURER_BEAM_LENGTH,
      width: CAPTURER_BEAM_WIDTH,
      pullStrength: this._pullStrength,
    });
    this._drawBeam();
  }

  private _handleBeam(dt: number): void {
    // Hold station at the beam origin (a tiny hover bob keeps it alive).
    const bob = Math.sin(this._localPhase * 3) * 2;
    this.setPosition(this._moveTargetX, this._moveTargetY + bob);

    if (this._beam) {
      // The beam origin follows the craft's hover so the drawn corridor and
      // the gameplay corridor stay coincident.
      this._beam = advanceCaptureBeam(this._beam, dt * 1000);
      this._beam = { ...this._beam, x: this.x, topY: this.y };
      this._drawBeam();
    }

    if (this._captureEnded || !this._beam?.active) {
      this._startWithdraw();
    }
  }

  private _startWithdraw(): void {
    this._state = CapturerState.WITHDRAW;
    this._movePhase = 0;
    this._moveStartX = this.x;
    this._moveStartY = this.y;
    this._beam = null;
    this._captureEnded = false;
    this._drawBeam();
  }

  private _handleWithdraw(x: number, y: number, dt: number): void {
    this._movePhase += dt / CAPTURER_WITHDRAW_SECONDS;
    if (this._movePhase >= 1) {
      this._movePhase = 1;
      this.setPosition(x, y);
      this._state = CapturerState.FORMATION;
      this._holdTimer = 0;
      return;
    }
    this.setPosition(
      this._moveStartX + (x - this._moveStartX) * this._movePhase,
      this._moveStartY + (y - this._moveStartY) * this._movePhase,
    );
  }
}

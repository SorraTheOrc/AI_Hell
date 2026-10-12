/**
 * Grunt enemy entity — the Robotron 2084 homing-horde archetype
 * (AH-0MV01EKTL001NRE6).
 *
 * A grunt is one member of the horde: a small, fast, non-firing enemy that
 * pours in from an arena edge and continuously homes on the live player.
 * The steering law — turn the heading toward the player at a bounded turn
 * rate, then travel forward at the homing speed — lives once in the shared
 * pure module `src/scenes/core/gruntSteering.ts`. This class only owns:
 *
 * - the per-frame call to that shared step (from `applyFormationPosition`,
 *   the seam both `PlayScene` and every gym run), and
 * - the live player position fed by the scene's `setAimTarget` seam.
 *
 * Grunts **never fire** — the archetype's threat is the swarm of bodies,
 * resolved by the existing enemy-body collision rule (no archetype-specific
 * collision code). `shootEnabled` is a no-op setter and the effective shot
 * pattern is always `none`. Grunts pass through each other and every other
 * enemy (GDD §2.6 — no enemy–enemy collision).
 *
 * @module entities/Grunt
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { EnemyShotPattern } from '../core/configTypes';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { FormationOffset } from '../utils/formations';
import {
  GRUNT_COLOR,
  GRUNT_HOMING_SPEED,
  GRUNT_SIZE,
  GRUNT_TURN_RATE,
  stepGrunt,
  type GruntTarget,
} from '../scenes/core/gruntSteering';

// ── Visual / behaviour tuning ───────────────────────────────────────

/** Alias for the shared default homing speed (px/s). */
export const GRUNT_SPEED = GRUNT_HOMING_SPEED;

/** Config accepted by the Grunt (config-driven visuals + homing tuning). */
export interface GruntConfig {
  x: number;
  y: number;
  /** Offset within the formation; required by the base class. */
  formationOffset: FormationOffset;
  /** Optional config-driven overrides; when absent the shared constants win. */
  size?: number;
  color?: number;
  bulletColor?: number;
  health?: number;
  /** Homing speed in px/s (defaults to {@link GRUNT_HOMING_SPEED}). */
  speed?: number;
  /** Maximum heading change in rad/s (defaults to {@link GRUNT_TURN_RATE}). */
  turnRate?: number;
  /** Initial heading in radians (defaults to a seeded draw). */
  heading?: number;
  /** Injectable random source (defaults to `Math.random`). */
  rng?: () => number;
}

/** One member of the Robotron homing horde. Never fires; body contact is its threat. */
export class Grunt extends BaseEnemy {
  private readonly _speed: number;
  private readonly _turnRate: number;
  private _heading: number;
  private _targetX = 0;
  private _targetY = 0;
  private _hasTarget = false;

  constructor(scene: Phaser.Scene, config: GruntConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? GRUNT_SIZE,
      color: config.color ?? GRUNT_COLOR,
      bulletColor: config.bulletColor,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this._speed = config.speed ?? GRUNT_HOMING_SPEED;
    this._turnRate = config.turnRate ?? GRUNT_TURN_RATE;
    this._heading =
      config.heading ?? this._rng() * Math.PI * 2;

    this._drawBody();
    this.addSharedGraphics();
  }

  /** Archetype key (`'grunt'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'grunt';
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draws a small angular robot-chest chevron with a forward pointing nose.
   * Style is set **after** `clear()` (Graphics is command-buffered) so the
   * body never inherits Phaser's module-global stroke tint
   * (docs/ENEMY_DESIGN_AND_IMPLEMENTATION §4.2).
   */
  protected _drawBody(): void {
    const g = this.bodyGraphics;
    const r = this._size / 2;
    g.clear();
    g.lineStyle(2, this._color, 1);

    // Angular forward-facing hull.
    g.beginPath();
    g.moveTo(r * 0.9, 0); // nose
    g.lineTo(-r * 0.6, r * 0.8); // left shoulder
    g.lineTo(-r * 0.25, 0); // waist notch
    g.lineTo(-r * 0.6, -r * 0.8); // right shoulder
    g.closePath();
    g.strokePath();

    // A single sensor eye so the facing reads at a glance.
    g.fillStyle(0xffffff, 1);
    g.fillCircle(r * 0.25, 0, r * 0.18);
  }

  // ── Effective config (for tests / gym tuning) ────────────────────

  /** Effective config-driven size (for tests). */
  get effectiveSize(): number {
    return this._size;
  }

  /** Effective config-driven body colour (for tests). */
  get effectiveColor(): number {
    return this._color;
  }

  /** Homing speed (px/s). */
  get homingSpeed(): number {
    return this._speed;
  }

  /** Maximum heading change (rad/s). */
  get turnRate(): number {
    return this._turnRate;
  }

  /** Current forward heading (radians). */
  get heading(): number {
    return this._heading;
  }

  /** Whether a live aim target has been pushed by the scene. */
  get hasAimTarget(): boolean {
    return this._hasTarget;
  }

  // ── No-fire guarantee ────────────────────────────────────────────

  /**
   * Both halves of the shootEnabled accessor pair are overridden so reads
   * stay false and writes are ignored (the Grunt never fires).
   */
  override get shootEnabled(): boolean {
    return false;
  }

  override set shootEnabled(_value: boolean) {
    // No-op — the Grunt never fires; the swarm of bodies is the threat.
  }

  /** Effective shot pattern is always 'none'. */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'none';
  }

  // ── Live aim seam ────────────────────────────────────────────────

  /** Pushes the player's live position so the grunt homes on it. */
  setAimTarget(x: number, y: number): void {
    this._targetX = x;
    this._targetY = y;
    this._hasTarget = true;
  }

  /** Current homing target (for tests). */
  getSteeringTarget(): GruntTarget {
    return { x: this._targetX, y: this._targetY };
  }

  // ── Movement ─────────────────────────────────────────────────────

  /**
   * Advances the forward heading/position via the shared bounded-steering
   * step. Called by the shared positioning pass in `PlayScene._moveEnemies`
   * and `GymFormationScene` for every non-roamer entity, so the game and
   * every gym run the same code.
   *
   * The formation base is ignored: a grunt spawns on its (cluster) slot and
   * then homes. Until the scene pushes a live target (the first frame),
   * it simply travels straight along its initial heading rather than
   * lurching toward the origin. The `baseX`/`baseY`/spacing parameters keep
   * the shared entity signature intact.
   */
  applyFormationPosition(
    _baseX: number,
    _baseY: number,
    dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;

    if (this._hasTarget) {
      const next = stepGrunt(
        { x: this.x, y: this.y, heading: this._heading },
        { x: this._targetX, y: this._targetY },
        this._speed,
        this._turnRate,
        dt,
      );
      this._heading = next.heading;
      this.setPosition(
        this._clamp(next.x, this._size / 2, GAME_WIDTH - this._size / 2),
        this._clamp(next.y, this._size / 2, GAME_HEIGHT - this._size / 2),
      );
      return;
    }

    // No live target yet: coast straight along the initial heading. The
    // per-frame turn is a no-op (it preserves the heading) so the shared
    // steering step is still the single movement authority.
    const next = stepGrunt(
      { x: this.x, y: this.y, heading: this._heading },
      { x: this.x, y: this.y },
      this._speed,
      0,
      dt,
    );
    this._heading = next.heading;
    this.setPosition(
      this._clamp(next.x, this._size / 2, GAME_WIDTH - this._size / 2),
      this._clamp(next.y, this._size / 2, GAME_HEIGHT - this._size / 2),
    );
  }

  private _clamp(value: number, lo: number, hi: number): number {
    if (hi < lo) return lo;
    return Math.min(hi, Math.max(lo, value));
  }
}

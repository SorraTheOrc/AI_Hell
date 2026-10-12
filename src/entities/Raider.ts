/**
 * Raider enemy entity — the Defender patrol-and-attack raider archetype
 * (classic-arcade archetype, AH-0MV01EM7U0033W7L).
 *
 * A raider is a fast attacker with a two-state machine:
 *
 * - **Patrol** — an independent horizontal sweep at `patrolSpeed`, wrapping
 *   at the left/right arena edges.
 * - **Attack** — a committed straight run at `attackSpeed` toward the live
 *   player position snapshotted at the commit moment. It overshoots, wraps
 *   at the first arena edge and re-enters patrol, so it can commit repeatedly.
 *
 * The travel maths lives once in the pure shared policy
 * `src/scenes/core/raiderPatrol.ts`, consumed here in the game and every gym
 * (gym↔game parity). This class only owns drawing, the live aim seam (the
 * commit decision) and the aimed-fire gate.
 *
 * **Firing.** The raider reuses the Scout's aimed-shot path (including its
 * ≥ 500 ms advance-cue tell) rather than duplicating the firing policy, but
 * only fires during a committed attack run and only when the level's fire
 * rule enables firing (`shootEnabled`, Levels 4+). It therefore never fires
 * in Levels 1–3 and never fires while patrolling. Raiders pass through every
 * other enemy (GDD §2.6 — no enemy–enemy collision): there is no
 * archetype-specific collision code.
 *
 * @module entities/Raider
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { EnemyShotPattern } from '../core/configTypes';
import { Scout, type ScoutBullet, type ScoutConfig } from './Scout';
import {
  RAIDER_ATTACK_SPEED,
  RAIDER_BULLET_COLOR,
  RAIDER_COLOR,
  RAIDER_COMMIT_RANGE,
  RAIDER_PATROL_SPEED,
  RAIDER_SIZE,
  createRaiderState,
  stepRaider,
  type RaiderArena,
  type RaiderMode,
  type RaiderMotionState,
  type RaiderTuning,
} from '../scenes/core/raiderPatrol';

// ── Config ──────────────────────────────────────────────────────────

/** Config accepted by the Raider (Scout seam + patrol/attack tuning). */
export interface RaiderConfig extends ScoutConfig {
  /** Horizontal patrol speed in px/s (defaults to {@link RAIDER_PATROL_SPEED}). */
  patrolSpeed?: number;
  /** Committed attack-run speed in px/s (defaults to {@link RAIDER_ATTACK_SPEED}). */
  attackSpeed?: number;
  /** Commit range in px (defaults to {@link RAIDER_COMMIT_RANGE}). */
  commitRange?: number;
}

// ── Geometry ────────────────────────────────────────────────────────

/**
 * The inclusive arena bounds a raider wraps within, inset by its half-size so
 * the body never leaves the visible playfield.
 */
export function raiderArena(size: number): RaiderArena {
  const half = size / 2;
  return {
    minX: half,
    maxX: GAME_WIDTH - half,
    minY: half,
    maxY: GAME_HEIGHT - half,
  };
}

/**
 * A Defender raider: patrols the arena, commits to a high-speed attack run at
 * the player and wraps back into patrol. Fires aimed shots only during a
 * committed attack and only when the level's fire rule enables firing.
 */
export class Raider extends Scout {
  private _state: RaiderMotionState;
  private readonly _tuning: RaiderTuning;
  private readonly _arena: RaiderArena;
  private _playerX = 0;
  private _playerY = 0;
  private _hasTarget = false;

  constructor(scene: Phaser.Scene, config: RaiderConfig) {
    // Resolve the raider-specific tuning before delegating the shared Scout
    // seam (which owns the aimed-fire tell and the default goal target).
    const size = config.size ?? RAIDER_SIZE;
    const color = config.color ?? RAIDER_COLOR;
    const bulletColor = config.bulletColor ?? RAIDER_BULLET_COLOR;
    super(scene, { ...config, size, color, bulletColor });

    this._tuning = {
      patrolSpeed: config.patrolSpeed ?? RAIDER_PATROL_SPEED,
      attackSpeed: config.attackSpeed ?? RAIDER_ATTACK_SPEED,
      commitRange: config.commitRange ?? RAIDER_COMMIT_RANGE,
    };
    this._arena = raiderArena(this._size);
    // Seeded initial patrol heading so a run is reproducible (AH-0MUY08V6W001SJJN).
    this._state = createRaiderState(config.x, config.y, this._rng() < 0.5 ? -1 : 1);
  }

  /** Archetype key (`'raider'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'raider';
  }

  protected override getExplosionPatternName(): string {
    return 'scout';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draws a forward-swept raider dart: a long nose with swept wings and a
   * cockpit dot. Style is set **after** `clear()` (Graphics is
   * command-buffered) so the body never inherits Phaser's module-global
   * stroke tint (docs/ENEMY_DESIGN_AND_IMPLEMENTATION §4.2).
   */
  protected override _drawBody(): void {
    const g = this.bodyGraphics;
    const r = this._size / 2;
    g.clear();
    g.lineStyle(2, this._color, 1);

    // Swept dart: nose, swept wing tips, tail notch.
    g.beginPath();
    g.moveTo(r, 0);
    g.lineTo(-r * 0.55, r * 0.85);
    g.lineTo(-r * 0.15, 0);
    g.lineTo(-r * 0.55, -r * 0.85);
    g.closePath();
    g.strokePath();

    // Cockpit sensor to read the nose direction.
    g.fillStyle(0xffffff, 1);
    g.fillCircle(r * 0.35, 0, r * 0.16);
  }

  // ── Effective config (for tests / gym tuning) ────────────────────

  /** Current behaviour mode. */
  get mode(): RaiderMode {
    return this._state.mode;
  }

  /** Horizontal patrol heading (`+1` right, `-1` left). */
  get patrolDir(): 1 | -1 {
    return this._state.patrolDir;
  }

  /** Current committed attack velocity (px/s); zero while patrolling. */
  get attackVelocity(): { vx: number; vy: number } {
    return { vx: this._state.vx, vy: this._state.vy };
  }

  /** Current motion state (copy — for tests). */
  get motionState(): RaiderMotionState {
    return { ...this._state };
  }

  /** Effective patrol speed (px/s). */
  get patrolSpeed(): number {
    return this._tuning.patrolSpeed;
  }

  /** Effective committed attack speed (px/s). */
  get attackSpeed(): number {
    return this._tuning.attackSpeed;
  }

  /** Effective commit range (px). */
  get commitRange(): number {
    return this._tuning.commitRange;
  }

  /** The arena bounds this raider wraps within. */
  get arena(): RaiderArena {
    return { ...this._arena };
  }

  /** Whether a live aim target has been pushed by the scene. */
  get hasAimTarget(): boolean {
    return this._hasTarget;
  }

  /** The raider always fires (when enabled) with the aimed pattern. */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'aimed';
  }

  // ── Live aim seam ────────────────────────────────────────────────

  /**
   * Pushes the player's live position. It is used both for the commit
   * decision (patrol) and for the aimed shot; the attack run snapshots it
   * into an attack velocity on the commit frame.
   */
  override setAimTarget(x: number, y: number): void {
    super.setAimTarget(x, y);
    this._playerX = x;
    this._playerY = y;
    this._hasTarget = true;
  }

  // ── Movement ─────────────────────────────────────────────────────

  /**
   * Advances the shared patrol/attack state machine for one frame. Called by
   * the shared positioning pass in `PlayScene._moveEnemies` and
   * `GymFormationScene` for every formation entity, so the game and every gym
   * run the same code. The formation base is ignored: a raider owns its own
   * patrol and attack motion.
   */
  override applyFormationPosition(
    _baseX: number,
    _baseY: number,
    dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;

    // With no live target yet the raider simply patrols; passing its own
    // position makes the commit distance zero, which never commits.
    const player = this._hasTarget
      ? { x: this._playerX, y: this._playerY }
      : { x: this._state.x, y: this._state.y };
    const next = stepRaider(this._state, player, this._tuning, this._arena, dt);
    this._state = {
      x: next.x,
      y: next.y,
      mode: next.mode,
      patrolDir: next.patrolDir,
      vx: next.vx,
      vy: next.vy,
    };
    this.setPosition(next.x, next.y);
  }

  // ── Fire gate ────────────────────────────────────────────────────

  /**
   * Fires an aimed shot through the inherited Scout tell, but only during a
   * committed attack run. While patrolling it returns `null` without
   * consuming the fire cycle, so the raider never shoots from patrol.
   */
  override tryFireAimedBullet(now: number): ScoutBullet | null {
    if (this._state.mode !== 'attack') return null;
    return super.tryFireAimedBullet(now);
  }
}

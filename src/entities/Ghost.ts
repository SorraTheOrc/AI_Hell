/**
 * Ghost enemy entity — the Pac-Man personality-pursuer archetype
 * (AH-0MV01EH2U008XT3Q).
 *
 * Four pursuers each steer with a distinct personality (see
 * `src/scenes/core/ghostSteering.ts`): `chase` follows the player directly,
 * `ambush` leads the player's velocity, `flank` cuts across the player's
 * path from a pivot, and `wander` roams a slowly rotating point near itself.
 * A shared scatter/chase timer makes all four alternate between a corner
 * retreat (scatter) and their pursuit target (chase).
 *
 * The targeting maths lives once in the shared pure module; this class only
 * owns:
 *
 * - the per-frame steering (move toward the resolved target at a bounded
 *   pursuit speed, clamped to the arena), and
 * - the live player context (position + derived velocity) fed by the
 *   scene's `setAimTarget` seam.
 *
 * Ghosts **never fire** — the archetype's threat is body contact, resolved by
 * the existing enemy-body collision rule (no archetype-specific collision
 * code). `shootEnabled` is a no-op setter and the effective shot pattern is
 * always `none`. They never collide with each other (GDD §2.6).
 *
 * @module entities/Ghost
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { EnemyShotPattern } from '../core/configTypes';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { FormationOffset } from '../utils/formations';
import {
  GHOST_CHASE_SECONDS,
  GHOST_PERSONALITIES,
  GHOST_SCATTER_SECONDS,
  ghostModeAt,
  resolveGhostTarget,
  steerToward,
  type GhostMode,
  type GhostPersonality,
  type GhostTarget,
} from '../scenes/core/ghostSteering';

export type { GhostPersonality } from '../scenes/core/ghostSteering';

// ── Visual / behaviour tuning ───────────────────────────────────────

/** Fast pursuit speed (px/s) — the ghosts are the fastest regular enemies. */
export const GHOST_PURSUIT_SPEED = 95;

/** Half-size of a ghost. */
export const GHOST_SIZE = 16;

/** Blinky — direct chase — classic ghost red. */
export const GHOST_CHASE_COLOR = 0xff2222;

/** Pinky — ambush — classic ghost pink. */
export const GHOST_AMBUSH_COLOR = 0xffb8ff;

/** Inky — flank — classic ghost cyan. */
export const GHOST_FLANK_COLOR = 0x22ffff;

/** Clyde — wander — classic ghost orange. */
export const GHOST_WANDER_COLOR = 0xffb852;

/** Per-personality default body colour. */
export const GHOST_COLORS: Record<GhostPersonality, number> = {
  chase: GHOST_CHASE_COLOR,
  ambush: GHOST_AMBUSH_COLOR,
  flank: GHOST_FLANK_COLOR,
  wander: GHOST_WANDER_COLOR,
};

/** Config accepted by the Ghost (config-driven visuals + personality). */
export interface GhostConfig {
  x: number;
  y: number;
  /** Offset within the formation. */
  formationOffset: FormationOffset;
  /** Pursuit personality — selects the targeting rule. */
  personality: GhostPersonality;
  /** Optional config-driven overrides; when absent the constants above win. */
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  bulletLifetime?: number;
  fireInterval?: number;
  health?: number;
  /** Pursuit speed in px/s (defaults to {@link GHOST_PURSUIT_SPEED}). */
  speed?: number;
  /** Scatter-phase duration in seconds (defaults to the shared tuning). */
  scatterSeconds?: number;
  /** Chase-phase duration in seconds (defaults to the shared tuning). */
  chaseSeconds?: number;
  /** Initial `wander` heading (radians); when absent a seeded draw is used. */
  wanderAngle?: number;
  /** Injectable random source (defaults to `Math.random`). */
  rng?: () => number;
}

/**
 * Derives a personality from an archetype key of the form
 * `ghost-<personality>` (e.g. `ghost-ambush`), falling back to `chase`.
 */
export function personalityFromKey(key: string): GhostPersonality {
  const suffix = key.startsWith('ghost-') ? key.slice('ghost-'.length) : key;
  return (GHOST_PERSONALITIES as readonly string[]).includes(suffix)
    ? (suffix as GhostPersonality)
    : 'chase';
}

/** A Pac-Man personality pursuer. Never fires; body contact is its threat. */
export class Ghost extends BaseEnemy {
  private readonly _personality: GhostPersonality;
  private readonly _speed: number;
  private readonly _scatterSeconds: number;
  private readonly _chaseSeconds: number;
  private _elapsed = 0;
  private _wanderAngle: number;
  /** Latest frame time (s), used to derive the player velocity from aim samples. */
  private _frameDt = 1 / 60;
  /** Live player context pushed by the scene's `setAimTarget` seam. */
  private _playerX = 0;
  private _playerY = 0;
  private _playerVx = 0;
  private _playerVy = 0;
  private _hasPlayer = false;

  constructor(scene: Phaser.Scene, config: GhostConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? GHOST_SIZE,
      color: config.color ?? GHOST_COLORS[config.personality],
      bulletColor: config.bulletColor ?? 0xffffff,
      bulletSize: config.bulletSize,
      bulletSpeed: config.bulletSpeed,
      bulletLifetime: config.bulletLifetime,
      fireInterval: config.fireInterval,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this._personality = config.personality;
    this._speed = config.speed ?? GHOST_PURSUIT_SPEED;
    this._scatterSeconds = config.scatterSeconds ?? GHOST_SCATTER_SECONDS;
    this._chaseSeconds = config.chaseSeconds ?? GHOST_CHASE_SECONDS;
    this._wanderAngle =
      config.wanderAngle ?? this._rng() * Math.PI * 2;

    this._drawBody();
    this.addSharedGraphics();
  }

  /** Archetype key (`ghost-<personality>`), matching the scene's enemy key. */
  override get archetype(): string {
    return `ghost-${this._personality}`;
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draw the classic dome-and-skirt ghost silhouette. Style is set **after**
   * `clear()` (Graphics is command-buffered) so the body never inherits
   * Phaser's module-global stroke tint (docs/ENEMY_DESIGN_AND_IMPLEMENTATION
   * §4.2).
   */
  protected _drawBody(): void {
    const g = this.bodyGraphics;
    const r = this._size / 2;
    g.clear();
    g.lineStyle(2, this._color, 1);

    // Dome: a semicircle from the left to the right shoulder.
    g.beginPath();
    g.arc(0, 0, r, Math.PI, 0, false);
    // Right shoulder down to the first skirt point.
    g.lineTo(r, r * 0.55);
    // Skirt: four downward points across the base.
    const feet = 4;
    const step = (r * 2) / feet;
    for (let i = 0; i < feet; i++) {
      const x = r - step * i;
      g.lineTo(x - step / 2, r * (i % 2 === 0 ? 0.2 : 0.55));
      g.lineTo(x - step, r * 0.55);
    }
    g.closePath();
    g.strokePath();

    // Eyes — a readable facing cue so the four read as distinct pursuers.
    g.fillStyle(0xffffff, 1);
    g.fillCircle(-r * 0.32, -r * 0.1, r * 0.2);
    g.fillCircle(r * 0.32, -r * 0.1, r * 0.2);
    g.fillStyle(0x1111ff, 1);
    g.fillCircle(-r * 0.32 + r * 0.08, -r * 0.1, r * 0.09);
    g.fillCircle(r * 0.32 + r * 0.08, -r * 0.1, r * 0.09);
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

  /** The pursuit personality. */
  get personality(): GhostPersonality {
    return this._personality;
  }

  /** Pursuit speed (px/s). */
  get pursuitSpeed(): number {
    return this._speed;
  }

  /** Total elapsed seconds used by the scatter/chase timer. */
  get elapsedSeconds(): number {
    return this._elapsed;
  }

  // ── No-fire guarantee ────────────────────────────────────────────

  /**
   * Both halves of the shootEnabled accessor pair are overridden so reads
   * stay false and writes are ignored (the Ghost never fires).
   */
  override get shootEnabled(): boolean {
    return false;
  }

  override set shootEnabled(_value: boolean) {
    // No-op — the Ghost never fires; body contact is the threat.
  }

  /** Effective shot pattern is always 'none'. */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'none';
  }

  // ── Live aim seam ────────────────────────────────────────────────

  /**
   * Pushes the player's live position. The Ghost derives the player's
   * velocity from consecutive samples (using the last frame's `dt`) so the
   * `ambush`/`flank` lead targets track a moving player.
   */
  setAimTarget(x: number, y: number): void {
    if (this._hasPlayer && this._frameDt > 0) {
      this._playerVx = (x - this._playerX) / this._frameDt;
      this._playerVy = (y - this._playerY) / this._frameDt;
    }
    this._playerX = x;
    this._playerY = y;
    this._hasPlayer = true;
  }

  /** Current resolved steering target (for tests). */
  getSteeringTarget(): GhostTarget {
    return resolveGhostTarget(
      this._personality,
      this.mode,
      this._worldState(),
      { width: GAME_WIDTH, height: GAME_HEIGHT },
    );
  }

  /** Current shared scatter/chase mode (for tests). */
  get mode(): GhostMode {
    return ghostModeAt(this._elapsed, this._scatterSeconds, this._chaseSeconds);
  }

  private _worldState() {
    return {
      x: this.x,
      y: this.y,
      playerX: this._playerX,
      playerY: this._playerY,
      playerVx: this._playerVx,
      playerVy: this._playerVy,
      wanderAngle: this._wanderAngle,
    };
  }

  // ── Movement ─────────────────────────────────────────────────────

  /**
   * Steer toward the personality's resolved target. Called by the shared
   * positioning pass in `PlayScene._moveEnemies` and `GymFormationScene` for
   * every non-roamer entity, so the game and every gym run the same code.
   *
   * The ghost ignores the passed formation base once spawned — it spawns on
   * its formation slot and then pursues — but the `baseX`/`baseY`/`spacing`
   * parameters keep the shared entity signature intact.
   */
  applyFormationPosition(
    _baseX: number,
    _baseY: number,
    dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;
    this._frameDt = dt > 0 ? dt : this._frameDt;
    this._elapsed += dt;

    // A slow, deterministic wander rotation keeps the roam personality from
    // fixating on one point without introducing per-frame randomness.
    this._wanderAngle += dt * 0.6;

    const target = resolveGhostTarget(
      this._personality,
      this.mode,
      this._worldState(),
      { width: GAME_WIDTH, height: GAME_HEIGHT },
    );
    const next = steerToward(this.x, this.y, target.x, target.y, this._speed, dt);
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

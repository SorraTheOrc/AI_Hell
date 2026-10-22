/**
 * Phaser enemy entity (GDD §4.1 — E4 Phaser, Level 5 and later).
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

import { createBullet } from './bulletUtils';
import { resolveEnemyBulletVisual } from '../utils/bulletVisuals';
import { spawnEnemyMuzzleFlash } from '../vfx/enemyMuzzleFlash';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import { playPhaserAdvanceCue, playPhaserFireSound } from '../audio/effects';
import {
  computeOrbitalSlot,
  DEFAULT_ORBITAL_FORMATION_COUNT,
  FormationOffset,
  FormationPosition,
  orbitalPhaseAngle,
  orbitalPhaseIndex,
} from '../utils/formations';
import { type ExplosionHandle } from '../vfx/explosionParticles';

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
export const PHASER_BULLET_SPEED = 90;

/** Ring stroke width in px. */
export const PHASER_RING_WIDTH = 2;

/** Number of Phasers in the orbital formation when the group count is unknown. */
export const PHASER_FORMATION_COUNT = DEFAULT_ORBITAL_FORMATION_COUNT;

/**
 * Orbital spacing — phase offset between adjacent Phasers for the default
 * four-member square (a full turn split four ways). Superseded by the
 * count-based {@link orbitalPhaseAngle} for groups of any size
 * (AH-0MVEXVME1004SIIS); retained for callers that reference the constant.
 */
export const PHASER_ORBITAL_PHASE_SPACING = (Math.PI * 2) / PHASER_FORMATION_COUNT;

export interface PhaserConfig {
  x: number;
  y: number;
  /**
   * Offset within the orbital formation; used to determine orbit phase. When
   * it carries a `phaseCount` (populated by `buildOrbitalPhaseOffsets`) that
   * group count governs the even phase distribution (AH-0MVEXVME1004SIIS).
   */
  formationOffset: FormationOffset;
  /**
   * Number of Phasers in this group's orbital formation. Drives the even
   * phase distribution `phase_i = i × 2π / count`. Defaults to the offset's
   * `phaseCount`, then to {@link PHASER_FORMATION_COUNT} (4) so
   * single-entity constructors are unchanged (AH-0MVEXVME1004SIIS).
   */
  formationCount?: number;
  size?: number;
  color?: number;
  bulletColor?: number;
  bulletSize?: number;
  bulletSpeed?: number;
  /** Bullet lifetime in seconds (wrap + expiry; AH-0MU960UTE001PTV0). */
  bulletLifetime?: number;
  fireInterval?: number;
  burstCount?: number;
  /**
   * Chance (fraction `0.0`–`1.0`) that this phaser fires when the interval
   * elapses (per shot cycle). Defaults to `1.0` (current behaviour). The
   * roll happens at the tell decision point, so a skipped cycle never
   * plays an advance cue.
   */
  shotProbability?: number;
  /**
   * Hit points before the enemy is destroyed (data-driven;
   * AH-0MUI820PM0038HS2). Defaults to `1` (single-hit).
   */
  health?: number;
  /** Injectable random source for the per-cycle shot roll (defaults to `Math.random`). */
  rng?: () => number;
}

/**
 * A bullet fired by a Phaser. Renders as a crisply-edged phaser bolt (the
 * Phaser's radial-shot projectile identity — AH-0MV822DRX009RYUB) and travels
 * in a straight line, wrapping across the screen edges until its per-type
 * lifetime elapses.
 */
export interface PhaserBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  /**
   * Per-frame redraw hook for shapes animated by the bullet's age, consumed by
   * the shared enemy-bullet lifecycle so any animated part breathes
   * identically in the game and every gym. The Phaser bolt is static, so this
   * is normally absent; threaded through for parity with the Tank/Diver
   * identity bullets.
   */
  redraw?: (elapsed: number) => void;
  vx: number;
  vy: number;
  /** Bullet lifetime in seconds (AH-0MU960UTE001PTV0). */
  lifetime: number;
  /** Elapsed time since creation (seconds). */
  elapsed: number;
}

export class PhaserEntity extends BaseEnemy {
  // ── Phaser-specific fields ───────────────────────────────────────

  private readonly ringGraphics: Phaser.GameObjects.Graphics;
  private readonly coreGraphics: Phaser.GameObjects.Graphics;
  private readonly tellGraphics: Phaser.GameObjects.Graphics;

  /** Seconds (local phase) when the tell (warning) animation started. */
  private _tellStartTime = 0;
  private _isTelling = false;
  private _orbitalPhase: number;
  /**
   * Number of Phasers in this group's orbital formation — drives the even
   * phase distribution. Defaults to 4 when the group count is unknown
   * (AH-0MVEXVME1004SIIS).
   */
  private readonly _formationCount: number;
  /** Local phase accumulator for orbital rotation (seconds, dt-driven;
   *  replaces `scene.time.now`).  Allows the entity to compute its orbital
   *  position without a `scene` ref, which is required for correctness when
   *  the entity is stale after a scene restart (its `this.scene` is
   *  undefined). */
  private _localPhase = 0;
  /** Aim point for the radial pattern — the fixed bottom-centre stand-in by default. */
  private readonly target: Phaser.Math.Vector2;
  private readonly _colorNumber: number;
  private readonly _burstCount: number;

  // ── Construction ─────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: PhaserConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? PHASER_SIZE,
      color: config.color ?? PHASER_COLOR_NUMBER,
      bulletColor: config.bulletColor ?? PHASER_BULLET_COLOR,
      bulletSize: config.bulletSize ?? PHASER_BULLET_SIZE,
      bulletSpeed: config.bulletSpeed ?? PHASER_BULLET_SPEED,
      bulletLifetime: config.bulletLifetime,
      fireInterval: config.fireInterval ?? PHASER_FIRE_INTERVAL,
      shotProbability: config.shotProbability,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    // Each Phaser gets a unique orbital phase evenly distributed across the
    // group's actual size (`phase_i = i × 2π / count`), so a group of any
    // count occupies distinct orbital slots (AH-0MVEXVME1004SIIS).
    this._formationCount =
      config.formationCount ??
      config.formationOffset.phaseCount ??
      PHASER_FORMATION_COUNT;
    this._orbitalPhase = this._computeOrbitalPhase(config.formationOffset);
    this._colorNumber = config.color ?? PHASER_COLOR_NUMBER;
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
    this.explosionGraphics.setDepth(3);
    this.add(this.explosionGraphics);

    // Tell graphics — visual warning before firing.
    this.tellGraphics = scene.add.graphics();
    this.tellGraphics.setDepth(0);
    this.add(this.tellGraphics);
  }

  /** VFX pattern name for Phaser explosions. */
  /** Archetype key (`'phaser'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'phaser';
  }

  protected getExplosionPatternName(): string {
    return 'phaser';
  }

  /**
   * Computes the orbital phase for this Phaser based on its formation
   * offset and the group's actual count. Phases are evenly distributed
   * across the full turn, so a group of `N` Phasers occupies `N` distinct
   * slots (AH-0MVEXVME1004SIIS).
   */
  private _computeOrbitalPhase(offset: FormationOffset): number {
    return orbitalPhaseAngle(orbitalPhaseIndex(offset), this._formationCount);
  }

  // ── Drawing ──────────────────────────────────────────────────────

  protected _drawBody(): void {
    this.ringGraphics.clear();
    const half = this._size / 2;

    // Style must be set AFTER clear(): Graphics is command-buffered.
    this.ringGraphics.lineStyle(PHASER_RING_WIDTH, this._colorNumber, 1);

    // Circular neon ring.
    this.ringGraphics.strokeCircle(0, 0, half + 4);
  }

  /** Live particle-explosion handles (copy — for tests/SHUTDOWN checks). */
  getExplosionHandles(): ExplosionHandle[] {
    return this.explosionHandles.slice();
  }

  // ── Public state ─────────────────────────────────────────────────

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

  get effectiveSize(): number { return this._size; }
  get effectiveColor(): number { return this._colorNumber; }
  get effectiveBurstCount(): number { return this._burstCount; }

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

  /** Whether the Phaser's visible body (ring) is currently shown. */
  get bodyVisible(): boolean {
    return this.ringGraphics.alpha > 0 && this.ringGraphics.visible;
  }

  /**
   * Hides the ring and core (the Phaser's visible body) on destruction.
   */
  protected hideBody(): void {
    this.ringGraphics.setAlpha(0);
    this.coreGraphics.setAlpha(0);
  }

  /**
   * Destroys Phaser-specific graphics (ring, core, tell) in addition to
   * the shared body graphics.
   */
  protected destroyGraphics(): void {
    super.destroyGraphics();
    this.ringGraphics.destroy();
    this.coreGraphics.destroy();
    this.tellGraphics.destroy();
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
      // The fire sound was already scheduled at tell start (cue end), so
      // this branch plays no additional audio (no double-play).
      // The shared Phaser radial projectile identity (AH-0MV822DRX009RYUB):
      // every bolt is a crisply-edged hexagonal phaser bolt with a bright
      // velocity-aligned white core streak and a neon rim in the Phaser's own
      // magenta — drawn through the shared bullet-shape seam with a short
      // fading trail. Because EVERY scene drives this same
      // `tryFireRadialBullets` through `fireForEnemy`, the bolt's shape, rim,
      // trail and launch pop are identical in the game and every gym
      // (gym↔game parity by construction). Firing logic, speed, interval,
      // spoke count and radial pattern are unchanged — visuals/feel only.
      const visual = resolveEnemyBulletVisual('phaser');

      // One shared launch pop at the Phaser's body for the whole radial
      // volley: the volley is a single fire event (one cue+sound pair), so it
      // gets one magenta fire VFX rather than N stacked pops. Spawned through
      // the shared `src/vfx/enemyMuzzleFlash` helper (cheap Graphics
      // primitive, self-cleaning tween). `heading` 0 — a radial burst has no
      // single aim direction, so the pop is direction-agnostic like the burst
      // itself.
      if (visual.muzzle) {
        spawnEnemyMuzzleFlash(this.scene, this.x, this.y, 0, visual.muzzle);
      }

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
        // Normalise direction.
        const mag = Math.sqrt(dir.dx * dir.dx + dir.dy * dir.dy) || 1;
        const nx = dir.dx / mag;
        const ny = dir.dy / mag;
        // Each bolt flies nose-first along its own spoke (the shared seam
        // rotates the Graphics to `heading`).
        const heading = Math.atan2(ny, nx);

        const { graphics, color, redraw } = createBullet({
          scene: this.scene,
          color: this._bulletColor,
          size: this._bulletSize,
          x: this.x,
          y: this.y,
          shape: visual.shape,
          length: visual.length,
          rimColor: visual.rimColor,
          thickness: visual.thickness,
          alpha: visual.alpha,
          tail: visual.tail,
          angle: heading,
        });

        bullets.push({
          graphics,
          color,
          redraw,
          vx: nx * this._bulletSpeed,
          vy: ny * this._bulletSpeed,
          lifetime: this._bulletLifetime,
          elapsed: 0,
        });
      }
      return bullets;
    }

    // Start the tell animation — roll the shot probability at this
    // decision point BEFORE entering the tell, so a failed roll consumes
    // the cycle without playing an advance cue (tell/RNG constraint).
    if (!(this._rng() < this._shotProbability)) {
      this._lastFireTime = now;
      return [];
    }
    this._isTelling = true;
    // Store the local phase (in seconds) so applyFormationPosition can
    // compute tell elapsed without accessing scene.time.now.
    this._tellStartTime = this._localPhase;
    // The actual firing happens on the next call after the tell duration.
    return [];
  }

  /**
   * The Phaser's live orbital slot around the formation base `(baseX, baseY)`
   * (AH-0MVEXVME1004SIIS). The shared orbital-slot seam consumed by the
   * scenes' wormhole-transit destination resolvers, so a spawning Phaser
   * travels straight to the point it will orbit on — no line-then-snap.
   * Re-evaluated every frame, so it tracks the advancing orbit.
   */
  formationSlot(baseX: number, baseY: number): FormationPosition {
    return computeOrbitalSlot(
      baseX,
      baseY,
      this._orbitalPhase,
      PHASER_ORBITAL_RADIUS,
      this._localPhase * PHASER_ORBITAL_SPEED,
    );
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

    // Advance the orbital angle using a local phase accumulator instead of
    // `scene.time.now` so the entity does not crash when its `scene` is
    // undefined (stale after a scene restart — the SHUTDOWN teardown
    // destroys it first). The position comes from the shared orbital-slot
    // helper, the same one the transit-destination resolver consumes through
    // `formationSlot` (AH-0MVEXVME1004SIIS).
    this._localPhase += dt;
    const slot = this.formationSlot(baseX, baseY);
    this.setPosition(slot.x, slot.y);

    // Handle tell animation if firing is enabled.
    if (this._shootEnabled && this._isTelling) {
      // Tell elapsed in ms (local phase is in seconds).
      const tellElapsed =
        Math.max(0, this._localPhase - this._tellStartTime) * 1000;
      if (tellElapsed < PHASER_ADVANCE_CUE_DURATION) {
        // During the tell, pulse the ring to warn the player.
        this._drawTell(tellElapsed);
        // Play the two-phase audio tell at the start of the tell (once):
        // the advance cue now, and the fire sound scheduled at the cue's
        // end (matching the Scout pattern — no dead gap).
        if (tellElapsed < 50) {
          playPhaserAdvanceCue();
          playPhaserFireSound();
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
}

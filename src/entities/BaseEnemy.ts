/**
 * Shared base class for regular enemy entities.
 *
 * Extracts ~60 % of boilerplate shared across Scout, Diver, Tank, Phaser and
 * Swarm: construction state, destruction teardown, explosion handling,
 * hit-radius calculation, body visibility, aim-target management, and
 * formation-position calculation.
 *
 * Each concrete subclass still defines:
 * - its own config type with type-specific fields / defaults
 * - its `_drawBody()` implementation (unique shape)
 * - its movement modifier (wiggle, dive state machine, hold/move, orbit, drift)
 * - its firing pattern (`tryFire*` methods)
 *
 * @module src/entities/BaseEnemy
 */

import Phaser from 'phaser';

import { HIT_RADIUS_BUFFER_PX } from '../core/constants';
import { loadRules } from '../core/rules';
import { playEnemyForceFieldBreakSound } from '../audio/effects';
import {
  drawEnemyForceFieldBubble,
  ENEMY_FORCE_FIELD_BREAK_RADIUS_FACTOR,
  ENEMY_FORCE_FIELD_RADIUS_FACTOR,
  spawnEnemyForceFieldBreakFlash,
} from '../scenes/core/CombatEffectVisuals';
import {
  FormationOffset,
  FormationPosition,
  computeFormationPosition,
} from '../utils/formations';
import { resolvePatterns, spawnExplosionParticles } from '../vfx/explosionParticles';
import type { ExplosionHandle } from '../vfx/explosionParticles';
import { Mineral, scatterMineralDrops } from './Mineral';

/**
 * Minimal shared config fields accepted by every regular enemy subclass.
 * Type-specific fields (burst count, pause duration, etc.) live on the
 * subclass's config type.
 */
export interface BaseEnemyConfig {
  /** Position within the formation. */
  formationOffset: FormationOffset;
  /** Entity visual half-size in px. */
  size?: number;
  /** Body colour (hex number). */
  color?: number;
  /** Bullet colour (hex number). */
  bulletColor?: number;
  /** Bullet radius in px. */
  bulletSize?: number;
  /** Bullet speed in px/s. */
  bulletSpeed?: number;
  /**
   * Bullet lifetime in seconds (bullets wrap and expire; AH-0MU960UTE001PTV0).
   * Defaults to 1.5 s when omitted.
   */
  bulletLifetime?: number;
  /** Minimum milliseconds between fire attempts. */
  fireInterval?: number;
  /** Probability that a fire cycle produces a shot (0–1). */
  shotProbability?: number;
  /**
   * Hit points before the enemy is destroyed (data-driven; AH-0MUI820PM0038HS2).
   * Defaults to `1` so every single-hit archetype is unchanged.
   */
  health?: number;
  /**
   * Remaining enemy force-field hits at spawn (epic AH-0MVJ8W4GE007OMNT AC2;
   * AH-0MVM8GUZG008AWSU). The count is resolved once by the pure
   * `enemyForceFieldHits(level, config)` helper and threaded through the
   * spawn path — the entity never evaluates the level curve itself.
   *
   * Defaults to `0` (unshielded), so an entity constructed without a field is
   * byte-for-byte today's behaviour: `health` is the only thing a hit touches.
   */
  forceFieldHits?: number;
  /**
   * Whether this enemy is aware of the playfield seam (AH-0MV9G3DZ9003P7P8).
   * Absent resolves to `true` — seam-awareness is the default — while the
   * classic arcade exclusions (`march`, `centipede`) carry an explicit
   * `false`. Scenes must read the resolved {@link BaseEnemy.wrapAware}
   * accessor rather than re-parsing the raw config.
   */
  wrapAware?: boolean;
  /** Random-number generator (defaults to `Math.random`). */
  rng?: () => number;
}

/**
 * Abstract base for all regular (non-Boss) enemy entities.
 *
 * Extends `Phaser.GameObjects.Container` directly — Phaser 3 requires
 * Container inheritance for display-list children.
 */
export abstract class BaseEnemy extends Phaser.GameObjects.Container {
  // ── Shared state (declared here, initialised in subclass constructors) ─

  /** Whether the enemy is currently alive (not yet destroyed). */
  protected _alive = true;

  /** Whether the enemy is allowed to fire. */
  protected _shootEnabled = false;

  /** Timestamp of the last fire attempt (ms). */
  protected _lastFireTime = 0;

  /** Position within the formation, assigned from config. */
  protected readonly formationOffset: FormationOffset;

  // ── Graphics (shared across all regular enemies) ────────────────────

  /** Body rendering layer — unique shape drawn by each subclass. */
  protected readonly bodyGraphics: Phaser.GameObjects.Graphics;

  /** Separate explosion particle layer. */
  protected readonly explosionGraphics: Phaser.GameObjects.Graphics;

  /**
   * Shared enemy force-field bubble layer (epic AH-0MVJ8W4GE007OMNT AC3,
   * AH-0MVM8GW7W004SI0E). Drawn by the shared
   * `drawEnemyForceFieldBubble` helper so the game and every gym render the
   * barrier identically; cleared once the field breaks.
   */
  protected readonly forceFieldGraphics: Phaser.GameObjects.Graphics;

  /** Live particle-explosion handles (SHUTDOWN-safe teardown in destroy()). */
  protected readonly explosionHandles: ExplosionHandle[] = [];

  // ── Common config fields (with shared defaults) ────────────────────

  /** Entity visual half-size in px. */
  protected readonly _size: number;

  /** Body colour (hex number). */
  protected readonly _color: number;

  /** Bullet colour (hex number). */
  protected readonly _bulletColor: number;

  /** Bullet radius in px. */
  protected readonly _bulletSize: number;

  /** Bullet speed in px/s. */
  protected readonly _bulletSpeed: number;

  /** Bullet lifetime in seconds (wrap + expiry; AH-0MU960UTE001PTV0). */
  protected readonly _bulletLifetime: number;

  /** Minimum milliseconds between fire attempts. */
  protected readonly _fireInterval: number;

  /** Probability that a fire cycle produces a shot (0–1). */
  protected readonly _shotProbability: number;

  /**
   * Remaining hit points before destruction (data-driven). Initialised from
   * `config.health` and decremented by {@link takeDamage}; defaults to `1`.
   */
  protected _health: number;

  /**
   * Remaining force-field hits (epic AH-0MVJ8W4GE007OMNT AC2). Absorbed
   * before the hull: {@link takeDamage} decrements this while it is above
   * zero and only then touches {@link _health}. Initialised from
   * `config.forceFieldHits` (default `0` = unshielded) so no entity gains a
   * field by accident.
   */
  protected _forceFieldHits: number;

  /**
   * Field hits at full strength (the value the entity spawned with), used to
   * brighten the shared bubble ring with the remaining hits. `0` for an
   * unshielded enemy.
   */
  protected _forceFieldMaxHits: number;

  /**
   * Whether the shared force-field bubble is currently drawn. Mirrors the
   * helper's return value so tests/consumers can read the bubble state
   * without pixel assertions.
   */
  protected _forceFieldBubbleDrawn = false;

  /**
   * Latches `true` on the hit that spends the last field hit and never flips
   * back — the single, exactly-once "field broke" signal shared by every
   * consumer (feedback, audio, scenes).
   */
  protected _forceFieldBroken = false;

  /**
   * Whether the most recent {@link takeDamage} hit was absorbed by the force
   * field rather than the hull. `false` for unshielded enemies and after the
   * field has broken.
   */
  protected _lastHitAbsorbed = false;

  /** Random-number generator. */
  protected readonly _rng: () => number;

  /**
   * Resolved seam-awareness flag (AH-0MV9G3DZ9003P7P8): `true` unless the
   * config explicitly opts out. This is the one value scenes read through the
   * {@link wrapAware} accessor — no duplicated parsing anywhere else.
   */
  protected readonly _wrapAware: boolean;

  // ── Abstract method: pattern name for explosion VFX ────────────────

  /**
   * Returns the VFX pattern name used by `spawnExplosionParticles` for
   * this enemy type (e.g. `'scout'`, `'diver'`, `'tank'`, `'phaser'`, `'swarm'`).
   */
  protected abstract getExplosionPatternName(): string;

  // ── Constructor ────────────────────────────────────────────────────

  /**
   * Create the shared base. Subclasses call `super()` with `scene, x, y, config`
   * then set up their type-specific fields and graphics.
   *
   * @param scene — Phaser scene
   * @param x — initial x position
   * @param y — initial y position
   * @param config — shared config fields (type-specific fields are subclass-only)
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    config: BaseEnemyConfig,
  ) {
    super(scene, x, y);

    this.formationOffset = config.formationOffset;
    this._size = config.size ?? 16;
    this._color = config.color ?? 0x000000;
    this._bulletColor = config.bulletColor ?? 0xffffff;
    this._bulletSize = config.bulletSize ?? 3;
    this._bulletSpeed = config.bulletSpeed ?? 100;
    this._bulletLifetime = config.bulletLifetime ?? 1.5;
    this._fireInterval = config.fireInterval ?? 1000;
    this._shotProbability = config.shotProbability ?? 1.0;
    this._health = config.health ?? 1;
    this._forceFieldHits = sanitiseForceFieldHits(config.forceFieldHits);
    this._forceFieldMaxHits = this._forceFieldHits;
    this._wrapAware = config.wrapAware ?? true;
    this._rng = config.rng ?? Math.random;

    // Shared graphics — created here but NOT added to the container.
    // Each subclass adds them in the correct render order (body first,
    // then explosion) to preserve the original visual layering.
    this.bodyGraphics = scene.add.graphics();
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(2);
    this.forceFieldGraphics = scene.add.graphics();
  }

  /**
   * Adds the shared body + explosion graphics to this container in the
   * canonical render order (body first, explosion second). Subclasses
   * with extra graphics layers call this before adding their own layers.
   */
  protected addSharedGraphics(): void {
    this.bodyGraphics.setDepth(1);
    this.add(this.bodyGraphics);
    // The force-field bubble sits over the hull (depth between body and
    // explosion) so a shielded enemy always reads "barrier around ship".
    this.forceFieldGraphics.setDepth(1.5);
    this.add(this.forceFieldGraphics);
    this.add(this.explosionGraphics);
    this._drawForceFieldBubble();
  }

  // ── Force-field bubble (AC3, AH-0MVM8GW7W004SI0E) ──────────────────

  /**
   * Re-draws the shared enemy force-field bubble layer from the current field
   * state, delegating the drawing to `drawEnemyForceFieldBubble`. Called when
   * the shared layers are attached and after every absorbed hit, so the ring
   * dims as the field is spent.
   */
  protected _drawForceFieldBubble(): void {
    this._forceFieldBubbleDrawn = drawEnemyForceFieldBubble(
      this.forceFieldGraphics,
      { x: 0, y: 0 },
      this._size,
      this._forceFieldHits,
      this._forceFieldMaxHits,
    );
  }

  /**
   * Removes the bubble layer without destroying it (field broken or enemy
   * destroyed). The graphics object is reused if the enemy is re-drawn.
   */
  protected _clearForceFieldBubble(): void {
    this._forceFieldBubbleDrawn = false;
    this.forceFieldGraphics.clear();
  }

  /**
   * Runs the once-per-field **break** feedback (AC3): clears the bubble and
   * plays the distinct break flash + registered audio cue. Called from
   * {@link takeDamage} on the hit that spends the last field hit, so the
   * game and every gym (all routed through the same `takeDamage()` seam) get
   * identical feedback.
   */
  protected _breakForceField(): void {
    this._clearForceFieldBubble();
    const scene = this.scene as Phaser.Scene | undefined;
    if (!scene) return;
    const bubbleRadius =
      (this._size / 2) * ENEMY_FORCE_FIELD_RADIUS_FACTOR;
    spawnEnemyForceFieldBreakFlash(scene, this.x, this.y, {
      radius: bubbleRadius * ENEMY_FORCE_FIELD_BREAK_RADIUS_FACTOR,
    });
    playEnemyForceFieldBreakSound();
  }

  // ── Subclass hook: draw unique body shape ──────────────────────────

  /**
   * Each subclass overrides this to draw its unique body shape
   * (chevron, dart, hexagon, ring, diamond). Called once during
   * construction and optionally re-called if the body needs redrawing.
   */
  protected abstract _drawBody(): void;

  // ── Shared lifecycle ───────────────────────────────────────────────

  /**
   * Mark this enemy as destroyed: set alive flag, hide body, trigger explosion.
   * This is the single entry point for destruction — the scene calls it
   * when the enemy collides with a player bullet. Subclasses may override
   * `hideBody()` to hide type-specific graphics.
   */
  destroySelf(scale = 1): void {
    if (!this._alive) return;
    this.destroySilently();
    this.playExplosion(scale);
  }

  /**
   * Mark this enemy as destroyed **without** its own explosion VFX.
   *
   * This is the shared "removed from play, no reward" seam for callers that
   * play their own burst at the same position — currently the mini-boss death
   * sweep (`spawnMiniBossDeathSweep`, AH-0MVROELN600410GP), whose staggered
   * cascade would otherwise be doubled by every swept enemy exploding twice.
   * It does exactly what {@link destroySelf} does minus the particles: alive
   * flag cleared, body hidden, force-field bubble cleared. It never awards
   * score, drops or telemetry — that only happens in the scene's kill path.
   */
  destroySilently(): void {
    if (!this._alive) return;
    this._alive = false;
    this.hideBody();
    // A destroyed enemy never leaves its barrier hovering in the arena —
    // cleared here so every subclass (including those overriding hideBody) is
    // covered.
    this._clearForceFieldBubble();
  }

  /**
   * Hook for subclasses to hide body graphics on destruction.
   * The default implementation hides `bodyGraphics`.
   */
  protected hideBody(): void {
    this.bodyGraphics.setAlpha(0);
  }

  /**
   * Play the destruction explosion animation.
   * Audio is played by the scene at destruction time, not here
   * (design doc §7).
   *
   * @param scale — explosion geometry scale factor (1 = normal; the wave
   *   time-limit penalty uses 10, AH-0MU7JTG9R002ZWA6).
   */
  playExplosion(scale = 1): void {
    // Belt-and-braces null-scene guard (AH-0MTPLHLZ3006MOC4): a destroyed
    // display-list child has `scene === undefined`; animating it here would
    // dereference undefined. Normal single-run destruction keeps the old
    // behaviour exactly (the guard never triggers on a live object).
    if (!this.scene) return;
    const scene = this.scene as Phaser.Scene;
    const handle = spawnExplosionParticles(
      scene,
      this.x,
      this.y,
      this._color,
      this._size,
      { patterns: resolvePatterns(this.getExplosionPatternName()), scale, kind: 'enemy' },
    );
    if (handle) this.explosionHandles.push(handle);
  }

  /**
   * Apply one hit of damage. The **force field absorbs hits before the hull**
   * (epic AH-0MVJ8W4GE007OMNT AC2): while the field carries hits, this
   * decrements the field, leaves `health` untouched, reports the hit as
   * absorbed and keeps the enemy alive — yet still returns the remaining
   * **hull** health so every existing caller keeps working unchanged. The hit
   * that spends the last field hit is the last absorbed hit and latches
   * {@link forceFieldBroken} exactly once.
   *
   * Only once the field is down does the hull take damage as before:
   * {@link _health} is decremented and {@link destroySelf} runs on the last
   * hit point, so the shared player-bullet collision path finalises the kill
   * exactly once on the lethal blow. A hit against an already-destroyed enemy
   * is a no-op.
   *
   * Every player damage source (bullet, damage-budget beam, AOE, Smart Bomb, Orbital
   * Strike, Frenzy bonus hits) already routes through this single seam, so the
   * field depletes identically for all of them — there is no parallel damage
   * path.
   *
   * @returns the remaining hit points after this hit (`0` when destroyed).
   */
  takeDamage(): number {
    if (!this._alive) return 0;
    if (this._forceFieldHits > 0) {
      this._forceFieldHits -= 1;
      this._lastHitAbsorbed = true;
      if (this._forceFieldHits === 0) {
        this._forceFieldBroken = true;
        this._breakForceField();
      } else {
        // The barrier survived: redraw so its brightness tracks the spent hit.
        this._drawForceFieldBubble();
      }
      return this._health;
    }
    this._lastHitAbsorbed = false;
    this._health -= 1;
    if (this._health <= 0) {
      this._health = 0;
      this.destroySelf();
    }
    return this._health;
  }

  /**
   * Whether this enemy is aware of the playfield seam (AH-0MV9G3DZ9003P7P8).
   * The single resolved accessor every scene reads; an absent config resolves
   * to `true` (seam-awareness is the default) and only the explicit seed
   * exclusions (`march`, `centipede`) carry `false`.
   */
  get wrapAware(): boolean {
    return this._wrapAware;
  }

  /** Remaining hit points before destruction. */
  get health(): number {
    return this._health;
  }

  /**
   * Remaining force-field hits (read-only; `0` when unshielded or broken).
   * The field absorbs hits before the hull — see {@link takeDamage}.
   */
  get forceFieldHits(): number {
    return this._forceFieldHits;
  }

  /** Whether this enemy still carries a force field (`forceFieldHits > 0`). */
  get hasForceField(): boolean {
    return this._forceFieldHits > 0;
  }

  /**
   * Whether the shared enemy force-field bubble is currently drawn (AC3).
   * True while the field is up, false once it breaks or the enemy is
   * destroyed.
   */
  get forceFieldBubbleVisible(): boolean {
    return this._forceFieldBubbleDrawn;
  }

  /** Whether the most recent hit was absorbed by the force field. */
  get lastHitAbsorbed(): boolean {
    return this._lastHitAbsorbed;
  }

  /**
   * Whether the force field has been broken. Latches `true` on the hit that
   * spends the last field hit and never flips back.
   */
  get forceFieldBroken(): boolean {
    return this._forceFieldBroken;
  }

  /** Hit radius for collision detection. */
  getHitRadius(): number {
    return Math.ceil(this._size / 2 + HIT_RADIUS_BUFFER_PX);
  }

  /** Whether the body graphics is currently visible. */
  get bodyVisible(): boolean {
    return this.bodyGraphics.alpha > 0 && this.bodyGraphics.visible;
  }

  /** Whether the enemy is alive. */
  get alive(): boolean {
    return this._alive;
  }

  /**
   * The enemy archetype key (e.g. `'scout'`, `'diver'`, `'asteroid'`).
   *
   * Matches the `enemyKey` used by the scene/formation data and is exposed
   * for read-only consumers such as the bot snapshot builder
   * (`src/ai/botSnapshot.ts`). Concrete subclasses override it with their
   * canonical key; an unknown subclass falls back to `'unknown'` so the
   * value is always a string.
   */
  get archetype(): string {
    return 'unknown';
  }

  // ── Mineral accounting (AH-0MUBVGI62004ED9Q) ─────────────────────

  /** Number of minerals this enemy has absorbed. */
  private _mineralCount = 0;

  /** Number of minerals this enemy has absorbed (for tests/scene wiring). */
  get mineralCount(): number {
    return this._mineralCount;
  }

  /**
   * Absorb one mineral, incrementing the tracked count. Asteroids override
   * this as a no-op — they are excluded from mineral collection.
   */
  collectMineral(): void {
    this._mineralCount += 1;
  }

  /**
   * Number of minerals to re-drop when this enemy is destroyed — the
   * collected count plus a random additive bonus drawn from
   * [`mineralRedropBonusMin`, `mineralRedropBonusMax`] (defaults
   * 0.25–1.25), rounded to the nearest integer. The result may exceed the
   * collected count (there is no upper cap); an enemy that collected
   * nothing still draws the bonus and may occasionally drop a single mineral
   * (when `round(bonus) === 1`).
   *
   * @param rng — random-number generator (defaults to `Math.random`);
   *   injected by tests for deterministic bounds checking. Exactly one
   *   draw is taken per call.
   */
  mineralRedropCount(rng: () => number = Math.random): number {
    const rules = loadRules();
    const bonus =
      rules.mineralRedropBonusMin +
      rng() * (rules.mineralRedropBonusMax - rules.mineralRedropBonusMin);
    return Math.round(this._mineralCount + bonus);
  }

  /**
   * Spawn the re-dropped minerals scattered at the explosion site. Each drop
   * lands within {@link MINERAL_REDROP_SCATTER_RADIUS} px of `(x, y)`. Returns
   * the spawned minerals, or an empty array when nothing is to be re-dropped
   * (or the enemy is no longer attached to a scene).
   *
   * @param x — explosion-site x position
   * @param y — explosion-site y position
   * @param rng — random-number generator (defaults to `Math.random`)
   */
  spawnMineralDrops(
    x: number,
    y: number,
    rng: () => number = Math.random,
  ): Mineral[] {
    const count = this.mineralRedropCount(rng);
    const scene = this.scene as Phaser.Scene | undefined;
    if (!scene) return [];
    // Shared scatter maths (single definition in Mineral.ts, also used by the
    // shared kill-drop rule) keeps the RNG draw order unchanged.
    return scatterMineralDrops(scene, x, y, count, rng);
  }

  /** Whether the enemy is allowed to fire. */
  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  /** Set whether the enemy is allowed to fire. */
  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
  }

  // ── Spawn animation state (wormhole entry) ────────────────────────

  /** Whether this enemy is currently in its spawn animation. */
  protected _isSpawning = false;

  /** True while the enemy is still growing from the wormhole spawn. */
  get isSpawning(): boolean {
    return this._isSpawning;
  }

  /**
   * Sets the spawn animation state.  When `true`, the enemy is protected
   * from collisions and cannot fire; the scene drives the visual growth
   * animation each frame via {@link updateSpawnAnimation}.
   *
   * @param value - Whether the enemy is spawning.
   */
  setSpawning(value: boolean): void {
    this._isSpawning = value;
  }

  /**
   * Full destruction teardown. Each subclass overrides `destroyGraphics()`
   * to destroy its type-specific graphics objects; the base class handles
   * the shared ones.
   */
  destroy(fromScene?: boolean): void {
    this.destroyGraphics();
    this.explosionGraphics.destroy();
    this.forceFieldGraphics.destroy();
    for (const handle of this.explosionHandles) handle.destroy();
    this.explosionHandles.length = 0;
    super.destroy(fromScene);
  }

  /**
   * Hook for subclasses to destroy type-specific graphics.
   * The default implementation destroys only `bodyGraphics`.
   */
  protected destroyGraphics(): void {
    this.bodyGraphics.destroy();
  }

  // ── Formation position ─────────────────────────────────────────────

  /**
   * Compute the base formation position for this enemy.
   * Each subclass adds its own movement modifier on top.
   */
  computeFormationPosition(
    baseX: number,
    baseY: number,
    spacingX: number,
    spacingY: number,
  ): FormationPosition {
    return computeFormationPosition(
      baseX, baseY,
      this.formationOffset,
      spacingX, spacingY,
    );
  }

  /** Current formation offset (copy). */
  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }
}

/**
 * Resolves an authored force-field hit count to a usable non-negative
 * integer. Non-finite/negative values resolve to `0` (unshielded) — a
 * defensive guard so a corrupt config can never fabricate a shield.
 */
function sanitiseForceFieldHits(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

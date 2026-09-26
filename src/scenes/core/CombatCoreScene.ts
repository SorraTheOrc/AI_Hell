/**
 * Narrower shared combat base (parent AH-0MUDCT7EU0061OSZ).
 *
 * `CombatScene` (the shipped game's combat core, re-based by
 * AH-0MUD8E015004C4JO) is the shared core for scenes that need the full
 * combat/lifecycle surface. The three older standalone gym scenes
 * (`GymWeapons`, `GymPowerUpsCombat`, `GymPowerUpsUtility`) predate that
 * core and duplicated part of it. Two of them are threat-free: they need
 * the input path, auto-fire and drop collection, but not collisions,
 * teleports or hostile-hit handling.
 *
 * This class owns that narrower surface **once** so those threat-free
 * scenes can consume it directly, while `CombatScene` extends it and adds
 * the combat-only template methods (collisions, hostile hits, teleport).
 * It owns:
 *
 * - the input path ({@link CombatCoreScene._readPlayerInput} plus the
 *   cursor/WASD/handler fields),
 * - auto-fire ({@link CombatCoreScene._autoFire},
 *   {@link CombatCoreScene.spawnPlayerBullet} and the
 *   {@link CombatCoreScene.onWeaponFired} hook),
 * - drop collection ({@link CombatCoreScene._collectDrop},
 *   {@link CombatCoreScene._startCollectAnimation},
 *   {@link CombatCoreScene._updateCollectAnimations} and the pickup-cue
 *   hook),
 * - the player-explosion/collect registries, and the shared
 *   enemy-bullet clear path used by the P4 bomb,
 * - the shared hooks the combat scenes override
 *   ({@link CombatCoreScene.getInvulnerabilityDuration},
 *   {@link CombatCoreScene.tryAbsorbPlayerHit},
 *   {@link CombatCoreScene.isPlayerPhased},
 *   {@link CombatCoreScene.onPowerUpCollected},
 *   {@link CombatCoreScene.onWeaponCollected},
 *   {@link CombatCoreScene._playPickupCue}).
 *
 * The class is deliberately *concrete*: each participant accessor has a
 * safe default (no player, empty bullets, a private effects registry) so
 * the shared seams are directly testable with a stub subclass, and the
 * combat-specific subclasses narrow the contract again with abstract
 * declarations.
 *
 * @module scenes/core/CombatCoreScene
 */

import Phaser from 'phaser';

import {
  PLAYER_BULLET_RADIUS,
  PLAYER_BULLET_SPEED,
  PLAYER_RESPAWN_INVULNERABLE,
  SHIP_COLOR,
  SHIP_SIZE,
} from '../../core/constants';
import { Player } from '../../entities/Player';
import { PlayerBullet, createPlayerBullet } from '../../entities/PlayerBullet';
import {
  angleToVelocity,
  createBulletsFromHeading,
  type WeaponId,
} from '../../utils/weapons';
import {
  AsteroidsInputHandler,
  FourDirectionalInputHandler,
  type ControlInput,
} from '../../utils/movementModel';
import type { WasdKeysLike } from '../../utils/input';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import {
  spawnCollectAnimation,
  type CollectAnimationHandle,
} from '../../powerups/collectAnimation';
import {
  resolvePatterns,
  spawnExplosionParticles,
} from '../../vfx/explosionParticles';
import type { DropId, PowerUpId } from '../../powerups/types';

/**
 * Structural contract an enemy entity must satisfy for a combat scene to
 * collide with and destroy it. `FormationSceneEntity` (gym) and
 * `EnemyEntity` (game) both satisfy it structurally.
 */
export interface CombatEnemyEntity extends Phaser.GameObjects.GameObject {
  x: number;
  y: number;
  readonly alive: boolean;
  /** Hit radius (px) used for circle-vs-circle collision checks. */
  getHitRadius(): number;
  /** Destroys the entity, optionally at an explosion scale. */
  destroySelf(scale?: number): void;
  /** Optional entity-specific destruction audio seam. */
  playDestructionAudio?(): void;
  /**
   * Optional multi-hit seam (e.g. Boss). When present, a player bullet
   * delegates to this instead of `destroySelf()`.
   */
  takeDamage?(): number | void;
}

/** Structural contract an enemy bullet must satisfy. */
export interface CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
}

/**
 * Structural contract a power-up/weapon drop must satisfy for the shared
 * collect path. `PlayDrop` (game) and `FormationSceneDrop` (gym) both
 * satisfy it structurally.
 */
export interface CombatDrop {
  x: number;
  y: number;
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly powerUp: PowerUp;
  /** Unified drop id (power-up or weapon). */
  readonly dropId: DropId;
  /** The weapon drop id when this is a weapon drop. */
  weaponDropId?: string;
  /** True once collected and playing its absorb animation. */
  absorbing?: boolean;
}

/**
 * Concrete narrower shared combat base. Parameterised by the enemy,
 * bullet and drop types so the combat-specific subclasses keep fully
 * typed accessors; the enemy type is part of the signature so
 * {@link CombatScene} can pass through all three.
 */
export class CombatCoreScene<
  TEnemy extends CombatEnemyEntity = CombatEnemyEntity,
  TBullet extends CombatEnemyBullet = CombatEnemyBullet,
  TDrop extends CombatDrop = CombatDrop,
> extends Phaser.Scene {
  /** Player bullets in flight (auto-fired + test-injected). */
  protected playerBullets: PlayerBullet[] = [];
  /** Live player-explosion VFX graphics (tracked for observation). */
  protected playerExplosions: Phaser.GameObjects.Graphics[] = [];
  /**
   * Registry for every display object owned by the composed player-death
   * juice effect (flash, debris, shockwave, particles) — see
   * `spawnPlayerDeathJuice`. Cleared on scene SHUTDOWN so a stop/restart
   * leaks nothing (parent AH-0MUAYB4R3002ZIZY AC6).
   */
  protected playerDeathEffects: Phaser.GameObjects.GameObject[] = [];
  /** In-flight absorb animations for collected drops. */
  protected collectAnimations: CollectAnimationHandle[] = [];

  // Arrow-key (cursor) and WASD bindings for the player ship.
  protected cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  protected wasd: WasdKeysLike | undefined;
  /** Pluggable input handlers (one per control scheme). */
  protected fourDirHandler = new FourDirectionalInputHandler();
  protected asteroidsHandler = new AsteroidsInputHandler();

  /** Registry used by subclasses that do not supply their own. */
  private readonly defaultEffectsRegistry = new EffectsRegistry();

  // ── Participant contract (safe concrete defaults) ─────────────────

  /** The keyboard-controlled player ship (null when the scene has none). */
  protected getPlayer(): Player | null {
    return null;
  }

  /** The shared active-effect registry. */
  protected getEffectsRegistry(): EffectsRegistry {
    return this.defaultEffectsRegistry;
  }

  /** Live enemy entities. Threat-free scenes return an empty list. */
  protected getEnemyEntities(): readonly TEnemy[] {
    return [];
  }

  /** Live enemy bullets. Threat-free scenes return an empty list. */
  protected getEnemyBullets(): readonly TBullet[] {
    return [];
  }

  /** Replaces the enemy-bullet collection after a collision pass. */
  protected setEnemyBullets(_bullets: TBullet[]): void {}

  // ── Overridable hooks ─────────────────────────────────────────────

  /**
   * Seconds of post-hit invulnerability. Default 1.5 s (the shipped
   * game); `GymPowerUpsCombat` overrides this to keep its 0.8 s feel.
   */
  protected getInvulnerabilityDuration(): number {
    return PLAYER_RESPAWN_INVULNERABLE;
  }

  /**
   * Scene hook for shield-style absorption. Default: no absorption (the
   * hit always lands). {@link CombatScene} provides the shared
   * registry-backed implementation (P3 shield consumes one shield and
   * starts the post-hit invulnerability window), so concrete combat scenes
   * should not re-implement it.
   *
   * @returns whether the hit was fully absorbed.
   */
  protected tryAbsorbPlayerHit(_player: Player): boolean {
    return false;
  }

  /**
   * Whether the player is phase-shifted (P6) and therefore immune.
   * Default false; {@link CombatScene} provides the shared registry-backed
   * implementation (`getEffectsRegistry().isPhased`) so every combat scene
   * gates hits identically.
   */
  protected isPlayerPhased(): boolean {
    return false;
  }

  /**
   * Plays the firing cue for one weapon (one per firing weapon per
   * volley). Default no-op; scenes override with their per-weapon cue.
   */
  protected onWeaponFired(_weaponId: WeaponId): void {}

  /**
   * Plays the per-type pickup activation cue. Default no-op; scenes
   * override with their per-type game/gym cues.
   */
  protected _playPickupCue(_drop: TDrop): void {}

  /**
   * Hook run after a power-up (non-weapon) drop is collected. Default
   * no-op; scenes add their lifecycle extras.
   */
  protected onPowerUpCollected(_drop: TDrop): void {}

  /**
   * Hook run after a weapon drop is collected. Default no-op; scenes
   * advance their weapon lifecycle.
   */
  protected onWeaponCollected(_drop: TDrop): void {}

  // ── Shared template methods ───────────────────────────────────────

  /**
   * Reads the held arrow/WASD keys into the scheme-appropriate
   * `ControlInput` contract, keyed off the player's saved control scheme.
   */
  protected _readPlayerInput(): ControlInput | null {
    const player = this.getPlayer();
    if (!player || !this.cursors || !this.wasd) return null;
    const raw = { cursors: this.cursors, wasd: this.wasd };
    return player.getScheme() === 'asteroids'
      ? this.asteroidsHandler.mapInput(raw)
      : this.fourDirHandler.mapInput(raw);
  }

  /**
   * Auto-fires every active weapon toward the direction of travel when
   * its cooldown has elapsed, delegating the firing cue to
   * {@link CombatCoreScene.onWeaponFired}.
   */
  protected _autoFire(dt: number): void {
    const player = this.getPlayer();
    if (!player) return;
    const fired = player.tryFire(dt);
    if (fired.length === 0) return;
    const headingDeg = (player.getHeading() * 180) / Math.PI;
    for (const weaponId of fired) {
      this.onWeaponFired(weaponId);
      const def = player.getWeaponDef(weaponId);
      for (const bd of createBulletsFromHeading(
        def,
        headingDeg,
        player.x,
        player.y,
      )) {
        const vel = angleToVelocity(bd.angleDeg, PLAYER_BULLET_SPEED);
        this.spawnPlayerBullet(
          bd.x,
          bd.y,
          vel.vx,
          vel.vy,
          bd.color,
          def.bulletLifetime,
        );
      }
    }
  }

  /**
   * Spawns a player bullet at (x, y) travelling at (vx, vy) px/s,
   * with the given colour and lifetime (seconds).
   * Public so tests can place bullets deterministically.
   */
  spawnPlayerBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0x00ffff,
    lifetime = 1.5,
  ): PlayerBullet {
    const bullet = createPlayerBullet(
      this,
      x,
      y,
      color,
      PLAYER_BULLET_RADIUS,
      vx,
      vy,
      lifetime,
    );
    this.playerBullets.push(bullet);
    return bullet;
  }

  /** Spawns the player-death particle burst at (x, y). */
  protected _spawnPlayerExplosion(x: number, y: number): void {
    spawnExplosionParticles(this, x, y, SHIP_COLOR, SHIP_SIZE, {
      patterns: resolvePatterns('player'),
      registry: this.playerExplosions,
    });
  }

  /**
   * Collects a drop on overlap: applies the weapon/power-up through the
   * shared registry, clears bullets for P4, then starts the absorb VFX
   * and pickup cue. Scene-specific extras run through the collect hooks.
   */
  protected _collectDrop(drop: TDrop): void {
    const registry = this.getEffectsRegistry();
    const player = this.getPlayer();
    if (drop.weaponDropId) {
      if (drop.weaponDropId === 'reset') {
        registry.tryResetWeapons();
        player?.resetWeapon();
      } else {
        registry.applyWeapon(drop.weaponDropId as WeaponId);
        player?.equipWeapon(drop.weaponDropId as WeaponId);
      }
      this.onWeaponCollected(drop);
    } else {
      const effect = drop.powerUp.tryCollect();
      if (!effect) return;
      if (drop.dropId === 'P4') {
        this._clearEnemyBullets();
      }
      registry.applyCollect(drop.dropId as PowerUpId);
      this.onPowerUpCollected(drop);
    }
    // Collection confirmed — mark the drop so the overlap gate can never
    // re-collect it while the absorb animation plays.
    drop.absorbing = true;
    this._startCollectAnimation(drop);
    this._playPickupCue(drop);
  }

  /**
   * Starts the absorb animation for a collected drop, using the ship's
   * current world position as the attractor.
   */
  protected _startCollectAnimation(drop: TDrop): void {
    const player = this.getPlayer();
    const shipX = player?.x ?? drop.x;
    const shipY = player?.y ?? drop.y;
    this.collectAnimations.push(
      spawnCollectAnimation(drop.graphics, drop.x, drop.y, shipX, shipY),
    );
  }

  /** Advances every in-flight absorb animation and prunes completed ones. */
  protected _updateCollectAnimations(dt: number): void {
    if (this.collectAnimations.length === 0) return;
    const player = this.getPlayer();
    const kept: CollectAnimationHandle[] = [];
    for (const handle of this.collectAnimations) {
      if (player) handle.setAttractor(player.x, player.y);
      handle.update(dt);
      if (!handle.isComplete()) kept.push(handle);
    }
    this.collectAnimations = kept;
  }

  /** Clears all on-screen enemy bullets (P4 bomb — no enemy damage). */
  protected _clearEnemyBullets(): void {
    for (const bullet of this.getEnemyBullets()) {
      bullet.graphics.destroy();
    }
    this.setEnemyBullets([]);
  }

  // ── Run lifecycle (restart / teardown parity, gap 10) ─────────────

  /**
   * Resets the shared per-run state so a stop/restart of the *same*
   * scene instance starts from a clean slate — the gym/game counterpart
   * of `PlayScene._resetRunState()` (AH-0MUII3FYN0072QRT, gap 10).
   *
   * The active effects registry is reset through the polymorphic
   * {@link CombatCoreScene.getEffectsRegistry} accessor, so whichever
   * registry a scene owns (its own field or the shared default) is
   * cleared by this single implementation — no scene re-implements it.
   *
   * Scenes that own additional per-run state override this and call
   * `super.resetRunState()` first. Called at the top of `create()`.
   */
  protected resetRunState(): void {
    this.getEffectsRegistry().reset();
    this.playerBullets = [];
    this.playerExplosions = [];
    this.playerDeathEffects = [];
    // In-flight absorb animations are owned by the animation registry
    // (their drops are no longer in the scene's drop list), so their
    // only teardown path is here.
    for (const anim of this.collectAnimations) anim.destroy();
    this.collectAnimations = [];
  }

  /**
   * Destroys and clears the shared per-run display objects on scene
   * `SHUTDOWN` so a stop/restart leaks nothing (AC2). Scenes that own
   * additional object families override this and call
   * `super.teardownRunState()` first (or last, provided the base call is
   * always reached).
   */
  protected teardownRunState(): void {
    for (const bullet of this.playerBullets) bullet.destroy();
    this.playerBullets = [];
    for (const effect of this.playerExplosions) effect.destroy();
    this.playerExplosions = [];
    for (const effect of this.playerDeathEffects) effect.destroy();
    this.playerDeathEffects = [];
    for (const anim of this.collectAnimations) anim.destroy();
    this.collectAnimations = [];
    // Release every collected effect so a restarted scene starts clean
    // even when teardown (not a fresh `create()`) is the observed path.
    this.getEffectsRegistry().reset();
  }
}

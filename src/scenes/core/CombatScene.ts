/**
 * Shared combat core (parent AH-0MUD8E015004C4JO).
 *
 * `PlayScene` (the shipped game) and `GymFormationScene` (the gym core)
 * historically each kept their own copy of the scene-level combat and
 * player-lifecycle logic. The copies drifted, so a behaviour fix in one
 * scene did not reach the other. This abstract base class defines the
 * shared combat/lifecycle **template methods** exactly once:
 *
 * - {@link CombatScene._readPlayerInput}
 * - {@link CombatScene._autoFire}
 * - {@link CombatScene._collectDrop}
 * - {@link CombatScene._spawnPlayerExplosion}
 * - {@link CombatScene._clearEnemyBullets}
 * - {@link CombatScene._handleTeleport} / {@link CombatScene.triggerTeleport}
 * - {@link CombatScene._hitPlayer}
 * - {@link CombatScene._handleCollisions}
 *
 * Subclasses supply scene-specific behaviour through the hook contract
 * below (participant accessors + overridable hooks). The base owns the
 * state every combat scene shares: the player bullet list, the
 * player-explosion registry, the input handlers, and the post-hit
 * invulnerability window.
 *
 * @module scenes/core/CombatScene
 */

import Phaser from 'phaser';

import {
  PLAYER_BULLET_RADIUS,
  PLAYER_BULLET_SPEED,
  PLAYER_HIT_SCALE_PEAK,
  PLAYER_HIT_SCALE_PULSE_DURATION,
  PLAYER_RESPAWN_INVULNERABLE,
  SHIP_COLOR,
  SHIP_SIZE,
} from '../../core/constants';
import {
  playDestructionSound,
  playPowerUpCollectPopSound,
  playPowerUpCollectSound,
} from '../../audio/effects';
import { Player } from '../../entities/Player';
import {
  PlayerBullet,
  createPlayerBullet,
} from '../../entities/PlayerBullet';
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
import {
  resolvePatterns,
  spawnExplosionParticles,
} from '../../vfx/explosionParticles';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import {
  spawnCollectAnimation,
  type CollectAnimationHandle,
} from '../../powerups/collectAnimation';
import {
  findTeleportDestination,
  type TeleportBody,
} from '../../powerups/teleport';
import type { DropId, PowerUpId } from '../../powerups/types';

/** Blink half-period (s) while the player is invulnerable after a hit. */
export const COMBAT_BLINK_INTERVAL = 0.1;

/**
 * Structural contract an enemy entity must satisfy for the shared combat
 * core to collide with and destroy it. `FormationSceneEntity` (gym) and
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
 * Abstract shared combat scene. Parameterised by the enemy, bullet and
 * drop types so concrete subclasses keep fully-typed accessors.
 */
export abstract class CombatScene<
  TEnemy extends CombatEnemyEntity = CombatEnemyEntity,
  TBullet extends CombatEnemyBullet = CombatEnemyBullet,
  TDrop extends CombatDrop = CombatDrop,
> extends Phaser.Scene {
  /** Player bullets in flight (auto-fired + test-injected). */
  protected playerBullets: PlayerBullet[] = [];
  /** Live player-explosion VFX graphics (tracked for observation). */
  protected playerExplosions: Phaser.GameObjects.Graphics[] = [];
  /** In-flight absorb animations for collected drops. */
  protected collectAnimations: CollectAnimationHandle[] = [];

  /** Seconds of post-hit invulnerability remaining (blinks while > 0). */
  protected invulnerable = 0;
  protected blinkPhase = 0;
  /** Cumulative player-hit counter (exposed by both scenes). */
  protected playerHitCount = 0;

  // Arrow-key (cursor) and WASD bindings for the player ship.
  protected cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  protected wasd: WasdKeysLike | undefined;
  /** P7 teleport activation keys: S / ↓ (JustDown semantics). */
  protected teleportKey: Phaser.Input.Keyboard.Key | null = null;
  protected downKey: Phaser.Input.Keyboard.Key | null = null;
  /** Pluggable input handlers (one per control scheme). */
  protected fourDirHandler = new FourDirectionalInputHandler();
  protected asteroidsHandler = new AsteroidsInputHandler();

  // ── Participant contract (subclass accessors) ────────────────────

  /** The keyboard-controlled player ship (null when the scene has none). */
  protected abstract getPlayer(): Player | null;
  /** The shared active-effect registry. */
  protected abstract getEffectsRegistry(): EffectsRegistry;
  /** Live enemy entities (game: `spawned`; gym: `entities`). */
  protected abstract getEnemyEntities(): readonly TEnemy[];
  /** Live enemy bullets (game: `enemyBullets`; gym: `bullets`). */
  protected abstract getEnemyBullets(): readonly TBullet[];
  /** Replaces the enemy-bullet collection after a collision pass. */
  protected abstract setEnemyBullets(bullets: TBullet[]): void;

  // ── Overridable hooks (default = generic gym behaviour) ───────────

  /**
   * Whether the player may teleport right now. The gym gates teleports
   * on its opt-in power-up layer; the game always allows them.
   */
  protected canTeleport(): boolean {
    return true;
  }

  /** Default enemy hit radius for teleport destination avoidance (px). */
  protected getTeleportEnemyHitRadius(): number {
    return 12;
  }

  /** Default enemy-bullet hit radius for teleport avoidance (px). */
  protected getTeleportBulletHitRadius(): number {
    return 5;
  }

  /** Extra teleport-avoidance bodies (game: the boss). Default: none. */
  protected getAdditionalTeleportBodies(): TeleportBody[] {
    return [];
  }

  /**
   * Plays the firing cue for one weapon (one per firing weapon per
   * volley). Default no-op; the game plays its per-weapon shoot cue.
   */
  protected onWeaponFired(_weaponId: WeaponId): void {}

  /**
   * Player bullet hits an enemy. Default (generic gym) behaviour:
   * multi-hit entities receive `takeDamage()`; single-hit entities are
   * destroyed with their destruction audio and `onEnemyDestroyed`.
   *
   * @returns whether the bullet was consumed (stops the scan).
   */
  protected onPlayerBulletHitsEnemy(
    enemy: TEnemy,
    bullet: PlayerBullet,
  ): boolean {
    if (enemy.takeDamage) {
      enemy.takeDamage();
    } else {
      enemy.destroySelf();
      if (enemy.playDestructionAudio) {
        enemy.playDestructionAudio();
      } else {
        playDestructionSound();
      }
      this.onEnemyDestroyed(enemy);
    }
    bullet.destroy();
    return true;
  }

  /**
   * Player bullet hits the boss. Default: no boss. The game overrides
   * this to run its multi-hit phase damage.
   *
   * @returns whether the bullet was consumed.
   */
  protected onPlayerBulletHitsBoss(_bullet: PlayerBullet): boolean {
    return false;
  }

  /**
   * Called when an enemy is destroyed through the generic path. Default
   * no-op; the gym forwards to `config.onEntityDestroyed`.
   */
  protected onEnemyDestroyed(_enemy: TEnemy): void {}

  /**
   * Player-body ram destroys an enemy. Default (generic gym): destroy
   * the entity with its own destruction audio and `onEnemyDestroyed`
   * (the generic destruction sound is played by `_hitPlayer`).
   */
  protected onPlayerRamsEnemy(enemy: TEnemy): void {
    enemy.destroySelf();
    if (enemy.playDestructionAudio) {
      enemy.playDestructionAudio();
    }
    this.onEnemyDestroyed(enemy);
  }

  /**
   * Player-body ram against the boss. Default: no boss. The game
   * overrides this to detect the boss overlap (the boss cannot be
   * killed by ramming).
   *
   * @returns whether the player rammed the boss.
   */
  protected onPlayerRamsBoss(): boolean {
    return false;
  }

  /**
   * Dedicated player-bullet vs enemy-bullet impact feedback (parent AC5).
   * The shared collision path is the single place that resolves the
   * interception for both scenes; SFX/VFX hook in here.
   */
  protected onBulletVsBulletImpact(
    _enemyBullet: TBullet,
    _playerBullet: PlayerBullet,
  ): void {}

  /** Enemy-bullet hit radius for bullet and player collisions (px). */
  protected getEnemyBulletRadius(): number {
    return 5;
  }

  /**
   * Whether the player is phase-shifted (P6) and therefore immune, and
   * whether scene-specific collision stages should be skipped. Default
   * false; the game returns `effectsRegistry.isPhased`.
   */
  protected isPlayerPhased(): boolean {
    return false;
  }

  /**
   * Scene-specific collision stage run between the bullet-vs-bullet and
   * enemy-bullet-vs-player stages (game: mineral collection/absorption).
   * Default no-op.
   */
  protected onAfterBulletVsBullet(): void {}

  /**
   * Scene hook for the player-hit lifecycle. Default (generic gym):
   * run the shared damage VFX + in-place respawn + invulnerability. The
   * game overrides this to route through its shield/lives flow.
   */
  protected onPlayerHit(player: Player): void {
    this.applyPlayerHit(player);
  }

  /**
   * Scene hook for shield-style absorption. Default: no absorption (the
   * hit always lands). The game overrides this to try its P3 shield.
   *
   * @returns whether the hit was fully absorbed.
   */
  protected tryAbsorbPlayerHit(_player: Player): boolean {
    return false;
  }

  /**
   * Scene hook run after a power-up (non-weapon) drop is collected.
   * Default no-op; the game adds the P4 bomb notice and P8 extra life.
   */
  protected onPowerUpCollected(_drop: TDrop): void {}

  /**
   * Scene hook run after a weapon drop is collected. Default no-op; the
   * gym advances the placeholder power-up lifecycle.
   */
  protected onWeaponCollected(_drop: TDrop): void {}

  /**
   * Plays the per-type pickup activation cue. Default (generic gym):
   * generic pop + generic collect chime. The game overrides this with
   * its per-type cues.
   */
  protected _playPickupCue(_drop: TDrop): void {
    try {
      playPowerUpCollectPopSound();
      playPowerUpCollectSound();
    } catch {
      // Audio is best-effort in headless tests.
    }
  }

  // ── Shared combat template methods ───────────────────────────────

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
   * {@link CombatScene.onWeaponFired}.
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
        this.spawnPlayerBullet(bd.x, bd.y, vel.vx, vel.vy, bd.color);
      }
    }
  }

  /**
   * Spawns a player bullet at (x, y) travelling at (vx, vy) px/s.
   * Public so tests can place bullets deterministically.
   */
  spawnPlayerBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0x00ffff,
  ): PlayerBullet {
    const bullet = createPlayerBullet(
      this,
      x,
      y,
      color,
      PLAYER_BULLET_RADIUS,
      vx,
      vy,
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

  /**
   * Handles the S / ↓ key press for a P7 teleport (JustDown semantics).
   */
  protected _handleTeleport(): void {
    const player = this.getPlayer();
    if (!player || !this.teleportKey) return;
    const JustDown = (
      Phaser.Input.Keyboard as unknown as {
        JustDown?: (key: Phaser.Input.Keyboard.Key) => boolean;
      }
    ).JustDown;
    const sDown = JustDown
      ? JustDown(this.teleportKey)
      : this.teleportKey.isDown;
    const downDown = this.downKey
      ? JustDown
        ? JustDown(this.downKey)
        : this.downKey.isDown
      : false;
    if (sDown || downDown) this.triggerTeleport();
  }

  /**
   * Consumes one P7 teleport stack and warps the player to the nearest
   * safe spot along the heading (granting P6 on arrival via the
   * registry). Public so tests can trigger it deterministically.
   *
   * @returns true when a teleport was performed.
   */
  triggerTeleport(): boolean {
    const player = this.getPlayer();
    if (!player || !this.canTeleport()) return false;
    const registry = this.getEffectsRegistry();
    if (!registry.hasTeleport()) return false;

    const heading = player.getHeading();
    const enemies: TeleportBody[] = this.getEnemyEntities()
      .filter((entity) => entity.alive)
      .map((entity) => ({
        x: entity.x,
        y: entity.y,
        radius: entity.getHitRadius(),
      }));
    enemies.push(...this.getAdditionalTeleportBodies());
    const bullets: TeleportBody[] = this.getEnemyBullets().map((bullet) => ({
      x: bullet.graphics.x,
      y: bullet.graphics.y,
    }));

    const dest = findTeleportDestination(
      player.x,
      player.y,
      heading,
      enemies,
      bullets,
      this.scale.width,
      this.scale.height,
      {
        enemyHitRadius: this.getTeleportEnemyHitRadius(),
        bulletHitRadius: this.getTeleportBulletHitRadius(),
      },
    );

    // Consume one stack FIFO and grant P6 phase shift at the landing spot.
    registry.consumeTeleport();
    player.setPosition(dest.x, dest.y);
    // Keep the movement state's position in sync with the new position
    // (physicsTick uses the internal state as its base).
    const state = player.getMovementState();
    (
      player as unknown as {
        _movementState: { x: number; y: number };
      }
    )._movementState = { ...state, x: dest.x, y: dest.y };
    return true;
  }

  /**
   * Player hit: records the hit, then dispatches to the scene hooks.
   * Shield-style absorption is optional via {@link tryAbsorbPlayerHit}.
   */
  protected _hitPlayer(): void {
    const player = this.getPlayer();
    if (!player) return;
    this.playerHitCount += 1;
    if (this.tryAbsorbPlayerHit(player)) return;
    this.onPlayerHit(player);
  }

  /**
   * Shared damage VFX + in-place respawn + invulnerability: destruction
   * sound, explosion burst, scale-pulse tween, respawn, invuln window.
   */
  protected applyPlayerHit(player: Player): void {
    playDestructionSound();
    this._spawnPlayerExplosion(player.x, player.y);
    this.tweens.add({
      targets: player,
      scale: PLAYER_HIT_SCALE_PEAK,
      duration: PLAYER_HIT_SCALE_PULSE_DURATION / 2,
      yoyo: true,
      ease: 'Power2',
    });
    player.respawnInPlace();
    this._startInvulnerability();
  }

  /** Starts the brief post-hit invulnerability blink. */
  protected _startInvulnerability(): void {
    const player = this.getPlayer();
    if (!player) return;
    this.invulnerable = PLAYER_RESPAWN_INVULNERABLE;
    this.blinkPhase = 0;
    player.setAlpha(1);
  }

  /** Counts down invulnerability and blinks the ship's alpha. */
  protected _updateInvulnerability(dt: number): void {
    const player = this.getPlayer();
    if (!player || this.invulnerable <= 0) return;
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.blinkPhase += dt;
    const visible = Math.floor(this.blinkPhase / COMBAT_BLINK_INTERVAL) % 2 === 0;
    player.setAlpha(visible ? 1 : 0.3);
    if (this.invulnerable <= 0) player.setAlpha(1);
  }

  /**
   * Resolves the shared collision passes:
   *
   * 1. player bullets vs enemies (and the boss, via hook)
   * 2. player bullets vs enemy bullets (AC5 impact feedback)
   * 2b. scene-specific stage (`onAfterBulletVsBullet`, e.g. minerals)
   * 3. enemy bullets vs player
   * 4. player body vs enemy body (and the boss, via hook)
   */
  protected _handleCollisions(): void {
    const playerHull = SHIP_SIZE / 2;

    // 1. Player bullets vs enemies (and the boss).
    const keptBullets: PlayerBullet[] = [];
    for (const pb of this.playerBullets) {
      let spent = false;
      for (const enemy of this.getEnemyEntities()) {
        if (!enemy.alive) continue;
        if (
          this._overlaps(
            pb.x,
            pb.y,
            PLAYER_BULLET_RADIUS,
            enemy.x,
            enemy.y,
            enemy.getHitRadius(),
          )
        ) {
          spent = this.onPlayerBulletHitsEnemy(enemy, pb);
          if (spent) break;
        }
      }
      if (!spent) spent = this.onPlayerBulletHitsBoss(pb);
      if (!spent) keptBullets.push(pb);
    }
    this.playerBullets = keptBullets;

    // 2. Player bullets vs enemy bullets — both destroyed (shared AC5 path).
    const bulletRadius = this.getEnemyBulletRadius();
    const keptEnemy: TBullet[] = [];
    for (const eb of this.getEnemyBullets()) {
      let consumed = false;
      for (let i = 0; i < this.playerBullets.length; i++) {
        const pb = this.playerBullets[i];
        if (
          this._overlaps(
            pb.x,
            pb.y,
            PLAYER_BULLET_RADIUS,
            eb.graphics.x,
            eb.graphics.y,
            bulletRadius,
          )
        ) {
          pb.destroy();
          this.playerBullets.splice(i, 1);
          eb.graphics.destroy();
          consumed = true;
          this.onBulletVsBulletImpact(eb, pb);
          break;
        }
      }
      if (!consumed) keptEnemy.push(eb);
    }
    this.setEnemyBullets(keptEnemy);

    this.onAfterBulletVsBullet();

    const player = this.getPlayer();
    if (!player || this.isPlayerPhased()) return;

    // 3. Enemy bullets vs player.
    const keptEnemy2: TBullet[] = [];
    for (const eb of this.getEnemyBullets()) {
      if (
        this.invulnerable <= 0 &&
        this._overlaps(
          eb.graphics.x,
          eb.graphics.y,
          bulletRadius,
          player.x,
          player.y,
          playerHull,
        )
      ) {
        this._hitPlayer();
        eb.graphics.destroy();
      } else {
        keptEnemy2.push(eb);
      }
    }
    this.setEnemyBullets(keptEnemy2);

    // 4. Player body vs enemy body — both are hit.
    if (this.invulnerable <= 0) {
      for (const enemy of this.getEnemyEntities()) {
        if (!enemy.alive) continue;
        if (
          this._overlaps(
            player.x,
            player.y,
            playerHull,
            enemy.x,
            enemy.y,
            enemy.getHitRadius(),
          )
        ) {
          this.onPlayerRamsEnemy(enemy);
          this._hitPlayer();
          break;
        }
      }
      if (this.onPlayerRamsBoss()) {
        this._hitPlayer();
      }
    }
  }

  /** Circle-vs-circle overlap test. */
  protected _overlaps(
    ax: number,
    ay: number,
    ar: number,
    bx: number,
    by: number,
    br: number,
  ): boolean {
    return Math.hypot(ax - bx, ay - by) <= ar + br;
  }
}

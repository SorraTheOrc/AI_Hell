/**
 * Shared combat core (parent AH-0MUD8E015004C4JO).
 *
 * `PlayScene` (the shipped game) and `GymFormationScene` (the gym core)
 * historically each kept their own copy of the scene-level combat and
 * player-lifecycle logic. The copies drifted, so a behaviour fix in one
 * scene did not reach the other. This abstract class extends
 * {@link CombatCoreScene} — the narrower shared base that owns the input
 * path, auto-fire and drop collection — and adds the **combat-only**
 * template methods exactly once:
 *
 * - {@link CombatScene._spawnPlayerExplosion} (inherited from the base)
 * - {@link CombatScene._clearEnemyBullets} (inherited from the base)
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
  PLAYER_HIT_SCALE_PEAK,
  PLAYER_HIT_SCALE_PULSE_DURATION,
  SHIP_SIZE,
} from '../../core/constants';
import {
  playDestructionSound,
  playPowerUpCollectPopSound,
  playPowerUpCollectSound,
} from '../../audio/effects';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { resolveBulletVsBulletImpact } from '../../vfx/bulletImpact';
import { spawnPlayerDeathJuice } from '../../vfx/playerDeathJuice';
import { EffectsRegistry } from '../../powerups/effects';
import {
  findTeleportDestination,
  type TeleportBody,
} from '../../powerups/teleport';
import {
  CombatCoreScene,
  type CombatDrop,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatCoreScene';

// Re-export the shared contracts so existing `from './CombatScene'`
// imports keep working after they moved to the narrower base.
export type { CombatDrop, CombatEnemyBullet, CombatEnemyEntity };

/** Blink half-period (s) while the player is invulnerable after a hit. */
export const COMBAT_BLINK_INTERVAL = 0.1;

/**
 * Abstract shared combat scene. Parameterised by the enemy, bullet and
 * drop types so concrete subclasses keep fully-typed accessors.
 */
export abstract class CombatScene<
  TEnemy extends CombatEnemyEntity = CombatEnemyEntity,
  TBullet extends CombatEnemyBullet = CombatEnemyBullet,
  TDrop extends CombatDrop = CombatDrop,
> extends CombatCoreScene<TEnemy, TBullet, TDrop> {
  /** Live bullet-impact flash graphics (AC5, tracked for observation). */
  protected bulletImpactEffects: Phaser.GameObjects.Graphics[] = [];

  /** Seconds of post-hit invulnerability remaining (blinks while > 0). */
  protected invulnerable = 0;
  protected blinkPhase = 0;
  /** Cumulative player-hit counter (exposed by both scenes). */
  protected playerHitCount = 0;

  /** P7 teleport activation keys: S / ↓ (JustDown semantics). */
  protected teleportKey: Phaser.Input.Keyboard.Key | null = null;
  protected downKey: Phaser.Input.Keyboard.Key | null = null;

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

  // ── Shared effect gating (P3 shield / P6 phase) ─────────────────

  /**
   * Whether the player is P6 phase-shifted and therefore immune to enemy
   * bullets and enemy body contact. Backed by the shared effects registry,
   * so every `CombatScene` subclass (including `GymFormationScene` and its
   * `GymEnemies`/`GymBoss`/`GymMinerals` subclasses) inherits the same
   * gating exactly once and cannot diverge.
   */
  protected override isPlayerPhased(): boolean {
    return this.getEffectsRegistry().isPhased;
  }

  /**
   * P3 shield absorbs one hit: consume exactly one shield, run the
   * scene-specific absorb cue ({@link CombatScene.onShieldAbsorbed}), start
   * the shared post-hit invulnerability window and report the hit as
   * absorbed. The shield is not re-applied, so the following hit lands
   * normally.
   */
  protected override tryAbsorbPlayerHit(_player: Player): boolean {
    if (!this.getEffectsRegistry().tryAbsorbShield()) return false;
    this.onShieldAbsorbed();
    this._startInvulnerability();
    return true;
  }

  /**
   * Scene hook for the P3 shield-absorb cue. Default no-op — the generic
   * gym is silent; `PlayScene` plays its destruction sound here.
   */
  protected onShieldAbsorbed(): void {}

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
   * interception for both scenes; the default implementation plays the
   * dedicated cue and spawns the small impact flash at the enemy bullet's
   * position. Scenes may override, but should delegate to
   * {@link resolveBulletVsBulletImpact} to stay on the shared path.
   */
  protected onBulletVsBulletImpact(
    enemyBullet: TBullet,
    _playerBullet: PlayerBullet,
  ): void {
    resolveBulletVsBulletImpact(
      this,
      enemyBullet.graphics.x,
      enemyBullet.graphics.y,
      { registry: this.bulletImpactEffects },
    );
  }

  /** Enemy-bullet hit radius for bullet and player collisions (px). */
  protected getEnemyBulletRadius(): number {
    return 5;
  }

  /**
   * Scene-specific collision stage run between the bullet-vs-bullet and
   * enemy-bullet-vs-player stages (game: mineral collection/absorption).
   * Default no-op.
   */
  protected onAfterBulletVsBullet(): void {}

  /**
   * Scene hook for the player-hit lifecycle. Default (generic gym):
   * records the hit, then runs the shared damage VFX + in-place respawn +
   * invulnerability. The game overrides this to route through its
   * shield/lives flow.
   */
  protected onPlayerHit(player: Player): void {
    this.playerHitCount += 1;
    this.applyPlayerHit(player);
  }

  /**
   * Plays the per-type pickup activation cue. Default (generic gym):
   * generic pop + generic collect chime. The game overrides this with
   * its per-type cues.
   */
  protected override _playPickupCue(_drop: TDrop): void {
    try {
      playPowerUpCollectPopSound();
      playPowerUpCollectSound();
    } catch {
      // Audio is best-effort in headless tests.
    }
  }

  // ── Teleport ─────────────────────────────────────────────────────

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

  // ── Hit lifecycle ────────────────────────────────────────────────

  /**
   * Player hit: dispatches to the scene hooks. Shield-style absorption
   * is optional via {@link CombatCoreScene.tryAbsorbPlayerHit}; the hit
   * counter is owned by the scene's hit lifecycle (so an absorbed hit
   * need not count).
   */
  protected _hitPlayer(): void {
    const player = this.getPlayer();
    if (!player) return;
    if (this.tryAbsorbPlayerHit(player)) return;
    this.onPlayerHit(player);
  }

  /**
   * Shared damage VFX + in-place respawn + invulnerability: the composed
   * player-death juice (dedicated cue + shake + particles + flash + debris +
   * shockwave), scale-pulse tween, respawn, invuln window.
   *
   * The juice helper owns the particle burst, so this path must NOT also call
   * `_spawnPlayerExplosion()` (that would double-spawn).
   */
  protected applyPlayerHit(player: Player): void {
    spawnPlayerDeathJuice(this, player.x, player.y, 'respawn', {
      registry: this.playerDeathEffects,
    });
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
    this.invulnerable = this.getInvulnerabilityDuration();
    this.blinkPhase = 0;
    player.setAlpha(1);
  }

  /** Counts down invulnerability and blinks the ship's alpha. */
  protected _updateInvulnerability(dt: number): void {
    const player = this.getPlayer();
    if (!player || this.invulnerable <= 0) return;
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.blinkPhase += dt;
    const visible =
      Math.floor(this.blinkPhase / COMBAT_BLINK_INTERVAL) % 2 === 0;
    player.setAlpha(visible ? 1 : 0.3);
    if (this.invulnerable <= 0) player.setAlpha(1);
  }

  // ── Collisions ───────────────────────────────────────────────────

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
          // Impact feedback fires from the shared path before the bullets
          // are destroyed (so the impact point is still readable).
          this.onBulletVsBulletImpact(eb, pb);
          pb.destroy();
          this.playerBullets.splice(i, 1);
          eb.graphics.destroy();
          consumed = true;
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

  // ── Run lifecycle (restart / teardown parity, gap 10) ─────────────

  /**
   * Resets the shared core state plus the combat-only per-run state
   * (invulnerability blink, hit counter, teleport keys and bullet-impact
   * VFX) so a stop/restart starts clean (AH-0MUII3FYN0072QRT, gap 10).
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.bulletImpactEffects = [];
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.playerHitCount = 0;
    this.teleportKey = null;
    this.downKey = null;
  }

  /**
   * Destroys and clears the combat-only per-run objects on `SHUTDOWN`
   * after the shared core teardown has run (AC2).
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    for (const effect of this.bulletImpactEffects) effect.destroy();
    this.bulletImpactEffects = [];
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.playerHitCount = 0;
    this.teleportKey = null;
    this.downKey = null;
  }
}

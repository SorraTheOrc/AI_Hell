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
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_BULLET_RADIUS,
  PLAYER_HIT_SCALE_PEAK,
  PLAYER_HIT_SCALE_PULSE_DURATION,
  SHIP_SIZE,
} from '../../core/constants';
import { playDestructionSound, playMortarDetonationSound, playPhaseShiftSound } from '../../audio/effects';
import { Boss } from '../../entities/Boss';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { resolveBulletVsBulletImpact, spawnBulletImpact } from '../../vfx/bulletImpact';
import { spawnMortarBurst, spawnNovaRing, spawnArcChain, type ArcChainPoint } from '../../vfx/aoeEffect';
import { isPointNearSegment, selectAoETargets, selectChainTargets } from '../../utils/aoe';
import type { WeaponDefinition, WeaponId } from '../../utils/weapons';
import { spawnPlayerDeathJuice } from '../../vfx/playerDeathJuice';
import { EffectsRegistry } from '../../powerups/effects';
import { isInDanger } from '../../powerups/dangerDetection';
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
import {
  detonateWaveTimeoutSurvivors,
  WAVE_TIME_LIMIT_SECONDS,
  WAVE_TIMER_BAR_HEIGHT,
  WAVE_TIMER_BAR_WIDTH,
  WAVE_TIMER_BAR_X,
  WAVE_TIMER_BAR_Y,
} from './waveTimeout';
import { Asteroid } from '../../entities/Asteroid';

// Re-export the shared contracts so existing `from './CombatScene'`
// imports keep working after they moved to the narrower base.
export type { CombatDrop, CombatEnemyBullet, CombatEnemyEntity };

/** Blink half-period (s) while the player is invulnerable after a hit. */
export const COMBAT_BLINK_INTERVAL = 0.1;

/**
 * Half-width (px) of the Arc chain bolt used to clear enemy bullets lying on
 * the bolt path between chained targets (parent AH-0MUOOB3OR001V8CD).
 */
export const ARC_CHAIN_HALF_WIDTH = 14;

/** Wipe → respawn countdown (s) — visible centred text, deterministic via tick(dt). */
const RESPAWN_COUNTDOWN_SECONDS = 3;

/** Style for the centred respawn countdown overlay. */
const COUNTDOWN_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '24px',
  color: '#ffffff',
  backgroundColor: '#000000',
  padding: { x: 12, y: 8 },
};

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

  /**
   * Live AOE effect graphics (nova ring; mortar burst / arc chain in F3/F4),
   * tracked for observation and teardown on scene shutdown
   * (parent AH-0MUOOB3OR001V8CD).
   */
  protected aoeEffects: Phaser.GameObjects.Graphics[] = [];

  /**
   * Live wormhole spawn containers, tracked for observation and teardown
   * on scene shutdown (AH-0MURBER4L00821RR).
   */
  protected wormholeEffects: Phaser.GameObjects.Container[] = [];

  /** Seconds of post-hit invulnerability remaining (blinks while > 0). */
  protected invulnerable = 0;
  protected blinkPhase = 0;
  /** Cumulative player-hit counter (exposed by both scenes). */
  protected playerHitCount = 0;

  // ── Shared opt-in wave-timeout + wipe→respawn lifecycle ──────────
  // (AH-0MUNR5LM1004B223) The wave-timeout and the wipe→3 s countdown→
  // respawn lifecycle live here so every combat scene (the formation gyms
  // and the combat power-up gym) runs the *same code* — a single kind of
  // scene — instead of each scene re-implementing them.

  /** Seconds remaining on the shared wave-timeout (0 when inactive). */
  protected waveTimeoutTimer = 0;
  /** Whether the shared wave-timeout is counting down. */
  protected waveTimeoutActive = false;
  /** Configured duration of the active timeout (seconds). */
  protected waveTimeoutDuration = 0;
  /** The shared wave-timeout bar graphic (created lazily when enabled). */
  protected waveTimeoutBar: Phaser.GameObjects.Graphics | null = null;

  /** Seconds remaining on the wipe→respawn countdown. */
  protected respawnCountdown = 0;
  /** Whether the wipe→respawn countdown is active. */
  protected respawnCountdownActive = false;
  /** Centred countdown overlay (created lazily; hidden when idle). */
  protected countdownText: Phaser.GameObjects.Text | null = null;

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

  // ── Automatic Phase Shift (P6) danger feed ──────────────────────

  /**
   * Shared per-frame danger feed for the automatic Phase Shift (parent
   * AH-0MUIYX1EE008FVS8, Q1/Q2/Q3).
   *
   * Counts the live hostile bodies and enemy bullets whose centre lies
   * within `DANGER_RADIUS` of the ship (via the pure `isInDanger` helper)
   * and hands the result to the effects registry, which auto-activates
   * Phase Shift when a charge is available and the re-arm conditions are
   * met. Every combat scene calls this once per frame immediately before
   * `_handleCollisions`, so the game and the gyms share one implementation
   * and one ordering and cannot diverge.
   *
   * @param dt — frame delta (seconds); advances the P6 re-arm cooldown.
   */
  protected _updatePhaseShiftAutoTrigger(dt: number): void {
    const registry = this.getEffectsRegistry();
    const player = this.getPlayer();
    if (!player) {
      // No ship: no danger, but keep the re-arm state advancing.
      registry.updateDanger(false, dt);
      return;
    }
    const bodies = this.getEnemyEntities()
      .filter((enemy) => enemy.alive)
      .map((enemy) => ({ x: enemy.x, y: enemy.y }));
    const bullets = this.getEnemyBullets().map((bullet) => ({
      x: bullet.graphics.x,
      y: bullet.graphics.y,
    }));
    const fired = registry.updateDanger(isInDanger(player, bodies, bullets), dt);
    // Dedicated activation cue on every auto-trigger (parent AH-0MUIYX1EE008FVS8).
    if (fired) playPhaseShiftSound();
  }

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

  /**
   * The scene's boss, or null (game: spawned after Level 5; `GymBoss`: its
   * single formation entity). The shared boss hooks below use this accessor
   * so boss advancement and teleport avoidance are defined once for both
   * scenes (AH-0MUII3E5E006A93F, gap 6).
   */
  protected getBoss(): Boss | null {
    return null;
  }

  /**
   * Extra teleport-avoidance bodies (the boss when present). The default
   * derives the boss body from {@link CombatScene.getBoss}, so a P7
   * teleport avoids the boss identically in the game and in `GymBoss`
   * (AH-0MUII3E5E006A93F, AC2).
   */
  protected getAdditionalTeleportBodies(): TeleportBody[] {
    const boss = this.getBoss();
    if (!boss?.alive) return [];
    return [{ x: boss.x, y: boss.y, radius: boss.getHitRadius() }];
  }

  /**
   * Advances the boss state machine as part of the shared tick: attack
   * telegraphing, bullet collection, and pulse-wave expansion. Called from
   * both `PlayScene.tick` and `GymFormationScene.tick`, so a single
   * `tick(dt)` advances the boss with the same ordering relative to
   * collisions in the game and in `GymBoss` (AH-0MUII3E5E006A93F, AC1).
   *
   * Boss bullets are appended to the scene's enemy-bullet list; pulse waves
   * are managed by the Boss itself. A scene with no boss is a no-op.
   */
  protected _advanceBoss(dt: number): void {
    const boss = this.getBoss();
    if (!boss?.alive) return;
    const player = this.getPlayer();
    if (player) boss.setAimTarget(player.x, player.y);

    const bullets = boss.update(
      this.time.now,
      dt * 1000,
      GAME_WIDTH,
      GAME_HEIGHT,
    );
    const live = this.getEnemyBullets().slice();
    for (const bullet of bullets) {
      if (!('isPulseWave' in bullet && bullet.isPulseWave)) {
        live.push(bullet as unknown as TBullet);
      }
    }
    this.setEnemyBullets(live);
    boss.advancePulseWave(dt, GAME_WIDTH, GAME_HEIGHT);

    // Scene hook for boss-adjacent work (e.g. `GymBoss` minions).
    this.onBossAdvanced(dt);
  }

  /**
   * Hook run after the shared boss advance. Default no-op; `GymBoss`
   * advances its phase minions here so they stay on the shared tick path.
   */
  protected onBossAdvanced(_dt: number): void {}

  /**
   * Player bullet hits an enemy. Default (generic gym) behaviour:
   * multi-hit entities receive `takeDamage()`; single-hit entities are
   * destroyed with their destruction audio and `onEnemyDestroyed`.
   *
   * A non-lethal multi-hit hit consumes the bullet and spawns the shared
   * bullet-impact flash at the hit point, so a durable enemy (whose body does
   * not explode) still gives immediate "that hit registered" feedback. The
   * same shared path runs in the game and the gyms, so the feedback cannot
   * diverge (parent AH-0MUI820PM0038HS2 — producer review).
   *
   * @returns whether the bullet was consumed (stops the scan).
   */
  protected onPlayerBulletHitsEnemy(
    enemy: TEnemy,
    bullet: PlayerBullet,
  ): boolean {
    // Spawning enemies are invulnerable — player bullets pass through.
    if ((enemy as unknown as { isSpawning?: boolean }).isSpawning) {
      return false;
    }
    // An `'onImpact'` AOE projectile detonates instead of dealing a direct
    // hit: the blast resolves the damage for this and every other enemy in the
    // radius, so the directly-hit enemy is not double-damaged.
    if (bullet.aoeWeapon) {
      this.detonateAoeProjectile(bullet);
      bullet.destroy();
      return true;
    }
    if (enemy.takeDamage) {
      enemy.takeDamage();
      // Multi-hit entity: finalise the kill exactly once on the lethal blow
      // (the entity's `takeDamage()` has already run `destroySelf()` and
      // cleared `alive`). A non-lethal hit consumes the bullet but flashes at
      // the impact point so the player can read that the hit registered.
      if (!enemy.alive) {
        this.finaliseEnemyKill(enemy);
      } else {
        spawnBulletImpact(this, bullet.x, bullet.y, {
          registry: this.bulletImpactEffects,
        });
      }
    } else {
      enemy.destroySelf();
      this.finaliseEnemyKill(enemy);
    }
    bullet.destroy();
    return true;
  }

  /**
   * Play the destruction audio and notify `onEnemyDestroyed` for a killed
   * enemy — the shared single-finalisation seam used by the bullet and ram
   * paths, so destruction audio and score/drop/wave accounting happen exactly
   * once per kill.
   */
  private finaliseEnemyKill(enemy: TEnemy): void {
    if (enemy.playDestructionAudio) {
      enemy.playDestructionAudio();
    } else {
      playDestructionSound();
    }
    this.onEnemyDestroyed(enemy);
  }

  /**
   * Shared AOE effect application (parent AH-0MUOOB3OR001V8CD). Resolves one
   * area effect at (x, y) from the weapon's descriptor:
   *
   * 1. damages every live enemy inside the radius through the same
   *    `takeDamage()` / `destroySelf()` + `finaliseEnemyKill` seam a player
   *    bullet uses (so destruction audio and score/drop/wave accounting run
   *    exactly once per kill),
   * 2. destroys every enemy bullet inside the radius with the shared impact
   *    feedback,
   * 3. damages the boss through the overridable {@link CombatScene.onAoeHitsBoss}
   *    hook (the `onPlayerBulletHitsBoss`-style path).
   *
   * An `'onFire'` effect calls this at the ship from
   * {@link CombatScene.onAoeFired}; an `'onImpact'` projectile calls it at the
   * detonation point.
   */
  protected applyAoeEffect(def: WeaponDefinition, x: number, y: number): void {
    const aoe = def.aoe;
    if (!aoe) return;

    if (aoe.damagesEnemies) {
      // Pure target selection (utils/aoe) keeps the game and gyms identical.
      const targets = selectAoETargets(
        x,
        y,
        aoe.radius,
        this.getEnemyEntities(),
      );
      for (const enemy of targets) this.damageEnemyViaAoe(enemy);
    }

    if (aoe.clearsEnemyBullets) {
      const kept: TBullet[] = [];
      const bulletRadius = this.getEnemyBulletRadius();
      for (const bullet of this.getEnemyBullets()) {
        const { x: bx, y: by } = bullet.graphics;
        if (this._overlaps(x, y, aoe.radius, bx, by, bulletRadius)) {
          // Shared interception feedback (cue + flash), then destroy.
          resolveBulletVsBulletImpact(this, bx, by, {
            registry: this.bulletImpactEffects,
          });
          bullet.graphics.destroy();
        } else {
          kept.push(bullet);
        }
      }
      this.setEnemyBullets(kept);
    }

    this.onAoeHitsBoss(x, y, aoe.radius);
  }

  /**
   * Applies one AOE damage instance to an enemy through the shared kill
   * seam: multi-hit entities take `takeDamage()` (and finalise on the lethal
   * blow); single-hit entities are destroyed and finalised outright.
   */
  private damageEnemyViaAoe(enemy: TEnemy): void {
    if (!enemy.alive) return;
    if (enemy.takeDamage) {
      enemy.takeDamage();
      if (!enemy.alive) this.finaliseEnemyKill(enemy);
    } else {
      enemy.destroySelf();
      this.finaliseEnemyKill(enemy);
    }
  }

  /**
   * AOE effect hits the boss. Default returns false (the generic core owns no
   * boss); the game overrides it to damage its multi-phase boss through the
   * same path a player bullet would use. Returning true means the boss was
   * hit.
   */
  protected onAoeHitsBoss(_x: number, _y: number, _radius: number): boolean {
    return false;
  }

  /**
   * Shared AOE dispatch from `_autoFire`: resolves an `'onFire'` effect at
   * the ship immediately and spawns its distinctive VFX. An `'onImpact'`
   * effect (mortar shell) resolves later, when its projectile detonates and
   * calls {@link CombatScene.applyAoeEffect}.
   */
  protected override onAoeFired(
    _weaponId: WeaponId,
    def: WeaponDefinition,
    x: number,
    y: number,
  ): void {
    const aoe = def.aoe;
    if (aoe?.trigger !== 'onFire') return;
    if (aoe.chains) {
      // Arc: strike the nearest enemy, then chain to nearby targets. The
      // chain is computed once (before any damage) so the damage, the
      // along-path bullet clear and the VFX all describe the same strikes.
      const chain = selectChainTargets(
        x,
        y,
        this.getEnemyEntities(),
        // The descriptor counts *additional* targets after the primary.
        aoe.chains + 1,
        aoe.radius,
      );
      const path: ArcChainPoint[] = [
        { x, y },
        ...chain.map((enemy) => ({ x: enemy.x, y: enemy.y })),
      ];
      this.applyArcChainEffect(aoe, x, y, chain, path);
      this.spawnArcChainVfx(path);
      return;
    }
    this.applyAoeEffect(def, x, y);
    this.spawnAoeEffectVfx(def, x, y);
  }

  /**
   * Resolves a chaining (`'chains'`) `'onFire'` effect: damages the selected
   * chain targets, clears enemy bullets along the bolt path, and reports the
   * hit to the boss hook.
   *
   * @param aoe - The weapon's AOE descriptor.
   * @param x - Effect origin x (the ship).
   * @param y - Effect origin y.
   * @param chain - The selected targets, in hop order.
   * @param path - The chain vertices (origin → target → …).
   */
  private applyArcChainEffect(
    aoe: NonNullable<WeaponDefinition['aoe']>,
    x: number,
    y: number,
    chain: readonly TEnemy[],
    path: readonly ArcChainPoint[],
  ): void {
    if (aoe.damagesEnemies) {
      for (const enemy of chain) this.damageEnemyViaAoe(enemy);
    }
    if (aoe.clearsEnemyBullets) this.clearEnemyBulletsAlongPath(path);
    this.onAoeHitsBoss(x, y, aoe.radius);
  }

  /**
   * Destroys every enemy bullet within {@link ARC_CHAIN_HALF_WIDTH} px of any
   * Arc bolt segment, playing the shared impact feedback for each.
   */
  private clearEnemyBulletsAlongPath(path: readonly ArcChainPoint[]): void {
    if (path.length < 2) return;
    const kept: TBullet[] = [];
    for (const bullet of this.getEnemyBullets()) {
      const { x: bx, y: by } = bullet.graphics;
      let onPath = false;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        if (
          isPointNearSegment(
            bx,
            by,
            a.x,
            a.y,
            b.x,
            b.y,
            ARC_CHAIN_HALF_WIDTH,
          )
        ) {
          onPath = true;
          break;
        }
      }
      if (onPath) {
        resolveBulletVsBulletImpact(this, bx, by, {
          registry: this.bulletImpactEffects,
        });
        bullet.graphics.destroy();
      } else {
        kept.push(bullet);
      }
    }
    this.setEnemyBullets(kept);
  }

  /**
   * Spawns the Arc chaining-bolt VFX for the computed chain path. The shared
   * core owns it so the game and every gym draw the identical zigzag bolts.
   */
  protected spawnArcChainVfx(path: readonly ArcChainPoint[]): void {
    if (path.length < 2) return;
    spawnArcChain(this, path, { registry: this.aoeEffects });
  }

  /**
   * Spawns the distinctive neon-vector VFX for a firing AOE weapon. Owned by
   * the shared core so the game and every gym render the identical effect
   * (parent AH-0MUOOB3OR001V8CD AC5). Nova's expanding ring is the F2
   * implementation; F3/F4 extend this with the Mortar detonation burst and
   * the Arc chain bolts.
   */
  protected spawnAoeEffectVfx(
    def: WeaponDefinition,
    x: number,
    y: number,
  ): void {
    if (def.id === 'nova' && def.aoe) {
      spawnNovaRing(this, x, y, def.aoe.radius, { registry: this.aoeEffects });
    }
  }

  /**
   * Shared hook for an `'onImpact'` AOE projectile: attaches the expiry
   * detonation so the blast resolves at the projectile's position whether it
   * hits an enemy/enemy bullet or reaches the end of its lifetime.
   */
  protected override onAoeProjectileSpawned(
    bullet: PlayerBullet,
    _def: WeaponDefinition,
  ): void {
    bullet.onExpire = () => this.detonateAoeProjectile(bullet);
  }

  /**
   * Detonates an `'onImpact'` AOE projectile at its current position: applies
   * the descriptor's area effect, then spawns the shared detonation VFX/cue.
   * Idempotent per projectile — a projectile detonates at most once even if
   * both the collision and expiry paths observe it.
   */
  protected detonateAoeProjectile(bullet: PlayerBullet): void {
    const def = bullet.aoeWeapon;
    if (!def?.aoe || bullet.aoeDetonated) return;
    bullet.aoeDetonated = true;
    this.applyAoeEffect(def, bullet.x, bullet.y);
    this.spawnAoeDetonationVfx(def, bullet.x, bullet.y);
  }

  /**
   * Spawns the distinctive detonation VFX/cue for an `'onImpact'` AOE weapon.
   * Mortar's radial burst is the F3 implementation; the shared core owns it so
   * the game and every gym detonate identically.
   */
  protected spawnAoeDetonationVfx(
    def: WeaponDefinition,
    x: number,
    y: number,
  ): void {
    if (def.id === 'mortar' && def.aoe) {
      spawnMortarBurst(this, x, y, def.aoe.radius, {
        registry: this.aoeEffects,
      });
      playMortarDetonationSound();
    }
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
    this.finaliseEnemyKill(enemy);
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
    const phaseActivated = registry.consumeTeleport();
    // Direct activation also plays the dedicated cue (Q6).
    if (phaseActivated) playPhaseShiftSound();
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
          // An AOE projectile detonates at the interception point.
          if (pb.aoeWeapon) this.detonateAoeProjectile(pb);
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
        // Spawning enemies are still growing — no body collision.
        if ((enemy as unknown as { isSpawning?: boolean }).isSpawning) continue;
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

  // ── Shared opt-in wave-timeout (AH-0MUNR5LM1004B223) ────────────

  /**
   * Whether this scene opts into the shared wave-timeout. Default off;
   * subclasses arm it from their own config/state. When a scene opts in,
   * the timeout keeps survivors and runs {@link onWaveTimeoutExpired}
   * (carry-over semantics — AH-0MUNS3ZQ1002DJ9S).
   */
  protected isWaveTimeoutEnabled(): boolean {
    return false;
  }

  /** Duration (seconds) the shared wave-timeout counts down from. */
  protected getWaveTimeoutDuration(): number {
    return this.isWaveTimeoutEnabled() ? WAVE_TIME_LIMIT_SECONDS : 0;
  }

  /** Live entities eligible for carry-over on timeout (survivors). */
  protected getWaveTimeoutSurvivors(): readonly TEnemy[] {
    return this.getEnemyEntities().filter((enemy) => enemy.alive);
  }

  /**
   * Entities excluded from carry-over wave accounting. Default: asteroids
   * persist independently and never gate wave completion
   * (AH-0MUJM746P000QAEO). Retained for the shared detonation helper's
   * signature; the helper is now a no-op (AH-0MUNS3ZQ1002DJ9S).
   */
  protected isWaveTimeoutExempt(entity: TEnemy): boolean {
    return entity instanceof Asteroid;
  }

  /** Whether the countdown is paused (e.g. mid wipe→respawn countdown). */
  protected isWaveTimeoutPaused(): boolean {
    return false;
  }

  /**
   * Starts (or disables) the shared wave-timeout for the current wave from
   * {@link getWaveTimeoutDuration}. A missing/zero/negative duration leaves
   * the timeout inactive (subclasses that opt out / the boss).
   */
  protected startWaveTimeout(): void {
    const duration = this.getWaveTimeoutDuration();
    if (!Number.isFinite(duration) || duration <= 0) {
      this.hideWaveTimeout();
      return;
    }
    this.waveTimeoutDuration = duration;
    this.waveTimeoutTimer = duration;
    this.waveTimeoutActive = true;
  }

  /** Stops the shared wave-timeout and hides its bar. */
  protected hideWaveTimeout(): void {
    this.waveTimeoutActive = false;
    this.waveTimeoutTimer = 0;
  }

  /**
   * Counts the shared wave-timeout down and fires the penalty on expiry.
   * Scenes call this once per frame from their own `tick`.
   */
  protected _advanceWaveTimeout(dt: number): void {
    if (!this.waveTimeoutActive) return;
    if (this.isWaveTimeoutPaused()) return;
    this.waveTimeoutTimer = Math.max(0, this.waveTimeoutTimer - dt);
    if (this.waveTimeoutTimer <= 0) this._onWaveTimeout();
  }

  /**
   * Shared wave-timeout expiry (carry-over semantics, AH-0MUNS3ZQ1002DJ9S):
   * survivors are **kept** — the shared {@link detonateWaveTimeoutSurvivors}
   * helper is a no-op — and the subclass lifecycle hook runs to refresh the
   * wave (the formation gyms start the wipe→respawn countdown, spawning a
   * fresh formation alongside the survivors).
   */
  protected _onWaveTimeout(): void {
    this.hideWaveTimeout();
    detonateWaveTimeoutSurvivors(
      this.getWaveTimeoutSurvivors(),
      (entity) => this.isWaveTimeoutExempt(entity),
    );
    this.onWaveTimeoutExpired();
  }

  /**
   * Subclass lifecycle hook run after the timeout. Default no-op; the
   * formation gyms start the wipe→respawn countdown here, preserving the
   * survivors and spawning a fresh formation alongside them.
   */
  protected onWaveTimeoutExpired(): void {}

  /**
   * Redraws the shared wave-timeout bar (hidden when inactive). Mirrors
   * `PlayScene._drawWaveTimer` and shares its geometry constants so the
   * bars cannot drift.
   */
  protected _drawWaveTimeoutBar(): void {
    const duration = this.getWaveTimeoutDuration();
    // Opt-out scenes never allocate the bar.
    if (duration <= 0) return;
    if (!this.waveTimeoutBar) {
      this.waveTimeoutBar = this.add.graphics();
      this.waveTimeoutBar.setDepth(400);
    }
    const g = this.waveTimeoutBar;
    g.clear();
    if (!this.waveTimeoutActive) {
      g.setVisible(false);
      return;
    }
    g.setVisible(true);
    // Background track.
    g.fillStyle(0x111111, 0.85);
    g.fillRect(
      WAVE_TIMER_BAR_X,
      WAVE_TIMER_BAR_Y,
      WAVE_TIMER_BAR_WIDTH,
      WAVE_TIMER_BAR_HEIGHT,
    );
    // Depleting fill.
    const ratio = Math.max(
      0,
      Math.min(1, this.waveTimeoutTimer / Math.max(duration, Number.EPSILON)),
    );
    g.fillStyle(0x00ffff, 1);
    g.fillRect(
      WAVE_TIMER_BAR_X,
      WAVE_TIMER_BAR_Y,
      WAVE_TIMER_BAR_WIDTH * ratio,
      WAVE_TIMER_BAR_HEIGHT,
    );
  }

  /** Whether the wave-timeout is currently counting down (test seam). */
  isWaveTimeoutActive(): boolean {
    return this.waveTimeoutActive;
  }

  /** Seconds remaining on the wave-timeout (0 when inactive; test seam). */
  getWaveTimeoutRemaining(): number {
    return this.waveTimeoutActive ? Math.max(0, this.waveTimeoutTimer) : 0;
  }

  /**
   * Sets the remaining wave-timeout seconds and makes it active (test seam,
   * mirrors `PlayScene.setWaveTimerRemaining`). Ignored when the scene has no
   * timeout configured so a test cannot arm a disabled scene.
   */
  setWaveTimeoutRemaining(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    if (this.getWaveTimeoutDuration() <= 0) return;
    this.waveTimeoutTimer = Math.max(0, seconds);
    this.waveTimeoutActive = true;
  }

  /** The wave-timeout bar graphic (null before create/teardown; test seam). */
  getWaveTimeoutBar(): Phaser.GameObjects.Graphics | null {
    return this.waveTimeoutBar;
  }

  // ── Shared wipe → 3 s countdown → respawn lifecycle ──────────────

  /** Whether the scene has a live formation to wipe and respawn. */
  protected hasRespawnableFormation(): boolean {
    return this.getEnemyEntities().length > 0;
  }

  /** Whether the current formation has been fully wiped. */
  protected isFormationWiped(): boolean {
    const entities = this.getEnemyEntities();
    return entities.length > 0 && entities.every((entity) => !entity.alive);
  }

  /**
   * Rebuilds/refreshes the wave after the countdown elapses. Subclass hook;
   * the default is a no-op.
   */
  protected respawnWave(): void {}

  /** Starts the wipe→respawn countdown with the visible centred overlay. */
  protected _startRespawnCountdown(): void {
    this.respawnCountdownActive = true;
    this.respawnCountdown = RESPAWN_COUNTDOWN_SECONDS;
    if (!this.countdownText) {
      this.countdownText = this.add
        .text(
          GAME_WIDTH / 2,
          GAME_HEIGHT / 2,
          this._countdownLabel(),
          COUNTDOWN_STYLE,
        )
        .setOrigin(0.5)
        .setDepth(100);
    } else {
      this.countdownText.setVisible(true);
    }
    this.countdownText.setText(this._countdownLabel());
  }

  private _countdownLabel(): string {
    const n = Math.max(1, Math.ceil(this.respawnCountdown));
    return `Respawning in ${n}...`;
  }

  /** Cancels the countdown and hides the overlay. */
  protected _cancelRespawnCountdown(): void {
    this.respawnCountdownActive = false;
    this.respawnCountdown = 0;
    if (this.countdownText) {
      this.countdownText.setVisible(false);
    }
  }

  /**
   * Advances the wipe→respawn countdown, or starts it when the formation is
   * wiped. Scenes call this once per frame from their own `tick`.
   */
  protected _tickRespawnCountdown(dt: number): void {
    // No formation → nothing to wipe.
    if (!this.hasRespawnableFormation()) return;

    if (this.respawnCountdownActive) {
      this.respawnCountdown = Math.max(0, this.respawnCountdown - dt);
      if (this.countdownText) {
        this.countdownText.setText(
          this.respawnCountdown <= 0 ? 'Respawning...' : this._countdownLabel(),
        );
      }
      if (this.respawnCountdown <= 0) {
        // The countdown has elapsed: cancel/hide it, then refresh the wave.
        this._cancelRespawnCountdown();
        this.respawnWave();
      }
      return;
    }

    // Wipe signal: every entity is no longer alive (mid-explosion counts
    // as killed, per `alive === false` after `destroySelf()`).
    if (this.isFormationWiped()) {
      this._startRespawnCountdown();
    }
  }

  /** True while the wipe → respawn countdown is active. */
  isRespawnCountdownActive(): boolean {
    return this.respawnCountdownActive;
  }

  /** Seconds remaining on the wipe → respawn countdown (0 when idle). */
  getRespawnCountdownRemaining(): number {
    return this.respawnCountdownActive ? Math.max(0, this.respawnCountdown) : 0;
  }

  /** The centred countdown overlay (null before create/teardown). */
  getRespawnCountdownText(): Phaser.GameObjects.Text | null {
    return this.countdownText;
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
    this.aoeEffects = [];
    this.wormholeEffects = [];
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.playerHitCount = 0;
    this.teleportKey = null;
    this.downKey = null;
    this.waveTimeoutTimer = 0;
    this.waveTimeoutActive = false;
    this.waveTimeoutDuration = 0;
    this.waveTimeoutBar = null;
    this.respawnCountdown = 0;
    this.respawnCountdownActive = false;
    this.countdownText = null;
  }

  /**
   * Destroys and clears the combat-only per-run objects on `SHUTDOWN`
   * after the shared core teardown has run (AC2).
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    for (const effect of this.bulletImpactEffects) effect.destroy();
    this.bulletImpactEffects = [];
    for (const effect of this.aoeEffects) effect.destroy();
    this.aoeEffects = [];
    for (const effect of this.wormholeEffects) effect.destroy();
    this.wormholeEffects = [];
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.playerHitCount = 0;
    this.teleportKey = null;
    this.downKey = null;
    this.waveTimeoutBar?.destroy();
    this.waveTimeoutBar = null;
    this.waveTimeoutActive = false;
    this.waveTimeoutTimer = 0;
    this.countdownText?.destroy();
    this.countdownText = null;
    this.respawnCountdownActive = false;
    this.respawnCountdown = 0;
  }
}

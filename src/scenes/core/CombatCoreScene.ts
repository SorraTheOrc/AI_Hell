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
 * - the shared player-control step
 *   ({@link CombatCoreScene._tickPlayer}: weapon timers → live P5
 *   multipliers → input → physics → auto-fire),
 * - the input path ({@link CombatCoreScene._readPlayerInput} plus the
 *   cursor/WASD bindings; the scheme→input branch itself lives in
 *   `mapControlInput` so `GymPlayer` shares it too),
 * - auto-fire ({@link CombatCoreScene._autoFire},
 *   {@link CombatCoreScene.spawnPlayerBullet} and the
 *   {@link CombatCoreScene.onWeaponFired} hook),
 * - drop collection ({@link CombatCoreScene._collectDrop},
 *   {@link CombatCoreScene._startCollectAnimation},
 *   {@link CombatCoreScene._updateCollectAnimations} and the pickup-cue
 *   hook) plus the shared power-up drop layer itself — the default weighted
 *   spawner, grow/hold/shrink lifecycle, hull-touches-bubble collection gate,
 *   P9 magnet and the complete per-frame drop sequence, delegated to
 *   `./dropLayer` through {@link CombatCoreScene._updateDropLayer} et al.
 *   (AH-0MUII3CXX0023H24, gap 4), so an enabled drop behaves identically in
 *   every scene and only the spawn *source* stays per-scene,
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
  type WeaponDefinition,
  type WeaponId,
} from '../../utils/weapons';
import {
  mapControlInput,
  type ControlInput,
} from '../../utils/movementModel';
import type { WasdKeysLike } from '../../utils/input';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import {
  spawnCollectAnimation,
  type CollectAnimationHandle,
} from '../../powerups/collectAnimation';
import type { PowerUpSpawner } from '../../powerups/spawner';
import {
  resolvePatterns,
  spawnExplosionParticles,
} from '../../vfx/explosionParticles';
import type { DropId, PowerUpId } from '../../powerups/types';
import type { PowerUpWeights, WeaponWeights } from '../../core/rules';
import { loadRules } from '../../core/rules';
import {
  advanceDropLifecycles,
  applyDropMagnet,
  buildDefaultDropSpawner,
  collectOverlappingDrops,
  playDropPickupCue,
} from './dropLayer';
import {
  applyMineralScoop,
  type MovableMineral,
} from '../../powerups/mineralScoop';
import { spawnNovaRing } from '../../vfx/aoeEffect';
import { PhaseShiftJuice } from '../../vfx/phaseShiftJuice';
import { BeatClock, createBeatClock } from '../../utils/beat';

/** Ring colour for the P4 bomb pulse VFX (hot magenta-red). */
export const BOMB_PULSE_COLOR = 0xff5577;

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
   * Optional multi-hit seam (e.g. Harvester). When present, a player bullet
   * delegates to this instead of `destroySelf()`. The entity clears its own
   * `alive` flag on the lethal hit; the scene then finalises the kill exactly
   * once (destruction audio + `onEnemyDestroyed`) by observing `alive`.
   */
  takeDamage?(): number | void | { destroyed: boolean; phaseAdvanced: boolean; phase: number; hpRemaining: number; };
  /**
   * Optional roaming-seek seam (Harvester, GDD §4.1 — E7). When present, the
   * shared tick hands the scene's live mineral field to the entity so it can
   * steer toward the nearest mineral. Defined once here and consumed by the
   * game and the gyms so seeking is never re-implemented per scene
   * (AH-0MUII2FJ5007MDDA gym-parity epic).
   */
  setSeekTargets?(minerals: readonly import('../../entities/Mineral').Mineral[]): void;
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
  /**
   * Screen-wide Phase Shift juice overlays owned by the shared step
   * (parent AH-0MUIYX1EE008FVS8). Cleared on restart/shutdown like the other
   * shared effect registries.
   */
  protected phaseShiftEffects: Phaser.GameObjects.GameObject[] = [];
  /**
   * Live P4 bomb-pulse ring VFX (AH-0MUVM9RAO004Y3LB). The ring removes
   * itself on completion; the registry is also cleared on restart/shutdown
   * so an in-flight pulse leaks nothing.
   */
  protected bombPulseEffects: Phaser.GameObjects.Graphics[] = [];
  /** Lazily-created Phase Shift treatment controller. */
  private phaseShiftJuice: PhaseShiftJuice | null = null;

  /**
   * The single shared beat clock driving phase-locked player auto-fire
   * (AH-0MUAYB8EH005RJ8B). Created once per scene and anchored at scene
   * start (t=0); it is shared with the player so every shot lands on one
   * grid. It advances only through {@link CombatCoreScene._autoFire} (via
   * the player's `tryFire`), so a paused scene — whose `update` is not
   * called — pauses the clock with it.
   */
  protected readonly beatClock: BeatClock = createBeatClock({
    bpm: loadRules().beatBpm,
  });

  /**
   * The scene's single shared beat clock (one instance per scene, never a
   * per-scene copy of the beat module). Exposed so scenes, gyms and tests
   * can read/verify the grid driving player fire.
   */
  getBeatClock(): BeatClock {
    return this.beatClock;
  }

  // Arrow-key (cursor) and WASD bindings for the player ship.
  protected cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  protected wasd: WasdKeysLike | undefined;

  /** Registry used by subclasses that do not supply their own. */
  private readonly defaultEffectsRegistry = new EffectsRegistry();

  /**
   * Binds `registry` to the scene's live player store — the single
   * run-scoped power-up level model (AH-0MUV5CLW6005VF7K, Q1=A).
   *
   * The resolver is dynamic, so a player created after the bind (or a
   * respawned player) is picked up automatically; `getPlayer()` returning
   * null falls back to the registry's private store. Safe to call before the
   * player exists and idempotent, so scenes with their own registry can
   * invoke it from their `create()`/`resetRunState()`.
   *
   * @param registry — the registry to bind (the scene's own or the default).
   */
  protected _bindPowerUpLevelStore(registry: EffectsRegistry): void {
    registry.setStoreResolver(
      () => this.getPlayer()?.getPowerUpLevelStore() ?? null,
    );
  }

  // ── Participant contract (safe concrete defaults) ─────────────────

  /** The keyboard-controlled player ship (null when the scene has none). */
  protected getPlayer(): Player | null {
    return null;
  }

  /**
   * The shared active-effect registry (default implementation). Binds the
   * registry to this scene's live player store (dynamic resolver) so a stub
   * scene that does not override this accessor still consumes the single
   * run-scoped level model (AH-0MUV5CLW6005VF7K). Idempotent and cheap.
   */
  protected getEffectsRegistry(): EffectsRegistry {
    this._bindPowerUpLevelStore(this.defaultEffectsRegistry);
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
   * Shared AOE dispatch hook (parent AH-0MUOOB3OR001V8CD): called by
   * {@link CombatCoreScene._autoFire} once for every AOE weapon that fires,
   * with the firing weapon and the ship position. Default no-op; the shared
   * {@link CombatScene} overrides it to resolve an `'onFire'` area effect, and
   * an `'onImpact'` projectile later resolves its own blast through the same
   * shared effect path.
   *
   * @param _weaponId - The AOE weapon that fired.
   * @param _def - Its catalogue definition (carries the AOE descriptor).
   * @param _x - Ship world x at the moment of firing.
   * @param _y - Ship world y at the moment of firing.
   */
  protected onAoeFired(
    _weaponId: WeaponId,
    _def: WeaponDefinition,
    _x: number,
    _y: number,
  ): void {}

  /**
   * Shared hook called once for every `'onRandom'` AOE weapon that fires
   * (parent AH-0MUUF9GZV004WVT9): the area resolves immediately at one or
   * more points sampled uniformly at random within the weapon's effective
   * range, centred on the ship — no travelling projectile. Default no-op; the
   * shared {@link CombatScene} overrides it to sample the points and resolve
   * the effect (and VFX/cue) at each.
   *
   * @param _def - The firing weapon's catalogue definition.
   * @param _x - Ship world x at the moment of firing.
   * @param _y - Ship world y at the moment of firing.
   */
  protected onAoeRandomFired(
    _def: WeaponDefinition,
    _x: number,
    _y: number,
  ): void {}

  /**
   * Shared hook called once for every `'onImpact'` AOE projectile the moment
   * it is spawned (parent AH-0MUOOB3OR001V8CD). Default no-op; the shared
   * {@link CombatScene} overrides it to attach the projectile's expiry
   * detonation. The projectile already carries its definition in
   * {@link PlayerBullet.aoeWeapon}.
   *
   * @param _bullet - The freshly spawned projectile.
   * @param _def - Its AOE weapon definition.
   */
  protected onAoeProjectileSpawned(
    _bullet: PlayerBullet,
    _def: WeaponDefinition,
  ): void {}

  /**
   * Plays the per-type pickup activation cue through the single shared
   * `playDropPickupCue` dispatcher, so every scene plays the same cue set
   * (generic pop + P5/P8/P9 + weapon/Reset, generic chime fallback).
   */
  protected _playPickupCue(drop: TDrop): void {
    playDropPickupCue(drop);
  }

  /**
   * Hook run after a power-up (non-weapon) drop is collected. Default
   * no-op; scenes override to add their lifecycle extras (and call
   * `super`). The P4 bomb is handled entirely by the shared pulse path
   * ({@link CombatCoreScene._updateP4Bomb}), so no notice is shown here
   * (AH-0MUVM9RAO004Y3LB, producer Q3=A).
   */
  protected onPowerUpCollected(_drop: TDrop): void {}

  /**
   * Hook run after a weapon drop is collected. Default no-op; scenes
   * advance their weapon lifecycle.
   */
  protected onWeaponCollected(_drop: TDrop): void {}

  // ── Shared template methods ───────────────────────────────────────

  /**
   * Optional bot-input seam for a demo/attract mode (AH-0MUX495VG0014MIY
   * AC2). {@link CombatCoreScene._readPlayerInput} consults this **before**
   * the keyboard: a non-null result is used verbatim, so a bot's decision
   * flows through the shared player-control step exactly like held keys.
   * The bot therefore never bypasses movement physics.
   *
   * Default `null` — keyboard-only. `PlayScene` overrides it to return the
   * pure `decideBotInput(snapshot)` decision while demo mode is on; the
   * threat-free gyms inherit the default and are unchanged, so the shared
   * input path stays identical everywhere (gym↔game parity).
   */
  protected getBotInput(): ControlInput | null {
    return null;
  }

  /**
   * Reads the held arrow/WASD keys into the scheme-appropriate
   * `ControlInput` contract, keyed off the player's saved control scheme.
   * Delegates to the shared {@link mapControlInput} helper so the
   * scheme→input branch is defined once (AC1/AC2).
   *
   * A provided {@link CombatCoreScene.getBotInput} result takes precedence
   * over the keyboard — the demo/attract seam — while normal play (no bot
   * input) reads the keys exactly as before.
   */
  protected _readPlayerInput(): ControlInput | null {
    const botInput = this.getBotInput();
    if (botInput) return botInput;
    const player = this.getPlayer();
    if (!player || !this.cursors || !this.wasd) return null;
    return mapControlInput(player.getScheme(), {
      cursors: this.cursors,
      wasd: this.wasd,
    });
  }

  /**
   * Whether this scene auto-fires the player's active weapons. Default
   * `true` — the shipped game and the weapon-enabled gyms fire every
   * active weapon each frame. Threat-free / weapon-free gyms
   * (`GymPowerUpsUtility`, `GymPowerUpsCombat`) override this to `false`,
   * so the shared step is a no-op for the feature they do not enable
   * (AH-0MUII39KX007YUQ0, AC1).
   */
  protected autoFireEnabled(): boolean {
    return true;
  }

  /**
   * Shared screen-wide Phase Shift juice step (parent AH-0MUIYX1EE008FVS8).
   *
   * Lazily creates the treatment the first time a ship exists, then advances
   * it for the current phased state: the overlays appear on the frame the
   * phase activates and are destroyed on the frame it expires. A no-op when
   * the scene has no player, so threat-free/non-combat frames stay clean.
   *
   * @param dt — frame delta (seconds).
   */
  protected _updatePhaseShiftJuice(dt: number): void {
    if (!this.getPlayer()) return;
    this.phaseShiftJuice ??= new PhaseShiftJuice(this, {
      registry: this.phaseShiftEffects,
    });
    this.phaseShiftJuice.update(this.getEffectsRegistry().isPhased, dt);
  }

  /**
   * Shared player-control step (AH-0MUII39KX007YUQ0, AC1). Every
   * scene advances the player identically, in the same order every frame:
   *
   * 1. advance timed-weapon countdowns,
   * 2. apply the live P5 speed / fire-rate multipliers from the effects
   *    registry,
   * 3. read the scheme-appropriate input,
   * 4. step physics (screen-wrap),
   * 5. auto-fire the active weapons (unless the scene opts out via
   *    {@link CombatCoreScene.autoFireEnabled}),
   * 6. advance the P4 bomb pulse and fire a ranged clear when due
   *    ({@link CombatCoreScene._updateP4Bomb}).
   *
   * Scenes call this instead of a local copy, so a control/ordering fix
   * reaches the game and every gym at once. A scene with no player is a
   * no-op.
   */
  protected _tickPlayer(dt: number): void {
    const player = this.getPlayer();
    if (!player) return;
    // Advance timed-weapon countdowns before auto-fire so an expired
    // weapon stops firing this frame.
    player.tickWeaponTimers(dt * 1000);
    // P5 live boost: scale thrust/max-speed and fire rate each frame.
    const registry = this.getEffectsRegistry();
    player.setSpeedMultiplier(registry.speedMultiplier());
    player.setFireRateMultiplier(registry.fireRateMultiplier());
    const input = this._readPlayerInput();
    if (input) player.setInput(input);
    player.physicsTick(dt, this.scale.width, this.scale.height);
    if (this.autoFireEnabled()) this._autoFire(dt);
    // P4 bomb: advance the shared pulse state and fire a ranged clear when
    // one is due. Runs after physics so the pulse is centred on the player's
    // current position, and from this single shared step so the game and
    // every gym cannot diverge (AH-0MUVM9RAO004Y3LB).
    this._updateP4Bomb(dt);
  }

  /**
   * Auto-fires every active weapon toward the direction of travel when
   * its cooldown has elapsed, delegating the firing cue to
   * {@link CombatCoreScene.onWeaponFired}.
   */
  protected _autoFire(dt: number): void {
    const player = this.getPlayer();
    if (!player) return;
    // Every scene shares its single beat clock with the player so player
    // fire is phase-locked to the scene anchor (AH-0MUAYB8EH005RJ8B).
    if (player.getBeatClock() !== this.beatClock) {
      player.setBeatClock(this.beatClock);
    }
    const fired = player.tryFire(dt);
    if (fired.length === 0) return;
    const headingDeg = (player.getHeading() * 180) / Math.PI;
    for (const weaponId of fired) {
      this.onWeaponFired(weaponId);
      const def = player.getWeaponDef(weaponId);
      if (def.aoe) {
        // AOE dispatch: the shared core owns the hook, so the game and the
        // gyms resolve the same area effect from one implementation.
        this.onAoeFired(weaponId, def, player.x, player.y);
        // Neither an `onFire` effect (nova ring / arc chain) nor an
        // `onRandom` effect (mortar blast) launches a travelling projectile:
        // both resolve their area effect at fire time. Only an `onImpact`
        // effect launches a projectile through the normal bullet path, and
        // the projectile resolves its blast on impact/expiry.
        if (def.aoe.trigger === 'onFire') continue;
        if (def.aoe.trigger === 'onRandom') {
          this.onAoeRandomFired(def, player.x, player.y);
          continue;
        }
      }
      for (const bd of createBulletsFromHeading(
        def,
        headingDeg,
        player.x,
        player.y,
      )) {
        // An `'onImpact'` projectile travels at its own (slower) speed so the
        // detonation point stays legible; conventional bullets use the shared
        // speed.
        const speed = def.aoe?.projectileSpeed ?? PLAYER_BULLET_SPEED;
        const vel = angleToVelocity(bd.angleDeg, speed);
        const bullet = this.spawnPlayerBullet(
          bd.x,
          bd.y,
          vel.vx,
          vel.vy,
          bd.color,
          def.bulletLifetime,
          // Weapon leveling grows the bullet: `levelBulletSize` is 1/absent on
          // a base definition, so the base radius is unchanged (AC8).
          PLAYER_BULLET_RADIUS * (def.levelBulletSize ?? 1),
        );
        if (def.aoe?.trigger === 'onImpact') {
          // Tag the projectile so the shared combat core can detonate its
          // area effect on impact/expiry, then let the scene attach its
          // detonation callback through the shared hook.
          bullet.aoeWeapon = def;
          this.onAoeProjectileSpawned(bullet, def);
        }
      }
    }
  }

  /**
   * Spawns a player bullet at (x, y) travelling at (vx, vy) px/s,
   * with the given colour and lifetime (seconds).
   * Public so tests can place bullets deterministically.
   *
   * `lifetime` defaults to the reduced Cannon base range (0.75 s,
   * AH-0MUU131PU006O7ZD); `radius` defaults to the shared
   * {@link PLAYER_BULLET_RADIUS}. The shared auto-fire path passes a
   * level-scaled radius when a weapon has bullet-size upgrades.
   */
  spawnPlayerBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0x00ffff,
    lifetime = 0.75,
    radius = PLAYER_BULLET_RADIUS,
  ): PlayerBullet {
    const bullet = createPlayerBullet(
      this,
      x,
      y,
      color,
      radius,
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
        // Reset drop no longer clears timed weapons — the onWeaponCollected
        // hook below still fires the pickup audio cue.
      } else {
        registry.applyWeapon(drop.weaponDropId as WeaponId);
        player?.equipWeapon(drop.weaponDropId as WeaponId);
      }
      this.onWeaponCollected(drop);
    } else {
      const effect = drop.powerUp.tryCollect();
      if (!effect) return;
      // P4's ranged clear/pulse is driven from the registry by the shared
      // per-frame bomb step ({@link CombatCoreScene._updateP4Bomb}) — a
      // field pickup queues one pulse, a hold-full reward a permanent one
      // (AH-0MUVM9RAO004Y3LB).
      registry.applyCollect(drop.dropId as PowerUpId);
      this.onPowerUpCollected(drop);
    }
    // Collection confirmed — mark the drop so the overlap gate can never
    // re-collect it while the absorb animation plays.
    drop.absorbing = true;
    this._startCollectAnimation(drop);
    this._playPickupCue(drop);
  }

  // ── Shared drop layer (gap 4) ─────────────────────────────────────

  /**
   * Builds the default weighted-random drop spawner over the combined pool
   * (P3–P9 + weapon drops) from the game-rules weights — the single shared
   * spawner construction consumed by `PlayScene` and every gym.
   */
  protected _buildDefaultDropSpawner(
    powerUpWeights: PowerUpWeights,
    weaponWeights: WeaponWeights,
    rng: () => number,
  ): PowerUpSpawner<DropId> {
    return buildDefaultDropSpawner(powerUpWeights, weaponWeights, rng);
  }

  /**
   * Advances every drop's grow → hold → shrink → despawn lifecycle by `dt`
   * (shared implementation), destroying despawned Graphics. `onDespawn`
   * lets a scene play a despawn cue. Returns the kept drops.
   */
  protected _advanceDropLifecycles(
    drops: TDrop[],
    dt: number,
    onDespawn?: (drop: TDrop) => void,
  ): TDrop[] {
    return advanceDropLifecycles(drops, dt, onDespawn);
  }

  /**
   * Collects every collectible drop whose hull-touches-bubble radius
   * overlaps the player (shared gate: ≥ 3 % scale + `dropCollectRadius`),
   * applying each through {@link CombatCoreScene._collectDrop}. Returns the
   * survivors.
   */
  protected _collectOverlappingDrops(drops: TDrop[]): TDrop[] {
    return collectOverlappingDrops(drops, this.getPlayer(), (drop) =>
      this._collectDrop(drop),
    );
  }

  /**
   * Applies the P9 magnet pull (shared range/speed) to every collectible
   * drop within range, using the scene's effective magnet stacks
   * (permanent stacking or timed field-pickup). The hybrid accessor
   * consumes the effective count so both paths drive the same radius curve.
   */
  protected _applyDropMagnet(drops: TDrop[], dt: number): void {
    applyDropMagnet(
      drops,
      this.getPlayer(),
      this.getEffectsRegistry().magnetEffectStacks(),
      dt,
    );
  }

  /**
   * Applies the P10 Mineral Scoop pull (shared range/speed) to every live
   * mineral within range, using the scene's effective scoop stacks. The
   * mineral-field analogue of {@link _applyDropMagnet}; scenes with a mineral
   * field call it immediately before their shared `collectMinerals` pass so
   * attraction and collection run in the same order everywhere.
   */
  protected _applyMineralScoop(minerals: MovableMineral[], dt: number): void {
    const player = this.getPlayer();
    if (!player) return;
    applyMineralScoop(
      minerals,
      player,
      this.getEffectsRegistry().scoopEffectStacks(),
      dt,
    );
  }

  /**
   * The complete shared per-frame drop sequence: apply the P9 magnet,
   * advance the lifecycle, collect overlaps, then advance the absorb
   * animations. Scenes that interleave a spawn source call the individual
   * shared steps instead.
   */
  protected _updateDropLayer(
    drops: TDrop[],
    dt: number,
    options?: { onDespawn?: (drop: TDrop) => void },
  ): TDrop[] {
    this._applyDropMagnet(drops, dt);
    const kept = this._advanceDropLifecycles(drops, dt, options?.onDespawn);
    const remaining = this._collectOverlappingDrops(kept);
    this._updateCollectAnimations(dt);
    return remaining;
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
   * Clears every enemy bullet whose centre lies within `range` px of the
   * point `(x, y)`, keeping the rest — the shared P4 ranged clear
   * (AH-0MUVM9RAO004Y3LB, AC4). Bullets only: enemy entities are never
   * touched, so the bomb deals no damage (AC3).
   *
   * Position is read from each bullet's `graphics` object (the shared
   * bullet lifecycle keeps it authoritative) so the same implementation
   * serves the game and every gym.
   *
   * @param x - Blast centre x (px).
   * @param y - Blast centre y (px).
   * @param range - Blast radius (px, inclusive).
   */
  protected _clearEnemyBulletsInRange(x: number, y: number, range: number): void {
    const survivors: TBullet[] = [];
    for (const bullet of this.getEnemyBullets()) {
      if (Math.hypot(bullet.graphics.x - x, bullet.graphics.y - y) <= range) {
        bullet.graphics.destroy();
      } else {
        survivors.push(bullet);
      }
    }
    this.setEnemyBullets(survivors);
  }

  /**
   * Advances the shared P4 bomb pulse and, when the registry reports a pulse
   * is due, clears enemy bullets within the resolved range around the player
   * and spawns the expanding-ring VFX (AH-0MUVM9RAO004Y3LB).
   *
   * Called from {@link CombatCoreScene._tickPlayer} so the game and every
   * gym drive the pulse from exactly one implementation; a scene with no
   * player is a no-op.
   *
   * @param dt - Frame delta in seconds.
   */
  protected _updateP4Bomb(dt: number): void {
    const registry = this.getEffectsRegistry();
    if (!registry.updateBomb(dt)) return;
    const player = this.getPlayer();
    if (!player) return;
    const range = registry.bombRange();
    this._clearEnemyBulletsInRange(player.x, player.y, range);
    this._spawnBombPulse(player.x, player.y, range);
  }

  /**
   * Spawns the P4 expanding-ring pulse VFX at the cleared radius. Reuses the
   * shared `spawnNovaRing` helper (tracked in {@link bombPulseEffects}) so
   * the game and every gym show the same feedback.
   */
  protected _spawnBombPulse(x: number, y: number, range: number): void {
    spawnNovaRing(this, x, y, range, {
      registry: this.bombPulseEffects,
      color: BOMB_PULSE_COLOR,
    });
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
    // Bind the registry to this scene's live player store, then reset both
    // the timing state and the level store together (AC6). The dynamic
    // resolver means a player created later in `create()` is picked up with
    // no further wiring — the single shared injection point.
    const registry = this.getEffectsRegistry();
    this._bindPowerUpLevelStore(registry);
    registry.reset();
    this.playerBullets = [];
    this.playerExplosions = [];
    this.playerDeathEffects = [];
    this.phaseShiftJuice?.destroy();
    this.phaseShiftJuice = null;
    this.phaseShiftEffects = [];
    // In-flight absorb animations are owned by the animation registry
    // (their drops are no longer in the scene's drop list), so their
    // only teardown path is here.
    for (const anim of this.collectAnimations) anim.destroy();
    this.collectAnimations = [];
    // In-flight P4 pulse rings are likewise owned by their registry.
    for (const effect of this.bombPulseEffects) effect.destroy();
    this.bombPulseEffects = [];
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
    for (const effect of this.phaseShiftEffects) effect.destroy();
    this.phaseShiftEffects = [];
    for (const anim of this.collectAnimations) anim.destroy();
    this.collectAnimations = [];
    for (const effect of this.bombPulseEffects) effect.destroy();
    this.bombPulseEffects = [];
    // Release every collected effect so a restarted scene starts clean
    // even when teardown (not a fresh `create()`) is the observed path.
    this.getEffectsRegistry().reset();
  }
}

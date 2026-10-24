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
 * - {@link CombatScene._updateAutoDefence} / {@link CombatScene.triggerTeleport}
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
  ENEMY_FIELD_RAM_REARM_MS,
  FORCE_FIELD_COLOR,
  FORCE_FIELD_REFLECT_LIFETIME,
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_BULLET_RADIUS,
  PLAYER_HIT_SCALE_PEAK,
  PLAYER_HIT_SCALE_PULSE_DURATION,
  SHIP_SIZE,
} from '../../core/constants';
import {
  playBulletDestructionSound,
  playDestructionSound,
  playMortarDetonationSound,
  playMortarImpactSound,
  playPhaseShiftSound,
  playWeaponImpactCue,
  playNovaImpactSound,
} from '../../audio/effects';
import { Boss } from '../../entities/Boss';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { resolveBulletVsBulletImpact, spawnBulletImpact } from '../../vfx/bulletImpact';
import { spawnMortarBurst, spawnNovaRing, spawnArcChain, type ArcChainPoint } from '../../vfx/aoeEffect';
import { isPointNearSegment, selectAoETargets, selectChainTargets, selectRandomPoint } from '../../utils/aoe';
import type { AoEDescriptor, WeaponDefinition, WeaponId } from '../../utils/weapons';
import { spawnPlayerDeathJuice } from '../../vfx/playerDeathJuice';
import { resolveThornsAbsorb } from '../../vfx/thornsAbsorb';
import { EffectsRegistry } from '../../powerups/effects';
import { isInDanger } from '../../powerups/dangerDetection';
import {
  findTeleportDestination,
  type TeleportBody,
} from '../../powerups/teleport';

// ── Orbital Strike reward VFX (AH-0MVH80ZJ7009W18Z) ──────────────────
/** Visual radius of the reward strike's expanding ring (px). */
export const ORBITAL_STRIKE_RADIUS = 40;
/** Distinct cyan-white colour for the reward strike's ring/impact. */
export const ORBITAL_STRIKE_COLOR = 0x9ffcff;
import {
  CombatCoreScene,
  SMART_BOMB_PULSE_COLOR,
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
import { hitDrone } from './combatDrone';

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

  /**
   * Live Thorn Field absorb bursts, tracked for observation and teardown on
   * scene shutdown (AH-0MVJ8YKR70096C6T). Spawned by the shared ram branch
   * through {@link _onThornsAbsorb}, so the game and every gym fire the same
   * burst.
   */
  protected thornsAbsorbEffects: Phaser.GameObjects.Graphics[] = [];

  /** Seconds of post-hit invulnerability remaining (blinks while > 0). */
  protected invulnerable = 0;
  protected blinkPhase = 0;
  /** Cumulative player-hit counter (exposed by both scenes). */
  protected playerHitCount = 0;

  /**
   * Scene-clock timestamp (`this.time.now`, ms) until which an enemy force
   * field will not absorb another ram (epic AH-0MVJ8W4GE007OMNT AC2, Q6 = B).
   * One configured contact consumes exactly one field hit; a sustained
   * overlap inside this window consumes nothing, so a player holding the ram
   * position cannot drain the field frame-by-frame. Only gates enemies that
   * still carry a field — an unshielded contact keeps the both-destroyed rule.
   */
  protected enemyFieldRamReArmUntil = 0;

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

  // ── Automatic defence danger feed ──────────────────────────

  /**
   * Shared per-frame danger feed for the automatic defences (Phase Shift,
   * parent AH-0MUIYX1EE008FVS8; Teleport, AH-0MUZE4AIP009HZWC).
   *
   * Counts the live hostile bodies and enemy bullets whose centre lies
   * within `DANGER_RADIUS` of the ship (via the pure `isInDanger` helper)
   * and hands the result to the effects registry. Under one shared re-arm
   * governor the registry selects — at most once per danger episode — which
   * defence to spend by comparing the available counts ({@link
   * selectAutoDefence}). When it reports Phase Shift it has already
   * activated the pass-through; when it selects Teleport the scene performs
   * the warp through {@link CombatScene.triggerTeleport} (consuming one FIFO
   * stack and granting Phase Shift on arrival). Every combat scene calls this
   * once per frame immediately before `_handleCollisions`, so the game and
   * the gyms share one implementation and one ordering and cannot diverge.
   *
   * @param dt — frame delta (seconds); advances the shared re-arm cooldown.
   */
  protected _updateAutoDefence(dt: number): void {
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
    const decision = registry.updateDanger(
      isInDanger(player, bodies, bullets),
      dt,
    );
    // Dedicated activation cue on every automatic Phase Shift trigger
    // (parent AH-0MUIYX1EE008FVS8). The Teleport path plays the same cue
    // inside `triggerTeleport` once the warp lands.
    if (decision === 'phase_shift') {
      playPhaseShiftSound();
    } else if (decision === 'teleport') {
      this.triggerTeleport();
    }
  }

  // ── Shared effect gating (Shield shield / Phase Shift phase) ─────────────────

  /**
   * Whether the player is Phase Shift phase-shifted and therefore immune to enemy
   * bullets and enemy body contact. Backed by the shared effects registry,
   * so every `CombatScene` subclass (including `GymFormationScene` and its
   * `GymFodderEnemies`/`GymBoss`/`GymMinerals` subclasses) inherits the same
   * gating exactly once and cannot diverge.
   */
  protected override isPlayerPhased(): boolean {
    return this.getEffectsRegistry().isPhased;
  }

  /**
   * Shield shield absorbs a hit: consume one of the bubble's remaining
   * absorptions (level-resolved), run the scene-specific absorb cue
   * ({@link CombatScene.onShieldAbsorbed}), start the shared post-hit
   * invulnerability window and report the hit as absorbed. A shield with
   * absorptions to spare stays active; the last absorb pops it, after which
   * the following hit lands normally (AH-0MUVM9RAO004Y3LB).
   */
  protected override tryAbsorbPlayerHit(_player: Player): boolean {
    if (!this.getEffectsRegistry().tryAbsorbShield()) return false;
    this.onShieldAbsorbed();
    this._startInvulnerability();
    return true;
  }

  /**
   * Scene hook for the Shield shield-absorb cue. Default no-op — the generic
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
   * The scene's boss, or null (game: spawned after the final level; `GymBoss`: its
   * single formation entity). The shared boss hooks below use this accessor
   * so boss advancement and teleport avoidance are defined once for both
   * scenes (AH-0MUII3E5E006A93F, gap 6).
   */
  protected getBoss(): Boss | null {
    return null;
  }

  /**
   * Extra teleport-avoidance bodies (the boss when present). The default
   * derives the boss body from {@link CombatScene.getBoss}, so a Teleport
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
   * A **damage-budget** beam (`bullet.maxHitPoints > 0`, R-Type wave laser)
   * spends up to its remaining budget on the enemy (one hit point per
   * `takeDamage()`), remembers the enemy so its budget is never re-charged,
   * and — if the enemy was destroyed and budget remains — returns `false` so
   * the shared loop keeps scanning to the ships behind it. If the enemy
   * survives a partial hit or the budget is spent the bullet is consumed
   * (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S).
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
    // A splitting projectile (cluster missile) does not deal a direct hit: it
    // bursts into radial warheads at the impact point, which damage enemies
    // on contact through the ordinary bullet path. The split resolves exactly
    // once and the parent shell is consumed (AH-0MV1BIVIJ007KYXU).
    if (bullet.splitWeapon) {
      this.splitProjectile(bullet);
      bullet.destroy();
      return true;
    }
    // Already spent damage on this enemy on an earlier frame — never re-charge.
    if (bullet.damagedEnemies.has(enemy)) {
      return false;
    }
    if (bullet.maxHitPoints > 0) {
      // Damage-budget beam: apply up to the remaining budget, charge the
      // enemy its actual damage and remember it. The beam passes through only
      // when it destroyed the enemy and still has budget left; an enemy that
      // survives a partial hit consumes the beam (it has nothing left to
      // spend), as does an enemy destroyed exactly at zero budget.
      bullet.damagedEnemies.add(enemy);
      const applied = this.damageEnemyWithBullet(
        enemy,
        bullet,
        bullet.maxHitPoints,
      );
      bullet.maxHitPoints = Math.max(0, bullet.maxHitPoints - applied);
      if (!enemy.alive && bullet.maxHitPoints > 0) {
        return false;
      }
      bullet.destroy();
      return true;
    }
    // Ordinary single-hit bullet: one damage instance, then consumed.
    this.damageEnemyWithBullet(enemy, bullet);
    bullet.destroy();
    return true;
  }

  /**
   * Applies player-bullet damage to `enemy` through the shared kill seam
   * **without** consuming the bullet: a multi-hit entity takes one hit point
   * per `takeDamage()` (finalised on the lethal blow, with the shared impact
   * flash on a non-lethal hit); a single-hit entity is destroyed and
   * finalised.
   *
   * `damage` is the number of hit points to attempt — 1 for an ordinary
   * bullet, the beam's remaining `maxHitPoints` budget for the R-Type wave
   * laser. The loop stops at the enemy's death, so per-enemy damage is capped
   * at its remaining HP (AH-0MV97RISJ002WR2S).
   *
   * @returns the number of damage points actually applied — the budget
   * caller deducts it from the bullet's `maxHitPoints`.
   */
  private damageEnemyWithBullet(
    enemy: TEnemy,
    bullet: PlayerBullet,
    damage = 1,
  ): number {
    // Per-weapon hit feedback (cannon's distinct flash + hit cue) plays on
    // every connect through the shared impact seam — including the lethal
    // blow, which layers the shot's hit cue under the destruction audio
    // (AH-0MV8228YW0050IXS AC4).
    this.resolveWeaponImpactFx(bullet);
    const points = Math.max(0, Math.floor(damage));
    let applied = 0;
    if (enemy.takeDamage) {
      // Frenzy (AH-0MVH80ZJ7009W18Z): while its window is active a single
      // ordinary-bullet contact applies its bonus hits, so multi-hit targets
      // (Harvester/mini-boss/boss) die faster. Inactive = exactly one hit,
      // unchanged. The damage-budget path applies one hit point per budget
      // point instead, bounded by the enemy's remaining HP.
      const extraHits = this.getEffectsRegistry().frenzyBonusHits();
      if (points === 1) {
        for (let hit = 0; hit <= extraHits && enemy.alive; hit += 1) {
          enemy.takeDamage();
          applied += 1;
        }
      } else {
        while (applied < points && enemy.alive) {
          enemy.takeDamage();
          applied += 1;
        }
      }
      // Multi-hit entity: finalise the kill exactly once on the lethal blow
      // (the entity's `takeDamage()` has already run `destroySelf()` and
      // cleared `alive`). A non-lethal hit flashes at the impact point so the
      // player can read that the hit registered — unless the per-weapon
      // impact already laid down its distinct flash above.
      if (!enemy.alive) {
        this.finaliseEnemyKill(enemy);
      } else if (!bullet.impactFx) {
        spawnBulletImpact(this, bullet.x, bullet.y, {
          registry: this.bulletImpactEffects,
        });
      }
    } else {
      enemy.destroySelf();
      this.finaliseEnemyKill(enemy);
      // A single-hit entity counts as 1 HP regardless of the offered damage.
      applied = points > 0 ? 1 : 0;
    }
    return applied;
  }

  /**
   * Resolves a bullet's per-weapon impact feedback through the shared impact
   * seam (AH-0MV8228YW0050IXS AC4): plays the weapon's baked hit cue and
   * spawns its distinct impact flash at the hit point, so the game and every
   * gym show the identical hit feedback. Bullets without `impactFx` metadata
   * are a no-op — they keep the generic bullet-impact flash only.
   */
  protected resolveWeaponImpactFx(bullet: PlayerBullet): void {
    const fx = bullet.impactFx;
    if (!fx) return;
    playWeaponImpactCue(fx.cue);
    spawnBulletImpact(this, bullet.x, bullet.y, {
      registry: this.bulletImpactEffects,
      color: fx.color,
      radius: fx.radius,
      duration: fx.duration,
    });
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
    this.applyAoEDescriptor(aoe, x, y);
  }

  /**
   * Shared area-effect application from a bare {@link AoEDescriptor} — the
   * seam the AOE **weapons** and the Smart Bomb **power-up** share
   * (AH-0MV1BIWP9003EHRQ). Resolves one area effect at (x, y):
   *
   * 1. damages every live enemy inside the radius for `aoe.damage` hit points
   *    (default 1) through the same `takeDamage()` / `destroySelf()` +
   *    `finaliseEnemyKill` seam a player bullet uses,
   * 2. destroys every enemy bullet inside the radius with the shared impact
   *    feedback,
   * 3. damages the boss through {@link CombatScene.onAoeHitsBoss}.
   *
   * Keeping this the single implementation means the Smart Bomb cannot fork
   * the area-effect behaviour away from Nova/Mortar/Arc (AC5).
   */
  protected applyAoEDescriptor(aoe: AoEDescriptor, x: number, y: number): void {
    if (aoe.damagesEnemies) {
      // Pure target selection (utils/aoe) keeps the game and gyms identical.
      const targets = selectAoETargets(
        x,
        y,
        aoe.radius,
        this.getEnemyEntities(),
      );
      // Frenzy also strengthens area effects (same shared damage seam).
      const damage =
        Math.max(1, Math.floor(aoe.damage ?? 1)) +
        this.getEffectsRegistry().frenzyBonusHits();
      for (const enemy of targets) this.damageEnemyViaAoe(enemy, damage);
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
   * seam: multi-hit entities take `damage` hits (and finalise on the lethal
   * blow); single-hit entities are destroyed and finalised outright. AOE
   * weapons pass the default of one hit; the Smart Bomb passes its
   * level-resolved damage (AH-0MV1BIWP9003EHRQ).
   */
  private damageEnemyViaAoe(enemy: TEnemy, damage = 1): void {
    if (!enemy.alive) return;
    if (enemy.takeDamage) {
      const hits = Math.max(1, Math.floor(damage));
      for (let i = 0; i < hits && enemy.alive; i++) enemy.takeDamage();
      if (!enemy.alive) this.finaliseEnemyKill(enemy);
    } else {
      enemy.destroySelf();
      this.finaliseEnemyKill(enemy);
    }
  }

  /**
   * Resolves one Orbital Strike bolt (AH-0MVH80ZJ7009W18Z): picks the live
   * enemy nearest the ship and applies the level-resolved damage through the
   * shared AOE kill seam (so score/drop/wave accounting runs exactly once),
   * with a shared expanding-ring + impact flash at the target. Lights up in
   * the game and every gym because the detection lives in the shared
   * {@link CombatCoreScene._updateOrbitalStrike}.
   *
   * @param damage - Level-resolved strike damage (whole hits).
   */
  protected override onOrbitalStrike(damage: number): void {
    const player = this.getPlayer();
    if (!player) return;
    let target: TEnemy | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const enemy of this.getEnemyEntities()) {
      if (!enemy.alive) continue;
      const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
      if (distance < best) {
        best = distance;
        target = enemy;
      }
    }
    if (!target) return;
    const x = target.x;
    const y = target.y;
    spawnNovaRing(this, x, y, ORBITAL_STRIKE_RADIUS, {
      registry: this.aoeEffects,
      color: ORBITAL_STRIKE_COLOR,
    });
    spawnBulletImpact(this, x, y, {
      color: ORBITAL_STRIKE_COLOR,
      registry: this.bulletImpactEffects,
    });
    this.damageEnemyViaAoe(target, damage);
  }

  /**
   * Resolves one Smart Bomb pulse (AH-0MV1BIWP9003EHRQ): applies the
   * level-resolved {@link AoEDescriptor} through the shared AOE seam and
   * spawns the expanding-ring VFX. Defined on the concrete combat scene
   * because the enemy-damage seam ({@link CombatScene.damageEnemyViaAoe})
   * lives here; the shared {@link CombatCoreScene._updateSmartBomb} owns the
   * pulse detection so gyms cannot fork the behaviour.
   */
  protected override onSmartBombPulse(
    aoe: AoEDescriptor,
    x: number,
    y: number,
  ): void {
    this.applyAoEDescriptor(aoe, x, y);
    spawnNovaRing(this, x, y, aoe.radius, {
      registry: this.aoeEffects,
      color: SMART_BOMB_PULSE_COLOR,
    });
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
   * the ship immediately and spawns its distinctive VFX. An `'onRandom'`
   * effect (mortar blast) resolves at random points through
   * {@link CombatScene.onAoeRandomFired}; an `'onImpact'` effect (retained
   * dead-code path) resolves later, when its projectile detonates and calls
   * {@link CombatScene.applyAoeEffect}.
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
      // The connect feedback (impact flash at each chained target + baked hit
      // cue) rides the same shared chain seam, so the game and every gym
      // connect identically (AH-0MV822CE7004MQ14).
      this.resolveChainImpactFx(def, path);
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
   * Resolves the per-weapon connect feedback for a chaining AOE shot (Arc):
   * plays the weapon's baked hit cue once and spawns its distinct impact
   * flash at every chained target through the shared impact-flash seam, so
   * the game and every gym connect identically
   * (AH-0MV822CE7004MQ14). Weapons without `impactFx` metadata are a no-op
   * — the jagged bolt still draws, but no per-weapon connect feedback plays.
   */
  protected resolveChainImpactFx(
    def: WeaponDefinition,
    path: readonly ArcChainPoint[],
  ): void {
    const fx = def.impactFx;
    if (!fx || path.length < 2) return;
    playWeaponImpactCue(fx.cue);
    for (let i = 1; i < path.length; i++) {
      spawnBulletImpact(this, path[i].x, path[i].y, {
        registry: this.bulletImpactEffects,
        color: fx.color,
        radius: fx.radius,
        duration: fx.duration,
      });
    }
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
      // The shockwave connect sound plays with the ring expansion through
      // the same shared onFire AOE VFX path that spawns it (AH-0MV822BPT002GF17),
      // so the game and every gym sound the identical nova impact — mirroring
      // the Mortar detonation cue in `spawnAoeDetonationVfx`.
      playNovaImpactSound();
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
   * Spawns the distinctive detonation VFX/cue for an AOE weapon at (x, y).
   * Mortar's radial burst is the F3 implementation; the shared core owns it so
   * the game and every gym detonate identically. The detonation **cue always
   * plays** (so an off-screen random blast is still audible), but the burst
   * **graphics are culled** when the point lies outside the play bounds — the
   * random Mortar can otherwise sample a point beyond the screen
   * (AH-0MUUF9GZV004WVT9 AC4).
   *
   * `origin` (when supplied) is the launcher's fire position, used to draw the
   * Mortar's inbound arcing shell trail from the ship into the blast point
   * (AH-0MV822C250051OVN); absent for the retained `onImpact` projectile path.
   */
  protected spawnAoeDetonationVfx(
    def: WeaponDefinition,
    x: number,
    y: number,
    origin?: { x: number; y: number },
  ): void {
    if (def.id === 'mortar' && def.aoe) {
      if (this.isPointInPlayBounds(x, y)) {
        spawnMortarBurst(this, x, y, def.aoe.radius, {
          registry: this.aoeEffects,
          origin,
        });
      }
      // The shell lands (sharp impact crack) then detonates (heavy boom),
      // both through this same shared AOE seam so the game and every gym
      // sound the identical Mortar connect (AH-0MV822C250051OVN).
      playMortarImpactSound();
      playMortarDetonationSound();
    }
  }

  /**
   * Shared hook for an `'onRandom'` AOE weapon (parent AH-0MUUF9GZV004WVT9):
   * resolves the area effect **instantly** at one point per pattern bullet
   * (`def.offsets.length`, so `projectileCount` leveling adds detonations),
   * each sampled uniformly at random over the disc of radius
   * `projectileSpeed × bulletLifetime` centred on the ship. No travelling
   * projectile is spawned and there is no forward bias. Audio always fires;
   * VFX off-screen is culled by {@link CombatScene.spawnAoeDetonationVfx}.
   */
  protected override onAoeRandomFired(
    def: WeaponDefinition,
    x: number,
    y: number,
  ): void {
    const aoe = def.aoe;
    if (aoe?.trigger !== 'onRandom') return;
    // Effective range = existing projectile-speed × lifetime (scaled by the
    // `bulletLifetime` leveling multiplier through `def.bulletLifetime`).
    const range = (aoe.projectileSpeed ?? 0) * def.bulletLifetime;
    const detonations = Math.max(1, def.offsets.length);
    for (let i = 0; i < detonations; i++) {
      const point = selectRandomPoint(x, y, range, this.sceneRng);
      this.applyAoeEffect(def, point.x, point.y);
      // Pass the ship as the launch origin so the burst draws the inbound
      // arcing shell trail from the launcher into the blast point (visual
      // identity AH-0MV822C250051OVN).
      this.spawnAoeDetonationVfx(def, point.x, point.y, { x, y });
    }
  }

  /**
   * True when (x, y) lies inside the scene's play bounds
   * `[0, width] × [0, height]`. Used to cull off-screen AOE VFX while still
   * playing the detonation cue (AH-0MUUF9GZV004WVT9 AC4).
   */
  private isPointInPlayBounds(x: number, y: number): boolean {
    return x >= 0 && x <= this.scale.width && y >= 0 && y <= this.scale.height;
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
   * Resolves per-weapon impact VFX/SFX when a ricochet bullet bounces off
   * a wall (AH-0MV822AP1006W2F9 AC4). Reuses the same impact seam as
   * enemy hits so the game and every gym show identical bounce feedback.
   */
  protected override onPlayerBulletWallBounce(bullet: PlayerBullet): void {
    this.resolveWeaponImpactFx(bullet);
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
      {
        registry: this.bulletImpactEffects,
        // Identity-carrying shots (the Scout's pellet) tint the interception
        // flash with their own colour, so the hit reads distinct per enemy
        // while the existing per-enemy destruction cue still plays
        // (AH-0MV822CQL005R4MM). Legacy bullets keep the warm-white flash.
        color: enemyBullet.color,
      },
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
   * Consumes one Teleport teleport stack and warps the player to the nearest
   * safe spot along the heading (granting Phase Shift on arrival via the
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

    // Consume one stack FIFO and grant Phase Shift phase shift at the landing spot.
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
   * Resolves the shared player-bullets-vs-enemies pass (plus the boss via the
   * {@link CombatScene.onPlayerBulletHitsBoss} hook). Each live enemy is
   * scanned until the bullet is consumed; a damage-budget beam survives the
   * hit and continues scanning (see
   * {@link CombatScene.onPlayerBulletHitsEnemy}). The game and every gym run
   * this one implementation, and `GymWeapons` calls it directly so its inert
   * practice targets demonstrate the damage budget through the same code
   * (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S).
   */
  protected _resolvePlayerBulletsVsEnemies(): void {
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

    // 1. Player bullets vs enemies (and the boss) — shared pass.
    this._resolvePlayerBulletsVsEnemies();

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
          // A splitting projectile bursts into warheads at the interception
          // point (AH-0MV1BIVIJ007KYXU).
          if (pb.splitWeapon) this.splitProjectile(pb);
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

    // 2c. Enemy ordnance and enemy bodies vs collector drones (Mystery UFO
    //     reward, AH-0MV9G113S009B37I). Only enemies can destroy a drone —
    //     the player's own fire passes through — and the spill lands as
    //     collectable minerals at the crash site. Runs before the mineral
    //     pass so a same-frame drop joins the field this frame.
    this._resolveDronesVsEnemies();

    this.onAfterBulletVsBullet();

    const player = this.getPlayer();
    if (!player || this.isPlayerPhased()) return;

    // 3. Enemy bullets vs player — the Force Field reflect branch runs first:
    //    while the bubble is active and a bullet meets it, the bullet is
    //    consumed and re-spawned as a player-owned bullet travelling back
    //    along its incoming direction (Gradius homage, AH-0MV1BIX1W006XF95).
    //    A bullet the field cannot reflect (inactive or budget spent) falls
    //    through to the normal player-hit check below.
    const keptEnemy2: TBullet[] = [];
    const effects = this.getEffectsRegistry();
    for (const eb of this.getEnemyBullets()) {
      const bulletX = eb.graphics.x;
      const bulletY = eb.graphics.y;
      if (
        effects.isForceFieldActive() &&
        this._overlaps(
          bulletX,
          bulletY,
          bulletRadius,
          player.x,
          player.y,
          effects.forceFieldRadius(),
        ) &&
        effects.tryConsumeForceFieldReflect()
      ) {
        this._reflectEnemyBullet(eb);
        eb.graphics.destroy();
        continue;
      }
      if (
        this.invulnerable <= 0 &&
        this._overlaps(
          bulletX,
          bulletY,
          bulletRadius,
          player.x,
          player.y,
          playerHull,
        )
      ) {
        this._hitPlayer();
        // Identity-carrying shot lands on the ship: pop its distinct impact
        // flash + the existing per-enemy cue through the shared impact seam,
        // so a Scout hit reads (and sounds) distinct from a glancing shot
        // (AH-0MV822CQL005R4MM). Legacy bullets keep the plain hit behaviour.
        this._spawnEnemyBulletHitImpact(eb);
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
          // Ram resolution order matters: both the Thorn Field and a shielded
          // enemy's force field absorb the ram, and only the branches that
          // really destroy the enemy may run `onPlayerRamsEnemy` (the shared
          // hook destroys the entity and runs the kill accounting in the game
          // and the generic gym).
          //
          // Thorn Field (AH-0MVH80ZJ7009W18Z) keeps precedence: an active
          // field absorbs the ram — the enemy still dies, but the player takes
          // no hit and the distinct absorb burst/cue fires
          // (AH-0MVJ8YKR70096C6T). A shielded enemy's shield never "steals" the
          // ram the Thorn Field already claimed (pinned by contract test
          // AH-0MVM8GTG7002IRTL).
          if (this.getEffectsRegistry().tryConsumeThornsRam()) {
            this.onPlayerRamsEnemy(enemy);
            this._onThornsAbsorb(player.x, player.y);
          } else if (this._tryEnemyFieldAbsorbRam(enemy)) {
            // Enemy force field (epic AH-0MVJ8W4GE007OMNT AC2, Q6 = B): the
            // field absorbs the ram — one field hit consumed, both sides
            // survive, no player hit and no kill accounting (the enemy was
            // not destroyed, so `onPlayerRamsEnemy` must not run).
          } else {
            this.onPlayerRamsEnemy(enemy);
            this._hitPlayer();
          }
          break;
        }
      }
      if (this.onPlayerRamsBoss()) {
        if (this.getEffectsRegistry().tryConsumeThornsRam()) {
          this._onThornsAbsorb(player.x, player.y);
        } else {
          this._hitPlayer();
        }
      }
    }
  }

  /**
   * Shared Thorn Field absorb feedback: plays the distinct lime spike-shatter
   * burst and cue at the collision (AH-0MVJ8YKR70096C6T). Defined once here
   * because the ram branch above is shared, so an absorbed ram never reads
   * like a normal player hit — and no scene can hand-roll a divergent burst
   * (gym↔game parity, AH-0MUGZDTFX004RBD1).
   */
  protected _onThornsAbsorb(x: number, y: number): void {
    resolveThornsAbsorb(this, x, y, { registry: this.thornsAbsorbEffects });
  }

  /**
   * Enemy force-field ram absorption (epic AH-0MVJ8W4GE007OMNT AC2, operator
   * Q6 = B; AH-0MVM8GUZG008AWSU). Defined once in the shared core, mirroring
   * the Thorn Field `tryConsumeThornsRam` precedent, so the game and every
   * gym inherit one implementation and cannot diverge.
   *
   * While the rammed enemy still carries a field, the field absorbs the ram
   * through the entity's own `takeDamage()` seam — the field decrements and
   * the hull is untouched, so both sides survive and the player is not hit.
   * A shared re-arm ({@link ENEMY_FIELD_RAM_REARM_MS}) makes that exactly
   * **one field hit per contact**: a fresh overlap inside the window consumes
   * nothing (and does not hurt the player either). Once the field is down the
   * enemy's normal, pre-existing contact rule applies unchanged — this method
   * returns `false` and the caller runs `_hitPlayer()` (both destroyed,
   * AH-0MTV7JOLU006W8PT).
   *
   * @returns whether the ram was absorbed by the enemy's force field.
   */
  protected _tryEnemyFieldAbsorbRam(enemy: TEnemy): boolean {
    const field = enemy as unknown as {
      hasForceField?: boolean;
      takeDamage?: () => unknown;
    };
    // No field left (never shielded, or already broken): today's rule wins.
    if (field.hasForceField !== true || typeof field.takeDamage !== 'function') {
      return false;
    }
    // Inside the re-arm window the contact is already paid for: absorb it
    // silently rather than draining the field (or the player) frame by frame.
    if (this.time.now < this.enemyFieldRamReArmUntil) return true;
    // One field hit per contact, through the entity's single damage seam.
    field.takeDamage();
    this.enemyFieldRamReArmUntil = this.time.now + ENEMY_FIELD_RAM_REARM_MS;
    return true;
  }

  /**
   * Live Thorn Field absorb bursts (copy) — surfaced so tests can observe the
   * feedback without pixel assertions (mirrors the other effect registries).
   */
  getThornsAbsorbEffects(): Phaser.GameObjects.Graphics[] {
    return [...this.thornsAbsorbEffects];
  }

  /**
   * Resolves the shared collector-drone destruction pass: enemy bullets and
   * enemy bodies destroy a drone, scattering its held minerals plus the
   * `2 × level` destruction bonus at the crash site. Player bullets are not
   * considered here, so the player's own fire passes straight through.
   *
   * Defined once here so the game and every combat gym run the identical
   * rule (gym↔game parity, AH-0MV9G113S009B37I).
   */
  protected _resolveDronesVsEnemies(): void {
    if (this.drones.length === 0) return;
    const level = this.getDroneLevel();
    const field = this.getDroneMineralField();
    const bulletRadius = this.getEnemyBulletRadius();

    // Enemy bullets: an intercepted shot is consumed and the drone spills.
    const keptEnemy: TBullet[] = [];
    for (const eb of this.getEnemyBullets()) {
      let consumed = false;
      for (const drone of this.drones) {
        if (!drone.alive) continue;
        if (
          this._overlaps(
            eb.graphics.x,
            eb.graphics.y,
            bulletRadius,
            drone.x,
            drone.y,
            drone.getHitRadius(),
          )
        ) {
          field.push(...hitDrone(this, drone, 'enemy-bullet', level));
          eb.graphics.destroy();
          consumed = true;
          break;
        }
      }
      if (!consumed) keptEnemy.push(eb);
    }
    this.setEnemyBullets(keptEnemy);

    // Enemy bodies: contact destroys the drone (spawning enemies are still
    // growing, so they cannot touch it yet — same rule as every collision).
    for (const drone of this.drones) {
      if (!drone.alive) continue;
      for (const enemy of this.getEnemyEntities()) {
        if (!enemy.alive) continue;
        if ((enemy as unknown as { isSpawning?: boolean }).isSpawning) continue;
        if (
          this._overlaps(
            drone.x,
            drone.y,
            drone.getHitRadius(),
            enemy.x,
            enemy.y,
            enemy.getHitRadius(),
          )
        ) {
          field.push(...hitDrone(this, drone, 'enemy-body', level));
          break;
        }
      }
    }
  }

  /**
   * Resolves the per-identity impact feedback for an enemy shot reaching the
   * player (AH-0MV822CQL005R4MM): a small flash in the shot's own colour at
   * the impact point plus the existing per-enemy destruction cue — routed
   * through the same shared impact helpers (`spawnBulletImpact` +
   * `playBulletDestructionSound`) the interception path uses, so the game
   * and every gym read a Scout hit identically. A no-op for legacy bullets
   * without the identity `color` field (unchanged behaviour).
   */
  private _spawnEnemyBulletHitImpact(enemyBullet: TBullet): void {
    if (enemyBullet.color === undefined) return;
    playBulletDestructionSound();
    spawnBulletImpact(this, enemyBullet.graphics.x, enemyBullet.graphics.y, {
      registry: this.bulletImpactEffects,
      color: enemyBullet.color,
    });
  }

  /**
   * Reflects one enemy bullet back along its incoming direction as a
   * player-owned bullet (Gradius Force Field homage, AH-0MV1BIX1W006XF95).
   *
   * The reflected shot is spawned through the shared
   * {@link CombatCoreScene.spawnPlayerBullet} path, so it is an ordinary
   * player bullet that damages enemies through the same collision pass as the
   * cannon — the game and every gym reflect identically. The bullet is placed
   * at the enemy bullet's position with its velocity reversed ("back toward
   * its source") and given the shared Force Field lifetime.
   *
   * The caller owns the lifecycle: it destroys the enemy bullet's graphics
   * and drops it from the enemy-bullet list after this returns.
   *
   * @param enemyBullet - The enemy bullet meeting the field.
   * @returns The new player-owned reflected bullet.
   */
  protected _reflectEnemyBullet(enemyBullet: TBullet): PlayerBullet {
    return this.spawnPlayerBullet(
      enemyBullet.graphics.x,
      enemyBullet.graphics.y,
      -enemyBullet.vx,
      -enemyBullet.vy,
      FORCE_FIELD_COLOR,
      FORCE_FIELD_REFLECT_LIFETIME,
    );
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
    // Opt-out scenes never allocate the bar; an already-drawn bar is hidden so
    // a scene that becomes ineligible (e.g. level complete) cannot leave a
    // stale timer on screen.
    if (duration <= 0) {
      this.waveTimeoutBar?.setVisible(false);
      return;
    }
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
    this.thornsAbsorbEffects = [];
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.playerHitCount = 0;
    this.enemyFieldRamReArmUntil = 0;
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
    for (const effect of this.thornsAbsorbEffects) effect.destroy();
    this.thornsAbsorbEffects = [];
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.playerHitCount = 0;
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

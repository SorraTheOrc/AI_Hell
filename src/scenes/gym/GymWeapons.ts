/**
 * Gym scene — weapon power-ups (Spread, Dual, Rapid) with auto-fire,
 * cumulative collection, and Reset to cannon (GDD §2.3, §4.4).
 *
 * Threat-free: no enemies, no enemy bullets.  The player ship flies
 * around collecting weapon power-up drops; each collected drop **adds**
 * its weapon to the ship's active set for **10 seconds** (cumulative, no
 * replacement — the permanent cannon is always active), and each timed
 * weapon expires independently and silently stops firing afterwards. A
 * fourth power-up drop, **Reset**, clears all timed weapons, leaving
 * only the cannon (AC2/AC4).
 *
 * Spawn cadence (AC3): one drop on screen at a time, round-robin
 * **Spread → Dual → Rapid → Reset**, each living `WEAPON_DROP_LIFETIME`
 * (7 s, tunable) and stationary at a fixed position. Each drop grows
 * from scale 0 to full size on spawn and shrinks to nothing on despawn,
 * delta-time driven (framerate-independent, shared PowerUp lifecycle).
 * The next spawn coincides with the previous drop's despawn (one drop
 * on screen while nothing is collected).
 *
 * Auto-fire (AC1, AC3): the ship auto-fires **every active weapon** in the
 * direction of movement (current velocity heading; most-recent heading
 * when stationary) with no fire button (GDD §2.3). Each weapon fires at
 * its own independent fire rate; bullets of all active weapons are
 * emitted on the same fire cycle when their individual cooldowns have
 * elapsed.  Player bullets are demonstration-only: they fly in their
 * pattern, wrap across all four screen edges, and expire after their
 * per-weapon lifetime; no collision damage (AH-0MU960UTE001PTV0).
 *
 * Collection (AC4): a drop is collectible once its current scale is at
 * least 3% of full size; collection requires ship overlap (drop radius
 * + ship hull radius); collecting plays the pickup cue and applies the
 * weapon effect without pausing the next spawn's cadence.
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically.
 */

import Phaser from 'phaser';

import { CombatCoreScene, type CombatEnemyBullet, type CombatEnemyEntity } from '../core/CombatCoreScene';
import { Player } from '../../entities/Player';
import { advanceAndCull, PlayerBullet } from '../../entities/PlayerBullet';
import { WeaponId } from '../../utils/weapons';
import { EffectsRegistry } from '../../powerups/effects';
import type { DropId, WeaponDropId } from '../../powerups/types';
import { drawWeaponDrop, dropCollectRadius, WeaponDropIconId } from '../../powerups/icons';
import {
  playPowerUpSpawnSound,
  playPowerUpDespawnSound,
  playPowerUpCollectPopSound,
  playCannonFireSound,
  playSpreadFireSound,
  playDualFireSound,
  playRapidFireSound,
  playSpreadPickupSound,
  playDualPickupSound,
  playRapidPickupSound,
  playResetPickupSound,
} from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { addHelpButton, type GymHelpHandle } from '../../utils/gymHelp';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  WEAPON_DROP_LIFETIME,
  WEAPON_DROP_SIZE,
  SHIP_SIZE,
} from '../../core/constants';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';

/** A weapon-drop type: one of the three weapons, or 'reset'. */
type DropType = WeaponId | 'reset';

/** Round-robin spawn order (AC3): Spread → Dual → Rapid → Reset. */
const ROUND_ROBIN_ORDER: readonly DropType[] = ['spread', 'dual', 'rapid', 'reset'];

/** Deterministic spawn position — always the same spot for predictability. */
const SPAWN_POSITION = { x: GAME_WIDTH / 2, y: 100 };

/** A live drop on the field: pure lifecycle + world position + visuals. */
interface ActiveDrop {
  /** The drop's lifecycle/state (grow/hold/shrink/collect). */
  powerUp: PowerUp;
  /** The weapon type of this drop ('spread', 'dual', 'rapid', or 'reset'). */
  weaponType: DropType;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
  /** Graphics object rendering the drop's icon (scaled by lifecycle). */
  graphics: Phaser.GameObjects.Graphics;
  /** Whether the despawn sound has already played for this drop. */
  despawnSoundPlayed: boolean;
  /** True once collected and playing its absorb VFX (AC4). */
  absorbing?: boolean;
  /** Unified drop id for the shared collect path. */
  dropId: DropId;
  /** Weapon drop id for the shared collect path. */
  weaponDropId: WeaponDropId;
}

/**
 * Weapon power-ups gym. Extends the narrower shared
 * {@link CombatCoreScene} so auto-fire and drop collection flow through
 * the one shared implementation (the gym is threat-free, so it does not
 * need the combat-only collision/teleport surface).
 */
export class GymWeapons extends CombatCoreScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  ActiveDrop
> {
  private player: Player | null = null;
  private drops: ActiveDrop[] = [];
  /** Shared registry for the collect path (AC3). */
  private effectsRegistry = new EffectsRegistry();
  /** Per-scene round-robin spawner (fresh index per scene instance). */
  private roundRobinSpawner = new RoundRobinSpawner<DropType>(ROUND_ROBIN_ORDER);
  /** Countdown to the next round-robin spawn (starts at 0 → immediate first drop). */
  private spawnTimer = 0;
  /** Shared help affordance (AH-0MUAYB67I002REOZ). */
  private helpHandle: GymHelpHandle | null = null;

  constructor() {
    super({ key: 'GymWeapons' });
  }

  create(): void {
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);

    // Shared "← INDEX" button (reused by every gym).
    addBackToIndexButton(this);
    // Shared "Help (?)" button + overlay: lists every drop this gym can
    // spawn (cannon + Spread/Dual/Rapid/Reset), sourced from the shared
    // catalogues (AH-0MUAYB67I002REOZ).
    this.helpHandle = addHelpButton(this, {
      gymKey: 'GymWeapons',
      drops: ['cannon', ...ROUND_ROBIN_ORDER],
    });
    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    // Spawn the first drop immediately, then cycle every lifetime (AC3).
    this._spawnRoundRobin();
    this.spawnTimer = WEAPON_DROP_LIFETIME;

    // Release any in-flight absorb animations on shutdown/restart.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const anim of this.collectAnimations) anim.destroy();
      this.collectAnimations = [];
    });
  }

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds). Drives ship movement,
   * auto-fire, bullet lifecycle, the spawner, drop lifecycles, and
   * collection — used by the scene loop and by tests.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // ── Weapon timers: advance each timed weapon's 10 s countdown ──
    // Expired weapons are silently dropped before auto-fire so they
    // stop firing this step (AC2, AC5).
    this.player.tickWeaponTimers(dt * 1000);

    // ── Ship: input → thrust movement + screen-wrap ─────────────
    const input = this._readPlayerInput();
    if (input) {
      this.player.setInput(input);
    }
    this.player.physicsTick(dt, this.scale.width, this.scale.height);

    // ── Auto-fire: emit bullets per weapon fire rate (AC1) ──────
    this._autoFire(dt);

    // ── Bullet lifecycle: advance + wrap + lifetime expiry ─────
    this._advanceBullets(dt);

    // ── Drop lifecycles (grow/hold/shrink) ─────────────────────
    this.advanceDrops(dt);

    // ── Spawner: one drop per lifetime, round-robin (AC3) ──────
    // Ran after advanceDrops so a freshly spawned drop is not
    // over-advanced in the same frame; cadence is purely time-based
    // (collecting early does not pause the next spawn — AC4).
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer += WEAPON_DROP_LIFETIME;
      this._spawnRoundRobin();
    }

    // ── Overlap collection (gated by the ≥ 3% scale threshold) ─
    this.collectOverlapping();
    // Advance the absorb VFX for collected drops (cosmetic only).
    this._updateCollectAnimations(dt);
  }

  // ── Auto-fire cue (AC1, AC3) ─────────────────────────────────────

  /**
   * Shared auto-fire hook: plays each firing weapon's distinct cue once
   * per shot (not per bullet). The shared `_autoFire` spawns the bullets
   * into the inherited `playerBullets` list.
   */
  protected override onWeaponFired(weaponId: WeaponId): void {
    this._playShootCue(weaponId);
  }

  /**
   * Plays the shoot cue for one firing weapon. One cue per shot, keyed
   * off the firing weapon's id (AC — player shoot audio). Safe no-op
   * without an AudioContext.
   */
  private _playShootCue(weaponId: WeaponId): void {
    if (!this.player) return;
    switch (weaponId) {
      case 'cannon':
        playCannonFireSound();
        break;
      case 'spread':
        playSpreadFireSound();
        break;
      case 'dual':
        playDualFireSound();
        break;
      case 'rapid':
        playRapidFireSound();
        break;
    }
  }

  /** Advances all bullets by `dt` and removes those whose lifetime elapsed. */
  private _advanceBullets(dt: number): void {
    this.playerBullets = this.playerBullets.filter((b) => advanceAndCull(b, dt));
  }

  // ── Spawning / lifecycle (AC3, AC5) ──────────────────────────────

  /** Spawns the next round-robin drop (Spread → Dual → Rapid → Reset). */
  private _spawnRoundRobin(): void {
    const weaponType = this.roundRobinSpawner.next();
    this._spawnDrop(weaponType, SPAWN_POSITION.x, SPAWN_POSITION.y);
  }

  /**
   * Spawns a drop of the given type at a world position, with its icon
   * visuals (drawn at scale 0 → grows in). Public so tests can place a
   * drop deterministically, and used by the round-robin spawner.
   */
  spawnDrop(weaponType: DropType, x: number, y: number): ActiveDrop {
    return this._spawnDrop(weaponType, x, y);
  }

  private _spawnDrop(weaponType: DropType, x: number, y: number): ActiveDrop {
    const graphics = this.add.graphics();
    // Bubble + icon drawn in local space centred at its own origin (0,0) so
    // `setScale` grows it about its centre; position the graphics at
    // the drop's world position.
    graphics.setPosition(x, y);
    drawWeaponDrop(graphics, weaponType as WeaponDropIconId, 0, 0, WEAPON_DROP_SIZE);
    // Start at scale 0 — the lifecycle grows it in (AC3).
    graphics.setScale(0);

    const drop: ActiveDrop = {
      powerUp: new PowerUp(
        'dummy',
        undefined,
        undefined,
        WEAPON_DROP_LIFETIME,
      ),
      weaponType,
      x,
      y,
      graphics,
      despawnSoundPlayed: false,
      dropId: weaponType as DropId,
      weaponDropId: weaponType as WeaponDropId,
    };
    this.drops.push(drop);
    playPowerUpSpawnSound(); // AC6 spawn cue
    return drop;
  }

  /**
   * Advances every drop's lifecycle by `dt` seconds (grow/hold/shrink),
   * scaling its icon to match, and plays the despawn cue when a drop
   * fades away uncollected (AC6).
   */
  advanceDrops(dt: number): void {
    const kept: ActiveDrop[] = [];
    for (const drop of this.drops) {
      // An absorbing drop is owned by its animation — never re-process it.
      if (drop.absorbing) continue;
      drop.powerUp.advance(dt);
      // Icon scale tracks the lifecycle scale factor (0 → 1 → 0).
      drop.graphics.setScale(drop.powerUp.currentScale);
      if (drop.powerUp.state === PowerUpState.DESPAWNED) {
        if (!drop.despawnSoundPlayed) {
          playPowerUpDespawnSound(); // AC6 despawn cue
          drop.despawnSoundPlayed = true;
        }
        // Remove the drop's visuals from the display list.
        drop.graphics.destroy();
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  // ── Collection (AC2, AC4, AC6) ───────────────────────────────────

  /**
   * Collects drops overlapping the ship hull when they are above the 3%
   * scale threshold.  A collected drop applies its weapon effect
   * (equip or reset) exactly once and is removed; an uncollected drop
   * that fades away applies nothing.
   */
  /**
   * Checks all drops for overlap collection (public so tests can drive
   * the collection gate deterministically without advancing lifecycles).
   */
  collectOverlapping(): void {
    if (!this.player) return;
    const hull = SHIP_SIZE / 2;
    const kept: ActiveDrop[] = [];
    for (const drop of this.drops) {
      // Collection gated by the shared ≥ 3% scale lifecycle (AC4).
      if (!drop.absorbing && drop.powerUp.canCollect() && this._overlapsShip(drop, hull)) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  private _overlapsShip(drop: ActiveDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = dropCollectRadius(WEAPON_DROP_SIZE, drop.powerUp.currentScale);
    const dist = Math.hypot(this.player.x - drop.x, this.player.y - drop.y);
    return dist <= hull + dropRadius;
  }

  // ── Shared collect-path hooks (AC2, AC3, AC6) ───────────────────

  /** Shared registry consumed by the collect path (AC3). */
  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  /** Per-type weapon/Reset activation cue (the shared path equips first). */
  protected override onWeaponCollected(drop: ActiveDrop): void {
    switch (drop.weaponType) {
      case 'reset':
        playResetPickupSound();
        break;
      case 'spread':
        playSpreadPickupSound();
        break;
      case 'dual':
        playDualPickupSound();
        break;
      case 'rapid':
        playRapidPickupSound();
        break;
    }
  }

  /** Generic collection pop, played alongside the per-type weapon cue. */
  protected override _playPickupCue(_drop: ActiveDrop): void {
    try {
      playPowerUpCollectPopSound();
    } catch {
      /* ignore */
    }
  }

  // ── Public test accessors ─────────────────────────────────────────

  getPlayer(): Player | null {
    return this.player;
  }

  /** Arrow-key bindings for the player (undefined when no keyboard). */
  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined {
    return this.cursors;
  }

  /** WASD bindings for the player (undefined when no keyboard). */
  getWasd(): WasdKeysLike | undefined {
    return this.wasd;
  }

  getDrops(): ActiveDrop[] {
    return [...this.drops];
  }

  /** In-flight absorb animations for collected drops (test seam). */
  getCollectAnimations(): CollectAnimationHandle[] {
    return [...this.collectAnimations];
  }

  getBullets(): PlayerBullet[] {
    return [...this.playerBullets];
  }

  /**
   * Advances bullets by the given delta time. Public for testing.
   */
  advanceBullets(dt: number): void {
    this.playerBullets = this.playerBullets.filter((b) => advanceAndCull(b, dt));
  }

  /** The shared help button/overlay handle (AH-0MUAYB67I002REOZ). */
  getHelpHandle(): GymHelpHandle | null {
    return this.helpHandle;
  }
}
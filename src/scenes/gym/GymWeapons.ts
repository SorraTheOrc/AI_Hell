/**
 * Gym scene — weapon power-ups (Spread, Dual, Rapid) with auto-fire,
 * persistent switching, and Reset to cannon (GDD §2.3, §4.4).
 *
 * Threat-free: no enemies, no enemy bullets.  The player ship flies
 * around collecting weapon power-up drops; each collected drop swaps
 * the ship's weapon **persistently** (no timer — active until another
 * weapon power-up is collected).  A fourth power-up drop, **Reset**,
 * returns the ship to the starting cannon (AC2).
 *
 * Spawn cadence (AC3): one drop on screen at a time, round-robin
 * **Spread → Dual → Rapid → Reset**, each living `WEAPON_DROP_LIFETIME`
 * (7 s, tunable) and stationary at a fixed position. Each drop grows
 * from scale 0 to full size on spawn and shrinks to nothing on despawn,
 * delta-time driven (framerate-independent, shared PowerUp lifecycle).
 * The next spawn coincides with the previous drop's despawn (one drop
 * on screen while nothing is collected).
 *
 * Auto-fire (AC1): the ship auto-fires its equipped weapon in the
 * direction of movement (current velocity heading; most-recent heading
 * when stationary) with no fire button (GDD §2.3).  Bullet emission is
 * gated by the weapon's fire rate.  Player bullets are
 * demonstration-only: they fly in their pattern and are removed
 * off-screen; no collision damage.
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

import { Player } from '../../entities/Player';
import {
  createPlayerBullet,
  advanceAndCull,
  PlayerBullet,
} from '../../entities/PlayerBullet';
import {
  WeaponId,
  createBulletsFromHeading,
  angleToVelocity,
} from '../../utils/weapons';
import { drawWeaponIcon, WeaponDropIconId } from '../../powerups/icons';
import {
  playPowerUpSpawnSound,
  playPowerUpDespawnSound,
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
import { addBackToIndexButton } from '../../utils/gymNavigation';
import {
  AsteroidsInputHandler,
  ControlInput,
  FourDirectionalInputHandler,
} from '../../utils/movementModel';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  WEAPON_DROP_LIFETIME,
  WEAPON_DROP_SIZE,
  PLAYER_BULLET_SPEED,
  PLAYER_BULLET_RADIUS,
  SHIP_SIZE,
} from '../../core/constants';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';

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
}

export class GymWeapons extends Phaser.Scene {
  private player: Player | null = null;
  private drops: ActiveDrop[] = [];
  /** Per-scene round-robin spawner (fresh index per scene instance). */
  private roundRobinSpawner = new RoundRobinSpawner<DropType>(ROUND_ROBIN_ORDER);
  /** Countdown to the next round-robin spawn (starts at 0 → immediate first drop). */
  private spawnTimer = 0;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;
  /** Pluggable input handlers (one per control scheme, mirrors GymPlayer). */
  private fourDirHandler = new FourDirectionalInputHandler();
  private asteroidsHandler = new AsteroidsInputHandler();
  /** Active player bullets (demonstration only). */
  private bullets: PlayerBullet[] = [];

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

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    // Spawn the first drop immediately, then cycle every lifetime (AC3).
    this._spawnRoundRobin();
    this.spawnTimer = WEAPON_DROP_LIFETIME;
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

    // ── Ship: input → thrust movement + screen-wrap ─────────────
    const input = this._readInput();
    if (input) {
      this.player.setInput(input);
    }
    this.player.physicsTick(dt, this.scale.width, this.scale.height);

    // ── Auto-fire: emit bullets per weapon fire rate (AC1) ──────
    this._autoFire(dt);

    // ── Bullet lifecycle: advance + cull off-screen ────────────
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
  }

  // ── Auto-fire (AC1) ──────────────────────────────────────────────

  /**
   * Auto-fires the equipped weapon when its cooldown has elapsed.
   * Bullets spawn in the direction of travel (or the most-recent
   * heading when stationary) using the weapon's pattern.
   */
  private _autoFire(dt: number): void {
    if (!this.player) return;

    // tryFire decrements the cooldown and returns true when a shot is
    // due, re-arming the cooldown to the weapon's fire rate.
    if (!this.player.tryFire(dt)) return;

    // AC — player shoot audio: play the equipped weapon's distinct
    // cue exactly once per shot (not per bullet) so fast weapons stay
    // legible.
    this._playShootCue();

    const headingDeg = (this.player.getHeading() * 180) / Math.PI;
    const weaponDef = this.player.getWeaponDef();
    const bulletDescs = createBulletsFromHeading(
      weaponDef,
      headingDeg,
      this.player.x,
      this.player.y,
    );

    for (const bd of bulletDescs) {
      const vel = angleToVelocity(bd.angleDeg, PLAYER_BULLET_SPEED);
      this.bullets.push(
        createPlayerBullet(
          this,
          bd.x,
          bd.y,
          bd.color,
          PLAYER_BULLET_RADIUS,
          vel.vx,
          vel.vy,
        ),
      );
    }
  }

  /**
   * Plays the shoot cue for the player's currently equipped weapon.
   * One cue per shot, keyed off `getEquippedWeapon()` (AC — player
   * shoot audio). Safe no-op without an AudioContext.
   */
  private _playShootCue(): void {
    if (!this.player) return;
    switch (this.player.getEquippedWeapon()) {
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

  /** Advances all bullets by `dt` and removes off-screen ones. */
  private _advanceBullets(dt: number): void {
    this.bullets = this.bullets.filter((b) =>
      advanceAndCull(b, dt, this.scale.width, this.scale.height),
    );
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
    // Icon drawn in local space centred at its own origin (0,0) so
    // `setScale` grows it about its centre; position the graphics at
    // the drop's world position.
    graphics.setPosition(x, y);
    drawWeaponIcon(graphics, weaponType as WeaponDropIconId, 0, 0, WEAPON_DROP_SIZE);
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
      if (drop.powerUp.canCollect() && this._overlapsShip(drop, hull)) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  private _overlapsShip(drop: ActiveDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = WEAPON_DROP_SIZE * drop.powerUp.currentScale;
    const dist = Math.hypot(this.player.x - drop.x, this.player.y - drop.y);
    return dist <= hull + dropRadius;
  }

  /**
   * Applies the drop's weapon effect (equip or reset to cannon),
   * plays the appropriate cue, and removes the drop.
   *
   * AC — pickup activation audio: each weapon pickup (Spread, Dual,
   * Rapid, Reset) plays a unique activation sound on collection,
   * distinct from the generic `playPowerUpCollectSound()` and
   * `playWeaponChangeSound()`.
   */
  private _collectDrop(drop: ActiveDrop): void {
    if (!this.player) return;

    if (drop.weaponType === 'reset') {
      this.player.resetWeapon(); // AC2 — Reset returns to cannon
      playResetPickupSound();
    } else {
      this.player.equipWeapon(drop.weaponType); // AC2 — persistent switch
      switch (drop.weaponType) {
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

    // Remove the drop's visuals.
    drop.graphics.destroy();
  }

  // ── Input ─────────────────────────────────────────────────────────

  /**
   * Reads the current held-key state into the scheme-appropriate
   * `ControlInput`, keyed off the player's saved control scheme (mirrors
   * GymPlayer._readInput — parent AC3). Returns null when no keyboard is
   * available or the player is absent.
   */
  private _readInput(): ControlInput | null {
    if (!this.player || !this.cursors || !this.wasd) return null;
    const raw = { cursors: this.cursors, wasd: this.wasd };
    return this.player.getScheme() === 'asteroids'
      ? this.asteroidsHandler.mapInput(raw)
      : this.fourDirHandler.mapInput(raw);
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

  getBullets(): PlayerBullet[] {
    return [...this.bullets];
  }

  /**
   * Advances bullets by the given delta time. Public for testing.
   */
  advanceBullets(dt: number): void {
    this.bullets = this.bullets.filter((b) =>
      advanceAndCull(b, dt, this.scale.width, this.scale.height),
    );
  }
}
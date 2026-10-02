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
 * per-weapon lifetime; no collision damage (AH-0MU960UTE001PTV0). Their
 * lifecycle is owned by the shared `scenes/core/bulletLifecycle.ts`
 * helper (`advancePlayerBullets`), AH-0MUII3CF00024EDM.
 *
 * Collection (AC4): a drop is collectible once its current scale is at
 * least 3% of full size; collection requires ship overlap (drop radius
 * + ship hull radius); collecting plays the pickup cue and applies the
 * weapon effect without pausing the next spawn's cadence.
 *
 * The drop lifecycle, collection gate, P9 magnet and per-type pickup cues
 * run through the shared `src/scenes/core/dropLayer.ts` template methods
 * (`_advanceDropLifecycles`, `_collectOverlappingDrops`, `_applyDropMagnet`,
 * `_playPickupCue`), so the gym cannot drift from the game; only the
 * round-robin spawn *source* and its spawn/despawn cues are gym-specific
 * (AH-0MUII3CXX0023H24, gap 4).
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically.
 */

import Phaser from 'phaser';

import {
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from '../core/CombatCoreScene';
import { CombatScene } from '../core/CombatScene';
import { Player } from '../../entities/Player';
import { advancePlayerBullets } from '../core/bulletLifecycle';
import { PlayerBullet } from '../../entities/PlayerBullet';
import { WeaponId } from '../../utils/weapons';
import { EffectsRegistry } from '../../powerups/effects';
import type { DropId, WeaponDropId } from '../../powerups/types';
import { drawWeaponDrop, WeaponDropIconId } from '../../powerups/icons';
import {
  playPowerUpSpawnSound,
  playPowerUpDespawnSound,
  playCannonFireSound,
  playSpreadFireSound,
  playDualFireSound,
  playRapidFireSound,
  playNovaFireSound,
  playMortarFireSound,
  playArcFireSound,
} from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { addHelpButton, type GymHelpHandle } from '../../utils/gymHelp';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  WEAPON_DROP_LIFETIME,
  WEAPON_DROP_SIZE,
} from '../../core/constants';
import { PowerUp } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';

/** A weapon-drop type: one of the weapons, or 'reset'. */
type DropType = WeaponId | 'reset';

/**
 * Round-robin spawn order (AC3, parent AH-0MQUYHY0000MZ2F): the three
 * conventional weapons, the three AOE weapons, then Reset. Interleaving the
 * AOE family means the weapon gym demonstrates every fire mode.
 */
const ROUND_ROBIN_ORDER: readonly DropType[] = [
  'spread',
  'dual',
  'rapid',
  'nova',
  'mortar',
  'arc',
  'reset',
];

/**
 * Practice-target layout offsets (px, relative to the arena centre). The
 * centre target sits nearest the ship so Nova catches it; the two upper
 * targets sit within the Arc chain reach of the centre and of each other
 * (so the chain visits all three) while staying outside the Nova ring.
 *
 * Intentional divergence (F6 AC5): the game has no static targets.
 */
const PRACTICE_TARGET_OFFSETS: readonly { x: number; y: number }[] = [
  { x: 0, y: -60 },
  { x: -60, y: -120 },
  { x: 60, y: -120 },
];

/** Hit radius (px) of a practice target. */
const PRACTICE_TARGET_RADIUS = 14;

/** Delay (s) after the last target dies before the tripod respawns. */
const PRACTICE_TARGET_RESPAWN_DELAY = 2.0;

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
 * An inert practice target for the weapon gym: a static neon ring that AOE
 * weapons can damage/destroy so their area effects (Nova ring damage, Mortar
 * blast, Arc chain) are visible. It never moves and never fires, so the gym
 * stays threat-free.
 *
 * Intentional divergence (F6 AC5): the game has no such static targets —
 * they exist only to make the weapon gallery legible. They are included in
 * `getEnemyEntities()` so the shared AOE resolution reaches them exactly as
 * it would reach a real enemy.
 */
class TrainingTarget
  extends Phaser.GameObjects.Graphics
  implements CombatEnemyEntity
{
  alive = true;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, { x, y });
    this.lineStyle(2, 0x44ff88, 1);
    this.strokeCircle(0, 0, PRACTICE_TARGET_RADIUS);
    this.strokeCircle(0, 0, PRACTICE_TARGET_RADIUS * 0.5);
  }

  getHitRadius(): number {
    return PRACTICE_TARGET_RADIUS;
  }

  destroySelf(): void {
    this.alive = false;
    this.destroy();
  }
}

/**
 * Weapon power-ups gym. Extends the shared {@link CombatScene} core so
 * auto-fire, drop collection **and the shared AOE dispatch/VFX** flow through
 * the one implementation (parent AH-0MQUYHY0000MZ2F AC1/AC3). It remains
 * threat-free: the only entities are inert {@link TrainingTarget}s that exist
 * solely so the AOE area effects are visible.
 */
export class GymWeapons extends CombatScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  ActiveDrop
> {
  private player: Player | null = null;
  private drops: ActiveDrop[] = [];
  /** Inert AOE practice targets (see {@link TrainingTarget}). */
  private targets: TrainingTarget[] = [];
  /** Seconds elapsed since every practice target was destroyed. */
  private targetRespawnTimer = 0;
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
    // Reset shared + scene-owned per-run state so a stop/restart of the
    // same instance starts clean (AH-0MUII3FYN0072QRT, gap 10).
    this.resetRunState();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);

    // Shared "← INDEX" button (reused by every gym).
    addBackToIndexButton(this);
    // Shared "Help (?)" button + overlay: lists every drop this gym can
    // spawn (cannon + the conventional and AOE weapon drops + Reset),
    // sourced from the shared catalogues (AH-0MUAYB67I002REOZ).
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

    // Inert practice targets so the AOE area effects are visible (F6 AC3).
    this._spawnPracticeTargets();

    // Tear down all scene-owned objects on shutdown so a stop/restart of
    // the same instance leaks nothing (AH-0MUII3FYN0072QRT, gap 10).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());
  }

  /**
   * Resets shared per-run state (effects registry + bullet/animation
   * registries via the core) plus this gym's player, drops and spawn
   * timer (AH-0MUII3FYN0072QRT, gap 10).
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.drops = [];
    this.targets = [];
    this.targetRespawnTimer = 0;
    this.spawnTimer = 0;
    this.helpHandle = null;
  }

  /**
   * Destroys every scene-owned object on `SHUTDOWN` after the shared core
   * teardown has run, so a stop/restart leaks nothing (AC2).
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    for (const drop of this.drops) drop.graphics.destroy();
    this.drops = [];
    for (const target of this.targets) target.destroy();
    this.targets = [];
    this.player?.destroy();
    this.player = null;
    this.helpHandle = null;
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

    // ── Shared player-control step: timers → multipliers → input →
    // physics → auto-fire (AH-0MUII39KX007YUQ0, AC1).
    this._tickPlayer(dt);

    // ── Bullet lifecycle: advance + wrap + lifetime expiry ─────
    this._advanceBullets(dt);

    // ── Drop lifecycles (grow/hold/shrink) ─────────────────────
    this._applyDropMagnet(this.drops, dt);
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

    // Respawn the practice targets a short delay after the AOE weapons
    // have cleared them, so every AOE weapon can be demonstrated again
    // (F6 AC3).
    this._advanceTargetRespawn(dt);
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
      case 'nova':
        playNovaFireSound();
        break;
      case 'mortar':
        playMortarFireSound();
        break;
      case 'arc':
        playArcFireSound();
        break;
    }
  }

  /** Advances all bullets by `dt` and removes those whose lifetime elapsed. */
  private _advanceBullets(dt: number): void {
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);
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
  /**
   * Advances every drop's lifecycle by `dt` seconds through the shared
   * helper (grow/hold/shrink) and plays the despawn cue when an uncollected
   * drop fades away (AC6). Public test seam.
   */
  advanceDrops(dt: number): void {
    this.drops = this._advanceDropLifecycles(this.drops, dt, (drop) =>
      this._playDespawnCue(drop),
    );
  }

  /** Plays the weapon-drop despawn cue once per drop (AC6). */
  private _playDespawnCue(drop: ActiveDrop): void {
    if (drop.despawnSoundPlayed) return;
    playPowerUpDespawnSound();
    drop.despawnSoundPlayed = true;
  }

  /**
   * Collects drops overlapping the ship hull when they are above the 3%
   * scale threshold, through the shared collection gate. Public test seam.
   */
  collectOverlapping(): void {
    this.drops = this._collectOverlappingDrops(this.drops);
  }

  // ── Shared collect-path hooks (AC2, AC3, AC6) ───────────────────

  /** Shared registry consumed by the collect path (AC3). */
  override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  // ── Public test accessors ─────────────────────────────────────────

  getPlayer(): Player | null {
    return this.player;
  }

  // ── Shared-combat participant contract (AOE demonstration) ──────

  /**
   * The gym's only entities: inert {@link TrainingTarget}s (F6 AC3). They are
   * exposed through the shared participant contract so the shared AOE
   * resolution reaches them exactly as it reaches a real enemy. There are no
   * enemy bullets in this threat-free gym.
   */
  protected override getEnemyEntities(): readonly CombatEnemyEntity[] {
    return this.targets;
  }

  /** No enemy bullets exist in the threat-free weapon gym. */
  protected override getEnemyBullets(): readonly CombatEnemyBullet[] {
    return [];
  }

  /** No enemy bullets exist, so this is a no-op. */
  protected override setEnemyBullets(
    _bullets: CombatEnemyBullet[],
  ): void {}

  /** Live practice targets (test seam). */
  getTargets(): readonly TrainingTarget[] {
    return this.targets;
  }

  /** Live AOE effect graphics (test seam, F6 AC3). */
  getAoeEffects(): Phaser.GameObjects.Graphics[] {
    return this.aoeEffects;
  }

  /** Spawns the inert AOE practice-target tripod (F6 AC3). */
  private _spawnPracticeTargets(): void {
    for (const offset of PRACTICE_TARGET_OFFSETS) {
      const target = new TrainingTarget(
        this,
        GAME_WIDTH / 2 + offset.x,
        GAME_HEIGHT / 2 + offset.y,
      );
      this.add.existing(target);
      this.targets.push(target);
    }
  }

  /**
   * Respawns the practice targets after a short delay once every one has
   * been destroyed, so the AOE weapons can be demonstrated repeatedly. A
   * no-op while any target is still alive, and the delay lets the player
   * (and tests) observe the cleared state.
   */
  private _advanceTargetRespawn(dt: number): void {
    if (this.targets.length === 0) return;
    if (!this.targets.every((target) => !target.alive)) {
      this.targetRespawnTimer = 0;
      return;
    }
    this.targetRespawnTimer += dt;
    if (this.targetRespawnTimer < PRACTICE_TARGET_RESPAWN_DELAY) return;
    this.targetRespawnTimer = 0;
    this.targets = [];
    this._spawnPracticeTargets();
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
   * Advances bullets by the given delta time. Public for testing; delegates
   * to the same shared helper as the per-frame path (no duplicate body).
   */
  advanceBullets(dt: number): void {
    this._advanceBullets(dt);
  }

  /** The shared help button/overlay handle (AH-0MUAYB67I002REOZ). */
  getHelpHandle(): GymHelpHandle | null {
    return this.helpHandle;
  }
}
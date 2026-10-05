/**
 * Gym scene — **weapon leveling** demonstration (parent AH-0MUPMPCB2009J54J).
 *
 * A threat-free gallery that makes the whole leveling system legible:
 *
 * - **Temporary leveling:** a weapon drop (Spread → Dual → Rapid → Nova →
 *   Mortar → Arc → Reset) spawns on a round-robin cadence; collecting it
 *   **levels that weapon up** and re-activates its 10 s timer. Re-collecting
 *   the same weapon keeps raising its run-scoped level.
 * - **Permanent leveling:** a mineral hold fills as minerals are collected;
 *   on hold-full the shared `MineralChoiceScene` offers (among others) a
 *   permanent **level-up** for every weapon already owned. Choosing one
 *   permanently levels the weapon for the rest of the run.
 * - **Visible MVP variables:** the HUD shows each active weapon's level, and
 *   the four producer-confirmed MVP upgrades are all observable — fire rate
 *   (cadence), projectile count (more bullets per shot), bullet size (larger
 *   bullets) and AoE radius (larger Nova ring / Mortar blast / Arc reach).
 *
 * Everything runs through the **shared** combat core + level resolver, so the
 * gym cannot drift from the game (gym↔game parity, AGENTS.md). The only
 * gym-specific parts are the deterministic spawn source and the display of a
 * level readout; there are no bespoke copies of weapon behaviour.
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention.
 *
 * @module src/scenes/gym/GymWeaponLeveling
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
import { drawWeaponDrop, type WeaponDropIconId } from '../../powerups/icons';
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
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  WEAPON_DROP_LIFETIME,
  WEAPON_DROP_SIZE,
} from '../../core/constants';
import { PowerUp } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';
import { Mineral } from '../../entities/Mineral';
import { HUD } from '../../ui/HUD';
import { MineralHold } from '../../core/mineralHold';
import type { ChoiceOption, ChoiceStrategy } from '../../powerups/choice';
import {
  buildChoiceCandidates,
  CHOICE_POOL,
} from '../../powerups/choice';
import { applyMineralChoiceReward } from '../core/mineralLayer';

/** The weapon-drop types this gym cycles (everything except Reset). */
const LEVELING_DROP_ORDER: readonly WeaponDropId[] = [
  'spread',
  'dual',
  'rapid',
  'nova',
  'mortar',
  'arc',
];

/** Deterministic drop spawn position (top-centre, easy to fly into). */
const SPAWN_POSITION = { x: GAME_WIDTH / 2, y: 100 };

/** Minerals granted by each collected mineral in the gym. */
const MINERAL_COLLECT_AMOUNT = 1;

/** First hold capacity — small so the choice is demonstrable quickly. */
const GYM_HOLD_CAPACITY = 3;

/** Hint line shown at the bottom of the gym. */
export const GYM_WEAPON_LEVELING_HINT =
  'Weapon Leveling — collect weapon drops to level up; fill the hold for a permanent level-up';

/** A live weapon drop on the field. */
interface LevelingDrop {
  /** Lifecycle/state (grow/hold/shrink/collect). */
  powerUp: PowerUp;
  /** The weapon type of this drop. */
  weaponType: WeaponDropId;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
  /** Icon graphics (scaled by the lifecycle). */
  graphics: Phaser.GameObjects.Graphics;
  /** Whether the despawn sound has played. */
  despawnSoundPlayed: boolean;
  /** True once collected (absorb VFX playing). */
  absorbing?: boolean;
  /** Unified drop id for the shared collect path. */
  dropId: DropId;
  /** Weapon drop id for the shared collect path. */
  weaponDropId: WeaponDropId;
}

/** A live mineral on the field. */
interface LevelingMineral {
  /** The mineral entity (stationary gold dot). */
  entity: Mineral;
  /** Reap the mineral (called on collection). */
  destroy: () => void;
}

/**
 * Weapon leveling gym. Extends the shared {@link CombatScene} core so
 * auto-fire, drop collection, AOE dispatch and the level-resolved definition
 * all flow through the one implementation (parent AH-0MUPMPCB2009J54J).
 */
export class GymWeaponLeveling extends CombatScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  LevelingDrop
> {
  private player: Player | null = null;
  private drops: LevelingDrop[] = [];
  private minerals: LevelingMineral[] = [];
  private effectsRegistry = new EffectsRegistry();
  private hud: HUD | null = null;
  private roundRobinSpawner = new RoundRobinSpawner<WeaponDropId>(
    LEVELING_DROP_ORDER,
  );
  private spawnTimer = 0;
  private mineralTimer = 0;
  private hold = new MineralHold({ capacity: GYM_HOLD_CAPACITY, growthMultiplier: 2 });
  private mineralChoiceOptions: ChoiceOption[] = [];
  private mineralChoiceOpen = false;
  private mineralChoiceStrategy: ChoiceStrategy = {
    choose: (count, _rng, context) => {
      // Prefer a weapon level-up offer so the permanent path is always
      // demonstrable, then fill the remaining slots from the base pool.
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const levelUps = candidates.filter((o) => o.kind === 'weapon-level');
      const others = candidates.filter((o) => o.kind !== 'weapon-level');
      const picked: ChoiceOption[] = [];
      if (levelUps.length > 0) picked.push(levelUps[0]);
      for (const option of [...levelUps.slice(1), ...others]) {
        if (picked.length >= count) break;
        if (!picked.some((p) => p.id === option.id && p.kind === option.kind)) {
          picked.push(option);
        }
      }
      return picked.slice(0, count);
    },
  };

  constructor() {
    super({ key: 'GymWeaponLeveling' });
  }

  create(): void {
    this.resetRunState();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT - 80,
    });
    this.add.existing(this.player);

    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    // HUD with the per-weapon level readout wired to the live player.
    this.hud = new HUD(this, this.effectsRegistry, {
      showLives: false,
      getWeaponLevel: (id) => this.player?.getWeaponLevel(id as WeaponId) ?? 0,
    });
    this.hud.setMineralStore(this.hold.store, this.hold.capacity);

    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 18, GYM_WEAPON_LEVELING_HINT, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#88ffcc',
    }).setOrigin(0.5, 1);

    this._spawnRoundRobin();
    this.spawnTimer = WEAPON_DROP_LIFETIME;

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.teardownRunState(),
    );
  }

  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.drops = [];
    this.minerals = [];
    this.hud = null;
    this.spawnTimer = 0;
    this.mineralTimer = 0;
    this.hold = new MineralHold({ capacity: GYM_HOLD_CAPACITY, growthMultiplier: 2 });
    this.mineralChoiceOptions = [];
    this.mineralChoiceOpen = false;
  }

  protected override teardownRunState(): void {
    super.teardownRunState();
    for (const drop of this.drops) drop.graphics.destroy();
    this.drops = [];
    for (const mineral of this.minerals) mineral.destroy();
    this.minerals = [];
    this.player?.destroy();
    this.player = null;
    this.hud = null;
  }

  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /** One deterministic simulation step (seconds). */
  tick(dt: number): void {
    if (!this.player) return;

    this._tickPlayer(dt);
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);

    this._applyDropMagnet(this.drops, dt);
    this.advanceDrops(dt);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer += WEAPON_DROP_LIFETIME;
      this._spawnRoundRobin();
    }

    // Periodic mineral so the hold fills without player action being
    // required (the choice demonstrates permanent leveling).
    this.mineralTimer -= dt;
    if (this.mineralTimer <= 0) {
      this.mineralTimer += 2.0;
      this._spawnMineral();
    }

    this.collectOverlapping();
    this._updateCollectAnimations(dt);
    this._collectMineralsOverlapping();

    this.effectsRegistry.tick(dt);
    this.hud?.setMineralStore(this.hold.store, this.hold.capacity);
    this.hud?.refresh();

    if (this.hold.isFull && !this.mineralChoiceOpen) {
      this.openMineralChoice();
    }
  }

  protected override onWeaponFired(weaponId: WeaponId): void {
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

  // ── Spawning / lifecycle ─────────────────────────────────────────

  private _spawnRoundRobin(): void {
    this.spawnDrop(this.roundRobinSpawner.next(), SPAWN_POSITION.x, SPAWN_POSITION.y);
  }

  /** Spawns a weapon drop at (x, y). Public test seam. */
  spawnDrop(weaponType: WeaponDropId, x: number, y: number): LevelingDrop {
    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    drawWeaponDrop(graphics, weaponType as WeaponDropIconId, 0, 0, WEAPON_DROP_SIZE);
    graphics.setScale(0);

    const drop: LevelingDrop = {
      powerUp: new PowerUp('dummy', undefined, undefined, WEAPON_DROP_LIFETIME),
      weaponType,
      x,
      y,
      graphics,
      despawnSoundPlayed: false,
      dropId: weaponType,
      weaponDropId: weaponType,
    };
    this.drops.push(drop);
    playPowerUpSpawnSound();
    return drop;
  }

  advanceDrops(dt: number): void {
    this.drops = this._advanceDropLifecycles(this.drops, dt, (drop) => {
      if (!drop.despawnSoundPlayed) {
        playPowerUpDespawnSound();
        drop.despawnSoundPlayed = true;
      }
    });
  }

  collectOverlapping(): void {
    this.drops = this._collectOverlappingDrops(this.drops);
  }

  /** Spawns a mineral at a random position. Public test seam. */
  spawnMineral(x?: number, y?: number): LevelingMineral {
    const px = x ?? 80 + Math.random() * (GAME_WIDTH - 160);
    const py = y ?? 120 + Math.random() * (GAME_HEIGHT - 240);
    const entity = new Mineral(this, { x: px, y: py });
    const mineral: LevelingMineral = {
      entity,
      destroy: () => entity.destroy(),
    };
    this.minerals.push(mineral);
    return mineral;
  }

  private _spawnMineral(): void {
    this.spawnMineral();
  }

  /** Collects minerals overlapping the ship, filling the hold. Public seam. */
  collectMineralsOverlapping(): void {
    this._collectMineralsOverlapping();
  }

  private _collectMineralsOverlapping(): void {
    const player = this.player;
    if (!player) return;
    const collectRadius = 18;
    const remaining: LevelingMineral[] = [];
    for (const mineral of this.minerals) {
      const dx = mineral.entity.x - player.x;
      const dy = mineral.entity.y - player.y;
      if (dx * dx + dy * dy <= collectRadius * collectRadius) {
        this.hold.collect(MINERAL_COLLECT_AMOUNT);
        mineral.destroy();
      } else {
        remaining.push(mineral);
      }
    }
    this.minerals = remaining;
  }

  // ── Hold-full choice (permanent leveling) ────────────────────────

  /** Opens the hold-full choice overlay. Public test seam. */
  openMineralChoice(): ChoiceOption[] {
    if (this.mineralChoiceOpen) return [...this.mineralChoiceOptions];
    this.mineralChoiceOptions = this.mineralChoiceStrategy.choose(3, undefined, {
      weaponLevels: this.player?.getWeaponLevels() ?? [],
      // Offer level-ups for power-ups the player already owns (AH-0MUV5CLVO002ZHS9).
      powerUpLevels: this.player?.getPowerUpLevels() ?? [],
    });
    this.mineralChoiceOpen = true;
    this.scene.launch('MineralChoiceScene', {
      options: [...this.mineralChoiceOptions],
      onSelect: (index: number) => this.selectMineralChoice(index),
    });
    this.scene.pause();
    return [...this.mineralChoiceOptions];
  }

  /** Applies the chosen option permanently. Public test seam. */
  selectMineralChoice(index: number): ChoiceOption | null {
    const option = this.mineralChoiceOptions[index];
    if (!option) return null;
    applyMineralChoiceReward(option, this.effectsRegistry, this.player);
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.hold.resolve();
    if (this.scene.manager.getScene('MineralChoiceScene')) {
      this.scene.resume();
    }
    return option;
  }

  // ── Shared collect-path hooks ────────────────────────────────────

  override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  // ── Public test accessors ────────────────────────────────────────

  getPlayer(): Player | null {
    return this.player;
  }

  getDrops(): LevelingDrop[] {
    return [...this.drops];
  }

  getMinerals(): LevelingMineral[] {
    return [...this.minerals];
  }

  getBullets(): PlayerBullet[] {
    return [...this.playerBullets];
  }

  getHUD(): HUD | null {
    return this.hud;
  }

  getMineralChoiceOptions(): ChoiceOption[] {
    return [...this.mineralChoiceOptions];
  }

  getHold(): MineralHold {
    return this.hold;
  }

  /** Raises the mineral hold store directly (test seam). */
  addMinerals(amount: number): void {
    this.hold.collect(amount);
  }

  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined {
    return this.cursors;
  }

  getWasd(): WasdKeysLike | undefined {
    return this.wasd;
  }

  getCollectAnimations(): CollectAnimationHandle[] {
    return [...this.collectAnimations];
  }

  // ── Shared-combat participant contract (no enemies in this gym) ──

  protected override getEnemyEntities(): readonly CombatEnemyEntity[] {
    return [];
  }

  protected override getEnemyBullets(): readonly CombatEnemyBullet[] {
    return [];
  }

  protected override setEnemyBullets(_bullets: CombatEnemyBullet[]): void {}

  /** Kept for symmetry with the shared drop-layer hooks. */
  protected override autoFireEnabled(): boolean {
    return true;
  }
}

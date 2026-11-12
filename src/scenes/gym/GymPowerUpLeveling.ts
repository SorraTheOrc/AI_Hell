/**
 * Gym scene — **power-up leveling** demonstration (parent
 * AH-0MUV5CLVQ006V9HR / child AH-0MV7QKEEO006WFI1).
 *
 * A threat-free gallery that makes the whole power-up level curve legible
 * (the power-up counterpart of {@link GymWeaponLeveling}):
 *
 * - **Temporary leveling:** a power-up drop (Shield → Bomb → Speed Boost →
 *   Phase Shift → Teleport → Extra Life → Magnet → Mineral Scoop → Smart
 *   Bomb → Force Field → Mystery UFO) spawns on a round-robin cadence;
 *   collecting it **levels that power-up up** through the shared effect
 *   path. Re-collecting the same power-up keeps raising its run-scoped
 *   temporary level.
 * - **Permanent leveling:** a mineral hold fills as minerals are collected;
 *   on hold-full the shared `MineralChoiceScene` offers (among others) a
 *   permanent power-up grant or a permanent **level-up** for every power-up
 *   already owned this run. Choosing one permanently levels the power-up
 *   for the rest of the run. The gym's periodic mineral supply mixes in
 *   **red 10-value deposits**: every third spawn is a shared
 *   `createMineralDeposit` mineral (`RED_MINERAL_SHARE`, ≥ 30 %), so the hold
 *   fills at a usable pace at higher capacities, and a pickup credits the
 *   mineral's own value (10 red, 1 gold) rather than a flat amount
 *   (AH-0MW6OGSJP007K9W6).
 * - **Visible levels and stats:** the shared HUD renders each owned
 *   power-up's row with its effective level, and a gym-local `.gym-panel`
 *   readout lists **every** levelled power-up with its current run-scoped
 *   level plus the resolver-derived values of all its catalogue variables,
 *   updating live as the level rises.
 * - **Manual assign (gym-only):** each readout row carries an **Assign**
 *   button so a maintainer can add or level up any power-up directly, without
 *   flying around collecting drops (AH-0MW82M3LB007OQG6). It routes through
 *   the **same** shared `grantPermanentPowerUp` seam as a hold-full reward
 *   (permanent level for a non-consumable, one clamped charge for a
 *   consumable), and when the six-slot loadout is full it first removes one
 *   random slot-counted power-up (seeded `sceneRng()`) so the new kind can
 *   take the slot. It is a gym-only control: the shipped `PlayScene` gains
 *   none, and every level/charge/ownership read still comes from
 *   `PowerUpLevelStore`.
 *
 * Everything runs through the **shared** level model and combat core: the
 * gym reads levels and stats only from `PowerUpLevelStore` /
 * `resolvePowerUpAtLevel` and applies every collection through
 * `EffectsRegistry` — it defines no copy of the curve, the catalogue or the
 * level arithmetic (gym↔game parity, AGENTS.md). The only gym-specific
 * parts are the deterministic spawn source, the mineral hold cadence and
 * supply mix, and the level/stats readout.
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention.
 *
 * Scripted-scene setup (AH-0MVRMHYJR000Y9H8): the scene consumes the shared
 * `applySceneSetup` applier through `_adoptCaptureSetup`, so a capture setup's
 * player loadout, power-up levels and determinism seed are live before the
 * first captured frame, and the seed reproduces the mineral field. The
 * round-robin drop cadence and mineral hold stay fixed gym-only scenarios
 * (documented in `docs/GYM_PARITY.md` and `docs/dev/gameplay-capture.md`).
 *
 * @module src/scenes/gym/GymPowerUpLeveling
 */

import Phaser from 'phaser';

import {
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from '../core/CombatCoreScene';
import { CombatScene } from '../core/CombatScene';
import { gymBackgroundLevel } from './core/gymBackground';
import type { SceneSetupState } from '../core/sceneSetup';
import { Player } from '../../entities/Player';
import { advancePlayerBullets } from '../core/bulletLifecycle';
import { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import type { PowerUpId } from '../../powerups/types';
import { getPowerUpById } from '../../powerups/types';
import { drawPowerUpDrop } from '../../powerups/icons';
import {
  playPowerUpSpawnSound,
  playPowerUpDespawnSound,
} from '../../audio/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import {
  POWER_UP_LEVEL_IDS,
  POWER_UP_LEVEL_SPECS,
  isConsumablePowerUpId,
  isPowerUpAtDiscreteCap,
  resolvePowerUpAtLevel,
  type PowerUpLevelStats,
} from '../../powerups/powerUpLevels';
import { grantPermanentPowerUp } from '../../powerups/choiceReward';
import {
  resolvePlayerSlotState,
  slotCountedHeldIds,
  SLOTS_FULL_EXEMPT_IDS,
  type PowerUpSlotState,
} from '../../powerups/slots';
import { Mineral } from '../../entities/Mineral';
import { HUD } from '../../ui/HUD';
import { combatHudOptions } from '../core/hudWiring';
import { MineralHold } from '../../core/mineralHold';
import { buildHoldFullFireSchedule } from '../core/holdFullFire';
import type { MineralChoiceScene } from '../MineralChoiceScene';
import { WasdKeysLike } from '../../utils/input';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import { makeCollapsible } from '../../utils/gymPanel';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  POWER_UP_SPAWN_INTERVAL,
} from '../../core/constants';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';
import type { ChoiceOption, ChoiceStrategy } from '../../powerups/choice';
import { buildChoiceCandidates, CHOICE_POOL } from '../../powerups/choice';
import { applyMineralChoiceReward } from '../core/mineralLayer';
import { createMineralDeposit } from '../core/mineralKillDrops';
import { buildOwnedLoadout } from '../../powerups/ownedLoadout';
import type { DroneMineralSink } from '../core/combatDrone';

/** Id of the level/stats readout panel (plain-DOM `.gym-panel`). */
export const POWER_UP_READOUT_PANEL_ID = 'gym-powerup-level-readout';

/** Class applied to one power-up row in the readout panel. */
export const POWER_UP_ROW_CLASS = 'gym-powerup-level-row';

/** Class applied to the resolver-stats line of one readout row. */
export const POWER_UP_STATS_CLASS = 'gym-powerup-level-stats';

/**
 * Class applied to the per-row **Assign** button (a gym-only manual control,
 * AH-0MW82M3LB007OQG6). Each button carries `data-powerup-assign="<id>"` so a
 * test or scripted capture can address it without a DOM walk.
 */
export const POWER_UP_ASSIGN_CLASS = 'gym-powerup-assign';

/** Membership set of the levelled power-up ids (the removable kinds). */
const POWER_UP_LEVEL_ID_SET: ReadonlySet<string> = new Set<string>(
  POWER_UP_LEVEL_IDS,
);

/** Hint line shown at the bottom of the gym. */
export const GYM_POWER_UP_LEVELING_HINT =
  'Power-Up Leveling — collect drops to level up; fill the hold for a permanent level-up';

/**
 * Share of the gym's periodic mineral spawn stream that are **red 10-value
 * deposits** (AH-0MW6OGSJP007K9W6).
 *
 * The hold capacity doubles on every hold-full choice (3 → 6 → 12 → …), so a
 * stream of single-value gold minerals makes the permanent level-up
 * demonstration bog down at higher holds. The gym therefore guarantees a
 * meaningful share of high-value minerals: a **fixed rotation** turns every
 * third spawn into a red deposit, so any ten consecutive spawns contain at
 * least three red minerals (≥ 30 %) without relying on a per-spawn
 * probability.
 */
export const RED_MINERAL_SHARE = 0.3;

/**
 * Spawns per red deposit: `round(1 / RED_MINERAL_SHARE)` (3), giving one red
 * mineral every third spawn. Derived from the named share so the guarantee and
 * the rotation can never disagree.
 */
const RED_MINERAL_ROTATION = Math.round(1 / RED_MINERAL_SHARE);

/** First hold capacity — small so the choice is demonstrable quickly. */
const GYM_HOLD_CAPACITY = 3;

/** Deterministic drop spawn position (top-centre, easy to fly into). */
const SPAWN_POSITION = { x: GAME_WIDTH / 2, y: 100 };

/** A live power-up drop on the field. */
interface LevelingDrop {
  /** Lifecycle/state (grow/hold/shrink/collect). */
  powerUp: PowerUp;
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
  /** The power-up id for the shared collect path. */
  dropId: PowerUpId;
}

/** A live mineral on the field. */
interface LevelingMineral {
  /** The mineral entity (stationary gold dot). */
  entity: Mineral;
  /** Reap the mineral (called on collection). */
  destroy: () => void;
}

/** One row of the readout: a power-up at its current run-scoped level. */
export interface PowerUpLevelReadoutRow {
  /** The power-up id. */
  powerUpId: PowerUpId;
  /** Run-scoped collection level (permanent + temporary). */
  level: number;
  /** Resolver upgrade level (`level - 1`, 0 = base strength). */
  upgradeLevel: number;
  /** Resolved stats at `upgradeLevel` — exactly `resolvePowerUpAtLevel`. */
  stats: PowerUpLevelStats;
}

/** The full level readout: one row per levelled power-up. */
export interface PowerUpLevelReadout {
  rows: PowerUpLevelReadoutRow[];
}

/**
 * Formats one resolved-stats snapshot into a human-readable line, e.g.
 * `"Shield recharge 45s, Shield hits 1"`. Reads only the shared catalogue
 * (`POWER_UP_LEVEL_SPECS`) for each variable's label/unit/discreteness — the
 * gym renders the shared model, it never recomputes it.
 */
function formatLevelStats(stats: PowerUpLevelStats): string {
  const bucket = stats as unknown as Record<string, number>;
  return POWER_UP_LEVEL_SPECS[stats.powerUpId]
    .map((spec) => {
      const value = bucket[spec.variable];
      const shown = spec.discrete
        ? String(Math.round(value ?? 0))
        : (value ?? 0).toFixed(1);
      return `${spec.label} ${shown}${spec.unit}`;
    })
    .join(', ');
}

/**
 * Power-up leveling gym. Extends the shared {@link CombatScene} core so
 * drop collection, effect application and player control all flow through
 * the one implementation; only the deterministic spawn source, the mineral
 * hold cadence and supply mix, and the level/stats readout are gym-specific.
 */
export class GymPowerUpLeveling extends CombatScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  LevelingDrop
> {
  private player: Player | null = null;
  private drops: LevelingDrop[] = [];
  private minerals: LevelingMineral[] = [];
  private effectsRegistry = new EffectsRegistry();
  private hud: HUD | null = null;
  private roundRobinSpawner = new RoundRobinSpawner<PowerUpId>(
    POWER_UP_LEVEL_IDS,
  );
  private spawnTimer = 0;
  private mineralTimer = 0;
  /** Spawns seen by the red/gold rotation (deterministic, never from RNG). */
  private mineralSpawnCount = 0;
  private hold = new MineralHold({
    capacity: GYM_HOLD_CAPACITY,
    growthMultiplier: 2,
  });
  private mineralChoiceOptions: ChoiceOption[] = [];
  private mineralChoiceOpen = false;
  private panel: HTMLDivElement | null = null;
  private mineralChoiceStrategy: ChoiceStrategy = {
    choose: (count, _rng, context) => {
      // Prefer a power-up level-up offer so the permanent path is always
      // demonstrable, then fill the remaining slots from the base pool.
      // `buildChoiceCandidates` already suppresses the base-pool entry for an
      // owned power-up, so the candidate list holds no base/level pair for
      // the same id (AH-0MUVRACE9001WVT2) and the de-dup below is defensive.
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const levelUps = candidates.filter((o) => o.kind === 'power-up-level');
      const others = candidates.filter((o) => o.kind !== 'power-up-level');
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
    super({ key: 'GymPowerUpLeveling' });
  }

  /** Gym family background decision: fixed representative level, no warp. */
  protected override backgroundLevel(): number | null {
    return gymBackgroundLevel();
  }

  create(data?: SceneSetupState): void {
    this.resetRunState();
    // Shared background layer at the gym family's pinned level (see
    // `core/gymBackground.ts`, AH-0MVSEC0J0004YNJC).
    this._createSceneBackground();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT - 80,
    });
    this.add.existing(this.player);

    // Scripted-scene setup (AH-0MVRMHYJR000Y9H8): loadout, power-up levels
    // and the content seed are applied before any content spawns, so a
    // configured setup is live before the first captured frame. No setup
    // ⇒ unchanged behaviour.
    this._adoptCaptureSetup(data);

    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    // Shared HUD: one merged row per owned/active power-up showing its
    // effective level (permanent + temporary) from the shared registry.
    this.hud = new HUD(
      this,
      this.effectsRegistry,
      combatHudOptions(() => this.player, { showLives: false }),
    );
    this.hud.setMineralStore(this.hold.store, this.hold.capacity);

    this.add.text(
      GAME_WIDTH / 2,
      GAME_HEIGHT - 18,
      GYM_POWER_UP_LEVELING_HINT,
      {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#88ffcc',
      },
    ).setOrigin(0.5, 1);

    this._buildReadoutPanel();

    this._spawnRoundRobin();
    this.spawnTimer = POWER_UP_SPAWN_INTERVAL;

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
    this.mineralSpawnCount = 0;
    this.hold = new MineralHold({
      capacity: GYM_HOLD_CAPACITY,
      growthMultiplier: 2,
    });
    this.mineralChoiceOptions = [];
    this.mineralChoiceOpen = false;
    this.panel?.remove();
    this.panel = null;
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
    this.panel?.remove();
    this.panel = null;
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
      this.spawnTimer += POWER_UP_SPAWN_INTERVAL;
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
    this.refreshReadout();

    if (this.hold.isFull && !this.mineralChoiceOpen) {
      this.openMineralChoice();
    }
  }

  // ── Spawning / lifecycle ─────────────────────────────────────────

  private _spawnRoundRobin(): void {
    this.spawnDrop(
      this._drawNextDrop(
        this.roundRobinSpawner,
        this._resolveDropSlotState(),
      ),
      SPAWN_POSITION.x,
      SPAWN_POSITION.y,
    );
  }

  /** Spawns a power-up drop at (x, y). Public test seam. */
  spawnDrop(id: PowerUpId, x: number, y: number): LevelingDrop {
    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    drawPowerUpDrop(graphics, id, 0, 0, POWER_UP_DROP_SIZE);
    graphics.setScale(0);

    const drop: LevelingDrop = {
      powerUp: new PowerUp(id),
      x,
      y,
      graphics,
      despawnSoundPlayed: false,
      dropId: id,
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

  /**
   * Spawns a mineral at a random position (or the supplied one). Public test
   * seam.
   *
   * Every third spawn in the stream is a red 10-value deposit built through
   * the shared `createMineralDeposit` seam (colour and value paired once), so
   * the hold fills at a usable pace at higher capacities; the rest keep the
   * ordinary gold 1-value mineral. The decision is a fixed rotation, not an
   * RNG draw, so the seeded position stream (and a seeded capture) is
   * unchanged (AH-0MW6OGSJP007K9W6).
   */
  spawnMineral(x?: number, y?: number): LevelingMineral {
    const px = x ?? 80 + this.sceneRng() * (GAME_WIDTH - 160);
    const py = y ?? 120 + this.sceneRng() * (GAME_HEIGHT - 240);
    const entity = this._isRedMineralSpawn()
      ? createMineralDeposit(this, px, py)
      : new Mineral(this, { x: px, y: py });
    const mineral: LevelingMineral = {
      entity,
      destroy: () => entity.destroy(),
    };
    this.minerals.push(mineral);
    return mineral;
  }

  /**
   * Advances the deterministic red/gold rotation and reports whether this
   * spawn is a red deposit (every third spawn).
   */
  private _isRedMineralSpawn(): boolean {
    this.mineralSpawnCount += 1;
    return this.mineralSpawnCount % RED_MINERAL_ROTATION === 0;
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
      // A collector drone may have vacuumed this mineral (marked dead and
      // hidden by the shared drone pass): reap it so the field stays clean.
      if (!mineral.entity.alive) {
        mineral.destroy();
        continue;
      }
      const dx = mineral.entity.x - player.x;
      const dy = mineral.entity.y - player.y;
      if (dx * dx + dy * dy <= collectRadius * collectRadius) {
        // Credit the mineral's own value (10 for a red deposit, 1 for a gold
        // dot) — the same rule the game and the other gyms apply, so one red
        // pickup fills ten minerals' worth of the hold (AH-0MW6OGSJP007K9W6).
        this.hold.collect(mineral.entity.value);
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
    // This gym's offer pool stays power-ups-only, but the top-left owned
    // loadout panel always states the run's true permanent loadout, so the
    // weapon snapshot is read as well — a read of the same permanent state,
    // not new state (AH-0MVCRKAPL000L68Y, recorded plan default; producer did
    // not overrule it).
    const powerUpLevels = this.player?.getPowerUpLevels() ?? [];
    const weaponLevels = this.player?.getWeaponLevels() ?? [];
    this.mineralChoiceOptions = this.mineralChoiceStrategy.choose(
      3,
      undefined,
      {
        // Offer level-ups for power-ups the player permanently owns this run
        // (AH-0MUV5CLVO002ZHS9); a field-only item stays ★ New.
        powerUpLevels,
        // Temporary (field-pickup) stacks hold a slot while they last, so the
        // shared six-slot gate sees the same state as the game (parent
        // AH-0MVLIJT3M005HPHF, gym↔game parity).
        tempPowerUpIds: this.player?.getTempPowerUpIds() ?? [],
        tempWeaponIds: this.player?.getTempWeaponIds() ?? [],
      },
    );
    this.mineralChoiceOpen = true;
    // Fade the gym player's engine hum out across the pause; it ramps back
    // in on resume — the same shared seam as PlayScene.
    this.fadeThrusterHumForHoldFull();
    this.scene.launch('MineralChoiceScene', {
      options: [...this.mineralChoiceOptions],
      // Top-left permanent loadout panel: the run's true permanent weapons and
      // power-ups, so it reads identically to the game and the other gyms
      // (AH-0MVCRKAPL000L68Y · gym↔game parity).
      ownedUpgrades: buildOwnedLoadout(powerUpLevels, weaponLevels),
      // Reduced-volume ghost fire on the frozen beat grid, matching PlayScene
      // and the weapon-leveling gym (gym↔game parity).
      fireSchedule: buildHoldFullFireSchedule(this.player),
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
    // Re-base the frozen beat clock across the overlay + countdown pause so
    // the gym's real fire resumes phase-locked (gym↔game parity).
    const overlay = this.scene.manager.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene | null;
    this.rebaseBeatClockForHoldFullResume(overlay?.getOverlayElapsedMs() ?? 0);
    if (this.scene.manager.getScene('MineralChoiceScene')) {
      this.scene.resume();
    }
    return option;
  }

  // ── Readout (level + resolver-derived stats) ─────────────────────

  /**
   * Builds the plain-DOM readout panel: one row per levelled power-up with a
   * `data-powerup-row`/`data-powerup-label`/`data-powerup-stats` hook for the
   * live refresh and tests. Removed again on shutdown (like the other gym
   * panels).
   */
  private _buildReadoutPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    const panel = document.createElement('div');
    panel.id = POWER_UP_READOUT_PANEL_ID;
    panel.className = 'gym-panel';

    for (const id of POWER_UP_LEVEL_IDS) {
      const row = document.createElement('div');
      row.className = POWER_UP_ROW_CLASS;
      row.dataset.powerupRow = id;

      const label = document.createElement('span');
      label.className = 'gym-panel-label';
      label.dataset.powerupLabel = id;
      label.textContent = `${getPowerUpById(id).name} — Lv 0`;

      const stats = document.createElement('span');
      stats.className = POWER_UP_STATS_CLASS;
      stats.dataset.powerupStats = id;
      stats.textContent = '';

      // Gym-only manual control (AH-0MW82M3LB007OQG6): a native button in the
      // row body (never the collapsible header, so a click cannot also toggle
      // the panel). One click runs `assignPowerUp` exactly once.
      const assign = document.createElement('button');
      assign.type = 'button';
      assign.className = POWER_UP_ASSIGN_CLASS;
      assign.dataset.powerupAssign = id;
      assign.textContent = 'Assign';
      assign.addEventListener('click', () => this.assignPowerUp(id));

      row.append(label, stats, assign);
      panel.appendChild(row);
    }

    // Wrap the rows in a collapsible body ("Power-Up Levels") — a large
    // gallery would otherwise fill most of the screen.
    makeCollapsible({ panel, title: 'Power-Up Levels' });

    host.appendChild(panel);
    this.panel = panel;
    this.refreshReadout();
  }

  /**
   * The current level readout: one row per levelled power-up, with the run
   * scoped level and the stats exactly as the shared resolver reports them.
   */
  getReadout(): PowerUpLevelReadout {
    const player = this.player;
    return {
      rows: POWER_UP_LEVEL_IDS.map((id) => {
        const level = player?.getPowerUpLevel(id) ?? 0;
        const upgradeLevel =
          player?.getPowerUpLevelStore().getUpgradeLevel(id) ?? 0;
        return {
          powerUpId: id,
          level,
          upgradeLevel,
          stats: resolvePowerUpAtLevel(id, upgradeLevel),
        };
      }),
    };
  }

  /** The readout panel element (null before create / after teardown). */
  getPanel(): HTMLDivElement | null {
    return this.panel;
  }

  /** Re-renders every readout row from the live level store. Public seam. */
  refreshReadout(): void {
    const panel = this.panel;
    if (!panel) return;
    for (const row of this.getReadout().rows) {
      const rowEl = panel.querySelector<HTMLElement>(
        `[data-powerup-row="${row.powerUpId}"]`,
      );
      if (!rowEl) continue;
      const label = panel.querySelector<HTMLElement>(
        `[data-powerup-label="${row.powerUpId}"]`,
      );
      const stats = panel.querySelector<HTMLElement>(
        `[data-powerup-stats="${row.powerUpId}"]`,
      );
      const assign = panel.querySelector<HTMLButtonElement>(
        `[data-powerup-assign="${row.powerUpId}"]`,
      );
      if (label) {
        label.textContent = `${getPowerUpById(row.powerUpId).name} — Lv ${row.level}`;
      }
      if (stats) stats.textContent = formatLevelStats(row.stats);
      if (assign) assign.disabled = this.isAssignDisabled(row.powerUpId);
    }
  }

  // ── Manual assign (gym-only control) ────────────────────────────

  /**
   * Whether the **Assign** control for `id` is at its cap and therefore a
   * no-op (AH-0MW82M3LB007OQG6 AC5). Two independent rules:
   *
   * - **Non-consumable** — every **discrete** curve variable has reached its
   *   catalogue cap ({@link isPowerUpAtDiscreteCap}); continuous variables
   *   only asymptote, so a power-up with none is never disabled (Q9 = C).
   * - **Consumable** — its level-derived charge pool is full, or a single-use
   *   kind already holds its ready activation (Q10 = A). A consumable never
   *   levels from a grant, so the curve cap is irrelevant here.
   *
   * Public so a test (and a scripted capture) can read the live disable state
   * without inspecting the button's DOM property.
   */
  isAssignDisabled(id: PowerUpId): boolean {
    const player = this.player;
    if (!player) return false;
    const store = player.getPowerUpLevelStore();
    if (isConsumablePowerUpId(id)) {
      // A single-use kind has one readiness flag, not a pool: it is "full"
      // exactly while its ready activation is held.
      if (store.hasSingleUse(id)) return true;
      const cap = store.consumableChargeCap(id);
      return cap > 0 && store.consumableCharges(id) >= cap;
    }
    return isPowerUpAtDiscreteCap(id, store.getUpgradeLevel(id));
  }

  /**
   * Manually assigns power-up `id` to the ship — the gym-only control
   * (AH-0MW82M3LB007OQG6). It writes only through the shared seams:
   *
   * - **unowned** → one {@link grantPermanentPowerUp} adds the kind at base
   *   level (a consumable becomes owned and banks one clamped charge);
   * - **owned** → the same seam adds one permanent level (non-consumable) or
   *   one clamped charge (consumable), matching the hold-full rule — never a
   *   divergent copy;
   * - **unowned and the six-slot loadout full** → one random slot-counted
   *   power-up is removed first (`PowerUpLevelStore.remove`) so the new kind
   *   can take the slot. An exempt kind (Extra Life / Mystery UFO) never
   *   consumes a slot, so it triggers no removal.
   *
   * A no-op when the control is at its cap ({@link isAssignDisabled}). Public
   * so a test and a scripted capture can drive the exact code the button
   * calls; the readout is refreshed in the same call so `getReadout()` and
   * every row are current immediately after it.
   */
  assignPowerUp(id: PowerUpId): void {
    const player = this.player;
    if (!player || this.isAssignDisabled(id)) return;
    const store = player.getPowerUpLevelStore();
    const owned =
      store.getEffectiveLevel(id) > 0 || store.isConsumableOwned(id);
    if (!owned) {
      const slotState = resolvePlayerSlotState(player);
      // Only a slot-counted kind needs a slot; an exempt kind added at the
      // full cap must not evict a held power-up.
      const needsSlot = !SLOTS_FULL_EXEMPT_IDS.includes(id);
      if (slotState.isFull && needsSlot) {
        this._removeRandomSlotCountedPowerUp(slotState);
      }
    }
    // The one shared grant seam: permanent level for a non-consumable, one
    // clamped charge (never a level) for a consumable.
    grantPermanentPowerUp(id, this.effectsRegistry);
    this.refreshReadout();
  }

  /**
   * Removes one random held power-up kind so a manual assign can free a slot.
   *
   * The victim is drawn **only** from {@link slotCountedHeldIds} — the
   * slot-exempt Extra Life / Mystery UFO never appear there — and further
   * restricted to actual power-up kinds, because the whole-kind clear seam is
   * `PowerUpLevelStore.remove` / `Player.removePowerUp` (a weapon drop has its
   * own store and is not removable here). The draw uses the gym's seeded
   * `sceneRng()`, so a seeded capture reproduces the same victim
   * (AH-0MW82M3LB007OQG6 AC4).
   */
  private _removeRandomSlotCountedPowerUp(state: PowerUpSlotState): void {
    const player = this.player;
    if (!player) return;
    const victims = slotCountedHeldIds(state).filter((id) =>
      POWER_UP_LEVEL_ID_SET.has(id),
    );
    if (victims.length === 0) return;
    const index = Math.floor(this.sceneRng() * victims.length);
    player.removePowerUp(victims[index] as PowerUpId);
  }

  /**
   * Test seam: overrides the content RNG the random-victim draw uses, so a
   * test can pin the victim (AH-0MW82M3LB007OQG6 AC4/AC6). Production scenes
   * never call it — `sceneRng` is seeded from the capture `setup`.
   */
  setSceneRng(rng: () => number): void {
    this.sceneRng = rng;
  }

  // ── Run-restart reset (deterministic public seam) ────────────────

  /**
   * Resets the run: clears every power-up level and derived resource through
   * the shared registry reset (which drains the player's single store) and
   * resets the demonstration field. Public deterministic seam so the reset
   * test exercises `resetPowerUpLevels` without a real GameOver sequence
   * (AC5).
   */
  restartRun(): void {
    this.effectsRegistry.reset();
    this.hold = new MineralHold({
      capacity: GYM_HOLD_CAPACITY,
      growthMultiplier: 2,
    });
    this.mineralChoiceOptions = [];
    this.mineralChoiceOpen = false;
    for (const drop of this.drops) drop.graphics.destroy();
    this.drops = [];
    this.refreshReadout();
  }

  // ── Shared collect-path hooks ────────────────────────────────────

  override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  /**
   * Mineral field the collector drones (Mystery UFO reward) seek, vacuum and
   * drop into. This gym stores each mineral in a `{ entity, destroy }`
   * wrapper, so the live {@link Mineral} entities are projected for the shared
   * drone pass. The gym spawns no enemies, so a drone can never be destroyed
   * here and no destruction drops are lost by the projection.
   */
  protected override getDroneMineralField(): Mineral[] {
    return this.minerals.map((mineral) => mineral.entity);
  }

  /**
   * Hold sink for a collector drone's ferried minerals: the gym's shared
   * hold, mirrored onto the HUD exactly like a player pickup.
   */
  protected override getDroneMineralSink(): DroneMineralSink {
    return {
      addMinerals: (amount: number) => {
        this.hold.collect(amount);
        this.hud?.setMineralStore(this.hold.store, this.hold.capacity);
      },
    };
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

  /** The ship auto-fires its permanent cannon (no weapon drops here). */
  protected override autoFireEnabled(): boolean {
    return true;
  }
}

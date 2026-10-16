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
 *   for the rest of the run.
 * - **Visible levels and stats:** the shared HUD renders each owned
 *   power-up's row with its effective level, and a gym-local `.gym-panel`
 *   readout lists **every** levelled power-up with its current run-scoped
 *   level plus the resolver-derived values of all its catalogue variables,
 *   updating live as the level rises.
 *
 * Everything runs through the **shared** level model and combat core: the
 * gym reads levels and stats only from `PowerUpLevelStore` /
 * `resolvePowerUpAtLevel` and applies every collection through
 * `EffectsRegistry` — it defines no copy of the curve, the catalogue or the
 * level arithmetic (gym↔game parity, AGENTS.md). The only gym-specific
 * parts are the deterministic spawn source, the mineral hold cadence and the
 * level/stats readout.
 *
 * Discovered automatically by `GymIndex` via the `Gym<Name>.ts` convention.
 *
 * @module src/scenes/gym/GymPowerUpLeveling
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
  resolvePowerUpAtLevel,
  type PowerUpLevelStats,
} from '../../powerups/powerUpLevels';
import { Mineral } from '../../entities/Mineral';
import { HUD } from '../../ui/HUD';
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

/** Id of the level/stats readout panel (plain-DOM `.gym-panel`). */
export const POWER_UP_READOUT_PANEL_ID = 'gym-powerup-level-readout';

/** Class applied to one power-up row in the readout panel. */
export const POWER_UP_ROW_CLASS = 'gym-powerup-level-row';

/** Class applied to the resolver-stats line of one readout row. */
export const POWER_UP_STATS_CLASS = 'gym-powerup-level-stats';

/** Hint line shown at the bottom of the gym. */
export const GYM_POWER_UP_LEVELING_HINT =
  'Power-Up Leveling — collect drops to level up; fill the hold for a permanent level-up';

/** Minerals granted by each collected mineral in the gym. */
const MINERAL_COLLECT_AMOUNT = 1;

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
 * `"Shield time 15.0s, Shield hits 1"`. Reads only the shared catalogue
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
 * hold cadence and the level/stats readout are gym-specific.
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

    // Shared HUD: one merged row per owned/active power-up showing its
    // effective level (permanent + temporary) from the shared registry.
    this.hud = new HUD(this, this.effectsRegistry, { showLives: false });
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
      this.roundRobinSpawner.next(),
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
    this.mineralChoiceOptions = this.mineralChoiceStrategy.choose(
      3,
      undefined,
      {
        // Offer level-ups for power-ups the player permanently owns this run
        // (AH-0MUV5CLVO002ZHS9); a field-only item stays ★ New.
        powerUpLevels: this.player?.getPowerUpLevels() ?? [],
      },
    );
    this.mineralChoiceOpen = true;
    // Fade the gym player's engine hum out across the pause; it ramps back
    // in on resume — the same shared seam as PlayScene.
    this.fadeThrusterHumForHoldFull();
    this.scene.launch('MineralChoiceScene', {
      options: [...this.mineralChoiceOptions],
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

      row.append(label, stats);
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
      if (label) {
        label.textContent = `${getPowerUpById(row.powerUpId).name} — Lv ${row.level}`;
      }
      if (stats) stats.textContent = formatLevelStats(row.stats);
    }
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

  /** Applies the instant Mystery UFO bounty into the gym's shared hold. */
  protected override onPowerUpCollected(drop: LevelingDrop): void {
    super.onPowerUpCollected(drop);
    if (drop.dropId !== 'mystery_ufo') return;
    this._applyPendingMysteryBonus({
      addMinerals: (amount) => this.hold.collect(amount),
    });
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

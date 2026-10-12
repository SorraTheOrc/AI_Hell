/**
 * Gym scene — dedicated level gym scene for launching generated level
 * configurations from the difficulty-curve editor (AH-0MUNU6MGM007CI45).
 *
 * Plays a sequence of waves — either a full generated level or a single wave
 * — sequentially, one after another, in a gym context: like campaign mode,
 * but launched from the curve editor.
 *
 * Launch contract (`scene.start('GymLevel', data)`):
 *
 * ```ts
 * this.scene.start('GymLevel', {
 *   waves: level.waves,        // ordered WaveDefinitions
 *   levelName: level.name,     // shown in the HUD
 * });
 * ```
 *
 * The player ship starts with **spread** and **dual** weapons equipped
 * (permanent for the run) so the level can be played immediately.
 *
 * The scene extends the shared {@link CombatScene} so input, auto-fire,
 * collision resolution and the player-hit lifecycle are the *same code* the
 * shipped game and the other gyms run (gym↔game parity, AGENTS.md). Position
 * updates mirror `PlayScene._moveEnemies` (formation drift, per-entity
 * positioning and roaming-entity motion). It follows the standard gym
 * navigation pattern: a "← INDEX" button plus ESC-to-menu.
 *
 * ## Supply layer (AH-0MV4D7LAD009XYR0 producer-audit fix)
 *
 * The level plays exactly as the game does: a mineral field is seeded, a
 * destroyed enemy leaves minerals behind through the shared
 * `resolveMineralKillDrops` rule, and power-up/weapon drops appear on the
 * field on the shared `buildDefaultDropSpawner` + `RandomAvoidingPlacement`
 * cadence. Collection runs through the shared `collectMinerals` / drop-layer
 * template methods, so the gym never forks the game's supply behaviour; only
 * the spawn *source* (a cadence here, the game's own source) is gym-specific,
 * exactly as `GymFormationScene` documents (OQ6). The bot-tuning gym inherits
 * this so the bot can be tested against minerals, power-ups and weapons.
 */

import Phaser from 'phaser';

import { CombatScene, type CombatDrop } from '../core/CombatScene';
import { advancePlayerBullets, advanceWrappingBullets } from '../core/bulletLifecycle';
import { Player } from '../../entities/Player';
import { PlayerBullet } from '../../entities/PlayerBullet';
import {
  createEnemyFromConfig,
  type EnemyEntity,
} from '../../entities/enemyFactory';
import { fireForEnemy } from '../../entities/enemyFire';
import {
  computeFormationPosition,
  getFormationBuilder,
} from '../../utils/formations';
import { loadEnemyConfig } from '../../core/enemyConfig';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../../core/constants';
import { loadRules } from '../../core/rules';
import { playSpawnSound } from '../../audio/effects';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import type { WasdKeysLike } from '../../utils/input';
import type { WeaponId } from '../../utils/weapons';
import { EffectsRegistry } from '../../powerups/effects';
import { HUD } from '../../ui/HUD';
import { Mineral } from '../../entities/Mineral';
import { Asteroid } from '../../entities/Asteroid';
import { PowerUp } from '../../powerups/PowerUp';
import { drawPowerUpDrop, drawWeaponDrop } from '../../powerups/icons';
import {
  RandomAvoidingPlacement,
  type PlacementContext,
  type PowerUpPlacement,
} from '../../powerups/placement';
import type { PowerUpSpawner } from '../../powerups/spawner';
import {
  getPowerUpById,
  isWeaponDrop,
  type DropId,
  type PowerUpId,
} from '../../powerups/types';
import {
  randomChoiceStrategy,
  type ChoiceStrategy,
} from '../../powerups/choice';
import {
  applyMineralChoiceReward,
  collectMinerals,
  isMineralAbsorbingEnemy,
  MineralHold,
  type MineralAbsorbingEnemy,
} from '../core/mineralLayer';
import {
  resolveMineralKillDrops,
  type MineralKillDropEntity,
} from '../core/mineralKillDrops';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';

// ── Initialisation data ────────────────────────────────────────────

/**
 * Launch parameters accepted by {@link GymLevel}.
 *
 * The curve editor passes a complete {@link LevelDefinition} — either a whole
 * generated level (Launch Level) or a synthetic one-wave level (Launch Wave).
 */
export interface GymLevelData {
  /** The level to play. Its `waves` are played sequentially. */
  level: LevelDefinition;
}

/** Scene key of the level gym (registered by the gym index glob). */
export const GYM_LEVEL_SCENE_KEY = 'GymLevel';

/** Fallback HUD label when no level name is supplied. */
export const GYM_LEVEL_DEFAULT_LABEL = 'Generated Level';

/** Formation drift speed (px/s) — matches `PlayScene`'s `FORMATION_DRIFT_SPEED`. */
export const GYM_LEVEL_DRIFT_SPEED = 28;
/** Horizontal drift half-range (px), centred on the spawn x — matches the game. */
export const GYM_LEVEL_DRIFT_RANGE = GAME_WIDTH * 0.5;

/** Minerals seeded onto the level field at scene start. */
export const GYM_LEVEL_MINERAL_SEED_COUNT = 50;
/** Minimum distance from the screen edge for a spawned supply drop (px). */
export const GYM_LEVEL_DROP_MARGIN = 24;

// ── Bullet contract ────────────────────────────────────────────────

/**
 * Enemy bullet shape produced by the enemy entities, satisfying both the
 * shared `CombatEnemyBullet` and `WrappingBullet` contracts so the shared
 * collision and lifecycle passes can consume it unchanged.
 */
export interface GymLevelBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
  lifetime: number;
  elapsed: number;
}

/** Per-enemy spawn metadata needed to reposition it each frame. */
export interface LevelSpawn {
  /** The spawned enemy entity. */
  entity: EnemyEntity;
  /** Archetype key, for the shared fire dispatcher. */
  key: string;
  /** Formation base x at spawn (px). */
  startX: number;
  /** Formation base y at spawn (px). */
  startY: number;
  /** Horizontal formation spacing (px). */
  spacingX: number;
  /** Vertical formation spacing (px). */
  spacingY: number;
}

// ── Wave spawning ──────────────────────────────────────────────────

/**
 * Spawns every group of one wave and returns the enemy bullets fired during
 * spawn. Uses the shared formation builders and the config-aware entity
 * factory so the level gym spawns the *same* entities as the game.
 */
export function spawnWave(
  scene: Phaser.Scene,
  wave: WaveDefinition,
  spawned: LevelSpawn[],
): GymLevelBullet[] {
  const bullets: GymLevelBullet[] = [];

  for (const group of wave.groups) {
    const baseConfig = loadEnemyConfig(group.enemyKey);
    const key = baseConfig.key || group.enemyKey;
    const buildOffsets = getFormationBuilder(group.formation);

    // Per-group formation spacing/position overrides (WaveGroup, not the
    // archetype config) so a generated wave is spawned exactly as authored.
    for (const offset of buildOffsets(group.count)) {
      const { x, y } = computeFormationPosition(
        group.startX,
        group.startY,
        offset,
        group.spacingX,
        group.spacingY,
      );
      const enemy = createEnemyFromConfig(scene, baseConfig, x, y, offset);
      scene.add.existing(enemy);
      spawned.push({
        entity: enemy,
        key,
        startX: group.startX,
        startY: group.startY,
        spacingX: group.spacingX,
        spacingY: group.spacingY,
      });
      for (const bullet of fireForEnemy<GymLevelBullet>(enemy, key, scene.time.now)) {
        bullets.push(bullet);
      }
    }
  }

  return bullets;
}

/**
 * Fires every live enemy once through the shared dispatcher and returns the
 * newly-fired bullets. Called each tick so firing waves keep firing after
 * spawn (mirrors `GymFormationScene`'s per-tick `collectBullets` pass).
 */
export function fireLiveEnemies(
  spawned: readonly LevelSpawn[],
  now: number,
): GymLevelBullet[] {
  const bullets: GymLevelBullet[] = [];
  for (const spawn of spawned) {
    if (!spawn.entity.alive) continue;
    bullets.push(
      ...fireForEnemy<GymLevelBullet>(spawn.entity, spawn.key, now),
    );
  }
  return bullets;
}

/** True when every spawned enemy has been destroyed. */
export function isWaveClear(spawned: readonly LevelSpawn[]): boolean {
  return spawned.every((spawn) => !spawn.entity.alive);
}

/** Destroys every remaining enemy and enemy bullet, then empties the lists. */
function cleanupWave(
  spawned: LevelSpawn[],
  bullets: GymLevelBullet[],
): void {
  for (const bullet of bullets) {
    try { bullet.graphics.destroy(); } catch { /* already destroyed */ }
  }
  for (const spawn of spawned) {
    try { spawn.entity.destroy(); } catch { /* already destroyed */ }
  }
  spawned.length = 0;
  bullets.length = 0;
}

// ── Scene ──────────────────────────────────────────────────────────

export class GymLevel extends CombatScene<EnemyEntity, GymLevelBullet> {
  private player: Player | null = null;
  private spawned: LevelSpawn[] = [];
  private enemyBullets: GymLevelBullet[] = [];
  private effectsRegistry = new EffectsRegistry();
  private statusText: Phaser.GameObjects.Text | null = null;

  // ── Supply layer (minerals + power-up/weapon drops) ──────────────
  /** Live mineral collectables (seeded at start + kill drops). */
  private minerals: Mineral[] = [];
  /** Run-scoped mineral hold (the shared model the game uses). */
  private mineralHold = new MineralHold();
  /** Cumulative minerals seeded since the level started (test accessor). */
  private mineralsSeeded = 0;
  /** Live power-up/weapon drops on the field. */
  private drops: CombatDrop[] = [];
  /** Default weighted drop spawner (power-ups + weapons). */
  private dropSpawner: PowerUpSpawner<DropId> | null = null;
  /** Placement strategy for spawned drops. */
  private dropPlacement: PowerUpPlacement | null = null;
  /** Seconds until the next drop spawn. */
  private dropSpawnTimer = 0;
  /** Configured seconds between drop spawns. */
  private dropSpawnInterval = 0;
  /** Reward policy applied when the mineral hold fills (no modal pause). */
  private mineralChoiceStrategy: ChoiceStrategy = randomChoiceStrategy;
  /** Standalone effects/mineral HUD (null before create/after teardown). */
  private hud: HUD | null = null;

  /**
   * Scene-level RNG for supply seeding/placement. Defaults to `Math.random`;
   * `GymBotTuning` overrides it with a seeded RNG so a seed reproduces the
   * same mineral field and drop sequence.
   */
  protected supplyRng: () => number = () => Math.random();

  /** Current wave index (0-based). */
  private currentWaveIndex = 0;
  /** Waves to play in this session. */
  private wavesToPlay: WaveDefinition[] = [];
  /** HUD label for the current level/wave. */
  private label = GYM_LEVEL_DEFAULT_LABEL;
  /** True once every wave has been cleared. */
  private levelComplete = false;
  /** Horizontal formation drift (px), oscillating within ±drift range. */
  private driftX = 0;
  /** Drift direction (+1 right, −1 left). */
  private driftDir = 1;

  constructor(key: string = GYM_LEVEL_SCENE_KEY) {
    super({ key });
  }

  // ── Initialisation ───────────────────────────────────────────────

  init(data?: GymLevelData): void {
    this.currentWaveIndex = 0;
    this.levelComplete = false;
    this.spawned = [];
    this.enemyBullets = [];
    this.driftX = 0;
    this.driftDir = 1;

    const level = data?.level;
    if (!level || !Array.isArray(level.waves) || level.waves.length === 0) {
      this.wavesToPlay = [];
      this.label = GYM_LEVEL_DEFAULT_LABEL;
      return;
    }
    this.wavesToPlay = level.waves;
    this.label = level.name || GYM_LEVEL_DEFAULT_LABEL;
  }

  // ── Scene creation ───────────────────────────────────────────────

  create(): void {
    this.resetRunState();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);
    this.player.setPosition(GAME_WIDTH / 2, GAME_HEIGHT / 2);

    // Keyboard bindings for the shared player-control step. Every gym scene
    // binds arrow + WASD keys the same way (PlayScene, GymFormationScene,
    // GymPlayer, GymWeapons, …). Omitting them leaves `_readPlayerInput()`
    // returning null and freezes the ship — the regression reported in the
    // producer audit of this work item.
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    // Standard gym navigation (AC5).
    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    // HUD: level/wave label at top-centre (AC5).
    this.statusText = this.add
      .text(GAME_WIDTH / 2, 16, this.label, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#00ffff',
        backgroundColor: '#111111',
        padding: { x: 10, y: 6 },
      })
      .setOrigin(0.5);

    // Spread + dual weapons equipped at scene start (AC4).
    this.player.equipWeapon('spread', true);
    this.player.equipWeapon('dual', true);

    this._spawnCurrentWave();

    // Supply layer: seed minerals and start the power-up/weapon drop cadence
    // (shared game code — see the class docstring).
    this._initSupplyLayer();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());
  }

  // ── Wave management ──────────────────────────────────────────────

  /** Spawns the wave at `currentWaveIndex`, or completes when none remain. */
  private _spawnCurrentWave(): void {
    if (this.currentWaveIndex >= this.wavesToPlay.length) {
      this._onLevelComplete();
      return;
    }

    const wave = this.wavesToPlay[this.currentWaveIndex];
    this.statusText?.setText(
      `${this.label} — Wave ${this.currentWaveIndex + 1}/${this.wavesToPlay.length}`,
    );

    this.enemyBullets.push(...spawnWave(this, wave, this.spawned));
    // Spawn cue, matching the other gym scenes (GymFormationScene plays the
    // shared spawn sound once per wave). Without this the launched level is
    // silent on entry — the second half of the producer audit.
    playSpawnSound();
  }

  /** Advances to the next wave once the current one is clear. */
  private _checkWaveComplete(): void {
    if (this.levelComplete) return;
    if (!isWaveClear(this.spawned)) return;

    this.currentWaveIndex++;
    if (this.currentWaveIndex >= this.wavesToPlay.length) {
      this._onLevelComplete();
      return;
    }
    cleanupWave(this.spawned, this.enemyBullets);
    this.driftX = 0;
    this.driftDir = 1;
    this._spawnCurrentWave();
  }

  /** Marks the level complete and clears the field. */
  private _onLevelComplete(): void {
    this.levelComplete = true;
    cleanupWave(this.spawned, this.enemyBullets);
    this.statusText?.setText(`${this.label} — COMPLETE`);
  }

  /**
   * Loads and starts a fresh level, replacing whatever is on the field
   * (AH-0MV4D7LAD009XYR0). A subclass can call it to continue with a new
   * generated level without restarting the scene — the `GymBotTuning` gym
   * uses it to keep the bot playing random levels. Does not touch the player
   * ship, weapons, effects or HUD; only the wave queue and spawned enemies are
   * reset.
   */
  protected loadLevel(level: LevelDefinition): void {
    this.currentWaveIndex = 0;
    this.levelComplete = false;
    this.driftX = 0;
    this.driftDir = 1;
    cleanupWave(this.spawned, this.enemyBullets);
    this.spawned = [];
    this.enemyBullets = [];
    this.wavesToPlay = level.waves;
    this.label = level.name || GYM_LEVEL_DEFAULT_LABEL;
    this.statusText?.setText(this.label);
    this._spawnCurrentWave();
  }

  // ── Supply layer (minerals + power-up/weapon drops) ──────────────
  //
  // The level plays with the game's supply mechanics through the shared code:
  // `resolveMineralKillDrops` (enemy death), `buildDefaultDropSpawner` +
  // `RandomAvoidingPlacement` (drop source), `collectMinerals` and
  // `_updateDropLayer` (collection). Only the spawn *source* is scene-specific
  // (a cadence here, matching `GymFormationScene`; OQ6). A full mineral hold is
  // resolved automatically with the shared random reward so an autonomous bot
  // run never pauses — a documented gym-only divergence (the game opens a
  // modal choice).

  /** Seeds the mineral field, builds the drop spawner and adds the HUD. */
  private _initSupplyLayer(): void {
    const rules = loadRules();
    this.mineralHold.capacity = rules.mineralHoldCapacity;
    this.mineralHold.collectAmount = rules.mineralCollectAmount;
    this.mineralHold.growthMultiplier = rules.mineralHoldGrowthMultiplier;
    this.mineralHold.reset();
    this.mineralsSeeded = 0;
    this.mineralChoiceStrategy = randomChoiceStrategy;

    this.dropSpawner = this._buildDefaultDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      this.supplyRng,
    );
    this.dropPlacement = new RandomAvoidingPlacement({ rng: this.supplyRng });
    this.dropSpawnInterval = rules.powerUpSpawnInterval;
    this.dropSpawnTimer = this.dropSpawnInterval;

    this.hud = new HUD(this, this.getEffectsRegistry(), {
      showLives: true,
      getWeaponLevel: (id) =>
        this.getPlayer()?.getWeaponLevel(id as WeaponId) ?? 0,
    });

    this.seedMinerals(GYM_LEVEL_MINERAL_SEED_COUNT);
    this._syncMineralHud();
    // One drop immediately, so a power-up/weapon is observable at boot.
    this._spawnSupplyDrop();
  }

  /** Seeds `count` random minerals across the play area (public for tests). */
  seedMinerals(count: number): Mineral[] {
    const seeded: Mineral[] = [];
    for (let i = 0; i < count; i++) {
      const x = 20 + this.supplyRng() * (GAME_WIDTH - 40);
      const y = 20 + this.supplyRng() * (GAME_HEIGHT - 120);
      const mineral = new Mineral(this, { x, y });
      this.minerals.push(mineral);
      seeded.push(mineral);
    }
    this.mineralsSeeded += count;
    return seeded;
  }

  /** Chooses and places the next supply drop on the cadence. */
  private _spawnSupplyDrop(): void {
    if (!this.dropSpawner || !this.dropPlacement) return;
    const id = this.dropSpawner.next();
    const { x, y } = this.dropPlacement.place(this._supplyPlacementContext());
    this.spawnSupplyDrop(id, x, y);
  }

  /**
   * Builds and registers a drop of `id` at (x, y) through the shared
   * icon/lifecycle primitives. Public so tests (and the cadence) can place a
   * drop deterministically.
   */
  spawnSupplyDrop(id: DropId, x: number, y: number): CombatDrop {
    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    const isWeapon = isWeaponDrop(id);
    if (isWeapon) {
      drawWeaponDrop(graphics, id, 0, 0, POWER_UP_DROP_SIZE);
    } else {
      drawPowerUpDrop(
        graphics,
        getPowerUpById(id as PowerUpId).id,
        0,
        0,
        POWER_UP_DROP_SIZE,
      );
    }
    graphics.setScale(0);
    // Weapon drops carry a placeholder `shield` lifecycle as the collect gate;
    // the real effect is the shared weapon equip in `_collectDrop`.
    const drop: CombatDrop = {
      powerUp: new PowerUp(isWeapon ? 'shield' : (id as PowerUpId)),
      dropId: id,
      weaponDropId: isWeapon ? id : undefined,
      x,
      y,
      graphics,
    };
    this.drops.push(drop);
    return drop;
  }

  /** Live bodies a spawned drop must avoid (enemies + player). */
  private _supplyPlacementContext(): PlacementContext {
    const enemies = this.getEnemyEntities()
      .filter((enemy) => enemy.alive)
      .map((enemy) => ({ x: enemy.x, y: enemy.y, radius: enemy.getHitRadius() }));
    const player = this.getPlayer();
    return {
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
      margin: GYM_LEVEL_DROP_MARGIN,
      dropRadius: POWER_UP_DROP_SIZE,
      enemies,
      player: player
        ? { x: player.x, y: player.y, radius: SHIP_SIZE / 2 }
        : { x: -1e6, y: -1e6, radius: 0 },
    };
  }

  /** One supply step: minerals collect/absorb, drops lifecycle + spawn. */
  private _updateSupplies(dt: number): void {
    // Minerals: shared scoop pull, then shared collection/absorption.
    if (this.minerals.length > 0) {
      this._applyMineralScoop(this.minerals, dt);
      // Asteroids are inert to minerals; every other mineral-absorbing enemy
      // absorbs on overlap (shared gate).
      const absorbers = this.getEnemyEntities().filter(
        (enemy): enemy is EnemyEntity & MineralAbsorbingEnemy =>
          !(enemy instanceof Asteroid) && isMineralAbsorbingEnemy(enemy),
      );
      this.minerals = collectMinerals(
        this.minerals,
        this.getPlayer(),
        absorbers,
        () => this._collectMineral(),
        { playerPhased: this.isPlayerPhased() },
      );
    }

    // Drops: the complete shared sequence (Magnet → lifecycle → collect →
    // absorb VFX). One drop on screen at a time, refilled on the cadence.
    this.drops = this._updateDropLayer(this.drops, dt);
    this.dropSpawnTimer -= dt;
    if (this.dropSpawnTimer <= 0 && this.drops.length === 0) {
      this._spawnSupplyDrop();
      this.dropSpawnTimer = this.dropSpawnInterval;
    }

    this._syncMineralHud();
  }

  /** Collects a mineral into the shared hold, resolving it when full. */
  private _collectMineral(): void {
    this.mineralHold.collect();
    if (this.mineralHold.isFull) this._resolveMineralHold();
  }

  /**
   * Resolves a full hold with one shared random reward, with no modal pause so
   * the autonomous bot keeps playing (documented gym-only divergence).
   */
  private _resolveMineralHold(): void {
    const options = this.mineralChoiceStrategy.choose(1, this.supplyRng, {
      weaponLevels: this.getPlayer()?.getWeaponLevels() ?? [],
      powerUpLevels: this.getPlayer()?.getPowerUpLevels() ?? [],
    });
    const option = options[0];
    if (option) {
      applyMineralChoiceReward(
        option,
        this.getEffectsRegistry(),
        this.getPlayer(),
      );
    }
    this.mineralHold.resolve();
  }

  /** Mirrors the mineral hold onto the HUD bar. */
  private _syncMineralHud(): void {
    this.hud?.setMineralStore(
      this.mineralHold.store,
      this.mineralHold.capacity,
    );
  }

  /**
   * Enemy destruction seam: applies the shared mineral kill-drop rule so a
   * destroyed enemy leaves minerals exactly as it does in the game.
   */
  protected override onEnemyDestroyed(enemy: EnemyEntity): void {
    const dropped = resolveMineralKillDrops(
      this,
      enemy as unknown as MineralKillDropEntity,
      this.supplyRng,
    );
    if (dropped.length > 0) this.minerals.push(...dropped);
  }

  // ── Enemy movement (parity with `PlayScene._moveEnemies`) ────────

  /** Advances formation drift and repositions every live enemy. */
  private _moveEnemies(dt: number): void {
    this.driftX += this.driftDir * GYM_LEVEL_DRIFT_SPEED * dt;
    if (this.driftX > GYM_LEVEL_DRIFT_RANGE) {
      this.driftX = GYM_LEVEL_DRIFT_RANGE;
      this.driftDir = -1;
    } else if (this.driftX < 0) {
      this.driftX = 0;
      this.driftDir = 1;
    }

    for (const spawn of this.spawned) {
      if (!spawn.entity.alive) continue;
      const entity = spawn.entity;

      // Asteroids and other roaming entities advance their own motion and
      // ignore the formation drift (matches the game).
      if (spawn.key === 'asteroid' || entity.updatePosition) {
        entity.setSeekTargets?.([]);
        entity.updatePosition?.(dt);
        continue;
      }

      entity.applyFormationPosition(
        spawn.startX + this.driftX,
        spawn.startY,
        dt,
        spawn.spacingX,
        spawn.spacingY,
      );
    }
  }

  // ── Shared combat-core participant accessors ─────────────────────

  protected override getPlayer(): Player | null {
    return this.player;
  }

  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  protected override getEnemyEntities(): readonly EnemyEntity[] {
    return this.spawned.map((spawn) => spawn.entity);
  }

  protected override getEnemyBullets(): readonly GymLevelBullet[] {
    return this.enemyBullets;
  }

  protected override setEnemyBullets(bullets: GymLevelBullet[]): void {
    this.enemyBullets = bullets;
  }

  // ── Scene update loop ────────────────────────────────────────────

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds): moves enemies, advances
   * enemy/player bullets, runs the shared player-control step and collision
   * pass, then checks whether the current wave has been cleared.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // Enemy movement (drift + per-entity positioning).
    this._moveEnemies(dt);

    // Enemy bullets: wrap + lifetime expiry (shared helper).
    advanceWrappingBullets(this.enemyBullets, dt, GAME_WIDTH, GAME_HEIGHT);

    // Live enemies fire through the shared dispatcher (firing waves only).
    this.enemyBullets.push(
      ...fireLiveEnemies(this.spawned, this.time.now),
    );

    // Shared input → timers → multipliers → physics → auto-fire step.
    this._tickPlayer(dt);

    // Player bullets: advance + wrap + lifetime expiry (shared helper).
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);

    // Automatic defence danger feed (shared), before collision gating.
    this._updateAutoDefence(dt);

    // Shared collision pass.
    this._handleCollisions();

    // Post-hit invulnerability blink (shared).
    this._updateInvulnerability(dt);

    // Supply layer: mineral collection/absorption + power-up/weapon drops,
    // through the shared `collectMinerals` / drop-layer paths.
    this._updateSupplies(dt);

    // Timed effects (shared ordering).
    this.effectsRegistry.tick(dt);
    this.hud?.refresh();

    // Wave progression.
    this._checkWaveComplete();
  }

  // ── Reset / teardown ─────────────────────────────────────────────

  protected override resetRunState(): void {
    super.resetRunState();
    this.player?.destroy();
    this.player = null;
    this.spawned = [];
    this.enemyBullets = [];
    this.currentWaveIndex = 0;
    this.levelComplete = false;
    this.driftX = 0;
    this.driftDir = 1;
    // Supply layer state.
    this.minerals = [];
    this.mineralsSeeded = 0;
    this.mineralHold.reset();
    this.drops = [];
    this.dropSpawner = null;
    this.dropPlacement = null;
    this.dropSpawnTimer = 0;
    this.dropSpawnInterval = 0;
    this.hud = null;
  }

  protected override teardownRunState(): void {
    super.teardownRunState();
    this.player?.destroy();
    this.player = null;
    this.cursors = undefined;
    this.wasd = undefined;
    cleanupWave(this.spawned, this.enemyBullets);
    this.statusText?.destroy();
    this.statusText = null;
    // Supply layer cleanup.
    for (const mineral of this.minerals) mineral.destroy();
    this.minerals = [];
    for (const drop of this.drops) drop.graphics.destroy();
    this.drops = [];
    this.hud?.destroy();
    this.hud = null;
    this.mineralHold.reset();
  }

  // ── Public test accessors ────────────────────────────────────────

  /** Number of waves queued for this session. */
  getWavesToPlayCount(): number {
    return this.wavesToPlay.length;
  }

  /** Current wave index (0-based). */
  getCurrentWaveIndex(): number {
    return this.currentWaveIndex;
  }

  /** True once every wave has been cleared. */
  isLevelComplete(): boolean {
    return this.levelComplete;
  }

  /** HUD label for the level/wave. */
  getLabel(): string {
    return this.label;
  }

  /** Live enemies (copy). */
  getEnemies(): EnemyEntity[] {
    return this.spawned.map((spawn) => spawn.entity);
  }

  /** Player bullets in flight (copy). */
  getPlayerBullets(): PlayerBullet[] {
    return [...this.playerBullets];
  }

  /** The wave currently being played. */
  getCurrentWave(): WaveDefinition | undefined {
    return this.wavesToPlay[this.currentWaveIndex];
  }

  /** The player ship (for weapon assertions). */
  getShip(): Player | null {
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

  // ── Supply-layer accessors ──────────────────────────────────────

  /** Live minerals on the field (copy). */
  getMinerals(): Mineral[] {
    return [...this.minerals];
  }

  /** Live power-up/weapon drops on the field (copy). */
  getDrops(): CombatDrop[] {
    return [...this.drops];
  }

  /** Cumulative minerals seeded since the level started. */
  getSeededMineralCount(): number {
    return this.mineralsSeeded;
  }

  /** Current mineral hold value. */
  getMineralHold(): number {
    return this.mineralHold.store;
  }

  /** Current mineral hold capacity. */
  getMineralCapacity(): number {
    return this.mineralHold.capacity;
  }

  /** The effects/mineral HUD (null before create/after teardown). */
  getHud(): HUD | null {
    return this.hud;
  }

  /** Overrides the supply RNG (a seeded RNG for deterministic runs/tests). */
  setSupplyRng(rng: () => number): void {
    this.supplyRng = rng;
  }
}

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
 *
 * ## Scenario pressures (AH-0MV9AWR7A0084XJ0)
 *
 * Like the shipped demo, every wave runs a 30 s timed window (the shared
 * `CombatScene` wave-timeout, with `PlayScene`'s carry-over semantics) and a
 * scheduled random offscreen asteroid hazard planned by the shared
 * `AsteroidHazardLayer` (`computeSpawns`). Live asteroids are non-blocking —
 * they never gate wave completion and persist across wave transitions
 * (`isNonBlockingHazard`) — and `getWaveState()` reports the live wave clock,
 * so a bot in a gym sees the same hazard and wave-pressure signals it sees in
 * the game. `setAsteroidSpawnerEnabled(false)` is a tuning/test seam.
 */

import Phaser from 'phaser';

import { CombatScene, type CombatDrop } from '../core/CombatScene';
import { pushAimTargets, pushSeekTargets } from '../core/enemyTargeting';
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
  type FormationOffset,
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
import {
  rollAsteroidExtraLife,
  type AsteroidKillDropEntity,
} from '../core/asteroidKillDrops';
import {
  AsteroidHazardLayer,
  createAsteroidFromEvent,
} from '../core/asteroidHazard';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';
import type { SpawnEvent } from '../../waves/AsteroidSpawner';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import {
  WORMHOLE_OPEN_DURATION,
  WormholeController,
  formationCentre,
  formationExtents,
  getSpawnState,
  placeWavePortal,
  startSpawnAnimation,
  updateEnemyShimmer,
  updateSpawnAnimation,
  type PortalPoint,
  type SpawnAnimatable,
} from '../../vfx/wormholeSpawn';

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
  /**
   * True for a scheduled **non-blocking world hazard** spawn (the shared
   * asteroid hazard). Hazards never gate wave completion and persist across
   * wave transitions, exactly as in the game. Explicit (not key-derived) so a
   * hazard-looking key inside a wave group still gates its wave.
   */
  hazard?: boolean;
  /** Formation base x at spawn (px). */
  startX: number;
  /** Formation base y at spawn (px). */
  startY: number;
  /** Horizontal formation spacing (px). */
  spacingX: number;
  /** Vertical formation spacing (px). */
  spacingY: number;
  /** This enemy's formation offset (drives its live transit destination). */
  offset: FormationOffset;
}

/**
 * Options for {@link spawnWave}.
 *
 * The wormhole-entry options are how the level gym reproduces the game's
 * spawn presentation (AH-0MV8BSMXC0097KLW, gym↔game parity): every enemy is
 * created at the wave's wormhole origin and traverses to its formation slot
 * over the spawn-protection window. Omitting them keeps the legacy in-place
 * spawn (used by callers/tests that only need the plan).
 */
export interface GymLevelWaveSpawnOptions {
  /** The wave's wormhole origin (px) — where every enemy emerges. */
  origin?: PortalPoint;
  /** Live formation drift (px) for this frame, read by the transit target. */
  getDriftX?: () => number;
}

// ── Wave spawning ──────────────────────────────────────────────────

/**
 * Spawns every group of one wave and returns the enemy bullets fired during
 * spawn. Uses the shared formation builders and the config-aware entity
 * factory so the level gym spawns the *same* entities as the game.
 *
 * With `options.origin` supplied (the launched wave's wormhole) each enemy is
 * created **at the wormhole** and starts the shared spawn animation with a
 * live destination resolver, so it grows from 1 px and transits to its
 * slot exactly as `PlayScene._spawnEnemy` does. Entities with autonomous
 * positioning (e.g. the Raider) emerge at the origin with no destination and
 * their own motion carries them out (game parity).
 */
export function spawnWave(
  scene: Phaser.Scene,
  wave: WaveDefinition,
  spawned: LevelSpawn[],
  options: GymLevelWaveSpawnOptions = {},
): GymLevelBullet[] {
  const bullets: GymLevelBullet[] = [];
  const origin = options.origin;

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
      const enemy = createEnemyFromConfig(
        scene,
        baseConfig,
        origin?.x ?? x,
        origin?.y ?? y,
        offset,
      );
      scene.add.existing(enemy);
      spawned.push({
        entity: enemy,
        key,
        startX: group.startX,
        startY: group.startY,
        spacingX: group.spacingX,
        spacingY: group.spacingY,
        offset,
      });
      // Wormhole-entry transit: the destination is the live formation slot
      // (drift tracked every frame), matching `PlayScene._spawnEnemy`.
      const autonomous =
        (enemy as { autonomousPositioning?: boolean }).autonomousPositioning ===
        true;
      startSpawnAnimation(
        enemy as unknown as SpawnAnimatable,
        enemy.scaleX,
        WORMHOLE_OPEN_DURATION,
        origin && !autonomous
          ? () => {
              const drift = options.getDriftX?.() ?? 0;
              return {
                x: group.startX + drift + offset.col * group.spacingX,
                y: group.startY + offset.row * group.spacingY,
              };
            }
          : undefined,
      );
      enemy.setSpawning(true);
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
  /**
   * Single-live wormhole lifecycle for the launched waves, shared with
   * `PlayScene` and every formation gym (AH-0MV9KHLV8006GMX6) so a wave
   * transition can never strand a live wormhole.
   */
  private readonly _wormhole = new WormholeController(this);
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
  /**
   * Persisted chance a destroyed small asteroid additionally drops an Extra
   * Life (AH-0MV6M2M9P0078N4S). Loaded from the game rules in
   * `_initSupplyLayer`; read by the shared `rollAsteroidExtraLife` rule.
   */
  private asteroidExtraLifeDropChance = 0;
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

  /**
   * Live formation drift (px) applied to every non-roaming enemy slot.
   * Test seam (parity with `GymFormationScene.formationX`).
   */
  getFormationDriftX(): number {
    return this.driftX;
  }

  // ── Scheduled asteroid hazard + timed waves (AH-0MV9AWR7A0084XJ0) ──
  //
  // The shipped game plays a random offscreen asteroid hazard inside a timed
  // wave window; the bot-tuning gym used to play formation-only levels with no
  // hazard and no wave clock, so tuning there did not transfer to the demo.
  // The level gym now runs the *same* shared pieces: the
  // `AsteroidHazardLayer` plan/release lifecycle (also used by `PlayScene`)
  // and the shared `CombatScene` wave-timeout carry-over window.

  /**
   * RNG for the asteroid hazard plan. Defaults to `Math.random`;
   * `GymBotTuning` overrides it with a seeded RNG so a seed reproduces the
   * same hazard schedule.
   */
  protected hazardRng: () => number = () => Math.random();

  /** Scheduled asteroid hazard for the active wave (shared layer). */
  private readonly asteroidHazard = new AsteroidHazardLayer();

  /**
   * Whether the gym schedules the game's offscreen asteroid hazard. Mirrors
   * `PlayScene.setAsteroidSpawnerEnabled`; disabling drops any pending plan.
   */
  private asteroidHazardEnabled = true;

  /**
   * Cumulative 0-based index of the next wave to start, across this gym
   * session — the asteroid escalation input, mirroring
   * `WaveManager.globalWaveIndex` in the game.
   */
  private globalWaveIndex = 0;

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
    this.globalWaveIndex = 0;
    this.asteroidHazard.reset();

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

    // The wave enters through a wormhole exactly as it does in the game
    // (AH-0MV8BSMXC0097KLW, gym↔game parity): the portal opens at the centre
    // of the wave's formation (gyms have no ship to avoid, so the shared
    // `placeWavePortal` keeps the anchor) and every enemy emerges there and
    // transits to its slot over the spawn-protection window. The controller
    // closes any still-open previous wormhole first (single-live invariant).
    const portal = this._resolveWavePortal(wave);
    if (portal) {
      this._wormhole.open(portal.x, portal.y, this.wormholeEffects);
    }
    this.enemyBullets.push(
      ...spawnWave(this, wave, this.spawned, {
        origin: portal ?? undefined,
        getDriftX: () => this.driftX,
      }),
    );
    // Timed wave parity (AH-0MV9AWR7A0084XJ0): the game's regular waves run a
    // 30 s window that carries survivors into the next wave. Arm the shared
    // wave-timeout for every gym wave so the bot sees the same
    // `getWaveState()` pressure signal the demo does.
    this.startWaveTimeout();
    // Plan this wave's random offscreen asteroid hazard with the same shared
    // planner the game uses (one plan per wave, so the RNG stream only
    // advances at wave boundaries).
    this._planAsteroidSpawns();
    this.globalWaveIndex += 1;
    // Spawn cue, matching the other gym scenes (GymFormationScene plays the
    // shared spawn sound once per wave). Without this the launched level is
    // silent on entry — the second half of the producer audit.
    playSpawnSound();
  }

  /**
   * Chooses where the wave's wormhole opens.
   *
   * The portal is the **centre of the wave's planned formation**, computed
   * from the same shared formation builders that lay the wave out, so the
   * enemies' final positions are centred on the wormhole and no enemy
   * traverses the full formation extent (producer audit on
   * AH-0MV8BSMXC0097KLW). Gyms have no player ship, so `placeWavePortal`
   * returns the anchor unchanged — the same shared code path `PlayScene`
   * runs with a ship (AC4, gym↔game parity).
   *
   * @returns The portal position, or `null` for a wave with no enemies.
   */
  private _resolveWavePortal(wave: WaveDefinition): PortalPoint | null {
    const points: PortalPoint[] = [];
    for (const group of wave.groups) {
      for (const offset of getFormationBuilder(group.formation)(group.count)) {
        points.push(
          computeFormationPosition(
            group.startX,
            group.startY,
            offset,
            group.spacingX,
            group.spacingY,
          ),
        );
      }
    }
    if (points.length === 0) return null;
    const portal = placeWavePortal({
      formation: formationExtents(points),
      anchor: formationCentre(points),
      playfield: { width: GAME_WIDTH, height: GAME_HEIGHT },
      // Gyms have no in-game ship: the portal stays at the formation anchor.
      player: null,
    });
    return { x: portal.x, y: portal.y };
  }

  /**
   * Plans the active wave's scheduled asteroid hazard with the shared planner
   * (`AsteroidHazardLayer` → `computeSpawns`). Called once per wave from
   * {@link _spawnCurrentWave} so the RNG stream only advances at wave
   * boundaries, exactly as `PlayScene.planAsteroidSpawns()` does.
   */
  private _planAsteroidSpawns(): void {
    if (!this.asteroidHazardEnabled) {
      this.asteroidHazard.reset();
      return;
    }
    this.asteroidHazard.plan(
      this.globalWaveIndex,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      this.hazardRng,
    );
  }

  /**
   * Releases every planned asteroid spawn whose scheduled time has passed.
   * Runs before the wave clock advances (like `PlayScene`), so a wave timeout
   * cannot release the rest of the plan.
   */
  private _releaseDueAsteroidSpawns(): void {
    const duration = this.getWaveTimeoutDuration();
    if (duration <= 0) return;
    const elapsed = duration - this.getWaveTimeoutRemaining();
    this.asteroidHazard.releaseDue(elapsed, (event) =>
      this._spawnScheduledAsteroid(event),
    );
  }

  /**
   * Spawns one planned asteroid through the shared factory. Asteroids are
   * non-blocking hazards: like the game, they never gate wave completion and
   * persist across wave/level transitions (`isNonBlockingHazard`).
   */
  private _spawnScheduledAsteroid(event: SpawnEvent): void {
    const entity = createAsteroidFromEvent(this, event, this.hazardRng);
    this.spawned.push({
      entity,
      key: 'asteroid',
      hazard: true,
      startX: 0,
      startY: 0,
      spacingX: 0,
      spacingY: 0,
      // Roaming hazards ignore the formation slot; the offset is required by
      // the spawn contract and is never used for transit positioning.
      offset: { row: 0, col: 0 },
    });
  }

  /** Advances to the next wave once the current one is clear. */
  private _checkWaveComplete(): void {
    if (this.levelComplete) return;
    // Non-blocking world hazards (the scheduled asteroids) never gate wave
    // completion, exactly as in the game (AH-0MUJM746P000QAEO).
    const blocking = this.spawned.filter((spawn) => !spawn.hazard);
    if (!isWaveClear(blocking)) return;

    this.currentWaveIndex++;
    if (this.currentWaveIndex >= this.wavesToPlay.length) {
      this._onLevelComplete();
      return;
    }
    this._clearWaveEnemies();
    this.driftX = 0;
    this.driftDir = 1;
    this._spawnCurrentWave();
  }

  /**
   * Clears the finished wave's blocking enemies and stray enemy bullets while
   * keeping live **non-blocking hazards** on the field — asteroids persist
   * across wave/level transitions exactly as they do in the game
   * (AH-0MUJM746P000QAEO).
   */
  private _clearWaveEnemies(): void {
    for (const bullet of this.enemyBullets) {
      try {
        bullet.graphics.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.enemyBullets = [];
    for (const spawn of this.spawned) {
      if (spawn.hazard) continue;
      try {
        spawn.entity.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.spawned = this.spawned.filter(
      (spawn) => spawn.hazard === true && spawn.entity.alive,
    );
  }

  /**
   * Wave-timeout expiry (carry-over semantics, mirroring `PlayScene`): living
   * enemies stay on the field and the next wave spawns alongside them, so the
   * wave only clears once the fresh spawns *and* the survivors are destroyed
   * (AH-0MUNS3ZQ1002DJ9S). When the final wave times out there is no next wave
   * to advance to: the survivors stay and the level completes once they are
   * cleared.
   */
  protected override onWaveTimeoutExpired(): void {
    if (this.levelComplete) return;
    const hasNextWave = this.currentWaveIndex + 1 < this.wavesToPlay.length;
    if (!hasNextWave) {
      this.statusText?.setText(
        `${this.label} — Wave ${this.wavesToPlay.length}/${this.wavesToPlay.length} (over time)`,
      );
      return;
    }
    this.currentWaveIndex++;
    // Drop only the dead enemies; survivors keep their formation slots and
    // continue moving/firing into the next wave (no timeout penalty wave).
    this.spawned = this.spawned.filter((spawn) => spawn.entity.alive);
    this.driftX = 0;
    this.driftDir = 1;
    this._spawnCurrentWave();
  }

  /** Marks the level complete and clears the field. */
  private _onLevelComplete(): void {
    this.levelComplete = true;
    this.hideWaveTimeout();
    this.asteroidHazard.reset();
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
    this.globalWaveIndex = 0;
    this.hideWaveTimeout();
    this.asteroidHazard.reset();
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
    this.asteroidExtraLifeDropChance = rules.asteroidExtraLifeDropChance;

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
      .map((enemy) => {
        // (AH-0MV8BSMXC0097KLW) A spawning enemy is mid-emergence — its
        // transient transit position hugs the wormhole and would mislead drop
        // placement. Avoid the slot it settles on instead (parity with
        // `GymFormationScene._powerUpPlacementContext`).
        let x = enemy.x;
        let y = enemy.y;
        const state = getSpawnState(enemy as unknown as SpawnAnimatable);
        if (state) {
          x = state.destX;
          y = state.destY;
        }
        return { x, y, radius: enemy.getHitRadius() };
      });
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
    // Shared per-kill Extra Life roll (AH-0MV6M2M9P0078N4S): a fully
    // destroyed small asteroid additionally rolls the configurable Extra
    // Life drop, exactly as the game does. The rule tier-gates first.
    if (
      rollAsteroidExtraLife(
        enemy as unknown as AsteroidKillDropEntity,
        this.supplyRng,
        this.asteroidExtraLifeDropChance,
      )
    ) {
      this.spawnSupplyDrop('extra_life', enemy.x, enemy.y);
    }
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

    // Live mineral-seek: push the scene's live mineral field so roaming
    // seekers (Harvester) steer toward the nearest live mineral — parity with
    // PlayScene._moveEnemies, which passes its live field. The previous empty
    // array silently diverged (Harvesters held station) in every
    // GymLevel-based gym (shared helper, AH-0MV5SDNI2008RWQ2).
    pushSeekTargets(
      this.spawned
        .filter((spawn) => spawn.entity.alive)
        .map((spawn) => spawn.entity),
      this.minerals,
    );

    for (const spawn of this.spawned) {
      if (!spawn.entity.alive) continue;
      const entity = spawn.entity;

      // Asteroids and other roaming entities advance their own motion and
      // ignore the formation drift (matches the game).
      if (spawn.key === 'asteroid' || entity.updatePosition) {
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

  getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  protected override getEnemyEntities(): readonly EnemyEntity[] {
    return this.spawned.map((spawn) => spawn.entity);
  }

  /** Enemy bullets in flight (public, mirroring `PlayScene.getEnemyBullets`). */
  override getEnemyBullets(): readonly GymLevelBullet[] {
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

    // Live aim tracking: push the ship's live position into every alive
    // aimed enemy BEFORE this frame's fire is collected — the identical seam
    // and ordering PlayScene._collectEnemyFire uses (shared helper,
    // AH-0MV5SDNI2008RWQ2). This fixes the bot/level gyms, where aimed
    // archetypes (Diver, Scout, …) previously kept the constructor's fixed
    // bottom-centre stand-in target.
    pushAimTargets(
      this.spawned
        .filter((spawn) => spawn.entity.alive)
        .map((spawn) => spawn.entity),
      this.player,
    );

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

    // Advance the wormhole spawn animation before the shared collision pass,
    // so an enemy that finishes growing this frame is collidable on the same
    // frame it becomes whole (identical ordering to `PlayScene`).
    this._updateSpawnAnimations(dt);

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

    // Wave progression: release any asteroid spawns whose planned time has
    // passed before the wave clock advances (so a timeout cannot release the
    // rest of the plan), then advance the shared wave-timeout.
    if (!this.levelComplete) {
      this._releaseDueAsteroidSpawns();
      this._advanceWaveTimeout(dt);
    }
    this._drawWaveTimeoutBar();
    this._checkWaveComplete();
  }

  /**
   * Advances the wormhole spawn animation for every spawning enemy.
   * Once every enemy has finished growing the wormhole closes and the spawn
   * sequence is complete (AH-0MV8BSMXC0097KLW, gym parity with `PlayScene`).
   */
  private _updateSpawnAnimations(dt: number): void {
    let anySpawning = false;
    for (const spawn of this.spawned) {
      if (!spawn.entity.isSpawning) continue;
      const stillGrowing = updateSpawnAnimation(
        spawn.entity as unknown as SpawnAnimatable,
        dt,
      );
      // Per-entity emergence shimmer (AH-0MVD2N333004VDA9) rides the same
      // shared spawn path, immediately after the growth write so its scale
      // pulse layers on the growth scale instead of fighting it
      // (AH-0MVD2N9MM0007NGZ wiring).
      updateEnemyShimmer(spawn.entity as unknown as SpawnAnimatable, dt);
      if (stillGrowing) {
        anySpawning = true;
      } else {
        spawn.entity.setSpawning(false);
      }
    }
    if (!anySpawning) this._wormhole.close(this.wormholeEffects);
  }

  /**
   * Test seam: immediately completes any in-progress wormhole spawn
   * animations without ticking the whole scene (AH-0MURBER4L00821RR /
   * AH-0MV8BSMXC0097KLW). Not used by gameplay.
   */
  finishSpawnAnimations(): void {
    for (const spawn of this.spawned) {
      if (!spawn.entity.isSpawning) continue;
      updateSpawnAnimation(spawn.entity as unknown as SpawnAnimatable, 10);
      spawn.entity.setSpawning(false);
    }
    this._wormhole.close(this.wormholeEffects);
  }

  /** True while the wave's wormhole is live (single-live controller). */
  isWormholeOpen(): boolean {
    return this._wormhole.isOpen;
  }

  /** Live wormhole VFX containers (test seam; a copy). */
  getWormholeEffects(): Phaser.GameObjects.Container[] {
    return [...this.wormholeEffects];
  }

  /** Enemy bullets in flight (test seam; a copy). */
  getActiveEnemyBullets(): GymLevelBullet[] {
    return [...this.enemyBullets];
  }

  // ── Reset / teardown ─────────────────────────────────────────────

  protected override resetRunState(): void {
    super.resetRunState();
    this._wormhole.reset();
    this.player?.destroy();
    this.player = null;
    this.spawned = [];
    this.enemyBullets = [];
    this.currentWaveIndex = 0;
    this.levelComplete = false;
    this.driftX = 0;
    this.driftDir = 1;
    this.globalWaveIndex = 0;
    this.asteroidHazard.reset();
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
    this._wormhole.reset();
    this.player?.destroy();
    this.player = null;
    this.cursors = undefined;
    this.wasd = undefined;
    cleanupWave(this.spawned, this.enemyBullets);
    this.asteroidHazard.reset();
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

  // ── Timed waves + asteroid hazard accessors (AH-0MV9AWR7A0084XJ0) ──

  /**
   * The active wave's timed state — the same shape as
   * `PlayScene.getWaveState()` and the bot snapshot's `wave` field, so the
   * gym reports real wave pressure instead of a hard-coded inactive state.
   */
  getWaveState(): { active: boolean; timeRemaining: number; timeLimit: number } {
    return {
      active: this.isWaveTimeoutActive(),
      timeRemaining: this.getWaveTimeoutRemaining(),
      timeLimit: this.getWaveTimeoutDuration(),
    };
  }

  /**
   * Opt the level gym into the shared wave-timeout (carry-over window), so a
   * regular wave runs the game's 30 s clock (AH-0MV9AWR7A0084XJ0).
   */
  protected override getWaveTimeoutDuration(): number {
    return this.wavesToPlay.length > 0 && !this.levelComplete
      ? WAVE_TIME_LIMIT_SECONDS
      : 0;
  }

  /** Live asteroids on the field (scheduled hazard spawns). */
  getAsteroids(): Asteroid[] {
    return this.spawned
      .map((spawn) => spawn.entity)
      .filter((entity): entity is Asteroid => entity instanceof Asteroid);
  }

  /** The planned asteroid spawn events for the active wave (copy). */
  getPendingAsteroidSpawns(): readonly SpawnEvent[] {
    return this.asteroidHazard.getPlan();
  }

  /** How many planned asteroid spawns have been released this wave. */
  getReleasedAsteroidCount(): number {
    return this.asteroidHazard.getReleasedCount();
  }

  /** How many waves have started this gym session. */
  getGlobalWaveIndex(): number {
    return this.globalWaveIndex;
  }

  /**
   * Enables or disables the scheduled asteroid hazard (tuning/test seam,
   * mirroring `PlayScene.setAsteroidSpawnerEnabled`). Disabling drops the
   * current plan immediately.
   */
  setAsteroidSpawnerEnabled(enabled: boolean): void {
    this.asteroidHazardEnabled = enabled;
    if (!enabled) this.asteroidHazard.reset();
  }

  /** Overrides the asteroid-hazard RNG (seeded runs/tests); takes effect at
   * the next wave's plan. */
  setHazardRng(rng: () => number): void {
    this.hazardRng = rng;
  }
}

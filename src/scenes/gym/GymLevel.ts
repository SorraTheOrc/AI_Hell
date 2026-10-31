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
 * ## Spawn parity (AH-0MVRMHSKH0066J9B)
 *
 * A launched level spawns, transits, marches and fires through the same shared
 * seams as the shipped game, so the gym is a faithful preview:
 *
 * - Each enemy's wormhole destination is resolved by the shared
 *   `resolveSpawnTransitTarget` (`src/scenes/core/spawnTransit.ts`): an orbital
 *   enemy targets its live `formationSlot()` (no line-then-snap), an autonomous
 *   mover is exempt, and every other enemy keeps its grid slot.
 * - Every spawned entity inherits the wave's `shootEnabled`, as
 *   `PlayScene._spawnEnemy` does, so a launched level 4+ wave is threatening.
 * - A `march` wave steps and drops through the shared
 *   `createMarchState` / `advanceMarch` block, and each spawn is re-anchored to
 *   the live march base exactly as it is in the game.
 *
 * The behaviour is pinned by `src/scenes/gym/spawnParity.test.ts`, and
 * `GymBotTuning` inherits it through this scene.
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
 * ## Level scaling and the formation-gym divergence (AH-0MVLJF886009584F)
 *
 * A launched level plays with the game's level scaling, so tuning in the gym
 * transfers to the shipped campaign:
 *
 * - Every wave's group counts pass through the **same shared**
 *   `applyEnemyCountScaling` seam `PlayScene.resolveCampaignLevels` uses, with
 *   the launched `LevelDefinition.level` (rounding/floor/cap/`single` rules
 *   included), so a level gym spawns the counts the game spawns.
 * - The timed supply cadence is lengthened by the **inverse** per-kill
 *   drop-chance ratio: `interval(level) = interval(1) × chance(1) /
 *   chance(level)`, mirroring the game's falling drop chance, so high-level
 *   gym runs are not over-supplied relative to the game.
 *
 * Single-wave launches (`GymCurveSequencer._launchWave`) send `level: 0`,
 * which `clampLevel` resolves to level 1 — the identity transform for both
 * axes, so single-wave behaviour is unchanged.
 *
 * **Documented divergence (parent AC "Gym parity", AH-0MVHT1M6O003PU7P):**
 * the formation gyms (`GymFormationScene` and its scenes — `GymBoss`,
 * `GymCentipede`, `GymFodderEnemies`, …) have **no campaign-level input at
 * all**, so they keep their scene-specific flat
 * `rules.powerUpSpawnInterval` supply source unchanged. Only the level-based
 * gyms (`GymLevel` and `GymBotTuning` through inheritance) adopt the level
 * curves.
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
import {
  applyPostMotionWrapAll,
  PLAYFIELD_WORLD,
  type WrapAwareBody,
} from '../core/enemyWrap';
import {
  resolveSpawnTransitTarget,
  type SpawnTransitEntity,
  type SpawnTransitInput,
  type SpawnTransitPoint,
} from '../core/spawnTransit';
import {
  advanceMarch,
  computeMarchBounds,
  createMarchState,
  DEFAULT_MARCH_DROP,
  DEFAULT_MARCH_STEP,
  type MarchOptions,
  type MarchState,
} from '../core/marchFormation';
import {
  FormationReanchorController,
  type FormationReanchorCandidate,
} from '../core/formationReanchor';
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
import { enemyForceFieldHits } from '../../core/enemyForceField';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../../core/constants';
import { loadRules, type GameRules } from '../../core/rules';
import {
  applyEnemyCountScaling,
  dropChanceRatio,
} from '../../core/levelScaling';
import { LEVELS } from '../../waves/Formations';
import { playSpawnSound } from '../../audio/effects';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import type { WasdKeysLike } from '../../utils/input';
import { EffectsRegistry } from '../../powerups/effects';
import { HUD } from '../../ui/HUD';
import { combatHudOptions } from '../core/hudWiring';
import { Mineral } from '../../entities/Mineral';
import { Asteroid } from '../../entities/Asteroid';
import { Centipede } from '../../entities/Centipede';
import { LaneTraffic } from '../../entities/LaneTraffic';
import { OrbitalStrike } from '../../entities/OrbitalStrike';
import { CentipedeChain } from '../core/centipedeChain';
import {
  CENTIPEDE_DESCENT_SPEED,
  CENTIPEDE_ENEMY_KEY,
  CENTIPEDE_LATERAL_SPEED,
  CENTIPEDE_SEGMENT_SPACING,
  centipedeArena,
  type CentipedeSpawnEvent,
} from '../../waves/CentipedeSpawner';
import type { GhostSpawnEvent } from '../../waves/GhostSpawner';
import type { HordeSpawnEvent } from '../../waves/HordeSpawner';
import type { LaneTrafficSpawnEvent } from '../../waves/LaneTrafficSpawner';
import type { SpawnEvent as StrikeSpawnEvent } from '../../waves/StrikeSpawner';
import {
  planCentipedeWaveSpawn,
  planGhostWaveSpawns,
  planHordeWaveSpawns,
  planLaneTrafficWaveSpawns,
  planStrikeWaveSpawns,
  releaseDueSpawns,
} from '../core/dynamicSpawnPlan';
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
  toChoiceOption,
  type ChoiceOption,
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
import type {
  LevelDefinition,
  WaveDefinition,
  WaveGroup,
} from '../../waves/Formations';
import {
  applySceneSetup,
  DEFAULT_GYM_LEVEL_WEAPONS,
  resolveMineralReward,
  resolveSetupSeed,
  type SceneSetupState,
} from '../core/sceneSetup';
import { createSeededRng } from '../../core/rng';
import {
  WORMHOLE_OPEN_DURATION,
  WormholeController,
  formationCentre,
  formationExtents,
  getSpawnState,
  placeWavePortal,
  startSpawnAnimation,
  updateSpawnAnimation,
  updateSpawnEmergence,
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
  /**
   * Optional 1-based wave to start at (capture setups, AH-0MVNW8VNN004FFK1).
   * Clamped to the level's wave list; absent ⇒ the first wave.
   */
  startWave?: number;
  /** Optional player loadout / power-up levels (capture setups). */
  player?: SceneSetupState['player'];
  /** Optional power-up id → permanent level (capture setups). */
  powerUps?: SceneSetupState['powerUps'];
  /**
   * Optional forced hold-full reward id (capture setups, AH-0MVRMFOB4002LMZS).
   * When present, a full mineral hold resolves to that reward instead of a
   * random one, so a scripted pay-off lands deterministically on camera.
   */
  mineralReward?: SceneSetupState['mineralReward'];
  /**
   * Optional 32-bit determinism seed (capture setups, AH-0MVNW90FB003H3KM).
   * When present, the supply and asteroid RNGs are seeded from it so a config
   * reproduces the same minerals/drops/asteroid plan.
   */
  seed?: number;
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

/**
 * Per-enemy spawn metadata needed to reposition it each frame.
 *
 * `march` marks a member of the wave's shared march block (Space Invaders
 * archetype): such enemies are positioned from the live march state instead of
 * the global continuous drift, exactly as `PlayScene` positions them
 * (AH-0MVRMHSKH0066J9B AC3).
 */
export interface LevelSpawn {
  /** The spawned enemy entity. */
  entity: EnemyEntity;
  /** Archetype key, for the shared fire dispatcher. */
  key: string;
  /**
   * True when this enemy belongs to the wave's shared march block (Space
   * Invaders archetype): it is positioned from the live march state instead of
   * the global continuous drift, exactly as `PlayScene` positions it.
   */
  march?: boolean;
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
  /**
   * Live shared march-formation state for the active wave (Space Invaders
   * archetype), or `null` when the wave has no march block. Read every frame
   * by a march spawn's transit target so it lands on the moving block, exactly
   * as `PlayScene._spawnEnemy` does (AH-0MVRMHSKH0066J9B AC3).
   */
  getMarchState?: () => MarchState | null;
  /**
   * The formation RNG threaded into `createEnemyFromConfig`, so per-enemy
   * randomness (e.g. the Scout's wiggle phase and shot-probability roll) is
   * the same deterministic stream the game uses at the same seed
   * (AH-0MVRMHSKH0066J9B). Defaults to the entity factory's `Math.random`.
   */
  rng?: () => number;
  /**
   * Campaign level the wave is launched at, used to resolve enemy force
   * fields through the shared pure curve (`enemyForceFieldHits`). The level
   * gym passes its launched `levelNumber`; a single-wave launch sends `0`,
   * which resolves to level 1 (the identity, unshielded for the shipped
   * defaults). Omitting it is also treated as level 1.
   */
  level?: number;
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
  // Campaign level for force-field resolution (AH-0MVM8GXEF009883O).
  const level = options.level ?? 1;

  for (const group of wave.groups) {
    const baseConfig = loadEnemyConfig(group.enemyKey);
    const key = baseConfig.key || group.enemyKey;
    const buildOffsets = getFormationBuilder(group.formation);
    // Resolve the force field ONCE per group through the same shared curve the
    // game uses at its run level, and thread it down the common factory path
    // (game↔gym parity, epic AH-0MVJ8W4GE007OMNT AC4). A formation gym without
    // campaign context sets the hits directly instead (see GymFodderEnemies).
    const forceFieldHits = enemyForceFieldHits(level, baseConfig);
    // A march-config archetype rides the wave's shared march block, exactly as
    // `PlayScene` marks it from `cfg.formationKind === 'march'`.
    const isMarch = baseConfig.formationKind === 'march';

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
        // The formation RNG, threaded exactly as `PlayScene._spawnEnemy`
        // threads its run RNG (AH-0MVRMHSKH0066J9B).
        options.rng,
        forceFieldHits,
      );
      // Fire hand-off, exactly as `PlayScene._spawnEnemy` does: the wave's
      // rule flows onto every entity its group spawned (campaign Levels 4+
      // carry `shootEnabled: true`). `BaseEnemy` defaults to `false`, so
      // omitting this made every launched wave silently non-threatening.
      enemy.shootEnabled = wave.shootEnabled;
      scene.add.existing(enemy);
      spawned.push({
        entity: enemy,
        key,
        march: isMarch,
        startX: group.startX,
        startY: group.startY,
        spacingX: group.spacingX,
        spacingY: group.spacingY,
        offset,
      });
      // Wormhole-entry transit: the destination comes from the shared seam
      // (AH-0MVRMHQC9003VDNN); the level gym owns the launched-formation
      // base plus its live drift/march base, matching `PlayScene._spawnEnemy`.
      // The entity itself is passed (not a reduced shape), so an orbital
      // Phaser's live `formationSlot()` seam stays authoritative and it
      // transits straight onto its ring instead of a straight grid line
      // (AH-0MVRMHSKH0066J9B AC1). A march spawn's base is the live march
      // state (AH-0MVRMHSKH0066J9B AC3).
      const transitEntity: SpawnTransitEntity = enemy as unknown as SpawnTransitEntity;
      const transitInput = (base: SpawnTransitPoint): SpawnTransitInput => ({
        entity: transitEntity,
        transit: origin !== undefined,
        base,
        offset,
        spacingX: group.spacingX,
        spacingY: group.spacingY,
      });
      const transitBase = (): SpawnTransitPoint => {
        const marchState = options.getMarchState?.() ?? null;
        return isMarch && marchState
          ? { x: marchState.x, y: marchState.y }
          : { x: group.startX + (options.getDriftX?.() ?? 0), y: group.startY };
      };
      // Resolved once up front so an exempt spawn gets no destination
      // function at all (a destination would pin the entity to its origin).
      const transitTarget = resolveSpawnTransitTarget(
        transitInput(transitBase()),
      );
      startSpawnAnimation(
        enemy as unknown as SpawnAnimatable,
        enemy.scaleX,
        WORMHOLE_OPEN_DURATION,
        transitTarget
          ? () =>
              resolveSpawnTransitTarget(transitInput(transitBase())) ??
              transitTarget
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

  /**
   * The active wave's shared march-formation state (test/parity seam), or
   * `null` when the wave has no march block. Mirrors the live state the
   * position and transit passes consume.
   */
  getMarchState(): MarchState | null {
    return this.marchState ? { ...this.marchState } : null;
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

  // ── Spawner-delivered dynamic content (D3, docs/GYM_PARITY.md) ─────
  //
  // The same per-wave opt-in flags the game honours (`ghosts`, `centipede`,
  // `horde`, `laneTraffic`) plus the wave-index-driven orbital strikes. The
  // plans come from the shared `dynamicSpawnPlan` module and are released
  // through the same time-ordered rule `PlayScene` runs; only entity
  // construction and wave accounting are scene-specific.
  private pendingGhostSpawns: GhostSpawnEvent[] = [];
  private ghostsSpawnedThisWave = 0;
  private pendingCentipedeSpawn: CentipedeSpawnEvent | null = null;
  private centipedeSpawnedThisWave = false;
  private pendingHordeSpawns: HordeSpawnEvent[] = [];
  private hordeSpawnedThisWave = 0;
  private pendingLaneTrafficSpawns: LaneTrafficSpawnEvent[] = [];
  private laneTrafficSpawnedThisWave = 0;
  private pendingStrikeSpawns: StrikeSpawnEvent[] = [];
  private strikesSpawnedThisWave = 0;

  /**
   * Cumulative 0-based index of the next wave to start, across this gym
   * session — the asteroid escalation input, mirroring
   * `WaveManager.globalWaveIndex` in the game.
   */
  private globalWaveIndex = 0;

  /** Current wave index (0-based). */
  private currentWaveIndex = 0;
  /** Waves to play in this session (already level-count-scaled). */
  private wavesToPlay: WaveDefinition[] = [];
  /**
   * Campaign level number of the launched level, driving the shared count
   * scaling and the supply cadence (AH-0MVLJF886009584F). Single-wave
   * launches pass `0`, which resolves to level 1 (the identity).
   */
  private levelNumber = 1;
  /** HUD label for the current level/wave. */
  private label = GYM_LEVEL_DEFAULT_LABEL;
  /** True once every wave has been cleared. */
  private levelComplete = false;
  /** Horizontal formation drift (px), oscillating within ±drift range. */
  private driftX = 0;
  /** Drift direction (+1 right, −1 left). */
  private driftDir = 1;
  /**
   * Diver re-anchor + glide state (D2, docs/GYM_PARITY.md): the same shared
   * controller `PlayScene` and `GymFormationScene` run, so a launched Diver
   * group re-bases and glides exactly as it does in the game.
   */
  private readonly reanchor = new FormationReanchorController();
  /**
   * Shared march-formation state for the active wave (Space Invaders
   * archetype, AH-0MV01EDZS0005R20). `march` archetype enemies are positioned
   * from this state instead of the global continuous drift, exactly as
   * `PlayScene` positions them. `null` when the wave has no march block.
   */
  private marchState: MarchState | null = null;
  /** Resolved march tuning for the active wave (null when no march block). */
  private marchOptions: MarchOptions | null = null;
  /**
   * RNG for spawned entities (per-enemy formation/scatter randomness),
   * threaded into `createEnemyFromConfig` the same way `PlayScene` threads
   * its run RNG so per-enemy randomness in the gym is the game's randomness
   * (AH-0MVRMHSKH0066J9B AC2). Defaults to `Math.random`; a capture setup
   * seed (and `GymBotTuning`'s level seed) replace it with a seeded stream.
   */
  protected formationRng: () => number = () => Math.random();
  /**
   * Loadout/power-up state from a capture setup (AH-0MVNW8VNN004FFK1).
   * `null` ⇒ no setup, so `create()` applies the historical spread+dual
   * default (unchanged behaviour).
   */
  private pendingSetup: SceneSetupState | null = null;
  /**
   * Forced hold-full reward id from a capture setup (AH-0MVRMFOB4002LMZS), or
   * `null` for today's random resolution.
   */
  private pendingMineralReward: string | null = null;
  /**
   * 0-based wave index requested by a capture setup's `startWave`, re-applied
   * in `create()` after `resetRunState()` clears the wave cursor.
   */
  private pendingStartWaveIndex = 0;

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
    this.pendingSetup = data && (data.player || data.powerUps)
      ? { player: data.player, powerUps: data.powerUps }
      : null;
    // A captured scene can force the hold-full payoff so it lands inside the
    // recording window (AH-0MVRMFOB4002LMZS). Absent ⇒ random (unchanged).
    this.pendingMineralReward = typeof data?.mineralReward === 'string'
      ? data.mineralReward
      : null;
    // Deterministic content (AH-0MVNW90FB003H3KM): a setup seed seeds the
    // shared supply + hazard streams (offset so each is its own stream),
    // matching GymBotTuning's existing seeded-start shape. A setup-less start
    // keeps the historical `Math.random` default.
    const seed = resolveSetupSeed(data ?? null);
    if (seed !== null) {
      this.supplyRng = createSeededRng(seed);
      this.hazardRng = createSeededRng(seed + 1);
      // The formation (entity) RNG is the same stream the game seeds from the
      // run seed, so per-enemy randomness reproduces the game's at the same
      // seed (AH-0MVRMHSKH0066J9B).
      this.formationRng = createSeededRng(seed);
    }

    const level = data?.level;
    if (!level || !Array.isArray(level.waves) || level.waves.length === 0) {
      this.wavesToPlay = [];
      this.levelNumber = 1;
      this.label = GYM_LEVEL_DEFAULT_LABEL;
      return;
    }
    this._applyLevel(level);
    // Start at a configured wave when one is supplied (capture setups),
    // clamped to the level's wave list so a stale/short list cannot stall.
    // `create()` re-applies this after `resetRunState()` zeroes the cursor.
    this.pendingStartWaveIndex = 0;
    if (Number.isInteger(data?.startWave) && (data?.startWave ?? 0) > 1) {
      this.pendingStartWaveIndex = (data?.startWave as number) - 1;
      this.currentWaveIndex = Math.min(
        this.pendingStartWaveIndex,
        this.wavesToPlay.length - 1,
      );
    }
    this.globalWaveIndex = this._campaignWaveOffset(this.levelNumber)
      + this.currentWaveIndex;
  }

  /**
   * Waves that precede campaign level `levelNumber`, mirroring the game's
   * campaign-cumulative index.
   *
   * `WaveManager.globalWaveIndex` is `sum(waves of earlier levels) +
   * waveIndex`; the gym used to count only its own session waves, so a
   * launched level above level 1 (or started beyond wave 1) planned a
   * different asteroid-hazard and orbital-strike schedule than the same level
   * in the game. Seeding from the campaign table keeps the shared planners
   * fed the same index (AH-0MVTZ6U94000KHA2).
   *
   * @param levelNumber — 1-based campaign level of the launched definition.
   * @returns the number of regular waves before that level (0 for level 1).
   */
  private _campaignWaveOffset(levelNumber: number): number {
    const levels = Math.min(
      Math.max(Math.trunc(levelNumber) - 1, 0),
      LEVELS.length,
    );
    let offset = 0;
    for (let i = 0; i < levels; i += 1) {
      offset += LEVELS[i]?.waves.length ?? 0;
    }
    return offset;
  }

  /**
   * Adopts a launched level: records its campaign level number (for the
   * supply cadence) and stores its waves with the **shared** level
   * enemy-count scaling applied, so the gym spawns exactly the counts the
   * game's campaign build seam produces for that level
   * (AH-0MVLJF886009584F).
   *
   * The authored `LevelDefinition` is never mutated — `applyEnemyCountScaling`
   * returns fresh group objects — so reloading the same level scales from the
   * pristine data (no cumulative scaling).
   */
  private _applyLevel(level: LevelDefinition): void {
    this.levelNumber = level.level;
    const rules = loadRules();
    this.wavesToPlay = level.waves.map((wave) => ({
      ...wave,
      groups: applyEnemyCountScaling(level.level, wave.groups, rules),
    }));
    this.label = level.name || GYM_LEVEL_DEFAULT_LABEL;
  }

  /**
   * Level-resolved supply cadence: the flat rules interval lengthened by the
   * inverse of the level's per-kill drop-chance ratio
   * (`interval(1) × chance(1) / chance(level)`), mirroring the game's falling
   * drop chance so a high-level run is not over-supplied
   * (AH-0MVLJF886009584F). Level 1 (and single-wave launches, `level: 0`)
   * resolve to the flat interval unchanged.
   */
  private _resolveSupplyInterval(rules: GameRules): number {
    const ratio = dropChanceRatio(this.levelNumber, rules);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return rules.powerUpSpawnInterval;
    }
    return rules.powerUpSpawnInterval / ratio;
  }

  /**
   * Re-derives the supply cadence after a level change (see
   * {@link loadLevel}). Clamps a pending spawn timer to the new interval so a
   * lengthened cadence is never refilled by a stale short timer.
   */
  private _applySupplyInterval(rules: GameRules = loadRules()): void {
    this.dropSpawnInterval = this._resolveSupplyInterval(rules);
    if (this.dropSpawnTimer > this.dropSpawnInterval) {
      this.dropSpawnTimer = this.dropSpawnInterval;
    }
  }

  // ── Scene creation ───────────────────────────────────────────────

  create(): void {
    this.resetRunState();
    // `resetRunState()` zeroes the wave cursor; restore a setup's start wave
    // before the first wave is spawned so the captured window opens on it.
    if (this.pendingStartWaveIndex > 0 && this.wavesToPlay.length > 0) {
      this.currentWaveIndex = Math.min(
        this.pendingStartWaveIndex,
        this.wavesToPlay.length - 1,
      );
    }
    // `resetRunState()` also zeroes the planner input; re-seed it from the
    // launched level + wave so the gym plans the same hazard/strike schedule
    // as the game for that campaign position (AH-0MVTZ6U94000KHA2).
    this.globalWaveIndex = this._campaignWaveOffset(this.levelNumber)
      + this.currentWaveIndex;
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

    // Loadout/power-ups: the shared setup applier is the single place that
    // knows how a setup becomes play state (AH-0MVNW8VNN004FFK1). With no
    // setup it reproduces the historical spread+dual permanent start.
    applySceneSetup(
      { getPlayer: () => this.player },
      this.pendingSetup ?? {
        player: { weapons: DEFAULT_GYM_LEVEL_WEAPONS, timedWeapons: [] },
        powerUps: {},
      },
    );

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

    // Reset the shared march block for this wave, exactly where `PlayScene`
    // resets it (per wave, never per enemy). A launched march wave then steps,
    // reverses and drops as the game's block does (AH-0MVRMHSKH0066J9B AC3).
    this._resetMarchFormation(wave.groups);

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
        getMarchState: () => this.marchState,
        rng: this.formationRng,
        // The launched campaign level drives the shared force-field curve.
        level: this.levelNumber,
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
    // Plan this wave's spawner-delivered content with the shared planners the
    // game uses (D3, docs/GYM_PARITY.md).
    this._planDynamicSpawns(wave);
    this.globalWaveIndex += 1;
    // Spawn cue, matching the other gym scenes (GymFormationScene plays the
    // shared spawn sound once per wave). Without this the launched level is
    // silent on entry — the second half of the producer audit.
    playSpawnSound();
  }

  /**
   * Plans the wave's spawner-delivered content (ghosts, centipede, horde, lane
   * traffic and orbital strikes) through the shared `dynamicSpawnPlan` module —
   * the same planners `PlayScene` builds its plan from (D3,
   * docs/GYM_PARITY.md). Called once per wave so the RNG stream advances only
   * at wave boundaries, exactly as the game does.
   */
  private _planDynamicSpawns(wave: WaveDefinition): void {
    this.pendingGhostSpawns =
      wave.ghosts === true ? planGhostWaveSpawns(this.formationRng) : [];
    this.ghostsSpawnedThisWave = 0;

    this.pendingCentipedeSpawn =
      wave.centipede === true ? planCentipedeWaveSpawn(this.formationRng) : null;
    this.centipedeSpawnedThisWave = false;

    this.pendingHordeSpawns =
      wave.horde === true ? planHordeWaveSpawns(this.formationRng) : [];
    this.hordeSpawnedThisWave = 0;

    this.pendingLaneTrafficSpawns =
      wave.laneTraffic === true
        ? planLaneTrafficWaveSpawns(this.formationRng)
        : [];
    this.laneTrafficSpawnedThisWave = 0;

    const player = this.getPlayer();
    this.pendingStrikeSpawns = planStrikeWaveSpawns(
      this.globalWaveIndex,
      player?.x ?? GAME_WIDTH / 2,
      player?.y ?? GAME_HEIGHT / 2,
      this.formationRng,
    );
    this.strikesSpawnedThisWave = 0;
  }

  /**
   * Releases every planned spawner-delivered event whose scheduled time has
   * passed, through the shared time-ordered `releaseDueSpawns` rule (D3). Runs
   * before the wave clock advances so a timeout cannot release the rest of a
   * plan, exactly as `PlayScene` does.
   */
  private _releaseDueDynamicSpawns(): void {
    const duration = this.getWaveTimeoutDuration();
    if (duration <= 0) return;
    const elapsed = duration - this.getWaveTimeoutRemaining();

    this.ghostsSpawnedThisWave = releaseDueSpawns(
      this.pendingGhostSpawns,
      this.ghostsSpawnedThisWave,
      elapsed,
      (event) => this._spawnScheduledGhost(event),
    );
    this.hordeSpawnedThisWave = releaseDueSpawns(
      this.pendingHordeSpawns,
      this.hordeSpawnedThisWave,
      elapsed,
      (event) => this._spawnScheduledHorde(event),
    );
    this.laneTrafficSpawnedThisWave = releaseDueSpawns(
      this.pendingLaneTrafficSpawns,
      this.laneTrafficSpawnedThisWave,
      elapsed,
      (event) => this._spawnScheduledLaneTraffic(event),
    );
    this.strikesSpawnedThisWave = releaseDueSpawns(
      this.pendingStrikeSpawns,
      this.strikesSpawnedThisWave,
      elapsed,
      (event) => this._spawnScheduledStrike(event),
    );

    if (this.pendingCentipedeSpawn && !this.centipedeSpawnedThisWave) {
      const released = releaseDueSpawns(
        [this.pendingCentipedeSpawn],
        0,
        elapsed,
        (event) => this._spawnScheduledCentipede(event),
      );
      this.centipedeSpawnedThisWave = released > 0;
    }
  }

  /**
   * Spawns one planned ghost through the shared factory and registers it as a
   * blocking wave enemy, exactly as `PlayScene._spawnScheduledGhost` does.
   */
  private _spawnScheduledGhost(event: GhostSpawnEvent): void {
    const cfg = loadEnemyConfig(event.enemyKey);
    const entity = createEnemyFromConfig(
      this,
      cfg,
      event.x,
      event.y,
      { row: 0, col: 0 },
      this.formationRng,
      enemyForceFieldHits(this.levelNumber, cfg),
    );
    this.add.existing(entity);
    this.spawned.push({
      entity,
      key: event.enemyKey,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
      offset: { row: 0, col: 0 },
    });
  }

  /**
   * Spawns one planned horde grunt through the shared factory and registers it
   * as a blocking wave enemy (the Robotron horde gates the wave in the game).
   */
  private _spawnScheduledHorde(event: HordeSpawnEvent): void {
    const cfg = loadEnemyConfig(event.enemyKey);
    const entity = createEnemyFromConfig(
      this,
      cfg,
      event.x,
      event.y,
      { row: 0, col: 0 },
      this.formationRng,
      enemyForceFieldHits(this.levelNumber, cfg),
    );
    this.add.existing(entity);
    this.spawned.push({
      entity,
      key: event.enemyKey,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
      offset: { row: 0, col: 0 },
    });
  }

  /**
   * Spawns the planned Centipede chain: one shared `CentipedeChain` and one
   * `Centipede` per segment, registered as blocking wave enemies — the same
   * construction `PlayScene._spawnScheduledCentipede` uses.
   */
  private _spawnScheduledCentipede(event: CentipedeSpawnEvent): void {
    const arena = centipedeArena(GAME_WIDTH, GAME_HEIGHT);
    const chain = new CentipedeChain({
      startX: event.x,
      startY: event.y,
      arena,
      segmentCount: event.segmentCount,
      spacing: CENTIPEDE_SEGMENT_SPACING,
      lateralSpeed: CENTIPEDE_LATERAL_SPEED,
      descentSpeed: CENTIPEDE_DESCENT_SPEED,
      initialDir: event.dir,
    });
    for (let id = 0; id < event.segmentCount; id += 1) {
      const segment = chain.segment(id);
      const entity = new Centipede(this, {
        x: segment?.x ?? event.x,
        y: segment?.y ?? event.y,
        formationOffset: { row: 0, col: id },
        chain,
        segmentId: id,
        rng: this.formationRng,
      });
      this.add.existing(entity);
      this.spawned.push({
        entity,
        key: CENTIPEDE_ENEMY_KEY,
        startX: event.x,
        startY: event.y,
        spacingX: 0,
        spacingY: 0,
        offset: { row: 0, col: id },
      });
    }
  }

  /**
   * Spawns one planned Frogger lane-traffic hazard. Lane traffic is a
   * non-blocking world hazard (the asteroid accounting): it is marked
   * `hazard: true`, so it never gates wave completion, exactly as in the game.
   */
  private _spawnScheduledLaneTraffic(event: LaneTrafficSpawnEvent): void {
    const cfg = loadEnemyConfig(event.enemyKey);
    const entity = new LaneTraffic(this, {
      x: event.x,
      y: event.y,
      formationOffset: { row: 0, col: 0 },
      vx: event.vx,
      size: cfg.size,
      color: cfg.color,
      health: cfg.health,
      rng: this.formationRng,
      forceFieldHits: enemyForceFieldHits(this.levelNumber, cfg),
    });
    this.add.existing(entity);
    this.spawned.push({
      entity,
      key: event.enemyKey,
      hazard: true,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
      offset: { row: 0, col: 0 },
    });
  }

  /**
   * Spawns one planned telegraphed orbital strike. Like asteroids and lane
   * traffic it is a non-blocking world hazard, and its radial detonation burst
   * flows into the shared enemy-bullet path (see `_moveEnemies`).
   */
  private _spawnScheduledStrike(event: StrikeSpawnEvent): void {
    const entity = new OrbitalStrike(this, {
      x: event.x,
      y: event.y,
      formationOffset: { row: 0, col: 0 },
      rng: this.formationRng,
    });
    this.add.existing(entity);
    entity.initStrike(event.x, event.y, event.burstCount, this.formationRng);
    this.spawned.push({
      entity,
      key: 'orbital-strike',
      hazard: true,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
      offset: { row: 0, col: 0 },
    });
  }

  /**
   * Initialises (or clears) the shared march-formation state for a wave
   * (Space Invaders archetype, AH-0MV01EDZS0005R20), mirroring
   * `PlayScene._resetMarchFormation` so the game and the level gym cannot
   * diverge on the block's origin, bounds or cadence.
   *
   * A wave may contain at most one march block — the block is a single rigid
   * body, so it marches as one unit. The block's arena-edge bounds are derived
   * from its widest column and the group spacing, exactly as the game derives
   * them; the cadence/step/drop come from the archetype config. A wave with no
   * march spawns clears the state and keeps the legacy continuous drift.
   *
   * Called once per wave from {@link _spawnCurrentWave}, never per enemy: the
   * shared pure policy ({@link advanceMarch}) owns the motion in
   * {@link _moveEnemies}.
   */
  private _resetMarchFormation(groups: readonly WaveGroup[]): void {
    const marchGroups = groups.filter(
      (group) => loadEnemyConfig(group.enemyKey).formationKind === 'march',
    );
    const marchOffsets = marchGroups.flatMap((group) =>
      getFormationBuilder(group.formation)(group.count),
    );
    if (marchOffsets.length === 0) {
      this.marchState = null;
      this.marchOptions = null;
      return;
    }

    const first = marchGroups[0];
    const cfg = loadEnemyConfig(first.enemyKey);
    const maxAbsCol = marchOffsets.reduce(
      (max, offset) => Math.max(max, Math.abs(offset.col)),
      0,
    );
    const bounds = computeMarchBounds(maxAbsCol * first.spacingX, GAME_WIDTH);
    this.marchState = createMarchState(first.startX, first.startY, 1);
    this.marchOptions = {
      step: cfg.marchStep ?? DEFAULT_MARCH_STEP,
      drop: cfg.marchDrop ?? DEFAULT_MARCH_DROP,
      referenceSpeed: cfg.driftSpeed,
      minX: bounds.minX,
      maxX: bounds.maxX,
      initialCount: marchOffsets.length,
    };
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
    this.reanchor.reset();
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
    this.reanchor.reset();
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
    this.reanchor.reset();
    this.marchState = null;
    this.marchOptions = null;
    this.globalWaveIndex = 0;
    this.hideWaveTimeout();
    this.asteroidHazard.reset();
    this.pendingGhostSpawns = [];
    this.ghostsSpawnedThisWave = 0;
    this.pendingCentipedeSpawn = null;
    this.centipedeSpawnedThisWave = false;
    this.pendingHordeSpawns = [];
    this.hordeSpawnedThisWave = 0;
    this.pendingLaneTrafficSpawns = [];
    this.laneTrafficSpawnedThisWave = 0;
    this.pendingStrikeSpawns = [];
    this.strikesSpawnedThisWave = 0;
    cleanupWave(this.spawned, this.enemyBullets);
    this.spawned = [];
    this.enemyBullets = [];
    this._applyLevel(level);
    // A replaced level restarts at its wave 1, but the planner input is the
    // campaign-cumulative index of that position — not a session-local zero
    // (AH-0MVTZ6U94000KHA2).
    this.globalWaveIndex = this._campaignWaveOffset(this.levelNumber);
    // Keep the supply cadence consistent with the newly loaded level (the
    // supply layer outlives the level; only the cadence is level-derived).
    if (this.dropSpawner) this._applySupplyInterval();
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
    // Level-resolved cadence (AH-0MVLJF886009584F): the game's per-kill drop
    // chance falls with the campaign level, so the gym's timed source
    // lengthens by the inverse ratio instead of over-supplying a high level.
    this.dropSpawnInterval = this._resolveSupplyInterval(rules);
    this.dropSpawnTimer = this.dropSpawnInterval;
    this.asteroidExtraLifeDropChance = rules.asteroidExtraLifeDropChance;

    // Weapon levels and the six-slot state come from the one shared HUD
    // wiring (AH-0MVVJRRN10038VFR AC4).
    this.hud = new HUD(
      this,
      this.getEffectsRegistry(),
      combatHudOptions(() => this.getPlayer(), { showLives: true }),
    );

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
    const id = this._drawNextDrop(
      this.dropSpawner,
      this._resolveDropSlotState(),
    );
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
        (mineral) => this._collectMineral(mineral),
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

  /**
   * Collects a mineral into the shared hold, crediting its **worth** (1 for an
   * ordinary dot, `MINERAL_DEPOSIT_VALUE` = 10 for a red deposit —
   * AH-0MVJ79739008396I), and resolves it when full.
   */
  private _collectMineral(mineral: Mineral): void {
    this.mineralHold.collect(mineral.value);
    if (this.mineralHold.isFull) this._resolveMineralHold();
  }

  /**
   * Resolves a full hold with one shared reward, with no modal pause so the
   * autonomous bot keeps playing (documented gym-only divergence).
   *
   * A capture setup can force which reward the resolution grants
   * (`setup.mineralReward`, AH-0MVRMFOB4002LMZS); without one the configured
   * `randomChoiceStrategy` picks exactly as before.
   */
  private _resolveMineralHold(): void {
    const chosenId = resolveMineralReward(
      this.pendingMineralReward === null
        ? null
        : { mineralReward: this.pendingMineralReward },
      () => this._randomMineralChoice()?.id ?? '',
    );
    if (chosenId !== '') {
      // One shared reward-application path for the random and forced cases.
      applyMineralChoiceReward(
        toChoiceOption(chosenId as DropId),
        this.getEffectsRegistry(),
        this.getPlayer(),
      );
    }
    this.mineralHold.resolve();
  }

  /** Today's random hold-full choice (consumes the supply RNG stream). */
  private _randomMineralChoice(): ChoiceOption | undefined {
    const options = this.mineralChoiceStrategy.choose(1, this.supplyRng, {
      weaponLevels: this.getPlayer()?.getWeaponLevels() ?? [],
      powerUpLevels: this.getPlayer()?.getPowerUpLevels() ?? [],
      // Temporary field pickups hold a slot, so they participate in the
      // six-slot gate here exactly as in the game (parent AH-0MVLIJT3M005HPHF).
      tempPowerUpIds: this.getPlayer()?.getTempPowerUpIds() ?? [],
      tempWeaponIds: this.getPlayer()?.getTempWeaponIds() ?? [],
    });
    return options[0];
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

    // Advance the shared march block for this wave (Space Invaders archetype,
    // AH-0MV01EDZS0005R20): the same pure step/reverse/drop/speed-up policy the
    // game runs, with the cadence scaled by the block's live alive count.
    if (this.marchState && this.marchOptions) {
      const alive = this.spawned.reduce(
        (count, spawn) =>
          count + (spawn.march && spawn.entity.alive ? 1 : 0),
        0,
      );
      this.marchState = advanceMarch(
        this.marchState,
        dt,
        alive,
        this.marchOptions,
      );
    }

    // Diver re-anchor (GDD §4.1 — E2, D2): if a Diver's attack finished,
    // re-base the Diver group so its slot lands on the attack end. Applied
    // after the drift and before positioning, exactly as `PlayScene` and
    // `GymFormationScene` do through the shared controller.
    const reanchorApplied = this._applyFormationReanchor();

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

    // Formation-positioned enemies of this frame — the shared post-motion wrap
    // runs over exactly these bodies once the positioning pass has finished.
    // Self-moving entities (asteroids, roaming seekers) keep their own
    // existing four-edge wrap and are deliberately not re-wrapped here, the
    // same selection `PlayScene._moveEnemies` makes.
    const positioned: WrapAwareBody[] = [];

    for (const spawn of this.spawned) {
      if (!spawn.entity.alive) continue;
      const entity = spawn.entity;

      // Orbital strikes run their own telegraph → fall → detonate lifecycle
      // and are not formation-positioned. Their radial burst is hoisted into
      // the shared enemy-bullet path at detonation time, exactly as
      // `PlayScene._moveEnemies` does (D3, docs/GYM_PARITY.md).
      if (spawn.key === 'orbital-strike') {
        const strike = entity as OrbitalStrike;
        strike.update(dt);
        const burst = strike.getBurstBullets();
        if (burst.length > 0) {
          this.enemyBullets.push(...burst);
          strike.clearBurstBullets();
        }
        continue;
      }

      // Asteroids, lane traffic and other roaming entities advance their own
      // motion and ignore the formation drift (matches the game).
      if (spawn.key === 'asteroid' || entity.updatePosition) {
        entity.updatePosition?.(dt);
        continue;
      }

      const isDiver = entity.consumeFormationReanchor != null;
      entity.applyFormationPosition(
        // March-block enemies are positioned from the shared march state (which
        // already carries the drop); every other enemy keeps the global drift —
        // the same selection `PlayScene._moveEnemies` makes. Only Divers ride
        // the shared re-anchor offset (D2, docs/GYM_PARITY.md).
        (spawn.march && this.marchState
          ? this.marchState.x
          : spawn.startX + this.driftX) + (isDiver ? this.reanchor.anchorX : 0),
        (spawn.march && this.marchState ? this.marchState.y : spawn.startY)
          + (isDiver ? this.reanchor.anchorY : 0),
        dt,
        spawn.spacingX,
        spawn.spacingY,
      );
      positioned.push(entity);
    }

    // Ease the Divers onto their re-anchored slots (shared controller).
    this.reanchor.afterPositioning(dt, reanchorApplied);

    // Shared post-motion edge wrap (parent AH-0MV9G3DZ9003P7P8 AC3/AC4): the
    // one seam the game and every gym run. Wrap-aware enemies cross the seam to
    // the opposite edge (position only — velocity/heading preserved); `march`
    // and `centipede` carry `wrapAware: false` and keep their bounded,
    // wall-respecting behaviour.
    applyPostMotionWrapAll(positioned, PLAYFIELD_WORLD);
  }

  /**
   * Consumes any pending Diver re-anchor requests and shifts the Diver-group
   * anchor so the requesting Diver's slot lands on its attack end (GDD §4.1 —
   * E2). Delegates to the shared `FormationReanchorController` (D2,
   * docs/GYM_PARITY.md) so the level gym re-anchors and glides exactly as
   * `PlayScene` and `GymFormationScene` do.
   *
   * @returns `true` if a re-anchor was applied (and the glide was begun).
   */
  private _applyFormationReanchor(): boolean {
    const candidates: FormationReanchorCandidate[] = this.spawned
      .filter(
        (spawn) =>
          spawn.entity.alive && spawn.entity.consumeFormationReanchor != null,
      )
      .map((spawn) => ({
        entity: spawn.entity as unknown as FormationReanchorCandidate['entity'],
        originX: spawn.march && this.marchState
          ? this.marchState.x
          : spawn.startX + this.driftX,
        originY: spawn.march && this.marchState
          ? this.marchState.y
          : spawn.startY,
        spacingX: spawn.spacingX,
        spacingY: spawn.spacingY,
      }));
    return this.reanchor.apply(candidates);
  }

  // ── Shared combat-core participant accessors ─────────────────────

  override getPlayer(): Player | null {
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

    // Shared player Phase Shift treatment (AH-0MVNTY0700053T9E): the level
    // gym advances the juice through the same shared step as the game and
    // every other gym, so a phased ship is unmistakable here too.
    this._updatePhaseShiftJuice(dt);

    // Wave progression: release any asteroid spawns whose planned time has
    // passed before the wave clock advances (so a timeout cannot release the
    // rest of the plan), then advance the shared wave-timeout.
    if (!this.levelComplete) {
      this._releaseDueAsteroidSpawns();
      // Spawner-delivered content (ghosts/centipede/horde/lane traffic/
      // orbital strikes) releases on the same shared schedule (D3).
      this._releaseDueDynamicSpawns();
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
      // One shared emergence step (AH-0MVNTY0700053T9E): growth writes the
      // absolute scale and the shimmer layers on top — identical to the game
      // and every formation gym.
      const stillGrowing = updateSpawnEmergence(
        spawn.entity as unknown as SpawnAnimatable,
        dt,
      );
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
    this.reanchor.reset();
    this.marchState = null;
    this.marchOptions = null;
    this.globalWaveIndex = 0;
    this.asteroidHazard.reset();
    this.pendingGhostSpawns = [];
    this.ghostsSpawnedThisWave = 0;
    this.pendingCentipedeSpawn = null;
    this.centipedeSpawnedThisWave = false;
    this.pendingHordeSpawns = [];
    this.hordeSpawnedThisWave = 0;
    this.pendingLaneTrafficSpawns = [];
    this.laneTrafficSpawnedThisWave = 0;
    this.pendingStrikeSpawns = [];
    this.strikesSpawnedThisWave = 0;
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

  /** Overrides the pluggable hold-full choice strategy (test/tuning seam). */
  setMineralChoiceStrategy(strategy: ChoiceStrategy): void {
    this.mineralChoiceStrategy = strategy;
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

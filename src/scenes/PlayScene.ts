/**
 * Playable game scene (GDD §3 — Level structure, §4 — Boss).
 *
 * Owns the playable run: the `WaveManager` drives Level 1–10 progression
 * and the boss trigger; this scene spawns the wave's enemies in their
 * formations, integrates the player ship (auto-fire, weapons, effects),
 * resolves collisions, applies power-up collection, and advances levels
 * automatically when a wave/level is cleared. At run start it injects the
 * campaign into the `WaveManager` — the scripted `LEVELS` by default, or a
 * data-driven sequenced campaign when the opt-in `sequencedWavesEnabled`
 * rule is enabled (AH-0MUH6LEYY0054E63; see `resolveCampaignLevels`).
 *
 * **Shared combat core:** extends {@link CombatScene}
 * (`src/scenes/core/CombatScene.ts`), which owns collision resolution,
 * player hits, auto-fire, drop collection, teleports, player explosions
 * and bullet clearing. This scene supplies the game's hooks (boss
 * multi-hit, asteroid split, mineral absorption, wave accounting,
 * lives/game-over). The gym formation base runs the same shared path, so
 * the game and gyms cannot diverge.
 *
 * **Shared power-up drop layer:** the drop lifecycle, collection gate, Magnet
 * magnet and per-type pickup cues are inherited from the shared drop layer
 * (`src/scenes/core/dropLayer.ts`); the Bomb ranged bomb pulse is driven by
 * the shared `CombatCoreScene._updateP4Bomb` path. This scene supplies only
 * the kill-chance spawn *source* (AH-0MUII3CXX0023H24, gap 4).
 *
 * Flow: `MenuScene → PlayScene → GameOverScene → MenuScene`.
 *
 * Determinism: `update()` delegates to the public `tick(dt)` step, which
 * tests call directly to drive collisions and transitions without real
 * frame timing (mirrors `GymFormationScene.tick`).
 */

import Phaser from 'phaser';

import {
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_BULLET_RADIUS,
  PLAYER_HIT_SCALE_PEAK,
  PLAYER_HIT_SCALE_PULSE_DURATION,
  POWER_UP_DROP_MIN_SEPARATION,
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../core/constants';
import { GameState, MAX_LEVEL, MAX_LIVES } from '../core/GameState';
import {
  applyEnemyCountScaling,
  extraLifeDropChance,
  POWER_UP_DROP_CHANCE,
  powerUpDropChance,
} from '../core/levelScaling';
import { createSeededRng, normaliseSeed, randomSeed } from '../core/rng';
import {
  DEFAULT_RULES,
  loadRules,
  type GameRules,
} from '../core/rules';
import { buildHoldFullFireSchedule } from '../scenes/core/holdFullFire';
import type { MineralChoiceScene } from './MineralChoiceScene';
import {
  playDestructionSound,
  playSpawnSound,
  playVictoryFanfareSound,
  playWeaponFireSound,
} from '../audio/effects';
import { Player } from '../entities/Player';
import { PlayerBullet } from '../entities/PlayerBullet';
import { pushAimTargets, pushSeekTargets } from './core/enemyTargeting';
import { createEnemyFromConfig, type EnemyEntity } from '../entities/enemyFactory';
import {
  computeFormationReanchorDelta,
  type FormationReanchorRequest,
} from '../utils/formations';
import { FormationGlide } from './core/formationGlide';
import {
  advanceMarch,
  computeMarchBounds,
  createMarchState,
  DEFAULT_MARCH_DROP,
  DEFAULT_MARCH_STEP,
  type MarchOptions,
  type MarchState,
} from './core/marchFormation';
import { fireForEnemy } from '../entities/enemyFire';
import { Asteroid } from '../entities/Asteroid';
import type { AsteroidSizeTier } from '../entities/Asteroid';
import { Mineral } from '../entities/Mineral';
import {
  WORMHOLE_OPEN_DURATION,
  WormholeController,
  anchorSpawnsToPortal,
  formationCentre,
  formationExtents,
  placeWavePortal,
  startSpawnAnimation,
  updateEnemyShimmer,
  updateSpawnAnimation,
  type PortalPoint,
  type SpawnAnimatable,
} from '../vfx/wormholeSpawn';
import { spawnPlayerDeathJuice } from '../vfx/playerDeathJuice';
import { getExplosionVfxCounts } from '../vfx/explosionParticles';
import {
  ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS,
  spawnVictoryFireworks,
  spawnVictoryJuice,
} from '../vfx/endOfRunJuice';
import { EffectsRegistry } from '../powerups/effects';
import {
  randomChoiceStrategy,
  toChoiceOption,
  type ChoiceOption,
  type ChoiceStrategy,
} from '../powerups/choice';
import {
  buildUpgradeOptions,
  initialUnlockState,
  lockedWeaponIds,
  unlockWeapon,
  type MiniBossUnlockState,
} from '../powerups/unlocks';
import {
  CHECKPOINT_VERSION,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from '../core/checkpointStore';
import { PowerUp } from '../powerups/PowerUp';
import { EXTRA_LIFE_DROP_ID, getPowerUpById, isWeaponDrop, type DropId, type PowerUpId } from '../powerups/types';
import { drawPowerUpDrop, drawWeaponDrop } from '../powerups/icons';
import { nudgeAwayFromDrops } from '../powerups/placement';
import {
  type CollectAnimationHandle,
} from '../powerups/collectAnimation';
import { type PowerUpSpawner } from '../powerups/spawner';
import { HUD } from '../ui/HUD';
import { type WeaponId } from '../utils/weapons';
import type { WasdKeysLike } from '../utils/input';
import type { ControlInput } from '../utils/movementModel';
import { createCompetentBotBrain } from '../ai/framework';
import { buildBotSnapshot } from '../ai/botSnapshot';
import {
  BOT_MINERAL_CHOICE_DELAY_MS,
  BotInputGovernor,
} from '../ai/botHumanLike';
import {
  coerceTuningValues,
  toCompetentOverrides,
  toHumanOverrides,
} from '../ai/tuningFields';
import { getCurrentBotTuningConfig } from '../core/botTuningStore';
import { loadEnemyConfig } from '../core/enemyConfig';
import { emitRunEndedSignal } from '../core/runEndedSignal';
import {
  createTelemetryRecorder,
  installDevTelemetryBuffer,
  loadDevTelemetryUploader,
  resolveBuildInfo,
  resolveEffectiveTelemetryConfig,
  type TelemetryRecorder,
} from '../telemetry';
import {
  buildRunTelemetryState,
  RunTelemetry,
  serialiseTelemetryInput,
  type RunTelemetryExtras,
} from './core/runTelemetry';
import {
  clearDevScenarioHandle,
  installDevScenarioHandle,
  isDevScenarioEnabled,
  resolveDevScenario,
  resolveDevSeed,
  type DevScenario,
} from '../core/devScenario';
import {
  DEFAULT_BINDINGS,
  keyFor,
  loadSettings,
  loadStoredControlScheme,
  resolveBindings,
  type ActionName,
} from '../core/settingsStore';
import { loadTelemetryConsent } from '../core/telemetryConsentStore';
import { resolvePlayerControlScheme } from '../core/playerScheme';
import { loadShipConfig } from '../core/configStore';
import { resolveKeyCode } from '../utils/keys';
import { WaveManager, type EnemySpawn, type WaveEvent } from '../waves/WaveManager';
import { LEVELS, type LevelDefinition } from '../waves/Formations';
import { buildSequencedLevels } from '../waves/sequencedLevels';
import type { SpawnEvent } from '../waves/AsteroidSpawner';
import {
  AsteroidHazardLayer,
  createAsteroidFromEvent,
} from './core/asteroidHazard';
import {
  computeSpawns as computeStrikeSpawns,
  type SpawnEvent as StrikeSpawnEvent,
} from '../waves/StrikeSpawner';
import { OrbitalStrike } from '../entities/OrbitalStrike';
import {
  computeHarvesterSpawns,
  type HarvesterSpawnEvent,
} from '../waves/HarvesterSpawner';
import {
  computeGhostSpawns,
  type GhostSpawnEvent,
} from '../waves/GhostSpawner';
import {
  CENTIPEDE_DESCENT_SPEED,
  CENTIPEDE_ENEMY_KEY,
  CENTIPEDE_LATERAL_SPEED,
  CENTIPEDE_SEGMENT_SPACING,
  centipedeArena,
  computeCentipedeSpawn,
  type CentipedeSpawnEvent,
} from '../waves/CentipedeSpawner';
import { Centipede } from '../entities/Centipede';
import { CentipedeChain } from './core/centipedeChain';
import {
  HORDE_DEFAULT_GROUP_SIZE,
  HORDE_DEFAULT_SPAWN_INTERVAL_SECONDS,
  GRUNT_ENEMY_KEY,
  computeHordeSpawns,
  type HordeSpawnEvent,
} from '../waves/HordeSpawner';
import {
  LANE_TRAFFIC_DEFAULT_LANE_COUNT,
  LANE_TRAFFIC_DEFAULT_LANE_SPACING,
  computeLaneTrafficSpawns,
  type LaneTrafficSpawnEvent,
} from '../waves/LaneTrafficSpawner';
import { LaneTraffic } from '../entities/LaneTraffic';
import { Boss, BossPhase, BOSS_HIT_POINTS_PER_PHASE } from '../entities/Boss';
import { MiniBoss, type MiniBossConfig } from '../entities/MiniBoss';
import { miniBossConfigForLevel, miniBossDesignForLevel } from '../waves/miniBossDesigns';
import {
  playerPowerScore,
  scaledEncounterHp,
} from '../core/difficultyScaling';
import { planMinionSpawns } from '../waves/BossMinions';
import {
  CombatScene,
} from './core/CombatScene';
import type { DroneMineralSink } from './core/combatDrone';
import {
  advancePlayerBullets,
  advanceWrappingBullets,
} from './core/bulletLifecycle';
import {
  resolveMineralKillDrops,
  scatterSalvageMineralDrops,
} from './core/mineralKillDrops';
import {
  rollAsteroidExtraLife,
  type AsteroidKillDropEntity,
} from './core/asteroidKillDrops';
import { splitAsteroid } from './core/asteroidSplit';
import {
  applyMineralChoiceReward,
  collectMinerals,
} from './core/mineralLayer';
import {
  applyPhaseGhost,
  drawForceFieldBubble,
  drawShieldBubble,
  drawThornsAura,
} from './core/CombatEffectVisuals';
import {
  isNonBlockingHazard,
  WAVE_TIME_LIMIT_SECONDS,
  WAVE_TIMER_BAR_HEIGHT,
  WAVE_TIMER_BAR_WIDTH,
  WAVE_TIMER_BAR_X,
  WAVE_TIMER_BAR_Y,
} from './core/waveTimeout';

// Re-exported for existing importers (tests, HUD); the single source of
// truth now lives in `core/waveTimeout.ts`, shared with the gyms.
export {
  WAVE_TIME_LIMIT_SECONDS,
  WAVE_TIMEOUT_EXPLOSION_SCALE,
} from './core/waveTimeout';

// ── Mini-boss defeat hooks (epic AH-0MVCC8XSS007P01Z) ─────────────

/**
 * Context delivered to the mini-boss reward/checkpoint hooks at the moment
 * of defeat (before the run state advances), so `level`/`waveNumber` name
 * the level whose mini-boss was just defeated.
 */
export interface MiniBossDefeatContext {
  /** Campaign level whose mini-boss was defeated (1-based). */
  level: number;
  /** Wave number of the defeated mini-boss encounter within the level. */
  waveNumber: number;
  /** Display name of the defeated mini-boss entity. */
  miniBossName: string;
  /** Whether this was the final level's mini-boss (the final boss follows). */
  isFinalLevel: boolean;
}

/**
 * Reward callback fired **exactly once** when a mini-boss is defeated
 * (AH-0MVCRBISU006NUN5 AC3). Consumed by the mini-boss reward feature; the
 * call is guarded while no hook is installed. Until the mini-boss designs
 * feature lands, every level uses the generic default mini-boss.
 */
export type MiniBossDefeatHook = (context: MiniBossDefeatContext) => void;

// ── Scoring (GDD §4.5) ──────────────────────────────────────────────

/** Points awarded per destroyed enemy archetype (GDD §4.5). */
export const SCORE_VALUES: Record<string, number> = {
  scout: 100,
  diver: 200,
  tank: 300,
  phaser: 250,
  swarm: 150,
  boss: 1000, // per phase; the full boss awards 1000+2000+3000+5000
  // Asteroids: only small asteroids award points (50); large/medium award
  // none (GDD §4.5, E6 Asteroid). The tier check happens in `_onEnemyKilled`.
  asteroid: 50,
  // Harvester: a durable five-hit mineral-denial threat (GDD §4.5, E7).
  harvester: 400,
  // Centipede: a linked chain of weaving segments (classic-arcade archetype,
  // AH-0MV01EJ92008ZZ86). Each destroyed segment scores.
  centipede: 120,
  // Robotron homing horde: a small, fast non-firing grunt (classic-arcade
  // archetype, AH-0MV01EKTL001NRE6). Each grunt scores.
  grunt: 150,
  // Defender raider: a patrol-then-attack state machine (classic-arcade
  // archetype, AH-0MV01EM7U0033W7L). Each raider scores.
  raider: 175,
  // Frogger lane traffic: a fast, non-firing moving hazard (classic-arcade
  // archetype, AH-0MV01EPM40008N8T). Each lane member scores.
  'lane-traffic': 150,
};

/** Default score for an unknown archetype (falls back to the Scout value). */
export const DEFAULT_SCORE_VALUE = 100;

/** Points awarded per destroyed boss phase (GDD §4.5). */
export const BOSS_PHASE_SCORES: Record<number, number> = {
  1: 1000,
  2: 2000,
  3: 3000,
  4: 5000,
};

// ── Tuning constants ────────────────────────────────────────────────

/** Seconds between a wave/level wipe and the next spawn. */
export const LEVEL_TRANSITION_SECONDS = 1.5;

/**
 * Seconds a level/wave announcement banner stays on screen before it
 * hides automatically (GDD §3 — transient transitions). The banner still
 * expires on its own; 3.5 s leaves the player time to read the
 * announcement during the between-wave pause while the semi-transparent
 * background keeps the field visible (AH-0MV8BQ75V005QNZ1).
 */
export const BANNER_DURATION_SECONDS = 3.5;

/**
 * Opacity of the banner's background panel. The banner sits over live
 * gameplay — carried-over asteroids keep moving and surviving enemies stay
 * alive — during the between-wave pause, so a fully opaque panel hides the
 * action; 0.6 keeps the white banner text legible while letting the field
 * show through (AH-0MV8BQ75V005QNZ1).
 */
export const BANNER_BACKGROUND_ALPHA = 0.6;

/** Rightward formation drift speed (px/s). */
const FORMATION_DRIFT_SPEED = 28;

/** Formation drift bounds (px offset from each group's start). */
const FORMATION_DRIFT_RANGE = GAME_WIDTH * 0.5;

/**
 * Chance a destroyed enemy drops a power-up (GDD §4.4, ~15–20 %).
 *
 * Re-exported from `src/core/levelScaling.ts` (AH-0MVLJEE7O008RX9X): this
 * is the documented **level-1** per-kill drop chance, kept as the exported
 * constant so existing imports keep their meaning. Higher levels derive
 * from it through the level-scaling curves; the level-1 base lives in one
 * place.
 */
export { POWER_UP_DROP_CHANCE };

/**
 * In-run hold (ms) after the victory celebration is triggered and before the
 * `GameOverScene` transition. Set to the sustained fireworks duration
 * ({@link ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS}, 3–5 s) so the whole
 * boss-position-anchored explosion/firework display plays before the screen
 * changes (AH-0MUWZ5HCV0034H44). Set to 0 to transition immediately.
 */
export const VICTORY_TRANSITION_HOLD_MS = ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS;

/**
 * Render depth of the in-run victory fireworks: above the gameplay layer
 * (depth 0) so the display reads at the boss's death position, but below the
 * HUD ({@link HUD_DEPTH} 1000) and the banner/score text (500).
 */
export const VICTORY_FIREWORK_DEPTH = 300;

/**
 * Background depth for the play scene. Set well below the juice layers
 * (negative −10…−7) so the in-run celebration renders above the playfield
 * backdrop instead of behind it (mirrors `GameOverScene`'s −100 background).
 */
const PLAYSCENE_BACKGROUND_DEPTH = -1000;

/** Neon-cyan level/score text colour. */
const HUD_TEXT_COLOR = '#00ffff';

/** Level-transition banner style. */
const BANNER_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '34px',
  color: '#ffffff',
  // A CSS `rgba()` string is a valid Canvas2D `fillStyle`, so Phaser's text
  // canvas fill honours the alpha and keeps the field visible behind the
  // banner (AH-0MV8BQ75V005QNZ1).
  backgroundColor: `rgba(0, 0, 0, ${BANNER_BACKGROUND_ALPHA})`,
  padding: { x: 20, y: 12 },
};

/**
 * Rules the campaign resolution needs: the sequencing toggle plus whichever
 * scaling tunables the caller supplies. Anything omitted falls back to
 * {@link DEFAULT_RULES}, so unit tests can pass just the toggle.
 */
type CampaignResolutionRules = Pick<GameRules, 'sequencedWavesEnabled'> &
  Partial<GameRules>;

/**
 * Apply the level enemy-count scaling to a whole campaign
 * (AH-0MVLJF30O000E3J3).
 *
 * This is the **single** campaign-build seam: every group of every wave is
 * scaled with {@link applyEnemyCountScaling} for its level, so both the
 * static `LEVELS` campaign and the sequenced campaign receive the documented
 * multiplier (level 1 is the identity). The input campaign is never mutated —
 * a new `LevelDefinition[]` with new waves/groups is returned — which keeps
 * repeated builds idempotent (no cumulative/double scaling) and leaves the
 * authored `LEVELS` data as the pristine source every build scales from.
 *
 * @param campaign - Unscaled campaign (must be the authored/sequenced data, as
 *   returned by `LEVELS` / `buildSequencedLevels`; never a previously scaled
 *   campaign).
 * @param rules - Live rules supplying the scaling tunables.
 * @returns A new campaign whose group counts carry the level scaling.
 */
function scaleCampaignLevelCounts(
  campaign: LevelDefinition[],
  rules: CampaignResolutionRules,
): LevelDefinition[] {
  const tuning: GameRules = { ...DEFAULT_RULES, ...rules };
  return campaign.map((level) => ({
    ...level,
    waves: level.waves.map((wave) => ({
      ...wave,
      groups: applyEnemyCountScaling(level.level, wave.groups, tuning),
    })),
  }));
}

/**
 * Resolve the campaign the run should play (AH-0MUITS1SM008GPR9).
 *
 * With the opt-in `sequencedWavesEnabled` toggle off the static `LEVELS`
 * campaign is used. With it on, the campaign is generated from the
 * difficulty-curve config; if generation throws or yields nothing the static
 * campaign is used instead, so the game always boots into a playable
 * campaign.
 *
 * Either way the resolved campaign then passes through the shared
 * level-scaling seam exactly once (AH-0MVLJF30O000E3J3): each level's group
 * counts are multiplied by `enemyCountMultiplier(level)` with the documented
 * rounding, floor, per-group cap and `single`-group rule (see
 * `src/core/levelScaling.ts`). Level 1 is the identity, so onboarding data is
 * unchanged. The scaling reads the pristine source on every call, so it is
 * idempotent — a rebuilt campaign is never scaled twice.
 *
 * Pass a `build` that closes over the run seed (AH-0MUJSUQD8003FSUT) so
 * `dynamic` waves are regenerated per run while staying reproducible for a
 * given seed; the default build is seed-free.
 *
 * Exported so the toggle/fallback/scaling decision can be unit-tested without
 * booting a Phaser scene; `PlayScene.create()` calls it with the live rules.
 */
export function resolveCampaignLevels(
  rules: CampaignResolutionRules = loadRules(),
  build: () => LevelDefinition[] = () => buildSequencedLevels(),
): LevelDefinition[] {
  if (!rules.sequencedWavesEnabled) {
    return scaleCampaignLevelCounts(LEVELS, rules);
  }
  try {
    const generated = build();
    return scaleCampaignLevelCounts(
      generated.length > 0 ? generated : LEVELS,
      rules,
    );
  } catch {
    return scaleCampaignLevelCounts(LEVELS, rules);
  }
}

/** One spawned enemy plus the formation group it belongs to. */
interface SpawnedEnemy {
  entity: EnemyEntity;
  enemyKey: string;
  startX: number;
  startY: number;
  spacingX: number;
  spacingY: number;
  /**
   * True when this enemy belongs to a `march` formation block (Space Invaders
   * archetype, AH-0MV01EDZS0005R20). Such enemies are positioned from the
   * shared march state instead of the global continuous drift.
   */
  march?: boolean;
}

/** A live enemy bullet (matches the entity fire-method return shape). */
interface PlayEnemyBullet {
  graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
  /** Bullet lifetime in seconds (AH-0MU960UTE001PTV0). */
  lifetime: number;
  /** Elapsed time since creation (seconds). */
  elapsed: number;
}

/** A live power-up drop on the field. */
interface PlayDrop {
  dropId: DropId;
  powerUp: PowerUp;
  weaponDropId?: string;
  x: number;
  y: number;
  graphics: Phaser.GameObjects.Graphics;
  /**
   * True once the drop has been collected and is playing its absorb VFX —
   * the overlap gate must not re-collect it (AC5, AH-0MUBYXR280018HST).
   */
  absorbing?: boolean;
}

/**
 * The playable game scene — manages the 10 levels + boss encounter.
 */
export class PlayScene extends CombatScene<
  EnemyEntity,
  PlayEnemyBullet,
  PlayDrop
> {
  /**
   * Whether this run is the bot-driven demo/attract mode
   * (AH-0MUX495VG0014MIY). Opt-in via
   * `scene.start('PlayScene', { demo: true })`; false for normal play, so the
   * demo can never leak into a real session (AC1/AC7).
   */
  private demoMode = false;

  /**
   * Optional demo game-over dwell override in milliseconds, forwarded to
   * `GameOverScene` for a demo run (AH-0MUXZ4CAE008QRFZ). `undefined` uses the
   * single-source production default; tests inject a short/zero value.
   */
  private demoDwellMs?: number;

  /**
   * Demo take-over handler active only while the demo runs
   * (AH-0MUX4966Z0009P9Q AC3). Null outside demo mode, so normal play
   * carries no extra input listener. A movement key takes over in place;
   * any other key (including ESC/pause) returns to the main menu — the
   * pointer stays ignored (AH-0MUYP6M6W006Z1AY AC1–AC3, AH-0MUYG8XHI0044MQ1).
   */
  private demoTakeOverHandler: ((event: KeyboardEvent) => void) | null = null;

  /**
   * DOM key names that count as deliberate movement input during demo
   * take-over (AH-0MUYP6M6W006Z1AY AC2). Populated from the same resolved
   * settings bindings as the Phaser movement keys (`_applyBindings`), so a
   * rebind is honoured. Arrow keys are handled separately as the built-in
   * defaults.
   */
  private movementKeyNames = new Set<string>();

  /**
   * Human-like input layer for the demo bot (AH-0MUXXQ1MN002RXGB): samples
   * the pure decision at a human reaction cadence and resolves it to the
   * ship's own control scheme (W/A/D — never a reverse key).
   */
  private botGovernor = new BotInputGovernor();
  /** The structured competent bot's committed policy (AC1–AC4). */
  private botBrain = createCompetentBotBrain();
  /**
   * Name of the persisted bot-tuning configuration the demo bot is currently
   * flying with (AH-0MV6MFDYG001E6PL). `null` outside demo mode: human
   * sessions never consult the tuning store.
   */
  private appliedBotTuningName: string | null = null;

  /** Session state (lives, score, level). */
  private gameState: GameState;
  /** Wave/level progression state machine. */
  private waveManager: WaveManager;
  /** Active power-up effect registry. */
  private effectsRegistry: EffectsRegistry;

  private player: Player | null = null;
  private hud: HUD | null = null;

  private scoreText: Phaser.GameObjects.Text | null = null;
  private levelText: Phaser.GameObjects.Text | null = null;
  private bannerText: Phaser.GameObjects.Text | null = null;

  private spawned: SpawnedEnemy[] = [];
  private enemyBullets: PlayEnemyBullet[] = [];
  private drops: PlayDrop[] = [];
  /** Live mineral collectables on the field (GDD §4.5). */
  private minerals: Mineral[] = [];
  /** Whether the hold-full power-up choice is currently open. */
  private mineralChoiceOpen = false;
  /** The options currently offered by the hold-full choice. */
  private mineralChoiceOptions: ChoiceOption[] = [];
  /** Pluggable policy that selects the offered options. */
  private mineralChoiceStrategy: ChoiceStrategy = randomChoiceStrategy;

  /** The Central AI boss, spawned after the final level (null until then). */
  private boss: Boss | null = null;

  /**
   * The active level's wave-10 mini-boss entity (epic AH-0MVCC8XSS007P01Z),
   * spawned when the {@link WaveManager} opens the level's mini-boss wave and
   * held until it is defeated — the level only completes on its defeat.
   * Null outside the mini-boss encounter.
   */
  private miniBoss: MiniBoss | null = null;

  /**
   * Optional reward hook fired **exactly once** per mini-boss defeat
   * (consumer: mini-boss reward feature). `null` until a consumer installs
   * one; the call is guarded while absent (AC3).
   */
  private miniBossRewardHook: MiniBossDefeatHook | null = null;

  /** Optional checkpoint hook — see {@link miniBossRewardHook}. */
  private miniBossCheckpointHook: MiniBossDefeatHook | null = null;

  /** Total mini-bosses defeated this run (AC3: exactly one hook per defeat). */
  private miniBossDefeats = 0;

  /**
   * Run-scoped mini-boss unlock state (AH-0MVCRBNO6003E1CH): which initially
   * locked weapons this run has unlocked. The checkpoint feature persists it.
   */
  private miniBossUnlockState: MiniBossUnlockState = initialUnlockState();

  /** True while the mini-boss reward choice overlay is open. */
  private miniBossRewardOpen = false;

  /** Whether `create()` should resume from the persisted checkpoint. */
  private resumeFromCheckpoint = false;

  /** The checkpoint loaded in `init()`, applied once the run exists. */
  private pendingResumeCheckpoint: Checkpoint | null = null;

  /** The options offered by the open mini-boss reward overlay. */
  private miniBossRewardOptions: ChoiceOption[] = [];

  /**
   * Campaign level whose mini-boss has already been spawned this run. Guards
   * {@link _spawnMiniBossIfDue} against re-spawning (and double-registering
   * the gating spawn) if `spawnWave` were ever re-entered while the wave's
   * escorts are still alive.
   */
  private miniBossSpawnedLevel: number | null = null;

  /** Resolved DOM key name that toggles pause (from the bindings). */
  private pauseKeyName = 'Escape';

  /** Shield bubble (Shield) — drawn around the ship while shielded, cleared on absorb. */
  private shieldBubble: Phaser.GameObjects.Graphics | null = null;
  /** Whether the bubble was actually drawn in the last visual update. */
  private shieldBubbleDrawn = false;
  /** Force Field reflect-bubble graphics (Gradius homage, AH-0MV1BIX1W006XF95). */
  private forceFieldBubble: Phaser.GameObjects.Graphics | null = null;
  /** Thorn Field lime spike aura (AH-0MVJ8YKR70096C6T). */
  private thornsAura: Phaser.GameObjects.Graphics | null = null;
  /** Whether the aura was actually drawn in the last visual update. */
  private thornsAuraDrawn = false;

  private driftX = 0;
  private driftDir = 1;
  /**
   * Shared march-formation state for the current wave (Space Invaders
   * archetype, AH-0MV01EDZS0005R20). Non-null only when the wave contains a
   * `march` block; those enemies are positioned from this state rather than
   * the global drift, so the game runs the same policy as the gym.
   */
  private marchState: MarchState | null = null;
  /** Resolved march tuning for the current wave (null when no march block). */
  private marchOptions: MarchOptions | null = null;
  /**
   * Diver-group re-anchor offset (px), added only to Diver spawns' origin on
   * top of the drift. A Diver's attack re-anchors the Diver group by adding
   * the shared delta here, so the Diver's slot lands on its attack end while
   * every other enemy stays where it is (producer review,
   * AH-0MUL15N63003PUDB).
   */
  private diverAnchorX = 0;
  private diverAnchorY = 0;

  /** Glide manager: eases enemies to their re-anchored slots (AH-0MUL15N63003PUDB). */
  private glide = new FormationGlide();

  private transitionTimer = 0;

  /**
   * Registry for the in-run victory celebration display objects (the shared
   * `spawnVictoryJuice` layers). Cleared — with every leftover object
   * destroyed — on scene SHUTDOWN so a stop/restart leaks nothing.
   */
  private victoryEffects: Phaser.GameObjects.GameObject[] = [];

  // ── Wormhole spawn animation tracking ────────────────────────────
  /**
   * Single-live-wormhole lifecycle (shared with every gym via
   * `vfx/wormholeSpawn.ts`): opening a new wormhole first closes any
   * still-open one, and close is idempotent across transitions, timeouts,
   * respawns and resets (AH-0MV9KHLV8006GMX6).
   */
  private readonly _wormhole = new WormholeController(this);

  /**
   * Whether the simulation is frozen by the pause menu (parent
   * AH-0MU9LPZ0G0015292). While `true`, `tick()` short-circuits so no
   * subsystem advances.
   */
  private paused = false;

  /** Seconds left before the current banner hides itself (0 = hidden). */
  private bannerTimer = 0;

  /** Seconds remaining on the active wave's time limit (0 when inactive). */
  private waveTimer = 0;

  /** Whether the wave time-limit is currently counting down. */
  private waveTimerActive = false;

  /**
   * Whether random offscreen asteroid spawning is active. Enabled for the
   * campaign; switchable so gym/legacy fixtures can isolate a single fixed
   * asteroid without the dynamic spawner adding more.
   */
  private asteroidSpawnerEnabled = true;

  /** Rendered wave time-limit bar (top of the screen). */
  private waveTimerBar: Phaser.GameObjects.Graphics | null = null;

  private dropSpawner: PowerUpSpawner<DropId> | null = null;
  private rng: () => number = Math.random;

  /**
   * The run's loaded game rules (AH-0MVLJF5P0005KF8X). Resolved once at
   * create-time from persisted config; the level-scaling helpers consume
   * these to turn the live campaign level into the per-kill power-up drop
   * chance and the small-asteroid Extra Life chance (see
   * `src/core/levelScaling.ts` — nothing here hard-codes per-level
   * numbers). The legacy flat `asteroidExtraLifeDropChance` read was the
   * level-1 base; the per-level chance derives from this same rules object
   * (level 1 is exactly that base).
   */
  private rules: GameRules = DEFAULT_RULES;

  /**
   * The resolved per-run seed (AH-0MUY08V6W001SJJN). Assigned once per run
   * by {@link _initRunSeed}: the explicit {@link setRunSeed} value when one
   * was supplied, otherwise a fresh random seed, so each unseeded run
   * differs while a seeded run reproduces exactly. Exposed via
   * {@link getRunSeed} and mirrored onto `GameState.runSeed` for telemetry.
   */
  private runSeed = 0;

  /**
   * Explicit run seed supplied by a caller (test/headless seam); `null`
   * when the run should generate a fresh seed. Cleared after each run so a
   * restart without an explicit seed gets a new random run.
   */
  private injectedRunSeed: number | null = null;

  /**
   * Whether an RNG was injected via {@link setRng}. When true, `create()`
   * leaves the injected stream untouched (tests that script the RNG keep
   * their sequence); when false, `create()` seeds the stream from the run
   * seed.
   */
  private rngInjected = false;

  /**
   * Test/headless seam: a recorder injected via {@link setTelemetryRecorder}.
   * When null, `create()` builds one from the environment config (disabled by
   * default). The recorder is reused across restarts so a test can observe a
   * full run (AH-0MUY08VVQ007HSSH).
   */
  private injectedTelemetryRecorder: TelemetryRecorder | null = null;

  /**
   * Live run instrumentation (AH-0MUY08VVQ007HSSH). A strict no-op until
   * `_initTelemetry()` installs the configured/injected recorder, and while
   * telemetry is disabled. Never null, so tick/event call sites need no null
   * guard.
   */
  private runTelemetry: RunTelemetry = RunTelemetry.noop();

  /**
   * Scheduled asteroid hazard for the active wave (shared with the level
   * gyms, AH-0MV9AWR7A0084XJ0). Planned once per wave by
   * `planAsteroidSpawns()` so the scene rng stream is only advanced at wave
   * boundaries.
   */
  private readonly asteroidHazard = new AsteroidHazardLayer();

  /**
   * Planned Harvester spawns for the active regular wave (Levels 4–10 only),
   * computed once per wave by `planHarvesterSpawns()`. Each released spawn is
   * registered with the WaveManager (they gate wave completion — unlike
   * asteroids).
   */
  private pendingHarvesterSpawns: HarvesterSpawnEvent[] = [];
  /** Number of planned Harvester spawns already released this wave. */
  private harvestersSpawnedThisWave = 0;

  /**
   * Whether the Pac-Man ghost-pursuer group is planned for a wave
   * (classic-arcade archetype, AH-0MV01EH2U008XT3Q). Ghosts additionally
   * require the wave's `ghosts: true` opt-in, so the shipped campaign is
   * unchanged until a wave enables them. Tuning/test seam.
   */
  private ghostSpawnerEnabled = true;
  /** Planned ghost spawns for the active regular wave (empty unless opted in). */
  private pendingGhostSpawns: GhostSpawnEvent[] = [];
  /** Number of planned ghost spawns already released this wave. */
  private ghostsSpawnedThisWave = 0;

  /**
   * Whether the Centipede chain is planned for a wave (classic-arcade
   * archetype, AH-0MV01EJ92008ZZ86). The chain additionally requires the
   * wave's `centipede: true` opt-in, so the shipped campaign is unchanged
   * until a wave enables it. Tuning/test seam.
   */
  private centipedeSpawnerEnabled = true;
  /** The planned Centipede chain for the active wave (`null` unless opted in). */
  private pendingCentipedeSpawn: CentipedeSpawnEvent | null = null;
  /** Whether the planned Centipede chain has been released this wave. */
  private centipedeSpawnedThisWave = false;

  /**
   * Whether the Robotron homing horde is planned for a wave (classic-arcade
   * archetype, AH-0MV01EKTL001NRE6). The horde additionally requires the
   * wave's `horde: true` opt-in, so the shipped campaign is unchanged.
   */
  private hordeSpawnerEnabled = true;
  /** Planned horde spawns for the active regular wave (empty unless opted in). */
  private pendingHordeSpawns: HordeSpawnEvent[] = [];
  /** Number of planned horde spawns already released this wave. */
  private hordeSpawnedThisWave = 0;

  /**
   * Whether telegraphed orbital-strike spawning is active (Missile Command
   * archetype, AH-0MV01ENX00055CG1). Enabled for the campaign; switchable so
   * tests can isolate the hazard. The strike is a non-blocking world hazard
   * (like asteroids) — it never gates wave completion.
   */
  private orbitalStrikeSpawnerEnabled = true;
  /** Planned orbital-strike spawns for the active regular wave. */
  private pendingStrikeSpawns: StrikeSpawnEvent[] = [];
  /** Number of planned orbital-strike spawns already released this wave. */
  private strikesSpawnedThisWave = 0;

  /**
   * Whether the Frogger lane-traffic plan is active (classic-arcade archetype,
   * AH-0MV01EPM40008N8T). Lane traffic is a non-blocking world hazard, so it
   * is spawned directly rather than through the WaveManager. Tuning/test seam.
   */
  private laneTrafficSpawnerEnabled = true;
  /** Planned lane-traffic spawns for the active regular wave. */
  private pendingLaneTrafficSpawns: LaneTrafficSpawnEvent[] = [];
  /** Number of planned lane-traffic spawns already released this wave. */
  private laneTrafficSpawnedThisWave = 0;
  constructor() {
    super('PlayScene');
    this.gameState = new GameState({ gameState: 'playing' });
    this.waveManager = new WaveManager();
    this.effectsRegistry = new EffectsRegistry();
  }

  // ── Scene lifecycle ─────────────────────────────────────────────

  /**
   * Reads the scene-start data. Demo/attract mode is opt-in: only an explicit
   * `{ demo: true }` turns it on, so absent, `undefined` or non-`true` data is
   * always non-demo (AC1/AC7). A `seed` supplied here becomes the run seed
   * (AH-0MUY08V6W001SJJN), letting a caller start a reproducible run without
   * the {@link setRunSeed} seam.
   *
   * Scene-start data contract (AH-0MUY4881P007FJ8R): Phaser reuses this scene
   * instance and `Systems.start(data)` only rewrites `settings.data` for a
   * truthy `data`. A no-argument `scene.start('PlayScene')` therefore receives
   * the **previous** payload via `init()` — so every normal caller must pass an
   * explicit `{ demo: false }` (see `MenuScene`). This guard only protects a
   * genuinely absent payload; it cannot distinguish a stale one.
   */
  init(data?: {
    demo?: boolean;
    seed?: number;
    demoDwellMs?: number;
    resume?: boolean;
  }): void {
    this.demoMode = data?.demo === true;
    // Continue from the last checkpoint (AH-0MVCRBTNF000DK51). It is loaded
    // here so the saved run seed seeds the RNG before anything draws from it;
    // the rest of the run state is applied in `create()`.
    this.resumeFromCheckpoint = data?.resume === true;
    this.pendingResumeCheckpoint = this.resumeFromCheckpoint
      ? loadCheckpoint()
      : null;
    if (this.pendingResumeCheckpoint) {
      this.injectedRunSeed = this.pendingResumeCheckpoint.runSeed;
    }
    // The bot seam is inert outside demo mode; clear any name applied by a
    // previous demo so a normal (re)start never reports a stale config
    // (AH-0MV6MFDYG001E6PL).
    if (!this.demoMode) this.appliedBotTuningName = null;
    this.demoDwellMs = data?.demoDwellMs;
    if (data?.seed !== undefined) this.injectedRunSeed = normaliseSeed(data.seed);
  }

  create(): void {
    // Reset any state carried over from a previous session (restarts reuse
    // the same scene instance — never leak stale enemies/bullets/timers).
    this.resetRunState();
    // Fresh human-like bot input state for this run.
    this.botGovernor.reset();
    // Fresh competent-bot commitment/scratch for this run (AC1).
    this.botBrain.reset();
    // Demo runs fly the *persisted* bot-tuning configuration — the same store
    // the Bot Tuning gym edits (AH-0MV6MFDYG001E6PL). No-op outside demo
    // mode; corrupt/absent storage falls back to the built-in Default, so
    // behaviour is unchanged when nothing has been saved.
    this._applyBotTuning();
    // Resolve and seed the per-run RNG before anything draws from it
    // (AH-0MUY08V6W001SJJN). Must run before the player/drop spawner/enemies
    // are created so every gameplay draw comes from the seeded stream.
    this._initRunSeed();
    // Seed the bot's per-press jitter from the run seed so demo press
    // lengths are reproducible per run (AC15).
    this.botGovernor.seed(this.getRunSeed());
    // Install the telemetry instrumentation for this run (AH-0MUY08VVQ007HSSH):
    // the environment-configured recorder (disabled by default) unless a test
    // injected one. Records the run header + `run_start` event.
    this._initTelemetry();

    this.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000)
      .setOrigin(0)
      .setDepth(PLAYSCENE_BACKGROUND_DEPTH);

    // Player ship (auto-fire, weapons, effects).
    //
    // The control scheme is resolved once, at spawn, from the per-player
    // setting → the designer-owned ship config → the built-in default
    // (AH-0MVI7LRCJ006Q8SA AC4). Resolving here means a Settings change takes
    // effect on the next run/ship spawn; on RESUME the live ship is
    // re-resolved too, so a mid-run change is honoured on return to the
    // paused game (AH-0MVIMPC11001F7WU). The ship gets a copy of the config,
    // so neither the store nor `ship-config.csv` is touched. Gyms keep their
    // own config/toggle-driven scheme.
    const shipConfig = loadShipConfig();
    const playerScheme = resolvePlayerControlScheme(loadStoredControlScheme(), shipConfig);
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT - 80,
      config: { ...shipConfig, controlScheme: playerScheme },
    });
    this.add.existing(this.player);
    // The demo drives whichever control scheme the ship is configured with
    // (the shipped default is `asteroids`); the human-like governor resolves
    // the bot's steering intent to that scheme, so the demo ship looks and
    // handles like the player's ship rather than a four-directional impostor
    // (AH-0MUX2NENC008AHOQ producer review).
    this.cursors = this.input.keyboard?.createCursorKeys();
    // Movement / pause keys come from `ai_hell_settings`
    // (parent AH-0MU9LPZ0G0015292); arrow keys remain built-in defaults.
    this._applyBindings();
    // Shield bubble — rendered above gameplay (below the HUD).
    this.shieldBubble = this.add.graphics();
    this.shieldBubble.setDepth(50);
    // Force Field reflect bubble — above the shield bubble (below the HUD).
    this.forceFieldBubble = this.add.graphics();
    this.forceFieldBubble.setDepth(51);
    // Thorn Field aura — outside the Force Field bubble so the spiked halo
    // never reads as one of the round bubbles (AH-0MVJ8YKR70096C6T).
    this.thornsAura = this.add.graphics();
    this.thornsAura.setDepth(52);

    // HUD (lives counter + active effects).
    this.hud = new HUD(this, this.effectsRegistry, {
      showLives: true,
      // Show each weapon's run-scoped level (parent AH-0MUPMPCB2009J54J).
      getWeaponLevel: (id) => this.player?.getWeaponLevel(id as WeaponId) ?? 0,
    });

    this._buildHudText();

    // ESC toggles the pause menu (parent AH-0MU9LPZ0G0015292). Registered
    // here because the keyboard plugin is torn down on scene shutdown, so
    // there is no cross-session listener leak. While the demo runs the demo
    // take-over handler owns the pause key instead — ESC returns to the main
    // menu, never the pause menu (AH-0MUYP6M6W006Z1AY AC1/AC5).
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.key === this.pauseKeyName && !event.repeat && !this.demoMode) {
        this.togglePause();
      }
    });

    // Press-to-take-over while the demo runs (AH-0MUX4966Z0009P9Q AC3,
    // AH-0MUYP6M6W006Z1AY AC1–AC3, AH-0MUYG8XHI0044MQ1): a movement key
    // hands control to the player in place; any non-movement key (including
    // ESC) returns to the main menu; the pointer stays ignored.
    if (this.demoMode) this._enableDemoTakeOver();

    // Power-up drop pool.
    const rules = loadRules();
    this.rules = rules;
    this.dropSpawner = this._buildDefaultDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      this.rng,
    );

    // Start the run.
    this.gameState.startGame();
    this.effectsRegistry.setLives(this.gameState.lives);
    // Hold capacity (first hold) and its growth multiplier come from the
    // game-rules config, so the game and every gym progress identically
    // (GDD §4.5, AH-0MUKC6IML0082ZR4).
    this.gameState.mineralCapacity = rules.mineralHoldCapacity;
    this.gameState.mineralHoldGrowthMultiplier =
      rules.mineralHoldGrowthMultiplier;
    this._syncMineralHud();
    // Campaign source (AH-0MVLJF30O000E3J3): always resolve through
    // `resolveCampaignLevels`, which applies the level enemy-count scaling
    // exactly once to the static `LEVELS` campaign and to the sequenced one.
    // A campaign injected with `setLevels()` (tests, future callers) is left
    // untouched so the caller keeps control of the campaign. Never throws:
    // `resolveCampaignLevels` falls back to the (scaled) static campaign. The
    // run seed (AH-0MUJSUQD8003FSUT) is threaded in so `dynamic` waves
    // regenerate per run while staying reproducible for a given seed.
    if (!this.waveManager.hasInjectedLevels) {
      this.waveManager.setLevels(
        resolveCampaignLevels(rules, () =>
          buildSequencedLevels(undefined, undefined, { seed: this.runSeed }),
        ),
        { injected: false },
      );
    }
    // Checkpoint resume (AH-0MVCRBTNF000DK51): start at the saved level and
    // restore the run stats/permanent progress before the first wave spawns.
    const resume = this.pendingResumeCheckpoint;
    this.pendingResumeCheckpoint = null;
    this.resumeFromCheckpoint = false;
    this.waveManager.beginGame(resume?.level ?? 1);
    if (resume) this._restoreCheckpoint(resume);
    // The campaign labels need the started WaveManager (level/wave counts).
    this._refreshHudText();
    this.spawnWave();
    this._announceLevel();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());
    // Settings changes made in the pause menu must take effect when the
    // player returns to the paused game: rebinds re-apply immediately
    // (parent AH-0MU9LPZ0G0015292), and a control-scheme change is applied
    // to the live ship mid-run (AH-0MVIMPC11001F7WU). Spawn-time
    // application in create() still covers every new run.
    this.events.on(Phaser.Scenes.Events.RESUME, () => {
      this._applyResolvedControlScheme();
      this._applyBindings();
    });

    // Dev-gated recorder scenario (AH-0MUWZ5HCV0034H44): when the URL asks
    // for one, drop straight into the boss encounter. No-op in production.
    this._applyDevScenarioFromUrl();
  }

  /**
   * Re-resolves the effective player control scheme and applies it to the
   * live ship when the stored choice has changed. Called on RESUME so a
   * scheme chosen in the in-game Settings takes effect when the player
   * returns to the running game (mid-run), not only from the next spawn
   * (AH-0MVIMPC11001F7WU). Spawn-time application in create() is untouched,
   * so a stored scheme still drives the ship from the first frame of every
   * run. `Player.setScheme` swaps the movement model and input shape live;
   * the shared `mapControlInput` seam reads `player.getScheme()` per tick,
   * keeping gym↔game parity. An unchanged scheme is a no-op.
   */
  private _applyResolvedControlScheme(): void {
    if (!this.player) return;
    const resolved = resolvePlayerControlScheme(
      loadStoredControlScheme(),
      loadShipConfig(),
    );
    if (resolved !== this.player.getScheme()) {
      this.player.setScheme(resolved);
    }
  }

  /**
   * Reads the persisted `ai_hell_settings` bindings and creates the Phaser
   * keys for movement and the pause toggle. Arrow keys remain
   * always-available movement defaults. Called on create and again on RESUME
   * so a rebind takes effect immediately on return to the game. Teleport is
   * automatic (AH-0MUZE4AIP009HZWC), so no layer-drop action exists and
   * S / ↓ are free for reverse thrust.
   */
  private _applyBindings(): void {
    const bindings = resolveBindings(loadSettings().bindings);
    this.pauseKeyName = keyFor(bindings, 'pauseToggle');

    const kb = this.input.keyboard;
    if (!kb) {
      this.wasd = undefined;
      return;
    }
    const keyForAction = (action: ActionName) =>
      kb.addKey(resolveKeyCode(bindings[action], DEFAULT_BINDINGS[action]));
    this.wasd = {
      W: keyForAction('moveUp'),
      A: keyForAction('moveLeft'),
      S: keyForAction('moveDown'),
      D: keyForAction('moveRight'),
    } as WasdKeysLike;

    // The demo take-over keys must be the *same* source as normal-play
    // movement: the resolved `moveUp`/`moveDown`/`moveLeft`/`moveRight`
    // bindings (arrow-key defaults are added separately).
    this.movementKeyNames = new Set(
      (['moveUp', 'moveDown', 'moveLeft', 'moveRight'] as ActionName[]).map(
        (action) => this._normaliseKeyName(keyFor(bindings, action)),
      ),
    );
  }

  /**
   * Clears all per-run state so a restarted session starts fresh.
   *
   * The shared core reset ({@link CombatCoreScene.resetRunState}) clears
   * the effects registry and the shared bullet/effect/animation
   * registries; this override adds the campaign-only state (waves,
   * minerals, boss, timers, pause).
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.victoryEffects = [];
    this.spawned = [];
    this.enemyBullets = [];
    this.drops = [];
    this.minerals = [];
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.boss = null;
    this.miniBoss = null;
    this.miniBossDefeats = 0;
    this.miniBossSpawnedLevel = null;
    this.miniBossUnlockState = initialUnlockState();
    this.miniBossRewardOpen = false;
    this.miniBossRewardOptions = [];
    this.driftX = 0;
    this.driftDir = 1;
    this.diverAnchorX = 0;
    this.diverAnchorY = 0;
    this.transitionTimer = 0;
    this.bannerTimer = 0;
    this.waveTimer = 0;
    this.waveTimerActive = false;
    this.asteroidHazard.reset();
    this.pendingLaneTrafficSpawns = [];
    this.laneTrafficSpawnedThisWave = 0;
    this.pendingHarvesterSpawns = [];
    this.harvestersSpawnedThisWave = 0;
    this.pendingGhostSpawns = [];
    this.ghostsSpawnedThisWave = 0;
    this.pendingCentipedeSpawn = null;
    this.centipedeSpawnedThisWave = false;
    this.pendingHordeSpawns = [];
    this.hordeSpawnedThisWave = 0;
    this.pendingStrikeSpawns = [];
    this.strikesSpawnedThisWave = 0;
    this.shieldBubbleDrawn = false;
    this.thornsAuraDrawn = false;
    this._wormhole.close(this.wormholeEffects);
    this.paused = false;
  }

  /** Builds the fixed score / level text readouts (lives live in the HUD). */
  private _buildHudText(): void {
    this.scoreText = this.add
      .text(GAME_WIDTH - 10, 10, 'Score: 0', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: HUD_TEXT_COLOR,
      })
      .setOrigin(1, 0);

    // Level indicator sits top-centre so it never overlaps the HUD's
    // top-left lives counter / effect rows. The text is filled in by
    // `_refreshHudText()` once the WaveManager has started (below).
    this.levelText = this.add
      .text(GAME_WIDTH / 2, 10, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: HUD_TEXT_COLOR,
      })
      .setOrigin(0.5, 0);
  }

  /**
   * Destroys scene-owned objects on shutdown (no leaks across sessions).
   *
   * The shared core teardown ({@link CombatCoreScene.teardownRunState})
   * destroys the shared bullets/effects/animations; this override adds
   * the campaign-only object families.
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    clearDevScenarioHandle();
    this._disableDemoTakeOver();
    for (const s of this.spawned) s.entity.destroy(true);
    this.spawned = [];
    for (const b of this.enemyBullets) b.graphics.destroy();
    this.enemyBullets = [];
    for (const d of this.drops) d.graphics.destroy();
    this.drops = [];
    for (const m of this.minerals) m.destroy();
    this.minerals = [];
    this.shieldBubble?.destroy();
    this.shieldBubble = null;
    this.forceFieldBubble?.destroy();
    this.forceFieldBubble = null;
    this.thornsAura?.destroy();
    this.thornsAura = null;
    this.thornsAuraDrawn = false;
    this.hud?.destroy();
    this.hud = null;
    this.player?.destroy();
    this.player = null;
    this.boss?.destroy();
    this.boss = null;
    this.miniBoss?.destroy();
    this.miniBoss = null;
    this.bannerText?.destroy();
    this.bannerText = null;
    this.waveTimerBar?.destroy();
    this.waveTimerBar = null;

    // Destroy any in-run victory celebration still alive on shutdown.
    for (const effect of this.victoryEffects) effect.destroy();
    this.victoryEffects = [];

    // Clear glide state so a stop/restart starts fresh (AH-0MUL15N63003PUDB).
    this.glide.clear();

    // Flush any buffered records so the run tail (run_end) reaches the sink
    // before the scene is torn down (AH-0MUY08VVQ007HSSH).
    void this.runTelemetry.flush();
  }

  // ── Frame loop ──────────────────────────────────────────────────

  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds). Drives input → player
   * thrust, auto-fire, enemy formation movement and fire, bullet
   * lifecycles, collisions, power-up drops, and level transitions.
   */
  tick(dt: number): void {
    // Pause freeze (parent AH-0MU9LPZ0G0015292): while paused nothing
    // advances — enemies stop moving/firing, projectiles and timers
    // freeze, and the player is frozen and cannot be hit. Resuming
    // continues from this exact state with no time counted.
    if (this.paused) return;

    this.effectsRegistry.tick(dt);
    this.hud?.refresh();

    // The announcement banner is transient: it always expires on its own
    // timer, even while enemies remain alive (AH-0MU7JTEMC006QPSN).
    this._advanceBanner(dt);

    // Level/wave transition pause. Enemy spawning, enemy movement/fire and
    // enemy-based collisions are suspended, but carried-over asteroids
    // continue moving and are shootable/hitable (AH-0MU8TWF1H007OG2L).
    // The player stays in full control (input, physics and auto-fire)
    // and cannot be hit by enemy bullets during the pause
    // (AH-0MU7JTF9W008B8HW).
    const transitioning = this.transitionTimer > 0;
    if (transitioning) {
      this.transitionTimer = Math.max(0, this.transitionTimer - dt);
      // The transition banner is shown once at `_startTransition()`; its own
      // timer then governs how long it stays up, so it outlives the 1.5 s
      // pause and is no longer hidden when the transition completes
      // (AH-0MV8BQ75V005QNZ1).
      // Carried-over survivors stay active through the transition pause
      // (AH-0MUNS3ZQ1002DJ9S AC3): they keep their formation drift / their own
      // motion, keep firing, and remain shootable/hitable. `_moveEnemies`
      // handles both formation enemies and asteroids. Enemy bullets vs the
      // player stay suspended for the pause (AH-0MU7JTF9W008B8HW grace), so a
      // timed-out wave still gives the player the transition breather.
      this._moveEnemies(dt);
      this._collectEnemyFire();
      this._handleCarriedSurvivorCollisions();
      // Between-waves mineral passes (AH-0MUX96GJF006CAZP, AC1/AC3): the
      // player and carried-over survivors keep collecting/absorbing minerals
      // through the transition breather, and the shared Mineral Scoop scoop keeps
      // attracting them. `true` bypasses the Phase Shift phase gate for the pause only
      // (AC2) — normal wave play still blocks phased collection (Q7).
      this._applyMineralScoop(this.minerals, dt);
      this._handleMinerals(true);
      if (this.transitionTimer === 0) this._onTransitionComplete();
    } else {
      this._moveEnemies(dt);
      this._collectEnemyFire();
      // Shared boss advance (AH-0MUII3E5E006A93F, AC1) — same ordering
      // relative to collisions as every gym.
      this._advanceBoss(dt);
    }

    // Player input, thrust and auto-fire run in every phase, including the
    // wave/level transition pause.
    //
    // Human-like demo bot: sample the decision at a human reaction cadence
    // before the shared player step reads the input seam
    // (AH-0MUXXQ1MN002RXGB).
    this._advanceDemoBot(dt);
    // Shared player-control step (timers → multipliers → input → physics →
    // auto-fire) — identical in every scene (AH-0MUII39KX007YUQ0, AC1).
    this._tickPlayer(dt);

    this._advanceBullets(dt);
    if (!transitioning) {
      // Automatic defence (Phase Shift / Teleport): feed live danger before
      // collision gating so a trigger this frame protects this frame
      // (parent AH-0MUIYX1EE008FVS8; AH-0MUZE4AIP009HZWC).
      this._updateAutoDefence(dt);
      // Advance the wormhole spawn animation first so an enemy that finishes
      // growing this frame is collidable on the same frame it becomes whole.
      this._updateSpawnAnimations(dt);
      // Mineral Scoop attractor runs before the shared mineral collection
      // inside _handleCollisions, so a mineral pulled into the hull this frame
      // is collected this frame (parity with every gym).
      this._applyMineralScoop(this.minerals, dt);
      this._handleCollisions();
      // Release any asteroid spawns whose planned time has passed — before
      // the timer advances so a wave-timeout cannot release the whole plan.
      this._releaseDueAsteroidSpawns();
      // Release any planned Harvester spawns (Levels 4–10 only) whose time
      // has passed; each is registered with the WaveManager so wave-clear
      // accounting stays correct (F6).
      this._releaseDueHarvesterSpawns();
      // Release any planned ghost-pursuer spawns whose time has passed
      // (AH-0MV01EH2U008XT3Q); each is registered with the WaveManager so the
      // wave neither clears early nor stalls.
      this._releaseDueGhostSpawns();
      // Release the planned Centipede chain whose time has passed
      // (AH-0MV01EJ92008ZZ86); every segment is registered with the
      // WaveManager so the wave neither clears early nor stalls.
      this._releaseDueCentipedeSpawn();
      // Release any planned Robotron homing-horde grunts whose time has passed
      // (AH-0MV01EKTL001NRE6); each is registered with the WaveManager so the
      // wave neither clears early nor stalls.
      this._releaseDueHordeSpawns();
      // Release any planned telegraphed orbital strikes whose time has passed
      // (AH-0MV01ENX00055CG1); non-blocking world hazards (never registered
      // with the WaveManager), like asteroids.
      this._releaseDueStrikeSpawns();
      // Release any planned Frogger lane-traffic hazards whose time has passed
      // (AH-0MV01EPM40008N8T); these are NOT registered with the WaveManager
      // (non-blocking world hazard, the Asteroid accounting).
      this._releaseDueLaneTrafficSpawns();
      this._advanceWaveTimer(dt);
    }
    this._updateInvulnerability(dt);
    this._updateVisuals();
    this._updatePhaseShiftJuice(dt);
    this._updateDrops(dt);
    this._refreshHudText();
    this._drawWaveTimer();
    // Per-tick telemetry last, so the recorded state matches the frame the
    // player actually saw (AH-0MUY08VVQ007HSSH). No-op when off.
    this._recordTelemetryTick();
  }

  /**
   * Advances the wormhole spawn animation for every spawning enemy.
   * When all enemies in the current wave have finished growing, the
   * wormhole closes and the spawn sequence is complete (AC1–AC4).
   */
  private _updateSpawnAnimations(dt: number): void {
    let anySpawning = false;
    for (const s of this.spawned) {
      if (!s.entity.isSpawning) continue;
      const stillGrowing = updateSpawnAnimation(s.entity, dt);
      // Per-entity emergence shimmer (AH-0MVD2N333004VDA9) rides the same
      // shared spawn path, immediately after the growth write so its scale
      // pulse layers on the growth scale instead of fighting it
      // (AH-0MVD2N9MM0007NGZ wiring).
      updateEnemyShimmer(s.entity as unknown as SpawnAnimatable, dt);
      if (stillGrowing) {
        anySpawning = true;
      } else {
        s.entity.setSpawning(false);
      }
    }
    if (!anySpawning) this._wormhole.close(this.wormholeEffects);
  }

  /**
   * Test seam: immediately completes any in-progress wormhole spawn
   * animations without ticking the whole scene, so collision tests observe
   * fully-spawned enemies without advancing wave timers or asteroid spawns
   * (AH-0MURBER4L00821RR). Not used by gameplay.
   */
  finishSpawnAnimations(): void {
    for (const s of this.spawned) {
      if (!s.entity.isSpawning) continue;
      // Fast-forward past the wormhole-open delay + full growth.
      updateSpawnAnimation(s.entity as unknown as SpawnAnimatable, 10);
      s.entity.setSpawning(false);
    }
    this._wormhole.close(this.wormholeEffects);
  }

  // ── Wave spawning & progression ─────────────────────────────────

  /**
   * Spawns the enemies of the active wave in their formations. Public so
   * tests and the (future) boss integration can drive it deterministically.
   */
  spawnWave(): void {
    // Plan the random offscreen asteroid spawns for this wave. Empty during
    // the boss encounter (see `planAsteroidSpawns`).
    this.planAsteroidSpawns();
    // Plan the rare Harvester spawns (Levels 4–10 only; empty elsewhere).
    this.planHarvesterSpawns();
    // Plan the Pac-Man ghost-pursuer group for waves that opted in
    // (AH-0MV01EH2U008XT3Q); empty for every other wave.
    this.planGhostSpawns();
    // Plan the Centipede chain for waves that opted in
    // (AH-0MV01EJ92008ZZ86); empty for every other wave.
    this.planCentipedeSpawn();
    // Plan the Robotron homing horde for waves that opted in
    // (AH-0MV01EKTL001NRE6); empty for every other wave.
    this.planHordeSpawns();
    // Plan the telegraphed orbital strikes for this wave (Missile Command
    // archetype, AH-0MV01ENX00055CG1); empty before wave 3.
    this.planStrikeSpawns();
    // Plan the Frogger lane traffic for this wave (AH-0MV01EPM40008N8T); it is
    // a non-blocking world hazard (the Asteroid accounting).
    this.planLaneTrafficSpawns();
    const spawns = this.waveManager.planSpawns(this.rng);
    // The formation is anchored relative to the wave portal; without a live
    // portal (no planned enemies) the plan is used unchanged.
    let anchoredSpawns: EnemySpawn[] = spawns;
    // Carry-over continuity (AH-0MV9FUG4J008OHKA): when the previous wave
    // timed out, its surviving formation enemies persist in place — resetting
    // the shared drift/march state below would re-anchor every survivor to its
    // spawn origin (a visible snap). Capture the carried survivors **before**
    // spawning the fresh wave so the just-spawned enemies are never mistaken
    // for carried ones.
    const carriedFormation = this.spawned.filter(
      (s) =>
        s.entity.alive &&
        !isNonBlockingHazard(s.enemyKey) &&
        s.enemyKey !== 'orbital-strike' &&
        !s.entity.setSeekTargets,
    );
    if (spawns.length > 0) {
      // Open the wave's wormhole at an independent position well away from
      // the player (current position and ~2 s trajectory), then anchor every
      // formation enemy relative to that portal — portal-relative offsets
      // instead of screen coordinates (AH-0MV8BR9Y70079TKC, AC1–AC5). The
      // shared controller closes any still-open previous wormhole first, so
      // a transition/timeout that began mid-spawn never strands a live one
      // (AC3 — AH-0MV9KHLV8006GMX6).
      const portal = this._resolveWavePortal(spawns);
      anchoredSpawns = anchorSpawnsToPortal(spawns, portal);
      // Every enemy of the wave emerges from the wave's portal and traverses
      // to its anchored formation position during the spawn window
      // (AH-0MV8BSMXC0097KLW, composed with AH-0MV8BR9Y70079TKC).
      this._wormhole.open(portal.x, portal.y, this.wormholeEffects);
      const wormholeOrigin = { x: portal.x, y: portal.y };
      for (const spawn of anchoredSpawns) this._spawnEnemy(spawn, wormholeOrigin);
      playSpawnSound();
    }

    // Whenever a formation survivor carries over, keep the continuing base so
    // survivors simply keep moving and the fresh wave's enemies join that base
    // (gym parity with `GymFormationScene.respawnWithCarriedSurvivors`). With
    // no carried formation survivors (a clean wipe), the base resets exactly
    // as before.
    if (carriedFormation.length === 0) {
      this.driftX = 0;
      this.driftDir = 1;
      this.diverAnchorX = 0;
      this.diverAnchorY = 0;
      this._resetMarchFormation(anchoredSpawns);
    } else {
      // Keep the continuous drift, its direction and the Diver anchor exactly
      // where they were — the fresh wave's enemies join the continuing base
      // (gym parity).
      const carriedMarch = carriedFormation.some((s) => s.march);
      if (!carriedMarch) {
        // No march block is being carried: a fresh march block (if this wave
        // has one) still starts at its configured origin, exactly as on a
        // clean start.
        this._resetMarchFormation(anchoredSpawns);
      }
      // When march survivors are carried, the continuing march state is kept
      // in full: fresh march spawns join the single rigid block (mirroring
      // the gym's carry-over respawn).
    }
    this._spawnMiniBossIfDue();
    this._startWaveTimer();
    this.runTelemetry.waveStart(
      this.waveManager.level,
      this.waveManager.waveNumber,
      this.waveManager.waveCount,
    );
  }

  /**
   * Spawns the level's mini-boss when the active wave is the flagged
   * wave-10 mini-boss encounter (epic AH-0MVCC8XSS007P01Z, AC1). Called from
   * {@link spawnWave} — i.e. once per wave/level transition — so the entity
   * appears as the mini-boss wave begins. Idempotent: an already-live entity
   * is never re-spawned.
   *
   * The entity is registered with the {@link WaveManager} as a gating spawn,
   * so the level clears only once the mini-boss **and** the wave's escorts
   * are destroyed (AC2). Its defeat then replays one destruction through the
   * shared wave state machine (see {@link _damageMiniBoss}).
   */
  private _spawnMiniBossIfDue(): void {
    if (!this.waveManager.miniBossActive) return;
    if (this.miniBoss?.alive) return;

    const level = this.waveManager.level;
    // One encounter per level: never re-register the gating spawn (a second
    // registration would require a second destruction and stall the wave).
    if (this.miniBossSpawnedLevel === level) return;
    this.miniBossSpawnedLevel = level;
    this.miniBoss = new MiniBoss(this, this.miniBossConfigFor(level));
    this.add.existing(this.miniBoss);
    // Gate the level on the mini-boss: the wave cannot clear (and the level
    // cannot advance) until this registration is itself destroyed.
    this.waveManager.registerDynamicSpawn(1);
    // No per-wave time limit applies to the encounter (like the final boss).
    this._hideWaveTimer();
  }

  /**
   * Builds the config for the active level's mini-boss (extension point for
   * the per-level mini-boss designs feature, epic AH-0MVCC8XSS007P01Z).
   *
   * Until those designs land this returns the **generic default** mini-boss
   * — config-driven phases, patterns, HP and colour defaulted by
   * {@link MiniBoss} — positioned like the final boss at the screen centre.
   * An override supplies a per-level design without changing the share/defeat
   * wiring.
   */
  protected miniBossConfigFor(level: number): MiniBossConfig {
    // The ten bespoke per-level designs are the single data source for the
    // encounter (AH-0MVCRBXSS008JSV0); the gym consumes the same helper.
    // The hit pool scales with the player's total permanent upgrade levels
    // (AH-0MVH87A3L004VOLD) so an upgraded ship faces a tougher encounter.
    const design = miniBossDesignForLevel(level);
    return miniBossConfigForLevel(level, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2 - 80,
      formationOffset: { row: 0, col: 0 },
      rng: this.rng,
      hpPerPhase: scaledEncounterHp(design.hpPerPhase, this.getPlayerPowerScore()),
    });
  }

  /**
   * The run's firepower: the total permanent weapon + power-up levels
   * (AH-0MVH87A3L004VOLD). 0 on a fresh run. Used to scale the mini-boss and
   * final-boss hit pools.
   */
  getPlayerPowerScore(): number {
    return playerPowerScore(
      this.player?.getWeaponLevels() ?? [],
      this.player?.getPowerUpLevels() ?? [],
    );
  }

  /**
   * Chooses where the wave's wormhole opens (AH-0MV8BR9Y70079TKC).
   *
   * Derives the wave's formation extents from the planned spawns (single
   * source for `D_MIN = max(height, width)`), then runs the shared
   * {@link placeWavePortal} helper with the player's live position and
   * velocity. Uses the scene RNG so deterministic replays stay
   * deterministic. The portal is independent of any single enemy slot and
   * the whole formation is anchored relative to it (AC1–AC5).
   */
  private _resolveWavePortal(spawns: readonly EnemySpawn[]): PortalPoint {
    const movement = this.player?.getMovementState();
    return placeWavePortal({
      formation: formationExtents(spawns),
      anchor: formationCentre(spawns),
      playfield: { width: GAME_WIDTH, height: GAME_HEIGHT },
      player: movement
        ? { x: movement.x, y: movement.y, vx: movement.vx, vy: movement.vy }
        : null,
      rng: this.rng,
    });
  }

  /**
   * Instantiates one enemy from its spawn descriptor.
   *
   * @param origin - The wave's wormhole position when the enemy should emerge
   *   from the wormhole and traverse to its formation slot. When omitted (e.g.
   *   boss minions, which are not part of the wave's wormhole entry) the
   *   enemy is created in place with the growth animation only.
   */
  private _spawnEnemy(spawn: EnemySpawn, origin?: { x: number; y: number }): void {
    const cfg = loadEnemyConfig(spawn.enemyKey);
    const entity = createEnemyFromConfig(
      this,
      cfg,
      origin?.x ?? spawn.x,
      origin?.y ?? spawn.y,
      spawn.offset,
      this.rng,
    );
    entity.shootEnabled = spawn.shootEnabled;

    // ── Wormhole spawn animation (AC1–AC4) ────────────────────────
    // The enemy starts at 1 px and grows to its full scale over the
    // growth duration; while spawning it is protected from collisions.
    // Growth begins once the wormhole has finished opening. When the enemy
    // emerged from the wormhole it also traverses to its formation position
    // in lock-step with the growth animation (AH-0MV8BSMXC0097KLW).
    // Entities with autonomous motion (e.g. the Raider, whose patrol/attack
    // state drives its own position) are exempt: they emerge at the origin
    // and their own motion carries them out, avoiding a position pop when
    // the spawn window ends.
    const transit =
      origin && !(entity as { autonomousPositioning?: boolean }).autonomousPositioning;
    // Orbital entities (the Phaser) expose a live formation-slot seam: the
    // wormhole transit targets their orbital slot instead of the grid line,
    // so they never appear in a line then snap onto the ring
    // (AH-0MVEXVME1004SIIS, Q2=A). Every other enemy keeps the grid slot.
    const orbitalSlot = (
      entity as {
        formationSlot?: (baseX: number, baseY: number) => { x: number; y: number };
      }
    ).formationSlot;
    startSpawnAnimation(
      entity,
      entity.scaleX,
      WORMHOLE_OPEN_DURATION,
      transit
        ? () => {
            // Track the live formation slot so formation drift/march during
            // the transit is followed and the enemy lands exactly on it.
            const isMarch = cfg.formationKind === 'march';
            const baseX =
              isMarch && this.marchState
                ? this.marchState.x
                : spawn.startX + this.driftX;
            const baseY =
              isMarch && this.marchState
                ? this.marchState.y
                : spawn.startY;
            if (typeof orbitalSlot === 'function') {
              return orbitalSlot.call(entity, baseX, baseY);
            }
            return {
              x: baseX + spawn.offset.col * spawn.spacingX,
              y: baseY + spawn.offset.row * spawn.spacingY,
            };
          }
        : undefined,
    );
    entity.setSpawning(true);

    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: spawn.enemyKey,
      startX: spawn.startX,
      startY: spawn.startY,
      spacingX: spawn.spacingX,
      spacingY: spawn.spacingY,
      march: cfg.formationKind === 'march',
    });
  }

  /**
   * Initialises (or clears) the shared march-formation state for a wave
   * (Space Invaders archetype, AH-0MV01EDZS0005R20).
   *
   * A wave may contain at most one march block — the block is a single rigid
   * body, so it marches as one unit. The block's arena-edge bounds are derived
   * from its widest column and the group spacing, matching the gym's
   * `_marchBounds` calculation so the game and gym cannot diverge. A wave with
   * no march spawns clears the state and keeps the legacy continuous drift.
   */
  private _resetMarchFormation(spawns: EnemySpawn[]): void {
    const marchSpawns = spawns.filter(
      (spawn) => loadEnemyConfig(spawn.enemyKey).formationKind === 'march',
    );
    if (marchSpawns.length === 0) {
      this.marchState = null;
      this.marchOptions = null;
      return;
    }

    const first = marchSpawns[0];
    const cfg = loadEnemyConfig(first.enemyKey);
    const maxAbsCol = marchSpawns.reduce(
      (max, spawn) => Math.max(max, Math.abs(spawn.offset.col)),
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
      initialCount: marchSpawns.length,
    };
  }

  /**
   * Plans the random offscreen asteroid spawns for the active regular wave
   * (AH-0MUGCNZNE002D7QJ). Called once per wave from `spawnWave()` so the
   * scene rng stream advances only at wave boundaries. Outside a regular
   * wave — before `beginGame()`, during or after the boss encounter — the
   * plan is cleared and no asteroids spawn.
   */
  planAsteroidSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.asteroidSpawnerEnabled ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.asteroidHazard.reset();
      return;
    }
    this.asteroidHazard.plan(
      wm.globalWaveIndex,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      this.rng,
    );
  }

  /**
   * Releases every planned asteroid spawn whose scheduled time has passed.
   * Runs only during the regular wave phase (never during a transition,
   * pause or boss encounter) and stops at the first not-yet-due event — the
   * plan is time-ordered.
   */
  private _releaseDueAsteroidSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    this.asteroidHazard.releaseDue(elapsed, (event) =>
      this._spawnScheduledAsteroid(event),
    );
  }

  /**
   * Spawns one planned asteroid at its offscreen position with the planned
   * inward velocity. Asteroids are NOT registered with the WaveManager
   * (AH-0MUJM746P000QAEO): they do not gate wave completion, and they persist
   * in the field across wave and level transitions.
   */
  private _spawnScheduledAsteroid(event: SpawnEvent): void {
    const entity = createAsteroidFromEvent(this, event, this.rng);
    this.spawned.push({
      entity,
      enemyKey: 'asteroid',
      startX: 0,
      startY: 0,
      spacingX: 0,
      spacingY: 0,
    });
  }

  /**
   * Plans the telegraphed orbital strikes for the active regular wave
   * (Missile Command archetype, AH-0MV01ENX00055CG1). Called once per wave
   * from `spawnWave()` so the scene rng stream advances only at wave
   * boundaries. Outside a regular wave — before `beginGame()`, during or
   * after the boss encounter — the plan is cleared and no strikes spawn.
   */
  planStrikeSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.orbitalStrikeSpawnerEnabled ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.pendingStrikeSpawns = [];
      this.strikesSpawnedThisWave = 0;
      return;
    }
    const player = this.getPlayer();
    this.pendingStrikeSpawns = computeStrikeSpawns(
      wm.globalWaveIndex,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      player?.x ?? GAME_WIDTH / 2,
      player?.y ?? GAME_HEIGHT / 2,
      this.rng,
    );
    this.strikesSpawnedThisWave = 0;
  }

  /**
   * Releases every planned orbital strike whose scheduled time has passed.
   * Runs only during the regular wave phase (never during a transition,
   * pause or boss encounter) and stops at the first not-yet-due event — the
   * plan is time-ordered.
   */
  private _releaseDueStrikeSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    while (this.strikesSpawnedThisWave < this.pendingStrikeSpawns.length) {
      const event = this.pendingStrikeSpawns[this.strikesSpawnedThisWave];
      if (elapsed + 1e-9 < event.timeSeconds) break;
      this._spawnScheduledStrike(event);
      this.strikesSpawnedThisWave += 1;
    }
  }

  /**
   * Spawns one planned orbital strike at its impact point. Like asteroids,
   * strikes are NOT registered with the WaveManager (AH-0MV01ENX00055CG1):
   * they are non-blocking world hazards and never gate wave completion.
   * Their radial detonation burst is routed through the shared enemy-bullet
   * path so it can damage the player, but it never touches other enemies.
   */
  private _spawnScheduledStrike(event: StrikeSpawnEvent): void {
    const entity = new OrbitalStrike(this, {
      x: event.x,
      y: event.y,
      formationOffset: { row: 0, col: 0 },
      rng: this.rng,
    });
    this.add.existing(entity);
    entity.initStrike(event.x, event.y, event.burstCount, this.rng);
    this.spawned.push({
      entity,
      enemyKey: 'orbital-strike',
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
    });
  }

  /**
   * Plans the rare Harvester spawns for the active regular wave. Only
   * Levels 4–10 are eligible; Levels 1–3 and the boss encounter produce no
   * plan. Called once per wave from `spawnWave()` so the scene rng stream
   * advances only at wave boundaries (F6).
   */
  planHarvesterSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.asteroidSpawnerEnabled ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.pendingHarvesterSpawns = [];
      this.harvestersSpawnedThisWave = 0;
      return;
    }
    this.pendingHarvesterSpawns = computeHarvesterSpawns(
      wm.currentLevel()?.level ?? 0,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      this.rng,
    );
    this.harvestersSpawnedThisWave = 0;
  }

  /**
   * Releases every planned Harvester spawn whose scheduled time has passed.
   * Runs only during the regular wave phase (never during a transition,
   * pause or boss encounter) and stops at the first not-yet-due event — the
   * plan is time-ordered.
   */
  private _releaseDueHarvesterSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    while (this.harvestersSpawnedThisWave < this.pendingHarvesterSpawns.length) {
      const event = this.pendingHarvesterSpawns[this.harvestersSpawnedThisWave];
      if (elapsed + 1e-9 < event.timeSeconds) break;
      this._spawnScheduledHarvester(event);
      this.harvestersSpawnedThisWave += 1;
    }
  }

  /**
   * Spawns one planned Harvester at its position and registers it with the
   * WaveManager so the wave's alive count tracks it. Unlike asteroids, a
   * Harvester holds station when no mineral is present, so it must be
   * wave-accounted (the wave neither clears early nor stalls) — hence the
   * on-screen placement in the planner.
   */
  private _spawnScheduledHarvester(event: HarvesterSpawnEvent): void {
    const cfg = loadEnemyConfig('harvester');
    const entity = createEnemyFromConfig(
      this,
      cfg,
      event.x,
      event.y,
      { row: 0, col: 0 },
      this.rng,
    );
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: 'harvester',
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
    });
    this.waveManager.registerDynamicSpawn(1);
  }

  /**
   * Plans the Pac-Man ghost-pursuer group for the active regular wave
   * (classic-arcade archetype, AH-0MV01EH2U008XT3Q). Only waves that opt in
   * with `ghosts: true` produce a plan; Levels/campaign data that do not
   * opt in are unchanged. Called once per wave from `spawnWave()` so the
   * scene rng stream advances only at wave boundaries.
   */
  planGhostSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.ghostSpawnerEnabled ||
      wm.currentWave()?.ghosts !== true ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.pendingGhostSpawns = [];
      this.ghostsSpawnedThisWave = 0;
      return;
    }
    this.pendingGhostSpawns = computeGhostSpawns(
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      this.rng,
    );
    this.ghostsSpawnedThisWave = 0;
  }

  /**
   * Releases every planned ghost spawn whose scheduled time has passed. Runs
   * only during the regular wave phase (never during a transition, pause or
   * boss encounter) and stops at the first not-yet-due event — the plan is
   * time-ordered.
   */
  private _releaseDueGhostSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    while (this.ghostsSpawnedThisWave < this.pendingGhostSpawns.length) {
      const event = this.pendingGhostSpawns[this.ghostsSpawnedThisWave];
      if (elapsed + 1e-9 < event.timeSeconds) break;
      this._spawnScheduledGhost(event);
      this.ghostsSpawnedThisWave += 1;
    }
  }

  /**
   * Spawns one planned ghost at its position and registers it with the
   * WaveManager so the wave's alive count tracks it. Ghosts are placed
   * on-screen by the planner, so they are always reachable and never stall
   * wave completion.
   */
  private _spawnScheduledGhost(event: GhostSpawnEvent): void {
    const cfg = loadEnemyConfig(event.enemyKey);
    const entity = createEnemyFromConfig(
      this,
      cfg,
      event.x,
      event.y,
      { row: 0, col: 0 },
      this.rng,
    );
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: event.enemyKey,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
    });
    this.waveManager.registerDynamicSpawn(1);
  }

  /**
   * Plans the Centipede chain for the active regular wave (classic-arcade
   * archetype, AH-0MV01EJ92008ZZ86). Only waves that opt in with
   * `centipede: true` produce a plan; every other wave is unchanged. Called
   * once per wave from `spawnWave()` so the scene rng stream advances only at
   * wave boundaries.
   */
  planCentipedeSpawn(): void {
    const wm = this.waveManager;
    if (
      !this.centipedeSpawnerEnabled ||
      wm.currentWave()?.centipede !== true ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.pendingCentipedeSpawn = null;
      this.centipedeSpawnedThisWave = false;
      return;
    }
    this.pendingCentipedeSpawn = computeCentipedeSpawn(
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      this.rng,
    );
    this.centipedeSpawnedThisWave = false;
  }

  /**
   * Releases the planned Centipede chain once its scheduled time has passed.
   * Runs only during the regular wave phase (never during a transition, pause
   * or boss encounter).
   */
  private _releaseDueCentipedeSpawn(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated ||
      this.centipedeSpawnedThisWave ||
      !this.pendingCentipedeSpawn
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    if (elapsed + 1e-9 < this.pendingCentipedeSpawn.timeSeconds) return;
    this._spawnScheduledCentipede(this.pendingCentipedeSpawn);
    this.centipedeSpawnedThisWave = true;
  }

  /**
   * Spawns the planned Centipede chain: one shared `CentipedeChain` and one
   * `Centipede` entity per segment. Every segment is registered with the
   * `WaveManager` so the wave neither clears early nor stalls while any
   * segment is alive (the Harvester/Ghost invariant; unlike Asteroids).
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
    for (let id = 0; id < event.segmentCount; id++) {
      const segment = chain.segment(id);
      const entity = new Centipede(this, {
        x: segment?.x ?? event.x,
        y: segment?.y ?? event.y,
        formationOffset: { row: 0, col: id },
        chain,
        segmentId: id,
        rng: this.rng,
      });
      this.add.existing(entity);
      this.spawned.push({
        entity,
        enemyKey: CENTIPEDE_ENEMY_KEY,
        startX: event.x,
        startY: event.y,
        spacingX: 0,
        spacingY: 0,
      });
      this.waveManager.registerDynamicSpawn(1);
    }
  }

  /**
   * Plans the Robotron homing horde for the active regular wave
   * (classic-arcade archetype, AH-0MV01EKTL001NRE6). Only waves that opt in
   * with `horde: true` produce a plan; every other wave is unchanged. The
   * horde size, group size, spawn cadence and homing speed are all
   * data-driven (the `grunt` CSV row). Called once per wave from `spawnWave()`
   * so the scene rng stream advances only at wave boundaries.
   */
  planHordeSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.hordeSpawnerEnabled ||
      wm.currentWave()?.horde !== true ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.pendingHordeSpawns = [];
      this.hordeSpawnedThisWave = 0;
      return;
    }
    const cfg = loadEnemyConfig(GRUNT_ENEMY_KEY);
    this.pendingHordeSpawns = computeHordeSpawns({
      gameWidth: GAME_WIDTH,
      gameHeight: GAME_HEIGHT,
      waveTimeLimitSeconds: WAVE_TIME_LIMIT_SECONDS,
      count: cfg.count,
      groupSize: cfg.hordeGroupSize ?? HORDE_DEFAULT_GROUP_SIZE,
      spawnIntervalSeconds:
        cfg.hordeSpawnInterval ?? HORDE_DEFAULT_SPAWN_INTERVAL_SECONDS,
      rng: this.rng,
    });
    this.hordeSpawnedThisWave = 0;
  }

  /**
   * Releases every planned horde grunt whose scheduled time has passed. Runs
   * only during the regular wave phase (never during a transition, pause or
   * boss encounter) and stops at the first not-yet-due event — the plan is
   * time-ordered.
   */
  private _releaseDueHordeSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    while (this.hordeSpawnedThisWave < this.pendingHordeSpawns.length) {
      const event = this.pendingHordeSpawns[this.hordeSpawnedThisWave];
      if (elapsed + 1e-9 < event.timeSeconds) break;
      this._spawnScheduledHorde(event);
      this.hordeSpawnedThisWave += 1;
    }
  }

  /**
   * Spawns one planned grunt on its arena edge and registers it with the
   * `WaveManager` so the wave neither clears early nor stalls while the horde
   * is alive. Grunts are placed inside the play area by the planner, so they
   * are always reachable.
   */
  private _spawnScheduledHorde(event: HordeSpawnEvent): void {
    const cfg = loadEnemyConfig(event.enemyKey);
    const entity = createEnemyFromConfig(
      this,
      cfg,
      event.x,
      event.y,
      { row: 0, col: 0 },
      this.rng,
    );
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: event.enemyKey,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
    });
    this.waveManager.registerDynamicSpawn(1);
  }

  /**
   * Plans the Frogger lane-traffic hazards for the active regular wave
   * (classic-arcade archetype, AH-0MV01EPM40008N8T). Only waves that opt in
   * with `laneTraffic: true` produce a plan; every other wave is unchanged, so
   * the shipped campaign is untouched. The lane count, per-lane count, speed
   * and spacing are all data-driven (the `lane-traffic` CSV row). Called once
   * per wave from `spawnWave()` so the scene rng stream advances only at wave
   * boundaries.
   *
   * Lane traffic is a non-blocking world hazard (Asteroid accounting), so the
   * plan is spawned directly and never registered with the `WaveManager`.
   */
  planLaneTrafficSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.laneTrafficSpawnerEnabled ||
      wm.currentWave()?.laneTraffic !== true ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      this.pendingLaneTrafficSpawns = [];
      this.laneTrafficSpawnedThisWave = 0;
      return;
    }
    const cfg = loadEnemyConfig('lane-traffic');
    this.pendingLaneTrafficSpawns = computeLaneTrafficSpawns({
      gameWidth: GAME_WIDTH,
      gameHeight: GAME_HEIGHT,
      waveTimeLimitSeconds: WAVE_TIME_LIMIT_SECONDS,
      laneCount: cfg.laneCount ?? LANE_TRAFFIC_DEFAULT_LANE_COUNT,
      perLaneCount: cfg.count,
      spacing: cfg.spacingX,
      laneSpacing: cfg.laneSpacing ?? LANE_TRAFFIC_DEFAULT_LANE_SPACING,
      speed: cfg.driftSpeed,
      rng: this.rng,
    });
    this.laneTrafficSpawnedThisWave = 0;
  }

  /**
   * Releases every planned lane-traffic hazard whose scheduled time has
   * passed. Runs only during the regular wave phase (never during a
   * transition, pause or boss encounter) and stops at the first not-yet-due
   * event — the plan is time-ordered.
   */
  private _releaseDueLaneTrafficSpawns(): void {
    const wm = this.waveManager;
    if (
      !this.waveTimerActive ||
      !wm.currentWave() ||
      wm.bossTriggered ||
      wm.bossActive ||
      wm.bossDefeated
    ) {
      return;
    }
    const elapsed = WAVE_TIME_LIMIT_SECONDS - this.waveTimer;
    while (this.laneTrafficSpawnedThisWave < this.pendingLaneTrafficSpawns.length) {
      const event =
        this.pendingLaneTrafficSpawns[this.laneTrafficSpawnedThisWave];
      if (elapsed + 1e-9 < event.timeSeconds) break;
      this._spawnScheduledLaneTraffic(event);
      this.laneTrafficSpawnedThisWave += 1;
    }
  }

  /**
   * Spawns one planned lane-traffic hazard at its lane position and velocity.
   * Lane traffic is NOT registered with the WaveManager
   * (AH-0MV01EPM40008N8T): it is a non-blocking world hazard (the Asteroid
   * accounting), so it can never stall or prematurely clear a wave.
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
      rng: this.rng,
    });
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: event.enemyKey,
      startX: event.x,
      startY: event.y,
      spacingX: 0,
      spacingY: 0,
    });
  }

  /** Advances formation drift and repositions every live enemy. */
  private _moveEnemies(dt: number): void {
    // Formation drift advances unconditionally — no entity can freeze it (the
    // obsolete formation-hold seam was removed in AH-0MUAYB957002EMYV).
    this.driftX += this.driftDir * FORMATION_DRIFT_SPEED * dt;
    if (this.driftX > FORMATION_DRIFT_RANGE) {
      this.driftX = FORMATION_DRIFT_RANGE;
      this.driftDir = -1;
    } else if (this.driftX < 0) {
      this.driftX = 0;
      this.driftDir = 1;
    }

    // Advance the shared march block for this wave (Space Invaders archetype,
    // AH-0MV01EDZS0005R20): the same pure step/reverse/drop/speed-up policy the
    // gym runs. The block's cadence scales with its live alive count.
    if (this.marchState && this.marchOptions) {
      const alive = this.spawned.reduce(
        (count, spawn) => count + (spawn.march && spawn.entity.alive ? 1 : 0),
        0,
      );
      this.marchState = advanceMarch(
        this.marchState,
        dt,
        alive,
        this.marchOptions,
      );
    }

    // Diver re-anchor (GDD §4.1 — E2): if a Diver's attack finished, re-base
    // the whole unit so its slot lands on the attack end. Applied after the
    // drift and before positioning so every enemy uses the new origin in the
    // same frame.
    const reanchorApplied = this._applyFormationReanchor();

    // Live mineral-seek: push the scene's live mineral field so roaming
    // seekers (Harvester) steer toward the nearest live mineral — the same
    // shared helper the gyms call (AH-0MV5SDNI2008RWQ2). The seeker advances
    // its own motion in the loop below.
    pushSeekTargets(
      this.spawned.filter((s) => s.entity.alive).map((s) => s.entity),
      this.minerals,
    );

    for (const s of this.spawned) {
      if (!s.entity.alive) continue;
      // Non-blocking world hazards (Asteroid, Frogger lane traffic) advance
      // their own constant-velocity motion with four-edge wrap (never
      // formation drift).
      if (isNonBlockingHazard(s.enemyKey)) {
        s.entity.updatePosition?.(dt);
        continue;
      }
      // Orbital strikes run their own telegraph → fall → detonate lifecycle
      // (Missile Command archetype, AH-0MV01ENX00055CG1); they are not
      // formation-positioned. Their radial detonation burst is hoisted into
      // the shared enemy-bullet path here — at detonation time, before the
      // destroyed entity is skipped — so it can damage the player while never
      // touching other enemies.
      if (s.enemyKey === 'orbital-strike') {
        const strike = s.entity as OrbitalStrike;
        strike.update(dt);
        const burst = strike.getBurstBullets();
        if (burst.length > 0) {
          this.enemyBullets.push(...burst);
          strike.clearBurstBullets();
        }
        continue;
      }
      // Roaming seekers (Harvester) advance their own motion — the scene's
      // live mineral field was pushed above by the shared helper (F4 parity).
      if (s.entity.setSeekTargets) {
        s.entity.updatePosition?.(dt);
        continue;
      }
      // Only Divers ride the Diver re-anchor offset; every other enemy uses
      // the drift alone and therefore stays where it is when a Diver
      // re-anchors (AC5, AH-0MUL15N63003PUDB).
      const isDiver = s.entity.consumeFormationReanchor != null;
      // March-block enemies are positioned from the shared march state (which
      // already carries the drop); every other enemy keeps the global drift.
      const baseX =
        s.march && this.marchState ? this.marchState.x : s.startX + this.driftX;
      const baseY = s.march && this.marchState ? this.marchState.y : s.startY;
      s.entity.applyFormationPosition(
        baseX + (isDiver ? this.diverAnchorX : 0),
        baseY + (isDiver ? this.diverAnchorY : 0),
        dt,
        s.spacingX,
        s.spacingY,
      );
    }

    // If a re-anchor fired (now or on an earlier frame), ease all living
    // entities from their old positions to the live (drifting) slot
    // (AH-0MUL15N63003PUDB). A no-op when no glide is active.
    if (reanchorApplied || this.glide.active) {
      this.glide.update(dt);
    }
  }

  /**
   * Consumes any pending enemy re-anchor requests and shifts the Diver-group
   * anchor so the requesting Diver's slot lands on its attack end (shared rule
   * in `computeFormationReanchorDelta`). The most recent request wins when
   * Divers are desynchronised (documented assumption). Only the Divers move:
   * every other enemy stays where it is (producer review,
   * AH-0MUL15N63003PUDB).
   *
   * @returns `true` if a re-anchor was applied (and the glide was begun),
   *   `false` otherwise.
   */
  private _applyFormationReanchor(): boolean {
    let latest: { request: FormationReanchorRequest; spawn: SpawnedEnemy } | null = null;
    for (const spawn of this.spawned) {
      const request = spawn.entity.consumeFormationReanchor?.();
      if (request) latest = { request, spawn };
    }
    if (!latest) return false;

    const { request, spawn } = latest;
    // Re-anchor the Diver group only: the delta moves the Diver origin so the
    // requester's slot lands on the attack end. Every other enemy is left
    // exactly where it is (producer review, AH-0MUL15N63003PUDB).
    const { dx, dy } = computeFormationReanchorDelta(
      request,
      spawn.startX + this.driftX + this.diverAnchorX,
      spawn.startY + this.diverAnchorY,
      spawn.spacingX,
      spawn.spacingY,
    );
    this.diverAnchorX += dx;
    this.diverAnchorY += dy;

    // Only the Divers glide to their new slots; non-Divers did not move this
    // frame, so they are not tracked by the glide.
    const glideTargets = this.spawned
      .filter(
        (s) => s.entity.alive && s.entity.consumeFormationReanchor != null,
      )
      .map((s) => s.entity);
    this.glide.begin(glideTargets);
    return true;
  }

  /**
   * Handles a wave/level/boss transition after an enemy death.
   */
  private _advanceAfterKill(): void {
    this._handleWaveEvent(this.waveManager.onEnemyDestroyed());
  }

  /**
   * Reacts to a {@link WaveEvent} from the shared wave state machine. Split
   * out of {@link _advanceAfterKill} so the mini-boss defeat path
   * ({@link _damageMiniBoss}) replays exactly the same transition handling
   * as an ordinary enemy death.
   */
  private _handleWaveEvent(event: WaveEvent): void {
    switch (event) {
      case 'continue':
        return;
      case 'waveCleared':
        this.runTelemetry.waveCleared(
          this.waveManager.level,
          this.waveManager.waveNumber,
        );
        this._startTransition();
        return;
      case 'levelCleared':
        this.runTelemetry.levelCleared(this.waveManager.level);
        this._announceLevel();
        this._startTransition();
        return;
      case 'bossTriggered':
        this.runTelemetry.bossTriggered();
        this.onBossTriggered();
        return;
      case 'gameComplete':
        return;
    }
  }

  /** Begins the brief pause before the next wave/level spawns. */
  private _startTransition(): void {
    // Close any wormhole still open (e.g. a timeout/carry-over began
    // mid-spawn): the normal close tick is gated behind the non-transition
    // branch, so the close must happen at transition start (AC4 —
    // AH-0MV9KHLV8006GMX6).
    this._wormhole.close(this.wormholeEffects);
    this.transitionTimer = LEVEL_TRANSITION_SECONDS;
    // The time-limit is paused/hidden while the transition runs; the next
    // wave restarts a fresh countdown (AH-0MU7JTG9R002ZWA6).
    this._hideWaveTimer();
    this._updateTransitionBanner();
  }

  /**
   * The shared level/wave progress label used by both the persistent HUD
   * readout and the transition banner, e.g. `Level 1: Entry, Wave: 1 of 2`
   * (AH-0MUMMBRCC0093MGV). During the boss encounter it collapses to just
   * `Boss` (no numeric level and no name), per AH-0MU7JTEY3004EXR2.
   *
   * With sequenced levels active the name comes from the CSV
   * (`WaveManager.levelName` → `LevelDefinition.name`); with static
   * `LEVELS` it is the `LevelDefinition.name` property. When the name is
   * empty the label falls back to a name-free numeric form
   * (`Level N of 10, Wave M of K`) so no blank label or crash occurs.
   */
  private _progressLabel(): string {
    const wm = this.waveManager;
    if (wm.bossTriggered || wm.bossActive || wm.bossDefeated) return 'Boss';
    const name = wm.levelName?.trim();
    if (name) {
      return `Level ${wm.level}: ${name}, Wave: ${wm.waveNumber} of ${wm.waveCount}`;
    }
    return `Level ${wm.level} of ${wm.levelCount}, Wave ${wm.waveNumber} of ${wm.waveCount}`;
  }

  /** Shows/updates the centred transition banner. */
  private _updateTransitionBanner(): void {
    this._showBanner(this._progressLabel());
  }

  /** Shows the level announcement banner at level start. */
  private _announceLevel(): void {
    this._showBanner(this._progressLabel());
  }

  /**
   * Shows the banner with the supplied label and (re)starts its
   * self-expiry timer so it always clears a bounded time later.
   */
  private _showBanner(label: string): void {
    if (!this.bannerText) {
      this.bannerText = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, label, BANNER_STYLE)
        .setOrigin(0.5)
        .setDepth(500);
    }
    this.bannerText.setText(label).setVisible(true);
    this.bannerTimer = BANNER_DURATION_SECONDS;
  }

  /** Counts the banner's lifetime down and hides it when it expires. */
  private _advanceBanner(dt: number): void {
    if (this.bannerTimer <= 0) return;
    this.bannerTimer = Math.max(0, this.bannerTimer - dt);
    if (this.bannerTimer === 0) this._hideBanner();
  }

  /** Hides the banner and cancels any pending expiry. */
  private _hideBanner(): void {
    this.bannerTimer = 0;
    this.bannerText?.setVisible(false);
  }

  /**
   * Called when the final level is wiped: begins the boss encounter and
   * runs the transition banner, after which `_onTransitionComplete`
   * spawns the Central AI.
   */
  protected onBossTriggered(): void {
    // No random asteroids in the boss encounter: drop the last wave's plan
    // so no spawn can leak in after the transition (AH-0MUGCNZNE002D7QJ).
    this.asteroidHazard.reset();
    this.pendingGhostSpawns = [];
    this.ghostsSpawnedThisWave = 0;
    this.pendingCentipedeSpawn = null;
    this.centipedeSpawnedThisWave = false;
    this.pendingHordeSpawns = [];
    this.hordeSpawnedThisWave = 0;
    this.pendingStrikeSpawns = [];
    this.strikesSpawnedThisWave = 0;
    this.waveManager.beginBoss();
    this._startTransition();
  }

  /**
   * Called when a wave/level/boss transition ends: spawns the boss when
   * the encounter is due, otherwise spawns the current wave.
   */
  private _onTransitionComplete(): void {
    if (this.waveManager.bossActive && !this.boss) {
      // Carried-over asteroids do not belong in the boss encounter: destroy
      // them before the boss spawns (no split children) — AH-0MU8TWF1H007OG2L.
      this._clearAsteroidsOnBossEntry();
      this.spawnBoss();
    } else {
      this.spawnWave();
    }
    // The banner is intentionally NOT hidden here: its own transient timer
    // (`_advanceBanner`) expires it so the announcement stays readable after
    // the next wave spawns (AH-0MV8BQ75V005QNZ1).
  }

  /**
   * Destroys every alive carried-over asteroid when the boss encounter is
   * due. Uses the normal destruction VFX but deliberately bypasses
   * `_onEnemyKilled()` so `_splitAsteroid()` does not spawn children
   * (AH-0MU8TWF1H007OG2L).
   */
  private _clearAsteroidsOnBossEntry(): void {
    for (const s of this.spawned) {
      if (!s.entity.alive) continue;
      if (s.enemyKey !== 'asteroid') continue;
      s.entity.destroySelf();
      this._playEnemyDestruction(s.entity);
    }
    // Drop the destroyed asteroids so no stale entries linger into the boss fight.
    this.spawned = this.spawned.filter(
      (s) => s.entity.alive || s.enemyKey !== 'asteroid',
    );
  }

  /**
   * Spawns the Central AI boss at the screen centre and summons its
   * Phase-1 minion wave (GDD §4.3).
   *
   * @param options — dev/test overrides: `initialHp` / `initialPhase` tune the
   *   starting health/phase, and `spawnMinions: false` skips the Phase-1 minion
   *   wave (used by the dev boss scenario so the fight is deterministic).
   */
  protected spawnBoss(
    options: {
      initialHp?: number;
      initialPhase?: number;
      spawnMinions?: boolean;
    } = {},
  ): void {
    this.boss = new Boss(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2 - 80,
      formationOffset: { row: 0, col: 0 },
      rng: this.rng,
      initialHp: options.initialHp,
      initialPhase: options.initialPhase,
      // The final boss strengthens with the player's permanent upgrades
      // exactly like the mini-bosses (AH-0MVH87A3L004VOLD). Dev scenarios
      // that pin `initialHp` keep their explicit pool.
      hitPointsPerPhase:
        options.initialHp === undefined
          ? scaledEncounterHp(
              BOSS_HIT_POINTS_PER_PHASE,
              this.getPlayerPowerScore(),
            )
          : undefined,
    });
    this.add.existing(this.boss);
    this.runTelemetry.bossSpawn();
    if (options.spawnMinions !== false) this._spawnMinions(1);
    // No per-wave time limit applies to the boss encounter.
    this._hideWaveTimer();
  }

  // ── Dev scenarios (AH-0MUWZ5HCV0034H44) ──────────────────────────

  /**
   * Drops the run straight into the boss encounter with `hitsRemaining`
   * further hits required to win (the dev-gated recorder scenario).
   *
   * The current regular wave is cleared without awarding score or triggering a
   * transition, the boss spawns in its final phase with no minions and its
   * attacks disabled, and the ship is placed directly below the boss facing it
   * so the auto-fire lands on its own. The run is then frozen so the recorder
   * can start capturing before the (short) fight begins; the pause key resumes
   * it (see `docs/dev/gameplay-capture.md`).
   *
   * Public so tests and the capture tool can drive it directly; the URL query
   * path in `create()` calls this only when the dev flag is on.
   *
   * @param hitsRemaining — further boss hits before the run is won.
   */
  startDevBossScenario(hitsRemaining: number): void {
    this._clearWaveForScenario();
    this.waveManager.beginBoss();
    this.spawnBoss({
      initialHp: hitsRemaining,
      // Show the final, desperation visuals: a low-HP boss reads as an
      // about-to-explode boss rather than a healthy Phase-1 one.
      initialPhase: BossPhase.Desperation,
      spawnMinions: false,
    });
    if (this.boss) {
      // No attacks: the display is the spectacle, and a stray volley could
      // kill the ship (or the minions could soak the player's fire) before
      // the 4 hits land. Draw the core once so the paused boss is fully
      // rendered before the first tick.
      this.boss.shootEnabled = false;
      this.boss.update(0, 0, GAME_WIDTH, GAME_HEIGHT);
    }
    this._positionPlayerForBossScenario();
    this._refreshHudText();
    this.setPaused(true);
    // Expose a deterministic release hook so the recorder can start the short
    // fight after recording is live, without simulating the pause key
    // (AH-0MUWZ5HCV0034H44). No-op in production.
    installDevScenarioHandle({
      hitsRemaining,
      resume: () => this.setPaused(false),
    });
  }

  /**
   * Drops the run straight into a deterministic **defeat** (the dev-gated
   * recorder scenario for the defeat path, AH-0MUX2K8U7000GFNU producer-audit
   * follow-up).
   *
   * The current wave is cleared and the run is frozen so the recorder can
   * start before the (instant) end. Releasing the page-side handle drains the
   * ship's remaining lives, ending the run in defeat through the normal
   * `_loseLife` → `_finishRun(false)` path — so `npm run capture -- --scenario
   * defeat` exercises the defeat end-of-run signal and the recorder's tail
   * exactly as a natural loss would.
   *
   * Public so tests and the capture tool can drive it directly; the URL query
   * path in `create()` calls this only when the dev flag is on.
   */
  startDevDefeatScenario(): void {
    this._clearWaveForScenario();
    this._refreshHudText();
    this.setPaused(true);
    // Reuse the shared release handle: `hitsRemaining: 0` marks the run as
    // already over and the recorder only needs `resume()`.
    installDevScenarioHandle({
      hitsRemaining: 0,
      resume: () => this._forceDevDefeat(),
    });
  }

  /**
   * Ends a released defeat scenario through the normal fatal-loss path: with
   * one life left, a fatal `_loseLife` reaches zero and `_finishRun(false)`
   * emits the defeat end-of-run signal before the game-over transition.
   */
  private _forceDevDefeat(): void {
    this.setPaused(false);
    this.gameState.lives = 1;
    this._loseLife(true);
  }

  /**
   * Clears the active regular wave for the dev boss scenario without scoring
   * or advancing the campaign: destroys the spawned enemies, drops their
   * bullets, cancels planned asteroid/Harvester releases, closes any open
   * wormhole and hides the wave timer.
   */
  private _clearWaveForScenario(): void {
    this._wormhole.close(this.wormholeEffects);
    for (const s of this.spawned) {
      if (s.entity.alive) s.entity.destroySelf();
    }
    this.spawned = [];
    this.miniBoss?.destroy();
    this.miniBoss = null;
    for (const bullet of this.enemyBullets) bullet.graphics.destroy();
    this.enemyBullets = [];
    this.asteroidHazard.reset();
    this.pendingHarvesterSpawns = [];
    this.harvestersSpawnedThisWave = 0;
    this.pendingGhostSpawns = [];
    this.ghostsSpawnedThisWave = 0;
    this.pendingCentipedeSpawn = null;
    this.centipedeSpawnedThisWave = false;
    this.pendingHordeSpawns = [];
    this.hordeSpawnedThisWave = 0;
    this.pendingStrikeSpawns = [];
    this.strikesSpawnedThisWave = 0;
    this._hideWaveTimer();
  }

  /**
   * Places the ship to the boss's left at the same height and leaves it
   * stationary, aiming the auto-fire at the boss with no player input.
   *
   * The default heading is to the right in **both** control schemes (the
   * Asteroids scheme starts at `facing: 0`; the 4-directional scheme's
   * stationary default heading is also 0), so the scenario never has to touch
   * the ship's facing or control scheme.
   */
  private _positionPlayerForBossScenario(): void {
    const boss = this.boss;
    const player = this.player;
    if (!boss || !player) return;
    const x = Math.max(40, boss.x - 260);
    player.respawn(x, boss.y);
  }

  /**
   * Applies a URL-selected dev scenario at the end of {@link create} when the
   * dev flag is on. No-op in production and for an absent/unknown scenario, so
   * a normal run is byte-for-byte unchanged.
   */
  private _applyDevScenarioFromUrl(): void {
    if (!isDevScenarioEnabled()) return;
    if (typeof window === 'undefined') return;
    const scenario: DevScenario | null = resolveDevScenario(
      window.location?.search ?? '',
    );
    if (!scenario) return;
    if (scenario.kind === 'boss') {
      this.startDevBossScenario(scenario.bossHitsRemaining);
    } else if (scenario.kind === 'defeat') {
      this.startDevDefeatScenario();
    }
  }

  /** Spawns the minion wave for the given boss phase (GDD §4.3). */
  private _spawnMinions(phase: number): void {
    for (const spawn of planMinionSpawns(phase, this.rng)) this._spawnEnemy(spawn);
  }

  /**
   * Handles a single player hit on the boss (bullet or AOE). Applies one
   * hit; score and minions are gated on phase depletion via
   * `Boss.takeDamage()`'s `phaseAdvanced` signal (AH-0MUUJEB1D000GPX0):
   * only a depleting hit awards the phase score and summons the next
   * phase's minions. The run is completed as a victory when the boss dies
   * (GDD §4.5).
   *
   * @param hitX — optional world-space X of the hit, forwarded to
   *   `Boss.takeDamage()` so the per-hit impact VFX appears at the hit point.
   * @param hitY — optional world-space Y of the hit.
   */
  private _damageBoss(hitX?: number, hitY?: number): void {
    const boss = this.boss;
    if (!boss || !boss.alive) return;

    const previousPhase = boss.getPhaseNumber();
    const result = boss.takeDamage(hitX, hitY);
    if (result.destroyed) {
      // Capture the boss's death position before anything else can move or
      // destroy it — the celebration is anchored here (AC3).
      const deathX = boss.x;
      const deathY = boss.y;
      // Boss destroyed — award the final phase's points, then win.
      this.gameState.addScore(BOSS_PHASE_SCORES[previousPhase] ?? 0);
      this.waveManager.onBossDefeated();
      this.runTelemetry.bossDefeated();
      // The body's death VFX is intentional, but the health-bar box must not
      // linger as a dark rectangle through the victory celebration
      // (AH-0MVH85XXZ008INE2).
      boss.getHealthBarGraphics().setVisible(false);
      this._triggerVictoryCelebration(deathX, deathY);
      this._finishRunWithPurpose(true);
      return;
    }

    // Phase depleted: award the destroyed phase's points (GDD §4.5) and
    // summon the next phase's minions. Partial-phase hits do neither.
    if (result.phaseAdvanced) {
      this.gameState.addScore(BOSS_PHASE_SCORES[previousPhase] ?? 0);
      this.runTelemetry.bossPhase(boss.getPhaseNumber());
      this._spawnMinions(boss.getPhaseNumber());
    }
  }

  /**
   * Handles one player hit on the active level's mini-boss (epic
   * AH-0MVCC8XSS007P01Z, AH-0MVCRBISU006NUN5). The shared `takeDamage()`
   * contract drives phases/patterns; on the lethal blow the encounter is
   * finalised exactly once:
   *
   * 1. the reward and checkpoint hooks fire (capturing the level just
   *    completed, before the run state advances) — AC3;
   * 2. the registered gating spawn is replayed through the shared wave state
   *    machine, which advances the level (or triggers the final boss on the
   *    final level) — AC2/AC3.
   */
  private _damageMiniBoss(hitX?: number, hitY?: number): void {
    const miniBoss = this.miniBoss;
    if (!miniBoss || !miniBoss.alive) return;

    const result = miniBoss.takeDamage(hitX, hitY);
    if (!result.destroyed) return;

    const context: MiniBossDefeatContext = {
      level: this.waveManager.level,
      waveNumber: this.waveManager.waveNumber,
      miniBossName: miniBoss.resolvedConfig.name,
      isFinalLevel: this.waveManager.isFinalLevel,
    };
    // Fully tear the encounter down. `takeDamage()` only fades the body and
    // darkens the health bar; the entity's scene-level Graphics (the health
    // bar and the telegraph/pulse-wave ring) live outside the container and
    // would otherwise remain frozen on screen after the level advances
    // (AH-0MVH85XXZ008INE2). `destroy()` removes them (and any minions).
    miniBoss.destroy();
    this.miniBoss = null;
    this._fireMiniBossDefeatHooks(context);

    // The mini-boss was registered as a gating dynamic spawn when it spawned,
    // so this single destruction closes its encounter and advances the level
    // (or triggers the final boss) through the ordinary wave path.
    let event = this.waveManager.onEnemyDestroyed();

    // Defeat reconciliation (AC2 — the level completes on the mini-boss
    // defeat). The wave-timeout carry-over path can leave the manager's alive
    // count above zero for enemies that are no longer on the field; without
    // this the mini-boss encounter — the one wave that cannot be timed out —
    // would stall forever. When the field is empty, the mini-boss defeat is
    // the authoritative gate, so clear the stale residual through the shared
    // "removed without a destruction event" seam and replay the clear once.
    if (this.waveManager.miniBossActive && this.getAliveCount() === 0) {
      this.waveManager.unregisterDynamicSpawn(this.waveManager.enemiesAlive);
      event = this.waveManager.onEnemyDestroyed();
    }
    this._handleWaveEvent(event);
  }

  /**
   * Fires the reward then checkpoint hooks exactly once for one mini-boss
   * defeat (AC3). Both are optional — guarded while no consumer is installed,
   * so the gameplay path is unchanged until the reward/checkpoint features
   * land.
   */
  private _fireMiniBossDefeatHooks(context: MiniBossDefeatContext): void {
    this.miniBossDefeats += 1;
    // Auto-save the checkpoint at every mini-boss defeat (AC2).
    this._saveCheckpoint(context);
    this.miniBossRewardHook?.(context);
    this.miniBossCheckpointHook?.(context);
    // Reward loop (AH-0MVCRBNO6003E1CH AC1): a defeat offers exactly ONE
    // upgrade-or-unlock choice through the shared choice overlay. Off in the
    // headless/dev scenarios and while a choice is already open.
    if (!this.miniBossRewardOpen) this.openMiniBossReward(context);
  }

  /**
   * Opens the mini-boss reward choice (AH-0MVCRBNO6003E1CH): one choice —
   * upgrade an owned permanent weapon/power-up by one level, OR unlock a
   * weapon from the initially-locked pool. Reuses the shared
   * `MineralChoiceScene` overlay (launcher-agnostic) and pauses play exactly
   * like the hold-full choice.
   *
   * @param _context - The defeated mini-boss's context (level/wave/name).
   * @returns The offered options.
   */
  openMiniBossReward(_context: MiniBossDefeatContext): ChoiceOption[] {
    if (this.miniBossRewardOpen) return [...this.miniBossRewardOptions];
    // Option A — upgrade any one owned permanent weapon/power-up.
    const owned: ChoiceOption[] = buildUpgradeOptions({
      weaponLevels: this.player?.getWeaponLevels() ?? [],
      powerUpLevels: this.player?.getPowerUpLevels() ?? [],
    });
    // Option B — unlock one weapon still in the initially-locked pool.
    const unlocks: ChoiceOption[] = lockedWeaponIds(
      this.miniBossUnlockState,
    ).map((weaponId) => toChoiceOption(weaponId as DropId));
    const options = [...owned, ...unlocks];
    this.miniBossRewardOptions = options;
    this.miniBossRewardOpen = true;
    this.mineralChoiceOpen = true;
    this.setPaused(true);
    if (this.scene.manager.getScene('MineralChoiceScene')) {
      this.scene.pause();
      this.scene.launch('MineralChoiceScene', {
        origin: 'PlayScene-miniBoss',
        options: [...this.miniBossRewardOptions],
        // Demo mode auto-selects a random offered option after the same
        // human-like delay as the hold-full choice, so the attract bot never
        // stalls on the reward screen (AH-0MVJ8U79V0056I2F · AC1/AC2). The
        // pick is drawn from the run-seeded RNG, so a seed replays the same
        // reward; normal play leaves both params unset and waits for a real
        // selection (AC3).
        ...(this.demoMode
          ? {
              autoSelectMs: BOT_MINERAL_CHOICE_DELAY_MS,
              autoSelectIndex: this._randomDemoRewardIndex(),
            }
          : {}),
        // Single overlay contract: the launcher supplies one selection
        // callback; `selectMineralChoice` routes it to the reward resolver
        // while the reward is open.
        onSelect: (index: number) => this.selectMineralChoice(index),
      });
    }
    return [...this.miniBossRewardOptions];
  }

  /**
   * The demo bot's random mini-boss reward pick: a uniform index into the
   * currently offered reward options, drawn from the run-seeded RNG so a given
   * seed reproduces the same reward (AH-0MVJ8U79V0056I2F · AC2). The result is
   * clamped to `0 .. n-1` (returning 0 for an empty offer) so the overlay's
   * auto-select can never be handed an out-of-range index. Only the demo
   * auto-select consults it, so normal play is unaffected.
   */
  private _randomDemoRewardIndex(): number {
    const count = this.miniBossRewardOptions.length;
    if (count <= 0) return 0;
    return Math.min(count - 1, Math.max(0, Math.floor(this.rng() * count)));
  }

  /**
   * Resolves the mini-boss reward: applies the chosen option through the
   * shared reward seam (permanent upgrade or weapon unlock), records any
   * unlock, resumes play and closes the overlay. Exactly one option is
   * consumed per mini-boss (AC4).
   *
   * @returns The chosen option, or null for an out-of-range index.
   */
  selectMiniBossReward(index: number): ChoiceOption | null {
    const option = this.miniBossRewardOptions[index];
    if (!option) return null;
    applyMineralChoiceReward(option, this.effectsRegistry, this.player);
    // An unlock option names a locked weapon: record it so the run (and the
    // checkpoint) knows the weapon is now available.
    if (option.kind === 'weapon') {
      this.miniBossUnlockState = unlockWeapon(
        option.id as WeaponId,
        this.miniBossUnlockState,
      );
    }
    this.miniBossRewardOpen = false;
    this.miniBossRewardOptions = [];
    this.mineralChoiceOpen = false;
    this.setPaused(false);
    if (this.scene.manager.getScene('MineralChoiceScene')) {
      this.scene.resume();
    }
    return option;
  }

  /**
   * Writes the run checkpoint after a mini-boss defeat (AC2). The saved level
   * is the level the run **resumes** at — the one after the defeated
   * mini-boss (capped at the final level), at wave 1 — so Continue always
   * restarts cleanly at the beginning of a level.
   */
  private _saveCheckpoint(context: MiniBossDefeatContext): void {
    const resumeLevel = Math.min(context.level + 1, MAX_LEVEL);
    const checkpoint: Checkpoint = {
      version: CHECKPOINT_VERSION,
      level: resumeLevel,
      wave: 1,
      lives: this.gameState.lives,
      score: this.gameState.score,
      minerals: this.gameState.minerals,
      weaponLevels: this.player?.getWeaponLevels() ?? [],
      powerUpLevels: this.player?.getPowerUpLevels() ?? [],
      unlockedWeapons: this.getUnlockedWeapons(),
      runSeed: this.getRunSeed(),
      savedAt: new Date().toISOString(),
    };
    saveCheckpoint(checkpoint);
  }

  /**
   * Restores a checkpoint into a freshly created run (AC3/AC4): run stats,
   * the run seed (reproducibility/leaderboard validity), permanent weapon and
   * power-up levels and the mini-boss unlock state. The WaveManager has
   * already started at the checkpoint level.
   */
  private _restoreCheckpoint(checkpoint: Checkpoint): void {
    this.gameState.lives = checkpoint.lives;
    this.gameState.score = checkpoint.score;
    this.gameState.minerals = checkpoint.minerals;
    this.gameState.runSeed = checkpoint.runSeed;
    this.injectedRunSeed = checkpoint.runSeed;
    this.effectsRegistry.setLives(checkpoint.lives);
    // Replay the permanent grants through the ordinary collection seam so the
    // restored levels are identical to a run that earned them.
    for (const entry of checkpoint.weaponLevels) {
      for (let i = 0; i < entry.level; i += 1) {
        this.player?.equipWeapon(entry.id, true);
      }
    }
    for (const entry of checkpoint.powerUpLevels) {
      for (let i = 0; i < entry.level; i += 1) {
        this.player?.collectPowerUp(entry.id, true);
      }
    }
    const unlocked = new Set<WeaponId>(this.miniBossUnlockState.unlockedWeapons);
    for (const weaponId of checkpoint.unlockedWeapons) unlocked.add(weaponId);
    this.miniBossUnlockState = { unlockedWeapons: unlocked };
    this._syncMineralHud();
    this._refreshHudText();
  }

  /** The options offered by the open (or most recent) mini-boss reward. */
  getMiniBossRewardOptions(): ChoiceOption[] {
    return [...this.miniBossRewardOptions];
  }

  /** Whether the mini-boss reward overlay is open. */
  isMiniBossRewardOpen(): boolean {
    return this.miniBossRewardOpen;
  }

  /** The weapons this run has unlocked through mini-boss rewards. */
  getUnlockedWeapons(): WeaponId[] {
    return [...this.miniBossUnlockState.unlockedWeapons];
  }

  /**
   * Fires the end-of-run victory treatment at the moment the boss dies
   * (parent AH-0MUTV7632000ZWCB AC1/AC6; extended by
   * AH-0MUWZ5HCV0034H44): the dedicated fanfare plays once, the shared
   * `spawnVictoryJuice` celebration is spawned at `(x, y)`, and the sustained
   * `spawnVictoryFireworks` sequence explodes around the same boss-death
   * anchor for {@link ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS}. The celebration
   * then continues on `GameOverScene`, so the in-run transition waits
   * {@link VICTORY_TRANSITION_HOLD_MS} for the display to play.
   *
   * @param x — boss death X (the firework anchor).
   * @param y — boss death Y.
   */
  private _triggerVictoryCelebration(x: number, y: number): void {
    playVictoryFanfareSound();
    spawnVictoryJuice(this, { registry: this.victoryEffects, x, y });
    spawnVictoryFireworks(this, x, y, {
      registry: this.victoryEffects,
      depth: VICTORY_FIREWORK_DEPTH,
    });
  }

  /**
   * Transitions to `GameOverScene` for a won run after the short victory
   * hold, so the in-run celebration is visible before the screen changes.
   * A zero hold transitions immediately (keeps timing tests deterministic).
   */
  private _finishRunWithPurpose(won: boolean): void {
    if (!won || VICTORY_TRANSITION_HOLD_MS <= 0) {
      this._finishRun(won);
      return;
    }
    this.time.delayedCall(VICTORY_TRANSITION_HOLD_MS, () =>
      this._finishRun(won),
    );
  }

  // ── Player input & fire ─────────────────────────────────────────

  /**
   * Demo/attract-mode bot input (AC2). With demo mode on, the shared input
   * seam consumes the human-like governed decision over a fresh read-only
   * snapshot of this scene's live state instead of the keyboard. Off (the
   * default) → null, and the keyboard path is used unchanged (AC4).
   */
  protected override getBotInput(): ControlInput | null {
    if (!this.demoMode) return null;
    return this.botGovernor.current();
  }

  /**
   * Applies the persisted bot-tuning configuration to the demo brain and
   * governor (AH-0MV6MFDYG001E6PL).
   *
   * The Bot Tuning gym (`GymBotTuning`) edits and persists these values; when
   * a demo run starts (and when demo mode is re-enabled mid-session) this
   * rebuilds `botBrain`/`botGovernor` from the currently-selected config so
   * **Watch Demo** — and the gameplay recording tools that drive it — fly the
   * tuned bot. The reconstruction mirrors `GymBotTuning._applyTuning()`
   * exactly (same `toCompetentOverrides`/`toHumanOverrides` mapping), keeping
   * gym↔game parity. Outside demo mode the bot seam is inert, so human
   * sessions never consult the store. The store is corrupt-safe: absent or
   * invalid persisted data falls back to the built-in `Default`, which
   * numerically equals the constructor defaults, so behaviour is unchanged
   * when nothing has been saved.
   */
  private _applyBotTuning(): void {
    if (!this.demoMode) return;
    const config = getCurrentBotTuningConfig();
    this.appliedBotTuningName = config.name;
    const values = coerceTuningValues(config.values);
    this.botBrain = createCompetentBotBrain({ tunables: toCompetentOverrides(values) });
    this.botGovernor = new BotInputGovernor(toHumanOverrides(values));
  }

  /**
   * Name of the persisted bot-tuning configuration the demo bot is currently
   * flying with, or `null` outside demo mode (AH-0MV6MFDYG001E6PL).
   */
  getBotTuningConfigName(): string | null {
    return this.appliedBotTuningName;
  }

  /** The live demo bot governor (test/telemetry seam, AH-0MV6MFDYG001E6PL). */
  getBotGovernor(): BotInputGovernor {
    return this.botGovernor;
  }

  /**
   * Samples the pure bot decision and feeds it to the human-like input
   * governor (AH-0MUXXQ1MN002RXGB). Called once per tick, before the shared
   * player-control step reads the seam, so the committed input the governor
   * holds is what the ship flies with.
   */
  private _advanceDemoBot(dt: number): void {
    if (!this.demoMode) return;
    const player = this.getPlayer();
    const movement = player?.getMovementState();
    const rotation = player?.getRotationConfig();
    this.botGovernor.update(
      this.botBrain.decide(buildBotSnapshot(this), dt),
      dt,
      {
        scheme: player?.getScheme() ?? 'asteroids',
        facing: movement?.facing ?? 0,
        // Inertia-aware turn release (AH-0MV1DUSM2005HL98 · AC1): the bot
        // needs the ship's live spin and rotation config to predict the
        // heading it will coast to once the turn input is released.
        angularVelocity: movement?.angularVelocity ?? 0,
        rotationSpeed: rotation?.rotationSpeed,
        rotationAcceleration: rotation?.rotationAcceleration,
        rotationDeceleration: rotation?.rotationDeceleration,
        // Respect the player's reverse-thruster configuration: when the
        // player switched it off, the demo bot emits `reverse: false` on
        // every input (AH-0MV1J0OHP0072XA5 · AC4).
        reverseEnabled: player?.isReverseEnabled() ?? true,
      },
    );
  }

  /**
   * Plays the per-weapon shoot cue when a weapon fires — the hook for
   * the shared {@link CombatScene._autoFire}.
   */
  protected override onWeaponFired(weaponId: WeaponId): void {
    this._playShootCue(weaponId);
  }

  /** Plays the shoot cue for one firing weapon (one per shot, keyed off id). */
  private _playShootCue(weaponId: WeaponId): void {
    // Shared player-fire path: the metronomic hold-full ghost fire and live
    // fire play the same cue through the same switch (AH-0MV55O9R5005W6J0).
    playWeaponFireSound(weaponId);
  }

  /**
   * Spawns an enemy bullet at (x, y) travelling at (vx, vy) px/s.
   * Used by tests (and the boss integration) to place bullets
   * deterministically without relying on entity fire timers.
   *
   * @param lifetime - Bullet lifetime in seconds (default 1.5 s).
   */
  spawnEnemyBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0xff4444,
    lifetime = 1.5,
  ): PlayEnemyBullet {
    const graphics = this.add.graphics();
    graphics.fillStyle(color, 1);
    graphics.fillCircle(0, 0, 4);
    graphics.setPosition(x, y);
    const bullet: PlayEnemyBullet = { graphics, vx, vy, lifetime, elapsed: 0 };
    this.enemyBullets.push(bullet);
    return bullet;
  }

  // ── Enemy fire ──────────────────────────────────────────────────

  /** Collects any bullets fired by the formation this frame. */
  private _collectEnemyFire(): void {
    // Live aim tracking: push the live player position into every alive
    // aimed enemy BEFORE this frame's fire is collected — single-sourced with
    // the gyms through the shared helper (AH-0MV5SDNI2008RWQ2).
    pushAimTargets(
      this.spawned.filter((s) => s.entity.alive).map((s) => s.entity),
      this.player,
    );
    for (const s of this.spawned) {
      if (!s.entity.alive) continue;
      // Shared archetype→tryFire dispatch, driven by the scene clock
      // (AH-0MUII3BBW000XZ46): no local switch, so a new enemy is wired once.
      this.enemyBullets.push(
        ...fireForEnemy<PlayEnemyBullet>(
          s.entity,
          s.enemyKey,
          this.time.now,
        ),
      );
    }
  }

  // ── Bullet lifecycles ───────────────────────────────────────────

  private _advanceBullets(dt: number): void {
    // Shared projectile lifecycle: enemy bullets wrap at all four edges and
    // expire by lifetime; player bullets advance through the same shared
    // `advanceAndCull` path every scene uses (AH-0MUII3CF00024EDM, gap 3).
    // Chrono Field (AH-0MVH80ZJ7009W18Z) scales the enemy-bullet time step
    // while its window is active; player bullets are never slowed.
    const enemyDt =
      dt * this.effectsRegistry.enemyBulletTimeScale();
    advanceWrappingBullets(this.enemyBullets, enemyDt, GAME_WIDTH, GAME_HEIGHT);
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);
  }

  // ── Collisions ──────────────────────────────────────────────────

  /**
   * Plays the enemy's destruction audio, preferring the entity's
   * `playDestructionAudio()` seam (e.g. Diver → playDiverDestructionSound,
   * Boss → playBossDestructionSound) and falling back to the shared
   * `playDestructionSound()` otherwise (mirrors GymFormationScene).
   */
  private _playEnemyDestruction(entity: EnemyEntity): void {
    if (entity.playDestructionAudio) {
      entity.playDestructionAudio();
    } else {
      playDestructionSound();
    }
  }

  // ── Shared collision hooks ──────────────────────────────────────

  /** Live enemy entities for the shared collision pass. */
  protected override getEnemyEntities(): readonly EnemyEntity[] {
    return this.spawned.map((s) => s.entity);
  }

  /** Replaces the enemy-bullet collection after a shared collision pass. */
  protected override setEnemyBullets(bullets: PlayEnemyBullet[]): void {
    this.enemyBullets = bullets;
  }

  /** Enemy destroyed by a player bullet: award score and advance waves. */
  protected override onEnemyDestroyed(enemy: EnemyEntity): void {
    const s = this.spawned.find((candidate) => candidate.entity === enemy);
    if (s) this._onEnemyKilled(s);
  }

  /**
   * Player bullet hits the boss: consume the bullet and damage a phase
   * (the multi-hit boss is not handled by the generic enemy loop).
   */
  protected override onPlayerBulletHitsBoss(pb: PlayerBullet): boolean {
    if (this._playerBulletHitsEntity(pb, this.boss)) {
      if (pb.aoeWeapon) {
        // An `'onImpact'` AOE projectile detonates instead of dealing a direct
        // phase hit; the blast damages the boss through `onAoeHitsBoss`.
        this.detonateAoeProjectile(pb);
      } else {
        // Frenzy amplifies each bullet into `1 + bonus` phase hits
        // (AH-0MVH80ZJ7009W18Z); the damage path stops once the boss dies.
        for (let hit = 0; hit <= this.effectsRegistry.frenzyBonusHits(); hit += 1) {
          this._damageBoss(pb.x, pb.y);
        }
      }
      pb.destroy();
      return true;
    }
    // Mini-boss encounter (the final boss is not spawned at the same time).
    if (this._playerBulletHitsEntity(pb, this.miniBoss)) {
      if (pb.aoeWeapon) {
        this.detonateAoeProjectile(pb);
      } else {
        for (let hit = 0; hit <= this.effectsRegistry.frenzyBonusHits(); hit += 1) {
          this._damageMiniBoss(pb.x, pb.y);
        }
      }
      pb.destroy();
      return true;
    }
    return false;
  }

  /** Whether a player bullet overlaps a live multi-hit boss-style entity. */
  private _playerBulletHitsEntity(
    pb: PlayerBullet,
    entity: Boss | MiniBoss | null,
  ): boolean {
    return Boolean(
      entity?.alive &&
        this._overlaps(
          pb.x, pb.y, PLAYER_BULLET_RADIUS,
          entity.x, entity.y, entity.getHitRadius(),
        ),
    );
  }

  /**
   * AOE effect hits the boss (final boss or mini-boss): routes through the
   * same damage path a player bullet uses, so multi-phase pacing, phase scores
   * and minion summons are identical (parent AH-0MUOOB3OR001V8CD AC5).
   */
  protected override onAoeHitsBoss(
    x: number,
    y: number,
    radius: number,
  ): boolean {
    if (this._aoeHitsEntity(x, y, radius, this.boss)) {
      for (let hit = 0; hit <= this.effectsRegistry.frenzyBonusHits(); hit += 1) {
        this._damageBoss(x, y);
      }
      return true;
    }
    if (this._aoeHitsEntity(x, y, radius, this.miniBoss)) {
      for (let hit = 0; hit <= this.effectsRegistry.frenzyBonusHits(); hit += 1) {
        this._damageMiniBoss(x, y);
      }
      return true;
    }
    return false;
  }

  /** Whether an AOE effect overlaps a live multi-hit boss-style entity. */
  private _aoeHitsEntity(
    x: number,
    y: number,
    radius: number,
    entity: Boss | MiniBoss | null,
  ): boolean {
    return Boolean(
      entity?.alive &&
        this._overlaps(x, y, radius, entity.x, entity.y, entity.getHitRadius()),
    );
  }

  /** Ramming an enemy destroys it but awards no score. */
  protected override onPlayerRamsEnemy(enemy: EnemyEntity): void {
    const s = this.spawned.find((candidate) => candidate.entity === enemy);
    if (!s) return;
    enemy.destroySelf();
    this._playEnemyDestruction(enemy);
    this._onEnemyKilled(s, false);
  }

  /** Ramming the active boss-style encounter only costs the player a life. */
  protected override onPlayerRamsBoss(): boolean {
    if (!this.player) return false;
    const playerHull = SHIP_SIZE / 2;
    for (const entity of [this.boss, this.miniBoss]) {
      if (!entity?.alive) continue;
      if (
        this._overlaps(
          this.player.x, this.player.y, playerHull,
          entity.x, entity.y, entity.getHitRadius(),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Mineral collection/absorption runs between the shared collision passes. */
  protected override onAfterBulletVsBullet(): void {
    this._handleMinerals();
  }

  /**
   * Minerals (GDD §4.5): the player collects them; non-asteroid enemies
   * absorb them. Neither contact causes damage, and bullets pass straight
   * through (no mineral bullet pass exists).
   */
  private _handleMinerals(transitioning = false): void {
    if (!this.player) return;
    // Non-blocking hazards absorb no minerals (GDD §4.5): asteroids and lane
    // traffic are inert, so they are excluded from the absorber list.
    const absorbers = this.spawned
      .filter((s) => !isNonBlockingHazard(s.enemyKey))
      .map((s) => s.entity);
    // Shared collection/absorption routine — the same code the gyms run
    // (AH-0MUII3DHM008L7JF, gap 5). While phased the player collects nothing
    // (Q7); enemy absorption still runs. The between-waves transition is a
    // non-combat breather, so it bypasses the phase gate — an automatic
    // defensive Phase Shift activation at wave-clear must not cost earned minerals
    // (AH-0MUX96GJF006CAZP, AC2).
    this.minerals = collectMinerals(
      this.minerals,
      this.player,
      absorbers,
      () => this._collectMineral(),
      { playerPhased: this.isPlayerPhased() && !transitioning },
    );
  }

  /**
   * Handles an enemy's destruction: awards score, splits asteroids,
   * rolls a power-up drop, and advances the wave/level state machine.
   *
   * @param awardScore — false for collision kills (no points for ramming).
   */
  private _onEnemyKilled(s: SpawnedEnemy, awardScore = true): void {
    if (s.enemyKey === 'asteroid') {
      // Asteroids: only the small tier awards points (50). Large and
      // medium asteroids award none (GDD §4.5 — E6 Asteroid).
      if (awardScore && (s.entity as Asteroid).getSizeTier() === 'small') {
        this.gameState.addScore(SCORE_VALUES.asteroid ?? DEFAULT_SCORE_VALUE);
      }
      // A destroyed large/medium asteroid splits into two smaller rocks
      // that continue the wave (wave-child accounting via WaveManager).
      this._splitAsteroid(s);
    } else if (awardScore) {
      this.gameState.addScore(SCORE_VALUES[s.enemyKey] ?? DEFAULT_SCORE_VALUE);
    }
    this.runTelemetry.enemyKilled(s.enemyKey, s.entity.x, s.entity.y);
    this._maybeDropPowerUp(s.entity.x, s.entity.y);
    // Extra Life kill reward (AH-0MV6M2M9P0078N4S): a fully destroyed small
    // asteroid additionally rolls the configurable Extra Life drop. The
    // shared rule tier-gates first, so large/medium rocks (which split) and
    // non-asteroid enemies never consume an RNG draw here. Additive to the
    // generic pool above — asteroids stay in the weighted drop pool. The
    // chance scales by the same ratio as the per-kill power-up chance, so
    // the supply falls with the campaign level (AH-0MVLJF5P0005KF8X).
    const level = this._resolveDropLevel();
    if (
      rollAsteroidExtraLife(
        s.entity as unknown as AsteroidKillDropEntity,
        this.rng,
        extraLifeDropChance(level, this.rules),
      )
    ) {
      this.spawnPowerUpDrop('extra_life', s.entity.x, s.entity.y);
    }
    // Mineral drops (GDD §4.5): the shared kill-drop rule decides — a small
    // asteroid leaves one mineral at the site, large/medium asteroids do not
    // (their small split children do), and a non-asteroid enemy re-drops a
    // fraction of the minerals it absorbed while alive.
    this.minerals.push(
      ...resolveMineralKillDrops(this, s.entity, this.rng),
    );
    // Salvage (AH-0MVH80ZJ7009W18Z): an active bounty adds extra minerals at
    // the wreck of a destroyed enemy ship (hazards excluded — they are not
    // bounty targets). The shared seam renders them orange so the payout is
    // visible against ordinary gold drops (AH-0MVJ72I8O0009T09).
    const salvageBonus = this.effectsRegistry.salvageBonusMinerals();
    if (salvageBonus > 0 && !isNonBlockingHazard(s.enemyKey)) {
      this.minerals.push(
        ...scatterSalvageMineralDrops(
          this,
          s.entity.x,
          s.entity.y,
          salvageBonus,
          this.rng,
        ),
      );
    }
    // Non-blocking hazards (asteroids, lane traffic) are not wave-accounted
    // (AH-0MUJM746P000QAEO, AH-0MV01EPM40008N8T): destroying one must not
    // advance the wave. Only non-hazard enemy ships drive wave/level/boss
    // progression.
    if (!isNonBlockingHazard(s.enemyKey)) this._advanceAfterKill();
  }

  /**
   * Splits a destroyed large/medium asteroid into exactly two smaller
   * children moving in directions different from the parent and from each
   * other. Children are NOT registered with the WaveManager
   * (AH-0MUJM746P000QAEO), so the split does not affect wave accounting; the
   * children persist and remain shootable.
   */
  private _splitAsteroid(s: SpawnedEnemy): void {
    const parent = s.entity as Asteroid;
    // Shared asteroid-split helper (gap 8): the same spawn code the gyms
    // consume. Split children are not wave-accounted (AH-0MUJM746P000QAEO).
    splitAsteroid({
      scene: this,
      parent,
      rng: this.rng,
      register: (child) => {
        this.spawned.push({
          entity: child,
          enemyKey: 'asteroid',
          startX: 0,
          startY: 0,
          spacingX: 0,
          spacingY: 0,
        });
      },
    });
  }

  /**
   * Shield-absorb cue for the shared gating path (`CombatScene` owns the
   * consume + invulnerability semantics): the game pops the bubble with its
   * destruction sound. The hit is absorbed — no life lost.
   */
  protected override onShieldAbsorbed(): void {
    this.runTelemetry.playerHitAbsorbed();
    playDestructionSound();
  }

  /** Unabsorbed hit: run the standard lose-life / respawn flow. */
  protected override onPlayerHit(): void {
    this._loseLife();
  }

  /**
   * Costs one life using the standard penalty flow (respawn with
   * invulnerability, or the normal game-over flow at 0 lives). Shield
   * absorption is NOT applied here — callers opt in via `_hitPlayer`;
   * the wave time-limit penalty always costs exactly one life
   * (AH-0MU7JTG9R002ZWA6).
   *
   * When the ship actually explodes, the composed player-death juice plays
   * with `'fatal'` severity for a run-ending death (final life) and
   * `'respawn'` otherwise. The wave-timeout penalty (`explodeShip === false`)
   * keeps the existing lighter generic cue and spawns no juice VFX.
   *
   * @param explodeShip — whether to play the ship explosion VFX.
   */
  private _loseLife(explodeShip = true): void {
    if (!this.player) return;

    this.playerHitCount += 1;
    this.gameState.loseLife();
    this.runTelemetry.playerHit(this.gameState.lives);
    // Push the authoritative run-state lives into the HUD's registry so the
    // lives counter updates immediately (GDD §4.5 display).
    this.effectsRegistry.setLives(this.gameState.lives);
    this.hud?.refresh();

    if (explodeShip) {
      // Run-ending death (final life) reads heavier than a mid-run respawn.
      const severity = this.gameState.lives <= 0 ? 'fatal' : 'respawn';
      // Spawn the juice before the game-over transition so the 'fatal'
      // effect still fires even though _finishRun starts GameOverScene.
      spawnPlayerDeathJuice(this, this.player.x, this.player.y, severity, {
        registry: this.playerDeathEffects,
      });
    } else {
      // Wave-timeout penalty: lighter generic cue only, no juice VFX.
      playDestructionSound();
    }

    if (this.gameState.lives <= 0) {
      this.runTelemetry.playerDeath();
      this._finishRun(false);
      return;
    }

    this.tweens.add({
      targets: this.player,
      scale: PLAYER_HIT_SCALE_PEAK,
      duration: PLAYER_HIT_SCALE_PULSE_DURATION / 2,
      yoyo: true,
      ease: 'Power2',
    });
    this.player.respawnInPlace();
    this._startInvulnerability();
  }

  // ── Power-up visuals (Shield shield bubble, Phase Shift phase ghost) ──────────

  /**
   * Updates effect visuals each tick: the Shield shield bubble is drawn around
   * the ship while shielded (shared helper — continuously pulsing rim +
   * low-alpha fill, radius SHIP_SIZE × 1.6, with the shared ending fade in
   * the final second, mirrors GymPowerUpsCombat) and cleared otherwise, and
   * the Phase Shift phase ghost alpha is applied when phased.
   */
  private _updateVisuals(): void {
    // Shield bubble: drawn around the ship while Shield is active (shared helper,
    // including the continuous rim pulse and ending fade).
    if (this.shieldBubble) {
      this.shieldBubbleDrawn = drawShieldBubble(
        this.shieldBubble,
        this.player,
        this.effectsRegistry,
      );
    }
    // Force Field bubble: drawn while the reflect field is active (shared
    // helper — hexagon boundary matches the gameplay reflect radius).
    if (this.forceFieldBubble) {
      drawForceFieldBubble(
        this.forceFieldBubble,
        this.player,
        this.effectsRegistry,
      );
    }
    // Thorn Field aura: a lime spiked halo while the field is armed, scaling
    // with the remaining ram budget and brightening as the next automatic
    // recharge approaches (shared helper — game/gym parity).
    if (this.thornsAura) {
      this.thornsAuraDrawn = drawThornsAura(
        this.thornsAura,
        this.player,
        this.effectsRegistry,
        this.time.now / 1000,
      );
    }
    // Phase ghost: semi-transparent ship while Phase Shift is active (keeps the
    // blink alpha when invulnerable — see AC of AH-0MU8QVC9Y008R8I5).
    applyPhaseGhost(this.player, this.effectsRegistry, this.invulnerable > 0);
    // Bomb notice: advanced by the shared drop layer (`_updateDropLayer`).
  }

  // ── Power-up drops ──────────────────────────────────────────────

  /**
   * Rolls (and possibly spawns) a power-up drop at a kill position.
   *
   * The roll uses the **level-resolved** per-kill drop chance
   * (`powerUpDropChance`, AH-0MVLJF5P0005KF8X): the level is read from the
   * live campaign at kill time, so the supply per enemy falls as the
   * campaign progresses. Level 1 keeps today's flat `POWER_UP_DROP_CHANCE`
   * (0.18) exactly; all per-level values come from the shared module.
   */
  private _maybeDropPowerUp(x: number, y: number): void {
    if (!this.dropSpawner) return;
    if (this.rng() > powerUpDropChance(this._resolveDropLevel(), this.rules)) {
      return;
    }
    this.spawnPowerUpDrop(this.dropSpawner.next(), x, y);
  }

  /**
   * The live campaign level for kill-time drop rolls.
   *
   * Resolved from `WaveManager.currentLevel()?.level` so every drop roll
   * tracks the current campaign level; falls back to level 1 when no level
   * is live (e.g. between transitions), preserving today's level-1 rate.
   */
  private _resolveDropLevel(): number {
    return this.waveManager.currentLevel()?.level ?? 1;
  }

  /**
   * Spawns a drop of `id` at (x, y), nudged to keep the configured minimum
   * separation from every live drop (AH-0MU7JTFM5000R4ME). Returns null
   * when no separated in-bounds position exists (the drop is skipped).
   * Public so tests can place a deterministic drop.
   */
  spawnPowerUpDrop(id: DropId, x: number, y: number): PlayDrop | null {
    const placed = nudgeAwayFromDrops(
      this.drops.map((d) => ({ x: d.x, y: d.y })),
      x,
      y,
      POWER_UP_DROP_MIN_SEPARATION,
      GAME_WIDTH,
      GAME_HEIGHT,
    );
    if (!placed) return null;
    x = placed.x;
    y = placed.y;

    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    if (isWeaponDrop(id)) {
      drawWeaponDrop(graphics, id, 0, 0, POWER_UP_DROP_SIZE);
    } else {
      drawPowerUpDrop(graphics, getPowerUpById(id).id, 0, 0, POWER_UP_DROP_SIZE);
    }
    graphics.setScale(0);

    const drop: PlayDrop = {
      dropId: id,
      powerUp: new PowerUp(isWeaponDrop(id) ? 'shield' : (id as PowerUpId)),
      weaponDropId: isWeaponDrop(id) ? id : undefined,
      x,
      y,
      graphics,
    };
    this.drops.push(drop);
    return drop;
  }

  /**
   * Advances the drop layer through the single shared sequence (gap 4):
   * advance the Bomb notice, apply the Magnet magnet, advance the lifecycle,
   * collect overlaps and advance the absorb VFX. The per-scene spawn
   * *source* (kill chance) stays in `_maybeDropPowerUp` (OQ6).
   */
  private _updateDrops(dt: number): void {
    this.drops = this._updateDropLayer(this.drops, dt);
  }

  /**
   * Game extras after a power-up is collected: the Extra Life extra life (keeping
   * the HUD lives counter aligned with run state). The Bomb bomb is handled
   * by the shared pulse path, not here.
   */
  protected override onPowerUpCollected(drop: PlayDrop): void {
    super.onPowerUpCollected(drop);
    this.runTelemetry.pickup('powerUp', drop.dropId);
    if (drop.dropId === 'extra_life') {
      this.gameState.addLife();
      this.effectsRegistry.setLives(this.gameState.lives);
    }
    // `mystery_ufo` needs no scene-local work: the pickup queues a drone spawn
    // in the shared registry and the shared `_updateDroneSpawning` pass turns
    // it into the visible collector drone (AH-0MV9G113S009B37I).
  }

  /** Weapon pickup hook: records the discrete pickup event (AC3). */
  protected override onWeaponCollected(drop: PlayDrop): void {
    this.runTelemetry.pickup('weapon', drop.weaponDropId ?? drop.dropId);
  }

  // ── Wave time limit (AH-0MU7JTG9R002ZWA6) ────────────────────────

  /** Starts the countdown for the active (regular) wave; hidden for the boss. */
  private _startWaveTimer(): void {
    if (
      this.waveManager.bossTriggered ||
      this.waveManager.bossActive ||
      this.waveManager.bossDefeated ||
      // The mini-boss encounter has no wave time limit (like the final boss):
      // the level only completes when the mini-boss is defeated, so a timeout
      // must never carry the level past an undefeated mini-boss (AC2).
      this.waveManager.miniBossActive
    ) {
      this._hideWaveTimer();
      return;
    }
    this.waveTimer = WAVE_TIME_LIMIT_SECONDS;
    this.waveTimerActive = true;
  }

  /** Stops/hides the wave time-limit (transition pause, boss, expiry). */
  private _hideWaveTimer(): void {
    this.waveTimerActive = false;
    this.waveTimer = 0;
  }

  /** Counts the wave time-limit down; carries survivors over on expiry. */
  private _advanceWaveTimer(dt: number): void {
    if (!this.waveTimerActive) return;
    this.waveTimer = Math.max(0, this.waveTimer - dt);
    if (this.waveTimer <= 0) this._timeoutWave();
  }

  /**
   * Wave time-limit expired — carry-over semantics (AH-0MUNS3ZQ1002DJ9S).
   *
   * No detonation and no life penalty: every surviving non-asteroid enemy
   * persists in place, is adopted into the next wave's alive roster (so the
   * wave only clears once both the fresh spawns **and** the carried-over
   * survivors are destroyed), and continues moving/firing through the 3 s
   * transition pause. Asteroids persist independently and are never adopted
   * (they do not gate wave completion — AH-0MUJM746P000QAEO). If no enemies
   * remain, the timer is simply hidden (AC3).
   *
   * The wave advances via {@link _advanceAfterTimeout}; the survivors are
   * re-registered **after** the advance so the fresh wave's alive count is
   * already set and the adopted survivors are added on top of it.
   *
   * Gym↔game parity: the gyms keep survivors and spawn a fresh formation
   * through the shared `CombatScene._onWaveTimeout` path — the shared
   * detonation helper (`core/waveTimeout.ts`) is now a no-op.
   */
  private _timeoutWave(): void {
    // The mini-boss encounter is not time-limited: a timeout must never carry
    // the level past an undefeated mini-boss (AC2).
    if (this.waveManager.miniBossActive) {
      this._hideWaveTimer();
      return;
    }
    const survivors = this.spawned.filter((s) => s.entity.alive);
    if (survivors.length === 0) {
      // No enemies left to carry over — the penalty does not apply.
      this._hideWaveTimer();
      return;
    }

    // Non-blocking hazards carry over independently and are never
    // wave-accounted; only non-hazard survivors gate the next wave
    // (AH-0MUJM746P000QAEO, AH-0MV01EPM40008N8T).
    const carried = survivors.filter((s) => !isNonBlockingHazard(s.enemyKey));

    // No detonation, no life loss: advance the wave/level, then adopt the
    // surviving non-asteroid enemies so they count toward the next wave's
    // alive target (AH-0MUNS3ZQ1002DJ9S AC1/AC2).
    //
    // Adopt ONLY when the timeout actually advanced the wave/level. A
    // `continue` event means the manager did not transition (it believed the
    // wave was already clear, or the run is in a boss/over state); adopting
    // the survivors then would add phantom enemies to a wave that will never
    // be destroyed — permanently stuck wave accounting (AH-0MVCRBISU006NUN5
    // AC2). The survivors are still alive in that case and stay accounted by
    // whichever wave owns them.
    const event = this._advanceAfterTimeout();
    if (event === 'waveCleared' || event === 'levelCleared') {
      this.waveManager.adoptCarriedSurvivors(carried.length);
    }
  }

  /**
   * Advances the wave/level state machine after a timeout while keeping the
   * survivors alive: replays one destruction per remaining enemy so the
   * manager emits exactly one clear event, then reacts like any other wipe.
   * The caller re-adopts the survivors afterwards so they gate the next wave —
   * but only when the returned event shows the wave/level actually advanced
   * (`waveCleared` / `levelCleared`), never on `continue` (which would add
   * phantom, undestroyable enemies — AH-0MVCRBISU006NUN5 AC2).
   *
   * @returns the {@link WaveEvent} the replay produced.
   */
  private _advanceAfterTimeout(): WaveEvent {
    const wm = this.waveManager;
    let event: WaveEvent = 'continue';
    const defeated = wm.enemiesAlive;
    for (let i = 0; i < defeated; i += 1) event = wm.onEnemyDestroyed();
    switch (event) {
      case 'continue':
        return event;
      case 'waveCleared':
        this.runTelemetry.waveCleared(wm.level, wm.waveNumber);
        this._startTransition();
        return event;
      case 'levelCleared':
        this.runTelemetry.levelCleared(wm.level);
        this._announceLevel();
        this._startTransition();
        return event;
      case 'bossTriggered':
        this.runTelemetry.bossTriggered();
        this.onBossTriggered();
        return event;
      case 'gameComplete':
        return event;
    }
  }

  /**
   * Collision pass used during the wave/level transition pause: player
   * bullets vs carried-over survivors (and the boss) plus ram collisions.
   *
   * Unlike the full {@link _handleCollisions} pass, enemy bullets vs the
   * player remain suspended for the pause — the transition is a breather
   * (AH-0MU7JTF9W008B8HW). Carried-over survivors still move and fire
   * (AH-0MUNS3ZQ1002DJ9S AC3); their shots simply land once the next wave
   * begins. Multi-hit enemies are handled by the shared
   * `onPlayerBulletHitsEnemy` seam.
   */
  private _handleCarriedSurvivorCollisions(): void {
    const playerHull = SHIP_SIZE / 2;

    // 1. Player bullets vs carried-over survivors (and the boss).
    const keptBullets: PlayerBullet[] = [];
    for (const pb of this.playerBullets) {
      let spent = false;
      for (const s of this.spawned) {
        if (!s.entity.alive) continue;
        if (
          this._overlaps(
            pb.x,
            pb.y,
            PLAYER_BULLET_RADIUS,
            s.entity.x,
            s.entity.y,
            s.entity.getHitRadius(),
          )
        ) {
          spent = this.onPlayerBulletHitsEnemy(s.entity, pb);
          if (spent) break;
        }
      }
      if (!spent) spent = this.onPlayerBulletHitsBoss(pb);
      if (!spent) keptBullets.push(pb);
    }
    this.playerBullets = keptBullets;

    if (!this.player || this.effectsRegistry.isPhased) return;

    // 2. Player body vs carried-over survivor body — both are hit.
    if (this.invulnerable <= 0) {
      for (const s of this.spawned) {
        if (!s.entity.alive) continue;
        if (
          this._overlaps(
            this.player.x,
            this.player.y,
            playerHull,
            s.entity.x,
            s.entity.y,
            s.entity.getHitRadius(),
          )
        ) {
          this.onPlayerRamsEnemy(s.entity);
          this._hitPlayer();
          break;
        }
      }
    }
  }

  /** Redraws the horizontal wave time-limit bar (hidden when inactive). */
  private _drawWaveTimer(): void {
    if (!this.waveTimerBar) {
      this.waveTimerBar = this.add.graphics();
      this.waveTimerBar.setDepth(400);
    }
    const g = this.waveTimerBar;
    g.clear();
    if (!this.waveTimerActive) {
      g.setVisible(false);
      return;
    }
    g.setVisible(true);
    // Background track.
    g.fillStyle(0x111111, 0.85);
    g.fillRect(WAVE_TIMER_BAR_X, WAVE_TIMER_BAR_Y, WAVE_TIMER_BAR_WIDTH, WAVE_TIMER_BAR_HEIGHT);
    // Depleting fill.
    const ratio = Math.max(0, Math.min(1, this.waveTimer / WAVE_TIME_LIMIT_SECONDS));
    g.fillStyle(0x00ffff, 1);
    g.fillRect(WAVE_TIMER_BAR_X, WAVE_TIMER_BAR_Y, WAVE_TIMER_BAR_WIDTH * ratio, WAVE_TIMER_BAR_HEIGHT);
  }

  // ── HUD & run end ───────────────────────────────────────────────

  private _refreshHudText(): void {
    this.scoreText?.setText(`Score: ${this.gameState.score}`);
    this.levelText?.setText(this._progressLabel());
  }

  /** Transitions to GameOverScene with the final score. */
  private _finishRun(won: boolean): void {
    // Run end (win/lose) is a discrete telemetry event (AH-0MUY08VVQ007HSSH).
    this.runTelemetry.runEnd(won, this.gameState.score);
    // Dev-gated end-of-run signal (AH-0MUXZ4BXK001QCEK), emitted *before* the
    // scene transition so a demo run that returns to the menu still signals.
    // `window` receives the `aihell:run-ended` CustomEvent and the
    // `window.__aiHellRunState` fallback; `npm run capture` consumes both.
    emitRunEndedSignal(won, this.gameState.score);
    // Dev-gated auto-upload of the accumulated local sink (AH-0MVBMRK6X0069QDI).
    // Fire-and-forget: the flush + POST must never block or crash run end, so
    // the scene transitions below happen regardless of its outcome.
    void this.flushAndUploadDevTelemetry();
    if (this.demoMode) {
      // Non-scoring demo (AC2): start the shared GameOverScene in demo mode so
      // it renders VICTORY/DEFEAT + final score without leaderboard
      // qualification or initials, then auto-returns to the menu after the
      // demo dwell (AH-0MUXZ4CAE008QRFZ). Demo runs never touch the
      // leaderboard, and normal play still reaches the interactive
      // GameOverScene unchanged (AC3).
      this.demoMode = false;
      this._disableDemoTakeOver();
      this.scene.start('GameOverScene', {
        won,
        score: this.gameState.score,
        demo: true,
        demoDwellMs: this.demoDwellMs,
      });
      return;
    }
    this.scene.start('GameOverScene', { won, score: this.gameState.score });
  }

  /**
   * Flushes the recorder's buffered records into the dev JSONL sink, then
   * delivers the run's in-memory buffer to the dev server
   * (AH-0MVBMRK6X0069QDI, AH-0MVIRYGD1000JVY3).
   *
   * Fire-and-forget by contract: the caller uses `void`, every failure is
   * caught here (a dev-server outage must never block or crash run end), and
   * the uploader itself is a no-op outside a dev build or when the
   * share-telemetry setting is off.
   *
   * The uploader is loaded dynamically through the gate module
   * ({@link loadDevTelemetryUploader}): Vite folds the loader's dev check to
   * `false` in a production build, so the dev-only endpoint never ships in
   * the bundle (`npm run check-bundle`, F1 AC4).
   */
  private async flushAndUploadDevTelemetry(): Promise<void> {
    try {
      // Push what the recorder still holds into the sink before reading it.
      await this.runTelemetry.flush();
    } catch (error) {
      reportDevTelemetryFailure(error);
    }
    try {
      const upload = await loadDevTelemetryUploader();
      if (!upload) return;
      await upload({
        setting: loadSettings(),
        // The body is read straight out of the in-memory buffer; telemetry
        // never touches localStorage (AC1).
        readSink: () => this.runTelemetry.readBuffer(),
        onError: reportDevTelemetryFailure,
      });
    } catch (error) {
      // Covers a dynamic-import failure in a dev build; the uploader itself
      // never rejects. Either way run end is unaffected.
      reportDevTelemetryFailure(error);
    }
  }

  // ── Public test / integration accessors ─────────────────────────

  /** The session game state (lives, score, level). */
  getGameState(): GameState {
    return this.gameState;
  }

  /** The wave/level progression manager. */
  getWaveManager(): WaveManager {
    return this.waveManager;
  }

  /** The active-effect registry. */
  getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  /**
   * Mineral field the collector drones (Mystery UFO reward) seek, vacuum and
   * drop into — the game's live field, so the shared drone pass behaves
   * exactly like it does in the gyms (AH-0MV9G113S009B37I).
   */
  protected override getDroneMineralField(): Mineral[] {
    return this.minerals;
  }

  /**
   * Hold sink for a collector drone's ferried minerals: the run hold, with
   * the same HUD sync and hold-full choice every other mineral source uses.
   */
  protected override getDroneMineralSink(): DroneMineralSink {
    return {
      addMinerals: (amount: number) => {
        this.gameState.addMinerals(amount);
        this._syncMineralHud();
        if (this.gameState.isHoldFull()) this.openMineralChoice();
      },
    };
  }

  /** The in-game HUD (lives counter + active effects), or null after teardown. */
  getHUD(): HUD | null {
    return this.hud;
  }

  /** The player ship, or null after teardown. */
  getPlayer(): Player | null {
    return this.player;
  }

  /** Whether the Shield shield bubble was drawn in the last visual update (for tests). */
  isShieldBubbleVisible(): boolean {
    return this.shieldBubbleDrawn;
  }

  /** Whether the Thorn Field aura was drawn in the last visual update (for tests). */
  isThornsAuraVisible(): boolean {
    return this.thornsAuraDrawn;
  }

  /** Whether the Phase Shift phase ghost is currently active (for tests). */
  isPhaseGhostActive(): boolean {
    return this.effectsRegistry.isPhased;
  }

  /**
   * The active multi-hit boss encounter entity: the level's mini-boss while
   * it is active, otherwise the Central AI final boss (null before either
   * spawns). The shared combat core advances/targets whichever is active, so
   * the mini-boss runs the same tick, health bar and teleport avoidance as
   * the final boss.
   */
  getBoss(): Boss | null {
    return this.miniBoss ?? this.boss;
  }

  /** The active level's mini-boss entity, or null outside its encounter. */
  getMiniBoss(): MiniBoss | null {
    return this.miniBoss;
  }

  /**
   * Installs the mini-boss reward-consumer hook (reward feature seam). Fired
   * exactly once per mini-boss defeat, before the level advances (AC3).
   * Pass `null` to remove it.
   */
  setMiniBossRewardHook(hook: MiniBossDefeatHook | null): void {
    this.miniBossRewardHook = hook;
  }

  /**
   * Installs the mini-boss checkpoint-consumer hook (checkpoint feature seam).
   * Fired exactly once per mini-boss defeat, before the level advances (AC3).
   * Pass `null` to remove it.
   */
  setMiniBossCheckpointHook(hook: MiniBossDefeatHook | null): void {
    this.miniBossCheckpointHook = hook;
  }

  /**
   * Number of mini-boss encounters defeated this run (test/telemetry seam;
   * AC3 asserts the defeat hooks fire exactly once per increment).
   */
  getMiniBossDefeatCount(): number {
    return this.miniBossDefeats;
  }

  /** The boss's current health phase (1–4); 0 while no boss is present. */
  getBossPhase(): number {
    const boss = this.getBoss();
    return boss ? boss.getPhaseNumber() : 0;
  }

  /** Live enemies (one per spawned entity, destroyed ones included). */
  getEnemies(): EnemyEntity[] {
    return this.spawned.map((s) => s.entity);
  }

  /** Number of live enemies. */
  getAliveCount(): number {
    return this.spawned.filter((s) => s.entity.alive).length;
  }

  /**
   * The active timed wave's state (AH-0MUXYOV4C008MV0L AC14), read by the
   * demo bot so it can prioritise clearing the wave before the time limit
   * carries survivors over.
   */
  getWaveState(): { active: boolean; timeRemaining: number; timeLimit: number } {
    return {
      active: this.waveTimerActive,
      timeRemaining: this.waveTimer,
      timeLimit: WAVE_TIME_LIMIT_SECONDS,
    };
  }

  /** Player bullets in flight. */
  getPlayerBullets(): PlayerBullet[] {
    return this.playerBullets.slice();
  }

  /** Enemy bullets in flight. */
  getEnemyBullets(): PlayEnemyBullet[] {
    return this.enemyBullets.slice();
  }

  /** Live power-up drops. */
  getDrops(): PlayDrop[] {
    return this.drops.slice();
  }

  /** In-flight absorb animations for collected drops (test seam). */
  getCollectAnimations(): CollectAnimationHandle[] {
    return this.collectAnimations.slice();
  }

  /** True while a wave/level transition is in progress. */
  isTransitioning(): boolean {
    return this.transitionTimer > 0;
  }

  // ── Demo / attract mode (AH-0MUX495VG0014MIY) ───────────────────

  /**
   * Whether this run is the bot-driven demo/attract mode (AC1). Set when the
   * scene is started with `{ demo: true }` (or via `setDemoMode`).
   */
  isDemoMode(): boolean {
    return this.demoMode;
  }

  /**
   * Turns demo mode on/off at runtime. On, the shared input seam consumes the
   * bot decision; off, control returns to the keyboard with no bot input read
   * (AC4/AC7). Used by the menu attract lifecycle and tests.
   */
  setDemoMode(demo: boolean): void {
    this.demoMode = demo;
    if (demo) {
      // Rebuild the brain/governor from the persisted bot-tuning config so a
      // mid-session re-enable flies the saved tuning (AH-0MV6MFDYG001E6PL,
      // AC3).
      this._applyBotTuning();
      // Start the human-like input layer from a clean slate. The demo keeps
      // the ship's configured control scheme (default `asteroids`); the
      // governor resolves the bot's steering intent to it
      // (AH-0MUX2NENC008AHOQ producer review).
      this.botGovernor.seed(this.getRunSeed());
      this.botGovernor.reset();
      this._enableDemoTakeOver();
    } else {
      this.appliedBotTuningName = null;
      this._disableDemoTakeOver();
    }
  }

  /**
   * Wires the press-to-take-over while the demo runs
   * (AH-0MUX4966Z0009P9Q AC3, AH-0MUYP6M6W006Z1AY AC1–AC3, AH-0MUYG8XHI0044MQ1):
   * a **movement key** (an arrow key or a configured movement binding) leaves
   * demo mode **in place** — the run keeps going, only the input source changes
   * from the bot to the player. Any **other** key (including ESC) returns to
   * the main menu, abandoning the demo run without scoring. The pointer stays
   * ignored. Idempotent.
   */
  private _enableDemoTakeOver(): void {
    if (this.demoTakeOverHandler) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if (this._isMovementKey(event)) {
        this.setDemoMode(false); // take over in place
        return;
      }
      // Any non-movement key (ESC, letters, numbers, function keys, etc.)
      // returns to the main menu — clean up the listener before the
      // transition so no stale handler leaks into the menu.
      this._disableDemoTakeOver();
      this.scene.start('MenuScene');
    };
    this.demoTakeOverHandler = handler;
    this.input.keyboard?.on('keydown', handler);
  }

  /**
   * Whether `event` is a deliberate movement key for demo take-over: an arrow
   * key (built-in defaults) or one of the resolved `moveUp`/`moveDown`/
   * `moveLeft`/`moveRight` bindings — the same source normal play uses, so a
   * rebind is honoured (AH-0MUYP6M6W006Z1AY AC2).
   */
  private _isMovementKey(event: KeyboardEvent): boolean {
    const name = this._normaliseKeyName(event.key);
    return (
      name === 'ArrowUp' ||
      name === 'ArrowDown' ||
      name === 'ArrowLeft' ||
      name === 'ArrowRight' ||
      this.movementKeyNames.has(name)
    );
  }

  /**
   * Normalises a DOM `KeyboardEvent.key` to the form stored for bindings:
   * single characters are lower-cased (so Shift + letter matches the
   * binding), named keys are compared verbatim.
   */
  private _normaliseKeyName(key: string): string {
    return key.length === 1 ? key.toLowerCase() : key;
  }

  /**
   * Removes the demo take-over listener. Called on take-over, on return-to-menu
   * and on scene shutdown, so no listener leaks across sessions (AC3/AC4).
   */
  private _disableDemoTakeOver(): void {
    const handler = this.demoTakeOverHandler;
    if (!handler) return;
    this.input.keyboard?.off('keydown', handler);
    this.demoTakeOverHandler = null;
  }

  // ── Pause control (parent AH-0MU9LPZ0G0015292) ──────────────────

  /**
   * Freezes (`true`) or resumes (`false`) the simulation. While paused,
   * `tick()` short-circuits so no subsystem advances: enemies stop
   * moving and firing, projectiles and countdown timers freeze, and the
   * player is frozen and invulnerable. Resuming continues from the exact
   * paused state with no elapsed time counted.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Whether the simulation is currently frozen by the pause menu. */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Runtime ESC handler: toggles the paused state. On the pause edge it
   * hands off to the full-screen `PauseScene` when one is registered
   * (registered by the PauseScene child in `gameConfig.ts`); the hand-off
   * is guarded so it is a harmless no-op before that scene exists.
   */
  togglePause(): void {
    if (this.paused) {
      this.setPaused(false);
      return;
    }
    this.setPaused(true);
    if (this.scene.manager.getScene('PauseScene')) {
      this.scene.pause();
      this.scene.launch('PauseScene', { origin: 'PlayScene' });
    }
  }

  // ── Minerals & the hold-full choice (GDD §4.5) ──────────────────

  /** Live mineral collectables currently on the field (copy). */
  getMinerals(): Mineral[] {
    return [...this.minerals];
  }

  /**
   * Spawns a mineral collectable at (x, y) and registers it on the field.
   * Public so the scene wiring and gym can place minerals deterministically.
   */
  spawnMineralAt(x: number, y: number): Mineral {
    const mineral = new Mineral(this, { x, y });
    this.minerals.push(mineral);
    return mineral;
  }

  /**
   * Spawns an asteroid of the given size tier at (x, y). Asteroids are NOT
   * registered with the WaveManager (AH-0MUJM746P000QAEO): they do not gate
   * wave completion and persist in the field across wave/level transitions.
   * Public so tests and the mineral gym can place asteroids deterministically.
   */
  spawnAsteroidAt(x: number, y: number, sizeTier: AsteroidSizeTier): Asteroid {
    const entity = new Asteroid(this, {
      x,
      y,
      formationOffset: { row: 0, col: 0 },
      sizeTier,
      rng: this.rng,
    });
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: 'asteroid',
      startX: 0,
      startY: 0,
      spacingX: 0,
      spacingY: 0,
    });
    return entity;
  }

  /**
   * Registers an already-constructed enemy in the live simulation (public
   * integration/test seam). Mirrors `GymFormationScene.registerDynamicEntity`
   * so the game and gym can be driven identically by parity tests (F4).
   */
  registerEnemy(entity: EnemyEntity, enemyKey: string): void {
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey,
      startX: entity.x,
      startY: entity.y,
      spacingX: 0,
      spacingY: 0,
    });
  }

  /** Whether the hold-full choice overlay is currently open. */
  isMineralChoiceOpen(): boolean {
    return this.mineralChoiceOpen;
  }

  /** The options currently offered by the hold-full choice (copy). */
  getMineralChoiceOptions(): ChoiceOption[] {
    return [...this.mineralChoiceOptions];
  }

  /** Overrides the pluggable choice strategy (see `powerups/choice`). */
  setMineralChoiceStrategy(strategy: ChoiceStrategy): void {
    this.mineralChoiceStrategy = strategy;
  }

  /**
   * Opens the hold-full power-up choice: draws three distinct options from
   * the strategy and pauses play at the SceneManager level (mirroring
   * `PauseScene`), launching `MineralChoiceScene` when it is registered.
   * Returns the offered options. Idempotent while already open.
   */
  openMineralChoice(): ChoiceOption[] {
    if (this.mineralChoiceOpen) return [...this.mineralChoiceOptions];
    this.mineralChoiceOptions = this.mineralChoiceStrategy.choose(3, this.rng, {
      // Offer level-ups for weapons the player already owns (parent
      // AH-0MUPMPCB2009J54J); an unarmed player falls back to the base pool.
      weaponLevels: this.player?.getWeaponLevels() ?? [],
      // Offer level-ups for power-ups the player already owns (parent
      // AH-0MUV5CLVO002ZHS9); an unowned player falls back to the base pool.
      powerUpLevels: this.player?.getPowerUpLevels() ?? [],
    });
    this.mineralChoiceOpen = true;
    this.runTelemetry.holdFull(this.mineralChoiceOptions.map((o) => o.id));
    this.setPaused(true);
    // Fade the ship's engine hum out across the pause (the ship is idle
    // behind the overlay); it ramps back in on resume (AH-0MV70Y2XY005J2HI).
    this.fadeThrusterHumForHoldFull();
    if (this.scene.manager.getScene('MineralChoiceScene')) {
      this.scene.pause();
      // Pass the exact options (and the active strategy) the overlay must
      // present, so the displayed option is the option applied. Without
      // this the overlay draws its own independent sample and
      // `selectMineralChoice(index)` applies a different option than the
      // label shown (AH-0MUHMXWGC0058BO4 · AC1).
      this.scene.launch('MineralChoiceScene', {
        origin: 'PlayScene',
        options: [...this.mineralChoiceOptions],
        // Frozen player-fire schedule: the active player weapons + beat-grid
        // phase at the moment the overlay opens, so the reduced-volume ghost
        // fire continues on the same grid while paused (AH-0MV55O9R5005W6J0).
        fireSchedule: buildHoldFullFireSchedule(this.player),
        // Demo mode auto-selects after a human-like delay so the bot never
        // stalls on the overlay; normal play waits for a real selection
        // (AH-0MUXXQ1MN002RXGB · AC4/AC5). Below the life cap the bot takes
        // the offered Extra Life instead of the first option
        // (AH-0MV03GXZQ00801T4 · AC1).
        ...(this.demoMode
          ? {
              autoSelectMs: BOT_MINERAL_CHOICE_DELAY_MS,
              autoSelectIndex: this._preferredDemoChoiceIndex(),
            }
          : {}),
        // Single overlay contract (AH-0MUII3DHM008L7JF · AC3): the launcher
        // supplies the selection callback; the overlay never reaches back
        // into `PlayScene` by key.
        onSelect: (index: number) => this.selectMineralChoice(index),
      });
    }
    return [...this.mineralChoiceOptions];
  }

  /**
   * The demo bot's preferred hold-full option index: the offered Extra Life
   * while below the run's life cap, otherwise the first option (the previous
   * behaviour). Only used by the demo auto-select, so normal play is
   * unaffected (AH-0MV03GXZQ00801T4 · AC1).
   */
  private _preferredDemoChoiceIndex(): number {
    if (this.gameState.lives >= MAX_LIVES) return 0;
    const index = this.mineralChoiceOptions.findIndex(
      (option) => option.id === EXTRA_LIFE_DROP_ID,
    );
    return index >= 0 ? index : 0;
  }

  /**
   * Resolves the hold-full choice: applies the chosen option to the player
   * permanently for the run, resumes play, and resets the hold to 0 carrying
   * any overflow (store = collected − capacity). Returns the chosen option,
   * or null for an out-of-range index.
   */
  selectMineralChoice(index: number): ChoiceOption | null {
    // The mini-boss reward reuses the overlay; route its selection through
    // the reward resolver (no hold reset — a reward is not a hold-full drop).
    if (this.miniBossRewardOpen) return this.selectMiniBossReward(index);
    const option = this.mineralChoiceOptions[index];
    if (!option) return null;
    this.runTelemetry.choiceSelected(index, option.id);
    this._applyChoicePermanently(option);
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.gameState.resolveHold();
    this._syncMineralHud();
    // Re-base the frozen beat clock across the overlay + countdown pause so
    // the ship's real fire resumes phase-locked on the grid the metronome
    // ghosted (AH-0MV55OAQT004NMSN · AC3).
    const overlay = this.scene.manager.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene | null;
    this.rebaseBeatClockForHoldFullResume(overlay?.getOverlayElapsedMs() ?? 0);
    this.setPaused(false);
    // Resume the SceneManager-level pause that accompanied the overlay.
    if (this.scene.manager.getScene('MineralChoiceScene')) {
      this.scene.resume();
    }
    return option;
  }

  /** Applies a chosen option permanently for the current run. */
  private _applyChoicePermanently(option: ChoiceOption): void {
    // Shared reward application — the same code the gyms run, so a choice
    // grants the same effect in every scene (AH-0MUII3DHM008L7JF · AC4).
    applyMineralChoiceReward(option, this.effectsRegistry, this.player);
  }

  /** Collects a mineral: adds it to the hold and opens the choice when full. */
  private _collectMineral(): void {
    this.gameState.addMinerals(loadRules().mineralCollectAmount);
    this.runTelemetry.mineralCollected(this.gameState.minerals);
    this._syncMineralHud();
    if (this.gameState.isHoldFull()) this.openMineralChoice();
  }

  /** Mirrors the GameState hold onto the HUD mineral hold bar. */
  private _syncMineralHud(): void {
    this.hud?.setMineralStore(
      this.gameState.minerals,
      this.gameState.mineralCapacity,
    );
  }

  /** Whether the wave time-limit is currently counting down. */
  isWaveTimerActive(): boolean {
    return this.waveTimerActive;
  }

  /** Seconds remaining on the wave time-limit (0 when inactive). */
  getWaveTimerRemaining(): number {
    return this.waveTimer;
  }

  /** The rendered wave time-limit bar, or null before the first draw. */
  getWaveTimerBar(): Phaser.GameObjects.Graphics | null {
    return this.waveTimerBar;
  }

  /** Sets the wave time-limit remaining (tuning/test seam). */
  setWaveTimerRemaining(seconds: number): void {
    this.waveTimer = Math.max(0, seconds);
    this.waveTimerActive = this.waveTimer > 0;
  }

  /** True while the level/wave announcement banner is on screen. */
  isBannerVisible(): boolean {
    return this.bannerText?.visible ?? false;
  }

  /**
   * The persistent level/wave progress readout text, e.g.
   * `Level 1 of 10, Wave 1 of 2` (or `Boss` during the boss encounter).
   */
  getLevelText(): string {
    return this.levelText?.text ?? '';
  }

  /** Current banner text (empty string when no banner has been shown yet). */
  getBannerText(): string {
    return this.bannerText?.text ?? '';
  }

  /**
   * The banner's background CSS colour (empty string before it is shown).
   * Exposed so the semi-transparent background can be pinned by tests
   * (AH-0MV8BQ75V005QNZ1).
   */
  getBannerBackgroundColor(): string {
    return this.bannerText?.style.backgroundColor ?? '';
  }

  /**
   * Seconds left before the banner auto-hides (0 when it is hidden). Exposed
   * so tests can pin the transient window without depending on how much of
   * it the boot already consumed (AH-0MV8BQ75V005QNZ1).
   */
  getBannerTimeRemaining(): number {
    return this.bannerTimer;
  }

  /** Seconds remaining on the transition pause (0 when not transitioning). */
  getTransitionRemaining(): number {
    return this.transitionTimer;
  }

  /** Number of times the player has been hit. */
  getHitCount(): number {
    return this.playerHitCount;
  }

  /** Active composed player-death juice effects (empty once torn down). */
  getPlayerDeathEffects(): Phaser.GameObjects.GameObject[] {
    return this.playerDeathEffects.slice();
  }

  /**
   * The live in-run victory celebration display objects (shared
   * `spawnVictoryJuice` layers). Shrinks as each tween completes and is
   * emptied on SHUTDOWN. Exposed for victory-trigger / teardown tests.
   */
  getVictoryEffects(): Phaser.GameObjects.GameObject[] {
    return this.victoryEffects;
  }

  /** True while the player is invulnerable after a hit. */
  isPlayerInvulnerable(): boolean {
    return this.invulnerable > 0;
  }

  /**
   * Injects an RNG for deterministic drop rolls (tests).
   *
   * Also shared with the shared core's random-AOE seam. Because it is an
   * explicit injection, `create()` will not overwrite it with a
   * seed-derived stream, so the injected sequence is preserved across a
   * restart.
   */
  setRng(rng: () => number): void {
    this.rng = rng;
    this.sceneRng = rng;
    this.rngInjected = true;
    const rules = loadRules();
    this.dropSpawner = this._buildDefaultDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      rng,
    );
  }

  /**
   * Injects the per-run seed (tests / headless runner seam). It is read at
   * the next `create()`; when never injected, `create()` generates a fresh
   * random seed so production runs differ from one another.
   */
  setRunSeed(seed: number): void {
    this.injectedRunSeed = normaliseSeed(seed);
  }

  /**
   * The seed driving every gameplay RNG draw for the current run
   * (AH-0MUY08V6W001SJJN). Assigned by {@link _initRunSeed} at scene start,
   * so it is always a valid 32-bit integer once the scene has been created.
   */
  getRunSeed(): number {
    return this.runSeed;
  }

  /**
   * The ship's current life count (satisfied for the bot snapshot builder,
   * AH-0MV03GXZQ00801T4).
   */
  getLives(): number {
    return this.gameState.lives;
  }

  /**
   * The run's life cap (from the existing run state, AH-0MV03GXZQ00801T4 ·
   * AC3). The bot reads this rather than hard-coding a cap of its own.
   */
  getLivesCap(): number {
    return MAX_LIVES;
  }

  /**
   * Injects a telemetry recorder (test/headless seam,
   * AH-0MUY08VVQ007HSSH). The next `create()` uses it in place of the
   * environment-configured recorder, letting a test capture a run's records
   * without enabling telemetry for the whole suite.
   */
  setTelemetryRecorder(recorder: TelemetryRecorder): void {
    this.injectedTelemetryRecorder = recorder;
  }

  /** Whether live run recording is enabled (test/inspection seam). */
  isTelemetryEnabled(): boolean {
    return this.runTelemetry.enabled;
  }

  /**
   * Installs the instrumentation for this run: the injected recorder when one
   * was supplied via {@link setTelemetryRecorder}, else one built from the
   * environment config (disabled by default). Writes the run header (seed +
   * build) and the `run_start` event.
   */
  private _initTelemetry(): void {
    // The persisted settings carry the dev share-telemetry flag; the dev gate
    // is applied once, inside `resolveEffectiveTelemetryConfig` (see
    // `src/telemetry/devMode.ts`), so a stock dev session records from run
    // start (AH-0MVBMRIB800201KK).
    const settings = loadSettings();
    const recorder =
      this.injectedTelemetryRecorder ??
      createTelemetryRecorder(
        resolveEffectiveTelemetryConfig(
          import.meta.env,
          loadTelemetryConsent(),
          settings,
        ),
        { build: resolveBuildInfo() },
      );
    this.runTelemetry = new RunTelemetry(recorder);
    // Dev-only page accessor over the run's in-memory buffer: the dev CLI
    // tooling (`npm run record` / `capture` / `verify-dev-telemetry`) reads
    // the run from here instead of the retired localStorage sink
    // (AH-0MVIRYGD1000JVY3, AC5). The installer is dev-gated, so a production
    // bundle never writes the global.
    installDevTelemetryBuffer(() => this.runTelemetry.readBuffer());
    this.runTelemetry.startRun(this.getRunSeed());
  }

  /**
   * Records the per-tick state vector + the input actually applied
   * (AH-0MUY08VVQ007HSSH, AC1/AC2/AC4). When telemetry is disabled this is a
   * single boolean check — no snapshot is built and nothing is serialised
   * (AC5). `player.getInput()` is the input the shared player step applied, so
   * bot and human alike are captured through one seam (AC4).
   */
  private _recordTelemetryTick(): void {
    if (!this.runTelemetry.enabled) return;
    const player = this.player;
    this.runTelemetry.recordTick(
      buildRunTelemetryState(buildBotSnapshot(this), this._telemetryExtras()),
      serialiseTelemetryInput(player?.getInput() ?? null),
    );
  }

  /** The non-snapshot run state the tick vector carries (AC1). */
  private _telemetryExtras(): RunTelemetryExtras {
    const player = this.player;
    const explosions = getExplosionVfxCounts();
    return {
      heading: player?.getHeading() ?? 0,
      lives: this.gameState.lives,
      invulnerable: this.invulnerable > 0,
      minerals: this.gameState.minerals,
      mineralCapacity: this.gameState.mineralCapacity,
      weaponLevels: player?.getWeaponLevels() ?? [],
      powerUpLevels: player?.getPowerUpLevels() ?? [],
      enemyExplosions: explosions.enemy,
      bossExplosions: explosions.boss,
      playerExplosions: explosions.player,
    };
  }

  /**
   * Resolves and installs the run's RNG stream. Called once at the top of
   * `create()` before any gameplay draw:
   *
   * 1. seed = explicit {@link setRunSeed} value, else a fresh
   *    {@link randomSeed};
   * 2. unless an RNG was injected via {@link setRng}, install a
   *    {@link createSeededRng} stream for that seed (also wiring the shared
   *    core AOE seam);
   * 3. mirror the seed onto `GameState` for telemetry.
   */
  private _initRunSeed(): void {
    const seed = this.injectedRunSeed ?? this._devRunSeed() ?? randomSeed();
    this.runSeed = seed;
    if (!this.rngInjected) {
      this.rng = createSeededRng(seed);
      this.sceneRng = this.rng;
    }
    this.gameState.runSeed = seed;
  }

  /**
   * The deterministic run seed a dev build requested through the `seed` URL
   * query parameter, or `null` (AH-0MUY08W7Y004GATZ). Dev-gated so a
   * production build ignores the parameter entirely and always draws a fresh
   * random seed.
   */
  private _devRunSeed(): number | null {
    if (!isDevScenarioEnabled() || typeof window === 'undefined') return null;
    return resolveDevSeed(window.location?.search ?? '');
  }

  /**
   * Enables or disables random offscreen asteroid spawning (default enabled).
   * Disabling immediately drops any pending plan and clears the released
   * counter; re-enabling takes effect from the next `spawnWave()`. A tuning
   * and test seam mirroring `setRng` / `setWaveTimerRemaining`.
   */
  setAsteroidSpawnerEnabled(enabled: boolean): void {
    this.asteroidSpawnerEnabled = enabled;
    if (!enabled) this.asteroidHazard.reset();
  }

  /**
   * Enables/disables the ghost-pursuer plan independently of the wave
   * `ghosts: true` opt-in (classic-arcade archetype, AH-0MV01EH2U008XT3Q).
   * Disabling immediately drops any pending plan and clears the released
   * counter; re-enabling takes effect from the next `spawnWave()`. Tuning and
   * test seam mirroring `setAsteroidSpawnerEnabled`.
   */
  setGhostSpawnerEnabled(enabled: boolean): void {
    this.ghostSpawnerEnabled = enabled;
    if (!enabled) {
      this.pendingGhostSpawns = [];
      this.ghostsSpawnedThisWave = 0;
    }
  }

  /**
   * Enables/disables the Centipede plan independently of the wave
   * `centipede: true` opt-in (classic-arcade archetype, AH-0MV01EJ92008ZZ86).
   * Disabling immediately drops any pending plan; re-enabling takes effect
   * from the next `spawnWave()`. Tuning and test seam mirroring
   * `setGhostSpawnerEnabled`.
   */
  setCentipedeSpawnerEnabled(enabled: boolean): void {
    this.centipedeSpawnerEnabled = enabled;
    if (!enabled) {
      this.pendingCentipedeSpawn = null;
      this.centipedeSpawnedThisWave = false;
    }
  }

  /**
   * Enables/disables the Robotron homing-horde plan independently of the wave
   * `horde: true` opt-in (classic-arcade archetype, AH-0MV01EKTL001NRE6).
   * Disabling immediately drops any pending plan and clears the released
   * counter; re-enabling takes effect from the next `spawnWave()`. Tuning and
   * test seam mirroring `setCentipedeSpawnerEnabled`.
   */
  setHordeSpawnerEnabled(enabled: boolean): void {
    this.hordeSpawnerEnabled = enabled;
    if (!enabled) {
      this.pendingHordeSpawns = [];
      this.hordeSpawnedThisWave = 0;
    }
  }

  /**
   * Enables/disables the telegraphed orbital-strike plan (Missile Command
   * archetype, AH-0MV01ENX00055CG1). Disabling immediately drops any pending
   * plan and clears the released counter; re-enabling takes effect from the
   * next `spawnWave()`. Tuning and test seam mirroring
   * `setHordeSpawnerEnabled`.
   */
  setOrbitalStrikeSpawnerEnabled(enabled: boolean): void {
    this.orbitalStrikeSpawnerEnabled = enabled;
    if (!enabled) {
      this.pendingStrikeSpawns = [];
      this.strikesSpawnedThisWave = 0;
    }
  }

  /**
   * Enables/disables the Frogger lane-traffic plan (classic-arcade archetype,
   * AH-0MV01EPM40008N8T). Disabling immediately drops any pending plan and
   * clears the released counter; re-enabling takes effect from the next
   * `spawnWave()`. Tuning and test seam mirroring `setHordeSpawnerEnabled`.
   */
  setLaneTrafficSpawnerEnabled(enabled: boolean): void {
    this.laneTrafficSpawnerEnabled = enabled;
    if (!enabled) {
      this.pendingLaneTrafficSpawns = [];
      this.laneTrafficSpawnedThisWave = 0;
    }
  }
}

/**
 * Reports a dev-mode telemetry failure without ever propagating it: the
 * recorder flush and the end-of-run upload are fire-and-forget, so a failing
 * dev server must not affect the game (AH-0MVBMRK6X0069QDI).
 */
function reportDevTelemetryFailure(error: unknown): void {
  console.warn('[telemetry] dev upload skipped after an error:', error);
}

/** Re-exported so consumers need not import from `core/rules` directly. */
export { DEFAULT_RULES };

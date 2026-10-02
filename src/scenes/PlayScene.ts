/**
 * Playable game scene (GDD §3 — Level structure, §4 — Boss).
 *
 * Owns the playable run: the `WaveManager` drives Level 1–5 progression
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
 * **Shared power-up drop layer:** the drop lifecycle, collection gate, P9
 * magnet, P4 bomb notice and per-type pickup cues are inherited from the
 * shared drop layer (`src/scenes/core/dropLayer.ts`, `BombNotice.ts`); this
 * scene supplies only the kill-chance spawn *source* (AH-0MUII3CXX0023H24,
 * gap 4).
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
import { GameState } from '../core/GameState';
import { DEFAULT_RULES, loadRules, type GameRules } from '../core/rules';
import {
  playArcFireSound,
  playCannonFireSound,
  playDestructionSound,
  playDualFireSound,
  playMortarFireSound,
  playNovaFireSound,
  playRapidFireSound,
  playSpawnSound,
  playSpreadFireSound,
} from '../audio/effects';
import { Player } from '../entities/Player';
import { PlayerBullet } from '../entities/PlayerBullet';
import { createEnemyFromConfig, type EnemyEntity } from '../entities/enemyFactory';
import {
  computeFormationReanchorDelta,
  type FormationReanchorRequest,
} from '../utils/formations';
import { FormationGlide } from './core/formationGlide';
import { fireForEnemy } from '../entities/enemyFire';
import { Asteroid } from '../entities/Asteroid';
import type { AsteroidSizeTier } from '../entities/Asteroid';
import { Mineral } from '../entities/Mineral';
import { spawnPlayerDeathJuice } from '../vfx/playerDeathJuice';
import { EffectsRegistry } from '../powerups/effects';
import {
  randomChoiceStrategy,
  type ChoiceOption,
  type ChoiceStrategy,
} from '../powerups/choice';
import { PowerUp } from '../powerups/PowerUp';
import { getPowerUpById, isWeaponDrop, type DropId, type PowerUpId } from '../powerups/types';
import { drawPowerUpDrop, drawWeaponDrop } from '../powerups/icons';
import { nudgeAwayFromDrops } from '../powerups/placement';
import {
  type CollectAnimationHandle,
} from '../powerups/collectAnimation';
import { type PowerUpSpawner } from '../powerups/spawner';
import { BombNotice } from './core/BombNotice';
import { HUD } from '../ui/HUD';
import { type WeaponId } from '../utils/weapons';
import type { WasdKeysLike } from '../utils/input';
import { loadEnemyConfig } from '../core/enemyConfig';
import {
  DEFAULT_BINDINGS,
  keyFor,
  loadSettings,
  resolveBindings,
  type ActionName,
} from '../core/settingsStore';
import { resolveKeyCode } from '../utils/keys';
import { WaveManager, type EnemySpawn, type WaveEvent } from '../waves/WaveManager';
import { LEVELS, type LevelDefinition } from '../waves/Formations';
import { buildSequencedLevels } from '../waves/sequencedLevels';
import { computeSpawns, type SpawnEvent } from '../waves/AsteroidSpawner';
import {
  computeHarvesterSpawns,
  type HarvesterSpawnEvent,
} from '../waves/HarvesterSpawner';
import { Boss } from '../entities/Boss';
import { planMinionSpawns } from '../waves/BossMinions';
import {
  CombatScene,
} from './core/CombatScene';
import {
  advancePlayerBullets,
  advanceWrappingBullets,
} from './core/bulletLifecycle';
import { resolveMineralKillDrops } from './core/mineralKillDrops';
import { splitAsteroid } from './core/asteroidSplit';
import {
  applyMineralChoiceReward,
  collectMinerals,
} from './core/mineralLayer';
import {
  applyPhaseGhost,
  drawShieldBubble,
} from './core/CombatEffectVisuals';
import {
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
 * hides automatically (GDD §3 — transient transitions). Must be within
 * the ~1.5–2 s window required by AH-0MU7JTEMC006QPSN.
 */
export const BANNER_DURATION_SECONDS = 1.5;

/** Rightward formation drift speed (px/s). */
const FORMATION_DRIFT_SPEED = 28;

/** Formation drift bounds (px offset from each group's start). */
const FORMATION_DRIFT_RANGE = GAME_WIDTH * 0.5;

/** Chance a destroyed enemy drops a power-up (GDD §4.4, ~15–20 %). */
export const POWER_UP_DROP_CHANCE = 0.18;

/** Neon-cyan level/score text colour. */
const HUD_TEXT_COLOR = '#00ffff';

/** Level-transition banner style. */
const BANNER_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '34px',
  color: '#ffffff',
  backgroundColor: '#000000',
  padding: { x: 20, y: 12 },
};

/**
 * Resolve the campaign the run should play (AH-0MUITS1SM008GPR9).
 *
 * With the opt-in `sequencedWavesEnabled` toggle off (the default) the static
 * `LEVELS` campaign is returned unchanged. With it on, the campaign is
 * generated from the difficulty-curve config; if generation throws or yields
 * nothing the static campaign is used instead, so the game always boots into
 * a playable campaign.
 *
 * Pass a `build` that closes over the run seed (AH-0MUJSUQD8003FSUT) so
 * `dynamic` waves are regenerated per run while staying reproducible for a
 * given seed; the default build is seed-free.
 *
 * Exported so the toggle/fallback decision can be unit-tested without
 * booting a Phaser scene; `PlayScene.create()` calls it with the live rules.
 */
export function resolveCampaignLevels(
  rules: Pick<GameRules, 'sequencedWavesEnabled'> = loadRules(),
  build: () => LevelDefinition[] = () => buildSequencedLevels(),
): LevelDefinition[] {
  if (!rules.sequencedWavesEnabled) return LEVELS;
  try {
    const generated = build();
    return generated.length > 0 ? generated : LEVELS;
  } catch {
    return LEVELS;
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
 * The playable game scene — manages the 5 levels + boss encounter.
 */
export class PlayScene extends CombatScene<
  EnemyEntity,
  PlayEnemyBullet,
  PlayDrop
> {
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

  /** The Central AI boss, spawned after Level 5 (null until then). */
  private boss: Boss | null = null;

  /** Resolved DOM key name that toggles pause (from the bindings). */
  private pauseKeyName = 'Escape';

  /** Shield bubble (P3) — drawn around the ship while shielded, cleared on absorb. */
  private shieldBubble: Phaser.GameObjects.Graphics | null = null;
  /** Whether the bubble was actually drawn in the last visual update. */
  private shieldBubbleDrawn = false;
  /** P4 Bomb notice — shared component (gap 4), hidden until collected. */
  private bombNotice: BombNotice | null = null;

  private driftX = 0;
  private driftDir = 1;
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
   * Explicit run seed for `dynamic` wave regeneration (test seam). When null
   * (the default) a seed is derived once per run from the scene RNG, so each
   * run differs while remaining reproducible for a seeded RNG.
   */
  private runSeed: number | null = null;

  /**
   * Asteroid spawn events planned for the active wave (empty outside a
   * regular wave). Computed once per wave by `planAsteroidSpawns()` so the
   * scene rng stream is only advanced at wave boundaries.
   */
  private pendingAsteroidSpawns: SpawnEvent[] = [];

  /**
   * Planned Harvester spawns for the active regular wave (Levels 4–5 only),
   * computed once per wave by `planHarvesterSpawns()`. Each released spawn is
   * registered with the WaveManager (they gate wave completion — unlike
   * asteroids).
   */
  private pendingHarvesterSpawns: HarvesterSpawnEvent[] = [];
  /** Number of planned Harvester spawns already released this wave. */
  private harvestersSpawnedThisWave = 0;

  /** How many of the planned asteroid spawns have been released this wave. */
  private asteroidsSpawnedThisWave = 0;

  constructor() {
    super('PlayScene');
    this.gameState = new GameState({ gameState: 'playing' });
    this.waveManager = new WaveManager();
    this.effectsRegistry = new EffectsRegistry();
  }

  // ── Scene lifecycle ─────────────────────────────────────────────

  create(): void {
    // Reset any state carried over from a previous session (restarts reuse
    // the same scene instance — never leak stale enemies/bullets/timers).
    this.resetRunState();

    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // Player ship (auto-fire, weapons, effects).
    this.player = new Player(this, { x: GAME_WIDTH / 2, y: GAME_HEIGHT - 80 });
    this.add.existing(this.player);
    this.cursors = this.input.keyboard?.createCursorKeys();
    // Movement / layer-drop / pause keys come from `ai_hell_settings`
    // (parent AH-0MU9LPZ0G0015292); arrow keys remain built-in defaults.
    this._applyBindings();
    // P7 Teleport keeps its ↓ fallback key (JustDown semantics, mirrors the gyms).
    this.downKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN) ?? null;
    // P3 Shield bubble — rendered above gameplay (below the HUD).
    this.shieldBubble = this.add.graphics();
    this.shieldBubble.setDepth(50);
    // P4 Bomb notice — shared component (gap 4), hidden until collected.
    this.bombNotice = new BombNotice(this);

    // HUD (lives counter + active effects).
    this.hud = new HUD(this, this.effectsRegistry, { showLives: true });

    this._buildHudText();

    // ESC toggles the pause menu (parent AH-0MU9LPZ0G0015292). Registered
    // here because the keyboard plugin is torn down on scene shutdown, so
    // there is no cross-session listener leak.
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.key === this.pauseKeyName && !event.repeat) this.togglePause();
    });

    // Power-up drop pool.
    const rules = loadRules();
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
    // Campaign source: static `LEVELS` by default, generated when the
    // opt-in toggle is enabled (AH-0MUH6LEYY0054E63). Only override the
    // manager's levels when enabled so an injected campaign (tests, future
    // callers) is left untouched — preserving shipped behaviour. Never
    // throws: `resolveCampaignLevels` falls back to `LEVELS`. The run seed
    // (AH-0MUJSUQD8003FSUT) is threaded in so `dynamic` waves regenerate per
    // run while staying reproducible for a given seed.
    if (rules.sequencedWavesEnabled) {
      const seed = this._resolveRunSeed();
      this.waveManager.setLevels(
        resolveCampaignLevels(rules, () =>
          buildSequencedLevels(undefined, undefined, { seed }),
        ),
      );
    }
    this.waveManager.beginGame();
    // The campaign labels need the started WaveManager (level/wave counts).
    this._refreshHudText();
    this.spawnWave();
    this._announceLevel();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());
    // A rebind made in SettingsScene must take effect when the player
    // returns to the paused game (parent AH-0MU9LPZ0G0015292).
    this.events.on(Phaser.Scenes.Events.RESUME, () => this._applyBindings());
  }

  /**
   * Reads the persisted `ai_hell_settings` bindings and creates the Phaser
   * keys for movement, layer-drop/teleport and the pause toggle. Arrow keys
   * remain always-available movement defaults. Called on create and again
   * on RESUME so a rebind takes effect immediately on return to the game.
   */
  private _applyBindings(): void {
    const bindings = resolveBindings(loadSettings().bindings);
    this.pauseKeyName = keyFor(bindings, 'pauseToggle');

    const kb = this.input.keyboard;
    if (!kb) {
      this.wasd = undefined;
      this.teleportKey = null;
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
    this.teleportKey = keyForAction('layerDrop');
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
    this.spawned = [];
    this.enemyBullets = [];
    this.drops = [];
    this.minerals = [];
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.boss = null;
    this.driftX = 0;
    this.driftDir = 1;
    this.diverAnchorX = 0;
    this.diverAnchorY = 0;
    this.transitionTimer = 0;
    this.bannerTimer = 0;
    this.waveTimer = 0;
    this.waveTimerActive = false;
    this.pendingAsteroidSpawns = [];
    this.asteroidsSpawnedThisWave = 0;
    this.pendingHarvesterSpawns = [];
    this.harvestersSpawnedThisWave = 0;
    this.shieldBubbleDrawn = false;
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
    this.bombNotice?.destroy();
    this.bombNotice = null;
    this.hud?.destroy();
    this.hud = null;
    this.player?.destroy();
    this.player = null;
    this.boss?.destroy();
    this.boss = null;
    this.bannerText?.destroy();
    this.bannerText = null;
    this.waveTimerBar?.destroy();
    this.waveTimerBar = null;

    // Clear glide state so a stop/restart starts fresh (AH-0MUL15N63003PUDB).
    this.glide.clear();
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
      this._updateTransitionBanner();
      // Carried-over survivors stay active through the transition pause
      // (AH-0MUNS3ZQ1002DJ9S AC3): they keep their formation drift / their own
      // motion, keep firing, and remain shootable/hitable. `_moveEnemies`
      // handles both formation enemies and asteroids. Enemy bullets vs the
      // player stay suspended for the pause (AH-0MU7JTF9W008B8HW grace), so a
      // timed-out wave still gives the player the transition breather.
      this._moveEnemies(dt);
      this._collectEnemyFire();
      this._handleCarriedSurvivorCollisions();
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
    // P7 Teleport (S/↓ JustDown) runs first so the warp position is
    // consumed by this frame's physics.
    this._handleTeleport();
    // Shared player-control step (timers → multipliers → input → physics →
    // auto-fire) — identical in every scene (AH-0MUII39KX007YUQ0, AC1).
    this._tickPlayer(dt);

    this._advanceBullets(dt);
    if (!transitioning) {
      // Automatic Phase Shift (P6): feed live danger before collision gating
      // so a trigger this frame protects this frame (parent AH-0MUIYX1EE008FVS8).
      this._updatePhaseShiftAutoTrigger(dt);
      this._handleCollisions();
      // Release any asteroid spawns whose planned time has passed — before
      // the timer advances so a wave-timeout cannot release the whole plan.
      this._releaseDueAsteroidSpawns();
      // Release any planned Harvester spawns (Levels 4–5 only) whose time
      // has passed; each is registered with the WaveManager so wave-clear
      // accounting stays correct (F6).
      this._releaseDueHarvesterSpawns();
      this._advanceWaveTimer(dt);
    }
    this._updateInvulnerability(dt);
    this._updateVisuals();
    this._updatePhaseShiftJuice(dt);
    this._updateDrops(dt);
    this._refreshHudText();
    this._drawWaveTimer();
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
    // Plan the rare Harvester spawns (Levels 4–5 only; empty elsewhere).
    this.planHarvesterSpawns();
    const spawns = this.waveManager.planSpawns(this.rng);
    if (spawns.length > 0) {
      for (const spawn of spawns) this._spawnEnemy(spawn);
      playSpawnSound();
    }
    this.driftX = 0;
    this.driftDir = 1;
    this.diverAnchorX = 0;
    this.diverAnchorY = 0;
    this._startWaveTimer();
  }

  /** Instantiates one enemy from its spawn descriptor. */
  private _spawnEnemy(spawn: EnemySpawn): void {
    const cfg = loadEnemyConfig(spawn.enemyKey);
    const entity = createEnemyFromConfig(this, cfg, spawn.x, spawn.y, spawn.offset);
    entity.shootEnabled = spawn.shootEnabled;
    this.add.existing(entity);
    this.spawned.push({
      entity,
      enemyKey: spawn.enemyKey,
      startX: spawn.startX,
      startY: spawn.startY,
      spacingX: spawn.spacingX,
      spacingY: spawn.spacingY,
    });
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
      this.pendingAsteroidSpawns = [];
      this.asteroidsSpawnedThisWave = 0;
      return;
    }
    this.pendingAsteroidSpawns = computeSpawns(
      wm.globalWaveIndex,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      this.rng,
    );
    this.asteroidsSpawnedThisWave = 0;
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
    while (this.asteroidsSpawnedThisWave < this.pendingAsteroidSpawns.length) {
      const event = this.pendingAsteroidSpawns[this.asteroidsSpawnedThisWave];
      if (elapsed + 1e-9 < event.timeSeconds) break;
      this._spawnScheduledAsteroid(event);
      this.asteroidsSpawnedThisWave += 1;
    }
  }

  /**
   * Spawns one planned asteroid at its offscreen position with the planned
   * inward velocity. Asteroids are NOT registered with the WaveManager
   * (AH-0MUJM746P000QAEO): they do not gate wave completion, and they persist
   * in the field across wave and level transitions.
   */
  private _spawnScheduledAsteroid(event: SpawnEvent): void {
    const entity = new Asteroid(this, {
      x: event.x,
      y: event.y,
      formationOffset: { row: 0, col: 0 },
      sizeTier: event.sizeTier,
      vx: event.vx,
      vy: event.vy,
      enterFromOffscreen: true,
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
  }

  /**
   * Plans the rare Harvester spawns for the active regular wave. Only
   * Levels 4–5 are eligible; Levels 1–3 and the boss encounter produce no
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

    // Diver re-anchor (GDD §4.1 — E2): if a Diver's attack finished, re-base
    // the whole unit so its slot lands on the attack end. Applied after the
    // drift and before positioning so every enemy uses the new origin in the
    // same frame.
    const reanchorApplied = this._applyFormationReanchor();

    for (const s of this.spawned) {
      if (!s.entity.alive) continue;
      // Asteroids roam independently: constant-velocity straight-line
      // motion with four-edge wrap (never formation drift).
      if (s.enemyKey === 'asteroid') {
        (s.entity as Asteroid).updatePosition(dt);
        continue;
      }
      // Live mineral-seek: push the scene's live mineral field so roaming
      // seekers (Harvester) steer toward the nearest mineral, then advance
      // their own motion. The gym's shared tick calls the same seam (F4).
      if (s.entity.setSeekTargets) {
        s.entity.setSeekTargets(this.minerals);
        s.entity.updatePosition?.(dt);
        continue;
      }
      // Only Divers ride the Diver re-anchor offset; every other enemy uses
      // the drift alone and therefore stays where it is when a Diver
      // re-anchors (AC5, AH-0MUL15N63003PUDB).
      const isDiver = s.entity.consumeFormationReanchor != null;
      s.entity.applyFormationPosition(
        s.startX + this.driftX + (isDiver ? this.diverAnchorX : 0),
        s.startY + (isDiver ? this.diverAnchorY : 0),
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
    const event = this.waveManager.onEnemyDestroyed();
    switch (event) {
      case 'continue':
        return;
      case 'waveCleared':
        this._startTransition();
        return;
      case 'levelCleared':
        this._announceLevel();
        this._startTransition();
        return;
      case 'bossTriggered':
        this.onBossTriggered();
        return;
      case 'gameComplete':
        return;
    }
  }

  /** Begins the brief pause before the next wave/level spawns. */
  private _startTransition(): void {
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
   * (`Level N of 5, Wave M of K`) so no blank label or crash occurs.
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
    this.pendingAsteroidSpawns = [];
    this.asteroidsSpawnedThisWave = 0;
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
    this._hideBanner();
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
   */
  protected spawnBoss(): void {
    this.boss = new Boss(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2 - 80,
      formationOffset: { row: 0, col: 0 },
    });
    this.add.existing(this.boss);
    this._spawnMinions(1);
    // No per-wave time limit applies to the boss encounter.
    this._hideWaveTimer();
  }

  /** Spawns the minion wave for the given boss phase (GDD §4.3). */
  private _spawnMinions(phase: number): void {
    for (const spawn of planMinionSpawns(phase, this.rng)) this._spawnEnemy(spawn);
  }

  /**
   * Handles a player-bullet hit on the boss: consumes a phase, awards
   * the phase score, summons that phase's minions, and completes the run
   * as a victory when the boss dies (GDD §4.5).
   */
  private _damageBoss(): void {
    const boss = this.boss;
    if (!boss || !boss.alive) return;

    const previousPhase = boss.getPhaseNumber();
    const result = boss.takeDamage();
    if (result === 0) {
      // Boss destroyed — award the final phase's points, then win.
      this.gameState.addScore(BOSS_PHASE_SCORES[previousPhase] ?? 0);
      this.waveManager.onBossDefeated();
      this._finishRun(true);
      return;
    }

    // Phase advanced: award the destroyed phase's points (GDD §4.5).
    this.gameState.addScore(BOSS_PHASE_SCORES[previousPhase] ?? 0);
    if (result !== previousPhase) {
      this._spawnMinions(result);
    }
  }

  // ── Player input & fire ─────────────────────────────────────────

  /**
   * Plays the per-weapon shoot cue when a weapon fires — the hook for
   * the shared {@link CombatScene._autoFire}.
   */
  protected override onWeaponFired(weaponId: WeaponId): void {
    this._playShootCue(weaponId);
  }

  /** Plays the shoot cue for one firing weapon (one per shot, keyed off id). */
  private _playShootCue(weaponId: WeaponId): void {
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
    for (const s of this.spawned) {
      if (!s.entity.alive) continue;
      if (this.player) {
        const target = s.entity as unknown as {
          setAimTarget?: (x: number, y: number) => void;
        };
        target.setAimTarget?.(this.player.x, this.player.y);
      }
      // Shared archetype→tryFire dispatch, driven by the scene clock
      // (AH-0MUII3BBW000XZ46): no local switch, so a new enemy is wired once.
      this.enemyBullets.push(
        ...fireForEnemy<PlayEnemyBullet>(s.entity, s.enemyKey, this.time.now),
      );
    }
  }

  // ── Bullet lifecycles ───────────────────────────────────────────

  private _advanceBullets(dt: number): void {
    // Shared projectile lifecycle: enemy bullets wrap at all four edges and
    // expire by lifetime; player bullets advance through the same shared
    // `advanceAndCull` path every scene uses (AH-0MUII3CF00024EDM, gap 3).
    advanceWrappingBullets(this.enemyBullets, dt, GAME_WIDTH, GAME_HEIGHT);
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
    if (
      this.boss?.alive &&
      this._overlaps(
        pb.x, pb.y, PLAYER_BULLET_RADIUS,
        this.boss.x, this.boss.y, this.boss.getHitRadius(),
      )
    ) {
      if (pb.aoeWeapon) {
        // An `'onImpact'` AOE projectile detonates instead of dealing a direct
        // phase hit; the blast damages the boss through `onAoeHitsBoss`.
        this.detonateAoeProjectile(pb);
      } else {
        this._damageBoss();
      }
      pb.destroy();
      return true;
    }
    return false;
  }

  /**
   * AOE effect hits the boss: routes through the same `_damageBoss()` path a
   * player bullet uses, so multi-phase pacing, phase scoring and minion
   * summons are identical (parent AH-0MUOOB3OR001V8CD AC5).
   */
  protected override onAoeHitsBoss(
    x: number,
    y: number,
    radius: number,
  ): boolean {
    if (
      this.boss?.alive &&
      this._overlaps(
        x, y, radius,
        this.boss.x, this.boss.y, this.boss.getHitRadius(),
      )
    ) {
      this._damageBoss();
      return true;
    }
    return false;
  }

  /** Ramming an enemy destroys it but awards no score. */
  protected override onPlayerRamsEnemy(enemy: EnemyEntity): void {
    const s = this.spawned.find((candidate) => candidate.entity === enemy);
    if (!s) return;
    enemy.destroySelf();
    this._playEnemyDestruction(enemy);
    this._onEnemyKilled(s, false);
  }

  /** Ramming the boss only costs the player a life. */
  protected override onPlayerRamsBoss(): boolean {
    if (!this.player || !this.boss?.alive) return false;
    const playerHull = SHIP_SIZE / 2;
    return this._overlaps(
      this.player.x, this.player.y, playerHull,
      this.boss.x, this.boss.y, this.boss.getHitRadius(),
    );
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
  private _handleMinerals(): void {
    if (!this.player) return;
    // Non-asteroid enemies absorb minerals; asteroids are inert (GDD §4.5).
    const absorbers = this.spawned
      .filter((s) => s.enemyKey !== 'asteroid')
      .map((s) => s.entity);
    // Shared collection/absorption routine — the same code the gyms run
    // (AH-0MUII3DHM008L7JF, gap 5). While phased the player collects nothing
    // (Q7); enemy absorption still runs.
    this.minerals = collectMinerals(
      this.minerals,
      this.player,
      absorbers,
      () => this._collectMineral(),
      { playerPhased: this.isPlayerPhased() },
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
    this._maybeDropPowerUp(s.entity.x, s.entity.y);
    // Mineral drops (GDD §4.5): the shared kill-drop rule decides — a small
    // asteroid leaves one mineral at the site, large/medium asteroids do not
    // (their small split children do), and a non-asteroid enemy re-drops a
    // fraction of the minerals it absorbed while alive.
    this.minerals.push(
      ...resolveMineralKillDrops(this, s.entity, this.rng),
    );
    // Asteroids are not wave-accounted (AH-0MUJM746P000QAEO): destroying one
    // must not advance the wave. Only non-asteroid enemy ships drive
    // wave/level/boss progression.
    if (s.enemyKey !== 'asteroid') this._advanceAfterKill();
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

  // ── Power-up visuals (P3 shield bubble, P6 phase ghost) ──────────

  /**
   * Updates effect visuals each tick: the P3 shield bubble is drawn around
   * the ship while shielded (lineStyle + low-alpha fill, radius
   * SHIP_SIZE × 1.6, mirrors GymPowerUpsCombat) and cleared otherwise, and
   * the P6 phase ghost alpha is applied when phased.
   */
  private _updateVisuals(): void {
    // Shield bubble: drawn around the ship while P3 is active (shared helper).
    if (this.shieldBubble) {
      this.shieldBubbleDrawn = drawShieldBubble(
        this.shieldBubble,
        this.player,
        this.effectsRegistry,
      );
    }
    // Phase ghost: semi-transparent ship while P6 is active (keeps the
    // blink alpha when invulnerable — see AC of AH-0MU8QVC9Y008R8I5).
    applyPhaseGhost(this.player, this.effectsRegistry, this.invulnerable > 0);
    // Bomb notice: advanced by the shared drop layer (`_updateDropLayer`).
  }

  // ── Power-up drops ──────────────────────────────────────────────

  /**
   * The scene's P4 bomb notice (shared component, gap 4) — the shared
   * collect path shows it through this accessor (AC3).
   */
  protected override _getBombNotice(): BombNotice | null {
    return this.bombNotice;
  }

  /** Rolls (and possibly spawns) a power-up drop at a kill position. */
  private _maybeDropPowerUp(x: number, y: number): void {
    if (!this.dropSpawner) return;
    if (this.rng() > POWER_UP_DROP_CHANCE) return;
    this.spawnPowerUpDrop(this.dropSpawner.next(), x, y);
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
      drawPowerUpDrop(graphics, getPowerUpById(id).type, 0, 0, POWER_UP_DROP_SIZE);
    }
    graphics.setScale(0);

    const drop: PlayDrop = {
      dropId: id,
      powerUp: new PowerUp(isWeaponDrop(id) ? 'P3' : (id as PowerUpId)),
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
   * advance the P4 notice, apply the P9 magnet, advance the lifecycle,
   * collect overlaps and advance the absorb VFX. The per-scene spawn
   * *source* (kill chance) stays in `_maybeDropPowerUp` (OQ6).
   */
  private _updateDrops(dt: number): void {
    this.drops = this._updateDropLayer(this.drops, dt);
  }

  /**
   * Game extras after a power-up is collected: the shared P4 bomb notice
   * plus the P8 extra life (keeping the HUD lives counter aligned with run
   * state). The base shows the notice through `_getBombNotice()`.
   */
  protected override onPowerUpCollected(drop: PlayDrop): void {
    super.onPowerUpCollected(drop);
    if (drop.dropId === 'P8') {
      this.gameState.addLife();
      this.effectsRegistry.setLives(this.gameState.lives);
    }
  }

  // ── Wave time limit (AH-0MU7JTG9R002ZWA6) ────────────────────────

  /** Starts the countdown for the active (regular) wave; hidden for the boss. */
  private _startWaveTimer(): void {
    if (
      this.waveManager.bossTriggered ||
      this.waveManager.bossActive ||
      this.waveManager.bossDefeated
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
    const survivors = this.spawned.filter((s) => s.entity.alive);
    if (survivors.length === 0) {
      // No enemies left to carry over — the penalty does not apply.
      this._hideWaveTimer();
      return;
    }

    // Asteroids carry over independently and are never wave-accounted; only
    // non-asteroid survivors gate the next wave (AH-0MUJM746P000QAEO).
    const carried = survivors.filter((s) => s.enemyKey !== 'asteroid');

    // No detonation, no life loss: advance the wave/level, then adopt the
    // surviving non-asteroid enemies so they count toward the next wave's
    // alive target (AH-0MUNS3ZQ1002DJ9S AC1/AC2).
    this._advanceAfterTimeout();
    this.waveManager.adoptCarriedSurvivors(carried.length);
  }

  /**
   * Advances the wave/level state machine after a timeout while keeping the
   * survivors alive: replays one destruction per remaining enemy so the
   * manager emits exactly one clear event, then reacts like any other wipe.
   * The caller re-adopts the survivors afterwards so they gate the next wave.
   */
  private _advanceAfterTimeout(): void {
    const wm = this.waveManager;
    let event: WaveEvent = 'continue';
    const defeated = wm.enemiesAlive;
    for (let i = 0; i < defeated; i += 1) event = wm.onEnemyDestroyed();
    switch (event) {
      case 'continue':
        return;
      case 'waveCleared':
        this._startTransition();
        return;
      case 'levelCleared':
        this._announceLevel();
        this._startTransition();
        return;
      case 'bossTriggered':
        this.onBossTriggered();
        return;
      case 'gameComplete':
        return;
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
    this.scene.start('GameOverScene', { won, score: this.gameState.score });
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

  /** The in-game HUD (lives counter + active effects), or null after teardown. */
  getHUD(): HUD | null {
    return this.hud;
  }

  /** The player ship, or null after teardown. */
  getPlayer(): Player | null {
    return this.player;
  }

  /** Whether the P3 shield bubble was drawn in the last visual update (for tests). */
  isShieldBubbleVisible(): boolean {
    return this.shieldBubbleDrawn;
  }

  /** Whether the P4 bomb notice is currently visible (for tests). */
  isBombNoticeVisible(): boolean {
    return this.bombNotice?.isVisible() ?? false;
  }

  /** Whether the P6 phase ghost is currently active (for tests). */
  isPhaseGhostActive(): boolean {
    return this.effectsRegistry.isPhased;
  }

  /** The Central AI boss, or null before it spawns. */
  getBoss(): Boss | null {
    return this.boss;
  }

  /** The boss's current health phase (1–4); 0 while no boss is present. */
  getBossPhase(): number {
    return this.boss ? this.boss.getPhaseNumber() : 0;
  }

  /** Live enemies (one per spawned entity, destroyed ones included). */
  getEnemies(): EnemyEntity[] {
    return this.spawned.map((s) => s.entity);
  }

  /** Number of live enemies. */
  getAliveCount(): number {
    return this.spawned.filter((s) => s.entity.alive).length;
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
    this.mineralChoiceOptions = this.mineralChoiceStrategy.choose(3, this.rng);
    this.mineralChoiceOpen = true;
    this.setPaused(true);
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
        // Single overlay contract (AH-0MUII3DHM008L7JF · AC3): the launcher
        // supplies the selection callback; the overlay never reaches back
        // into `PlayScene` by key.
        onSelect: (index: number) => this.selectMineralChoice(index),
      });
    }
    return [...this.mineralChoiceOptions];
  }

  /**
   * Resolves the hold-full choice: applies the chosen option to the player
   * permanently for the run, resumes play, and resets the hold to 0 carrying
   * any overflow (store = collected − capacity). Returns the chosen option,
   * or null for an out-of-range index.
   */
  selectMineralChoice(index: number): ChoiceOption | null {
    const option = this.mineralChoiceOptions[index];
    if (!option) return null;
    this._applyChoicePermanently(option);
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.gameState.resolveHold();
    this._syncMineralHud();
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
   * `Level 1 of 5, Wave 1 of 2` (or `Boss` during the boss encounter).
   */
  getLevelText(): string {
    return this.levelText?.text ?? '';
  }

  /** Current banner text (empty string when no banner has been shown yet). */
  getBannerText(): string {
    return this.bannerText?.text ?? '';
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

  /** True while the player is invulnerable after a hit. */
  isPlayerInvulnerable(): boolean {
    return this.invulnerable > 0;
  }

  /** Injects an RNG for deterministic drop rolls (tests). */
  setRng(rng: () => number): void {
    this.rng = rng;
    const rules = loadRules();
    this.dropSpawner = this._buildDefaultDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      rng,
    );
  }

  /**
   * Injects the run seed used to regenerate `dynamic` waves (tests). The seed
   * is read at `create()` time; when never injected a seed is derived from the
   * scene RNG so production runs differ from one another.
   */
  setRunSeed(seed: number): void {
    this.runSeed = seed;
  }

  /**
   * The run seed for `dynamic` wave regeneration: an explicit
   * {@link setRunSeed} value when present, otherwise a 32-bit seed derived
   * once from the scene RNG. Deriving only happens when the sequenced-campaign
   * toggle is on, so the static path consumes no RNG values.
   */
  private _resolveRunSeed(): number {
    if (this.runSeed !== null) return this.runSeed;
    return Math.floor(this.rng() * 0x100000000) >>> 0;
  }

  /**
   * Enables or disables random offscreen asteroid spawning (default enabled).
   * Disabling immediately drops any pending plan and clears the released
   * counter; re-enabling takes effect from the next `spawnWave()`. A tuning
   * and test seam mirroring `setRng` / `setWaveTimerRemaining`.
   */
  setAsteroidSpawnerEnabled(enabled: boolean): void {
    this.asteroidSpawnerEnabled = enabled;
    if (!enabled) {
      this.pendingAsteroidSpawns = [];
      this.asteroidsSpawnedThisWave = 0;
    }
  }
}

/** Re-exported so consumers need not import from `core/rules` directly. */
export { DEFAULT_RULES };

/**
 * Playable game scene (GDD §3 — Level structure, §4 — Boss).
 *
 * Owns the playable run: the `WaveManager` drives Level 1–5 progression
 * and the boss trigger; this scene spawns the wave's enemies in their
 * formations, integrates the player ship (auto-fire, weapons, effects),
 * resolves collisions, applies power-up collection, and advances levels
 * automatically when a wave/level is cleared.
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
  PLAYER_BULLET_SPEED,
  PLAYER_HIT_SCALE_PEAK,
  PLAYER_HIT_SCALE_PULSE_DURATION,
  PLAYER_RESPAWN_INVULNERABLE,
  POWER_UP_DROP_MIN_SEPARATION,
  POWER_UP_DROP_SIZE,
  SHIP_COLOR,
  SHIP_SIZE,
} from '../core/constants';
import { GameState } from '../core/GameState';
import {
  DEFAULT_RULES,
  loadRules,
  POWER_UP_WEIGHT_IDS,
  WEAPON_WEIGHT_IDS,
  type PowerUpWeights,
  type WeaponWeights,
} from '../core/rules';
import {
  playCannonFireSound,
  playDestructionSound,
  playDualFireSound,
  playDualPickupSound,
  playExtraLifeCollectSound,
  playMagnetCollectSound,
  playPowerUpCollectSound,
  playRapidFireSound,
  playRapidPickupSound,
  playResetPickupSound,
  playSpawnSound,
  playSpeedBoostCollectSound,
  playSpreadFireSound,
  playSpreadPickupSound,
} from '../audio/effects';
import { Player } from '../entities/Player';
import {
  PlayerBullet,
  advanceAndCull,
  createPlayerBullet,
} from '../entities/PlayerBullet';
import { createEnemyFromConfig, type EnemyEntity } from '../entities/enemyFactory';
import { Asteroid } from '../entities/Asteroid';
import { EffectsRegistry } from '../powerups/effects';
import { PowerUp, PowerUpState } from '../powerups/PowerUp';
import { getPowerUpById, isWeaponDrop, type DropId, type PowerUpId } from '../powerups/types';
import { drawPowerUpDrop, drawWeaponDrop } from '../powerups/icons';
import { nudgeAwayFromDrops } from '../powerups/placement';
import { applyMagnetAttraction } from '../powerups/magnet';
import { WeightedRandomSpawner, type PowerUpSpawner } from '../powerups/spawner';
import {
  findTeleportDestination,
  type TeleportBody,
} from '../powerups/teleport';
import { HUD } from '../ui/HUD';
import { angleToVelocity, createBulletsFromHeading, type WeaponId } from '../utils/weapons';
import {
  AsteroidsInputHandler,
  FourDirectionalInputHandler,
  type ControlInput,
} from '../utils/movementModel';
import type { WasdKeysLike } from '../utils/input';
import { resolvePatterns, spawnExplosionParticles } from '../vfx/explosionParticles';
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
import { Boss } from '../entities/Boss';
import { planMinionSpawns } from '../waves/BossMinions';

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

/**
 * Seconds a regular wave may run before the time-limit penalty triggers
 * (per-wave, resets each wave; tunable — default 30 s per
 * AH-0MU7JTG9R002ZWA6 assumptions).
 */
export const WAVE_TIME_LIMIT_SECONDS = 30;

/** Detonation scale factor applied to survivors on wave-timeout (10x). */
export const WAVE_TIMEOUT_EXPLOSION_SCALE = 10;

/** Wave time-limit bar geometry (top-centre, above the level readout). */
const WAVE_TIMER_BAR_X = GAME_WIDTH * 0.25;
const WAVE_TIMER_BAR_Y = 2;
const WAVE_TIMER_BAR_WIDTH = GAME_WIDTH * 0.5;
const WAVE_TIMER_BAR_HEIGHT = 6;

/** Rightward formation drift speed (px/s). */
const FORMATION_DRIFT_SPEED = 28;

/** Formation drift bounds (px offset from each group's start). */
const FORMATION_DRIFT_RANGE = GAME_WIDTH * 0.5;

/** Chance a destroyed enemy drops a power-up (GDD §4.4, ~15–20 %). */
export const POWER_UP_DROP_CHANCE = 0.18;

/** Blink half-period while invulnerable after a hit (seconds). */
const BLINK_INTERVAL = 0.1;

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
}

/** A live power-up drop on the field. */
interface PlayDrop {
  dropId: DropId;
  powerUp: PowerUp;
  weaponDropId?: string;
  x: number;
  y: number;
  graphics: Phaser.GameObjects.Graphics;
}

/**
 * The playable game scene — manages the 5 levels + boss encounter.
 */
export class PlayScene extends Phaser.Scene {
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
  private playerBullets: PlayerBullet[] = [];
  private drops: PlayDrop[] = [];

  /** The Central AI boss, spawned after Level 5 (null until then). */
  private boss: Boss | null = null;

  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;
  /** P7 Teleport activation keys: S and ↓ (JustDown semantics). */
  private teleportKey: Phaser.Input.Keyboard.Key | null = null;
  private downKey: Phaser.Input.Keyboard.Key | null = null;
  private fourDirHandler = new FourDirectionalInputHandler();
  private asteroidsHandler = new AsteroidsInputHandler();

  /** Resolved DOM key name that toggles pause (from the bindings). */
  private pauseKeyName = 'Escape';

  private hitCount = 0;
  private invulnerable = 0;
  private blinkPhase = 0;
  private playerExplosions: Phaser.GameObjects.Graphics[] = [];
  /** Shield bubble (P3) — drawn around the ship while shielded, cleared on absorb. */
  private shieldBubble: Phaser.GameObjects.Graphics | null = null;
  /** Whether the bubble was actually drawn in the last visual update. */
  private shieldBubbleDrawn = false;
  /** P4 Bomb notice — brief centred 'BOMB!' flash after collection. */
  private bombNoticeLabel: Phaser.GameObjects.Text | null = null;
  private bombNoticeTimer = 0;

  private driftX = 0;
  private driftDir = 1;

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

  /** Rendered wave time-limit bar (top of the screen). */
  private waveTimerBar: Phaser.GameObjects.Graphics | null = null;

  private dropSpawner: PowerUpSpawner<DropId> | null = null;
  private rng: () => number = Math.random;

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
    this._resetRunState();

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
    // P4 Bomb notice — centred flash, hidden until a bomb is collected.
    this.bombNoticeLabel = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#ff4444',
        backgroundColor: '#1a1a1a',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5)
      .setVisible(false);

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
    this.dropSpawner = this._buildDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      this.rng,
    );

    // Start the run.
    this.gameState.startGame();
    this.effectsRegistry.setLives(this.gameState.lives);
    this.waveManager.beginGame();
    // The campaign labels need the started WaveManager (level/wave counts).
    this._refreshHudText();
    this.spawnWave();
    this._announceLevel();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this._teardown());
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

  /** Clears all per-run state so a restarted session starts fresh. */
  private _resetRunState(): void {
    this.spawned = [];
    this.enemyBullets = [];
    this.playerBullets = [];
    this.drops = [];
    this.boss = null;
    this.hitCount = 0;
    this.invulnerable = 0;
    this.blinkPhase = 0;
    this.driftX = 0;
    this.driftDir = 1;
    this.transitionTimer = 0;
    this.bannerTimer = 0;
    this.waveTimer = 0;
    this.waveTimerActive = false;
    this.shieldBubbleDrawn = false;
    this.paused = false;
    this.effectsRegistry.reset();
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

  /** Destroys scene-owned objects on shutdown (no leaks across sessions). */
  private _teardown(): void {
    for (const s of this.spawned) s.entity.destroy(true);
    this.spawned = [];
    for (const b of this.enemyBullets) b.graphics.destroy();
    this.enemyBullets = [];
    for (const b of this.playerBullets) b.destroy();
    this.playerBullets = [];
    for (const d of this.drops) d.graphics.destroy();
    this.drops = [];
    for (const e of this.playerExplosions) e.destroy();
    this.playerExplosions = [];
    this.shieldBubble?.destroy();
    this.shieldBubble = null;
    this.bombNoticeLabel?.destroy();
    this.bombNoticeLabel = null;
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
    // enemy-based collisions are suspended, but the player stays in full
    // control (input, physics and auto-fire) and cannot be hit
    // (AH-0MU7JTF9W008B8HW).
    const transitioning = this.transitionTimer > 0;
    if (transitioning) {
      this.transitionTimer = Math.max(0, this.transitionTimer - dt);
      this._updateTransitionBanner();
      if (this.transitionTimer === 0) this._onTransitionComplete();
    } else {
      this._moveEnemies(dt);
      this._collectEnemyFire();
      this._updateBoss(dt);
    }

    // Player input, thrust and auto-fire run in every phase, including the
    // wave/level transition pause.
    if (this.player) {
      this.player.tickWeaponTimers(dt * 1000);
      // P5 live boost: scale thrust/max-speed each frame (mirror gym).
      this.player.setSpeedMultiplier(this.effectsRegistry.speedMultiplier());
      // P7 Teleport (S/↓ JustDown) — runs before physics so the warp
      // position is consumed by this frame's physics.
      this._handleTeleport();
      const input = this._readPlayerInput();
      if (input) this.player.setInput(input);
      this.player.physicsTick(dt, this.scale.width, this.scale.height);
      this._autoFire(dt);
    }

    this._advanceBullets(dt);
    if (!transitioning) {
      this._handleCollisions();
      this._advanceWaveTimer(dt);
    }
    this._updateInvulnerability(dt);
    this._updateVisuals(dt);
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
    const spawns = this.waveManager.planSpawns();
    if (spawns.length > 0) {
      for (const spawn of spawns) this._spawnEnemy(spawn);
      playSpawnSound();
    }
    this.driftX = 0;
    this.driftDir = 1;
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

  /** Advances formation drift and repositions every live enemy. */
  private _moveEnemies(dt: number): void {
    this.driftX += this.driftDir * FORMATION_DRIFT_SPEED * dt;
    if (this.driftX > FORMATION_DRIFT_RANGE) {
      this.driftX = FORMATION_DRIFT_RANGE;
      this.driftDir = -1;
    } else if (this.driftX < 0) {
      this.driftX = 0;
      this.driftDir = 1;
    }

    for (const s of this.spawned) {
      if (!s.entity.alive) continue;
      // Asteroids roam independently: constant-velocity straight-line
      // motion with four-edge wrap (never formation drift).
      if (s.enemyKey === 'asteroid') {
        (s.entity as Asteroid).updatePosition(dt);
        continue;
      }
      s.entity.applyFormationPosition(
        s.startX + this.driftX,
        s.startY,
        dt,
        s.spacingX,
        s.spacingY,
      );
    }
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
   * readout and the transition banner, e.g. `Level 1 of 5, Wave 1 of 2`.
   * During the boss encounter it collapses to just `Boss` (no numeric
   * level/wave), per AH-0MU7JTEY3004EXR2.
   */
  private _progressLabel(): string {
    const wm = this.waveManager;
    if (wm.bossTriggered || wm.bossActive || wm.bossDefeated) return 'Boss';
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
    this.waveManager.beginBoss();
    this._startTransition();
  }

  /**
   * Called when a wave/level/boss transition ends: spawns the boss when
   * the encounter is due, otherwise spawns the current wave.
   */
  private _onTransitionComplete(): void {
    if (this.waveManager.bossActive && !this.boss) {
      this.spawnBoss();
    } else {
      this.spawnWave();
    }
    this._hideBanner();
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

  /**
   * Advances the Boss state machine: attack telegraphing, bullet
   * collection, and pulse-wave expansion (mirrors GymBoss). Boss bullets
   * are tracked by the scene's enemy-bullet list; pulse waves are managed
   * by the Boss itself.
   */
  private _updateBoss(dt: number): void {
    const boss = this.boss;
    if (!boss || !boss.alive) return;
    if (this.player) boss.setAimTarget(this.player.x, this.player.y);

    const bullets = boss.update(
      this.time.now,
      dt * 1000,
      GAME_WIDTH,
      GAME_HEIGHT,
    );
    for (const bullet of bullets) {
      if (!('isPulseWave' in bullet && bullet.isPulseWave)) {
        this.enemyBullets.push(bullet as unknown as PlayEnemyBullet);
      }
    }
    boss.advancePulseWave(dt, GAME_WIDTH, GAME_HEIGHT);
  }

  /** Spawns the minion wave for the given boss phase (GDD §4.3). */
  private _spawnMinions(phase: number): void {
    for (const spawn of planMinionSpawns(phase)) this._spawnEnemy(spawn);
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

  private _readPlayerInput(): ControlInput | null {
    if (!this.player || !this.cursors || !this.wasd) return null;
    const raw = { cursors: this.cursors, wasd: this.wasd };
    return this.player.getScheme() === 'asteroids'
      ? this.asteroidsHandler.mapInput(raw)
      : this.fourDirHandler.mapInput(raw);
  }

  private _autoFire(dt: number): void {
    if (!this.player) return;
    const fired = this.player.tryFire(dt);
    if (fired.length === 0) return;
    const headingDeg = (this.player.getHeading() * 180) / Math.PI;
    for (const weaponId of fired) {
      // One shoot cue per firing weapon per volley (not per bullet),
      // mirroring GymWeapons._playShootCue. Safe no-op without an
      // AudioContext.
      this._playShootCue(weaponId);
      const def = this.player.getWeaponDef(weaponId);
      for (const bd of createBulletsFromHeading(def, headingDeg, this.player.x, this.player.y)) {
        const vel = angleToVelocity(bd.angleDeg, PLAYER_BULLET_SPEED);
        this.spawnPlayerBullet(bd.x, bd.y, vel.vx, vel.vy, bd.color);
      }
    }
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
    }
  }

  /**
   * Spawns a player bullet at (x, y) travelling at (vx, vy) px/s.
   * Public so tests can place bullets deterministically.
   */
  spawnPlayerBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0x00ffff,
  ): PlayerBullet {
    const bullet = createPlayerBullet(this, x, y, color, PLAYER_BULLET_RADIUS, vx, vy);
    this.playerBullets.push(bullet);
    return bullet;
  }

  /**
   * Spawns an enemy bullet at (x, y) travelling at (vx, vy) px/s.
   * Used by tests (and the boss integration) to place bullets
   * deterministically without relying on entity fire timers.
   */
  spawnEnemyBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0xff4444,
  ): PlayEnemyBullet {
    const graphics = this.add.graphics();
    graphics.fillStyle(color, 1);
    graphics.fillCircle(0, 0, 4);
    graphics.setPosition(x, y);
    const bullet: PlayEnemyBullet = { graphics, vx, vy };
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
      for (const bullet of this._fireFor(s)) this.enemyBullets.push(bullet);
    }
  }

  /** Dispatches to the entity's archetype-specific fire method. */
  private _fireFor(s: SpawnedEnemy): PlayEnemyBullet[] {
    const e = s.entity as unknown as Record<string, unknown>;
    const now = this.time.now;
    const call = (name: string): unknown => {
      const fn = e[name] as ((n: number) => unknown) | undefined;
      return fn ? fn.call(s.entity, now) : undefined;
    };
    switch (s.enemyKey) {
      case 'diver': {
        const b = call('tryFireSpreadBurst');
        return Array.isArray(b) ? (b as PlayEnemyBullet[]) : [];
      }
      case 'tank': {
        const b = call('tryFireRadialBurst');
        return Array.isArray(b) ? (b as PlayEnemyBullet[]) : [];
      }
      case 'phaser': {
        const b = call('tryFireRadialBullets');
        return Array.isArray(b) ? (b as PlayEnemyBullet[]) : [];
      }
      case 'swarm': {
        const b = call('tryFireBurstBullet');
        return b ? [b as PlayEnemyBullet] : [];
      }
      case 'scout':
      default: {
        const b = call('tryFireAimedBullet');
        return b ? [b as PlayEnemyBullet] : [];
      }
    }
  }

  // ── Bullet lifecycles ───────────────────────────────────────────

  private _advanceBullets(dt: number): void {
    for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
      const b = this.enemyBullets[i];
      b.graphics.x += b.vx * dt;
      b.graphics.y += b.vy * dt;
      if (this._offScreen(b.graphics)) {
        b.graphics.destroy();
        this.enemyBullets.splice(i, 1);
      }
    }
    this.playerBullets = this.playerBullets.filter((b) =>
      advanceAndCull(b, dt, this.scale.width, this.scale.height),
    );
  }

  private _offScreen(g: Phaser.GameObjects.Graphics): boolean {
    return g.x < -20 || g.x > GAME_WIDTH + 20 || g.y < -20 || g.y > GAME_HEIGHT + 20;
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

  /** Circle-vs-circle overlap test. */
  private _overlaps(
    ax: number, ay: number, ar: number,
    bx: number, by: number, br: number,
  ): boolean {
    return Math.hypot(ax - bx, ay - by) <= ar + br;
  }

  private _handleCollisions(): void {
    const playerHull = SHIP_SIZE / 2;

    // 1. Player bullets vs enemies (and the boss).
    const keptBullets: PlayerBullet[] = [];
    for (const pb of this.playerBullets) {
      let spent = false;
      for (const s of this.spawned) {
        if (!s.entity.alive) continue;
        if (this._overlaps(pb.x, pb.y, PLAYER_BULLET_RADIUS, s.entity.x, s.entity.y, s.entity.getHitRadius())) {
          s.entity.destroySelf();
          this._playEnemyDestruction(s.entity);
          pb.destroy();
          spent = true;
          this._onEnemyKilled(s);
          break;
        }
      }
      if (!spent && this.boss?.alive && this._overlaps(
        pb.x, pb.y, PLAYER_BULLET_RADIUS, this.boss.x, this.boss.y, this.boss.getHitRadius(),
      )) {
        // Multi-hit boss: consume the bullet and damage a phase.
        pb.destroy();
        spent = true;
        this._damageBoss();
      }
      if (!spent) keptBullets.push(pb);
    }
    this.playerBullets = keptBullets;

    // 2. Player bullets vs enemy bullets — both destroyed.
    const keptEnemy: PlayEnemyBullet[] = [];
    for (const eb of this.enemyBullets) {
      let consumed = false;
      for (let i = 0; i < this.playerBullets.length; i++) {
        const pb = this.playerBullets[i];
        if (this._overlaps(pb.x, pb.y, PLAYER_BULLET_RADIUS, eb.graphics.x, eb.graphics.y, 5)) {
          pb.destroy();
          this.playerBullets.splice(i, 1);
          eb.graphics.destroy();
          consumed = true;
          break;
        }
      }
      if (!consumed) keptEnemy.push(eb);
    }
    this.enemyBullets = keptEnemy;

    if (!this.player || this.effectsRegistry.isPhased) return;

    // 3. Enemy bullets vs player.
    const keptEnemy2: PlayEnemyBullet[] = [];
    for (const eb of this.enemyBullets) {
      if (
        this.invulnerable <= 0 &&
        this._overlaps(eb.graphics.x, eb.graphics.y, 5, this.player.x, this.player.y, playerHull)
      ) {
        this._hitPlayer();
        eb.graphics.destroy();
      } else {
        keptEnemy2.push(eb);
      }
    }
    this.enemyBullets = keptEnemy2;

    // 4. Player body vs enemy body — both are hit. Ramming the boss only
    //    costs the player a life (the boss cannot be killed by collision).
    if (this.invulnerable <= 0) {
      for (const s of this.spawned) {
        if (!s.entity.alive) continue;
        if (this._overlaps(this.player.x, this.player.y, playerHull, s.entity.x, s.entity.y, s.entity.getHitRadius())) {
          s.entity.destroySelf();
          this._playEnemyDestruction(s.entity);
          this._onEnemyKilled(s, false);
          this._hitPlayer();
          break;
        }
      }
      if (
        this.boss?.alive &&
        this._overlaps(this.player.x, this.player.y, playerHull, this.boss.x, this.boss.y, this.boss.getHitRadius())
      ) {
        this._hitPlayer();
      }
    }
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
    this._advanceAfterKill();
  }

  /**
   * Splits a destroyed large/medium asteroid into exactly two smaller
   * children moving in directions different from the parent and from each
   * other. Children are registered with the WaveManager so the wave's
   * alive count tracks them (the wave neither clears early nor stalls).
   */
  private _splitAsteroid(s: SpawnedEnemy): void {
    const parent = s.entity as Asteroid;
    const children = parent.getSplitChildren(parent.x, parent.y);
    if (!children) return; // small tier — clean destruction, no children

    for (const spec of children) {
      const entity = new Asteroid(this, {
        x: spec.x,
        y: spec.y,
        formationOffset: { row: 0, col: 0 },
        sizeTier: spec.sizeTier,
        vx: spec.vx,
        vy: spec.vy,
        rotationSpeed: spec.rotationSpeed,
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
      // Register the dynamic child so `enemiesAlive` stays correct.
      this.waveManager.registerDynamicSpawn(1);
    }
  }

  /**
   * Player hit: absorb with a shield if active, otherwise lose a life and
   * either respawn with invulnerability or end the run.
   */
  private _hitPlayer(): void {
    if (!this.player) return;

    if (this.effectsRegistry.tryAbsorbShield()) {
      // Shield absorbs the hit — no life lost. The bubble pops (P3 removed
      // from the registry) and the player gets a brief invulnerability
      // blink so the absorb is observable (mirrors GymPowerUpsCombat).
      playDestructionSound();
      this._startInvulnerability();
      return;
    }
    this._loseLife();
  }

  /**
   * Costs one life using the standard penalty flow (respawn with
   * invulnerability, or the normal game-over flow at 0 lives). Shield
   * absorption is NOT applied here — callers opt in via `_hitPlayer`;
   * the wave time-limit penalty always costs exactly one life
   * (AH-0MU7JTG9R002ZWA6).
   *
   * @param explodeShip — whether to play the ship explosion VFX.
   */
  private _loseLife(explodeShip = true): void {
    if (!this.player) return;

    this.hitCount += 1;
    this.gameState.loseLife();
    // Push the authoritative run-state lives into the HUD's registry so the
    // lives counter updates immediately (GDD §4.5 display).
    this.effectsRegistry.setLives(this.gameState.lives);
    this.hud?.refresh();
    playDestructionSound();
    if (explodeShip) this._spawnPlayerExplosion(this.player.x, this.player.y);

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

  /** Starts the brief post-hit invulnerability blink (mirrors the gym). */
  private _startInvulnerability(): void {
    if (!this.player) return;
    this.invulnerable = PLAYER_RESPAWN_INVULNERABLE;
    this.blinkPhase = 0;
    this.player.setAlpha(1);
  }

  private _updateInvulnerability(dt: number): void {
    if (!this.player || this.invulnerable <= 0) return;
    this.invulnerable = Math.max(0, this.invulnerable - dt);
    this.blinkPhase += dt;
    const visible = Math.floor(this.blinkPhase / BLINK_INTERVAL) % 2 === 0;
    this.player.setAlpha(visible ? 1 : 0.3);
    if (this.invulnerable <= 0) this.player.setAlpha(1);
  }

  // ── Power-up visuals (P3 shield bubble, P6 phase ghost) ──────────

  /**
   * Updates effect visuals each tick: the P3 shield bubble is drawn around
   * the ship while shielded (lineStyle + low-alpha fill, radius
   * SHIP_SIZE × 1.6, mirrors GymPowerUpsCombat) and cleared otherwise, and
   * the P6 phase ghost alpha is applied when phased.
   */
  private _updateVisuals(dt: number): void {
    // Shield bubble: drawn around the ship while P3 is active.
    if (this.shieldBubble && this.player) {
      this.shieldBubble.clear();
      this.shieldBubbleDrawn = false;
      if (this.effectsRegistry.isShielded) {
        this.shieldBubble.lineStyle(2, 0x3399ff, 0.9);
        this.shieldBubble.strokeCircle(this.player.x, this.player.y, SHIP_SIZE * 1.6);
        this.shieldBubble.fillStyle(0x3399ff, 0.12);
        this.shieldBubble.fillCircle(this.player.x, this.player.y, SHIP_SIZE * 1.6);
        this.shieldBubbleDrawn = true;
      }
    }
    // Phase ghost: semi-transparent ship while P6 is active (keeps the
    // blink alpha when invulnerable — see AC of AH-0MU8QVC9Y008R8I5).
    if (this.player) {
      if (this.effectsRegistry.isPhased) {
        if (this.invulnerable <= 0) this.player.setAlpha(0.45);
      } else if (this.invulnerable <= 0) {
        this.player.setAlpha(1);
      }
    }
    // Bomb notice: brief centred flash after P4 collection.
    if (this.bombNoticeTimer > 0) {
      this.bombNoticeTimer = Math.max(0, this.bombNoticeTimer - dt);
      if (this.bombNoticeTimer <= 0) this.bombNoticeLabel?.setVisible(false);
    }
  }

  private _spawnPlayerExplosion(x: number, y: number): void {
    const handle = spawnExplosionParticles(this, x, y, SHIP_COLOR, SHIP_SIZE, {
      patterns: resolvePatterns('player'),
      registry: this.playerExplosions,
    });
    void handle;
  }

  // ── Power-up drops ──────────────────────────────────────────────

  private _buildDropSpawner(
    powerUpWeights: PowerUpWeights,
    weaponWeights: WeaponWeights,
    rng: () => number,
  ): PowerUpSpawner<DropId> {
    const ids: DropId[] = [...POWER_UP_WEIGHT_IDS, ...WEAPON_WEIGHT_IDS];
    const spawner = new WeightedRandomSpawner<DropId>(ids, rng);
    for (const id of POWER_UP_WEIGHT_IDS) spawner.setWeight(id, powerUpWeights[id]);
    for (const id of WEAPON_WEIGHT_IDS) spawner.setWeight(id, weaponWeights[id]);
    return spawner;
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

  /** Advances drop lifecycles and resolves fly-over collection. */
  private _updateDrops(dt: number): void {
    // ── Magnet attraction (P9) ──────────────────────────────────
    this._applyMagnet(dt);

    const kept: PlayDrop[] = [];
    for (const drop of this.drops) {
      drop.powerUp.advance(dt);
      drop.graphics.setScale(drop.powerUp.currentScale);
      if (drop.powerUp.state === PowerUpState.DESPAWNED) {
        drop.graphics.destroy();
        continue;
      }
      if (this._collectIfOverlapping(drop)) continue;
      kept.push(drop);
    }
    this.drops = kept;
  }

  /** P9: pulls collectible drops within range toward the player ship. */
  private _applyMagnet(dt: number): void {
    if (!this.player) return;
    const stacks = this.effectsRegistry.magnetStacks();
    if (stacks <= 0) return;
    applyMagnetAttraction(this.drops, this.player, stacks, dt);
  }

  /** Collects the drop when it overlaps the player's hull. */
  private _collectIfOverlapping(drop: PlayDrop): boolean {
    if (!this.player) return false;
    if (!drop.powerUp.canCollect()) return false;
    const hull = SHIP_SIZE / 2;
    const radius = POWER_UP_DROP_SIZE * drop.powerUp.currentScale;
    if (!this._overlaps(drop.x, drop.y, radius, this.player.x, this.player.y, hull)) {
      return false;
    }
    this._collectDrop(drop);
    return true;
  }

  private _collectDrop(drop: PlayDrop): void {
    if (drop.weaponDropId) {
      if (drop.weaponDropId === 'reset') {
        this.effectsRegistry.tryResetWeapons();
        this.player?.resetWeapon();
      } else {
        this.effectsRegistry.applyWeapon(drop.weaponDropId as WeaponId);
        this.player?.equipWeapon(drop.weaponDropId as WeaponId);
      }
    } else {
      const effect = drop.powerUp.tryCollect();
      if (!effect) return;
      if (drop.dropId === 'P4') {
        this._clearEnemyBullets();
        this._flashBombNotice();
      }
      this.effectsRegistry.applyCollect(drop.dropId as PowerUpId);
      if (drop.dropId === 'P8') {
        this.gameState.addLife();
        // Keep the HUD lives counter aligned with the run state.
        this.effectsRegistry.setLives(this.gameState.lives);
      }
    }
    drop.graphics.destroy();
    this._playPickupCue(drop);
  }

  /**
   * Plays the per-type pickup activation cue for a collected drop
   * (GDD §7.3 — unique cue per pickup type, distinct from the generic
   * collection chime). Where no dedicated cue exists in the audio module
   * for a type, the generic chime plays as fallback. Safe no-op without
   * an AudioContext (audio is best-effort in headless tests).
   */
  private _playPickupCue(drop: PlayDrop): void {
    try {
      if (drop.weaponDropId) {
        switch (drop.weaponDropId) {
          case 'reset':
            playResetPickupSound();
            break;
          case 'spread':
            playSpreadPickupSound();
            break;
          case 'dual':
            playDualPickupSound();
            break;
          case 'rapid':
            playRapidPickupSound();
            break;
          default:
            playPowerUpCollectSound();
        }
        return;
      }
      switch (drop.dropId) {
        case 'P5':
          playSpeedBoostCollectSound();
          break;
        case 'P8':
          playExtraLifeCollectSound();
          break;
        case 'P9':
          playMagnetCollectSound();
          break;
        default:
          // P3 shield, P4 bomb, P6 phase, P7 teleport have no dedicated
          // cue in the audio module yet — generic chime fallback.
          playPowerUpCollectSound();
      }
    } catch {
      // Audio is best-effort in headless tests.
    }
  }

  private _clearEnemyBullets(): void {
    for (const b of this.enemyBullets) b.graphics.destroy();
    this.enemyBullets = [];
  }

  /** Shows the brief centred 'BOMB! Bullets cleared' notice (mirrors the gym). */
  private _flashBombNotice(): void {
    this.bombNoticeTimer = 1.2;
    this.bombNoticeLabel?.setText('BOMB! Bullets cleared').setVisible(true);
  }

  // ── Teleport (P7, S/↓) ──────────────────────────────────────────

  /** Handles the S / ↓ key press for a P7 teleport (JustDown semantics). */
  private _handleTeleport(): void {
    if (!this.player || !this.teleportKey) return;
    const JustDown = (
      Phaser.Input.Keyboard as unknown as {
        JustDown?: (key: Phaser.Input.Keyboard.Key) => boolean;
      }
    ).JustDown;
    const sDown = JustDown
      ? JustDown(this.teleportKey)
      : this.teleportKey.isDown;
    const downDown = this.downKey
      ? JustDown
        ? JustDown(this.downKey)
        : this.downKey.isDown
      : false;
    if (sDown || downDown) this.triggerTeleport();
  }

  /**
   * Consumes one P7 teleport stack and warps the player to the nearest
   * safe spot along the heading (granting P6 on arrival via the
   * registry). Public so tests can trigger it deterministically without
   * faking keyboard state. Returns true when a teleport was performed.
   */
  triggerTeleport(): boolean {
    if (!this.player) return false;
    if (!this.effectsRegistry.hasTeleport()) return false;

    const heading = this.player.getHeading();
    const enemies: TeleportBody[] = this.spawned
      .filter((s) => s.entity.alive)
      .map((s) => ({
        x: s.entity.x,
        y: s.entity.y,
        radius: s.entity.getHitRadius(),
      }));
    const bullets: TeleportBody[] = this.enemyBullets.map((b) => ({
      x: b.graphics.x,
      y: b.graphics.y,
      radius: 5,
    }));
    // The boss is a body the destination must also avoid.
    if (this.boss?.alive) {
      enemies.push({ x: this.boss.x, y: this.boss.y, radius: this.boss.getHitRadius() });
    }

    const dest = findTeleportDestination(
      this.player.x,
      this.player.y,
      heading,
      enemies,
      bullets,
      this.scale.width,
      this.scale.height,
      {
        enemyHitRadius: 12,
        bulletHitRadius: 5,
      },
    );

    // Consume one stack FIFO and grant P6 phase shift at the landing spot.
    this.effectsRegistry.consumeTeleport();
    this.player.setPosition(dest.x, dest.y);
    // Keep the movement state's position in sync with the new position
    // (physicsTick uses the internal state as its base).
    const state = this.player.getMovementState();
    (
      this.player as unknown as {
        _movementState: { x: number; y: number };
      }
    )._movementState = { ...state, x: dest.x, y: dest.y };
    return true;
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

  /** Counts the wave time-limit down; detonates survivors on expiry. */
  private _advanceWaveTimer(dt: number): void {
    if (!this.waveTimerActive) return;
    this.waveTimer = Math.max(0, this.waveTimer - dt);
    if (this.waveTimer <= 0) this._timeoutWave();
  }

  /**
   * Wave time-limit expired. If enemies remain, every survivor detonates
   * at 10x scale and the run loses exactly one life (running the normal
   * game-over flow at 0 lives), then the wave advances. If no enemies
   * remain, nothing happens (AC3).
   */
  private _timeoutWave(): void {
    const survivors = this.spawned.filter((s) => s.entity.alive);
    if (survivors.length === 0) {
      // No enemies left to detonate — the penalty does not apply.
      this._hideWaveTimer();
      return;
    }
    for (const s of survivors) {
      s.entity.destroySelf(WAVE_TIMEOUT_EXPLOSION_SCALE);
    }
    this._loseLife(false);
    this._advanceAfterTimeout();
  }

  /**
   * Advances the wave/level state machine after a timeout wiped the whole
   * active wave: replays one destruction per remaining enemy so the
   * manager emits exactly one clear event, then reacts like any other wipe.
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
    return this.bombNoticeLabel?.visible ?? false;
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
    return this.hitCount;
  }

  /** True while the player is invulnerable after a hit. */
  isPlayerInvulnerable(): boolean {
    return this.invulnerable > 0;
  }

  /** Injects an RNG for deterministic drop rolls (tests). */
  setRng(rng: () => number): void {
    this.rng = rng;
    const rules = loadRules();
    this.dropSpawner = this._buildDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      rng,
    );
  }
}

/** Re-exported so consumers need not import from `core/rules` directly. */
export { DEFAULT_RULES };

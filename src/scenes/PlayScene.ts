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
  POWER_UP_DROP_SIZE,
  SHIP_COLOR,
  SHIP_SIZE,
} from '../core/constants';
import { BOSS_LEVEL, GameState } from '../core/GameState';
import {
  DEFAULT_RULES,
  loadRules,
  POWER_UP_WEIGHT_IDS,
  WEAPON_WEIGHT_IDS,
  type PowerUpWeights,
  type WeaponWeights,
} from '../core/rules';
import {
  playDestructionSound,
  playPowerUpCollectSound,
  playSpawnSound,
} from '../audio/effects';
import { Player } from '../entities/Player';
import {
  PlayerBullet,
  advanceAndCull,
  createPlayerBullet,
} from '../entities/PlayerBullet';
import { createEnemyFromConfig, type EnemyEntity } from '../entities/enemyFactory';
import { EffectsRegistry } from '../powerups/effects';
import { PowerUp, PowerUpState } from '../powerups/PowerUp';
import { getPowerUpById, isWeaponDrop, type DropId, type PowerUpId } from '../powerups/types';
import { drawPowerUpDrop, drawWeaponDrop } from '../powerups/icons';
import { WeightedRandomSpawner, type PowerUpSpawner } from '../powerups/spawner';
import { HUD } from '../ui/HUD';
import { addBackToIndexButton } from '../utils/gymNavigation';
import { angleToVelocity, createBulletsFromHeading, type WeaponId } from '../utils/weapons';
import {
  AsteroidsInputHandler,
  FourDirectionalInputHandler,
  type ControlInput,
} from '../utils/movementModel';
import type { WasdKeysLike } from '../utils/input';
import { resolvePatterns, spawnExplosionParticles } from '../vfx/explosionParticles';
import { loadEnemyConfig } from '../core/enemyConfig';
import { WaveManager, type EnemySpawn } from '../waves/WaveManager';
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
  private livesText: Phaser.GameObjects.Text | null = null;
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
  private fourDirHandler = new FourDirectionalInputHandler();
  private asteroidsHandler = new AsteroidsInputHandler();

  private hitCount = 0;
  private invulnerable = 0;
  private blinkPhase = 0;
  private playerExplosions: Phaser.GameObjects.Graphics[] = [];

  private driftX = 0;
  private driftDir = 1;

  private transitionTimer = 0;

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
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // Player ship (auto-fire, weapons, effects).
    this.player = new Player(this, { x: GAME_WIDTH / 2, y: GAME_HEIGHT - 80 });
    this.add.existing(this.player);
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as WasdKeysLike | undefined;

    // HUD (effects only — lives displayed separately from the run state).
    this.hud = new HUD(this, this.effectsRegistry, { showLives: false });

    this._buildHudText();
    addBackToIndexButton(this);

    // Power-up drop pool.
    const rules = loadRules();
    this.dropSpawner = this._buildDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      this.rng,
    );

    // Start the run.
    this.gameState.startGame();
    this.waveManager.beginGame();
    this.spawnWave();
    this._announceLevel();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this._teardown());
  }

  /** Builds the fixed score / lives / level text readouts. */
  private _buildHudText(): void {
    this.scoreText = this.add
      .text(GAME_WIDTH - 10, 10, 'Score: 0', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#ffffff',
      })
      .setOrigin(1, 0);

    this.levelText = this.add.text(10, 10, 'Level 1', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: HUD_TEXT_COLOR,
    });

    this.livesText = this.add.text(10, 28, `Lives: ${this.gameState.lives}`, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: HUD_TEXT_COLOR,
    });
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
    this.hud?.destroy();
    this.hud = null;
    this.player?.destroy();
    this.player = null;
    this.boss?.destroy();
    this.boss = null;
    this.bannerText?.destroy();
    this.bannerText = null;
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
    this.effectsRegistry.tick(dt);
    this.hud?.refresh();

    // Level/wave transition pause: no spawns or collisions until done.
    if (this.transitionTimer > 0) {
      this.transitionTimer = Math.max(0, this.transitionTimer - dt);
      this._updateTransitionBanner();
      if (this.transitionTimer === 0) this._onTransitionComplete();
      this._refreshHudText();
      return;
    }

    this._moveEnemies(dt);
    this._collectEnemyFire();
    this._updateBoss(dt);

    if (this.player) {
      this.player.tickWeaponTimers(dt * 1000);
      const input = this._readPlayerInput();
      if (input) this.player.setInput(input);
      this.player.physicsTick(dt, this.scale.width, this.scale.height);
      this._autoFire(dt);
    }

    this._advanceBullets(dt);
    this._handleCollisions();
    this._updateInvulnerability(dt);
    this._updateDrops(dt);
    this._refreshHudText();
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
    this._updateTransitionBanner();
  }

  /** Shows/updates the centred transition banner. */
  private _updateTransitionBanner(): void {
    const label =
      this.waveManager.bossTriggered || this.waveManager.bossActive
        ? '⚠ BOSS ⚠'
        : `Level ${this.waveManager.level}`;
    if (!this.bannerText) {
      this.bannerText = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, label, BANNER_STYLE)
        .setOrigin(0.5)
        .setDepth(500);
    }
    this.bannerText.setText(label).setVisible(true);
  }

  /** Shows the level announcement banner at level start. */
  private _announceLevel(): void {
    const label =
      this.waveManager.level === BOSS_LEVEL
        ? '⚠ BOSS ⚠'
        : `Level ${this.waveManager.level}`;
    if (!this.bannerText) {
      this.bannerText = this.add
        .text(GAME_WIDTH / 2, GAME_HEIGHT / 2, label, BANNER_STYLE)
        .setOrigin(0.5)
        .setDepth(500);
    }
    this.bannerText.setText(label).setVisible(true);
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
    if (this.bannerText) this.bannerText.setVisible(false);
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
      const def = this.player.getWeaponDef(weaponId);
      for (const bd of createBulletsFromHeading(def, headingDeg, this.player.x, this.player.y)) {
        const vel = angleToVelocity(bd.angleDeg, PLAYER_BULLET_SPEED);
        this.spawnPlayerBullet(bd.x, bd.y, vel.vx, vel.vy, bd.color);
      }
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
          playDestructionSound();
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
          playDestructionSound();
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
   * Handles an enemy's destruction: awards score, rolls a power-up drop,
   * and advances the wave/level state machine.
   *
   * @param awardScore — false for collision kills (no points for ramming).
   */
  private _onEnemyKilled(s: SpawnedEnemy, awardScore = true): void {
    if (awardScore) {
      this.gameState.addScore(SCORE_VALUES[s.enemyKey] ?? DEFAULT_SCORE_VALUE);
    }
    this._maybeDropPowerUp(s.entity.x, s.entity.y);
    this._advanceAfterKill();
  }

  /**
   * Player hit: absorb with a shield if active, otherwise lose a life and
   * either respawn with invulnerability or end the run.
   */
  private _hitPlayer(): void {
    if (!this.player) return;

    if (this.effectsRegistry.tryAbsorbShield()) {
      // Shield absorbs the hit — no life lost, brief visual pulse.
      playDestructionSound();
      return;
    }

    this.hitCount += 1;
    this.gameState.loseLife();
    playDestructionSound();
    this._spawnPlayerExplosion(this.player.x, this.player.y);

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
   * Spawns a drop of `id` at (x, y). Public so tests can place a
   * deterministic drop.
   */
  spawnPowerUpDrop(id: DropId, x: number, y: number): PlayDrop | null {
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
      if (drop.dropId === 'P4') this._clearEnemyBullets();
      this.effectsRegistry.applyCollect(drop.dropId as PowerUpId);
      if (drop.dropId === 'P8') this.gameState.addLife();
    }
    drop.graphics.destroy();
    try {
      playPowerUpCollectSound();
    } catch {
      // Audio is best-effort in headless tests.
    }
  }

  private _clearEnemyBullets(): void {
    for (const b of this.enemyBullets) b.graphics.destroy();
    this.enemyBullets = [];
  }

  // ── HUD & run end ───────────────────────────────────────────────

  private _refreshHudText(): void {
    this.scoreText?.setText(`Score: ${this.gameState.score}`);
    this.livesText?.setText(`Lives: ${this.gameState.lives}`);
    this.levelText?.setText(
      this.waveManager.level >= BOSS_LEVEL
        ? 'BOSS'
        : `Level ${this.waveManager.level}`,
    );
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

  /** The player ship, or null after teardown. */
  getPlayer(): Player | null {
    return this.player;
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

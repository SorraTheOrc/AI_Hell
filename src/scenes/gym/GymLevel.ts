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
 */

import Phaser from 'phaser';

import { CombatScene } from '../core/CombatScene';
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
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { EffectsRegistry } from '../../powerups/effects';
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
    bullets.push(...fireForEnemy<GymLevelBullet>(spawn.entity, spawn.key, now));
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

  constructor() {
    super({ key: GYM_LEVEL_SCENE_KEY });
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
    this.enemyBullets.push(...fireLiveEnemies(this.spawned, this.time.now));

    // Shared input → timers → multipliers → physics → auto-fire step.
    this._tickPlayer(dt);

    // Player bullets: advance + wrap + lifetime expiry (shared helper).
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);

    // Automatic Phase Shift danger feed (shared), before collision gating.
    this._updatePhaseShiftAutoTrigger(dt);

    // Shared collision pass.
    this._handleCollisions();

    // Post-hit invulnerability blink (shared).
    this._updateInvulnerability(dt);

    // Timed effects (shared ordering).
    this.effectsRegistry.tick(dt);

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
  }

  protected override teardownRunState(): void {
    super.teardownRunState();
    this.player?.destroy();
    this.player = null;
    cleanupWave(this.spawned, this.enemyBullets);
    this.statusText?.destroy();
    this.statusText = null;
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
}

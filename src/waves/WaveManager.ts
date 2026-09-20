/**
 * Wave & level manager for the playable game (GDD §3.2, §4.2).
 *
 * Pure state machine — no Phaser runtime dependency, so it is fully
 * unit-testable. It owns:
 *
 * - the current level (1–5) and wave within that level;
 * - the number of enemies still alive in the active wave;
 * - the transition to the final boss after Level 5 is cleared; and
 * - deterministic spawn planning for the active wave.
 *
 * The scene (`PlayScene`) drives it: it calls {@link WaveManager.beginGame}
 * once, spawns the enemies from {@link WaveManager.planSpawns}, and calls
 * {@link WaveManager.onEnemyDestroyed} each time an enemy dies. The
 * returned {@link WaveEvent} tells the scene what to do next (spawn the
 * next wave, advance the level, trigger the boss, or finish the game).
 *
 * GDD §2.4 — Levels 1–3 do not fire; GDD §2.5 — Levels 4–5 do.
 */

import { computeFormationPosition, getFormationBuilder } from '../utils/formations';
import type { FormationOffset } from '../utils/formations';
import {
  LEVELS,
  type LevelDefinition,
  type WaveDefinition,
  type WaveGroup,
} from './Formations';

// ── Event / spawn shapes ────────────────────────────────────────────

/**
 * Outcome of an enemy destruction, telling the scene what to do next:
 *
 * - `continue`      — enemies remain in the active wave.
 * - `waveCleared`   — the wave was wiped; the next wave is now current.
 * - `levelCleared`  — the level was wiped; the next level is now current.
 * - `bossTriggered` — Level 5 was wiped; the boss should now be spawned
 *                     (call {@link WaveManager.beginBoss}).
 * - `gameComplete`  — the boss was defeated; the run is over.
 */
export type WaveEvent =
  | 'continue'
  | 'waveCleared'
  | 'levelCleared'
  | 'bossTriggered'
  | 'gameComplete';

/** One concrete enemy spawn, ready for the scene to instantiate. */
export interface EnemySpawn {
  /** Enemy config key resolved through `loadEnemyConfig` / entity factory. */
  enemyKey: string;
  /** Formation slot of this enemy. */
  offset: FormationOffset;
  /** Absolute spawn x (px). */
  x: number;
  /** Absolute spawn y (px). */
  y: number;
  /** Whether this enemy may fire projectiles (Level 4+). */
  shootEnabled: boolean;
  /** Formation base x of this enemy's group (px). */
  startX: number;
  /** Formation base y of this enemy's group (px). */
  startY: number;
  /** Horizontal slot spacing of this enemy's group (px). */
  spacingX: number;
  /** Vertical slot spacing of this enemy's group (px). */
  spacingY: number;
}

// ── WaveManager ─────────────────────────────────────────────────────

/**
 * Drives wave/level progression for a single play session.
 *
 * Lifecycle: `beginGame()` → `planSpawns()` → (`onEnemyDestroyed()` → …)
 * → `beginBoss()` → `onBossDefeated()`.
 */
export class WaveManager {
  private readonly levels: LevelDefinition[];

  private _levelIndex = 0;
  private _waveIndex = 0;
  private _enemiesAlive = 0;
  private _bossTriggered = false;
  private _bossActive = false;
  private _bossDefeated = false;
  private _started = false;

  /**
   * @param levels — level definitions to play; defaults to the built-in
   *   five-level campaign (`LEVELS`). Injectable for tests.
   */
  constructor(levels: LevelDefinition[] = LEVELS) {
    this.levels = levels;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Resets to Level 1, Wave 1 and marks the session started. */
  beginGame(): void {
    this._levelIndex = 0;
    this._waveIndex = 0;
    this._bossTriggered = false;
    this._bossActive = false;
    this._bossDefeated = false;
    this._started = true;
    this._enemiesAlive = this._waveSize(this.currentWave());
  }

  /** Resets to the initial (not-started) state. */
  reset(): void {
    this._levelIndex = 0;
    this._waveIndex = 0;
    this._enemiesAlive = 0;
    this._bossTriggered = false;
    this._bossActive = false;
    this._bossDefeated = false;
    this._started = false;
  }

  // ── Accessors ───────────────────────────────────────────────────

  /** Whether `beginGame()` has been called and the run is active. */
  get started(): boolean {
    return this._started;
  }

  /** Current 1-based level number (1–5). */
  get level(): number {
    return this._levelIndex + 1;
  }

  /** Current level's theme name (GDD §3.2), e.g. `The Core`. */
  get levelName(): string {
    return this.currentLevel()?.name ?? '';
  }

  /** Zero-based index of the active wave within the level. */
  get waveIndex(): number {
    return this._waveIndex;
  }

  /** 1-based wave number within the active level. */
  get waveNumber(): number {
    return this._waveIndex + 1;
  }

  /** Number of waves in the active level. */
  get waveCount(): number {
    return this.currentLevel()?.waves.length ?? 0;
  }

  /** Total number of regular levels in the campaign (excludes the boss). */
  get levelCount(): number {
    return this.levels.length;
  }

  /** Whether the active level is the final (pre-boss) level. */
  get isFinalLevel(): boolean {
    return this._levelIndex >= this.levels.length - 1;
  }

  /** Enemies still alive in the active wave. */
  get enemiesAlive(): number {
    return this._enemiesAlive;
  }

  /** Whether the Level-5 wipe has marked the boss encounter as due. */
  get bossTriggered(): boolean {
    return this._bossTriggered;
  }

  /** Whether the boss encounter is active. */
  get bossActive(): boolean {
    return this._bossActive;
  }

  /** Whether the boss has been defeated. */
  get bossDefeated(): boolean {
    return this._bossDefeated;
  }

  /** The active level definition, or null before `beginGame()`. */
  currentLevel(): LevelDefinition | null {
    if (!this._started) return null;
    return this.levels[this._levelIndex] ?? null;
  }

  /**
   * The active wave definition, or null when no regular wave is active
   * (before `beginGame()`, once the boss is due, or during/after the
   * boss encounter).
   */
  currentWave(): WaveDefinition | null {
    if (!this._started || this._bossTriggered || this._bossActive || this._bossDefeated) {
      return null;
    }
    const level = this.currentLevel();
    if (!level) return null;
    return level.waves[this._waveIndex] ?? null;
  }

  // ── Spawn planning ──────────────────────────────────────────────

  /** Total number of enemies in the supplied wave (0 when null). */
  private _waveSize(wave: WaveDefinition | null): number {
    if (!wave) return 0;
    return wave.groups.reduce((sum, g) => sum + g.count, 0);
  }

  /** Total number of enemies in the active wave. */
  waveEnemyCount(): number {
    return this._waveSize(this.currentWave());
  }

  /**
   * Computes the concrete spawn list for the active wave: one
   * {@link EnemySpawn} per enemy, positioned by the group's formation
   * builder. Returns an empty array when there is no active wave
   * (before `beginGame()` or during the boss encounter).
   */
  planSpawns(): EnemySpawn[] {
    const wave = this.currentWave();
    if (!wave) return [];
    return planGroupSpawns(wave.groups, wave.shootEnabled);
  }

  // ── Dynamic spawn registration (asteroid splits, AH-0MU8BZ2ZM004J47F) ──

  /**
   * Registers `count` dynamically spawned enemies (e.g. split asteroid
   * children) so the wave's alive count tracks them and the wave does
   * not clear early or stall. Must be called exactly once per spawned
   * child before that child can be destroyed. Safe no-op when no regular
   * wave is active (before `beginGame()`, boss due/active, run over).
   */
  registerDynamicSpawn(count: number): void {
    if (!this._started || this._bossTriggered || this._bossActive || this._bossDefeated) {
      return;
    }
    if (count > 0) this._enemiesAlive += count;
  }

  /**
   * Unregisters `count` dynamically spawned enemies that are removed
   * without a destruction event (e.g. an off-screen child is discarded).
   * Never drives the counter below zero. Safe no-op when no regular wave
   * is active.
   */
  unregisterDynamicSpawn(count: number): void {
    if (!this._started || this._bossTriggered || this._bossActive || this._bossDefeated) {
      return;
    }
    this._enemiesAlive = Math.max(0, this._enemiesAlive - count);
  }

  // ── Progression ─────────────────────────────────────────────────

  /**
   * Records one enemy destruction and advances the state machine.
   *
   * @returns the {@link WaveEvent} describing the transition. The caller
   *   is responsible for reacting (spawn the next wave, start the boss,
   *   or end the run).
   */
  onEnemyDestroyed(): WaveEvent {
    if (!this._started || this._bossTriggered || this._bossActive || this._bossDefeated) {
      return this._bossDefeated ? 'gameComplete' : 'continue';
    }

    if (this._enemiesAlive > 0) {
      this._enemiesAlive -= 1;
    }
    if (this._enemiesAlive > 0) return 'continue';

    // Active wave wiped — is there another wave in this level?
    const level = this.currentLevel();
    if (level && this._waveIndex < level.waves.length - 1) {
      this._waveIndex += 1;
      this._enemiesAlive = this._waveSize(this.currentWave());
      return 'waveCleared';
    }

    // Level wiped — advance to the next level, or trigger the boss.
    if (!this.isFinalLevel) {
      this._levelIndex += 1;
      this._waveIndex = 0;
      this._enemiesAlive = this._waveSize(this.currentWave());
      return 'levelCleared';
    }

    // Final level wiped — the boss encounter is due.
    this._enemiesAlive = 0;
    this._bossTriggered = true;
    return 'bossTriggered';
  }

  /**
   * Starts the boss encounter. Called by the scene after receiving
   * `bossTriggered` from {@link onEnemyDestroyed}.
   */
  beginBoss(): void {
    this._bossActive = true;
  }

  /**
   * Records the boss defeat and completes the run.
   * @returns `gameComplete`.
   */
  onBossDefeated(): WaveEvent {
    this._bossActive = false;
    this._bossDefeated = true;
    return 'gameComplete';
  }
}

// ── Spawn planning helper ───────────────────────────────────────────

/**
 * Computes the concrete spawn list for a list of wave groups: one
 * {@link EnemySpawn} per enemy, positioned by each group's formation
 * builder. Shared by {@link WaveManager.planSpawns} and the boss minion
 * planner (`waves/BossMinions.ts`). Pure — no Phaser dependency.
 */
export function planGroupSpawns(
  groups: WaveGroup[],
  shootEnabled: boolean,
): EnemySpawn[] {
  const spawns: EnemySpawn[] = [];
  for (const groupDef of groups) {
    const buildOffsets = getFormationBuilder(groupDef.formation);
    for (const offset of buildOffsets(groupDef.count)) {
      const { x, y } = computeFormationPosition(
        groupDef.startX,
        groupDef.startY,
        offset,
        groupDef.spacingX,
        groupDef.spacingY,
      );
      spawns.push({
        enemyKey: groupDef.enemyKey,
        offset,
        x,
        y,
        shootEnabled,
        startX: groupDef.startX,
        startY: groupDef.startY,
        spacingX: groupDef.spacingX,
        spacingY: groupDef.spacingY,
      });
    }
  }
  return spawns;
}

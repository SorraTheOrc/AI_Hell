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

import {
  computeFormationPosition,
  formationSpawnCount,
  getFormationBuilder,
} from '../utils/formations';
import type { EnemyFormationKind, FormationOffset } from '../utils/formations';
import { pickInRange, resolveSpawnRange, type EnemyConfig, type SpawnRange } from '../core/configTypes';
import { loadEnemyConfig } from '../core/enemyConfig';
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
  private levels: LevelDefinition[];

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

  /**
   * Replaces the level definitions at runtime. Resets internal state so
   * the next `beginGame()` starts from the new levels. Injectable for
   * tests that need custom wave configurations.
   */
  setLevels(levels: LevelDefinition[]): void {
    this.levels = levels;
    this.reset();
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

  /**
   * Cumulative zero-based regular-wave index across the whole campaign
   * (0 for Level 1 Wave 1). Increments once per regular wave and never
   * decreases. Returns 0 when no regular wave is active (before
   * `beginGame()`, once the boss is due, during/after the boss
   * encounter) so it can never rise outside a playable wave.
   */
  get globalWaveIndex(): number {
    // Before `beginGame()`, during the boss encounter (active or defeated),
    // or after game complete — no regular wave is active.
    // We allow the index to persist when `bossTriggered` is true (boss is
    // queued but not yet active) so that callers can observe the last
    // regular-wave index.
    if (!this._started || this._bossActive || this._bossDefeated) {
      return 0;
    }
    let index = 0;
    for (let i = 0; i < this._levelIndex; i++) {
      index += this.levels[i]?.waves.length ?? 0;
    }
    return index + this._waveIndex;
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

  /**
   * Total number of enemies the supplied wave will **actually** spawn
   * (0 when null). Derived from each group's formation builder — not the
   * raw `count` field — so the declared size always matches
   * {@link planSpawns} (a count-independent formation such as `single`
   * spawns one entity regardless of its declared `count`).
   */
  private _waveSize(wave: WaveDefinition | null): number {
    if (!wave) return 0;
    return wavePlannedSpawnCount(wave.groups);
  }

  /**
   * Total number of enemies the active wave will actually spawn. Always
   * equal to `planSpawns().length` — the declared-vs-planned invariant.
   */
  waveEnemyCount(): number {
    return this._waveSize(this.currentWave());
  }

  /**
   * Computes the concrete spawn list for the active wave: one
   * {@link EnemySpawn} per enemy, positioned by the group's formation
   * builder. Its length always equals {@link waveEnemyCount}. Returns an
   * empty array when there is no active wave (before `beginGame()` or
   * during the boss encounter).
   */
  planSpawns(rng: () => number = Math.random): EnemySpawn[] {
    const wave = this.currentWave();
    if (!wave) return [];
    return planGroupSpawns(wave.groups, wave.shootEnabled, rng);
  }

  // ── Dynamic spawn registration (generic seam) ───────────────────

  /**
   * Registers `count` dynamically spawned enemies so the wave's alive count
   * tracks them and the wave does not clear early or stall. Must be called
   * exactly once per spawned child before that child can be destroyed. Safe
   * no-op when no regular wave is active (before `beginGame()`, boss
   * due/active, run over).
   *
   * Asteroids are NOT registered through this seam (AH-0MUJM746P000QAEO):
   * they do not gate wave completion and persist across wave/level
   * transitions. The seam is retained for any future dynamically spawned
   * enemy that must be wave-accounted.
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
 * Total number of enemies a list of wave groups will actually spawn, derived
 * from each group's formation builder (see `formationSpawnCount`). This is
 * the spawn plan's source of truth: `waveEnemyCount()` and
 * `planSpawns().length` both resolve to this value, so the declared size can
 * never exceed what is spawned. Pure — no Phaser dependency.
 */
export function wavePlannedSpawnCount(groups: WaveGroup[]): number {
  return groups.reduce((sum, g) => sum + formationSpawnCount(g.formation, g.count), 0);
}

/**
 * One wave-group configuration problem, naming the offending group.
 */
export interface WaveGroupValidationError {
  /** Index of the offending group in the supplied list. */
  index: number;
  /** Enemy config key of the offending group. */
  enemyKey: string;
  /** Formation kind of the offending group. */
  formation: EnemyFormationKind;
  /** Declared enemy count of the offending group. */
  count: number;
  /** Human-readable description naming the group and its count. */
  message: string;
}

/**
 * Validates a list of wave groups against the formation semantics and
 * returns one error per misconfigured group (an empty array when all are
 * valid).
 *
 * Currently the only rule is the `single` formation: it represents exactly
 * one entity (`buildSingleOffset` always returns one centred offset), so its
 * declared `count` must be `1`. This is an authoring-time check — it returns
 * errors rather than throwing, so callers (level loaders, authoring tools,
 * tests) can surface them without risking a runtime crash. Note that
 * {@link wavePlannedSpawnCount} already keeps declared and planned counts
 * equal even for an over-declared `single` group; this helper exists to flag
 * the otherwise-silent misconfiguration. Pure — no Phaser dependency.
 */
export function validateWaveGroups(groups: WaveGroup[]): WaveGroupValidationError[] {
  const errors: WaveGroupValidationError[] = [];
  groups.forEach((group, index) => {
    if (group.formation === 'single' && group.count !== 1) {
      errors.push({
        index,
        enemyKey: group.enemyKey,
        formation: group.formation,
        count: group.count,
        message:
          `single-formation group ${index} ('${group.enemyKey}') declares count=${group.count}; ` +
          `the 'single' formation spawns exactly one enemy, so count must be 1.`,
      });
    }
  });
  return errors;
}

/**
 * Resolves the effective spawn range for one axis of a wave group.
 *
 * Precedence (AH-0MUKCLXLW0032R67, WG4): an explicit per-group range
 * overrides the enemy archetype's configured range. A degenerate or absent
 * archetype range (min === max, e.g. every legacy seed) leaves the group's
 * scalar `start` untouched, so existing levels spawn at exactly the same
 * point. Reversed bounds are normalised by {@link resolveSpawnRange}.
 */
function resolveGroupRange(
  groupStart: number,
  groupMin: number | undefined,
  groupMax: number | undefined,
  configMin: number | undefined,
  configMax: number | undefined,
): SpawnRange {
  // Per-group override wins when either bound is present (WG4).
  if (groupMin !== undefined || groupMax !== undefined) {
    return resolveSpawnRange(groupStart, groupMin, groupMax);
  }
  // Otherwise use the archetype's range, but only when it is a genuine band:
  // a degenerate (min === max) config is the legacy scalar and must not
  // override the wave group's own start position.
  if (configMin !== undefined && configMax !== undefined && configMin !== configMax) {
    return resolveSpawnRange(configMin, configMin, configMax);
  }
  return { min: groupStart, max: groupStart };
}

/**
 * Computes the concrete spawn list for a list of wave groups: one
 * {@link EnemySpawn} per enemy, positioned by each group's formation
 * builder. The number of spawns always equals
 * {@link wavePlannedSpawnCount} for the same groups, keeping the declared
 * wave size and the plan in lockstep. Shared by
 * {@link WaveManager.planSpawns} and the boss minion planner
 * (`waves/BossMinions.ts`). Pure — no Phaser dependency.
 *
 * Spawn-position ranges (AH-0MUKCLXLW0032R67): each group selects a random
 * base position within its effective range (per-group override, else the
 * enemy archetype's configured range), then the formation offsets are added
 * exactly as before. A zero-width range consumes no randomness, preserving
 * deterministic legacy behaviour. `rng` is injectable for tests.
 *
 * @param groups — wave groups to position.
 * @param shootEnabled — whether the spawned enemies may fire.
 * @param rng — RNG returning a fraction in `[0, 1)`; defaults to
 *   `Math.random`. The scene passes its own RNG for deterministic replays.
 * @param configFor — archetype resolver; defaults to the config store
 *   loader (injectable for tests without a seeded registry).
 */
export function planGroupSpawns(
  groups: WaveGroup[],
  shootEnabled: boolean,
  rng: () => number = Math.random,
  configFor: (enemyKey: string) => EnemyConfig = loadEnemyConfig,
): EnemySpawn[] {
  const spawns: EnemySpawn[] = [];
  for (const groupDef of groups) {
    const config = configFor(groupDef.enemyKey);
    const baseX = pickInRange(
      resolveGroupRange(
        groupDef.startX,
        groupDef.startXMin,
        groupDef.startXMax,
        config.startXMin,
        config.startXMax,
      ),
      rng,
    );
    const baseY = pickInRange(
      resolveGroupRange(
        groupDef.startY,
        groupDef.startYMin,
        groupDef.startYMax,
        config.startYMin,
        config.startYMax,
      ),
      rng,
    );
    const buildOffsets = getFormationBuilder(groupDef.formation);
    for (const offset of buildOffsets(groupDef.count)) {
      const { x, y } = computeFormationPosition(
        baseX,
        baseY,
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
        startX: baseX,
        startY: baseY,
        spacingX: groupDef.spacingX,
        spacingY: groupDef.spacingY,
      });
    }
  }
  return spawns;
}

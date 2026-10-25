/**
 * MiniBoss — a reusable, config-driven variant of the multi-phase
 * {@link Boss} (epic AH-0MVCC8XSS007P01Z, AH-0MVCRAYSH0014BQJ).
 *
 * The shipped Boss hard-codes four phases with one pattern each and a fixed
 * 4 × 50 HP pool. A mini-boss (the 10th wave of every level) needs the same
 * architecture — telegraph → volley → attack interval, per-phase health bar,
 * damage/defeat contract, figure-of-eight movement, shared VFX/audio and the
 * shared `CombatScene._advanceBoss` tick — but driven by a per-level config:
 *
 * - **pattern set** — one {@link MiniBossPattern} per phase, each dispatching
 *   to the Boss's existing, shared pattern implementations (no forked firing
 *   code);
 * - **HP** — a configurable uniform `hpPerPhase` (validated > 0);
 * - **colour** — body (and optional final-phase) colour;
 * - **optional minions** — per-phase formation waves spawned and advanced by
 *   the entity itself through the shared `planGroupSpawns` / enemy factory /
 *   `fireForEnemy` path, so the game and every gym run identical minion code.
 *
 * **Why it extends rather than copies `Boss`:** extending the shipped entity
 * keeps a single implementation of the shared telegraph/volley/damage
 * machinery (AGENTS.md gym↔game parity). `Boss` gained only additive,
 * default-preserving config hooks (`phaseCount`, `hitPointsPerPhase`,
 * `bodyColor`, `desperationColor`, an overridable `firePhase()`) so its
 * shipped behaviour is byte-for-byte unchanged while `MiniBoss` supplies the
 * per-level values.
 *
 * **No-config-safe default:** `new MiniBoss(scene, { x, y, formationOffset })`
 * is valid — one `spread` phase, {@link MINI_BOSS_DEFAULT_HP_PER_PHASE} hits
 * and the default colour. Invalid configs throw {@link MiniBossConfigError}
 * with an actionable message (phases ≥ 1, HP > 0, known patterns, valid
 * minion phases).
 */

import Phaser from 'phaser';

import { Boss, type BossBullet } from './Boss';
import { createEnemyFromConfig, type EnemyEntity } from './enemyFactory';
import { fireForEnemy } from './enemyFire';
import { loadEnemyConfig } from '../core/enemyConfig';
import { enemyForceFieldHits } from '../core/enemyForceField';
import type { FormationOffset } from '../utils/formations';
import { planGroupSpawns, type EnemySpawn } from '../waves/WaveManager';
import type { WaveGroup } from '../waves/Formations';

// ── Config types ────────────────────────────────────────────────────

/**
 * Attack patterns a mini-boss phase can select. Each maps onto an existing
 * shared Boss pattern implementation, so no firing logic is duplicated:
 *
 * - `spread` — wide forward arc (`Boss.tryFireSpreadBullets`);
 * - `spiral` — rotating radial spiral (`Boss.tryFireSpiralBullets`);
 * - `pulse` — screen-wide pulse wave + aimed fan (`Boss.tryFirePulseBullets`);
 * - `combined` — every pattern at once (`Boss.tryFireDesperationBullets`).
 */
export type MiniBossPattern = 'spread' | 'spiral' | 'pulse' | 'combined';

/** All valid {@link MiniBossPattern} values (used by config validation). */
export const MINI_BOSS_PATTERNS: readonly MiniBossPattern[] = [
  'spread',
  'spiral',
  'pulse',
  'combined',
];

/** One mini-boss phase: the pattern it fires while active. */
export interface MiniBossPhaseConfig {
  /** Pattern fired by this phase (see {@link MiniBossPattern}). */
  pattern: MiniBossPattern;
}

/**
 * An optional minion wave summoned when a phase begins. Spawns are planned
 * through the shared `planGroupSpawns` (the same planner used by the shipped
 * wave/boss minion code), so positions and formation geometry match the game.
 */
export interface MiniBossMinionWaveConfig {
  /** 1-based phase during which this wave is summoned. */
  phase: number;
  /** Formation groups spawned for the wave. */
  groups: WaveGroup[];
  /** Whether the summoned minions may fire (defaults to `true`). */
  shootEnabled?: boolean;
}

/** Per-level mini-boss configuration (all fields beyond position optional). */
export interface MiniBossConfig {
  /** Campaign level this mini-boss belongs to (defaults to 1). */
  level?: number;
  /** Display name (defaults to `'Mini-Boss'`). */
  name?: string;
  x: number;
  y: number;
  /** Offset within the formation (required by the shared entity interface). */
  formationOffset: FormationOffset;
  /** Body colour (defaults to {@link MINI_BOSS_DEFAULT_COLOR}). */
  color?: number;
  /** Final-phase body colour (defaults to {@link MiniBossConfig.color}). */
  desperationColor?: number;
  /**
   * Hits required to deplete each phase. Defaults to
   * {@link MINI_BOSS_DEFAULT_HP_PER_PHASE}; must be > 0.
   */
  hpPerPhase?: number;
  /**
   * Phase pattern set, one entry per phase. Defaults to a single `spread`
   * phase; when present it must contain at least one phase.
   */
  phases?: MiniBossPhaseConfig[];
  /** Optional per-phase minion waves (omitted → no minions). */
  minions?: MiniBossMinionWaveConfig[];
  /** Chance (0–1) a volley fires when eligible (defaults to 1.0). */
  shotProbability?: number;
  /** Injectable random source for fire rolls and minion placement. */
  rng?: () => number;
  /** Optional starting HP (dev/testing shortcut, clamped to the total pool). */
  initialHp?: number;
  /** Optional starting phase (dev/testing shortcut, clamped to the phase count). */
  initialPhase?: number;
}

/** A fully populated mini-boss config (defaults applied, validation passed). */
export interface ResolvedMiniBossConfig {
  level: number;
  name: string;
  x: number;
  y: number;
  formationOffset: FormationOffset;
  color: number;
  desperationColor: number;
  hpPerPhase: number;
  phases: MiniBossPhaseConfig[];
  minions: MiniBossMinionWaveConfig[];
  shotProbability?: number;
  rng?: () => number;
  initialHp?: number;
  initialPhase?: number;
}

// ── Defaults ────────────────────────────────────────────────────────

/** Default hits per mini-boss phase (no-config-safe default). */
export const MINI_BOSS_DEFAULT_HP_PER_PHASE = 25;
/** Default mini-boss body colour (violet, distinct from the red Boss). */
export const MINI_BOSS_DEFAULT_COLOR = 0xcc44ff;
/** Default pattern set — a single spread phase. */
export const MINI_BOSS_DEFAULT_PHASES: readonly MiniBossPhaseConfig[] = [
  { pattern: 'spread' },
];

// ── Validation ──────────────────────────────────────────────────────

/** Thrown when a mini-boss config is invalid; the message names the fix. */
export class MiniBossConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiniBossConfigError';
  }
}

/** Validates an already-defaulted config (shared by resolve/validate). */
function assertValidResolvedConfig(config: ResolvedMiniBossConfig): void {
  if (!Array.isArray(config.phases) || config.phases.length < 1) {
    throw new MiniBossConfigError(
      'MiniBoss config requires at least one phase (phases ≥ 1).',
    );
  }
  for (const [index, phase] of config.phases.entries()) {
    if (!MINI_BOSS_PATTERNS.includes(phase.pattern)) {
      throw new MiniBossConfigError(
        `MiniBoss phase ${index + 1} has unknown pattern "${String(
          phase.pattern,
        )}". Expected one of: ${MINI_BOSS_PATTERNS.join(', ')}.`,
      );
    }
  }
  if (!Number.isFinite(config.hpPerPhase) || config.hpPerPhase <= 0) {
    throw new MiniBossConfigError(
      `MiniBoss hpPerPhase must be greater than 0 (got ${String(
        config.hpPerPhase,
      )}).`,
    );
  }
  for (const wave of config.minions) {
    if (
      !Number.isInteger(wave.phase) ||
      wave.phase < 1 ||
      wave.phase > config.phases.length
    ) {
      throw new MiniBossConfigError(
        `MiniBoss minion wave phase must be an integer between 1 and ${
          config.phases.length
        } (got ${String(wave.phase)}).`,
      );
    }
    if (!Array.isArray(wave.groups)) {
      throw new MiniBossConfigError(
        `MiniBoss minion wave for phase ${wave.phase} requires a groups array.`,
      );
    }
  }
}

/**
 * Applies the no-config-safe defaults and validates the result. Throws a
 * {@link MiniBossConfigError} for an empty phase list, a non-positive HP
 * value, an unknown pattern or an out-of-range minion phase.
 */
export function resolveMiniBossConfig(
  config: MiniBossConfig,
): ResolvedMiniBossConfig {
  const color = config.color ?? MINI_BOSS_DEFAULT_COLOR;
  const resolved: ResolvedMiniBossConfig = {
    level: config.level ?? 1,
    name: config.name ?? 'Mini-Boss',
    x: config.x,
    y: config.y,
    formationOffset: config.formationOffset,
    color,
    desperationColor: config.desperationColor ?? color,
    // Preserve a caller-supplied (even invalid) value so validation can
    // reject it with an actionable message instead of silently clamping.
    hpPerPhase: config.hpPerPhase ?? MINI_BOSS_DEFAULT_HP_PER_PHASE,
    phases: (
      config.phases ?? MINI_BOSS_DEFAULT_PHASES.map((phase) => ({ ...phase }))
    ).map((phase) => ({ ...phase })),
    minions: (config.minions ?? []).map((wave) => ({
      ...wave,
      groups: wave.groups.map((group) => ({ ...group })),
    })),
    shotProbability: config.shotProbability,
    rng: config.rng,
    initialHp: config.initialHp,
    initialPhase: config.initialPhase,
  };
  assertValidResolvedConfig(resolved);
  return resolved;
}

/**
 * Validates a mini-boss config without constructing an entity. Throws a
 * {@link MiniBossConfigError} when the config (after defaults) is invalid.
 */
export function validateMiniBossConfig(config: MiniBossConfig): void {
  assertValidResolvedConfig(resolveMiniBossConfig(config));
}

// ── Active minion bookkeeping ───────────────────────────────────────

interface ActiveMinion {
  entity: EnemyEntity;
  enemyKey: string;
  startX: number;
  startY: number;
  spacingX: number;
  spacingY: number;
}

// ── The MiniBoss entity ─────────────────────────────────────────────

/**
 * Config-driven multi-phase mini-boss. Extends {@link Boss} so the telegraph,
 * volley cadence, phase health bar, damage/defeat result and figure-of-eight
 * movement are the single shared implementation; only the config-driven
 * pattern dispatch and optional minions are new here.
 */
export class MiniBoss extends Boss {
  /** The fully resolved, validated config (read-only by convention). */
  readonly resolvedConfig: ResolvedMiniBossConfig;

  private readonly activeMinions: ActiveMinion[] = [];
  private aimTargetX = 480;
  private aimTargetY = 500;

  constructor(scene: Phaser.Scene, config: MiniBossConfig) {
    const resolved = resolveMiniBossConfig(config);
    super(scene, {
      x: resolved.x,
      y: resolved.y,
      formationOffset: resolved.formationOffset,
      shotProbability: resolved.shotProbability,
      rng: resolved.rng,
      initialHp: resolved.initialHp,
      initialPhase: resolved.initialPhase,
      phaseCount: resolved.phases.length,
      hitPointsPerPhase: resolved.hpPerPhase,
      bodyColor: resolved.color,
      desperationColor: resolved.desperationColor,
    });
    this.resolvedConfig = resolved;
    // Phase 1 summons its minion wave immediately, mirroring the shipped
    // Boss encounter opening on its first phase (AH-0MUII3E5E006A93F).
    this._spawnMinionsForPhase(1);
  }

  /** The config-driven pattern for the current phase (shared Boss patterns). */
  protected override firePhase(now: number): BossBullet[] {
    const phase = this.resolvedConfig.phases[this.getPhaseNumber() - 1];
    switch (phase?.pattern) {
      case 'spiral':
        return this.tryFireSpiralBullets(now);
      case 'pulse':
        return this.tryFirePulseBullets(now);
      case 'combined':
        return this.tryFireDesperationBullets(now);
      case 'spread':
      default:
        return this.tryFireSpreadBullets(now);
    }
  }

  /**
   * Applies one hit, then summons the next phase's minion wave on a phase
   * advance (or clears the survivors on defeat). The shared damage contract
   * is unchanged.
   */
  override takeDamage(
    hitX?: number,
    hitY?: number,
  ): {
    destroyed: boolean;
    phaseAdvanced: boolean;
    phase: number;
    hpRemaining: number;
  } {
    const result = super.takeDamage(hitX, hitY);
    if (result.destroyed) {
      this._clearMinions();
    } else if (result.phaseAdvanced) {
      this._spawnMinionsForPhase(result.phase);
    }
    return result;
  }

  /**
   * Advances the mini-boss and its minions on the shared tick, returning the
   * boss volley **and** every live minion's fire so the scene collects them
   * through the same enemy-bullet list as a shipped boss encounter.
   */
  override update(
    now: number,
    delta: number,
    sceneWidth: number,
    sceneHeight: number,
  ): BossBullet[] {
    const bullets = super.update(now, delta, sceneWidth, sceneHeight);
    if (!this.alive || this.activeMinions.length === 0) return bullets;
    this._advanceMinions(delta / 1000, now, bullets);
    return bullets;
  }

  /** Live minions (collision + test seam). */
  getMinions(): EnemyEntity[] {
    return this.activeMinions.map((minion) => minion.entity);
  }

  /** Remembers the player position for minion aim (spread stays forward). */
  override setAimTarget(x: number, y: number): void {
    super.setAimTarget(x, y);
    this.aimTargetX = x;
    this.aimTargetY = y;
  }

  /** Clears the minions with the boss body. */
  override destroySelf(): void {
    this._clearMinions();
    super.destroySelf();
  }

  /** Destroys scene-level minions with the entity (SHUTDOWN/stop-safe). */
  override destroy(fromScene?: boolean): void {
    this._clearMinions();
    super.destroy(fromScene);
  }

  // ── Minion lifecycle (shared planner / factory / fire seam) ──────

  /** Replaces any live minions with `phase`'s configured wave (if any). */
  private _spawnMinionsForPhase(phase: number): void {
    this._clearMinions();
    const wave = this.resolvedConfig.minions.find(
      (candidate) => candidate.phase === phase,
    );
    if (!wave || wave.groups.length === 0) return;

    const rng = this.resolvedConfig.rng ?? Math.random;
    const spawns: EnemySpawn[] = planGroupSpawns(
      wave.groups,
      wave.shootEnabled ?? true,
      rng,
    );
    for (const spawn of spawns) {
      const cfg = loadEnemyConfig(spawn.enemyKey);
      const entity = createEnemyFromConfig(
        this.scene as Phaser.Scene,
        cfg,
        spawn.x,
        spawn.y,
        spawn.offset,
        rng,
        // Minion force fields resolve the mini-boss's campaign level through
        // the same shared curve as every other game spawn (the game builds
        // the config with the run level; a gym passes its own level or
        // defaults to 1 = unshielded) — AH-0MVM8GXEF009883O.
        enemyForceFieldHits(this.resolvedConfig.level ?? 1, cfg),
      );
      entity.shootEnabled = spawn.shootEnabled;
      (this.scene as Phaser.Scene).add.existing(entity);
      this.activeMinions.push({
        entity,
        enemyKey: spawn.enemyKey,
        startX: spawn.startX,
        startY: spawn.startY,
        spacingX: spawn.spacingX,
        spacingY: spawn.spacingY,
      });
    }
  }

  /**
   * Positions and fires every live minion, appending their shots to the
   * caller's bullet list. Dead minions are dropped.
   */
  private _advanceMinions(
    dtSeconds: number,
    now: number,
    bullets: BossBullet[],
  ): void {
    let write = 0;
    for (const minion of this.activeMinions) {
      const { entity } = minion;
      if (!entity.alive) continue;
      entity.applyFormationPosition(
        minion.startX,
        minion.startY,
        dtSeconds,
        minion.spacingX,
        minion.spacingY,
      );
      (
        entity as { setAimTarget?(x: number, y: number): void }
      ).setAimTarget?.(this.aimTargetX, this.aimTargetY);
      bullets.push(
        ...fireForEnemy<BossBullet>(entity, minion.enemyKey, now),
      );
      this.activeMinions[write++] = minion;
    }
    this.activeMinions.length = write;
  }

  /** Destroys and forgets every live minion. */
  private _clearMinions(): void {
    for (const minion of this.activeMinions) minion.entity.destroy(true);
    this.activeMinions.length = 0;
  }
}

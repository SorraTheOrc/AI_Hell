/**
 * Runtime auto-sequencer for dynamic difficulty adjustment (AH-0MUDIWETP003XC3X).
 *
 * Reads a **design-time difficulty curve** (an array of target scores, one per
 * wave) and a pool of **candidate enemy groups** — each describing an archetype
 * with one or more adjustable parameters — then produces a sequence of
 * {@link ShootableWave} definitions whose difficulty scores best approximate
 * the targets.
 *
 * The sequencer uses the {@link enemyDifficulty} scorer from
 * `enemyDifficulty.ts` to evaluate every candidate for every wave and picks
 * the combination with the smallest absolute error against the target.  It
 * optionally fine-tunes by iterating over adjustable fields (count, driftSpeed)
 * within their permitted ranges to narrow the error further.
 *
 * @module difficultySequencer
 */

import { enemyDifficulty } from './enemyDifficulty';
import {
  DEFAULT_ENEMY_CONFIGS,
  type EnemyConfig,
  type EnemyShotPattern,
  type EnemyFormationKind,
} from './enemyConfig';
import type { WaveGroup } from '../waves/Formations';

// ── Public types ─────────────────────────────────────────────────────

/**
 * A target difficulty curve — one numeric target score per wave.
 *
 * Targets are in the same 0–100 scale as the {@link enemyDifficulty} scorer.
 * Each entry is the desired difficulty for the corresponding wave position.
 */
export type DifficultyCurveConfig = number[];

/**
 * A candidate enemy group that the sequencer can instantiate and tune.
 *
 * The `enemyKey` identifies the archetype (resolved from the CSV-backed config
 * store or the seed defaults).  `baseCount` is the starting count; the
 * sequencer will vary it between `minCount` and `maxCount` (clamped to
 * `[1, 200]`).
 */
export interface CandidateGroup {
  /** Enemy archetype key — must exist in the config store or defaults. */
  enemyKey: string;
  /** Starting count for this candidate. */
  baseCount: number;
  /** Minimum count the sequencer may adjust to. */
  minCount: number;
  /** Maximum count the sequencer may adjust to. */
  maxCount: number;
  /**
   * Which fields may be adjusted.  At a minimum `count` must be listed.
   * Additional adjustable fields: `driftSpeed`, `formationKind`, `shotPattern`.
   */
  adjustableFields: Array<keyof Pick<EnemyConfig, 'count' | 'driftSpeed' | 'formationKind' | 'shotPattern'>>;
}

/**
 * An enemy group after the sequencer has tuned it to hit the target.
 *
 * Carries the effective score so the caller can inspect how well the target
 * was matched.
 */
export interface AdjustedGroup extends WaveGroup {
  /** The difficulty score of this adjusted group (0–100). */
  score: number;
}

/**
 * A wave produced by the sequencer, ready for the game to consume.
 */
export interface ShootableWave {
  /** Groups of enemies to spawn together. */
  groups: AdjustedGroup[];
  /** Whether enemies in this wave fire projectiles. */
  shootEnabled: boolean;
  /** The target difficulty score for this wave. */
  targetDifficulty: number;
}

/**
 * Full result from the sequencer.
 *
 * `waves` is the sequence of waves to play; `errors` is the absolute
 * difference between each wave's actual difficulty and its target (lower is
 * better). A wave's actual difficulty is the **sum** of its groups' scores;
 * when a single group cannot reach the target the sequencer composes the wave
 * from several groups (see {@link SequencerOptions.allowMultipleGroups}).
 */
export interface SequencerResult {
  /** The produced waves in play order. */
  waves: ShootableWave[];
  /** Per-wave absolute error against the target. */
  errors: number[];
}

// ── Sequencer options ────────────────────────────────────────────────

/** Optional configuration for the sequencer. */
export interface SequencerOptions {
  /**
   * Acceptable absolute error per wave (same 0–100 scale).  When the best
   * candidate is within this tolerance the sequencer stops tuning.
   * @default 10
   */
  tolerance?: number;
  /**
   * Maximum tuning iterations per wave per candidate.  Each iteration tries
   * a coarser or finer step depending on remaining error.
   * @default 50
   */
  maxIterations?: number;
  /**
   * Whether newly spawned groups are allowed to fire projectiles.
   * When `true`, firing factors contribute to the score; when `false` they
   * are suppressed (Levels 1–3 behaviour).
   * @default false
   */
  defaultShootEnabled?: boolean;
  /**
   * Whether a wave may be composed from more than one candidate group.
   *
   * A single group's `enemyDifficulty` score saturates well below 100 — the
   * tunable counts alone cannot push one archetype to the top of the scale —
   * so targets above a single group's ceiling are only reachable by combining
   * groups. Greedy composition also gives higher-difficulty waves varied
   * compositions instead of repeating one saturated archetype.
   * @default true
   */
  allowMultipleGroups?: boolean;
  /**
   * Maximum number of groups a single wave may be composed from.
   * @default 5
   */
  maxGroupsPerWave?: number;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_TOLERANCE = 10;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_GROUPS_PER_WAVE = 5;
/** Ignore floating-point noise when comparing candidate errors. */
const COMPOSE_EPSILON = 1e-9;

/**
 * The default candidate pool — one entry per seed archetype with sensible
 * count ranges and count as the only adjustable field.
 *
 * These defaults can be customised by the caller to give the sequencer
 * a wider (or narrower) set of tuning options.
 */
export function defaultCandidatePool(): CandidateGroup[] {
  return Object.entries(DEFAULT_ENEMY_CONFIGS).map(([key, cfg]) => {
    // `single`-formation archetypes (the roaming Asteroid) spawn exactly one
    // entity per group regardless of `count` (`buildSingleOffset` ignores its
    // argument), so exposing a count range would let the sequencer request a
    // group whose spawns cannot satisfy its declared `waveEnemyCount`. Pin the
    // range to the archetype's own count instead of scaling it.
    const scalable = cfg.formationKind !== 'single';
    return {
      enemyKey: key,
      baseCount: cfg.count,
      minCount: scalable ? Math.max(1, Math.floor(cfg.count * 0.1)) : cfg.count,
      maxCount: scalable ? Math.min(200, Math.ceil(cfg.count * 3)) : cfg.count,
      adjustableFields: ['count'],
    };
  });
}

// ── Internal helpers ─────────────────────────────────────────────────

/** Clamp a value to [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Resolve the base EnemyConfig for a candidate group.
 *
 * Looks up the archetype from the config store / defaults and copies the
 * group's override fields.
 */
function resolveBaseConfig(candidate: CandidateGroup): EnemyConfig {
  const seed = DEFAULT_ENEMY_CONFIGS[candidate.enemyKey];
  if (!seed) {
    // Unknown archetype — construct a minimal config from the candidate.
    return {
      key: candidate.enemyKey,
      displayName: candidate.enemyKey,
      formationKind: 'v' as EnemyFormationKind,
      count: candidate.baseCount,
      spacingX: 30,
      spacingY: 26,
      driftSpeed: 40,
      startX: 320,
      startY: 240,
      size: 16,
      color: 0x00ff00,
      bulletColor: 0xff4444,
      bulletSize: 3,
      shotPattern: 'aimed' as EnemyShotPattern,
      fireInterval: 1200,
      bulletSpeed: 200,
      bulletLifetime: 1.5,
      burstCount: 1,
      shotProbability: 1.0,
      health: 1,
    };
  }
  // Merge the candidate's overrides onto the seed.
  return {
    ...seed,
    count: candidate.baseCount,
  };
}

/**
 * Apply adjustable field mutations to a candidate and return the tuned group.
 *
 * Uses binary search over `count` (the primary adjustable field) because
 * the difficulty score is monotonically increasing in count.  Stops when
 * the score is within `tolerance` of `target` or the search space is
 * exhausted.
 */
export function adjustGroupForTarget(
  candidate: CandidateGroup,
  baseConfig: EnemyConfig,
  target: number,
  tolerance: number,
  _maxIterations: number = DEFAULT_MAX_ITERATIONS,
): AdjustedGroup {
  const countMin = clamp(candidate.minCount, 1, 200);
  const countMax = clamp(candidate.maxCount, 1, 200);

  let lo = countMin;
  let hi = countMax;
  let best: AdjustedGroup | null = null;

  // Evaluate the base count first (caller's starting point).
  const baseConfigForCount = { ...baseConfig, count: candidate.baseCount };
  const baseResult = enemyDifficulty(baseConfigForCount);
  best = {
    enemyKey: candidate.enemyKey,
    formation: baseConfig.formationKind,
    count: candidate.baseCount,
    spacingX: baseConfig.spacingX,
    spacingY: baseConfig.spacingY,
    startX: baseConfig.startX,
    startY: baseConfig.startY,
    score: baseResult.score,
  };

  // Evaluate endpoints.
  for (const count of [countMin, countMax]) {
    const config = { ...baseConfig, count };
    const result = enemyDifficulty(config);
    const adjusted: AdjustedGroup = {
      enemyKey: candidate.enemyKey,
      formation: config.formationKind,
      count,
      spacingX: config.spacingX,
      spacingY: config.spacingY,
      startX: config.startX,
      startY: config.startY,
      score: result.score,
    };
    if (!best || Math.abs(adjusted.score - target) < Math.abs(best.score - target)) {
      best = adjusted;
    }
  }

  // Binary search over the count range.
  while (lo <= hi && Math.abs((best?.score ?? 0) - target) > tolerance) {
    const mid = Math.round((lo + hi) / 2);
    const config = { ...baseConfig, count: mid };
    const result = enemyDifficulty(config);
    const adjusted: AdjustedGroup = {
      enemyKey: candidate.enemyKey,
      formation: config.formationKind,
      count: mid,
      spacingX: config.spacingX,
      spacingY: config.spacingY,
      startX: config.startX,
      startY: config.startY,
      score: result.score,
    };

    if (Math.abs(adjusted.score - target) < Math.abs((best?.score ?? 0) - target)) {
      best = adjusted;
    }

    if (result.score < target) {
      lo = mid + 1;
    } else if (result.score > target) {
      hi = mid - 1;
    } else {
      break; // exact match.
    }
  }

  return best!;
}

/**
 * Evaluate a candidate against a target and return the adjusted group
 * (without tuning — base count only).
 */
function evaluateCandidate(
  candidate: CandidateGroup,
  target: number,
  tolerance: number,
  maxIterations: number,
): { adjusted: AdjustedGroup; error: number } {
  const baseConfig = resolveBaseConfig(candidate);
  const adjusted = adjustGroupForTarget(candidate, baseConfig, target, tolerance, maxIterations);
  const error = Math.abs(adjusted.score - target);
  return { adjusted, error };
}

/**
 * True when the named archetype fires projectiles (used to derive a composed
 * wave's `shootEnabled` flag when the caller does not force it).
 */
function groupFires(enemyKey: string, count: number): boolean {
  const base = resolveBaseConfig({
    enemyKey,
    baseCount: count,
    minCount: count,
    maxCount: count,
    adjustableFields: [],
  });
  return base.shotPattern !== 'none';
}

/**
 * Greedily add candidate groups to a wave until the summed difficulty of the
 * wave is within `tolerance` of `target`, or no additional group improves it.
 *
 * Each added group is tuned against the *remaining gap* (`target − total`),
 * so the composed wave lands on the target rather than re-aiming at it. Ties
 * are broken in favour of archetypes that have not yet been used, which keeps
 * high-difficulty waves varied instead of stacking one saturated archetype.
 *
 * @returns the (possibly grown) groups and their summed score.
 */
function composeWaveGroups(
  initial: AdjustedGroup,
  target: number,
  candidates: CandidateGroup[],
  tolerance: number,
  maxIterations: number,
  maxGroups: number,
): { groups: AdjustedGroup[]; total: number } {
  const groups: AdjustedGroup[] = [initial];
  let total = initial.score;
  let error = Math.abs(total - target);
  const used = new Map<string, number>([[initial.enemyKey, 1]]);

  while (error > tolerance && groups.length < maxGroups) {
    const residual = target - total;
    let choice: {
      adjusted: AdjustedGroup;
      error: number;
      used: number;
    } | null = null;

    for (const candidate of candidates) {
      const baseConfig = resolveBaseConfig(candidate);
      const adjusted = adjustGroupForTarget(
        candidate,
        baseConfig,
        residual,
        tolerance,
        maxIterations,
      );
      if (adjusted.score <= 0) continue;

      const nextError = Math.abs(total + adjusted.score - target);
      const usedCount = used.get(candidate.enemyKey) ?? 0;

      if (
        !choice ||
        nextError < choice.error - COMPOSE_EPSILON ||
        (Math.abs(nextError - choice.error) <= COMPOSE_EPSILON &&
          usedCount < choice.used)
      ) {
        choice = { adjusted, error: nextError, used: usedCount };
      }
    }

    // No candidate improves the wave — stop rather than overshoot it.
    if (!choice || choice.error >= error - COMPOSE_EPSILON) break;

    groups.push(choice.adjusted);
    total += choice.adjusted.score;
    error = choice.error;
    used.set(choice.adjusted.enemyKey, (used.get(choice.adjusted.enemyKey) ?? 0) + 1);
  }

  return { groups, total };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run the auto-sequencer: given a target difficulty curve and a pool of
 * candidate enemy groups, produce wave definitions that best approximate
 * the targets.
 *
 * For each wave in the curve:
 * 1. Evaluate every candidate (using `adjustGroupForTarget` to fine-tune).
 * 2. Pick the candidate with the smallest absolute error.
 * 3. Record the adjusted group and the error.
 *
 * The result is a {@link SequencerResult} containing the waves and errors.
 *
 * @param curve — the target difficulty curve (one score per wave).
 * @param candidates — the pool of enemy groups to choose from.
 * @param options — sequencer tuning options.
 * @returns the sequencer result.
 */
export function sequencer(
  curve: DifficultyCurveConfig,
  candidates: CandidateGroup[],
  options: SequencerOptions = {},
): SequencerResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Validate candidates.
  for (const c of candidates) {
    if (c.minCount > c.maxCount) {
      throw new Error(
        `Candidate "${c.enemyKey}": minCount (${c.minCount}) must be <= maxCount (${c.maxCount})`,
      );
    }
  }

  const waves: ShootableWave[] = [];
  const errors: number[] = [];

  for (let wi = 0; wi < curve.length; wi++) {
    const target = curve[wi];
    let bestResult: { adjusted: AdjustedGroup; error: number } | null = null;

    for (const candidate of candidates) {
      const result = evaluateCandidate(candidate, target, tolerance, maxIterations);
      if (!bestResult || result.error < bestResult.error) {
        bestResult = result;
      }
    }

    // If no candidates were provided, create an empty wave.
    if (!bestResult) {
      waves.push({
        groups: [],
        shootEnabled: options.defaultShootEnabled ?? false,
        targetDifficulty: target,
      });
      errors.push(0);
      continue;
    }

    // Compose the wave: start from the best single group and, if it cannot
    // reach the target, add further groups until it does (or no improvement
    // remains). This is what lets targets above a single archetype's ceiling
    // be met with varied compositions (AH-0MUGXDVPH005TIZL).
    const composed =
      options.allowMultipleGroups === false
        ? { groups: [bestResult.adjusted], total: bestResult.adjusted.score }
        : composeWaveGroups(
            bestResult.adjusted,
            target,
            candidates,
            tolerance,
            maxIterations,
            options.maxGroupsPerWave ?? DEFAULT_MAX_GROUPS_PER_WAVE,
          );

    const shootEnabled =
      options.defaultShootEnabled ??
      composed.groups.some((group) => groupFires(group.enemyKey, group.count));

    waves.push({
      groups: composed.groups,
      shootEnabled,
      targetDifficulty: target,
    });
    errors.push(Math.round(Math.abs(composed.total - target) * 100) / 100);
  }

  return { waves, errors };
}

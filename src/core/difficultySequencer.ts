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
import type { EnemyMovementClass } from './configTypes';
import type { WaveGroup } from '../waves/Formations';
import {
  classifyArchetype,
  classifyWaveGroups,
  checkNoAllChaser,
  checkBoundedRangedMix,
  CHASER_MOVEMENT_CLASS,
  type ArchetypeClassification,
} from './waveBalance';

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

/**
 * Rule-constraint context supplied by the caller (e.g. the campaign builder).
 *
 * The campaign builder sets `allowedMovementClasses` for R1 opening-wave
 * curation (F4, `sequencedLevels.ts`): only archetypes whose `movementClass`
 * is in this array are eligible for the opening-wave candidate pool.
 */
export interface SequencerRuleConstraints {
  /**
   * Movement classes the caller is happy to see in this wave's candidate pool.
   *
   * Passed by the campaign builder for R1 opening-wave curation (F4):
   * `['formation', 'diver']` so that only R1-compliant archetypes enter
   * the opening-wave candidate pool.  Absent — or `undefined` — means
   * no movement-class filtering.
   */
  allowedMovementClasses?: readonly EnemyMovementClass[];
}

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
  /**
   * Maximum number of waves within a single level in which one archetype may
   * appear (the per-level archetype repetition cap).
   *
   * Defaults to {@link MAX_ARCHETYPE_PER_LEVEL}. Pass `Infinity` to disable
   * the cap.
   */
  maxArchetypePerLevel?: number;
  /**
   * Optional cross-call archetype-usage tracker.
   *
   * The campaign builder shares one map across a level's per-wave
   * `sequencer()` calls so the per-level cap spans the whole level. The
   * sequencer reads and updates the map in place. When absent, a fresh map is
   * created per call, so the cap applies across the supplied curve.
   */
  archetypeUsage?: Map<string, number>;
  /**
   * Rule-constraint context passed by the caller.
   *
   * The campaign builder supplies `allowedMovementClasses` for R1
   * opening-wave curation (F4).  The sequencer uses this to filter the
   * candidate pool for the wave, so that only archetypes whose
   * `movementClass` is in the array can be selected.
   */
  ruleConstraints?: SequencerRuleConstraints;
  /**
   * Whether the composed wave is validated and repaired against the hard
   * balance rules (R2 no-all-chaser, R3 bounded ranged mix) using the
   * shared rule module (`src/core/waveBalance.ts`).
   *
   * Enabled by default for every generated wave. Passing `false` disables
   * enforcement and returns the raw greedily-composed wave (useful for
   * tools that want the unconstrained preview). Rules win over exact target
   * match: a repair may grow the difficulty error because a compliant
   * composition is preferred over a closer non-compliant one.
   * @default true
   */
  enforceRules?: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_TOLERANCE = 10;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_GROUPS_PER_WAVE = 5;
/** Ignore floating-point noise when comparing candidate errors. */
const COMPOSE_EPSILON = 1e-9;

/**
 * Maximum number of waves within a single level in which any one enemy
 * archetype may appear (the per-level archetype repetition cap).
 *
 * The sequencer minimises error against the difficulty target with no notion
 * of composition, so before this cap the highest-rated archetype (the Phaser's
 * `orbital` formation, ordinal 5 in `enemyDifficulty`'s `formationKind`)
 * was selected for **every** wave once the target crossed ~30 — collapsing the
 * late game onto a single movement style (AH-0MV2SGIX5005PFJT). A cap of `1`
 * keeps each archetype to at most one wave per level; raise it to relax the
 * rule, or pass `Infinity` to disable it.
 *
 * The cap is applied across a whole level by the campaign builder
 * (`src/waves/sequencedLevels.ts`), which shares one {@link
 * SequencerOptions.archetypeUsage} map across the level's per-wave calls. It
 * only constrains `curve`/`dynamic` (generated) waves — an authored `fixed`
 * wave is never sequenced and may still use any archetype.
 */
export const MAX_ARCHETYPE_PER_LEVEL = 1;

/**
 * The default candidate pool — one entry per seed archetype the sequencer may
 * select as a wave group, with sensible count ranges and count as the only
 * adjustable field.
 *
 * Three archetypes are deliberately excluded because they are delivered by
 * their own spawners:
 *
 * - the **Grunt homing horde** (classic-arcade archetype,
 *   AH-0MV01EKTL001NRE6) is a timed edge-spawning pack delivered by the
 *   dedicated `HordeSpawner`, gated behind a per-wave `horde: true` opt-in —
 *   it is not a static wave group;
 * - the **Harvester** (F6) is a rare later-level roaming spawn delivered by
 *   the dedicated `HarvesterSpawner`;
 * - the **Asteroid** is delivered by the dedicated random offscreen spawner
 *   (`AsteroidSpawner`) and is explicitly **not wave-accounted** by the game:
 *   `PlayScene._onEnemyKilled()` never advances wave progression for an
 *   asteroid kill (AH-0MUJM746P000QAEO). A sequenced wave group containing an
 *   asteroid would be counted by `WaveManager.waveEnemyCount()` but never
 *   un-counted, so the wave would never clear, soft-locking the run and making
 *   the boss unreachable (AH-0MUR1HZLQ001ELX9). Excluding it keeps the
 *   "asteroids are not wave-accounted" contract intact.
 *
 * These defaults can be customised by the caller to give the sequencer
 * a wider (or narrower) set of tuning options.
 */
export function defaultCandidatePool(): CandidateGroup[] {
  return Object.entries(DEFAULT_ENEMY_CONFIGS)
    // See the JSDoc above: both archetypes are delivered by their own
    // spawners and must never be selected as a wave group.
    .filter(([key]) => key !== 'harvester' && key !== 'asteroid' && key !== 'grunt')
    .map(([key, cfg]) => {
      // `single`-formation archetypes (e.g. the Boss Swarm) spawn exactly one
      // entity per group regardless of `count` (`buildSingleOffset` ignores its
      // argument). `waveEnemyCount` now derives from the planned spawns, so an
      // over-declared `single` group can no longer inflate the alive count, but
      // `count` must still be `1` for the group to pass `validateWaveGroups`.
      // Pin the range to the archetype's own count instead of scaling it.
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
      movementClass: 'formation',
      attackClass: 'projectile',
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
  suppressFiring = false,
): AdjustedGroup {
  const countMin = clamp(candidate.minCount, 1, 200);
  const countMax = clamp(candidate.maxCount, 1, 200);

  // Only pass `suppressFiring` when set: omitting it keeps the archetype's own
  // auto-suppression rule (e.g. the non-firing Asteroid), which passing an
  // explicit `false` would override.
  const scoreOptions = suppressFiring ? { suppressFiring: true } : undefined;

  let lo = countMin;
  let hi = countMax;
  let best: AdjustedGroup | null = null;

  // Evaluate the base count first (caller's starting point).
  const baseConfigForCount = { ...baseConfig, count: candidate.baseCount };
  const baseResult = enemyDifficulty(baseConfigForCount, scoreOptions);
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
    const result = enemyDifficulty(config, scoreOptions);
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
    const result = enemyDifficulty(config, scoreOptions);
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
  suppressFiring = false,
): { adjusted: AdjustedGroup; error: number } {
  const baseConfig = resolveBaseConfig(candidate);
  const adjusted = adjustGroupForTarget(
    candidate,
    baseConfig,
    target,
    tolerance,
    maxIterations,
    suppressFiring,
  );
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
  suppressFiring = false,
  isAllowed: (enemyKey: string) => boolean = () => true,
): { groups: AdjustedGroup[]; total: number } {
  const groups: AdjustedGroup[] = [initial];
  let total = initial.score;
  let error = Math.abs(total - target);
  const used = new Map<string, number>([[initial.enemyKey, 1]]);

  // Respect the per-level archetype cap when adding groups. If every
  // candidate is already at the cap, fall back to the full pool so the wave
  // can never be starved into an empty composition.
  const allowedCandidates = candidates.filter((candidate) =>
    isAllowed(candidate.enemyKey),
  );
  const compositionPool =
    allowedCandidates.length > 0 ? allowedCandidates : candidates;

  while (error > tolerance && groups.length < maxGroups) {
    const residual = target - total;
    let choice: {
      adjusted: AdjustedGroup;
      error: number;
      used: number;
    } | null = null;

    for (const candidate of compositionPool) {
      const baseConfig = resolveBaseConfig(candidate);
      const adjusted = adjustGroupForTarget(
        candidate,
        baseConfig,
        residual,
        tolerance,
        maxIterations,
        suppressFiring,
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

// ── Rule enforcement (R2 / R3) ──────────────────────────────────────

/**
 * Validate and, when needed, repair a composed wave so it satisfies the
 * hard balance rules R2 (no all-chaser wave) and R3 (bounded ranged mix).
 *
 * The rules are evaluated **after** composition because the greedy scorer
 * has no intrinsic notion of the classification constraints. When a rule
 * is violated the sequencer repairs the wave *in place* via
 * {@link repairForRule}: it adds (or swaps in) a compliant candidate
 * tuned to the remaining target gap, so the wave stays playable but never
 * violates the constraint.
 *
 * **Precedence: rules win over exact target match.** A repair may grow the
 * difficulty error; the sequencer returns the best error-minimising
 * compliant composition available within the constrained candidate space
 * (as filtered by the caller's R1 context and the per-level archetype
 * cap).
 *
 * Rules are applied through the shared rule module
 * (`src/core/waveBalance.ts`) — `checkNoAllChaser` / `checkBoundedRangedMix`
 * and `classifyArchetype` — so the rules remain a single source of truth
 * (parent Q1=c); no rule logic is re-implemented here. No-fire waves pass
 * R3 by construction (effective-attack semantics, producer Q1) and are
 * never forced to add a contact group. Rules only ever inspect `curve` /
 * `dynamic` output — authored `fixed` waves are never sequenced.
 *
 * Determinism: every step is a pure function of its inputs (no
 * randomness), so rule enforcement never breaks seeded reproducibility.
 */
function enforceRules(
  groups: AdjustedGroup[],
  shootEnabled: boolean,
  target: number,
  candidates: CandidateGroup[],
  tolerance: number,
  maxIterations: number,
  suppressFiring: boolean,
  isAllowed: (enemyKey: string) => boolean,
  movementAllowed: (enemyKey: string) => boolean,
  maxGroups: number,
  canAddGroups: boolean,
): AdjustedGroup[] {
  if (groups.length === 0) return groups;

  let current = groups;
  // Bounded repair loop: each pass fixes one violating rule; a fix may in
  // principle perturb the other rule (e.g. swapping in a firing ranged
  // non-chaser), so re-check until stable or the budget runs out. The
  // budget is far beyond the number of groups the sequencer can compose.
  for (let pass = 0; pass < 4; pass++) {
    const classified = classifyWaveGroups(current);

    // R2 — no all-chaser wave.
    if (!checkNoAllChaser(classified).pass) {
      current = repairForRule(
        current,
        target,
        candidates,
        tolerance,
        maxIterations,
        suppressFiring,
        isAllowed,
        movementAllowed,
        maxGroups,
        canAddGroups,
        (classification) =>
          classification.movementClass !== CHASER_MOVEMENT_CLASS,
      );
      continue;
    }

    // R3 — bounded ranged mix (effective-attack semantics: a no-fire
    // wave already passes, so repair is only reached when firing).
    if (!checkBoundedRangedMix(classified, shootEnabled).pass) {
      current = repairForRule(
        current,
        target,
        candidates,
        tolerance,
        maxIterations,
        suppressFiring,
        isAllowed,
        movementAllowed,
        maxGroups,
        canAddGroups,
        (classification) => classification.attackClass === 'contact',
      );
      continue;
    }

    return current;
  }
  return current;
}

/**
 * Repair one rule violation by introducing a compliant candidate from the
 * caller-supplied pool: add it when the wave still has room (or multiple
 * groups are allowed), otherwise swap it in for an offending group.
 *
 * Candidate selection preferences, in order:
 *
 * 1. only candidates that meet the rule's classification predicate and the
 *    caller's R1 movement-class constraint;
 * 2. of those, candidates not yet at the per-level archetype cap (falling
 *    back to the full qualifying pool when every qualifying candidate is at
 *    the cap — mirroring the composition pool's never-starve fallback);
 * 3. the candidate whose tuned score lands closest to the required
 *    residual, so the repaired wave stays as close to `target` as the
 *    constraint allows.
 *
 * When no compliant candidate exists in the pool, the wave is returned
 * unchanged (the constraint cannot be satisfied by any available
 * archetype — never an empty result).
 *
 * @param matches — predicate selecting archetypes that satisfy the violated
 *   rule (e.g. `attackClass === 'contact'` for R3, non-chaser for R2).
 */
function repairForRule(
  groups: AdjustedGroup[],
  target: number,
  candidates: CandidateGroup[],
  tolerance: number,
  maxIterations: number,
  suppressFiring: boolean,
  isAllowed: (enemyKey: string) => boolean,
  movementAllowed: (enemyKey: string) => boolean,
  maxGroups: number,
  canAddGroups: boolean,
  matches: (classification: ArchetypeClassification) => boolean,
): AdjustedGroup[] {
  const rulePool = candidates.filter(
    (candidate) =>
      movementAllowed(candidate.enemyKey) &&
      matches(classifyArchetype(candidate.enemyKey)),
  );
  if (rulePool.length === 0) return groups;

  const total = groups.reduce((sum, group) => sum + group.score, 0);

  // Prefer repair archetypes not yet at the per-level cap; when every one
  // is already used, fall back to the full qualifying pool so a repair can
  // never be starved into silence.
  const qualifying = rulePool.filter((candidate) =>
    isAllowed(candidate.enemyKey),
  );
  const repairPool = qualifying.length > 0 ? qualifying : rulePool;

  const bestRepair = (residual: number): AdjustedGroup | null => {
    let best: AdjustedGroup | null = null;
    for (const candidate of repairPool) {
      const adjusted = adjustGroupForTarget(
        candidate,
        resolveBaseConfig(candidate),
        residual,
        tolerance,
        maxIterations,
        suppressFiring,
      );
      if (
        !best ||
        Math.abs(adjusted.score - residual) <
          Math.abs(best.score - residual)
      ) {
        best = adjusted;
      }
    }
    return best;
  };

  const canAdd = canAddGroups && groups.length < maxGroups;
  if (canAdd) {
    // Add the compliant group tuned to the remaining gap, keeping the
    // composed total as close to the target as the constraint allows.
    const repair = bestRepair(target - total);
    if (!repair) return groups;
    return [...groups, repair];
  }

  // No room to add (a single-group contract, or the wave is full): swap
  // an offending group for a compliant archetype, retuned to the offending
  // group's contribution so the total stays near target.
  const offenderIndex = groups.findIndex(
    (group) => !matches(classifyArchetype(group.enemyKey)),
  );
  if (offenderIndex < 0) return groups;
  const offenderScore = groups[offenderIndex].score;
  const swapResidual = target - (total - offenderScore);
  const repair = bestRepair(swapResidual);
  if (!repair) return groups;
  return groups.map((group, index) =>
    index === offenderIndex ? repair : group,
  );
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
 * **Balance-rule enforcement (parent AH-0MV29XQ0H009P9WP, F3).** Every
 * generated wave is validated against the hard balance rules R2
 * (no all-chaser wave) and R3 (bounded ranged mix) using the shared rule
 * module (`src/core/waveBalance.ts`), and repaired in place when violated
 * (see {@link enforceRules}). An R1 opening-wave constraint is supplied by
 * the caller through {@link SequencerOptions.ruleConstraints} — the pure
 * sequencer cannot know wave position, so the campaign builder narrows the
 * candidate pool to the R1-allowed movement classes (F4). Rules win over
 * exact target match: the sequencer returns the best error-minimising
 * composition within the rule-constrained candidate space.
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
  // A wave that does not fire must be scored without firing factors, so the
  // sequencer selects a composition that is genuinely appropriate for a
  // non-firing wave (AH-0MUOCJM0N000RW2B). When the caller does not declare
  // the fire rule, keep the archetype-level default (no forced suppression).
  const suppressFiring = options.defaultShootEnabled === false;
  // Per-level archetype repetition cap (AH-0MV2SGIX5005PFJT). `usage` counts
  // the waves each archetype has already appeared in; a shared map lets the
  // campaign builder carry the count across a level's per-wave calls.
  const maxArchetypePerLevel =
    options.maxArchetypePerLevel ?? MAX_ARCHETYPE_PER_LEVEL;
  const usage = options.archetypeUsage ?? new Map<string, number>();
  const isAllowed = (enemyKey: string): boolean =>
    (usage.get(enemyKey) ?? 0) < maxArchetypePerLevel;

  // R1 opening-wave constraint (F3): when the caller supplies the allowed
  // movement classes, only archetypes whose classification matches may be
  // selected. The classification is resolved through the shared rule module
  // (`classifyArchetype`), so no rule knowledge is duplicated here.
  const allowedMovementClasses =
    options.ruleConstraints?.allowedMovementClasses;
  const movementAllowed = (enemyKey: string): boolean =>
    allowedMovementClasses
      ? allowedMovementClasses.includes(
          classifyArchetype(enemyKey).movementClass,
        )
      : true;
  // Hard-constraint enforcement (R2 / R3) is on by default for every
  // generated wave.
  const enforceRulesEnabled = options.enforceRules !== false;
  const maxGroups = options.maxGroupsPerWave ?? DEFAULT_MAX_GROUPS_PER_WAVE;

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

    // Exclude archetypes already at the per-level cap (and, when R1 context
    // is supplied, archetypes outside the caller's allowed movement
    // classes). If every candidate is excluded, fall back to the full pool
    // so the wave cannot be empty.
    const allowedCandidates = candidates.filter(
      (candidate) =>
        isAllowed(candidate.enemyKey) &&
        movementAllowed(candidate.enemyKey),
    );
    const selectionPool =
      allowedCandidates.length > 0 ? allowedCandidates : candidates;

    for (const candidate of selectionPool) {
      const result = evaluateCandidate(
        candidate,
        target,
        tolerance,
        maxIterations,
        suppressFiring,
      );
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
            maxGroups,
            suppressFiring,
            (enemyKey) =>
              isAllowed(enemyKey) && movementAllowed(enemyKey),
          );

    const shootEnabled =
      options.defaultShootEnabled ??
      composed.groups.some((group) => groupFires(group.enemyKey, group.count));

    // Balance-rule enforcement (F3): validate the composed wave against R2 /
    // R3 via the shared rule module and repair it in place when a rule is
    // violated. Rules win over exact target match — enforcement may grow the
    // error (recorded in `errors`). A single-group contract
    // (`allowMultipleGroups: false`) is honoured by swapping rather than
    // adding, so the wave count never grows past the caller's intent.
    const enforcedGroups = enforceRulesEnabled
      ? enforceRules(
          composed.groups,
          shootEnabled,
          target,
          candidates,
          tolerance,
          maxIterations,
          suppressFiring,
          isAllowed,
          movementAllowed,
          maxGroups,
          options.allowMultipleGroups !== false,
        )
      : composed.groups;
    const enforcedTotal = enforcedGroups.reduce(
      (sum, group) => sum + group.score,
      0,
    );

    // Record this wave against every archetype it used, so later waves in the
    // same level respect the cap.
    for (const enemyKey of new Set(
      enforcedGroups.map((group) => group.enemyKey),
    )) {
      usage.set(enemyKey, (usage.get(enemyKey) ?? 0) + 1);
    }

    waves.push({
      groups: enforcedGroups,
      shootEnabled,
      targetDifficulty: target,
    });
    errors.push(Math.round(Math.abs(enforcedTotal - target) * 100) / 100);
  }

  return { waves, errors };
}

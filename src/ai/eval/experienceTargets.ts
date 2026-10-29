/**
 * Intended-experience targets and the pure human-experience comparator
 * (AH-0MV7WVHU0000U775).
 *
 * The automated-balancing framework records **what the game did** (a
 * {@link BalanceReport} of measured bot or human statistics). This module
 * records **what the game is supposed to do**: a versioned, machine-checkable
 * *targets* artifact derived from a recorded bot batch, plus a pure comparator
 * that decides whether a measured experience still sits inside those bands.
 *
 * Separation of concerns:
 *
 * - {@link deriveExperienceTargets} turns a bot baseline `BalanceAggregate`
 *   into bands (centre = baseline mean, tolerance = a documented multiple of
 *   the baseline std-dev with a relative floor) — the single machine-checkable
 *   statement of intended experience.
 * - {@link validateExperienceTargets} validates a targets artifact (the JSON
 *   file in `src/data/experience-targets.json`) against the schema.
 * - {@link compareExperience} compares a **human or bot** `BalanceAggregate`
 *   against the targets and returns, per metric, the measured value, the band,
 *   the signed drift and a pass/fail verdict.
 * - {@link buildExperienceValidationReport} packages that comparison as a
 *   versioned, byte-stable JSON report plus a Markdown summary.
 *
 * The comparator and the report builders are **pure**: no wall clock, no I/O,
 * no randomness. The on-demand CLI (`scripts/validate-experience.mjs`) owns
 * file reading/writing and the exit code.
 *
 * A green **bot** run only proves the bot baseline has not drifted; the
 * targets exist to judge the **human** experience (see
 * `docs/EXPERIENCE_VALIDATION.md` and the risk note in `docs/BALANCING.md`).
 *
 * @module src/ai/eval/experienceTargets
 */

import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  EVAL_DATASET_VERSION,
  type BalanceAggregate,
  type DistributionStats,
} from './types';
import { stableStringify } from './report';

/**
 * Version of the **targets artifact schema**
 * ({@link ExperienceTargets}). Bump on a backwards-incompatible shape change
 * so a consumer can key a migration off it. The band *values* have their own
 * {@link ExperienceTargets.targetsVersion}, bumped whenever the artifact is
 * re-derived from a new baseline.
 */
export const EXPERIENCE_TARGETS_SCHEMA_VERSION = 1;

/**
 * The metrics every targets artifact must carry (AC1): the key metrics of the
 * shared `BalanceAggregate` schema that describe the intended experience —
 * survival, pacing (wave/level progress), economy (minerals, upgrades) and
 * challenge (avoidable hits).
 */
export const EXPERIENCE_TRACKED_METRICS = Object.freeze([
  'survivalSeconds',
  'mineralsCollected',
  'upgradesSelected',
  'waveReached',
  'levelReached',
  'avoidableHits',
] as const);

/** A key metric of the intended experience. */
export type ExperienceMetric = (typeof EXPERIENCE_TRACKED_METRICS)[number];

/** Human-readable labels used by the Markdown summary. */
export const EXPERIENCE_METRIC_LABELS: Readonly<Record<ExperienceMetric, string>> =
  Object.freeze({
    survivalSeconds: 'survival (s)',
    mineralsCollected: 'minerals collected',
    upgradesSelected: 'upgrades selected / run',
    waveReached: 'wave reached',
    levelReached: 'level reached',
    avoidableHits: 'avoidable hits',
  });

/** One metric's intended band: a centre plus a symmetric tolerance. */
export interface ExperienceTargetBand {
  readonly metric: ExperienceMetric;
  /** The band centre (the bot baseline's mean for the metric). */
  readonly centre: number;
  /** The symmetric half-width of the band around {@link centre}. */
  readonly tolerance: number;
}

/**
 * The bot batch a targets artifact was derived from. Recorded so an artifact
 * is self-describing and a re-baseline is auditable.
 */
export interface ExperienceBaselineSource {
  /** Always a bot batch — the chosen source of intended experience. */
  readonly kind: 'bot-baseline';
  readonly policy: string;
  readonly games: number;
  readonly ticks: number;
  readonly campaign: boolean;
  readonly level: number | null;
  /** State-sampling stride the baseline batch recorded at (1 = every tick). */
  readonly sampleEveryTicks: number;
  readonly seeds: {
    readonly count: number;
    readonly first: number;
    readonly last: number;
  };
}

/**
 * The documented tolerance rule (AC1/risk "tolerance tuning"): a band is wide
 * enough to absorb normal run-to-run variance, but narrow enough to catch a
 * real regression. `tolerance = max(stdDevMultiplier × baseline stdDev,
 * relativeFloor × |centre|, minAbsoluteTolerance)`.
 *
 * `upgradesSelected` is a **per-key map** in the shared schema, so it has no
 * single baseline std-dev; its band uses the wider
 * {@link ExperienceToleranceRule.upgradesRelativeFloor} instead, documented in
 * the artifact so the rule is never implicit.
 */
export interface ExperienceToleranceRule {
  readonly stdDevMultiplier: number;
  readonly relativeFloor: number;
  readonly upgradesRelativeFloor: number;
  readonly minAbsoluteTolerance: number;
}

/** The default tolerance rule (see {@link ExperienceToleranceRule}). */
export const DEFAULT_EXPERIENCE_TOLERANCE_RULE: ExperienceToleranceRule =
  Object.freeze({
    stdDevMultiplier: 2,
    relativeFloor: 0.1,
    upgradesRelativeFloor: 0.25,
    minAbsoluteTolerance: 0.5,
  });

/** A versioned, machine-checkable statement of the intended experience. */
export interface ExperienceTargets {
  /** Version of the targets artifact schema ({@link EXPERIENCE_TARGETS_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  /** Version of the **band values** (bump on every re-baseline). */
  readonly targetsVersion: number;
  /** The shared balance-statistics schema the bands were derived from. */
  readonly balanceSchemaVersion: number;
  /** The evaluation dataset version the baseline batch was run with. */
  readonly datasetVersion: number;
  readonly kind: 'experience-targets';
  /** The baseline batch the bands were derived from. */
  readonly source: ExperienceBaselineSource;
  /** The structured tolerance rule, recorded for auditability. */
  readonly toleranceRule: ExperienceToleranceRule;
  /** The tolerance rule as prose, mirrored into the docs. */
  readonly toleranceRuleText: string;
  /** One band per {@link EXPERIENCE_TRACKED_METRICS} entry. */
  readonly bands: Readonly<Record<ExperienceMetric, ExperienceTargetBand>>;
}

/** The default tolerance rule, described in prose (kept next to the rule). */
export const EXPERIENCE_TOLERANCE_RULE_TEXT =
  'tolerance = max(2 x baseline stdDev, 10% of |centre|, 0.5); ' +
  'upgradesSelected uses max(25% of |centre|, 0.5) because the shared schema ' +
  'aggregates it as a per-key map with no single stdDev; bands are recorded ' +
  'to 4 decimal places';

/** Error raised for a malformed targets artifact or balance report. */
export class ExperienceTargetsError extends Error {
  readonly code:
    | 'invalid-targets'
    | 'invalid-report'
    | 'no-baseline-data'
    | 'schema-mismatch';

  constructor(code: ExperienceTargetsError['code'], message: string) {
    super(message);
    this.name = 'ExperienceTargetsError';
    this.code = code;
  }
}

/** Rounding applied to derived band values (documented in the artifact). */
export const EXPERIENCE_BAND_DECIMALS = 4;

/** Rounds a derived band value deterministically (removes float noise). */
function roundBand(value: number): number {
  const factor = 10 ** EXPERIENCE_BAND_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** A metric's measured scalar value plus the number of contributing runs. */
export interface ExperienceMeasurement {
  readonly value: number;
  readonly runs: number;
}

/** A per-metric drift verdict. */
export type ExperienceVerdict =
  | 'in-band'
  | 'above-band'
  | 'below-band'
  | 'missing';

/** One metric's comparison against its intended band. */
export interface ExperienceMetricComparison {
  readonly metric: ExperienceMetric;
  /** `missing` when the supplied aggregate carries no measurement. */
  readonly verdict: ExperienceVerdict;
  /** The measured value, or `null` when the metric is missing. */
  readonly measured: number | null;
  readonly centre: number;
  readonly tolerance: number;
  /** Inclusive lower band edge (`centre - tolerance`). */
  readonly lower: number;
  /** Inclusive upper band edge (`centre + tolerance`). */
  readonly upper: number;
  /** Signed drift `measured - centre`, or `null` when missing. */
  readonly drift: number | null;
  /**
   * Signed drift relative to the band centre (`drift / |centre|`), or `null`
   * when the metric is missing or the centre is zero (undefined there).
   */
  readonly relativeDrift: number | null;
  /** Whether the measurement sits inside the band (`false` when missing). */
  readonly withinTolerance: boolean;
}

/** The pure comparator's result over every tracked metric. */
export interface ExperienceComparison {
  readonly schemaVersion: number;
  readonly targetsVersion: number;
  /** One entry per {@link EXPERIENCE_TRACKED_METRICS} entry, in that order. */
  readonly metrics: readonly ExperienceMetricComparison[];
  /** Whether every metric was measured and inside its band. */
  readonly passed: boolean;
  /** Metrics outside their band (in tracked-metric order). */
  readonly driftedMetrics: readonly ExperienceMetric[];
  /** Metrics with no measurement in the supplied aggregate. */
  readonly missingMetrics: readonly ExperienceMetric[];
}

/** A `BalanceReport`-shaped input (the fields the validator consumes). */
export interface BalanceReportInput {
  readonly kind: 'balance';
  readonly schemaVersion: number;
  readonly datasetVersion: number;
  readonly config: {
    readonly policies: readonly string[];
    readonly campaign?: boolean;
    readonly level?: number;
    readonly ticks?: number;
    readonly seeds?: readonly number[];
    readonly sampleEveryTicks?: number;
  };
  readonly aggregate: BalanceAggregate;
}

/** The source labelled by a validation report. */
export interface ExperienceValidationSource {
  /** `human` for a recorded human report, otherwise `bot:<policy>`. */
  readonly label: string;
  readonly kind: 'human' | 'bot';
  readonly policies: readonly string[];
  readonly runs: number;
  /** Resolved harness mode, `null` for a human report (not a harness mode). */
  readonly campaign: boolean | null;
  readonly level: number | null;
}

/** A versioned, byte-stable human-experience validation artifact. */
export interface ExperienceValidationReport {
  readonly kind: 'experience-validation';
  /** Targets artifact schema version ({@link EXPERIENCE_TARGETS_SCHEMA_VERSION}). */
  readonly schemaVersion: number;
  /** The measured report's balance-statistics schema version. */
  readonly balanceSchemaVersion: number;
  /** The measured report's evaluation dataset version. */
  readonly datasetVersion: number;
  readonly targetsVersion: number;
  /** What was measured (human session or bot batch). */
  readonly source: ExperienceValidationSource;
  /** Where the bands came from (the recorded bot baseline). */
  readonly targetSource: ExperienceBaselineSource;
  readonly toleranceRuleText: string;
  readonly verdict: 'pass' | 'drift';
  readonly passed: boolean;
  readonly metrics: readonly ExperienceMetricComparison[];
  readonly driftedMetrics: readonly ExperienceMetric[];
  readonly missingMetrics: readonly ExperienceMetric[];
  /**
   * Deterministic notes about comparability (e.g. a bot report whose harness
   * mode differs from the baseline's). Never affects {@link passed}.
   */
  readonly warnings: readonly string[];
}

/** Coerces a finite number, else `null`. */
function finiteOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Coerces a finite positive number, else `null`. */
function positiveOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** Whether `value` is a non-null object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a scalar distribution for `metric` from an aggregate, if present. */
function scalarDistribution(
  aggregate: BalanceAggregate,
  metric: Exclude<ExperienceMetric, 'upgradesSelected'>,
): DistributionStats | null {
  const distribution = (aggregate as unknown as Record<string, unknown>)[metric];
  return isRecord(distribution) ? (distribution as unknown as DistributionStats) : null;
}

/**
 * Projects the shared `BalanceAggregate` onto one scalar measurement of an
 * intended-experience metric (AC1/AC2). Pure; never throws.
 *
 * All tracked metrics except `upgradesSelected` are scalar distributions in
 * the shared schema, measured by their mean. `upgradesSelected` is a per-key
 * map, projected as the **mean number of upgrade selections per run** (the sum
 * of the per-key means); a report whose map is absent is
 * {@link ExperienceVerdict} `missing`, while an empty map on a report with
 * runs is a legitimate measured `0`.
 *
 * Returns `null` for a missing metric: an absent/ malformed distribution, or a
 * distribution with no contributing runs (`count` 0).
 */
export function measureExperienceMetric(
  aggregate: BalanceAggregate,
  metric: ExperienceMetric,
): ExperienceMeasurement | null {
  if (!isRecord(aggregate)) return null;
  if (metric === 'upgradesSelected') {
    const perKey = (aggregate as unknown as Record<string, unknown>).upgradesSelected;
    if (!isRecord(perKey)) return null;
    const runs = finiteOrNull(aggregate.runs) ?? 0;
    let total = 0;
    for (const key of Object.keys(perKey)) {
      const distribution = perKey[key] as DistributionStats | undefined;
      if (!isRecord(distribution)) continue;
      const mean = finiteOrNull(distribution.mean);
      if (mean === null) continue;
      total += mean;
    }
    if (Object.keys(perKey).length === 0 && runs <= 0) return null;
    // Rounded like the derived bands so float noise in the per-key sum never
    // shows up as a spurious (if tiny) drift in the report.
    return { value: roundBand(total), runs };
  }
  const distribution = scalarDistribution(aggregate, metric);
  if (distribution === null) return null;
  const count = finiteOrNull(distribution.count);
  const mean = finiteOrNull(distribution.mean);
  if (count === null || count <= 0 || mean === null) return null;
  return { value: mean, runs: count };
}

/**
 * Derives the intended-experience bands from a recorded bot baseline
 * `BalanceAggregate` (AC1): centre = the baseline mean, tolerance from the
 * documented {@link ExperienceToleranceRule}.
 *
 * Throws {@link ExperienceTargetsError} (`no-baseline-data`) when the baseline
 * carries no measurement for a tracked metric — an intended band cannot be
 * invented from no data — and (`invalid-targets`) when `source` is malformed.
 */
export function deriveExperienceTargets(
  aggregate: BalanceAggregate,
  source: ExperienceBaselineSource,
  options: {
    readonly targetsVersion?: number;
    readonly toleranceRule?: Partial<ExperienceToleranceRule>;
  } = {},
): ExperienceTargets {
  const toleranceRule: ExperienceToleranceRule = Object.freeze({
    ...DEFAULT_EXPERIENCE_TOLERANCE_RULE,
    ...options.toleranceRule,
  });
  const targetsVersion = options.targetsVersion ?? 1;
  const bands = {} as Record<ExperienceMetric, ExperienceTargetBand>;
  for (const metric of EXPERIENCE_TRACKED_METRICS) {
    const measurement = measureExperienceMetric(aggregate, metric);
    if (measurement === null) {
      throw new ExperienceTargetsError(
        'no-baseline-data',
        `cannot derive an intended band for '${metric}': ` +
          'the baseline batch carries no measurement for it',
      );
    }
    const centre = measurement.value;
    const distribution =
      metric === 'upgradesSelected'
        ? null
        : scalarDistribution(aggregate, metric);
    const stdDev = distribution ? finiteOrNull(distribution.stdDev) ?? 0 : 0;
    const relativeFloor =
      metric === 'upgradesSelected'
        ? toleranceRule.upgradesRelativeFloor
        : toleranceRule.relativeFloor;
    const tolerance = Math.max(
      metric === 'upgradesSelected'
        ? 0
        : toleranceRule.stdDevMultiplier * stdDev,
      relativeFloor * Math.abs(centre),
      toleranceRule.minAbsoluteTolerance,
    );
    bands[metric] = Object.freeze({
      metric,
      centre: roundBand(centre),
      tolerance: roundBand(tolerance),
    });
  }

  return Object.freeze({
    schemaVersion: EXPERIENCE_TARGETS_SCHEMA_VERSION,
    targetsVersion,
    balanceSchemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    datasetVersion: EVAL_DATASET_VERSION,
    kind: 'experience-targets' as const,
    source: normaliseSource(source),
    toleranceRule,
    toleranceRuleText: EXPERIENCE_TOLERANCE_RULE_TEXT,
    bands: Object.freeze(bands),
  });
}

/** Validates and normalises a baseline source block. */
function normaliseSource(source: ExperienceBaselineSource): ExperienceBaselineSource {
  if (!isRecord(source) || source.kind !== 'bot-baseline') {
    throw new ExperienceTargetsError(
      'invalid-targets',
      "targets source.kind must be 'bot-baseline' (the chosen intended-experience source)",
    );
  }
  const policy = typeof source.policy === 'string' && source.policy.length > 0
    ? source.policy
    : null;
  if (policy === null) {
    throw new ExperienceTargetsError('invalid-targets', 'targets source.policy must be a non-empty string');
  }
  const games = positiveOrNull(source.games);
  const ticks = positiveOrNull(source.ticks);
  if (games === null || ticks === null) {
    throw new ExperienceTargetsError(
      'invalid-targets',
      'targets source.games and source.ticks must be positive numbers',
    );
  }
  if (typeof source.campaign !== 'boolean') {
    throw new ExperienceTargetsError('invalid-targets', 'targets source.campaign must be a boolean');
  }
  const level = source.level === null || source.level === undefined
    ? null
    : positiveOrNull(source.level);
  if (source.level !== null && source.level !== undefined && level === null) {
    throw new ExperienceTargetsError('invalid-targets', 'targets source.level must be null or a positive number');
  }
  const seeds: Record<string, unknown> = isRecord(source.seeds)
    ? source.seeds
    : {};
  const count = positiveOrNull(seeds.count) ?? games;
  const first = finiteOrNull(seeds.first) ?? 1;
  const last = finiteOrNull(seeds.last) ?? count;
  return Object.freeze({
    kind: 'bot-baseline' as const,
    policy,
    games,
    ticks,
    campaign: source.campaign,
    level,
    sampleEveryTicks: positiveOrNull(source.sampleEveryTicks) ?? 1,
    seeds: Object.freeze({ count, first, last }),
  });
}

/** Validates a tolerance-rule block, falling back to the defaults. */
function normaliseToleranceRule(
  raw: unknown,
): ExperienceToleranceRule {
  if (!isRecord(raw)) return DEFAULT_EXPERIENCE_TOLERANCE_RULE;
  const merged = { ...DEFAULT_EXPERIENCE_TOLERANCE_RULE };
  for (const key of Object.keys(DEFAULT_EXPERIENCE_TOLERANCE_RULE) as (keyof ExperienceToleranceRule)[]) {
    const value = finiteOrNull(raw[key]);
    if (value !== null && value >= 0) merged[key] = value;
  }
  return Object.freeze(merged);
}

/**
 * Validates a parsed targets artifact against the schema (AC1). Throws
 * {@link ExperienceTargetsError} with an actionable message on any structural
 * problem, so a malformed committed artifact fails loudly instead of silently
 * validating against invented bands.
 *
 * The result is a normalised copy carrying only known fields (deterministic
 * serialisation, no accidental extras).
 */
export function validateExperienceTargets(raw: unknown): ExperienceTargets {
  if (!isRecord(raw)) {
    throw new ExperienceTargetsError('invalid-targets', 'targets artifact must be a JSON object');
  }
  if (raw.kind !== 'experience-targets') {
    throw new ExperienceTargetsError(
      'invalid-targets',
      "targets artifact must declare kind: 'experience-targets'",
    );
  }
  if (raw.schemaVersion !== EXPERIENCE_TARGETS_SCHEMA_VERSION) {
    throw new ExperienceTargetsError(
      'schema-mismatch',
      `targets schema mismatch: got ${String(raw.schemaVersion)}, ` +
        `expected ${EXPERIENCE_TARGETS_SCHEMA_VERSION}`,
    );
  }
  if (raw.balanceSchemaVersion !== BALANCE_STATISTICS_SCHEMA_VERSION) {
    throw new ExperienceTargetsError(
      'schema-mismatch',
      `balance-statistics schema mismatch: got ${String(raw.balanceSchemaVersion)}, ` +
        `expected ${BALANCE_STATISTICS_SCHEMA_VERSION}`,
    );
  }
  const targetsVersion = positiveOrNull(raw.targetsVersion);
  if (targetsVersion === null) {
    throw new ExperienceTargetsError(
      'invalid-targets',
      'targets targetsVersion must be a positive integer',
    );
  }
  if (!isRecord(raw.bands)) {
    throw new ExperienceTargetsError('invalid-targets', 'targets bands must be an object');
  }
  const bands = {} as Record<ExperienceMetric, ExperienceTargetBand>;
  for (const metric of EXPERIENCE_TRACKED_METRICS) {
    const band = raw.bands[metric];
    if (!isRecord(band)) {
      throw new ExperienceTargetsError(
        'invalid-targets',
        `targets artifact is missing a band for required metric '${metric}'`,
      );
    }
    const centre = finiteOrNull(band.centre);
    const tolerance = finiteOrNull(band.tolerance);
    if (centre === null) {
      throw new ExperienceTargetsError(
        'invalid-targets',
        `band '${metric}' must carry a finite centre`,
      );
    }
    if (tolerance === null || tolerance <= 0) {
      throw new ExperienceTargetsError(
        'invalid-targets',
        `band '${metric}' must carry a finite, positive tolerance`,
      );
    }
    bands[metric] = Object.freeze({ metric, centre, tolerance });
  }
  const datasetVersion = positiveOrNull(raw.datasetVersion) ?? EVAL_DATASET_VERSION;
  return Object.freeze({
    schemaVersion: EXPERIENCE_TARGETS_SCHEMA_VERSION,
    targetsVersion,
    balanceSchemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    datasetVersion,
    kind: 'experience-targets' as const,
    source: normaliseSource(raw.source as ExperienceBaselineSource),
    toleranceRule: normaliseToleranceRule(raw.toleranceRule),
    toleranceRuleText:
      typeof raw.toleranceRuleText === 'string' && raw.toleranceRuleText.length > 0
        ? raw.toleranceRuleText
        : EXPERIENCE_TOLERANCE_RULE_TEXT,
    bands: Object.freeze(bands),
  });
}

/**
 * Serialises a targets artifact to stable, recursively key-sorted JSON so the
 * same baseline + rule yields a byte-identical committed artifact (AC4).
 */
export function serialiseExperienceTargets(targets: ExperienceTargets): string {
  return stableStringify(targets);
}

/**
 * Validates that a parsed JSON document is a `BalanceReport` the comparator can
 * consume (`kind: 'balance'`, matching balance-statistics schema, an aggregate
 * object). Throws {@link ExperienceTargetsError} (`invalid-report`) with an
 * actionable message otherwise.
 */
export function readBalanceReportInput(raw: unknown): BalanceReportInput {
  if (!isRecord(raw)) {
    throw new ExperienceTargetsError('invalid-report', 'balance report must be a JSON object');
  }
  if (raw.kind !== 'balance') {
    throw new ExperienceTargetsError(
      'invalid-report',
      "input must be a balance report (kind: 'balance') — " +
        'run `npm run evaluate -- --batch` or `npm run record` first',
    );
  }
  if (raw.schemaVersion !== BALANCE_STATISTICS_SCHEMA_VERSION) {
    throw new ExperienceTargetsError(
      'schema-mismatch',
      `balance report schema mismatch: got ${String(raw.schemaVersion)}, ` +
        `expected ${BALANCE_STATISTICS_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(raw.config) || !Array.isArray(raw.config.policies)) {
    throw new ExperienceTargetsError('invalid-report', 'balance report is missing config.policies');
  }
  if (!isRecord(raw.aggregate)) {
    throw new ExperienceTargetsError('invalid-report', 'balance report is missing an aggregate object');
  }
  return raw as unknown as BalanceReportInput;
}

/**
 * Compares a measured `BalanceAggregate` (human **or** bot) against the
 * intended-experience targets (AC2). Pure and clock-free.
 *
 * Per metric it returns the measured value, the band, the signed drift and a
 * verdict. A metric with no measurement is reported as `missing` and fails the
 * comparison: an unmeasured experience cannot be confirmed to be in band.
 * An empty aggregate is well-defined — every metric is `missing`, `passed` is
 * `false`, nothing throws.
 */
export function compareExperience(
  aggregate: BalanceAggregate,
  targets: ExperienceTargets,
): ExperienceComparison {
  const metrics: ExperienceMetricComparison[] = [];
  const driftedMetrics: ExperienceMetric[] = [];
  const missingMetrics: ExperienceMetric[] = [];
  for (const metric of EXPERIENCE_TRACKED_METRICS) {
    const band = targets.bands[metric];
    // The reported edges use the same deterministic rounding as the artifact,
    // so the band in the report is exactly the band the verdict applied.
    const lower = roundBand(band.centre - band.tolerance);
    const upper = roundBand(band.centre + band.tolerance);
    const measurement = measureExperienceMetric(aggregate, metric);
    if (measurement === null) {
      missingMetrics.push(metric);
      metrics.push({
        metric,
        verdict: 'missing',
        measured: null,
        centre: band.centre,
        tolerance: band.tolerance,
        lower,
        upper,
        drift: null,
        relativeDrift: null,
        withinTolerance: false,
      });
      continue;
    }
    const drift = measurement.value - band.centre;
    const verdict: ExperienceVerdict =
      measurement.value > upper
        ? 'above-band'
        : measurement.value < lower
          ? 'below-band'
          : 'in-band';
    if (verdict !== 'in-band') driftedMetrics.push(metric);
    metrics.push({
      metric,
      verdict,
      measured: measurement.value,
      centre: band.centre,
      tolerance: band.tolerance,
      lower,
      upper,
      drift,
      relativeDrift: band.centre === 0 ? null : drift / Math.abs(band.centre),
      withinTolerance: verdict === 'in-band',
    });
  }
  return {
    schemaVersion: EXPERIENCE_TARGETS_SCHEMA_VERSION,
    targetsVersion: targets.targetsVersion,
    metrics,
    passed: driftedMetrics.length === 0 && missingMetrics.length === 0,
    driftedMetrics,
    missingMetrics,
  };
}

/** Labels the measured report's source (human session vs bot policy). */
export function describeExperienceSource(
  report: BalanceReportInput,
): ExperienceValidationSource {
  const policies = report.config.policies;
  const isHuman = policies.length === 1 && policies[0] === 'human';
  const runs = Number(report.aggregate.runs);
  return {
    label: isHuman ? 'human' : `bot:${policies.join(',') || 'unknown'}`,
    kind: isHuman ? 'human' : 'bot',
    policies,
    runs: Number.isFinite(runs) ? runs : 0,
    campaign: typeof report.config.campaign === 'boolean' ? report.config.campaign : null,
    level: typeof report.config.level === 'number' ? report.config.level : null,
  };
}

/**
 * Builds the versioned, byte-stable validation report (AC2/AC3) from a parsed
 * balance report and the targets (AC4 determinism: the same inputs yield a
 * byte-identical artifact).
 *
 * A **bot** report whose harness mode (campaign / level) differs from the
 * baseline's produces a comparability warning: the bands were derived from a
 * campaign batch, so a skirmish batch is a directional check only. The warning
 * never changes the pass/fail verdict.
 */
export function buildExperienceValidationReport(options: {
  readonly report: BalanceReportInput;
  readonly targets: ExperienceTargets;
}): ExperienceValidationReport {
  const { report, targets } = options;
  const source = describeExperienceSource(report);
  const comparison = compareExperience(report.aggregate, targets);
  const warnings: string[] = [];
  if (source.kind === 'bot' && source.campaign !== null) {
    if (source.campaign !== targets.source.campaign) {
      warnings.push(
        `measured harness mode (campaign=${source.campaign}) differs from the ` +
          `targets baseline (campaign=${targets.source.campaign}) — treat the ` +
          'verdict as directional only',
      );
    } else if (
      source.level !== null &&
      targets.source.level !== null &&
      source.level !== targets.source.level
    ) {
      warnings.push(
        `measured level (${source.level}) differs from the targets baseline ` +
          `level (${targets.source.level}) — treat the verdict as directional only`,
      );
    }
  }
  return {
    kind: 'experience-validation',
    schemaVersion: EXPERIENCE_TARGETS_SCHEMA_VERSION,
    balanceSchemaVersion: report.schemaVersion,
    datasetVersion: report.datasetVersion,
    targetsVersion: targets.targetsVersion,
    source,
    targetSource: targets.source,
    toleranceRuleText: targets.toleranceRuleText,
    verdict: comparison.passed ? 'pass' : 'drift',
    passed: comparison.passed,
    metrics: comparison.metrics,
    driftedMetrics: comparison.driftedMetrics,
    missingMetrics: comparison.missingMetrics,
    warnings,
  };
}

/** Serialises a validation report byte-stably (AC4). */
export function serialiseExperienceValidationReport(
  report: ExperienceValidationReport,
): string {
  return stableStringify(report);
}

/** Formats a number with a fixed number of decimals (`2` dp by default). */
function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

/** Formats the signed drift with its relative magnitude. */
function formatDrift(metric: ExperienceMetricComparison): string {
  if (metric.measured === null || metric.drift === null) return '—';
  const sign = metric.drift > 0 ? '+' : '';
  const relative =
    metric.relativeDrift === null
      ? ''
      : ` (${sign}${(metric.relativeDrift * 100).toFixed(1)} %)`;
  return `${sign}${formatNumber(metric.drift)}${relative}`;
}

/**
 * Renders the Markdown summary (AC3): the measured source, the targets version,
 * and a per-metric table of measured value, band, signed drift and verdict,
 * ending with the overall PASS/DRIFT verdict. Deterministic — the same report
 * always renders the same bytes (AC4).
 */
export function formatExperienceValidationReport(
  report: ExperienceValidationReport,
): string {
  const lines: string[] = [];
  const inBand = report.metrics.filter((metric) => metric.withinTolerance).length;
  lines.push(`# Experience validation — ${report.source.label}`);
  lines.push('');
  lines.push(
    `- Targets: v${report.targetsVersion} (baseline: ` +
      `${report.targetSource.policy}, ${report.targetSource.games} games, ` +
      `${report.targetSource.ticks} ticks, ` +
      `campaign=${report.targetSource.campaign}` +
      `${report.targetSource.level === null ? '' : `, level ${report.targetSource.level}`})`,
  );
  lines.push(
    `- Measured: ${report.source.runs} run(s), balance schema v${report.balanceSchemaVersion}`,
  );
  lines.push(`- Tolerance: ${report.toleranceRuleText}`);
  lines.push(
    `- Result: **${report.verdict === 'pass' ? 'PASS' : 'DRIFT'}** ` +
      `(${inBand}/${report.metrics.length} metrics in band` +
      `${report.missingMetrics.length === 0 ? '' : `, ${report.missingMetrics.length} missing`})`,
  );
  lines.push('');
  lines.push('| Metric | Measured | Target band | Drift | Verdict |');
  lines.push('|---|---|---|---|---|');
  for (const metric of report.metrics) {
    const band =
      `${formatNumber(metric.lower)} – ${formatNumber(metric.upper)} ` +
      `(±${formatNumber(metric.tolerance)})`;
    lines.push(
      `| ${EXPERIENCE_METRIC_LABELS[metric.metric]} | ` +
        `${formatNumber(metric.measured)} | ${band} | ` +
        `${formatDrift(metric)} | ${metric.verdict} |`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  return lines.join('\n');
}

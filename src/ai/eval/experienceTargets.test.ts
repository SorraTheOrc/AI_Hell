/**
 * Intended-experience targets, the pure comparator and the validation report
 * (AH-0MV7WVHU0000U775 AC1/AC2/AC4).
 *
 * The targets artifact is the single machine-checkable statement of intended
 * experience, derived from a recorded bot batch. The comparator is pure — no
 * I/O, no wall clock, no randomness — so a validation run is reproducible and
 * the same measured report always yields the same bytes. These tests pin the
 * schema, the tolerance rule, the per-metric verdicts, the missing/empty-input
 * cases and the determinism of the JSON + Markdown artifacts.
 *
 * The committed artifact (`src/data/experience-targets.json`) is read from disk
 * here on purpose: it is **data**, and the test asserts the committed data
 * validates and covers every required metric.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildExperienceValidationReport,
  compareExperience,
  DEFAULT_EXPERIENCE_TOLERANCE_RULE,
  deriveExperienceTargets,
  describeExperienceSource,
  EXPERIENCE_TARGETS_SCHEMA_VERSION,
  EXPERIENCE_TRACKED_METRICS,
  ExperienceTargetsError,
  formatExperienceValidationReport,
  measureExperienceMetric,
  readBalanceReportInput,
  serialiseExperienceTargets,
  serialiseExperienceValidationReport,
  validateExperienceTargets,
  type BalanceReportInput,
  type ExperienceBaselineSource,
  type ExperienceMetric,
  type ExperienceTargets,
} from './experienceTargets';
import {
  BALANCE_STATISTICS_SCHEMA_VERSION,
  EVAL_DATASET_VERSION,
  type BalanceAggregate,
  type DistributionStats,
} from './types';

const TARGETS_PATH = path.resolve(process.cwd(), 'src/data/experience-targets.json');

/** Builds a distribution summary around a mean with a known std-dev. */
function dist(count: number, mean: number, stdDev: number): DistributionStats {
  return { count, mean, median: mean, min: mean - stdDev, max: mean + stdDev, stdDev };
}

/** A representative aggregate with a known value for every tracked metric. */
function aggregate(overrides: Partial<BalanceAggregate> = {}): BalanceAggregate {
  return {
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    runs: 10,
    seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    mineralsCollected: dist(10, 5, 1),
    powerUpsCollected: dist(10, 1, 0.2),
    asteroidsDestroyed: dist(10, 2, 0.5),
    avoidableHits: dist(10, 1, 0.3),
    survivalSeconds: dist(10, 30, 5),
    waveReached: dist(10, 6, 2),
    levelReached: dist(10, 1.2, 0.4),
    upgradesSelected: {
      spread: dist(10, 1, 0.4),
      shield: dist(10, 0.5, 0.2),
    },
    enemiesKilledByArchetype: { scout: dist(10, 4, 1) },
    ...overrides,
  };
}

const BOT_SOURCE: ExperienceBaselineSource = {
  kind: 'bot-baseline',
  policy: 'competent',
  games: 10,
  ticks: 18_000,
  campaign: true,
  level: null,
  sampleEveryTicks: 1,
  seeds: { count: 10, first: 1, last: 10 },
};

/** A derived targets fixture used by the comparator tests. */
function derivedTargets(): ExperienceTargets {
  return deriveExperienceTargets(aggregate(), BOT_SOURCE);
}

/** A `BalanceReport`-shaped input wrapping an aggregate. */
function balanceReport(
  overrides: {
    aggregate?: BalanceAggregate;
    policies?: readonly string[];
    campaign?: boolean;
    level?: number;
  } = {},
): BalanceReportInput {
  const config: BalanceReportInput['config'] = {
    policies: overrides.policies ?? ['competent'],
    ...(overrides.campaign === undefined ? {} : { campaign: overrides.campaign }),
    ...(overrides.level === undefined ? {} : { level: overrides.level }),
  };
  return {
    kind: 'balance',
    schemaVersion: BALANCE_STATISTICS_SCHEMA_VERSION,
    datasetVersion: EVAL_DATASET_VERSION,
    config,
    aggregate: overrides.aggregate ?? aggregate(),
  };
}

describe('committed targets artifact (src/data/experience-targets.json)', () => {
  it('exists and validates against the schema (AC1)', () => {
    expect(fs.existsSync(TARGETS_PATH)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
    expect(() => validateExperienceTargets(raw)).not.toThrow();
  });

  it('covers every required metric with a positive band (AC1)', () => {
    const targets = validateExperienceTargets(
      JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')),
    );
    expect(Object.keys(targets.bands).sort()).toEqual(
      [...EXPERIENCE_TRACKED_METRICS].sort(),
    );
    for (const metric of EXPERIENCE_TRACKED_METRICS) {
      const band = targets.bands[metric];
      expect(band.metric).toBe(metric);
      expect(Number.isFinite(band.centre)).toBe(true);
      expect(Number.isFinite(band.tolerance)).toBe(true);
      expect(band.tolerance).toBeGreaterThan(0);
    }
  });

  it('is versioned and self-describing (AC1)', () => {
    const targets = validateExperienceTargets(
      JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')),
    );
    expect(targets.schemaVersion).toBe(EXPERIENCE_TARGETS_SCHEMA_VERSION);
    expect(targets.balanceSchemaVersion).toBe(BALANCE_STATISTICS_SCHEMA_VERSION);
    expect(targets.targetsVersion).toBeGreaterThanOrEqual(1);
    expect(targets.source.kind).toBe('bot-baseline');
    expect(targets.source.policy.length).toBeGreaterThan(0);
    expect(targets.source.games).toBeGreaterThan(0);
    expect(targets.source.ticks).toBeGreaterThan(0);
    expect(targets.toleranceRuleText).toContain('stdDev');
  });

  it('is byte-identical to its normalised serialisation (committed form)', () => {
    const text = fs.readFileSync(TARGETS_PATH, 'utf8');
    const targets = validateExperienceTargets(JSON.parse(text));
    // A re-baseline writes exactly this form, so the committed file is stable.
    expect(serialiseExperienceTargets(targets)).toBe(text.trimEnd());
  });
});

describe('validateExperienceTargets', () => {
  it('normalises a derived artifact to only its known fields', () => {
    const raw = { ...derivedTargets(), unexpected: 'ignored' };
    const targets = validateExperienceTargets(raw);
    expect(targets).not.toHaveProperty('unexpected');
    expect(targets.bands.survivalSeconds.centre).toBe(30);
  });

  it('rejects a missing required band', () => {
    const raw = JSON.parse(JSON.stringify(derivedTargets()));
    delete raw.bands.avoidableHits;
    expect(() => validateExperienceTargets(raw)).toThrow(/avoidableHits/);
  });

  it('rejects a wrong kind', () => {
    const raw = { ...derivedTargets(), kind: 'balance' };
    expect(() => validateExperienceTargets(raw)).toThrow(/experience-targets/);
  });

  it('rejects an incompatible schema version', () => {
    const raw = { ...derivedTargets(), schemaVersion: 99 };
    expect(() => validateExperienceTargets(raw)).toThrow(ExperienceTargetsError);
    try {
      validateExperienceTargets(raw);
    } catch (error) {
      expect((error as ExperienceTargetsError).code).toBe('schema-mismatch');
    }
  });

  it('rejects a non-positive tolerance and a non-finite centre', () => {
    const zero = JSON.parse(JSON.stringify(derivedTargets()));
    zero.bands.survivalSeconds.tolerance = 0;
    expect(() => validateExperienceTargets(zero)).toThrow(/positive tolerance/);

    const infinite = JSON.parse(JSON.stringify(derivedTargets()));
    infinite.bands.survivalSeconds.centre = 'nope';
    expect(() => validateExperienceTargets(infinite)).toThrow(/finite centre/);
  });

  it('rejects a non bot-baseline source (the chosen intended-experience source)', () => {
    const raw = {
      ...derivedTargets(),
      source: { ...BOT_SOURCE, kind: 'vibes' },
    };
    expect(() => validateExperienceTargets(raw)).toThrow(/bot-baseline/);
  });
});

describe('deriveExperienceTargets', () => {
  it('uses the baseline mean as the band centre (AC1)', () => {
    const targets = derivedTargets();
    expect(targets.bands.survivalSeconds.centre).toBe(30);
    expect(targets.bands.mineralsCollected.centre).toBe(5);
    // upgradesSelected is a per-key map: centre = sum of the per-key means.
    expect(targets.bands.upgradesSelected.centre).toBe(1.5);
  });

  it('applies the documented tolerance rule: max(2σ, 10 % of |centre|, 0.5)', () => {
    const targets = derivedTargets();
    // survival: 2σ = 10 dominates 10 % of 30 (3) and the 0.5 floor.
    expect(targets.bands.survivalSeconds.tolerance).toBe(10);
    // minerals: 2σ = 2 dominates 10 % of 5 (0.5).
    expect(targets.bands.mineralsCollected.tolerance).toBe(2);
    // avoidable hits: 2σ = 0.6 dominates the 0.5 floor.
    expect(targets.bands.avoidableHits.tolerance).toBeCloseTo(0.6, 10);
    // upgradesSelected has no single stdDev: max(25 % of 1.5, 0.5) = 0.5.
    expect(targets.bands.upgradesSelected.tolerance).toBe(
      DEFAULT_EXPERIENCE_TOLERANCE_RULE.minAbsoluteTolerance,
    );
  });

  it('honours a min-absolute-tolerance floor when the baseline is very tight', () => {
    const targets = deriveExperienceTargets(
      aggregate({ mineralsCollected: dist(10, 0, 0) }),
      BOT_SOURCE,
      { toleranceRule: { minAbsoluteTolerance: 0.75 } },
    );
    expect(targets.bands.mineralsCollected.tolerance).toBe(0.75);
  });

  it('refuses to invent a band when the baseline has no data for a metric', () => {
    expect(() =>
      deriveExperienceTargets(aggregate({ waveReached: dist(0, 0, 0) }), BOT_SOURCE),
    ).toThrow(ExperienceTargetsError);
    try {
      deriveExperienceTargets(aggregate({ waveReached: dist(0, 0, 0) }), BOT_SOURCE);
    } catch (error) {
      expect((error as ExperienceTargetsError).code).toBe('no-baseline-data');
    }
  });

  it('is deterministic: the same baseline yields byte-identical JSON (AC4)', () => {
    const a = serialiseExperienceTargets(derivedTargets());
    const b = serialiseExperienceTargets(
      deriveExperienceTargets(aggregate(), BOT_SOURCE),
    );
    expect(a).toBe(b);
    expect(a).toBe(serialiseExperienceTargets(JSON.parse(a)));
  });
});

describe('measureExperienceMetric', () => {
  it('measures a scalar metric by its mean', () => {
    expect(measureExperienceMetric(aggregate(), 'survivalSeconds')).toEqual({
      value: 30,
      runs: 10,
    });
  });

  it('projects upgradesSelected as the mean selections per run', () => {
    expect(measureExperienceMetric(aggregate(), 'upgradesSelected')).toEqual({
      value: 1.5,
      runs: 10,
    });
  });

  it('reports an empty upgrades map on a report with runs as a measured zero', () => {
    expect(
      measureExperienceMetric(aggregate({ upgradesSelected: {} }), 'upgradesSelected'),
    ).toEqual({ value: 0, runs: 10 });
  });

  it('reports a metric with no contributing runs as missing', () => {
    const empty = aggregate({ survivalSeconds: dist(0, 0, 0) });
    expect(measureExperienceMetric(empty, 'survivalSeconds')).toBeNull();
    const noRuns = aggregate({ runs: 0, upgradesSelected: {} });
    expect(measureExperienceMetric(noRuns, 'upgradesSelected')).toBeNull();
  });

  it('reports an absent distribution as missing (defensive against partial JSON)', () => {
    const partial = { runs: 3 } as unknown as BalanceAggregate;
    expect(measureExperienceMetric(partial, 'avoidableHits')).toBeNull();
    expect(measureExperienceMetric(partial, 'upgradesSelected')).toBeNull();
  });
});

describe('compareExperience (pure comparator, AC2)', () => {
  it('passes a measurement equal to the baseline centre', () => {
    const comparison = compareExperience(aggregate(), derivedTargets());
    expect(comparison.passed).toBe(true);
    expect(comparison.driftedMetrics).toEqual([]);
    expect(comparison.missingMetrics).toEqual([]);
    for (const metric of comparison.metrics) {
      expect(metric.verdict).toBe('in-band');
      expect(metric.drift).toBe(0);
      expect(metric.withinTolerance).toBe(true);
    }
  });

  it('reports an above-band measurement with a signed drift and relative drift', () => {
    const comparison = compareExperience(
      aggregate({ survivalSeconds: dist(10, 100, 5) }),
      derivedTargets(),
    );
    const survival = comparison.metrics.find((metric) => metric.metric === 'survivalSeconds');
    expect(survival?.verdict).toBe('above-band');
    expect(survival?.measured).toBe(100);
    expect(survival?.drift).toBe(70);
    expect(survival?.relativeDrift).toBeCloseTo(70 / 30, 10);
    expect(survival?.withinTolerance).toBe(false);
    expect(comparison.passed).toBe(false);
    expect(comparison.driftedMetrics).toEqual(['survivalSeconds']);
  });

  it('reports a below-band measurement with a negative drift', () => {
    const comparison = compareExperience(
      aggregate({ mineralsCollected: dist(10, 1, 1) }),
      derivedTargets(),
    );
    const minerals = comparison.metrics.find(
      (metric) => metric.metric === 'mineralsCollected',
    );
    expect(minerals?.verdict).toBe('below-band');
    expect(minerals?.drift).toBe(-4);
    expect(minerals?.relativeDrift).toBeCloseTo(-0.8, 10);
  });

  it('treats a measurement exactly on the band edge as in band (inclusive)', () => {
    // survival band: 30 ± 10 → 40 is the inclusive upper edge.
    const comparison = compareExperience(
      aggregate({ survivalSeconds: dist(10, 40, 5) }),
      derivedTargets(),
    );
    const survival = comparison.metrics.find((metric) => metric.metric === 'survivalSeconds');
    expect(survival?.verdict).toBe('in-band');
    expect(comparison.passed).toBe(true);
  });

  it('fails the comparison when a metric is missing (cannot confirm a band)', () => {
    const partial = {
      ...aggregate(),
      avoidableHits: undefined,
    } as unknown as BalanceAggregate;
    const comparison = compareExperience(partial, derivedTargets());
    expect(comparison.passed).toBe(false);
    expect(comparison.missingMetrics).toEqual(['avoidableHits']);
    const missing = comparison.metrics.find((metric) => metric.metric === 'avoidableHits');
    expect(missing?.verdict).toBe('missing');
    expect(missing?.measured).toBeNull();
    expect(missing?.drift).toBeNull();
    expect(missing?.relativeDrift).toBeNull();
    expect(missing?.withinTolerance).toBe(false);
  });

  it('handles empty input without throwing: every metric is missing', () => {
    const comparison = compareExperience({} as BalanceAggregate, derivedTargets());
    expect(comparison.passed).toBe(false);
    expect(comparison.driftedMetrics).toEqual([]);
    expect(comparison.missingMetrics).toEqual([...EXPERIENCE_TRACKED_METRICS]);
    expect(comparison.metrics).toHaveLength(EXPERIENCE_TRACKED_METRICS.length);
  });

  it('emits one comparison per tracked metric in the canonical order', () => {
    const comparison = compareExperience(aggregate(), derivedTargets());
    expect(comparison.metrics.map((metric) => metric.metric)).toEqual([
      ...EXPERIENCE_TRACKED_METRICS,
    ]);
    expect(comparison.targetsVersion).toBe(derivedTargets().targetsVersion);
  });

  it('is clock-free and randomness-free (AC2/AC4)', () => {
    const clock = vi.spyOn(Date, 'now');
    const perf = vi.spyOn(performance, 'now');
    const random = vi.spyOn(Math, 'random');
    try {
      const targets = derivedTargets();
      compareExperience(aggregate(), targets);
      buildExperienceValidationReport({
        report: balanceReport(),
        targets,
      });
      expect(clock).not.toHaveBeenCalled();
      expect(perf).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      perf.mockRestore();
      random.mockRestore();
    }
  });
});

describe('readBalanceReportInput', () => {
  it('accepts a balance report and rejects other report kinds', () => {
    expect(readBalanceReportInput(balanceReport()).kind).toBe('balance');
    expect(() => readBalanceReportInput({ kind: 'evaluation' })).toThrow(
      /kind: 'balance'/,
    );
  });

  it('rejects an incompatible balance schema and a missing aggregate', () => {
    expect(() =>
      readBalanceReportInput({ ...balanceReport(), schemaVersion: 99 }),
    ).toThrow(ExperienceTargetsError);
    expect(() =>
      readBalanceReportInput({ ...balanceReport(), aggregate: undefined }),
    ).toThrow(/aggregate/);
  });
});

describe('describeExperienceSource', () => {
  it('labels a human report as human and omits the harness mode', () => {
    const source = describeExperienceSource(
      balanceReport({ policies: ['human'], aggregate: aggregate({ runs: 2 }) }),
    );
    expect(source).toEqual({
      label: 'human',
      kind: 'human',
      policies: ['human'],
      runs: 2,
      campaign: null,
      level: null,
    });
  });

  it('labels a bot report with its policy and records the harness mode', () => {
    const source = describeExperienceSource(
      balanceReport({ policies: ['competent', 'legacy'], campaign: true, level: 5 }),
    );
    expect(source.label).toBe('bot:competent,legacy');
    expect(source.kind).toBe('bot');
    expect(source.campaign).toBe(true);
    expect(source.level).toBe(5);
  });
});

describe('buildExperienceValidationReport (AC2/AC3/AC4)', () => {
  it('labels the measured source and carries the targets provenance', () => {
    const report = buildExperienceValidationReport({
      report: balanceReport({ policies: ['human'] }),
      targets: derivedTargets(),
    });
    expect(report.kind).toBe('experience-validation');
    expect(report.source.label).toBe('human');
    expect(report.targetSource.policy).toBe('competent');
    expect(report.verdict).toBe('pass');
    expect(report.passed).toBe(true);
    expect(report.driftedMetrics).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('fails the verdict and lists every drifted metric', () => {
    const report = buildExperienceValidationReport({
      report: balanceReport({
        aggregate: aggregate({
          survivalSeconds: dist(10, 1, 1),
          levelReached: dist(10, 9, 0),
        }),
      }),
      targets: derivedTargets(),
    });
    expect(report.verdict).toBe('drift');
    expect(report.passed).toBe(false);
    expect(report.driftedMetrics).toEqual(['survivalSeconds', 'levelReached']);
  });

  it('warns when a bot report uses a different harness mode from the baseline', () => {
    const report = buildExperienceValidationReport({
      report: balanceReport({ campaign: false }),
      targets: derivedTargets(),
    });
    expect(report.passed).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('campaign=false');
    // A human report carries no harness mode, so it never warns.
    const human = buildExperienceValidationReport({
      report: balanceReport({ policies: ['human'] }),
      targets: derivedTargets(),
    });
    expect(human.warnings).toEqual([]);
  });

  it('is byte-stable: the same inputs yield identical JSON and Markdown (AC4)', () => {
    const first = buildExperienceValidationReport({
      report: balanceReport(),
      targets: derivedTargets(),
    });
    const second = buildExperienceValidationReport({
      report: balanceReport(),
      targets: derivedTargets(),
    });
    expect(serialiseExperienceValidationReport(first)).toBe(
      serialiseExperienceValidationReport(second),
    );
    expect(formatExperienceValidationReport(first)).toBe(
      formatExperienceValidationReport(second),
    );
    // Serialisation is key-sorted, so the artifact is stable even if the
    // object was rebuilt in a different insertion order.
    expect(serialiseExperienceValidationReport(JSON.parse(serialiseExperienceValidationReport(first)))).toBe(
      serialiseExperienceValidationReport(first),
    );
  });

  it('renders the Markdown summary with the source, the band table and the verdict', () => {
    const markdown = formatExperienceValidationReport(
      buildExperienceValidationReport({
        report: balanceReport({ policies: ['human'] }),
        targets: derivedTargets(),
      }),
    );
    expect(markdown).toContain('# Experience validation — human');
    expect(markdown).toContain('Targets: v1');
    expect(markdown).toContain('Tolerance:');
    expect(markdown).toContain('**PASS**');
    expect(markdown).toContain('| Metric | Measured | Target band | Drift | Verdict |');
    expect(markdown).toContain('survival (s)');
    expect(markdown).toContain('30.00');
    expect(markdown).toContain('in-band');
  });

  it('renders a DRIFT verdict, missing rows and warnings', () => {
    const driftReport = buildExperienceValidationReport({
      report: balanceReport({
        campaign: false,
        aggregate: {
          ...aggregate({ survivalSeconds: dist(10, 100, 5) }),
          avoidableHits: dist(0, 0, 0),
        },
      }),
      targets: derivedTargets(),
    });
    const markdown = formatExperienceValidationReport(driftReport);
    expect(markdown).toContain('**DRIFT**');
    expect(markdown).toContain('1 missing');
    expect(markdown).toContain('missing');
    expect(markdown).toContain('Warnings:');
    expect(markdown).toContain('above-band');
  });
});

describe('EXPERIENCE_TRACKED_METRICS', () => {
  it('covers the minimum metrics the work item requires', () => {
    const required: ExperienceMetric[] = [
      'survivalSeconds',
      'mineralsCollected',
      'upgradesSelected',
      'waveReached',
      'levelReached',
      'avoidableHits',
    ];
    expect([...EXPERIENCE_TRACKED_METRICS]).toEqual(required);
    expect(Object.isFrozen(EXPERIENCE_TRACKED_METRICS)).toBe(true);
  });
});

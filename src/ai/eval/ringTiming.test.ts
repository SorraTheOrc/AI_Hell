/**
 * Tests for the headless ring-timing harness (AH-0MVUXCBQY001ESWT).
 *
 * The suite has two halves, on purpose:
 *
 * - **Model tests** drive {@link simulateRingTiming} with an injected
 *   deployment runner, so the ordering, the retry/exposure allowances, the
 *   determinism of the *model* and the budget verdict are pinned exactly and
 *   cheaply.
 * - **Arena tests** run the real harness against the real headless arena —
 *   the design's evidence (intake assumption A1): the same seed twice produces
 *   the same summed duration, the two ring budgets land inside their windows,
 *   and the rush line is measurably faster but riskier than the grind.
 *
 * Every assertion is about observable report values, never about how the
 * module is written.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHexCapture } from '../../core/hangarWar/captureCycle';
import { createRingState } from '../../core/hangarWar/hexRing';
import { hexDifficultyProfile } from '../../core/hangarWar/hexDifficulty';
import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import type { HexRingDefinition } from '../../core/hangarWar/hexRing';
import {
  HEX_RING_DEFINITIONS as HEZ_RING_ONE_ALL,
  hexRingDefinitionsFor,
} from '../../data/hexRingDefinitions';
import { loadBalanceConfig } from './balanceConfig';
import {
  DEFAULT_BETWEEN_SORTIE_MINUTES,
  DEFAULT_RETRY_MINUTES,
  RING_TIMING_TARGETS,
  RING_TIMING_TOLERANCE_PERCENT,
  createArenaDeploymentRunner,
  evaluateRingTimingBudget,
  formatRingTimingReport,
  planRingDeployments,
  ringTimingHexes,
  simulateRingTiming,
  type RingDeploymentRequest,
  type RingDeploymentRunner,
} from './ringTiming';

/** A minimal authored hex for model tests (only the fields the model reads). */
function hex(
  id: string,
  baseAggression: number,
  weaponHex = false,
): HexRingDefinition {
  return {
    id,
    q: 0,
    r: 0,
    ringIndex: 1,
    boss: `boss-${id}`,
    strengths: ['cannon'],
    weaknesses: ['nova'],
    grants: `grant-${id}`,
    weaponHex,
    baseAggression,
  };
}

/** A six-hex ring with the authored aggressions 2, 1, 3, 2, 4, 6. */
function modelRing(): HexRingDefinition[] {
  return [
    hex('hex-1', 2),
    hex('hex-2', 1),
    hex('hex-3', 3),
    hex('hex-4', 2),
    hex('hex-5', 4),
    hex('hex-6', 6, true),
  ];
}

/**
 * A runner that reports a fixed 300-second captured run for aggressions below
 * `riskyFrom`, and a 30-second lost run at or above it.
 */
function fakeRunner(riskyFrom = Number.POSITIVE_INFINITY): RingDeploymentRunner {
  return (request: RingDeploymentRequest) =>
    request.aggression >= riskyFrom
      ? { seconds: 30, captured: false, minerals: 5, hits: 3 }
      : { seconds: 300, captured: true, minerals: 18, hits: 0 };
}

/** Ring 1's authored definitions (the shipped capture-cycle data). */
const HEZ_RING_ONE = HEZ_RING_ONE_ALL.filter((entry) => entry.ringIndex === 1);

describe('ring timing: authored ring and deployment plan', () => {
  it('measures the authored rings (ring 1 = 6 hexes, ring 2 = 12, ring 3 = none)', () => {
    expect(ringTimingHexes(1)).toHaveLength(6);
    expect(ringTimingHexes(2)).toHaveLength(12);
    expect(ringTimingHexes(3)).toEqual([]);
  });

  it('the grind plays every hex weakest-aggression-first, weapon hex last', () => {
    const { played, exposed } = planRingDeployments(modelRing(), 'grind');
    expect(played.map((entry) => entry.baseAggression)).toEqual([1, 2, 2, 3, 4, 6]);
    expect(played[played.length - 1].weaponHex).toBe(true);
    expect(exposed).toEqual([]);
  });

  it('the rush takes the weapon hex first and leaves the rest exposed', () => {
    const { played, exposed } = planRingDeployments(modelRing(), 'rush');
    expect(played.map((entry) => entry.id)).toEqual(['hex-6']);
    expect(exposed.map((entry) => entry.id).sort()).toEqual([
      'hex-1',
      'hex-2',
      'hex-3',
      'hex-4',
      'hex-5',
    ]);
  });

  it('the modelled rush is a legal play sequence (AH-0MVXSHAS100010S0)', () => {
    // The rush the harness measures must be reachable in the shipped capture
    // cycle: taking only the weapon hex has to open the next ring, or the
    // measured rush line would be a strategy no player can play.
    const ring = createRingState(1, HEZ_RING_ONE);
    const capstone = planRingDeployments(HEZ_RING_ONE, 'rush').played[0];
    expect(capstone.weaponHex).toBe(true);

    const captured = resolveHexCapture(
      { ...createDefaultPayload(), ring },
      {
        hexId: capstone.id,
        defenderHullId: 'hull-1',
        salvage: {
          runId: 'rush-proof',
          checkpointId: 'run-end',
          minerals: 0,
          cores: 0,
        },
        // Both rings authored: ring 2 must be generatable for the push to open.
        definitions: HEZ_RING_ONE_ALL,
      },
    );

    expect(captured.ok).toBe(true);
    expect(captured.ringAdvanced).toBe(true);
    expect(captured.ringIndex).toBe(2);
    // ... and the ring is not secured: the rush really did leave it exposed.
    expect(captured.ringSecured).toBe(false);
  });
});

describe('ring timing: the measured + modelled play time', () => {
  it('sums the measured runs and the between-sortie allowance for a safe ring', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [4],
      hexes: modelRing(),
      runDeployment: fakeRunner(),
    });
    const run = report.runs[0];
    // 6 deployments × 300 s = 30 min measured, plus 6 × 2 min between sorties.
    expect(run.deploymentMinutes).toBeCloseTo(30, 5);
    expect(run.betweenSortieMinutes).toBe(
      6 * DEFAULT_BETWEEN_SORTIE_MINUTES,
    );
    expect(run.retryMinutes).toBe(0);
    expect(run.totalMinutes).toBeCloseTo(42, 5);
    expect(run.losses).toBe(0);
    expect(run.ringSecured).toBe(true);
    expect(run.salvageBanked).toBe(6 * 18);
    expect(run.salvageForfeited).toBe(0);
  });

  it('charges one modelled retry per lost deployment and forfeits its salvage', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
    });
    const run = report.runs[0];
    // Aggressions 3, 4 and 6 are lost: 3 losses × 1 retry × 5 min.
    expect(run.losses).toBe(3);
    expect(run.retryMinutes).toBe(3 * DEFAULT_RETRY_MINUTES);
    expect(run.salvageForfeited).toBe(3 * 5);
    expect(run.salvageBanked).toBe(3 * 18);
    // 3 safe runs × 5 min + 3 lost runs × 0.5 min + 15 min retries + 12 min.
    expect(run.totalMinutes).toBeCloseTo(3 * 5 + 3 * 0.5 + 15 + 12, 5);
    expect(run.ringSecured).toBe(true);
  });

  it('charges the rush line the expected re-capture work for its exposed hexes', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'rush',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
      retakeChancePercent: 50,
    });
    const run = report.runs[0];
    // The weapon hex (aggression 6) is lost: 0.5 min + one 5-minute retry.
    expect(run.deployments).toHaveLength(1);
    expect(run.exposedHexes).toBe(5);
    expect(run.expectedRetakes).toBe(2.5);
    // 2.5 expected retakes × (5 min deployment + 2 min visit).
    expect(run.retakeMinutes).toBeCloseTo(2.5 * 7, 5);
    expect(run.totalMinutes).toBeCloseTo(0.5 + 5 + 2 + 2.5 * 7, 5);
    expect(run.ringSecured).toBe(false);
  });

  it('resolves every deployment through the shipped aggression → level mapping', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      aggressionRisePerSortie: 1,
      runDeployment: fakeRunner(),
    });
    const deployments = report.runs[0].deployments;
    deployments.forEach((deployment) => {
      expect(deployment.level).toBe(
        hexDifficultyProfile(deployment.aggression).level,
      );
    });
    // The rise is applied per sortie: base aggression + sortie index.
    const base = planRingDeployments(modelRing(), 'grind').played;
    deployments.forEach((deployment, index) => {
      expect(deployment.aggression).toBe(base[index].baseAggression + index);
    });
  });

  it('aggregates several seeds into a min/mean/max summary', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1, 2, 3],
      hexes: modelRing(),
      runDeployment: fakeRunner(),
    });
    expect(report.seeds).toEqual([1, 2, 3]);
    expect(report.runs).toHaveLength(3);
    expect(report.summary.totalMinutes.count).toBe(3);
    expect(report.summary.totalMinutes.mean).toBeCloseTo(42, 5);
    expect(report.summary.totalMinutes.min).toBeCloseTo(42, 5);
    expect(report.summary.totalMinutes.max).toBeCloseTo(42, 5);
    expect(report.summary.ringSecuredRuns).toBe(3);
  });
});

describe('ring timing: budget verdicts', () => {
  it('accepts a measurement inside the window', () => {
    const verdict = evaluateRingTimingBudget(1, 'grind', 45);
    expect(verdict.applicable).toBe(true);
    expect(verdict.verdict).toBe('in-window');
    expect(verdict.withinTolerance).toBe(true);
    expect(verdict.target).toEqual(RING_TIMING_TARGETS[1]);
  });

  it('accepts a measurement inside the stated tolerance and states it', () => {
    // Ring 1's window is 20 minutes wide, so 10 % is a 2-minute tolerance.
    const verdict = evaluateRingTimingBudget(1, 'grind', 38.5);
    expect(verdict.tolerancePercent).toBe(RING_TIMING_TOLERANCE_PERCENT);
    expect(verdict.toleranceMinutes).toBeCloseTo(2, 5);
    expect(verdict.verdict).toBe('within-tolerance');
    expect(verdict.withinTolerance).toBe(true);
  });

  it('misses a measurement outside the window and its tolerance', () => {
    const verdict = evaluateRingTimingBudget(1, 'grind', 30);
    expect(verdict.verdict).toBe('missed');
    expect(verdict.withinTolerance).toBe(false);
  });

  it('does not judge a rush segment or an unauthored ring against the budget', () => {
    expect(evaluateRingTimingBudget(1, 'rush', 20).verdict).toBe(
      'not-applicable',
    );
    expect(evaluateRingTimingBudget(3, 'grind', 20).verdict).toBe(
      'not-applicable',
    );
    expect(evaluateRingTimingBudget(3, 'grind', 20).target).toBeNull();
  });
});

describe('ring timing: real arena evidence', () => {
  it('is deterministic: the same seed measures the same summed duration', () => {
    const options = { ringIndex: 1, strategy: 'grind' as const, seeds: [7] };
    const first = simulateRingTiming(options);
    const second = simulateRingTiming(options);
    expect(second).toEqual(first);
    expect(second.summary.totalMinutes.mean).toBe(
      first.summary.totalMinutes.mean,
    );
    // The measurement is the real arena's durations, not a constant.
    expect(first.summary.deploymentMinutes.mean).toBeGreaterThan(0);
  }, 60_000);

  it('the one-ring MVP grind lands inside the 40–60-minute budget', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1, 2, 3],
    });
    expect(report.runs[0].deployments).toHaveLength(6);
    expect(report.budget.verdict).toBe('in-window');
    expect(report.budget.withinTolerance).toBe(true);
    expect(report.budget.measuredMinutes).toBeGreaterThanOrEqual(
      RING_TIMING_TARGETS[1].minMinutes,
    );
    expect(report.budget.measuredMinutes).toBeLessThanOrEqual(
      RING_TIMING_TARGETS[1].maxMinutes,
    );
    expect(report.summary.ringSecuredRuns).toBe(3);
  }, 60_000);

  it('the 12-hex ring 2 grind lands inside the 90–120-minute budget', () => {
    const report = simulateRingTiming({
      ringIndex: 2,
      strategy: 'grind',
      seeds: [1, 2, 3],
    });
    expect(report.runs[0].deployments).toHaveLength(12);
    expect(report.budget.verdict).toBe('in-window');
    expect(report.budget.withinTolerance).toBe(true);
    expect(report.budget.measuredMinutes).toBeGreaterThanOrEqual(
      RING_TIMING_TARGETS[2].minMinutes,
    );
    expect(report.budget.measuredMinutes).toBeLessThanOrEqual(
      RING_TIMING_TARGETS[2].maxMinutes,
    );
  }, 60_000);

  it('the rush line is faster but riskier than the grind, and neither dominates', () => {
    const grind = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
    });
    const rush = simulateRingTiming({
      ringIndex: 1,
      strategy: 'rush',
      seeds: [1],
    });
    // Faster: the rush line spends less time in this ring.
    expect(rush.summary.totalMinutes.mean).toBeLessThan(
      grind.summary.totalMinutes.mean,
    );
    // Riskier: the rush line leaves the rest of the ring exposed to the
    // frontier (expected re-captures) and never secures it, while the grind
    // ends with the ring secured. First-attempt losses are deliberately *not*
    // the discriminator: both lines lose attempts at the ring's hard hexes,
    // and a lost grind attempt is retried with the ring still ending secured.
    expect(rush.runs[0].exposedHexes).toBe(5);
    expect(rush.runs[0].expectedRetakes).toBeGreaterThan(0);
    expect(grind.runs[0].expectedRetakes).toBe(0);
    expect(rush.runs[0].ringSecured).toBe(false);
    expect(grind.runs[0].ringSecured).toBe(true);
    // ...and it forfeits the salvage of the runs it does not finish.
    expect(rush.summary.salvageBanked.mean).toBeLessThan(
      grind.summary.salvageBanked.mean,
    );
    // Neither line dominates: the rush is faster but leaves the ring open, the
    // grind secures and banks it for more minutes.
    expect(grind.summary.totalMinutes.mean).toBeGreaterThan(
      rush.summary.totalMinutes.mean,
    );
  }, 60_000);

  it('the default runner plays the real campaign slice for the hex level', () => {
    const runner = createArenaDeploymentRunner();
    const campaignHex = hexRingDefinitionsFor(1).find(
      (entry) => entry.id === 'hex-r1-2',
    )!;
    const result = runner({
      seed: 5,
      hexId: campaignHex.id,
      aggression: campaignHex.baseAggression,
      level: hexDifficultyProfile(campaignHex.baseAggression).level,
      ticks: 600,
      dt: 1 / 60,
      balance: loadBalanceConfig(),
    });
    expect(result.seconds).toBeGreaterThan(0);
    expect(result.seconds).toBeLessThanOrEqual(10);
    expect(typeof result.captured).toBe('boolean');
    expect(result.minerals).toBeGreaterThanOrEqual(0);
  });
});

describe('ring timing: committed baseline evidence', () => {
  const baselinePath = path.resolve(
    process.cwd(),
    'docs/dev/ring-timing-baseline.json',
  );
  const baseline = fs.existsSync(baselinePath)
    ? (JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as Array<{
        ringIndex: number;
        strategy: string;
        runs: Array<{ ringSecured: boolean }>;
        summary: { totalMinutes: { mean: number } };
        budget: { verdict: string; measuredMinutes: number; withinTolerance: boolean };
      }>)
    : [];

  it('records one measurement per ring and line', () => {
    expect(baseline).toHaveLength(4);
    expect(
      baseline.map((report) => `${report.ringIndex}-${report.strategy}`),
    ).toEqual(['1-grind', '1-rush', '2-grind', '2-rush']);
  });

  it('both ring budgets are recorded in-window and internally consistent', () => {
    for (const ringIndex of [1, 2]) {
      const report = baseline.find(
        (entry) => entry.ringIndex === ringIndex && entry.strategy === 'grind',
      )!;
      expect(report.budget.verdict).toBe('in-window');
      expect(report.budget.withinTolerance).toBe(true);
      expect(report.budget.measuredMinutes).toBeCloseTo(
        report.summary.totalMinutes.mean,
        6,
      );
      expect(report.runs.every((run) => run.ringSecured)).toBe(true);
    }
  });

  it('records the rush line as faster and not ring-securing on both rings', () => {
    for (const ringIndex of [1, 2]) {
      const grind = baseline.find(
        (entry) => entry.ringIndex === ringIndex && entry.strategy === 'grind',
      )!;
      const rush = baseline.find(
        (entry) => entry.ringIndex === ringIndex && entry.strategy === 'rush',
      )!;
      expect(rush.summary.totalMinutes.mean).toBeLessThan(
        grind.summary.totalMinutes.mean,
      );
      expect(rush.runs.every((run) => run.ringSecured)).toBe(false);
    }
  });
});

describe('ring timing: report rendering', () => {
  it('renders the totals, the measured runs and the budget verdict', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(),
    });
    const text = formatRingTimingReport(report);
    expect(text).toContain('Ring 1 · grind · seed 1');
    expect(text).toContain('measured runs');
    expect(text).toContain('42.0 min');
    expect(text).toContain('40–60 min');
    expect(text).toContain('in-window');
  });
});

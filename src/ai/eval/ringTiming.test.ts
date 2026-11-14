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
 *   the same summed duration, the two ring grind budgets **miss** their authored
 *   windows on the shipped one-level deployment (AH-0MWCQ4HTC004U73V), and the
 *   rush line is measurably faster but riskier than the grind.
 *
 * The ring-1 / ring-2 grind verdicts are pinned **literally** against the
 * committed artifact (`docs/dev/ring-timing-baseline.json`), so a future
 * re-measurement cannot move the authored budgets' standing silently: the
 * two missed budgets are tracked as separate rebalancing items
 * (AH-0MWFDQ9EY004NO4X ring 1, AH-0MWFDQCFV007BZE5 ring 2).
 *
 * Every assertion is about observable report values, never about how the
 * module is written.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveHexCapture, resolveHexGrant } from '../../core/hangarWar/captureCycle';
import { createRingState } from '../../core/hangarWar/hexRing';
import { hexDifficultyProfile } from '../../core/hangarWar/hexDifficulty';
import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import type { HexRingDefinition } from '../../core/hangarWar/hexRing';
import {
  HEX_RING_DEFINITIONS as HEZ_RING_ONE_ALL,
  hexRingDefinitionsFor,
} from '../../data/hexRingDefinitions';
import { CORE_MINERAL_EQUIVALENT } from '../../core/hangarWar/hangarEconomy';
import {
  DEPLOYMENT_WAVE_COUNT,
  truncateCampaignForDeployment,
} from '../../scenes/hangarWar/hangarDeployment';
import { getLevelDefinition } from '../../waves/Formations';
import { runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import { resolvePolicyFactory } from './policies';
import type { TelemetryEventRecord } from './types';
import {
  DEFAULT_BETWEEN_SORTIE_MINUTES,
  DEFAULT_RING_TIMING_DT,
  RING_DEPLOYMENT_TICKS,
  RING_TIMING_TARGETS,
  RING_TIMING_TOLERANCE_PERCENT,
  createArenaDeploymentRunner,
  createOneLevelArenaDeploymentRunner,
  derivePerDeploymentIncome,
  deriveUnlockPace,
  evaluateRingTimingBudget,
  formatIncomeReport,
  formatRingTimingReport,
  planRingDeployments,
  resolveDeploymentLoadout,
  ringEntryOwnership,
  ringTimingHexes,
  simulateRingTiming,
  withCapturedGrant,
  type PerDeploymentIncome,
  type RingDeploymentLoadout,
  type RingDeploymentRequest,
  type RingDeploymentRunner,
  type RingLoadoutOwnership,
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
    // Aggressions 3, 4 and 6 are lost: 3 losses × 1 retry, each replaying the
    // SAME deployment at its measured 0.5 min (never the retired flat window).
    expect(run.losses).toBe(3);
    expect(run.retryMinutes).toBe(3 * (30 / 60));
    expect(run.salvageForfeited).toBe(3 * 5);
    expect(run.salvageBanked).toBe(3 * 18);
    // 3 safe runs × 5 min + 3 lost runs × 0.5 min + 3 measured retries ×
    // 0.5 min + 6 × 2 min between sorties.
    expect(run.totalMinutes).toBeCloseTo(3 * 5 + 3 * 0.5 + 3 * 0.5 + 12, 5);
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
    // The weapon hex (aggression 6) is lost: 0.5 min measured, replayed once
    // at its own measured 0.5 min.
    expect(run.deployments).toHaveLength(1);
    expect(run.exposedHexes).toBe(5);
    expect(run.expectedRetakes).toBe(2.5);
    // 2.5 expected retakes × (the line's measured mean 0.5-min deployment +
    // the 2-minute visit) — never the retired 5-minute window.
    expect(run.retakeMinutes).toBeCloseTo(2.5 * (0.5 + 2), 5);
    expect(run.totalMinutes).toBeCloseTo(0.5 + 0.5 + 2 + 2.5 * (0.5 + 2), 5);
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

describe('ring timing: the deployment loadout model (AH-0MW9QA2YC009PSF5)', () => {
  it('enters ring 1 with the starter kit and the bare cannon', () => {
    const ownership = ringEntryOwnership(1);
    // The fleet owns the starter hull and the starter `spread` weapon, but the
    // starter weapon is **not selected** — an empty loadout means the bare
    // cannon (AH-0MVZJ6V1J001DA9D).
    expect(ownership.hulls).toEqual(['hull-1']);
    expect(ownership.weapons).toEqual([]);
    expect(ownership.modifiers).toEqual([]);

    const loadout = resolveDeploymentLoadout(ownership);
    expect(loadout.hullId).toBe('hull-1');
    expect(loadout.lives).toBe(3);
    expect(loadout.speedMultiplier).toBe(1);
    expect(loadout.weapons).toEqual([]);
  });

  it('enters ring 2 with every ring-1 grant, the strongest hull and the extra life', () => {
    const ownership = ringEntryOwnership(2);
    expect(ownership.hulls).toEqual(['hull-1', 'hull-2']);
    // Grants are earned in the line's plan order (weakest aggression first), and
    // `ricochet`, `rapid` and `waveLaser` → `wave_laser` resolve to shipped
    // weapons; `extra-life` → `hardened_plating` and `core-bank` are recorded as
    // modifiers (the shipped `resolveHexGrant`).
    expect(ownership.weapons).toEqual(['ricochet', 'rapid', 'wave_laser']);
    expect(ownership.modifiers).toEqual(['hardened_plating', 'core-bank']);

    const loadout = resolveDeploymentLoadout(ownership);
    // `hull-2` is the strongest owned hull: 4 lives + the plating modifier,
    // capped at the run's maximum life count.
    expect(loadout.hullId).toBe('hull-2');
    expect(loadout.lives).toBe(5);
    expect(loadout.speedMultiplier).toBe(0.85);
    expect(loadout.weapons).toEqual([
      { id: 'ricochet', ownedLevel: 1 },
      { id: 'rapid', ownedLevel: 1 },
      { id: 'wave_laser', ownedLevel: 1 },
    ]);
  });

  it('derives the ring-2 entry ownership from the authored ring-1 grants', () => {
    // The expectation is folded from the **authored** grants through the
    // shipped `resolveHexGrant` alias rule, not restated as a literal list: if
    // a ring-1 grant is re-authored (a weapon swapped, a hex added) this test
    // fails instead of silently pinning stale data.
    const expected = {
      hulls: new Set(['hull-1']),
      weapons: new Set<string>(),
      modifiers: new Set<string>(),
    };
    for (const deployment of planRingDeployments(
      hexRingDefinitionsFor(1),
      'grind',
    ).played) {
      const grant = resolveHexGrant(deployment.grants);
      if (grant === null) continue;
      if (grant.kind === 'weapon') {
        expected.weapons.add(grant.weaponId ?? grant.entryId);
      } else if (grant.kind === 'hull') {
        expected.hulls.add(grant.entryId);
      } else {
        expected.modifiers.add(grant.entryId);
      }
    }

    const ownership = ringEntryOwnership(2);
    expect([...ownership.hulls].sort()).toEqual([...expected.hulls].sort());
    expect([...ownership.weapons].sort()).toEqual([...expected.weapons].sort());
    expect([...ownership.modifiers].sort()).toEqual(
      [...expected.modifiers].sort(),
    );
    // The authored data really does grant something, so the derivation above
    // cannot pass vacuously if the grants were removed.
    expect(expected.weapons.size).toBeGreaterThan(0);
    expect(expected.hulls.size).toBeGreaterThan(1);
  });

  it('enters ring 2 on the rush line with the earned loadout and nothing more', () => {
    const report = simulateRingTiming({
      ringIndex: 2,
      strategy: 'rush',
      seeds: [1],
      runDeployment: fakeRunner(),
    });
    const entry = resolveDeploymentLoadout(ringEntryOwnership(2));

    expect(report.entryLoadout).toEqual(entry);
    // The rush line plays the weapon hex and pushes on, so its single ring-2
    // deployment launches with the ring-entry loadout — no within-ring growth.
    const run = report.runs[0];
    expect(run.deployments).toHaveLength(1);
    expect(run.deployments[0].loadout).toEqual(entry);
  });

  it('earns a captured hex grant for the deployments that follow it', () => {
    const entry = ringEntryOwnership(1);
    // hex-r1-1 grants `hull-2`; hex-r1-6 grants `waveLaser` → `wave_laser`.
    const afterHull = withCapturedGrant(entry, 'hull-2');
    expect(afterHull.hulls).toEqual(['hull-1', 'hull-2']);
    expect(resolveDeploymentLoadout(afterHull).lives).toBe(4);

    const afterWeapon = withCapturedGrant(entry, 'waveLaser');
    expect(afterWeapon.weapons).toEqual(['wave_laser']);
    expect(resolveDeploymentLoadout(afterWeapon).weapons).toEqual([
      { id: 'wave_laser', ownedLevel: 1 },
    ]);

    // Idempotent and total: a re-capture or a blank grant changes nothing.
    expect(withCapturedGrant(afterWeapon, 'waveLaser')).toEqual(afterWeapon);
    expect(withCapturedGrant(entry, '')).toEqual(entry);
    // The input ownership is never mutated.
    expect(entry.weapons).toEqual([]);
  });

  it('applies the earned grants progressively, in the line’s play order', () => {
    // A synthetic ring whose hexes grant a weapon, in aggression order.
    const authored = ['ricochet', 'cluster', 'nova', 'arc', 'dual', 'broadside'].map(
      (grants, index) => ({
        ...hex(`hex-grant-${index}`, index),
        grants,
      }),
    );
    const seen: string[][] = [];
    simulateRingTiming({
      ringIndex: 9,
      strategy: 'grind',
      seeds: [1],
      hexes: authored,
      // The starter kit, stated explicitly (ring 9 has no authored data to
      // derive an entry ownership from).
      ownership: { hulls: ['hull-1'], weapons: [], modifiers: [] },
      // The first (weakest) deployment is lost, so it grants nothing; every
      // later one is captured and arms the deployments that follow it.
      runDeployment: (request: RingDeploymentRequest) => {
        seen.push(request.loadout.weapons.map((weapon) => weapon.id));
        return {
          seconds: 300,
          captured: request.hexId !== 'hex-grant-0',
          minerals: 0,
          hits: 0,
        };
      },
    });
    expect(seen).toEqual([
      [],
      [],
      ['cluster'],
      ['cluster', 'nova'],
      ['cluster', 'nova', 'arc'],
      ['cluster', 'nova', 'arc', 'dual'],
    ]);
  });

  it('trims the equipped weapons to the shared slot pool', () => {
    const ownership: RingLoadoutOwnership = {
      hulls: ['hull-1'],
      weapons: [
        'wave_laser',
        'ricochet',
        'nova',
        'arc',
        'dual',
        'broadside',
        'cluster',
      ],
      modifiers: [],
    };
    // The six-slot cap is the shipped one (`capDropIdsToSlotPool`).
    expect(resolveDeploymentLoadout(ownership).weapons).toHaveLength(6);
    expect(
      resolveDeploymentLoadout(ownership).weapons.map((weapon) => weapon.id),
    ).toEqual(['wave_laser', 'ricochet', 'nova', 'arc', 'dual', 'broadside']);
  });

  it('picks the strongest itemised hull, including the ring-2 reward hull', () => {
    // `hull-3` is the ring-2 extra-hit-points hull (AH-0MWF0CUS3009M5SY): once
    // captured it is owned and itemised, so it flies instead of the Bulwark
    // (5 lives vs 4) and the slower hull speed is the trade-off.
    const ownership: RingLoadoutOwnership = {
      hulls: ['hull-1', 'hull-2', 'hull-3'],
      weapons: [],
      modifiers: [],
    };
    const loadout = resolveDeploymentLoadout(ownership);
    expect(loadout.hullId).toBe('hull-3');
    expect(loadout.lives).toBe(5);
    expect(loadout.speedMultiplier).toBe(0.8);
    expect(loadout.ownedHulls).toEqual(['hull-1', 'hull-2', 'hull-3']);
  });

  it('falls back to the strongest itemised hull when a grant is not in the catalogue', () => {
    // A hull grant the catalogue does not itemise (`hull-9`) is owned but
    // contributes no run stats, exactly like `rapid` / `core-bank`.
    const ownership: RingLoadoutOwnership = {
      hulls: ['hull-1', 'hull-2', 'hull-9'],
      weapons: [],
      modifiers: [],
    };
    const loadout = resolveDeploymentLoadout(ownership);
    expect(loadout.hullId).toBe('hull-2');
    expect(loadout.ownedHulls).toEqual(['hull-1', 'hull-2', 'hull-9']);
  });

  it('is deterministic: the same model inputs produce an identical report', () => {
    const options = {
      ringIndex: 1,
      strategy: 'grind' as const,
      seeds: [1, 2],
      runDeployment: fakeRunner(3),
    };
    const first = simulateRingTiming(options);
    const second = simulateRingTiming(options);
    expect(second).toEqual(first);
  });

  it('changes the report when the loadout model changes (negative control)', () => {
    // The equality pin above is only meaningful if the loadout is live input:
    // swapping the earned ownership must change the recorded report.
    const options = {
      ringIndex: 1,
      strategy: 'grind' as const,
      seeds: [1, 2],
      runDeployment: fakeRunner(3),
    };
    const bare = simulateRingTiming(options);
    const armed = simulateRingTiming({
      ...options,
      ownership: {
        hulls: ['hull-1', 'hull-2'],
        weapons: ['wave_laser'],
        modifiers: ['hardened_plating'],
      },
    });

    expect(armed).not.toEqual(bare);
    // The difference is the stated launch loadout, not a stray measurement.
    expect(armed.entryLoadout).not.toEqual(bare.entryLoadout);
    expect(armed.runs[0].deployments[0].loadout).not.toEqual(
      bare.runs[0].deployments[0].loadout,
    );
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

/**
 * The design windows are an **authored input**, so they are pinned literally
 * (AH-0MW9VARCU000XZIL, AC2). The measured-mean assertion in the real-arena
 * suite compares a measurement against whatever the constant says, so on its
 * own it would happily follow an accidental recalibration.
 *
 * Both rings stay at the committed windows — ring 1 **40–60**, ring 2 **90–120**
 * — even though the regenerated one-level sortie misses both (ring 1 grind
 * 16.4 min, ring 2 grind 48.1 min): a window change is a producer ruling, not
 * a re-word of the measurement, so the pins stay authored and each missed
 * budget is re-ruled by its linked rebalancing item (AH-0MWFDQ9EY004NO4X ring
 * 1, AH-0MWFDQCFV007BZE5 ring 2). `docs/EVALUATION.md` records the
 * regenerated measurements as the evidence.
 */
describe('ring timing: the design windows are pinned literally', () => {
  it('pins ring 1 at 40–60 and ring 2 at the committed 90–120', () => {
    expect(RING_TIMING_TARGETS[1]).toEqual({
      minMinutes: 40,
      maxMinutes: 60,
    });
    expect(RING_TIMING_TARGETS[2]).toEqual({
      minMinutes: 90,
      maxMinutes: 120,
    });
  });

  it('derives the stated ±3-minute tolerance from the ring-2 window width', () => {
    // 10 % of a 30-minute window is 3 minutes: a measurement inside the window
    // passes as measured, and one up to 3 minutes outside still passes.
    const measured = evaluateRingTimingBudget(2, 'grind', 117);
    expect(measured.tolerancePercent).toBe(RING_TIMING_TOLERANCE_PERCENT);
    expect(measured.toleranceMinutes).toBeCloseTo(3, 5);
    expect(measured.verdict).toBe('in-window');
    expect(evaluateRingTimingBudget(2, 'grind', 88).verdict).toBe(
      'within-tolerance',
    );
    expect(evaluateRingTimingBudget(2, 'grind', 86).verdict).toBe('missed');
  });
});

/**
 * Per-test cap for the real-arena evidence runs.
 *
 * These tests drive `simulateRingTiming` over the shipped arena, so their
 * runtime is pure simulation cost: the ring-2 grind (3 seeds x 12 hexes) takes
 * ~20 s on an idle machine and measured 126–220 s on a shared 16-core host
 * running several concurrent agent suites. The 60 s cap therefore expired as a
 * load-induced timeout rather than a behavioural regression
 * (AH-0MW0M42H1003J8HW), turning host contention into a red suite. A generous
 * cap keeps a genuine hang bounded while the assertions stay about modelled
 * in-game minutes, never about wall-clock speed.
 */
const REAL_ARENA_TIMEOUT_MS = 300_000;

/** One ring/line report as committed in `docs/dev/ring-timing-baseline.json`. */
type CommittedBaselineReport = {
  ringIndex: number;
  strategy: string;
  runs: Array<{
    ringSecured: boolean;
    totalMinutes: number;
    deploymentMinutes: number;
    betweenSortieMinutes: number;
    retryMinutes: number;
    retakeMinutes: number;
    captured: number;
    losses: number;
  }>;
  summary: {
    totalMinutes: { mean: number; min: number; max: number };
  };
  budget: {
    verdict: string;
    measuredMinutes: number;
    toleranceMinutes: number;
    target: { minMinutes: number; maxMinutes: number } | null;
    withinTolerance: boolean;
    withinWindow: boolean;
  };
};

function readCommittedBaseline(): CommittedBaselineReport[] {
  const baselinePath = path.resolve(
    process.cwd(),
    'docs/dev/ring-timing-baseline.json',
  );
  return fs.existsSync(baselinePath)
    ? (JSON.parse(
        fs.readFileSync(baselinePath, 'utf8'),
      ) as CommittedBaselineReport[])
    : [];
}

/** The committed grind report for a ring — the line the authored budget judges. */
function committedGrindReport(ringIndex: number): CommittedBaselineReport {
  const report = readCommittedBaseline().find(
    (entry) => entry.ringIndex === ringIndex && entry.strategy === 'grind',
  );
  if (!report) throw new Error(`no committed grind report for ring ${ringIndex}`);
  return report;
}

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
  }, REAL_ARENA_TIMEOUT_MS);

  it('the one-level MVP grind measures ~16 min and misses the 40–60 window (AH-0MWCOWSVN003X81A)', () => {
    // One hex, one level, five-wave sortie: measured twice as fast as the
    // retired campaign-slice model and every sortie is lost to enemy fire, so
    // the committed 40–60-minute window no longer holds. The verdict is pinned
    // against the committed artifact (AH-0MWCQ4HTC004U73V) and tracked as the
    // rebalancing item AH-0MWFDQ9EY004NO4X, so a fire-model or balance change
    // cannot move it silently in the meantime.
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1, 2, 3],
    });
    const committed = committedGrindReport(1);
    expect(report.runs[0].deployments).toHaveLength(6);
    // The grind plays every hex, so the ring is secured even though every
    // sortie is a first-attempt loss (losses are retried, not abandoned).
    expect(report.summary.ringSecuredRuns).toBe(3);
    expect(report.budget.verdict).toBe('missed');
    expect(report.budget.verdict).toBe(committed.budget.verdict);
    expect(report.budget.withinTolerance).toBe(false);
    // The real arena still measures the regenerated artifact's numbers: 16.4 min
    // mean on seeds 1–3, decisively below the authored 40-minute floor.
    expect(report.summary.totalMinutes.mean).toBeCloseTo(16.4256, 4);
    expect(report.summary.totalMinutes.mean).toBeCloseTo(
      committed.summary.totalMinutes.mean,
      6,
    );
    expect(report.budget.measuredMinutes).toBeLessThan(
      RING_TIMING_TARGETS[1].minMinutes,
    );
    expect(report.budget.measuredMinutes).toBeGreaterThan(5);
  }, REAL_ARENA_TIMEOUT_MS);

  it('the 12-hex one-level ring 2 grind measures ~48 min and misses the 90–120 window (AH-0MWCOWSVN003X81A)', () => {
    // The same one-level model, twelve hexes: measured ≈ 48 min mean (seeds
    // 1–3), every sortie lost to enemy fire. The 90–120-minute window no longer
    // holds; the verdict is pinned against the committed artifact and tracked
    // as the rebalancing item AH-0MWFDQCFV007BZE5.
    const report = simulateRingTiming({
      ringIndex: 2,
      strategy: 'grind',
      seeds: [1, 2, 3],
    });
    const committed = committedGrindReport(2);
    expect(report.runs[0].deployments).toHaveLength(12);
    expect(report.budget.verdict).toBe('missed');
    expect(report.budget.verdict).toBe(committed.budget.verdict);
    expect(report.budget.withinTolerance).toBe(false);
    expect(report.summary.totalMinutes.mean).toBeCloseTo(48.0967, 4);
    expect(report.summary.totalMinutes.mean).toBeCloseTo(
      committed.summary.totalMinutes.mean,
      6,
    );
    expect(report.budget.measuredMinutes).toBeLessThan(
      RING_TIMING_TARGETS[2].minMinutes,
    );
    expect(report.budget.measuredMinutes).toBeGreaterThan(5);
  }, REAL_ARENA_TIMEOUT_MS);

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
    // On the one-level model every sortie on this seed is a first-attempt
    // loss (the per-level arena's documented fire-on fidelity), so neither
    // line banks salvage — the risk discriminator is exposure + the
    // re-capture charge, not banked salvage.
    expect(rush.runs[0].salvageBanked).toBe(0);
    expect(grind.runs[0].salvageBanked).toBe(0);
    // Neither line dominates: the rush is faster but leaves the ring open, the
    // grind spends more minutes and ends with the ring secured.
    expect(grind.summary.totalMinutes.mean).toBeGreaterThan(
      rush.summary.totalMinutes.mean,
    );
  }, REAL_ARENA_TIMEOUT_MS);

  it('the default runner plays the one-level deployment for the hex level', () => {
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
      loadout: resolveDeploymentLoadout(ringEntryOwnership(1)),
    });
    expect(result.seconds).toBeGreaterThan(0);
    expect(result.seconds).toBeLessThanOrEqual(10);
    expect(typeof result.captured).toBe('boolean');
    expect(result.minerals).toBeGreaterThanOrEqual(0);
  });
});

describe('ring timing: the arena starting-loadout seam is live (AH-0MW9QA2YC009PSF5)', () => {
  /**
   * The seam is proven by measurement, not by inspecting config: the same seed
   * and the same hex played twice, once with the launch loadout the model
   * resolved and once without it, must not measure the same run.
   *
   * Note the **direction** is not asserted for the weapon seam. Equipping the
   * Wave Laser does not make this arena's bot stronger: the arena fires it as a
   * 1-damage non-piercing travelling bullet (the unmodelled hitscan ray,
   * `docs/BALANCING.md` § *Fidelity boundary*), and a stronger loadout also
   * raises the kill-driven campaign escalation. What the test pins is that the
   * seam is **consumed** — the run changes.
   */
  /**
   * Plays one campaign level-4 deployment (the level whose slice reaches enemy
   * fire and ends in a death) at seed 1, with an explicit launch loadout.
   */
  const deploy = (
    loadout: RingDeploymentLoadout,
    level = 4,
    seed = 1,
  ) =>
    createArenaDeploymentRunner()({
      seed,
      hexId: 'hex-r1-1',
      aggression: 2,
      level,
      ticks: 18_000,
      dt: 1 / 60,
      balance: loadBalanceConfig(),
      loadout,
    });

  it('consumes the launched life count: a run that dies spends exactly its lives', () => {
    const hulled = resolveDeploymentLoadout(ringEntryOwnership(2));
    const bareHulled = { ...hulled, lives: 1 };
    const oneLife = deploy(bareHulled);
    const fiveLives = deploy(hulled);
    // Both runs die at level 4, and each spends exactly the lives it launched
    // with — one `player_hit` per life — so the seam really sets the run's
    // lives rather than being ignored.
    expect(oneLife.captured).toBe(false);
    expect(oneLife.hits).toBe(1);
    expect(fiveLives.captured).toBe(false);
    expect(fiveLives.hits).toBe(hulled.lives);
    // More lives also means more run time before the hull is spent.
    expect(fiveLives.seconds).toBeGreaterThan(oneLife.seconds);
  }, REAL_ARENA_TIMEOUT_MS);

  it('consumes the launched weapons and hull speed', () => {
    const starter = resolveDeploymentLoadout(ringEntryOwnership(1));
    const armed = resolveDeploymentLoadout(ringEntryOwnership(2));
    expect(armed.weapons.length).toBeGreaterThan(0);
    // The same seed no longer produces the same run once the fleet's weapons
    // are equipped, nor once the hull's slower speed multiplier applies.
    expect(deploy(armed)).not.toEqual(deploy(starter));
    expect(deploy({ ...armed, speedMultiplier: 0.5 })).not.toEqual(
      deploy({ ...armed, speedMultiplier: 1 }),
    );
  }, REAL_ARENA_TIMEOUT_MS);
});

describe('ring timing: the one-level survival boundary under the deployment loadout', () => {
  /**
   * The one-level model plays the arena's **per-level mode**, whose documented
   * fidelity boundary ignores the wave `shootEnabled` gate — every enemy
   * fires, at every level. With the shipped competent bot and the deployment
   * loadout, a one-level five-wave sortie therefore **dies to enemy fire
   * before the wave-5 clear on every seed**, at every level a ring-1 hex
   * selects (levels 2–3 for hex-r1-2 / hex-r1-1; the higher levels die even
   * sooner). The old campaign-slice boundary (a level-3 slice escalated into
   * the first enemy-fire level 4 by kills) is gone with the slice itself.
   *
   * This pin records the boundary the one-level budgets are now measured at,
   * so a later fire-model or balance change cannot move it silently: a
   * captured one-level sortie, or a surviving seed, would be the change.
   */
  it('a one-level sortie at levels 2–3 dies to enemy fire on every seed', () => {
    const runner = createArenaDeploymentRunner();
    const balance = loadBalanceConfig();
    const loadout = resolveDeploymentLoadout(ringEntryOwnership(2));
    const deploy = (hexId: string, seed: number) => {
      const definition = hexRingDefinitionsFor(1).find(
        (entry) => entry.id === hexId,
      )!;
      return runner({
        seed,
        hexId: definition.id,
        aggression: definition.baseAggression,
        level: hexDifficultyProfile(definition.baseAggression).level,
        ticks: 18_000,
        dt: 1 / 60,
        balance,
        loadout,
      });
    };
    // hex-r1-2 is aggression 1 → level 2; hex-r1-1 is aggression 2 → level 3
    // (the aggression → level mapping is the shipped one). The sortie never
    // clears: every seed dies to a `player_hit` after spending its lives.
    for (const seed of [1, 2, 3]) {
      const atLevel2 = deploy('hex-r1-2', seed);
      expect(atLevel2.captured).toBe(false);
      expect(atLevel2.hits).toBeGreaterThan(0);
      const atLevel3 = deploy('hex-r1-1', seed);
      expect(atLevel3.captured).toBe(false);
      expect(atLevel3.hits).toBeGreaterThan(0);
    }
  }, REAL_ARENA_TIMEOUT_MS);
});

describe('ring timing: the one-level income runner (AH-0MWCOWTOR00994NA)', () => {
  /** A level-2 (aggression 1) sortie request, the ring-1 opener. */
  const sortieRequest = (seed: number, balance: ReturnType<typeof loadBalanceConfig>) => ({
    seed,
    hexId: 'hex-r1-2',
    aggression: 1,
    level: hexDifficultyProfile(1).level,
    ticks: 18_000,
    dt: 1 / 60,
    balance,
    loadout: resolveDeploymentLoadout(ringEntryOwnership(1)),
  });

  it('is deterministic: the same sortie request measures an identical run', () => {
    const runner = createOneLevelArenaDeploymentRunner();
    const balance = loadBalanceConfig();
    const first = runner(sortieRequest(7, balance));
    const second = runner(sortieRequest(7, balance));
    expect(second).toEqual(first);
    // The measurement is the real arena, not a constant.
    expect(first.seconds).toBeGreaterThan(0);
  }, REAL_ARENA_TIMEOUT_MS);

  it('captures a sortie only when its mini-boss is wiped (the arena won)', () => {
    // Seed 7 on the ring-1 opener wipes its five-wave sortie and banks the
    // minerals it held at that checkpoint — a captured one-level deployment
    // is exactly what the mini-boss victory captures in the game.
    const result = createOneLevelArenaDeploymentRunner()(sortieRequest(7, loadBalanceConfig()));
    expect(result.captured).toBe(true);
    expect(result.minerals).toBeGreaterThanOrEqual(0);
  }, REAL_ARENA_TIMEOUT_MS);

  it('measures a faster-paced income than the fire-on per-level runner', () => {
    // The one-level sortie played through the arena's **full-campaign** mode
    // honours the wave `shootEnabled` gate (levels 1–3 do not fire), so the
    // competent bot wipes it and the measured capture rate (and therefore
    // cores + banked minerals per deployment) sits well above the default
    // per-level runner's fire-on result — the income drop the baseline
    // feared is refuted by the measurement (recorded on
    // AH-0MWCOWTOR00994NA).
    const sortie = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      runDeployment: createOneLevelArenaDeploymentRunner(),
    });
    const slice = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
    });
    expect(sortie.summary.captured.mean).toBeGreaterThan(slice.summary.captured.mean);
    expect(sortie.summary.salvageCores.mean).toBeGreaterThan(
      slice.summary.salvageCores.mean,
    );
    // Every captured sortie banks exactly one core (one mini-boss).
    expect(sortie.runs[0].salvageCores).toBe(sortie.runs[0].captured);
  }, REAL_ARENA_TIMEOUT_MS);
});

describe('ring timing: committed baseline evidence', () => {
  const baseline = readCommittedBaseline();

  it('records one measurement per ring and line', () => {
    expect(baseline).toHaveLength(4);
    expect(
      baseline.map((report) => `${report.ringIndex}-${report.strategy}`),
    ).toEqual(['1-grind', '1-rush', '2-grind', '2-rush']);
  });

  /**
   * The two grind verdicts are pinned **explicitly and per ring**
   * (AH-0MWCQ4HTC004U73V): the measured mean, its min–max, the authored window,
   * the tolerance and the delta to the window floor, plus the loss/retry/
   * re-capture split that produces the total. A re-measurement that moves any of
   * them fails here instead of drifting past the authored budgets, and each
   * missed budget is tracked as its own rebalancing item.
   */
  it('ring 1 grind: 16.4 min (15.7–16.9) misses the authored 40–60 min window', () => {
    // Tracked for a producer ruling by AH-0MWFDQ9EY004NO4X.
    const report = committedGrindReport(1);
    expect(report.budget.verdict).toBe('missed');
    expect(report.budget.withinWindow).toBe(false);
    expect(report.budget.withinTolerance).toBe(false);
    expect(report.summary.totalMinutes.mean).toBeCloseTo(16.4256, 4);
    expect(report.summary.totalMinutes.min).toBeCloseTo(15.7239, 4);
    expect(report.summary.totalMinutes.max).toBeCloseTo(16.9144, 4);
    // The authored window and tolerance are unchanged — judged, not re-authored.
    expect(report.budget.target).toEqual(RING_TIMING_TARGETS[1]);
    expect(report.budget.toleranceMinutes).toBeCloseTo(2, 6);
    // Δ to the window floor: 16.4256 − 40 = −23.5744 min (and −21.5744 min
    // below the 38-minute tolerance floor).
    expect(
      report.summary.totalMinutes.mean - RING_TIMING_TARGETS[1].minMinutes,
    ).toBeCloseTo(-23.5744, 4);
    // Re-judged through the shipped budget rule, the artifact's measurement is
    // still `missed`: the verdict is not merely a stored string.
    expect(
      evaluateRingTimingBudget(1, 'grind', report.summary.totalMinutes.mean)
        .verdict,
    ).toBe('missed');
    // The split produces the total: measured replay, 2-minute visits, no
    // re-capture on the grind line.
    for (const run of report.runs) {
      expect(
        run.deploymentMinutes +
          run.betweenSortieMinutes +
          run.retryMinutes +
          run.retakeMinutes,
      ).toBeCloseTo(run.totalMinutes, 9);
      expect(run.retryMinutes).toBeCloseTo(run.deploymentMinutes, 9);
      expect(run.retakeMinutes).toBe(0);
      expect(run.betweenSortieMinutes).toBeCloseTo(12, 9);
      expect(run.captured).toBe(0);
      expect(run.losses).toBe(6);
      expect(run.ringSecured).toBe(true);
    }
  });

  it('ring 2 grind: 48.1 min (42.4–58.4) misses the authored 90–120 min window', () => {
    // Tracked for a producer ruling by AH-0MWFDQCFV007BZE5.
    const report = committedGrindReport(2);
    expect(report.budget.verdict).toBe('missed');
    expect(report.budget.withinWindow).toBe(false);
    expect(report.budget.withinTolerance).toBe(false);
    expect(report.summary.totalMinutes.mean).toBeCloseTo(48.0967, 4);
    expect(report.summary.totalMinutes.min).toBeCloseTo(42.4067, 4);
    expect(report.summary.totalMinutes.max).toBeCloseTo(58.4144, 4);
    expect(report.budget.target).toEqual(RING_TIMING_TARGETS[2]);
    expect(report.budget.toleranceMinutes).toBeCloseTo(3, 6);
    // Δ to the window floor: 48.0967 − 90 = −41.9033 min (and −38.9033 min
    // below the 87-minute tolerance floor).
    expect(
      report.summary.totalMinutes.mean - RING_TIMING_TARGETS[2].minMinutes,
    ).toBeCloseTo(-41.9033, 4);
    expect(
      evaluateRingTimingBudget(2, 'grind', report.summary.totalMinutes.mean)
        .verdict,
    ).toBe('missed');
    for (const run of report.runs) {
      expect(
        run.deploymentMinutes +
          run.betweenSortieMinutes +
          run.retryMinutes +
          run.retakeMinutes,
      ).toBeCloseTo(run.totalMinutes, 9);
      expect(run.retryMinutes).toBeCloseTo(run.deploymentMinutes, 9);
      expect(run.retakeMinutes).toBe(0);
      expect(run.betweenSortieMinutes).toBeCloseTo(24, 9);
      expect(run.captured).toBe(0);
      expect(run.losses).toBe(12);
      expect(run.ringSecured).toBe(true);
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

  it('the README quotes the committed ring-2 mean and window', () => {
    // The README's Hangar War paragraph is the most-read statement of the ring
    // budget; it drifted from the artifact once (it still quoted the
    // pre-loadout 91.6 min and the superseded 70–100 window). Quote the
    // artifact and the constant instead of repeating literals by hand.
    const readme = fs.readFileSync(
      path.resolve(process.cwd(), 'README.md'),
      'utf8',
    );
    const ring2 = baseline.find(
      (entry) => entry.ringIndex === 2 && entry.strategy === 'grind',
    )!;
    const meanMinutes = `${ring2.summary.totalMinutes.mean.toFixed(1)} min`;
    expect(readme).toContain(meanMinutes);
    expect(readme).toMatch(/90\s*[–—-]\s*120/);
    expect(readme).not.toMatch(/70\s*[–—-]\s*100/);
  });
});

/**
 * The committed one-level income artifact (AH-0MWCOWTOR00994NA): the
 * re-baselined per-deployment income and unlock pace for the shipped
 * five-wave sortie, generated deterministically by
 * `npm run ring-timing -- --one-level --income-out docs/dev/one-level-income-baseline.json`.
 * The numbers are quoted in GDD §8.2 and pinned here so a change to the
 * harness model (e.g. the ring-timing chain's runner re-pointing) forces a
 * reviewed re-measurement instead of moving the docs silently.
 */
describe('one-level income baseline evidence (AH-0MWCOWTOR00994NA)', () => {
  const incomePath = path.resolve(
    process.cwd(),
    'docs/dev/one-level-income-baseline.json',
  );
  const income = fs.existsSync(incomePath)
    ? (JSON.parse(fs.readFileSync(incomePath, 'utf8')) as Array<{
        ringIndex: number;
        strategy: string;
        income: PerDeploymentIncome;
        unlockPace: Array<{ id: string; deploymentsToAfford: number }>;
      }>)
    : [];
  const line = (ringIndex: number, strategy: string) =>
    income.find(
      (entry) =>
        entry.ringIndex === ringIndex && entry.strategy === strategy,
    )!;

  it('records one measurement per ring and line', () => {
    expect(
      income.map((entry) => `${entry.ringIndex}-${entry.strategy}`),
    ).toEqual(['1-grind', '1-rush', '2-grind', '2-rush']);
  });

  it('is internally consistent (capture rate, cores and the checkpoint hold)', () => {
    for (const entry of income) {
      const i = entry.income;
      expect(i.captureRate).toBeCloseTo(i.captured / i.deployments, 6);
      expect(i.coresPerCapturedDeployment).toBe(1);
      expect(i.mineralEquivalentPerDeployment).toBeCloseTo(
        i.mineralsPerDeployment + i.coresPerDeployment * CORE_MINERAL_EQUIVALENT,
        6,
      );
      if (i.captured > 0) {
        expect(i.mineralsPerCapturedDeployment).toBeCloseTo(
          (i.mineralsPerDeployment * i.deployments) / i.captured,
          6,
        );
      }
    }
  });

  it('records the re-baselined outcome: income rose vs the campaign slice', () => {
    // The item's working assumption — that the shorter sortie drops
    // per-deployment income — is **refuted** by the measurement: the
    // competent bot wipes the five-wave sortie far more often than it
    // cleared the slice, so capture rate (and therefore cores + banked
    // minerals per deployment) climbs well above the campaign-slice
    // figures (ring-1 grind 0.222 → 0.5, ring-2 grind 0.111 → 0.333).
    const r1g = line(1, 'grind').income;
    const r2g = line(2, 'grind').income;
    expect(r1g.captureRate).toBeGreaterThan(0.22);
    expect(r1g.mineralsPerDeployment).toBeGreaterThan(4);
    expect(r2g.captureRate).toBeGreaterThan(0.11);
    expect(r2g.mineralsPerDeployment).toBeGreaterThan(1.86);
    // Every captured one-level sortie held the same ~18-mineral checkpoint
    // the arena's mineral supply grants a surviving run.
    expect(r1g.mineralsPerCapturedDeployment).toBe(18);
    // The rush line (one weapon hex per ring) banks nothing: its sorties are
    // the ring's hardest and the bot loses them — recorded, not assumed.
    expect(line(1, 'rush').income.captured).toBe(0);
    expect(line(2, 'rush').income.captured).toBe(0);
  });

  it('records a shorter unlock pace for every rings-1-2 entry', () => {
    const pace = new Map(
      line(1, 'grind').unlockPace.map((entry) => [
        entry.id,
        entry.deploymentsToAfford,
      ]),
    );
    // Campaign-slice before: hull-2 55 / wave_laser 30 / ricochet 23 /
    // cluster 40 / hardened_plating 20 ring-1-grind deployments.
    expect(pace.get('hull-2')).toBe(25);
    expect(pace.get('wave_laser')).toBe(14);
    expect(pace.get('ricochet')).toBe(10);
    expect(pace.get('cluster')).toBe(18);
    expect(pace.get('hardened_plating')).toBe(9);
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

  it('reports the banked cores alongside the banked salvage', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
    });
    // Six deployments, three captured (aggressions 1, 2, 2): one core each.
    expect(report.runs[0].salvageCores).toBe(3);
    expect(report.runs[0].salvageBanked).toBe(3 * 18);
    expect(report.summary.salvageCores.mean).toBe(3);
    expect(formatRingTimingReport(report)).toContain('3.0 cores');
  });
});

/**
 * The per-deployment income view (AH-0MWCOWTOR00994NA): a captured
 * deployment banks exactly **one core** plus the minerals it held at the
 * mini-boss checkpoint, and a loss banks nothing — so per-deployment income
 * is the arithmetical mean over every deployment a line plays (losses count
 * as 0), and the checkpoint figure is the mean over captured deployments
 * only.
 */
describe('ring timing: per-deployment income (AH-0MWCOWTOR00994NA)', () => {
  it('derives the per-deployment income from a measured report', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
    });
    // Aggressions 1, 2, 2 captured (18 minerals each) and 3, 4, 6 lost: the
    // fake runner's safe runs collect 18 minerals, its lost runs 5 (forfeit).
    const income = derivePerDeploymentIncome(report);
    expect(income.deployments).toBe(6);
    expect(income.captured).toBe(3);
    expect(income.captureRate).toBeCloseTo(0.5, 6);
    expect(income.mineralsPerDeployment).toBeCloseTo(3 * 18 / 6, 6);
    expect(income.mineralsPerCapturedDeployment).toBe(18);
    expect(income.coresPerDeployment).toBeCloseTo(0.5, 6);
    expect(income.coresPerCapturedDeployment).toBe(1);
    // The comparison aid: each core is worth CORE_MINERAL_EQUIVALENT minerals.
    expect(income.mineralEquivalentPerDeployment).toBeCloseTo(
      income.mineralsPerDeployment + income.coresPerDeployment * CORE_MINERAL_EQUIVALENT,
      6,
    );
  });

  it('reports an all-loss line as zero income', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'rush',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(1),
    });
    const income = derivePerDeploymentIncome(report);
    expect(income.captured).toBe(0);
    expect(income.mineralsPerDeployment).toBe(0);
    expect(income.coresPerDeployment).toBe(0);
    expect(income.captureRate).toBe(0);
  });

  it('aggregates across seeds before deriving the income', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1, 2, 3],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
    });
    const income = derivePerDeploymentIncome(report);
    // Every seed behaves identically under the fake runner.
    expect(income.deployments).toBe(18);
    expect(income.captured).toBe(9);
    expect(income.mineralsPerDeployment).toBeCloseTo(9, 6);
    expect(income.coresPerDeployment).toBeCloseTo(0.5, 6);
  });
});

/**
 * The unlock pace (AH-0MWCOWTOR00994NA, AC2): deployments needed to afford
 * each rings-1-2 catalogue entry from the measured per-deployment income.
 * A purchase needs **both** currencies at once (canBuy/buy), so the pace is
 * the slower of the two currency bounds — minerals and cores — never their
 * sum or a mineral-only rate.
 */
describe('ring timing: the unlock pace (AH-0MWCOWTOR00994NA)', () => {
  /** The buyable rings-1-2 catalogue entries, in catalogue order. */
  const BUYABLE = [
    'hull-2',
    'hull-3',
    'wave_laser',
    'ricochet',
    'cluster',
    'hardened_plating',
    // The defending-bot skill modifier (AH-0MVWZYJ740037EZ1).
    'anti_maw_plating',
  ];

  it('derives deployments-to-afford from both currency bounds', () => {
    const income: PerDeploymentIncome = {
      deployments: 6,
      captured: 3,
      captureRate: 0.5,
      mineralsPerDeployment: 9,
      coresPerDeployment: 0.5,
      mineralsPerCapturedDeployment: 18,
      coresPerCapturedDeployment: 1,
      mineralEquivalentPerDeployment: 9 + 0.5 * CORE_MINERAL_EQUIVALENT,
    };
    const pace = deriveUnlockPace(income);
    expect(pace.map((entry) => entry.id)).toEqual(BUYABLE);
    const byId = new Map(pace.map((entry) => [entry.id, entry]));
    // hull-2 (220 minerals / 3 cores): 220/9 → 25 deployments; cores are the
    // cheaper bound (3/0.5 = 6), so the mineral bound decides.
    expect(byId.get('hull-2')!.deploymentsToAfford).toBe(25);
    expect(byId.get('hull-2')!.mineralBoundDeployments).toBe(25);
    expect(byId.get('hull-2')!.coreBoundDeployments).toBe(6);
    expect(byId.get('hull-2')!.price).toEqual({ minerals: 220, cores: 3 });
    // hull-3 (320 minerals / 4 cores): 320/9 → 36 deployments; the cores are
    // still the cheaper bound (4/0.5 = 8), so minerals decide. The ring-2
    // special-reward hull is the tree's most expensive unlock.
    expect(byId.get('hull-3')!.deploymentsToAfford).toBe(36);
    expect(byId.get('hull-3')!.mineralBoundDeployments).toBe(36);
    expect(byId.get('hull-3')!.coreBoundDeployments).toBe(8);
    expect(byId.get('hull-3')!.price).toEqual({ minerals: 320, cores: 4 });
    // ricochet (90 minerals / 2 cores): 90/9 = 10 ≶ 2/0.5 = 4 → minerals.
    expect(byId.get('ricochet')!.deploymentsToAfford).toBe(10);
    // hardened_plating (80/1): 80/9 → 9 deployments.
    expect(byId.get('hardened_plating')!.deploymentsToAfford).toBe(9);
    // wave_laser (120/1): 120/9 → 14.
    expect(byId.get('wave_laser')!.deploymentsToAfford).toBe(14);
    // cluster (160/1): 160/9 → 18.
    expect(byId.get('cluster')!.deploymentsToAfford).toBe(18);
  });

  it('reports an infinite pace for a line that banks nothing', () => {
    const zero: PerDeploymentIncome = {
      deployments: 6,
      captured: 0,
      captureRate: 0,
      mineralsPerDeployment: 0,
      coresPerDeployment: 0,
      mineralsPerCapturedDeployment: 0,
      coresPerCapturedDeployment: 0,
      mineralEquivalentPerDeployment: 0,
    };
    const pace = deriveUnlockPace(zero);
    expect(pace.every((entry) => entry.deploymentsToAfford === Number.POSITIVE_INFINITY)).toBe(
      true,
    );
  });

  it('derives the pace from a measured report rather than hand-edited numbers', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
    });
    const pace = deriveUnlockPace(derivePerDeploymentIncome(report));
    // Same income (9 minerals / 0.5 cores per deployment) as the pinned case.
    expect(pace.find((entry) => entry.id === 'hull-2')!.deploymentsToAfford).toBe(25);
  });
});

describe('ring timing: income report rendering (AH-0MWCOWTOR00994NA)', () => {
  it('renders the checkpoint income and the unlock pace table', () => {
    const report = simulateRingTiming({
      ringIndex: 1,
      strategy: 'grind',
      seeds: [1],
      hexes: modelRing(),
      runDeployment: fakeRunner(3),
    });
    const text = formatIncomeReport(report);
    expect(text).toContain('Ring 1 · grind');
    expect(text).toContain('6 (3 captured, 50.0%)');
    expect(text).toContain('18.0 at the mini-boss checkpoint per captured');
    expect(text).toContain('1.0 per captured');
    expect(text).toContain('unlock pace');
    expect(text).toContain('hull-2');
    expect(text).toContain('25 deployments');
  });
});

/**
 * ## The one-level deployment model (parent: AH-0MWCOWSVN003X81A)
 *
 * A deployment is **one hex, one level**, played as the shipped **five-wave
 * sortie** — the level's first four regular waves plus the wave-5 mini-boss
 * composition, truncated with the same pure helper the game uses
 * (`truncateCampaignForDeployment` / `DEPLOYMENT_WAVE_COUNT` in
 * `src/scenes/hangarWar/hangarDeployment.ts`) — through the arena's per-level
 * mode. The arena emits `level_cleared` when the fifth wave's composition
 * clears (the mini-boss encounter itself is not simulated — the fidelity gap
 * stated on the parent), and the deployment's length is that event's tick ×
 * `dt`. Neither `ticksSimulated` nor `won` describes a deployment: the run
 * keeps simulating past the clear and `won` is false while the asteroid
 * shadow-hazard lingers.
 *
 * **Red-before/green-after (AH-0MWCQ4EZD006YWHV).** These cases pin the model
 * against the current campaign-slice harness: every case fails on the
 * pre-change harness at the intended assertion (the red witnesses are recorded
 * on the work item) and is wrapped in Vitest's `it.fails` — the repo's
 * red-before/green-after convention — so the suite stays green on pre-change
 * HEAD. The implementation item (AH-0MWCQ4FWN009J9DM) **flips every
 * `it.fails` back to a plain `it`** and implements the model; a leftover
 * `it.fails` then fails the suite, so this is a real target rather than a
 * permanent exemption.
 */
describe('ring timing: the one-level deployment model', () => {
  /**
   * A runner whose reports model the one-level deployment: a captured sortie
   * clears at `clearSeconds`, a death before it ends at `deathSeconds`.
   * Aggressions at or above `loseFrom` die before the clear (default: never).
   */
  function oneLevelRunner(options: {
    readonly clearSeconds?: number;
    readonly deathSeconds?: number;
    readonly loseFrom?: number;
  }): RingDeploymentRunner {
    const clearSeconds = options.clearSeconds ?? 45;
    const deathSeconds = options.deathSeconds ?? 12;
    const loseFrom = options.loseFrom ?? Number.POSITIVE_INFINITY;
    return (request) =>
      request.aggression >= loseFrom
        ? { seconds: deathSeconds, captured: false, minerals: 3, hits: 1 }
        : { seconds: clearSeconds, captured: true, minerals: 18, hits: 0 };
  }

  it(
    'a per-level deployment measures its level_cleared tick — one tick exactly, never the run length or won',
    () => {
      const dt = DEFAULT_RING_TIMING_DT;
      const ticks = RING_DEPLOYMENT_TICKS;
      const seed = 11;
      const level = 1;

      // The sortie this measures is the shipped five-wave one: the level's
      // first four regular waves plus the wave-5 mini-boss composition,
      // truncated by the SAME pure helper the game uses — never a hard-coded
      // 5 or 10 (AH-0MWCQ4EZD006YWHV coordination note).
      const sortie = truncateCampaignForDeployment([getLevelDefinition(level)!])[0];
      expect(sortie.waves).toHaveLength(DEPLOYMENT_WAVE_COUNT);
      expect(sortie.waves[DEPLOYMENT_WAVE_COUNT - 1].miniBoss).toBe(true);
      expect(
        sortie.waves
          .slice(0, DEPLOYMENT_WAVE_COUNT - 1)
          .some((wave) => wave.miniBoss),
      ).toBe(false);

      // A deterministic no-fire balance: the per-level arena ignores the
      // wave `shootEnabled` gate (its documented fidelity boundary) and every
      // enemy fires, so the competent bot cannot survive one level long enough
      // to clear it. Zeroing `shotProbability` pins the seam the runner reads
      // (`level_cleared` with its tick) for a fixed seed instead of leaving it
      // hostage to the bot's survival. The armed ring-2 entry loadout (five
      // lives, three weapons) is what a measured deployment actually launches
      // with (AH-0MW9QA2YC009PSF5). Measured: seed 11 clears level 1 at tick
      // 12 334 inside the 18 000-tick window.
      const noFireBalance = {
        ...loadBalanceConfig(),
        enemies: loadBalanceConfig().enemies.map((enemy) => ({
          ...enemy,
          shotProbability: 0,
        })),
      };
      const armedLoadout = resolveDeploymentLoadout(ringEntryOwnership(2));

      // Read the seam the runner must consume: a per-level run emits
      // `level_cleared` on the same tick it detects the final wave's clear.
      // (The asteroid shadow-hazard is off here so the sortie clears
      // deterministically — nothing lingers, so `won` is true at the end; the
      // model's *other* guard shape — `won` false while an asteroid lingers —
      // is the real runner's everyday outcome and is why the duration must
      // never come from `won`.)
      const arena = runArena(resolvePolicyFactory('competent').create(), {
        seed,
        ticks,
        dt,
        level,
        balance: noFireBalance,
        spawns: { asteroids: 0 },
        sampleEveryTicks: ticks,
        startingLoadout: {
          lives: armedLoadout.lives,
          speedMultiplier: armedLoadout.speedMultiplier,
          weapons: armedLoadout.weapons,
        },
      });
      const cleared = arena.records.find(
        (record): record is TelemetryEventRecord =>
          record.kind === 'event' && record.event === 'level_cleared',
      );
      expect(cleared).toBeDefined();
      const finalWaveCleared = arena.records
        .filter(
          (record): record is TelemetryEventRecord =>
            record.kind === 'event' && record.event === 'wave_cleared',
        )
        .at(-1);
      const lastKill = arena.records
        .filter(
          (record): record is TelemetryEventRecord =>
            record.kind === 'event' && record.event === 'enemy_killed',
        )
        .at(-1);
      expect(finalWaveCleared).toBeDefined();
      expect(lastKill).toBeDefined();
      // The one-tick emission convention, pinned literally: the level-clear is
      // emitted on the tick the final wave-clear is detected — exactly one
      // tick after the final wave's last member fell — so a later refactor
      // cannot silently shift every deployment's measured length.
      expect(cleared!.tick).toBe(finalWaveCleared!.tick);
      expect(cleared!.tick).toBe(lastKill!.tick + 1);
      // The run keeps simulating past the clear to `config.ticks`, so the run
      // length (here 300 s) is not the deployment's length.
      expect(arena.ticksSimulated).toBeGreaterThan(cleared!.tick);
      expect(arena.ticksSimulated).toBe(ticks);

      const result = createArenaDeploymentRunner()({
        seed,
        hexId: 'hex-r1-2',
        aggression: 0,
        level,
        ticks,
        dt,
        balance: noFireBalance,
        loadout: armedLoadout,
      });
      // A cleared sortie is captured, and its duration is the clear tick × dt:
      // the deployment ends at the clear, not at the 300 s run window. (This
      // pair was the red witness while the runner still played the campaign
      // slice; the one-level runner turns it green, AH-0MWCQ4FWN009J9DM.)
      expect(result.captured).toBe(true);
      expect(result.seconds).toBeLessThan(ticks * dt);
    },
  );

  it(
    'a cleared sortie is captured; a death before it is a loss charged its own measured length',
    () => {
      const report = simulateRingTiming({
        ringIndex: 1,
        strategy: 'grind',
        seeds: [1],
        hexes: modelRing(),
        runDeployment: oneLevelRunner({ clearSeconds: 45, deathSeconds: 12, loseFrom: 3 }),
      });
      const run = report.runs[0];
      const capturedByHex = new Map<string, boolean>([
        ['hex-1', true],
        ['hex-2', true],
        ['hex-3', false],
        ['hex-4', true],
        ['hex-5', false],
        ['hex-6', false],
      ]);
      for (const deployment of run.deployments) {
        const captured = capturedByHex.get(deployment.hexId)!;
        expect(deployment.captured).toBe(captured);
        expect(deployment.retries).toBe(captured ? 0 : 1);
        if (captured) {
          // A captured sortie costs exactly its measured clear length.
          expect(deployment.minutes).toBeCloseTo(deployment.seconds / 60, 5);
        } else {
          // A loss costs the death's measured length, replayed once at that
          // same length — never the flat 5-minute retry window.
          expect(deployment.seconds).toBe(12);
          expect(deployment.minutes).toBeCloseTo(2 * (deployment.seconds / 60), 5);
        }
      }
      expect(run.captured).toBe(3);
      expect(run.losses).toBe(3);
    },
  );

  it(
    'a lost deployment’s retry is its own measured length × retriesPerLoss — never the flat 5-minute window',
    () => {
      const report = simulateRingTiming({
        ringIndex: 1,
        strategy: 'grind',
        seeds: [1],
        hexes: modelRing(),
        retriesPerLoss: 2,
        runDeployment: oneLevelRunner({ clearSeconds: 45, deathSeconds: 12, loseFrom: 0 }),
      });
      const run = report.runs[0];
      expect(run.losses).toBe(6);
      // Each loss replays its own measured 12 s, twice: 6 × 2 × 0.2 min.
      expect(run.retryMinutes).toBeCloseTo(6 * 2 * (12 / 60), 5);
      // The retired flat 5-minute window (RING_DEPLOYMENT_TICKS × dt / 60) is
      // no longer the retry price.
      const retiredFlatMinutes = (RING_DEPLOYMENT_TICKS * DEFAULT_RING_TIMING_DT) / 60;
      expect(run.retryMinutes).not.toBeCloseTo(6 * 2 * retiredFlatMinutes, 5);
    },
  );

  it(
    'the between-sortie allowance stays a flat, documented 2 minutes, and the total uses the measured retry',
    () => {
      const report = simulateRingTiming({
        ringIndex: 1,
        strategy: 'grind',
        seeds: [1],
        hexes: modelRing(),
        runDeployment: oneLevelRunner({ clearSeconds: 45, deathSeconds: 12, loseFrom: 3 }),
      });
      const run = report.runs[0];
      // The flat 2-minute visit is shipped data, pinned literally.
      expect(DEFAULT_BETWEEN_SORTIE_MINUTES).toBe(2);
      expect(run.betweenSortieMinutes).toBe(6 * DEFAULT_BETWEEN_SORTIE_MINUTES);
      // 3 clears × 0.75 min + 3 losses × (0.2 measured + 0.2 retried) + 12 min
      // of between-sortie visits.
      expect(run.totalMinutes).toBeCloseTo(
        3 * 0.75 + 3 * (0.2 + 0.2) + 6 * DEFAULT_BETWEEN_SORTIE_MINUTES,
        5,
      );
    },
  );

  it(
    'a rush re-capture charges the line’s measured mean deployment plus the 2-minute visit (Q4 = a)',
    () => {
      const report = simulateRingTiming({
        ringIndex: 1,
        strategy: 'rush',
        seeds: [1],
        hexes: modelRing(),
        runDeployment: oneLevelRunner({ clearSeconds: 45 }),
        retakeChancePercent: 70,
      });
      const run = report.runs[0];
      expect(run.deployments).toHaveLength(1);
      expect(run.exposedHexes).toBe(5);
      expect(run.expectedRetakes).toBeCloseTo(5 * 0.7, 5);
      // The line's measured mean deployment (here its single 45 s sortie)
      // plus the unchanged 2-minute visit — not the retired 18 000-tick window.
      const meanDeployment = run.deployments[0].seconds / 60;
      expect(run.retakeMinutes).toBeCloseTo(
        run.expectedRetakes * (meanDeployment + DEFAULT_BETWEEN_SORTIE_MINUTES),
        5,
      );
      const retiredWindowMinutes = (RING_DEPLOYMENT_TICKS * DEFAULT_RING_TIMING_DT) / 60;
      expect(run.retakeMinutes).not.toBeCloseTo(
        run.expectedRetakes * (retiredWindowMinutes + DEFAULT_BETWEEN_SORTIE_MINUTES),
        5,
      );
    },
  );

  it(
    'is deterministic: the same seeds and options reproduce the measured seconds, retries and re-capture',
    () => {
      const options = {
        ringIndex: 1,
        strategy: 'rush' as const,
        seeds: [1, 2],
        retriesPerLoss: 2,
        retakeChancePercent: 70,
        runDeployment: oneLevelRunner({ clearSeconds: 45, deathSeconds: 12, loseFrom: 3 }),
      };
      const first = simulateRingTiming(options);
      const second = simulateRingTiming(options);
      expect(second).toEqual(first);
      expect(second.runs[0]).toEqual(first.runs[0]);
      // The reported numbers are the new model's, not the campaign slice's:
      for (const run of first.runs) {
        // The one rush sortie is lost at its measured 12 s, replayed twice.
        expect(run.retryMinutes).toBeCloseTo(2 * (12 / 60), 5);
        // Re-capture: 5 exposed hexes × 70 % × (the measured 0.2 min + visit).
        expect(run.retakeMinutes).toBeCloseTo(
          5 * 0.7 * ((12 / 60) + DEFAULT_BETWEEN_SORTIE_MINUTES),
          5,
        );
      }
    },
  );
});

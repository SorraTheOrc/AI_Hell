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
  resolveDeploymentLoadout,
  ringEntryOwnership,
  ringTimingHexes,
  simulateRingTiming,
  withCapturedGrant,
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

  it('falls back to the strongest itemised hull when a grant is not in the catalogue', () => {
    // Ring 2 grants `hull-3`, which the catalogue does not itemise yet: it is
    // owned but contributes no run stats, exactly like `rapid` / `core-bank`.
    const ownership: RingLoadoutOwnership = {
      hulls: ['hull-1', 'hull-2', 'hull-3'],
      weapons: [],
      modifiers: [],
    };
    const loadout = resolveDeploymentLoadout(ownership);
    expect(loadout.hullId).toBe('hull-2');
    expect(loadout.ownedHulls).toEqual(['hull-1', 'hull-2', 'hull-3']);
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
});

describe('ring timing: budget verdicts', () => {  it('accepts a measurement inside the window', () => {
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
  }, REAL_ARENA_TIMEOUT_MS);

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
    // ...and it forfeits the salvage of the runs it does not finish.
    expect(rush.summary.salvageBanked.mean).toBeLessThan(
      grind.summary.salvageBanked.mean,
    );
    // Neither line dominates: the rush is faster but leaves the ring open, the
    // grind secures and banks it for more minutes.
    expect(grind.summary.totalMinutes.mean).toBeGreaterThan(
      rush.summary.totalMinutes.mean,
    );
  }, REAL_ARENA_TIMEOUT_MS);

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

describe('ring timing: the level-3 boundary under the deployment loadout', () => {
  /**
   * The bare-cannon boundary was bisected (AH-0MWAPWS1W007LGGY) to the arena's
   * own fire-model fidelity commit `6ecbab23` (AH-0MW5DVAME0062GQO): firing the
   * run's permanent choice grants lifts the bot's damage output, and the
   * kill-driven campaign slice escalates by kills, so a run started at campaign
   * level 3 climbed into the first enemy-fire level (4) *inside* the fixed
   * deployment window and died at ≈250 s — which is why ring 2 measured every
   * hex as a first-attempt loss.
   *
   * Measuring the **deployment loadout** instead of the bare cannon
   * (AH-0MW9QA2YC009PSF5) restores most of that survival: campaign level 2
   * captures the full window on every seed, and level 3 captures on two of
   * three seeds and still dies to enemy fire on the third. This pin records the
   * boundary the budgets are now measured at, so a later fire-model or balance
   * change cannot move it silently.
   */
  it('captures level 2 on every seed and level 3 on two of three seeds', () => {
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
    // hex-r1-2 is aggression 1 → campaign level 2; hex-r1-1 is aggression 2 →
    // campaign level 3 (the aggression → level mapping is the shipped one).
    for (const seed of [1, 2, 3]) {
      expect(deploy('hex-r1-2', seed).captured).toBe(true);
    }
    expect(deploy('hex-r1-1', 1).captured).toBe(true);
    expect(deploy('hex-r1-1', 2).captured).toBe(true);
    const thirdSeed = deploy('hex-r1-1', 3);
    expect(thirdSeed.captured).toBe(false);
    // The loss is enemy fire — the run reached the first enemy-fire level (4)
    // inside the window, which is the mechanism the boundary records.
    expect(thirdSeed.hits).toBeGreaterThan(0);
  }, REAL_ARENA_TIMEOUT_MS);
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

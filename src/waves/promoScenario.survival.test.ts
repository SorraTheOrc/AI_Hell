/**
 * Hermetic promo-scenario survival check (AH-0MVSDMDA1003ARV5, child of
 * AH-0MVI5XI73000ZVYA).
 *
 * Proves the parent's sustained-footage target: every registered promo
 * scenario must keep the competent bot alive and producing action for at
 * least {@link PROMO_SURVIVAL_MIN_SECONDS} (45 s) before the run ends, so a
 * promo clip is never a bot dying on the first wave.
 *
 * The measurement is headless and hermetic (no browser, no Phaser, no
 * wall-clock): `src/waves/promoSurvival.ts` plays each scenario's authored
 * promo level as the whole campaign through the shipped evaluation harness
 * (`src/ai/eval/arena.ts`), flown by the competent bot configured with the
 * scenario's curated bot-tuning preset and seeded with the scenario's seed —
 * exactly the way `PlayScene` runs a promo capture.
 *
 * The suite asserts (parent AC map):
 *
 * - **AC1 (harness):** the harness measures **every** registered promo
 *   scenario (registry ↔ harness parity) and reports its simulated action
 *   duration and end reason.
 * - **AC2 (threshold):** no scenario measures below 45 s; a failure message
 *   names the scenario and its measured duration.
 * - **AC3 (tuning):** the measurement is reproducible per scenario (same
 *   seed ⇒ identical ticks), so a calibrated number is evidence rather than
 *   noise. The parity/duplicate-body guards stay green in the rest of the
 *   suite (this change adds authored promo content and presets only).
 * - **AC4 (regression):** each run is bounded by the tick budget, so the
 *   check is a fast, deterministic part of the standard suite.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  PROMO_SURVIVAL_DT,
  PROMO_SURVIVAL_MIN_SECONDS,
  PROMO_SURVIVAL_TICK_BUDGET,
  describePromoSurvivalFailure,
  measurePromoScenario,
  measurePromoSurvivalCatalogue,
  promoScenarioEntries,
  type PromoSurvivalReport,
} from './promoSurvival';

/**
 * The measured catalogue, computed once for the whole suite: each run is a
 * deterministic headless simulation, so measuring once keeps the suite fast
 * while every assertion reads the same evidence. The wall-clock timeout is
 * deliberately generous (the CPU-bound simulations can queue behind other
 * suites in a parallel run); the simulated window per scenario is bounded by
 * {@link PROMO_SURVIVAL_TICK_BUDGET}, so the check itself is bounded.
 */
let report: PromoSurvivalReport;

beforeAll(() => {
  report = measurePromoSurvivalCatalogue();
}, 120_000);

describe('promo scenario survival harness (AH-0MVSDMDA1003ARV5, AC1)', () => {
  it('measures every registered promo scenario exactly once', () => {
    const registered = promoScenarioEntries().map((scenario) => scenario.name);
    const measured = report.measurements.map((measurement) => measurement.scenario);

    // Registry ↔ harness parity: a promo scenario added to the catalogue is
    // measured automatically, and the harness never invents a scenario.
    expect(measured).toEqual(registered);
    expect(registered.length).toBeGreaterThanOrEqual(10);
  });

  it('reports each scenario\'s duration, end reason and the preset it flew', () => {
    const byName = new Map(
      promoScenarioEntries().map((scenario) => [scenario.name, scenario]),
    );

    for (const measurement of report.measurements) {
      const scenario = byName.get(measurement.scenario);
      expect(scenario, measurement.scenario).toBeDefined();
      // The harness must measure the authored scenario, not a default:
      // the level it plays and the preset it flies come from the registry.
      expect(measurement.promoLevel).toBe(scenario!.promoLevel);
      expect(measurement.preset).toBe(scenario!.preset);
      expect(measurement.seed).toBe(scenario!.seed);
      // A bounded, positive action window with a known end reason.
      expect(measurement.ticks).toBeGreaterThan(0);
      expect(measurement.ticks).toBeLessThanOrEqual(PROMO_SURVIVAL_TICK_BUDGET);
      expect(measurement.seconds).toBeCloseTo(
        measurement.ticks * PROMO_SURVIVAL_DT,
        3,
      );
      expect(['player-death', 'campaign-cleared', 'tick-budget']).toContain(
        measurement.endReason,
      );
    }
  });

  it('is reproducible per scenario seed (same scenario ⇒ identical duration)', () => {
    // One scenario is enough: `runArena` is deterministic in the seed and the
    // policy, which is the property the calibrated numbers rely on.
    const scenario = promoScenarioEntries()[0];
    const first = measurePromoScenario(scenario);
    const second = measurePromoScenario(scenario);

    expect(second.ticks).toBe(first.ticks);
    expect(second.endReason).toBe(first.endReason);
  }, 60_000);
});

describe('promo scenario sustained footage (AH-0MVSDMDA1003ARV5, AC2)', () => {
  it(`sustains at least ${PROMO_SURVIVAL_MIN_SECONDS} s of action in every scenario`, () => {
    const failures = report.measurements.filter(
      (measurement) => measurement.seconds < PROMO_SURVIVAL_MIN_SECONDS,
    );

    // The message names the scenario and the measured duration for every
    // scenario that misses the target, as AC2 requires.
    expect(
      failures.map(describePromoSurvivalFailure),
      'promo scenarios below the sustained-footage target',
    ).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('ends every run inside the bounded tick budget (AC4)', () => {
    for (const measurement of report.measurements) {
      expect(
        measurement.ticks,
        `${measurement.scenario} exceeded the bounded tick budget`,
      ).toBeLessThanOrEqual(PROMO_SURVIVAL_TICK_BUDGET);
    }
  });
});

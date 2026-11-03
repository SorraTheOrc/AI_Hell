/**
 * Hermetic promo-scenario **arena smoke signal** (AH-0MVSDMDA1003ARV5, child
 * of AH-0MVI5XI73000ZVYA; demoted by AH-0MW06XJKA009WX4B).
 *
 * A promo clip is only usable if the bot survives long enough to cut, but the
 * authoritative check for that is the **real-game** suite
 * `src/scenes/PromoScenarioSurvival.integration.test.ts`: it boots the real
 * `PlayScene` (formation descent, the real collision/spawner loop) and asserts
 * the ≥45 s target for every registered promo scenario.
 *
 * This suite is retained as a **bounded smoke signal** over the same
 * catalogue, using the fast arena harness (`src/waves/promoSurvival.ts`). The
 * arena omits Phaser formation movement/descent, so its durations do not
 * track the shipped game — they move with bot-steering changes while the real
 * game stays green — and it therefore makes **no ≥45 s assertion** (producer
 * decision (a) on AH-0MW06XJKA009WX4B). What it still proves cheaply:
 *
 * - **parity:** the harness measures **every** registered promo scenario
 *   exactly once (registry ↔ harness), never an invented one;
 * - **shape:** each measurement carries the authored `promoLevel`, `preset`
 *   and `seed`, a positive duration inside the bounded tick budget and a
 *   known end reason;
 * - **determinism:** the same scenario seed measures the same duration, so
 *   the number is reproducible evidence rather than noise.
 *
 * The ≥45 s assertion moved to the real-game check with the producer's
 * decision; re-adding it here would resurrect the contradiction between the
 * two oracles.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  PROMO_SURVIVAL_DT,
  PROMO_SURVIVAL_TICK_BUDGET,
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

describe('promo scenario arena smoke signal (AH-0MVI5XI73000ZVYA, AC5)', () => {
  it('ends every run inside the bounded tick budget (AC4)', () => {
    for (const measurement of report.measurements) {
      expect(
        measurement.ticks,
        `${measurement.scenario} exceeded the bounded tick budget`,
      ).toBeLessThanOrEqual(PROMO_SURVIVAL_TICK_BUDGET);
    }
  });
});

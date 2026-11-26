/**
 * Tests for parameter fitting (AH-0MUY08XXN003NV0I, AC2).
 *
 * The fitting path must map each extracted style feature onto a structured
 * bot knob *and* never weaken the bot's safety invariants, whatever the input
 * profile. These are pure-function tests over hand-built feature vectors, so
 * every mapping has an exact expected value and the safety envelope is probed
 * with adversarial inputs.
 *
 * The governor's turn/aim knobs are covered too
 * (AH-0MWLCGWUF00631UX): the calmer flight model added them, so the fit must
 * move them with the human's cadence/hold features and stand-off instead of
 * silently leaving the bot on a governor it no longer flies.
 */

import { describe, expect, it } from 'vitest';

import { BOT_HUMAN_INPUT_TUNABLES } from '../botHumanLike';
import {
  COMPETENT_BOT_TUNABLES,
  resolveCompetentTunables,
} from '../framework/competent/tunables';
import type { StyleFeatures } from './features';
import {
  BAND_GAP,
  MAX_BAND_BASE,
  MIN_BAND_BASE,
  SURVIVAL_GAP,
  aimDeadbandFor,
  defaultFit,
  enforceSafety,
  fitStyle,
  inputRapidity,
  targetBandTilt,
} from './fitting';

/** A fully-sampled feature vector with overridable fields. */
function features(overrides: Partial<StyleFeatures> = {}): StyleFeatures {
  return {
    version: 1,
    seed: 5,
    tickCount: 300,
    durationSeconds: 5,
    reactionLatencySeconds: 0.2,
    medianReactionLatencySeconds: 0.2,
    meanHoldSeconds: 0.2,
    maxHoldSeconds: 0.5,
    shortHoldRatio: 0.9,
    inputChangesPerSecond: 5,
    targetRates: { mineral: 0.6, powerUp: 0.2, enemy: 0.2, none: 0 },
    dominantTarget: 'mineral',
    engagementDistanceEnemy: 100,
    engagementDistancePowerUp: 50,
    engagementDistanceMineral: 80,
    dodgeRate: 0.8,
    riskAppetite: 0.3,
    ...overrides,
  };
}

/** The knob value recorded for `path`, or `undefined`. */
function appliedValue(fit: ReturnType<typeof fitStyle>, path: string): number | undefined {
  return fit.applied.find((application) => application.knob === path)?.value;
}

describe('fitStyle feature mapping (AC2)', () => {
  it('maps reaction latency onto the input governor and commitment window', () => {
    const fit = fitStyle(features());
    expect(fit.humanInput.reactionTimeMs).toBe(200);
    expect(appliedValue(fit, 'humanInput.reactionTimeMs')).toBe(200);
    // minCommitSeconds = min(reaction * 0.7, 1 / cadence) = 0.14.
    expect(fit.tunables.commitment.minCommitSeconds).toBeCloseTo(0.14, 6);
    // prediction horizon = reaction * 2.5, clamped to the minimum 0.6.
    expect(fit.tunables.firePredictionHorizon).toBeCloseTo(0.6, 6);
  });

  it('maps the key-hold distribution onto the thrust-press timings', () => {
    const fit = fitStyle(features());
    expect(fit.humanInput.thrustPressMinMs).toBe(160);
    expect(fit.humanInput.thrustPressMaxMs).toBe(240);
    expect(fit.humanInput.thrustPressMaxMsLong).toBe(432);
  });

  it('maps the enemy engagement distance onto the stand-off range', () => {
    const fit = fitStyle(features({ engagementDistanceEnemy: 110 }));
    expect(fit.tunables.engagementRange).toBe(110);
    expect(appliedValue(fit, 'engagementRange')).toBe(110);
  });

  it('maps risk appetite onto the keep-away and survival knobs', () => {
    const fit = fitStyle(features({ riskAppetite: 0.3 }));
    // lerp(130, 45, 0.3) = 104.5 => rounds to 105.
    expect(fit.tunables.dangerMargin).toBe(105);
    // lerp(7, 4, 0.3) = 6.1.
    expect(fit.tunables.survivalUrgencyPort).toBeCloseTo(6.1, 6);

    const risky = fitStyle(features({ riskAppetite: 1 }));
    const cautious = fitStyle(features({ riskAppetite: 0 }));
    expect(risky.tunables.dangerMargin).toBeLessThan(cautious.tunables.dangerMargin);
    expect(risky.tunables.survivalUrgencyPort).toBeLessThan(
      cautious.tunables.survivalUrgencyPort,
    );
  });

  it('retires the wallMargin knob but keeps the risk-appetite knobs fitted (AH-0MVT2W3RS009ZB2X)', () => {
    const fit = fitStyle(features({ riskAppetite: 0.3 }));
    // The retired field is absent from the fitted tunables and the knob list.
    expect(fit.tunables).not.toHaveProperty('wallMargin');
    const knobs = fit.applied.map((entry) => entry.knob);
    expect(knobs).not.toContain('wallMargin');
    // The remaining risk-appetite knobs are still fitted.
    expect(knobs).toContain('dangerMargin');
    expect(knobs).toContain('survivalUrgencyPort');
  });

  it('clamps out-of-range features instead of trusting them', () => {
    const slow = fitStyle(features({ reactionLatencySeconds: 9 }));
    expect(slow.humanInput.reactionTimeMs).toBe(600);
    const instant = fitStyle(features({ reactionLatencySeconds: 0 }));
    expect(instant.humanInput.reactionTimeMs).toBe(120);
  });

  it('warns and keeps the default when a feature is unsampled', () => {
    const fit = fitStyle(
      features({
        reactionLatencySeconds: null,
        medianReactionLatencySeconds: null,
        meanHoldSeconds: null,
        engagementDistanceEnemy: null,
      }),
    );
    expect(fit.humanInput.reactionTimeMs).toBe(BOT_HUMAN_INPUT_TUNABLES.reactionTimeMs);
    expect(fit.humanInput.thrustPressMinMs).toBe(
      BOT_HUMAN_INPUT_TUNABLES.thrustPressMinMs,
    );
    expect(fit.warnings.some((warning) => warning.includes('reaction latency'))).toBe(
      true,
    );
    expect(fit.warnings.some((warning) => warning.includes('key-hold'))).toBe(true);
    expect(fit.warnings.some((warning) => warning.includes('engagement distance'))).toBe(
      true,
    );
  });

  it('is deterministic for the same profile', () => {
    expect(fitStyle(features())).toEqual(fitStyle(features()));
  });
});

describe('fitStyle governor turn/aim knobs (AH-0MWLCGWUF00631UX)', () => {
  /**
   * The calmer flight model (AH-0MWJ1680Z001QYV2) added the travel deadband,
   * the aim deadband, the reversal hysteresis and the turn-press hold to the
   * governor. The fit must move them with the human's cadence/hold features and
   * stand-off, so a styled bot flies the same governor a human does.
   */
  it('reproduces the shipped governor at a typical human sample', () => {
    const fit = fitStyle(
      features({
        inputChangesPerSecond: 4,
        meanHoldSeconds: 0.3,
        engagementDistanceEnemy: 160,
      }),
    );
    // 4 input changes/s is the anchor cadence: shipped 0.16 rad / 0.25 rad.
    expect(fit.humanInput.alignmentToleranceRad).toBeCloseTo(0.16, 6);
    expect(fit.humanInput.turnHysteresisRad).toBeCloseTo(0.25, 6);
    // 300 ms holds is the anchor hold: shipped 30 ms turn press.
    expect(fit.humanInput.turnPressMinMs).toBe(
      BOT_HUMAN_INPUT_TUNABLES.turnPressMinMs,
    );
    // The shipped 160 px stand-off reproduces the shipped 0.05 rad aim deadband.
    expect(fit.humanInput.aimAlignmentToleranceRad).toBeCloseTo(0.05, 6);
  });

  it('fits the travel deadband and hysteresis from the input cadence', () => {
    // cadence 5 => rapidity (5-2)/(6-2) = 0.75.
    const fit = fitStyle(features());
    expect(inputRapidity(features())).toBeCloseTo(0.75, 6);
    expect(fit.humanInput.alignmentToleranceRad).toBeCloseTo(0.13, 6);
    expect(fit.humanInput.turnHysteresisRad).toBeCloseTo(0.195, 6);
    expect(appliedValue(fit, 'humanInput.alignmentToleranceRad')).toBeCloseTo(
      0.13,
      6,
    );
    expect(appliedValue(fit, 'humanInput.turnHysteresisRad')).toBeCloseTo(0.195, 6);
    // A twitchier human steers tighter than a deliberate one.
    const rapid = fitStyle(features({ inputChangesPerSecond: 6 }));
    const deliberate = fitStyle(features({ inputChangesPerSecond: 2 }));
    expect(rapid.humanInput.alignmentToleranceRad).toBeLessThan(
      deliberate.humanInput.alignmentToleranceRad,
    );
    expect(rapid.humanInput.turnHysteresisRad).toBeLessThan(
      deliberate.humanInput.turnHysteresisRad,
    );
  });

  it('clamps the travel deadband and hysteresis at both envelope ends', () => {
    const slowest = fitStyle(features({ inputChangesPerSecond: 0.5 }));
    expect(slowest.humanInput.alignmentToleranceRad).toBeCloseTo(0.22, 6);
    expect(slowest.humanInput.turnHysteresisRad).toBeCloseTo(0.36, 6);
    const fastest = fitStyle(features({ inputChangesPerSecond: 40 }));
    expect(fastest.humanInput.alignmentToleranceRad).toBeCloseTo(0.1, 6);
    expect(fastest.humanInput.turnHysteresisRad).toBeCloseTo(0.14, 6);
  });

  it('fits the turn-press hold from the key-hold distribution and clamps it', () => {
    const fit = fitStyle(features({ meanHoldSeconds: 0.2 }));
    expect(fit.humanInput.turnPressMinMs).toBe(20);
    expect(appliedValue(fit, 'humanInput.turnPressMinMs')).toBe(20);
    expect(fitStyle(features({ meanHoldSeconds: 10 })).humanInput.turnPressMinMs).toBe(
      90,
    );
    expect(
      fitStyle(features({ meanHoldSeconds: 0.001 })).humanInput.turnPressMinMs,
    ).toBe(15);
  });

  it('derives the aim deadband from the fitted stand-off and clamps it', () => {
    expect(aimDeadbandFor(160)).toBeCloseTo(0.05, 6);
    // The deadband's lateral miss at the stand-off stays inside half the 16 px
    // hostile contact radius, leaving the rest for lead error and enemy drift.
    const fit = fitStyle(features({ engagementDistanceEnemy: 200 }));
    expect(fit.tunables.engagementRange).toBe(200);
    expect(fit.humanInput.aimAlignmentToleranceRad * 200).toBeCloseTo(8, 6);
    expect(appliedValue(fit, 'humanInput.aimAlignmentToleranceRad')).toBeCloseTo(
      fit.humanInput.aimAlignmentToleranceRad,
      6,
    );
    // Both envelope ends are reachable from the stand-off clamp.
    expect(
      fitStyle(features({ engagementDistanceEnemy: 60 })).humanInput
        .aimAlignmentToleranceRad,
    ).toBeCloseTo(0.12, 6);
    expect(
      fitStyle(features({ engagementDistanceEnemy: 320 })).humanInput
        .aimAlignmentToleranceRad,
    ).toBeCloseTo(0.03, 6);
  });

  it('co-fits the aim fallibility with the aim deadband', () => {
    const fit = fitStyle(features(), { baseInput: { skill: 0.5 } });
    const effectiveDeadband = Math.min(
      fit.humanInput.alignmentToleranceRad,
      fit.humanInput.aimAlignmentToleranceRad,
    );
    expect(appliedValue(fit, 'humanInput.maxAimErrorRad')).toBeCloseTo(
      fit.humanInput.maxAimErrorRad,
      6,
    );
    // The governor rotates an aim bearing by at most maxAimErrorRad*(1-skill)
    // and then holds the ship inside the effective deadband, so the error can
    // never exceed the band it is aiming into.
    expect(
      fit.humanInput.maxAimErrorRad * (1 - fit.humanInput.skill),
    ).toBeLessThanOrEqual(effectiveDeadband + 1e-9);
  });

  it('keeps the shipped governor knobs and warns when the cadence is unsampled', () => {
    const fit = fitStyle(
      features({ inputChangesPerSecond: 0, meanHoldSeconds: null }),
    );
    expect(fit.humanInput.alignmentToleranceRad).toBe(
      BOT_HUMAN_INPUT_TUNABLES.alignmentToleranceRad,
    );
    expect(fit.humanInput.turnHysteresisRad).toBe(
      BOT_HUMAN_INPUT_TUNABLES.turnHysteresisRad,
    );
    expect(fit.humanInput.turnPressMinMs).toBe(
      BOT_HUMAN_INPUT_TUNABLES.turnPressMinMs,
    );
    expect(fit.warnings.some((warning) => warning.includes('input cadence'))).toBe(
      true,
    );
    expect(
      fit.warnings.some((warning) => warning.includes('turn-press hold')),
    ).toBe(true);
    expect(appliedValue(fit, 'humanInput.alignmentToleranceRad')).toBeUndefined();
    expect(appliedValue(fit, 'humanInput.turnPressMinMs')).toBeUndefined();
  });

  it('keeps every governor knob finite and inside its envelope for adversarial profiles', () => {
    const profiles: StyleFeatures[] = [
      features({ inputChangesPerSecond: 1e9, meanHoldSeconds: 1e6 }),
      features({ inputChangesPerSecond: -5, meanHoldSeconds: -1 }),
      features({ engagementDistanceEnemy: 1e9 }),
      features({ engagementDistanceEnemy: 0 }),
      features({ engagementDistanceEnemy: null, riskAppetite: 1 }),
    ];
    for (const profile of profiles) {
      const t = fitStyle(profile).humanInput;
      for (const value of [
        t.alignmentToleranceRad,
        t.aimAlignmentToleranceRad,
        t.turnHysteresisRad,
        t.turnPressMinMs,
        t.maxAimErrorRad,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(t.alignmentToleranceRad).toBeGreaterThanOrEqual(0.1);
      expect(t.alignmentToleranceRad).toBeLessThanOrEqual(0.22);
      expect(t.aimAlignmentToleranceRad).toBeGreaterThanOrEqual(0.03);
      expect(t.aimAlignmentToleranceRad).toBeLessThanOrEqual(0.12);
      expect(t.turnHysteresisRad).toBeGreaterThanOrEqual(0.14);
      expect(t.turnHysteresisRad).toBeLessThanOrEqual(0.36);
      expect(t.turnPressMinMs).toBeGreaterThanOrEqual(15);
      expect(t.turnPressMinMs).toBeLessThanOrEqual(90);
      expect(t.maxAimErrorRad).toBeLessThanOrEqual(
        Math.min(t.alignmentToleranceRad, t.aimAlignmentToleranceRad) + 1e-9,
      );
    }
  });
});

describe('targetBandTilt (AC2)', () => {
  it('tilts toward the dominant category without inverting the order', () => {
    const tilt = targetBandTilt(features());
    expect(tilt.mineral).toBeCloseTo((0.6 - 1 / 3) * 0.5, 6);
    expect(tilt.enemy).toBeCloseTo((0.2 - 1 / 3) * 0.5, 6);
    const fit = fitStyle(features());
    expect(fit.tunables.mineralBase).toBeGreaterThan(fit.tunables.powerUpBase);
    expect(fit.tunables.powerUpBase).toBeGreaterThan(fit.tunables.enemyBase);
    expect(fit.tunables.enemyBase).toBeGreaterThan(fit.tunables.asteroidBase);
  });

  it('returns a neutral tilt when no objective is observed', () => {
    const tilt = targetBandTilt(
      features({
        targetRates: { mineral: 0, powerUp: 0, enemy: 0, none: 1 },
        dominantTarget: 'none',
      }),
    );
    expect(tilt.mineral).toBeCloseTo(0, 6);
    expect(tilt.powerUp).toBeCloseTo(0, 6);
    expect(tilt.enemy).toBeCloseTo(0, 6);
  });
});

describe('enforceSafety (AC2)', () => {
  it('re-orders inverted priority bands to the safe order', () => {
    const unsafe = resolveCompetentTunables({
      mineralBase: 0.1,
      powerUpBase: 9,
      enemyBase: 0.2,
      asteroidBase: 5,
    });
    const { tunables, warnings } = enforceSafety(unsafe);
    const gap = tunables.prioritySpan + BAND_GAP;
    expect(tunables.mineralBase).toBeGreaterThanOrEqual(tunables.powerUpBase + gap);
    expect(tunables.powerUpBase).toBeGreaterThanOrEqual(tunables.enemyBase + gap);
    expect(tunables.enemyBase).toBeGreaterThanOrEqual(tunables.asteroidBase + gap);
    expect(warnings.some((warning) => warning.includes('priority bands'))).toBe(true);
  });

  it('keeps the survival band strictly above every objective band', () => {
    const { tunables } = enforceSafety(
      resolveCompetentTunables({ survivalBase: 0, mineralBase: MAX_BAND_BASE }),
    );
    expect(tunables.survivalBase).toBeGreaterThanOrEqual(
      tunables.mineralBase + tunables.prioritySpan + SURVIVAL_GAP,
    );
  });

  it('clamps bands and margins into their safe envelopes', () => {
    const { tunables } = enforceSafety(
      resolveCompetentTunables({
        asteroidBase: -50,
        mineralBase: 1_000,
        prioritySpan: 99,
        dangerMargin: -10,
        engagementRange: 1e9,
        threatRadius: 0,
        survivalUrgencyPort: 0,
      }),
    );
    expect(tunables.asteroidBase).toBeGreaterThanOrEqual(MIN_BAND_BASE);
    expect(tunables.mineralBase).toBeLessThanOrEqual(MAX_BAND_BASE);
    expect(tunables.prioritySpan).toBeLessThanOrEqual(1);
    expect(tunables.dangerMargin).toBeGreaterThanOrEqual(10);
    expect(tunables.engagementRange).toBeLessThanOrEqual(400);
    expect(tunables.threatRadius).toBeGreaterThanOrEqual(20);
    expect(tunables.survivalUrgencyPort).toBeGreaterThanOrEqual(1);
  });
});

describe('fitStyle safety envelope (AC2)', () => {
  it('always produces safety-valid tunables for adversarial profiles', () => {
    const profiles: StyleFeatures[] = [
      features({ targetRates: { mineral: 0, powerUp: 0, enemy: 1, none: 0 } }),
      features({ targetRates: { mineral: 1, powerUp: 0, enemy: 0, none: 0 } }),
      features({ riskAppetite: 1 }),
      features({ riskAppetite: 0 }),
      features({ reactionLatencySeconds: null, medianReactionLatencySeconds: null }),
    ];
    for (const profile of profiles) {
      const fit = fitStyle(profile);
      const t = fit.tunables;
      const gap = t.prioritySpan + BAND_GAP;
      expect(t.mineralBase).toBeGreaterThanOrEqual(t.powerUpBase + gap);
      expect(t.powerUpBase).toBeGreaterThanOrEqual(t.enemyBase + gap);
      expect(t.enemyBase).toBeGreaterThanOrEqual(t.asteroidBase + gap);
      expect(t.survivalBase).toBeGreaterThanOrEqual(
        t.mineralBase + t.prioritySpan + SURVIVAL_GAP,
      );
      for (const band of [t.asteroidBase, t.enemyBase, t.powerUpBase, t.mineralBase]) {
        expect(Number.isFinite(band)).toBe(true);
      }
    }
  });

  it('does not alter the priority bands for a neutral profile', () => {
    const fit = fitStyle(
      features({
        targetRates: { mineral: 1 / 3, powerUp: 1 / 3, enemy: 1 / 3, none: 0 },
      }),
    );
    expect(fit.tunables.mineralBase).toBeCloseTo(COMPETENT_BOT_TUNABLES.mineralBase, 6);
    expect(fit.tunables.powerUpBase).toBeCloseTo(COMPETENT_BOT_TUNABLES.powerUpBase, 6);
    expect(fit.tunables.enemyBase).toBeCloseTo(COMPETENT_BOT_TUNABLES.enemyBase, 6);
  });
});

describe('defaultFit', () => {
  it('is the shipped baseline with no applied knobs', () => {
    const fit = defaultFit();
    expect(fit.tunables).toEqual(resolveCompetentTunables());
    expect(fit.humanInput).toEqual(BOT_HUMAN_INPUT_TUNABLES);
    expect(fit.applied).toHaveLength(0);
    expect(fit.warnings).toHaveLength(0);
  });

  it('uses supplied base tunables as the starting point', () => {
    const fit = fitStyle(features(), {
      base: { engagementRange: 200 },
      baseInput: { thrustPressMinMs: 300 },
    });
    // The engagement distance feature overrides the supplied base.
    expect(fit.tunables.engagementRange).toBe(100);
    // Supplied base input is inherited when a feature does not move it.
    expect(fit.humanInput.allowDown).toBe(BOT_HUMAN_INPUT_TUNABLES.allowDown);
  });
});

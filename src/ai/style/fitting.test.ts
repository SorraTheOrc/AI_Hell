/**
 * Tests for parameter fitting (AH-0MUY08XXN003NV0I, AC2).
 *
 * The fitting path must map each extracted style feature onto a structured
 * bot knob *and* never weaken the bot's safety invariants, whatever the input
 * profile. These are pure-function tests over hand-built feature vectors, so
 * every mapping has an exact expected value and the safety envelope is probed
 * with adversarial inputs.
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
  defaultFit,
  enforceSafety,
  fitStyle,
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
    // lerp(45, 20, 0.3) = 37.5 => rounds to 38.
    expect(fit.tunables.wallMargin).toBe(38);
    // lerp(7, 4, 0.3) = 6.1.
    expect(fit.tunables.survivalUrgencyPort).toBeCloseTo(6.1, 6);

    const risky = fitStyle(features({ riskAppetite: 1 }));
    const cautious = fitStyle(features({ riskAppetite: 0 }));
    expect(risky.tunables.dangerMargin).toBeLessThan(cautious.tunables.dangerMargin);
    expect(risky.tunables.survivalUrgencyPort).toBeLessThan(
      cautious.tunables.survivalUrgencyPort,
    );
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
        wallMargin: 1e9,
        engagementRange: 1e9,
        threatRadius: 0,
        survivalUrgencyPort: 0,
      }),
    );
    expect(tunables.asteroidBase).toBeGreaterThanOrEqual(MIN_BAND_BASE);
    expect(tunables.mineralBase).toBeLessThanOrEqual(MAX_BAND_BASE);
    expect(tunables.prioritySpan).toBeLessThanOrEqual(1);
    expect(tunables.dangerMargin).toBeGreaterThanOrEqual(10);
    expect(tunables.wallMargin).toBeLessThanOrEqual(90);
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

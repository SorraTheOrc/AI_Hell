/**
 * Tests for style-feature extraction
 * (AH-0MUY08XXN003NV0I, AC1/AC6).
 *
 * The features are pure functions of a recording/analysis, so they are
 * exercised over small synthetic runs with exact expected values, plus an
 * arena-generated run for the end-to-end invariants.
 */

import { describe, expect, it } from 'vitest';

import { analyseRecording } from '../../../scripts/recording-analysis.mjs';
import { runArena } from '../eval/arena';
import { recordingRunFromRecords } from '../eval/metrics';
import { createCompetentBotBrain } from '../framework/competent';
import {
  computeRiskAppetite,
  extractStyleFeatures,
  resolveAnalysis,
  STYLE_FEATURE_VERSION,
} from './features';
import { styleDistance, styleDistanceBreakdown } from './distance';
import { FI, makeRun, makeTick, point } from './testFixtures';

const DT = 1 / 60;

/** A run with two threat windows and distinct engagement events. */
function mixedRun() {
  const bullet = point(100, 0);
  const near = { enemyBullets: [bullet] };
  const far = { enemyBullets: [] };
  const collectables = { minerals: [point(100, 0)], drops: [point(20, 0)] };
  const ticks = [
    makeTick(0, FI.left, { ...near, ...collectables }),
    makeTick(1, FI.left, { ...near, ...collectables }),
    makeTick(2, FI.right, { ...near, ...collectables }),
    makeTick(3, FI.right, { ...far, ...collectables }),
    makeTick(4, FI.idle, { ...far, ...collectables }),
  ];
  const events = [
    { tick: 2, event: 'enemy_killed', payload: point(100, 0) },
    { tick: 2, event: 'mineral_collected', payload: point(100, 0) },
    { tick: 2, event: 'pickup', payload: point(20, 0) },
  ];
  return makeRun(ticks, events);
}

/** A run whose velocity is aligned with an enemy behind the collectables. */
function enemyPreferringRun() {
  const state = {
    player: { x: 0, y: 0, vx: 1, vy: 0, facing: 0, lives: 3 },
    minerals: [point(-100, 0)],
    drops: [point(-50, 0)],
    enemies: [{ x: 10, y: 0, alive: true }],
  };
  const ticks = [0, 1, 2, 3].map((t) => makeTick(t, FI.idle, state));
  return makeRun(ticks);
}

describe('extractStyleFeatures', () => {
  it('extracts reaction latency, holds, engagement and risk from a run', () => {
    const features = extractStyleFeatures(mixedRun());

    expect(features.version).toBe(STYLE_FEATURE_VERSION);
    expect(features.seed).toBe(5);
    expect(features.tickCount).toBe(5);
    // Reaction: window at tick 0, input changes at tick 2 => 2 ticks.
    expect(features.reactionLatencySeconds).toBeCloseTo(2 * DT, 6);
    expect(features.medianReactionLatencySeconds).toBeCloseTo(2 * DT, 6);
    // Two holds of 2 ticks each.
    expect(features.meanHoldSeconds).toBeCloseTo(2 * DT, 6);
    expect(features.maxHoldSeconds).toBeCloseTo(2 * DT, 6);
    expect(features.shortHoldRatio).toBe(1);
    // Two input changes over 5 ticks.
    expect(features.inputChangesPerSecond).toBeCloseTo(2 / (5 * DT), 6);
    // Engage at 100 px, pick up at 20 px, collect at 100 px.
    expect(features.engagementDistanceEnemy).toBeCloseTo(100, 6);
    expect(features.engagementDistancePowerUp).toBeCloseTo(20, 6);
    expect(features.engagementDistanceMineral).toBeCloseTo(100, 6);
    // One threat window, no hit => dodge rate 1.
    expect(features.dodgeRate).toBe(1);
    // Risk = mean(closeness 1 - 100/160, taken-hits 1 - 1).
    expect(features.riskAppetite).toBeCloseTo((1 - 100 / 160 + 0) / 2, 6);
    expect(features.dominantTarget).toBe('mineral');
  });

  it('picks the dominant target category from the velocity alignment', () => {
    const features = extractStyleFeatures(enemyPreferringRun());
    expect(features.dominantTarget).toBe('enemy');
    expect(features.targetRates.enemy).toBe(1);
    expect(features.targetRates.mineral).toBe(0);
  });

  it('sums the target rates to one', () => {
    const features = extractStyleFeatures(mixedRun());
    const total = Object.values(features.targetRates).reduce((sum, rate) => sum + rate, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('reuses a precomputed analysis identically to a raw run', () => {
    const run = mixedRun();
    const analysis = analyseRecording(run);
    expect(extractStyleFeatures(analysis)).toEqual(extractStyleFeatures(run));
    expect(resolveAnalysis(analysis)).toBe(analysis);
  });

  it('leaves unsampled features null rather than inventing data', () => {
    // A single idle tick: no hold closed, no threat window, no events.
    const run = makeRun([makeTick(0, FI.idle)]);
    const features = extractStyleFeatures(run);
    expect(features.reactionLatencySeconds).toBeNull();
    expect(features.meanHoldSeconds).toBeNull();
    expect(features.engagementDistanceEnemy).toBeNull();
    expect(features.riskAppetite).toBe(0.5);
    expect(features.shortHoldRatio).toBe(0);
  });

  it('produces finite, in-range features from a real arena run', () => {
    const arena = runArena(createCompetentBotBrain(), { seed: 7, ticks: 300 });
    const features = extractStyleFeatures(recordingRunFromRecords(arena.records));
    expect(features.seed).toBe(7);
    expect(features.tickCount).toBe(300);
    expect(features.riskAppetite).toBeGreaterThanOrEqual(0);
    expect(features.riskAppetite).toBeLessThanOrEqual(1);
    for (const value of [
      features.inputChangesPerSecond,
      features.shortHoldRatio,
      features.riskAppetite,
      features.dodgeRate,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    for (const rate of Object.values(features.targetRates)) {
      expect(Number.isFinite(rate)).toBe(true);
    }
  });
});

describe('computeRiskAppetite', () => {
  it('rises when a player engages closer (given a kill to measure)', () => {
    const close = extractStyleFeatures(
      makeRun([makeTick(0, FI.idle)], [
        { tick: 0, event: 'enemy_killed', payload: point(40, 0) },
      ]),
    );
    const far = extractStyleFeatures(
      makeRun([makeTick(0, FI.idle)], [
        { tick: 0, event: 'enemy_killed', payload: point(320, 0) },
      ]),
    );
    expect(close.riskAppetite).toBeGreaterThan(far.riskAppetite);
    expect(close.riskAppetite).toBeCloseTo(1 - 40 / 160, 6);
    expect(far.riskAppetite).toBe(0);
  });

  it('averages the closeness and taken-hit components when both exist', () => {
    expect(computeRiskAppetite(analyseRecording(mixedRun()))).toBeCloseTo(
      (1 - 100 / 160) / 2,
      6,
    );
  });
});

describe('styleDistance', () => {
  it('is zero for identical profiles and positive otherwise', () => {
    const a = extractStyleFeatures(mixedRun());
    const b = extractStyleFeatures(enemyPreferringRun());
    expect(styleDistance(a, a)).toBe(0);
    expect(styleDistance(a, b)).toBeGreaterThan(0);
  });

  it('reports a per-feature breakdown', () => {
    const a = extractStyleFeatures(mixedRun());
    const b = extractStyleFeatures(enemyPreferringRun());
    const breakdown = styleDistanceBreakdown(a, b);
    expect(breakdown.total).toBeCloseTo(styleDistance(a, b), 6);
    expect(breakdown.components.targetRates).toBeGreaterThan(0);
    expect(Object.values(breakdown.components).every((value) => value >= 0)).toBe(true);
  });
});

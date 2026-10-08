/**
 * Tests for the style-match evaluation (AH-0MUY08XXN003NV0I, AC4).
 *
 * AC4 requires that a styled bot is **measurably closer** to a human recording
 * than the default competent bot, without regressing competence. These tests
 * assert the report invariant (mechanics) and then demonstrate the AC end to
 * end on a synthetic human recording, using the same deterministic arena the
 * harness runs.
 */

import { describe, expect, it } from 'vitest';

import { runArena } from '../eval/arena';
import { recordingRunFromRecords } from '../eval/metrics';
import { createCompetentBotBrain } from '../framework/competent';
import { resolveCompetentTunables } from '../framework/competent/tunables';
import type { BotHumanInputTunables } from '../botHumanLike';
import {
  evaluateStyleMatch,
  formatStyleMatchReport,
  STYLE_MATCH_REPORT_VERSION,
} from './evaluation';
import { extractStyleFeatures } from './features';
import { fitStyle } from './fitting';

/** A distinctive human-like input cadence for the synthetic recording. */
const HUMAN_INPUT: Partial<BotHumanInputTunables> = {
  reactionTimeMs: 120,
  thrustPressMinMs: 90,
  thrustPressMaxMs: 120,
  thrustPressMaxMsLong: 200,
};

/** A distinctive, risky human tuning so the default bot visibly differs. */
const HUMAN_TUNABLES = resolveCompetentTunables({
  engagementRange: 70,
  dangerMargin: 40,
  wallMargin: 20,
});

/**
 * Generates a synthetic human recording at the fit's fixed point, so the
 * human's own style is exactly one the fitting path can reach.
 */
function syntheticHumanRun(seed = 42, ticks = 600) {
  let tunables = HUMAN_TUNABLES;
  let humanInput: Partial<BotHumanInputTunables> = HUMAN_INPUT;
  let run = recordingRunFromRecords(
    runArena(createCompetentBotBrain({ tunables }), { seed, ticks, humanInput }).records,
  );
  for (let i = 0; i < 3; i += 1) {
    const fit = fitStyle(extractStyleFeatures(run));
    humanInput = fit.humanInput;
    tunables = fit.tunables;
    run = recordingRunFromRecords(
      runArena(createCompetentBotBrain({ tunables }), { seed, ticks, humanInput }).records,
    );
  }
  return run;
}

describe('evaluateStyleMatch report (AC4)', () => {
  const human = syntheticHumanRun(7, 420);
  const report = evaluateStyleMatch(human, { ticks: 420 });

  it('reports the human seed, version and fitted profile', () => {
    expect(report.version).toBe(STYLE_MATCH_REPORT_VERSION);
    expect(report.humanSeed).toBe(7);
    expect(report.human.seed).toBe(7);
    expect(report.fit.tunables).toBeDefined();
  });

  it('keeps the distance, delta and regression fields internally consistent', () => {
    for (const side of [report.structured, report.styled]) {
      expect(side.distance).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(side.point.score)).toBe(true);
      expect(Number.isFinite(side.point.survivalSeconds)).toBe(true);
      const breakdownTotal = Object.values(side.distanceBreakdown).reduce(
        (sum, value) => sum + value,
        0,
      );
      expect(breakdownTotal).toBeCloseTo(side.distance, 6);
    }
    expect(report.distanceImprovement).toBeCloseTo(
      report.structured.distance - report.styled.distance,
      6,
    );
    expect(report.competenceDelta).toBeCloseTo(
      report.styled.point.score - report.structured.point.score,
      6,
    );
    expect(report.survivalDelta).toBeCloseTo(
      report.styled.point.survivalSeconds - report.structured.point.survivalSeconds,
      6,
    );
    expect(report.regressed).toBe(
      report.competenceDelta < -report.competenceTolerance ||
        report.survivalDelta < -report.competenceTolerance,
    );
    expect(report.closer).toBe(report.styled.distance < report.structured.distance);
  });

  it('demonstrates the styled bot is closer without regressing competence (AC4)', () => {
    expect(report.closer).toBe(true);
    expect(report.regressed).toBe(false);
  });

  it('honours the caller-supplied competence tolerance', () => {
    const strict = evaluateStyleMatch(human, { ticks: 420, competenceTolerance: 0 });
    expect(strict.competenceTolerance).toBe(0);
    const loose = evaluateStyleMatch(human, { ticks: 420, competenceTolerance: 5 });
    expect(loose.competenceTolerance).toBe(5);
    if (strict.competenceDelta < 0 || strict.survivalDelta < 0) {
      expect(strict.regressed).toBe(true);
      expect(loose.regressed).toBe(false);
    }
  });

  it('is deterministic for the same recording', () => {
    expect(evaluateStyleMatch(human, { ticks: 420 })).toEqual(report);
  });
});

describe('formatStyleMatchReport', () => {
  it('renders the decisive fields for a human reader', () => {
    const report = evaluateStyleMatch(syntheticHumanRun(9, 300), { ticks: 300 });
    const text = formatStyleMatchReport(report);
    expect(text).toContain('Style match report');
    expect(text).toContain('structured');
    expect(text).toContain('styled');
    expect(text).toContain('closer to human');
    expect(text).toContain('competence delta');
  });
});

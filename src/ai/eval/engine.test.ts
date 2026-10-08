/**
 * End-to-end engine tests for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC5).
 */

import { describe, expect, it } from 'vitest';

import { parseRecording } from '../../../scripts/recording.mjs';
import { runAbEvaluation, runEvaluation, compareRecordings } from './engine';
import { resolvePolicyFactory } from './policies';
import { recordingRunFromRecords } from './metrics';
import { stableStringify } from './report';

const CONFIG = { seeds: [1, 2], ticks: 180, sampleEveryTicks: 2 } as const;

describe('runEvaluation (AC1/AC5)', () => {
  it('produces a deterministic report and parseable run telemetry', () => {
    const first = runEvaluation(resolvePolicyFactory('legacy'), CONFIG);
    const second = runEvaluation(resolvePolicyFactory('legacy'), CONFIG);
    expect(second.json).toBe(first.json);
    expect(second.jsonl).toBe(first.jsonl);
    expect(first.report.kind).toBe('evaluation');
    expect(first.report.config.policy).toBe('legacy');
    expect(first.report.config.seeds).toEqual([1, 2]);
    expect(first.report.runs).toHaveLength(2);
    expect(first.report.runs[0].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(first.report.aggregate.score.count).toBe(2);

    const parsed = parseRecording(first.jsonl);
    expect(parsed.runs).toHaveLength(2);
  });
});

describe('runAbEvaluation (AC3)', () => {
  it('produces an A/B report comparing two named policies', () => {
    const output = runAbEvaluation(
      resolvePolicyFactory('legacy'),
      resolvePolicyFactory('competent'),
      { seeds: [1, 2, 3], ticks: 180, sampleEveryTicks: 2 },
    );
    expect(output.report.kind).toBe('ab');
    expect(output.report.config.baseline).toBe('legacy');
    expect(output.report.config.candidate).toBe('competent');
    expect(output.report.ab.seeds).toEqual([1, 2, 3]);
    expect(output.baseline).toHaveLength(3);
    expect(output.candidate).toHaveLength(3);
    // The same seed must produce the same scenario on both sides.
    expect(output.baseline[0].run.runSeed).toBe(output.candidate[0].run.runSeed);
  });
});

describe('compareRecordings (AC2)', () => {
  it('compares two same-seed recordings and renders a ghost overlay', () => {
    const legacy = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [7],
      ticks: 180,
    });
    const competent = runEvaluation(resolvePolicyFactory('competent'), {
      seeds: [7],
      ticks: 180,
    });
    const output = compareRecordings(legacy.runs[0].run, competent.runs[0].run);
    expect(output.comparison.seed).toBe(7);
    expect(output.ghostSvg.startsWith('<svg')).toBe(true);
    expect(output.ghostSvg).toContain('</svg>');
    expect(stableStringify(output.comparison.deltas).length).toBeGreaterThan(0);
  });
});

describe('policy resolution', () => {
  it('rejects an unknown policy name with a helpful message', () => {
    expect(() => resolvePolicyFactory('nope')).toThrow(/unknown policy/);
  });
});

describe('metric point determinism', () => {
  it('derives the same point for the same records', () => {
    const arena = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [3],
      ticks: 120,
    });
    const rebuilt = recordingRunFromRecords(arena.runs[0].records, 0);
    expect(stableStringify(rebuilt)).toBe(stableStringify(arena.runs[0].run));
  });
});

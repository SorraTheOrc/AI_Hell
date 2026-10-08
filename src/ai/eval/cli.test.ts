/**
 * Pure CLI-core tests for the evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC2/AC3/AC4/AC7).
 *
 * The filesystem shell (`scripts/evaluate.mjs`) is exercised separately; these
 * tests drive `executeEvaluation` directly with an in-memory human recording.
 */

import { describe, expect, it } from 'vitest';

import { runEvaluation } from './engine';
import { resolvePolicyFactory } from './policies';
import { executeEvaluation, defaultOptions, seedRange } from './cli';
import type { CliOptions } from './cli';

/** Builds a full option object for the pure CLI core. */
function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return { ...defaultOptions(), seeds: [1], ticks: 120, sampleEveryTicks: 2, ...overrides };
}

describe('defaultOptions / seedRange', () => {
  it('defaults to three seeds and the competent policy', () => {
    const defaults = defaultOptions();
    expect(defaults.policy).toBe('competent');
    expect(defaults.seeds).toEqual([1, 2, 3]);
    expect(seedRange(0)).toHaveLength(3);
    expect(seedRange(5)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('executeEvaluation', () => {
  it('evaluates one policy and emits report + run artifacts', () => {
    const result = executeEvaluation(options());
    expect(result.exitCode).toBe(0);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      'report.json',
      'runs.jsonl',
    ]);
    expect(result.stdout).toContain('Evaluation report');
    const report = JSON.parse(result.artifacts[0].content);
    expect(report.kind).toBe('evaluation');
  });

  it('emits an A/B report when baseline and candidate are set', () => {
    const result = executeEvaluation(
      options({ baseline: 'legacy', candidate: 'competent', seeds: [1, 2] }),
    );
    const report = JSON.parse(
      result.artifacts.find((artifact) => artifact.name === 'report.json')?.content ?? '{}',
    );
    expect(report.kind).toBe('ab');
    expect(result.stdout).toContain('A/B report');
  });

  it('compares against a supplied human recording and renders the ghost SVG', () => {
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 120,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(
      options({ humanRecordingText: human.jsonl, humanSeed: 1 }),
    );
    expect(result.exitCode).toBe(0);
    const names = result.artifacts.map((artifact) => artifact.name);
    expect(names).toContain('comparison.json');
    expect(names).toContain('ghost.svg');
    const ghost = result.artifacts.find((artifact) => artifact.name === 'ghost.svg');
    expect(ghost?.content.startsWith('<svg')).toBe(true);
    expect(result.stdout).toContain('Same-seed comparison');
  });

  it('fails cleanly when the requested human seed is absent', () => {
    const human = runEvaluation(resolvePolicyFactory('legacy'), {
      seeds: [1],
      ticks: 60,
      sampleEveryTicks: 2,
    });
    const result = executeEvaluation(
      options({ humanRecordingText: human.jsonl, humanSeed: 999 }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No matching human run');
  });

  it('emits the side-by-side plan when video is requested', () => {
    const result = executeEvaluation(options({ video: true }));
    const names = result.artifacts.map((artifact) => artifact.name);
    expect(names).toContain('side-by-side.sh');
    expect(names).toContain('side-by-side.json');
    const script = result.artifacts.find((artifact) => artifact.name === 'side-by-side.sh');
    expect(script?.content).toContain('ffmpeg');
    expect(script?.content).toContain('hstack=inputs=2');
  });
});

/**
 * Hermetic tests for the evaluation CLI shell's argument parsing
 * (AH-0MUY08XLD009K4W4, AC7). The browser/SSR pipeline is not booted here.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  parseEvaluateArgs,
  resolveArtifactPath,
  resolveSeeds,
} from './evaluate.mjs';

describe('parseEvaluateArgs', () => {
  it('applies documented defaults', () => {
    const options = parseEvaluateArgs([]);
    expect(options).toMatchObject({
      policy: 'competent',
      baseline: null,
      candidate: null,
      ticks: 1800,
      outputDir: 'eval-output',
      json: false,
      video: false,
      humanFile: null,
    });
  });

  it('parses flags and repeatable seeds', () => {
    const options = parseEvaluateArgs([
      '--policy',
      'legacy',
      '--seed',
      '3',
      '--seed',
      '7',
      '--ticks',
      '600',
      '--out',
      'out',
      '--json',
      '--video',
      '--human',
      'h.jsonl',
      '--human-seed',
      '3',
    ]);
    expect(options.policy).toBe('legacy');
    expect(options.seeds).toEqual([3, 7]);
    expect(options.ticks).toBe(600);
    expect(options.outputDir).toBe('out');
    expect(options.json).toBe(true);
    expect(options.video).toBe(true);
    expect(options.humanFile).toBe('h.jsonl');
    expect(options.humanSeed).toBe(3);
  });

  it('parses an A/B pair', () => {
    const options = parseEvaluateArgs(['--baseline', 'legacy', '--candidate', 'competent']);
    expect(options.baseline).toBe('legacy');
    expect(options.candidate).toBe('competent');
  });

  it('throws on an unknown flag or a missing value', () => {
    expect(() => parseEvaluateArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseEvaluateArgs(['--policy'])).toThrow(/Missing value/);
  });
});

describe('resolveSeeds', () => {
  it('expands a count into 1..count', () => {
    expect(resolveSeeds({ seeds: 3 })).toEqual([1, 2, 3]);
    expect(resolveSeeds({ seeds: [9, 4] })).toEqual([9, 4]);
    expect(resolveSeeds({ seeds: null })).toEqual([1, 2, 3]);
  });
});

describe('resolveArtifactPath', () => {
  it('joins with or without a trailing slash', () => {
    expect(resolveArtifactPath('out', 'report.json')).toBe('out/report.json');
    expect(resolveArtifactPath('out/', 'report.json')).toBe('out/report.json');
  });
});

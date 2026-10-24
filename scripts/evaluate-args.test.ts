/**
 * Hermetic tests for the evaluation CLI shell's argument parsing
 * (AH-0MUY08XLD009K4W4, AC7). The browser/SSR pipeline is not booted here.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  EVALUATE_USAGE,
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
      // `null` means “mode default”: 1800 single-run, 18000 batch (AC3).
      ticks: null,
      outputDir: 'eval-output',
      json: false,
      video: false,
      batch: false,
      // Full-campaign batch mode is the default (AC1).
      campaign: true,
      games: null,
      policies: null,
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

  it('parses the batch flags (size, policies, output dir)', () => {
    const options = parseEvaluateArgs([
      '--batch',
      '--games',
      '50',
      '--policies',
      'legacy, competent',
      '--out',
      'balance-out',
    ]);
    expect(options.batch).toBe(true);
    expect(options.games).toBe(50);
    expect(options.policies).toEqual(['legacy', 'competent']);
    expect(options.outputDir).toBe('balance-out');
  });

  it('parses repeatable --seed into an explicit seeds list even in batch mode', () => {
    const options = parseEvaluateArgs(['--batch', '--seed', '4', '--seed', '9']);
    expect(options.batch).toBe(true);
    expect(options.seeds).toEqual([4, 9]);
  });

  it('defaults a batch to the full campaign and parses --skirmish as the opt-out (AC1/AC2)', () => {
    const batch = parseEvaluateArgs(['--batch']);
    expect(batch.campaign).toBe(true);

    const skirmish = parseEvaluateArgs(['--batch', '--skirmish']);
    expect(skirmish.batch).toBe(true);
    expect(skirmish.campaign).toBe(false);

    // An explicit --ticks always wins over the mode default.
    expect(parseEvaluateArgs(['--batch', '--ticks', '500']).ticks).toBe(500);
  });

  it('advertises --skirmish and both tick defaults in the help text', () => {
    expect(EVALUATE_USAGE).toContain('--skirmish');
    expect(EVALUATE_USAGE).toContain('18000');
    expect(EVALUATE_USAGE).toContain('1800');
  });

  it('parses the per-level campaign flags (--level, --scale-levels)', () => {
    const defaults = parseEvaluateArgs(['--batch']);
    expect(defaults.level).toBeNull();
    expect(defaults.scaleLevels).toBe(true);

    const scaled = parseEvaluateArgs(['--batch', '--level', '10']);
    expect(scaled.level).toBe(10);
    expect(scaled.scaleLevels).toBe(true);

    const baseline = parseEvaluateArgs(['--batch', '--level', '5', '--scale-levels', 'off']);
    expect(baseline.level).toBe(5);
    expect(baseline.scaleLevels).toBe(false);

    // An explicit on re-enables the curves after an off.
    const reenabled = parseEvaluateArgs(['--level', '3', '--scale-levels', 'on']);
    expect(reenabled.level).toBe(3);
    expect(reenabled.scaleLevels).toBe(true);
  });
});

describe('resolveSeeds', () => {
  it('expands a count into 1..count', () => {
    expect(resolveSeeds({ seeds: 3 })).toEqual([1, 2, 3]);
    expect(resolveSeeds({ seeds: [9, 4] })).toEqual([9, 4]);
    expect(resolveSeeds({ seeds: null })).toEqual([1, 2, 3]);
  });

  it('defaults batch size to 100 games and honours --games', () => {
    expect(resolveSeeds({ batch: true })).toHaveLength(100);
    expect(resolveSeeds({ batch: true, games: 12 })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Explicit seeds win over the batch fallback.
    expect(resolveSeeds({ batch: true, seeds: [5, 6] })).toEqual([5, 6]);
  });
});

describe('resolveArtifactPath', () => {
  it('joins with or without a trailing slash', () => {
    expect(resolveArtifactPath('out', 'report.json')).toBe('out/report.json');
    expect(resolveArtifactPath('out/', 'report.json')).toBe('out/report.json');
  });

  it('places the human balance report under the requested --out (AH-0MV7WVEWL005XEMN)', () => {
    const options = parseEvaluateArgs(['--human', 'h.jsonl', '--out', 'human-out']);
    expect(options.humanFile).toBe('h.jsonl');
    expect(options.outputDir).toBe('human-out');
    expect(resolveArtifactPath(options.outputDir, 'human-balance-report.json')).toBe(
      'human-out/human-balance-report.json',
    );
  });
});

describe('--tune flags (AH-0MVBNITA0005VQGN)', () => {
  it('parses --tune with its declarative --set edit', () => {
    const options = parseEvaluateArgs([
      '--tune',
      '--set',
      'enemy-configs.csv',
      'boss.health=6',
      '--games',
      '100',
      '--out',
      'tune-out',
    ]);
    expect(options.tune).toBe(true);
    expect(options.tuneFile).toBe('enemy-configs.csv');
    expect(options.tuneAssignment).toBe('boss.health=6');
    expect(options.games).toBe(100);
    expect(options.outputDir).toBe('tune-out');
  });

  it('defaults the threshold to ±10 % and honours --keep-edit', () => {
    const defaults = parseEvaluateArgs(['--tune', '--set', 'ship-config.csv', 'thrustAcceleration=320']);
    expect(defaults.threshold).toBe(10);
    expect(defaults.keepEdit).toBe(false);
    const kept = parseEvaluateArgs([
      '--tune',
      '--set',
      'enemy-configs.csv',
      'boss.health=6',
      '--threshold',
      '25',
      '--keep-edit',
    ]);
    expect(kept.threshold).toBe(25);
    expect(kept.keepEdit).toBe(true);
  });

  it('rejects --set without an assignment token', () => {
    expect(() => parseEvaluateArgs(['--set', 'enemy-configs.csv'])).toThrow(
      /Missing value for --set/,
    );
  });
});

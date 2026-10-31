/**
 * Tests for the ring-timing CLI's argument surface
 * (AH-0MVUXCBQY001ESWT).
 *
 * The shell is deliberately thin — it loads the pure TS core over Vite SSR and
 * prints it — so only the flag parsing (the part that can silently do the wrong
 * thing) is pinned here. The measurement itself is covered by
 * `src/ai/eval/ringTiming.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RINGS,
  DEFAULT_SEEDS,
  DEFAULT_STRATEGIES,
  parseRingTimingArgs,
} from './ring-timing.mjs';

describe('ring-timing CLI arguments', () => {
  it('defaults to both rings, both lines and the three evidence seeds', () => {
    const options = parseRingTimingArgs([]);
    expect(options.rings).toEqual(DEFAULT_RINGS);
    expect(options.strategies).toEqual(DEFAULT_STRATEGIES);
    expect(options.seeds).toEqual(DEFAULT_SEEDS);
    expect(options.json).toBe(false);
    expect(options.out).toBeNull();
    expect(options.help).toBe(false);
  });

  it('accepts repeated rings, seeds and a single line', () => {
    const options = parseRingTimingArgs([
      '--ring',
      '2',
      '--seed',
      '7',
      '--seed',
      '9',
      '--strategy',
      'rush',
      '--json',
      '--out',
      'docs/dev/ring.json',
    ]);
    expect(options.rings).toEqual([2]);
    expect(options.seeds).toEqual([7, 9]);
    expect(options.strategies).toEqual(['rush']);
    expect(options.json).toBe(true);
    expect(options.out).toBe('docs/dev/ring.json');
  });

  it('expands --strategy both and --seeds <count> without duplicates', () => {
    const both = parseRingTimingArgs(['--strategy', 'both', '--strategy', 'grind']);
    expect(both.strategies).toEqual(['grind', 'rush']);
    const seeds = parseRingTimingArgs(['--seeds', '3', '--seed', '2']);
    expect(seeds.seeds).toEqual([1, 2, 3]);
  });

  it('rejects an unknown flag, an unknown line and a bad seed count', () => {
    expect(() => parseRingTimingArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseRingTimingArgs(['--strategy', 'speedrun'])).toThrow(
      /--strategy/,
    );
    expect(() => parseRingTimingArgs(['--seeds', '0'])).toThrow(/--seeds/);
    expect(() => parseRingTimingArgs(['--ring'])).toThrow(/Missing value/);
  });

  it('recognises the help flag', () => {
    expect(parseRingTimingArgs(['--help']).help).toBe(true);
  });
});

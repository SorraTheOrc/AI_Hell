/**
 * Deterministic serialisation and report tests for the evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC5).
 */

import { describe, expect, it } from 'vitest';

import { parseRecording } from '../../../scripts/recording.mjs';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { runArena } from './arena';
import {
  fnv1aHash,
  serialiseRecordsJsonl,
  stableStringify,
} from './report';

describe('stableStringify', () => {
  it('recursively sorts object keys so serialisation is byte-stable', () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('fnv1aHash', () => {
  it('is deterministic and sensitive to input', () => {
    expect(fnv1aHash('hello')).toBe(fnv1aHash('hello'));
    expect(fnv1aHash('hello')).not.toBe(fnv1aHash('hellp'));
    expect(fnv1aHash('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('serialiseRecordsJsonl', () => {
  it('round-trips through the existing recording parser', () => {
    const arena = runArena(createLegacyBotPolicy(), { seed: 21, ticks: 120 });
    const jsonl = serialiseRecordsJsonl(arena.records);
    const parsed = parseRecording(jsonl);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].runSeed).toBe(21);
    expect(parsed.skippedLines).toBe(0);
    expect(parsed.unsupportedLines).toBe(0);
    expect(jsonl.endsWith('\n')).toBe(true);
  });
});

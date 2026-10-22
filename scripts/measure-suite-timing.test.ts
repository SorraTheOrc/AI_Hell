/**
 * Tests for the suite-timing measurement parsers
 * (child AH-0MVF6XLBQ002GYWQ, parent AH-0MVF3BESP005ZDAV).
 *
 * The script itself is a measurement harness and must never be executed as
 * a test; only its pure parsers are unit-tested here, using the exact
 * summary block shapes vitest prints (green and red runs).
 */

import { describe, expect, it } from 'vitest';

import {
  latestCachedRun,
  loadSnapshot,
  parseVitestSummary,
} from './measure-suite-timing.mjs';

const GREEN_SUMMARY = `
 RUN  v4.1.11 /home/me/repo

 ❯ src/scenes/PlayScene.test.ts (1 test | 1 failed) 31970ms
     × serves CSV-backed enemy/ship/difficulty values under Vite SSR 30803ms

 Test Files  1 failed | 269 passed (270)
      Tests  1 failed | 5967 passed | 23 expected fail (5991)
   Start at  15:55:54
   Duration  566.42s (transform 279.21s, setup 37.83s, import 2211.76s, tests 1681.71s, environment 1459.40s)
`;

const CLEAN_SUMMARY = `
 Test Files  271 passed (271)
      Tests  5973 passed | 23 expected fail (5996)
   Start at  17:08:15
   Duration  304.05s (transform 156.14s, setup 33.58s, import 1234.33s, tests 916.81s, environment 712.48s)
`;

describe('measure-suite-timing parseVitestSummary', () => {
  it('parses a red run: file/test counts, failures and per-phase durations', () => {
    const s = parseVitestSummary(GREEN_SUMMARY);
    expect(s).not.toBeNull();
    if (!s) throw new Error('expected a summary');
    expect(s.testFiles).toEqual({ failed: 1, passed: 269, expectedFail: 0, total: 270 });
    expect(s.tests).toEqual({ failed: 1, passed: 5967, expectedFail: 23, total: 5991 });
    expect(s.wallClockSeconds).toBeCloseTo(566.42, 2);
    expect(s.phases).toEqual({
      transform: 279.21,
      setup: 37.83,
      import: 2211.76,
      tests: 1681.71,
      environment: 1459.4,
    });
  });

  it('parses a clean run with no failure columns', () => {
    const s = parseVitestSummary(CLEAN_SUMMARY);
    expect(s).not.toBeNull();
    if (!s) throw new Error('expected a summary');
    expect(s.testFiles).toEqual({ failed: 0, passed: 271, expectedFail: 0, total: 271 });
    expect(s.tests).toEqual({ failed: 0, passed: 5973, expectedFail: 23, total: 5996 });
    expect(s.wallClockSeconds).toBeCloseTo(304.05, 2);
  });

  it('returns null for non-summary text', () => {
    expect(parseVitestSummary('')).toBeNull();
    expect(parseVitestSummary('bundle hygiene OK')).toBeNull();
    expect(parseVitestSummary(undefined)).toBeNull();
  });
});

describe('measure-suite-timing loadSnapshot', () => {
  it('reports the cpu count and numeric load averages', () => {
    const load = loadSnapshot();
    expect(load.cpus).toBeGreaterThan(0);
    for (const k of ['load1', 'load5', 'load15'] as const) {
      expect(typeof load[k]).toBe('number');
      expect(Number.isNaN(load[k])).toBe(false);
    }
  });
});

describe('measure-suite-timing latestCachedRun', () => {
  it('tolerates a missing cache dir', () => {
    expect(latestCachedRun('/nonexistent/definitely-missing')).toBeNull();
  });
});

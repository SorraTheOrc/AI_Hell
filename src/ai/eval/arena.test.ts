/**
 * Determinism and telemetry-shape tests for the headless evaluation arena
 * (AH-0MUY08XLD009K4W4, AC1/AC5/AC6).
 *
 * These assert observable behaviour — that the same seed + policy reproduces
 * the same record stream, that a different seed produces a different
 * scenario, and that the emitted records are valid telemetry the existing
 * dev tooling can parse — rather than restating the implementation.
 */

import { describe, expect, it } from 'vitest';

import { parseRecording } from '../../../scripts/recording.mjs';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { runArena } from './arena';
import { stableStringify } from './report';
import { EVAL_TELEMETRY_SCHEMA_VERSION, type TelemetryTickRecord } from './types';

const SMALL_SPAWNS = { minerals: 2, powerUps: 1, enemies: 1, asteroids: 1 };

/** Runs the legacy ladder over a small, fast scenario. */
function run(seed: number, ticks = 240) {
  return runArena(createLegacyBotPolicy(), {
    seed,
    ticks,
    spawns: SMALL_SPAWNS,
  });
}

describe('headless arena determinism (AC5)', () => {
  it('reproduces the identical record stream for the same seed and policy', () => {
    const first = run(0xabc);
    const second = run(0xabc);
    expect(stableStringify(second.records)).toBe(stableStringify(first.records));
    expect(second.ticksSimulated).toBe(first.ticksSimulated);
    expect(second.won).toBe(first.won);
  });

  it('produces a different scenario for a different seed', () => {
    const a = run(1);
    const b = run(2);
    expect(stableStringify(b.records)).not.toBe(stableStringify(a.records));
  });
});

describe('headless arena telemetry shape (AC1)', () => {
  it('opens with a run header carrying the seed and a fixed timestamp', () => {
    const result = run(7);
    const header = result.records[0];
    expect(header.kind).toBe('run_header');
    if (header.kind !== 'run_header') throw new Error('unreachable');
    expect(header.schemaVersion).toBe(EVAL_TELEMETRY_SCHEMA_VERSION);
    expect(header.runSeed).toBe(7);
    expect(header.startedAt).toBe(0);
  });

  it('records finite player state and a run_end event', () => {
    const result = run(3);
    const ticks = result.records.filter(
      (record): record is TelemetryTickRecord => record.kind === 'tick',
    );
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(Number.isFinite(tick.state.player.x)).toBe(true);
      expect(Number.isFinite(tick.state.player.y)).toBe(true);
      expect(tick.input.scheme).toBe('asteroids');
    }
    const runEnd = result.records.find(
      (record) => record.kind === 'event' && record.event === 'run_end',
    );
    expect(runEnd).toBeDefined();
    if (runEnd?.kind !== 'event') throw new Error('unreachable');
    expect(typeof runEnd.payload.won).toBe('boolean');
  });

  it('emits records the existing recording parser accepts as one run', () => {
    const result = run(11);
    const text = result.records.map((record) => JSON.stringify(record)).join('\n');
    const parsed = parseRecording(text);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].runSeed).toBe(11);
    expect(parsed.runs[0].ticks.length).toBeGreaterThan(0);
    expect(parsed.skippedLines).toBe(0);
    expect(parsed.unsupportedLines).toBe(0);
  });
});

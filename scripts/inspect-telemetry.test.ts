/**
 * Hermetic tests for the telemetry inspector
 * (AH-0MUY08Y9P005ER7A, AC5).
 *
 * The inspector's pure core: tolerant JSONL parsing (skips blank/corrupt/
 * incompatible lines), record summarisation and human-readable formatting.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  INSPECT_SCHEMA_VERSION,
  formatSummary,
  isInspectableRecord,
  parseTelemetryJsonl,
  summariseTelemetry,
} from './inspect-telemetry.mjs';

const HEADER = {
  kind: 'run_header',
  schemaVersion: INSPECT_SCHEMA_VERSION,
  runSeed: 42,
  build: { appVersion: '0.1.10', commit: 'abc1234' },
  startedAt: 1_700_000_000_000,
};
const TICK = {
  kind: 'tick',
  schemaVersion: INSPECT_SCHEMA_VERSION,
  tick: 0,
  state: {},
  input: {},
};
const TICK2 = { ...TICK, tick: 5 };
const EVENT = {
  kind: 'event',
  schemaVersion: INSPECT_SCHEMA_VERSION,
  tick: 5,
  event: 'enemy_killed',
  payload: { archetype: 'scout' },
};

describe('parseTelemetryJsonl', () => {
  it('parses valid records and skips blank lines', () => {
    const text = [JSON.stringify(HEADER), '', JSON.stringify(TICK), '  ', JSON.stringify(EVENT)].join(
      '\n',
    );
    const { records, skipped } = parseTelemetryJsonl(text);

    expect(records).toHaveLength(3);
    expect(skipped).toBe(0);
  });

  it('skips corrupt JSON and unknown schema versions without throwing', () => {
    const text = [
      JSON.stringify(HEADER),
      '{not json',
      JSON.stringify({ kind: 'tick', schemaVersion: 999, tick: 1 }),
      JSON.stringify({ kind: 'mystery', schemaVersion: INSPECT_SCHEMA_VERSION }),
    ].join('\n');

    const { records, skipped } = parseTelemetryJsonl(text);

    expect(records).toEqual([HEADER]);
    expect(skipped).toBe(3);
  });

  it('treats non-string input as empty', () => {
    expect(parseTelemetryJsonl(undefined)).toEqual({ records: [], skipped: 0 });
  });
});

describe('isInspectableRecord', () => {
  it('accepts schema-v1 records and rejects everything else', () => {
    expect(isInspectableRecord(HEADER)).toBe(true);
    expect(isInspectableRecord(TICK)).toBe(true);
    expect(isInspectableRecord(EVENT)).toBe(true);
    expect(isInspectableRecord(null)).toBe(false);
    expect(isInspectableRecord('x')).toBe(false);
    expect(isInspectableRecord({ kind: 'tick', schemaVersion: 2 })).toBe(false);
  });
});

describe('summariseTelemetry', () => {
  it('counts kinds, seeds, builds, tick range and event histogram', () => {
    const summary = summariseTelemetry([HEADER, TICK, TICK2, EVENT, { ...EVENT, tick: 6 }]);

    expect(summary.recordCount).toBe(5);
    expect(summary.byKind).toEqual({ run_header: 1, tick: 2, event: 2 });
    expect(summary.schemaVersions).toEqual([1]);
    expect(summary.runs).toEqual({ count: 1, seeds: [42] });
    expect(summary.builds).toEqual(['0.1.10@abc1234']);
    expect(summary.startedAt).toBe(1_700_000_000_000);
    expect(summary.ticks).toEqual({ count: 2, first: 0, last: 6 });
    expect(summary.events).toEqual({ enemy_killed: 2 });
  });

  it('handles an empty list', () => {
    const summary = summariseTelemetry([]);
    expect(summary.recordCount).toBe(0);
    expect(summary.startedAt).toBeNull();
    expect(summary.ticks).toEqual({ count: 0, first: null, last: null });
    expect(summary.events).toEqual({});
  });
});

describe('formatSummary', () => {
  it('renders the key metrics as readable text', () => {
    const text = formatSummary(summariseTelemetry([HEADER, TICK, EVENT]));

    expect(text).toContain('Records: 3');
    expect(text).toContain('run_header: 1');
    expect(text).toContain('seeds: 42');
    expect(text).toContain('enemy_killed: 1');
  });

  it('prints "none" when there are no events', () => {
    expect(formatSummary(summariseTelemetry([HEADER]))).toContain('Events: none');
  });
});

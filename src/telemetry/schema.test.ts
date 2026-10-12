/**
 * Runtime-guard tests for the versioned telemetry schema
 * (AH-0MUY08VJ9006BHJO, AC1/AC6).
 *
 * `isTelemetryRecord` is what a future JSONL reader uses to skip records
 * written by an incompatible schema version instead of crashing, so these
 * tests pin its accept/reject behaviour against real record shapes.
 */

import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_SCHEMA_VERSION,
  isTelemetryRecord,
  type TelemetryEventRecord,
  type TelemetryRunHeaderRecord,
  type TelemetryTickRecord,
} from './schema';

const RUN_HEADER: TelemetryRunHeaderRecord = {
  kind: 'run_header',
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  runSeed: 42,
  build: { appVersion: '0.1.10', commit: 'abc1234' },
  startedAt: 1_700_000_000_000,
};

const TICK: TelemetryTickRecord = {
  kind: 'tick',
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  tick: 7,
  state: { player: { x: 1, y: 2 } },
  input: { thrust: true },
};

const EVENT: TelemetryEventRecord = {
  kind: 'event',
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  tick: 7,
  event: 'enemy_killed',
  payload: { archetype: 'scout' },
};

describe('telemetry schema guard', () => {
  it('declares a positive integer schema version', () => {
    expect(Number.isInteger(TELEMETRY_SCHEMA_VERSION)).toBe(true);
    expect(TELEMETRY_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('accepts each schema-v1 record kind', () => {
    expect(isTelemetryRecord(RUN_HEADER)).toBe(true);
    expect(isTelemetryRecord(TICK)).toBe(true);
    expect(isTelemetryRecord(EVENT)).toBe(true);
  });

  it('rejects records from a different schema version', () => {
    expect(
      isTelemetryRecord({ ...RUN_HEADER, schemaVersion: TELEMETRY_SCHEMA_VERSION + 1 }),
    ).toBe(false);
  });

  it('rejects malformed, unknown or non-object records', () => {
    expect(isTelemetryRecord(null)).toBe(false);
    expect(isTelemetryRecord('tick')).toBe(false);
    expect(isTelemetryRecord({ kind: 'wave', schemaVersion: TELEMETRY_SCHEMA_VERSION })).toBe(
      false,
    );
    expect(
      isTelemetryRecord({ kind: 'run_header', schemaVersion: TELEMETRY_SCHEMA_VERSION }),
    ).toBe(false);
    expect(isTelemetryRecord({ kind: 'tick', schemaVersion: TELEMETRY_SCHEMA_VERSION })).toBe(
      false,
    );
  });
});

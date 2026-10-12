/**
 * Tests for the telemetry recorder (AH-0MUY08VJ9006BHJO, AC4/AC6).
 *
 * These exercise the observable pipeline behaviour: the run header carries
 * the seed/schema/build, records round-trip through the JSONL sink, the ring
 * buffer stays bounded, batch flushing is serialised but non-blocking, ticks
 * are sampled, and payloads are redacted before reaching the sink.
 */

import { describe, expect, it } from 'vitest';

import type { TelemetryConfig } from './config';
import { TELEMETRY_REDACTED, sanitiseTelemetryValue } from './redact';
import {
  BufferedTelemetryRecorder,
  DEFAULT_TELEMETRY_BUILD,
  createTelemetryRecorder,
} from './recorder';
import {
  TELEMETRY_SCHEMA_VERSION,
  isTelemetryRecord,
  type TelemetryRecord,
} from './schema';
import { createMemoryLineWriter, type TelemetrySink } from './sinks';

/** A sink that records the batches it receives. */
class CapturingSink implements TelemetrySink {
  readonly name = 'capture';
  readonly batches: TelemetryRecord[][] = [];

  get records(): TelemetryRecord[] {
    return this.batches.flat();
  }

  async write(records: readonly TelemetryRecord[]): Promise<void> {
    this.batches.push([...records]);
  }
}

/** An enabled config; individual tests override what they exercise. */
function enabledConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    consent: false,
    sink: 'jsonl',
    production: false,
    endpoint: undefined,
    sampleRate: 1,
    bufferCapacity: 16,
    batchSize: 4,
    recording: true,
    ...overrides,
  };
}

describe('telemetry recorder — disabled is a strict no-op (AC3/AC6)', () => {
  it('records and flushes nothing when recording is disabled', async () => {
    const writer = createMemoryLineWriter();
    const recorder = createTelemetryRecorder(
      enabledConfig({ enabled: false, recording: false, sink: 'none' }),
      { lineWriter: writer },
    );

    recorder.startRun({ runSeed: 1 });
    recorder.recordTick({ x: 1 }, { thrust: true });
    recorder.recordEvent('enemy_killed');
    await recorder.flush();
    await recorder.close();

    expect(recorder.enabled).toBe(false);
    expect(writer.lines).toEqual([]);
    expect(recorder.stats).toEqual({
      recorded: 0,
      dropped: 0,
      skipped: 0,
      flushedBatches: 0,
      flushedRecords: 0,
      failedBatches: 0,
    });
  });
});

describe('telemetry recorder — run header and schema version (AC1/AC6)', () => {
  it('writes a run header carrying seed, schema version and build', async () => {
    const sink = new CapturingSink();
    const recorder = createTelemetryRecorder(enabledConfig(), { sink, now: () => 1234 });

    recorder.startRun({ runSeed: 99, build: { commit: 'deadbeef' } });
    recorder.recordTick({ player: { x: 1, y: 2 } }, { thrust: true });
    await recorder.flush();

    expect(sink.records[0]).toEqual({
      kind: 'run_header',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      runSeed: 99,
      build: { appVersion: DEFAULT_TELEMETRY_BUILD.appVersion, commit: 'deadbeef' },
      startedAt: 1234,
    });
    expect(sink.records[1]).toMatchObject({
      kind: 'tick',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      tick: 0,
      state: { player: { x: 1, y: 2 } },
      input: { thrust: true },
    });
  });

  it('resets the tick counter when a new run starts', async () => {
    const sink = new CapturingSink();
    const recorder = createTelemetryRecorder(enabledConfig(), { sink });

    recorder.startRun({ runSeed: 1 });
    recorder.recordTick({}, {});
    recorder.recordEvent('wave_start');
    recorder.startRun({ runSeed: 2 });
    recorder.recordTick({}, {});
    await recorder.flush();

    expect(sink.records.map((record) => record.kind)).toEqual([
      'run_header',
      'tick',
      'event',
      'run_header',
      'tick',
    ]);
    const ticks = sink.records.filter((record) => record.kind === 'tick');
    expect(ticks.map((record) => record.tick)).toEqual([0, 0]);
  });
});

describe('telemetry recorder — JSONL round-trip (AC2/AC6)', () => {
  it('round-trips header, ticks and events through the JSONL sink', async () => {
    const writer = createMemoryLineWriter();
    const recorder = createTelemetryRecorder(enabledConfig(), {
      lineWriter: writer,
      now: () => 1,
    });

    recorder.startRun({ runSeed: 5 });
    recorder.recordTick({ x: 1 }, { left: false });
    recorder.recordEvent('enemy_killed', { archetype: 'scout' });
    await recorder.close();

    const decoded = writer.lines.map((line) => JSON.parse(line));
    expect(decoded.every(isTelemetryRecord)).toBe(true);
    expect(decoded.map((record) => record.kind)).toEqual(['run_header', 'tick', 'event']);
    expect(decoded[2]).toMatchObject({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      event: 'enemy_killed',
      payload: { archetype: 'scout' },
    });
  });
});

describe('telemetry recorder — batching and backpressure (AC4)', () => {
  it('flushes in batches once the batch size is reached', async () => {
    const sink = new CapturingSink();
    const recorder = createTelemetryRecorder(enabledConfig({ batchSize: 2 }), { sink });

    recorder.recordTick({}, {});
    recorder.recordTick({}, {});
    recorder.recordTick({}, {});
    await recorder.flush();

    expect(sink.batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(recorder.stats.flushedBatches).toBe(2);
    expect(recorder.stats.flushedRecords).toBe(3);
  });

  it('overwrites the oldest records when the ring buffer is full', async () => {
    const sink = new CapturingSink();
    const recorder = new BufferedTelemetryRecorder(sink, {
      capacity: 3,
      batchSize: 100,
      sampleRate: 1,
    });

    for (let index = 0; index < 5; index += 1) recorder.recordTick({ index }, {});
    await recorder.flush();

    expect(recorder.stats.recorded).toBe(5);
    expect(recorder.stats.dropped).toBe(2);
    expect(sink.records.map((record) => (record.kind === 'tick' ? record.tick : -1))).toEqual([
      2, 3, 4,
    ]);
  });

  it('never blocks recording on a slow sink', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowSink: TelemetrySink = { name: 'slow', write: () => gate };
    const recorder = createTelemetryRecorder(
      enabledConfig({ bufferCapacity: 8, batchSize: 4 }),
      { sink: slowSink },
    );

    for (let index = 0; index < 8; index += 1) recorder.recordTick({ index }, {});

    // All calls returned while the sink is still pending; nothing was dropped.
    expect(recorder.stats.recorded).toBe(8);
    expect(recorder.stats.dropped).toBe(0);

    release();
    await recorder.flush();
    expect(recorder.stats.flushedRecords).toBe(8);
  });
});

describe('telemetry recorder — sampling (AC4)', () => {
  it('skips sampled-out ticks but always records events, keeping tick alignment', async () => {
    const sink = new CapturingSink();
    const recorder = new BufferedTelemetryRecorder(sink, {
      capacity: 16,
      batchSize: 16,
      sampleRate: 0.5,
      random: () => 0.9,
    });

    recorder.recordTick({ a: 1 }, {});
    recorder.recordTick({ a: 2 }, {});
    recorder.recordEvent('wave_start');
    await recorder.flush();

    expect(recorder.stats.skipped).toBe(2);
    expect(sink.records).toEqual([
      {
        kind: 'event',
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        tick: 2,
        event: 'wave_start',
        payload: null,
      },
    ]);
  });

  it('records every tick when the sample rate is 1', async () => {
    const sink = new CapturingSink();
    const recorder = new BufferedTelemetryRecorder(sink, {
      capacity: 16,
      batchSize: 16,
      sampleRate: 1,
    });

    recorder.recordTick({ a: 1 }, {});
    recorder.recordTick({ a: 2 }, {});
    await recorder.flush();

    expect(recorder.stats.skipped).toBe(0);
    expect(sink.records).toHaveLength(2);
  });
});

describe('telemetry recorder — privacy (AC5)', () => {
  it('redacts sensitive payload fields before they reach a sink', async () => {
    const sink = new CapturingSink();
    const recorder = createTelemetryRecorder(enabledConfig(), { sink });

    recorder.recordTick({ email: 'player@example.com', score: 10 }, { token: 'abc' });
    await recorder.flush();

    expect(sink.records[0]).toMatchObject({
      state: { email: TELEMETRY_REDACTED, score: 10 },
      input: { token: TELEMETRY_REDACTED },
    });
  });

  it('sanitises values passed directly to the redaction helper', () => {
    expect(sanitiseTelemetryValue({ password: 'x' })).toEqual({ password: TELEMETRY_REDACTED });
  });
});

describe('telemetry recorder — close (AC6)', () => {
  it('flushes pending records on close and ignores later ones', async () => {
    const sink = new CapturingSink();
    const recorder = createTelemetryRecorder(enabledConfig(), { sink });

    recorder.recordEvent('pending');
    await recorder.close();
    recorder.recordEvent('after_close');
    await recorder.flush();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ event: 'pending' });
  });
});

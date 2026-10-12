/**
 * Tests for the pluggable telemetry sinks (AH-0MUY08VJ9006BHJO, AC2/AC6).
 *
 * Covers the three sink behaviours that matter: a disabled pipeline writes
 * nothing, the local JSONL sink round-trips records, and the remote stub
 * delivers to (or drops without) a transport.
 */

import { describe, expect, it, vi } from 'vitest';

import type { TelemetryConfig } from './config';
import {
  JsonlTelemetrySink,
  NoopTelemetrySink,
  RemoteTelemetrySink,
  TELEMETRY_JSONL_STORAGE_KEY,
  createLocalStorageLineWriter,
  createMemoryLineWriter,
  createTelemetrySink,
  type TelemetryTransport,
} from './sinks';
import { TELEMETRY_SCHEMA_VERSION, type TelemetryRecord } from './schema';

/** A minimal config; individual tests override the fields they exercise. */
function config(overrides: Partial<TelemetryConfig>): TelemetryConfig {
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

const HEADER: TelemetryRecord = {
  kind: 'run_header',
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  runSeed: 7,
  build: { appVersion: '0.1.10', commit: 'abc1234' },
  startedAt: 1_700_000_000_000,
};

const EVENT: TelemetryRecord = {
  kind: 'event',
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  tick: 3,
  event: 'power_up',
  payload: { type: 'spread' },
};

/** A `Storage` backed by a Map, so tests never touch real browser storage. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  } as Storage;
}

describe('no-op sink (AC2/AC6)', () => {
  it('discards a batch without touching the configured writer', async () => {
    const writer = createMemoryLineWriter();
    const sink = createTelemetrySink(config({ recording: false, sink: 'none' }), {
      lineWriter: writer,
    });

    expect(sink).toBeInstanceOf(NoopTelemetrySink);
    await sink.write([HEADER, EVENT]);
    expect(writer.lines).toEqual([]);
  });
});

describe('JSONL sink (AC2/AC6)', () => {
  it('round-trips records as one JSON object per line', () => {
    const writer = createMemoryLineWriter();
    const sink = new JsonlTelemetrySink(writer);

    sink.write([HEADER, EVENT]);

    expect(writer.lines).toHaveLength(2);
    expect(writer.lines.map((line) => JSON.parse(line))).toEqual([HEADER, EVENT]);
    expect(writer.lines.every((line) => !line.includes('\n'))).toBe(true);
  });

  it('appends newline-delimited JSON through a storage writer', () => {
    const storage = fakeStorage();
    const sink = new JsonlTelemetrySink(
      createLocalStorageLineWriter(TELEMETRY_JSONL_STORAGE_KEY, storage),
    );

    sink.write([EVENT]);
    sink.write([HEADER]);

    const stored = storage.getItem(TELEMETRY_JSONL_STORAGE_KEY);
    expect(stored?.endsWith('\n')).toBe(true);
    const lines = stored!.trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([EVENT, HEADER]);
  });

  it('is selected by the factory when enabled with the jsonl sink', () => {
    const writer = createMemoryLineWriter();
    const sink = createTelemetrySink(config({ sink: 'jsonl' }), { lineWriter: writer });

    expect(sink).toBeInstanceOf(JsonlTelemetrySink);
  });
});

describe('remote sink stub (AC2)', () => {
  it('delivers whole batches to an injected transport', async () => {
    const transport = vi.fn<TelemetryTransport>();
    const sink = new RemoteTelemetrySink({ transport });

    await sink.write([HEADER, EVENT]);

    expect(transport).toHaveBeenCalledWith([HEADER, EVENT]);
    expect(sink.deliveredBatches).toBe(1);
    expect(sink.droppedBatches).toBe(0);
  });

  it('drops and counts batches until a transport is wired', async () => {
    const sink = new RemoteTelemetrySink();

    await sink.write([HEADER]);

    expect(sink.deliveredBatches).toBe(0);
    expect(sink.droppedBatches).toBe(1);
  });

  it('is selected by the factory when enabled with the remote sink', () => {
    expect(createTelemetrySink(config({ sink: 'remote' }))).toBeInstanceOf(RemoteTelemetrySink);
  });

  it('auto-wires an HTTP transport from the configured endpoint (AC2)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const sink = createTelemetrySink(
      config({ sink: 'remote', endpoint: 'https://telemetry.example/ingest' }),
      { transportOptions: { fetchImpl } },
    );

    await sink.write([HEADER, EVENT]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe('https://telemetry.example/ingest');
    expect(init.method).toBe('POST');
  });

  it('drops batches when the remote sink has no endpoint and no transport', async () => {
    const sink = createTelemetrySink(config({ sink: 'remote', endpoint: undefined }));
    expect(sink).toBeInstanceOf(RemoteTelemetrySink);
    await sink.write([HEADER]);
    expect((sink as RemoteTelemetrySink).droppedBatches).toBe(1);
  });
});

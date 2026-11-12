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
  createMemoryLineWriter,
  createTelemetrySink,
  linesToNdjson,
  type TelemetryLineBuffer,
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
    devCollection: false,
    recording: true,
    maxRetainedMessageBytes: 16 * 1024 * 1024,
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

  it('reads the buffer back as NDJSON with a trailing newline (AC1/AC5)', () => {
    const sink = new JsonlTelemetrySink(createMemoryLineWriter());

    sink.write([EVENT]);
    sink.write([HEADER]);

    const content = sink.read();
    expect(content?.endsWith('\n')).toBe(true);
    const lines = content!.trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual([EVENT, HEADER]);
  });

  it('reports an empty buffer as an empty string and resets to it', () => {
    const sink = new JsonlTelemetrySink(createMemoryLineWriter());
    expect(sink.read()).toBe('');

    sink.write([HEADER]);
    expect(sink.read()).not.toBe('');

    sink.reset();
    expect(sink.read()).toBe('');
  });

  it('reads null from a writer that does not buffer', () => {
    const writer = { writeLine: vi.fn() };
    const sink = new JsonlTelemetrySink(writer);

    sink.write([HEADER]);

    expect(writer.writeLine).toHaveBeenCalledTimes(1);
    expect(sink.read()).toBeNull();
    expect(() => sink.reset()).not.toThrow();
  });

  it('is selected by the factory when enabled with the jsonl sink', () => {
    const writer = createMemoryLineWriter();
    const sink = createTelemetrySink(config({ sink: 'jsonl' }), { lineWriter: writer });

    expect(sink).toBeInstanceOf(JsonlTelemetrySink);
  });

  it('defaults to an in-memory buffer that never touches browser storage (AC1)', async () => {
    const setItem = vi.fn();
    const getItem = vi.fn(() => null);
    const sink = createTelemetrySink(config({ sink: 'jsonl' }));
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: vi.fn(), clear: vi.fn() });

    await sink.write([HEADER, EVENT]);

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(sink.read?.()).toContain('"kind":"run_header"');
    vi.unstubAllGlobals();
  });
});

describe('JSONL sink batch observer (AH-0MW6NFRQR0062D90, AC5)', () => {
  it('hands over exactly one batch of NDJSON per flush', () => {
    const deltas: string[] = [];
    const sink = new JsonlTelemetrySink(createMemoryLineWriter(), {
      onFlush: (delta) => deltas.push(delta),
    });

    sink.write([HEADER]);
    sink.write([EVENT]);

    expect(deltas).toEqual([`${JSON.stringify(HEADER)}\n`, `${JSON.stringify(EVENT)}\n`]);
    // The delta is the batch alone, so a streaming uploader never re-sends
    // records an earlier part already carried.
    expect(deltas.map((delta) => JSON.parse(delta.trimEnd()))).toEqual([HEADER, EVENT]);
  });

  it('leaves the buffer accumulating and never clears it mid-run', () => {
    const writer = createMemoryLineWriter();
    const sink = new JsonlTelemetrySink(writer, { onFlush: () => {} });

    sink.write([HEADER]);
    sink.write([EVENT]);

    expect(writer.lines).toHaveLength(2);
    // The whole run is still readable after both flushes (the dev CLI tooling
    // and the run-end upload depend on it).
    expect(sink.read()).toBe(linesToNdjson(writer.lines));
    expect(sink.read()!.trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual([
      HEADER,
      EVENT,
    ]);
  });

  it('does not report an empty batch', () => {
    const onFlush = vi.fn();
    const sink = new JsonlTelemetrySink(createMemoryLineWriter(), { onFlush });

    sink.write([]);

    expect(onFlush).not.toHaveBeenCalled();
    expect(sink.read()).toBe('');
  });

  it('is not invoked by a reset, which only clears the buffer', () => {
    const onFlush = vi.fn();
    const sink = new JsonlTelemetrySink(createMemoryLineWriter(), { onFlush });

    sink.write([HEADER]);
    sink.reset();

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(sink.read()).toBe('');
  });

  it('is wired from the factory sink dependencies', () => {
    const deltas: string[] = [];
    const sink = createTelemetrySink(config({ sink: 'jsonl' }), {
      onFlush: (delta) => deltas.push(delta),
    });

    sink.write([HEADER, EVENT]);

    expect(deltas).toEqual([`${JSON.stringify(HEADER)}\n${JSON.stringify(EVENT)}\n`]);
  });

  it('is simply absent when no observer is injected', () => {
    const sink = new JsonlTelemetrySink(createMemoryLineWriter());

    expect(() => sink.write([HEADER])).not.toThrow();
    expect(sink.read()).toBe(`${JSON.stringify(HEADER)}\n`);
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

/**
 * Bounded-retention + windowed read/drain seam (AH-0MWDGPYDW006MTTM — the
 * red half of the test-first gate for the F3 implementation child
 * AH-0MWDGPZL8005QU13).
 *
 * **TEST-FIRST → GREEN.** These assertions were authored under Vitest's
 * `it.fails(...)` while the seam was missing; the implementation slice
 * (AH-0MWDGPZL8005QU13) flipped each `.fails` back to `it` once the memory
 * line writer gained its bounded-retention cap (drop-oldest
 * **confirmed/skipped** first), a dropped-record base so absolute record-count
 * offsets stay correct, and a read that returns a bounded, in-order window
 * from an absolute record offset. The assertions themselves are unchanged by
 * the flip.
 *
 * Contract pinned:
 * - `createMemoryLineWriter({ maxRetainedBytes })` retains at most
 *   `maxRetainedBytes` bytes of NDJSON body. Once a `writeLine` pushes the
 *   retained body over the cap, the **oldest** retained records are evicted,
 *   preferring records the caller has confirmed/finally-skipped
 *   (`dropConfirmed`) and touching the oldest unconfirmed only as the final
 *   bound that keeps memory bounded under a total dev-server outage.
 * - `baseRecord` is the absolute record offset of the first retained line and
 *   `totalRecords` the absolute count ever written, so a drain never breaks
 *   the streaming protocol's absolute-offset watermark semantics.
 * - `readWindow(fromRecord, limits?)` returns the retained records at/after an
 *   absolute offset, in original order, cut to `limits` (or the whole retained
 *   tail without them); a `fromRecord` below the retained base never re-reads
 *   evicted content.
 * - `read()` keeps returning the whole **retained** run (the dev CLI /
 *   `window.__aiHellTelemetry` contract): a normal below-cap run is
 *   byte-identical to today.
 */
describe('memory line writer — bounded retention and windowed read/drain (AH-0MWDGPYDW006MTTM)', () => {
  /** Window limits for {@link RetainedLineBuffer.readWindow} (F3 seam). */
  interface RetainedWindowLimits {
    readonly maxBytes: number;
    readonly maxRecords: number;
  }

  /** One windowed read's result (F3 seam). */
  interface RetainedWindow {
    readonly lines: readonly string[];
    /** Absolute record offset of the first returned line. */
    readonly fromRecord: number;
    /** Absolute record offset one past the last returned line. */
    readonly nextRecord: number;
  }

  /** The F3 drain-seam surface added to the memory line writer. */
  interface RetainedLineBuffer extends TelemetryLineBuffer {
    /** Absolute count of lines ever written (monotonic, never shrinks). */
    readonly totalRecords: number;
    /** Absolute record offset of the first retained line (evictions only). */
    readonly baseRecord: number;
    /** Marks records below `absoluteCount` as confirmed/finally-skipped. */
    dropConfirmed(absoluteCount: number): void;
    /** Reads a bounded, in-order window from an absolute record offset. */
    readWindow(fromRecord: number, limits?: RetainedWindowLimits): RetainedWindow;
  }

  /** The F3 seam: `createMemoryLineWriter` gains an optional retention cap. */
  const makeRetainedWriter = createMemoryLineWriter as unknown as (
    options?: { readonly maxRetainedBytes?: number },
  ) => RetainedLineBuffer;

  /** An ASCII NDJSON line of exactly `bytes` characters, unique per index. */
  function line(index: number, bytes = 10): string {
    return `${'x'.repeat(bytes - 4)}${String(index).padStart(4, '0')}`;
  }

  it(
    'bounds the retained buffer by the cap, dropping the oldest unconfirmed as the final bound',
    () => {
      // Cap sized for exactly three ten-byte lines (3 × 10 + 3 newlines = 33).
      const writer = makeRetainedWriter({ maxRetainedBytes: 33 });
      for (let i = 0; i < 10; i += 1) writer.writeLine(line(i));

      // Even with nothing confirmed (a total dev-server outage: every upload
      // failed and nothing was skipped either), memory stays bounded — the
      // oldest unconfirmed records fall off as the final bound.
      expect(writer.read().length).toBeLessThanOrEqual(33);
      expect(writer.read().trimEnd().split('\n')).toEqual([
        line(7),
        line(8),
        line(9),
      ]);
      expect(writer.baseRecord).toBe(7);
      expect(writer.totalRecords).toBe(10);
      // Absolute offsets stay correct: a windowed read past the end returns
      // nothing and reports the absolute end of the run.
      expect(writer.readWindow(10)).toEqual({
        lines: [],
        fromRecord: 10,
        nextRecord: 10,
      });
    },
  );

  it(
    'drops confirmed content first when the cap bites, keeping the unconfirmed tail in order',
    () => {
      const writer = makeRetainedWriter({ maxRetainedBytes: 33 });
      for (let i = 0; i < 6; i += 1) writer.writeLine(line(i));
      writer.dropConfirmed(4); // records 0..3 are confirmed/finally-skipped

      // 60 bytes > 33 → the confirmed prefix [0..3] is evicted first; the
      // unconfirmed tail {4,5} is untouched and stays in order.
      expect(writer.baseRecord).toBe(4);
      expect(writer.read().trimEnd().split('\n')).toEqual([line(4), line(5)]);
      expect(writer.totalRecords).toBe(6);

      // The windowed read from the confirmed offset returns exactly the
      // unconfirmed, in-order records with correct absolute offsets.
      expect(writer.readWindow(4)).toEqual({
        lines: [line(4), line(5)],
        fromRecord: 4,
        nextRecord: 6,
      });
      // Reading from below the retained base clamps up — evicted content is
      // never re-read.
      expect(writer.readWindow(0).fromRecord).toBe(4);
      expect(writer.readWindow(0).lines).toEqual([line(4), line(5)]);
    },
  );

  it(
    'falls back to evicting the oldest unconfirmed only after confirmed content is exhausted',
    () => {
      const writer = makeRetainedWriter({ maxRetainedBytes: 33 });
      for (let i = 0; i < 6; i += 1) writer.writeLine(line(i));
      writer.dropConfirmed(1); // only record 0 is confirmed/skipped

      // 60 > 33. Evict {0} (confirmed) → 50 still > 33 → the final bound
      // evicts the oldest unconfirmed {1,2} → {3,4,5} = 33 bytes.
      expect(writer.baseRecord).toBe(3);
      expect(writer.read().trimEnd().split('\n')).toEqual([
        line(3),
        line(4),
        line(5),
      ]);
      expect(writer.totalRecords).toBe(6);
    },
  );

  it('reads a bounded, in-order window from an absolute record offset', () => {
    const writer = makeRetainedWriter();
    for (let i = 0; i < 5; i += 1) writer.writeLine(line(i));
    writer.dropConfirmed(2); // below the cap → nothing is ever evicted

    expect(writer.totalRecords).toBe(5);
    expect(writer.baseRecord).toBe(0);

    // From the confirmed offset: only the unconfirmed records, in order.
    expect(writer.readWindow(2)).toEqual({
      lines: [line(2), line(3), line(4)],
      fromRecord: 2,
      nextRecord: 5,
    });
    // A records-ceiling cuts the window without dropping anything.
    expect(writer.readWindow(2, { maxBytes: 1000, maxRecords: 2 })).toEqual({
      lines: [line(2), line(3)],
      fromRecord: 2,
      nextRecord: 4,
    });
    // Beyond the end: an empty window clamped to the absolute end.
    expect(writer.readWindow(9)).toEqual({ lines: [], fromRecord: 5, nextRecord: 5 });
  });

  it('keeps a normal below-cap run byte-identical and tracked from absolute zero', () => {
    const writer = makeRetainedWriter();
    const recorded = [
      JSON.stringify({ kind: 'event', tick: 1 }),
      JSON.stringify({ kind: 'event', tick: 2 }),
      JSON.stringify({ kind: 'event', tick: 3 }),
    ];
    for (const recordLine of recorded) writer.writeLine(recordLine);

    // The whole retained run reads back exactly as written — a normal demo
    // run sits orders of magnitude under the default cap, so the dev CLI /
    // `window.__aiHellTelemetry` accessor contracts are byte-identical.
    expect(writer.read()).toBe(`${recorded.join('\n')}\n`);
    expect(writer.baseRecord).toBe(0);
    expect(writer.totalRecords).toBe(3);
  });

  it('bounds an oversized run with the default cap when no cap is given', () => {
    const writer = makeRetainedWriter();
    const fill = 'y'.repeat(200);
    for (let i = 0; i < 120_000; i += 1) writer.writeLine(fill);

    // The default 16 MiB retention cap keeps a multi-hour session bounded.
    expect(writer.read().length).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(writer.totalRecords).toBe(120_000);
    expect(writer.baseRecord).toBeGreaterThan(0);
  });

  it('exposes the drain seam through the JSONL sink for its retained writer', () => {
    // One EVENT line is ~88 bytes, so a 100-byte cap retains exactly one.
    const sink = new JsonlTelemetrySink(createMemoryLineWriter({ maxRetainedBytes: 100 }));

    sink.write([EVENT, EVENT]); // two lines > 100 → the oldest is evicted
    expect(sink.readWindow(0)).toMatchObject({ fromRecord: 1, nextRecord: 2 });
    expect(sink.readWindow(0)!.lines).toHaveLength(1);

    // Confirming the evicted prefix never re-reads it: the window clamps to
    // the retained base, and the retained tail is still the whole retained run.
    sink.dropConfirmed(1);
    expect(sink.readWindow(0)!.fromRecord).toBe(1);
    expect(sink.readWindow(1)!.lines).toEqual([sink.read()!.trimEnd()]);

    // A writer that does not retain a window reports null/no-ops.
    const plainSink = new JsonlTelemetrySink({ writeLine: vi.fn() });
    expect(plainSink.readWindow(0)).toBeNull();
    expect(() => plainSink.dropConfirmed(1)).not.toThrow();
  });

  it('wires the configured retention cap into the factory-created dev sink', () => {
    const sink = createTelemetrySink(
      config({ sink: 'jsonl', maxRetainedMessageBytes: 33 }),
    ) as JsonlTelemetrySink;

    sink.write([EVENT, EVENT, EVENT]); // 3 × ~22 bytes > 33 → bounded
    expect(sink.read()!.length).toBeLessThanOrEqual(33);
    expect(sink.readWindow(3)).toEqual({
      lines: [],
      fromRecord: 3,
      nextRecord: 3,
    });
  });
});

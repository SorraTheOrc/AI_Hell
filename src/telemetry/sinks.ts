/**
 * Pluggable telemetry sinks (AH-0MUY08VJ9006BHJO, AC2).
 *
 * Every sink implements one interface — {@link TelemetrySink} — so the
 * recorder and its callers never know where records go. Three sinks ship:
 *
 * - {@link NoopTelemetrySink} — used whenever recording is disabled.
 * - {@link JsonlTelemetrySink} — the local dev sink: one JSON object per
 *   line, written through a pluggable {@link TelemetryLineWriter}. Its
 *   optional {@link TelemetryBatchObserver} (`onFlush`) sees each batch's
 *   **delta** NDJSON right after it is appended, which is how the dev
 *   streaming uploader observes flushed batches without ever clearing the
 *   buffer (AH-0MW6NFRQR0062D90). The
 *   default writer is an **in-memory, run-scoped buffer**
 *   ({@link createMemoryLineWriter}); it never touches browser storage, so a
 *   long run can neither exhaust the origin's storage quota nor break
 *   unrelated writes such as saving settings (AH-0MVIRYGD1000JVY3). The
 *   buffer is read back directly for the streamed parts and the run-end final
 *   part, and by the dev CLI tooling (`window.__aiHellTelemetry`), and is
 *   reset when a run starts.
 * - {@link RemoteTelemetrySink} — the production sink. It forwards batches
 *   to an injected transport; {@link createTelemetrySink} wires an HTTP
 *   transport automatically when an endpoint is configured, otherwise the
 *   sink drops and counts batches (it never silently pretends to send).
 *
 * The factory {@link createTelemetrySink} enforces the disabled/consent
 * policy: it returns a no-op sink unless `config.recording` is true.
 *
 * @module src/telemetry/sinks
 */

import {
  DEFAULT_MAX_RETAINED_MESSAGE_BYTES,
  type TelemetryConfig,
} from './config';
import { type TelemetryRecord } from './schema';
import {
  createHttpTransport,
  type HttpTelemetryTransportOptions,
} from './transport';

/** One destination for telemetry records. */
export interface TelemetrySink {
  /** Human-readable sink name, for diagnostics. */
  readonly name: string;
  /** Delivers a batch of records; may be asynchronous. */
  write(records: readonly TelemetryRecord[]): void | Promise<void>;
  /** Flushes any buffered output, if the sink buffers. */
  flush?(): void | Promise<void>;
  /** Reads the sink's buffered content as NDJSON, when the sink buffers in
   * memory (the dev JSONL sink does; transport sinks return `null`). */
  read?(): string | null;
  /**
   * Reads a bounded window of a retaining sink, from an absolute record
   * offset (AH-0MWDGPZL8005QU13). `null` when the sink does not retain a
   * windowed buffer (e.g. a transport sink or a test spy).
   */
  readWindow?(fromRecord: number, limits?: RetainedWindowLimits): RetainedWindow | null;
  /**
   * Marks records below `absoluteCount` as confirmed/finally-skipped, so a
   * retaining sink drops them first once its retention cap bites
   * (AH-0MWDGPZL8005QU13). No-op for sinks that do not retain a buffer.
   */
  dropConfirmed?(absoluteCount: number): void;
  /** Discards the sink's buffered content, when the sink buffers in memory. */
  reset?(): void;
  /** Releases the sink's resources. */
  close?(): void | Promise<void>;
}

/**
 * Observes the batch a buffering sink has just appended
 * (AH-0MW6NFRQR0062D90, parent AH-0MVJUAADW0033QBD).
 *
 * The argument is **only that batch's** newline-delimited JSON — never the
 * whole buffer — so a consumer (the dev streaming uploader) can send the
 * delta it has not confirmed yet while the sink's buffer keeps accumulating
 * for the CLI tooling and the run-end final part. The observer is invoked
 * after the lines are appended, so a failure in the sink cannot lose the batch
 * and the buffer is never cleared here.
 */
export type TelemetryBatchObserver = (deltaNdjson: string) => void;

/** A sink that discards everything; used when telemetry is disabled. */
export class NoopTelemetrySink implements TelemetrySink {
  readonly name = 'noop';

  /** Discards the batch. */
  write(): void {
    // Intentionally empty: disabled telemetry records nothing.
  }
}

/** Writes one already-serialised JSON line. */
export interface TelemetryLineWriter {
  writeLine(line: string): void;
}

/**
 * A line writer that keeps its lines in memory, so they can be read back as
 * NDJSON and discarded without touching any storage.
 */
export interface TelemetryLineBuffer extends TelemetryLineWriter {
  /** Every buffered line as newline-delimited JSON (`''` when empty). */
  read(): string;
  /** Discards every buffered line. */
  reset(): void;
}

/** Window limits for a windowed read on a retained buffer. */
export interface RetainedWindowLimits {
  /** Ceiling on the window's NDJSON body, in UTF-8 bytes. */
  readonly maxBytes: number;
  /** Ceiling on the window's record count. */
  readonly maxRecords: number;
}

/** One windowed read's result. */
export interface RetainedWindow {
  /** The window's record lines, in original order. */
  readonly lines: readonly string[];
  /** Absolute record offset of the first returned line. */
  readonly fromRecord: number;
  /** Absolute record offset one past the last returned line. */
  readonly nextRecord: number;
}

/**
 * The bounded-retention line buffer the dev JSONL sink writes to
 * (AH-0MWDGPZL8005QU13).
 *
 * Extends the plain buffer with an absolute-offset windowed read/drain seam:
 * `totalRecords`/`baseRecord` keep absolute record counts correct across
 * evictions, `dropConfirmed` marks a confirmed/skipped prefix so retention
 * drops it first, and {@link readWindow} reads only a bounded, in-order
 * window from an absolute record offset — never the whole buffer.
 */
export interface RetainedLineBuffer extends TelemetryLineBuffer {
  /** Absolute count of lines ever written (monotonic, never shrinks). */
  readonly totalRecords: number;
  /** Absolute record offset of the first retained line (evictions only). */
  readonly baseRecord: number;
  /** Marks records below `absoluteCount` as confirmed/finally-skipped. */
  dropConfirmed(absoluteCount: number): void;
  /** Reads a bounded, in-order window from an absolute record offset. */
  readWindow(fromRecord: number, limits?: RetainedWindowLimits): RetainedWindow;
}

/** Construction options for {@link createMemoryLineWriter}. */
export interface MemoryLineWriterOptions {
  /**
   * Retention cap on the buffer's NDJSON body, in UTF-8 bytes (default
   * {@link DEFAULT_MAX_RETAINED_MESSAGE_BYTES}, 16 MiB). Once a write pushes
   * the retained body over the cap the oldest retained records are evicted —
   * already-confirmed (or finally-skipped) content preferred, oldest
   * unconfirmed only as the final bound, so memory stays bounded even under a
   * total dev-server outage (AH-0MWDGPZL8005QU13).
   */
  readonly maxRetainedBytes?: number;
}

/**
 * The dev JSONL sink's writer: an in-memory, run-scoped line buffer with a
 * bounded-retention cap (AH-0MWDGPZL8005QU13).
 *
 * Deliberately storage-free (AH-0MVIRYGD1000JVY3, AC1): the previous
 * `localStorage` writer grew without bound until the origin quota filled,
 * after which every unrelated `setItem` — including saving settings — threw
 * `QuotaExceededError`. The buffer is read straight from memory for the
 * streamed parts, the run-end final part and the dev CLI tooling, and reset
 * when a run starts.
 *
 * Retention is bounded by a configurable cap: below it (every normal demo
 * run, measured 0.67–4 MiB against the 16 MiB default) the buffer is
 * byte-identical to the pre-cap writer; once a write pushes the retained body
 * over the cap the **oldest** retained records are evicted first, preferring
 * records the caller has confirmed/finally-skipped (`dropConfirmed`) and
 * touching the oldest unconfirmed only as the final bound. `baseRecord`/
 * `totalRecords` track absolute record offsets across evictions, so a
 * windowed read/drain can never break the confirmed-offset watermark
 * semantics.
 */
export function createMemoryLineWriter(
  options: MemoryLineWriterOptions = {},
): RetainedLineBuffer & { readonly lines: string[] } {
  const cap = options.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_MESSAGE_BYTES;
  const lines: string[] = [];
  let baseRecord = 0;
  let totalRecords = 0;
  let confirmedCount = 0;
  let retainedBytes = 0;

  /** Bytes one retained line contributes to the NDJSON body (line + newline). */
  const retainedLineBytes = (line: string): number => utf8ByteLength(line) + 1;

  /** Evicts the oldest retained record, tracking the absolute base. */
  const evictOldest = (): void => {
    const dropped = lines.shift();
    if (dropped !== undefined) {
      baseRecord += 1;
      retainedBytes -= retainedLineBytes(dropped);
    }
  };

  return {
    lines,
    writeLine(line: string): void {
      lines.push(line);
      totalRecords += 1;
      retainedBytes += retainedLineBytes(line);
      // Bounded retention: while the retained body is over the cap, evict the
      // oldest record. Confirmed/skipped records are exactly the oldest
      // prefix of the retained window (the boundary only ever advances), so
      // evicting the oldest record automatically prefers them; the oldest
      // unconfirmed falls off only when no confirmed record remains — the
      // final bound that keeps memory bounded under a total outage.
      while (retainedBytes > cap) evictOldest();
    },
    read(): string {
      return linesToNdjson(lines);
    },
    reset(): void {
      lines.length = 0;
      baseRecord = 0;
      totalRecords = 0;
      confirmedCount = 0;
      retainedBytes = 0;
    },
    get baseRecord(): number {
      return baseRecord;
    },
    get totalRecords(): number {
      return totalRecords;
    },
    dropConfirmed(absoluteCount: number): void {
      if (!Number.isFinite(absoluteCount)) return;
      const count = Math.max(0, Math.trunc(absoluteCount));
      if (count <= confirmedCount) return;
      confirmedCount = count;
      // The newly confirmed prefix is now the retention cap's preferred
      // eviction candidate: drop the retained confirmed records first while
      // the body is at/over the cap, then the oldest unconfirmed only if it
      // is still over (the final bound). Below the cap nothing is evicted, so
      // a normal run stays byte-identical regardless of confirmations.
      while (retainedBytes >= cap && baseRecord < confirmedCount) evictOldest();
      while (retainedBytes > cap) evictOldest();
    },
    readWindow(fromRecord: number, limits?: RetainedWindowLimits): RetainedWindow {
      const requested = Number.isFinite(fromRecord) ? Math.trunc(fromRecord) : baseRecord;
      // Clamp up to the retained base (evicted content is never re-read) and
      // down to the absolute run end.
      const start = Math.min(Math.max(requested, baseRecord), totalRecords);
      if (start >= totalRecords) {
        return { lines: [], fromRecord: totalRecords, nextRecord: totalRecords };
      }
      const maxRecords = limits?.maxRecords ?? Number.POSITIVE_INFINITY;
      const maxBytes = limits?.maxBytes ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      let bytes = 0;
      for (let index = start - baseRecord; index < lines.length && out.length < maxRecords; index += 1) {
        const line = lines[index] as string;
        const added = retainedLineBytes(line);
        // Whole records only, and never an empty window while records remain
        // pending: a window is cut before a record that would push it over the
        // byte budget, but at least one record is always returned.
        if (out.length > 0 && bytes + added > maxBytes) break;
        out.push(line);
        bytes += added;
      }
      return { lines: out, fromRecord: start, nextRecord: start + out.length };
    },
  };
}

/** Size of a string in UTF-8 bytes (the unit the retention cap is expressed in). */
function utf8ByteLength(text: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
}

/**
 * NDJSON text for already-serialised record lines (`''` when there are none).
 *
 * The batch half of the delta-observer contract: `read()` formats the whole
 * buffer this way and {@link TelemetryBatchObserver} receives exactly one
 * batch formatted this way. `splitNdjsonLines` in `./devStreamProtocol` is its
 * inverse.
 */
export function linesToNdjson(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** True when a writer can be read back as a buffer. */
function isLineBuffer(writer: TelemetryLineWriter): writer is TelemetryLineBuffer {
  return (
    typeof (writer as Partial<TelemetryLineBuffer>).read === 'function' &&
    typeof (writer as Partial<TelemetryLineBuffer>).reset === 'function'
  );
}

/** True when a writer supports the bounded-retention windowed read/drain seam. */
function isRetainedLineBuffer(writer: TelemetryLineWriter): writer is RetainedLineBuffer {
  return (
    isLineBuffer(writer) &&
    typeof (writer as Partial<RetainedLineBuffer>).readWindow === 'function' &&
    typeof (writer as Partial<RetainedLineBuffer>).dropConfirmed === 'function'
  );
}

/** Construction options for {@link JsonlTelemetrySink}. */
export interface JsonlTelemetrySinkOptions {
  /**
   * Post-flush observer: called once per **non-empty** batch, after its lines
   * have been appended, with only that batch's NDJSON. The buffer's content
   * and lifetime are unchanged, and an empty batch is not an event (there is
   * nothing to stream).
   */
  readonly onFlush?: TelemetryBatchObserver;
}

/** The local JSONL dev sink: serialises each record to one JSON line. */
export class JsonlTelemetrySink implements TelemetrySink {
  readonly name = 'jsonl';

  private readonly onFlush: TelemetryBatchObserver | undefined;

  constructor(
    private readonly writer: TelemetryLineWriter,
    options: JsonlTelemetrySinkOptions = {},
  ) {
    this.onFlush = options.onFlush;
  }

  /**
   * Serialises and writes each record as a single line, then hands the batch
   * delta to the post-flush observer.
   *
   * The observer runs **after** the append and never clears or rewrites the
   * buffer: every record stays readable for the run-end final part and the dev
   * CLI tooling. An observer that throws propagates to the caller, which is
   * the recorder's already-isolated sink write (it counts a failed batch
   * rather than stalling gameplay).
   *
   * @param records - The batch to write.
   */
  write(records: readonly TelemetryRecord[]): void {
    if (records.length === 0) return;
    const lines: string[] = [];
    for (const record of records) {
      const line = JSON.stringify(record);
      this.writer.writeLine(line);
      lines.push(line);
    }
    this.onFlush?.(linesToNdjson(lines));
  }

  /**
   * The buffered NDJSON content, or `null` when the injected writer does not
   * buffer (e.g. a test spy).
   */
  read(): string | null {
    return isLineBuffer(this.writer) ? this.writer.read() : null;
  }

  /** Discards the buffered content, when the writer buffers. */
  reset(): void {
    if (isLineBuffer(this.writer)) this.writer.reset();
  }

  /**
   * Reads a bounded, in-order window from an absolute record offset, when the
   * injected writer retains one; `null` otherwise.
   */
  readWindow(fromRecord: number, limits?: RetainedWindowLimits): RetainedWindow | null {
    return isRetainedLineBuffer(this.writer)
      ? this.writer.readWindow(fromRecord, limits)
      : null;
  }

  /**
   * Marks records below `absoluteCount` as confirmed/finally-skipped, so the
   * retention cap drops them first. No-op when the writer does not retain a
   * windowed buffer.
   */
  dropConfirmed(absoluteCount: number): void {
    if (isRetainedLineBuffer(this.writer)) this.writer.dropConfirmed(absoluteCount);
  }
}

/** Delivers a batch to a remote endpoint. */
export type TelemetryTransport = (
  records: readonly TelemetryRecord[],
) => void | Promise<void>;

/**
 * Production remote sink (AC2).
 *
 * Batches go to the injected transport, or are counted as dropped when none
 * is wired (no endpoint / no transport). The transport owns upload, retry,
 * backoff and the offline path (see `transport.ts`).
 */
export class RemoteTelemetrySink implements TelemetrySink {
  readonly name = 'remote';

  /** Batches handed to a transport. */
  deliveredBatches = 0;
  /** Batches dropped because no transport has been wired yet. */
  droppedBatches = 0;

  private readonly transport: TelemetryTransport | undefined;

  constructor(options: { transport?: TelemetryTransport } = {}) {
    this.transport = options.transport;
  }

  /**
   * Forwards the batch to the configured transport (or drops it in the
   * stub phase).
   *
   * @param records - The batch to deliver.
   */
  async write(records: readonly TelemetryRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (!this.transport) {
      this.droppedBatches += 1;
      return;
    }
    await this.transport(records);
    this.deliveredBatches += 1;
  }
}

/** Injected dependencies for {@link createTelemetrySink}. */
export interface TelemetrySinkDeps {
  /** Line writer for the JSONL sink (defaults to an in-memory buffer). */
  readonly lineWriter?: TelemetryLineWriter;
  /** Transport for the remote sink; overrides endpoint auto-wiring. */
  readonly transport?: TelemetryTransport;
  /** Tuning/injections for the auto-created HTTP transport (AC2). */
  readonly transportOptions?: Omit<HttpTelemetryTransportOptions, 'endpoint'>;
  /**
   * Post-flush observer for the `jsonl` sink's batch deltas
   * (AH-0MW6NFRQR0062D90): the dev streaming uploader subscribes here. The
   * other sinks do not buffer, so they ignore it.
   */
  readonly onFlush?: TelemetryBatchObserver;
}

/**
 * Builds the sink selected by `config`, honouring the disabled/consent
 * gate: a no-op sink is returned unless `config.recording` is true.
 *
 * For the `remote` sink, an HTTP transport is created from the configured
 * endpoint unless one is injected via `deps.transport`. When no endpoint is
 * configured the sink keeps its drop-and-count behaviour.
 *
 * @param config - Resolved telemetry configuration.
 * @param deps - Optional writer/transport injections.
 */
export function createTelemetrySink(
  config: TelemetryConfig,
  deps: TelemetrySinkDeps = {},
): TelemetrySink {
  if (!config.recording || config.sink === 'none') return new NoopTelemetrySink();

  switch (config.sink) {
    case 'jsonl':
      return new JsonlTelemetrySink(
        deps.lineWriter ??
          createMemoryLineWriter({ maxRetainedBytes: config.maxRetainedMessageBytes }),
        { onFlush: deps.onFlush },
      );
    case 'remote': {
      const transport =
        deps.transport ?? createHttpTransport(config.endpoint, deps.transportOptions);
      return new RemoteTelemetrySink({ transport });
    }
    default:
      return new NoopTelemetrySink();
  }
}

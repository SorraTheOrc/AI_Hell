/**
 * Pluggable telemetry sinks (AH-0MUY08VJ9006BHJO, AC2).
 *
 * Every sink implements one interface — {@link TelemetrySink} — so the
 * recorder and its callers never know where records go. Three sinks ship:
 *
 * - {@link NoopTelemetrySink} — used whenever recording is disabled.
 * - {@link JsonlTelemetrySink} — the local dev sink: one JSON object per
 *   line, written through a pluggable {@link TelemetryLineWriter}. The
 *   default writer is an **in-memory, run-scoped buffer**
 *   ({@link createMemoryLineWriter}); it never touches browser storage, so a
 *   long run can neither exhaust the origin's storage quota nor break
 *   unrelated writes such as saving settings (AH-0MVIRYGD1000JVY3). The
 *   buffer is read back directly for the run-end upload and by the dev CLI
 *   tooling (`window.__aiHellTelemetry`), and is reset when a run starts.
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

import { type TelemetryConfig } from './config';
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
  /**
   * Reads the sink's buffered content as NDJSON, when the sink buffers in
   * memory (the dev JSONL sink does; transport sinks return `null`).
   */
  read?(): string | null;
  /** Discards the sink's buffered content, when the sink buffers in memory. */
  reset?(): void;
  /** Releases the sink's resources. */
  close?(): void | Promise<void>;
}

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

/**
 * The dev JSONL sink's writer: an in-memory, run-scoped line buffer.
 *
 * Deliberately storage-free (AH-0MVIRYGD1000JVY3, AC1): the previous
 * `localStorage` writer grew without bound until the origin quota filled,
 * after which every unrelated `setItem` — including saving settings — threw
 * `QuotaExceededError`. The buffer is read straight from memory for the
 * run-end upload and the dev CLI tooling, and reset when a run starts.
 */
export function createMemoryLineWriter(): TelemetryLineBuffer & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    writeLine(line: string): void {
      lines.push(line);
    },
    read(): string {
      return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
    },
    reset(): void {
      lines.length = 0;
    },
  };
}

/** True when a writer can be read back as a buffer. */
function isLineBuffer(writer: TelemetryLineWriter): writer is TelemetryLineBuffer {
  return (
    typeof (writer as Partial<TelemetryLineBuffer>).read === 'function' &&
    typeof (writer as Partial<TelemetryLineBuffer>).reset === 'function'
  );
}

/** The local JSONL dev sink: serialises each record to one JSON line. */
export class JsonlTelemetrySink implements TelemetrySink {
  readonly name = 'jsonl';

  constructor(private readonly writer: TelemetryLineWriter) {}

  /**
   * Serialises and writes each record as a single line.
   *
   * @param records - The batch to write.
   */
  write(records: readonly TelemetryRecord[]): void {
    for (const record of records) {
      this.writer.writeLine(JSON.stringify(record));
    }
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
      return new JsonlTelemetrySink(deps.lineWriter ?? createMemoryLineWriter());
    case 'remote': {
      const transport =
        deps.transport ?? createHttpTransport(config.endpoint, deps.transportOptions);
      return new RemoteTelemetrySink({ transport });
    }
    default:
      return new NoopTelemetrySink();
  }
}

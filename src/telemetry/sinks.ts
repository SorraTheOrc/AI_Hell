/**
 * Pluggable telemetry sinks (AH-0MUY08VJ9006BHJO, AC2).
 *
 * Every sink implements one interface — {@link TelemetrySink} — so the
 * recorder and its callers never know where records go. Three sinks ship:
 *
 * - {@link NoopTelemetrySink} — used whenever recording is disabled.
 * - {@link JsonlTelemetrySink} — the local dev sink: one JSON object per
 *   line, written through a pluggable {@link TelemetryLineWriter} (browser
 *   `localStorage` by default, in-memory for headless use/tests).
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

/** `localStorage` key the dev JSONL sink appends to. */
export const TELEMETRY_JSONL_STORAGE_KEY = 'ai_hell_telemetry_jsonl';

/** An in-memory line writer; useful for headless runs and tests. */
export function createMemoryLineWriter(): TelemetryLineWriter & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    writeLine(line: string): void {
      lines.push(line);
    },
  };
}

/**
 * A line writer that appends newline-delimited JSON to `localStorage`
 * (AC2's local dev sink). Falls back to an in-memory writer when storage is
 * unavailable (SSR/tests), so it never throws.
 *
 * @param key - The storage key to append to.
 * @param storage - Storage to use; defaults to `globalThis.localStorage`.
 */
export function createLocalStorageLineWriter(
  key: string = TELEMETRY_JSONL_STORAGE_KEY,
  storage?: Storage | null,
): TelemetryLineWriter & { readonly lines?: string[] } {
  const target = storage ?? resolveLocalStorage();
  if (!target) return createMemoryLineWriter();

  return {
    writeLine(line: string): void {
      const existing = target.getItem(key);
      target.setItem(key, existing === null ? `${line}\n` : `${existing}${line}\n`);
    },
  };
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
  /** Line writer for the JSONL sink (defaults to local storage). */
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
      return new JsonlTelemetrySink(
        deps.lineWriter ?? createLocalStorageLineWriter(TELEMETRY_JSONL_STORAGE_KEY),
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

/** Resolves a usable `Storage`, or `null` when unavailable. */
function resolveLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

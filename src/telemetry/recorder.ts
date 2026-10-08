/**
 * Telemetry recorder: the bounded, batched, consent-gated pipeline
 * (AH-0MUY08VJ9006BHJO, AC1 + AC4).
 *
 * {@link TelemetryRecorder} is the single entry point call sites use. Its
 * production implementation, {@link BufferedTelemetryRecorder}, is built so
 * recording can never stall gameplay:
 *
 * - **Bounded ring buffer.** Records go into a fixed-capacity ring buffer;
 *   when it fills, the oldest record is overwritten and counted as dropped.
 *   Memory use is constant no matter how slow a sink is.
 * - **Batched, serialised flush.** The buffer is drained into a batch and
 *   handed to the sink asynchronously. Writes are serialised so batches
 *   reach the sink in order; `recordTick`/`recordEvent` never await the sink.
 * - **Sampling.** Ticks can be sampled at a configured rate; discrete events
 *   are always recorded. The tick counter advances even for sampled-out
 *   ticks, so events stay correctly aligned.
 * - **No PII.** Every payload is sanitised (see `redact.ts`) before it is
 *   buffered, so nothing sensitive can reach a sink by mistake.
 *
 * When recording is disabled — the default — {@link createTelemetryRecorder}
 * returns a {@link NoopTelemetryRecorder} that does nothing at all.
 *
 * @module src/telemetry/recorder
 */

import { type TelemetryConfig } from './config';
import { sanitiseTelemetryValue } from './redact';
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryBuildInfo,
  type TelemetryRecord,
} from './schema';
import {
  type TelemetrySink,
  type TelemetrySinkDeps,
  createTelemetrySink,
} from './sinks';

/** Default build metadata when the caller wires none. */
export const DEFAULT_TELEMETRY_BUILD: TelemetryBuildInfo = {
  appVersion: '0.0.0-dev',
  commit: 'unknown',
};

/** Counter snapshot for a recorder. */
export interface TelemetryRecorderStats {
  /** Records accepted into the buffer (including any later dropped). */
  readonly recorded: number;
  /** Records overwritten by the ring buffer before they were flushed. */
  readonly dropped: number;
  /** Ticks skipped by sampling. */
  readonly skipped: number;
  /** Batches handed to the sink. */
  readonly flushedBatches: number;
  /** Records handed to the sink across all batches. */
  readonly flushedRecords: number;
  /** Batches whose sink write threw. */
  readonly failedBatches: number;
}

/** Inputs for the run header written by {@link TelemetryRecorder.startRun}. */
export interface TelemetryRunHeaderInput {
  /** Per-run RNG seed. */
  readonly runSeed: number;
  /** Build metadata; overrides the recorder's default per field. */
  readonly build?: Partial<TelemetryBuildInfo>;
  /** Wall-clock start, epoch ms; defaults to the recorder's clock. */
  readonly startedAt?: number;
}

/**
 * The telemetry recorder (AC1). All methods are synchronous and non-blocking
 * except {@link TelemetryRecorder.flush} / {@link TelemetryRecorder.close},
 * which await the sink.
 */
export interface TelemetryRecorder {
  /** `false` for the disabled no-op recorder. */
  readonly enabled: boolean;
  /** Starts a new run: resets the tick counter and writes the run header. */
  startRun(header: TelemetryRunHeaderInput): void;
  /** Records the state + input for the next tick. */
  recordTick(state: unknown, input: unknown): void;
  /** Records a discrete event at the current tick. */
  recordEvent(event: string, payload?: unknown): void;
  /** Drains the buffer and awaits all in-flight sink writes. */
  flush(): Promise<void>;
  /** Flushes and closes the sink; further records are ignored. */
  close(): Promise<void>;
  /** A snapshot of the recorder's counters. */
  readonly stats: TelemetryRecorderStats;
}

/** Frozen zeroed stats for the no-op recorder. */
const NOOP_STATS: TelemetryRecorderStats = Object.freeze({
  recorded: 0,
  dropped: 0,
  skipped: 0,
  flushedBatches: 0,
  flushedRecords: 0,
  failedBatches: 0,
});

/** The disabled recorder: a strict no-op (AC3, AC6). */
export class NoopTelemetryRecorder implements TelemetryRecorder {
  readonly enabled = false;

  startRun(): void {
    // Disabled: nothing is recorded.
  }

  recordTick(): void {
    // Disabled: nothing is recorded.
  }

  recordEvent(): void {
    // Disabled: nothing is recorded.
  }

  async flush(): Promise<void> {
    // Nothing buffered.
  }

  async close(): Promise<void> {
    // Nothing buffered.
  }

  get stats(): TelemetryRecorderStats {
    return NOOP_STATS;
  }
}

/** Construction options for {@link BufferedTelemetryRecorder}. */
export interface BufferedTelemetryRecorderOptions {
  /** Ring-buffer capacity in records. */
  readonly capacity: number;
  /** Buffer size that triggers an automatic flush. */
  readonly batchSize: number;
  /** Tick sampling rate, `0`–`1`. */
  readonly sampleRate: number;
  /** Random source for sampling (defaults to `Math.random`). */
  readonly random?: () => number;
  /** Clock for `startedAt` (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Default build metadata for run headers. */
  readonly build?: TelemetryBuildInfo;
}

/**
 * The enabled recorder: bounded ring buffer + batched, serialised sink
 * writes (AC4).
 */
export class BufferedTelemetryRecorder implements TelemetryRecorder {
  readonly enabled = true;

  private readonly sink: TelemetrySink;
  private readonly buffer: RingBuffer<TelemetryRecord>;
  private readonly batchSize: number;
  private readonly sampleRate: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly build: TelemetryBuildInfo;

  private tick = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private counters = {
    recorded: 0,
    skipped: 0,
    flushedBatches: 0,
    flushedRecords: 0,
    failedBatches: 0,
  };

  constructor(sink: TelemetrySink, options: BufferedTelemetryRecorderOptions) {
    this.sink = sink;
    this.buffer = new RingBuffer<TelemetryRecord>(options.capacity);
    this.batchSize = Math.max(1, options.batchSize);
    this.sampleRate = Math.min(1, Math.max(0, options.sampleRate));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.build = options.build ?? DEFAULT_TELEMETRY_BUILD;
  }

  /** Writes the run header and resets the tick counter. */
  startRun(header: TelemetryRunHeaderInput): void {
    this.tick = 0;
    if (this.closed) return;
    this.enqueue({
      kind: 'run_header',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      runSeed: header.runSeed,
      build: {
        appVersion: header.build?.appVersion ?? this.build.appVersion,
        commit: header.build?.commit ?? this.build.commit,
      },
      startedAt: header.startedAt ?? this.now(),
    });
  }

  /** Sanitises and buffers the tick's state + input, subject to sampling. */
  recordTick(state: unknown, input: unknown): void {
    if (this.closed) return;
    const tick = this.tick++;
    if (!this.shouldSample()) {
      this.counters.skipped += 1;
      return;
    }
    this.enqueue({
      kind: 'tick',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      tick,
      state: sanitiseTelemetryValue(state),
      input: sanitiseTelemetryValue(input),
    });
  }

  /** Sanitises and buffers a discrete event at the current tick. */
  recordEvent(event: string, payload: unknown = null): void {
    if (this.closed) return;
    this.enqueue({
      kind: 'event',
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      tick: this.tick,
      event,
      payload: sanitiseTelemetryValue(payload),
    });
  }

  /** Drains the buffer and awaits all in-flight sink writes. */
  async flush(): Promise<void> {
    const batch = this.buffer.drain();
    if (batch.length > 0) {
      this.counters.flushedBatches += 1;
      this.counters.flushedRecords += batch.length;
      this.writeChain = this.writeChain.then(() => this.deliver(batch));
    }
    await this.writeChain;
  }

  /** Flushes pending records, then closes the sink. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.writeChain;
      return;
    }
    await this.flush();
    try {
      await this.sink.close?.();
    } finally {
      this.closed = true;
    }
  }

  /** A frozen snapshot of the recorder's counters. */
  get stats(): TelemetryRecorderStats {
    return Object.freeze({
      ...this.counters,
      dropped: this.buffer.dropped,
    });
  }

  /** Adds a record to the ring buffer, auto-flushing at the batch size. */
  private enqueue(record: TelemetryRecord): void {
    this.buffer.push(record);
    this.counters.recorded += 1;
    if (this.buffer.size >= this.batchSize) this.scheduleFlush();
  }

  /** Fire-and-forget flush; sink errors are counted, not thrown. */
  private scheduleFlush(): void {
    void this.flush().catch(() => {
      // `deliver` already accounts for sink errors; this guards the chain.
    });
  }

  /** Writes one batch, counting (not propagating) a sink failure. */
  private async deliver(batch: readonly TelemetryRecord[]): Promise<void> {
    try {
      await this.sink.write(batch);
    } catch {
      this.counters.failedBatches += 1;
    }
  }

  /** Applies the sampling policy for a tick record. */
  private shouldSample(): boolean {
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    return this.random() < this.sampleRate;
  }
}

/** Optional injections for {@link createTelemetryRecorder}. */
export interface TelemetryRecorderOptions extends TelemetrySinkDeps {
  /** Random source for sampling. */
  readonly random?: () => number;
  /** Clock for run-header timestamps. */
  readonly now?: () => number;
  /** Default build metadata. */
  readonly build?: TelemetryBuildInfo;
  /** Sink override, bypassing {@link createTelemetrySink}. */
  readonly sink?: TelemetrySink;
}

/**
 * Builds the recorder for a resolved config. Returns the no-op recorder
 * unless `config.recording` is true, so disabled-by-default is enforced in
 * one place (AC3).
 *
 * @param config - Resolved telemetry configuration.
 * @param options - Optional sink/writer/clock injections.
 */
export function createTelemetryRecorder(
  config: TelemetryConfig,
  options: TelemetryRecorderOptions = {},
): TelemetryRecorder {
  if (!config.recording) return new NoopTelemetryRecorder();

  const sink = options.sink ?? createTelemetrySink(config, options);
  return new BufferedTelemetryRecorder(sink, {
    capacity: config.bufferCapacity,
    batchSize: config.batchSize,
    sampleRate: config.sampleRate,
    random: options.random,
    now: options.now,
    build: options.build,
  });
}

/**
 * A fixed-capacity ring buffer that overwrites its oldest entry when full.
 *
 * Draining returns records oldest-first, preserving chronological order.
 */
class RingBuffer<T> {
  /** Count of entries overwritten before they could be drained. */
  dropped = 0;

  private readonly storage: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.storage = new Array<T | undefined>(Math.max(1, capacity));
  }

  /** Number of buffered entries. */
  get size(): number {
    return this.count;
  }

  /** Appends `item`, overwriting the oldest entry when full. */
  push(item: T): void {
    if (this.count === this.capacity) {
      this.storage[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
      this.dropped += 1;
      return;
    }
    this.storage[(this.head + this.count) % this.capacity] = item;
    this.count += 1;
  }

  /** Removes and returns all buffered entries, oldest-first. */
  drain(): T[] {
    const out: T[] = [];
    for (let index = 0; index < this.count; index += 1) {
      out.push(this.storage[(this.head + index) % this.capacity] as T);
    }
    this.storage.fill(undefined);
    this.head = 0;
    this.count = 0;
    return out;
  }
}

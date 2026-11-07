/**
 * Dev-only streaming telemetry uploader (AH-0MW6NI6BW003RJWH, parent
 * AH-0MVJUAADW0033QBD).
 *
 * The client half of the incremental part protocol: instead of one run-end
 * POST of the whole in-memory buffer, every flushed batch is streamed to the
 * dev server **during** the run, so an interrupted run keeps everything the
 * server already confirmed.
 *
 * Design constraints (pinned by `devStream.test.ts`):
 *
 * - **Dev-only.** Every part send routes its decision through the single dev
 *   gate ({@link isDevTelemetryUploadEnabled}); the module itself is reached
 *   only through {@link loadDevTelemetryStreamer}, whose literal dev check Vite
 *   folds to `false` in a production build (so the whole module is
 *   dead-code-eliminated).
 * - **The buffer is the source of truth and is never cleared.** A part is
 *   built by reading the run's in-memory buffer through the injected
 *   `readBuffer` seam and taking only the records beyond the confirmed
 *   offset ({@link nextPartRange}). The `onFlush` delta is the **trigger**
 *   (one part per flush, in flush order), while the buffer read keeps the
 *   streamer correct even when it finishes loading after the first batches
 *   have already been flushed.
 * - **Serialised part chain.** Parts are chained one at a time, so records
 *   can never interleave out of order, and a slow server cannot build a
 *   request storm.
 * - **Server-authoritative watermark.** {@link DevTelemetryStreamer.confirmedCount}
 *   only advances to the cumulative count the server reports, so a retried
 *   part is deduped by the server's offset rule rather than duplicated.
 * - **Bounded bodies.** Each part carries at most one batch; the run-end final
 *   part still respects the 8 MiB CDP-message cap
 *   ({@link checkDevUploadSize}) with today's actionable skip line when the
 *   backlog after an outage is over it.
 * - **Fire-and-forget.** Every failure is caught and reported through the
 *   optional `onError` seam; the runner never rejects and run end is never
 *   blocked or crashed by a streaming failure.
 *
 * @module src/telemetry/devStream
 */

import {
  DEV_TELEMETRY_UPLOAD_CONTENT_TYPE,
  DEV_TELEMETRY_UPLOAD_ENDPOINT,
  checkDevUploadSize,
  reportDevUploadSkip,
  resolveDevUploadLimit,
  type DevUploadCapEnv,
  type DevUploadFetch,
  type DevUploadFetchResponse,
  type DevUploadSkip,
} from './devUpload';
import {
  PART_FINAL_HEADER,
  PART_MARKER_HEADER,
  PART_OFFSET_HEADER,
  PART_RUN_KEY_HEADER,
  deriveRunKey,
  nextPartRange,
  splitNdjsonLines,
} from './devStreamProtocol';
import {
  isDevTelemetryUploadEnabled,
  type DevModeEnv,
  type DevTelemetrySetting,
} from './devMode';
import { linesToNdjson } from './sinks';

/** Construction options for {@link createDevTelemetryStreamer}. */
export interface DevTelemetryStreamerOptions {
  /** The run's start timestamp (epoch ms), from the run header. */
  readonly startedAt: number;
  /** The run's RNG seed, from the run header. */
  readonly runSeed: number;
  /**
   * Reads the current run's buffered NDJSON content (the recorder's in-memory
   * buffer). The buffer is never cleared by this module.
   */
  readonly readBuffer: () => string | null;
  /**
   * Reads the persisted share-telemetry setting. A reader rather than a value,
   * so a setting changed during the run is honoured at the next part (and at
   * run end), exactly like the whole-file run-end upload.
   */
  readonly getSetting?: () => DevTelemetrySetting | undefined;
  /** Build environment slice; defaults to `import.meta.env`. */
  readonly env?: DevModeEnv & DevUploadCapEnv;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: DevUploadFetch;
  /** Upload endpoint; defaults to {@link DEV_TELEMETRY_UPLOAD_ENDPOINT}. */
  readonly endpoint?: string;
  /** CDP message cap in bytes; defaults to the environment's configured cap. */
  readonly maxMessageBytes?: number;
  /** Failure reporter (never throws to the caller); silent by default. */
  readonly onError?: (error: unknown) => void;
  /** Over-cap reporter; defaults to one actionable `console.warn` line. */
  readonly onSkip?: (skip: DevUploadSkip) => void;
}

/**
 * The dev streaming uploader for one run.
 *
 * Create it at run start, call {@link push} for every flushed batch and
 * {@link finalise} once at run end.
 */
export interface DevTelemetryStreamer {
  /** The run-scoped key every part of this run carries. */
  readonly runKey: string;
  /** Records the server has confirmed storing for this run. */
  readonly confirmedCount: number;
  /** How many parts have been delivered with a 2xx. */
  readonly sentParts: number;
  /** `true` once the final part has been accepted by the server. */
  readonly finalised: boolean;
  /**
   * Streams whatever the buffer holds beyond the confirmed offset, as one
   * part. Called once per flushed batch, so parts arrive in flush order.
   *
   * @param deltaNdjson - The batch that was just flushed (the trigger; the
   *   part's content is read from the buffer so a late subscriber loses
   *   nothing).
   */
  push(deltaNdjson: string): void;
  /**
   * Sends the run's final part (`final: true`), which makes the server store
   * the run as one `session-*.jsonl` and enqueue exactly one evaluation.
   *
   * @returns `true` when the server accepted the finalisation.
   */
  finalise(): Promise<boolean>;
  /** Resolves once every queued part has settled. */
  whenIdle(): Promise<void>;
}

/** Builds the run key from a run header's start time and seed. */
export function runKeyFor(startedAt: number, runSeed: number): string {
  return deriveRunKey(startedAt, runSeed);
}

/**
 * Creates the streaming uploader for one run.
 *
 * @param options - Run identity and injected seams.
 */
export function createDevTelemetryStreamer(
  options: DevTelemetryStreamerOptions,
): DevTelemetryStreamer {
  const env = options.env ?? import.meta.env;
  const endpoint = options.endpoint ?? DEV_TELEMETRY_UPLOAD_ENDPOINT;
  const maxMessageBytes = resolveDevUploadLimit(env, options.maxMessageBytes);
  const onSkip = options.onSkip ?? reportDevUploadSkip;
  const onError = options.onError ?? (() => {});
  const runKey = runKeyFor(options.startedAt, options.runSeed);

  let confirmedCount = 0;
  let sentParts = 0;
  let finalised = false;
  let chain: Promise<void> = Promise.resolve();

  /** True when this build/setting may reach the dev server at all. */
  const gateOpen = (): boolean =>
    isDevTelemetryUploadEnabled(env, options.getSetting?.());

  /** The run's buffered records beyond the confirmed offset. */
  const pendingRange = () => {
    const buffered = options.readBuffer() ?? '';
    return nextPartRange(confirmedCount, splitNdjsonLines(buffered));
  };

  /** Shares of the protocol response the streamer needs. */
  const readConfirmedCount = (payload: unknown): number | undefined => {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const value = (payload as { confirmedCount?: unknown }).confirmedCount;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : undefined;
  };

  const readPayload = async (
    response: DevUploadFetchResponse,
  ): Promise<unknown> => {
    if (!response.json) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  };

  const resolveFetch = (): DevUploadFetch | undefined => {
    if (options.fetchImpl) return options.fetchImpl;
    return typeof globalThis.fetch === 'function'
      ? (url, init) => globalThis.fetch(url, init)
      : undefined;
  };

  /**
   * Sends one part. Never throws: a failure is reported through `onError` and
   * leaves the watermark where it was, so the records stay pending.
   */
  const sendPart = async (final: boolean): Promise<void> => {
    if (final && finalised) return;
    if (!gateOpen()) return;

    const range = pendingRange();
    // Mid-run an empty part is not an event (there is nothing to stream); run
    // end always speaks, because finalisation is the part's payload.
    if (!final && range.empty) return;
    // Nothing was ever recorded (recording disabled for this run), so there is
    // nothing to finalise — the pre-streaming uploader skipped an empty buffer
    // the same way.
    if (final && range.empty && confirmedCount === 0) return;

    const body = linesToNdjson(range.lines);
    const over = checkDevUploadSize(body, maxMessageBytes);
    if (over) {
      onSkip(over);
      return;
    }

    const post = resolveFetch();
    if (!post) return;

    const headers: Record<string, string> = {
      'content-type': DEV_TELEMETRY_UPLOAD_CONTENT_TYPE,
      [PART_MARKER_HEADER]: '1',
      [PART_RUN_KEY_HEADER]: runKey,
      [PART_OFFSET_HEADER]: String(range.offset),
    };
    if (final) headers[PART_FINAL_HEADER] = '1';

    const response = await post(endpoint, { method: 'POST', headers, body });
    const payload = await readPayload(response);
    if (!response.ok) {
      // A gap means the server knows more than we thought; adopt its count so
      // the next part re-syncs instead of repeating the refusal.
      const serverCount = readConfirmedCount(payload);
      if (response.status === 409 && serverCount !== undefined) {
        confirmedCount = serverCount;
      }
      onError(
        new Error(
          `dev telemetry part rejected (${response.status}) for run ${runKey}`,
        ),
      );
      return;
    }
    sentParts += 1;
    confirmedCount = readConfirmedCount(payload) ?? range.confirmedCount;
    if (final) finalised = true;
  };

  /** Appends a task to the serialised part chain (never rejects). */
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task).catch((error: unknown) => {
      onError(error);
    });
    chain = run;
    return run;
  };

  return {
    runKey,
    get confirmedCount() {
      return confirmedCount;
    },
    get sentParts() {
      return sentParts;
    },
    get finalised() {
      return finalised;
    },
    push(deltaNdjson: string): void {
      if (deltaNdjson.trim().length === 0) return;
      void enqueue(() => sendPart(false));
    },
    async finalise(): Promise<boolean> {
      await enqueue(() => sendPart(true));
      return finalised;
    },
    whenIdle(): Promise<void> {
      return chain;
    },
  };
}

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
 * - **Lost 2xx is a retry, never a gap.** A failed part leaves the watermark
 *   where it was, so the next attempt re-sends the same range from the last
 *   confirmed offset; the server drops the already-appended prefix (its
 *   `applyPartRecords` dedupe rule) and the run's records still land exactly
 *   once.
 * - **Gap re-sync.** A part refused as a gap (409) carries the server's
 *   authoritative count; the client adopts it and re-sends immediately from
 *   there, without spending a backoff delay on a recoverable re-sync.
 * - **Light, bounded retry/backoff.** A failed part is not retried in a tight
 *   loop: it opens a short, exponentially backing-off **window** (capped), and
 *   the next flush inside that window is coalesced into it. An unreachable
 *   dev server is therefore retried at most once per window instead of being
 *   hammered, and no background timer outlives the trigger it belongs to.
 * - **Offline degradation.** After a failure the records simply stay pending
 *   in the (never-cleared) buffer; run end's final part carries the whole
 *   unconfirmed tail as one request (retried a bounded number of times with
 *   backoff), which is today's single run-end upload.
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

/**
 * Total delivery attempts for a **run-end** part: the first send plus its
 * retries (`AH-0MW6NJ3VU0038JHZ`).
 *
 * Bounded because run end is the last chance to deliver the tail, so a dev
 * server outage must not turn it into an unbounded retry loop.
 */
export const DEFAULT_PART_MAX_ATTEMPTS = 4;

/** Delay before the first retry, in milliseconds (doubles per attempt). */
export const DEFAULT_PART_RETRY_BASE_MS = 250;

/** Ceiling for one retry delay, in milliseconds. */
export const DEFAULT_PART_RETRY_MAX_MS = 2_000;

/** Resolves after `ms`; the injectable timer seam (tests never wait). */
export type DevPartSleep = (ms: number) => Promise<void>;

/** Default backoff timer. */
const defaultSleep: DevPartSleep = (ms) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

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
  /**
   * Total delivery attempts for the run-end final part (first send plus
   * retries). Defaults to {@link DEFAULT_PART_MAX_ATTEMPTS}; never less than 1.
   */
  readonly maxPartAttempts?: number;
  /** First retry delay in ms; defaults to {@link DEFAULT_PART_RETRY_BASE_MS}. */
  readonly retryBaseDelayMs?: number;
  /** Retry delay ceiling in ms; defaults to {@link DEFAULT_PART_RETRY_MAX_MS}. */
  readonly retryMaxDelayMs?: number;
  /** Backoff timer seam for the run-end retries; defaults to `setTimeout`. */
  readonly sleep?: DevPartSleep;
  /** Clock seam for the mid-run backoff window; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Failure reporter for a part that could not be delivered (never throws to
   * the caller); silent by default. Reported once per failed delivery, so a
   * mid-run failure is reported even though a later trigger retries it.
   */
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
   * A trigger inside the current backoff window (opened by the last failed
   * part) is coalesced: it is the next trigger after the window that re-sends
   * the pending range from the last confirmed offset.
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
   * Unlike {@link push}, this ignores the mid-run backoff window and retries a
   * failed final part a bounded number of times with a light backoff, because
   * no further flush will come to trigger the tail.
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
  /**
   * Consecutive failed parts (reset by any success) and the earliest time the
   * next mid-run trigger may attempt a send. A failed part therefore coalesces
   * every flush inside its backoff window instead of retrying in a tight loop.
   */
  let failureStreak = 0;
  let nextAttemptAt = 0;

  const maxAttempts = Math.max(
    1,
    Math.trunc(options.maxPartAttempts ?? DEFAULT_PART_MAX_ATTEMPTS),
  );
  const retryBaseDelayMs = Math.max(
    0,
    options.retryBaseDelayMs ?? DEFAULT_PART_RETRY_BASE_MS,
  );
  const retryMaxDelayMs = Math.max(
    0,
    options.retryMaxDelayMs ?? DEFAULT_PART_RETRY_MAX_MS,
  );
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  /** Exponential, capped delay before retry number `attempt` (1-based). */
  const retryDelay = (attempt: number): number =>
    Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** (attempt - 1));

  /** Starts a new backoff window after a failed part (reported once here). */
  const recordFailure = (error: unknown): void => {
    failureStreak += 1;
    nextAttemptAt = now() + retryDelay(failureStreak);
    onError(error);
  };

  /** Clears the backoff window: the pipeline is healthy again. */
  const recordSuccess = (): void => {
    failureStreak = 0;
    nextAttemptAt = 0;
  };

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
   * One delivery attempt for the pending range.
   *
   * Never throws and never reports: it returns whether the part is done (sent,
   * empty, over-cap, no `fetch`) or must be retried, plus the error and
   * whether the retry should back off. `retry` never advances the watermark,
   * so a retried part is rebuilt from the last confirmed offset.
   */
  const attemptPart = async (
    final: boolean,
  ): Promise<
    | { readonly kind: 'done' }
    | { readonly kind: 'retry'; readonly error: unknown; readonly backoff: boolean }
  > => {
    const range = pendingRange();
    // Mid-run an empty part is not an event (there is nothing to stream); run
    // end always speaks, because finalisation is the part's payload.
    if (!final && range.empty) return { kind: 'done' };
    // Nothing was ever recorded (recording disabled for this run), so there is
    // nothing to finalise — the pre-streaming uploader skipped an empty buffer
    // the same way.
    if (final && range.empty && confirmedCount === 0) return { kind: 'done' };

    const body = linesToNdjson(range.lines);
    const over = checkDevUploadSize(body, maxMessageBytes);
    if (over) {
      // Retrying cannot shrink the body, so an over-cap part is final.
      onSkip(over);
      return { kind: 'done' };
    }

    const post = resolveFetch();
    if (!post) return { kind: 'done' };

    const headers: Record<string, string> = {
      'content-type': DEV_TELEMETRY_UPLOAD_CONTENT_TYPE,
      [PART_MARKER_HEADER]: '1',
      [PART_RUN_KEY_HEADER]: runKey,
      [PART_OFFSET_HEADER]: String(range.offset),
    };
    if (final) headers[PART_FINAL_HEADER] = '1';

    let response: DevUploadFetchResponse;
    try {
      response = await post(endpoint, { method: 'POST', headers, body });
    } catch (error) {
      // Unreachable dev server: the watermark stays put, so these records are
      // re-sent (after a backoff) or carried by the run-end final part.
      return { kind: 'retry', error, backoff: true };
    }

    const payload = await readPayload(response);
    if (!response.ok) {
      const serverCount = readConfirmedCount(payload);
      if (response.status === 409 && serverCount !== undefined) {
        // A gap means the server knows more than we thought; adopt its count
        // and re-send from there immediately — a recoverable re-sync is not
        // an outage, so it does not pay a backoff delay.
        confirmedCount = serverCount;
        return {
          kind: 'retry',
          error: new Error(
            `dev telemetry part gap for run ${runKey}: re-synced to ${serverCount}`,
          ),
          backoff: false,
        };
      }
      return {
        kind: 'retry',
        error: new Error(
          `dev telemetry part rejected (${response.status}) for run ${runKey}`,
        ),
        backoff: true,
      };
    }
    sentParts += 1;
    confirmedCount = readConfirmedCount(payload) ?? range.confirmedCount;
    if (final) finalised = true;
    return { kind: 'done' };
  };

  /**
   * Sends one part.
   *
   * - **Mid-run** (`push`) this is a single attempt. A failure reports once and
   *   opens a backoff window, so the next flush is coalesced into it and the
   *   retry happens as soon as the window elapses — no timer, no retry storm.
   * - **Run end** (`finalise`) it retries a bounded number of times with a
   *   light exponential backoff, because no further flush will ever come.
   * - A **gap** is a recoverable re-sync, not an outage: it adopts the server's
   *   count and re-sends immediately.
   *
   * Never throws: the watermark is left where it was on failure, so every
   * record stays pending for the next trigger or run end.
   */
  const sendPart = async (final: boolean): Promise<void> => {
    if (final && finalised) return;
    if (!gateOpen()) return;
    // Mid-run triggers inside the backoff window are coalesced: the backlog
    // rides the next flush once the window has elapsed. Run end always tries.
    if (!final && now() < nextAttemptAt) return;

    for (let attempt = 1; ; attempt += 1) {
      const outcome = await attemptPart(final);
      if (outcome.kind === 'done') {
        recordSuccess();
        return;
      }
      if (!outcome.backoff) {
        // Gap re-sync: bounded by the same attempt budget in both phases.
        if (attempt >= maxAttempts) {
          recordFailure(outcome.error);
          return;
        }
        continue;
      }
      // An unreachable/rejecting server: mid-run one attempt per trigger, run
      // end the full bounded budget with backoff between attempts.
      if (!final || attempt >= maxAttempts) {
        recordFailure(outcome.error);
        return;
      }
      await sleep(retryDelay(attempt));
    }
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

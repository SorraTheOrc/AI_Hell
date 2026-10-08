/**
 * Remote telemetry transport (AH-0MUY08Y9P005ER7A, AC2/AC4).
 *
 * The framework's `RemoteTelemetrySink` forwards **already-recorded batches**
 * to an injected transport. This module supplies the production transport:
 * an HTTP `POST` of the batch to a configurable endpoint, with:
 *
 * - **Retry with exponential backoff + jitter** for transient failures
 *   (network errors, request timeouts and retryable HTTP statuses). A batch
 *   is retried a bounded number of times and then dropped, so a down sink
 *   can never stall the game.
 * - **Offline short-circuit** — when the browser reports `offline`, the batch
 *   is dropped immediately instead of burning retries. This keeps the game
 *   completely unaffected by a missing network.
 * - **Never throws** — every failure is counted and swallowed, because the
 *   caller is the gameplay loop's flush path.
 *
 * All timing, randomness, networking and connectivity are injected, so the
 * retry/backoff policy is fully unit-testable without real timers or network
 * access.
 *
 * @module src/telemetry/transport
 */

import { TELEMETRY_SCHEMA_VERSION, type TelemetryRecord } from './schema';
import { type TelemetryTransport } from './sinks';

/** The minimal response surface the transport needs. */
export interface TelemetryFetchResponse {
  /** HTTP 2xx. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
}

/** The minimal `fetch` surface the transport needs, for injection in tests. */
export type TelemetryFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<TelemetryFetchResponse>;

/** Construction options for {@link HttpTelemetryTransport}. */
export interface HttpTelemetryTransportOptions {
  /** Absolute URL batches are POSTed to. */
  readonly endpoint: string;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: TelemetryFetch;
  /** Total attempts including the first (default {@link DEFAULT_MAX_ATTEMPTS}). */
  readonly maxAttempts?: number;
  /** First backoff delay in ms (default {@link DEFAULT_BASE_DELAY_MS}). */
  readonly baseDelayMs?: number;
  /** Backoff ceiling in ms (default {@link DEFAULT_MAX_DELAY_MS}). */
  readonly maxDelayMs?: number;
  /** Per-attempt request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}; `0` disables). */
  readonly timeoutMs?: number;
  /** Sleep implementation, for tests (defaults to a real `setTimeout`). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Random source for jitter (defaults to `Math.random`). */
  readonly random?: () => number;
  /** Connectivity probe (defaults to `navigator.onLine`; `true` when unknown). */
  readonly isOnline?: () => boolean;
  /** Extra request headers (e.g. an ingestion key). */
  readonly headers?: Record<string, string>;
}

/** A snapshot of a transport's counters, for diagnostics/tests. */
export interface TelemetryTransportStats {
  /** Batches offered to the transport. */
  readonly batches: number;
  /** Batches accepted by the endpoint. */
  readonly delivered: number;
  /** Batches dropped after exhausting retries or on a permanent failure. */
  readonly dropped: number;
  /** Batches skipped because the device was offline. */
  readonly skippedOffline: number;
  /** Batches that failed for a non-retryable reason (e.g. HTTP 4xx). */
  readonly rejected: number;
  /** Total HTTP attempts made across all batches. */
  readonly attempts: number;
  /** Retry attempts (beyond the first attempt of a batch). */
  readonly retries: number;
  /** Last observed HTTP status, or `null`. */
  readonly lastStatus: number | null;
}

/** Default total attempts (the first try plus two retries). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default first backoff delay. */
export const DEFAULT_BASE_DELAY_MS = 1_000;
/** Default backoff ceiling. */
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** Default per-attempt request timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** The JSON envelope POSTed to the endpoint. */
export interface TelemetryUploadBody {
  /** Envelope schema version, so the receiver can migrate/reject. */
  readonly schemaVersion: number;
  /** The batch of records. */
  readonly records: readonly TelemetryRecord[];
}

/**
 * True when an HTTP status is worth retrying: request timeout (408),
 * too-early (425), rate limit (429) and any 5xx. Other 4xx are permanent
 * (a malformed request will not succeed on retry) and are not retried.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * A concrete, retrying production transport (AC2).
 *
 * Implements the {@link TelemetryTransport} contract (a `(records) => void |
 * Promise<void>` function) via {@link send}. `send` never rejects.
 */
export class HttpTelemetryTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: TelemetryFetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;
  private readonly headers: Record<string, string>;

  private counters = {
    batches: 0,
    delivered: 0,
    dropped: 0,
    skippedOffline: 0,
    rejected: 0,
    attempts: 0,
    retries: 0,
    lastStatus: null as number | null,
  };

  constructor(options: HttpTelemetryTransportOptions) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.isOnline = options.isOnline ?? defaultIsOnline;
    this.headers = {
      'content-type': 'application/json',
      ...options.headers,
    };
  }

  /** A frozen snapshot of the transport's counters. */
  get stats(): TelemetryTransportStats {
    return Object.freeze({ ...this.counters });
  }

  /**
   * Uploads one batch, retrying transient failures with exponential backoff.
   * Resolves (never rejects) once the batch is delivered or dropped.
   *
   * @param records - The batch handed over by the recorder.
   */
  async send(records: readonly TelemetryRecord[]): Promise<void> {
    if (records.length === 0) return;
    this.counters.batches += 1;

    if (!this.isOnline()) {
      this.counters.skippedOffline += 1;
      this.counters.dropped += 1;
      return;
    }

    const body: TelemetryUploadBody = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      records,
    };
    const payload = JSON.stringify(body);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.counters.attempts += 1;
      const outcome = await this.attemptOnce(payload);
      if (outcome.kind === 'delivered') {
        this.counters.delivered += 1;
        return;
      }
      if (outcome.kind === 'rejected') {
        this.counters.rejected += 1;
        this.counters.dropped += 1;
        return;
      }
      // Transient failure: back off and retry while attempts remain.
      if (attempt < this.maxAttempts) {
        this.counters.retries += 1;
        await this.sleep(this.backoffDelay(attempt));
      }
    }

    this.counters.dropped += 1;
  }

  /** Performs one HTTP attempt, classifying the outcome. */
  private async attemptOnce(
    payload: string,
  ): Promise<{ kind: 'delivered' } | { kind: 'retryable' } | { kind: 'rejected' }> {
    const controller = this.timeoutMs > 0 ? new AbortController() : undefined;
    const timer =
      controller !== undefined
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : undefined;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: payload,
        signal: controller?.signal,
      });
      this.counters.lastStatus = response.status;
      if (response.ok) return { kind: 'delivered' };
      return isRetryableStatus(response.status)
        ? { kind: 'retryable' }
        : { kind: 'rejected' };
    } catch {
      // Network error / timeout — retryable.
      this.counters.lastStatus = null;
      return { kind: 'retryable' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Exponential backoff with additive jitter, capped at `maxDelayMs`. */
  private backoffDelay(attempt: number): number {
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    const jitter = this.baseDelayMs * this.random();
    return Math.min(this.maxDelayMs, exponential + jitter);
  }
}

/**
 * Builds a transport function for a configured endpoint, or `undefined` when
 * no endpoint is set (so the sink keeps its drop-and-count stub behaviour).
 *
 * @param endpoint - The configured endpoint, if any.
 * @param options - Transport tuning/injections.
 */
export function createHttpTransport(
  endpoint: string | undefined,
  options: Omit<HttpTelemetryTransportOptions, 'endpoint'> = {},
): TelemetryTransport | undefined {
  if (!endpoint) return undefined;
  const transport = new HttpTelemetryTransport({ endpoint, ...options });
  return (records) => transport.send(records);
}

/** Default `fetch` binding, guarded for environments without one. */
function defaultFetch(url: string, init: Parameters<TelemetryFetch>[1]): Promise<TelemetryFetchResponse> {
  if (typeof fetch !== 'function') {
    return Promise.reject(new Error('fetch is not available'));
  }
  return fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
}

/** Default sleep, using a real timer. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default connectivity probe: online unless the browser explicitly says otherwise. */
function defaultIsOnline(): boolean {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * Game-side dev telemetry uploader (AH-0MVBMRK6X0069QDI, parent
 * AH-0MVBHRLY8004BGDN).
 *
 * The game half of the dev-mode auto-upload flow: at run end the run's
 * in-memory telemetry buffer holds the recording (see `sinks.ts` /
 * `isDevTelemetryCollectionEnabled`), and this module delivers that content to
 * the dev server the page was served from. The server side — the Vite
 * `POST /api/telemetry/upload` middleware — is a separate child (F5).
 *
 * Design constraints, all pinned by `devUpload.test.ts`:
 *
 * - **Dev-only.** The decision goes through the single dev gate
 *   ({@link isDevTelemetryUploadEnabled}), so a production build or an
 *   opted-out setting is a strict no-op. This module never reads
 *   `import.meta.env.DEV` itself — `devModeEnforcement.test.ts` fails the
 *   suite if it does.
 * - **Fire-and-forget.** Every failure (no `fetch`, unreadable storage, empty
 *   sink, network error, non-2xx) is caught and reported through the optional
 *   {@link DevTelemetryUploadOptions.onError} seam. The promise always
 *   resolves — the run-end hook must never be blocked or crashed by an
 *   upload.
 * - **Sink content is canonical and read from memory.** The body is the dev
 *   JSONL sink's in-memory buffer content read through the injected
 *   {@link DevTelemetryUploadOptions.readSink} seam; nothing is cleared after
 *   a successful upload, so `npm run record` and the inspection tools keep
 *   working until the next run starts. Telemetry never touches `localStorage`
 *   (AH-0MVIRYGD1000JVY3, AC1).
 * - **Bounded.** The body is never posted above
 *   {@link DEFAULT_MAX_DEV_UPLOAD_BYTES} (8 MiB, configurable via
 *   `VITE_TELEMETRY_MAX_UPLOAD_BYTES` up to the server's 16 MiB bound):
 *   Playwright reads a request body as `request.postData` inside one
 *   `Network.requestWillBeSent` CDP message, so an unbounded body overflows
 *   the page→node pipe on long runs (AH-0MVNVGP55002G0KH). An over-cap buffer
 *   is skipped with one actionable line, never delivered.
 * - **Same-origin.** The endpoint is a relative path
 *   ({@link DEV_TELEMETRY_UPLOAD_ENDPOINT}), so the browser POSTs to the dev
 *   server that served the page and no CORS work is needed.
 *
 * Storage and `fetch` are injected seams, so the whole contract is
 * unit-testable without a network or a real browser.
 *
 * @module src/telemetry/devUpload
 */

import { parsePositiveInt } from './config';
import {
  isDevTelemetryUploadEnabled,
  type DevModeEnv,
  type DevTelemetrySetting,
} from './devMode';

/**
 * Same-origin endpoint the dev server exposes for game-side uploads
 * (the F5 middleware registers it for `apply: 'serve'` only).
 */
export const DEV_TELEMETRY_UPLOAD_ENDPOINT = '/api/telemetry/upload';

/**
 * Body content type: the payload is the local sink's newline-delimited JSON,
 * so the server can validate it with the existing recording reader.
 */
export const DEV_TELEMETRY_UPLOAD_CONTENT_TYPE = 'application/x-ndjson';

/**
 * Default cap on the **CDP message** one run-end upload may produce
 * (8 MiB, AH-0MVNVGP55002G0KH).
 *
 * The bound exists because of **how the body reaches the dev server**, not
 * because of what the server accepts: Playwright reports the request body as
 * `request.postData` inside a single `Network.requestWillBeSent` CDP message,
 * so the run's telemetry becomes one page→node message. Playwright's pipe
 * transport concatenates every pending buffer into one string, and V8 caps a
 * string at 512 MiB (`ERR_STRING_TOO_LONG`) — a long enough run therefore
 * killed the capture process mid-recording. The server's own 16 MiB `413`
 * (`DEFAULT_MAX_UPLOAD_BYTES` in `vite/plugins/telemetryUploadPlugin.ts`)
 * cannot help, because the overflow happens when the request is *sent*, before
 * any response exists.
 *
 * The cap is metered on the **escaped message body**, not on the raw telemetry
 * size: the CDP message embeds the body as a JSON string, so it is inflated by
 * JSON escaping (measured 2.4× on real runs — a 4.0 MiB body produced a
 * 9.7 MiB message). {@link devUploadMessageBytes} computes that size exactly
 * and {@link uploadDevTelemetry} skips an over-cap upload with one actionable
 * line instead of posting it. 8 MiB is well under the server bound and orders
 * of magnitude under the pipe's limit, while normal-length dev runs stay far
 * below it (a 46 s demo run measured 0.67 MiB of telemetry).
 */
export const DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Hard ceiling for a configured cap (16 MiB).
 *
 * Matches the dev server's own body bound, so a configured cap can never
 * promise more than the server would accept. `resolveDevUploadMaxMessageBytes`
 * clamps to this value, so configuring a bigger cap can never resurrect the
 * overflow (a 512 MiB message needs a 512 MiB+ cap, which the ceiling makes
 * unreachable).
 */
export const MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING = 16 * 1024 * 1024;

/**
 * Allowance for the CDP envelope around the escaped body (method, params,
 * request headers, URL) so the metered value covers the whole message.
 */
export const DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/**
 * Environment slice that can override the cap (a `VITE_*` variable, so a
 * capture or `npm run dev` can configure it).
 */
export interface DevUploadCapEnv {
  /** Cap in bytes; positive integer, clamped to {@link MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING}. */
  readonly VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES?: string;
}

/** Reported when a buffer is too large to upload (see `onSkip`). */
export interface DevUploadSkip {
  /** Size of the run's telemetry buffer, in UTF-8 bytes. */
  readonly bytes: number;
  /**
   * Size of the CDP message it would have produced, in bytes (a lower bound
   * when the raw body alone already exceeds the cap).
   */
  readonly messageBytes: number;
  /** The cap `messageBytes` was measured against. */
  readonly maxMessageBytes: number;
}

/** The minimal response surface the uploader needs. */
export interface DevUploadFetchResponse {
  /** HTTP 2xx. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
}

/** The minimal `fetch` surface the uploader needs, for injection in tests. */
export type DevUploadFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<DevUploadFetchResponse>;

/** Injected dependencies for {@link uploadDevTelemetry}. */
export interface DevTelemetryUploadOptions {
  /** Build environment slice; defaults to `import.meta.env`. */
  readonly env?: DevModeEnv & DevUploadCapEnv;
  /** Persisted settings slice carrying the share-telemetry flag. */
  readonly setting?: DevTelemetrySetting;
  /**
   * Reads the current run's buffered NDJSON content (the recorder's in-memory
   * `readBuffer()`); returns `null`/empty when nothing is buffered. Required:
   * there is no storage default any more (AC1).
   */
  readonly readSink: () => string | null;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: DevUploadFetch;
  /** Upload endpoint; defaults to {@link DEV_TELEMETRY_UPLOAD_ENDPOINT}. */
  readonly endpoint?: string;
  /**
   * Maximum CDP message size in bytes; defaults to the environment's
   * `VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES`, itself falling back to
   * {@link DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES}. A buffer whose escaped upload
   * message would exceed it is never posted.
   */
  readonly maxMessageBytes?: number;
  /** Failure reporter (never throws to the caller); silent by default. */
  readonly onError?: (error: unknown) => void;
  /** Over-cap reporter; defaults to one `console.warn` line. */
  readonly onSkip?: (skip: DevUploadSkip) => void;
}

/**
 * Uploads the accumulated local JSONL sink to the dev server, fire-and-forget.
 *
 * A no-op when the dev gate is closed (non-dev build or the share-telemetry
 * setting off) or when the sink is empty. Otherwise POSTs the sink content
 * verbatim to {@link DEV_TELEMETRY_UPLOAD_ENDPOINT} and resolves `true` on a
 * 2xx. Every failure resolves `false` — this function never rejects and never
 * throws synchronously.
 *
 * A body whose upload message would exceed the configured cap is **skipped**,
 * never posted: the run-end request would otherwise reach Playwright as one
 * CDP message whose size grows with the run, and a long enough run kills the
 * capture process (AH-0MVNVGP55002G0KH). Skipping is reported once through
 * {@link DevTelemetryUploadOptions.onSkip} and resolves `false`.
 *
 * @param options - Gate inputs and injected seams (all optional).
 * @returns `true` only when the dev server accepted the upload.
 */
export async function uploadDevTelemetry(
  options: DevTelemetryUploadOptions,
): Promise<boolean> {
  const { env = import.meta.env, setting, readSink, fetchImpl, onError, onSkip } = options;
  if (!isDevTelemetryUploadEnabled(env, setting)) return false;

  try {
    const body = readSink();
    if (body === null || body.trim().length === 0) return false;

    const maxMessageBytes =
      options.maxMessageBytes ??
      resolveDevUploadMaxMessageBytes(env.VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES);
    const bytes = utf8ByteLength(body);
    // Cheap first pass: escaping only ever grows the payload, so a raw body
    // larger than the whole budget is already over it (and never needs the
    // escaping allocation below) — `bytes` is then a lower bound on the message.
    const messageBytes = bytes > maxMessageBytes ? bytes : devUploadMessageBytes(body);
    if (messageBytes > maxMessageBytes) {
      (onSkip ?? reportSkip)({ bytes, messageBytes, maxMessageBytes });
      return false;
    }

    const post = fetchImpl ?? resolveFetch();
    if (!post) return false;

    const response = await post(options.endpoint ?? DEV_TELEMETRY_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': DEV_TELEMETRY_UPLOAD_CONTENT_TYPE },
      body,
    });
    // A non-2xx is the dev server's problem: swallow it so run end is unaffected.
    return response.ok === true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

/**
 * Resolves the cap from a raw `VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES` value:
 * a positive integer is honoured, anything else falls back to
 * {@link DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES}; the result is clamped to
 * {@link MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING}.
 *
 * Takes the raw value (not an env object) so it is usable from the uploader's
 * injected `env` seam, where the cap variable is one of many Vite keys.
 *
 * @param raw - The configured value, if any.
 */
export function resolveDevUploadMaxMessageBytes(raw?: string): number {
  const configured = parsePositiveInt(raw, DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES);
  return Math.min(configured, MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING);
}

/**
 * Size of the CDP message an upload of `body` produces, in UTF-8 bytes.
 *
 * Playwright embeds the request body in `Network.requestWillBeSent` as the
 * JSON string `postData`, so the message carries the body **escaped**
 * (`JSON.stringify`) plus the surrounding envelope, accounted for with
 * {@link DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES}. Measuring the escaped form is
 * what makes the cap a bound on the message rather than on the raw telemetry:
 * real NDJSON inflates by ~2.4×.
 *
 * @param body - The upload body.
 */
export function devUploadMessageBytes(body: string): number {
  return utf8ByteLength(JSON.stringify(body)) + DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES;
}

/** Size of a string in UTF-8 bytes (the unit the cap is expressed in). */
function utf8ByteLength(text: string): number {
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
}

/** One actionable line for a skipped upload (the default `onSkip`). */
function reportSkip({ bytes, maxMessageBytes }: DevUploadSkip): void {
  const formatBytes = (value: number): string =>
    value >= 1024 * 1024
      ? `${(value / (1024 * 1024)).toFixed(1)} MiB (${value} bytes)`
      : `${value} bytes`;
  console.warn(
    `[telemetry] run-end upload skipped: ${formatBytes(bytes)} of run telemetry ` +
      `needs a browser→node message over the ${formatBytes(maxMessageBytes)} ` +
      `upload cap. Set VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES to raise the cap ` +
      `(max ${formatBytes(MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING)}) or record shorter runs.`,
  );
}

/** Resolves the global `fetch`, or `undefined` when the environment lacks one. */
function resolveFetch(): DevUploadFetch | undefined {
  return typeof globalThis.fetch === 'function'
    ? (url, init) => globalThis.fetch(url, init)
    : undefined;
}

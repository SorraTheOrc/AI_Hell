/**
 * Game-side dev telemetry uploader (AH-0MVBMRK6X0069QDI, parent
 * AH-0MVBHRLY8004BGDN).
 *
 * The game half of the dev-mode auto-upload flow: at run end the local JSONL
 * sink already holds the run's recording (see `sinks.ts` /
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
 * - **Sink content is canonical and left intact.** The body is the
 *   `ai_hell_telemetry_jsonl` localStorage content exactly as written;
 *   nothing is cleared after a successful upload, so `npm run record` and the
 *   inspection tools keep working.
 * - **Same-origin.** The endpoint is a relative path
 *   ({@link DEV_TELEMETRY_UPLOAD_ENDPOINT}), so the browser POSTs to the dev
 *   server that served the page and no CORS work is needed.
 *
 * Storage and `fetch` are injected seams, so the whole contract is
 * unit-testable without a network or a real browser.
 *
 * @module src/telemetry/devUpload
 */

import {
  isDevTelemetryUploadEnabled,
  type DevModeEnv,
  type DevTelemetrySetting,
} from './devMode';
import { TELEMETRY_JSONL_STORAGE_KEY } from './sinks';

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
  readonly env?: DevModeEnv;
  /** Persisted settings slice carrying the share-telemetry flag. */
  readonly setting?: DevTelemetrySetting;
  /** Reads the accumulated local JSONL sink content; defaults to `localStorage`. */
  readonly readSink?: () => string | null;
  /** `fetch` implementation; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: DevUploadFetch;
  /** Upload endpoint; defaults to {@link DEV_TELEMETRY_UPLOAD_ENDPOINT}. */
  readonly endpoint?: string;
  /** Failure reporter (never throws to the caller); silent by default. */
  readonly onError?: (error: unknown) => void;
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
 * @param options - Gate inputs and injected seams (all optional).
 * @returns `true` only when the dev server accepted the upload.
 */
export async function uploadDevTelemetry(
  options: DevTelemetryUploadOptions = {},
): Promise<boolean> {
  const { env = import.meta.env, setting, fetchImpl, onError } = options;
  if (!isDevTelemetryUploadEnabled(env, setting)) return false;

  try {
    const readSink = options.readSink ?? readLocalSink;
    const body = readSink();
    if (body === null || body.trim().length === 0) return false;

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

/** Reads the local JSONL sink content, or `null` when storage is unavailable. */
function readLocalSink(): string | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage.getItem(TELEMETRY_JSONL_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Resolves the global `fetch`, or `undefined` when the environment lacks one. */
function resolveFetch(): DevUploadFetch | undefined {
  return typeof globalThis.fetch === 'function'
    ? (url, init) => globalThis.fetch(url, init)
    : undefined;
}

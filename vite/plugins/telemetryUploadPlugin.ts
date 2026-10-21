/**
 * Dev-only telemetry upload middleware (AH-0MVBMRNAH001B8X4 — parent
 * AH-0MVBHRLY8004BGDN).
 *
 * The server half of the dev-mode auto-upload flow: the game's
 * `src/telemetry/devUpload.ts` uploader POSTs the local JSONL sink's content
 * to this endpoint at run end, and this middleware validates it against the
 * existing recording reader (`scripts/recording.mjs`) and stores it under
 * `recordings/session-<timestamp>.jsonl` — mirroring the `configCsvPlugin`
 * pattern and the `record-session.mjs` naming.
 *
 * The plugin is registered only while Vite runs in dev mode
 * (`apply: 'serve'`), so the endpoint never exists for `vite build` /
 * `vite preview` (enforced by `src/telemetry/devModeEnforcement.test.ts`
 * AC3c and the bundle-hygiene gate).
 *
 * ## Handling rules (pinned by `telemetryUploadPlugin.test.ts`)
 *
 * - `POST /api/telemetry/upload` with a JSONL body that contains **at least
 *   one schema-valid telemetry record** (via `parseRecording`) is stored
 *   verbatim and confirmed with a 2xx JSON payload carrying the stored path,
 *   the record count and the run count.
 * - Malformed bodies — unparseable JSONL, unsupported schema versions,
 *   unknown record kinds, or zero schema-valid records — are rejected with a
 *   4xx **before** anything is written, so a rejected upload never touches
 *   `recordings/`.
 * - Bodies larger than {@link DEFAULT_MAX_UPLOAD_BYTES} are rejected with
 *   413 before parsing or writing, whether the size is declared in
 *   `Content-Length` or discovered while streaming the request body.
 * - File names are collision-safe: an upload never overwrites an existing
 *   file; when the timestamped name is occupied a numeric suffix is used.
 *
 * @module vite/plugins/telemetryUploadPlugin
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

import {
  SUPPORTED_TELEMETRY_SCHEMA_VERSIONS,
  parseRecording,
} from '../../scripts/recording.mjs';

/** Endpoint the game-side uploader posts to (`src/telemetry/devUpload.ts`). */
export const TELEMETRY_UPLOAD_PATH = '/api/telemetry/upload';

/** Directory (under the plugin root) recordings are stored in. */
export const RECORDINGS_DIR = 'recordings';

/** Upper bound for an accepted upload body. 16 MiB covers the multi-megabyte
 * local sink content a long dev session accumulates; larger payloads are
 * almost certainly not the real sink and are rejected before parsing. */
export const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Collision-safety attempts before giving up on a unique file name. */
const MAX_NAME_ATTEMPTS = 100;

export interface TelemetryUploadPluginOptions {
  /** Project root the `recordings/` directory resolves against.
   * Defaults to `process.cwd()`. */
  root?: string;
  /** Maximum accepted request body size in bytes
   * (defaults to {@link DEFAULT_MAX_UPLOAD_BYTES}). */
  maxBytes?: number;
}

export type TelemetryUploadValidation =
  | {
      readonly ok: true;
      readonly recordCount: number;
      readonly runCount: number;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validates an upload body against the recording reader's semantics.
 *
 * The body must contain at least one schema-valid telemetry record
 * (a supported `schemaVersion` and a known record kind per
 * `scripts/recording.mjs`). Any unparseable line, unsupported schema
 * version, or unrecognised record kind also rejects the whole body: a
 * malformed upload is never stored. The validator is a pure function of the
 * text, so it is directly unit-testable.
 *
 * @param text - The uploaded JSONL body.
 * @returns record count (per-line valid records) and run count when valid,
 *   or the human-readable errors when rejected.
 */
export function validateTelemetryUpload(text: string): TelemetryUploadValidation {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['Upload body is empty'] };
  }
  const parsed = parseRecording(text);
  const errors: string[] = [];
  const unsupportedVersions = parsed.schemaVersions.filter(
    (version) => !SUPPORTED_TELEMETRY_SCHEMA_VERSIONS.includes(version),
  );
  if (unsupportedVersions.length > 0) {
    errors.push(
      `Unsupported telemetry schema version(s): ${unsupportedVersions.join(
        ', ',
      )}`,
    );
  }
  if (parsed.skippedLines > 0) {
    errors.push(`${parsed.skippedLines} line(s) were not valid JSON`);
  }
  if (parsed.unsupportedLines > 0) {
    errors.push(
      `${parsed.unsupportedLines} line(s) were not supported telemetry records`,
    );
  }
  if (parsed.recordCount === 0) {
    errors.push('No schema-valid telemetry records found');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, recordCount: parsed.recordCount, runCount: parsed.runs.length };
}

export type RequestBodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly bytes: number };

/**
 * Reads a request body, rejecting it (413) as soon as it exceeds `maxBytes`.
 *
 * A `Content-Length` header larger than the bound fails immediately without
 * buffering; a streaming body that grows past the bound mid-flight fails the
 * moment the limit is crossed. The result is a discriminated union so the
 * caller can distinguish a rejected size from a readable body without
 * exceptions.
 *
 * @param req - The HTTP request whose body is being read.
 * @param maxBytes - The size limit in bytes.
 */
export function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<RequestBodyResult> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Give the client somewhere to write; the response is sent immediately.
      req.resume();
      resolve({ ok: false, bytes: declared });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: RequestBodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish({ ok: false, bytes });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** Allocates the next free `session-<stamp>.jsonl` name (collision-safe). */
function storeRecording(recordingsDir: string, body: string): string {
  mkdirSync(recordingsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const fileName =
      attempt === 1
        ? `session-${stamp}.jsonl`
        : `session-${stamp}-${attempt}.jsonl`;
    try {
      // `wx` fails if the name is taken, so a concurrent upload can never
      // overwrite an existing recording.
      writeFileSync(join(recordingsDir, fileName), body, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return fileName;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(
    `Could not allocate a unique recording file name in ${recordingsDir}`,
  );
}

function handleUpload(
  root: string,
  maxBytes: number,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  readRequestBody(req, maxBytes)
    .then((result) => {
      if (!result.ok) {
        sendJson(res, 413, {
          ok: false,
          errors: [`Upload too large: ${result.bytes} bytes (max ${maxBytes} bytes)`],
        });
        return;
      }
      const validation = validateTelemetryUpload(result.body);
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, errors: validation.errors });
        return;
      }
      const recordingsDir = join(root, RECORDINGS_DIR);
      const fileName = storeRecording(recordingsDir, result.body);
      sendJson(res, 200, {
        ok: true,
        storedPath: `${RECORDINGS_DIR}/${fileName}`,
        recordCount: validation.recordCount,
        runCount: validation.runCount,
      });
    })
    .catch((err: unknown) => {
      sendJson(res, 500, {
        ok: false,
        errors: [
          err instanceof Error ? err.message : 'Upload request failed',
        ],
      });
    });
}

function isDevServer(server: ViteDevServer): boolean {
  const command = server.config?.command;
  if (command && command !== 'serve') return false;
  const mode = server.config?.mode;
  if (mode === 'production') return false;
  return true;
}

/**
 * Create the dev-only telemetry upload plugin.
 *
 * @param options.root — project root (defaults to `process.cwd()`).
 * @param options.maxBytes — upload body size limit
 *   (defaults to {@link DEFAULT_MAX_UPLOAD_BYTES}).
 */
export function telemetryUploadPlugin(
  options: TelemetryUploadPluginOptions = {},
): Plugin {
  const root = options.root ?? process.cwd();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  return {
    name: 'ai-hell:telemetry-upload',
    // Only applies to the dev server (`vite`), never `vite build` — the
    // endpoint must be unreachable outside dev mode.
    apply: 'serve',
    configureServer(server) {
      if (!isDevServer(server)) return;
      server.middlewares.use((req, res, next) => {
        const [path] = (req.url ?? '').split('?');
        if (path !== TELEMETRY_UPLOAD_PATH) {
          next();
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, {
            ok: false,
            errors: [`Method not allowed: ${req.method}`],
          });
          return;
        }
        handleUpload(root, maxBytes, req, res);
      });
    },
  };
}

export default telemetryUploadPlugin;

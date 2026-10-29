/**
 * Dev-only bot-tuning write-back plugin (AH-0MVBJ0DUI009B6AM).
 *
 * The server half of the Bot Tuning gym's **Save to repo** action: the gym's
 * store (`src/core/botTuningStore.ts`) PUTs its current state blob here and
 * this middleware writes it to the Git-tracked baseline
 * `src/data/bot-tuning.json`. It mirrors the established
 * `configCsvPlugin` pattern exactly — `apply: 'serve'` only, a one-entry
 * allowed-path allowlist, validation **before** any file access, and an
 * atomic write (temp file + rename, reusing `configCsvPlugin`'s
 * {@link atomicWrite}).
 *
 * ## Endpoints (dev server only)
 *
 * - `GET /api/bot-tuning/src/data/bot-tuning.json` → the committed baseline
 *   (JSON text), so a designer can inspect what ships.
 * - `PUT /api/bot-tuning/src/data/bot-tuning.json` → validate the blob with
 *   the shared schema (`validateBotTuningStateBlob`) and atomically replace
 *   the file with its canonical serialisation — pretty-printed JSON plus the
 *   trailing newline the committed file's tests pin. An invalid blob is
 *   rejected with 400 and the committed file is left byte-identical.
 *
 * The plugin is registered only while Vite runs in dev mode, so `vite build`
 * / `vite preview` never expose a write path to the shipped baseline
 * (AC3). Pinned by `botTuningPlugin.test.ts`.
 *
 * @module vite/plugins/botTuningPlugin
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

import { atomicWrite } from './configCsvPlugin';
import {
  BOT_TUNING_API_PREFIX,
  BOT_TUNING_FILE_PATH,
  serialiseBotTuningFile,
  validateBotTuningStateBlob,
} from '../../src/core/botTuningSchema';

/** Files the plugin is permitted to read or write. */
export const ALLOWED_BOT_TUNING_FILES = [BOT_TUNING_FILE_PATH] as const;

/** Endpoint prefix, re-exported for tests and documentation. */
export { BOT_TUNING_API_PREFIX };

export interface BotTuningPluginOptions {
  /** Project root the baseline path resolves against. Defaults to `process.cwd()`. */
  root?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function isAllowedPath(relPath: string): boolean {
  return (ALLOWED_BOT_TUNING_FILES as readonly string[]).includes(relPath);
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── Request handlers ────────────────────────────────────────────────

function handleGet(root: string, res: ServerResponse, relPath: string): void {
  const filePath = resolve(root, relPath);
  try {
    const body = readFileSync(filePath, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      errors: [err instanceof Error ? err.message : 'Read failed'],
    });
  }
}

function handlePut(
  root: string,
  res: ServerResponse,
  relPath: string,
  body: string,
): void {
  const filePath = resolve(root, relPath);
  // Never create the baseline: the dev write-back refreshes the committed
  // file, it does not bootstrap a missing checkout.
  if (!existsSync(filePath)) {
    sendJson(res, 404, { ok: false, errors: [`Not found: ${relPath}`] });
    return;
  }

  const validation = validateBotTuningStateBlob(body);
  if (!validation.ok) {
    // Rejected before any file access: the committed baseline is untouched.
    sendJson(res, 400, { ok: false, errors: validation.errors });
    return;
  }

  try {
    const state = validation.state;
    atomicWrite(filePath, serialiseBotTuningFile(state));
    sendJson(res, 200, {
      ok: true,
      path: relPath,
      current: state.current,
      configCount: state.configs.length,
    });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      errors: [err instanceof Error ? err.message : 'Write failed'],
    });
  }
}

// ── Plugin factory ──────────────────────────────────────────────────

function isDevServer(server: ViteDevServer): boolean {
  const command = server.config?.command;
  if (command && command !== 'serve') return false;
  const mode = server.config?.mode;
  if (mode === 'production') return false;
  return true;
}

/**
 * Create the dev-only bot-tuning write-back plugin.
 *
 * @param options.root — project root (defaults to `process.cwd()`).
 */
export function botTuningPlugin(options: BotTuningPluginOptions = {}): Plugin {
  const root = options.root ?? process.cwd();

  return {
    name: 'ai-hell:bot-tuning',
    // Only applies to the dev server (`vite`), never `vite build`.
    apply: 'serve',
    configureServer(server) {
      if (!isDevServer(server)) return;
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith(BOT_TUNING_API_PREFIX)) {
          next();
          return;
        }

        const [requestPath] = rawUrl.split('?');
        const relPath = decodeURIComponent(
          requestPath.slice(BOT_TUNING_API_PREFIX.length),
        );
        if (!isAllowedPath(relPath)) {
          sendJson(res, 404, { ok: false, errors: [`Not found: ${relPath}`] });
          return;
        }

        if (req.method === 'GET') {
          handleGet(root, res, relPath);
          return;
        }
        if (req.method === 'PUT') {
          readBody(req)
            .then((body) => handlePut(root, res, relPath, body))
            .catch((err: unknown) => {
              sendJson(res, 500, {
                ok: false,
                errors: [err instanceof Error ? err.message : 'Request failed'],
              });
            });
          return;
        }

        sendJson(res, 405, {
          ok: false,
          errors: [`Method not allowed: ${req.method}`],
        });
      });
    },
  };
}

export default botTuningPlugin;

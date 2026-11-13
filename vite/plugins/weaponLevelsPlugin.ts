/**
 * Dev-only weapon-levels write-back plugin (AH-0MW0WLZ9600693R9).
 *
 * The server half of the weapon-tuning panel's **Save** for the Euclidean
 * rhythm ladder: the panel's store (`src/core/weaponLevelsStore.ts`) PUTs a
 * single weapon's rung list here and this middleware merges it into the
 * Git-tracked `src/data/weapon-levels.json`. It mirrors the established
 * `botTuningPlugin` / `configCsvPlugin` pattern exactly — `apply: 'serve'`
 * only, a one-entry allowed-path allowlist, validation **before** any file
 * access, and an atomic write (temp file + rename, reusing `configCsvPlugin`'s
 * `atomicWrite`).
 *
 * ## Endpoints (dev server only)
 *
 * - `GET /api/weapon-levels/src/data/weapon-levels.json` → the committed file
 *   (JSON text), so the store can re-read it after a successful Save.
 * - `PUT /api/weapon-levels/src/data/weapon-levels.json` with body
 *   `{ weaponId, rungs }` → validate the payload, merge the rung list into the
 *   committed file, re-validate the merged record with the shared
 *   `parseWeaponLevels`, and atomically replace the file with its canonical
 *   serialisation (pretty JSON + trailing newline). Any invalid payload is
 *   rejected with 400 and the committed file is left byte-identical.
 *
 * The plugin is registered only while Vite runs in dev mode, so `vite build`
 * / `vite preview` never expose a write path to the shipped data. Pinned by
 * `weaponLevelsPlugin.test.ts`.
 *
 * @module vite/plugins/weaponLevelsPlugin
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

import { atomicWrite } from './configCsvPlugin';
import {
  WEAPON_LEVELS_API_PREFIX,
  WEAPON_LEVELS_FILE_PATH,
  mergeWeaponLevelsRecord,
  parseWeaponLevels,
  serialiseWeaponLevelsFile,
  validateWeaponLevelsWriteBlob,
} from '../../src/core/weaponLevelsSchema';

/** Files the plugin is permitted to read or write. */
export const ALLOWED_WEAPON_LEVELS_FILES = [WEAPON_LEVELS_FILE_PATH] as const;

/** Endpoint prefix, re-exported for tests and documentation. */
export { WEAPON_LEVELS_API_PREFIX };

export interface WeaponLevelsPluginOptions {
  /** Project root the data path resolves against. Defaults to `process.cwd()`. */
  root?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function isAllowedPath(relPath: string): boolean {
  return (ALLOWED_WEAPON_LEVELS_FILES as readonly string[]).includes(relPath);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
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
  // Validate the incoming payload before any file access: a rejected payload
  // must leave the committed file byte-identical.
  const validation = validateWeaponLevelsWriteBlob(body);
  if (!validation.ok) {
    sendJson(res, 400, { ok: false, errors: validation.errors });
    return;
  }

  const filePath = resolve(root, relPath);
  // Never create the data file: the dev write-back refreshes the committed
  // file, it does not bootstrap a missing checkout.
  if (!existsSync(filePath)) {
    sendJson(res, 404, { ok: false, errors: [`Not found: ${relPath}`] });
    return;
  }

  const { weaponId, rungs } = validation.payload;
  try {
    const committed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (
      typeof committed !== 'object' ||
      committed === null ||
      Array.isArray(committed)
    ) {
      sendJson(res, 400, {
        ok: false,
        errors: [`${relPath}: expected an object keyed by weapon id`],
      });
      return;
    }

    const merged = mergeWeaponLevelsRecord(
      committed as Record<string, unknown>,
      weaponId,
      rungs,
    );
    const serialised = serialiseWeaponLevelsFile(merged);

    // Re-validate the whole merged file with the shared parser (belt and
    // braces): a decreasing-density ladder or an unknown id is rejected here
    // rather than written.
    const revalidation = parseWeaponLevels(serialised);
    if (revalidation.errors.length > 0) {
      sendJson(res, 400, { ok: false, errors: revalidation.errors });
      return;
    }

    atomicWrite(filePath, serialised);
    sendJson(res, 200, {
      ok: true,
      weaponId,
      rungCount: rungs.length,
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
 * Create the dev-only weapon-levels write-back plugin.
 *
 * @param options.root — project root (defaults to `process.cwd()`).
 */
export function weaponLevelsPlugin(
  options: WeaponLevelsPluginOptions = {},
): Plugin {
  const root = options.root ?? process.cwd();

  return {
    name: 'ai-hell:weapon-levels',
    // Only applies to the dev server (`vite`), never `vite build`.
    apply: 'serve',
    configureServer(server) {
      if (!isDevServer(server)) return;
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith(WEAPON_LEVELS_API_PREFIX)) {
          next();
          return;
        }

        const [requestPath] = rawUrl.split('?');
        const relPath = decodeURIComponent(
          requestPath.slice(WEAPON_LEVELS_API_PREFIX.length),
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

export default weaponLevelsPlugin;

/**
 * Vite CSV config plugin (AH-0MTZWZ9TE009CVUA — task AH-0MUE2MHRC0090AXP).
 *
 * Dev-only middleware that exposes read/write endpoints for the committed
 * configuration CSV files under `src/data/`:
 *
 *   GET  /api/csv/src/data/enemy-configs.csv   → file contents (text/csv)
 *   PUT  /api/csv/src/data/enemy-configs.csv   → upsert the supplied row
 *   PUT  ...?mode=append                       → append (409 on duplicate key)
 *
 * Writes are validated with the CSV codec and committed atomically
 * (temp file + rename) so an interrupted write never corrupts the
 * committed CSV. The plugin is registered only while Vite runs in dev
 * mode (`apply: 'serve'`).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

import {
  parseCsvRows,
  coerceEnemyConfig,
  coerceShipConfig,
  serializeEnemyConfigs,
  serializeShipConfigs,
  validateEnemyConfig,
  validateShipConfig,
} from '../../src/core/csv';
import { DEFAULT_ENEMY_CONFIGS, DEFAULT_CONFIG } from '../../src/core/configDefaults';
import type { EnemyConfig } from '../../src/core/configTypes';

/** Prefix under which the plugin serves its endpoints. */
export const CSV_API_PREFIX = '/api/csv/';

/** Files the plugin is permitted to read or write. */
export const ALLOWED_CSV_FILES = [
  'src/data/enemy-configs.csv',
  'src/data/ship-config.csv',
] as const;

export interface ConfigCsvPluginOptions {
  /** Project root the CSV paths resolve against. Defaults to `process.cwd()`. */
  root?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

function isAllowedPath(relPath: string): boolean {
  return (ALLOWED_CSV_FILES as readonly string[]).includes(relPath);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(body);
}

function sendCsv(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
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

/** Write `content` to `filePath` atomically (temp file + rename). */
export function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp_${filePath.split(sep).pop()}`);
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Preserve the original file; drop the partial temp file.
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
}

// ── Request handlers ────────────────────────────────────────────────

interface ParsedUrl {
  path: string;
  query: URLSearchParams;
}

function parseUrl(rawUrl: string): ParsedUrl {
  const [path, queryString = ''] = rawUrl.split('?');
  return { path, query: new URLSearchParams(queryString) };
}

function handleGet(
  root: string,
  res: ServerResponse,
  relPath: string,
): void {
  if (!isAllowedPath(relPath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }
  const filePath = resolve(root, relPath);
  if (!existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }
  try {
    const body = readFileSync(filePath, 'utf8');
    sendCsv(res, 200, body);
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : 'Read failed',
    });
  }
}

function handlePut(
  root: string,
  res: ServerResponse,
  relPath: string,
  query: URLSearchParams,
  body: string,
): void {
  if (!isAllowedPath(relPath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }

  const filePath = resolve(root, relPath);
  if (!existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }

  const mode = query.get('mode') === 'append' ? 'append' : 'upsert';
  const incomingRows = parseCsvRows(body);
  if (incomingRows.length === 0) {
    sendJson(res, 400, { ok: false, errors: ['Request body contained no CSV rows'] });
    return;
  }
  // Validate every incoming row against the target schema before touching
  // the file. The store PUTs the full CSV, so all rows are checked.
  const isShip = relPath.endsWith('ship-config.csv');
  for (const incoming of incomingRows) {
    const validation = isShip
      ? validateShipConfig(incoming, DEFAULT_CONFIG)
      : validateEnemyConfig(incoming, DEFAULT_ENEMY_CONFIGS);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, errors: validation.errors });
      return;
    }
  }

  // Read + parse the existing file.
  const existingText = readFileSync(filePath, 'utf8');
  const existingRows = parseCsvRows(existingText);

  if (isShip) {
    const ship = coerceShipConfig(incomingRows[0], DEFAULT_CONFIG);
    atomicWrite(filePath, serializeShipConfigs([ship]));
    sendJson(res, 200, { ok: true, mode: 'upsert', row: ship });
    return;
  }

  // In append mode (Save As), reject any incoming key that already exists.
  if (mode === 'append') {
    for (const incoming of incomingRows) {
      const exists = existingRows.some((row) => row.key === incoming.key);
      if (exists) {
        sendJson(res, 409, {
          ok: false,
          error: `Duplicate key: "${incoming.key}" already exists`,
        });
        return;
      }
    }
  }

  // Enemy config: upsert each incoming row by key, preserving other rows.
  const enemies: EnemyConfig[] = existingRows.map((row) =>
    coerceEnemyConfig(row, DEFAULT_ENEMY_CONFIGS),
  );
  let status = 200;
  let resultMode: 'upsert' | 'append' = 'upsert';
  let lastRow: EnemyConfig | null = null;

  for (const incoming of incomingRows) {
    const coerced = coerceEnemyConfig(incoming, DEFAULT_ENEMY_CONFIGS);
    const index = enemies.findIndex((e) => e.key === coerced.key);
    if (index === -1) {
      enemies.push(coerced);
      status = 201;
      resultMode = 'append';
    } else {
      enemies[index] = coerced;
    }
    lastRow = coerced;
  }

  atomicWrite(filePath, serializeEnemyConfigs(enemies));
  sendJson(res, status, { ok: true, mode: resultMode, row: lastRow });
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
 * Create the dev-only CSV config plugin.
 *
 * @param options.root — project root (defaults to `process.cwd()`).
 */
export function configCsvPlugin(options: ConfigCsvPluginOptions = {}): Plugin {
  const root = options.root ?? process.cwd();

  return {
    name: 'ai-hell:config-csv',
    // Only applies to the dev server (`vite`), never `vite build`.
    apply: 'serve',
    configureServer(server) {
      if (!isDevServer(server)) return;
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '';
        if (!rawUrl.startsWith(CSV_API_PREFIX)) {
          next();
          return;
        }

        const { path: requestPath, query } = parseUrl(rawUrl);
        const relPath = decodeURIComponent(requestPath.slice(CSV_API_PREFIX.length));

        if (req.method === 'GET') {
          handleGet(root, res, relPath);
          return;
        }
        if (req.method === 'PUT') {
          readBody(req)
            .then((body) => handlePut(root, res, relPath, query, body))
            .catch((err: unknown) => {
              sendJson(res, 500, {
                ok: false,
                error: err instanceof Error ? err.message : 'Request failed',
              });
            });
          return;
        }

        sendJson(res, 405, { ok: false, error: `Method not allowed: ${req.method}` });
      });
    },
  };
}

export default configCsvPlugin;

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
 * The weapon-catalogue files (`src/data/weapons.csv` +
 * `src/data/weapon-patterns.csv`) get the same read endpoint and a
 * **row-preserving** write (AH-0MW0Q1GMK005HOF0): only the rows named in the
 * request body change, so the `#` schema/comment block and every untouched
 * row stay byte-identical. A weapon save is validated twice before it is
 * committed — per row (`validateWeaponRow`, the scalar/enum/descriptor
 * checks) and across the merged catalogue (`validateWeaponCatalogue`, the
 * runtime roster guards: on-beat fire rate, unique colour, unique canonical
 * bullet-shape family) — and a rejected save leaves the file untouched.
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
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

import {
  parseCsvRows,
  coerceEnemyConfig,
  coerceShipConfig,
  coerceDifficultyCurveRow,
  serializeEnemyConfigs,
  serializeShipConfigs,
  serializeDifficultyCurves,
  serializeCsvLine,
  validateEnemyConfig,
  validateShipConfig,
  validateDifficultyCurveRow,
  validateWeaponRow,
  parseWeaponCatalogue,
  parseWeaponPatterns,
  WEAPON_IDS,
  WEAPON_COLUMN_ORDER,
  WEAPON_PATTERN_COLUMN_ORDER,
} from '../../src/core/csv';
import { validateWeaponCatalogue } from '../../src/utils/weaponCatalogue';
import { DEFAULT_ENEMY_CONFIGS, DEFAULT_CONFIG } from '../../src/core/configDefaults';
import type { DifficultyCurveRow, EnemyConfig } from '../../src/core/configTypes';

/** Prefix under which the plugin serves its endpoints. */
export const CSV_API_PREFIX = '/api/csv/';

/** Project-relative path of the weapon-catalogue CSV. */
export const WEAPONS_CSV_PATH = 'src/data/weapons.csv';

/** Project-relative path of the long-format weapon shot-pattern CSV. */
export const WEAPON_PATTERNS_CSV_PATH = 'src/data/weapon-patterns.csv';

/** Files the plugin is permitted to read or write. */
export const ALLOWED_CSV_FILES = [
  'src/data/enemy-configs.csv',
  'src/data/ship-config.csv',
  'src/data/difficulty-curves.csv',
  WEAPONS_CSV_PATH,
  WEAPON_PATTERNS_CSV_PATH,
] as const;

export interface ConfigCsvPluginOptions {
  /**
   * Explicit project root override for tests/fixtures.
   *
   * When omitted the plugin uses the Vite server's resolved
   * `server.config.root`, captured in `configureServer` — **never**
   * `process.cwd()`. Vite resolves `config.root` from the config file's
   * directory, so the plugin always targets the checkout Vite is actually
   * serving (a suite running from a worktree can therefore never follow
   * `process.cwd()` into the main checkout, AH-0MVKYQWSW0067F12).
   *
   * When neither an explicit root nor `server.config.root` is available the
   * middleware is not registered at all: a plugin that cannot verify the
   * checkout it serves must never fall back to guessing one.
   */
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

/** Resolve a path through `realpath` where possible, else the input path. */
function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    // Missing paths (a fresh target cannot be realpath'd) keep their
    // already-resolved form.
    return target;
  }
}

/**
 * True when `filePath` stays inside `root`.
 *
 * Containment is checked with `path.relative` (not a naive `startsWith`
 * prefix, which `/repo-evil` would satisfy for `/repo`): `..` traversal and
 * absolute paths resolve outside the root and are rejected. Both sides run
 * through `realpath` for the parts that exist, so a symlinked
 * `node_modules` cannot make a legitimate in-root path look foreign.
 */
export function isWithinRoot(root: string, filePath: string): boolean {
  const realRoot = realpathOrSelf(resolve(root));
  const realTarget = realpathOrSelf(resolve(filePath));
  const rel = relative(realRoot, realTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve a request target under `root`, refusing anything that escapes it.
 *
 * Applied to GET as well as PUT (parent AC: "any request"): reads outside
 * the served checkout are equally unintended. The refusal happens before any
 * filesystem access to the target, so an escaping request can never create or
 * modify a file — it gets HTTP 403 and a logged reason (AH-0MVS9U6PP009JB0M).
 */
function resolveTarget(
  root: string,
  res: ServerResponse,
  relPath: string,
): string | null {
  const filePath = resolve(root, relPath);
  if (!isWithinRoot(root, filePath)) {
    console.warn(
      `[ai-hell:config-csv] refused request: target escapes project root: ${relPath}`,
    );
    sendJson(res, 403, { ok: false, error: 'target escapes project root' });
    return null;
  }
  return filePath;
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

// ── Weapon catalogue write helpers (AH-0MW0Q1GMK005HOF0) ───────────

/**
 * A CSV file split into lines, plus its header row and line-ending style.
 *
 * The weapon write path edits the **file text** rather than re-serialising
 * the parsed catalogue: the hand-authored `#` schema block above the header
 * and every untouched row must survive a save byte-for-byte (AC1/AC3).
 */
interface CsvTextLayout {
  /** Lines without their line terminators. */
  lines: string[];
  /** The file's dominant line ending. */
  eol: string;
  /** True when the file ended with a line terminator. */
  trailingNewline: boolean;
  /** Index of the header line, or -1 when the file declares none. */
  headerIndex: number;
  /** Header columns, trimmed. */
  header: string[];
}

/** True when `line` carries data (not blank and not a `#` comment). */
function isCsvDataLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#');
}

function splitCsvText(text: string): CsvTextLayout {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith(eol);
  const lines = text.split(eol);
  if (trailingNewline) lines.pop();
  const headerIndex = lines.findIndex(isCsvDataLine);
  const header =
    headerIndex === -1
      ? []
      : lines[headerIndex].split(',').map((column) => column.trim());
  return { lines, eol, trailingNewline, headerIndex, header };
}

function joinCsvText(layout: CsvTextLayout, lines: string[]): string {
  return lines.join(layout.eol) + (layout.trailingNewline ? layout.eol : '');
}

/** Parse one data line against a header line (reusing the codec's parser). */
function parseCsvDataLine(
  line: string,
  headerLine: string,
): Record<string, string> {
  const [record] = parseCsvRows(`${headerLine}\n${line}`);
  return record ?? {};
}

/** The first non-comment, non-blank line of `body`, or `undefined`. */
function bodyHeaderLine(body: string): string | undefined {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(isCsvDataLine);
}

/**
 * Columns a request body's header declares (`[]` when it declares none).
 *
 * A body without a header would have its first data row consumed as the
 * header by {@link parseCsvRows}, silently dropping a weapon — so the write
 * handlers refuse one instead of guessing.
 */
function bodyHeaderColumns(body: string): string[] {
  const header = bodyHeaderLine(body);
  return header === undefined
    ? []
    : header.split(',').map((column) => column.trim());
}

/** Fast membership check mirroring the codec's `WEAPON_ID_SET`. */
const WEAPON_ID_LOOKUP: ReadonlySet<string> = new Set<string>(WEAPON_IDS);

/** One merged-catalogue diagnostic, split into the ids it names and its text. */
interface WeaponWriteDiagnostic {
  message: string;
  ids: string[];
}

/**
 * The weapon ids named by a diagnostic's `<ids>: <field>: <reason>` prefix.
 * Schema-level messages (e.g. `Unknown column "x" — …`) name none.
 */
function weaponDiagnosticIds(message: string): string[] {
  const head = message.split(':')[0] ?? '';
  return head
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
}

/**
 * Split merged-catalogue diagnostics into blocking errors and warnings.
 *
 * A save is refused when a finding is **caused by the incoming rows** (it
 * names an incoming weapon id) or is **schema-level** (it names no known
 * weapon id — an unknown column or a drifting header). A finding that names
 * only weapons the request did not touch is reported as a warning and does
 * not block: a pre-existing broken row must never trap a designer who is
 * trying to fix a different weapon.
 */
function classifyWeaponDiagnostics(
  diagnostics: readonly WeaponWriteDiagnostic[],
  incomingIds: readonly string[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const diagnostic of diagnostics) {
    const known = diagnostic.ids.filter((id) => WEAPON_ID_LOOKUP.has(id));
    const blocking =
      known.length === 0 || known.some((id) => incomingIds.includes(id));
    (blocking ? errors : warnings).push(diagnostic.message);
  }
  return { errors, warnings };
}

/**
 * The authored row for `id` in an existing weapons CSV, or `null`.
 *
 * Used to merge a **partial** payload: a column the request omits keeps its
 * authored value, while an explicitly blank cell clears it (blank means "this
 * weapon has no such capability", so a merge that filled blanks from the old
 * row would make a capability impossible to remove).
 */
function findWeaponRecord(
  layout: CsvTextLayout,
  id: string,
): Record<string, string> | null {
  const headerLine = layout.lines[layout.headerIndex];
  for (let i = layout.headerIndex + 1; i < layout.lines.length; i++) {
    const line = layout.lines[i];
    if (!isCsvDataLine(line)) continue;
    const record = parseCsvDataLine(line, headerLine);
    if ((record.id ?? '').trim() === id) return record;
  }
  return null;
}

/** Columns in `row` that the file's header does not declare. */
function undeclaredRowColumns(
  row: Readonly<Record<string, string>>,
  header: readonly string[],
): string[] {
  const declared = new Set(header);
  return Object.keys(row).filter((column) => !declared.has(column));
}

/**
 * Diagnostics for a request body whose header does not declare the same
 * columns as the file it writes.
 *
 * The body must declare the file's schema (in any order — cells are written in
 * the file's order). An extra column would be silently dropped, and an
 * omitted column would be blanked on every row the save touches — both would
 * corrupt a hand-authored file, so both are refused with the column named.
 */
function headerMismatchDiagnostics(
  header: readonly string[],
  fileHeader: readonly string[],
): string[] {
  const declared = new Set(fileHeader);
  const inBody = new Set(header);
  return [
    ...header
      .filter((column) => !declared.has(column))
      .map(
        (column) =>
          `Unknown column "${column}" — not part of the file's schema (${fileHeader.join(', ')})`,
      ),
    ...fileHeader
      .filter((column) => !inBody.has(column))
      .map(
        (column) =>
          `Missing column "${column}" — the request header must declare every column of the file's schema`,
      ),
  ];
}

/**
 * `PUT src/data/weapons.csv` — upsert the supplied weapon rows by `id`.
 *
 * Validation runs in two layers before anything is written:
 *
 * 1. **Per row** — {@link validateWeaponRow}: required columns, enum values,
 *    `0xRRGGBB` colours, numeric magnitudes and descriptor-group coherence.
 *    This is also what rejects an **unknown id**: a weapon the code has no
 *    fallback definition for cannot resolve an icon
 *    (`src/powerups/icons.ts`) or an audio cue (`src/audio/effects.ts`), so a
 *    bare CSV row would ship a broken drop. The epic adds weapons by code
 *    (icon arm + cue arm), never by CSV row alone.
 * 2. **Across the merged catalogue** — `parseWeaponCatalogue` +
 *    `validateWeaponCatalogue` (the child-5 runtime roster guards): an
 *    off-beat `subdivisions` (e.g. `1.37`), a duplicate bullet colour or a
 *    duplicate canonical bullet-shape family is rejected with the offending
 *    rows named.
 *
 * A rejected save returns 400 with the diagnostics and leaves the file
 * untouched. In `?mode=append` (the panel's Save As) any id that already
 * exists is refused with 409 — matching the enemy-config behaviour.
 */
function handleWeaponsPut(
  root: string,
  res: ServerResponse,
  filePath: string,
  mode: 'upsert' | 'append',
  incomingRows: Record<string, string>[],
  body: string,
): void {
  const header = bodyHeaderColumns(body);
  if (!header.includes('id')) {
    sendJson(res, 400, {
      ok: false,
      errors: [
        'Request body must include the weapons header row (starting with `id,`)',
      ],
    });
    return;
  }
  if (incomingRows.length === 0) {
    sendJson(res, 400, {
      ok: false,
      errors: ['Request body contained no CSV rows'],
    });
    return;
  }

  const rowErrors: string[] = [];
  for (const incoming of incomingRows) {
    rowErrors.push(...validateWeaponRow(incoming).errors);
  }
  if (rowErrors.length > 0) {
    sendJson(res, 400, { ok: false, errors: [...new Set(rowErrors)] });
    return;
  }

  const incomingIds = [
    ...new Set(incomingRows.map((row) => (row.id ?? '').trim())),
  ];

  const existingText = readFileSync(filePath, 'utf8');
  const layout = splitCsvText(existingText);
  if (layout.headerIndex === -1) {
    sendJson(res, 500, {
      ok: false,
      error: `${WEAPONS_CSV_PATH} declares no header row — refusing to write`,
    });
    return;
  }

  const headerErrors = headerMismatchDiagnostics(header, layout.header);
  const unknownColumns = [
    ...new Set(
      incomingRows.flatMap((row) => undeclaredRowColumns(row, layout.header)),
    ),
  ].map(
    (column) =>
      `Unknown column "${column}" — not part of the weapon-catalogue schema (${WEAPON_COLUMN_ORDER.join(', ')})`,
  );
  if (headerErrors.length > 0 || unknownColumns.length > 0) {
    sendJson(res, 400, {
      ok: false,
      errors: [...headerErrors, ...unknownColumns],
    });
    return;
  }

  const existingIds = parseCsvRows(existingText).map((row) =>
    (row.id ?? '').trim(),
  );
  if (mode === 'append') {
    for (const id of incomingIds) {
      if (existingIds.includes(id)) {
        sendJson(res, 409, {
          ok: false,
          error: `Duplicate weapon id: "${id}" already exists`,
        });
        return;
      }
    }
  }

  // One replacement line per incoming id, merged over the authored row.
  const replacements = new Map<string, string>();
  for (const incoming of incomingRows) {
    const id = (incoming.id ?? '').trim();
    const cells: Record<string, string> = {
      ...(findWeaponRecord(layout, id) ?? {}),
    };
    for (const column of layout.header) {
      const value = incoming[column];
      if (value !== undefined) cells[column] = value;
    }
    replacements.set(id, serializeCsvLine(cells, layout.header));
  }

  // Replace matching rows in place, keeping the header, the comment block and
  // every other row verbatim; a new id is appended at the end.
  const headerLine = layout.lines[layout.headerIndex];
  const merged: string[] = [];
  const replaced = new Set<string>();
  layout.lines.forEach((line, index) => {
    if (index <= layout.headerIndex || !isCsvDataLine(line)) {
      merged.push(line);
      return;
    }
    const id = (parseCsvDataLine(line, headerLine).id ?? '').trim();
    const replacement = replacements.get(id);
    if (replacement === undefined || replaced.has(id)) {
      merged.push(line);
      return;
    }
    replaced.add(id);
    merged.push(replacement);
  });

  const appendedIds: string[] = [];
  for (const id of incomingIds) {
    if (replaced.has(id)) continue;
    const line = replacements.get(id);
    if (line === undefined) continue;
    merged.push(line);
    appendedIds.push(id);
  }

  const mergedText = joinCsvText(layout, merged);
  const patternsPath = join(root, WEAPON_PATTERNS_CSV_PATH);
  const patternsText = existsSync(patternsPath)
    ? readFileSync(patternsPath, 'utf8')
    : '';
  const parsed = parseWeaponCatalogue(mergedText, patternsText);
  const guard = validateWeaponCatalogue(parsed.catalogue);
  const { errors, warnings } = classifyWeaponDiagnostics(
    [
      ...parsed.errors.map((message) => ({
        message,
        ids: weaponDiagnosticIds(message),
      })),
      ...guard.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => ({
          message: diagnostic.message,
          ids: [...diagnostic.weaponIds],
        })),
    ],
    incomingIds,
  );
  if (errors.length > 0) {
    sendJson(res, 400, { ok: false, errors });
    return;
  }

  atomicWrite(filePath, mergedText);

  const definitions = incomingIds.flatMap((id) => {
    const definition = parsed.catalogue[id as (typeof WEAPON_IDS)[number]];
    return definition === undefined ? [] : [definition];
  });
  sendJson(res, appendedIds.length > 0 ? 201 : 200, {
    ok: true,
    mode: appendedIds.length > 0 ? 'append' : 'upsert',
    weaponIds: incomingIds,
    definitions,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

/**
 * `PUT src/data/weapon-patterns.csv` — replace every pattern row for each
 * weapon named in the request body.
 *
 * The patterns file is long format (`weaponId,index,angleDeg,sideOffsetPx`),
 * so an angle-list edit is written **whole per weapon**: sending a weapon's
 * rows replaces all of them, which means a shortened pattern can never leave
 * orphan rows behind (AC3). Rows belonging to any other weapon are untouched,
 * as is the `#` schema block.
 *
 * Validation reuses the codec's {@link parseWeaponPatterns} on the merged
 * file, so a bad index, a non-numeric angle or an unknown weapon id is
 * rejected with the offending id named and the file untouched. A weapon id
 * with no row in `weapons.csv` is refused too: pattern rows for a weapon that
 * does not exist are orphans by definition.
 */
function handleWeaponPatternsPut(
  root: string,
  res: ServerResponse,
  filePath: string,
  incomingRows: Record<string, string>[],
  body: string,
): void {
  const header = bodyHeaderColumns(body);
  if (!header.includes('weaponId')) {
    sendJson(res, 400, {
      ok: false,
      errors: [
        'Request body must include the weapon-patterns header row (starting with `weaponId,`)',
      ],
    });
    return;
  }
  if (incomingRows.length === 0) {
    sendJson(res, 400, {
      ok: false,
      errors: ['Request body contained no CSV rows'],
    });
    return;
  }

  const touchedIds = [
    ...new Set(incomingRows.map((row) => (row.weaponId ?? '').trim())),
  ];

  const existingText = readFileSync(filePath, 'utf8');
  const layout = splitCsvText(existingText);
  if (layout.headerIndex === -1) {
    sendJson(res, 500, {
      ok: false,
      error: `${WEAPON_PATTERNS_CSV_PATH} declares no header row — refusing to write`,
    });
    return;
  }

  const unknownColumns = [
    ...new Set(
      incomingRows.flatMap((row) => undeclaredRowColumns(row, layout.header)),
    ),
  ].map(
    (column) =>
      `Unknown column "${column}" — not part of the weapon-pattern schema (${WEAPON_PATTERN_COLUMN_ORDER.join(', ')})`,
  );
  const headerErrors = headerMismatchDiagnostics(header, layout.header);
  if (headerErrors.length > 0 || unknownColumns.length > 0) {
    sendJson(res, 400, {
      ok: false,
      errors: [...headerErrors, ...unknownColumns],
    });
    return;
  }

  const weaponsPath = join(root, WEAPONS_CSV_PATH);
  if (existsSync(weaponsPath)) {
    const catalogueIds = new Set(
      parseCsvRows(readFileSync(weaponsPath, 'utf8')).map((row) =>
        (row.id ?? '').trim(),
      ),
    );
    const orphans = touchedIds.filter(
      (id) => id !== '' && !catalogueIds.has(id),
    );
    if (orphans.length > 0) {
      sendJson(res, 400, {
        ok: false,
        errors: orphans.map(
          (id) =>
            `${id}: weaponId: No row for this weapon in ${WEAPONS_CSV_PATH} — a pattern needs a weapon`,
        ),
      });
      return;
    }
  }

  // New rows per weapon, serialised in the file's own column order.
  const incomingLines = new Map<string, string[]>();
  for (const incoming of incomingRows) {
    const id = (incoming.weaponId ?? '').trim();
    const cells: Record<string, string> = {};
    for (const column of layout.header) {
      const value = incoming[column];
      if (value !== undefined) cells[column] = value;
    }
    const lines = incomingLines.get(id) ?? [];
    lines.push(serializeCsvLine(cells, layout.header));
    incomingLines.set(id, lines);
  }

  const headerLine = layout.lines[layout.headerIndex];
  const merged: string[] = [];
  const inserted = new Set<string>();
  layout.lines.forEach((line, index) => {
    if (index <= layout.headerIndex || !isCsvDataLine(line)) {
      merged.push(line);
      return;
    }
    const weaponId = (parseCsvDataLine(line, headerLine).weaponId ?? '').trim();
    const replacement = incomingLines.get(weaponId);
    if (replacement === undefined) {
      merged.push(line);
      return;
    }
    // Replace-all for the weapon: emit its new rows at the first old row and
    // drop every other old row for it.
    if (inserted.has(weaponId)) return;
    inserted.add(weaponId);
    merged.push(...replacement);
  });

  for (const [weaponId, lines] of incomingLines) {
    if (inserted.has(weaponId)) continue;
    merged.push(...lines);
    inserted.add(weaponId);
  }

  const mergedText = joinCsvText(layout, merged);
  const parsed = parseWeaponPatterns(mergedText);
  const { errors, warnings } = classifyWeaponDiagnostics(
    parsed.errors.map((message) => ({
      message,
      ids: weaponDiagnosticIds(message),
    })),
    touchedIds,
  );
  if (errors.length > 0) {
    sendJson(res, 400, { ok: false, errors });
    return;
  }

  atomicWrite(filePath, mergedText);
  sendJson(res, 200, {
    ok: true,
    mode: 'replace',
    weaponIds: touchedIds,
    rowCount: incomingRows.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

function handleGet(
  root: string,
  res: ServerResponse,
  relPath: string,
): void {
  const filePath = resolveTarget(root, res, relPath);
  if (filePath === null) return;
  if (!isAllowedPath(relPath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }
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
  const filePath = resolveTarget(root, res, relPath);
  if (filePath === null) return;
  if (!isAllowedPath(relPath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }

  if (!existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: `Not found: ${relPath}` });
    return;
  }

  const mode = query.get('mode') === 'append' ? 'append' : 'upsert';
  const incomingRows = parseCsvRows(body);

  // The weapon-catalogue files get a row-preserving write path; the enemy,
  // ship and difficulty files keep the whole-file flow below. They are
  // dispatched first because their handlers validate the body's header row
  // themselves — a headerless body parses as "one header, zero rows" and must
  // be reported as a missing header rather than as an empty request.
  if (relPath === WEAPONS_CSV_PATH) {
    handleWeaponsPut(root, res, filePath, mode, incomingRows, body);
    return;
  }
  if (relPath === WEAPON_PATTERNS_CSV_PATH) {
    handleWeaponPatternsPut(root, res, filePath, incomingRows, body);
    return;
  }

  if (incomingRows.length === 0) {
    sendJson(res, 400, { ok: false, errors: ['Request body contained no CSV rows'] });
    return;
  }

  // Validate every incoming row against the target schema before touching
  // the file. The store PUTs the full CSV, so all rows are checked.
  const isShip = relPath.endsWith('ship-config.csv');
  const isDifficulty = relPath.endsWith('difficulty-curves.csv');
  for (const incoming of incomingRows) {
    const validation = isShip
      ? validateShipConfig(incoming, DEFAULT_CONFIG)
      : isDifficulty
        ? validateDifficultyCurveRow(incoming)
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

  if (isDifficulty) {
    // The curve file has no key to upsert by: the store PUTs the full,
    // validated curve and the plugin replaces the file wholesale.
    const curves: DifficultyCurveRow[] = [];
    for (const incoming of incomingRows) {
      const row = coerceDifficultyCurveRow(incoming);
      if (row) curves.push(row);
    }
    atomicWrite(filePath, serializeDifficultyCurves(curves));
    sendJson(res, 200, { ok: true, mode: 'upsert', rows: curves });
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
 * The read/write root is resolved inside `configureServer` from
 * `options.root` (explicit override) or the Vite server's resolved
 * `server.config.root` — never `process.cwd()`, so the plugin always targets
 * the checkout Vite is serving (AH-0MVS9U6PP009JB0M, parent
 * AH-0MVKYQWSW0067F12). Any request whose target resolves outside that root
 * is refused with HTTP 403 before any file I/O.
 *
 * @param options.root — explicit project root override (tests/fixtures).
 *   Defaults to the Vite-resolved `server.config.root`.
 */
export function configCsvPlugin(options: ConfigCsvPluginOptions = {}): Plugin {
  return {
    name: 'ai-hell:config-csv',
    // Only applies to the dev server (`vite`), never `vite build`.
    apply: 'serve',
    configureServer(server) {
      if (!isDevServer(server)) return;

      // Resolve the root here, from the Vite-resolved project root, instead
      // of at plugin-construction time from `process.cwd()`.
      const configuredRoot = options.root ?? server.config?.root;
      if (!configuredRoot) {
        const logger = server.config?.logger ?? console;
        logger.warn(
          '[ai-hell:config-csv] no project root resolved from the Vite server; CSV endpoints are disabled',
        );
        return;
      }
      const root = resolve(configuredRoot);

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

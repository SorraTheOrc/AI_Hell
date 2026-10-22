/**
 * Declarative single-field CSV editing for the balance-tuning loop
 * (AH-0MVBNISWE009QFBL, child 3 of AH-0MV8Q5EYE001R715).
 *
 * Pure string-level helpers for the `--tune` loop's `--set` edit step:
 * a declarative `<file> <rowKey>.<field>=<value>` (or `<field>=<value>` for
 * single-row files like `ship-config.csv`) is parsed and applied as **exactly
 * one** single-field change to one of the three balance CSVs. The editor is
 * quote-aware (a quoted field that contains a comma does not shift the
 * column), preserves every untouched byte of the input (comments, other
 * rows, line endings), and records the previous and new value for the
 * before/after comparison record (parent AC1). Restore of the byte-identical
 * original is orchestrated by the Node shell (`scripts/evaluate.mjs`), which
 * keeps the original text and writes it back on success and failure paths
 * (parent AC4) — see `scripts/csvEdit-shell.test.ts`.
 *
 * Pure only: no filesystem, no wall clock — same constraint as the eval
 * core, so the editor is unit-testable without touching disk.
 *
 * @module src/util/csvEdit
 */

/** Error codes raised by the CSV editor. */
export type CsvEditErrorCode =
  | 'malformed-assignment'
  | 'unknown-file'
  | 'unknown-field'
  | 'unknown-row'
  | 'no-data-row';

/** Structured error raised by the declarative edit helpers. */
export class CsvEditError extends Error {
  readonly code: CsvEditErrorCode;

  constructor(code: CsvEditErrorCode, message: string) {
    super(message);
    this.name = 'CsvEditError';
    this.code = code;
  }
}

/** The three balance CSVs a `--set` edit may touch (single source of truth). */
export const KNOWN_BALANCE_CSV_FILES = Object.freeze([
  'enemy-configs.csv',
  'ship-config.csv',
  'difficulty-curves.csv',
] as const);

/** A parsed single-field edit request. */
export interface CsvEditSpec {
  /** Which balance CSV file the edit targets (a basename from {@link KNOWN_BALANCE_CSV_FILES}). */
  readonly file: string;
  /**
   * Row key to edit — matched against the data row's first column. `null`
   * targets the file's first (single) data row (e.g. `ship-config.csv`).
   */
  readonly rowKey: string | null;
  /** Header column name whose value changes. */
  readonly field: string;
  /** New value, verbatim. */
  readonly value: string;
}

/** The outcome of applying one {@link CsvEditSpec} to a CSV string. */
export interface CsvEditOutcome {
  /** The edited CSV text — byte-identical everywhere but the target cell. */
  readonly csv: string;
  /** The target cell's previous value (unquoted). */
  readonly previousValue: string;
  /** The target cell's new value as supplied. */
  readonly newValue: string;
  /** True when the cell's value actually changed. */
  readonly changed: boolean;
}

/**
 * Parses the assignment half of a `--set` value, e.g. `boss.health=6` (row
 * key + field) or `thrustAcceleration=320` (single-row file, no row key).
 * Throws {@link CsvEditError} (`malformed-assignment`) when the assignment
 * cannot name exactly one field with a value.
 */
export function parseAssignment(assignment: string): Omit<CsvEditSpec, 'file'> {
  if (typeof assignment !== 'string' || assignment.length === 0) {
    throw new CsvEditError(
      'malformed-assignment',
      'Empty --set assignment: expected <rowKey>.<field>=<value> or <field>=<value>.',
    );
  }
  const eq = assignment.indexOf('=');
  if (eq < 0) {
    throw new CsvEditError(
      'malformed-assignment',
      `Malformed --set assignment "${assignment}": expected <rowKey>.<field>=<value>.`,
    );
  }
  const selector = assignment.slice(0, eq);
  const value = assignment.slice(eq + 1);
  if (selector.length === 0 || value.length === 0) {
    throw new CsvEditError(
      'malformed-assignment',
      `Malformed --set assignment "${assignment}": field and value must both be non-empty.`,
    );
  }
  const dot = selector.indexOf('.');
  if (dot < 0) {
    // Single-row file (e.g. ship-config.csv) — the selector is just the field.
    if (selector.length === 0) {
      throw new CsvEditError(
        'malformed-assignment',
        `Malformed --set assignment "${assignment}": empty field name.`,
      );
    }
    return { rowKey: null, field: selector, value };
  }
  const rowKey = selector.slice(0, dot);
  const field = selector.slice(dot + 1);
  if (rowKey.length === 0 || field.length === 0) {
    throw new CsvEditError(
      'malformed-assignment',
      `Malformed --set assignment "${assignment}": row key and field must both be non-empty.`,
    );
  }
  return { rowKey, field, value };
}

/**
 * Parses a full `--set` edit spec from a known file basename and an
 * assignment string. Validates the file against
 * {@link KNOWN_BALANCE_CSV_FILES} so the edit can never touch an arbitrary
 * file (parent constraints: dev/eval only, checkout hygiene).
 */
export function parseEditSpec(file: string, assignment: string): CsvEditSpec {
  if (!KNOWN_BALANCE_CSV_FILES.includes(file as (typeof KNOWN_BALANCE_CSV_FILES)[number])) {
    throw new CsvEditError(
      'unknown-file',
      `Unknown balance CSV "${file}": --set supports ${KNOWN_BALANCE_CSV_FILES.join(', ')}.`,
    );
  }
  return { file, ...parseAssignment(assignment) };
}

/** Splits one CSV line into raw fields, honouring double-quoted cells. */
function splitRawFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '""';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
    i += 1;
  }
  fields.push(current);
  return fields;
}

/** Unquotes a raw CSV field (removes surrounding quotes, un-doubles inner). */
function unquoteField(raw: string): string {
  let value = raw;
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replaceAll('""', '"');
  }
  return value;
}

/** Encodes a value as a CSV cell (quotes when it contains a comma, quote or newline). */
function encodeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * Locates the raw `[start, end)` span of the `colIndex`-th field on a single
 * CSV data line (0-based, quote-aware). Returns null when the column does
 * not exist on the line.
 */
function fieldSpan(line: string, colIndex: number): [number, number] | null {
  let inQuotes = false;
  let column = 0;
  let start = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          i += 2;
          continue;
        }
        inQuotes = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      if (column === colIndex) return [start, i];
      column += 1;
      start = i + 1;
    }
    i += 1;
  }
  if (column === colIndex) return [start, i];
  return null;
}

/** Splices `newText` onto a single line at the target column span. */
function replaceColumn(line: string, colIndex: number, newText: string): string {
  const span = fieldSpan(line, colIndex);
  if (span === null) {
    throw new CsvEditError(
      'unknown-field',
      `Cannot edit column ${colIndex} on line "${line.slice(0, 40)}…": column absent.`,
    );
  }
  const [start, end] = span;
  return line.slice(0, start) + newText + line.slice(end);
}

/**
 * Applies exactly one single-field edit to a balance CSV string (parent
 * AC1). Finds the header row (first non-comment, non-empty line), locates
 * the target column by header name and the target data row by first-column
 * row key (or the first data row when `rowKey` is null), then replaces only
 * that cell — every other byte of the input is preserved (comments, other
 * rows, CRLF/LF line endings, quoting).
 *
 * Throws {@link CsvEditError} when the file has no header/field, the field
 * is not a column, or the row key does not match a data row.
 */
export function applyCsvEdit(csv: string, spec: Omit<CsvEditSpec, 'file'>): CsvEditOutcome {
  const lineEnding = csv.includes('\r\n') ? '\r\n' : '\n';
  const lines = csv.split(/\r?\n/);
  let headerIndex: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    headerIndex = i;
    break;
  }
  if (headerIndex === null) {
    throw new CsvEditError('no-data-row', 'Cannot edit a CSV with no header row.');
  }
  const headerFields = splitRawFields(lines[headerIndex]);
  const column = headerFields.findIndex(
    (raw) => unquoteField(raw).trim() === spec.field,
  );
  if (column < 0) {
    throw new CsvEditError(
      'unknown-field',
      `Column "${spec.field}" is not in the CSV header (${headerFields.map(unquoteField).join(', ')}).`,
    );
  }

  // Identify the target data row: first-column match on the row key, or the
  // first data row for single-row files (rowKey === null).
  let targetIndex: number | null = null;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const rowFields = splitRawFields(lines[i]);
    if (rowFields.length === 0) continue;
    if (spec.rowKey === null) {
      targetIndex = i;
      break;
    }
    if (unquoteField(rowFields[0]).trim() === spec.rowKey) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === null) {
    if (spec.rowKey === null) {
      throw new CsvEditError('no-data-row', 'The CSV has no data row to edit.');
    }
    throw new CsvEditError(
      'unknown-row',
      `No data row with key "${spec.rowKey}" found in the CSV.`,
    );
  }

  const rowLine = lines[targetIndex];
  const span = fieldSpan(rowLine, column);
  const rawField = span === null ? '' : rowLine.slice(span[0], span[1]);
  const previousValue = unquoteField(rawField);
  const encodedNew = encodeField(spec.value);

  lines[targetIndex] = replaceColumn(rowLine, column, encodedNew);

  return {
    csv: lines.join(lineEnding),
    previousValue,
    newValue: spec.value,
    changed: previousValue !== spec.value,
  };
}

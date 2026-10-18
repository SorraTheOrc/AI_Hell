/**
 * Type declarations for the dependency-free `scripts/evaluate.mjs` CLI shell
 * (AH-0MUY08XLD009K4W4). The implementation is plain JS so the CLI runs
 * under Node without a TypeScript loader; these declarations let the
 * TypeScript test suite type-check against it.
 */

export interface ParsedEvaluateArgs {
  policy: string;
  baseline: string | null;
  candidate: string | null;
  seeds: number | number[] | null;
  ticks: number;
  dt: number;
  sampleEveryTicks: number;
  outputDir: string;
  json: boolean;
  video: boolean;
  batch: boolean;
  games: number | null;
  policies: string[] | null;
  humanFile: string | null;
  humanSeed: number | null;
  help: boolean;
  tune: boolean;
  tuneFile: string | null;
  tuneAssignment: string | null;
  threshold: number;
  keepEdit: boolean;
}

export const EVALUATE_USAGE: string;

/** Pure CSV-edit surface re-exported by the SSR-loaded eval core. */
export interface CsvEditOutcome {
  csv: string;
  previousValue: string;
  newValue: string;
  changed: boolean;
}

/** Parsed `--set` edit request. */
export interface CsvEditSpec {
  file: string;
  rowKey: string | null;
  field: string;
  value: string;
}

/** The pure parse/apply functions the shell consumes from the SSR core. */
export interface CsvEditCore {
  applyCsvEdit(csv: string, spec: CsvEditSpec): CsvEditOutcome;
  parseEditSpec(file: string, assignment: string): CsvEditSpec;
  /** Present when the caller wants structured edit errors. */
  CsvEditError?: new (code: string, message: string) => Error;
}

/** Applies one `--set` edit to a balance CSV on disk (AH-0MVBNISWE009QFBL). */
export function applyCsvEditFile(
  filePath: string,
  assignment: string,
  csvEditCore?: CsvEditCore | null,
): Promise<{
  fileName: string;
  spec: CsvEditSpec;
  previousValue: string;
  newValue: string;
  originalText: string;
  editedText: string;
}>;

/** Restores a CSV to its pre-edit text unless `keepEdit` is set (AC4). */
export function restoreCsvFile(
  filePath: string,
  originalText: string,
  keepEdit?: boolean,
): Promise<{ action: 'restored' | 'kept-edited' }>;

export function parseEvaluateArgs(argv?: string[]): ParsedEvaluateArgs;
export function resolveSeeds(options: {
  seeds?: number | number[] | null;
  games?: number | null;
  batch?: boolean;
}): number[];
export function resolveArtifactPath(dir: string, name: string): string;
export function executeTune(
  options: ParsedEvaluateArgs,
  io?: { out: { write(text: string): void }; err: { write(text: string): void } },
): Promise<number>;
export function main(
  argv: string[],
  io?: { out: { write(text: string): void }; err: { write(text: string): void } },
): Promise<number>;

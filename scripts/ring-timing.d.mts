/**
 * Type declarations for the dependency-free `scripts/ring-timing.mjs` CLI
 * shell (AH-0MVUXCBQY001ESWT). The implementation is plain JS so the CLI runs
 * under Node without a TypeScript loader; these declarations let the
 * TypeScript test suite type-check against it.
 */

/** Parsed CLI options. */
export interface ParsedRingTimingArgs {
  /** Rings to measure (default `[1, 2]`). */
  rings: number[];
  /** Playstyle lines to measure (default `['grind', 'rush']`). */
  strategies: string[];
  /** Run seeds to measure (default `[1, 2, 3]`). */
  seeds: number[];
  /** Print the JSON report instead of text. */
  json: boolean;
  /** Optional JSON artifact path (relative to the repo root). */
  out: string | null;
  /** Show usage instead of measuring. */
  help: boolean;
}

export const DEFAULT_RINGS: number[];
export const DEFAULT_STRATEGIES: string[];
export const DEFAULT_SEEDS: number[];

export function parseRingTimingArgs(argv?: string[]): ParsedRingTimingArgs;
export function loadCore(): Promise<{
  server: { close(): Promise<void> };
  core: Record<string, unknown>;
}>;
export function main(argv?: string[]): Promise<number>;

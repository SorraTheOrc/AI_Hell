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
  humanFile: string | null;
  humanSeed: number | null;
  help: boolean;
}

export const EVALUATE_USAGE: string;

export function parseEvaluateArgs(argv?: string[]): ParsedEvaluateArgs;
export function resolveSeeds(options: { seeds: number | number[] | null }): number[];
export function resolveArtifactPath(dir: string, name: string): string;
export function main(
  argv: string[],
  io?: { out: { write(text: string): void }; err: { write(text: string): void } },
): Promise<number>;

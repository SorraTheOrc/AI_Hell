/**
 * Type declarations for the `scripts/analyse-recording.mjs` CLI
 * (AH-0MUY08W7Y004GATZ). Plain JS implementation; these declare the shell's
 * exports for the test suite.
 */

import type { RecordingRun } from './recording.mjs';

export interface AnalyseArgs {
  file: string | null;
  runIndex: number | null;
  seed: number | null;
  json: boolean;
  output: string | null;
  help?: boolean;
}

export function parseAnalyseArgs(argv?: string[]): AnalyseArgs;
export function selectRun(
  runs: RecordingRun[],
  options?: { runIndex?: number | null; seed?: number | null },
): RecordingRun | null;

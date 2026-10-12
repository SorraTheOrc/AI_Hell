/**
 * Type declarations for the `scripts/replay-recording.mjs` CLI
 * (AH-0MUY08W7Y004GATZ). Plain JS implementation; these declare the shell's
 * exports for the test suite.
 */

import type { RecordingRun } from './recording.mjs';

export interface ReplayArgs {
  file: string | null;
  runIndex: number | null;
  seed: number | null;
  botFile: string | null;
  botRunIndex: number | null;
  botSeed: number | null;
  tick: number | null;
  list: boolean;
  json: boolean;
  svg: string | null;
  verbose: boolean;
  help?: boolean;
}

export function parseReplayArgs(argv?: string[]): ReplayArgs;
export function selectRun(
  runs: RecordingRun[],
  index: number | null,
  seed: number | null,
  exclude?: RecordingRun | null,
): RecordingRun | null;

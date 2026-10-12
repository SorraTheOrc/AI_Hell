/**
 * Type declarations for the `scripts/record-session.mjs` CLI
 * (AH-0MUY08W7Y004GATZ). Plain JS implementation; these declare the shell's
 * exports for the test suite.
 */

export const TELEMETRY_JSONL_STORAGE_KEY: string;
export const DEFAULT_RECORD_MAX_DURATION_MS: number;
export const DEFAULT_RECORD_POLL_MS: number;

export interface RecordArgs {
  output: string | null;
  port: number;
  seed: number | null;
  bot: boolean;
  headed: boolean;
  auto: boolean;
  maxDurationMs: number;
  pollMs: number;
  json: boolean;
  help?: boolean;
}

export function parseRecordArgs(argv?: string[]): RecordArgs;
export function recordUrl(baseUrl: string, options?: { seed?: number | null }): string;
export function resolveRecordingOutputPath(
  requested: string | null | undefined,
  options?: { seed?: number | null },
): string;

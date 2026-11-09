/**
 * Type declarations for the `scripts/record-session.mjs` CLI
 * (AH-0MUY08W7Y004GATZ). Plain JS implementation; these declare the shell's
 * exports for the test suite.
 */

export const DEFAULT_RECORD_MAX_DURATION_MS: number;
export const DEFAULT_RECORD_POLL_MS: number;

/** The single actionable line printed when an interrupted run captured nothing. */
export const LOST_RECORDING_MESSAGE: string;

/** Suffix inserted before the `.jsonl` extension for the crash-safe partial. */
export const RECORDING_PARTIAL_SUFFIX: string;

/** Why a recording wait loop stopped (AH-0MVWIDLX200526P1). */
export type RecordingStopReason = 'sigint' | 'run_end' | 'max_duration' | 'target_closed';

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
  /** `--bot-config` file path holding exported bot-tuning state, or null. */
  botConfig: string | null;
  help?: boolean;
}

export function parseRecordArgs(argv?: string[]): RecordArgs;
export function recordUrl(baseUrl: string, options?: { seed?: number | null }): string;
export function resolveRecordingOutputPath(
  requested: string | null | undefined,
  options?: { seed?: number | null },
): string;
export function resolveBalanceStatsOutputPath(recordingPath: string): string;
export function buildHumanBalanceStatsArtifact(
  records: unknown[],
  core: {
    extractHumanBalanceStats(records: any): { report: unknown };
    serialiseReport(report: any): string;
  },
): { name: string; content: string; report: unknown };
/** True when `error` is a Playwright target-closed failure (a family match). */
export function isTargetClosedError(error: unknown): boolean;
/** Resolves `<stem>.partial.jsonl` for a recording path. */
export function partialPathForJsonl(outputPath: string): string;
/** Builds the single actionable lost-session line naming the unwritten path. */
export function formatLostRecordingLine(outputPath: string): string;
/** Builds the single actionable salvaged-partial line. */
export function formatSalvagedRecordingLine(partialPath: string): string;

export interface RecordingWaitLoopOptions {
  evaluate: (fn: Function, arg?: unknown) => Promise<unknown>;
  stop: { readonly requested: boolean };
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
  maxDurationMs?: number;
  pollMs?: number;
  auto?: boolean;
  isPageClosed?: (() => boolean) | null;
  isBrowserConnected?: (() => boolean) | null;
  onInterruption?: ((info: { error: unknown; targetClosed: boolean }) => void) | null;
}

export function runRecordingWaitLoop(
  options?: RecordingWaitLoopOptions,
): Promise<RecordingStopReason>;

export interface FinaliseRecordingOptions {
  reason: RecordingStopReason;
  outputPath: string;
  partialPath?: string | null;
  capturedBytes?: number;
  readJsonl: () => Promise<string>;
  writeRecording: (path: string, jsonl: string) => void;
  removeFile: (path: string) => void;
  log?: (line: string) => void;
}

export interface FinaliseRecordingResult {
  exitCode: number;
  lost: boolean;
  salvaged: boolean;
  outputPath: string;
  partialPath: string | null;
  jsonl: string | null;
}

export function finaliseRecording(
  options: FinaliseRecordingOptions,
): Promise<FinaliseRecordingResult>;

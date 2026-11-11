/**
 * Type declarations for the `scripts/record-session.mjs` CLI
 * (AH-0MUY08W7Y004GATZ). Plain JS implementation; these declare the shell's
 * exports for the test suite.
 */

export const DEFAULT_RECORD_MAX_DURATION_MS: number;
export const DEFAULT_RECORD_POLL_MS: number;
/** Default interval between crash-safe checkpoints (`--checkpoint-ms`), in ms. */
export const DEFAULT_CHECKPOINT_MS: number;

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
  /** `--checkpoint-ms`; `0` disables crash-safe checkpointing. */
  checkpointMs: number;
  json: boolean;
  /** `--bot-config` file path holding exported bot-tuning state, or null. */
  botConfig: string | null;
  help?: boolean;
}

export function parseRecordArgs(argv?: string[]): RecordArgs;
/** The recorder's `--help` text, including the stop procedure and `--auto` separator. */
export function formatRecordHelp(): string;
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
/** Resolves the collision-safe partial write target for a recording path. */
export function resolvePartialRecordingPath(
  outputPath: string,
  exists?: (path: string) => boolean,
): string;
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
  onTick?: ((info: { elapsedMs: number }) => Promise<unknown> | unknown) | null;
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

export interface CheckpointState {
  offset: number;
  total: number;
  remainder: string;
  bytesWritten: number;
}

export interface CheckpointRead {
  total: number;
  chunk: string;
}

/** Advances the checkpoint state by one bounded page read (pure). */
export function applyCheckpointRead(
  state: CheckpointState,
  read: CheckpointRead,
): { state: CheckpointState; append: string; reset: boolean };

export interface RecordingCheckpoint {
  readonly partialPath: string | null;
  readonly enabled: boolean;
  readonly offset: number;
  readonly bytesWritten: number;
  readonly remainder: string;
  tick(): Promise<{ skipped: boolean; appended: string; bytesWritten: number }>;
}

export interface CreateRecordingCheckpointOptions {
  partialPath?: string | null;
  readChunk: (offset: number, chunkChars: number) => Promise<CheckpointRead>;
  appendText?: (path: string, text: string) => void;
  truncateFile?: (path: string) => void;
  intervalMs?: number;
  now?: () => number;
  chunkChars?: number;
}

/** Creates the incremental crash-safe checkpoint writer. */
export function createRecordingCheckpoint(
  options?: CreateRecordingCheckpointOptions,
): RecordingCheckpoint;

/** The recorder setup steps, in order (AH-0MWB6OFP50004VYE / AH-0MWB6OG5T007BYXP). */
export interface RecordingSetupSteps {
  listenServer: () => Promise<{ server: unknown; url: string }>;
  launchBrowser: () => Promise<unknown>;
  newPage: (browser: unknown) => Promise<unknown>;
  addRunEndedInitScript: (page: unknown) => Promise<void>;
  /** Optional bot-tuning seed; absent when no `--bot-config` was supplied. */
  addBotConfigInitScript?: (page: unknown) => Promise<void>;
  goto: (page: unknown, url: string) => Promise<void>;
  waitForSelector: (page: unknown) => Promise<void>;
  pressStartKeys: (page: unknown) => Promise<void>;
}

export interface RunRecordingSetupOptions {
  steps: RecordingSetupSteps;
  outputPath: string;
  partialPath?: string;
  /** Bytes a checkpoint had already captured; 0 during setup. */
  capturedBytes?: number;
  log?: (line: string) => void;
  /** Secondary diagnostic sink; never receives the actionable line. */
  stderr?: (line: string) => void;
  finalise?: typeof finaliseRecording;
}

export interface RunRecordingSetupResult {
  exitCode: number;
  rescued: boolean;
  /** Handles obtained so far; present on the rescue path too, for cleanup. */
  server?: unknown;
  browser?: unknown;
  page?: unknown;
  targetClosed?: boolean;
  error?: unknown;
}

/**
 * Runs the recorder's startup sequence through an injected step map and rescues
 * a failure at any step with the existing lost/salvaged line.
 */
export function runRecordingSetup(
  options: RunRecordingSetupOptions,
): Promise<RunRecordingSetupResult>;

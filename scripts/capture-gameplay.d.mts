/**
 * Type declarations for `scripts/capture-gameplay.mjs`
 * (AH-0MUX496IJ0041O3V). The browser/encode pipeline is exercised by
 * `npm run capture`; these declarations let the TypeScript test suite
 * type-check the pure argument/mode helpers without booting a browser.
 */

export interface CaptureOptions {
  durationMs: number;
  /** True when `--duration` was passed (legacy fixed-length capture). */
  fixedDuration: boolean;
  /** Post-signal tail in milliseconds (default `DEFAULT_CAPTURE_TAIL_MS`). */
  tailMs: number;
  /** Safety cap in milliseconds (default `DEFAULT_MAX_CAPTURE_DURATION_MS`). */
  maxDurationMs: number;
  warmupMs: number;
  output: string | null;
  /** Number of clips to record (default `DEFAULT_CAPTURE_COUNT`). */
  count: number;
  port: number;
  headed: boolean;
  keepServer: boolean;
  json: boolean;
  scripted: boolean;
  /** Dev scenario name passed to the game URL, or null (AH-0MUWZ5HCV0034H44). */
  scenario: string | null;
  help?: boolean;
}

/** Which capture path the options select. */
export type CaptureMode = 'demo' | 'scripted' | 'scenario';

/** One capture-start key and the delay to apply after dispatching it. */
export interface CaptureStartStep {
  key: string;
  delayAfterMs: number;
}

export const START_KEY_GAP_MS: number;

/** Clips per invocation when `--count` is omitted (1 = single-clip default). */
export const DEFAULT_CAPTURE_COUNT: number;

/** Page-side event the game dispatches when a run ends. */
export const RUN_ENDED_EVENT: string;
/** Read-only `window` flag the game mirrors the run outcome onto. */
export const RUN_ENDED_STATE_KEY: string;
/** Where the installed listener parks the latest captured event detail. */
export const RUN_ENDED_STORE_KEY: string;

/** The event/flag/store names the run-end listener plan carries. */
export interface RunEndedListenerPlan {
  eventName: string;
  stateKey: string;
  storeKey: string;
}

/** The page-side store the listener writes the latest event detail into. */
export interface RunEndedListenerStore {
  detail: unknown;
}

export function parseCaptureArgs(argv?: string[]): CaptureOptions;
/** Validates a `--count` value into a positive integer, or throws. */
export function parseCaptureCount(value: unknown): number;
/** Resolves the N output paths for a `--count` batch (indexed when > 1). */
export function resolveOutputPaths(
  requested: string | null | undefined,
  count?: number,
): string[];
export function resolveCaptureMode(options?: {
  scripted?: boolean;
  scenario?: string | null;
}): CaptureMode;
export function captureUrl(
  baseUrl: string,
  options?: { scenario?: string | null },
): string;
export function captureStartKeys(mode: CaptureMode): string[];
export function captureStartPlan(
  mode: CaptureMode,
  gapMs?: number,
): CaptureStartStep[];
export function buildRunEndedListenerPlan(): RunEndedListenerPlan;
export function installRunEndedListener(
  plan?: RunEndedListenerPlan,
  scope?: object,
): RunEndedListenerStore | null;
export function readRunEndedSignal(
  plan?: RunEndedListenerPlan,
  scope?: object,
): unknown;
export function captureExitCode(result?: {
  fullRun?: boolean;
  capHit?: boolean;
  nonTrivial?: boolean;
}): number;

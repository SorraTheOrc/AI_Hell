/**
 * Type declarations for the dependency-free `scripts/capture-run-lifecycle.mjs`
 * Node/game ESM module (AH-0MUXZ49PY0065K2O). The implementation is plain JS so
 * both the capture tool and the Vite game build can import it without a
 * TypeScript loader; these declarations let `capture-gameplay.mjs` and the game
 * code consume the pure run-lifecycle helpers without `any` leaks.
 */

/** The decoded end-of-run payload: victory/defeat and the final score. */
export interface RunEndedDetail {
  won: boolean;
  score: number;
}

/** One page-side observation of a run-end signal (event detail or flag). */
export interface RunEndedObservation {
  /** Present on the `window.__aiHellRunState` flag; `false` means not ended. */
  ended?: boolean;
  won?: unknown;
  score?: unknown;
}

/** Why the capture loop stopped: a run-end signal, or the safety cap. */
export type RunStopReason = 'signal' | 'cap';

/** Inputs to the pure wait-loop decision. All optional; defaults apply. */
export interface RunStopState {
  elapsedMs?: number;
  signalTimeMs?: number | null;
  tailMs?: number;
  maxDurationMs?: number;
}

/** The wait-loop decision returned by `evaluateRunStop`. */
export interface RunStopDecision {
  done: boolean;
  reason: RunStopReason | null;
  stopTimeMs: number;
  capHit: boolean;
}

/** Progress heartbeat emitted before each poll of `waitForRunEnd`. */
export interface RunEndWaitProgress {
  elapsedMs: number;
  maxDurationMs: number;
  signalTimeMs: number | null;
}

/** Injected dependencies for the pure `waitForRunEnd` loop. */
export interface RunEndWaitOptions {
  now?: () => number;
  readSignal?: () => unknown;
  sleep?: (ms: number) => unknown;
  pollMs?: number;
  tailMs?: number;
  maxDurationMs?: number;
  onProgress?: (state: RunEndWaitProgress) => void;
}

/** The terminal result of the `waitForRunEnd` loop. */
export interface RunEndWaitResult extends RunStopDecision {
  signal: RunEndedDetail | null;
  signalTimeMs: number | null;
  elapsedMs: number;
  runLengthMs: number;
}

/** Inputs to `summariseCaptureRun`. */
export interface CaptureRunInput {
  fullRun?: boolean;
  wait?: RunEndWaitResult | null;
  recordingMs?: number;
}

/** The run-outcome fields reported by a capture. */
export interface CaptureRunSummary {
  fullRun: boolean;
  complete: boolean | null;
  capHit: boolean;
  runOutcome: RunEndedDetail | null;
  runLengthMs: number;
}

/** Post-signal tail length in milliseconds. */
export const DEFAULT_CAPTURE_TAIL_MS: number;
/** Generous safety cap for a full-run recording, in milliseconds. */
export const DEFAULT_MAX_CAPTURE_DURATION_MS: number;
/** Default demo game-over dwell; at least `DEFAULT_CAPTURE_TAIL_MS`. */
export const DEMO_GAME_OVER_DWELL_MS: number;

export function buildRunEndedDetail(won: unknown, score: unknown): RunEndedDetail;
export function decodeRunEndedDetail(detail: unknown): RunEndedDetail | null;
export function computeStopTimeMs(
  signalTimeMs: number,
  tailMs: number,
  maxDurationMs: number,
): number;
export function capWasReachedWithoutSignal(
  signalTimeMs: number | null | undefined,
  elapsedMs: number,
  maxDurationMs: number,
): boolean;
export function evaluateRunStop(state?: RunStopState): RunStopDecision;
export function waitForRunEnd(
  options?: RunEndWaitOptions,
): Promise<RunEndWaitResult>;
export function summariseCaptureRun(
  capture?: CaptureRunInput,
): CaptureRunSummary;
export function resolveDemoGameOverDwellMs(
  configuredMs?: number,
  minMs?: number,
): number;
export function shouldDemoReturnToMenu(
  elapsedMs: number,
  dwellMs: number,
): boolean;

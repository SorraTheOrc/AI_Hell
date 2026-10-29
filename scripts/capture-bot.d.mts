/**
 * Type declarations for the dependency-free `scripts/capture-bot.mjs` Node
 * ESM module (AH-0MUWMFF3C002WOBK). The implementation is plain JS so the
 * capture tool runs without a TypeScript loader; these declarations let the
 * TypeScript test suite type-check against it.
 */

export interface BotStep {
  key: string;
  holdMs: number;
}

export interface VideoClipProbe {
  bytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  nonBlackFraction?: number;
  uniqueColours?: number;
  motion?: number;
  /** Recording's effective frame rate (`null`/absent = not judged). */
  effectiveFps?: number | null;
}

export interface NonTrivialVerdict {
  nonTrivial: boolean;
  reasons: string[];
}

export interface AudioTrackProbe {
  trackCount?: number;
  peak?: number;
  rms?: number;
  decodeError?: string;
}

export interface AudioTrackVerdict {
  hasAudioTrack: boolean;
  nonSilent: boolean;
  reasons: string[];
}

export interface CombinedClipVerdict {
  nonTrivial: boolean;
  reasons: string[];
}

export interface GameAudioTap {
  contexts(): unknown[];
  captureDestinations(): unknown[];
  getAudioTracks(): unknown[];
  audioTrackCount(): number;
  isContextRunning(): boolean;
}

export const MOVE_KEYS: readonly string[];
export const DEFAULT_CAPTURE_DURATION_MS: number;
export const DEFAULT_WARMUP_MS: number;
export const BASE_SWEEP_PATTERN: readonly BotStep[];
export const CAPTURE_MIME_CANDIDATES: readonly string[];
export const AUDIO_SILENCE_PEAK_FLOOR: number;
export const AUDIO_SILENCE_RMS_FLOOR: number;

export function buildScriptedPlan(
  durationMs?: number,
  pattern?: readonly BotStep[],
): BotStep[];
export function planDurationMs(plan: readonly BotStep[]): number;
/**
 * Lowest effective frame rate a recording may have and still count as a real
 * take (AH-0MVTI3O650064IM7). Below it the capture page was starved, so game
 * time barely advanced and scripted pay-offs cannot appear on camera.
 */
export const MIN_EFFECTIVE_FPS = 15;

export function isNonTrivialClip(probe?: VideoClipProbe): NonTrivialVerdict;
export function resolveCaptureMimeType(
  isSupported: (mimeType: string) => boolean,
): string | null;
export function evaluateAudioTrack(probe?: AudioTrackProbe): AudioTrackVerdict;
export function combineClipVerdict(
  videoVerdict?: NonTrivialVerdict,
  audioVerdict?: AudioTrackVerdict,
): CombinedClipVerdict;
export function installGameAudioTap(scope?: object): GameAudioTap | null;

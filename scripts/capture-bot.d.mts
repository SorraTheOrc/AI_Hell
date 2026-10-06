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
}

export interface NonTrivialVerdict {
  nonTrivial: boolean;
  reasons: string[];
}

export const MOVE_KEYS: readonly string[];
export const DEFAULT_CAPTURE_DURATION_MS: number;
export const DEFAULT_WARMUP_MS: number;
export const BASE_SWEEP_PATTERN: readonly BotStep[];

export function buildScriptedPlan(
  durationMs?: number,
  pattern?: readonly BotStep[],
): BotStep[];
export function planDurationMs(plan: readonly BotStep[]): number;
export function isNonTrivialClip(probe?: VideoClipProbe): NonTrivialVerdict;

/**
 * Type declarations for the dependency-free `scripts/capture-progress.mjs`
 * Node ESM module (AH-0MUWTNPY8003GGAA). The implementation is plain JS so
 * the capture tool runs without a TypeScript loader; these declarations let
 * the TypeScript test suite type-check against it.
 */

export function formatDuration(ms: number): string;
export function estimateRemainingMs(elapsedMs: number, totalMs: number): number;
export function formatProgress(
  elapsedMs: number,
  totalMs: number,
  width?: number,
): string;
export function formatAudioSummary(probe?: {
  audioTrackCount?: number;
  audioPeak?: number;
  audioRms?: number;
  audioDecodeError?: string;
}): string;
export function setupHint(dependency?: string): string;

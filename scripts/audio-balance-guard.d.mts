/**
 * Type declarations for the dependency-free `scripts/audio-balance-guard.mjs`
 * Node ESM module (AH-0MVCRKTRZ009Q2L8). The implementation is plain JS so
 * it can run under the project's Node CI without a TS loader; these
 * declarations let the TypeScript test suite type-check against it.
 */

import type { BuildManifest } from './build-audio.d.mts';

/** Amplitude tier for one enemy cue (parent AC2). */
export interface AmplitudeTier {
  /** Category RMS target; `at-or-below` tiers treat it as a ceiling. */
  targetRms: number;
  /** `at-or-below` (ambience) when present; otherwise a ±TIER_BAND_DB band. */
  mode?: 'at-or-below';
}

export interface WavAnalysis {
  rms: number;
  peak: number;
  channels: number;
  sampleRate: number;
  bitDepth: number;
  sampleCount: number;
}

export interface ScaleNote {
  note: number;
  frequency: number;
  centsOff: number;
}

export interface PitchPoint {
  node: string;
  source: string;
  value: number;
}

export interface BalanceGuardResult {
  ok: boolean;
  errors: string[];
  enemyCues: number;
}

export const REPO_ROOT: string;
export const MANIFEST_PATH: string;
export const TIER_BAND_DB: number;
export const PEAK_CEILING: number;
export const SCALE_CENTS_TOLERANCE: number;
export const VARIANT_SPREAD_DB: number;
export const VARIANT_CONSISTENCY_CUES: Set<string>;
export const ENEMY_TAGS: Set<string>;
export const ENEMY_CUE_EXTRAS: Set<string>;
export const AMPLITUDE_TIERS: Record<string, AmplitudeTier>;

export function analyzeWavBuffer(buffer: Buffer): WavAnalysis;
export function tierBounds(targetRms: number): { lower: number; upper: number };
export function rmsTierError(tier: AmplitudeTier, rms: number): string | null;
export function midiForFreq(freq: number): number;
export function nearestScaleNote(freq: number): ScaleNote;
export function isInAMinor(freq: number): boolean;
export function oscillatorPitchPoints(doc: Record<string, unknown>): PitchPoint[];
export function pitchConformanceErrors(
  doc: Record<string, unknown>,
  recipeName: string,
  options?: { centsTolerance?: number },
): string[];
export function recipeTags(recipeDir: string, recipeName: string): string[];
export function enemyCueEntries(
  manifest: BuildManifest,
  recipeDir: string,
): BuildManifest['cues'];
export function loadRecipe(recipeDir: string, recipeName: string): Record<string, unknown>;
export function verifyAudioBalance(options?: {
  manifestPath?: string;
  repoRoot?: string;
  logger?: { log: (...args: unknown[]) => void };
}): BalanceGuardResult;
export function main(
  argv?: string[],
  options?: { logger?: Console },
): number;

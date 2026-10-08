/**
 * Style-feature extraction from recorded telemetry
 * (AH-0MUY08XXN003NV0I, AC1/AC6).
 *
 * The first half of the style-matching pipeline: turn one recorded run — a
 * dev `record` capture or a headless evaluation run, both in the shipped
 * telemetry envelope — into a small, **pure**, comparable feature vector
 * describing *how* the player played:
 *
 * | Feature | Human-style meaning |
|---|---|---|
 * | reaction latency | how quickly the player responds to incoming fire |
 * | key-hold distribution | how long each input key is held (cadence) |
 * | target preferences | which category (mineral / power-up / enemy) they chase |
 * | engagement distances | how close they get before shooting / collecting |
 * | risk appetite | how much danger they accept (dodges vs hits, proximity) |
 *
 * Every raw statistic is delegated to the existing dev-tooling analyser
 * (`scripts/recording-analysis.mjs`) so a recorded human game and a headless
 * bot run are measured by exactly the same code — there is no second,
 * divergent implementation. This module only normalises and combines those
 * statistics; it reads no wall clock and performs no I/O, so the extraction
 * is deterministic and unit-testable (AC6).
 *
 * @module src/ai/style/features
 */

import {
  analyseRecording,
  HOLD_DURATION_BUCKETS,
  type RecordingAnalysis,
} from '../../../scripts/recording-analysis.mjs';
import type { RecordingRun } from '../../../scripts/recording.mjs';

/** Version of the extracted feature shape (bump on a breaking change). */
export const STYLE_FEATURE_VERSION = 1;

/** The objective categories the target-choice analysis distinguishes. */
export type TargetCategory = 'mineral' | 'powerUp' | 'enemy';

/** Every target-choice bucket (the objective categories plus "none"). */
export type TargetChoice = TargetCategory | 'none';

/**
 * Engagement distance (px) at which a player counts as "risk-neutral" for the
 * risk-appetite proxy. Mirrors the competent bot's default `engagementRange`,
 * so a player who engages at the bot's default standoff scores the midpoint.
 */
export const RISK_REFERENCE_ENGAGEMENT_PX = 160;

/** Key holds shorter than this (seconds) count as a "short" tap for the ratio. */
export const SHORT_HOLD_SECONDS = 0.25;

/** A comparable vector of human-play style features (AC1). */
export interface StyleFeatures {
  /** The extracted feature shape version. */
  readonly version: number;
  /** The run seed the features were extracted from. */
  readonly seed: number;
  /** Number of recorded ticks analysed. */
  readonly tickCount: number;
  /** Run duration in seconds. */
  readonly durationSeconds: number;
  /** Mean reaction-latency proxy (seconds), or `null` when unsampled. */
  readonly reactionLatencySeconds: number | null;
  /** Median reaction-latency proxy (seconds), or `null` when unsampled. */
  readonly medianReactionLatencySeconds: number | null;
  /** Mean key-hold duration (seconds), or `null` when unsampled. */
  readonly meanHoldSeconds: number | null;
  /** Longest key-hold duration (seconds), or `null` when unsampled. */
  readonly maxHoldSeconds: number | null;
  /** Fraction of key holds shorter than {@link SHORT_HOLD_SECONDS}. */
  readonly shortHoldRatio: number;
  /** Input changes per second (cadence). */
  readonly inputChangesPerSecond: number;
  /** Fraction of ticks aligned with each target category (sums to 1). */
  readonly targetRates: Readonly<Record<TargetChoice, number>>;
  /** The non-"none" category with the highest rate, or `'none'`. */
  readonly dominantTarget: TargetChoice;
  /** Mean distance (px) at which enemies were killed, or `null`. */
  readonly engagementDistanceEnemy: number | null;
  /** Mean distance (px) at which power-ups were picked up, or `null`. */
  readonly engagementDistancePowerUp: number | null;
  /** Mean distance (px) at which minerals were collected, or `null`. */
  readonly engagementDistanceMineral: number | null;
  /** Fraction of threat windows the player avoided (dodge rate). */
  readonly dodgeRate: number;
  /**
   * A 0..1 proxy for how much danger the player accepts: higher = riskier
   * (closes in on enemies and/or takes hits when threatened). Derived from the
   * engagement distance and the dodge rate; see {@link computeRiskAppetite}.
   */
  readonly riskAppetite: number;
}

/** Options for {@link extractStyleFeatures}. */
export interface StyleFeatureOptions {
  /** Override the tick length used by the reaction/hold proxies (seconds). */
  readonly dtSeconds?: number;
  /** Override the threat radius (px) for the reaction/dodge proxies. */
  readonly threatRadiusPx?: number;
}

/** Clamps a finite number into `[min, max]` (non-finite falls to `min`). */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Reads a finite mean distance from a `ValueStats`, or `null`. */
function meanOrNull(stats: { readonly mean: number | null }): number | null {
  return Number.isFinite(stats.mean) ? (stats.mean as number) : null;
}

/** Whether an unknown value looks like a precomputed {@link RecordingAnalysis}. */
function isAnalysis(value: unknown): value is RecordingAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RecordingAnalysis>;
  return (
    typeof candidate.summary === 'object' &&
    candidate.summary !== null &&
    typeof candidate.keyHolds === 'object' &&
    candidate.keyHolds !== null &&
    typeof candidate.dodge === 'object' &&
    candidate.dodge !== null
  );
}

/**
 * Resolves the analyser output from either a raw recording run or a
 * precomputed analysis, so callers holding the analysis reuse it (AC6).
 */
export function resolveAnalysis(
  input: RecordingRun | RecordingAnalysis,
  options: StyleFeatureOptions = {},
): RecordingAnalysis {
  return isAnalysis(input)
    ? input
    : analyseRecording(input, {
        dtSeconds: options.dtSeconds,
        threatRadiusPx: options.threatRadiusPx,
      });
}

/**
 * The risk-appetite proxy (0..1): the mean of the available components.
 *
 * - **closeness** — engaging enemies closer than
 *   {@link RISK_REFERENCE_ENGAGEMENT_PX} reads as riskier
 *   (`1 - d / reference`).
 * - **taken-hits** — a lower dodge rate (the player was hit in more threat
 *   windows) reads as riskier (`1 - dodgeRate`), available only when the run
 *   recorded at least one threat window.
 *
 * With neither component available the proxy is the neutral `0.5`.
 */
export function computeRiskAppetite(analysis: RecordingAnalysis): number {
  const components: number[] = [];
  const enemy = meanOrNull(analysis.engagementDistances.enemy);
  if (enemy !== null) {
    components.push(clamp(1 - enemy / RISK_REFERENCE_ENGAGEMENT_PX, 0, 1));
  }
  if (analysis.dodge.windows > 0) {
    components.push(clamp(1 - analysis.dodge.dodgeRate, 0, 1));
  }
  if (components.length === 0) return 0.5;
  return components.reduce((sum, value) => sum + value, 0) / components.length;
}

/** Fraction of key holds shorter than {@link SHORT_HOLD_SECONDS}. */
function shortHoldRatio(analysis: RecordingAnalysis): number {
  const histogram = analysis.keyHolds.overall.histogram;
  const total = histogram.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total === 0) return 0;
  // Map each histogram bucket's label back to its upper bound so the
  // threshold stays single-sourced in the analyser's bucket table.
  const short = histogram
    .filter((bucket) => {
      const spec = HOLD_DURATION_BUCKETS.find((entry) => entry.label === bucket.label);
      return spec !== undefined && spec.maxSeconds <= SHORT_HOLD_SECONDS;
    })
    .reduce((sum, bucket) => sum + bucket.count, 0);
  return short / total;
}

/** The longest key hold across channels (seconds), or `null` when unsampled. */
function longestHoldSeconds(analysis: RecordingAnalysis): number | null {
  const maxima = Object.values(analysis.keyHolds.byChannel)
    .map((entry) => entry.maxSeconds)
    .filter((value): value is number => Number.isFinite(value));
  return maxima.length > 0 ? Math.max(...maxima) : null;
}

/** The highest-rate non-"none" target category, or `'none'`. */
function dominantTarget(rates: Readonly<Record<TargetChoice, number>>): TargetChoice {
  let best: TargetChoice = 'none';
  let bestRate = 0;
  for (const category of ['mineral', 'powerUp', 'enemy'] as const) {
    if ((rates[category] ?? 0) > bestRate) {
      best = category;
      bestRate = rates[category] ?? 0;
    }
  }
  return best;
}

/**
 * Extracts the comparable style-feature vector from one recorded run (AC1).
 *
 * Accepts a raw {@link RecordingRun} (analysed on the fly) or a precomputed
 * {@link RecordingAnalysis}. Pure and deterministic.
 */
export function extractStyleFeatures(
  input: RecordingRun | RecordingAnalysis,
  options: StyleFeatureOptions = {},
): StyleFeatures {
  const analysis = resolveAnalysis(input, options);
  const rates: Record<TargetChoice, number> = {
    mineral: analysis.targetChoice.rates.mineral ?? 0,
    powerUp: analysis.targetChoice.rates.powerUp ?? 0,
    enemy: analysis.targetChoice.rates.enemy ?? 0,
    none: analysis.targetChoice.rates.none ?? 0,
  };
  return {
    version: STYLE_FEATURE_VERSION,
    seed: analysis.runSeed,
    tickCount: analysis.summary.ticks,
    durationSeconds: analysis.summary.durationSeconds,
    reactionLatencySeconds: Number.isFinite(analysis.reactionLatency.meanSeconds)
      ? (analysis.reactionLatency.meanSeconds as number)
      : null,
    medianReactionLatencySeconds: Number.isFinite(analysis.reactionLatency.medianSeconds)
      ? (analysis.reactionLatency.medianSeconds as number)
      : null,
    meanHoldSeconds: Number.isFinite(analysis.keyHolds.overall.meanSeconds)
      ? (analysis.keyHolds.overall.meanSeconds as number)
      : null,
    maxHoldSeconds: longestHoldSeconds(analysis),
    shortHoldRatio: shortHoldRatio(analysis),
    inputChangesPerSecond: analysis.inputCadence.changesPerSecond,
    targetRates: rates,
    dominantTarget: dominantTarget(rates),
    engagementDistanceEnemy: meanOrNull(analysis.engagementDistances.enemy),
    engagementDistancePowerUp: meanOrNull(analysis.engagementDistances.powerUp),
    engagementDistanceMineral: meanOrNull(analysis.engagementDistances.mineral),
    dodgeRate: analysis.dodge.dodgeRate,
    riskAppetite: computeRiskAppetite(analysis),
  };
}

/**
 * Style-feature distance for the style-matching pipeline
 * (AH-0MUY08XXN003NV0I, AC4).
 *
 * A single scalar that answers "how close is this bot's play to the human's?"
 * so a styled bot can be compared against the default competent bot on the
 * **same seed**. It is the weighted, scale-normalised sum of the per-feature
 * differences produced by {@link extractStyleFeatures}; every component is
 * skipped when either side lacks a sample (so a featureless run never
 * manufactures a difference). Lower is closer.
 *
 * The distance is deliberately simple and interpretable — no learned metric —
 * so the evaluation report can show which feature moved. It is a directional
 * tuning signal, not a perceptual model.
 *
 * @module src/ai/style/distance
 */

import type { StyleFeatures } from './features';

/** Per-feature scale/weight used by {@link styleDistance}. */
interface FeatureScale {
  /** Difference at which this feature contributes its full weight. */
  readonly scale: number;
  /** Relative importance of the feature in the total. */
  readonly weight: number;
}

/**
 * The feature scales/weights. Fittable features (reaction/holds/cadence,
 * engagement distance, target preference, risk) carry the weight, because
 * those are what {@link fitStyle} can actually move; the collection-distance
 * features are near-constant and are de-emphasised.
 */
export const STYLE_FEATURE_SCALES = Object.freeze({
  reactionLatencySeconds: { scale: 0.25, weight: 1 } as FeatureScale,
  meanHoldSeconds: { scale: 0.25, weight: 1 } as FeatureScale,
  shortHoldRatio: { scale: 1, weight: 0.5 } as FeatureScale,
  inputChangesPerSecond: { scale: 1.5, weight: 0.5 } as FeatureScale,
  targetRates: { scale: 1, weight: 1.5 } as FeatureScale,
  engagementDistanceEnemy: { scale: 120, weight: 1 } as FeatureScale,
  engagementDistancePowerUp: { scale: 250, weight: 0.5 } as FeatureScale,
  engagementDistanceMineral: { scale: 60, weight: 0.5 } as FeatureScale,
  riskAppetite: { scale: 1, weight: 1 } as FeatureScale,
} as const);

/** The breakdown of a {@link styleDistance} result. */
export interface StyleDistanceBreakdown {
  /** The weighted total (lower = closer). */
  readonly total: number;
  /** Each feature's weighted contribution to the total. */
  readonly components: Readonly<Record<string, number>>;
}

/** A finite component contribution, or `null` when either side is unsampled. */
function component(a: number | null, b: number | null, spec: FeatureScale): number | null {
  if (a === null || b === null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (spec.weight * Math.abs(a - b)) / spec.scale;
}

/** L1 distance between two target-rate vectors, skipping no categories. */
function targetRateDistance(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const category of ['mineral', 'powerUp', 'enemy'] as const) {
    total += Math.abs((a[category] ?? 0) - (b[category] ?? 0));
  }
  return total;
}

/**
 * Weighted, scaled distance between two style-feature vectors (AC4). Lower is
 * closer; `0` means every sampled feature matches.
 */
export function styleDistance(a: StyleFeatures, b: StyleFeatures): number {
  return styleDistanceBreakdown(a, b).total;
}

/** The per-feature breakdown of {@link styleDistance}. */
export function styleDistanceBreakdown(
  a: StyleFeatures,
  b: StyleFeatures,
): StyleDistanceBreakdown {
  const scalers = STYLE_FEATURE_SCALES;
  const components: Record<string, number> = {};

  const assign = (key: keyof typeof scalers, value: number | null): void => {
    if (value !== null) components[key] = value;
  };

  assign('reactionLatencySeconds', component(a.reactionLatencySeconds, b.reactionLatencySeconds, scalers.reactionLatencySeconds));
  assign('meanHoldSeconds', component(a.meanHoldSeconds, b.meanHoldSeconds, scalers.meanHoldSeconds));
  assign('shortHoldRatio', component(a.shortHoldRatio, b.shortHoldRatio, scalers.shortHoldRatio));
  assign('inputChangesPerSecond', component(a.inputChangesPerSecond, b.inputChangesPerSecond, scalers.inputChangesPerSecond));
  assign(
    'targetRates',
    (scalers.targetRates.weight * targetRateDistance(a.targetRates, b.targetRates)) /
      scalers.targetRates.scale,
  );
  assign('engagementDistanceEnemy', component(a.engagementDistanceEnemy, b.engagementDistanceEnemy, scalers.engagementDistanceEnemy));
  assign('engagementDistancePowerUp', component(a.engagementDistancePowerUp, b.engagementDistancePowerUp, scalers.engagementDistancePowerUp));
  assign('engagementDistanceMineral', component(a.engagementDistanceMineral, b.engagementDistanceMineral, scalers.engagementDistanceMineral));
  assign('riskAppetite', component(a.riskAppetite, b.riskAppetite, scalers.riskAppetite));

  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { total, components };
}

/**
 * Style matching from telemetry — public surface
 * (AH-0MUY08XXN003NV0I, child 9 of epic AH-0MUY089KR003F8S4).
 *
 * Two paths, parameter fitting preferred (AC2):
 *
 * ```ts
 * import {
 *   extractStyleFeatures,
 *   fitStyle,
 *   createImitationPolicy,
 *   trainImitationPolicy,
 *   evaluateStyleMatch,
 *   styleDistance,
 * } from './ai/style';
 *
 * // 1. Extract a style profile from a recording.
 * const features = extractStyleFeatures(humanRun);
 *
 * // 2. Fit the structured bot's tunables to it (safety-checked).
 * const fit = fitStyle(features);
 *
 * // 3. Optionally clone the recorded actions directly (stretch, AC3).
 * const imitation = createImitationPolicy(trainImitationPolicy(humanRun));
 *
 * // 4. Evaluate the styled bot against the default on the human's seed.
 * const report = evaluateStyleMatch(humanRun);
 * console.log(report.closer, report.regressed);
 * ```
 *
 * See `docs/STYLE_MATCHING.md` for how to fit and evaluate a style.
 *
 * @module src/ai/style
 */

export {
  RISK_REFERENCE_ENGAGEMENT_PX,
  SHORT_HOLD_SECONDS,
  STYLE_FEATURE_VERSION,
  computeRiskAppetite,
  extractStyleFeatures,
  resolveAnalysis,
  type StyleFeatureOptions,
  type StyleFeatures,
  type TargetCategory,
  type TargetChoice,
} from './features';

export {
  STYLE_FEATURE_SCALES,
  styleDistance,
  styleDistanceBreakdown,
  type StyleDistanceBreakdown,
} from './distance';

export {
  BAND_GAP,
  MAX_BAND_BASE,
  MIN_BAND_BASE,
  STYLE_FIT_VERSION,
  SURVIVAL_GAP,
  defaultFit,
  enforceSafety,
  fitStyle,
  targetBandTilt,
  type FitApplication,
  type FitStyleOptions,
  type StyleFit,
} from './fitting';

export {
  IMITATION_DATASET_VERSION,
  IMITATION_FEATURE_COUNT,
  IMITATION_FEATURE_SCALE_PX,
  createImitationPolicy,
  observationFeatures,
  trainImitationPolicy,
  type ImitationDataset,
  type ImitationSample,
  type ImitationTrainingOptions,
} from './imitation';

export {
  STYLE_MATCH_REPORT_VERSION,
  evaluateStyleMatch,
  formatStyleMatchReport,
  type EvaluateStyleOptions,
  type StyleMatchReport,
  type StyleMatchSide,
} from './evaluation';

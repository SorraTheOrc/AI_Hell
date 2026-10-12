/**
 * Style-match evaluation: is the styled bot measurably closer to the human?
 * (AH-0MUY08XXN003NV0I, AC4).
 *
 * Runs the **default** structured bot and the **fitted** (styled) bot on the
 * human recording's own seed — the same-seed evaluation harness, so scenario
 * variance cancels — then measures, for each:
 *
 * - the {@link styleDistance} between the bot's play and the human's play,
 * - the competence metrics (objective score, survival) from the harness.
 *
 * The report states whether the styled bot is closer to the human and whether
 * it did so **without regressing competence or survival**. It is pure and
 * deterministic: the arena, the metrics and the feature extraction all draw
 * only from the seed and the policies.
 *
 * @module src/ai/style/evaluation
 */

import { runArena } from '../eval/arena';
import {
  extractMetricPoint,
  recordingRunFromRecords,
  type MetricPoint,
} from '../eval/metrics';
import type { ArenaSpawns, EvalBuild } from '../eval/types';
import { createCompetentBotBrain } from '../framework/competent';
import type { RecordingRun } from '../../../scripts/recording.mjs';
import {
  extractStyleFeatures,
  resolveAnalysis,
  type StyleFeatures,
} from './features';
import { styleDistance, styleDistanceBreakdown } from './distance';
import { fitStyle, type FitStyleOptions, type StyleFit } from './fitting';
import type { RecordingAnalysis } from '../../../scripts/recording-analysis.mjs';

/** Version of the style-match report shape (bump on a breaking change). */
export const STYLE_MATCH_REPORT_VERSION = 1;

/** One side of a style-match evaluation (a bot's play vs the human). */
export interface StyleMatchSide {
  /** The bot's extracted style features. */
  readonly features: StyleFeatures;
  /** The bot's competence metrics. */
  readonly point: MetricPoint;
  /** Weighted style distance to the human (lower is closer). */
  readonly distance: number;
  /** Per-feature contribution to {@link distance}. */
  readonly distanceBreakdown: Readonly<Record<string, number>>;
}

/** The result of comparing a styled bot and the default bot to a human run. */
export interface StyleMatchReport {
  readonly version: number;
  /** The seed both bots were evaluated on (the human's seed). */
  readonly humanSeed: number;
  /** The human's extracted style. */
  readonly human: StyleFeatures;
  /** The fitted tunables the styled bot used. */
  readonly fit: StyleFit;
  /** The default structured bot's side. */
  readonly structured: StyleMatchSide;
  /** The fitted/styled bot's side. */
  readonly styled: StyleMatchSide;
  /** Whether the styled bot is strictly closer to the human. */
  readonly closer: boolean;
  /** `structured.distance - styled.distance` (positive = improvement). */
  readonly distanceImprovement: number;
  /** Styled objective score minus the structured score. */
  readonly competenceDelta: number;
  /** Styled survival seconds minus the structured survival. */
  readonly survivalDelta: number;
  /** Whether the styled bot regressed competence/survival beyond tolerance. */
  readonly regressed: boolean;
  /** The tolerance used for the regression check. */
  readonly competenceTolerance: number;
}

/** Options for {@link evaluateStyleMatch}. */
export interface EvaluateStyleOptions {
  /** Maximum ticks per arena run. Defaults to 1800. */
  readonly ticks?: number;
  /** Fixed simulation step (seconds). Defaults to 1/60. */
  readonly dt?: number;
  /** Entity counts for the arena scenario. */
  readonly spawns?: Partial<ArenaSpawns>;
  /** Build metadata stamped into the run header. */
  readonly build?: EvalBuild;
  /**
   * How much the styled bot may lose (objective score and survival seconds)
   * before it counts as a competence regression. Defaults to 1.
   */
  readonly competenceTolerance?: number;
  /** Forwarded to {@link fitStyle} (custom base tunables). */
  readonly fit?: FitStyleOptions;
}

/** Builds one side of the report from a bot's run. */
function sideFor(human: StyleFeatures, run: RecordingRun): StyleMatchSide {
  const features = extractStyleFeatures(run);
  const breakdown = styleDistanceBreakdown(human, features);
  return {
    features,
    point: extractMetricPoint(run),
    distance: breakdown.total,
    distanceBreakdown: breakdown.components,
  };
}

/**
 * Evaluates whether the styled bot is closer to a human recording than the
 * default structured bot, on the human's seed (AC4).
 *
 * @param human — the human recording (raw run) or its precomputed analysis.
 */
export function evaluateStyleMatch(
  human: RecordingRun | RecordingAnalysis,
  options: EvaluateStyleOptions = {},
): StyleMatchReport {
  const humanFeatures = extractStyleFeatures(resolveAnalysis(human));
  const fit = fitStyle(humanFeatures, options.fit);
  const ticks = options.ticks ?? 1800;
  const common = {
    seed: humanFeatures.seed,
    ticks,
    dt: options.dt,
    spawns: options.spawns,
    build: options.build,
  };

  const structuredRun = recordingRunFromRecords(
    runArena(createCompetentBotBrain(), common).records,
  );
  const styledRun = recordingRunFromRecords(
    runArena(createCompetentBotBrain({ tunables: fit.tunables }), {
      ...common,
      humanInput: fit.humanInput,
    }).records,
  );

  const structured = sideFor(humanFeatures, structuredRun);
  const styled = sideFor(humanFeatures, styledRun);

  const tolerance = options.competenceTolerance ?? 1;
  const competenceDelta = styled.point.score - structured.point.score;
  const survivalDelta = styled.point.survivalSeconds - structured.point.survivalSeconds;
  const regressed = competenceDelta < -tolerance || survivalDelta < -tolerance;
  const distanceImprovement = structured.distance - styled.distance;

  return {
    version: STYLE_MATCH_REPORT_VERSION,
    humanSeed: humanFeatures.seed,
    human: humanFeatures,
    fit,
    structured,
    styled,
    closer: styled.distance < structured.distance,
    distanceImprovement,
    competenceDelta,
    survivalDelta,
    regressed,
    competenceTolerance: tolerance,
  };
}

/** Formats a style-match report as a readable text block (for the CLI). */
export function formatStyleMatchReport(report: StyleMatchReport): string {
  const lines: string[] = [];
  lines.push(`Style match report (seed ${report.humanSeed}, v${report.version})`);
  lines.push(
    `  dominant target: ${report.human.dominantTarget} ` +
      `(risk appetite ${report.human.riskAppetite.toFixed(2)}, ` +
      `dodge rate ${report.human.dodgeRate.toFixed(2)})`,
  );
  lines.push('');
  lines.push('  side        style distance   score    survival s');
  lines.push(
    `  structured  ${report.structured.distance.toFixed(3).padStart(14)} ` +
      `${report.structured.point.score.toFixed(1).padStart(8)} ` +
      `${report.structured.point.survivalSeconds.toFixed(2).padStart(11)}`,
  );
  lines.push(
    `  styled      ${report.styled.distance.toFixed(3).padStart(14)} ` +
      `${report.styled.point.score.toFixed(1).padStart(8)} ` +
      `${report.styled.point.survivalSeconds.toFixed(2).padStart(11)}`,
  );
  lines.push('');
  lines.push(
    `  closer to human: ${report.closer ? 'yes' : 'no'} ` +
      `(improvement ${report.distanceImprovement.toFixed(3)})`,
  );
  lines.push(
    `  competence delta: ${report.competenceDelta.toFixed(1)}, ` +
      `survival delta: ${report.survivalDelta.toFixed(2)} ` +
      `(regressed: ${report.regressed ? 'yes' : 'no'})`,
  );
  if (report.fit.applied.length > 0) {
    lines.push('');
    lines.push('  fitted knobs:');
    for (const application of report.fit.applied) {
      lines.push(
        `    ${application.knob} = ${Number(application.value.toFixed(4))} ` +
          `(${application.reason})`,
      );
    }
  }
  if (report.fit.warnings.length > 0) {
    lines.push('');
    lines.push('  warnings:');
    for (const warning of report.fit.warnings) lines.push(`    ${warning}`);
  }
  return lines.join('\n');
}

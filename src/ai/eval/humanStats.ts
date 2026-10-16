/**
 * Shared human balance-statistics extraction
 * (AH-0MV7WVEWL005XEMN AC1/AC2/AC4).
 *
 * Converts a recorded human session's flat telemetry record stream into
 * per-run {@link BalanceRunStats} (one per `run_header`) plus a single
 * {@link BalanceAggregate}, packaged as a versioned {@link BalanceReport}
 * labelled with a `human` pseudo-policy. A recorded human game emits the
 * same `run_header` / `tick` / `event` envelope as a headless bot run, so the
 * human report is directly comparable to a bot batch report on one schema.
 *
 * Pure, clock-free and I/O-free: it reuses
 * {@link extractBalanceStats} and {@link aggregateBalanceStats} from the
 * automated-balancing framework (no divergent copy), so bot and human
 * statistics can never drift.
 *
 * @module src/ai/eval/humanStats
 */

import { aggregateBalanceStats, extractBalanceStats } from './metrics';
import { buildBalanceReport, fnv1aHash, stableStringify, type BalanceReport } from './report';
import type { BatchedRunSummary } from './engine';
import {
  type BalanceAggregate,
  type BalanceRunStats,
  type TelemetryRecord,
} from './types';

/** The pseudo-policy name carrying a human session in a balance report. */
export const HUMAN_BALANCE_POLICY = 'human';

/**
 * The simulation step assumed for a recorded human tick when the recording
 * does not state one (60 Hz), matching the shared balance extractor.
 */
export const HUMAN_BALANCE_DT_SECONDS = 1 / 60;

/** Optional knobs for {@link extractHumanBalanceStats}. */
export interface HumanBalanceStatsOptions {
  /**
   * Seconds per recorded tick for survival-time derivation. Defaults to
   * {@link HUMAN_BALANCE_DT_SECONDS} (1/60 s).
   */
  readonly dtSeconds?: number;
  /**
   * The recording's state sampling stride, surfaced in the report config so a
   * consumer interprets the tick numbers correctly. Defaults to `1`.
   */
  readonly sampleEveryTicks?: number;
  /** The pseudo-policy label. Defaults to {@link HUMAN_BALANCE_POLICY}. */
  readonly policy?: string;
}

/** The shared human balance-statistics result. */
export interface HumanBalanceStats {
  /** One summary per recorded run (mirrors the bot batch's `runs`). */
  readonly runs: readonly BatchedRunSummary[];
  /** The same per-run statistics without the bookkeeping fields. */
  readonly stats: readonly BalanceRunStats[];
  /** The single aggregate across every recorded run. */
  readonly aggregate: BalanceAggregate;
  /** The versioned, byte-stable `BalanceReport` (`kind: 'balance'`). */
  readonly report: BalanceReport;
}

/** Coerces a positive finite option, else `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/** Coerces a positive integer option, else `fallback`. */
function positiveIntOr(value: number | undefined, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

/**
 * Splits a flat telemetry record stream at `run_header` boundaries. Records
 * before the first header are ignored (they belong to no run), matching
 * `parseRecording`'s run grouping. Each returned array starts with its header.
 */
function splitIntoRuns(
  records: readonly TelemetryRecord[],
): TelemetryRecord[][] {
  const runs: TelemetryRecord[][] = [];
  let current: TelemetryRecord[] | null = null;
  for (const record of records) {
    if (record.kind === 'run_header') {
      current = [record];
      runs.push(current);
    } else if (current !== null) {
      current.push(record);
    }
  }
  return runs;
}

/** The highest recorded tick across the stream (`-1` when there is none). */
function highestTick(records: readonly TelemetryRecord[]): number {
  let max = -1;
  for (const record of records) {
    if (record.kind === 'run_header') continue;
    max = Math.max(max, record.tick);
  }
  return max;
}

/**
 * Extracts the shared balance statistics from a recorded human session
 * (AC1/AC2/AC4).
 *
 * Every `run_header` opens a new run; each run is reduced through
 * {@link extractBalanceStats} (seed attributed from its header) and all runs
 * are aggregated by {@link aggregateBalanceStats} into one
 * {@link BalanceAggregate} using {@link BALANCE_STATISTICS_SCHEMA_VERSION}.
 * The output is packaged by {@link buildBalanceReport} as a `kind: 'balance'`
 * report whose sole policy is the `human` pseudo-policy.
 *
 * An empty stream yields a deterministic, well-formed report (zero runs, an
 * empty aggregate) without throwing.
 *
 * @param records - A flat telemetry record stream (a recorded human session).
 * @param options - Optional labelling / timing knobs.
 */
export function extractHumanBalanceStats(
  records: readonly TelemetryRecord[],
  options: HumanBalanceStatsOptions = {},
): HumanBalanceStats {
  const dtSeconds = positiveOr(options.dtSeconds, HUMAN_BALANCE_DT_SECONDS);
  const sampleEveryTicks = positiveIntOr(options.sampleEveryTicks, 1);
  const policy = options.policy ?? HUMAN_BALANCE_POLICY;

  const runRecords = splitIntoRuns(records);
  const stats = runRecords.map((run) =>
    extractBalanceStats(run, { dtSeconds }),
  );
  const runs: BatchedRunSummary[] = runRecords.map((run, index) => ({
    policy,
    seed: stats[index].seed,
    stats: stats[index],
    recordsHash: fnv1aHash(stableStringify(run)),
    recordCount: run.length,
  }));
  const aggregate = aggregateBalanceStats(stats);
  const ticks = Math.max(0, highestTick(records) + 1);
  const report = buildBalanceReport({
    policies: [policy],
    seeds: stats.map((point) => point.seed),
    ticks,
    dt: dtSeconds,
    sampleEveryTicks,
    runs,
    aggregate,
  });

  return { runs, stats, aggregate, report };
}

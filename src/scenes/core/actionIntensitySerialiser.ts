/**
 * Standalone action-intensity time-series serialiser (AH-0MUZQF0FR008WRNM;
 * decision doc `docs/dev/action-intensity.md` §7.2–§7.3).
 *
 * The per-tick metric rides the versioned telemetry envelope (§7.1), but
 * consumers that want the series on its own — analysis tooling, the video
 * highlighter — read a small, self-describing **JSONL** artefact instead.
 * This module is that artefact's format: it is **pure** (it only reads its
 * arguments and returns strings/objects), so it can be used from tooling and
 * unit-tested hermetically.
 *
 * Layout (one JSON object per line):
 *
 * 1. a **header** line carrying `schemaVersion`, `runSeed`, `sampleRateHz`
 *    and the ordered `categories` list, so a consumer can map a breakdown
 *    without hard-coding category names; and
 * 2. one **sample** line per recorded tick, carrying `schemaVersion`, `t`
 *    (milliseconds since run start), `tick`, the four scores and the
 *    per-category `breakdown`.
 *
 * `schemaVersion` is on the header **and** every sample line, so a truncated
 * file is still self-identifying. The writer is tolerant of partial runs —
 * a series with no samples is a header-only file, and a consumer skips
 * malformed/truncated lines rather than failing the whole read.
 *
 * The file location/naming convention (`capture-output/<run-id>.action.jsonl`)
 * is fixed by {@link actionIntensitySeriesFileName} /
 * {@link actionIntensitySeriesPath} so it sits alongside the captured WebM
 * with a matching basename (§7.3). `capture-output/` is git-ignored.
 *
 * @module scenes/core/actionIntensitySerialiser
 */

import {
  ACTION_INTENSITY_CATEGORIES,
  type ActionIntensityCategory,
  type ActionIntensityCounts,
  type ActionIntensitySample,
} from './actionIntensity';
import { TELEMETRY_SCHEMA_VERSION } from '../../telemetry';

/** The series-format version, matching the telemetry envelope (§7.2). */
export const ACTION_INTENSITY_SERIES_SCHEMA_VERSION = TELEMETRY_SCHEMA_VERSION;

/** The git-ignored directory the captured WebM and series live in (§7.3). */
export const ACTION_INTENSITY_SERIES_DIR = 'capture-output';

/** The file extension for the derived series artefact. */
export const ACTION_INTENSITY_SERIES_EXTENSION = '.action.jsonl';

/** The self-describing first line of a series file (§7.2). */
export interface ActionIntensitySeriesHeader {
  readonly schemaVersion: number;
  readonly runSeed: number;
  readonly sampleRateHz: number;
  readonly categories: readonly ActionIntensityCategory[];
}

/** One sample line of a series file (§7.2). */
export interface ActionIntensitySeriesLine {
  readonly schemaVersion: number;
  /** Milliseconds since run start. */
  readonly t: number;
  /** Zero-based simulation tick the sample was taken on. */
  readonly tick: number;
  readonly rawScore: number;
  readonly intensity: number;
  readonly smoothed: number;
  readonly burstiness: number;
  readonly breakdown: ActionIntensityCounts;
}

/** A sampled tick to serialise: the run clock plus the computed sample. */
export interface ActionIntensitySeriesSampleInput {
  /** Milliseconds since run start (the recorded `t`). */
  readonly t: number;
  /** Zero-based simulation tick. */
  readonly tick: number;
  /** The computed fallback metric sample for this tick. */
  readonly actionIntensity: ActionIntensitySample;
}

/** The input to {@link serialiseActionIntensitySeries}. */
export interface ActionIntensitySeriesInput {
  /** The per-run RNG seed from the telemetry run header. */
  readonly runSeed: number;
  /** The recording/sampling rate in Hz. */
  readonly sampleRateHz: number;
  /** The recorded samples, in run order. */
  readonly samples: readonly ActionIntensitySeriesSampleInput[];
}

/** The parsed contents of a series file (best-effort, tolerant of truncation). */
export interface ParsedActionIntensitySeries {
  /** The header, or `null` when the first valid line was not a header. */
  readonly header: ActionIntensitySeriesHeader | null;
  /** All valid sample lines (malformed/truncated lines are skipped). */
  readonly samples: readonly ActionIntensitySeriesLine[];
}

/** Builds the header for a run. */
export function buildActionIntensitySeriesHeader(
  runSeed: number,
  sampleRateHz: number,
): ActionIntensitySeriesHeader {
  return {
    schemaVersion: ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
    runSeed,
    sampleRateHz,
    categories: [...ACTION_INTENSITY_CATEGORIES],
  };
}

/** Serialises one input sample to its JSONL object. */
export function actionIntensitySeriesLine(
  sample: ActionIntensitySeriesSampleInput,
): ActionIntensitySeriesLine {
  const { rawScore, intensity, smoothed, burstiness, breakdown } =
    sample.actionIntensity;
  return {
    schemaVersion: ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
    t: sample.t,
    tick: sample.tick,
    rawScore,
    intensity,
    smoothed,
    burstiness,
    breakdown: { ...breakdown },
  };
}

/**
 * Serialises a run's samples to the JSONL artefact (§7.2).
 *
 * Returns a header line followed by one line per sample, each terminated by a
 * newline (so the file is append-friendly). An empty `samples` array yields a
 * header-only file.
 *
 * @param input - The run seed, sample rate and recorded samples.
 */
export function serialiseActionIntensitySeries(
  input: ActionIntensitySeriesInput,
): string {
  const lines: string[] = [
    JSON.stringify(
      buildActionIntensitySeriesHeader(input.runSeed, input.sampleRateHz),
    ),
  ];
  for (const sample of input.samples) {
    lines.push(JSON.stringify(actionIntensitySeriesLine(sample)));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parses a series artefact, tolerating partial runs and truncated files.
 *
 * The first valid JSON line is treated as the header; subsequent valid lines
 * are samples. Lines that are empty or fail to parse (for example a half
 * written trailing line) are skipped, so a run interrupted mid-write is still
 * readable. Sample lines missing a finite `t` are also skipped.
 *
 * @param jsonl - The raw file contents.
 */
export function parseActionIntensitySeries(
  jsonl: string,
): ParsedActionIntensitySeries {
  let header: ActionIntensitySeriesHeader | null = null;
  const samples: ActionIntensitySeriesLine[] = [];

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // truncated / malformed line — tolerate it
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    if (header === null && Array.isArray(record.categories)) {
      header = {
        schemaVersion: Number(record.schemaVersion),
        runSeed: Number(record.runSeed),
        sampleRateHz: Number(record.sampleRateHz),
        categories: (record.categories as string[]).filter(
          (category): category is ActionIntensityCategory =>
            (ACTION_INTENSITY_CATEGORIES as readonly string[]).includes(category),
        ),
      };
      continue;
    }
    if (!Number.isFinite(Number(record.t))) continue;
    if (!record.breakdown || typeof record.breakdown !== 'object') continue;
    samples.push(record as unknown as ActionIntensitySeriesLine);
  }

  return { header, samples };
}

/**
 * The file name for a run's series, derived from the capture basename so it
 * sits alongside the WebM with a matching stem (§7.3):
 * `gameplay-<timestamp>` → `gameplay-<timestamp>.action.jsonl`.
 */
export function actionIntensitySeriesFileName(runId: string): string {
  return `${runId}${ACTION_INTENSITY_SERIES_EXTENSION}`;
}

/**
 * The git-ignored path for a run's series, alongside the capture output
 * (§7.3): `capture-output/<run-id>.action.jsonl`.
 */
export function actionIntensitySeriesPath(
  runId: string,
  directory: string = ACTION_INTENSITY_SERIES_DIR,
): string {
  return `${directory}/${actionIntensitySeriesFileName(runId)}`;
}

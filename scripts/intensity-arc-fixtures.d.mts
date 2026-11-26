/**
 * Type declarations for the pure `scripts/intensity-arc-fixtures.mjs` fixture
 * builders (AH-0MWPD4OZH001M74F). The implementation is plain ESM JavaScript
 * so the Node scripts and the Vitest suite can consume it without a TypeScript
 * loader.
 */

import type { CaptureJoinAnchor } from './capture-series.mjs';

/** One half-open, constant-intensity plateau in series time (`t`, ms). */
export interface IntensityPlateau {
  fromT: number;
  toT: number;
  intensity: number;
}

/** Options shared by the plateau/series builders. */
export interface FixtureBuildOptions {
  /** Sampling rate written to the header; defaults to 10 Hz. */
  sampleRateHz?: number;
  /** Deterministic run seed written to the header. */
  runSeed?: number;
  /** First `tick` value; defaults to 0. */
  startTick?: number;
  /**
   * Omit `intensity` from every sample (the deliberate `no-samples` fixture).
   * The remaining scores are still written, so the line stays schema-valid.
   */
  omitIntensity?: boolean;
}

/** One built series sample, shaped like the serialiser's input. */
export interface BuiltSeriesSample {
  t: number;
  tick: number;
  actionIntensity: {
    rawScore: number;
    smoothed: number;
    burstiness: number;
    breakdown: Record<string, number>;
    /** Absent when `omitIntensity` is set. */
    intensity?: number;
  };
}

/** A built series, ready for `serialiseActionIntensitySeries`. */
export interface BuiltIntensitySeries {
  runSeed: number;
  sampleRateHz: number;
  samples: BuiltSeriesSample[];
}

/** The two epoch-ms markers a join anchor is built from (`null` ⇒ approximate). */
export interface FixtureAnchorMarkers {
  runStartedAtEpochMs: number | null;
  captureStartedAtEpochMs: number | null;
}

/** One capture stem in the committed corpus. */
export interface IntensityArcFixtureCase {
  name: string;
  plateaus: ReadonlyArray<IntensityPlateau>;
  /** `null` ⇒ no `.capture.json` is written (missing-anchor case). */
  anchor: FixtureAnchorMarkers | null;
  /** Omit `intensity` from the sample lines (the `no-samples` fixture). */
  omitIntensity?: boolean;
}

/** One parsed series sample line (validated, still open for extra fields). */
export interface ParsedSeriesSample {
  schemaVersion: number;
  t: number;
  tick: number;
  rawScore: number;
  intensity?: number;
  smoothed: number;
  burstiness: number;
  breakdown: Record<string, number>;
  [field: string]: unknown;
}

/** The validated series header (`docs/dev/action-intensity.md` §7.2). */
export interface SeriesFixtureHeader {
  schemaVersion: number;
  runSeed: number;
  sampleRateHz: number;
  categories: string[];
}

/** Options for `parseSeriesFixture`. */
export interface ParseSeriesFixtureOptions {
  /** Require a finite `intensity` on every sample; defaults to `true`. */
  requireIntensity?: boolean;
  /** Expected header rate; defaults to 10 Hz. */
  expectedSampleRateHz?: number;
}

/** Result of `parseSeriesFixture`. */
export interface ParsedSeriesFixture {
  header: SeriesFixtureHeader;
  samples: ParsedSeriesSample[];
  sampleCount: number;
}

/** Directory (relative to the repository root) holding the committed corpus. */
export const INTENSITY_ARC_FIXTURE_DIR: string;
/** The 10 Hz cadence every recorded series uses. */
export const FIXTURE_SAMPLE_RATE_HZ: number;
/** Deterministic run seed carried by every fixture header. */
export const FIXTURE_RUN_SEED: number;
/** Base epoch the fixture anchors are offset from. */
export const FIXTURE_RUN_STARTED_AT_EPOCH_MS: number;
/** Named plateau specs reused by the corpus cases. */
export const FIXTURE_PLATEAUS: Readonly<Record<string, ReadonlyArray<IntensityPlateau>>>;
/** The corpus definition — one entry per capture stem. */
export const INTENSITY_ARC_FIXTURE_CASES: ReadonlyArray<IntensityArcFixtureCase>;

/** Turns a plateau spec into deterministic series samples. */
export function buildPlateauSamples(
  plateaus: ReadonlyArray<IntensityPlateau>,
  options?: FixtureBuildOptions,
): BuiltSeriesSample[];
/** Builds the serialiser input (run identity + samples). */
export function buildIntensitySeries(
  plateaus: ReadonlyArray<IntensityPlateau>,
  options?: FixtureBuildOptions,
): BuiltIntensitySeries;
/** Serialises a capture's series through the canonical series serialiser. */
export function serialisePlateauSeries(
  plateaus: ReadonlyArray<IntensityPlateau>,
  options?: FixtureBuildOptions,
): string;
/** Builds the §7.5 join anchor through the canonical anchor builder. */
export function buildFixtureAnchor(markers: FixtureAnchorMarkers): CaptureJoinAnchor;
/** Serialises an anchor as `.capture.json` text (2-space JSON + newline). */
export function serialiseCaptureAnchor(anchor: CaptureJoinAnchor): string;
/** Builds the complete corpus as file name → exact file text. */
export function buildFixtureCorpus(): Record<string, string>;
/** Parses and validates a committed `.action.jsonl` fixture. */
export function parseSeriesFixture(
  text: string,
  options?: ParseSeriesFixtureOptions,
): ParsedSeriesFixture;
/** Thrown when fixture text drifts from the recorded series schema. */
export class FixtureSchemaError extends Error {}
/** `--write` CLI: regenerate the committed corpus; always prints JSON. */
export function main(argv?: string[]): number;

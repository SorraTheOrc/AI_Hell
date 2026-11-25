/**
 * Type declarations for the pure `scripts/intensity-arc.mjs` planner
 * primitives (AH-0MWPD4QRO007WMJ1). The implementation is plain ESM
 * JavaScript so the Node scripts run it without a TypeScript loader; these
 * declarations let the Vitest suite (and the follow-up planner slices) consume
 * it without `any` leaks.
 */

import type { CaptureJoinAnchor } from './capture-series.mjs';

/** The canonical arc band names, in the order the promo is cut. */
export type IntensityArcBandName = 'high' | 'medium' | 'medium+' | 'very high';

/**
 * One arc band: an inclusive `min`, an exclusive `max` (`null` for the
 * unbounded top band) and the footage target in seconds.
 */
export interface IntensityArcBand {
  name: IntensityArcBandName;
  min: number;
  /** Exclusive upper bound; `null` means unbounded (`I ≥ min`). */
  max: number | null;
  targetSeconds: number;
}

/**
 * The single intensity-arc config object. The arc is not user-selectable:
 * retune by editing `DEFAULT_INTENSITY_ARC_CONFIG`, never through a flag.
 */
export interface IntensityArcConfig {
  /** The four bands, in arc order (high → medium → medium+ → very high). */
  bands: readonly IntensityArcBand[];
  /** Minimum window length the planner may emit, in seconds. */
  minWindowSeconds: number;
  /** The `vidc` cross-fade length, in seconds (document transitions are hard cuts). */
  fadeSeconds: number;
  /** The recorded series cadence, in Hz. */
  sampleRateHz: number;
}

/** One parsed series sample line (`docs/dev/action-intensity.md` §7.2). */
export interface IntensityArcSample {
  schemaVersion?: number;
  /** Milliseconds since run start (real time, from the tick's own clock). */
  t: number;
  /** Zero-based simulation tick the sample was current on. */
  tick: number;
  rawScore: number;
  intensity: number;
  smoothed: number;
  burstiness: number;
  breakdown: Record<string, number>;
  [field: string]: unknown;
}

/** The recorded series header (§7.2). */
export interface IntensityArcSeriesHeader {
  schemaVersion: number;
  runSeed: number | null;
  sampleRateHz: number;
  categories: string[];
  [field: string]: unknown;
}

/** A usable capture admitted to the planner corpus. */
export interface IntensityArcCapture {
  /** The candidate clip path/stem as supplied. */
  clip: string;
  /** The capture stem (the WebM basename without its extension). */
  stem: string;
  /** `<stem>.action.jsonl` basename used at ingest. */
  seriesFileName: string;
  /** `<stem>.capture.json` basename used at ingest. */
  anchorFileName: string;
  /** The parsed series header. */
  header: IntensityArcSeriesHeader;
  /** The series cadence the ingest used for run lengths, in Hz. */
  sampleRateHz: number;
  /** The usable series samples (finite `t` and `intensity`). */
  samples: IntensityArcSample[];
  /** The non-approximate join anchor. */
  anchor: CaptureJoinAnchor;
  /** `capture_started − run_startedAt`, in ms. */
  offsetMs: number;
  /** Map one of this capture's series times onto its video timeline. */
  videoTimeMs: (t: number) => number;
}

/** Why a candidate capture was skipped, and the names used to look for it. */
export interface IntensityArcSkippedCapture {
  clip: string;
  stem: string;
  seriesFileName: string;
  anchorFileName: string;
  reason:
    | 'missing-series'
    | 'malformed-series'
    | 'header-only'
    | 'sample-less'
    | 'missing-anchor'
    | 'malformed-anchor'
    | 'approximate-anchor';
}

/** The ingest result: the usable corpus plus what was skipped and why. */
export interface IntensityArcCorpus {
  captures: IntensityArcCapture[];
  skipped: IntensityArcSkippedCapture[];
}

/** Per-band coverage: target, longest available window and satisfiability. */
export interface BandAvailability {
  band: IntensityArcBandName;
  requiredSeconds: number;
  longestAvailableSeconds: number;
  satisfiable: boolean;
}

/** Options for `loadIntensityCorpus`. */
export interface LoadIntensityCorpusOptions {
  /** Directory to resolve series/anchor filenames against. */
  dir?: string;
  /** Injectable reader (defaults to UTF-8 `node:fs`). */
  readFile?: (filePath: string) => string;
  /** Injectable warning sink (one line per skipped capture). */
  warn?: (message: string) => void;
  /** Fallback cadence when a header omits `sampleRateHz`. */
  sampleRateHz?: number;
}

/** Options for `longestWindowSeconds`. */
export interface LongestWindowOptions {
  /** Series cadence, in Hz (defaults to 10). */
  sampleRateHz?: number;
}

/** The canonical arc band order: high → medium → medium+ → very high. */
export const INTENSITY_ARC_BAND_ORDER: readonly IntensityArcBandName[];
/** The one and only definition of the promo intensity arc. */
export const DEFAULT_INTENSITY_ARC_CONFIG: IntensityArcConfig;

/** Thrown when the arc config is malformed. */
export class IntensityArcConfigError extends Error {}
/** Thrown when the series ingest cannot produce a usable corpus. */
export class IntensityArcIngestError extends Error {}
/** Thrown when one or more arc bands cannot be filled from the footage. */
export class IntensityArcShortfallError extends Error {
  shortfalls: BandAvailability[];
}

/** True when `intensity` is inside `band` (inclusive min, exclusive max). */
export function bandContains(
  band: Pick<IntensityArcBand, 'min' | 'max'>,
  intensity: number,
): boolean;

/** Map series time to video time (`t − offsetMs`, clamped at 0). */
export function videoTimeMs(t: number, offsetMs: number): number;

/** Validate an arc config, throwing `IntensityArcConfigError` when malformed. */
export function validateIntensityArcConfig(config: unknown): IntensityArcConfig;

/** Split `.action.jsonl` text into its header and raw sample lines. */
export function parseActionIntensitySeries(text: string): {
  header: IntensityArcSeriesHeader;
  samples: IntensityArcSample[];
};

/** Load the usable captures for the arc, skipping unusable ones with one warning each. */
export function loadIntensityCorpus(
  candidates: ReadonlyArray<string>,
  options?: LoadIntensityCorpusOptions,
): IntensityArcCorpus;

/** Longest contiguous in-band window, in seconds. */
export function longestWindowSeconds(
  band: Pick<IntensityArcBand, 'min' | 'max'>,
  samples: ReadonlyArray<Pick<IntensityArcSample, 't' | 'intensity'>>,
  options?: LongestWindowOptions,
): number;

/** Per-band coverage across the corpus. */
export function bandAvailability(
  captures: ReadonlyArray<IntensityArcCapture>,
  config?: IntensityArcConfig,
): BandAvailability[];

/** Throw `IntensityArcShortfallError` when any band cannot be filled. */
export function assertArcBandsSatisfiable(
  captures: ReadonlyArray<IntensityArcCapture>,
  config?: IntensityArcConfig,
): BandAvailability[];

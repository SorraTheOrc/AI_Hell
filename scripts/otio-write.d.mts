/**
 * Type declarations for the pure `.otio` writer (AH-0MWPD4U3M003YG5M).
 *
 * The implementation is plain ESM JavaScript so the Node scripts run it without
 * a TypeScript loader; these declarations let the Vitest suite and the
 * `capture:promo` CLI consume it without `any` leaks.
 *
 * The shapes mirror the `video_compiler` OTIO model (`src/otio/model.ts`), which
 * is the consumer's source of truth.
 */

import type {
  IntensityArcConfig,
  IntensityArcPlanWindow,
} from './intensity-arc.mjs';

/** A point in time, in frames at `rate`. */
export interface OtioRationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
  rate: number;
  value: number;
}

/** A span of time: `start_time` for `duration`. */
export interface OtioTimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  duration: OtioRationalTime;
  start_time: OtioRationalTime;
}

/** One clip's external media reference (document-relative `target_url`). */
export interface OtioExternalReference {
  OTIO_SCHEMA: 'ExternalReference.1';
  metadata: Record<string, unknown>;
  name: string;
  available_range: OtioTimeRange;
  available_image_bounds: null;
  target_url: string;
}

/** One clip (a planned footage window). */
export interface OtioClip {
  OTIO_SCHEMA: 'Clip.1';
  metadata: Record<string, unknown>;
  name: string;
  source_range: OtioTimeRange;
  effects: readonly unknown[];
  markers: readonly unknown[];
  enabled: true;
  media_reference: OtioExternalReference;
  active_media_reference_key: string;
}

/** A zero-length cut transition. */
export interface OtioTransition {
  OTIO_SCHEMA: 'Transition.1';
  metadata: Record<string, unknown>;
  name: string;
  effects: readonly unknown[];
  markers: readonly unknown[];
  enabled: true;
  transition_type: 'Cut';
  in_offset: OtioRationalTime;
  out_offset: OtioRationalTime;
}

/** A video track. */
export interface OtioTrack {
  OTIO_SCHEMA: 'Track.1';
  metadata: Record<string, unknown>;
  name: string;
  source_range: null;
  effects: readonly unknown[];
  markers: readonly unknown[];
  enabled: true;
  kind: 'Video';
  children: ReadonlyArray<OtioClip | OtioTransition>;
}

/** The timeline's tracks stack. */
export interface OtioStack {
  OTIO_SCHEMA: 'Stack.1';
  metadata: Record<string, unknown>;
  name: string;
  source_range: null;
  effects: readonly unknown[];
  markers: readonly unknown[];
  enabled: true;
  children: readonly OtioTrack[];
}

/** The auditable planner-input record echoed at `metadata.vidc.intensity_arc`. */
export interface OtioArcMetadata {
  bands: ReadonlyArray<{
    name: string;
    min: number;
    max: number | null;
    target_seconds: number;
  }>;
  min_window_seconds: number;
  fade_seconds: number;
  sample_rate_hz: number;
  edge_nudge_seconds: number;
  achieved_seconds: Record<string, number>;
  footage_seconds: number;
  fade_overlap_seconds: number;
  rendered_seconds: number;
  windows: ReadonlyArray<{
    band: string;
    source_stem: string;
    in_seconds: number;
    duration_seconds: number;
  }>;
}

/** The root `.otio` document: an OTIO `Timeline.1` object. */
export interface OtioTimelineDocument {
  OTIO_SCHEMA: 'Timeline.1';
  metadata: {
    vidc: {
      otio_schema_version: string;
      generator: string;
      clip_count: number;
      intensity_arc: OtioArcMetadata;
    };
  };
  name: string;
  global_start_time: null;
  tracks: OtioStack;
}

/** Options for `buildOtioDocument`. */
export interface BuildOtioDocumentOptions {
  /** The config the plan was produced with (recorded in the metadata). */
  config?: IntensityArcConfig;
  /** The frame rate every `RationalTime` is expressed in (default 30). */
  rate?: number;
  /** The timeline's name. */
  name?: string;
  /** Maps a planned window to its document-relative media basename. */
  clipFileName?: (window: IntensityArcPlanWindow) => string;
}

/** The OpenTimelineIO release the labels are validated against. */
export const OTIO_SCHEMA_VERSION: '0.16.0';
/** The frame rate every `RationalTime` uses (vidc's `DEFAULT_OTIO_RATE`). */
export const DEFAULT_OTIO_RATE: 30;
/** OTIO type labels, mirrored from the `video_compiler` OTIO model. */
export const OTIO_SCHEMA_LABELS: Readonly<{
  timeline: 'Timeline.1';
  stack: 'Stack.1';
  track: 'Track.1';
  clip: 'Clip.1';
  transition: 'Transition.1';
  timeRange: 'TimeRange.1';
  rationalTime: 'RationalTime.1';
  externalReference: 'ExternalReference.1';
}>;
/** The producer recorded at `metadata.vidc.generator`. */
export const OTIO_GENERATOR: string;

/** Thrown when a document cannot be built faithfully. */
export class OtioWriteError extends Error {}

/** Seconds → whole frames (at least 1). */
export function durationToFrames(seconds: number, rate?: number): number;
/** Seconds → whole frames (at least 0). */
export function startToFrames(seconds: number, rate?: number): number;
/** True when `name` is a bare file name (no directory, no scheme). */
export function isMediaBasename(name: unknown): boolean;
/** The default document-relative media name: `<sourceStem>.webm`. */
export function defaultClipFileName(window: IntensityArcPlanWindow): string;

/** Builds the OTIO document for a planned arc. */
export function buildOtioDocument(
  plan: ReadonlyArray<IntensityArcPlanWindow>,
  options?: BuildOtioDocumentOptions,
): OtioTimelineDocument;

/** Serialises a document to canonical bytes (2-space JSON + trailing newline). */
export function serialiseOtioDocument(document: OtioTimelineDocument): string;

/** Builds and serialises in one call. */
export function renderOtioDocument(
  plan: ReadonlyArray<IntensityArcPlanWindow>,
  options?: BuildOtioDocumentOptions,
): { document: OtioTimelineDocument; text: string };

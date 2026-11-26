/**
 * OpenTimelineIO (`.otio`) document writer for the intensity-arc promo plan
 * (AH-0MWPD4U3M003YG5M).
 *
 * The promo edit is an OTIO document so it is hand-editable and reproducible:
 * a producer can open it in any OTIO editor, tweak a cut point and re-render,
 * and the same plan always serialises to the same bytes.
 *
 * ## Source of truth for the shape
 *
 * The labels, the required per-object fields and the schema pin mirror the
 * `video_compiler` project's OTIO model (`src/otio/model.ts`:
 * `OTIO_SCHEMA_LABELS`, `OTIO_SCHEMA_VERSION = '0.16.0'`,
 * `DEFAULT_OTIO_RATE = 30`). `vidc` is the consumer, so it is the source of
 * truth; this mirror is a deliberate cross-repo copy (the two projects share no
 * package) and it is pinned by the tests here plus the `vidc` acceptance step
 * recorded on the work item.
 *
 * No dependency: the document is plain JSON in the pinned schema, so it is
 * built as an object and serialised with `JSON.stringify` — never a bespoke
 * textual writer.
 *
 * ## Determinism
 *
 * - Objects are built in OTIO's declared field order (`OTIO_SCHEMA` first), so
 *   `JSON.stringify` (which follows insertion order) is byte-stable.
 * - Two-space indent, one trailing newline — the convention `video_compiler`'s
 *   writer uses, so a re-write is a minimal diff.
 * - Nothing derives from the clock, the filesystem or the environment: the
 *   document is a pure function of the plan and its config.
 * - Times are whole frames at one shared rate, so a cut point is always a
 *   frame boundary (`vidc` converts `RationalTime` as `value / rate`).
 *
 * ## Document-relative media
 *
 * `media_reference.target_url` is a **bare basename** (`gameplay-….webm`), never
 * an absolute path: the document lives next to the captures it names, so the
 * pair stays portable. A caller-supplied name that is not a basename is
 * rejected rather than silently mangled.
 *
 * Existence is guaranteed upstream, not re-checked here: the default name is
 * `<sourceStem>.webm` and a stem only reaches the plan through
 * `loadIntensityCorpus`, which read that capture's series and anchor **from the
 * directory being planned**, so every basename this writer emits is a file that
 * exists next to the document.
 *
 * @module scripts/otio-write
 */

import {
  DEFAULT_INTENSITY_ARC_CONFIG,
  planTotals,
} from './intensity-arc.mjs';

/** The OpenTimelineIO release the labels are validated against. */
export const OTIO_SCHEMA_VERSION = '0.16.0';

/**
 * The frame rate every `RationalTime` in the document is expressed in —
 * `video_compiler`'s `DEFAULT_OTIO_RATE`, the render pipeline's default target
 * rate, so a cut point never lands on a sub-frame boundary.
 */
export const DEFAULT_OTIO_RATE = 30;

/** OTIO type labels, mirrored from `video_compiler` `src/otio/model.ts`. */
export const OTIO_SCHEMA_LABELS = Object.freeze({
  timeline: 'Timeline.1',
  stack: 'Stack.1',
  track: 'Track.1',
  clip: 'Clip.1',
  transition: 'Transition.1',
  timeRange: 'TimeRange.1',
  rationalTime: 'RationalTime.1',
  externalReference: 'ExternalReference.1',
});

/** The tool that produced a document, recorded at `metadata.vidc.generator`. */
export const OTIO_GENERATOR = 'ai-hell/capture:promo intensity arc';

/** Thrown when a document cannot be built faithfully (bad plan or bad options). */
export class OtioWriteError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'OtioWriteError';
  }
}

/** Throws unless `rate` is a positive, finite frame rate. */
function assertRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new OtioWriteError(
      `OTIO rate must be a positive, finite frame rate (got ${String(rate)}).`,
    );
  }
}

/**
 * Converts a duration in seconds to whole frames.
 *
 * `vidc` converts a `RationalTime` back to seconds as `value / rate`, so the
 * rounding error this introduces is at most half a frame (16.7 ms at 30 fps) —
 * well inside the acceptance tolerance for a per-band duration. A non-positive
 * duration is clamped to one frame: OTIO cannot express a zero-length clip.
 *
 * @param {number} seconds
 * @param {number} [rate]
 * @returns {number} whole frames, at least 1.
 */
export function durationToFrames(seconds, rate = DEFAULT_OTIO_RATE) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    throw new OtioWriteError(
      `Clip duration must be a finite number of seconds (got ${String(seconds)}).`,
    );
  }
  assertRate(rate);
  return Math.max(1, Math.round(value * rate));
}

/**
 * Converts an in point in seconds to whole frames.
 *
 * Unlike {@link durationToFrames} a start point may legitimately be frame `0`
 * (the first frame of the source clip).
 *
 * @param {number} seconds
 * @param {number} [rate]
 * @returns {number} whole frames, at least 0.
 */
export function startToFrames(seconds, rate = DEFAULT_OTIO_RATE) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    throw new OtioWriteError(
      `Clip in point must be a finite number of seconds (got ${String(seconds)}).`,
    );
  }
  assertRate(rate);
  return Math.max(0, Math.round(value * rate));
}

/**
 * True when `name` is a bare file name — no directory separator, no drive or
 * scheme prefix, and not a parent reference.
 *
 * A `.otio` `target_url` is resolved against the document's own directory, so
 * anything with a path component would escape it.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isMediaBasename(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  return !name.includes('/') && !name.includes('\\') && !name.includes(':');
}

/** The default `target_url` for a planned window: `<sourceStem>.webm`. */
export function defaultClipFileName(window) {
  const stem = typeof window?.sourceStem === 'string' ? window.sourceStem : '';
  return `${stem}.webm`;
}

/** A `RationalTime.1` value at `rate` frames per second. */
function rationalTime(value, rate) {
  return {
    OTIO_SCHEMA: OTIO_SCHEMA_LABELS.rationalTime,
    rate,
    value,
  };
}

/** A `TimeRange.1` spanning `durationFrames` from `startFrames`. */
function timeRange(startFrames, durationFrames, rate) {
  return {
    OTIO_SCHEMA: OTIO_SCHEMA_LABELS.timeRange,
    duration: rationalTime(durationFrames, rate),
    start_time: rationalTime(startFrames, rate),
  };
}

/** A zero-length `Cut` transition — the join the renderer performs. */
function cutTransition(rate) {
  return {
    OTIO_SCHEMA: OTIO_SCHEMA_LABELS.transition,
    metadata: {},
    name: 'Cut',
    effects: [],
    markers: [],
    enabled: true,
    transition_type: 'Cut',
    in_offset: rationalTime(0, rate),
    out_offset: rationalTime(0, rate),
  };
}

/** One `Clip.1` for a planned footage window. */
function planClip(window, options) {
  const { rate, fileName } = options;
  if (!isMediaBasename(fileName)) {
    throw new OtioWriteError(
      `The clip file name for band ${JSON.stringify(window?.band)} must be a bare basename ` +
        `(no directory, no absolute path) because a .otio target_url resolves against the ` +
        `document's own directory; got ${JSON.stringify(fileName)}.`,
    );
  }
  const startFrames = startToFrames(window.inSeconds, rate);
  const durationFrames = durationToFrames(window.durationSeconds, rate);
  const range = timeRange(startFrames, durationFrames, rate);
  return {
    OTIO_SCHEMA: OTIO_SCHEMA_LABELS.clip,
    metadata: {
      vidc: {
        duration_seconds: window.durationSeconds,
        frame_rate: rate,
        // The captures carry their own audio and the compile keeps it.
        has_audio: true,
        // Planner provenance: which arc band this window was cut for.
        intensity_band: window.band,
      },
    },
    name: fileName,
    source_range: range,
    effects: [],
    markers: [],
    enabled: true,
    media_reference: {
      OTIO_SCHEMA: OTIO_SCHEMA_LABELS.externalReference,
      metadata: {},
      name: fileName,
      available_range: range,
      available_image_bounds: null,
      target_url: fileName,
    },
    active_media_reference_key: 'DEFAULT_MEDIA',
  };
}

/**
 * The auditable record of the planner inputs, echoed at
 * `metadata.vidc.intensity_arc` so an edit can always be traced back to the
 * thresholds, targets and totals it was made with.
 *
 * Every value comes from the **config object the plan was built with** (and
 * from `planTotals` over the plan itself), never from a re-derivation, so the
 * document cannot record values the plan did not use.
 */
function arcMetadata(plan, config) {
  const totals = planTotals(plan, config);
  return {
    bands: config.bands.map((band) => ({
      name: band.name,
      min: band.min,
      max: band.max,
      target_seconds: band.targetSeconds,
    })),
    min_window_seconds: config.minWindowSeconds,
    fade_seconds: config.fadeSeconds,
    sample_rate_hz: config.sampleRateHz,
    edge_nudge_seconds: config.edgeNudgeSeconds,
    achieved_seconds: { ...totals.byBand },
    footage_seconds: totals.footageSeconds,
    fade_overlap_seconds: totals.fadeSeconds,
    rendered_seconds: totals.renderedSeconds,
    windows: plan.map((window) => ({
      band: window.band,
      source_stem: window.sourceStem,
      in_seconds: window.inSeconds,
      duration_seconds: window.durationSeconds,
    })),
  };
}

/**
 * Builds the OTIO `Timeline.1` document for a planned intensity arc.
 *
 * One video track (`V1`) holds one `Clip.1` per planned window in arc order,
 * with a zero-length `Cut` after each clip — the same shape `vidc timeline`
 * writes, so the document is a plain timeline with no unsupported construct.
 * Each clip's `source_range` is the planned window expressed in whole frames at
 * `options.rate`, and its `media_reference.target_url` is the capture basename
 * relative to the document's directory.
 *
 * @param {ReadonlyArray<import('./intensity-arc.mjs').IntensityArcPlanWindow>} plan
 * @param {{
 *   config?: import('./intensity-arc.mjs').IntensityArcConfig,
 *   rate?: number,
 *   name?: string,
 *   clipFileName?: (window: import('./intensity-arc.mjs').IntensityArcPlanWindow) => string,
 * }} [options]
 * @returns {object} the OTIO `Timeline.1` document object.
 */
export function buildOtioDocument(plan, options = {}) {
  if (!Array.isArray(plan)) {
    throw new OtioWriteError(
      'buildOtioDocument needs the planned arc (an array of windows) as its first argument.',
    );
  }
  const {
    config = DEFAULT_INTENSITY_ARC_CONFIG,
    rate = DEFAULT_OTIO_RATE,
    name = 'Intensity arc promo',
    clipFileName = defaultClipFileName,
  } = options;
  assertRate(rate);

  const children = [];
  for (const window of plan) {
    children.push(planClip(window, { rate, fileName: clipFileName(window) }));
    // One Cut after every clip, exactly as `vidc timeline` writes it: a
    // zero-length transition is the join the renderer performs, so it is never
    // reported as a lossy construct.
    children.push(cutTransition(rate));
  }

  return {
    OTIO_SCHEMA: OTIO_SCHEMA_LABELS.timeline,
    metadata: {
      vidc: {
        // The schema pin is the first field of the project block, matching
        // `video_compiler`'s writer.
        otio_schema_version: OTIO_SCHEMA_VERSION,
        generator: OTIO_GENERATOR,
        clip_count: plan.length,
        intensity_arc: arcMetadata(plan, config),
      },
    },
    name,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: OTIO_SCHEMA_LABELS.stack,
      metadata: {},
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      children: [
        {
          OTIO_SCHEMA: OTIO_SCHEMA_LABELS.track,
          metadata: {},
          name: 'V1',
          source_range: null,
          effects: [],
          markers: [],
          enabled: true,
          kind: 'Video',
          children,
        },
      ],
    },
  };
}

/**
 * Serialises a document to its canonical bytes: two-space indented JSON with a
 * single trailing newline.
 *
 * `JSON.stringify` follows the object's insertion order, and
 * {@link buildOtioDocument} builds every OTIO object in OTIO's declared field
 * order, so the same plan always produces the same bytes — the property the
 * double-run test asserts.
 *
 * @param {object} document
 * @returns {string}
 */
export function serialiseOtioDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new OtioWriteError('serialiseOtioDocument needs a document object.');
  }
  if (document.OTIO_SCHEMA !== OTIO_SCHEMA_LABELS.timeline) {
    throw new OtioWriteError(
      `A .otio file's root must be a ${JSON.stringify(OTIO_SCHEMA_LABELS.timeline)} object; got ${JSON.stringify(document.OTIO_SCHEMA)}.`,
    );
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Builds and serialises in one call — the CLI's path, so the two steps can
 * never diverge.
 *
 * @param {ReadonlyArray<import('./intensity-arc.mjs').IntensityArcPlanWindow>} plan
 * @param {Parameters<typeof buildOtioDocument>[1]} [options]
 * @returns {{ document: object, text: string }}
 */
export function renderOtioDocument(plan, options = {}) {
  const document = buildOtioDocument(plan, options);
  return { document, text: serialiseOtioDocument(document) };
}

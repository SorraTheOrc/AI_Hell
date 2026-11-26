/**
 * Pure intensity-arc planner primitives for the `capture:promo` pipeline
 * (AH-0MWPD4QRO007WMJ1, first slice of AH-0MWPCLYYG007NUJY).
 *
 * This module owns two slices of the planner: it ingests every capture's
 * recorded action-intensity series, joins series time to video time through the
 * §7.5 anchor, owns the **single** band/target config object the promo arc is
 * planned from, and turns that corpus into the ordered, non-overlapping
 * footage windows of the arc (`planIntensityArc`) with the inter-window fade
 * overlap compensated so the **rendered** timeline delivers the 34 s arc.
 * `.otio` emission is the following slice; it consumes the plan and the totals
 * here (in particular `planTotals`) rather than re-deriving anything.
 *
 * ## Inputs (reused, never re-derived)
 *
 * The recorded artefacts are documented in `docs/dev/action-intensity.md`:
 *
 * - `<stem>.action.jsonl` — the 10 Hz series: a self-describing header
 *   (`schemaVersion`, `runSeed`, `sampleRateHz`, `categories`) followed by one
 *   sample line per recorded sample (§7.2).
 * - `<stem>.capture.json` — the join anchor
 *   (`capture_started`, `run_startedAt`, `offsetMs`, `approximate`) (§7.5).
 *
 * The filenames/extensions and the anchor shape come from
 * `scripts/capture-series.mjs`; this module imports those helpers so a
 * filename or extension change cannot drift between the writer and the
 * reader. The series/anchor format itself is parsed here because the planner
 * is a production consumer (the corpus parser in
 * `scripts/intensity-arc-fixtures.mjs` is fixture-build tooling).
 *
 * ## The arc is not a user-selectable value
 *
 * The intensity arc is the **only** behaviour of `capture:promo`, so there is
 * deliberately **no `--arc` flag and no spec parser**. The arc lives in
 * `DEFAULT_INTENSITY_ARC_CONFIG` and is retuned by editing that one object
 * (a plain Node script — no rebuild). `validateIntensityArcConfig` runs at
 * module load, so a malformed retune fails immediately with an actionable
 * message instead of silently shipping a broken arc.
 *
 * ## Failure posture
 *
 * A series is **skipped, never silently truncated**, when it cannot be joined:
 * a header-only/sample-less series, a missing/malformed anchor or an
 * `approximate` anchor each produce **exactly one** warning per capture. When
 * no usable capture remains the ingest fails loudly. A band that cannot be
 * filled fails naming the band, the required seconds and the longest window
 * available — never a quietly shorter arc.
 *
 * Every function here is pure: no clock, no randomness. The ingest reads
 * committed files but takes an injectable `readFile` and `warn` sink, so it is
 * unit-testable over synthetic fixtures with no browser and no network.
 *
 * @module scripts/intensity-arc
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CAPTURE_ANCHOR_KIND,
  actionIntensitySeriesFileName,
  captureAnchorFileName,
  captureSeriesStem,
} from './capture-series.mjs';

/**
 * The canonical arc order the promo is cut in: **high → medium → medium+ →
 * very high** (parent item AC3(b)). The order is deliberately *not* the
 * threshold order — the arc opens on the strongest beat and releases through
 * the lower bands.
 */
export const INTENSITY_ARC_BAND_ORDER = Object.freeze([
  'high',
  'medium',
  'medium+',
  'very high',
]);

/**
 * The one and only definition of the promo intensity arc
 * (`docs/dev/action-intensity.md` §6.6's knob-object pattern, extended to the
 * planner). Thresholds are calibrated from the 35 recorded series in
 * `capture-output` (parent item "Band definitions"), not guesses; the targets
 * are the 7/7/10/10 s arc.
 *
 * **This object is the only place the arc is defined.** There is no CLI flag
 * or spec parser: retune by editing this object (a plain Node script, no
 * rebuild). The module validates it at load, so a broken retune cannot ship.
 *
 * Band membership uses the instantaneous `intensity` field with an inclusive
 * `min` and an exclusive `max`; the top band is unbounded (`max: null`) and is
 * `I ≥ min`.
 *
 * | Band        | Threshold        | Target |
 * |-------------|------------------|--------|
 * | `high`      | `0.65 ≤ I < 0.75`| 10 s   |
 * | `medium`    | `0.40 ≤ I < 0.55`| 7 s    |
 * | `medium+`   | `0.55 ≤ I < 0.65`| 7 s    |
 * | `very high` | `I ≥ 0.75`       | 10 s   |
 *
 * `fadeSeconds: 0.3` mirrors `vidc`'s `DEFAULT_FADE_DURATION_MS` (300 ms), the
 * only softening mechanism available today (document transitions are not
 * rendered yet: VC-0MWNW4SPX002J2SE / VC-0MWNW4T81005YFBJ). `sampleRateHz: 10`
 * matches the recorded series cadence (§6.5).
 *
 * `edgeNudgeSeconds: 0.25` bounds the cut-placement nudge: a window edge may
 * move at most this far (2.5 samples at 10 Hz) to land on a local `smoothed`
 * minimum instead of cutting mid-spike (parent item assumption 2). The bound
 * is small enough that a cut never strays into another band's footage.
 *
 * @type {IntensityArcConfig}
 */
export const DEFAULT_INTENSITY_ARC_CONFIG = Object.freeze({
  bands: Object.freeze([
    Object.freeze({ name: 'high', min: 0.65, max: 0.75, targetSeconds: 10 }),
    Object.freeze({ name: 'medium', min: 0.4, max: 0.55, targetSeconds: 7 }),
    Object.freeze({ name: 'medium+', min: 0.55, max: 0.65, targetSeconds: 7 }),
    Object.freeze({ name: 'very high', min: 0.75, max: null, targetSeconds: 10 }),
  ]),
  minWindowSeconds: 1.0,
  fadeSeconds: 0.3,
  sampleRateHz: 10,
  edgeNudgeSeconds: 0.25,
});

/**
 * Thrown when the arc config is malformed. A retune is developer input, so it
 * must fail at module load with an actionable message rather than ship a
 * silently broken arc.
 */
export class IntensityArcConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'IntensityArcConfigError';
  }
}

/**
 * Thrown when the series ingest cannot produce a corpus: no usable capture
 * remains, or a series/anchor is structurally unusable in a way that must stop
 * the run.
 */
export class IntensityArcIngestError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'IntensityArcIngestError';
  }
}

/**
 * Thrown when one or more arc bands cannot be filled from the available
 * footage. The message names every shortfall's band, required seconds and the
 * longest window available, so a producer can see exactly what to re-capture or
 * retune.
 */
export class IntensityArcShortfallError extends Error {
  /**
   * @param {string} message
   * @param {BandAvailability[]} [shortfalls]
   */
  constructor(message, shortfalls = []) {
    super(message);
    this.name = 'IntensityArcShortfallError';
    /** @type {BandAvailability[]} */
    this.shortfalls = shortfalls;
  }
}

/**
 * True when `intensity` falls inside `band`: inclusive `min`, exclusive `max`,
 * with an unbounded top band (`max: null` / non-finite) meaning `I ≥ min`.
 *
 * @param {{ min: number, max?: number | null }} band
 * @param {number} intensity
 * @returns {boolean}
 */
export function bandContains(band, intensity) {
  if (!band || !Number.isFinite(intensity)) return false;
  if (!Number.isFinite(band.min) || intensity < band.min) return false;
  if (band.max === null || band.max === undefined) return true;
  if (!Number.isFinite(band.max)) return true;
  return intensity < band.max;
}

/**
 * Maps series time (`t`, ms since run start) onto the WebM playback timeline
 * exactly as `docs/dev/action-intensity.md` §7.5 documents:
 *
 *   `videoTimeMs(t) = t − offsetMs`, clamped at 0
 *
 * The clamp matters because the first recorded sample may predate
 * `capture_started` (warm-up). `offsetMs` is `capture_started − run_startedAt`
 * from the join anchor; a non-finite offset is a programming error (the ingest
 * skips `approximate`/missing anchors, so a usable capture always has one).
 *
 * @param {number} t — series time in ms.
 * @param {number} offsetMs — `capture_started − run_startedAt` in ms.
 * @returns {number} video time in ms, never negative.
 */
export function videoTimeMs(t, offsetMs) {
  const seriesTime = Number(t);
  const offset = Number(offsetMs);
  if (!Number.isFinite(seriesTime)) {
    throw new TypeError(`videoTimeMs: series time t must be a finite number (got ${String(t)}).`);
  }
  if (!Number.isFinite(offset)) {
    throw new TypeError(
      `videoTimeMs: offsetMs must be a finite number from a non-approximate join anchor (got ${String(offsetMs)}).`,
    );
  }
  return Math.max(0, seriesTime - offset);
}

/**
 * Validates an arc config and throws an actionable `IntensityArcConfigError`
 * for a malformed retune. Called at module load on the default config and
 * exported so tests (and any future retune harness) can prove a config is
 * sound before it is used.
 *
 * Rejected shapes, per the acceptance criteria:
 *
 * - **unknown band name** — a name outside {@link INTENSITY_ARC_BAND_ORDER};
 * - **non-positive duration** — `targetSeconds`, `minWindowSeconds` or
 *   `sampleRateHz` ≤ 0 (or a negative `fadeSeconds`);
 * - **unordered arc** — the bands are not in arc order, or their threshold
 *   ranges are not a contiguous partition of the intensity domain.
 *
 * @param {unknown} config
 * @returns {IntensityArcConfig} the same config, for chaining.
 */
export function validateIntensityArcConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new IntensityArcConfigError(
      'Intensity arc config must be an object with `bands`, `minWindowSeconds`, `fadeSeconds` and `sampleRateHz`.',
    );
  }
  const { bands, minWindowSeconds, fadeSeconds, sampleRateHz } =
    /** @type {IntensityArcConfig} */ (config);

  if (!Array.isArray(bands) || bands.length !== INTENSITY_ARC_BAND_ORDER.length) {
    throw new IntensityArcConfigError(
      `Intensity arc config.bands must list exactly the ${INTENSITY_ARC_BAND_ORDER.length} bands (${INTENSITY_ARC_BAND_ORDER.join(', ')}).`,
    );
  }

  const seen = new Set();
  bands.forEach((band, index) => {
    if (!band || typeof band !== 'object') {
      throw new IntensityArcConfigError(`Intensity arc config.bands[${index}] must be an object.`);
    }
    const { name, min, max } = /** @type {IntensityArcBand} */ (band);
    if (!INTENSITY_ARC_BAND_ORDER.includes(/** @type {any} */ (name))) {
      throw new IntensityArcConfigError(
        `Unknown intensity band name ${JSON.stringify(name)} at index ${index}; expected one of ${INTENSITY_ARC_BAND_ORDER.map((n) => JSON.stringify(n)).join(', ')}.`,
      );
    }
    if (seen.has(name)) {
      throw new IntensityArcConfigError(
        `Duplicate intensity band name ${JSON.stringify(name)}; each band may appear only once.`,
      );
    }
    seen.add(name);
    if (name !== INTENSITY_ARC_BAND_ORDER[index]) {
      throw new IntensityArcConfigError(
        `Unordered arc: band ${index} is ${JSON.stringify(name)} but the arc order is ${INTENSITY_ARC_BAND_ORDER.map((n) => JSON.stringify(n)).join(' → ')}.`,
      );
    }
    if (!Number.isFinite(min) || min < 0 || min >= 1) {
      throw new IntensityArcConfigError(
        `Intensity band ${JSON.stringify(name)} has min ${JSON.stringify(min)}; min must be a finite number in [0, 1).`,
      );
    }
    if (max !== null && (!Number.isFinite(max) || max <= min || max > 1)) {
      throw new IntensityArcConfigError(
        `Intensity band ${JSON.stringify(name)} has max ${JSON.stringify(max)}; max must be null (unbounded top band) or a finite number greater than min and at most 1.`,
      );
    }
    const targetSeconds = /** @type {IntensityArcBand} */ (band).targetSeconds;
    if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
      throw new IntensityArcConfigError(
        `Intensity band ${JSON.stringify(name)} has targetSeconds ${JSON.stringify(targetSeconds)}; targetSeconds must be a positive, finite number.`,
      );
    }
  });

  // The threshold ranges must be a contiguous partition of the intensity
  // domain in threshold order: an overlap or a gap is an "unordered arc" and
  // would make band membership ambiguous. The lower bound of the lowest band
  // may be > 0 (intensity below the arc is simply unbanded).
  const sorted = [...bands].sort(
    (a, b) => /** @type {IntensityArcBand} */ (a).min - /** @type {IntensityArcBand} */ (b).min,
  );
  sorted.forEach((band, index) => {
    const { name, max } = /** @type {IntensityArcBand} */ (band);
    const isTop = index === sorted.length - 1;
    if (isTop && max !== null) {
      throw new IntensityArcConfigError(
        `Unordered arc: top band ${JSON.stringify(name)} must be unbounded (max: null).`,
      );
    }
    if (!isTop && max === null) {
      throw new IntensityArcConfigError(
        `Unordered arc: only the top band may be unbounded, but ${JSON.stringify(name)} has max: null.`,
      );
    }
    if (!isTop) {
      const next = /** @type {IntensityArcBand} */ (sorted[index + 1]);
      if (max !== next.min) {
        throw new IntensityArcConfigError(
          `Unordered arc: band ${JSON.stringify(name)} ends at ${JSON.stringify(max)} but ${JSON.stringify(next.name)} starts at ${JSON.stringify(next.min)}; bands must form a contiguous threshold partition.`,
        );
      }
    }
  });

  if (!Number.isFinite(minWindowSeconds) || minWindowSeconds <= 0) {
    throw new IntensityArcConfigError(
      `Intensity arc config.minWindowSeconds must be a positive, finite number (got ${JSON.stringify(minWindowSeconds)}).`,
    );
  }
  if (!Number.isFinite(fadeSeconds) || fadeSeconds < 0) {
    throw new IntensityArcConfigError(
      `Intensity arc config.fadeSeconds must be a non-negative, finite number (got ${JSON.stringify(fadeSeconds)}).`,
    );
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new IntensityArcConfigError(
      `Intensity arc config.sampleRateHz must be a positive, finite number (got ${JSON.stringify(sampleRateHz)}).`,
    );
  }
  const edgeNudgeSeconds = /** @type {IntensityArcConfig} */ (config).edgeNudgeSeconds;
  if (!Number.isFinite(edgeNudgeSeconds) || edgeNudgeSeconds < 0) {
    throw new IntensityArcConfigError(
      `Intensity arc config.edgeNudgeSeconds must be a non-negative, finite number (got ${JSON.stringify(edgeNudgeSeconds)}).`,
    );
  }

  return /** @type {IntensityArcConfig} */ (config);
}

// Fail fast: a malformed default retune must never ship a broken arc.
validateIntensityArcConfig(DEFAULT_INTENSITY_ARC_CONFIG);

/**
 * Parses `.action.jsonl` text into its header and raw sample lines (§7.2).
 *
 * Only structural JSON errors and an empty file are rejected here; whether a
 * sample carries a usable `intensity` is decided by the ingest (so the
 * `no-samples`/header-only cases skip with a warning rather than throwing at
 * this layer as well).
 *
 * @param {string} text
 * @returns {{ header: IntensityArcSeriesHeader, samples: IntensityArcSample[] }}
 */
export function parseActionIntensitySeries(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new IntensityArcIngestError(
      'Series is empty: expected a header line first (see docs/dev/action-intensity.md §7.2).',
    );
  }

  /** @type {IntensityArcSeriesHeader} */
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new IntensityArcIngestError(
      `Series header (line 1) is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!header || typeof header !== 'object') {
    throw new IntensityArcIngestError('Series header (line 1) must be a JSON object.');
  }

  /** @type {IntensityArcSample[]} */
  const samples = [];
  for (let index = 1; index < lines.length; index += 1) {
    /** @type {IntensityArcSample} */
    let sample;
    try {
      sample = JSON.parse(lines[index]);
    } catch (error) {
      throw new IntensityArcIngestError(
        `Series line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (!sample || typeof sample !== 'object') {
      throw new IntensityArcIngestError(`Series line ${index + 1} must be a JSON object.`);
    }
    samples.push(sample);
  }

  return { header, samples };
}

/** Default file reader: UTF-8 from disk. Injectable so tests stay hermetic. */
function defaultReadFile(filePath) {
  return readFileSync(filePath, 'utf8');
}

/** Default warning sink: one line per skipped capture on stderr. */
function defaultWarn(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Loads the usable captures for the arc from a list of candidate clips.
 *
 * For each candidate (a `.webm` path or a capture stem) the ingest derives the
 * series/anchor filenames through `scripts/capture-series.mjs`, reads both and
 * either admits the capture or **skips it with exactly one warning**:
 *
 * - header-only series (no sample lines);
 * - sample-less series (no sample with a usable `intensity`);
 * - a missing or unparsable `.capture.json`;
 * - an `approximate` anchor (`offsetMs` unavailable).
 *
 * A missing or unparsable series is skipped the same way. When no usable
 * capture remains the ingest throws an `IntensityArcIngestError` naming the
 * remediation — never an empty, silently short corpus.
 *
 * @param {ReadonlyArray<string>} candidates — capture clip paths or stems.
 * @param {{
 *   dir?: string,
 *   readFile?: (filePath: string) => string,
 *   warn?: (message: string) => void,
 *   sampleRateHz?: number,
 * }} [options]
 * @returns {{ captures: IntensityArcCapture[], skipped: IntensityArcSkippedCapture[] }}
 */
export function loadIntensityCorpus(candidates, options = {}) {
  const {
    dir,
    readFile = defaultReadFile,
    warn = defaultWarn,
    sampleRateHz = DEFAULT_INTENSITY_ARC_CONFIG.sampleRateHz,
  } = options;

  const list = Array.isArray(candidates) ? candidates : [];
  const read = (fileName) => readFile(dir ? join(dir, fileName) : fileName);

  /** @type {IntensityArcCapture[]} */
  const captures = [];
  /** @type {IntensityArcSkippedCapture[]} */
  const skipped = [];

  for (const candidate of list) {
    const stem = captureSeriesStem(candidate);
    const seriesFileName = actionIntensitySeriesFileName(candidate);
    const anchorFileName = captureAnchorFileName(candidate);

    /** Record a skip with **exactly one** warning and move on. */
    const skip = (reason, detail) => {
      skipped.push({ clip: candidate, stem, seriesFileName, anchorFileName, reason });
      warn(`Intensity arc: skipping "${candidate}" — ${detail}`);
    };

    let seriesText;
    try {
      seriesText = read(seriesFileName);
    } catch {
      skip('missing-series', `no action-intensity series file (${seriesFileName}).`);
      continue;
    }

    let parsed;
    try {
      parsed = parseActionIntensitySeries(seriesText);
    } catch (error) {
      skip(
        'malformed-series',
        `series ${seriesFileName} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (parsed.samples.length === 0) {
      skip('header-only', `series ${seriesFileName} is header-only (no sample lines).`);
      continue;
    }

    const samples = parsed.samples.filter(
      (sample) => Number.isFinite(Number(sample.t)) && Number.isFinite(Number(sample.intensity)),
    );
    if (samples.length === 0) {
      skip('sample-less', `series ${seriesFileName} has no sample with a usable intensity.`);
      continue;
    }

    let anchorText;
    try {
      anchorText = read(anchorFileName);
    } catch {
      skip('missing-anchor', `join anchor ${anchorFileName} is missing.`);
      continue;
    }

    let anchor;
    try {
      anchor = JSON.parse(anchorText);
    } catch (error) {
      skip(
        'malformed-anchor',
        `join anchor ${anchorFileName} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!anchor || typeof anchor !== 'object') {
      skip('malformed-anchor', `join anchor ${anchorFileName} must be a JSON object.`);
      continue;
    }
    if (anchor.kind !== undefined && anchor.kind !== CAPTURE_ANCHOR_KIND) {
      skip(
        'malformed-anchor',
        `join anchor ${anchorFileName} has kind ${JSON.stringify(anchor.kind)}; expected ${JSON.stringify(CAPTURE_ANCHOR_KIND)}.`,
      );
      continue;
    }
    if (anchor.approximate === true || !Number.isFinite(anchor.offsetMs)) {
      skip(
        'approximate-anchor',
        `join anchor ${anchorFileName} is approximate (offsetMs unavailable).`,
      );
      continue;
    }

    const offsetMs = Number(anchor.offsetMs);
    captures.push(
      Object.freeze({
        clip: candidate,
        stem,
        seriesFileName,
        anchorFileName,
        header: parsed.header,
        sampleRateHz: Number.isFinite(parsed.header?.sampleRateHz)
          ? Number(parsed.header.sampleRateHz)
          : sampleRateHz,
        samples,
        anchor,
        offsetMs,
        /** Map one of this capture's series times onto its video timeline. */
        videoTimeMs: (t) => videoTimeMs(t, offsetMs),
      }),
    );
  }

  if (captures.length === 0) {
    const reasons =
      skipped.length > 0 ? skipped.map((entry) => entry.reason).join(', ') : 'none supplied';
    throw new IntensityArcIngestError(
      `No usable capture remains: all ${list.length} candidate capture(s) were skipped (${reasons}). ` +
        'Each capture needs a non-approximate <stem>.capture.json join anchor and a <stem>.action.jsonl series with at least one usable intensity sample ' +
        '(docs/dev/action-intensity.md §7.2–§7.5). Re-capture with telemetry enabled, or pass a directory that contains captured runs.',
    );
  }

  return { captures, skipped };
}

/**
 * The longest **contiguous** run, in seconds, during which the series stays
 * inside `band` — the shared run-length primitive used by the shortfall
 * diagnosis here and by window assembly in the follow-up slice.
 *
 * A run covers `(lastT − firstT) + oneSampleInterval`, so a contiguous
 * plateau of N samples at the series cadence measures `N × step` seconds; a
 * gap larger than 1.5 sample intervals (a dropped/absent sample) breaks the
 * run rather than bridging it. Only samples with a finite `t` and `intensity`
 * can join a run.
 *
 * @param {{ min: number, max?: number | null }} band
 * @param {ReadonlyArray<{ t: number, intensity: number }>} samples
 * @param {{ sampleRateHz?: number }} [options]
 * @returns {number} longest contiguous in-band window, in seconds (0 when none).
 */
export function longestWindowSeconds(band, samples, options = {}) {
  const rate = Number(options.sampleRateHz);
  const sampleRateHz =
    Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_INTENSITY_ARC_CONFIG.sampleRateHz;
  const stepMs = 1000 / sampleRateHz;
  const gapToleranceMs = stepMs * 1.5;

  let best = 0;
  /** @type {number | null} */
  let runStartT = null;
  /** @type {number | null} */
  let runEndT = null;

  const closeRun = () => {
    if (runStartT === null || runEndT === null) return;
    best = Math.max(best, (runEndT - runStartT + stepMs) / 1000);
    runStartT = null;
    runEndT = null;
  };

  for (const sample of Array.isArray(samples) ? samples : []) {
    const t = Number(sample?.t);
    const intensity = Number(sample?.intensity);
    if (!Number.isFinite(t) || !bandContains(band, intensity)) {
      closeRun();
      continue;
    }
    if (runStartT === null || runEndT === null) {
      runStartT = t;
      runEndT = t;
      continue;
    }
    if (t - runEndT > gapToleranceMs) {
      // A gap between samples means the band was not continuously present.
      closeRun();
      runStartT = t;
      runEndT = t;
      continue;
    }
    runEndT = Math.max(runEndT, t);
  }
  closeRun();

  return best;
}

// ── Window selection and fade compensation (AH-0MWPD4SGJ005LAPR) ──────────

/**
 * Float tolerance for sample-grid arithmetic, in seconds.
 *
 * Windows are built from **sample indices** rather than float times, so this
 * only absorbs the rounding of a duration derived from a sample count.
 */
const TIME_EPSILON = 1e-9;

/**
 * Firewall on the fade-compensation distribution loop. Each window can only
 * grow into its own run's slack, so the loop converges in at most one pass per
 * window; the bound exists so a future bug can never spin forever.
 */
const FADE_COMPENSATION_MAX_PASSES = 64;

/**
 * Locale-independent natural ordering for clip names.
 *
 * `gameplay-2.webm` sorts before `gameplay-10.webm` (digit runs compare
 * numerically, everything else compares by code unit, so the result never
 * depends on the host's ICU data). This is the "clip natural order" the plan's
 * tie-breaks are defined on, and it makes the plan independent of the
 * filesystem's iteration order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareClipNaturalOrder(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  const chunk = /\d+|\D+/g;
  const leftParts = left.match(chunk) ?? [];
  const rightParts = right.match(chunk) ?? [];
  const shared = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < shared; index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  if (leftParts.length !== rightParts.length) {
    return leftParts.length < rightParts.length ? -1 : 1;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The maximal contiguous in-band runs of one capture, in **video** time.
 *
 * A run is the same primitive `longestWindowSeconds` measures — the same
 * cadence step and the same `1.5 × step` gap tolerance — but it keeps the
 * samples, so window edges can be nudged onto a local `smoothed` minimum and
 * growth can snap to real sample times instead of accumulating float drift.
 * Every sample in a run is in-band, so a window that stays inside its run can
 * never wander into another band.
 *
 * @param {IntensityArcCapture} capture
 * @param {IntensityArcBand} band
 * @param {number} sampleRateHz
 * @returns {Array<{ samples: Array<{ seconds: number, smoothed: number }>, durationSeconds: number }>}
 */
function captureBandRuns(capture, band, sampleRateHz) {
  const stepSeconds = 1 / sampleRateHz;
  const gapToleranceSeconds = stepSeconds * 1.5;
  const offsetMs = Number(capture?.offsetMs);
  const toVideoSeconds = (seriesMs) => {
    // Deliberately **unclamped**: a sample recorded before `capture_started`
    // maps to a negative video time, and that footage does not exist. Clamping
    // it to 0 (as `videoTimeMs` does) would pile those samples onto the first
    // frame and make a run look longer than the video really is.
    if (Number.isFinite(offsetMs)) return (seriesMs - offsetMs) / 1000;
    if (typeof capture?.videoTimeMs === 'function') {
      return capture.videoTimeMs(seriesMs) / 1000;
    }
    return seriesMs / 1000;
  };

  const samples = (Array.isArray(capture?.samples) ? capture.samples : [])
    .map((sample) => ({
      seriesMs: Number(sample?.t),
      intensity: Number(sample?.intensity),
      smoothed: Number.isFinite(Number(sample?.smoothed))
        ? Number(sample?.smoothed)
        : Number(sample?.intensity),
    }))
    .filter((sample) => Number.isFinite(sample.seriesMs))
    .sort((left, right) => left.seriesMs - right.seriesMs);

  /** @type {Array<{ samples: Array<{ seconds: number, smoothed: number }>, durationSeconds: number }>} */
  const runs = [];
  /** @type {Array<{ seconds: number, smoothed: number }>} */
  let current = [];

  const closeRun = () => {
    if (current.length === 0) return;
    const first = current[0].seconds;
    const last = current[current.length - 1].seconds;
    runs.push({ samples: current, durationSeconds: roundSeconds(last - first + stepSeconds) });
    current = [];
  };

  for (const sample of samples) {
    if (!bandContains(band, sample.intensity)) {
      closeRun();
      continue;
    }
    const seconds = toVideoSeconds(sample.seriesMs);
    if (seconds < 0) {
      // Recorded before the capture started: there is no footage for it, so it
      // can never be part of a window (the planner measures *video* time).
      closeRun();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous !== undefined && seconds - previous.seconds > gapToleranceSeconds) {
      // A gap between samples means the band was not continuously present.
      closeRun();
    }
    current.push({ seconds, smoothed: sample.smoothed });
  }
  closeRun();

  return runs;
}

/**
 * The sample-index intervals of `run` that no already-planned window occupies.
 *
 * A window occupies `[startIndex, endIndex]` inclusive, so a run that an
 * earlier band (or an earlier window of the same band) consumed is split into
 * the pieces that are still free — the mechanism that makes "no footage is
 * reused" structural rather than a post-hoc check.
 *
 * @param {{ samples: ReadonlyArray<{ seconds: number }> }} run
 * @param {ReadonlyArray<[number, number]>} consumed — inclusive index pairs.
 * @returns {Array<[number, number]>} inclusive, ascending, non-overlapping.
 */
function freeIndexPieces(run, consumed) {
  const last = run.samples.length - 1;
  /** @type {Array<[number, number]>} */
  const pieces = [];
  let cursor = 0;
  const sorted = [...consumed].sort((left, right) => left[0] - right[0]);
  for (const [startIndex, endIndex] of sorted) {
    if (endIndex < cursor) continue;
    if (startIndex > cursor && startIndex <= last) {
      pieces.push([cursor, Math.min(startIndex - 1, last)]);
    }
    cursor = Math.max(cursor, endIndex + 1);
    if (cursor > last) break;
  }
  if (cursor <= last) pieces.push([cursor, last]);
  return pieces;
}

/**
 * Picks the sample a cut should land on: the lowest `smoothed` value in range,
 * with ties resolved by distance to the original edge and then by the earlier
 * sample. A cut therefore lands on (at worst) a local `smoothed` minimum, never
 * mid-spike (parent item assumption 2).
 *
 * @param {ReadonlyArray<{ seconds: number, smoothed: number }>} samples
 * @param {ReadonlyArray<number>} indices
 * @param {number} originalSeconds
 * @returns {number} the chosen index.
 */
function pickSmoothedMinimum(samples, indices, originalSeconds) {
  let best = indices[0];
  for (const index of indices) {
    const candidate = samples[index];
    const incumbent = samples[best];
    if (candidate.smoothed < incumbent.smoothed - TIME_EPSILON) {
      best = index;
      continue;
    }
    if (Math.abs(candidate.smoothed - incumbent.smoothed) > TIME_EPSILON) continue;
    const candidateDistance = Math.abs(candidate.seconds - originalSeconds);
    const incumbentDistance = Math.abs(incumbent.seconds - originalSeconds);
    if (candidateDistance < incumbentDistance - TIME_EPSILON) {
      best = index;
      continue;
    }
    if (Math.abs(candidateDistance - incumbentDistance) <= TIME_EPSILON && index < best) {
      best = index;
    }
  }
  return best;
}

/**
 * Moves one window's edges onto local `smoothed` minima within
 * `config.edgeNudgeSeconds`, keeping the window inside its own run piece and no
 * shorter than `config.minWindowSeconds`.
 *
 * The nudge is bounded to the same contiguous in-band run, so it can never
 * overlap another window, leave the band, or change the window's source clip.
 *
 * @param {{
 *   run: { samples: ReadonlyArray<{ seconds: number, smoothed: number }> },
 *   pieceStartIndex: number,
 *   pieceEndIndex: number,
 *   startIndex: number,
 *   endIndex: number,
 * }} window
 * @param {IntensityArcConfig} config
 * @returns {{ startIndex: number, endIndex: number }}
 */
function nudgeWindowEdges(window, config) {
  const { samples } = window.run;
  const nudgeSamples = Math.max(
    0,
    Math.round(config.edgeNudgeSeconds * config.sampleRateHz),
  );
  const minSamples = Math.max(
    1,
    Math.round(config.minWindowSeconds * config.sampleRateHz),
  );

  let startIndex = window.startIndex;
  let endIndex = window.endIndex;

  const startCandidates = [];
  const latestStart = Math.min(
    startIndex + nudgeSamples,
    endIndex - (minSamples - 1),
    window.pieceEndIndex,
  );
  for (
    let index = Math.max(window.pieceStartIndex, startIndex - nudgeSamples);
    index <= latestStart;
    index += 1
  ) {
    startCandidates.push(index);
  }
  if (startCandidates.length > 0) {
    startIndex = pickSmoothedMinimum(samples, startCandidates, samples[window.startIndex].seconds);
  }

  const endCandidates = [];
  const earliestEnd = Math.max(
    endIndex - nudgeSamples,
    startIndex + (minSamples - 1),
    window.pieceStartIndex,
  );
  const latestEnd = Math.min(endIndex + nudgeSamples, window.pieceEndIndex);
  for (let index = earliestEnd; index <= latestEnd; index += 1) {
    endCandidates.push(index);
  }
  if (endCandidates.length > 0) {
    endIndex = pickSmoothedMinimum(samples, endCandidates, samples[window.endIndex].seconds);
  }

  return { startIndex, endIndex };
}

/**
 * Selects the footage windows for **one** band: the fewest windows reaching the
 * band's target, drawn from the longest free runs first, each window at least
 * `config.minWindowSeconds` long.
 *
 * Runs come from every capture in the corpus (pooling), in clip natural order,
 * and whatever a window occupies is recorded in `consumedByKey`, so no later
 * band can reuse that footage. When the free footage cannot reach the target
 * the band is reported as a **shortfall** with the required seconds and the
 * longest single window any capture offers — computed from this real selection
 * pass, never an estimate.
 *
 * @param {IntensityArcBand} band
 * @param {ReadonlyArray<{ key: string, capture: IntensityArcCapture }>} orderedCorpus
 * @param {Map<string, Array<[number, number]>>} consumedByKey — inclusive index pairs per capture key.
 * @param {IntensityArcConfig} config
 * @returns {{ windows: Array<any>, shortfall: BandAvailability | null }}
 */
function selectBandWindows(band, orderedCorpus, consumedByKey, config) {
  const stepSeconds = 1 / config.sampleRateHz;
  const minSamples = Math.max(1, Math.round(config.minWindowSeconds * config.sampleRateHz));

  /** @type {Array<{ key: string, capture: IntensityArcCapture, run: any, pieceStartIndex: number, pieceEndIndex: number, durationSeconds: number }>} */
  const candidates = [];
  let longestAvailableSeconds = 0;

  for (const entry of orderedCorpus) {
    const runs = captureBandRuns(entry.capture, band, config.sampleRateHz);
    for (const run of runs) {
      longestAvailableSeconds = Math.max(longestAvailableSeconds, run.durationSeconds);
      // Sample indices are run-local, so consumption is tracked per
      // (capture, band) — the only scope in which a run can be split.
      const consumed = consumedByKey.get(`${entry.key}|${band.name}`) ?? [];
      for (const [pieceStartIndex, pieceEndIndex] of freeIndexPieces(run, consumed)) {
        const durationSeconds = roundSeconds(
          run.samples[pieceEndIndex].seconds - run.samples[pieceStartIndex].seconds + stepSeconds,
        );
        if (durationSeconds + TIME_EPSILON < config.minWindowSeconds) continue;
        candidates.push({
          key: entry.key,
          capture: entry.capture,
          run,
          pieceStartIndex,
          pieceEndIndex,
          durationSeconds,
        });
      }
    }
  }

  const totalAvailableSeconds = candidates.reduce(
    (total, candidate) => total + candidate.durationSeconds,
    0,
  );
  const shortfall = {
    band: band.name,
    requiredSeconds: band.targetSeconds,
    longestAvailableSeconds,
    satisfiable: false,
  };
  if (totalAvailableSeconds + TIME_EPSILON < band.targetSeconds) {
    return { windows: [], shortfall };
  }

  // Fewest windows: longest free piece first; ties by clip natural order then
  // earliest start. `candidates` is built in natural order, so the index in
  // that array is the deterministic tie-breaker.
  const ordered = candidates
    .map((candidate, order) => ({ candidate, order }))
    .sort((left, right) => {
      const delta = right.candidate.durationSeconds - left.candidate.durationSeconds;
      if (Math.abs(delta) > TIME_EPSILON) return delta;
      return left.order - right.order;
    })
    .map((entry) => entry.candidate);

  /** @type {Array<any>} */
  const windows = [];
  let remainingSeconds = band.targetSeconds;
  for (const candidate of ordered) {
    if (remainingSeconds <= TIME_EPSILON) break;
    const availableSamples = candidate.pieceEndIndex - candidate.pieceStartIndex + 1;
    const wantedSamples = Math.max(1, Math.round(remainingSeconds * config.sampleRateHz));
    let takeSamples = Math.min(availableSamples, wantedSamples);
    if (takeSamples < minSamples) {
      // A short remainder cannot stand alone: over-deliver to the minimum
      // window length from this piece instead of emitting a stub window.
      takeSamples = Math.min(availableSamples, minSamples);
    }
    const startIndex = candidate.pieceStartIndex;
    const endIndex = startIndex + takeSamples - 1;
    windows.push({
      band: band.name,
      key: candidate.key,
      capture: candidate.capture,
      run: candidate.run,
      pieceStartIndex: candidate.pieceStartIndex,
      pieceEndIndex: candidate.pieceEndIndex,
      startIndex,
      endIndex,
    });
    remainingSeconds -=
      candidate.run.samples[endIndex].seconds -
      candidate.run.samples[startIndex].seconds +
      stepSeconds;
    const consumedKey = `${candidate.key}|${band.name}`;
    const consumed = consumedByKey.get(consumedKey) ?? [];
    consumed.push([startIndex, endIndex]);
    consumedByKey.set(consumedKey, consumed);
  }

  if (remainingSeconds > TIME_EPSILON) {
    // Defensive: the feasibility check above guarantees this cannot happen, so
    // a residual means the selection pass and the availability sum disagree.
    return { windows: [], shortfall };
  }
  return { windows, shortfall: null };
}

/** One window's footage length, in seconds, from its sample indices. */
function windowDurationSeconds(window, stepSeconds) {
  return (
    window.run.samples[window.endIndex].seconds -
    window.run.samples[window.startIndex].seconds +
    stepSeconds
  );
}

/**
 * Grows one window by up to `amountSeconds` of extra footage, **end edge
 * first**, staying inside its own run piece (so it can never overlap another
 * window or leave the band).
 *
 * @returns {number} the footage actually added, in seconds.
 */
function growWindowBy(window, amountSeconds, sampleRateHz) {
  const stepSeconds = 1 / sampleRateHz;
  let remaining = amountSeconds;
  let grew = 0;

  const endRoomSamples = window.pieceEndIndex - window.endIndex;
  if (endRoomSamples > 0 && remaining > TIME_EPSILON) {
    const takeSamples = Math.min(
      endRoomSamples,
      Math.max(0, Math.floor((remaining + TIME_EPSILON) / stepSeconds)),
    );
    if (takeSamples > 0) {
      const before = window.run.samples[window.endIndex].seconds;
      window.endIndex += takeSamples;
      const added = window.run.samples[window.endIndex].seconds - before;
      grew += added;
      remaining -= added;
    }
  }

  const startRoomSamples = window.startIndex - window.pieceStartIndex;
  if (startRoomSamples > 0 && remaining > TIME_EPSILON) {
    const takeSamples = Math.min(
      startRoomSamples,
      Math.max(0, Math.floor((remaining + TIME_EPSILON) / stepSeconds)),
    );
    if (takeSamples > 0) {
      const before = window.run.samples[window.startIndex].seconds;
      window.startIndex -= takeSamples;
      const added = before - window.run.samples[window.startIndex].seconds;
      grew += added;
      remaining -= added;
    }
  }

  return grew;
}

/**
 * Distributes the inter-window fade overlap across the planned windows so the
 * **rendered** timeline delivers the arc's targets.
 *
 * `vidc` cross-fades consecutive clips, so `n` windows render
 * `Σ durations − (n − 1) × fadeSeconds` seconds (parent item assumption 3).
 * The planner therefore adds exactly `(n − 1) × fadeSeconds` of footage: the
 * extra is shared evenly, in arc order, by growing each window into the slack
 * of its own contiguous in-band run (end edge first).
 *
 * @returns {number} the extra footage the plan could not accommodate (0 when
 *   the compensation was applied in full).
 */
function compensateFadeOverlap(windows, config) {
  const extraSeconds = Math.max(0, (windows.length - 1) * config.fadeSeconds);
  if (extraSeconds <= TIME_EPSILON) return 0;

  const stepSeconds = 1 / config.sampleRateHz;
  let remaining = extraSeconds;
  // One sample per window per pass, so the extra footage is shared evenly in
  // arc order (an uneven remainder lands on the earlier bands). The pass bound
  // is the sample count needed plus a window's worth of no-progress passes.
  const maxPasses = Math.ceil(extraSeconds / stepSeconds) + windows.length + 8;
  let passes = 0;
  while (remaining > TIME_EPSILON && passes < maxPasses) {
    passes += 1;
    let progressed = false;
    for (const window of windows) {
      if (remaining <= TIME_EPSILON) break;
      const added = growWindowBy(
        window,
        Math.min(remaining, stepSeconds),
        config.sampleRateHz,
      );
      if (added > TIME_EPSILON) {
        remaining -= added;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return remaining > TIME_EPSILON ? remaining : 0;
}

/** The arc's rendered total, in seconds: the sum of every band target. */
function planTargetSeconds(config) {
  return config.bands.reduce((total, band) => total + band.targetSeconds, 0);
}

/**
 * Rounds a seconds value to microseconds.
 *
 * Sample-grid arithmetic accumulates binary rounding (`10.299999999999999`).
 * Six decimals is far below a video frame (33.3 ms at 30 fps) and keeps the
 * emitted plan, its metadata and the `.otio` numbers readable while staying
 * deterministic.
 */
function roundSeconds(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

/** Round-trip formatting used only in shortfall messages. */
function formatSeconds(value) {
  return `${Number(value).toFixed(3)}s`;
}

/**
 * Plans the promo's intensity arc: the ordered, non-overlapping footage windows
 * that deliver **10 s high → 7 s medium → 7 s medium+ → 10 s very high** on the
 * rendered timeline.
 *
 * Selection rules (parent item AC3):
 *
 * - arc order comes from `config.bands` (high → medium → medium+ → very high);
 * - windows are never reused and never overlap inside one source clip —
 *   consumption is tracked per capture as inclusive sample-index intervals;
 * - each band uses the **fewest** windows that reach its target, the longest
 *   free runs first, every window at least `config.minWindowSeconds`;
 * - footage is pooled across captures, but one window always comes from one
 *   capture (an `.otio` `source_range` is per clip);
 * - window edges are nudged to local `smoothed` minima within
 *   `config.edgeNudgeSeconds`;
 * - the fade overlap is compensated so the rendered total is the arc's 34 s,
 *   not 34 s minus the overlaps;
 * - ties resolve by clip natural order, then earliest `t`, so the plan is
 *   reproducible byte-for-byte from the same inputs.
 *
 * A band that cannot be filled throws {@link IntensityArcShortfallError} naming
 * the band, the required seconds and the longest window available — never a
 * silently shorter arc.
 *
 * @param {ReadonlyArray<IntensityArcCapture>} captures — the ingest corpus.
 * @param {IntensityArcConfig} [config]
 * @returns {IntensityArcPlanWindow[]} windows in arc order, each with its in
 *   point (`inSeconds` / `videoTimeSeconds`, seconds on the source clip's video
 *   timeline) and its duration (`durationSeconds`).
 * @throws {IntensityArcShortfallError}
 */
export function planIntensityArc(captures, config = DEFAULT_INTENSITY_ARC_CONFIG) {
  const orderedCorpus = (Array.isArray(captures) ? captures : [])
    .map((capture, index) => ({
      key: `${capture?.stem ?? capture?.clip ?? ''}#${index}`,
      capture,
      index,
      clip: String(capture?.clip ?? capture?.stem ?? ''),
    }))
    .sort((left, right) => {
      const byName = compareClipNaturalOrder(left.clip, right.clip);
      return byName !== 0 ? byName : left.index - right.index;
    });

  /** @type {Map<string, Array<[number, number]>>} */
  const consumedByKey = new Map();
  /** @type {Array<any>} */
  const chosen = [];
  /** @type {BandAvailability[]} */
  const shortfalls = [];

  for (const band of config.bands) {
    const selection = selectBandWindows(band, orderedCorpus, consumedByKey, config);
    if (selection.shortfall !== null) {
      shortfalls.push(selection.shortfall);
      continue;
    }
    chosen.push(...selection.windows);
  }

  if (shortfalls.length > 0) {
    const detail = shortfalls
      .map(
        (entry) =>
          `${entry.band}: needs ${entry.requiredSeconds}s, longest available ${entry.longestAvailableSeconds}s`,
      )
      .join('; ');
    throw new IntensityArcShortfallError(
      `Intensity arc cannot be filled from the available footage — ${detail}. ` +
        'Re-capture footage with longer stretches of that band, pool more runs, or retune DEFAULT_INTENSITY_ARC_CONFIG (scripts/intensity-arc.mjs).',
      shortfalls,
    );
  }

  // Nudge every cut onto a local smoothed minimum before any compensation
  // growth: the nudge is inward-biased by the target window, and the fade
  // compensation pass below tops the plan back up to the arc length.
  const nudged = chosen.map((window) => ({
    ...window,
    ...nudgeWindowEdges(window, config),
  }));

  const uncompensated = compensateFadeOverlap(nudged, config);
  const stepSeconds = 1 / config.sampleRateHz;
  if (uncompensated > TIME_EPSILON) {
    const footageSeconds = nudged.reduce(
      (total, window) => total + windowDurationSeconds(window, stepSeconds),
      0,
    );
    throw new IntensityArcShortfallError(
      `Intensity arc cannot deliver the ${planTargetSeconds(config)}s rendered arc: ` +
        `the selected windows leave only ${formatSeconds(footageSeconds)} of footage, ` +
        `which cannot absorb the ${formatSeconds(uncompensated)} inter-window fade compensation that remains. ` +
        'Re-capture longer runs of the arc bands, or lower DEFAULT_INTENSITY_ARC_CONFIG.fadeSeconds.',
      [],
    );
  }

  return nudged.map((window) => {
    const startSeconds = roundSeconds(window.run.samples[window.startIndex].seconds);
    return Object.freeze({
      band: /** @type {IntensityArcBandName} */ (window.band),
      sourceStem: String(window.capture?.stem ?? ''),
      inSeconds: startSeconds,
      durationSeconds: roundSeconds(windowDurationSeconds(window, stepSeconds)),
      videoTimeSeconds: startSeconds,
    });
  });
}

/**
 * Summarises a plan: delivered footage, the rendered total (footage minus the
 * inter-window fade overlaps) and the per-band delivered seconds.
 *
 * The planner's own totals, not a re-derivation: the CLI's `--dry-run` output
 * and the `.otio` metadata both quote this, so the numbers a producer reads are
 * the numbers the plan actually contains.
 *
 * @param {ReadonlyArray<IntensityArcPlanWindow>} plan
 * @param {IntensityArcConfig} [config]
 * @returns {IntensityArcPlanTotals}
 */
export function planTotals(plan, config = DEFAULT_INTENSITY_ARC_CONFIG) {
  const windows = Array.isArray(plan) ? plan : [];
  /** @type {Record<string, number>} */
  const byBand = {};
  for (const band of config.bands) byBand[band.name] = 0;
  let footageSeconds = 0;
  for (const window of windows) {
    const duration = Number(window?.durationSeconds) || 0;
    footageSeconds += duration;
    if (window?.band !== undefined) {
      byBand[window.band] = (byBand[window.band] ?? 0) + duration;
    }
  }
  const fadeSeconds = windows.length > 0 ? (windows.length - 1) * config.fadeSeconds : 0;
  return {
    windows: windows.length,
    footageSeconds,
    fadeSeconds,
    renderedSeconds: footageSeconds - fadeSeconds,
    byBand,
  };
}

/**
 * Per-band availability across the usable corpus: the target, the longest
 * contiguous window any single capture offers, and whether that window meets
 * the target.
 *
 * A window comes from one source clip (an `.otio` `source_range` is per clip),
 * so the longest available window for a band is the **maximum** contiguous run
 * across captures — not a sum, and never a window that straddles two clips.
 *
 * @param {ReadonlyArray<IntensityArcCapture>} captures
 * @param {IntensityArcConfig} [config]
 * @returns {BandAvailability[]}
 */
export function bandAvailability(
  captures,
  config = DEFAULT_INTENSITY_ARC_CONFIG,
) {
  const corpus = Array.isArray(captures) ? captures : [];
  return config.bands.map((band) => {
    let longestAvailableSeconds = 0;
    for (const capture of corpus) {
      const sampleRateHz = Number(capture?.sampleRateHz) || config.sampleRateHz;
      longestAvailableSeconds = Math.max(
        longestAvailableSeconds,
        longestWindowSeconds(band, capture?.samples ?? [], { sampleRateHz }),
      );
    }
    return {
      band: band.name,
      requiredSeconds: band.targetSeconds,
      longestAvailableSeconds,
      satisfiable: longestAvailableSeconds >= band.targetSeconds,
    };
  });
}

/**
 * Fails loudly when any band cannot be filled: the error names the band, the
 * required seconds and the longest window available for every shortfall, so
 * the run never delivers a silently shorter arc. Returns the full availability
 * table when every band is satisfiable.
 *
 * @param {ReadonlyArray<IntensityArcCapture>} captures
 * @param {IntensityArcConfig} [config]
 * @returns {BandAvailability[]}
 * @throws {IntensityArcShortfallError}
 */
export function assertArcBandsSatisfiable(
  captures,
  config = DEFAULT_INTENSITY_ARC_CONFIG,
) {
  const availability = bandAvailability(captures, config);
  const shortfalls = availability.filter((entry) => !entry.satisfiable);
  if (shortfalls.length === 0) return availability;

  const detail = shortfalls
    .map(
      (entry) =>
        `${entry.band}: needs ${entry.requiredSeconds}s, longest available ${entry.longestAvailableSeconds}s`,
    )
    .join('; ');
  throw new IntensityArcShortfallError(
    `Intensity arc cannot be filled from the available footage — ${detail}. ` +
      'Re-capture footage with longer stretches of that band, pool more runs, or retune DEFAULT_INTENSITY_ARC_CONFIG (scripts/intensity-arc.mjs).',
    shortfalls,
  );
}

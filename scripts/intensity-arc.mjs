/**
 * Pure intensity-arc planner primitives for the `capture:promo` pipeline
 * (AH-0MWPD4QRO007WMJ1, first slice of AH-0MWPCLYYG007NUJY).
 *
 * This module is the **first slice** of the planner: it ingests every
 * capture's recorded action-intensity series, joins series time to video time
 * through the §7.5 anchor, and owns the **single** band/target config object
 * the promo arc is planned from. Window selection, fade compensation and
 * `.otio` emission are the follow-up slices; they consume the primitives here
 * (in particular the shared `longestWindowSeconds` run-length helper) rather
 * than re-deriving anything.
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

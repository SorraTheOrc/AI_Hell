/**
 * Pure action-intensity series export helpers for the capture pipeline
 * (AH-0MVDV4DMY001Z7CU).
 *
 * The gameplay capture (`scripts/capture-gameplay.mjs`) records the run with
 * telemetry enabled (local dev JSONL sink), so the page-side
 * `state.actionIntensity` samples land in `localStorage` under
 * `ai_hell_telemetry_jsonl` (doc `docs/dev/action-intensity.md` §7.1/§8.2).
 * This module turns that recorded stream into the two artefacts the promo
 * compile pipeline consumes, next to each captured WebM (§7.3/§7.5):
 *
 * 1. `<run-id>.action.jsonl` — the standalone action-intensity series, using
 *    the **exact** format of `src/scenes/core/actionIntensitySerialiser.ts`
 *    (self-describing header + one sample line per recorded sample). The
 *    serialiser is ported here byte-for-byte because the capture script is
 *    plain ESM JavaScript (no TypeScript loader); the parity test
 *    (`scripts/capture-gameplay.test.ts`) asserts the port never drifts from
 *    the canonical TS module.
 * 2. `<run-id>.capture.json` — the §7.5 video-join anchor: the recording-
 *    start marker (`capture_started`, epoch ms) plus the telemetry run
 *    header's `startedAt` (epoch ms), so a consumer can map series `t` to
 *    WebM timeline time offline and deterministically.
 *
 * Every function here is **pure**: no browser, no filesystem, no clock. The
 * capture script owns the `page.evaluate` read and the file writes; this
 * module only parses/builds strings and objects, so it is hermetically
 * unit-testable without a browser or ffmpeg (AC4).
 *
 * @module scripts/capture-series
 */

/**
 * Telemetry envelope schema version the series mirrors (§7.2; identical to
 * `src/telemetry/schema.ts` `TELEMETRY_SCHEMA_VERSION` and the TS
 * serialiser's `ACTION_INTENSITY_SERIES_SCHEMA_VERSION`).
 */
export const ACTION_INTENSITY_SERIES_SCHEMA_VERSION = 1;

/**
 * The series file extension appended to the WebM basename (§7.3):
 * `gameplay-<ts>.webm` → `gameplay-<ts>.action.jsonl`.
 */
export const ACTION_INTENSITY_SERIES_EXTENSION = '.action.jsonl';

/** The join-anchor sidecar extension: `gameplay-<ts>.capture.json` (§7.5). */
export const CAPTURE_ANCHOR_EXTENSION = '.capture.json';

/**
 * The action-intensity sampling rate the game records at (§6.5), mirrored
 * from `DEFAULT_ACTION_INTENSITY_CONFIG.sampleRateHz` in
 * `src/scenes/core/actionIntensity.ts`. The series' `t` grid is derived from
 * it (`t = i / sampleRateHz`), so a consumer knows the sample cadence
 * without reading the game's config.
 */
export const DEFAULT_ACTION_INTENSITY_SAMPLE_RATE_HZ = 10;

/**
 * The ordered category list the series header carries (§6.1/§7.2), mirrored
 * from `ACTION_INTENSITY_CATEGORIES` in `src/scenes/core/actionIntensity.ts`.
 * Read-only so a consumer can map a breakdown without hard-coding it.
 */
export const ACTION_INTENSITY_SERIES_CATEGORIES = Object.freeze([
  'playerBullets',
  'enemyBullets',
  'enemies',
  'asteroids',
  'drops',
  'enemyExplosions',
  'bossExplosions',
  'playerExplosions',
  'bosses',
]);

/**
 * `localStorage` key the page's dev JSONL telemetry sink appends to
 * (mirrors `TELEMETRY_JSONL_STORAGE_KEY` in `src/telemetry/sinks.ts`). The
 * capture re-enables telemetry so the recorded run leaves its
 * `state.actionIntensity` samples here; the series exporter reads them back.
 */
export const CAPTURE_TELEMETRY_JSONL_KEY = 'ai_hell_telemetry_jsonl';

/**
 * The kind discriminator of the join-anchor sidecar record (AC2). Versioned
 * with the series schema so a consumer can migrate both artefacts together.
 */
export const CAPTURE_ANCHOR_KIND = 'capture-join-anchor';

/**
 * Strips the `.webm` extension (case-insensitive) from a capture output
 * path. Any other extension is stripped too, so `--output demo` (no
 * extension) still yields `demo` rather than `demo.capture`. Pure — never
 * touches the filesystem.
 *
 * @param {string} webmPath — the captured WebM path.
 * @returns {string} the basename stem the sidecar names derive from.
 */
export function captureSeriesStem(webmPath) {
  // Name derivation is basename-level only (s7.3): directory components and
  // any leading absolute root are dropped so the sidecar always sits next to
  // the WebM it describes (`clips/demo-2.webm` -> `demo-2`, `/tmp/x/gameplay-a.webm`
  // -> `gameplay-a`). The last path separator is the split point regardless of
  // platform (POSIX `/` and Windows `\\`).
  const raw = String(webmPath);
  const lastSep = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const basename = lastSep >= 0 ? raw.slice(lastSep + 1) : raw;
  const match = /\.[^./\\]+$/.exec(basename);
  if (!match) return basename;
  // Strip `.webm` exactly when present; strip any other trailing extension
  // the same way so `demo` stays `demo` but `demo.webm` becomes `demo`.
  const trimmed = basename.slice(0, -match[0].length);
  return match[0].toLowerCase() === '.webm' ? trimmed : basename;
}

/**
 * The series file name for a capture output path (§7.3): the WebM basename
 * with the extension replaced by `.action.jsonl`
 * (`gameplay-<ts>.webm` → `gameplay-<ts>.action.jsonl`). Basename-level only,
 * so the series sits alongside the WebM wherever it was written.
 *
 * @param {string} webmPath
 * @returns {string}
 */
export function actionIntensitySeriesFileName(webmPath) {
  return `${captureSeriesStem(webmPath)}${ACTION_INTENSITY_SERIES_EXTENSION}`;
}

/**
 * The join-anchor sidecar file name for a capture output path (§7.5): the
 * WebM basename with the extension replaced by `.capture.json`
 * (`gameplay-<ts>.webm` → `gameplay-<ts>.capture.json`).
 *
 * @param {string} webmPath
 * @returns {string}
 */
export function captureAnchorFileName(webmPath) {
  return `${captureSeriesStem(webmPath)}${CAPTURE_ANCHOR_EXTENSION}`;
}

/**
 * Serialises one input sample to its series line object — the exact shape
 * `src/scenes/core/actionIntensitySerialiser.ts` writes (§7.2):
 * `schemaVersion`, `t`, `tick`, the four scores and the per-category
 * `breakdown`.
 *
 * @param {{ t: number, tick: number, actionIntensity: object }} sample
 * @returns {object}
 */
export function actionIntensitySeriesLine(sample) {
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
 * Serialises a run's samples to the JSONL series artefact (§7.2) — the
 * byte-for-byte port of `serialiseActionIntensitySeries` from
 * `src/scenes/core/actionIntensitySerialiser.ts`.
 *
 * The first line is the self-describing header (`schemaVersion`, `runSeed`,
 * `sampleRateHz`, ordered `categories`); each subsequent line is one sample
 * (`t`, `tick`, the four scores, the `breakdown`). Every line is terminated
 * by a newline (append-friendly) and carries `schemaVersion`, so a truncated
 * file is still self-identifying. An empty `samples` array yields a
 * header-only file — a partial run is valid (AC1/AC3).
 *
 * @param {{ runSeed: number, sampleRateHz: number, samples: object[] }} input
 * @returns {string}
 */
export function serialiseActionIntensitySeries(input) {
  const lines = [
    JSON.stringify({
      schemaVersion: ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
      runSeed: input.runSeed,
      sampleRateHz: input.sampleRateHz,
      categories: [...ACTION_INTENSITY_SERIES_CATEGORIES],
    }),
  ];
  for (const sample of input.samples) {
    lines.push(JSON.stringify(actionIntensitySeriesLine(sample)));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Deep-equality of two action-intensity samples. Compares the four scores
 * and every breakdown category, so a duplicated sample (identical values)
 * cannot survive deduplication but a byte-identical object can be reused
 * freely.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function actionIntensitySamplesEqual(a, b) {
  if (!a || !b) return a === b;
  if (a.rawScore !== b.rawScore) return false;
  if (a.intensity !== b.intensity) return false;
  if (a.smoothed !== b.smoothed) return false;
  if (a.burstiness !== b.burstiness) return false;

  const ba = a.breakdown;
  const bb = b.breakdown;
  if (!ba || !bb) return ba === bb;
  for (const category of ACTION_INTENSITY_SERIES_CATEGORIES) {
    if (ba[category] !== bb[category]) return false;
  }
  return true;
}

/**
 * True when a decoded record has a usable action-intensity sample — a `tick`
 * record whose `state.actionIntensity` is an object with finite numeric
 * scores and a plain breakdown. Records without the metric (telemetry off,
 * a non-tick record, a malformed line) are skipped, so a partial or
 * truncated run degrades to fewer samples rather than failing.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function hasActionIntensitySample(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.kind !== 'tick') return false;
  const state = record.state;
  if (!state || typeof state !== 'object') return false;
  const ai = state.actionIntensity;
  if (!ai || typeof ai !== 'object') return false;
  if (!Number.isFinite(Number(ai.rawScore))) return false;
  if (!Number.isFinite(Number(ai.intensity))) return false;
  if (!Number.isFinite(Number(ai.smoothed))) return false;
  if (!Number.isFinite(Number(ai.burstiness))) return false;
  const breakdown = ai.breakdown;
  if (!breakdown || typeof breakdown !== 'object') return false;
  return true;
}

/**
 * Extracts the action-intensity series from parsed telemetry records.
 *
 * Walks the records in order: the run header supplies `runSeed` and
 * `startedAt` (epoch ms); every `tick` with a `state.actionIntensity` sample
 * contributes a sample. If the sink holds **more than one run** (a reused
 * page's `localStorage`, or a batch item that failed to clear), the series
 * describes the run opened by the **last** `run_header` — the sample list is
 * reset at every header, so an earlier run's ticks cannot leak into the
 * export. Consecutive records may carry the **same** computed sample (the
 * recorder computes at most one sample per `1 / sampleRateHz` seconds and
 * reuses the last value for the ticks in between), so identical consecutive
 * samples are collapsed into one series sample — the series has one line per
 * *recorded* tick of the metric, matching the documented artefact (§7.2).
 *
 * Each emitted sample's `t` is **real time since the run started**, not a
 * count of retained samples: collapsing duplicates must not compress the
 * timeline (AH-0MVFI5OQN008XGBV). The tick record's own wall clock
 * (`recordedAt`, epoch ms — stamped by the telemetry recorder) is the time
 * base, relative to the run header's `startedAt`; when the header carries no
 * `startedAt` the first sample's clock becomes the origin, and when a record
 * predates the origin the value is clamped to 0. A legacy capture whose
 * ticks have no `recordedAt` falls back to the documented sample grid
 * (`i * 1000 / sampleRateHz`), which is the pre-clock behaviour and is only
 * as accurate as the grid.
 *
 * A run with telemetry disabled, or a run interrupted before any sample, is
 * valid: the result is a header with no samples (AC3 — header-only series).
 * `runSeed`/`startedAt` are `null` when no run header was recorded, so the
 * anchor can flag the join as approximate instead of pretending to know the
 * run start.
 *
 * @param {object[]} records — decoded telemetry records (`run_header`/`tick`/`event`).
 * @param {{ sampleRateHz?: number }} [options]
 * @returns {{ runSeed: number|null, startedAt: number|null, samples: Array<{ t: number, tick: number, actionIntensity: object }> }}
 */
export function extractActionIntensitySeriesFromRecords(
  records,
  options = {},
) {
  const rate = Number(options.sampleRateHz);
  const sampleRateHz =
    Number.isFinite(rate) && rate > 0
      ? rate
      : DEFAULT_ACTION_INTENSITY_SAMPLE_RATE_HZ;
  const gridMs = 1000 / sampleRateHz;

  let runSeed = null;
  let startedAt = null;
  // Clock origin for the current run: the header `startedAt`, or (when the
  // header has none) the first sample's own clock. Reset per run header.
  let originMs = null;
  const samples = [];

  for (const record of Array.isArray(records) ? records : []) {
    if (
      record &&
      typeof record === 'object' &&
      record.kind === 'run_header'
    ) {
      // A new run starts here: adopt its identity and discard any ticks from
      // an earlier run sharing the same sink (batch items, reused pages).
      // The identity is reset first, so an earlier run's header can never
      // supply the new run's clock.
      runSeed = null;
      startedAt = null;
      if (Number.isFinite(Number(record.runSeed))) {
        runSeed = Number(record.runSeed);
      }
      // A null/absent/non-numeric `startedAt` means the run header carries
      // no clock (legacy/partial) — never coerce null to 0 (which is a real
      // epoch and would silently date the timeline to 1970).
      if (
        record.startedAt !== null &&
        record.startedAt !== undefined &&
        Number.isFinite(Number(record.startedAt))
      ) {
        startedAt = Number(record.startedAt);
      }
      originMs = startedAt;
      samples.length = 0;
      continue;
    }
    if (!hasActionIntensitySample(record)) continue;

    const ai = record.state.actionIntensity;
    const previous = samples[samples.length - 1];
    // Collapse consecutive records that reused the same computed sample.
    if (previous && actionIntensitySamplesEqual(previous.actionIntensity, ai)) {
      // Collapse the duplicate re-emission into the existing sample: the
      // value is unchanged, so the first tick that produced it is the one
      // recorded (deterministic, monotonic series). Nothing is mutated.
      continue;
    }

    const recordedAt = Number(record.recordedAt);
    let t;
    if (Number.isFinite(recordedAt)) {
      // Real time from the record's own wall clock (the authoritative base).
      if (originMs === null) originMs = recordedAt;
      t = Math.max(0, Math.round(recordedAt - originMs));
    } else {
      // Legacy capture: no per-tick clock, so fall back to the documented
      // sampler grid — as accurate as that grid, never denser.
      t = Math.round(samples.length * gridMs);
    }
    // A clock adjustment must never rewind the series.
    if (previous) t = Math.max(t, previous.t);

    samples.push({
      t,
      tick: Number(record.tick),
      actionIntensity: {
        rawScore: Number(ai.rawScore),
        intensity: Number(ai.intensity),
        smoothed: Number(ai.smoothed),
        burstiness: Number(ai.burstiness),
        breakdown: { ...ai.breakdown },
      },
    });
  }

  return { runSeed, startedAt, samples };
}

/**
 * Builds the §7.5 video-join anchor object persisted as
 * `<run-id>.capture.json` (AC2).
 *
 * The join needs the shared clock anchor between the series' `t` (ms since
 * run start) and the WebM playback timeline:
 *
 *   videoTimeMs(t) ≈ t − (capture_started − run_startedAt)
 *
 * so the anchor carries both epoch-ms values and the precomputed
 * `offsetMs = capture_started − run_startedAt` (a consumer can just
 * subtract `offsetMs`). When either input is missing (an older recording
 * without the dev marker, telemetry disabled, a non-finite value) the
 * affected field is `null`, `offsetMs` is `null` and `approximate` is `true`
 * — the join must then fall back to the documented `--warmup` heuristic and
 * flag the mapping as approximate (§7.5).
 *
 * @param {{
 *   captureStarted?: { event: string, atEpochMs: number } | null,
 *   runStartedAtEpochMs?: number | null,
 * }} [anchor]
 * @returns {{
 *   schemaVersion: number,
 *   kind: 'capture-join-anchor',
 *   captureStartedAtEpochMs: number|null,
 *   runStartedAtEpochMs: number|null,
 *   offsetMs: number|null,
 *   approximate: boolean,
 * }}
 */
export function buildCaptureJoinAnchor(anchor = {}) {
  const rawCapture = anchor.captureStarted?.atEpochMs;
  const captureStartedAtEpochMs =
    Number.isFinite(Number(rawCapture)) ? Math.trunc(Number(rawCapture)) : null;
  const rawRunStart = anchor.runStartedAtEpochMs;
  const runStartedAtEpochMs =
    Number.isFinite(Number(rawRunStart)) ? Math.trunc(Number(rawRunStart)) : null;

  const offsetMs =
    captureStartedAtEpochMs !== null && runStartedAtEpochMs !== null
      ? captureStartedAtEpochMs - runStartedAtEpochMs
      : null;

  return {
    schemaVersion: ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
    kind: CAPTURE_ANCHOR_KIND,
    captureStartedAtEpochMs,
    runStartedAtEpochMs,
    offsetMs,
    approximate: offsetMs === null,
  };
}

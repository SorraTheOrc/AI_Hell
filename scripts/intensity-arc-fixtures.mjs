/**
 * Pure fixture builders for the intensity-arc planner corpus
 * (AH-0MWPD4OZH001M74F).
 *
 * ## Fixture contract
 *
 * The committed corpus lives in `scripts/fixtures/intensity-arc/` and is
 * **generated, never hand-edited**. Each capture is described by a plateau spec
 * — an ordered list of `{ fromT, toT, intensity }` half-open millisecond ranges
 * — and serialised through the canonical helpers in
 * `scripts/capture-series.mjs`:
 *
 * - `<name>.action.jsonl` via `serialiseActionIntensitySeries` /
 *   `actionIntensitySeriesLine`, so the fixture format can never drift from the
 *   recorded one (`docs/dev/action-intensity.md` §7.2);
 * - `<name>.capture.json` via `buildCaptureJoinAnchor` (§7.5).
 *
 * A capture with `anchor: null` has **no** `.capture.json` (the missing-anchor
 * case). An anchor with only null timestamps is the `approximate: true` case.
 *
 * **Adding a case:** append an entry to `INTENSITY_ARC_FIXTURE_CASES`, regenerate
 * with `node scripts/intensity-arc-fixtures.mjs --write`, and commit the
 * generated files. `scripts/intensity-arc.test.ts` asserts the committed bytes
 * equal `buildFixtureCorpus()`, so ad-hoc JSON cannot slip into the corpus.
 *
 * Every function here is pure: no clock, no randomness, no filesystem. Only the
 * `--write` CLI (guarded by `import.meta.url`) touches disk.
 *
 * @module scripts/intensity-arc-fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ACTION_INTENSITY_SERIES_CATEGORIES,
  ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
  buildCaptureJoinAnchor,
  serialiseActionIntensitySeries,
} from './capture-series.mjs';

/** Directory (relative to the repository root) holding the committed corpus. */
export const INTENSITY_ARC_FIXTURE_DIR = 'scripts/fixtures/intensity-arc';

/** The 10 Hz cadence every recorded series uses (§6.5). */
export const FIXTURE_SAMPLE_RATE_HZ = 10;

/** Deterministic run seed carried by every fixture header. */
export const FIXTURE_RUN_SEED = 20261120;

/**
 * Base epoch (2025-01-15T00:00:00Z) the fixture anchors are offset from, so a
 * join test can assert an exact `offsetMs` without a clock.
 */
export const FIXTURE_RUN_STARTED_AT_EPOCH_MS = 1736899200000;

/** One half-open, constant-intensity plateau in series time (`t`, ms). */
export const FIXTURE_PLATEAUS = Object.freeze({
  /** All four bands, contiguous, each comfortably above its 7/7/10/10 s target. */
  plateaus: Object.freeze([
    { fromT: 0, toT: 8000, intensity: 0.46 },
    { fromT: 8000, toT: 16000, intensity: 0.6 },
    { fromT: 16000, toT: 27000, intensity: 0.7 },
    { fromT: 27000, toT: 38000, intensity: 0.82 },
  ]),
  /** Very high totals 5 s — the unsatisfiable ("shortfall") case. */
  'short-band': Object.freeze([
    { fromT: 0, toT: 8000, intensity: 0.46 },
    { fromT: 8000, toT: 16000, intensity: 0.6 },
    { fromT: 16000, toT: 27000, intensity: 0.7 },
    { fromT: 27000, toT: 32000, intensity: 0.82 },
  ]),
  /** A capture that only carries medium + high. */
  'two-runs-a': Object.freeze([
    { fromT: 0, toT: 8000, intensity: 0.46 },
    { fromT: 8000, toT: 19000, intensity: 0.7 },
  ]),
  /** The complementary capture: medium+ and very high only. */
  'two-runs-b': Object.freeze([
    { fromT: 0, toT: 8000, intensity: 0.6 },
    { fromT: 8000, toT: 19000, intensity: 0.82 },
  ]),
  /** Series with sample lines, but no usable `intensity` on any of them. */
  'no-samples': Object.freeze([
    { fromT: 0, toT: 3000, intensity: 0.6 },
    { fromT: 3000, toT: 6000, intensity: 0.82 },
  ]),
  /** A series whose join anchor is missing entirely. */
  'missing-anchor': Object.freeze([
    { fromT: 0, toT: 4000, intensity: 0.46 },
    { fromT: 4000, toT: 9000, intensity: 0.7 },
  ]),
  /** A series whose join anchor is flagged approximate (no clock markers). */
  approx: Object.freeze([
    { fromT: 0, toT: 8000, intensity: 0.46 },
    { fromT: 8000, toT: 19000, intensity: 0.7 },
  ]),
});

/**
 * The corpus definition — one entry per capture stem. `anchor: null` means the
 * capture has a series but no join anchor (do not write a `.capture.json`);
 * otherwise the anchor is built from the two epoch-ms markers.
 */
export const INTENSITY_ARC_FIXTURE_CASES = Object.freeze([
  {
    name: 'plateaus',
    plateaus: FIXTURE_PLATEAUS.plateaus,
    anchor: {
      runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
      captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 2000,
    },
  },
  {
    name: 'short-band',
    plateaus: FIXTURE_PLATEAUS['short-band'],
    anchor: {
      runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
      captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 1500,
    },
  },
  {
    name: 'header-only',
    plateaus: [],
    anchor: {
      runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
      captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 1000,
    },
  },
  {
    name: 'no-samples',
    plateaus: FIXTURE_PLATEAUS['no-samples'],
    omitIntensity: true,
    anchor: {
      runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
      captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 1000,
    },
  },
  {
    name: 'missing-anchor',
    plateaus: FIXTURE_PLATEAUS['missing-anchor'],
    anchor: null,
  },
  {
    name: 'approx',
    plateaus: FIXTURE_PLATEAUS.approx,
    anchor: { runStartedAtEpochMs: null, captureStartedAtEpochMs: null },
  },
  {
    name: 'two-runs-a',
    plateaus: FIXTURE_PLATEAUS['two-runs-a'],
    anchor: {
      runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
      captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 2500,
    },
  },
  {
    name: 'two-runs-b',
    plateaus: FIXTURE_PLATEAUS['two-runs-b'],
    anchor: {
      runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 60000,
      captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS + 60000 + 3500,
    },
  },
]);

/** An empty per-category breakdown, keyed exactly like the series header. */
function emptyBreakdown() {
  /** @type {Record<string, number>} */
  const breakdown = {};
  for (const category of ACTION_INTENSITY_SERIES_CATEGORIES) breakdown[category] = 0;
  return breakdown;
}

/**
 * Derives the recorded scores for a constant-intensity plateau: the four
 * scores are self-consistent with `intensity = R / (R + 30)`, and a flat
 * plateau has `smoothed === intensity` and zero burstiness.
 */
function plateauScores(intensity) {
  const rawScore = Number(((30 * intensity) / (1 - intensity)).toFixed(3));
  return { rawScore, intensity, smoothed: intensity, burstiness: 0 };
}

/**
 * Validates a plateau spec: ordered, non-overlapping, positive-duration,
 * finite intensity in `[0, 1)`. Throws an actionable error (a fixture spec is
 * developer input, so a bad one must fail at build time, not produce nonsense).
 *
 * @param {ReadonlyArray<{ fromT: number, toT: number, intensity: number }>} plateaus
 */
function assertPlateaus(plateaus) {
  let previousTo = -Infinity;
  plateaus.forEach((plateau, index) => {
    const label = `plateau[${index}]`;
    for (const field of ['fromT', 'toT', 'intensity']) {
      if (!Number.isFinite(plateau[field])) {
        throw new TypeError(`${label}.${field} must be a finite number.`);
      }
    }
    if (plateau.fromT >= plateau.toT) {
      throw new TypeError(`${label} must have fromT < toT (got ${plateau.fromT} → ${plateau.toT}).`);
    }
    if (plateau.fromT < previousTo) {
      throw new TypeError(
        `${label} overlaps or precedes the previous plateau (fromT ${plateau.fromT} < ${previousTo}).`,
      );
    }
    if (plateau.intensity < 0 || plateau.intensity >= 1) {
      throw new TypeError(`${label}.intensity must be in [0, 1) (got ${plateau.intensity}).`);
    }
    previousTo = plateau.toT;
  });
}

/**
 * Turns a plateau spec into series samples at the recorded cadence.
 *
 * Each plateau is half-open (`fromT` inclusive, `toT` exclusive) with one
 * sample every `1000 / sampleRateHz` ms, so a 8 000 ms plateau at 10 Hz yields
 * exactly 80 samples. `t` is series time in ms and `tick` is a contiguous
 * counter across the whole series; both are deterministic.
 *
 * @param {ReadonlyArray<{ fromT: number, toT: number, intensity: number }>} plateaus
 * @param {{ sampleRateHz?: number, startTick?: number, omitIntensity?: boolean }} [options]
 * @returns {Array<{ t: number, tick: number, actionIntensity: Record<string, unknown> }>}
 */
export function buildPlateauSamples(plateaus, options = {}) {
  const {
    sampleRateHz = FIXTURE_SAMPLE_RATE_HZ,
    startTick = 0,
    omitIntensity = false,
  } = options;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new TypeError(`sampleRateHz must be a positive number (got ${sampleRateHz}).`);
  }
  assertPlateaus(plateaus);

  const stepMs = 1000 / sampleRateHz;
  /** @type {Array<{ t: number, tick: number, actionIntensity: Record<string, unknown> }>} */
  const samples = [];
  let tick = startTick;

  for (const plateau of plateaus) {
    const count = Math.round((plateau.toT - plateau.fromT) / stepMs);
    if (count < 1) {
      throw new TypeError(
        `plateau ${plateau.fromT}–${plateau.toT} ms is shorter than one ${sampleRateHz} Hz sample.`,
      );
    }
    const scores = plateauScores(plateau.intensity);
    const actionIntensity = {
      rawScore: scores.rawScore,
      smoothed: scores.smoothed,
      burstiness: scores.burstiness,
      breakdown: emptyBreakdown(),
    };
    if (!omitIntensity) actionIntensity.intensity = scores.intensity;
    for (let index = 0; index < count; index += 1) {
      const t = Math.round((plateau.fromT + index * stepMs) * 1000) / 1000;
      samples.push({ t, tick, actionIntensity: { ...actionIntensity, breakdown: { ...actionIntensity.breakdown } } });
      tick += 1;
    }
  }

  return samples;
}

/**
 * Builds the serialiser input for a capture: run identity plus plateau samples.
 *
 * @param {ReadonlyArray<{ fromT: number, toT: number, intensity: number }>} plateaus
 * @param {{ sampleRateHz?: number, runSeed?: number, startTick?: number, omitIntensity?: boolean }} [options]
 */
export function buildIntensitySeries(plateaus, options = {}) {
  const {
    sampleRateHz = FIXTURE_SAMPLE_RATE_HZ,
    runSeed = FIXTURE_RUN_SEED,
    startTick = 0,
    omitIntensity = false,
  } = options;
  return {
    runSeed,
    sampleRateHz,
    samples: buildPlateauSamples(plateaus, { sampleRateHz, startTick, omitIntensity }),
  };
}

/**
 * Serialises a capture's series to the committed `.action.jsonl` text — through
 * the canonical `serialiseActionIntensitySeries`, never a bespoke writer.
 *
 * @param {ReadonlyArray<{ fromT: number, toT: number, intensity: number }>} plateaus
 * @param {{ sampleRateHz?: number, runSeed?: number, startTick?: number, omitIntensity?: boolean }} [options]
 * @returns {string}
 */
export function serialisePlateauSeries(plateaus, options = {}) {
  return serialiseActionIntensitySeries(buildIntensitySeries(plateaus, options));
}

/**
 * Builds the §7.5 join anchor for a fixture from its two epoch-ms markers via
 * the canonical `buildCaptureJoinAnchor` (so `approximate`/`offsetMs` semantics
 * are the recorded ones). Null markers yield `approximate: true`.
 *
 * @param {{ runStartedAtEpochMs: number | null, captureStartedAtEpochMs: number | null }} markers
 */
export function buildFixtureAnchor(markers) {
  const captureStartedAtEpochMs = markers.captureStartedAtEpochMs;
  return buildCaptureJoinAnchor({
    captureStarted:
      captureStartedAtEpochMs === null || captureStartedAtEpochMs === undefined
        ? null
        : { event: 'capture_started', atEpochMs: captureStartedAtEpochMs },
    runStartedAtEpochMs: markers.runStartedAtEpochMs,
  });
}

/**
 * Serialises a join anchor as the committed `.capture.json` text (2-space JSON
 * plus a trailing newline, matching the capture writer's sidecar style).
 *
 * @param {ReturnType<typeof buildFixtureAnchor>} anchor
 * @returns {string}
 */
export function serialiseCaptureAnchor(anchor) {
  return `${JSON.stringify(anchor, null, 2)}\n`;
}

/**
 * Thrown when committed fixture text does not match the series schema. The
 * message names the offending line and field so a drift fails loudly with an
 * actionable fix.
 */
export class FixtureSchemaError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FixtureSchemaError';
  }
}

/**
 * Parses and validates `.action.jsonl` fixture text against the recorded series
 * schema (header `schemaVersion`/`sampleRateHz`/`categories`, and a
 * `schemaVersion` plus finite scores on every sample line).
 *
 * `requireIntensity` defaults to `true`; the `no-samples` fixture (deliberately
 * missing `intensity`) is the only caller that relaxes it, so every other
 * fixture is proven usable by the planner.
 *
 * @param {string} text
 * @param {{ requireIntensity?: boolean, expectedSampleRateHz?: number }} [options]
 * @returns {{
 *   header: { schemaVersion: number, runSeed: number, sampleRateHz: number, categories: string[] },
 *   samples: Array<Record<string, any>>,
 *   sampleCount: number,
 * }}
 */
export function parseSeriesFixture(text, options = {}) {
  const {
    requireIntensity = true,
    expectedSampleRateHz = FIXTURE_SAMPLE_RATE_HZ,
  } = options;
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new FixtureSchemaError(
      'Series fixture is empty: expected a header line first (see docs/dev/action-intensity.md §7.2).',
    );
  }

  /** @type {any} */
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new FixtureSchemaError(`Invalid JSON on line 1 (series header): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!header || typeof header !== 'object') {
    throw new FixtureSchemaError('Series header on line 1 must be a JSON object.');
  }
  if (header.schemaVersion !== ACTION_INTENSITY_SERIES_SCHEMA_VERSION) {
    throw new FixtureSchemaError(
      `Series header line 1: schemaVersion ${header.schemaVersion} does not match the recorded schema ${ACTION_INTENSITY_SERIES_SCHEMA_VERSION}.`,
    );
  }
  if (header.sampleRateHz !== expectedSampleRateHz) {
    throw new FixtureSchemaError(
      `Series header line 1: sampleRateHz ${header.sampleRateHz} does not match the recorded rate ${expectedSampleRateHz}.`,
    );
  }
  const expectedCategories = [...ACTION_INTENSITY_SERIES_CATEGORIES];
  if (JSON.stringify(header.categories) !== JSON.stringify(expectedCategories)) {
    throw new FixtureSchemaError(
      `Series header line 1: categories ${JSON.stringify(header.categories)} do not match the recorded categories ${JSON.stringify(expectedCategories)}.`,
    );
  }

  /** @type {Array<Record<string, any>>} */
  const samples = [];
  for (let index = 1; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    /** @type {any} */
    let sample;
    try {
      sample = JSON.parse(lines[index]);
    } catch (error) {
      throw new FixtureSchemaError(
        `Invalid JSON on line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sample || typeof sample !== 'object') {
      throw new FixtureSchemaError(`Series sample line ${lineNumber} must be a JSON object.`);
    }
    if (sample.schemaVersion !== ACTION_INTENSITY_SERIES_SCHEMA_VERSION) {
      throw new FixtureSchemaError(
        `Series sample line ${lineNumber}: schemaVersion ${sample.schemaVersion} does not match the recorded schema ${ACTION_INTENSITY_SERIES_SCHEMA_VERSION}.`,
      );
    }
    for (const field of ['t', 'tick', 'rawScore', 'smoothed', 'burstiness']) {
      if (!Number.isFinite(sample[field])) {
        throw new FixtureSchemaError(
          `Series sample line ${lineNumber}: ${field} must be a finite number (got ${JSON.stringify(sample[field])}).`,
        );
      }
    }
    if (!sample.breakdown || typeof sample.breakdown !== 'object') {
      throw new FixtureSchemaError(`Series sample line ${lineNumber}: breakdown must be an object.`);
    }
    if (requireIntensity && !Number.isFinite(sample.intensity)) {
      throw new FixtureSchemaError(
        `Series sample line ${lineNumber}: intensity must be a finite number (got ${JSON.stringify(sample.intensity)}); omit requireIntensity only for the deliberate no-samples fixture.`,
      );
    }
    samples.push(sample);
  }

  return { header, samples, sampleCount: samples.length };
}

/**
 * Builds the complete committed corpus: file name → exact file text. This is
 * the single source of truth the test compares the committed files against and
 * the `--write` CLI persists.
 *
 * @returns {Record<string, string>}
 */
export function buildFixtureCorpus() {
  /** @type {Record<string, string>} */
  const corpus = {};
  for (const testCase of INTENSITY_ARC_FIXTURE_CASES) {
    corpus[`${testCase.name}.action.jsonl`] = serialisePlateauSeries(testCase.plateaus, {
      omitIntensity: testCase.omitIntensity === true,
    });
    if (testCase.anchor) {
      corpus[`${testCase.name}.capture.json`] = serialiseCaptureAnchor(
        buildFixtureAnchor(testCase.anchor),
      );
    }
  }
  return corpus;
}

/**
 * `--write` CLI: regenerates the committed corpus from `buildFixtureCorpus()`.
 * Prints a JSON report (always JSON, per repo CLI convention). Without
 * `--write` it only reports the files it would produce.
 *
 * @param {string[]} [argv]
 * @returns {number} process exit code
 */
export function main(argv = []) {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const targetDir = `${repoRoot}${INTENSITY_ARC_FIXTURE_DIR}`;
  const corpus = buildFixtureCorpus();
  const files = Object.keys(corpus).sort();
  const write = argv.includes('--write');

  if (!write) {
    process.stdout.write(`${JSON.stringify({ dir: INTENSITY_ARC_FIXTURE_DIR, files, written: false }, null, 2)}\n`);
    return 0;
  }

  mkdirSync(targetDir, { recursive: true });
  for (const fileName of files) {
    writeFileSync(`${targetDir}/${fileName}`, corpus[fileName], 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ dir: INTENSITY_ARC_FIXTURE_DIR, files, written: true }, null, 2)}\n`);
  return 0;
}

// Run only when executed directly (`node scripts/intensity-arc-fixtures.mjs`),
// never when imported by the test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

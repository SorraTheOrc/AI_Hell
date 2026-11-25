/**
 * Fixture-loading tests for the intensity-arc planner corpus
 * (AH-0MWPD4OZH001M74F).
 *
 * These tests cover **only** the committed synthetic corpus under
 * `scripts/fixtures/intensity-arc/` and the pure builders that produce it
 * (`scripts/intensity-arc-fixtures.mjs`). They deliberately know nothing about
 * the planner: the planner tests consume this corpus in the follow-up items.
 *
 * Everything here is a filesystem read of committed files plus pure parsing —
 * no browser, no network, no capture footage — so the corpus is usable from the
 * plain `unit` project.
 *
 * The corpus is **generated, never hand-edited**: `buildFixtureCorpus()`
 * regenerates every file from the plateau specs through
 * `serialiseActionIntensitySeries` / `buildCaptureJoinAnchor`, and the first
 * test asserts the committed bytes match. A drifted fixture therefore fails
 * here instead of quietly feeding a wrong-format series to the planner.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACTION_INTENSITY_SERIES_CATEGORIES,
  ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
  CAPTURE_ANCHOR_KIND,
} from './capture-series.mjs';
import {
  FIXTURE_SAMPLE_RATE_HZ,
  FixtureSchemaError,
  INTENSITY_ARC_FIXTURE_DIR,
  buildFixtureCorpus,
  parseSeriesFixture,
} from './intensity-arc-fixtures.mjs';

/** Repository root, resolved from this test file rather than `cwd`. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_ROOT = `${REPO_ROOT}${INTENSITY_ARC_FIXTURE_DIR}/`;

/** The sample interval of the committed corpus, in seconds. */
const SAMPLE_STEP_SECONDS = 1 / FIXTURE_SAMPLE_RATE_HZ;

/**
 * The four arc bands exactly as the planner defines them (inclusive `min`,
 * exclusive `max`, with the top band unbounded). Duplicated here on purpose so
 * a fixture cannot be "fixed" by silently moving a band boundary.
 */
const BANDS: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: 'medium', min: 0.4, max: 0.55 },
  { name: 'medium+', min: 0.55, max: 0.65 },
  { name: 'high', min: 0.65, max: 0.75 },
  { name: 'very high', min: 0.75, max: Number.POSITIVE_INFINITY },
];

/** Band targets from the parent item (7/7/10/10 s). */
const BAND_TARGETS_SECONDS: Readonly<Record<string, number>> = {
  medium: 7,
  'medium+': 7,
  high: 10,
  'very high': 10,
};

function bandOf(intensity: number): string | null {
  for (const band of BANDS) {
    if (intensity >= band.min && intensity < band.max) return band.name;
  }
  return null;
}

function fixturePath(fileName: string): string {
  return `${FIXTURE_ROOT}${fileName}`;
}

function readSeries(fileName: string, options?: { requireIntensity?: boolean }) {
  return parseSeriesFixture(readFileSync(fixturePath(fileName), 'utf8'), options);
}

function readAnchor(fileName: string) {
  return JSON.parse(readFileSync(fixturePath(fileName), 'utf8'));
}

/**
 * Total seconds of footage per band for a parsed series — every sample stands
 * for one sample interval, so a contiguous plateau of 80 samples at 10 Hz is
 * exactly 8 s regardless of where it starts.
 */
function bandSeconds(parsed: ReturnType<typeof readSeries>): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const sample of parsed.samples) {
    const band = bandOf(sample.intensity as number);
    if (!band) continue;
    totals[band] = (totals[band] ?? 0) + SAMPLE_STEP_SECONDS;
  }
  return totals;
}

/** Longest **contiguous** run per band, in seconds. */
function longestBandRunSeconds(parsed: ReturnType<typeof readSeries>): Record<string, number> {
  const longest: Record<string, number> = {};
  let runBand: string | null = null;
  let runSamples = 0;
  const closeRun = () => {
    if (runBand !== null) {
      longest[runBand] = Math.max(longest[runBand] ?? 0, runSamples * SAMPLE_STEP_SECONDS);
    }
    runBand = null;
    runSamples = 0;
  };
  for (const sample of parsed.samples) {
    const band = bandOf(sample.intensity as number);
    if (band === null) {
      closeRun();
      continue;
    }
    if (band !== runBand) {
      closeRun();
      runBand = band;
    }
    runSamples += 1;
  }
  closeRun();
  return longest;
}

const PLATEAU_FIXTURES = ['plateaus', 'short-band', 'two-runs-a', 'two-runs-b'] as const;

describe('intensity-arc committed fixture corpus (AH-0MWPD4OZH001M74F)', () => {
  it('matches the pure builders byte-for-byte (fixtures are generated, not hand-edited)', () => {
    const corpus = buildFixtureCorpus();
    const committed = readdirSync(FIXTURE_ROOT)
      .filter((name) => name.endsWith('.action.jsonl') || name.endsWith('.capture.json'))
      .sort();

    expect(committed).toEqual(Object.keys(corpus).sort());
    for (const [fileName, expected] of Object.entries(corpus)) {
      expect(readFileSync(fixturePath(fileName), 'utf8'), fileName).toBe(expected);
    }
  });

  it('commits every series with a valid self-describing header', () => {
    for (const fileName of readdirSync(FIXTURE_ROOT).filter((name) => name.endsWith('.action.jsonl'))) {
      const parsed = readSeries(fileName, { requireIntensity: false });
      expect(parsed.header.schemaVersion, fileName).toBe(ACTION_INTENSITY_SERIES_SCHEMA_VERSION);
      expect(parsed.header.sampleRateHz, fileName).toBe(FIXTURE_SAMPLE_RATE_HZ);
      expect(parsed.header.categories, fileName).toEqual([...ACTION_INTENSITY_SERIES_CATEGORIES]);
      for (const sample of parsed.samples) {
        expect(sample.schemaVersion, fileName).toBe(ACTION_INTENSITY_SERIES_SCHEMA_VERSION);
        expect(Number.isFinite(sample.t), `${fileName} t`).toBe(true);
        expect(Number.isFinite(sample.tick), `${fileName} tick`).toBe(true);
        expect(Number.isFinite(sample.rawScore), `${fileName} rawScore`).toBe(true);
        expect(Number.isFinite(sample.smoothed), `${fileName} smoothed`).toBe(true);
        expect(Number.isFinite(sample.burstiness), `${fileName} burstiness`).toBe(true);
        expect(typeof sample.breakdown, `${fileName} breakdown`).toBe('object');
      }
    }
  });

  it('covers all four bands with contiguous duration at or above the 7/7/10/10 s targets', () => {
    const parsed = readSeries('plateaus.action.jsonl');
    const totals = bandSeconds(parsed);
    const contiguous = longestBandRunSeconds(parsed);

    for (const band of BANDS) {
      const target = BAND_TARGETS_SECONDS[band.name];
      expect(totals[band.name], `${band.name} total`).toBeGreaterThanOrEqual(target);
      expect(contiguous[band.name], `${band.name} contiguous`).toBeGreaterThanOrEqual(target);
    }
  });

  it('keeps every plateaus sample inside its declared band (inclusive min, exclusive max)', () => {
    const parsed = readSeries('plateaus.action.jsonl');
    expect(parsed.samples.length).toBeGreaterThan(0);
    for (const sample of parsed.samples) {
      expect(bandOf(sample.intensity as number), `intensity ${sample.intensity}`).not.toBeNull();
    }
  });

  it('commits the shortfall case: very high totals under 10 s', () => {
    const parsed = readSeries('short-band.action.jsonl');
    const totals = bandSeconds(parsed);
    expect(totals['very high'] ?? 0).toBeGreaterThan(0);
    expect(totals['very high'] ?? 0).toBeLessThan(BAND_TARGETS_SECONDS['very high']);
    // The other bands stay satisfiable, so the shortfall is unambiguous.
    for (const band of ['medium', 'medium+', 'high']) {
      expect(totals[band], band).toBeGreaterThanOrEqual(BAND_TARGETS_SECONDS[band]);
    }
  });

  it('commits a header-only series (header, zero sample lines)', () => {
    const parsed = readSeries('header-only.action.jsonl');
    expect(parsed.samples).toEqual([]);
    const lines = readFileSync(fixturePath('header-only.action.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
  });

  it('commits a sample-less series whose lines carry no usable intensity', () => {
    const parsed = readSeries('no-samples.action.jsonl', { requireIntensity: false });
    expect(parsed.samples.length).toBeGreaterThan(0);
    for (const sample of parsed.samples) {
      expect(Number.isFinite(sample.intensity as number)).toBe(false);
    }
    // Requiring intensity must reject it loudly — the planner uses this to skip.
    expect(() => readSeries('no-samples.action.jsonl')).toThrow(FixtureSchemaError);
  });

  it('commits an approximate join anchor and a missing-anchor capture', () => {
    const approximate = readAnchor('approx.capture.json');
    expect(approximate.kind).toBe(CAPTURE_ANCHOR_KIND);
    expect(approximate.approximate).toBe(true);
    expect(approximate.offsetMs).toBeNull();

    expect(existsSync(fixturePath('missing-anchor.action.jsonl'))).toBe(true);
    expect(existsSync(fixturePath('missing-anchor.capture.json'))).toBe(false);
  });

  it('commits a usable anchor for every non-approximate capture', () => {
    for (const fileName of readdirSync(FIXTURE_ROOT).filter((name) => name.endsWith('.capture.json'))) {
      const anchor = readAnchor(fileName);
      expect(anchor.kind, fileName).toBe(CAPTURE_ANCHOR_KIND);
      expect(anchor.schemaVersion, fileName).toBe(ACTION_INTENSITY_SERIES_SCHEMA_VERSION);
      if (anchor.approximate) {
        expect(anchor.offsetMs, fileName).toBeNull();
      } else {
        expect(Number.isFinite(anchor.offsetMs), `${fileName} offsetMs`).toBe(true);
        expect(anchor.offsetMs, fileName).toBe(
          anchor.captureStartedAtEpochMs - anchor.runStartedAtEpochMs,
        );
      }
    }
  });

  it('pools two captures so neither alone covers all four bands but the pair does', () => {
    const first = bandSeconds(readSeries('two-runs-a.action.jsonl'));
    const second = bandSeconds(readSeries('two-runs-b.action.jsonl'));

    expect(first['medium'] ?? 0).toBeGreaterThanOrEqual(BAND_TARGETS_SECONDS['medium']);
    expect(first['high'] ?? 0).toBeGreaterThanOrEqual(BAND_TARGETS_SECONDS['high']);
    expect(first['medium+'] ?? 0).toBe(0);
    expect(first['very high'] ?? 0).toBe(0);

    expect(second['medium+'] ?? 0).toBeGreaterThanOrEqual(BAND_TARGETS_SECONDS['medium+']);
    expect(second['very high'] ?? 0).toBeGreaterThanOrEqual(BAND_TARGETS_SECONDS['very high']);
    expect(second['medium'] ?? 0).toBe(0);
    expect(second['high'] ?? 0).toBe(0);

    const pooled: Record<string, number> = {};
    for (const totals of [first, second]) {
      for (const [band, seconds] of Object.entries(totals)) {
        pooled[band] = (pooled[band] ?? 0) + seconds;
      }
    }
    for (const band of BANDS) {
      expect(pooled[band.name], `pooled ${band.name}`).toBeGreaterThanOrEqual(
        BAND_TARGETS_SECONDS[band.name],
      );
    }
  });

  it('names each capture after its series stem so the planner can find the pair', () => {
    for (const fileName of readdirSync(FIXTURE_ROOT).filter((name) => name.endsWith('.action.jsonl'))) {
      const stem = fileName.slice(0, -'.action.jsonl'.length);
      expect(stem.length).toBeGreaterThan(0);
    }
  });
});

describe('intensity-arc fixture schema validation fails loudly (AH-0MWPD4OZH001M74F)', () => {
  const header = readFileSync(fixturePath('plateaus.action.jsonl'), 'utf8').split('\n')[0];
  const firstSample = readFileSync(fixturePath('plateaus.action.jsonl'), 'utf8').split('\n')[1];

  it('rejects a header whose schemaVersion drifted', () => {
    const drifted = header.replace('"schemaVersion":1', '"schemaVersion":2');
    expect(() => parseSeriesFixture(`${drifted}\n${firstSample}\n`)).toThrow(/schemaVersion/);
  });

  it('rejects a header whose sampleRateHz drifted', () => {
    const drifted = header.replace('"sampleRateHz":10', '"sampleRateHz":5');
    expect(() => parseSeriesFixture(`${drifted}\n${firstSample}\n`)).toThrow(/sampleRateHz/);
  });

  it('rejects a sample line with no intensity when intensity is required', () => {
    const stripped = firstSample.replace(/,"intensity":[^,]+/, '');
    expect(() => parseSeriesFixture(`${header}\n${stripped}\n`)).toThrow(/intensity/);
  });

  it('rejects malformed JSON with the offending line number', () => {
    expect(() => parseSeriesFixture(`${header}\nnot-json\n`)).toThrow(/line 2/);
  });

  it('rejects an empty file', () => {
    expect(() => parseSeriesFixture('')).toThrow(FixtureSchemaError);
  });
});

/**
 * Guard that the fixture path constant is relative to the repository root, so
 * the same string works from the module, the tests and the `--write` CLI.
 */
describe('intensity-arc fixture location contract (AH-0MWPD4OZH001M74F)', () => {
  it('keeps the corpus under scripts/fixtures/intensity-arc', () => {
    expect(INTENSITY_ARC_FIXTURE_DIR).toBe('scripts/fixtures/intensity-arc');
    for (const fileName of PLATEAU_FIXTURES) {
      expect(existsSync(fixturePath(`${fileName}.action.jsonl`)), fileName).toBe(true);
    }
  });
});

/**
 * Hermetic tests for the standalone action-intensity JSONL serialiser
 * (AH-0MUZQF0FR008WRNM; decision doc §7.2–§7.3).
 *
 * These assert the on-disk contract a consumer relies on — the self-describing
 * header, one sample per line, `schemaVersion` on every line, and tolerance of
 * header-only / truncated files — rather than the internals of the writer.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ACTION_INTENSITY_CONFIG,
  type ActionIntensitySample,
} from './actionIntensity';
import {
  ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
  actionIntensitySeriesFileName,
  actionIntensitySeriesPath,
  parseActionIntensitySeries,
  serialiseActionIntensitySeries,
  type ActionIntensitySeriesInput,
} from './actionIntensitySerialiser';

function sample(
  rawScore: number,
  intensity: number,
  smoothed: number,
  burstiness: number,
): ActionIntensitySample {
  return {
    rawScore,
    intensity,
    smoothed,
    burstiness,
    breakdown: {
      playerBullets: 4,
      enemyBullets: 11,
      enemies: 6,
      asteroids: 0,
      drops: 1,
      enemyExplosions: 0,
      bossExplosions: 0,
      playerExplosions: 0,
      bosses: 0,
    },
  };
}

const INPUT: ActionIntensitySeriesInput = {
  runSeed: 123456789,
  sampleRateHz: DEFAULT_ACTION_INTENSITY_CONFIG.sampleRateHz,
  samples: [
    { t: 0, tick: 0, actionIntensity: sample(8, 0.21, 0.21, 0) },
    { t: 100, tick: 6, actionIntensity: sample(13.5, 0.31, 0.24, 0.07) },
  ],
};

describe('serialiseActionIntensitySeries (AC5)', () => {
  it('writes a self-describing header as the first line', () => {
    const [headerLine] = serialiseActionIntensitySeries(INPUT).split('\n');
    const header = JSON.parse(headerLine);

    expect(header).toEqual({
      schemaVersion: ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
      runSeed: 123456789,
      sampleRateHz: 10,
      categories: [
        'playerBullets',
        'enemyBullets',
        'enemies',
        'asteroids',
        'drops',
        'enemyExplosions',
        'bossExplosions',
        'playerExplosions',
        'bosses',
      ],
    });
  });

  it('writes one sample per line with t in ms and schemaVersion on each', () => {
    const lines = serialiseActionIntensitySeries(INPUT).trimEnd().split('\n');

    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[1]);
    expect(first).toMatchObject({
      schemaVersion: ACTION_INTENSITY_SERIES_SCHEMA_VERSION,
      t: 0,
      tick: 0,
      rawScore: 8,
      intensity: 0.21,
      smoothed: 0.21,
      burstiness: 0,
    });
    expect(first.breakdown.enemyBullets).toBe(11);
    const second = JSON.parse(lines[2]);
    expect(second).toMatchObject({ t: 100, tick: 6, burstiness: 0.07 });
  });

  it('terminates every line with a newline (append-friendly)', () => {
    expect(serialiseActionIntensitySeries(INPUT).endsWith('\n')).toBe(true);
  });

  it('writes a header-only file when there are no samples', () => {
    const text = serialiseActionIntensitySeries({
      ...INPUT,
      samples: [],
    });
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('parseActionIntensitySeries round-trip (AC5)', () => {
  it('recovers the header and every sample', () => {
    const parsed = parseActionIntensitySeries(
      serialiseActionIntensitySeries(INPUT),
    );

    expect(parsed.header?.runSeed).toBe(123456789);
    expect(parsed.header?.sampleRateHz).toBe(10);
    expect(parsed.header?.categories).toContain('playerBullets');
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[1]).toMatchObject({
      t: 100,
      tick: 6,
      rawScore: 13.5,
      intensity: 0.31,
      smoothed: 0.24,
      burstiness: 0.07,
    });
    expect(parsed.samples[0].breakdown).toEqual(
      sample(0, 0, 0, 0).breakdown,
    );
  });

  it('tolerates a truncated final line', () => {
    const text = serialiseActionIntensitySeries(INPUT);
    const truncated = `${text}{"schemaVersion":1,"t":200,"tick":`;
    const parsed = parseActionIntensitySeries(truncated);

    expect(parsed.header).not.toBeNull();
    expect(parsed.samples).toHaveLength(2);
  });

  it('handles a header-only (empty run) file', () => {
    const parsed = parseActionIntensitySeries(
      serialiseActionIntensitySeries({ ...INPUT, samples: [] }),
    );
    expect(parsed.header).not.toBeNull();
    expect(parsed.samples).toHaveLength(0);
  });
});

describe('series location and naming (AC5)', () => {
  it('matches the capture basename with an .action.jsonl suffix', () => {
    expect(actionIntensitySeriesFileName('gameplay-20260101T000000')).toBe(
      'gameplay-20260101T000000.action.jsonl',
    );
  });

  it('places the series alongside the capture output', () => {
    expect(actionIntensitySeriesPath('gameplay-abc')).toBe(
      'capture-output/gameplay-abc.action.jsonl',
    );
  });
});

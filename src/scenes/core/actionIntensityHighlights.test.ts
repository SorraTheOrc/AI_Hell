/**
 * Hermetic tests for the action-intensity video join + highlight selection
 * (AH-0MUZQG13S006KL8K; decision doc §7.5).
 *
 * The join and highlight logic is pure, so every case — anchor present/absent,
 * warm-up clamping, thresholding, gap merging and lead/tail expansion — is
 * asserted without a browser.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HIGHLIGHT_OPTIONS,
  mapHighlightWindowToVideo,
  mapTimeToVideo,
  selectHighlightWindows,
  type ActionIntensitySeriesPoint,
} from './actionIntensityHighlights';

describe('mapTimeToVideo (AC6)', () => {
  it('subtracts the capture/run-start offset from the series time', () => {
    // capture started 2s after the run started.
    expect(mapTimeToVideo(5000, 1_000_200, 1_000_000)).toBe(4800);
  });

  it('clamps warm-up samples that predate the capture start at zero', () => {
    // Sample at t=500 ms, capture started 2 s after the run started.
    expect(mapTimeToVideo(500, 1_002_000, 1_000_000)).toBe(0);
  });

  it('returns the raw series time when the anchor is absent (approximate)', () => {
    expect(mapTimeToVideo(1234, null, 1_000_000)).toBe(1234);
    expect(mapTimeToVideo(1234, 1_002_000, null)).toBe(1234);
  });
});

describe('selectHighlightWindows (AC6)', () => {
  const at = (t: number, intensity = 0, burstiness = 0): ActionIntensitySeriesPoint => ({
    t,
    intensity,
    burstiness,
  });

  it('returns no windows for a quiet series', () => {
    const points = [at(0, 0.1, 0.0), at(100, 0.2, 0.05)];
    expect(selectHighlightWindows(points)).toEqual([]);
  });

  it('selects a peak above the burstiness threshold', () => {
    const points = [at(0), at(1000, 0.2, 0.5), at(2000)];
    // lead 1.5s / tail 1.0s around t=1000, clamped at 0.
    expect(selectHighlightWindows(points)).toEqual([
      { startMs: 0, endMs: 2000 },
    ]);
  });

  it('selects a peak above the intensity threshold', () => {
    const points = [at(10_000, 0.8, 0.0)];
    expect(selectHighlightWindows(points)).toEqual([
      { startMs: 8500, endMs: 11_000 },
    ]);
  });

  it('merges peaks within the gap and their lead/tail windows', () => {
    const points = [at(5000, 0.8, 0), at(5800, 0.8, 0), at(20_000)];
    // 800 ms apart -> one group; expanded and merged into one window.
    expect(selectHighlightWindows(points)).toEqual([
      { startMs: 3500, endMs: 6800 },
    ]);
  });

  it('keeps peaks further apart than the gap as separate windows', () => {
    const points = [at(5000, 0.8, 0), at(10_000, 0.8, 0)];
    const windows = selectHighlightWindows(points);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ startMs: 3500, endMs: 6000 });
    expect(windows[1]).toEqual({ startMs: 8500, endMs: 11_000 });
  });

  it('honours custom thresholds and lead/tail', () => {
    const points = [at(5000, 0.4, 0.05)];
    const windows = selectHighlightWindows(points, {
      ...DEFAULT_HIGHLIGHT_OPTIONS,
      intensityThreshold: 0.3,
      leadMs: 0,
      tailMs: 0,
    });
    expect(windows).toEqual([{ startMs: 5000, endMs: 5000 }]);
  });
});

describe('mapHighlightWindowToVideo (AC6)', () => {
  it('maps both edges through the shared anchor', () => {
    const mapped = mapHighlightWindowToVideo(
      { startMs: 5000, endMs: 9000 },
      1_002_000,
      1_000_000,
    );
    expect(mapped).toEqual({ startMs: 3000, endMs: 7000 });
  });
});

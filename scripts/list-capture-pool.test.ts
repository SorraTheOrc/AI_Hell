/**
 * Hermetic tests for the capture-pool inventory lister
 * (AH-0MVDV4SYG008X8TY, parent AC2/AC3/AC4).
 *
 * The lister (`scripts/list-capture-pool.mjs`) answers two questions the
 * capture-pool item depends on:
 *
 * 1. **Which runs are retained?** Every retained source WebM must have its
 *    sibling `.action.jsonl` series and `.capture.json` join anchor; runs
 *    missing either are excluded and reported (parent AC2).
 * 2. **Which features does each run evidence?** Editorial categories are
 *    recognised from the §7.2 breakdown (`playerBullets`, `drops`,
 *    `enemies`, `bosses`), so the inventory can be validated against the
 *    editorial config before compiling (parent AC3/AC4).
 *
 * Everything here is synthetic — no footage, no ffmpeg, no browser. The
 * filesystem is injected so the collector's exclusion contract is testable
 * without a gitignored `capture-output/` directory.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  POOL_INVENTORY_KIND,
  POOL_INVENTORY_SCHEMA_VERSION,
  buildCapturePoolInventory,
  collectCapturePool,
  formatPoolInventory,
  listCapturePoolMain,
  parseListPoolArgs,
} from './list-capture-pool.mjs';

const HEADER = JSON.stringify({
  schemaVersion: 1,
  runSeed: 42,
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

/** One synthetic series sample with the documented scores + breakdown. */
function sample(t: number, breakdown: Record<string, number>, intensity = 0.4) {
  return {
    schemaVersion: 1,
    t,
    tick: t / 100,
    rawScore: intensity * 50,
    intensity,
    smoothed: intensity * 0.8,
    burstiness: 0.1,
    breakdown: {
      playerBullets: 0,
      enemyBullets: 0,
      enemies: 0,
      asteroids: 0,
      drops: 0,
      enemyExplosions: 0,
      bossExplosions: 0,
      playerExplosions: 0,
      bosses: 0,
      ...breakdown,
    },
  };
}

/** Serialises synthetic samples into the canonical `<run>.action.jsonl`. */
function seriesText(samples: readonly object[]): string {
  return `${[HEADER, ...samples.map((entry) => JSON.stringify(entry))].join('\n')}\n`;
}

const EXACT_ANCHOR = JSON.stringify({
  schemaVersion: 1,
  kind: 'capture-join-anchor',
  captureStartedAtEpochMs: 2_000,
  runStartedAtEpochMs: 1_000,
  offsetMs: 1_000,
  approximate: false,
});

const APPROXIMATE_ANCHOR = JSON.stringify({
  schemaVersion: 1,
  kind: 'capture-join-anchor',
  captureStartedAtEpochMs: null,
  runStartedAtEpochMs: null,
  offsetMs: null,
  approximate: true,
});

/** Complete three-artifact run evidencing weapons, pickups and enemies. */
const COVERING_SERIES = seriesText([
  sample(0, { playerBullets: 3, enemies: 1 }, 0.2),
  sample(1_000, { drops: 1, enemies: 2 }, 0.4),
  sample(2_000, { enemies: 2 }, 0.6),
]);

/** Minimal injectable fs holding a small synthetic pool. */
function fakeFs(files: Record<string, string>, dirs: readonly string[] = ['capture-output']) {
  const reads: string[] = [];
  return {
    reads,
    readdirSync: (dir: string) => {
      if (!dirs.includes(dir)) throw new Error(`ENOENT: ${dir}`);
      return Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => !name.includes('/'));
    },
    existsSync: (path: string) =>
      dirs.includes(path) || Object.prototype.hasOwnProperty.call(files, path),
    readFileSync: (path: string) => {
      reads.push(path);
      if (!Object.prototype.hasOwnProperty.call(files, path)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path];
    },
  };
}

describe('buildCapturePoolInventory', () => {
  it('retains a complete run and reports per-feature series-time evidence', () => {
    const inventory = buildCapturePoolInventory({
      entries: [
        {
          runId: 'run-a',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: COVERING_SERIES,
          anchorText: EXACT_ANCHOR,
        },
      ],
    });

    expect(inventory.schemaVersion).toBe(POOL_INVENTORY_SCHEMA_VERSION);
    expect(inventory.kind).toBe(POOL_INVENTORY_KIND);
    expect(inventory.retained).toHaveLength(1);
    expect(inventory.excluded).toHaveLength(0);

    const run = inventory.retained[0];
    expect(run.runId).toBe('run-a');
    expect(run.sampleCount).toBe(3);
    expect(run.durationMs).toBe(2_000);
    expect(run.meanIntensity).toBeCloseTo(0.4, 4);
    expect(run.anchor).toEqual({ present: true, approximate: false, offsetMs: 1_000 });
    expect(run.features).toEqual([
      { feature: 'weapons', samples: 1, firstTMs: 0, lastTMs: 0 },
      { feature: 'pickups', samples: 1, firstTMs: 1_000, lastTMs: 1_000 },
      { feature: 'enemies', samples: 3, firstTMs: 0, lastTMs: 2_000 },
    ]);

    expect(inventory.features).toEqual([
      { feature: 'weapons', runs: ['run-a'] },
      { feature: 'pickups', runs: ['run-a'] },
      { feature: 'enemies', runs: ['run-a'] },
      { feature: 'boss', runs: [] },
    ]);
    expect(inventory.missingFeatures).toEqual(['boss']);
  });

  it('excludes runs missing any required artifact and explains why', () => {
    const inventory = buildCapturePoolInventory({
      entries: [
        {
          runId: 'legacy-webm',
          webmPresent: true,
          seriesPresent: false,
          anchorPresent: false,
        },
        {
          runId: 'no-anchor',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: false,
          seriesText: COVERING_SERIES,
        },
        {
          runId: 'orphan-series',
          webmPresent: false,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: COVERING_SERIES,
          anchorText: EXACT_ANCHOR,
        },
      ],
    });

    expect(inventory.retained).toHaveLength(0);
    expect(inventory.excluded.map((run) => run.runId)).toEqual([
      'legacy-webm',
      'no-anchor',
      'orphan-series',
    ]);
    expect(inventory.excluded[0].missing).toEqual(['series', 'anchor']);
    expect(inventory.excluded[0].reasons).toEqual([
      'missing action-intensity series capture-output/legacy-webm.action.jsonl',
      'missing join anchor capture-output/legacy-webm.capture.json',
    ]);
    expect(inventory.excluded[1].missing).toEqual(['anchor']);
    expect(inventory.excluded[2].missing).toEqual(['webm']);
    // Excluded runs never contribute feature evidence.
    expect(inventory.features.every((entry) => entry.runs.length === 0)).toBe(true);
    expect(inventory.missingFeatures).toEqual(['weapons', 'pickups', 'enemies', 'boss']);
  });

  it('reports present-but-unreadable artifacts instead of claiming they are missing', () => {
    const inventory = buildCapturePoolInventory({
      entries: [
        {
          runId: 'broken',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: null,
          anchorText: null,
        },
      ],
    });

    expect(inventory.excluded[0].missing).toEqual(['series', 'anchor']);
    expect(inventory.excluded[0].reasons).toEqual([
      'unreadable action-intensity series capture-output/broken.action.jsonl',
      'unreadable join anchor capture-output/broken.capture.json',
    ]);
  });

  it('retains a header-only (partial) series but reports no feature evidence', () => {
    const inventory = buildCapturePoolInventory({
      entries: [
        {
          runId: 'partial-run',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: `${HEADER}\n`,
          anchorText: EXACT_ANCHOR,
        },
      ],
    });

    expect(inventory.retained).toHaveLength(1);
    expect(inventory.retained[0].sampleCount).toBe(0);
    expect(inventory.retained[0].durationMs).toBe(0);
    expect(inventory.retained[0].meanIntensity).toBe(0);
    expect(inventory.retained[0].features).toEqual([]);
  });

  it('flags an anchor without join timestamps as approximate instead of excluding the run', () => {
    const inventory = buildCapturePoolInventory({
      entries: [
        {
          runId: 'approx-run',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: COVERING_SERIES,
          anchorText: APPROXIMATE_ANCHOR,
        },
      ],
    });

    expect(inventory.retained).toHaveLength(1);
    expect(inventory.retained[0].anchor).toEqual({
      present: true,
      approximate: true,
      offsetMs: null,
    });
  });

  it('aggregates feature coverage across several retained runs', () => {
    const bossSeries = seriesText([sample(0, { bosses: 1, playerBullets: 2 }, 0.9)]);
    const inventory = buildCapturePoolInventory({
      entries: [
        {
          runId: 'waves',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: COVERING_SERIES,
          anchorText: EXACT_ANCHOR,
        },
        {
          runId: 'boss-run',
          webmPresent: true,
          seriesPresent: true,
          anchorPresent: true,
          seriesText: bossSeries,
          anchorText: EXACT_ANCHOR,
        },
      ],
    });

    expect(inventory.features).toEqual([
      { feature: 'weapons', runs: ['waves', 'boss-run'] },
      { feature: 'pickups', runs: ['waves'] },
      { feature: 'enemies', runs: ['waves'] },
      { feature: 'boss', runs: ['boss-run'] },
    ]);
    expect(inventory.missingFeatures).toEqual([]);
  });
});

describe('collectCapturePool', () => {
  it('scans the pool directory and reports legacy WebMs without sidecars', () => {
    const fs = fakeFs({
      'capture-output/run-a.webm': '',
      'capture-output/run-a.action.jsonl': COVERING_SERIES,
      'capture-output/run-a.capture.json': EXACT_ANCHOR,
      'capture-output/legacy.webm': '',
    });

    const inventory = collectCapturePool({ fs });

    expect(inventory.retained.map((run) => run.runId)).toEqual(['run-a']);
    expect(inventory.excluded).toEqual([
      expect.objectContaining({ runId: 'legacy', missing: ['series', 'anchor'] }),
    ]);
  });

  it('limits the scan to explicit run ids', () => {
    const fs = fakeFs({
      'capture-output/run-a.webm': '',
      'capture-output/run-a.action.jsonl': COVERING_SERIES,
      'capture-output/run-a.capture.json': EXACT_ANCHOR,
      'capture-output/run-b.webm': '',
    });

    const inventory = collectCapturePool({ fs, runs: ['run-a'] });

    expect(inventory.retained.map((run) => run.runId)).toEqual(['run-a']);
    expect(inventory.excluded).toEqual([]);
  });

  it('records a fatal error when the pool directory is missing', () => {
    const inventory = collectCapturePool({
      fs: fakeFs({}, []),
    });

    expect(inventory.retained).toEqual([]);
    expect(inventory.errors).toEqual([
      'capture pool directory not found: capture-output',
    ]);
  });
});

describe('parseListPoolArgs', () => {
  it('defaults to a human-readable listing of capture-output/', () => {
    expect(parseListPoolArgs([])).toEqual({
      help: false,
      json: false,
      dir: 'capture-output',
      runs: [],
      error: null,
    });
  });

  it('parses --json, --dir and --runs', () => {
    expect(parseListPoolArgs(['--json', '--dir', 'clips', '--runs', 'a,b'])).toEqual({
      help: false,
      json: true,
      dir: 'clips',
      runs: ['a', 'b'],
      error: null,
    });
  });

  it('supports --help', () => {
    expect(parseListPoolArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown options and missing values', () => {
    expect(parseListPoolArgs(['--nope']).error).toContain('unknown option');
    expect(parseListPoolArgs(['--dir']).error).toContain('--dir requires');
    expect(parseListPoolArgs(['--runs']).error).toContain('--runs requires');
  });
});

describe('listCapturePoolMain', () => {
  it('prints the machine-readable inventory as JSON', () => {
    const fs = fakeFs({
      'capture-output/run-a.webm': '',
      'capture-output/run-a.action.jsonl': COVERING_SERIES,
      'capture-output/run-a.capture.json': EXACT_ANCHOR,
    });

    const result = listCapturePoolMain(['--json'], fs);

    expect(result.code).toBe(0);
    const inventory = JSON.parse(result.stdout);
    expect(inventory.kind).toBe(POOL_INVENTORY_KIND);
    expect(inventory.retained.map((run: { runId: string }) => run.runId)).toEqual(['run-a']);
  });

  it('prints a human-readable listing with retained, feature and excluded sections', () => {
    const fs = fakeFs({
      'capture-output/run-a.webm': '',
      'capture-output/run-a.action.jsonl': COVERING_SERIES,
      'capture-output/run-a.capture.json': EXACT_ANCHOR,
      'capture-output/legacy.webm': '',
    });

    const result = listCapturePoolMain([], fs);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Retained runs');
    expect(result.stdout).toContain('run-a');
    expect(result.stdout).toContain('Feature coverage');
    expect(result.stdout).toContain('weapons: run-a');
    expect(result.stdout).toContain('Missing features: boss');
    expect(result.stdout).toContain('Excluded runs');
    expect(result.stdout).toContain('legacy — missing');
  });

  it('exits non-zero when no run is retained', () => {
    const fs = fakeFs({ 'capture-output/legacy.webm': '' });

    const result = listCapturePoolMain([], fs);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('No retained runs');
  });

  it('returns the usage text for --help without touching the filesystem', () => {
    const fs = fakeFs({});
    const result = listCapturePoolMain(['--help'], fs);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Capture-pool inventory');
    expect(result.stdout).toContain('--dir');
  });
});

describe('formatPoolInventory', () => {
  it('renders an empty inventory without crashing', () => {
    const text = formatPoolInventory(
      buildCapturePoolInventory({ entries: [], errors: ['boom'] }),
    );

    expect(text).toContain('0 retained, 0 excluded');
    expect(text).toContain('No retained runs');
    expect(text).toContain('error: boom');
  });
});

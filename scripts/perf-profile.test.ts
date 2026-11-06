/**
 * Tests for the CPU-profile aggregation used by the performance harness
 * (`scripts/perf-profile.mjs`, AH-0MVXV0E8000937U5, parent AH-0MVWJQUN6009IS87).
 *
 * The raw input is a Chrome DevTools `Profiler.stop` payload, so the fixtures
 * here are hand-built profiles with the same shape (nodes / samples /
 * timeDeltas) — no browser and no CDP session is involved. Every assertion is
 * on observable output: the bucket attribution, the self-time ranking and the
 * human summary that the harness prints.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROFILE_SAMPLING_INTERVAL_US,
  DEFAULT_PROFILE_TOP_FILES,
  DEFAULT_PROFILE_TOP_FUNCTIONS,
  PROFILE_BUCKETS,
  classifyProfileBucket,
  formatProfileSummary,
  normaliseProfileUrl,
  summariseCpuProfile,
} from './perf-profile.mjs';

/** A call-frame node in the CDP profile shape (lineNumber is 0-based). */
function node(
  id: number,
  functionName: string,
  url = '',
  lineNumber = 0,
): { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number } } {
  return { id, callFrame: { functionName, url, lineNumber, columnNumber: 0 } };
}

/**
 * Builds a profile from `[nodeId, durationMicros]` pairs, one sample each, so
 * a test can state the exact self time every node received.
 */
function profileOf(
  nodes: ReturnType<typeof node>[],
  samples: Array<[number, number]>,
): { nodes: ReturnType<typeof node>[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number } {
  return {
    nodes,
    samples: samples.map(([id]) => id),
    timeDeltas: samples.map(([, micros]) => micros),
    startTime: 0,
    endTime: samples.reduce((total, [, micros]) => total + micros, 0),
  };
}

describe('normaliseProfileUrl', () => {
  it('turns a dev-server module URL into a repo-relative path', () => {
    expect(
      normaliseProfileUrl('http://127.0.0.1:5173/src/scenes/PlayScene.ts?t=1699000000000'),
    ).toBe('src/scenes/PlayScene.ts');
    expect(normaliseProfileUrl('/src/core/Game.ts')).toBe('src/core/Game.ts');
  });

  it('keeps dependency URLs so they can be bucketed as renderer/other', () => {
    expect(normaliseProfileUrl('http://127.0.0.1:5173/node_modules/.vite/deps/phaser.js?v=abc')).toBe(
      'node_modules/.vite/deps/phaser.js',
    );
  });

  it('returns null for a native frame with no URL', () => {
    expect(normaliseProfileUrl('')).toBeNull();
    expect(normaliseProfileUrl(undefined as unknown as string)).toBeNull();
  });
});

describe('classifyProfileBucket', () => {
  it('classifies V8 synthetic nodes before looking at the URL', () => {
    expect(classifyProfileBucket({ functionName: '(garbage collector)', url: '' })).toBe('gc');
    expect(classifyProfileBucket({ functionName: '(idle)', url: '' })).toBe('idle');
    expect(classifyProfileBucket({ functionName: '(program)', url: '' })).toBe('native');
    expect(classifyProfileBucket({ functionName: '(anonymous)', url: '' })).toBe('native');
  });

  it('classifies Phaser internals as renderer draw submission', () => {
    expect(
      classifyProfileBucket({
        functionName: 'batchSprite',
        url: 'http://127.0.0.1:5173/node_modules/.vite/deps/phaser.js?v=1',
      }),
    ).toBe('renderer');
  });

  it('classifies the Vite-optimised Phaser bundle served from its private cache', () => {
    // The harness gives each run a private Vite dep cache, so the served
    // bundle is `@fs/tmp/ai-hell-perf-vite-…/deps/phaser.js`, never
    // `node_modules/…` — the bucket must still be renderer.
    expect(
      classifyProfileBucket({
        functionName: 'GraphicsWebGLRenderer',
        url: 'http://127.0.0.1:5175/@fs/tmp/ai-hell-perf-vite-Y0Ib1b/deps/phaser.js?v=abc',
      }),
    ).toBe('renderer');
  });

  it('classifies game code by area: simulation, ui and audio', () => {
    expect(classifyProfileBucket({ functionName: '_handleCollisions', url: '/src/scenes/core/CombatScene.ts' })).toBe(
      'simulation',
    );
    expect(classifyProfileBucket({ functionName: 'refresh', url: '/src/ui/hud.ts' })).toBe('ui');
    expect(classifyProfileBucket({ functionName: 'play', url: '/src/audio/sfx.ts' })).toBe('audio');
  });

  it('falls back to "other" for a third-party frame that is not Phaser', () => {
    expect(
      classifyProfileBucket({ functionName: 'tick', url: 'http://127.0.0.1:5173/node_modules/.vite/deps/tone.js' }),
    ).toBe('other');
  });
});

describe('summariseCpuProfile', () => {
  it('attributes self time to the declared buckets and totals it', () => {
    const profile = profileOf(
      [
        node(1, '(root)'),
        node(2, '_handleCollisions', '/src/scenes/core/CombatScene.ts'),
        node(3, 'batchSprite', '/node_modules/.vite/deps/phaser.js'),
        node(4, '(garbage collector)'),
        node(5, '(idle)'),
      ],
      [
        [2, 400_000],
        [3, 200_000],
        [4, 100_000],
        [5, 300_000],
      ],
    );

    const summary = summariseCpuProfile(profile);

    expect(summary).not.toBeNull();
    expect(summary?.samples).toBe(4);
    expect(summary?.totalMs).toBeCloseTo(1000, 6);
    const byBucket = Object.fromEntries((summary?.buckets ?? []).map((row) => [row.bucket, row]));
    expect(byBucket.simulation.selfMs).toBeCloseTo(400, 6);
    expect(byBucket.simulation.sharePercent).toBeCloseTo(40, 6);
    expect(byBucket.renderer.sharePercent).toBeCloseTo(20, 6);
    expect(byBucket.gc.sharePercent).toBeCloseTo(10, 6);
    expect(byBucket.idle.sharePercent).toBeCloseTo(30, 6);
    expect(summary?.mainThreadIdlePercent).toBeCloseTo(30, 6);
    // JS = simulation 400 + renderer 200 of 1000 ms; gc/idle/native excluded.
    expect(summary?.mainThreadJsPercent).toBeCloseTo(60, 6);
  });

  it('ranks functions by self time, merging the same function across nodes', () => {
    const profile = profileOf(
      [
        node(1, 'tick', '/src/scenes/PlayScene.ts'),
        node(2, 'tick', '/src/scenes/PlayScene.ts'),
        node(3, 'batchSprite', '/node_modules/.vite/deps/phaser.js'),
      ],
      [
        [1, 300_000],
        [2, 100_000],
        [3, 600_000],
      ],
    );

    const summary = summariseCpuProfile(profile);
    const top = summary?.topFunctions ?? [];

    expect(top).toHaveLength(2);
    expect(top[0]).toMatchObject({ functionName: 'batchSprite', file: 'node_modules/.vite/deps/phaser.js' });
    expect(top[0].selfMs).toBeCloseTo(600, 6);
    expect(top[0].sharePercent).toBeCloseTo(60, 6);
    expect(top[1]).toMatchObject({ functionName: 'tick', file: 'src/scenes/PlayScene.ts' });
    expect(top[1].selfMs).toBeCloseTo(400, 6);
  });

  it('exposes project-only hotspots so a report can cite game code, not libraries', () => {
    const profile = profileOf(
      [
        node(1, 'batchSprite', '/node_modules/.vite/deps/phaser.js'),
        node(2, '_collectEnemyFire', '/src/scenes/PlayScene.ts'),
      ],
      [
        [1, 800_000],
        [2, 200_000],
      ],
    );

    const summary = summariseCpuProfile(profile);
    expect(summary?.topProjectFunctions.map((row) => row.functionName)).toEqual(['_collectEnemyFire']);
    // JS = 800 (renderer) + 200 (simulation); the game function is 20 % of it.
    expect(summary?.topProjectFunctions[0].jsSharePercent).toBeCloseTo(20, 6);
    expect(summary?.topProjectFunctions[0].sharePercent).toBeCloseTo(20, 6);
  });

  it('aggregates self time per file for a coarse "where does it go" view', () => {
    const profile = profileOf(
      [
        node(1, 'a', '/src/scenes/PlayScene.ts'),
        node(2, 'b', '/src/scenes/PlayScene.ts'),
        node(3, 'c', '/src/scenes/core/CombatScene.ts'),
      ],
      [
        [1, 100_000],
        [2, 200_000],
        [3, 700_000],
      ],
    );

    const summary = summariseCpuProfile(profile);
    expect(summary?.topFiles[0]).toMatchObject({ file: 'src/scenes/core/CombatScene.ts', sharePercent: 70 });
    expect(summary?.topFiles[1]).toMatchObject({ file: 'src/scenes/PlayScene.ts', selfMs: 300 });
  });

  it('caps the ranked lists at the requested size', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => node(index + 1, `fn${index}`, `/src/a${index}.ts`));
    const samples: Array<[number, number]> = nodes.map((entry) => [entry.id, 1000]);
    const summary = summariseCpuProfile(profileOf(nodes, samples), { topFunctions: 3, topFiles: 2 });

    expect(summary?.topFunctions).toHaveLength(3);
    expect(summary?.topFiles).toHaveLength(2);
  });

  it('records the sampling interval and the measured window it was given', () => {
    const profile = profileOf([node(1, 'tick', '/src/scenes/PlayScene.ts')], [[1, 1000]]);
    const summary = summariseCpuProfile(profile, { samplingIntervalUs: 500, windowSeconds: 60 });

    expect(summary?.samplingIntervalUs).toBe(500);
    expect(summary?.windowSeconds).toBe(60);
  });

  it('returns null for an empty or malformed profile instead of fabricating a result', () => {
    expect(summariseCpuProfile(null as unknown as object)).toBeNull();
    expect(summariseCpuProfile({})).toBeNull();
    expect(summariseCpuProfile({ nodes: [], samples: [], timeDeltas: [] })).toBeNull();
    expect(
      summariseCpuProfile({ nodes: [node(1, 'tick', '/src/a.ts')], samples: [], timeDeltas: [] }),
    ).toBeNull();
  });

  it('ignores samples that reference an unknown node or a negative delta', () => {
    const profile = {
      nodes: [node(1, 'tick', '/src/a.ts')],
      samples: [1, 99, 1],
      timeDeltas: [1000, 5000, -1000],
      startTime: 0,
      endTime: 1000,
    };
    const summary = summariseCpuProfile(profile);

    expect(summary?.samples).toBe(1);
    expect(summary?.totalMs).toBeCloseTo(1, 6);
  });

  it('keeps the bucket list stable (every declared bucket appears)', () => {
    const profile = profileOf([node(1, 'tick', '/src/a.ts')], [[1, 1000]]);
    const summary = summariseCpuProfile(profile);
    expect(summary?.buckets.map((row) => row.bucket)).toEqual([...PROFILE_BUCKETS]);
  });
});

describe('formatProfileSummary', () => {
  it('prints the buckets, the idle share and the top project hotspots', () => {
    const profile = profileOf(
      [
        node(1, '_collectEnemyFire', '/src/scenes/PlayScene.ts'),
        node(2, '(idle)'),
      ],
      [
        [1, 250_000],
        [2, 750_000],
      ],
    );
    const text = formatProfileSummary(summariseCpuProfile(profile, { samplingIntervalUs: 1000 }));

    expect(text).toContain('CPU profile');
    expect(text).toContain('simulation 25.0%');
    expect(text).toContain('idle 75.0%');
    expect(text).toContain('main thread JS: 25.0%');
    expect(text).toContain('_collectEnemyFire');
    expect(text).toContain('src/scenes/PlayScene.ts');
  });

  it('says so when there is no profile instead of printing an empty table', () => {
    expect(formatProfileSummary(null)).toContain('no CPU profile');
  });
});

describe('documented defaults', () => {
  it('uses a 1 ms sampling interval and bounded ranked lists', () => {
    expect(DEFAULT_PROFILE_SAMPLING_INTERVAL_US).toBe(1000);
    expect(DEFAULT_PROFILE_TOP_FUNCTIONS).toBeGreaterThan(0);
    expect(DEFAULT_PROFILE_TOP_FILES).toBeGreaterThan(0);
    expect(PROFILE_BUCKETS).toContain('simulation');
    expect(PROFILE_BUCKETS).toContain('renderer');
  });
});

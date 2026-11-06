/**
 * Tests for the dev-gated in-page frame-time probe
 * (`src/core/perfProbe.ts`, AH-0MVXV0DER009ER70).
 *
 * A fake, duck-typed game stands in for Phaser — the probe deliberately reads
 * only `events.on/off`, `loop.actualFps` and `scene.getScenes(true)` — so the
 * sampling contract (frame deltas, cadence, entity counts, method label, dev
 * gate) is asserted without booting a browser or a scene.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_COUNT_SAMPLE_INTERVAL_MS,
  PERF_PROBE_FRAME_EVENT,
  PERF_PROBE_GLOBAL_KEY,
  PERF_PROBE_METHOD,
  createPerfProbe,
  registerPerfProbe,
  type PerfGameLike,
  type PerformanceCounts,
  type PerfSceneLike,
} from './perfProbe';

type FrameListener = (time: number, delta: number) => void;

/** A minimal Phaser-game stand-in with a real listener registry. */
class FakeGame implements PerfGameLike {
  readonly listeners = new Map<string, Set<FrameListener>>();
  loop: { actualFps?: number } = { actualFps: 59.4 };
  readonly renderScenes: PerfSceneLike[] = [];

  readonly events = {
    on: (event: string, listener: FrameListener): void => {
      const set = this.listeners.get(event) ?? new Set<FrameListener>();
      set.add(listener);
      this.listeners.set(event, set);
    },
    off: (event: string, listener: FrameListener): void => {
      this.listeners.get(event)?.delete(listener);
    },
  };

  readonly scene = {
    getScenes: (active = true): PerfSceneLike[] => (active ? this.renderScenes : []),
  };

  /** Dispatches one frame event, exactly as Phaser's `poststep` does. */
  emitFrame(time: number): void {
    for (const listener of this.listeners.get(PERF_PROBE_FRAME_EVENT) ?? []) {
      listener(time, 16);
    }
  }

  listenerCount(): number {
    return this.listeners.get(PERF_PROBE_FRAME_EVENT)?.size ?? 0;
  }
}

/** A scene exposing the shared performance-count seam. */
function fakeScene(
  key: string,
  counts: () => PerformanceCounts,
): PerfSceneLike & { getPerformanceCounts: () => PerformanceCounts } {
  return { sys: { settings: { key } }, getPerformanceCounts: counts };
}

const zeroCounts = (): PerformanceCounts => ({
  enemies: 0,
  enemyBullets: 0,
  playerBullets: 0,
  minerals: null,
});

beforeEach(() => {
  delete window.__aiHellPerfProbe;
});

afterEach(() => {
  delete window.__aiHellPerfProbe;
  vi.unstubAllEnvs();
});

describe('createPerfProbe — frame sampling', () => {
  it('records the interval between consecutive Phaser frame timestamps', () => {
    const game = new FakeGame();
    game.renderScenes.push(fakeScene('PlayScene', zeroCounts));
    const probe = createPerfProbe(game);

    expect(probe.start()).toBe(true);
    game.emitFrame(1000);
    game.emitFrame(1016.5);
    game.emitFrame(1033);
    const result = probe.stop();

    expect(result?.frameTimesMs).toEqual([16.5, 16.5]);
    expect(result?.frames).toBe(2);
    expect(result?.durationMs).toBe(33);
    expect(result?.method).toBe(PERF_PROBE_METHOD);
  });

  it('labels the result with Phaser own smoothed FPS', () => {
    const game = new FakeGame();
    const probe = createPerfProbe(game);

    probe.start();
    game.emitFrame(10);
    game.emitFrame(26);

    expect(probe.stop()?.actualFps).toBe(59.4);
  });

  it('drops zero/negative intervals so fake 0 ms frames never reach the percentiles', () => {
    const game = new FakeGame();
    const probe = createPerfProbe(game);

    probe.start();
    game.emitFrame(100);
    game.emitFrame(100);
    game.emitFrame(90);
    game.emitFrame(116);
    const result = probe.stop();

    expect(result?.frameTimesMs).toEqual([26]);
  });

  it('falls back to the injected clock when a frame carries no usable timestamp', () => {
    const game = new FakeGame();
    let clock = 500;
    const probe = createPerfProbe(game, { now: () => (clock += 20) });

    probe.start();
    game.emitFrame(Number.NaN);
    game.emitFrame(Number.NaN);

    expect(probe.stop()?.frameTimesMs).toEqual([20]);
  });

  it('refuses to start twice without discarding the running samples', () => {
    const game = new FakeGame();
    const probe = createPerfProbe(game);

    expect(probe.start()).toBe(true);
    game.emitFrame(10);
    game.emitFrame(30);
    expect(probe.start()).toBe(false);
    expect(probe.stop()?.frames).toBe(1);
  });

  it('returns null when stopped while idle', () => {
    const probe = createPerfProbe(new FakeGame());

    expect(probe.stop()).toBeNull();
    expect(probe.isRunning()).toBe(false);
  });

  it('unsubscribes on stop and can start a fresh run on the same handle', () => {
    const game = new FakeGame();
    const probe = createPerfProbe(game);

    probe.start();
    expect(game.listenerCount()).toBe(1);
    game.emitFrame(10);
    game.emitFrame(26);
    expect(probe.stop()?.frames).toBe(1);
    expect(game.listenerCount()).toBe(0);

    game.emitFrame(40); // ignored: not running
    probe.start();
    game.emitFrame(100);
    game.emitFrame(140);

    expect(probe.stop()?.frameTimesMs).toEqual([40]);
  });

  it('reports liveness through snapshot()', () => {
    const game = new FakeGame();
    const probe = createPerfProbe(game, { now: () => 999 });

    expect(probe.snapshot()).toEqual({ running: false, frames: 0, countSamples: 0, elapsedMs: 0 });

    probe.start();
    game.emitFrame(1000);
    game.emitFrame(1100);

    expect(probe.snapshot()).toMatchObject({ running: true, frames: 1, countSamples: 0 });
    expect(probe.snapshot().elapsedMs).toBe(100);
  });
});

describe('createPerfProbe — entity counts', () => {
  it('samples counts at the configured cadence, not every frame', () => {
    const game = new FakeGame();
    game.renderScenes.push(
      fakeScene('PlayScene', () => ({ enemies: 7, enemyBullets: 3, playerBullets: 2, minerals: 4 })),
    );
    const probe = createPerfProbe(game, { sampleIntervalMs: 250 });

    probe.start();
    game.emitFrame(1000); // first sample
    game.emitFrame(1016); // too soon
    game.emitFrame(1032); // too soon
    game.emitFrame(1250); // second sample (250 ms after the first)
    const result = probe.stop();

    expect(result?.countSamples).toHaveLength(2);
    expect(result?.countSamples[0]).toEqual({
      atMs: 0,
      counts: { enemies: 7, enemyBullets: 3, playerBullets: 2, minerals: 4 },
    });
    expect(result?.countSamples[1].atMs).toBe(250);
    expect(result?.countsSource).toBe('PlayScene');
    expect(DEFAULT_COUNT_SAMPLE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('reads the counts from the first active scene that exposes the seam', () => {
    const game = new FakeGame();
    game.renderScenes.push({ sys: { settings: { key: 'MenuScene' } } });
    game.renderScenes.push(fakeScene('GymPerformance', () => ({
      enemies: 100,
      enemyBullets: 30,
      playerBullets: 5,
      minerals: null,
    })));

    const probe = createPerfProbe(game);
    probe.start();
    game.emitFrame(1000);

    const result = probe.stop();
    expect(result?.countsSource).toBe('GymPerformance');
    expect(result?.countSamples[0].counts.enemies).toBe(100);
    expect(result?.countSamples[0].counts.minerals).toBeNull();
  });

  it('reports no counts (rather than crashing) when no active scene exposes the seam', () => {
    const game = new FakeGame();
    game.renderScenes.push({ sys: { settings: { key: 'MenuScene' } } });
    const probe = createPerfProbe(game);

    probe.start();
    game.emitFrame(1000);
    game.emitFrame(1200);
    const result = probe.stop();

    expect(result?.countSamples).toEqual([]);
    expect(result?.countsSource).toBeNull();
    expect(result?.frames).toBe(1);
  });

  it('coerces a malformed count report into non-negative integers', () => {
    const game = new FakeGame();
    game.renderScenes.push(
      fakeScene('PlayScene', () => ({
        enemies: 3.6,
        enemyBullets: -2,
        playerBullets: Number.NaN,
        minerals: undefined as unknown as number,
      })),
    );
    const probe = createPerfProbe(game);

    probe.start();
    game.emitFrame(1000);

    expect(probe.stop()?.countSamples[0].counts).toEqual({
      enemies: 4,
      enemyBullets: 0,
      playerBullets: 0,
      minerals: null,
    });
  });
});

describe('registerPerfProbe — dev gate (boot registration)', () => {
  it('installs the handle on `window` in a dev build', () => {
    const game = new FakeGame();

    const handle = registerPerfProbe(game);

    expect(handle).not.toBeNull();
    expect(window[PERF_PROBE_GLOBAL_KEY]).toBe(handle);
    expect(handle?.isRunning()).toBe(false);
  });

  it('never writes the global in a production build', () => {
    vi.stubEnv('DEV', false);

    const handle = registerPerfProbe(new FakeGame());

    expect(handle).toBeNull();
    expect(window[PERF_PROBE_GLOBAL_KEY]).toBeUndefined();
  });
});

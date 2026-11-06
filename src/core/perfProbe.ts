/**
 * Dev-gated in-page frame-time probe (AH-0MVXV0DER009ER70, parent
 * AH-0MVWJQUN6009IS87).
 *
 * The performance harness (`scripts/measure-performance.mjs`) needs frame
 * times from inside the running page, but the game instance is deliberately
 * not a page global. This probe mirrors the established dev-gated handle
 * pattern (`src/core/captureDirector.ts`, `src/core/devScenario.ts`): it is
 * registered on `window` at boot **only** in a dev build (Vite folds
 * `import.meta.env.DEV` to `false`, `isPerfProbeEnabled()` becomes a constant
 * `false` and the registration body is dead-code-eliminated), and it is the
 * harness's only entry point into the loop.
 *
 * ## What it measures
 *
 * Frame times are the differences between consecutive Phaser
 * `Phaser.Core.Events.POST_STEP` (`'poststep'`) timestamps — Phaser's own
 * loop, once per rendered frame, after the scene manager has updated. This is
 * deliberately **not** a bare `requestAnimationFrame` counter: the reported
 * frame time is the game loop's real interval (simulation + render + browser
 * scheduling), and the method string is recorded in every report so numbers
 * from a different sampling strategy are never compared by accident.
 *
 * Entity counts are sampled every {@link DEFAULT_COUNT_SAMPLE_INTERVAL_MS} ms
 * (not every frame) from the active scene's
 * {@link PerfSceneLike.getPerformanceCounts} — a public scene seam implemented
 * by the shared `CombatScene` core, so the game and every gym report the same
 * counts. Sampling at a low cadence keeps the probe itself off the measured
 * frame's hot path (the enemy-count getter allocates).
 */

/** Window-global key the probe installs itself under (dev builds only). */
export const PERF_PROBE_GLOBAL_KEY = '__aiHellPerfProbe';

/** Phaser game event sampled once per frame (`Phaser.Core.Events.POST_STEP`). */
export const PERF_PROBE_FRAME_EVENT = 'poststep';

/** How the frame times are measured; recorded in every report header. */
export const PERF_PROBE_METHOD = 'phaser-game-loop/poststep-frame-delta';

/** Default interval between entity-count samples, in milliseconds. */
export const DEFAULT_COUNT_SAMPLE_INTERVAL_MS = 250;

/**
 * Live entity counts reported by a scene. `minerals` is `null` for a scene
 * that has no minerals (`CombatScene`'s default); `PlayScene` fills it in.
 */
export interface PerformanceCounts {
  enemies: number;
  enemyBullets: number;
  playerBullets: number;
  minerals: number | null;
}

/** One entity-count sample, `atMs` relative to the first sampled frame. */
export interface PerfCountSample {
  atMs: number;
  counts: PerformanceCounts;
}

/** The raw probe result handed to the harness (`stop()`). */
export interface PerfProbeResult {
  /** The measurement method (`PERF_PROBE_METHOD`). */
  method: string;
  /** Every usable inter-frame interval, in milliseconds, in frame order. */
  frameTimesMs: number[];
  /** Entity-count samples taken during the run (may be empty). */
  countSamples: PerfCountSample[];
  /** Scene key that provided the entity counts, or `null` when unavailable. */
  countsSource: string | null;
  /** Number of inter-frame intervals (= frames after the first). */
  frames: number;
  /** Wall-clock span of the sampled frames, in milliseconds. */
  durationMs: number;
  /** Phaser's own smoothed FPS reading at stop time, when available. */
  actualFps: number | null;
}

/** A cheap liveness snapshot (used by the harness while waiting). */
export interface PerfProbeSnapshot {
  running: boolean;
  frames: number;
  countSamples: number;
  elapsedMs: number;
}

/** The page-side handle exposed on `window.__aiHellPerfProbe`. */
export interface PerfProbeHandle {
  /**
   * Starts sampling. Returns `false` when a run is already in progress (a
   * second `start()` never silently discards the first run's samples).
   */
  start(): boolean;
  /** Stops sampling and returns the run's samples, or `null` when idle. */
  stop(): PerfProbeResult | null;
  /** Liveness snapshot; safe to call at any time. */
  snapshot(): PerfProbeSnapshot;
  /** Whether a measurement is currently running. */
  isRunning(): boolean;
}

/** The scene surface the probe reads (duck-typed: no Phaser import needed). */
export interface PerfSceneLike {
  sys?: { settings?: { key?: string } };
  getPerformanceCounts?: () => PerformanceCounts;
}

/** The game surface the probe hooks (duck-typed: no Phaser import needed). */
export interface PerfGameLike {
  events: {
    on(event: string, listener: (time: number, delta: number) => void): unknown;
    off?(event: string, listener: (time: number, delta: number) => void): unknown;
  };
  loop?: { actualFps?: number };
  scene?: { getScenes?: (active?: boolean) => PerfSceneLike[] };
}

/** Options for {@link createPerfProbe}. */
export interface PerfProbeOptions {
  /** Interval between entity-count samples, in milliseconds. */
  sampleIntervalMs?: number;
  /** Clock used when a frame event carries no usable timestamp. */
  now?: () => number;
}

declare global {
  interface Window {
    /**
     * Dev-gated frame-time probe (AH-0MVXV0DER009ER70). Set by
     * {@link registerPerfProbe} at boot in dev builds only; absent in
     * production and outside a browser.
     */
    __aiHellPerfProbe?: PerfProbeHandle;
  }
}

/** True when the perf probe should be available (dev builds only). */
export function isPerfProbeEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/** Default clock: the high-resolution browser timer. */
function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Coerces a scene's counts into non-negative integers (`null` when absent). */
function normaliseCounts(counts: PerformanceCounts | undefined): PerformanceCounts {
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const optional = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  return {
    enemies: count(counts?.enemies),
    enemyBullets: count(counts?.enemyBullets),
    playerBullets: count(counts?.playerBullets),
    minerals: optional(counts?.minerals),
  };
}

/** The scene key of a Phaser scene (`scene.sys.settings.key`), if any. */
function sceneKeyOf(scene: PerfSceneLike): string | null {
  const key = scene.sys?.settings?.key;
  return typeof key === 'string' ? key : null;
}

/**
 * Creates a probe for `game` without installing it on `window`.
 *
 * Exported so unit tests can drive it with a fake game (no browser, no
 * Phaser) and so a future caller can sample a game it did not boot.
 *
 * @param {PerfGameLike} game
 * @param {PerfProbeOptions} [options]
 */
export function createPerfProbe(
  game: PerfGameLike,
  { sampleIntervalMs = DEFAULT_COUNT_SAMPLE_INTERVAL_MS, now = defaultNow }: PerfProbeOptions = {},
): PerfProbeHandle {
  let running = false;
  let frameTimesMs: number[] = [];
  let countSamples: PerfCountSample[] = [];
  let countsSource: string | null = null;
  let firstFrameAt: number | null = null;
  let lastFrameAt: number | null = null;
  let lastCountAt: number | null = null;

  const resolveCountsSource = (): { scene: PerfSceneLike; key: string | null } | null => {
    const scenes = game.scene?.getScenes?.(true) ?? [];
    for (const scene of scenes) {
      if (typeof scene?.getPerformanceCounts === 'function') {
        return { scene, key: sceneKeyOf(scene) };
      }
    }
    return null;
  };

  const onFrame = (time: number): void => {
    const at = typeof time === 'number' && Number.isFinite(time) ? time : now();
    if (firstFrameAt === null) firstFrameAt = at;
    if (lastFrameAt !== null) {
      const delta = at - lastFrameAt;
      // A zero/negative interval cannot describe a rendered frame (two events
      // sharing a timestamp, or a non-monotonic clock), so it is dropped
      // rather than polluting the percentiles with fake 0 ms frames.
      if (delta > 0) frameTimesMs.push(delta);
    }
    lastFrameAt = at;

    if (lastCountAt === null || at - lastCountAt >= sampleIntervalMs) {
      lastCountAt = at;
      const source = resolveCountsSource();
      if (source) {
        const sampledAt = Math.max(0, at - (firstFrameAt ?? at));
        countSamples.push({
          atMs: sampledAt,
          counts: normaliseCounts(source.scene.getPerformanceCounts?.()),
        });
        if (source.key !== null) countsSource = source.key;
      }
    }
  };

  const clear = (): void => {
    frameTimesMs = [];
    countSamples = [];
    countsSource = null;
    firstFrameAt = null;
    lastFrameAt = null;
    lastCountAt = null;
  };

  return {
    start(): boolean {
      if (running) return false;
      clear();
      running = true;
      game.events.on(PERF_PROBE_FRAME_EVENT, onFrame);
      return true;
    },

    stop(): PerfProbeResult | null {
      if (!running) return null;
      running = false;
      if (typeof game.events.off === 'function') {
        game.events.off(PERF_PROBE_FRAME_EVENT, onFrame);
      }
      const durationMs =
        firstFrameAt !== null && lastFrameAt !== null ? Math.max(0, lastFrameAt - firstFrameAt) : 0;
      const result: PerfProbeResult = {
        method: PERF_PROBE_METHOD,
        frameTimesMs,
        countSamples,
        countsSource,
        frames: frameTimesMs.length,
        durationMs,
        actualFps:
          typeof game.loop?.actualFps === 'number' && Number.isFinite(game.loop.actualFps)
            ? game.loop.actualFps
            : null,
      };
      clear();
      return result;
    },

    snapshot(): PerfProbeSnapshot {
      const elapsedMs =
        firstFrameAt !== null ? Math.max(0, (lastFrameAt ?? now()) - firstFrameAt) : 0;
      return {
        running,
        frames: frameTimesMs.length,
        countSamples: countSamples.length,
        elapsedMs,
      };
    },

    isRunning(): boolean {
      return running;
    },
  };
}

/**
 * Registers the frame-time probe on `window` (dev builds only).
 *
 * No-op in production (`isPerfProbeEnabled()` folds to `false`) and outside a
 * browser, matching the other dev-gated page handles. Returns the installed
 * handle, or `null` when it was not installed.
 *
 * @param {PerfGameLike} game — the running game (e.g. from `bootGame()`).
 * @param {PerfProbeOptions} [options]
 */
export function registerPerfProbe(
  game: PerfGameLike,
  options: PerfProbeOptions = {},
): PerfProbeHandle | null {
  if (!isPerfProbeEnabled() || typeof window === 'undefined') return null;
  const handle = createPerfProbe(game, options);
  window.__aiHellPerfProbe = handle;
  return handle;
}

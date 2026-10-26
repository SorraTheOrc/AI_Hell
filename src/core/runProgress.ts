/**
 * Dev-gated run-progress page handle (AH-0MVE01EY0008QEVX AC3).
 *
 * A generated-level capture scene must observe the **live** run's level/wave
 * position and whether the run has ended, so the capture driver can apply a
 * multi-wave-aware window (AC4) without reaching into Phaser internals. This
 * mirrors the established dev-gated page-signal pattern
 * (`src/core/runEndedSignal.ts`, `src/core/devScenario.ts`): a `window` global
 * written only in dev builds, so Vite folds the gate to `false` in a
 * production build and the whole publish body is dead-code-eliminated
 * (`npm run check-bundle` unaffected).
 *
 * The handle is intentionally read-only from the page's perspective: the
 * capture tool polls `window.__aiHellRunProgress`; nothing else writes it.
 */

/** The live run position the capture driver polls. */
export interface RunProgressState {
  /** Current campaign level (1-based). */
  level: number;
  /** Current wave within the level (1-based; 0 before the first wave). */
  wave: number;
  /** Number of waves in the current level. */
  waveCount: number;
  /** True once the run has ended (victory or defeat). */
  ended: boolean;
}

declare global {
  interface Window {
    /**
     * Dev-gated live run progress. Set by {@link publishRunProgress} from a
     * dev build only; absent in production and outside a browser.
     */
    __aiHellRunProgress?: RunProgressState;
  }
}

/** True when the dev-gated capture seams (progress + startLevel) are enabled. */
export function isRunProgressEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/** Clamps a count to a non-negative integer, falling back to `fallback`. */
function count(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

/**
 * Builds a normalised progress snapshot (pure). Exported so the shape is
 * unit-testable without a browser and the driver's expectations are pinned.
 *
 * @param level — current campaign level.
 * @param wave — current wave number (0 before the first wave).
 * @param waveCount — waves in the current level.
 * @param ended — whether the run has ended.
 */
export function buildRunProgressState(
  level: unknown,
  wave: unknown,
  waveCount: unknown,
  ended: unknown = false,
): RunProgressState {
  return {
    level: count(level, 1),
    wave: count(wave, 0),
    waveCount: count(waveCount, 0),
    ended: ended === true,
  };
}

/**
 * Publishes the live run position to `window.__aiHellRunProgress` (dev builds
 * only). No-op in production and outside a browser.
 *
 * @param level — current campaign level.
 * @param wave — current wave number (0 before the first wave).
 * @param waveCount — waves in the current level.
 * @param ended — whether the run has ended (default false).
 */
export function publishRunProgress(
  level: number,
  wave: number,
  waveCount: number,
  ended = false,
): void {
  if (!isRunProgressEnabled() || typeof window === 'undefined') return;
  window.__aiHellRunProgress = buildRunProgressState(level, wave, waveCount, ended);
}

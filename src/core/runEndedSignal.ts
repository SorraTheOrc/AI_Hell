/**
 * Dev-gated end-of-run page-side signal (AH-0MUXZ4BXK001QCEK).
 *
 * The full-run capture tool (`npm run capture`, parent AH-0MUX2K8U7000GFNU)
 * detects when a bot-driven run ends — victory or defeat — instead of assuming
 * a duration. To that end `PlayScene._finishRun` emits two additive, read-only
 * signals the moment a run ends:
 *
 * - a `CustomEvent` on `window` named `aihell:run-ended` whose `detail` is
 *   `{ won, score }`; and
 * - `window.__aiHellRunState = { ended: true, won, score }` as a race
 *   fallback (a short run can end before the capture attaches its listener, so
 *   the tool also reads the flag).
 *
 * Both are gated behind `import.meta.env.DEV`: Vite statically replaces the
 * flag in a production build, `isRunEndedSignalEnabled()` becomes a constant
 * `false`, and the emitter's body is dead-code-eliminated — so the shipped
 * bundle stays inert (`npm run check-bundle` unaffected).
 *
 * The payload shape is owned by the pure `buildRunEndedDetail` helper in
 * `scripts/capture-run-lifecycle.mjs` (foundation child AH-0MUXZ49PY0065K2O),
 * which the capture decodes with `decodeRunEndedDetail`; this module never
 * re-implements it.
 */

import { buildRunEndedDetail } from '../../scripts/capture-run-lifecycle.mjs';

/**
 * The page-side event name dispatched on `window` when a run ends. Consumed by
 * the capture tool (`scripts/capture-gameplay.mjs`); documented for the
 * dev-gated signal (AC5).
 */
export const RUN_ENDED_EVENT = 'aihell:run-ended';

/** The read-only page-side state mirrored onto `window.__aiHellRunState`. */
export interface RunEndedState {
  /** Always `true`; the flag only exists once a run has ended. */
  ended: true;
  won: boolean;
  score: number;
}

declare global {
  interface Window {
    /**
     * Dev-gated race fallback for the capture tool: set by
     * {@link emitRunEndedSignal} when a run ends. Read-only from the page's
     * perspective — capture never writes it.
     */
    __aiHellRunState?: RunEndedState;
  }
}

/** True when the dev-gated page-side signal should be emitted. */
export function isRunEndedSignalEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * Emits the dev-gated end-of-run signal for `won`/`score`.
 *
 * No-op outside a dev build. Sets the `window.__aiHellRunState` fallback first,
 * then dispatches the `aihell:run-ended` event, so a capture that listens for
 * the event and one that polls the flag observe the same `{ won, score }`
 * payload. The payload is built by the shared pure helper — this function adds
 * no shape of its own.
 */
export function emitRunEndedSignal(won: boolean, score: number): void {
  if (!isRunEndedSignalEnabled()) return;

  const detail = buildRunEndedDetail(won, score);
  window.__aiHellRunState = {
    ended: true,
    won: detail.won,
    score: detail.score,
  };
  window.dispatchEvent(new CustomEvent(RUN_ENDED_EVENT, { detail }));
}

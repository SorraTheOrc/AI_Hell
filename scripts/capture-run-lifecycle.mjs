/**
 * Pure run-lifecycle contracts for full-run gameplay capture
 * (AH-0MUXZ49PY0065K2O, foundation for AH-0MUX2K8U7000GFNU).
 *
 * The capture tool records a **complete run** — from the start of play to a
 * configurable tail after the victory/defeat moment — rather than a fixed
 * clip. That needs three decisions that must be hermetic and unit-testable:
 *
 * 1. **The end-of-run signal payload.** `PlayScene` encodes `{ won, score }`
 *    into the `aihell:run-ended` `CustomEvent` detail and/or the
 *    `window.__aiHellRunState` flag; the capture decodes it back.
 * 2. **The tail and safety cap.** Recording stops one `tailMs` after the
 *    signal, clamped to a `maxDurationMs` cap so a run that never signals
 *    cannot record forever. Hitting the cap **without** a signal is reported
 *    explicitly (a capped clip is not a complete run).
 * 3. **The demo game-over dwell.** In demo/attract mode the game holds on the
 *    game-over screen long enough for the captured tail to show the outcome
 *    before returning to the menu.
 *
 * Every function here is **side-effect free and clock-free**: it takes its
 * inputs (including `now`/elapsed time) as arguments and returns a value, so
 * the browser/encode path stays a thin shell and all decisions can run under
 * vitest with no browser (see `scripts/capture-gameplay.test.ts`).
 *
 * This module is plain ESM JavaScript so the Node tooling and the Vite game
 * build can both import it without a TypeScript loader;
 * `capture-run-lifecycle.d.mts` supplies the types.
 */

/**
 * Post-signal tail, in milliseconds: recording continues this long after the
 * run-end signal so the victory/defeat screen is captured (AC: default
 * `5000`). Single source of truth — imported by the capture loop and the demo
 * dwell helper rather than re-declared.
 */
export const DEFAULT_CAPTURE_TAIL_MS = 5_000;

/**
 * Generous default safety cap for a full-run recording, in milliseconds
 * (30 minutes). A complete run — across however many levels it spans — is far
 * shorter than this; the cap only exists so a stuck or never-signalling run
 * cannot record forever. Hitting it without a signal is reported and treated
 * as an incomplete run.
 */
export const DEFAULT_MAX_CAPTURE_DURATION_MS = 30 * 60 * 1_000;

/**
 * Default demo game-over dwell, in milliseconds. Must be at least the capture
 * tail so the recorded tail shows the outcome; the demo returns to the menu
 * after this dwell. Kept single-source with `DEFAULT_CAPTURE_TAIL_MS`.
 */
export const DEMO_GAME_OVER_DWELL_MS = DEFAULT_CAPTURE_TAIL_MS;

/** Coerces `value` to a finite number, or returns `fallback`. */
const toFiniteOr = (value, fallback) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

/**
 * Whether a signal-time input represents an actual signal. `null`/`undefined`
 * mean "not yet signalled" and must not be coerced to the finite `Number(null)
 * === 0` (which would look like a signal at elapsed zero).
 */
const isSignalTime = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value));

/**
 * Encodes the end-of-run payload the game emits (`{ won, score }`).
 *
 * The win flag is normalised to a strict boolean and the score to a
 * non-negative integer, so the signal always carries a well-formed shape
 * however it is called. Used by the dev-gated emitter in `PlayScene` and
 * round-trips through {@link decodeRunEndedDetail}.
 *
 * @param {unknown} won — whether the run ended in victory.
 * @param {unknown} score — the final score.
 * @returns {{ won: boolean, score: number }}
 */
export function buildRunEndedDetail(won, score) {
  const numericScore = Number(score);
  return {
    won: won === true,
    score: Number.isFinite(numericScore)
      ? Math.max(0, Math.trunc(numericScore))
      : 0,
  };
}

/**
 * Decodes a page-side run-end payload back into `{ won, score }`, or returns
 * `null` when it is missing or malformed.
 *
 * Accepts both shapes the game emits: the `CustomEvent` detail `{ won, score }`
 * and the `window.__aiHellRunState` flag `{ ended: true, won, score }`. An
 * explicit `ended: false` flag is rejected, as are a missing/non-boolean `won`
 * and a missing/non-finite `score` — capture must never mistake a partial
 * payload for a finished run.
 *
 * @param {unknown} detail
 * @returns {{ won: boolean, score: number } | null}
 */
export function decodeRunEndedDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  if (detail.ended === false) return null;
  if (typeof detail.won !== 'boolean') return null;

  const numericScore = Number(detail.score);
  if (!Number.isFinite(numericScore)) return null;

  return {
    won: detail.won,
    score: Math.max(0, Math.trunc(numericScore)),
  };
}

/**
 * Computes when recording should stop after a run-end signal:
 * `signalTimeMs + tailMs`, clamped to `maxDurationMs`.
 *
 * Returns `Number.POSITIVE_INFINITY` when any input is non-finite (there is no
 * meaningful stop time), which the caller treats as "keep waiting"; a negative
 * tail is treated as no tail. This is pure arithmetic only — it assumes a
 * signal has arrived. Use {@link evaluateRunStop} for the full loop decision.
 *
 * @param {number} signalTimeMs — elapsed time when the signal arrived.
 * @param {number} tailMs — post-signal tail duration.
 * @param {number} maxDurationMs — safety cap.
 * @returns {number}
 */
export function computeStopTimeMs(signalTimeMs, tailMs, maxDurationMs) {
  const signal = Number(signalTimeMs);
  const tail = Number(tailMs);
  const cap = Number(maxDurationMs);

  if (
    !Number.isFinite(signal) ||
    !Number.isFinite(tail) ||
    !Number.isFinite(cap)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.min(signal + Math.max(0, tail), Math.max(0, cap));
}

/**
 * Reports whether the safety cap was reached **without** a run-end signal.
 *
 * A signal at any point means the run ended properly, so the cap is not
 * considered hit even if the tail was clamped to it; the capture reports a cap
 * hit only for a run that never signalled, so a capped clip is never presented
 * as a complete run.
 *
 * @param {number|null|undefined} signalTimeMs — signal time, or `null`/`undefined` for none.
 * @param {number} elapsedMs — elapsed recording time.
 * @param {number} maxDurationMs — safety cap.
 * @returns {boolean}
 */
export function capWasReachedWithoutSignal(
  signalTimeMs,
  elapsedMs,
  maxDurationMs,
) {
  if (isSignalTime(signalTimeMs)) return false;

  const elapsed = Number(elapsedMs);
  const cap = Number(maxDurationMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(cap)) return false;

  return elapsed >= Math.max(0, cap);
}

/**
 * Decides whether the capture loop should stop, and why.
 *
 * This is the whole wait-loop decision in one pure call: feed it the current
 * `elapsedMs` and the run state and it returns whether to stop, the reason
 * (`'signal'` after the tail, `'cap'` when the safety cap was reached without
 * a signal, or `null` to keep recording), the computed `stopTimeMs` and
 * whether the cap was hit. All inputs are optional and fall back to the
 * documented defaults, so a missing/invalid state simply keeps waiting.
 *
 * @param {{ elapsedMs?: number, signalTimeMs?: number|null, tailMs?: number, maxDurationMs?: number }} [state]
 * @returns {{ done: boolean, reason: 'signal'|'cap'|null, stopTimeMs: number, capHit: boolean }}
 */
export function evaluateRunStop(state = {}) {
  const elapsedMs = toFiniteOr(state?.elapsedMs, 0);
  const tailMs = toFiniteOr(state?.tailMs, DEFAULT_CAPTURE_TAIL_MS);
  const maxDurationMs = toFiniteOr(
    state?.maxDurationMs,
    DEFAULT_MAX_CAPTURE_DURATION_MS,
  );
  const signalTimeMs = state?.signalTimeMs;
  const hasSignal = isSignalTime(signalTimeMs);

  const stopTimeMs = hasSignal
    ? computeStopTimeMs(Number(signalTimeMs), tailMs, maxDurationMs)
    : Math.max(0, maxDurationMs);

  const capHit = capWasReachedWithoutSignal(
    hasSignal ? Number(signalTimeMs) : null,
    elapsedMs,
    maxDurationMs,
  );
  const signalDone = hasSignal && elapsedMs >= stopTimeMs;
  const done = signalDone || capHit;

  let reason = null;
  if (done) reason = signalDone ? 'signal' : 'cap';

  return { done, reason, stopTimeMs, capHit };
}

/**
 * Drives the full-run wait loop to a decision, given injected clock, signal
 * reader and sleep so the loop is hermetic and testable without a browser.
 *
 * Each poll reads the latest run-end payload (through
 * {@link decodeRunEndedDetail}) and hands the elapsed time and the first
 * observed signal to {@link evaluateRunStop}; the loop returns when that
 * decision says to stop — one `tailMs` after the signal, or at
 * `maxDurationMs` when no signal arrived. The first signal observation wins,
 * so a duplicate later signal cannot extend the tail. `onProgress` is called
 * before each sleep with the elapsed time against the effective cap, so a
 * caller can render an elapsed-vs-cap heartbeat across an unbounded wait.
 *
 * @param {{
 *   now?: () => number,
 *   readSignal?: () => unknown,
 *   sleep?: (ms: number) => unknown,
 *   pollMs?: number,
 *   tailMs?: number,
 *   maxDurationMs?: number,
 *   onProgress?: (state: { elapsedMs: number, maxDurationMs: number, signalTimeMs: number|null }) => void,
 * }} [options]
 * @returns {Promise<{
 *   done: boolean,
 *   reason: 'signal'|'cap'|null,
 *   stopTimeMs: number,
 *   capHit: boolean,
 *   signal: { won: boolean, score: number }|null,
 *   signalTimeMs: number|null,
 *   elapsedMs: number,
 *   runLengthMs: number,
 * }>}
 */
export async function waitForRunEnd(options = {}) {
  const clock =
    typeof options.now === 'function' ? options.now : () => Date.now();
  const readSignal =
    typeof options.readSignal === 'function'
      ? options.readSignal
      : () => null;
  const pause =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollRaw = Number(options.pollMs);
  const pollMs = Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 1;
  const effectiveCap = toFiniteOr(
    options.maxDurationMs,
    DEFAULT_MAX_CAPTURE_DURATION_MS,
  );

  const startMs = clock();
  let signal = null;
  let signalTimeMs = null;
  let elapsedMs = 0;
  let decision = evaluateRunStop({
    elapsedMs: 0,
    signalTimeMs: null,
    tailMs: options.tailMs,
    maxDurationMs: options.maxDurationMs,
  });

  while (!decision.done) {
    if (signal === null) {
      const decoded = decodeRunEndedDetail(readSignal());
      if (decoded) {
        signal = decoded;
        signalTimeMs = clock() - startMs;
      }
    }
    elapsedMs = clock() - startMs;
    decision = evaluateRunStop({
      elapsedMs,
      signalTimeMs,
      tailMs: options.tailMs,
      maxDurationMs: options.maxDurationMs,
    });
    if (decision.done) break;
    if (typeof options.onProgress === 'function') {
      options.onProgress({
        elapsedMs,
        maxDurationMs: effectiveCap,
        signalTimeMs,
      });
    }
    await pause(pollMs);
  }

  return {
    ...decision,
    signal,
    signalTimeMs,
    elapsedMs,
    runLengthMs: signalTimeMs ?? elapsedMs,
  };
}

/**
 * Resolves the effective demo game-over dwell, in milliseconds.
 *
 * The configured value (from `DEMO_GAME_OVER_DWELL_MS`, an override, or a test
 * injection) is clamped up to `minMs`, which defaults to the capture tail so
 * the dwell is always long enough for the recorded tail to show the outcome.
 * An invalid (non-finite or negative) configured value falls back to
 * `DEMO_GAME_OVER_DWELL_MS`. Passing `minMs: 0` lets tests run the demo with a
 * short or zero dwell without weakening the production minimum.
 *
 * @param {number} [configuredMs]
 * @param {number} [minMs]
 * @returns {number}
 */
export function resolveDemoGameOverDwellMs(
  configuredMs = DEMO_GAME_OVER_DWELL_MS,
  minMs = DEFAULT_CAPTURE_TAIL_MS,
) {
  const configured = Number(configuredMs);
  const minimum = Number.isFinite(Number(minMs))
    ? Math.max(0, Number(minMs))
    : DEFAULT_CAPTURE_TAIL_MS;
  const base =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : DEMO_GAME_OVER_DWELL_MS;

  return Math.max(minimum, base);
}

/**
 * Decides whether the demo should leave the game-over screen and return to
 * the menu: true once the dwell has elapsed.
 *
 * Non-finite inputs return `false` — the demo keeps holding rather than
 * looping on a bad clock/value.
 *
 * @param {number} elapsedMs — time spent on the game-over screen.
 * @param {number} dwellMs — the effective demo dwell.
 * @returns {boolean}
 */
export function shouldDemoReturnToMenu(elapsedMs, dwellMs) {
  const elapsed = Number(elapsedMs);
  const dwell = Number(dwellMs);
  if (!Number.isFinite(elapsed) || !Number.isFinite(dwell)) return false;

  return elapsed >= Math.max(0, dwell);
}

/**
 * Pure formatting helpers for `npm run capture` progress output
 * (AH-0MUWTNPY8003GGAA).
 *
 * The capture pipeline spends ~20 s producing no output (browser/Vite
 * startup + warm-up + recording + decode), which is easily mistaken for a
 * hang. These helpers render a single-line elapsed/total/ETA heartbeat and
 * are deliberately dependency-free and side-effect-free so they can be
 * unit-tested without a browser.
 *
 * This module is plain ESM JavaScript so the capture tool runs without a
 * TypeScript loader; `capture-progress.d.mts` supplies the types used by
 * the test suite.
 */

/**
 * Formats a duration in milliseconds as seconds with one decimal place.
 *
 * @param {number} ms
 * @returns {string} e.g. `1.5s`; `0.0s` for non-finite/negative input.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Estimates the remaining time (ms) for a run of `totalMs`.
 *
 * Clamped to `[0, totalMs]` so an over-running step never reports negative
 * time. Returns `0` when either input is not finite.
 *
 * @param {number} elapsedMs
 * @param {number} totalMs
 * @returns {number}
 */
export function estimateRemainingMs(elapsedMs, totalMs) {
  if (!Number.isFinite(totalMs) || !Number.isFinite(elapsedMs)) return 0;
  const remaining = totalMs - Math.max(0, elapsedMs);
  return Math.max(0, Math.round(remaining));
}

/**
 * Renders a single-line recording heartbeat with a progress bar, elapsed /
 * total time and an ETA, e.g.:
 *
 * `Recording [########----------------]  33%  5.0s/15.0s  ETA 10.0s`
 *
 * @param {number} elapsedMs
 * @param {number} totalMs
 * @param {number} [width] — progress-bar cell count (default 24).
 * @returns {string}
 */
export function formatProgress(elapsedMs, totalMs, width = 24) {
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const clamped = total > 0 ? Math.min(elapsed, total) : elapsed;
  const ratio = total > 0 ? clamped / total : 0;

  const cells = Math.max(1, Math.round(width));
  const filled = Math.min(cells, Math.max(0, Math.round(ratio * cells)));
  const bar = '#'.repeat(filled) + '-'.repeat(cells - filled);

  const percent = Math.round(ratio * 100);
  const remaining = estimateRemainingMs(elapsed, totalMs);

  return (
    `Recording [${bar}] ${String(percent).padStart(3, ' ')}%  ` +
    `${formatDuration(clamped)}/${formatDuration(total)}  ` +
    `ETA ${formatDuration(remaining)}`
  );
}

/**
 * Actionable setup hint shown when an opt-in capture dependency (the
 * `playwright` package or its Chromium binary) is missing, so the user
 * sees the fix instead of a raw module-resolution stack.
 *
 * @param {string} [dependency]
 * @returns {string}
 */
export function setupHint(dependency = 'playwright') {
  return (
    `${dependency} is required for automated gameplay capture but is not available.\n` +
    'Run: npm install && npm run capture:install'
  );
}

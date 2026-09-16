/**
 * Live spawn-interval control for the combat gyms (GDD §4.4, §6.3).
 *
 * Builds a plain-DOM range input (patterned on the `GymPlayer`/`GymEnemies`
 * panel sliders) that changes the running scene's power-up spawn cadence
 * immediately and persists the value through the game-rules config. Shared
 * by `GymEnemies` (which already owns a panel) and `GymBoss` (which uses it
 * as its only control) so the control is defined once.
 *
 * The row carries a stable id and data attributes so tests can assert it
 * with `document.querySelector`.
 *
 * @module utils/gymPowerUpControl
 */

import { loadRules, saveRules } from '../core/rules';

/** Stable DOM id of the spawn-interval range input. */
export const POWER_UP_INTERVAL_SLIDER_ID = 'power-up-spawn-interval';

/** Lower bound of the slider (seconds). */
export const POWER_UP_INTERVAL_MIN = 1;

/** Upper bound of the slider (seconds). */
export const POWER_UP_INTERVAL_MAX = 30;

/** Slider step (seconds). */
export const POWER_UP_INTERVAL_STEP = 0.5;

/** A built spawn-interval control row. */
export interface SpawnIntervalControl {
  /** The label row element (append to a panel/host). */
  row: HTMLElement;
  /** Re-applies the current slider value (used on input events). */
  refresh(): void;
}

/**
 * Builds the spawn-interval slider row, seeded from
 * `loadRules().powerUpSpawnInterval`. On every `input` event the *onApply*
 * callback is invoked with the new seconds value and the output label is
 * updated.
 *
 * @param onApply - Called with the new interval (seconds) on every input.
 * @returns The row element plus a `refresh()` handle.
 */
export function buildSpawnIntervalSlider(
  onApply: (seconds: number) => void,
): SpawnIntervalControl {
  const initial = loadRules().powerUpSpawnInterval;

  const row = document.createElement('label');
  row.className = 'gym-panel-row';

  const label = document.createElement('span');
  label.className = 'gym-panel-label';
  label.textContent = 'spawnInterval';

  const input = document.createElement('input');
  input.type = 'range';
  input.id = POWER_UP_INTERVAL_SLIDER_ID;
  input.dataset['powerUpControl'] = 'spawnInterval';
  input.min = String(POWER_UP_INTERVAL_MIN);
  input.max = String(POWER_UP_INTERVAL_MAX);
  input.step = String(POWER_UP_INTERVAL_STEP);
  input.value = String(initial);

  const output = document.createElement('output');
  output.dataset['powerUpControlValue'] = 'spawnInterval';
  output.textContent = String(initial);

  const refresh = (): void => {
    const seconds = Number(input.value);
    output.textContent = String(seconds);
    onApply(seconds);
  };
  input.addEventListener('input', refresh);

  row.append(label, input, output);
  return { row, refresh };
}

/**
 * Persists a new spawn interval into the game-rules config (merging over
 * the current rules so per-ID weights are preserved).
 */
export function applyAndPersistSpawnInterval(seconds: number): void {
  saveRules({ ...loadRules(), powerUpSpawnInterval: seconds });
}
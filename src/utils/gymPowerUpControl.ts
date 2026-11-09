/**
 * Live power-up controls for the combat gyms (GDD §4.4, §6.3).
 *
 * Builds plain-DOM range inputs (patterned on the `GymPlayer`/`GymFodderEnemies`
 * panel sliders). Two kinds of control are defined here, on the **one**
 * seconds-slider builder, so the DOM code is never duplicated:
 *
 * - {@link buildSpawnIntervalSlider} — changes the running scene's power-up
 *   spawn cadence immediately and persists the value through the game-rules
 *   config. Shared by `GymFodderEnemies` (which already owns a panel) and
 *   `GymBoss` (which uses it as its only control).
 * - {@link buildRechargeTimeSlider} — the dedicated recharge-tuning gym's
 *   Phase Shift / Teleport recharge-time override (AH-0MV82IAYG000WS8B). The
 *   override is persisted through `GameRules.phaseRechargeOverrideSeconds` /
 *   `teleportRechargeOverrideSeconds` so it survives a page reload, and is a
 *   **gym-only** layer: the shipped gameplay keeps its level-derived times.
 *
 * Every row carries a stable id and data attributes so tests can assert it
 * with `document.querySelector`.
 *
 * @module utils/gymPowerUpControl
 */

import { loadRules, saveRules } from '../core/rules';

/** Stable DOM id of the spawn-interval range input. */
export const POWER_UP_INTERVAL_SLIDER_ID = 'power-up-spawn-interval';

/** Lower bound of the spawn-interval slider (seconds). */
export const POWER_UP_INTERVAL_MIN = 1;

/** Upper bound of the spawn-interval slider (seconds). */
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

// ── Recharge-time overrides (AH-0MV82IAYG000WS8B) ───────────────────

/** The two defensive abilities the recharge-tuning gym can override. */
export type RechargeAbility = 'phase_shift' | 'teleport';

/** Stable DOM id of the Phase Shift recharge-time range input. */
export const PHASE_RECHARGE_SLIDER_ID = 'phase-recharge-override';

/** Stable DOM id of the Teleport recharge-time range input. */
export const TELEPORT_RECHARGE_SLIDER_ID = 'teleport-recharge-override';

/** Step of both recharge-time sliders (seconds). */
export const RECHARGE_SLIDER_STEP = 0.5;

/** Per-ability slider presentation — one source for ids, labels and ranges. */
export interface RechargeSliderSpec {
  /** Stable DOM id of the range input. */
  id: string;
  /** `data-power-up-control` key (stable CSS/test selector). */
  controlKey: string;
  /** Visible label, e.g. `Phase Shift recharge`. */
  label: string;
  /** Lower bound (seconds). */
  min: number;
  /** Upper bound (seconds). */
  max: number;
}

/**
 * The recharge-slider presentation table: Phase Shift covers 1–60 s and
 * Teleport 1–120 s, both at {@link RECHARGE_SLIDER_STEP} (AH-0MV82IAYG000WS8B).
 * The ranges bracket the level-derived defaults (30 s / 60 s) with room to
 * observe both a much faster and a much slower cadence.
 */
export const RECHARGE_SLIDER_SPECS: Readonly<
  Record<RechargeAbility, RechargeSliderSpec>
> = {
  phase_shift: {
    id: PHASE_RECHARGE_SLIDER_ID,
    controlKey: 'phaseRecharge',
    label: 'Phase Shift recharge',
    min: 1,
    max: 60,
  },
  teleport: {
    id: TELEPORT_RECHARGE_SLIDER_ID,
    controlKey: 'teleportRecharge',
    label: 'Teleport recharge',
    min: 1,
    max: 120,
  },
};

/** A built seconds-slider control row. */
export interface SecondsSliderControl {
  /** The label row element (append to a panel/host). */
  row: HTMLElement;
  /** The range input (seeded value, min/max/step). */
  input: HTMLInputElement;
  /** The numeric readout. */
  output: HTMLOutputElement;
  /** Re-applies the current slider value (used on input events). */
  refresh(): void;
}

/** Internal configuration for the shared seconds-slider builder. */
interface SecondsSliderConfig {
  /** Stable DOM id of the range input. */
  id: string;
  /** `data-power-up-control` key. */
  controlKey: string;
  /** Visible label. */
  label: string;
  min: number;
  max: number;
  step: number;
  /** Seed value. */
  initial: number;
  /** Unit suffix appended to the readout (e.g. `s`), or empty. */
  unit?: string;
  /** Called with the new seconds value on every input. */
  onApply: (seconds: number) => void;
}

/**
 * Builds one labelled range row. Kept private so both public controls share
 * exactly one DOM implementation (and one set of data attributes).
 */
function buildSecondsSlider(config: SecondsSliderConfig): SecondsSliderControl {
  const row = document.createElement('label');
  row.className = 'gym-panel-row';

  const label = document.createElement('span');
  label.className = 'gym-panel-label';
  label.textContent = config.label;

  const input = document.createElement('input');
  input.type = 'range';
  input.id = config.id;
  input.dataset['powerUpControl'] = config.controlKey;
  input.min = String(config.min);
  input.max = String(config.max);
  input.step = String(config.step);
  input.value = String(config.initial);

  const output = document.createElement('output');
  output.dataset['powerUpControlValue'] = config.controlKey;
  output.textContent = `${config.initial}${config.unit ?? ''}`;

  const refresh = (): void => {
    const seconds = Number(input.value);
    output.textContent = `${seconds}${config.unit ?? ''}`;
    config.onApply(seconds);
  };
  input.addEventListener('input', refresh);

  row.append(label, input, output);
  return { row, input, output, refresh };
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
  const control = buildSecondsSlider({
    id: POWER_UP_INTERVAL_SLIDER_ID,
    controlKey: 'spawnInterval',
    label: 'spawnInterval',
    min: POWER_UP_INTERVAL_MIN,
    max: POWER_UP_INTERVAL_MAX,
    step: POWER_UP_INTERVAL_STEP,
    initial,
    onApply,
  });
  return { row: control.row, refresh: control.refresh };
}

/**
 * Builds one recharge-time slider row for the tuning gym.
 *
 * The slider covers the ability's documented range at
 * {@link RECHARGE_SLIDER_STEP}, displays **seconds**, and invokes *onApply*
 * with the new override whenever it moves. The caller seeds *initialSeconds*
 * from the persisted rules override, or the level-derived default when the
 * override is unset.
 *
 * @param ability - The defensive ability to tune.
 * @param initialSeconds - Seed value in seconds.
 * @param onApply - Called with the new recharge time (seconds) on every input.
 * @returns The row element plus the input/output handles.
 */
export function buildRechargeTimeSlider(
  ability: RechargeAbility,
  initialSeconds: number,
  onApply: (seconds: number) => void,
): SecondsSliderControl {
  const spec = RECHARGE_SLIDER_SPECS[ability];
  return buildSecondsSlider({
    id: spec.id,
    controlKey: spec.controlKey,
    label: spec.label,
    min: spec.min,
    max: spec.max,
    step: RECHARGE_SLIDER_STEP,
    initial: initialSeconds,
    unit: 's',
    onApply,
  });
}

/**
 * Persists a new spawn interval into the game-rules config (merging over
 * the current rules so per-ID weights are preserved).
 */
export function applyAndPersistSpawnInterval(seconds: number): void {
  saveRules({ ...loadRules(), powerUpSpawnInterval: seconds });
}

/**
 * Persists a recharge-time override into the game-rules config, merging over
 * the current rules so every other tunable (including the sibling override)
 * is preserved (AH-0MV82IAYG000WS8B).
 *
 * @param ability - The ability whose override changed.
 * @param seconds - The new override in seconds, or `null` to restore the
 *   level-derived interval.
 */
export function applyAndPersistRechargeOverride(
  ability: RechargeAbility,
  seconds: number | null,
): void {
  const rules = loadRules();
  if (ability === 'phase_shift') {
    saveRules({ ...rules, phaseRechargeOverrideSeconds: seconds });
  } else {
    saveRules({ ...rules, teleportRechargeOverrideSeconds: seconds });
  }
}

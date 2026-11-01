/**
 * Hermetic promo-scenario survival/duration check
 * (AH-0MVSDMDA1003ARV5, child of AH-0MVI5XI73000ZVYA).
 *
 * A promo clip is only usable if the competent bot actually **survives and
 * keeps producing action** long enough to cut: a scenario the bot dies in
 * instantly is a wasted clip (parent risk). This module measures that
 * property headlessly through the shipped evaluation harness
 * (`src/ai/eval/arena.ts`) instead of ad-hoc browser captures.
 *
 * ## What it measures
 *
 * For one `kind: 'promo'` registry entry it plays the scenario exactly as the
 * game does:
 *
 * - the scenario's **hand-authored promo level** is the whole injected
 *   campaign (the same `[getPromoLevel(promoLevel)]` campaign `PlayScene`
 *   injects, `AH-0MVSDM8SE0081WU7`);
 * - the run is flown by the **competent bot** built from the scenario's
 *   curated **bot-tuning preset** (the same `createCompetentBotBrain` +
 *   `BotInputGovernor` mapping `PlayScene._applyBotTuning()` uses);
 * - the run is seeded with the scenario's `seed`, so the measurement is
 *   reproducible per scenario.
 *
 * The reported **action duration** is the simulated time before the run ends
 * (death, campaign clear, or the tick budget): `ticksSimulated × dt`. The
 * promo target is {@link PROMO_SURVIVAL_MIN_SECONDS} (≥45 s), and the tick
 * budget is bounded ({@link PROMO_SURVIVAL_TICK_BUDGET}) so the check stays a
 * fast, deterministic part of the standard suite.
 *
 * ## Fidelity boundary
 *
 * The arena is the evaluation harness's closed-loop approximation (no
 * Phaser, formation movement, VFX or boss entity — see the arena module doc).
 * It measures the property that matters here — how long the shipped bot
 * survives the authored waves — and is deliberately the *same* harness the
 * balance/batch tooling uses, so the number can be reproduced from the CLI.
 *
 * @module src/waves/promoSurvival
 */

import { runArena } from '../ai/eval/arena';
import {
  coerceTuningValues,
  toCompetentOverrides,
  toHumanOverrides,
} from '../ai/tuningFields';
import { createCompetentBotBrain } from '../ai/framework';
import {
  getBotTuningConfig,
  getCurrentBotTuningConfig,
} from '../core/botTuningStore';
import {
  listCaptureScenarios,
  type CapturePromoScenario,
} from '../../scripts/capture-scenarios.mjs';
import { getPromoLevel } from '../../scripts/promo-scenarios.mjs';

/** Fixed simulation step (seconds) — the arena's default ~60 fps. */
export const PROMO_SURVIVAL_DT = 1 / 60;

/** The sustained-action target a promo scenario must meet (parent AC2). */
export const PROMO_SURVIVAL_MIN_SECONDS = 45;

/**
 * Maximum ticks a measurement simulates (100 s at 60 fps).
 *
 * The budget is a *bound*, not a target: it sits comfortably above the 45 s
 * threshold so a healthy scenario can still be measured past it, while a
 * scenario that runs away (e.g. one stalled wave the bot cannot clear) ends
 * deterministically instead of hanging the suite.
 */
export const PROMO_SURVIVAL_TICK_BUDGET = 6_000;

/** Why a measured run ended. */
export type PromoSurvivalEndReason = 'player-death' | 'campaign-cleared' | 'tick-budget';

/** One promo scenario's measured survival/duration. */
export interface PromoSurvivalMeasurement {
  /** The registry scenario name (what `--scenario` accepts). */
  readonly scenario: string;
  /** The promo level id the scenario plays. */
  readonly promoLevel: string;
  /** The bot-tuning preset the scenario flies. */
  readonly preset: string;
  /** The run seed actually measured. */
  readonly seed: number;
  /** Simulated action duration before the run ended, seconds. */
  readonly seconds: number;
  /** Ticks simulated (the raw duration unit). */
  readonly ticks: number;
  /** Why the run ended. */
  readonly endReason: PromoSurvivalEndReason;
  /** Whether the authored promo campaign was cleared without dying. */
  readonly cleared: boolean;
}

/** The measured radio of a promo scenario against the ≥45 s target. */
export interface PromoSurvivalReport {
  /** Every measurement, in registry order. */
  readonly measurements: readonly PromoSurvivalMeasurement[];
  /** The scenarios below {@link PROMO_SURVIVAL_MIN_SECONDS}, in registry order. */
  readonly failures: readonly PromoSurvivalMeasurement[];
  /** Whether every measured scenario met the target. */
  readonly passed: boolean;
}

/** Narrows a registry entry to the promo catalogue. */
export function isPromoScenario(
  entry: { readonly kind: string },
): entry is CapturePromoScenario {
  return entry.kind === 'promo';
}

/** The promo catalogue entries, in registry (listing) order. */
export function promoScenarioEntries(): CapturePromoScenario[] {
  return listCaptureScenarios().filter(isPromoScenario);
}

/**
 * Resolves the bot-tuning preset a promo scenario flies, mirroring
 * `PlayScene._applyBotTuning()`: the scenario's named preset, falling back to
 * the currently-selected configuration when the local store lacks it (so a
 * stale `localStorage` blob can never break the measurement).
 */
export function resolvePromoPreset(preset: string) {
  return getBotTuningConfig(preset) ?? getCurrentBotTuningConfig();
}

/**
 * Measures one promo scenario's simulated action duration.
 *
 * Plays the scenario's authored promo level as the whole campaign through the
 * shared arena, flown by the competent bot configured with the scenario's
 * preset, seeded with the scenario's seed.
 */
export function measurePromoScenario(
  scenario: CapturePromoScenario,
): PromoSurvivalMeasurement {
  const presetConfig = resolvePromoPreset(scenario.preset);
  const values = coerceTuningValues(presetConfig.values);
  const tunables = toCompetentOverrides(values);
  const humanInput = toHumanOverrides(values);
  const level = getPromoLevel(scenario.promoLevel);
  const seed = scenario.seed ?? 1;

  const arena = runArena(
    createCompetentBotBrain({ tunables }),
    {
      seed,
      ticks: PROMO_SURVIVAL_TICK_BUDGET,
      dt: PROMO_SURVIVAL_DT,
      humanInput,
      campaign: true,
      campaignLevels: [level],
    },
  );

  const died = arena.records.some(
    (record) => record.kind === 'event' && record.event === 'player_death',
  );
  const cleared = arena.won && !died;
  const endReason: PromoSurvivalEndReason = died
    ? 'player-death'
    : cleared
      ? 'campaign-cleared'
      : 'tick-budget';

  return {
    scenario: scenario.name,
    promoLevel: scenario.promoLevel,
    preset: scenario.preset,
    seed,
    seconds: Number((arena.ticksSimulated * PROMO_SURVIVAL_DT).toFixed(3)),
    ticks: arena.ticksSimulated,
    endReason,
    cleared,
  };
}

/** Measures every promo scenario in the registry and checks the target. */
export function measurePromoSurvivalCatalogue(
  entries: readonly CapturePromoScenario[] = promoScenarioEntries(),
): PromoSurvivalReport {
  const measurements = entries.map(measurePromoScenario);
  const failures = measurements.filter(
    (measurement) => measurement.seconds < PROMO_SURVIVAL_MIN_SECONDS,
  );
  return { measurements, failures, passed: failures.length === 0 };
}

/**
 * Formats a measurement for an actionable failure message: the scenario name
 * and the measured duration are always present, as AC2 requires.
 */
export function describePromoSurvivalFailure(
  measurement: PromoSurvivalMeasurement,
): string {
  return (
    `${measurement.scenario}: ${measurement.seconds.toFixed(2)} s of action`
    + ` (${measurement.ticks} ticks, ended by ${measurement.endReason};`
    + ` target ≥${PROMO_SURVIVAL_MIN_SECONDS} s)`
  );
}

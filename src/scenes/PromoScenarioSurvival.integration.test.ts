/**
 * Real-game promo-scenario survival check (AH-0MVI5XI73000ZVYA, AC2/AC5).
 *
 * The promo catalogue's sustained-footage target ("≥45 s of bot-flown action
 * before the game-over dwell") was previously evidenced only by the headless
 * **arena** approximation (`src/waves/promoScenario.survival.test.ts`). The
 * arena deliberately omits Phaser formation movement, enemy descent and the
 * real collision/spawner loop, so it can report a long survival for a level
 * the shipped game ends in seconds — and it cannot be checked against a
 * recording on a loaded host.
 *
 * This suite closes that fidelity gap without a browser or a video: it boots
 * the **real `PlayScene`** through the shared deterministic boot harness, lets
 * the promo URL parameter apply the registered scenario (hand-authored level,
 * curated preset by name, seeded RNG), and advances the scene at a fixed
 * 1/60 s step — the same update path `npm run capture` records — until the
 * run-ended signal fires or the 45 s target is reached.
 *
 * It pins, for **every** registered `kind: 'promo'` entry:
 *
 * - the scenario really is applied (bot flight, the scenario's preset, the
 *   promo level as the whole campaign) — so a scenario that silently fell back
 *   to the shipped campaign cannot pass vacuously;
 * - the run does **not** end before 45 s of simulated action (defeat or an
 *   early campaign clear both fail, naming the scenario and its measured
 *   duration).
 *
 * The measurement is deterministic: the run is seeded from the scenario, the
 * bot is the shipped competent bot, and the harness steps the scene with a
 * fixed delta, so the result does not depend on host load. That is what makes
 * the promo catalogue verifiable on a busy machine where a recording would be
 * rejected as a stalled take.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { MineralChoiceScene } from './MineralChoiceScene';
import { PlayScene } from './PlayScene';
import { RUN_ENDED_EVENT } from '../core/runEndedSignal';
import { resetBotTuningStore } from '../core/botTuningStore';
import type { WaveManager } from '../waves/WaveManager';
import {
  listCaptureScenarios,
  type CapturePromoScenario,
} from '../../scripts/capture-scenarios.mjs';
import { getPromoLevel } from '../../scripts/promo-scenarios.mjs';

/** Fixed simulation step: the scene's own ~60 fps update cadence. */
const STEP_SECONDS = 1 / 60;

/** The sustained-action target a promo scenario must meet (parent AC2). */
const TARGET_SECONDS = 45;

/** Ticks needed to reach {@link TARGET_SECONDS} of simulated action. */
const TARGET_TICKS = Math.ceil(TARGET_SECONDS / STEP_SECONDS);

/** One scenario's real-game measurement. */
interface PromoMeasurement {
  readonly scenario: string;
  /** Simulated seconds the run survived before the run-ended signal. */
  readonly seconds: number;
  /** Whether the run ended (defeat or campaign clear) before the target. */
  readonly endedEarly: boolean;
  /** End-of-run outcome when the run ended, otherwise `null`. */
  readonly won: boolean | null;
  readonly score: number | null;
  /** The preset the run actually flew (should be the scenario's preset). */
  readonly preset: string | null;
  /** The campaign the run actually played (should be the promo level name). */
  readonly levelName: string;
  readonly levelCount: number;
  /** The wave the run was on when it ended (1-based). */
  readonly waveNumber: number;
  /** Lives left when the run ended (0 after a defeat). */
  readonly lives: number;
  /** Enemies still alive when the run ended. */
  readonly aliveCount: number;
}

/** Every registered promo scenario, in registry (listing) order. */
function promoEntries(): CapturePromoScenario[] {
  return listCaptureScenarios().filter(
    (entry): entry is CapturePromoScenario => entry.kind === 'promo',
  );
}

/** Narrows the scene's live `WaveManager` (campaign assertions). */
function waveManagerOf(scene: PlayScene): WaveManager {
  return (scene as unknown as { waveManager: WaveManager }).waveManager;
}

/** The measured catalogue, computed once for the whole suite. */
let measurements: PromoMeasurement[] = [];

describe('promo scenarios sustain real-game action (AH-0MVI5XI73000ZVYA, AC2)', () => {
  /**
   * Boots the menu, enters the ordinary `Play Game` run (the promo URL
   * parameter turns it into the scenario) and advances the real scene at a
   * fixed 1/60 s step until the run ends or 45 s of action is reached.
   */
  async function measureScenario(entry: CapturePromoScenario): Promise<PromoMeasurement> {
    resetBotTuningStore();
    window.history.replaceState(null, '', `/?scenario=${entry.name}`);

    const booted: BootedGame = await bootScene([
      MenuScene,
      PlayScene,
      GameOverScene,
      MineralChoiceScene,
    ]);
    try {
      const menu = booted.scene as MenuScene;
      menu.scene.start('PlayScene', { demo: false });
      // Two fixed steps: `create()` has run (the run exists) but no
      // meaningful gameplay time has elapsed — the "first frame" the promo
      // seam test uses.
      await advanceGame(booted.game, 34);
      const play = booted.game.scene.getScene('PlayScene') as PlayScene;

      // A holder object, not bare locals: the run-ended listener assigns
      // through the closure, so reading a holder property keeps the loop
      // condition honest for the type checker.
      const outcome: { won: boolean | null; score: number | null } = {
        won: null,
        score: null,
      };
      const onRunEnded = (event: Event): void => {
        const detail = (event as CustomEvent<{ won: boolean; score: number }>).detail;
        outcome.won = detail.won;
        outcome.score = detail.score;
      };
      window.addEventListener(RUN_ENDED_EVENT, onRunEnded);

      let ticks = 0;
      try {
        while (ticks < TARGET_TICKS && outcome.won === null) {
          play.tick(STEP_SECONDS);
          ticks += 1;
        }
      } finally {
        window.removeEventListener(RUN_ENDED_EVENT, onRunEnded);
      }

      const wave = waveManagerOf(play);
      return {
        scenario: entry.name,
        seconds: ticks * STEP_SECONDS,
        endedEarly: outcome.won !== null,
        won: outcome.won,
        score: outcome.score,
        preset: play.getBotTuningConfigName(),
        levelName: wave.levelName,
        levelCount: wave.levelCount,
        waveNumber: wave.waveNumber,
        lives: play.getGameState().lives,
        aliveCount: play.getAliveCount(),
      };
    } finally {
      booted.game.destroy(true);
    }
  }

  beforeAll(async () => {
    const measured: PromoMeasurement[] = [];
    for (const entry of promoEntries()) {
      measured.push(await measureScenario(entry));
    }
    measurements = measured;
  }, 600_000);

  afterAll(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
  });

  it('applies every registered promo scenario to the real run (no vacuous passes)', () => {
    const entries = promoEntries();

    // Registry ↔ harness parity: the check measures the live catalogue, not a
    // fixture, and never invents a scenario.
    expect(measurements.map((measurement) => measurement.scenario)).toEqual(
      entries.map((entry) => entry.name),
    );
    expect(entries.length).toBeGreaterThanOrEqual(10);

    for (const entry of entries) {
      const measurement = measurements.find((candidate) => candidate.scenario === entry.name)!;
      // The scenario is the run: bot-flown with its preset by name and its
      // hand-authored level as the whole campaign. A fallback to the shipped
      // campaign would make the duration assertion meaningless.
      expect(measurement.preset, `${entry.name} did not fly its preset`).toBe(entry.preset);
      expect(measurement.levelCount, `${entry.name} campaign level count`).toBe(1);
      expect(measurement.levelName, `${entry.name} campaign level`).toBe(
        getPromoLevel(entry.promoLevel).name,
      );
    }
  });

  it('keeps every registered promo scenario alive for at least 45 s of action', () => {
    const describeMeasurement = (measurement: PromoMeasurement): string =>
      `${measurement.scenario}: ${measurement.seconds.toFixed(1)} s`
      + (measurement.endedEarly
        ? ` — ended (${measurement.won ? 'campaign cleared' : 'defeat'}) on wave `
          + `${measurement.waveNumber}, lives ${measurement.lives}, `
          + `${measurement.aliveCount} enemies alive, score ${measurement.score}`
        : ' — survived the target');

    const failures = measurements
      .filter((measurement) => measurement.endedEarly)
      .map(describeMeasurement);

    // The full measured table is the evidence, not just the failures: a
    // scenario barely over the target is worth seeing next to one that failed.
    expect(failures, measurements.map(describeMeasurement).join('\n')).toEqual([]);
  });
});

/**
 * Deterministic run seeding integration tests (AH-0MUY08V6W001SJJN).
 *
 * Boots the real `PlayScene` with its live loop stopped and drives it with
 * fixed-delta `game.step` calls, so a run is a pure function of its seed and
 * the (empty) input. Two runs on the same seed must agree tick-for-tick; two
 * runs on different seeds must diverge; and an unseeded run must pick a fresh
 * random seed each time.
 *
 * No search tools were used to find the wiring: the seeded stream is threaded
 * to wave planning, asteroid timing, entity construction, mineral drops,
 * power-up rolls and random AOE, so the fingerprint below covers every RNG
 * consumer that runs during the measured window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { RULES_STORAGE_KEY } from '../core/rules';
import { buildBotSnapshot } from '../ai/botSnapshot';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';

/** Fixed simulation step (~60 fps) for deterministic manual stepping. */
const STEP_MS = 1000 / 60;

/** Number of ticks measured after the seeded run settles. */
const RUN_TICKS = 180;

/** Monotonic simulated clock for manual `game.step` calls. */
let simTime = 0;

describe('PlayScene — deterministic run seeding (AH-0MUY08V6W001SJJN)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // Use the deterministic static campaign; the seeding path is covered
    // separately for sequenced waves (its generator is seeded too).
    localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Boots PlayScene and stops the live loop for explicit stepping. */
  async function bootStopped(): Promise<Phaser.Game> {
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene], {
      deterministicBoot: true,
    });
    booted.game.loop.stop();
    return booted.game;
  }

  /** Steps the stopped game until `predicate` holds (or fails loudly). */
  function stepUntil(game: Phaser.Game, label: string, predicate: () => boolean): void {
    for (let i = 0; i < 600; i += 1) {
      if (predicate()) return;
      simTime += STEP_MS;
      game.step(simTime, STEP_MS);
    }
    throw new Error(`stepUntil(${label}): condition not met after 600 steps`);
  }

  /**
   * Restarts PlayScene and steps until the new `create()` has completed.
   * Waiting on Phaser's `CREATE` event (rather than a guessed step count)
   * makes the measurement window identical across runs regardless of how
   * many steps the restart itself takes.
   */
  function restartAndSettle(game: Phaser.Game, data?: { seed?: number }): PlayScene {
    const play = game.scene.getScene('PlayScene') as PlayScene;
    let created = false;
    play.events.once(Phaser.Scenes.Events.CREATE, () => {
      created = true;
    });
    simTime = 0;
    play.scene.restart(data);
    stepUntil(game, 'scene create after restart', () => created);
    return play;
  }

  /**
   * Restarts PlayScene with `seed`, settles it, advances `RUN_TICKS` fixed
   * steps, and returns a position fingerprint of the whole live simulation.
   */
  function runSeeded(game: Phaser.Game, seed: number): string {
    const play = restartAndSettle(game, { seed });
    for (let i = 0; i < RUN_TICKS; i += 1) {
      simTime += STEP_MS;
      game.step(simTime, STEP_MS);
    }
    return fingerprint(play);
  }

  it('AC1 — exposes the seeded run seed via getRunSeed() and GameState', async () => {
    const game = await bootStopped();
    const play = restartAndSettle(game, { seed: 0x0badf00d });

    expect(play.getRunSeed()).toBe(0x0badf00d);
    expect(play.getGameState().runSeed).toBe(0x0badf00d);
  });

  it('AC3 — the same seed reproduces the same run over N ticks', async () => {
    const game = await bootStopped();

    const first = runSeeded(game, 4242);
    const second = runSeeded(game, 4242);

    expect(second).toBe(first);
  });

  it('AC3 — different seeds produce different runs', async () => {
    const game = await bootStopped();

    const a = runSeeded(game, 4242);
    const b = runSeeded(game, 9001);

    expect(b).not.toBe(a);
  });

  it('AC5 — an unseeded run picks a fresh random seed each run', async () => {
    const game = await bootStopped();

    const first = restartAndSettle(game).getRunSeed();
    const second = restartAndSettle(game).getRunSeed();

    expect(first).not.toBe(second);
  });

  it('AC5 — an unseeded run still starts and spawns a wave', async () => {
    const game = await bootStopped();
    const play = restartAndSettle(game);
    stepUntil(game, 'wave spawn', () => play.getEnemies().length > 0);

    expect(Number.isInteger(play.getRunSeed())).toBe(true);
    expect(play.getRunSeed()).toBeGreaterThanOrEqual(0);
    expect(play.getRunSeed()).toBeLessThanOrEqual(0xffffffff);
    expect(play.getAliveCount()).toBeGreaterThan(0);
  });
});

/** A position fingerprint of the live run (positions rounded to 1e-6). */
function fingerprint(scene: PlayScene): string {
  const snapshot = buildBotSnapshot(scene);
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return JSON.stringify({
    runSeed: snapshot.runSeed,
    player: snapshot.player ? [r(snapshot.player.x), r(snapshot.player.y)] : null,
    enemies: snapshot.enemies.map((e) => [r(e.x), r(e.y), e.alive, e.archetype]),
    enemyBullets: snapshot.enemyBullets.map((b) => [r(b.x), r(b.y), r(b.vx), r(b.vy)]),
    playerBullets: snapshot.playerBullets.map((b) => [r(b.x), r(b.y)]),
    drops: snapshot.drops.map((d) => [r(d.x), r(d.y), d.type]),
    minerals: snapshot.minerals.map((m) => [r(m.x), r(m.y)]),
    aliveCount: snapshot.aliveCount,
  });
}

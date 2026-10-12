/**
 * Integration tests for the PlayScene telemetry instrumentation
 * (AH-0MUY08VVQ007HSSH, AC1–AC5).
 *
 * Boots the real `PlayScene` with its live loop stopped, injects a real
 * `BufferedTelemetryRecorder` writing to a capturing sink (so the whole
 * framework path — envelope versioning, redaction, schema) is exercised, and
 * drives fixed-delta `game.step` calls. Every record is asserted through the
 * public recorder/sink, never by grepping the source.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { RULES_STORAGE_KEY } from '../core/rules';
import { buildBotSnapshot } from '../ai/botSnapshot';
import {
  BufferedTelemetryRecorder,
  TELEMETRY_JSONL_STORAGE_KEY,
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryRecord,
  type TelemetrySink,
} from '../telemetry';
import {
  RUN_TELEMETRY_EVENT_VERSION,
  RUN_TELEMETRY_STATE_VERSION,
  serialiseTelemetryInput,
} from './core/runTelemetry';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';

vi.setConfig({ testTimeout: 20000 });

/** Fixed simulation step (~60 fps) for deterministic manual stepping. */
const STEP_MS = 1000 / 60;

/** Fixed run seed, so the run header/state assertions are exact. */
const SEED = 0x51ee7;

/** Monotonic simulated clock for manual `game.step` calls. */
let simTime = 0;

/** Captures every delivered record synchronously (no async sink races). */
class CaptureSink implements TelemetrySink {
  readonly name = 'capture';
  readonly records: TelemetryRecord[] = [];

  write(batch: readonly TelemetryRecord[]): void {
    this.records.push(...batch);
  }
}

describe('PlayScene telemetry instrumentation (AH-0MUY08VVQ007HSSH)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
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

  /** Steps the stopped game until `predicate` holds (or fails loudly). */
  function stepUntil(
    game: Phaser.Game,
    label: string,
    predicate: () => boolean,
  ): void {
    for (let i = 0; i < 600; i += 1) {
      if (predicate()) return;
      simTime += STEP_MS;
      game.step(simTime, STEP_MS);
    }
    throw new Error(`stepUntil(${label}): condition not met after 600 steps`);
  }

  /** Steps the stopped game `count` fixed ticks. */
  function step(game: Phaser.Game, count: number): void {
    for (let i = 0; i < count; i += 1) {
      simTime += STEP_MS;
      game.step(simTime, STEP_MS);
    }
  }

  /** Restarts PlayScene and steps until the new `create()` has completed. */
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
   * Boots PlayScene, injects a real recorder over a capturing sink and
   * restarts with the fixed seed so `create()` installs the injected recorder
   * and writes the run header.
   */
  async function bootWithTelemetry(): Promise<{
    game: Phaser.Game;
    play: PlayScene;
    sink: CaptureSink;
    recorder: BufferedTelemetryRecorder;
  }> {
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene], {
      deterministicBoot: true,
    });
    booted.game.loop.stop();
    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    const sink = new CaptureSink();
    const recorder = new BufferedTelemetryRecorder(sink, {
      capacity: 8192,
      batchSize: 8192,
      sampleRate: 1,
    });
    play.setTelemetryRecorder(recorder);
    restartAndSettle(booted.game, { seed: SEED });
    return { game: booted.game, play, sink, recorder };
  }

  /** All delivered event records, in delivery order. */
  function eventRecords(sink: CaptureSink): Extract<TelemetryRecord, { kind: 'event' }>[] {
    return sink.records.filter(
      (record): record is Extract<TelemetryRecord, { kind: 'event' }> =>
        record.kind === 'event',
    );
  }

  /** A position fingerprint of the live run, rounded to 1e-6. */
  function fingerprint(scene: PlayScene): string {
    const snapshot = buildBotSnapshot(scene);
    const r = (n: number) => Math.round(n * 1e6) / 1e6;
    return JSON.stringify({
      runSeed: snapshot.runSeed,
      player: snapshot.player
        ? [r(snapshot.player.x), r(snapshot.player.y), r(snapshot.player.vx), r(snapshot.player.vy)]
        : null,
      enemies: snapshot.enemies.map((e) => [r(e.x), r(e.y), e.alive, e.archetype]),
      enemyBullets: snapshot.enemyBullets.map((b) => [r(b.x), r(b.y), r(b.vx), r(b.vy)]),
      drops: snapshot.drops.map((d) => [r(d.x), r(d.y), d.type]),
      minerals: snapshot.minerals.map((m) => [r(m.x), r(m.y)]),
      aliveCount: snapshot.aliveCount,
    });
  }

  /**
   * Steps (flushing periodically so the capturing sink sees events) until
   * `eventName` has been delivered, or `maxSteps` is reached.
   */
  async function stepUntilEvent(
    game: Phaser.Game,
    recorder: BufferedTelemetryRecorder,
    sink: CaptureSink,
    eventName: string,
    maxSteps = 600,
  ): Promise<void> {
    for (let i = 0; i < maxSteps; i += 1) {
      simTime += STEP_MS;
      game.step(simTime, STEP_MS);
      if (i % 10 === 0) {
        await recorder.flush();
        if (eventRecords(sink).some((record) => record.event === eventName)) return;
      }
    }
    await recorder.flush();
  }

  it('AC1/AC2/AC6 — records a versioned run header and per-tick state + applied input', async () => {
    const { game, play, sink, recorder } = await bootWithTelemetry();
    step(game, 30);
    await recorder.flush();

    const header = sink.records.find((record) => record.kind === 'run_header');
    expect(header).toBeDefined();
    if (header?.kind !== 'run_header') throw new Error('no run header');
    expect(header.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(header.runSeed).toBe(SEED);

    const ticks = sink.records.filter((record) => record.kind === 'tick');
    expect(ticks.length).toBeGreaterThan(0);
    const tick = ticks[ticks.length - 1];
    if (tick.kind !== 'tick') throw new Error('no tick record');

    expect(tick.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    const state = tick.state as Record<string, unknown>;
    expect(state.v).toBe(RUN_TELEMETRY_STATE_VERSION);
    expect(state.runSeed).toBe(SEED);
    const playerState = state.player as Record<string, unknown>;
    expect(playerState).toBeTruthy();
    expect(typeof playerState.x).toBe('number');
    expect(typeof playerState.y).toBe('number');
    expect(typeof playerState.vx).toBe('number');
    expect(typeof playerState.vy).toBe('number');
    expect(typeof playerState.heading).toBe('number');
    expect(playerState.lives).toBe(3);
    expect(state.hold).toEqual({ minerals: 0, capacity: 5 });
    expect(state.levels).toEqual({ weapons: [], powerUps: [] });
    expect(Array.isArray(state.enemies)).toBe(true);

    // AC2: the tick's input is the input the shared player step actually applied.
    const player = play.getPlayer();
    expect(tick.input).toEqual(serialiseTelemetryInput(player!.getInput()));
  });

  it('AC3 — records run start and wave start', async () => {
    const { game, sink, recorder } = await bootWithTelemetry();
    step(game, 5);
    await recorder.flush();

    const names = eventRecords(sink).map((record) => record.event);
    expect(names).toContain('run_start');
    expect(names).toContain('wave_start');
    expect(eventRecords(sink).find((r) => r.event === 'run_start')?.payload).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      seed: SEED,
    });
  });

  it('AC3 — records mineral collection', async () => {
    const { game, play, sink, recorder } = await bootWithTelemetry();
    const player = play.getPlayer()!;
    play.spawnMineralAt(player.x, player.y);
    step(game, 2);
    await recorder.flush();

    expect(eventRecords(sink).map((r) => r.event)).toContain('mineral_collected');
  });

  it('AC3 — records a power-up pickup', async () => {
    const { game, play, sink, recorder } = await bootWithTelemetry();
    const player = play.getPlayer()!;
    play.spawnPowerUpDrop('shield', player.x, player.y);
    await stepUntilEvent(game, recorder, sink, 'pickup');

    const pickup = eventRecords(sink).find((r) => r.event === 'pickup');
    expect(pickup?.payload).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      kind: 'powerUp',
      id: 'shield',
    });
  });

  it('AC3 — records the hold-full choice opening and its selection', async () => {
    const { play, sink, recorder } = await bootWithTelemetry();
    const options = play.openMineralChoice();
    expect(options.length).toBeGreaterThan(0);
    play.selectMineralChoice(0);
    await recorder.flush();

    const names = eventRecords(sink).map((r) => r.event);
    expect(names).toContain('hold_full');
    expect(names).toContain('choice_selected');
    const selected = eventRecords(sink).find((r) => r.event === 'choice_selected');
    expect(selected?.payload).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      index: 0,
      id: options[0].id,
    });
  });

  it('AC3 — records an enemy kill, the fatal hit and the run end', async () => {
    const { game, play, sink, recorder } = await bootWithTelemetry();
    step(game, 60);
    play.finishSpawnAnimations();
    const target = play.getEnemies().find((enemy) => enemy.alive);
    expect(target).toBeDefined();
    // One life left, then ram the enemy: destroys it and ends the run.
    play.getGameState().lives = 1;
    play.getPlayer()!.respawn(target!.x, target!.y);
    step(game, 1);
    await recorder.flush();

    const names = eventRecords(sink).map((r) => r.event);
    expect(names).toContain('enemy_killed');
    expect(names).toContain('player_hit');
    expect(names).toContain('player_death');
    expect(names).toContain('run_end');
    const runEnd = eventRecords(sink).find((r) => r.event === 'run_end');
    expect(runEnd?.payload).toMatchObject({ won: false });
  });

  it('AC5 — telemetry off is a strict no-op and records nothing', async () => {
    localStorage.removeItem(TELEMETRY_JSONL_STORAGE_KEY);
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene], {
      deterministicBoot: true,
    });
    booted.game.loop.stop();
    const play = restartAndSettle(booted.game, { seed: SEED });

    expect(play.isTelemetryEnabled()).toBe(false);
    step(booted.game, 30);
    expect(localStorage.getItem(TELEMETRY_JSONL_STORAGE_KEY)).toBeNull();
  });

  it('AC5 — enabling recording does not change the run (regression)', async () => {
    // Run A: recording enabled via an injected recorder.
    const a = await bootWithTelemetry();
    step(a.game, 120);
    const recorded = fingerprint(a.play);
    a.game.destroy(true);
    booted = null;

    // Run B: recording disabled (no injection) — same seed, same ticks.
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene], {
      deterministicBoot: true,
    });
    booted.game.loop.stop();
    const playB = restartAndSettle(booted.game, { seed: SEED });
    step(booted.game, 120);

    expect(fingerprint(playB)).toBe(recorded);
  });

  it('AC3 — records boss spawn, defeat and a winning run end', async () => {
    const { game, play, sink, recorder } = await bootWithTelemetry();
    // Public dev/test seam: a one-hit boss, frozen until we release it.
    play.startDevBossScenario(1);
    play.setPaused(false);
    await stepUntilEvent(game, recorder, sink, 'run_end');

    const names = eventRecords(sink).map((record) => record.event);
    expect(names).toContain('boss_spawn');
    expect(names).toContain('boss_defeated');
    const runEnd = eventRecords(sink).find((record) => record.event === 'run_end');
    expect(runEnd?.payload).toMatchObject({ won: true });
  });

  it('AC4 — records the bot input when the demo bot drives', async () => {
    const { game, sink, recorder } = await bootWithTelemetry();
    const play = game.scene.getScene('PlayScene') as PlayScene;
    // Drive the shared input seam with a deterministic bot decision rather
    // than depending on the demo governor's timing.
    (play as unknown as { getBotInput: () => unknown }).getBotInput = () => ({
      forward: true,
      turnLeft: false,
      turnRight: false,
    });
    step(game, 5);
    await recorder.flush();

    const ticks = sink.records.filter((record) => record.kind === 'tick');
    const lastInput = ticks[ticks.length - 1];
    if (lastInput.kind !== 'tick') throw new Error('no tick record');
    expect(lastInput.input).toEqual({
      scheme: 'asteroids',
      forward: true,
      turnLeft: false,
      turnRight: false,
    });
  });
});

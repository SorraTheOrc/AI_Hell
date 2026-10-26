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
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../core/settingsStore';
import { buildBotSnapshot } from '../ai/botSnapshot';
import {
  BufferedTelemetryRecorder,
  JsonlTelemetrySink,
  TELEMETRY_SCHEMA_VERSION,
  createMemoryLineWriter,
  type TelemetryRecord,
  type TelemetrySink,
} from '../telemetry';
import type { DevUploadFetch } from '../telemetry/devUpload';
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

/**
 * Every `localStorage` key whose name mentions telemetry. Telemetry must never
 * write to storage (AH-0MVIRYGD1000JVY3, AC1), so this is always empty.
 */
function telemetryStorageKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key !== null && key.toLowerCase().includes('telemetry')) keys.push(key);
  }
  return keys;
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
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
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
    // Dev collection is on by default (AH-0MVBMRIB800201KK), so the opt-out
    // is what makes this a stock "off" run.
    saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev: false });
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    booted.game.loop.stop();
    const play = restartAndSettle(booted.game, { seed: SEED });

    expect(play.isTelemetryEnabled()).toBe(false);
    step(booted.game, 30);
    // The buffer accessor exists (dev-gated) but never holds a record, and no
    // telemetry is written to storage (AC1).
    expect(window.__aiHellTelemetry?.read()).toBeNull();
    expect(telemetryStorageKeys()).toEqual([]);
  });

  it('dev collection is on by default: a stock dev run fills the in-memory buffer', async () => {
    vi.stubEnv('DEV', true);
    saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev: true });
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    booted.game.loop.stop();
    const play = restartAndSettle(booted.game, { seed: SEED });

    // No injected recorder and no VITE_TELEMETRY_* env var: the persisted
    // setting alone puts a stock dev session into recording (AC2/AC3).
    expect(play.isTelemetryEnabled()).toBe(true);

    // Stepping past the recorder's batch size forces a flush of the buffered
    // records into the dev sink's in-memory buffer, which the dev-gated page
    // accessor exposes to the Node tooling (AH-0MVIRYGD1000JVY3, AC1/AC5).
    step(booted.game, 120);

    await vi.waitFor(
      () => {
        const buffered = window.__aiHellTelemetry?.read();
        expect(buffered).toBeTruthy();
        const records = buffered!
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as TelemetryRecord);
        expect(records[0]?.kind).toBe('run_header');
        expect(records.some((record) => record.kind === 'tick')).toBe(true);
      },
      { timeout: 5000 },
    );
    // Telemetry never touches storage, so a full quota can no longer break
    // settings saves (AC1).
    expect(telemetryStorageKeys()).toEqual([]);
  });

  it('AC1/AC3 — a dev run leaves settings writable: the scheme persists and reloads', async () => {
    vi.stubEnv('DEV', true);
    saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev: true, controlScheme: 'asteroids' });
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    booted.game.loop.stop();
    const play = restartAndSettle(booted.game, { seed: SEED });
    expect(play.isTelemetryEnabled()).toBe(true);

    // Several seconds of telemetry: far past the old ~1.4-minute quota path
    // per second, but the point stands — the buffer grows, storage does not.
    // The recorder flushes into the sink asynchronously, so wait for it.
    step(booted.game, 240);
    await vi.waitFor(
      () => expect(window.__aiHellTelemetry?.read()).toBeTruthy(),
      { timeout: 5000 },
    );

    // The reported symptom was `setItem` throwing; with telemetry off
    // storage the settings record still saves and reloads.
    saveSettings({ ...loadSettings(), controlScheme: 'fourDirectional' });
    expect(loadSettings().controlScheme).toBe('fourDirectional');
    expect(telemetryStorageKeys()).toEqual([]);
    // And the in-memory buffer is untouched by the settings write.
    expect(window.__aiHellTelemetry?.read()).toBeTruthy();
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
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
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

describe('PlayScene dev upload at run end (AH-0MVBMRK6X0069QDI)', () => {
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** A `fetch` spy typed like the uploader's seam. */
  function uploadFetchSpy(): ReturnType<typeof vi.fn<DevUploadFetch>> {
    return vi.fn<DevUploadFetch>(async () => ({ ok: true, status: 200 }));
  }

  /** Drains pending promise jobs (the fire-and-forget bridge) without timers. */
  async function drainMicrotasks(turns = 20): Promise<void> {
    for (let i = 0; i < turns; i += 1) await Promise.resolve();
  }

  /** Steps the stopped game until `predicate` holds (or fails loudly). */
  function stepUntil(label: string, predicate: () => boolean): void {
    for (let i = 0; i < 600; i += 1) {
      if (predicate()) return;
      simTime += STEP_MS;
      booted!.game.step(simTime, STEP_MS);
    }
    throw new Error(`stepUntil(${label}): condition not met after 600 steps`);
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
    stepUntil('scene create after restart', () => created);
    return play;
  }

  /**
   * Boots a settled PlayScene with an injected recorder whose dev sink is a
   * real in-memory JSONL buffer, then applies the run-end share setting.
   *
   * The injected recorder keeps the run's records in that buffer, so the
   * upload body is exactly the buffer content the dev-gated accessor exposes
   * (AH-0MVIRYGD1000JVY3). The uploader reads the setting at run end, so
   * applying it afterwards is the state the run-end hook sees.
   */
  async function bootWithMemoryBuffer(shareTelemetryDev: boolean): Promise<PlayScene> {
    saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev: false });
    simTime = 0;
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    booted.game.loop.stop();
    const play = booted.game.scene.getScene('PlayScene') as PlayScene;
    play.setTelemetryRecorder(
      new BufferedTelemetryRecorder(new JsonlTelemetrySink(createMemoryLineWriter()), {
        capacity: 8192,
        batchSize: 8192,
        sampleRate: 1,
      }),
    );
    restartAndSettle(booted.game, { seed: SEED });
    saveSettings({ ...DEFAULT_SETTINGS, shareTelemetryDev });
    return play;
  }

  /** Ram the final-life ship into a live enemy: synchronously ends the run. */
  function endRun(play: PlayScene): void {
    // Warm the wave spawners (mirroring the fatal-hit telemetry test) so a
    // target exists to ram.
    for (let i = 0; i < 60; i += 1) {
      simTime += STEP_MS;
      booted!.game.step(simTime, STEP_MS);
    }
    play.finishSpawnAnimations();
    const target = play.getEnemies().find((enemy) => enemy.alive);
    if (!target) throw new Error('no live enemy to end the run with');
    play.getGameState().lives = 1;
    play.getPlayer()!.respawn(target.x, target.y);
    simTime += STEP_MS;
    booted!.game.step(simTime, STEP_MS);
  }

  it('dev+on — posts the run buffer at run end and still reaches GameOverScene', async () => {
    const play = await bootWithMemoryBuffer(true);
    const uploadFetch = uploadFetchSpy();
    vi.stubGlobal('fetch', uploadFetch);

    endRun(play);
    // Phaser queues `scene.start`; step once so the transition is processed.
    stepUntil('GameOverScene active', () => booted!.game.scene.isActive('GameOverScene'));

    await vi.waitFor(
      () => expect(uploadFetch).toHaveBeenCalledTimes(1),
      { timeout: 5000 },
    );
    const [url, init] = uploadFetch.mock.calls[0]!;
    expect(url).toBe('/api/telemetry/upload');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
    });
    // The body is this run's records, read straight out of the in-memory
    // buffer: exactly one run_header, ticks, and the run_end event.
    const records = init.body
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryRecord);
    expect(records.filter((record) => record.kind === 'run_header')).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'run_header', runSeed: SEED });
    expect(records.some((record) => record.kind === 'tick')).toBe(true);
    expect(
      records.some((record) => record.kind === 'event' && record.event === 'run_end'),
    ).toBe(true);
    // The dev-gated accessor exposes the same buffer, and no telemetry reached
    // storage (AC1/AC5).
    expect(window.__aiHellTelemetry?.read()).toBe(init.body);
    expect(telemetryStorageKeys()).toEqual([]);
    // The scene transition still happened alongside the upload.
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });

  it('dev+off — no fetch, run end still transitions', async () => {
    const play = await bootWithMemoryBuffer(false);
    const uploadFetch = uploadFetchSpy();
    vi.stubGlobal('fetch', uploadFetch);

    endRun(play);
    stepUntil('GameOverScene active', () => booted!.game.scene.isActive('GameOverScene'));
    // Let the fire-and-forget bridge settle before asserting it never fired.
    await drainMicrotasks();
    expect(uploadFetch).not.toHaveBeenCalled();
  });

  it('prod build — no fetch, run end still transitions', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    const play = await bootWithMemoryBuffer(true);
    const uploadFetch = uploadFetchSpy();
    vi.stubGlobal('fetch', uploadFetch);

    endRun(play);
    stepUntil('GameOverScene active', () => booted!.game.scene.isActive('GameOverScene'));
    await drainMicrotasks();
    expect(uploadFetch).not.toHaveBeenCalled();
  });

  it('failed upload — swallowed, run end still transitions', async () => {
    const play = await bootWithMemoryBuffer(true);
    vi.stubGlobal(
      'fetch',
      vi.fn<DevUploadFetch>(async () => {
        throw new Error('dev server unreachable');
      }),
    );

    endRun(play);
    stepUntil('GameOverScene active', () => booted!.game.scene.isActive('GameOverScene'));

    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });
});

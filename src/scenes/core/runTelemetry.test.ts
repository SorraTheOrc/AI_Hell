/**
 * Unit tests for the game telemetry instrumentation layer
 * (AH-0MUY08VVQ007HSSH, AC1/AC2/AC3/AC6).
 *
 * These are hermetic and Phaser-free: the state/event serialisation is a pure
 * function of a `BotSnapshot` plus run-state extras, so every shape, version
 * tag and event name is asserted directly without booting a scene.
 */

import { describe, expect, it } from 'vitest';

import type { BotSnapshot } from '../../ai/botSnapshot';
import {
  DEFAULT_ACTION_INTENSITY_CONFIG,
  computeActionIntensity,
} from './actionIntensity';
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryJson,
  type TelemetryRecorder,
  type TelemetryRecorderStats,
  type TelemetryRunHeaderInput,
} from '../../telemetry';
import {
  actionIntensityCountsFromState,
  buildRunTelemetryState,
  RUN_TELEMETRY_EVENT_VERSION,
  RUN_TELEMETRY_EVENTS,
  RUN_TELEMETRY_STATE_VERSION,
  RunTelemetry,
  serialiseTelemetryInput,
  type RunTelemetryExtras,
  type RunTelemetryState,
} from './runTelemetry';

/** A representative snapshot with every collection populated. */
const SNAPSHOT: BotSnapshot = {
  player: { x: 10, y: 20, vx: 1.5, vy: -2.5 },
  enemies: [
    { x: 1, y: 2, alive: true, archetype: 'scout' },
    { x: 3, y: 4, alive: false, archetype: 'diver' },
  ],
  enemyBullets: [{ x: 5, y: 6, vx: 7, vy: 8 }],
  playerBullets: [{ x: 0.5, y: 0.5, vx: 0, vy: 0 }],
  drops: [{ x: 9, y: 9, type: 'shield' }],
  minerals: [{ x: 11, y: 11, type: 'mineral' }],
  boss: { x: 12, y: 12, alive: true, phase: 3 },
  aliveCount: 1,
  wave: { active: true, timeRemaining: 30, timeLimit: 45 },
  runSeed: 0x0badf00d,
};

const EXTRAS: RunTelemetryExtras = {
  heading: 1.25,
  lives: 2,
  invulnerable: true,
  minerals: 3,
  mineralCapacity: 5,
  weaponLevels: [{ id: 'spread', level: 2 }],
  powerUpLevels: [{ id: 'shield', level: 1 }],
};

/** Captures every recorder call synchronously for assertions. */
class FakeRecorder implements TelemetryRecorder {
  readonly enabled: boolean;
  header: TelemetryRunHeaderInput | null = null;
  readonly ticks: Array<{ state: unknown; input: unknown }> = [];
  readonly events: Array<{ event: string; payload: unknown }> = [];
  flushCount = 0;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  startRun(header: TelemetryRunHeaderInput): void {
    this.header = header;
  }

  recordTick(state: unknown, input: unknown): void {
    this.ticks.push({ state, input });
  }

  recordEvent(event: string, payload?: unknown): void {
    this.events.push({ event, payload: payload ?? null });
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  async close(): Promise<void> {
    // Nothing to release in the fake.
  }

  get stats(): TelemetryRecorderStats {
    return {
      recorded: this.ticks.length + this.events.length,
      dropped: 0,
      skipped: 0,
      flushedBatches: 0,
      flushedRecords: 0,
      failedBatches: 0,
    };
  }
}

describe('buildRunTelemetryState — actionIntensity (AH-0MUZQEDW9002KHRN, AC3)', () => {
  it('defaults actionIntensity to null until the tick is recorded', () => {
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    expect(state.actionIntensity).toBeNull();
  });
});

describe('actionIntensityCountsFromState (AH-0MUZQEDW9002KHRN, AC3)', () => {
  it('derives counts from the state registries, splitting asteroids out', () => {
    const state = buildRunTelemetryState(
      {
        ...SNAPSHOT,
        enemies: [
          { x: 1, y: 2, alive: true, archetype: 'scout' },
          { x: 3, y: 4, alive: true, archetype: 'asteroid' },
          { x: 5, y: 6, alive: false, archetype: 'asteroid' },
        ],
      },
      EXTRAS,
    );

    expect(actionIntensityCountsFromState(state)).toEqual({
      playerBullets: 1,
      enemyBullets: 1,
      enemies: 1,
      asteroids: 1,
      drops: 1,
      enemyExplosions: 0,
      bossExplosions: 0,
      playerExplosions: 0,
      bosses: 1,
    });
  });
});

describe('buildRunTelemetryState (AC1, AC6)', () => {
  it('versions the state, tags the run seed and reuses the snapshot collections', () => {
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    expect(state.v).toBe(RUN_TELEMETRY_STATE_VERSION);
    expect(state.runSeed).toBe(SNAPSHOT.runSeed);

    // Player position/velocity from the snapshot, heading + run state from
    // the extras (AC1).
    expect(state.player).toEqual({
      x: 10,
      y: 20,
      vx: 1.5,
      vy: -2.5,
      heading: 1.25,
      lives: 2,
      invulnerable: true,
    });

    // Hold + run-scoped levels (AC1: hold/levels).
    expect(state.hold).toEqual({ minerals: 3, capacity: 5 });
    expect(state.levels).toEqual({
      weapons: [{ id: 'spread', level: 2 }],
      powerUps: [{ id: 'shield', level: 1 }],
    });

    // Enemies/bullets/drops/minerals/boss/wave copied through (AC1).
    expect(state.enemies).toEqual([
      { x: 1, y: 2, alive: true, archetype: 'scout' },
      { x: 3, y: 4, alive: false, archetype: 'diver' },
    ]);
    expect(state.enemyBullets).toEqual([{ x: 5, y: 6, vx: 7, vy: 8 }]);
    expect(state.drops).toEqual([{ x: 9, y: 9, type: 'shield' }]);
    expect(state.minerals).toEqual([{ x: 11, y: 11, type: 'mineral' }]);
    expect(state.boss).toEqual({ x: 12, y: 12, alive: true, phase: 3 });
    expect(state.aliveCount).toBe(1);
    expect(state.wave).toEqual({ active: true, timeRemaining: 30, timeLimit: 45 });
  });

  it('is JSON-serialisable and never mutates the source snapshot', () => {
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);
    expect(() => JSON.stringify(state)).not.toThrow();
    // The extras list is copied, not aliased.
    expect(state.levels.weapons).not.toBe(EXTRAS.weaponLevels);
    expect(state.enemies).not.toBe(SNAPSHOT.enemies);
  });

  it('records a null player/boss and a null wave when absent', () => {
    const state = buildRunTelemetryState(
      { ...SNAPSHOT, player: null, boss: null, wave: null },
      EXTRAS,
    );
    expect(state.player).toBeNull();
    expect(state.boss).toBeNull();
    expect(state.wave).toBeNull();
  });
});

describe('serialiseTelemetryInput (AC2)', () => {
  it('tags the asteroid scheme and copies its keys', () => {
    expect(
      serialiseTelemetryInput({ forward: true, turnLeft: false, turnRight: true }),
    ).toEqual({
      scheme: 'asteroids',
      forward: true,
      turnLeft: false,
      turnRight: true,
    });
  });

  it('tags the four-directional scheme and copies its keys', () => {
    expect(
      serialiseTelemetryInput({ up: true, down: false, left: true, right: false }),
    ).toEqual({
      scheme: 'fourDirectional',
      up: true,
      down: false,
      left: true,
      right: false,
    });
  });

  it('maps a missing input to JSON null', () => {
    expect(serialiseTelemetryInput(null)).toBeNull();
  });
});

describe('RunTelemetry (AC3, AC6)', () => {
  it('is a strict no-op while disabled (AC5)', async () => {
    const recorder = new FakeRecorder(false);
    const telemetry = new RunTelemetry(recorder);

    expect(telemetry.enabled).toBe(false);
    telemetry.startRun(42);
    telemetry.recordTick(buildRunTelemetryState(SNAPSHOT, EXTRAS), null);
    telemetry.playerHit(1);
    telemetry.runEnd(false, 0);
    await telemetry.flush();

    expect(recorder.header).toBeNull();
    expect(recorder.ticks).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
    expect(recorder.flushCount).toBe(0);
  });

  it('writes the run header and a versioned run_start event', () => {
    const recorder = new FakeRecorder();
    new RunTelemetry(recorder).startRun(1234, { appVersion: '9.9.9' });

    expect(recorder.header).toEqual({ runSeed: 1234, build: { appVersion: '9.9.9' } });
    expect(recorder.events[0]).toEqual({
      event: 'run_start',
      payload: { v: RUN_TELEMETRY_EVENT_VERSION, seed: 1234 },
    });
  });

  it('forwards a tick state + serialised input', () => {
    const recorder = new FakeRecorder();
    const telemetry = new RunTelemetry(recorder, { now: () => 0 });
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    telemetry.recordTick(state, serialiseTelemetryInput(null));

    expect(recorder.ticks).toHaveLength(1);
    expect(recorder.ticks[0].input).toBeNull();
    const recorded = recorder.ticks[0].state as RunTelemetryState;
    // Everything except the instrumentation-owned actionIntensity is forwarded.
    expect({ ...recorded, actionIntensity: null }).toEqual(state);
  });

  it('folds a computed actionIntensity sample into the recorded tick', () => {
    const recorder = new FakeRecorder();
    const telemetry = new RunTelemetry(recorder, { now: () => 0 });
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    telemetry.recordTick(state, serialiseTelemetryInput(null));

    expect(recorder.ticks).toHaveLength(1);
    const recorded = recorder.ticks[0].state as RunTelemetryState;
    expect(recorded.actionIntensity).toEqual(
      computeActionIntensity(
        { counts: actionIntensityCountsFromState(state), eventScore: 0 },
        DEFAULT_ACTION_INTENSITY_CONFIG,
      ),
    );
    // The state handed in is not mutated.
    expect(state.actionIntensity).toBeNull();
  });

  it('includes observed discrete events in the burst window (AC4)', () => {
    const recorder = new FakeRecorder();
    const telemetry = new RunTelemetry(recorder, { now: () => 0 });
    telemetry.enemyKilled('scout', 1, 2);
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    telemetry.recordTick(state, serialiseTelemetryInput(null));

    const recorded = recorder.ticks[0].state as RunTelemetryState;
    expect(recorded.actionIntensity).toEqual(
      computeActionIntensity(
        {
          counts: actionIntensityCountsFromState(state),
          events: [{ type: 'enemy_killed', at: 0 }],
        },
        DEFAULT_ACTION_INTENSITY_CONFIG,
      ),
    );
  });

  it('reuses the sample within one sample interval', () => {
    const recorder = new FakeRecorder();
    let nowMs = 0;
    const telemetry = new RunTelemetry(recorder, { now: () => nowMs });
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    telemetry.startRun(1);
    telemetry.recordTick(state, null);
    nowMs = 50; // below the 100 ms interval at the default 10 Hz
    telemetry.recordTick(state, null);

    const first = (recorder.ticks[0].state as RunTelemetryState).actionIntensity;
    const second = (recorder.ticks[1].state as RunTelemetryState).actionIntensity;
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('records nothing while disabled (strict no-op)', () => {
    const recorder = new FakeRecorder(false);
    const telemetry = new RunTelemetry(recorder, { now: () => 0 });
    const state = buildRunTelemetryState(SNAPSHOT, EXTRAS);

    telemetry.enemyKilled('scout', 1, 2);
    telemetry.recordTick(state, serialiseTelemetryInput(null));

    expect(recorder.ticks).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });

  it('emits every discrete event with the concrete event version', () => {
    const recorder = new FakeRecorder();
    const telemetry = new RunTelemetry(recorder);

    telemetry.playerHit(2);
    telemetry.playerHitAbsorbed();
    telemetry.playerDeath();
    telemetry.enemyKilled('scout', 1, 2);
    telemetry.pickup('powerUp', 'shield');
    telemetry.pickup('weapon', 'spread');
    telemetry.mineralCollected(3);
    telemetry.holdFull(['shield', 'bomb', 'rapid']);
    telemetry.choiceSelected(1, 'bomb');
    telemetry.waveStart(1, 1, 2);
    telemetry.waveCleared(1, 1);
    telemetry.levelCleared(1);
    telemetry.bossTriggered();
    telemetry.bossSpawn();
    telemetry.bossPhase(2);
    telemetry.bossDefeated();
    telemetry.runEnd(true, 5000);

    const byEvent = new Map<string, unknown>();
    for (const entry of recorder.events) {
      if (!byEvent.has(entry.event)) byEvent.set(entry.event, entry.payload);
    }
    // Every emitted event name is part of the declared closed set.
    for (const { event } of recorder.events) {
      expect(RUN_TELEMETRY_EVENTS).toContain(event);
    }
    // Every payload carries the concrete event version.
    for (const { payload } of recorder.events) {
      expect((payload as TelemetryJson & { v: number }).v).toBe(
        RUN_TELEMETRY_EVENT_VERSION,
      );
    }
    expect(byEvent.get('player_hit')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      lives: 2,
    });
    expect(byEvent.get('enemy_killed')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      archetype: 'scout',
      x: 1,
      y: 2,
    });
    expect(byEvent.get('pickup')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      kind: 'powerUp',
      id: 'shield',
    });
    expect(byEvent.get('hold_full')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      options: ['shield', 'bomb', 'rapid'],
    });
    expect(byEvent.get('choice_selected')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      index: 1,
      id: 'bomb',
    });
    expect(byEvent.get('wave_start')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      level: 1,
      waveNumber: 1,
      waveCount: 2,
    });
    expect(byEvent.get('boss_phase')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      phase: 2,
    });
    expect(byEvent.get('run_end')).toEqual({
      v: RUN_TELEMETRY_EVENT_VERSION,
      won: true,
      score: 5000,
    });
  });

  it('exposes the framework schema version independently of the payload version', () => {
    // The framework owns the envelope version; the instrumentation owns the
    // payload version. Keep both explicit so a bump in either is intentional.
    expect(TELEMETRY_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(RUN_TELEMETRY_STATE_VERSION).toBeGreaterThanOrEqual(1);
    expect(RUN_TELEMETRY_EVENT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

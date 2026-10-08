/**
 * Hermetic tests for the dev recording library
 * (AH-0MUY08W7Y004GATZ, AC3 + AC5).
 *
 * The pure core: tolerant JSONL parsing into runs, the deterministic replay
 * stepper, the same-seed human-vs-bot ghost overlay and the SVG renderer. No
 * browser, no game instance.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  RECORDING_DATASET_VERSION,
  buildGhostOverlay,
  createRecordingStepper,
  inputChannels,
  inputSignature,
  isSupportedRecordingRecord,
  parseRecording,
  renderGhostSvg,
  tickPosition,
} from './recording.mjs';
import type { RecordingRun } from './recording.mjs';

/** Builds a `run_header` JSONL line. */
function header(runSeed: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'run_header',
    schemaVersion: 1,
    runSeed,
    build: { appVersion: '0.1.10', commit: 'abc1234' },
    startedAt: 1_700_000_000_000,
    ...extra,
  });
}

/** Builds a `tick` JSONL line with a minimal player state. */
function tickLine(tick: number, x: number, y: number, input: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: 'tick',
    schemaVersion: 1,
    tick,
    state: {
      v: 1,
      runSeed: 42,
      player: { x, y, vx: 1, vy: 0, heading: 0, lives: 3, invulnerable: false },
      hold: { minerals: 0, capacity: 5 },
      levels: { weapons: [], powerUps: [] },
      enemies: [],
      enemyBullets: [],
      drops: [],
      minerals: [],
      boss: null,
      aliveCount: 0,
      wave: null,
      ...extra,
    },
    input,
  });
}

/** Builds an `event` JSONL line. */
function eventLine(tick: number, event: string, payload: unknown = null): string {
  return JSON.stringify({ kind: 'event', schemaVersion: 1, tick, event, payload });
}

const RIGHT = { scheme: 'fourDirectional', up: false, down: false, left: false, right: true };
const LEFT = { scheme: 'fourDirectional', up: false, down: false, left: true, right: false };
const IDLE = { scheme: 'fourDirectional', up: false, down: false, left: false, right: false };

/** Builds one run's ticks from an input sequence. */
function runFromInputs(seed: number, inputs: unknown[], positions?: { x: number; y: number }[]): RecordingRun {
  const ticks = inputs.map((input, index) => ({
    tick: index,
    state: {
      v: 1,
      runSeed: seed,
      player: {
        x: positions?.[index]?.x ?? index,
        y: positions?.[index]?.y ?? 0,
        vx: 1,
        vy: 0,
        heading: 0,
        lives: 3,
        invulnerable: false,
      },
      hold: { minerals: 0, capacity: 5 },
      levels: { weapons: [], powerUps: [] },
      enemies: [],
      enemyBullets: [],
      drops: [],
      minerals: [],
      boss: null,
      aliveCount: 0,
      wave: null,
    },
    input,
  }));
  return {
    index: 0,
    runSeed: seed,
    build: { appVersion: 'test', commit: 'test' },
    startedAt: null,
    ticks,
    events: [],
  };
}

describe('parseRecording', () => {
  it('groups records into runs, sorted by tick, and reports schema versions', () => {
    const text = [
      header(42),
      tickLine(1, 1, 0, RIGHT),
      tickLine(0, 0, 0, IDLE),
      eventLine(1, 'enemy_killed', { x: 10, y: 0 }),
      '',
    ].join('\n');

    const result = parseRecording(text);

    expect(result.datasetVersion).toBe(RECORDING_DATASET_VERSION);
    expect(result.schemaVersions).toEqual([1]);
    expect(result.recordCount).toBe(4);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].runSeed).toBe(42);
    expect(result.runs[0].build).toEqual({ appVersion: '0.1.10', commit: 'abc1234' });
    expect(result.runs[0].ticks.map((entry) => entry.tick)).toEqual([0, 1]);
    expect(result.runs[0].events).toHaveLength(1);
  });

  it('starts a new run at each run_header', () => {
    const text = [header(1), tickLine(0, 0, 0, IDLE), header(2), tickLine(0, 0, 0, IDLE)].join('\n');
    const result = parseRecording(text);
    expect(result.runs.map((run) => run.runSeed)).toEqual([1, 2]);
  });

  it('skips blank and corrupt lines, and counts unsupported schema versions', () => {
    const text = [
      header(1),
      '',
      'not json',
      JSON.stringify({ kind: 'tick', schemaVersion: 99, tick: 0, state: {}, input: null }),
      tickLine(0, 0, 0, IDLE),
    ].join('\n');
    const result = parseRecording(text);
    expect(result.skippedLines).toBe(1);
    expect(result.unsupportedLines).toBe(1);
    expect(result.runs[0].ticks).toHaveLength(1);
  });

  it('counts records before the first run_header as unattributed', () => {
    const text = [tickLine(0, 0, 0, IDLE), header(1), tickLine(0, 0, 0, IDLE)].join('\n');
    const result = parseRecording(text);
    expect(result.unattributedLines).toBe(1);
    expect(result.runs[0].ticks).toHaveLength(1);
  });

  it('guards supported records by schema version and kind', () => {
    expect(isSupportedRecordingRecord({ kind: 'tick', schemaVersion: 1 })).toBe(true);
    expect(isSupportedRecordingRecord({ kind: 'tick', schemaVersion: 2 })).toBe(false);
    expect(isSupportedRecordingRecord({ kind: 'nope', schemaVersion: 1 })).toBe(false);
    expect(isSupportedRecordingRecord(null)).toBe(false);
  });
});

describe('input model', () => {
  it('normalises both control schemes', () => {
    expect(inputChannels({ scheme: 'asteroids', forward: true, turnLeft: false, turnRight: true })).toEqual({
      scheme: 'asteroids',
      channels: { forward: true, turnLeft: false, turnRight: true },
    });
    expect(inputChannels(RIGHT)).toEqual({
      scheme: 'fourDirectional',
      channels: { up: false, down: false, left: false, right: true },
    });
    expect(inputChannels(null)).toEqual({ scheme: null, channels: {} });
  });

  it('produces distinct signatures and equal signatures for equal inputs', () => {
    expect(inputSignature(RIGHT)).not.toBe(inputSignature(LEFT));
    expect(inputSignature(RIGHT)).toBe(inputSignature({ scheme: 'fourDirectional', right: true }));
    expect(inputSignature(null)).toBe('none');
  });

  it('reads a player position or null', () => {
    expect(tickPosition({ player: { x: 3, y: 4 } })).toEqual({ x: 3, y: 4 });
    expect(tickPosition({ player: null })).toBeNull();
    expect(tickPosition(null)).toBeNull();
  });
});

describe('createRecordingStepper', () => {
  const run = runFromInputs(7, [IDLE, RIGHT, RIGHT, LEFT]);

  it('starts before the first frame and emits frames in order', () => {
    const stepper = createRecordingStepper(run, { dtSeconds: 0.5 });
    expect(stepper.total).toBe(4);
    expect(stepper.current()).toBeNull();

    const first = stepper.step();
    expect(first?.tick).toBe(0);
    expect(first?.elapsedSeconds).toBe(0);
    expect(stepper.index).toBe(0);

    stepper.step();
    stepper.step();
    const fourth = stepper.step();
    expect(fourth?.tick).toBe(3);
    expect(fourth?.elapsedSeconds).toBe(1.5);
    expect(stepper.done).toBe(true);
    expect(stepper.step()).toBeNull();
  });

  it('seeks to the latest frame at or before a tick and resets', () => {
    const stepper = createRecordingStepper(run, { dtSeconds: 0.5 });
    expect(stepper.seek(2)?.tick).toBe(2);
    expect(stepper.seek(100)?.tick).toBe(3);
    stepper.reset();
    expect(stepper.index).toBe(-1);
    expect(stepper.current()).toBeNull();
  });

  it('lists all frames without moving the cursor, deterministically', () => {
    const stepper = createRecordingStepper(run, { dtSeconds: 0.5 });
    const frames = stepper.frames();
    expect(frames.map((frame) => frame.tick)).toEqual([0, 1, 2, 3]);
    expect(stepper.index).toBe(-1);
  });
});

describe('buildGhostOverlay', () => {
  const human = runFromInputs(42, [RIGHT, RIGHT, LEFT, IDLE], [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ]);
  const bot = runFromInputs(42, [RIGHT, LEFT, LEFT, IDLE], [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: 20 },
    { x: 0, y: 30 },
  ]);

  it('pairs input and position per tick and reports agreement stats', () => {
    const overlay = buildGhostOverlay(human, bot);
    expect(overlay.runSeed).toBe(42);
    expect(overlay.frames).toHaveLength(4);
    expect(overlay.stats.inputMatchCount).toBe(3); // ticks 0, 2 and 3
    expect(overlay.stats.inputMatchRate).toBeCloseTo(0.75);
    expect(overlay.frames[0].inputMatch).toBe(true);
    expect(overlay.frames[1].inputMatch).toBe(false);
    expect(overlay.frames[0].positionDelta).toBe(0);
    expect(overlay.frames[1].positionDelta).toBeCloseTo(Math.hypot(10, 10));
    expect(overlay.stats.maxPositionDelta).toBeCloseTo(Math.hypot(30, 30));
  });

  it('aligns by tick number over the intersection of the runs', () => {
    const short = runFromInputs(42, [RIGHT, RIGHT]);
    const overlay = buildGhostOverlay(human, short);
    expect(overlay.frames.map((frame) => frame.tick)).toEqual([0, 1]);
  });

  it('rejects runs recorded on different seeds', () => {
    const other = runFromInputs(43, [RIGHT]);
    expect(() => buildGhostOverlay(human, other)).toThrow(/same seed/i);
  });
});

describe('renderGhostSvg', () => {
  it('renders deterministic polylines for both trajectories', () => {
    const human = runFromInputs(1, [RIGHT, RIGHT], [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ]);
    const bot = runFromInputs(1, [LEFT, LEFT], [
      { x: 0, y: 0 },
      { x: 50, y: 100 },
    ]);
    const svg = renderGhostSvg(buildGhostOverlay(human, bot), { width: 100, height: 100, padding: 0 });
    expect(svg).toContain('<svg');
    expect(svg.match(/<polyline/g)).toHaveLength(2);
    expect(svg).toContain('points="0.00,0.00 100.00,50.00"');
    expect(svg).toContain('points="0.00,0.00 50.00,100.00"');
    expect(renderGhostSvg(buildGhostOverlay(human, bot), { width: 100, height: 100, padding: 0 })).toBe(svg);
  });

  it('escapes an XML-hostile title', () => {
    const run = runFromInputs(1, [RIGHT]);
    const svg = renderGhostSvg(buildGhostOverlay(run, run), { title: 'a <b> & "c"' });
    expect(svg).toContain('a &lt;b&gt; &amp; &quot;c&quot;');
  });
});

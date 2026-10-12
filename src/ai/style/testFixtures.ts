/**
 * Shared hermetic test fixtures for the style-matching suite
 * (AH-0MUY08XXN003NV0I).
 *
 * Small synthetic telemetry runs with known geometry so every extracted
 * style feature has an exact expected value. Not a test file itself.
 *
 * @module src/ai/style/testFixtures
 */

import type {
  RecordingEvent,
  RecordingRun,
  RecordingTick,
} from '../../../scripts/recording.mjs';

/** Four-directional input helpers. */
export const FI = {
  idle: { scheme: 'fourDirectional', up: false, down: false, left: false, right: false },
  left: { scheme: 'fourDirectional', up: false, down: false, left: true, right: false },
  right: { scheme: 'fourDirectional', up: false, down: false, left: false, right: true },
} as const;

/** A minimal recorded state with overrides (mirrors the analyser tests). */
export function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    runSeed: 5,
    player: { x: 0, y: 0, vx: 1, vy: 0, facing: 0, lives: 3 },
    hold: { minerals: 0, capacity: 5 },
    enemies: [],
    enemyBullets: [],
    playerBullets: [],
    drops: [],
    minerals: [],
    boss: null,
    aliveCount: 0,
    wave: null,
    ...overrides,
  };
}

/** Builds a tick with `input` and optional state overrides. */
export function makeTick(
  tick: number,
  input: unknown,
  overrides: Record<string, unknown> = {},
): RecordingTick {
  return { tick, input, state: makeState(overrides) };
}

/** Wraps ticks and events into a recording run. */
export function makeRun(
  ticks: RecordingTick[],
  events: RecordingEvent[] = [],
  seed = 5,
): RecordingRun {
  return {
    index: 0,
    runSeed: seed,
    build: { appVersion: 'test', commit: 'test' },
    startedAt: null,
    ticks,
    events,
  };
}

/** A `{ x, y }` bullet point. */
export function point(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

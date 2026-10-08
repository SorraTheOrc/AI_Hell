/**
 * Hermetic tests for the recording analyser
 * (AH-0MUY08W7Y004GATZ, AC2 + AC5).
 *
 * The pure statistics are exercised over small synthetic runs with known
 * inputs, events and targets, so every metric has an exact expected value.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';

import {
  analyseRecording,
  formatAnalysis,
} from './recording-analysis.mjs';
import type { RecordingEvent, RecordingRun, RecordingTick } from './recording.mjs';

const RIGHT = { scheme: 'fourDirectional', up: false, down: false, left: false, right: true };
const LEFT = { scheme: 'fourDirectional', up: false, down: false, left: true, right: false };
const IDLE = { scheme: 'fourDirectional', up: false, down: false, left: false, right: false };

/** A minimal recorded state with overrides. */
function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    runSeed: 5,
    player: { x: 0, y: 0, vx: 1, vy: 0, heading: 0, lives: 3, invulnerable: false },
    hold: { minerals: 0, capacity: 5 },
    levels: { weapons: [], powerUps: [] },
    enemies: [],
    enemyBullets: [],
    drops: [],
    minerals: [],
    boss: null,
    aliveCount: 0,
    wave: null,
    ...overrides,
  };
}

/** Builds a tick at `tick` with `input` and optional state overrides. */
function tick(tick: number, input: unknown, overrides: Record<string, unknown> = {}): RecordingTick {
  return { tick, input, state: state(overrides) };
}

/** Wraps ticks and events into a run. */
function run(ticks: RecordingTick[], events: RecordingEvent[] = []): RecordingRun {
  return {
    index: 0,
    runSeed: 5,
    build: { appVersion: 'test', commit: 'test' },
    startedAt: null,
    ticks,
    events,
  };
}

describe('analyseRecording — key holds', () => {
  it('measures contiguous hold durations per channel and buckets them', () => {
    const inputs = [
      ...Array.from({ length: 12 }, () => RIGHT),
      IDLE,
      ...Array.from({ length: 4 }, () => RIGHT),
    ];
    const report = analyseRecording(run(inputs.map((input, i) => tick(i, input))), {
      dtSeconds: 1 / 60,
    });

    const channel = report.keyHolds.byChannel['fourDirectional:right'];
    expect(channel.count).toBe(2);
    expect(channel.maxSeconds).toBeCloseTo(0.2);
    expect(channel.histogram.find((bucket) => bucket.label === '0.1–0.25 s')?.count).toBe(1);
    expect(channel.histogram.find((bucket) => bucket.label === '<0.1 s')?.count).toBe(1);
    expect(report.keyHolds.overall.count).toBe(2);
  });
});

describe('analyseRecording — input cadence', () => {
  it('counts signature changes and buckets the gaps between them', () => {
    const inputs = [IDLE, ...Array.from({ length: 5 }, () => RIGHT), LEFT, IDLE];
    const report = analyseRecording(run(inputs.map((input, i) => tick(i, input))), {
      dtSeconds: 1 / 60,
    });

    expect(report.inputCadence.changes).toBe(3);
    expect(report.inputCadence.meanGapSeconds).toBeCloseTo((1 + 5 + 1) / 3 / 60);
    expect(report.inputCadence.histogram.find((bucket) => bucket.label === '<0.05 s')?.count).toBe(2);
  });
});

describe('analyseRecording — reaction latency proxy', () => {
  it('measures the delay from threat onset to the next input change', () => {
    const bullet = { x: 0, y: 0 };
    const ticks = [
      tick(0, IDLE),
      tick(1, IDLE, { enemyBullets: [bullet] }),
      tick(2, IDLE, { enemyBullets: [bullet] }),
      tick(3, RIGHT, { enemyBullets: [bullet] }),
      tick(4, RIGHT),
      // Second threat window with no input reaction.
      tick(5, RIGHT, { enemyBullets: [bullet] }),
      tick(6, RIGHT, { enemyBullets: [bullet] }),
      tick(7, RIGHT),
    ];
    const report = analyseRecording(run(ticks), { dtSeconds: 1 / 60, threatRadiusPx: 50 });

    expect(report.reactionLatency.windows).toBe(2);
    expect(report.reactionLatency.samples).toBe(1);
    expect(report.reactionLatency.noReactionCount).toBe(1);
    expect(report.reactionLatency.meanSeconds).toBeCloseTo(2 / 60);
  });
});

describe('analyseRecording — target choice', () => {
  it('classifies the target category most aligned with the player velocity', () => {
    const ticks = [
      tick(0, RIGHT, { minerals: [{ x: 10, y: 0 }] }),
      tick(1, RIGHT, { drops: [{ x: 10, y: 0 }] }),
      tick(2, RIGHT, { enemies: [{ x: 10, y: 0, alive: true, archetype: 'scout' }] }),
      tick(3, RIGHT),
    ];
    const report = analyseRecording(run(ticks), { dtSeconds: 1 / 60 });

    expect(report.targetChoice.counts.mineral).toBe(1);
    expect(report.targetChoice.counts.powerUp).toBe(1);
    expect(report.targetChoice.counts.enemy).toBe(1);
    expect(report.targetChoice.counts.none).toBe(1);
  });
});

describe('analyseRecording — engagement distances', () => {
  it('measures kill, mineral and pickup distances at the recorded tick', () => {
    const ticks = [
      tick(0, RIGHT, {
        minerals: [{ x: 0, y: 50, type: 'mineral' }],
        drops: [{ x: 0, y: 25, type: 'shield' }],
      }),
    ];
    const events: RecordingEvent[] = [
      { tick: 0, event: 'enemy_killed', payload: { archetype: 'scout', x: 0, y: 100 } },
      { tick: 0, event: 'mineral_collected', payload: { total: 1 } },
      { tick: 0, event: 'pickup', payload: { kind: 'powerUp', id: 'shield' } },
    ];
    const report = analyseRecording(run(ticks, events), { dtSeconds: 1 / 60 });

    expect(report.engagementDistances.enemy.count).toBe(1);
    expect(report.engagementDistances.enemy.mean).toBeCloseTo(100);
    expect(report.engagementDistances.mineral.mean).toBeCloseTo(50);
    expect(report.engagementDistances.powerUp.mean).toBeCloseTo(25);
  });
});

describe('analyseRecording — dodge outcomes', () => {
  it('rates threat windows by whether a hit was recorded during them', () => {
    const bullet = { x: 0, y: 0 };
    const ticks = [
      tick(0, IDLE, { enemyBullets: [bullet] }),
      tick(1, IDLE, { enemyBullets: [bullet] }),
      tick(2, IDLE),
      tick(3, IDLE, { enemyBullets: [bullet] }),
      tick(4, IDLE, { enemyBullets: [bullet] }),
      tick(5, IDLE),
    ];
    const events: RecordingEvent[] = [{ tick: 1, event: 'player_hit', payload: { lives: 2 } }];
    const report = analyseRecording(run(ticks, events), { dtSeconds: 1 / 60, threatRadiusPx: 50 });

    expect(report.dodge.windows).toBe(2);
    expect(report.dodge.hit).toBe(1);
    expect(report.dodge.dodged).toBe(1);
    expect(report.dodge.dodgeRate).toBeCloseTo(0.5);
  });
});

describe('analyseRecording — summary', () => {
  it('reports duration, survival, minerals-per-minute and events', () => {
    const ticks = Array.from({ length: 11 }, (_, i) =>
      tick(i, IDLE, { hold: { minerals: i === 10 ? 5 : 0, capacity: 5 } }),
    );
    const events: RecordingEvent[] = [{ tick: 10, event: 'run_end', payload: { won: true, score: 100 } }];
    const report = analyseRecording(run(ticks, events), { dtSeconds: 1 / 60 });

    expect(report.summary.ticks).toBe(11);
    expect(report.summary.durationSeconds).toBeCloseTo(11 / 60);
    expect(report.summary.survived).toBe(true);
    expect(report.summary.won).toBe(true);
    expect(report.summary.score).toBe(100);
    expect(report.summary.minerals).toBe(5);
    expect(report.summary.mineralsPerMinute).toBeCloseTo(5 / (11 / 3600));
    expect(report.summary.eventCounts.run_end).toBe(1);
  });
});

describe('formatAnalysis', () => {
  it('renders a readable report with the key sections', () => {
    const report = analyseRecording(run([tick(0, RIGHT)]), { dtSeconds: 1 / 60 });
    const text = formatAnalysis(report);
    expect(text).toContain('Recording analysis');
    expect(text).toContain('Key-hold duration histogram');
    expect(text).toContain('Input-change cadence');
    expect(text).toContain('Reaction latency proxy');
    expect(text).toContain('Dodge outcomes');
    expect(text).toContain('Minerals:');
  });
});

describe('analyseRecording — empty run', () => {
  it('returns zeroed metrics rather than throwing', () => {
    const report = analyseRecording(run([]), { dtSeconds: 1 / 60 });
    expect(report.summary.ticks).toBe(0);
    expect(report.summary.durationSeconds).toBe(0);
    expect(report.keyHolds.overall.count).toBe(0);
    expect(report.inputCadence.changes).toBe(0);
    expect(report.dodge.dodgeRate).toBe(0);
  });
});

/**
 * Hold-full overlay metronome scheduler tests
 * (AH-0MV55O9R5005W6J0 · AC1/AC2/AC3).
 *
 * The reduced-volume metronomic fire during the hold-full choice overlay is a
 * **pure, deterministic scheduler**: given the frozen game-time at overlay
 * open, each active weapon's grid interval and the elapsed overlay time, it
 * emits on-grid cue ticks with no projectiles and no gameplay simulation.
 *
 * These tests drive the scheduler with a fake clock (exact millisecond
 * advances — never the wall clock) and a fake player schedule, and assert:
 * - AC1 — per-weapon cadence at the exact beat-grid interval;
 * - AC2 — only the supplied active weapons emit (no enemy/other cues);
 * - AC3 — phase-lock: the first ghost tick lands on the beat tick the next
 *   real shot would have used (`nextTick(startMs, interval)`) and every
 *   emitted tick is a member of the weapon's grid per `src/utils/beat.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BPM,
  nextTick,
  isOnGrid,
} from '../../utils/beat';
import { HOLD_FULL_FIRE_VOLUME_SCALE } from '../../core/rules';
import {
  buildHoldFullFireSchedule,
  createHoldFullFireMetronome,
  type HoldFullFireSchedule,
  type HoldFullFirePlayerSource,
} from './holdFullFire';

/** The canonical 80 BPM beat period (375 ms for 2 shots/beat). */
const CANNON_INTERVAL_MS = 60000 / DEFAULT_BPM / 2; // 375
const RAPID_INTERVAL_MS = 60000 / DEFAULT_BPM / 6; // 125

/** Builds a schedule at the canonical grid origin with cannon + rapid. */
function cannonAndRapidSchedule(overrides: Partial<HoldFullFireSchedule> = {}): HoldFullFireSchedule {
  return {
    anchorMs: 0,
    bpm: DEFAULT_BPM,
    startMs: 0,
    weapons: [
      { weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS },
      { weaponId: 'rapid', intervalMs: RAPID_INTERVAL_MS },
    ],
    ...overrides,
  };
}

/** A fake player: deterministic active weapons + intervals (no Phaser). */
function fakePlayer(
  weapons: Array<{ weaponId: string; intervalMs: number }>,
  now = 0,
): HoldFullFirePlayerSource {
  return {
    getActiveWeapons: () => weapons.map((w) => w.weaponId),
    getFireInterval: (id: string) =>
      weapons.find((w) => w.weaponId === id)?.intervalMs ?? 0,
    getBeatClock: () => ({
      now: () => now,
      anchorMs: 0,
      bpm: DEFAULT_BPM,
    }),
  } as unknown as HoldFullFirePlayerSource;
}

describe('createHoldFullFireMetronome', () => {
  it('AC1 — cannon cues on its exact 2-shots-per-beat cadence from a frozen clock at 0', () => {
    const metronome = createHoldFullFireMetronome({
      anchorMs: 0,
      bpm: DEFAULT_BPM,
      startMs: 0,
      weapons: [{ weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS }],
    });
    // Nothing due before the first tick.
    expect(metronome.advance(CANNON_INTERVAL_MS - 1)).toEqual([]);
    // The first shot of the beat lands exactly on the first grid tick.
    expect(metronome.advance(1)).toEqual(['cannon']);
    // Every following cannon shot is one interval later.
    expect(metronome.advance(CANNON_INTERVAL_MS)).toEqual(['cannon']);
    expect(metronome.advance(CANNON_INTERVAL_MS)).toEqual(['cannon']);
  });

  it('AC1 — rapid cues six times per beat (125 ms at 80 BPM)', () => {
    const metronome = createHoldFullFireMetronome(
      cannonAndRapidSchedule(),
    );
    // 5 rapid ticks then the cannon + 6th rapid tick on the beat boundary.
    let rapid = 0;
    let cannon = 0;
    for (let dt = 0; dt < 6 * RAPID_INTERVAL_MS; dt += 1) {
      for (const weaponId of metronome.advance(1)) {
        if (weaponId === 'rapid') rapid += 1;
        if (weaponId === 'cannon') cannon += 1;
      }
    }
    expect(rapid).toBe(6);
    expect(cannon).toBe(2);
  });

  it('AC3 — phase-lock: the first ghost tick lands on the beat tick the next real shot would have used (mid-beat freeze)', () => {
    // Freeze the game mid-beat at 6002 ms (off the 375 ms cannon grid). The
    // next real cannon shot would land on nextTick(6002, 375) = 6375 ms.
    const startMs = 6002;
    const metronome = createHoldFullFireMetronome(
      cannonAndRapidSchedule({ startMs }),
    );
    // Advance until the first ghost tick fires.
    let firedAt: number | null = null;
    let elapsed = 0;
    for (let i = 0; i < 1000 && firedAt === null; i += 1) {
      elapsed += 1;
      if (metronome.advance(1).includes('cannon')) firedAt = elapsed;
    }
    const expectedFirstTick = nextTick(startMs, CANNON_INTERVAL_MS, 0);
    // The first ghost tick is exactly the beat tick the next real shot
    // would have used, with no phase jump from the frozen clock.
    expect(expectedFirstTick).toBe(6375);
    expect(firedAt).toBe(expectedFirstTick - startMs);
    expect(metronome.nextTickMs('cannon')).toBe(
      expectedFirstTick + CANNON_INTERVAL_MS,
    );
  });

  it('AC3 — every emitted cannon tick lies on the beat grid', () => {
    const metronome = createHoldFullFireMetronome(
      cannonAndRapidSchedule({ startMs: 1234 }),
    );
    const fired: number[] = [];
    let elapsed = 0;
    for (let i = 0; i < 4000; i += 1) {
      elapsed += 1;
      if (metronome.advance(1).includes('cannon')) {
        const tick = metronome.lastTickMs('cannon');
        if (tick !== undefined) fired.push(tick);
      }
    }
    expect(fired.length).toBeGreaterThan(0);
    for (const tick of fired) {
      expect(
        isOnGrid(tick, CANNON_INTERVAL_MS, 0),
        `${tick} ms should be a cannon grid tick`,
      ).toBe(true);
    }
    // First tick is exactly the grid tick the next real shot would use.
    expect(fired[0]).toBe(nextTick(1234, CANNON_INTERVAL_MS, 0));
  });

  it('AC2 — only the supplied active weapons emit (cannon alone → no rapid)', () => {
    const metronome = createHoldFullFireMetronome({
      anchorMs: 0,
      bpm: DEFAULT_BPM,
      startMs: 0,
      weapons: [{ weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS }],
    });
    let sawRapid = false;
    for (let i = 0; i < 3000; i += 1) {
      for (const id of metronome.advance(1)) if (id === 'rapid') sawRapid = true;
    }
    expect(sawRapid).toBe(false);
    expect(metronome.nextTickMs('rapid')).toBeUndefined();
  });

  it('is a pure schedule — advances never spawn projectiles or run gameplay', () => {
    const metronome = createHoldFullFireMetronome(
      cannonAndRapidSchedule(),
    );
    metronome.advance(375);
    // The scheduler exposes only weapon ids and grid times.
    expect(metronome.nextTickMs('cannon')).toBe(750);
  });

  it('a non-positive advance is a no-op (time never runs backwards)', () => {
    const metronome = createHoldFullFireMetronome({
      anchorMs: 0,
      bpm: DEFAULT_BPM,
      startMs: 0,
      weapons: [{ weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS }],
    });
    expect(metronome.advance(0)).toEqual([]);
    expect(metronome.advance(-5)).toEqual([]);
    expect(metronome.elapsedMs()).toBe(0);
    expect(metronome.advance(CANNON_INTERVAL_MS)).toEqual(['cannon']);
  });

  it('empty active-weapon schedule emits nothing', () => {
    const metronome = createHoldFullFireMetronome({
      anchorMs: 0,
      bpm: DEFAULT_BPM,
      startMs: 0,
      weapons: [],
    });
    expect(metronome.advance(10000)).toEqual([]);
  });
});

describe('buildHoldFullFireSchedule', () => {
  it('maps the fake player active weapons + intervals + frozen clock onto a schedule', () => {
    const player = fakePlayer([
      { weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS },
      { weaponId: 'rapid', intervalMs: RAPID_INTERVAL_MS },
    ]);
    const schedule = buildHoldFullFireSchedule(player);
    expect(schedule).toEqual({
      anchorMs: 0,
      bpm: DEFAULT_BPM,
      startMs: 0,
      weapons: [
        { weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS },
        { weaponId: 'rapid', intervalMs: RAPID_INTERVAL_MS },
      ],
    });
  });

  it('propagates the countdown tempo (bpm) from the beat clock', () => {
    const player = fakePlayer(
      [{ weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS }],
      0,
    );
    const schedule = buildHoldFullFireSchedule(player);
    expect(schedule?.bpm).toBe(DEFAULT_BPM);
  });

  it('propagates the frozen beat-clock elapsed time (startMs)', () => {
    const player = fakePlayer(
      [{ weaponId: 'cannon', intervalMs: CANNON_INTERVAL_MS }],
      6000,
    );
    const schedule = buildHoldFullFireSchedule(player);
    expect(schedule?.startMs).toBe(6000);
  });

  it('HOLD_FULL_FIRE_VOLUME_SCALE is a single named 0.3 tunable', () => {
    expect(HOLD_FULL_FIRE_VOLUME_SCALE).toBe(0.3);
  });
});

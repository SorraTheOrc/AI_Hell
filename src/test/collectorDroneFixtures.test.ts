/**
 * Smoke tests for the shared collector-drone fixtures
 * (parent AH-0MV9G113S009B37I, leading task AH-0MVBMPYPB004RP0P).
 *
 * Every fixture exported by `collectorDroneFixtures.ts` is exercised here so
 * the test infrastructure is covered before the downstream drone items
 * (level variables, entity, lifecycle pass, spawn wiring, gym parity)
 * depend on it. The parent-AC → test matrix lives in the fixture file
 * header (see `collectorDroneFixtures.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { PowerUpState } from '../powerups/PowerUp';
import { collectOverlappingDrops } from '../scenes/core/dropLayer';
import { cueAssetUrl } from '../audio/cueManifest';
import {
  getAudioContext,
  playDiveSound,
  playPowerUpCollectSound,
  playPowerUpSpawnSound,
  stopDiveSound,
} from '../audio/effects';
import {
  COLLECTOR_DRONE_MINERAL_CLEARANCE,
  UFO_CUES,
  UFO_DESTRUCTION_CUE_SEQUENCE,
  UFO_PAYOUT_CUE_SEQUENCE,
  bootCollectorDroneScene,
  captureUfoLifecycleFeedback,
  createMysteryUfoDrop,
  createSeededMineralField,
  createSteppedClock,
  expectUfoDestructionLifecycle,
  expectUfoPayoutLifecycle,
  getDroneVfxCounts,
  installUfoCueRecorder,
  isClearOf,
  makeDropCollectible,
  recordDroneVfxSpawn,
  resetDroneVfxCounts,
  resolveSeededMineralPositions,
  type DroneVfxCounts,
  type SteppedClock,
  type UfoCueRecorder,
  type UfoFeedbackEventName,
  type UfoLifecycleFeedback,
  DEFAULT_MINERAL_FIELD_BOUNDS,
} from './collectorDroneFixtures';
import { PLAYER_SPAWN, MINERAL_SIZE } from '../core/constants';

describe('collectorDroneFixtures — shared collector-drone test infrastructure', () => {
  const games: Phaser.Game[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.destroy(true);
  });

  // ── Seeded mineral-field builder ──────────────────────────────────

  describe('resolveSeededMineralPositions', () => {
    it('is deterministic for a fixed seed', () => {
      const a = resolveSeededMineralPositions({ count: 8, seed: 7 });
      const b = resolveSeededMineralPositions({ count: 8, seed: 7 });
      expect(a).toEqual(b);
      expect(a).toHaveLength(8);
    });

    it('produces different fields for different seeds (seeded RNG)', () => {
      const a = resolveSeededMineralPositions({ count: 8, seed: 1 });
      const b = resolveSeededMineralPositions({ count: 8, seed: 2 });
      expect(a).not.toEqual(b);
    });

    it('places every mineral clear of the ship start by default', () => {
      const positions = resolveSeededMineralPositions({ count: 16, seed: 3 });
      for (const position of positions) {
        expect(isClearOf(position, PLAYER_SPAWN)).toBe(true);
        const distance = Math.hypot(
          position.x - PLAYER_SPAWN.x,
          position.y - PLAYER_SPAWN.y,
        );
        expect(distance).toBeGreaterThanOrEqual(
          COLLECTOR_DRONE_MINERAL_CLEARANCE,
        );
      }
    });

    it('honours an explicit clearance and clearOf point', () => {
      const clearOf = { x: 100, y: 100 };
      const positions = resolveSeededMineralPositions({
        count: 10,
        seed: 5,
        clearOf,
        clearance: 30,
      });
      for (const position of positions) {
        expect(Math.hypot(position.x - 100, position.y - 100)).toBeGreaterThanOrEqual(30);
      }
    });

    it('stays inside the default play-area bounds (HUD margin respected)', () => {
      const positions = resolveSeededMineralPositions({ count: 20, seed: 9 });
      for (const position of positions) {
        expect(position.x).toBeGreaterThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.minX);
        expect(position.x).toBeLessThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.maxX);
        expect(position.y).toBeGreaterThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.minY);
        expect(position.y).toBeLessThanOrEqual(DEFAULT_MINERAL_FIELD_BOUNDS.maxY);
      }
    });

    it('an empty count yields no positions', () => {
      expect(resolveSeededMineralPositions({ count: 0 })).toHaveLength(0);
    });
  });

  describe('createSeededMineralField', () => {
    it('creates live Mineral entities at the seeded positions', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const minerals = createSeededMineralField(scene, { count: 5, seed: 11 });
      const positions = resolveSeededMineralPositions({ count: 5, seed: 11 });

      expect(minerals).toHaveLength(5);
      for (let i = 0; i < minerals.length; i += 1) {
        expect(minerals[i].alive).toBe(true);
        expect(minerals[i].x).toBeCloseTo(positions[i].x, 5);
        expect(minerals[i].y).toBeCloseTo(positions[i].y, 5);
        // Not overlapping the ship start: outside the ship's pickup radius.
        const distance = Math.hypot(
          minerals[i].x - PLAYER_SPAWN.x,
          minerals[i].y - PLAYER_SPAWN.y,
        );
        expect(distance).toBeGreaterThan(MINERAL_SIZE + 10);
      }
    });
  });

  // ── Stepped / mock clock ──────────────────────────────────────────

  describe('createSteppedClock', () => {
    it('starts at zero and advances deterministically', () => {
      const clock = createSteppedClock();
      expect(clock.now()).toBe(0);
      expect(clock.advance(0.5)).toBe(0.5);
      expect(clock.now()).toBe(0.5);
    });

    it('step() advances one fixed frame at a time', () => {
      const clock = createSteppedClock(1 / 60);
      expect(clock.step()).toBeCloseTo(1 / 60, 5);
      expect(clock.now()).toBeCloseTo(1 / 60, 5);
      clock.step();
      expect(clock.now()).toBeCloseTo(2 / 60, 5);
    });

    it('run() ticks the callback once per fixed step until the elapsed time', () => {
      const clock = createSteppedClock(1 / 60);
      const ticks: number[] = [];
      const end = clock.run(30, (now) => ticks.push(now));
      // 30 s of 1/60 steps (default ceil) — the permanent-timer cadence.
      expect(ticks.length).toBe(1800);
      expect(ticks[0]).toBeCloseTo(1 / 60, 5);
      expect(end).toBeCloseTo(30, 5);
      expect(clock.now()).toBeCloseTo(30, 5);
    });

    it('reset() returns the clock to zero', () => {
      const clock = createSteppedClock();
      clock.advance(10);
      clock.reset();
      expect(clock.now()).toBe(0);
    });

    it('is a driven time source: explicit advances only (no wall clock)', () => {
      const clock: SteppedClock = createSteppedClock();
      expect(clock.now()).toBe(0); // nothing moves until advanced
    });
  });

  // ── Mystery UFO drop manufacture ──────────────────────────────────

  describe('createMysteryUfoDrop', () => {
    it('manufactures a mystery_ufo drop at the requested position', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const drop = createMysteryUfoDrop(scene, 200, 150);

      expect(drop.x).toBe(200);
      expect(drop.y).toBe(150);
      expect(drop.dropId).toBe('mystery_ufo');
      expect(drop.powerUp.id).toBe('mystery_ufo');
      expect(drop.graphics).toBeDefined();
      expect(drop.powerUp.state).toBe(PowerUpState.GROWING); // starts at scale 0
    });

    it('makeDropCollectible matures the drop so the shared gate collects it', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const drop = makeDropCollectible(createMysteryUfoDrop(scene, 200, 150));
      const collected: typeof drop[] = [];
      const kept = collectOverlappingDrops(
        [drop],
        { x: 200, y: 150 },
        (d) => {
          d.absorbing = true;
          collected.push(d);
        },
      );

      expect(drop.powerUp.canCollect()).toBe(true);
      expect(collected).toEqual([drop]);
      expect(kept).toEqual([]); // collected → removed from the field
    });

    it('an immature drop is not collectible through the shared gate', async () => {
      const { game, scene } = await bootCollectorDroneScene();
      games.push(game);

      const drop = createMysteryUfoDrop(scene, 200, 150);
      const collected: typeof drop[] = [];
      collectOverlappingDrops(
        [drop],
        { x: 200, y: 150 },
        (d) => {
          d.absorbing = true;
          collected.push(d);
        },
      );

      expect(drop.powerUp.canCollect()).toBe(false);
      expect(collected).toEqual([]);
    });
  });
});

// ── UFO feel verification seams (AH-0MVSAJJ8F000ZD5Q) ───────────────

describe('UFO feel cue recorder (AH-0MVSAJJ8F000ZD5Q)', () => {
  let recorder: UfoCueRecorder;

  beforeEach(() => {
    recorder = installUfoCueRecorder();
  });

  afterEach(() => {
    recorder.dispose();
    resetDroneVfxCounts();
  });

  it('records a continuous cue start/stop pair in call order without an AudioContext', () => {
    expect(getAudioContext()).toBeNull();

    playDiveSound();
    stopDiveSound();

    expect(recorder.events.map(({ cue, kind }) => ({ cue, kind }))).toEqual([
      { cue: 'playDiveSound', kind: 'play' },
      { cue: 'stopDiveSound', kind: 'stop' },
    ]);
    // Recording never constructs an audio context.
    expect(getAudioContext()).toBeNull();
  });

  it('records one-shot cue dispatches with their baked asset URL', () => {
    playPowerUpCollectSound();
    playPowerUpSpawnSound();

    expect(recorder.events.map((event) => event.cue)).toEqual([
      'playPowerUpCollectSound',
      'playPowerUpSpawnSound',
    ]);
    expect(recorder.events[0].url).toBe(cueAssetUrl('playPowerUpCollectSound'));
    expect(recorder.events.every((event) => event.kind === 'play')).toBe(true);
  });

  it('records no UFO cue today: the feel slices are not wired yet', () => {
    playPowerUpCollectSound();

    // The seam observes the real dispatch path, so it starts recording the
    // UFO cues automatically once the ToneForge bake adds them.
    expect(recorder.ufoEvents()).toEqual([]);
    expect(recorder.ufoEventNames()).toEqual([]);
  });

  it('captures the recorder log plus a VFX snapshot', () => {
    playPowerUpCollectSound();

    expect(captureUfoLifecycleFeedback(recorder)).toEqual({
      cues: [],
      vfx: getDroneVfxCounts(),
    });
  });

  it('names every UFO wrapper the feel slices will call', () => {
    // The contract with the bake/warble/terminal slices: changing a wrapper
    // name here forces the seam and those slices to change together.
    expect(Object.values(UFO_CUES)).toEqual([
      'playMysteryUfoWarbleSound',
      'stopMysteryUfoWarbleSound',
      'playMysteryUfoRewardSound',
      'playMysteryUfoDestroySound',
      'playMineralTinkleSound',
    ]);
  });
});

describe('collector-drone VFX counters (AH-0MVSAJJ8F000ZD5Q)', () => {
  afterEach(() => {
    resetDroneVfxCounts();
  });

  it('exposes per-moment counters that reset between tests', () => {
    recordDroneVfxSpawn('launchPoof');
    recordDroneVfxSpawn('collectSparkle', 2);
    recordDroneVfxSpawn('returnTrail');
    recordDroneVfxSpawn('destruction');

    expect(getDroneVfxCounts()).toEqual({
      launchPoof: 1,
      collectSparkle: 2,
      returnTrail: 1,
      destruction: 1,
    });

    resetDroneVfxCounts();
    expect(getDroneVfxCounts()).toEqual({
      launchPoof: 0,
      collectSparkle: 0,
      returnTrail: 0,
      destruction: 0,
    });
  });
});

describe('UFO lifecycle sequence helpers (AH-0MVSAJJ8F000ZD5Q)', () => {
  /** Today's silent baseline: no cue, no VFX. */
  const silent = (): UfoLifecycleFeedback => ({
    cues: [],
    vfx: getDroneVfxCounts(),
  });

  /** Synthetic feedback, so the helpers' discrimination is pinned without production cues. */
  const withFeedback = (
    cues: readonly UfoFeedbackEventName[],
    vfx: Partial<DroneVfxCounts> = {},
  ): UfoLifecycleFeedback => ({
    cues,
    vfx: { ...getDroneVfxCounts(), ...vfx },
  });

  beforeEach(() => {
    resetDroneVfxCounts();
  });

  afterEach(() => {
    resetDroneVfxCounts();
  });

  it('passes the payout baseline: silent, exactly as the drone behaves today', () => {
    expect(() => expectUfoPayoutLifecycle(silent())).not.toThrow();
  });

  it('accepts the documented payout target sequence once the feel slices land', () => {
    expect(() =>
      expectUfoPayoutLifecycle(
        withFeedback(UFO_PAYOUT_CUE_SEQUENCE, { returnTrail: 1 }),
        { cues: UFO_PAYOUT_CUE_SEQUENCE, vfx: { returnTrail: 1 } },
      ),
    ).not.toThrow();
  });

  it('rejects a reward fired before the warble stops', () => {
    expect(() =>
      expectUfoPayoutLifecycle(
        withFeedback(['warble-start', 'reward', 'warble-stop']),
        { cues: UFO_PAYOUT_CUE_SEQUENCE },
      ),
    ).toThrow(/cue sequence/);
  });

  it('rejects destruction feedback in the payout sequence', () => {
    expect(() => expectUfoPayoutLifecycle(withFeedback(['destroy']))).toThrow(
      /unexpected 'destroy'/,
    );
  });

  it('rejects a warble stop with no matching start', () => {
    expect(() => expectUfoPayoutLifecycle(withFeedback(['warble-stop']))).toThrow(
      /stopped before it started/,
    );
  });

  it('rejects a double warble start', () => {
    expect(() =>
      expectUfoPayoutLifecycle(withFeedback(['warble-start', 'warble-start'])),
    ).toThrow(/started more than once/);
  });

  it('rejects a repeated reward', () => {
    expect(() =>
      expectUfoPayoutLifecycle(withFeedback(['reward', 'reward'])),
    ).toThrow(/reward' fired more than once/);
  });

  it('rejects VFX spawns the payout baseline does not expect', () => {
    expect(() =>
      expectUfoPayoutLifecycle(withFeedback([], { collectSparkle: 1 })),
    ).toThrow(/collectSparkle spawn count/);
  });

  it('passes the destruction baseline: silent, exactly as the drone behaves today', () => {
    expect(() => expectUfoDestructionLifecycle(silent())).not.toThrow();
  });

  it('accepts the documented destruction target sequence once the slices land', () => {
    expect(() =>
      expectUfoDestructionLifecycle(
        withFeedback(UFO_DESTRUCTION_CUE_SEQUENCE, { destruction: 1 }),
        {
          cues: UFO_DESTRUCTION_CUE_SEQUENCE,
          vfx: { destruction: 1 },
        },
      ),
    ).not.toThrow();
  });

  it('rejects reward feedback in the destruction sequence', () => {
    expect(() =>
      expectUfoDestructionLifecycle(withFeedback(['reward'])),
    ).toThrow(/unexpected 'reward'/);
  });

  it('rejects a tinkle that fires twice', () => {
    expect(() =>
      expectUfoDestructionLifecycle(withFeedback(['tinkle', 'tinkle'])),
    ).toThrow(/tinkle' fired more than once/);
  });
});

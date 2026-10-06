/**
 * Boss shot-probability gate (AH-0MU0F1T2H003B4K0).
 *
 * The Boss always shoots (pattern-driven) and its default
 * `shotProbability` is 1.0, so this suite pins the additive behaviour:
 * forced success fires, forced failure consumes the cycle without firing,
 * an omitted field preserves the old always-fire behaviour, and the roll
 * is never made while a telegraph (tell) is scheduled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import * as effectsModule from '../audio/effects';
import {
  BOSS_ATTACK_INTERVAL,
  BOSS_HIT_POINTS_PER_PHASE,
  BOSS_PHASE_COUNT,
  Boss,
  playBossSpawnSound,
} from './Boss';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BossProbabilityHarness');
  }
}

describe('Boss — shot probability gate (AH-0MU0F1T2H003B4K0)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(config: {
    shotProbability?: number;
    rng?: () => number;
  } = {}): Boss {
    return new Boss(booted!.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
      ...config,
    });
  }

  it('a forced-success roll fires a full spread volley', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ shotProbability: 0.25, rng: () => 0.1 });
    boss._simulateTelegraphElapsed();
    const bullets = boss.tryFireSpreadBullets(1_000_000);
    expect(bullets.length).toBeGreaterThan(0);
  });

  it('a forced-failure roll consumes the cycle and fires nothing', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ shotProbability: 0.25, rng: () => 0.9 });
    boss._simulateTelegraphElapsed();
    const t0 = 1_000_000;
    expect(boss.tryFireSpreadBullets(t0)).toEqual([]);
    // Cycle consumed — still nothing inside the attack interval.
    expect(boss.tryFireSpreadBullets(t0 + BOSS_ATTACK_INTERVAL - 1)).toEqual([]);
  });

  it('defaults shotProbability to 1.0 when omitted (no behaviour change)', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    boss._simulateTelegraphElapsed();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const bullets = boss.tryFireSpreadBullets(1_000_000);
    spy.mockRestore();
    expect(bullets.length).toBeGreaterThan(0);
  });

  it('never rolls while a telegraph (tell) is scheduled', async () => {
    booted = await bootScene([HarnessScene]);
    // rng would throw if invoked — proves the guard precedes the roll.
    const rng = vi.fn(() => 0.1);
    const boss = makeBoss({ shotProbability: 0.25, rng });
    boss.startTelegraph(1_000_000);
    expect(boss.isTelegraphing()).toBe(true);
    expect(boss.tryFireSpreadBullets(1_000_000)).toEqual([]);
    expect(rng).not.toHaveBeenCalled();
  });
});

// ── AC4: Boss SFX wiring (AH-0MU3VPIA900697E8) ──────────────────────

describe('Boss SFX wiring (AH-0MU3VPIA900697E8)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('playBossFireSound fires once per Spread volley', async () => {
    booted = await bootScene([HarnessScene]);
    const fireSpy = vi.spyOn(effectsModule, 'playBossFireSound');

    const boss = new Boss(booted!.scene, {
      x: 480, y: 300, formationOffset: { row: 0, col: 0 },
    });
    boss._simulateTelegraphElapsed();

    const bullets = boss.tryFireSpreadBullets(1_000_000);
    expect(bullets.length).toBeGreaterThan(0);
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('playBossFireSound fires once per Spiral volley', async () => {
    booted = await bootScene([HarnessScene]);
    const fireSpy = vi.spyOn(effectsModule, 'playBossFireSound');

    const boss = new Boss(booted!.scene, {
      x: 480, y: 300, formationOffset: { row: 0, col: 0 },
    });
    boss._simulateTelegraphElapsed();

    const bullets = boss.tryFireSpiralBullets(1_000_000);
    expect(bullets.length).toBeGreaterThan(0);
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('playBossFireSound fires once per Pulse volley', async () => {
    booted = await bootScene([HarnessScene]);
    const fireSpy = vi.spyOn(effectsModule, 'playBossFireSound');

    const boss = new Boss(booted!.scene, {
      x: 480, y: 300, formationOffset: { row: 0, col: 0 },
    });
    boss._simulateTelegraphElapsed();

    const bullets = boss.tryFirePulseBullets(1_000_000);
    expect(bullets.length).toBeGreaterThan(0);
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('playBossFireSound fires once per Desperation volley', async () => {
    booted = await bootScene([HarnessScene]);
    const fireSpy = vi.spyOn(effectsModule, 'playBossFireSound');

    const boss = new Boss(booted!.scene, {
      x: 480, y: 300, formationOffset: { row: 0, col: 0 },
    });
    boss._simulateTelegraphElapsed();

    const bullets = boss.tryFireDesperationBullets(1_000_000);
    expect(bullets.length).toBeGreaterThan(0);
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('does not play fire SFX when shotProbability fails', async () => {
    booted = await bootScene([HarnessScene]);
    const fireSpy = vi.spyOn(effectsModule, 'playBossFireSound');

    const boss = new Boss(booted!.scene, {
      x: 480, y: 300, formationOffset: { row: 0, col: 0 },
      shotProbability: 0,
    });
    boss._simulateTelegraphElapsed();

    const bullets = boss.tryFireSpreadBullets(1_000_000);
    expect(bullets).toHaveLength(0);
    expect(fireSpy).not.toHaveBeenCalled();
  });
});

// ── Shared audio context (AH-0MU4KPQHR008WX4R) ──────────────────────

/**
 * Minimal AudioContext stub that counts how many contexts are constructed.
 * Boss audio must reuse the single effects.ts context, not create its own.
 */
class CountingAudioContext {
  static instances = 0;
  currentTime = 0;
  sampleRate = 44100;
  destination = {};

  constructor() {
    CountingAudioContext.instances += 1;
  }

  createOscillator(): unknown {
    return {
      type: 'sine',
      frequency: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => ({ connect: () => ({}) }),
      start: () => {},
      stop: () => {},
    };
  }

  createGain(): unknown {
    return {
      context: this,
      gain: {
        setValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        cancelScheduledValues: () => {},
      },
      connect: () => ({}),
    };
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): unknown {
    return { duration: 0, getChannelData: () => new Float32Array(length) };
  }

  createBufferSource(): unknown {
    return {
      buffer: null as unknown,
      loop: false,
      connect: () => ({}),
      start: () => {},
      stop: () => {},
    };
  }
}

describe('Boss audio shares the effects.ts AudioContext (AH-0MU4KPQHR008WX4R)', () => {
  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext =
      CountingAudioContext;
    effectsModule._resetAudioContextForTests();
    CountingAudioContext.instances = 0;
  });

  afterEach(() => {
    effectsModule._resetAudioContextForTests();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    CountingAudioContext.instances = 0;
  });

  it('a Boss cue does not construct a second AudioContext after an effects cue', () => {
    // An effects.ts cue lazily creates the shared context…
    effectsModule.playSpawnSound();
    // …and a Boss cue must reuse it rather than build its own.
    playBossSpawnSound();

    expect(CountingAudioContext.instances).toBe(1);
  });
});

// ── Per-phase HP model: 100 hits per phase (AH-0MUWTS07L008KVP9) ──────

interface TakeDamageResult {
  destroyed: boolean;
  phaseAdvanced: boolean;
  phase: number;
  hpRemaining: number;
}

describe('Boss — per-phase HP model: 100 hits per phase (AH-0MUWTS07L008KVP9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(): Boss {
    return new Boss(booted!.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });
  }

  // AC1: 100 hits per phase; total HP derives from the phase constants.
  it('AC1 — total hits to destroy = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const totalHits = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE;

    // AC1 metric: the exported constants compose to exactly 400 hits.
    expect(totalHits).toBe(400);

    for (let i = 0; i < totalHits - 1; i++) {
      const result = boss.takeDamage() as TakeDamageResult;
      expect(result.destroyed).toBe(false);
    }
    expect(boss.alive).toBe(true);

    const final = boss.takeDamage() as TakeDamageResult;
    expect(final.destroyed).toBe(true);
    expect(boss.alive).toBe(false);
  });

  // AC1: 100 hits per phase
  it('after BOSS_HIT_POINTS_PER_PHASE - 1 hits the boss remains in phase 1', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    expect(boss.getPhaseNumber()).toBe(1);

    for (let i = 0; i < BOSS_HIT_POINTS_PER_PHASE - 1; i++) {
      const result = boss.takeDamage() as TakeDamageResult;
      expect(result.destroyed).toBe(false);
      expect(result.phaseAdvanced).toBe(false);
    }

    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.alive).toBe(true);
  });

  it('the BOSS_HIT_POINTS_PER_PHASE-th hit advances to phase 2', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    for (let i = 0; i < BOSS_HIT_POINTS_PER_PHASE - 1; i++) {
      boss.takeDamage();
    }

    const result = boss.takeDamage() as TakeDamageResult;
    expect(result.phaseAdvanced).toBe(true);
    expect(boss.getPhaseNumber()).toBe(2);
    expect(boss.alive).toBe(true);
  });

  // AC2: all 4 phases traversed, the final hit destroys boss
  it('BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE hits destroys the boss (phase 4 -> destroyed)', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const totalHits = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE;

    for (let i = 0; i < totalHits - 1; i++) {
      const result = boss.takeDamage() as TakeDamageResult;
      expect(result.destroyed).toBe(false);
    }

    expect(boss.getPhaseNumber()).toBe(4);
    expect(boss.alive).toBe(true);

    const result = boss.takeDamage() as TakeDamageResult;
    expect(result.destroyed).toBe(true);
    expect(boss.alive).toBe(false);
  });

  // AC3: return contract
  it('takeDamage returns { destroyed, phaseAdvanced, hpRemaining }', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    // Hit 1: not destroyed, no phase advance
    const r1 = boss.takeDamage() as TakeDamageResult;
    expect(r1).toHaveProperty('destroyed', false);
    expect(r1).toHaveProperty('phaseAdvanced', false);
    expect(r1).toHaveProperty('hpRemaining');
    expect(typeof r1.hpRemaining).toBe('number');

    // Hits 2 through (P-1): no phase advance
    for (let i = 1; i < BOSS_HIT_POINTS_PER_PHASE - 1; i++) {
      boss.takeDamage();
    }
    // Hit P: phase advanced
    const rP = boss.takeDamage() as TakeDamageResult;
    expect(rP.phaseAdvanced).toBe(true);
    expect(rP.phase).toBe(2);

    // Hits P+1 to (total-1)
    const totalHits = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE;
    for (let i = BOSS_HIT_POINTS_PER_PHASE; i < totalHits - 1; i++) {
      boss.takeDamage();
    }
    // Final hit: destroyed
    const rFinal = boss.takeDamage() as TakeDamageResult;
    expect(rFinal.destroyed).toBe(true);
  });

  // AC4: health-bar fraction accessors
  it('getHpFraction() returns remaining HP / total HP', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    const P = BOSS_HIT_POINTS_PER_PHASE;
    const total = BOSS_PHASE_COUNT * P;
    let hits = 0;

    // 0 hits = full health
    expect(boss.getHpFraction()).toBeCloseTo(1.0);

    // 1 hit = (total-1)/total remaining
    boss.takeDamage();
    hits++;
    expect(boss.getHpFraction()).toBeCloseTo((total - hits) / total);

    // P-1 hits: still in phase 1, one hit short of the boundary.
    while (hits < P - 1) {
      boss.takeDamage();
      hits++;
    }
    expect(boss.getHpFraction()).toBeCloseTo((total - hits) / total);

    // P hits: phase 2 starts.
    const rP = boss.takeDamage() as TakeDamageResult;
    hits++;
    expect(rP.phaseAdvanced).toBe(true);
    expect(boss.getHpFraction()).toBeCloseTo((total - hits) / total);

    // 3P-1 hits: one hit short of phase 4.
    while (hits < 3 * P - 1) {
      boss.takeDamage();
      hits++;
    }
    expect(boss.getHpFraction()).toBeCloseTo((total - hits) / total);

    // total-1 hits: 1/total remaining.
    while (hits < total - 1) {
      boss.takeDamage();
      hits++;
    }
    expect(boss.getHpFraction()).toBeCloseTo(1 / total);

    // total hits = destroyed, 0 HP
    const rFinal = boss.takeDamage() as TakeDamageResult;
    hits++;
    expect(rFinal.destroyed).toBe(true);
    expect(hits).toBe(total);
    expect(boss.getHpFraction()).toBeCloseTo(0.0);
  });

  // AC5: phaseAdvanced signal
  it('phaseAdvanced is false for non-depleting hits of each phase, true on the depleting hit', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const P = BOSS_HIT_POINTS_PER_PHASE;

    for (let phase = 1; phase <= BOSS_PHASE_COUNT; phase++) {
      // Non-depleting hits: phase must remain unchanged.
      for (let hit = 1; hit < P; hit++) {
        const result = boss.takeDamage() as TakeDamageResult;
        expect(result.phaseAdvanced).toBe(false);
        expect(result.destroyed).toBe(false);
      }

      // Depleting hit: advances the phase, or destroys after the final phase.
      const depleting = boss.takeDamage() as TakeDamageResult;
      expect(depleting.phaseAdvanced).toBe(true);
      if (phase < BOSS_PHASE_COUNT) {
        expect(boss.getPhaseNumber()).toBe(phase + 1);
        expect(depleting.destroyed).toBe(false);
      } else {
        expect(depleting.destroyed).toBe(true);
        expect(boss.alive).toBe(false);
      }
    }
  });

  // AC5b: extra boundary checks on phaseAdvanced
  it('phaseAdvanced is false mid-phase and true on the phase boundary', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const P = BOSS_HIT_POINTS_PER_PHASE;

    for (let i = 0; i < P - 2; i++) boss.takeDamage();
    // One hit before the boundary (hit P-1): still in phase 1.
    const rBefore = boss.takeDamage() as TakeDamageResult;
    expect(rBefore.phaseAdvanced).toBe(false);
    expect(boss.getPhaseNumber()).toBe(1);

    // Boundary hit (hit P): advances to phase 2.
    const rBoundary = boss.takeDamage() as TakeDamageResult;
    expect(rBoundary.phaseAdvanced).toBe(true);
    expect(boss.getPhaseNumber()).toBe(2);
  });
});

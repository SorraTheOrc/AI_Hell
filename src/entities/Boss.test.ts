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
import * as bulletImpactModule from '../vfx/bulletImpact';
import {
  BOSS_ATTACK_INTERVAL,
  BOSS_HEALTH_BAR_WIDTH,
  BOSS_HEALTH_SEGMENTS,
  BOSS_HIT_POINTS_PER_PHASE,
  BOSS_IMPACT_COLOR,
  BOSS_MOVE_AMPLITUDE_X,
  BOSS_MOVE_AMPLITUDE_Y,
  BOSS_MOVE_PERIOD_MS,
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

// ── Per-phase HP model: 50 hits per phase, 200 total (AH-0MUZMTRJM003ISD5) ──

interface TakeDamageResult {
  destroyed: boolean;
  phaseAdvanced: boolean;
  phase: number;
  hpRemaining: number;
}

describe('Boss — per-phase HP model: 50 hits per phase (AH-0MUWTS07L008KVP9)', () => {
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

  // AC1: 50 hits per phase; total HP derives from the phase constants.
  it('AC1 — total hits to destroy = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const totalHits = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE;

    // AC1 metric: the exported constants compose to exactly 200 hits.
    expect(totalHits).toBe(200);

    for (let i = 0; i < totalHits - 1; i++) {
      const result = boss.takeDamage() as TakeDamageResult;
      expect(result.destroyed).toBe(false);
    }
    expect(boss.alive).toBe(true);

    const final = boss.takeDamage() as TakeDamageResult;
    expect(final.destroyed).toBe(true);
    expect(boss.alive).toBe(false);
  });

  // AC1: 50 hits per phase
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

// ── 200-hit retune + screen-fixed health bar (AH-0MUZMTRJM003ISD5) ─

// Phaser Graphics `commandBuffer` opcodes (mirrors src/powerups/icons.test.ts).
const Cmd = {
  FILL_RECT: 3,
  LINE_TO: 4,
  MOVE_TO: 5,
  LINE_STYLE: 6,
  FILL_STYLE: 7,
  FILL_PATH: 8,
  STROKE_PATH: 9,
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
} as const;

interface ParsedGraphics {
  fillRects: number[][];
  lineStyles: number[][];
}

/** Walks the flat command buffer, extracting FILL_RECT and LINE_STYLE commands. */
function parseGraphics(buf: number[]): ParsedGraphics {
  const fillRects: number[][] = [];
  const lineStyles: number[][] = [];
  let i = 0;
  while (i < buf.length) {
    switch (buf[i]) {
      case Cmd.FILL_RECT:
        fillRects.push(buf.slice(i + 1, i + 5));
        i += 5;
        break;
      case Cmd.LINE_TO:
      case Cmd.MOVE_TO:
        i += 3;
        break;
      case Cmd.LINE_STYLE:
        lineStyles.push(buf.slice(i + 1, i + 4));
        i += 4;
        break;
      case Cmd.FILL_STYLE:
        i += 3;
        break;
      case Cmd.BEGIN_PATH:
      case Cmd.CLOSE_PATH:
      case Cmd.FILL_PATH:
      case Cmd.STROKE_PATH:
        i += 1;
        break;
      default:
        i += 1;
        break;
    }
  }
  return { fillRects, lineStyles };
}

describe('Boss — 200-hit retune + screen-fixed health bar (AH-0MUZMTRJM003ISD5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(x = 480, y = 200): Boss {
    return new Boss(booted!.scene, {
      x,
      y,
      formationOffset: { row: 0, col: 0 },
    });
  }

  it('AC1 — BOSS_HIT_POINTS_PER_PHASE is 50 and total HP is 200', async () => {
    booted = await bootScene([HarnessScene]);
    expect(BOSS_HIT_POINTS_PER_PHASE).toBe(50);
    expect(BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE).toBe(200);
  });

  it('AC1 — hit 49 keeps phase 1, hit 50 advances to phase 2, hit 200 destroys', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    for (let hit = 1; hit <= 49; hit++) {
      const result = boss.takeDamage() as TakeDamageResult;
      expect(result.destroyed).toBe(false);
      expect(result.phaseAdvanced).toBe(false);
    }
    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.alive).toBe(true);

    const fiftieth = boss.takeDamage() as TakeDamageResult;
    expect(fiftieth.phaseAdvanced).toBe(true);
    expect(boss.getPhaseNumber()).toBe(2);

    // Hits 51..199 leave the boss alive on its final phase.
    for (let hit = 51; hit <= 199; hit++) boss.takeDamage();
    expect(boss.alive).toBe(true);
    expect(boss.getPhaseNumber()).toBe(BOSS_PHASE_COUNT);

    const twoHundredth = boss.takeDamage() as TakeDamageResult;
    expect(twoHundredth.destroyed).toBe(true);
    expect(twoHundredth.hpRemaining).toBe(0);
    expect(boss.alive).toBe(false);
  });

  it('AC3 — getHpFraction decreases monotonically with every hit', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    let previous = boss.getHpFraction();
    expect(previous).toBeCloseTo(1.0);
    for (let hit = 1; hit <= 199; hit++) {
      boss.takeDamage();
      const next = boss.getHpFraction();
      expect(next).toBeLessThan(previous);
      previous = next;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it('AC2 — the health bar Graphics is a scene child, not a boss-container child', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const bar = boss.getHealthBarGraphics();

    expect(boss.list).not.toContain(bar);
    expect(bar.parentContainer).toBeNull();
    // Camera-fixed at the top of the screen.
    expect(bar.scrollFactorX).toBe(0);
    expect(bar.scrollFactorY).toBe(0);
    expect(bar.depth).toBe(100);
  });

  it('AC2 — the bar’s drawn screen position is unchanged when the boss moves', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);
    const bar = boss.getHealthBarGraphics();

    const before = parseGraphics(bar.commandBuffer as number[]).fillRects;
    const expectedX =
      (booted!.scene.scale.width - BOSS_HEALTH_BAR_WIDTH) / 2;
    // Drawn at the absolute screen centre, not at the boss position.
    expect(before[0][0]).toBeCloseTo(expectedX);
    expect(before[0][0]).not.toBeCloseTo(boss.x);

    // Move the boss far from its spawn anchor (as figure-8 motion will).
    boss.setPosition(120, 460);

    // A scene child is not transformed by the boss container, so the drawn
    // screen coordinates are byte-for-byte unchanged.
    const after = parseGraphics(bar.commandBuffer as number[]).fillRects;
    expect(after).toEqual(before);
    expect(boss.x).toBe(120);
    expect(boss.y).toBe(460);
  });

  it('AC4 — the proportional fill halves after 100 hits and the four dividers remain', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const bar = boss.getHealthBarGraphics();

    const full = parseGraphics(bar.commandBuffer as number[]);
    // Two FILL_RECTs: full-width background and the proportional health fill.
    expect(full.fillRects).toHaveLength(2);
    expect(full.fillRects[1][2]).toBeCloseTo(BOSS_HEALTH_BAR_WIDTH);

    for (let hit = 0; hit < 100; hit++) boss.takeDamage();
    expect(boss.getHpFraction()).toBeCloseTo(0.5);

    const half = parseGraphics(bar.commandBuffer as number[]);
    expect(half.fillRects[1][2]).toBeCloseTo(BOSS_HEALTH_BAR_WIDTH * 0.5);
    // The divider line style is still emitted (4 segments → 3 dividers).
    expect(BOSS_HEALTH_SEGMENTS).toBe(4);
    expect(half.lineStyles.some((s) => s[1] === 0x666666)).toBe(true);
  });

  it('AC4 — destroy() explicitly destroys the health-bar Graphics', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const bar = boss.getHealthBarGraphics();

    boss.destroy();

    expect(bar.active).toBe(false);
    expect(bar.scene).toBeUndefined();
  });
});

describe('Boss — dev scenario starting health (AH-0MUWZ5HCV0034H44)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(config: {
    initialHp?: number;
    initialPhase?: number;
  } = {}): Boss {
    return new Boss(booted!.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
      ...config,
    });
  }

  it('defaults to the full four-phase pool', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    expect(boss.getHpFraction()).toBe(1);
    expect(boss.getPhaseNumber()).toBe(1);
  });

  it('destroys after exactly the configured number of hits', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ initialHp: 4, initialPhase: 4 });

    for (let hit = 1; hit < 4; hit++) {
      const result = boss.takeDamage();
      expect(result.destroyed).toBe(false);
    }
    const final = boss.takeDamage();
    expect(final.destroyed).toBe(true);
    expect(boss.alive).toBe(false);
  });

  it('honours the starting phase for the low-HP visuals', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ initialHp: 4, initialPhase: 4 });
    expect(boss.getPhaseNumber()).toBe(4);
    expect(boss.isDesperation()).toBe(true);
  });

  it('clamps an initialHp above the pool and an out-of-range phase', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ initialHp: 10_000, initialPhase: 99 });
    expect(boss.getHpFraction()).toBe(1);
    expect(boss.getPhaseNumber()).toBe(BOSS_PHASE_COUNT);
  });

  it('clamps a non-positive initialHp to one hit and a phase below one to one', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ initialHp: 0, initialPhase: -3 });
    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.takeDamage().destroyed).toBe(true);
  });
});

// ── Figure-of-eight movement (AH-0MUZMTS8J0029FSS) ──────────────────

describe('Boss — figure-of-eight movement in shared core (AH-0MUZMTS8J0029FSS)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(x = 480, y = 200): Boss {
    return new Boss(booted!.scene, {
      x,
      y,
      formationOffset: { row: 0, col: 0 },
    });
  }

  it('exposes the documented movement constants', async () => {
    booted = await bootScene([HarnessScene]);
    expect(BOSS_MOVE_AMPLITUDE_X).toBe(120);
    expect(BOSS_MOVE_AMPLITUDE_Y).toBe(60);
    expect(BOSS_MOVE_PERIOD_MS).toBe(8000);
  });

  it('starts on its anchor at elapsed time zero', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);

    boss.update(0, 0, 960, 540);

    expect(boss.x).toBeCloseTo(480);
    expect(boss.y).toBeCloseTo(200);
    expect(boss.getMoveAnchorX()).toBe(480);
    expect(boss.getMoveAnchorY()).toBe(200);
  });

  it('reaches its horizontal peak a quarter of the way through the cycle', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);

    boss.update(0, BOSS_MOVE_PERIOD_MS / 4, 960, 540);

    // theta = PI/2: x at +amplitude, y at the anchor (sin(PI) = 0).
    expect(boss.x).toBeCloseTo(480 + BOSS_MOVE_AMPLITUDE_X);
    expect(boss.y).toBeCloseTo(200);
  });

  it('reaches its vertical peak an eighth of the way through the cycle', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);

    boss.update(0, BOSS_MOVE_PERIOD_MS / 8, 960, 540);

    // theta = PI/4: y at +amplitude (sin(PI/2) = 1).
    expect(boss.y).toBeCloseTo(200 + BOSS_MOVE_AMPLITUDE_Y);
  });

  it('returns to its anchor after a full cycle', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);

    boss.update(0, BOSS_MOVE_PERIOD_MS, 960, 540);

    expect(boss.x).toBeCloseTo(480);
    expect(boss.y).toBeCloseTo(200);
  });

  it('traces close to the configured horizontal and vertical amplitudes over a cycle', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);

    let peakX = 0;
    let peakY = 0;
    const step = 100;
    for (let elapsed = 0; elapsed <= BOSS_MOVE_PERIOD_MS; elapsed += step) {
      boss.update(0, step, 960, 540);
      peakX = Math.max(peakX, Math.abs(boss.x - 480));
      peakY = Math.max(peakY, Math.abs(boss.y - 200));
    }

    expect(peakX).toBeCloseTo(BOSS_MOVE_AMPLITUDE_X, 1);
    expect(peakY).toBeCloseTo(BOSS_MOVE_AMPLITUDE_Y, 1);
  });

  it('clamps the traced position so the boss body stays within the playfield', async () => {
    booted = await bootScene([HarnessScene]);
    // Anchor hard against the top-left corner: without clamping the path
    // would leave the screen on both axes.
    const boss = makeBoss(30, 30);

    const step = 50;
    for (let elapsed = 0; elapsed <= BOSS_MOVE_PERIOD_MS; elapsed += step) {
      boss.update(0, step, 960, 540);
      expect(boss.x).toBeGreaterThanOrEqual(0);
      expect(boss.x).toBeLessThanOrEqual(960);
      expect(boss.y).toBeGreaterThanOrEqual(0);
      expect(boss.y).toBeLessThanOrEqual(540);
    }
  });

  it('applyFormationPosition sets the anchor without overriding the live position', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);

    // Move the boss off its anchor first.
    boss.update(0, BOSS_MOVE_PERIOD_MS / 8, 960, 540);
    const liveX = boss.x;
    const liveY = boss.y;
    expect(liveX).not.toBeCloseTo(480);

    boss.applyFormationPosition(300, 150, 0.016, 0, 0);

    // The live figure-of-eight position is untouched; only the anchor moved.
    expect(boss.x).toBe(liveX);
    expect(boss.y).toBe(liveY);
    expect(boss.getMoveAnchorX()).toBe(300);
    expect(boss.getMoveAnchorY()).toBe(150);

    // The next full cycle now traces about the new anchor (the motion phase
    // continues, so advance to the next full-cycle boundary).
    boss.update(0, BOSS_MOVE_PERIOD_MS - BOSS_MOVE_PERIOD_MS / 8, 960, 540);
    expect(boss.x).toBeCloseTo(300);
    expect(boss.y).toBeCloseTo(150);
  });

  it('does not move a destroyed boss', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);
    boss.update(0, BOSS_MOVE_PERIOD_MS / 8, 960, 540);
    const liveX = boss.x;
    const liveY = boss.y;

    boss.destroySelf();
    boss.update(0, BOSS_MOVE_PERIOD_MS / 4, 960, 540);

    expect(boss.x).toBe(liveX);
    expect(boss.y).toBe(liveY);
  });
});

// ── Per-hit impact VFX & SFX on the shared feedback path (AH-0MUZMTTPE0074X59) ──

describe('Boss — per-hit impact VFX & SFX (AH-0MUZMTTPE0074X59)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeBoss(x = 480, y = 200): Boss {
    return new Boss(booted!.scene, {
      x,
      y,
      formationOffset: { row: 0, col: 0 },
    });
  }

  it('AC1 — every landed hit plays the boss-hit cue and registers exactly one impact VFX', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const cue = vi.spyOn(effectsModule, 'playBossHitSound');
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');

    boss.takeDamage(100, 120);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(impact).toHaveBeenCalledTimes(1);
    expect(boss.getHitEffects()).toHaveLength(1);

    boss.takeDamage(140, 160);
    expect(cue).toHaveBeenCalledTimes(2);
    expect(impact).toHaveBeenCalledTimes(2);
    expect(boss.getHitEffects()).toHaveLength(2);
  });

  it('AC1 — the impact is spawned at the supplied hit point with the hot boss colour', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');

    boss.takeDamage(123, 145);

    expect(impact).toHaveBeenCalledWith(
      booted.scene,
      123,
      145,
      expect.objectContaining({ color: BOSS_IMPACT_COLOR }),
    );
  });

  it('AC1 — the impact falls back to the boss centre when no hit point is supplied', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(480, 200);
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');

    boss.takeDamage();

    expect(impact).toHaveBeenCalledWith(
      booted.scene,
      480,
      200,
      expect.objectContaining({ color: BOSS_IMPACT_COLOR }),
    );
  });

  it('AC2 — a depleting hit still plays the phase-transition cue alongside the per-hit cue', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const hitCue = vi.spyOn(effectsModule, 'playBossHitSound');
    const phaseCue = vi.spyOn(effectsModule, 'playBossPhaseTransitionSound');

    for (let i = 0; i < BOSS_HIT_POINTS_PER_PHASE - 1; i++) boss.takeDamage();
    expect(phaseCue).not.toHaveBeenCalled();
    expect(hitCue).toHaveBeenCalledTimes(BOSS_HIT_POINTS_PER_PHASE - 1);

    boss.takeDamage();
    expect(phaseCue).toHaveBeenCalledTimes(1);
    expect(hitCue).toHaveBeenCalledTimes(BOSS_HIT_POINTS_PER_PHASE);
  });

  it('AC1 — the destroying hit also plays the per-hit cue and spawns an impact', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const cue = vi.spyOn(effectsModule, 'playBossHitSound');
    const totalHits = BOSS_PHASE_COUNT * BOSS_HIT_POINTS_PER_PHASE;

    for (let i = 0; i < totalHits - 1; i++) boss.takeDamage();
    expect(cue).toHaveBeenCalledTimes(totalHits - 1);
    const effectsBefore = boss.getHitEffects().length;

    boss.takeDamage(50, 60);
    expect(cue).toHaveBeenCalledTimes(totalHits);
    // The destroying hit still registers exactly one per-hit impact.
    expect(boss.getHitEffects()).toHaveLength(effectsBefore + 1);
  });

  it('AC4 — the registry is emptied when an impact flash tween completes', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();
    const tweenSpy = vi.spyOn(booted.scene.tweens, 'add');

    boss.takeDamage(10, 20);
    expect(boss.getHitEffects()).toHaveLength(1);

    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(boss.getHitEffects()).toHaveLength(0);
  });

  it('AC4 — destroy() empties the registry and destroys live impact flashes', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    boss.takeDamage(10, 20);
    const [flash] = boss.getHitEffects();
    expect(flash.active).toBe(true);

    boss.destroy();

    expect(boss.getHitEffects()).toHaveLength(0);
    expect(flash.active).toBe(false);
  });
});

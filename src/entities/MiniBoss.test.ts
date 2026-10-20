/**
 * MiniBoss — config-driven multi-phase entity (AH-0MVCRAYSH0014BQJ).
 *
 * Covers the acceptance criteria:
 *  - AC1: a per-level config drives the pattern set, HP, colour and optional
 *    minions, while reusing the shared Boss architecture;
 *  - AC2: a no-config-safe default exists and invalid configs are rejected
 *    (phases ≥ 1, HP > 0);
 *  - AC4: entity unit tests cover phase advancement, damage/defeat and
 *    pattern firing.
 *
 * Behaviour is asserted through the public entity API (takeDamage,
 * update, getMinions, resolvedConfig) — never by grepping source.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  MiniBoss,
  MiniBossConfigError,
  MINI_BOSS_DEFAULT_COLOR,
  MINI_BOSS_DEFAULT_HP_PER_PHASE,
  resolveMiniBossConfig,
  validateMiniBossConfig,
  type MiniBossConfig,
  type MiniBossPattern,
} from './MiniBoss';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('MiniBossHarness');
  }
}

/** A 2-phase config helper — phase 1 is never the final phase. */
function twoPhaseConfig(
  firstPattern: MiniBossPattern,
  extra: Partial<MiniBossConfig> = {},
): Partial<MiniBossConfig> {
  return {
    phases: [{ pattern: firstPattern }, { pattern: 'spread' }],
    ...extra,
  };
}

describe('MiniBoss — config-driven entity framework (AH-0MVCRAYSH0014BQJ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  function makeBoss(config: Partial<MiniBossConfig> = {}): MiniBoss {
    return new MiniBoss(booted!.scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
      rng: () => 0.5,
      ...config,
    });
  }

  // ── AC2: no-config-safe default + validation ───────────────────

  it('AC2 — a position-only config uses safe defaults and one phase', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss();

    expect(boss.getPhaseCount()).toBe(1);
    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.getColor()).toBe(MINI_BOSS_DEFAULT_COLOR);
    expect(boss.getHpFraction()).toBe(1);
    expect(boss.alive).toBe(true);
    expect(boss.resolvedConfig.name).toBe('Mini-Boss');
    expect(boss.resolvedConfig.level).toBe(1);
    expect(boss.resolvedConfig.phases).toEqual([{ pattern: 'spread' }]);
    expect(boss.resolvedConfig.minions).toEqual([]);

    // The default pool is exactly the default hits per phase.
    for (let hit = 1; hit < MINI_BOSS_DEFAULT_HP_PER_PHASE; hit++) {
      expect(boss.takeDamage().destroyed).toBe(false);
    }
    expect(boss.takeDamage().destroyed).toBe(true);
  });

  it('AC2 — rejects an empty phase list', async () => {
    booted = await bootScene([HarnessScene]);
    expect(() => makeBoss({ phases: [] })).toThrow(MiniBossConfigError);
    expect(() => makeBoss({ phases: [] })).toThrow(/at least one phase/i);
  });

  it('AC2 — rejects non-positive or non-finite HP', async () => {
    booted = await bootScene([HarnessScene]);
    expect(() => makeBoss({ hpPerPhase: 0 })).toThrow(/greater than 0/i);
    expect(() => makeBoss({ hpPerPhase: -5 })).toThrow(MiniBossConfigError);
    expect(() => makeBoss({ hpPerPhase: Number.NaN })).toThrow(
      /greater than 0/i,
    );
  });

  it('AC2 — rejects an unknown phase pattern and an out-of-range minion phase', async () => {
    booted = await bootScene([HarnessScene]);
    expect(() =>
      makeBoss({ phases: [{ pattern: 'laser' as MiniBossPattern }] }),
    ).toThrow(/unknown pattern "laser"/i);

    expect(() =>
      makeBoss({
        phases: [{ pattern: 'spread' }],
        minions: [{ phase: 2, groups: [] }],
      }),
    ).toThrow(/between 1 and 1/i);
  });

  it('AC2 — validateMiniBossConfig validates without constructing an entity', () => {
    const base = { x: 480, y: 200, formationOffset: { row: 0, col: 0 } };
    expect(() => validateMiniBossConfig(base)).not.toThrow();
    expect(() => validateMiniBossConfig({ ...base, hpPerPhase: 0 })).toThrow(
      MiniBossConfigError,
    );
    const resolved = resolveMiniBossConfig(base);
    expect(resolved.hpPerPhase).toBe(MINI_BOSS_DEFAULT_HP_PER_PHASE);
    expect(resolved.phases).toEqual([{ pattern: 'spread' }]);
  });

  // ── AC1: config drives phase count, HP, colour ─────────────────

  it('AC1 — config drives the phase count, HP and colour', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({
      level: 4,
      name: 'Violet Warden',
      color: 0x123456,
      desperationColor: 0xabcdef,
      hpPerPhase: 5,
      phases: [
        { pattern: 'spread' },
        { pattern: 'spiral' },
        { pattern: 'pulse' },
      ],
    });

    expect(boss.getPhaseCount()).toBe(3);
    expect(boss.getHealthSegments()).toBe(3);
    expect(boss.getColor()).toBe(0x123456);
    expect(boss.resolvedConfig.desperationColor).toBe(0xabcdef);
    expect(boss.resolvedConfig.level).toBe(4);
    expect(boss.resolvedConfig.name).toBe('Violet Warden');
    expect(boss.getHpFraction()).toBe(1);
  });

  // ── AC4: phase advancement + damage/defeat ─────────────────────

  it('AC4 — phases advance at the configured HP and the final hit destroys', async () => {
    booted = await bootScene([HarnessScene]);
    const hp = 5;
    const boss = makeBoss({
      hpPerPhase: hp,
      phases: [
        { pattern: 'spread' },
        { pattern: 'spiral' },
        { pattern: 'pulse' },
        { pattern: 'combined' },
      ],
    });

    // Hit 4: one short of the phase-1 boundary.
    for (let hit = 1; hit < hp; hit++) {
      expect(boss.takeDamage().phaseAdvanced).toBe(false);
    }
    expect(boss.getPhaseNumber()).toBe(1);

    // Hit 5: phase 1 depletes.
    const boundary = boss.takeDamage();
    expect(boundary.phaseAdvanced).toBe(true);
    expect(boundary.destroyed).toBe(false);
    expect(boss.getPhaseNumber()).toBe(2);

    // Hits 6..19 leave the final phase alive.
    for (let hit = hp + 1; hit < hp * boss.getPhaseCount(); hit++) {
      boss.takeDamage();
    }
    expect(boss.alive).toBe(true);
    expect(boss.getPhaseNumber()).toBe(4);

    // Hit 20: destroyed, zero HP.
    const final = boss.takeDamage();
    expect(final.destroyed).toBe(true);
    expect(final.hpRemaining).toBe(0);
    expect(boss.alive).toBe(false);
    expect(boss.getHpFraction()).toBe(0);
  });

  it('AC4 — takeDamage short-circuits once destroyed', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({ hpPerPhase: 1, phases: [{ pattern: 'spread' }] });
    expect(boss.takeDamage().destroyed).toBe(true);
    expect(boss.takeDamage()).toEqual({
      destroyed: false,
      phaseAdvanced: false,
      phase: 1,
      hpRemaining: 0,
    });
  });

  // ── AC4: config-driven pattern firing ──────────────────────────

  it('AC4 — the configured spread pattern fires in a non-final phase', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(twoPhaseConfig('spread'));
    boss._simulateTelegraphElapsed();

    const bullets = boss.update(1_000_000, 0, 960, 540);
    // Seven-pellet forward spread in a non-final phase.
    expect(bullets).toHaveLength(7);
  });

  it('AC4 — advancing to the next phase fires that phase’s configured pattern', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({
      hpPerPhase: 1,
      // Three phases: phase 2 is not the final phase, so the spiral volley
      // keeps its non-desperation pellet count.
      phases: [
        { pattern: 'spread' },
        { pattern: 'spiral' },
        { pattern: 'pulse' },
      ],
    });

    boss._simulateTelegraphElapsed();
    expect(boss.update(1_000_000, 0, 960, 540)).toHaveLength(7);

    // Config HP is 1, so one hit advances to the spiral phase.
    expect(boss.takeDamage().phaseAdvanced).toBe(true);
    expect(boss.getPhaseNumber()).toBe(2);

    boss._simulateTelegraphElapsed();
    // Twelve-pellet spiral in a non-final phase.
    expect(boss.update(2_000_000, 0, 960, 540)).toHaveLength(12);
  });

  it('AC4 — the pulse pattern fires its wave plus aimed fan', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(twoPhaseConfig('pulse'));
    boss._simulateTelegraphElapsed();

    const bullets = boss.update(1_000_000, 0, 960, 540);
    // One expanding pulse wave + three aimed shots.
    expect(bullets).toHaveLength(4);
    expect(bullets.some((bullet) => bullet.isPulseWave === true)).toBe(true);
  });

  it('AC4 — the combined pattern fires more than a single pattern', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(twoPhaseConfig('combined'));
    boss._simulateTelegraphElapsed();

    const combined = boss.update(1_000_000, 0, 960, 540);
    expect(combined.length).toBeGreaterThan(12);
  });

  it('AC4 — the telegraph gates the configured pattern (no volley mid-tell)', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss(twoPhaseConfig('spiral'));
    boss.startTelegraph(1_000_000);

    expect(boss.isTelegraphing()).toBe(true);
    expect(boss.update(1_000_000, 0, 960, 540)).toEqual([]);
  });

  // ── AC1: optional minions ──────────────────────────────────────

  it('AC1 — optional minions spawn for phase 1 and rotate on a phase advance', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({
      hpPerPhase: 1,
      phases: [{ pattern: 'spread' }, { pattern: 'spiral' }],
      minions: [
        {
          phase: 1,
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 2,
              spacingX: 28,
              spacingY: 24,
              startX: 100,
              startY: 100,
            },
          ],
        },
        {
          phase: 2,
          groups: [
            {
              enemyKey: 'diver',
              formation: 'diver',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 600,
              startY: 100,
            },
          ],
        },
      ],
    });

    expect(boss.getMinions()).toHaveLength(2);

    // Phase 1 → 2 clears the scouts and summons the divers.
    expect(boss.takeDamage().phaseAdvanced).toBe(true);
    expect(boss.getMinions()).toHaveLength(1);
  });

  it('AC1 — destroy() clears live minions (no scene-level leaks)', async () => {
    booted = await bootScene([HarnessScene]);
    const boss = makeBoss({
      minions: [
        {
          phase: 1,
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 2,
              spacingX: 28,
              spacingY: 24,
              startX: 100,
              startY: 100,
            },
          ],
        },
      ],
    });
    const minions = boss.getMinions();
    expect(minions).toHaveLength(2);

    boss.destroy();
    expect(boss.getMinions()).toEqual([]);
    expect(minions.every((minion) => !minion.active)).toBe(true);
  });
});

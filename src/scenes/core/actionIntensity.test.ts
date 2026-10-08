/**
 * Hermetic unit tests for the pure action-intensity core
 * (AH-0MUZQ33GR006AKXD; decision doc `docs/dev/action-intensity.md` §6–§7).
 *
 * These exercise the *observable* behaviour of the pure function — the
 * presence layer, the event contribution, the saturating normalisation, the
 * EMA smoothing and the burstiness derivative — by constructing state
 * objects directly. No browser, Phaser scene or wall-clock state is involved,
 * matching AC1 ("unit-tested hermetically").
 */

import { describe, expect, it } from 'vitest';

import {
  ACTION_INTENSITY_CATEGORIES,
  ACTION_INTENSITY_EVENT_TYPES,
  DEFAULT_ACTION_INTENSITY_CONFIG,
  computeActionIntensity,
  computePresenceScore,
  smoothingAlpha,
  type ActionIntensityConfig,
  type ActionIntensityCounts,
  type ActionIntensityState,
} from './actionIntensity';

/** Builds a full counts object from a sparse override (zeros elsewhere). */
function counts(partial: Partial<ActionIntensityCounts> = {}): ActionIntensityCounts {
  return {
    playerBullets: 0,
    enemyBullets: 0,
    enemies: 0,
    asteroids: 0,
    drops: 0,
    enemyExplosions: 0,
    bossExplosions: 0,
    playerExplosions: 0,
    bosses: 0,
    ...partial,
  };
}

describe('actionIntensity — config defaults (AC2)', () => {
  it('exposes every documented per-category weight', () => {
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.weights).toEqual({
      playerBullets: 0.5,
      enemyBullets: 1.0,
      enemies: 2.0,
      asteroids: 1.0,
      drops: 1.0,
      enemyExplosions: 2.0,
      bossExplosions: 5.0,
      playerExplosions: 20.0,
      bosses: 5.0,
    });
  });

  it('exposes every documented discrete-event value', () => {
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.eventValues).toEqual({
      enemy_killed: 2,
      player_hit: 20,
      life_lost: 20,
      boss_phase: 5,
      powerup_collected: 1,
      wave_clear: 3,
      level_clear: 3,
      run_started: 0,
      run_ended: 0,
    });
  });

  it('exposes the documented global knobs', () => {
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.eventWindowSeconds).toBe(2.0);
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.referenceBudget).toBe(30);
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.eventBlend).toBe(1.0);
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.halfLifeSeconds).toBe(0.5);
    expect(DEFAULT_ACTION_INTENSITY_CONFIG.sampleRateHz).toBe(10);
  });

  it('caps every category at Infinity by default', () => {
    for (const category of ACTION_INTENSITY_CATEGORIES) {
      expect(DEFAULT_ACTION_INTENSITY_CONFIG.caps[category]).toBe(Infinity);
    }
  });

  it('lists the categories in schema order', () => {
    expect(ACTION_INTENSITY_CATEGORIES).toEqual([
      'playerBullets',
      'enemyBullets',
      'enemies',
      'asteroids',
      'drops',
      'enemyExplosions',
      'bossExplosions',
      'playerExplosions',
      'bosses',
    ]);
  });

  it('lists the discrete event types', () => {
    expect([...ACTION_INTENSITY_EVENT_TYPES]).toEqual([
      'enemy_killed',
      'player_hit',
      'life_lost',
      'boss_phase',
      'powerup_collected',
      'wave_clear',
      'level_clear',
      'run_started',
      'run_ended',
    ]);
  });
});

describe('computePresenceScore — weighted presence layer (AC1)', () => {
  it('sums weight × count over every category', () => {
    const score = computePresenceScore(
      counts({
        playerBullets: 4,
        enemyBullets: 11,
        enemies: 6,
        drops: 1,
      }),
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    // 0.5·4 + 1·11 + 2·6 + 1·1 = 26
    expect(score).toBe(26);
  });

  it('halves the auto-fire player-bullet baseline (refined weight 0.5)', () => {
    const onePlayerBullet = computePresenceScore(
      counts({ playerBullets: 1 }),
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(onePlayerBullet).toBe(0.5);
  });

  it('weights a player explosion above every other category', () => {
    const explosion = computePresenceScore(
      counts({ playerExplosions: 1 }),
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(explosion).toBe(20);
  });

  it('applies the per-category cap to a pathological swarm', () => {
    const capped: ActionIntensityConfig = {
      ...DEFAULT_ACTION_INTENSITY_CONFIG,
      caps: { ...DEFAULT_ACTION_INTENSITY_CONFIG.caps, enemyBullets: 5 },
    };

    const score = computePresenceScore(
      counts({ playerBullets: 4, enemyBullets: 11, enemies: 6, drops: 1 }),
      capped,
    );

    // enemyBullets saturates at 5 → 0.5·4 + 1·5 + 2·6 + 1·1 = 20
    expect(score).toBe(20);
  });

  it('is zero for an empty screen', () => {
    expect(
      computePresenceScore(counts(), DEFAULT_ACTION_INTENSITY_CONFIG),
    ).toBe(0);
  });
});

describe('smoothingAlpha — EMA coefficient (AC1)', () => {
  it('matches α = 1 − 2^(−Δt/h) for the defaults', () => {
    expect(smoothingAlpha(DEFAULT_ACTION_INTENSITY_CONFIG)).toBeCloseTo(
      0.12944943670387588,
      12,
    );
  });

  it('tracks the configured sample rate and half-life', () => {
    const faster: ActionIntensityConfig = {
      ...DEFAULT_ACTION_INTENSITY_CONFIG,
      sampleRateHz: 20,
    };

    expect(smoothingAlpha(faster)).toBeCloseTo(0.06696700846319259, 12);
  });
});

describe('computeActionIntensity — sample shape and layers (AC1)', () => {
  it('returns the §7.1 sample shape with a per-category breakdown', () => {
    const state: ActionIntensityState = {
      counts: counts({
        playerBullets: 4,
        enemyBullets: 11,
        enemies: 6,
        drops: 1,
      }),
    };

    const sample = computeActionIntensity(state, DEFAULT_ACTION_INTENSITY_CONFIG);

    expect(sample.rawScore).toBe(26);
    expect(sample.intensity).toBeCloseTo(0.4642857142857143, 12);
    expect(sample.smoothed).toBeCloseTo(0.4642857142857143, 12);
    expect(sample.burstiness).toBe(0);
    expect(sample.breakdown).toEqual(
      counts({ playerBullets: 4, enemyBullets: 11, enemies: 6, drops: 1 }),
    );
  });

  it('adds the event-window contribution blended by k_E', () => {
    const state: ActionIntensityState = {
      counts: counts({
        playerBullets: 4,
        enemyBullets: 11,
        enemies: 6,
        drops: 1,
      }),
      events: [
        { type: 'enemy_killed', at: 1 },
        { type: 'powerup_collected', at: 1.5 },
      ],
    };

    const sample = computeActionIntensity(state, DEFAULT_ACTION_INTENSITY_CONFIG);

    // P = 26; E = 2 + 1 = 3; R = 26 + 1·3 = 29
    expect(sample.rawScore).toBe(29);
    expect(sample.intensity).toBeCloseTo(0.4915254237288136, 12);
  });

  it('accepts a pre-summed event score from the window accumulator', () => {
    const state: ActionIntensityState = {
      counts: counts({ enemies: 1 }),
      eventScore: 4,
    };

    const sample = computeActionIntensity(state, DEFAULT_ACTION_INTENSITY_CONFIG);

    expect(sample.rawScore).toBe(6); // 2·1 + 1·4
  });

  it('uses zero event contribution for an empty event list', () => {
    const sample = computeActionIntensity(
      { counts: counts({ enemies: 1 }), events: [] },
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(sample.rawScore).toBe(2);
  });

  it('normalises with the saturating hyperbola R/(R+B)', () => {
    const sample = computeActionIntensity(
      { counts: counts({ enemies: 15 }) }, // R = 30
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(sample.rawScore).toBe(30);
    expect(sample.intensity).toBe(0.5);
  });

  it('yields an all-zero sample for an empty screen', () => {
    const sample = computeActionIntensity(
      { counts: counts() },
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(sample.rawScore).toBe(0);
    expect(sample.intensity).toBe(0);
    expect(sample.smoothed).toBe(0);
    expect(sample.burstiness).toBe(0);
  });

  it('starts the EMA at the first intensity (S(0) = intensity(0))', () => {
    const sample = computeActionIntensity(
      { counts: counts({ enemies: 3 }) }, // R = 6, I = 6/36
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(sample.smoothed).toBeCloseTo(sample.intensity, 12);
    expect(sample.burstiness).toBeCloseTo(0, 12);
  });

  it('smooths towards the previous EMA on subsequent samples', () => {
    const sample = computeActionIntensity(
      { counts: counts({ enemies: 6 }), previousSmoothed: 0.5 }, // R = 12, I = 12/42
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(sample.smoothed).toBeCloseTo(0.4722608349920266, 12);
    expect(sample.burstiness).toBeCloseTo(-0.1865465492777409, 12);
  });

  it('reports positive burstiness for a spike above trend', () => {
    const sample = computeActionIntensity(
      { counts: counts({ enemies: 15 }), previousSmoothed: 0.1 }, // I = 0.5
      DEFAULT_ACTION_INTENSITY_CONFIG,
    );

    expect(sample.burstiness).toBeGreaterThan(0);
    expect(sample.smoothed).toBeLessThan(sample.intensity);
  });

  it('honours custom weights and reference budget', () => {
    const custom: ActionIntensityConfig = {
      ...DEFAULT_ACTION_INTENSITY_CONFIG,
      weights: { ...DEFAULT_ACTION_INTENSITY_CONFIG.weights, enemies: 1 },
      referenceBudget: 10,
    };

    const sample = computeActionIntensity({ counts: counts({ enemies: 10 }) }, custom);

    expect(sample.rawScore).toBe(10);
    expect(sample.intensity).toBe(0.5);
  });

  it('is pure: identical input yields identical output and the input is untouched', () => {
    const state: ActionIntensityState = Object.freeze({
      counts: Object.freeze(counts({ enemies: 2, enemyBullets: 3 })),
    });

    const first = computeActionIntensity(state, DEFAULT_ACTION_INTENSITY_CONFIG);
    const second = computeActionIntensity(state, DEFAULT_ACTION_INTENSITY_CONFIG);

    expect(second).toEqual(first);
    expect(state.counts).toEqual(counts({ enemies: 2, enemyBullets: 3 }));
  });
});

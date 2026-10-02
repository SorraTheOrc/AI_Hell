import { beforeEach, describe, expect, it } from 'vitest';

import { POWER_UP_SPAWN_INTERVAL } from './constants';
import {
  DEFAULT_BEAT_BPM,
  DEFAULT_EXTRA_LIFE_WEIGHT,
  DEFAULT_MINERAL_COLLECT_AMOUNT,
  DEFAULT_MINERAL_HOLD_CAPACITY,
  DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER,
  DEFAULT_MINERAL_REDROP_BONUS_MAX,
  DEFAULT_MINERAL_REDROP_BONUS_MIN,
  DEFAULT_POWER_UP_SPAWN_INTERVAL,
  DEFAULT_RULES,
  DEFAULT_SEQUENCED_WAVES_ENABLED,
  DEFAULT_STANDARD_POWER_UP_WEIGHT,
  DEFAULT_WEAPON_WEIGHT,
  POWER_UP_WEIGHT_IDS,
  RULES_SCHEMA_VERSION,
  RULES_STORAGE_KEY,
  WEAPON_WEIGHT_IDS,
  defaultPowerUpWeights,
  defaultWeaponSubdivisions,
  loadRules,
  saveRules,
  type GameRules,
} from './rules';

describe('game rules configuration module', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // ── AC1: defaults ────────────────────────────────────────────────

  describe('defaults (AC1)', () => {
    it('exposes the 12.5 s default spawn interval', () => {
      expect(DEFAULT_POWER_UP_SPAWN_INTERVAL).toBe(12.5);
      expect(DEFAULT_RULES.powerUpSpawnInterval).toBe(12.5);
    });

    it('contains weights for every power-up ID P3-P9', () => {
      expect(Object.keys(DEFAULT_RULES.powerUpWeights).sort()).toEqual(
        [...POWER_UP_WEIGHT_IDS].sort(),
      );
    });

    it('gives standard IDs equal weight and makes P8 Extra Life rarer', () => {
      const weights = DEFAULT_RULES.powerUpWeights;
      for (const id of POWER_UP_WEIGHT_IDS) {
        if (id === 'P8') continue;
        expect(weights[id]).toBe(DEFAULT_STANDARD_POWER_UP_WEIGHT);
      }
      // AH-0MUNS3VAQ0023L1J: P8 raised from 1 to 3 (≈3× by weight) so Extra
      // Life spawns more often; it remains rarer than a standard drop (4).
      expect(DEFAULT_EXTRA_LIFE_WEIGHT).toBe(3);
      expect(weights.P8).toBe(3);
      expect(defaultPowerUpWeights().P8).toBe(3);
      expect(weights.P8).toBeLessThan(weights.P3);
      // The standard and weapon weights are untouched by the P8 change.
      expect(DEFAULT_STANDARD_POWER_UP_WEIGHT).toBe(4);
      expect(DEFAULT_WEAPON_WEIGHT).toBe(2);
    });

    it('contains weights for every weapon drop (spread/dual/rapid/reset)', () => {
      expect(Object.keys(DEFAULT_RULES.weaponWeights).sort()).toEqual(
        [...WEAPON_WEIGHT_IDS].sort(),
      );
      for (const id of WEAPON_WEIGHT_IDS) {
        expect(DEFAULT_RULES.weaponWeights[id]).toBe(DEFAULT_WEAPON_WEIGHT);
      }
    });
  });

  // ── AC2: load/save persistence and partial merge ─────────────────

  describe('load/save (AC2)', () => {
    it('falls back to defaults when nothing has been saved', () => {
      expect(loadRules()).toEqual(DEFAULT_RULES);
    });

    it('round-trips a saved rules object exactly', () => {
      const custom: GameRules = {
        powerUpSpawnInterval: 5,
        beatBpm: 120,
        weaponSubdivisions: { cannon: 4, spread: 2, dual: 2, rapid: 8, nova: 0.25, mortar: 0.5, arc: 1 },
        powerUpWeights: { P3: 10, P4: 9, P5: 8, P6: 7, P7: 6, P8: 1, P9: 5 },
        weaponWeights: {
          spread: 3,
          dual: 4,
          rapid: 2,
          reset: 1,
        },
        mineralCollectAmount: 2,
        mineralHoldCapacity: 30,
        mineralHoldGrowthMultiplier: 3,
        mineralRedropBonusMin: 0.3,
        mineralRedropBonusMax: 1.5,
        sequencedWavesEnabled: true,
      };
      saveRules(custom);

      const loaded = loadRules();
      expect(loaded).toEqual(custom);
      // Prove the values came from storage, not from the defaults.
      expect(loaded.powerUpSpawnInterval).toBe(5);
      expect(loaded.beatBpm).toBe(120);
      expect(loaded.weaponSubdivisions.cannon).toBe(4);
      expect(loaded.weaponSubdivisions.spread).toBe(2);
      expect(loaded.powerUpWeights.P3).toBe(10);
      expect(loaded.weaponWeights.spread).toBe(3);
      expect(loaded.mineralCollectAmount).toBe(2);
      expect(loaded.mineralHoldCapacity).toBe(30);
      expect(loaded.mineralHoldGrowthMultiplier).toBe(3);
    });

    it('merges a partial weapon weight table over the weapon defaults', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({ weaponWeights: { rapid: 9 } }),
      );

      const loaded = loadRules();
      expect(loaded.weaponWeights.rapid).toBe(9);
      expect(loaded.weaponWeights.spread).toBe(DEFAULT_WEAPON_WEIGHT);
      expect(loaded.weaponWeights.reset).toBe(DEFAULT_WEAPON_WEIGHT);
    });

    it('merges a partial stored config (interval only) over the weight defaults', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({ powerUpSpawnInterval: 3 }),
      );

      const loaded = loadRules();
      expect(loaded.powerUpSpawnInterval).toBe(3);
      expect(loaded.powerUpWeights).toEqual(DEFAULT_RULES.powerUpWeights);
    });

    it('merges a partial weight table over the weight defaults', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({ powerUpWeights: { P8: 7 } }),
      );

      const loaded = loadRules();
      expect(loaded.powerUpWeights.P8).toBe(7);
      expect(loaded.powerUpWeights.P3).toBe(DEFAULT_STANDARD_POWER_UP_WEIGHT);
      expect(loaded.powerUpSpawnInterval).toBe(DEFAULT_POWER_UP_SPAWN_INTERVAL);
    });

    it('returns a fresh object each call, so callers cannot mutate the defaults', () => {
      const first = loadRules();
      first.powerUpSpawnInterval = 999;
      first.powerUpWeights.P3 = 999;

      expect(loadRules()).toEqual(DEFAULT_RULES);
    });
  });

  // ── AC3: corrupt input ───────────────────────────────────────────

  describe('corrupt input (AC3)', () => {
    it('falls back to defaults when the stored JSON is corrupt', () => {
      window.localStorage.setItem(RULES_STORAGE_KEY, '{not valid json');

      expect(loadRules()).toEqual(DEFAULT_RULES);
    });

    it('falls back to the default interval when the stored interval is invalid', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({ powerUpSpawnInterval: 'soon' }),
      );

      expect(loadRules().powerUpSpawnInterval).toBe(
        DEFAULT_POWER_UP_SPAWN_INTERVAL,
      );
    });

    it('ignores non-numeric and negative weight entries', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({ powerUpWeights: { P3: 'lots', P8: -2 } }),
      );

      const loaded = loadRules();
      expect(loaded.powerUpWeights.P3).toBe(DEFAULT_STANDARD_POWER_UP_WEIGHT);
      expect(loaded.powerUpWeights.P8).toBe(DEFAULT_EXTRA_LIFE_WEIGHT);
    });
  });

  // ── Beat grid config (AH-0MUAYB8EH005RJ8B AC1/AC2/AC5/AC6) ──────

  describe('beat grid config', () => {
    it('defaults to 80 BPM and the catalogue subdivisions', () => {
      expect(DEFAULT_BEAT_BPM).toBe(80);
      expect(DEFAULT_RULES.beatBpm).toBe(80);
      expect(DEFAULT_RULES.weaponSubdivisions).toEqual({
        cannon: 2,
        spread: 1,
        dual: 1,
        rapid: 6,
        nova: 0.25,
        mortar: 0.5,
        arc: 1,
      });
    });

    it('returns a fresh subdivision table each call', () => {
      const subdivisions = defaultWeaponSubdivisions();
      subdivisions.cannon = 99;
      expect(defaultWeaponSubdivisions().cannon).toBe(2);
    });

    it('loads a stored BPM and subdivision override', () => {
      saveRules({
        ...DEFAULT_RULES,
        beatBpm: 160,
        weaponSubdivisions: { cannon: 4, spread: 2, dual: 2, rapid: 8, nova: 0.25, mortar: 0.5, arc: 1 },
      });

      const loaded = loadRules();
      expect(loaded.beatBpm).toBe(160);
      expect(loaded.weaponSubdivisions).toEqual({
        cannon: 4,
        spread: 2,
        dual: 2,
        rapid: 8,
        nova: 0.25,
        mortar: 0.5,
        arc: 1,
      });
    });

    it('merges a partial subdivision table over the defaults', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({ weaponSubdivisions: { cannon: 4 } }),
      );

      const loaded = loadRules();
      expect(loaded.weaponSubdivisions.cannon).toBe(4);
      expect(loaded.weaponSubdivisions.spread).toBe(1);
      expect(loaded.weaponSubdivisions.rapid).toBe(6);
    });

    it('falls back to the defaults for invalid BPM / non-integer subdivisions', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          beatBpm: 'fast',
          weaponSubdivisions: { cannon: 1.5, spread: 0, dual: -3, rapid: 'lots' },
        }),
      );

      const loaded = loadRules();
      expect(loaded.beatBpm).toBe(DEFAULT_BEAT_BPM);
      expect(loaded.weaponSubdivisions).toEqual({
        cannon: 2,
        spread: 1,
        dual: 1,
        rapid: 6,
        nova: 0.25,
        mortar: 0.5,
        arc: 1,
      });
    });

    it('returns a fresh object so callers cannot mutate the default subdivisions', () => {
      const first = loadRules();
      first.weaponSubdivisions.cannon = 999;
      expect(loadRules().weaponSubdivisions.cannon).toBe(2);
      expect(DEFAULT_RULES.weaponSubdivisions.cannon).toBe(2);
    });
  });

  // ── AC4: single source of truth ──────────────────────────────────

  describe('single source of truth (AC4)', () => {
    it('sources POWER_UP_SPAWN_INTERVAL from DEFAULT_RULES', () => {
      expect(POWER_UP_SPAWN_INTERVAL).toBe(
        DEFAULT_RULES.powerUpSpawnInterval,
      );
      expect(POWER_UP_SPAWN_INTERVAL).toBe(12.5);
    });
  });

  // ── defaultPowerUpWeights ────────────────────────────────────────

  describe('defaultPowerUpWeights', () => {
    it('returns a fresh table each call', () => {
      const weights = defaultPowerUpWeights();
      weights.P8 = 99;

      expect(defaultPowerUpWeights().P8).toBe(DEFAULT_EXTRA_LIFE_WEIGHT);
    });
  });

  // ── Mineral rules (AH-0MUBVGI62004ED9Q) ──────────────────────────

  describe('mineral rules', () => {
    it('exposes the default mineral tunables (AC: sensible defaults)', () => {
      expect(DEFAULT_MINERAL_COLLECT_AMOUNT).toBe(1);
      expect(DEFAULT_MINERAL_HOLD_CAPACITY).toBe(5);
      expect(DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER).toBe(2);
      expect(DEFAULT_MINERAL_REDROP_BONUS_MIN).toBe(0.25);
      expect(DEFAULT_MINERAL_REDROP_BONUS_MAX).toBe(1.25);
      expect(DEFAULT_RULES.mineralCollectAmount).toBe(1);
      expect(DEFAULT_RULES.mineralHoldCapacity).toBe(5);
      expect(DEFAULT_RULES.mineralHoldGrowthMultiplier).toBe(2);
      expect(DEFAULT_RULES.mineralRedropBonusMin).toBe(0.25);
      expect(DEFAULT_RULES.mineralRedropBonusMax).toBe(1.25);
    });

    it('loads mineral tunables from storage when present', () => {
      saveRules({
        ...DEFAULT_RULES,
        mineralCollectAmount: 3,
        mineralHoldCapacity: 50,
        mineralHoldGrowthMultiplier: 4,
        mineralRedropBonusMin: 0.1,
        mineralRedropBonusMax: 1.5,
      });

      const loaded = loadRules();
      expect(loaded.mineralCollectAmount).toBe(3);
      expect(loaded.mineralHoldCapacity).toBe(50);
      expect(loaded.mineralHoldGrowthMultiplier).toBe(4);
      expect(loaded.mineralRedropBonusMin).toBe(0.1);
      expect(loaded.mineralRedropBonusMax).toBe(1.5);
    });

    it('falls back to mineral defaults when the stored values are invalid', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          version: RULES_SCHEMA_VERSION,
          mineralCollectAmount: -4,
          mineralHoldCapacity: 'many',
          mineralHoldGrowthMultiplier: 0,
          mineralRedropBonusMin: -1,
          mineralRedropBonusMax: 'half',
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralCollectAmount).toBe(DEFAULT_MINERAL_COLLECT_AMOUNT);
      expect(loaded.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
      expect(loaded.mineralHoldGrowthMultiplier).toBe(
        DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER,
      );
      expect(loaded.mineralRedropBonusMin).toBe(
        DEFAULT_MINERAL_REDROP_BONUS_MIN,
      );
      expect(loaded.mineralRedropBonusMax).toBe(
        DEFAULT_MINERAL_REDROP_BONUS_MAX,
      );
    });

    it('accepts a zero bonus and a bonus above 1 (non-negative coercion)', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          version: RULES_SCHEMA_VERSION,
          mineralRedropBonusMin: 0,
          mineralRedropBonusMax: 2.5,
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralRedropBonusMin).toBe(0);
      expect(loaded.mineralRedropBonusMax).toBe(2.5);
    });

    it('falls back to the bonus defaults for a non-numeric stored value', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          version: RULES_SCHEMA_VERSION,
          mineralRedropBonusMin: null,
          mineralRedropBonusMax: 'many',
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralRedropBonusMin).toBe(
        DEFAULT_MINERAL_REDROP_BONUS_MIN,
      );
      expect(loaded.mineralRedropBonusMax).toBe(
        DEFAULT_MINERAL_REDROP_BONUS_MAX,
      );
    });

    it('resets the bonus tunables for legacy v1/v2 configs and drops stale fraction keys', () => {
      for (const version of [1, 2, undefined] as const) {
        window.localStorage.clear();
        window.localStorage.setItem(
          RULES_STORAGE_KEY,
          JSON.stringify({
            version,
            mineralRedropFractionMin: 0.1,
            mineralRedropFractionMax: 0.9,
            mineralRedropBonusMin: 0.05,
            mineralRedropBonusMax: 0.06,
          }),
        );

        const loaded = loadRules();
        expect(loaded.mineralRedropBonusMin).toBe(
          DEFAULT_MINERAL_REDROP_BONUS_MIN,
        );
        expect(loaded.mineralRedropBonusMax).toBe(
          DEFAULT_MINERAL_REDROP_BONUS_MAX,
        );
        // The renamed keys must not survive the migration.
        expect(
          'mineralRedropFractionMin' in loaded,
        ).toBe(false);
        expect(
          'mineralRedropFractionMax' in loaded,
        ).toBe(false);
      }
    });

    it('preserves customised hold tunables in a v2 config while resetting the bonus', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          mineralHoldCapacity: 7,
          mineralHoldGrowthMultiplier: 3,
          mineralRedropFractionMin: 0.2,
          mineralRedropFractionMax: 0.7,
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralHoldCapacity).toBe(7);
      expect(loaded.mineralHoldGrowthMultiplier).toBe(3);
      expect(loaded.mineralRedropBonusMin).toBe(
        DEFAULT_MINERAL_REDROP_BONUS_MIN,
      );
      expect(loaded.mineralRedropBonusMax).toBe(
        DEFAULT_MINERAL_REDROP_BONUS_MAX,
      );
    });

    it('honours customised bonus tunables in a current-schema config', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          version: RULES_SCHEMA_VERSION,
          mineralRedropBonusMin: 0.5,
          mineralRedropBonusMax: 2.5,
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralRedropBonusMin).toBe(0.5);
      expect(loaded.mineralRedropBonusMax).toBe(2.5);
    });

    it('migrates a legacy (unversioned) config to the new hold progression', () => {
      // Version-1 configs stored a *fixed* capacity (20). Resetting it to
      // the first-hold default is the sensible migration: the semantic
      // changed from fixed capacity to first-hold capacity.
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          powerUpSpawnInterval: 7,
          mineralHoldCapacity: 20,
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralHoldCapacity).toBe(5);
      expect(loaded.mineralHoldGrowthMultiplier).toBe(2);
      // Other rules survive the migration untouched.
      expect(loaded.powerUpSpawnInterval).toBe(7);
    });

    it('honours a customised capacity in a current-schema config', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          version: RULES_SCHEMA_VERSION,
          mineralHoldCapacity: 7,
          mineralHoldGrowthMultiplier: 3,
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralHoldCapacity).toBe(7);
      expect(loaded.mineralHoldGrowthMultiplier).toBe(3);
    });

    it('falls back to mineral defaults when the stored JSON is corrupt', () => {
      window.localStorage.setItem(RULES_STORAGE_KEY, '{not valid json');

      const loaded = loadRules();
      expect(loaded.mineralCollectAmount).toBe(DEFAULT_MINERAL_COLLECT_AMOUNT);
      expect(loaded.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    });
  });
});

// ── Sequenced-waves opt-in toggle (AH-0MUITS1SM008GPR9) ─────────────

describe('sequenced-waves opt-in toggle (AH-0MUITS1SM008GPR9)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults to enabled — the shipped campaign is sequenced (AH-0MUJSUTLA006Q8E1)', () => {
    expect(DEFAULT_SEQUENCED_WAVES_ENABLED).toBe(true);
    expect(DEFAULT_RULES.sequencedWavesEnabled).toBe(true);
    expect(loadRules().sequencedWavesEnabled).toBe(true);
  });

  it('loads a stored true value', () => {
    window.localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: true }),
    );
    expect(loadRules().sequencedWavesEnabled).toBe(true);
  });

  it('loads a stored false value', () => {
    window.localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: false }),
    );
    expect(loadRules().sequencedWavesEnabled).toBe(false);
  });

  it('coerces a non-boolean stored value to the enabled default', () => {
    window.localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ sequencedWavesEnabled: 'true' }),
    );
    expect(loadRules().sequencedWavesEnabled).toBe(true);
  });

  it('round-trips the toggle through saveRules', () => {
    saveRules({ ...DEFAULT_RULES, sequencedWavesEnabled: true });
    expect(loadRules().sequencedWavesEnabled).toBe(true);
  });

  it('returns a fresh copy so mutating it does not change the defaults', () => {
    const loaded = loadRules();
    loaded.sequencedWavesEnabled = false;
    expect(DEFAULT_RULES.sequencedWavesEnabled).toBe(true);
    expect(loadRules().sequencedWavesEnabled).toBe(true);
  });
});

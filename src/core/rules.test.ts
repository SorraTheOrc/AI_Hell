import { beforeEach, describe, expect, it } from 'vitest';

import { POWER_UP_SPAWN_INTERVAL } from './constants';
import {
  DEFAULT_EXTRA_LIFE_WEIGHT,
  DEFAULT_MINERAL_COLLECT_AMOUNT,
  DEFAULT_MINERAL_HOLD_CAPACITY,
  DEFAULT_MINERAL_REDROP_FRACTION_MAX,
  DEFAULT_MINERAL_REDROP_FRACTION_MIN,
  DEFAULT_POWER_UP_SPAWN_INTERVAL,
  DEFAULT_RULES,
  DEFAULT_STANDARD_POWER_UP_WEIGHT,
  DEFAULT_WEAPON_WEIGHT,
  POWER_UP_WEIGHT_IDS,
  RULES_STORAGE_KEY,
  WEAPON_WEIGHT_IDS,
  defaultPowerUpWeights,
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
      expect(weights.P8).toBe(DEFAULT_EXTRA_LIFE_WEIGHT);
      expect(weights.P8).toBeLessThan(weights.P3);
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
        powerUpWeights: { P3: 10, P4: 9, P5: 8, P6: 7, P7: 6, P8: 1, P9: 5 },
        weaponWeights: {
          spread: 3,
          dual: 4,
          rapid: 2,
          reset: 1,
        },
        mineralCollectAmount: 2,
        mineralHoldCapacity: 30,
        mineralRedropFractionMin: 0.3,
        mineralRedropFractionMax: 0.6,
      };
      saveRules(custom);

      const loaded = loadRules();
      expect(loaded).toEqual(custom);
      // Prove the values came from storage, not from the defaults.
      expect(loaded.powerUpSpawnInterval).toBe(5);
      expect(loaded.powerUpWeights.P3).toBe(10);
      expect(loaded.weaponWeights.spread).toBe(3);
      expect(loaded.mineralCollectAmount).toBe(2);
      expect(loaded.mineralHoldCapacity).toBe(30);
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
      expect(DEFAULT_MINERAL_HOLD_CAPACITY).toBe(20);
      expect(DEFAULT_MINERAL_REDROP_FRACTION_MIN).toBe(0.25);
      expect(DEFAULT_MINERAL_REDROP_FRACTION_MAX).toBe(0.5);
      expect(DEFAULT_RULES.mineralCollectAmount).toBe(1);
      expect(DEFAULT_RULES.mineralHoldCapacity).toBe(20);
      expect(DEFAULT_RULES.mineralRedropFractionMin).toBe(0.25);
      expect(DEFAULT_RULES.mineralRedropFractionMax).toBe(0.5);
    });

    it('loads mineral tunables from storage when present', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          mineralCollectAmount: 3,
          mineralHoldCapacity: 50,
          mineralRedropFractionMin: 0.1,
          mineralRedropFractionMax: 0.9,
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralCollectAmount).toBe(3);
      expect(loaded.mineralHoldCapacity).toBe(50);
      expect(loaded.mineralRedropFractionMin).toBe(0.1);
      expect(loaded.mineralRedropFractionMax).toBe(0.9);
    });

    it('falls back to mineral defaults when the stored values are invalid', () => {
      window.localStorage.setItem(
        RULES_STORAGE_KEY,
        JSON.stringify({
          mineralCollectAmount: -4,
          mineralHoldCapacity: 'many',
          mineralRedropFractionMin: 2,
          mineralRedropFractionMax: 'half',
        }),
      );

      const loaded = loadRules();
      expect(loaded.mineralCollectAmount).toBe(DEFAULT_MINERAL_COLLECT_AMOUNT);
      expect(loaded.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
      expect(loaded.mineralRedropFractionMin).toBe(
        DEFAULT_MINERAL_REDROP_FRACTION_MIN,
      );
      expect(loaded.mineralRedropFractionMax).toBe(
        DEFAULT_MINERAL_REDROP_FRACTION_MAX,
      );
    });

    it('falls back to mineral defaults when the stored JSON is corrupt', () => {
      window.localStorage.setItem(RULES_STORAGE_KEY, '{not valid json');

      const loaded = loadRules();
      expect(loaded.mineralCollectAmount).toBe(DEFAULT_MINERAL_COLLECT_AMOUNT);
      expect(loaded.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    });
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { POWER_UP_SPAWN_INTERVAL } from './constants';
import {
  DEFAULT_EXTRA_LIFE_WEIGHT,
  DEFAULT_POWER_UP_SPAWN_INTERVAL,
  DEFAULT_RULES,
  DEFAULT_STANDARD_POWER_UP_WEIGHT,
  POWER_UP_WEIGHT_IDS,
  RULES_STORAGE_KEY,
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
      };
      saveRules(custom);

      const loaded = loadRules();
      expect(loaded).toEqual(custom);
      // Prove the values came from storage, not from the defaults.
      expect(loaded.powerUpSpawnInterval).toBe(5);
      expect(loaded.powerUpWeights.P3).toBe(10);
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
});

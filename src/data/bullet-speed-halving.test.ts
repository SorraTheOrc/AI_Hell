/**
 * AH-0MUWZ5GST003NMFQ — enemy bullet-speed halving verification.
 *
 * Asserts that every archetype's `bulletSpeed` in the runtime CSV,
 * `DEFAULT_ENEMY_CONFIGS`, and the per-entity constants was reduced by
 * exactly 50 % relative to its own pre-change baseline, and that the player
 * speed (`PLAYER_BULLET_SPEED`) and every enemy `bulletLifetime` are
 * unchanged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_ENEMY_CONFIGS } from '../core/configDefaults';
import { coerceEnemyConfig, parseCsvRows } from '../core/csv';
import { SCOUT_BULLET_SPEED } from '../entities/Scout';
import { DIVER_BULLET_SPEED } from '../entities/Diver';
import { TANK_BULLET_SPEED } from '../entities/Tank';
import { PHASER_BULLET_SPEED } from '../entities/Phaser';
import { SWARM_BULLET_SPEED } from '../entities/Swarm';
import { BOSS_BULLET_SPEED } from '../entities/Boss';
import { PLAYER_BULLET_SPEED } from '../core/constants';

// ── Pre-change baselines (asserting exactly 50 % reduction) ──────────────
// CSV baseline (the scout row diverges from the defaults pre-change: 180 vs 200).
const csvBase: Record<string, number> = {
  scout: 180,
  diver: 220,
  tank: 150,
  phaser: 180,
  swarm: 180,
  boss: 160,
  asteroid: 100,
  harvester: 100,
};

// DEFAULT_ENEMY_CONFIGS / entity-constant baseline.
const defaultsBase: Record<string, number> = {
  scout: 200,
  diver: 220,
  tank: 150,
  phaser: 180,
  swarm: 180,
  boss: 160,
  asteroid: 100,
  harvester: 100,
};

// ── Lifetime baselines (must be unchanged) ───────────────────────────────
// CSV lifetimes (runtime source of truth)
const csvLifetimes: Record<string, number> = {
  scout: 1.4,
  diver: 1.5,
  tank: 1.5,
  phaser: 1.75,
  swarm: 1.5,
  boss: 0.7,
  asteroid: 1.5,
  harvester: 1.5,
};

// DEFAULT_ENEMY_CONFIGS lifetimes
const defaultsLifetimes: Record<string, number> = {
  scout: 1.5,
  diver: 1.5,
  tank: 2.0,
  phaser: 1.75,
  swarm: 1.5,
  boss: 2.0,
  asteroid: 1.5,
  harvester: 1.5,
};

const keys = Object.keys(csvBase);

function readCsvRows(): Record<string, string>[] {
  const csv = readFileSync(resolve(__dirname, 'enemy-configs.csv'), 'utf8');
  return parseCsvRows(csv);
}

describe('AH-0MUWZ5GST003NMFQ — bullet-speed halving', () => {
  describe('runtime CSV (src/data/enemy-configs.csv)', () => {
    const byKey = Object.fromEntries(readCsvRows().map((r) => [r.key, r]));

    for (const key of keys) {
      it(`${key} bulletSpeed is exactly half the baseline (${csvBase[key]} → ${csvBase[key] / 2})`, () => {
        const coerced = coerceEnemyConfig(byKey[key], DEFAULT_ENEMY_CONFIGS);
        expect(coerced.bulletSpeed).toBe(csvBase[key] / 2);
      });
    }

    it('every enemy bulletLifetime is unchanged', () => {
      for (const key of keys) {
        const coerced = coerceEnemyConfig(byKey[key], DEFAULT_ENEMY_CONFIGS);
        expect(coerced.bulletLifetime, key).toBe(csvLifetimes[key]);
      }
    });
  });

  describe('DEFAULT_ENEMY_CONFIGS', () => {
    for (const key of keys) {
      it(`${key} bulletSpeed is exactly half the baseline (${defaultsBase[key]} → ${defaultsBase[key] / 2})`, () => {
        expect(DEFAULT_ENEMY_CONFIGS[key].bulletSpeed).toBe(defaultsBase[key] / 2);
      });

      it(`${key} bulletLifetime is unchanged`, () => {
        expect(DEFAULT_ENEMY_CONFIGS[key].bulletLifetime).toBe(defaultsLifetimes[key]);
      });
    }
  });

  describe('entity constants', () => {
    it('SCOUT_BULLET_SPEED is halved (200 → 100)', () => {
      expect(SCOUT_BULLET_SPEED).toBe(defaultsBase.scout / 2);
    });
    it('DIVER_BULLET_SPEED is halved (220 → 110)', () => {
      expect(DIVER_BULLET_SPEED).toBe(defaultsBase.diver / 2);
    });
    it('TANK_BULLET_SPEED is halved (150 → 75)', () => {
      expect(TANK_BULLET_SPEED).toBe(defaultsBase.tank / 2);
    });
    it('PHASER_BULLET_SPEED is halved (180 → 90)', () => {
      expect(PHASER_BULLET_SPEED).toBe(defaultsBase.phaser / 2);
    });
    it('SWARM_BULLET_SPEED is halved (180 → 90)', () => {
      expect(SWARM_BULLET_SPEED).toBe(defaultsBase.swarm / 2);
    });
    it('BOSS_BULLET_SPEED is halved (160 → 80)', () => {
      expect(BOSS_BULLET_SPEED).toBe(defaultsBase.boss / 2);
    });
  });

  describe('out-of-scope values are unchanged', () => {
    it('PLAYER_BULLET_SPEED is unchanged (350)', () => {
      expect(PLAYER_BULLET_SPEED).toBe(350);
    });
  });
});

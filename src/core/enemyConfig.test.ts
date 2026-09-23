/**
 * EnemyConfig schema, key helpers, and store-backed loaders
 * (AH-0MTHG51A6003EX9S, epic AH-0MTFP7EIC004F1MN; CSV store AH-0MTZWZ9TE009CVUA).
 *
 * Persistence moved from localStorage to the CSV-backed config store; the
 * store's own behaviour is covered by `configStore.test.ts`. These tests
 * cover the schema and the thin delegating wrappers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  DEFAULT_ENEMY_CONFIGS,
  DEFAULT_ENEMY_KEYS,
  isValidEnemyKey,
  loadAllEnemyConfigs,
  loadEnemyConfig,
  listEnemyConfigKeys,
  sanitizeEnemyKey,
  saveEnemyConfig,
} from './enemyConfig';
import { resetConfigStore, seedConfigStore } from './configStore';

const SEED_KEYS = ['scout', 'diver', 'tank', 'phaser', 'swarm', 'boss', 'asteroid'];

describe('EnemyConfig schema', () => {
  it('DEFAULT_ENEMY_CONFIGS has one entry per seed archetype and the expected keys', () => {
    expect(Object.keys(DEFAULT_ENEMY_CONFIGS).sort()).toEqual(SEED_KEYS.slice().sort());
    expect(DEFAULT_ENEMY_KEYS.slice().sort()).toEqual(SEED_KEYS.slice().sort());
  });

  it('every seed has required fields and valid formationKind / shotPattern', () => {
    for (const config of Object.values(DEFAULT_ENEMY_CONFIGS)) {
      expect(config.key).toBeTruthy();
      expect(config.displayName).toBeTruthy();
      expect(['v', 'diver', 'rect', 'swarm', 'orbital', 'single']).toContain(config.formationKind);
      expect(['none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated']).toContain(config.shotPattern);
      expect(config.count).toBeGreaterThan(0);
      expect(config.size).toBeGreaterThan(0);
      expect(config.fireInterval).toBeGreaterThan(0);
      expect(config.bulletSpeed).toBeGreaterThan(0);
      expect(config.bulletLifetime).toBeGreaterThan(0);
      expect(config.burstCount).toBeGreaterThan(0);
    }
  });

  it('exposes the agreed per-enemy bullet lifetimes (AC3/AC4)', () => {
    expect(DEFAULT_ENEMY_CONFIGS.scout.bulletLifetime).toBe(1.5);
    expect(DEFAULT_ENEMY_CONFIGS.diver.bulletLifetime).toBe(1.5);
    expect(DEFAULT_ENEMY_CONFIGS.tank.bulletLifetime).toBe(2.0);
    expect(DEFAULT_ENEMY_CONFIGS.phaser.bulletLifetime).toBe(1.75);
    expect(DEFAULT_ENEMY_CONFIGS.swarm.bulletLifetime).toBe(1.5);
    expect(DEFAULT_ENEMY_CONFIGS.boss.bulletLifetime).toBe(2.0);
  });

  it('seed colours/bullet tunings mirror the hard-coded entity constants (smoke check)', () => {
    expect(DEFAULT_ENEMY_CONFIGS.scout.color).toBe(0x00ff00);
    expect(DEFAULT_ENEMY_CONFIGS.diver.color).toBe(0xffff00);
    expect(DEFAULT_ENEMY_CONFIGS.tank.color).toBe(0xff6600);
    expect(DEFAULT_ENEMY_CONFIGS.scout.bulletSpeed).toBe(200);
    expect(DEFAULT_ENEMY_CONFIGS.diver.burstCount).toBe(4);
    expect(DEFAULT_ENEMY_CONFIGS.tank.burstCount).toBe(10);
    expect(DEFAULT_ENEMY_CONFIGS.swarm.bulletColor).toBe(0x00ccff);
  });

  it('asteroid seed config is a non-firing single roamer with large-tier defaults', () => {
    const asteroid = DEFAULT_ENEMY_CONFIGS.asteroid;
    expect(asteroid).toBeDefined();
    expect(asteroid.displayName).toBe('Asteroid');
    expect(asteroid.formationKind).toBe('single');
    expect(asteroid.count).toBe(1);
    expect(asteroid.size).toBe(42);
    expect(asteroid.color).toBe(0x888888);
    expect(asteroid.shotPattern).toBe('none');
  });

  it('every seed supplies a shotProbability fraction (AC1: swarm 0.25, others 1.0)', () => {
    for (const config of Object.values(DEFAULT_ENEMY_CONFIGS)) {
      expect(typeof config.shotProbability).toBe('number');
      expect(config.shotProbability).toBeGreaterThanOrEqual(0);
      expect(config.shotProbability).toBeLessThanOrEqual(1);
    }
    expect(DEFAULT_ENEMY_CONFIGS.swarm.shotProbability).toBe(0.25);
    for (const key of ['scout', 'diver', 'tank', 'phaser', 'boss']) {
      expect(DEFAULT_ENEMY_CONFIGS[key].shotProbability).toBe(1.0);
    }
  });

  it('extra/open passthrough: unknown fields are allowed (forward-compat)', () => {
    const extended = { ...DEFAULT_ENEMY_CONFIGS.scout, wiggleAmplitude: 3 } as typeof DEFAULT_ENEMY_CONFIGS.scout & { wiggleAmplitude: number };
    expect((extended as Record<string, unknown>).wiggleAmplitude).toBe(3);
  });
});

describe('sanitizeEnemyKey / isValidEnemyKey', () => {
  it('sanitizes names to a valid slug', () => {
    expect(sanitizeEnemyKey('My New Enemy!')).toBe('my-new-enemy');
    expect(sanitizeEnemyKey('  Weird__Name  ')).toBe('weird-name');
    expect(sanitizeEnemyKey('UPPER')).toBe('upper');
  });

  it('collapses repeated hyphens and trims trailing hyphens after truncation', () => {
    const long = 'a'.repeat(50);
    const slug = sanitizeEnemyKey(long);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(isValidEnemyKey(slug)).toBe(true);
  });

  it('isValidEnemyKey rejects empty, too-long, or non-slug keys', () => {
    expect(isValidEnemyKey('')).toBe(false);
    expect(isValidEnemyKey('has space')).toBe(false);
    expect(isValidEnemyKey('UPPER')).toBe(false);
    expect(isValidEnemyKey('a'.repeat(41))).toBe(false);
    expect(isValidEnemyKey('valid-key')).toBe(true);
  });
});

describe('Store-backed loaders', () => {
  beforeEach(() => {
    resetConfigStore();
  });

  it('loadEnemyConfig returns seed defaults when the registry is empty', () => {
    expect(loadEnemyConfig('scout')).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
  });

  it('loadEnemyConfig returns a sensible fallback for an unknown key (no seed)', () => {
    const cfg = loadEnemyConfig('brand-new-enemy');
    expect(cfg.key).toBe('brand-new-enemy');
    expect(cfg.displayName).toBe('brand-new-enemy');
    expect(cfg.formationKind).toBeTruthy();
    expect(cfg.count).not.toBeNaN();
  });

  it('loadEnemyConfig serves the tuned value from the seeded registry', () => {
    seedConfigStore([{ ...DEFAULT_ENEMY_CONFIGS.scout, count: 9, driftSpeed: 77 }]);
    const loaded = loadEnemyConfig('scout');
    expect(loaded.count).toBe(9);
    expect(loaded.driftSpeed).toBe(77);
  });

  it('loadEnemyConfig returns copies so callers cannot mutate the registry', () => {
    seedConfigStore([{ ...DEFAULT_ENEMY_CONFIGS.scout, count: 9 }]);
    const first = loadEnemyConfig('scout');
    first.count = 1;
    expect(loadEnemyConfig('scout').count).toBe(9);
  });

  it('the generic fallback config for a key with no seed defaults shotProbability to 1.0', () => {
    expect(loadEnemyConfig('no-such-enemy').shotProbability).toBe(1.0);
  });

  it('listEnemyConfigKeys returns the seed set plus any seeded custom key', () => {
    expect(listEnemyConfigKeys().sort()).toEqual(SEED_KEYS.sort());
    seedConfigStore([...Object.values(DEFAULT_ENEMY_CONFIGS), { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'custom-one', displayName: 'Custom One' }]);
    expect(listEnemyConfigKeys()).toContain('custom-one');
  });

  it('loadAllEnemyConfigs loads every key returned by listEnemyConfigKeys', () => {
    seedConfigStore(Object.values(DEFAULT_ENEMY_CONFIGS));
    const all = loadAllEnemyConfigs();
    expect(new Set(all.map((c) => c.key))).toEqual(new Set(listEnemyConfigKeys()));
  });

  it('saveEnemyConfig delegates to the store and reports unavailability in production', async () => {
    vi.stubEnv('DEV', false);
    const result = await saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, count: 42 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    vi.unstubAllEnvs();
  });
});

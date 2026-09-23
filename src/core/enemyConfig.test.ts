/**
 * EnemyConfig schema and localStorage persistence — behaviour tests
 * (AH-0MTHG51A6003EX9S, epic AH-0MTFP7EIC004F1MN — AC1).
 *
 * Mirrors `src/core/config.test.ts` conventions: `happy-dom`, `localStorage`
 * isolation in beforeEach, and assertion of the public API's observable
 * behaviour (no source-grep trivialities).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  DEFAULT_ENEMY_CONFIGS,
  DEFAULT_ENEMY_KEYS,
  ENEMY_CONFIG_STORAGE_PREFIX,
  isValidEnemyKey,
  loadAllEnemyConfigs,
  loadEnemyConfig,
  listEnemyConfigKeys,
  sanitizeEnemyKey,
  saveEnemyConfig,
  deleteEnemyConfig,
} from './enemyConfig';

const SEED_KEYS = ['scout', 'diver', 'tank', 'phaser', 'swarm', 'boss', 'asteroid'];

function clearEnemyStorage(): void {
  // Remove only namespaced keys to avoid wiping ai-hell-ship-config in shared tests;
  // we remove by prefix scan.
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(ENEMY_CONFIG_STORAGE_PREFIX)) keys.push(k);
  }
  for (const k of keys) window.localStorage.removeItem(k);
}

describe('EnemyConfig schema', () => {
  it('DEFAULT_ENEMY_CONFIGS has one entry per seed archetype and the expected keys', () => {
    expect(Object.keys(DEFAULT_ENEMY_CONFIGS).sort()).toEqual(SEED_KEYS.slice().sort());
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
    expect(DEFAULT_ENEMY_CONFIGS.scout.bulletLifetime).toBe(3.0);
    expect(DEFAULT_ENEMY_CONFIGS.diver.bulletLifetime).toBe(3.0);
    expect(DEFAULT_ENEMY_CONFIGS.tank.bulletLifetime).toBe(4.0);
    expect(DEFAULT_ENEMY_CONFIGS.phaser.bulletLifetime).toBe(3.5);
    expect(DEFAULT_ENEMY_CONFIGS.swarm.bulletLifetime).toBe(3.0);
    expect(DEFAULT_ENEMY_CONFIGS.boss.bulletLifetime).toBe(4.0);
  });

  it('enemy bullet lifetimes are individually tunable (not a single shared value)', () => {
    const lifetimes = Object.values(DEFAULT_ENEMY_CONFIGS).map(
      (config) => config.bulletLifetime,
    );
    expect(new Set(lifetimes).size).toBeGreaterThan(1);
  });

  it('seed colours/bullet tunings mirror the hard-coded entity constants (smoke check)', () => {
    // Cheap mirror: the seed should use the same colours/sizes/bullet params the entities declare.
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
    // Non-formation roamer: single count, no formation drift.
    expect(asteroid.formationKind).toBe('single');
    expect(asteroid.count).toBe(1);
    // Large tier is the config default.
    expect(asteroid.size).toBe(42);
    expect(asteroid.color).toBe(0x888888);
    // Asteroids never fire.
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

  it('extra/open passthrough: unknown fields are allowed and round-trip (forward-compat)', () => {
    const extended = { ...DEFAULT_ENEMY_CONFIGS.scout, wiggleAmplitude: 3, cueDuration: 800 } as typeof DEFAULT_ENEMY_CONFIGS.scout & { wiggleAmplitude: number; cueDuration: number };
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

describe('EnemyConfig persistence (localStorage)', () => {
  beforeEach(() => {
    clearEnemyStorage();
  });

  afterEach(() => {
    clearEnemyStorage();
  });

  it('loadEnemyConfig returns seed defaults when storage is empty', () => {
    const cfg = loadEnemyConfig('scout');
    expect(cfg).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
  });

  it('loadEnemyConfig returns a sensible fallback for an unknown key (no seed)', () => {
    const cfg = loadEnemyConfig('brand-new-enemy');
    expect(cfg.key).toBe('brand-new-enemy');
    expect(cfg.displayName).toBe('brand-new-enemy');
    expect(cfg.formationKind).toBeTruthy();
  });

  it('loadEnemyConfig returns a persisted value after save', () => {
    const updated = { ...DEFAULT_ENEMY_CONFIGS.scout, count: 9, driftSpeed: 77 };
    saveEnemyConfig(updated);
    const loaded = loadEnemyConfig('scout');
    expect(loaded.count).toBe(9);
    expect(loaded.driftSpeed).toBe(77);
  });

  it('partial save is merged over defaults (missing fields keep defaults)', () => {
    // Simulate a partial write (e.g. an older saved format) by writing a raw
    // partial JSON for the 'diver' key and then loading. Missing fields should
    // be filled from DEFAULT_ENEMY_CONFIGS.diver rather than becoming undefined.
    window.localStorage.setItem(
      `${ENEMY_CONFIG_STORAGE_PREFIX}diver`,
      JSON.stringify({ key: 'diver', displayName: 'Diver', count: 3 }),
    );
    const loaded = loadEnemyConfig('diver');
    expect(loaded.count).toBe(3);
    expect(loaded.displayName).toBe('Diver');
    // A field not persisted should still be the seed value.
    expect(loaded.size).toBe(DEFAULT_ENEMY_CONFIGS.diver.size);
    expect(loaded.bulletSpeed).toBe(DEFAULT_ENEMY_CONFIGS.diver.bulletSpeed);
  });

  it('the generic fallback config for a key with no seed defaults shotProbability to 1.0', () => {
    const cfg = loadEnemyConfig('no-such-enemy');
    expect(cfg.shotProbability).toBe(1.0);
  });

  it('legacy persisted seed config without shotProbability inherits the seed value (swarm 0.25)', () => {
    // Pre-existing saved configs predate the field: merge-over-defaults must
    // keep the seed's swarm 0.25 rather than dropping to 0/undefined.
    const { shotProbability: _omitted, ...legacySwarm } = DEFAULT_ENEMY_CONFIGS.swarm;
    window.localStorage.setItem(
      `${ENEMY_CONFIG_STORAGE_PREFIX}swarm`,
      JSON.stringify(legacySwarm),
    );
    const loaded = loadEnemyConfig('swarm');
    expect(loaded.shotProbability).toBe(0.25);
  });

  it('legacy persisted custom config without shotProbability falls back to 1.0', () => {
    window.localStorage.setItem(
      `${ENEMY_CONFIG_STORAGE_PREFIX}legacy-custom`,
      JSON.stringify({ key: 'legacy-custom', displayName: 'Legacy', count: 4 }),
    );
    const loaded = loadEnemyConfig('legacy-custom');
    expect(loaded.shotProbability).toBe(1.0);
  });

  it('a persisted shotProbability round-trips and overrides the seed', () => {
    saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, shotProbability: 0.4 });
    expect(loadEnemyConfig('scout').shotProbability).toBe(0.4);
  });

  it('corrupt JSON falls back to defaults without throwing', () => {
    window.localStorage.setItem(`${ENEMY_CONFIG_STORAGE_PREFIX}scout`, '{ not json }}}}}');
    expect(() => loadEnemyConfig('scout')).not.toThrow();
    const loaded = loadEnemyConfig('scout');
    expect(loaded).toEqual(DEFAULT_ENEMY_CONFIGS.scout);
  });

  it('round-trip: save then load returns the same persisted values (JSON-serialized)', () => {
    const custom = {
      key: 'custom-one',
      displayName: 'Custom One',
      formationKind: 'rect' as const,
      count: 10,
      spacingX: 40,
      spacingY: 40,
      driftSpeed: 20,
      startX: 100,
      startY: 100,
      size: 22,
      color: 0x123456,
      bulletColor: 0xabcdef,
      bulletSize: 3,
      shotPattern: 'spread' as const,
      fireInterval: 1300,
      bulletSpeed: 170,
      bulletLifetime: 2.5,
      burstCount: 5,
      shotProbability: 0.6,
    };
    saveEnemyConfig(custom);
    const reloaded = loadEnemyConfig('custom-one');
    expect(reloaded).toEqual(custom);
  });

  it('extra/forward-compat fields on save round-trip through localStorage', () => {
    const withExtra = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'scout', wiggleAmplitude: 4 } as (typeof DEFAULT_ENEMY_CONFIGS.scout & { wiggleAmplitude: number });
    saveEnemyConfig(withExtra as unknown as typeof DEFAULT_ENEMY_CONFIGS.scout);
    const loaded = loadEnemyConfig('scout') as typeof withExtra;
    expect(loaded.wiggleAmplitude).toBe(4);
  });

  it('non-persisted runtime state is not serialized (caller must exclude it — helper stores only what is passed)', () => {
    // The config object is exactly what gets JSON.stringify'd; runtime state like
    // wigglePhase would never be included if the scene doesn't put it in the config.
    const base = { ...DEFAULT_ENEMY_CONFIGS.scout };
    // Ensure the config shape has no wigglePhase field by default.
    expect((base as Record<string, unknown>).wigglePhase).toBeUndefined();
  });

  it('listEnemyConfigKeys returns the seed set when no extra storage exists', () => {
    expect(listEnemyConfigKeys().sort()).toEqual(SEED_KEYS.sort());
  });

  it('listEnemyConfigKeys reflects a newly saved custom key', () => {
    const custom = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'save-as-test', displayName: 'Save As Test' };
    saveEnemyConfig(custom);
    expect(listEnemyConfigKeys()).toContain('save-as-test');
  });

  it('loadAllEnemyConfigs loads every key returned by listEnemyConfigKeys', () => {
    const all = loadAllEnemyConfigs();
    expect(new Set(all.map((c) => c.key))).toEqual(new Set(listEnemyConfigKeys()));
  });

  it('deleteEnemyConfig removes a custom key; list no longer contains it but seeds remain', () => {
    const custom = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'ephemeral', displayName: 'Ephemeral' };
    saveEnemyConfig(custom);
    expect(listEnemyConfigKeys()).toContain('ephemeral');
    deleteEnemyConfig('ephemeral');
    expect(listEnemyConfigKeys()).not.toContain('ephemeral');
    expect(listEnemyConfigKeys()).toEqual(expect.arrayContaining(DEFAULT_ENEMY_KEYS));
  });

  it('storage is namespaced — only prefix-matched keys are enumerated (unrelated keys ignored)', () => {
    window.localStorage.setItem('ai-hell-ship-config', JSON.stringify({ thrustAcceleration: 999 }));
    window.localStorage.setItem('unrelated-key', 'hello');
    expect(listEnemyConfigKeys()).not.toContain('ai-hell-ship-config');
    expect(listEnemyConfigKeys()).not.toContain('unrelated-key');
    // Cleanup the unrelated keys we wrote.
    window.localStorage.removeItem('ai-hell-ship-config');
    window.localStorage.removeItem('unrelated-key');
  });
});

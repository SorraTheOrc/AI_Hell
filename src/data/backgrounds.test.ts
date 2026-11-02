/**
 * Deterministic level→background manifest tests (slice 1 of parent
 * AH-0MVIB7PD50029ZY1; written test-first).
 *
 * The module under test is pure data + pure functions, so this suite runs in
 * the `unit` project (node environment, no Phaser). It pins the contract every
 * later background slice consumes: the pool size/uniqueness/sorting/format of
 * the texture keys, one distinct key per campaign level derived from `LEVELS`,
 * full determinism (call order and module instance), the documented clamp for
 * out-of-range input, and the file-name helpers used by the asset and loader
 * slices.
 */

import { describe, expect, it, vi } from 'vitest';

import { LEVELS } from '../waves/Formations';
import {
  BACKGROUND_ASSET_DIR,
  BACKGROUND_FILE_EXTENSION,
  BACKGROUND_TEXTURE_KEYS,
  CAMPAIGN_LEVEL_COUNT,
  LEVEL_BACKGROUND_KEYS,
  LEVEL_BACKGROUND_MANIFEST,
  backgroundAssetPath,
  backgroundFileName,
  backgroundForLevel,
} from './backgrounds';

/** Canonical `background-<slug>` texture-key shape. */
const TEXTURE_KEY_PATTERN = /^background-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Campaign levels as the game numbers them (1-based). */
const CAMPAIGN_LEVELS = Array.from(
  { length: CAMPAIGN_LEVEL_COUNT },
  (_unused, index) => index + 1,
);

describe('backgrounds — pool of bundled texture keys', () => {
  it('exposes at least 20 keys (epic pool requirement)', () => {
    expect(BACKGROUND_TEXTURE_KEYS.length).toBeGreaterThanOrEqual(20);
  });

  it('has no duplicate keys', () => {
    expect(new Set(BACKGROUND_TEXTURE_KEYS).size).toBe(
      BACKGROUND_TEXTURE_KEYS.length,
    );
  });

  it('uses lowercase `background-<slug>` keys for every entry', () => {
    for (const key of BACKGROUND_TEXTURE_KEYS) {
      expect(key, `texture key "${key}"`).toMatch(TEXTURE_KEY_PATTERN);
      expect(key).toBe(key.toLowerCase());
    }
  });

  it('is sorted ascending so the pool order is stable and reproducible', () => {
    expect([...BACKGROUND_TEXTURE_KEYS]).toEqual(
      [...BACKGROUND_TEXTURE_KEYS].sort(),
    );
  });

  it('is immutable at runtime (readonly data)', () => {
    expect(Object.isFrozen(BACKGROUND_TEXTURE_KEYS)).toBe(true);
    expect(Object.isFrozen(LEVEL_BACKGROUND_KEYS)).toBe(true);
    expect(Object.isFrozen(LEVEL_BACKGROUND_MANIFEST)).toBe(true);
  });
});

describe('backgrounds — campaign level→background manifest', () => {
  it('derives the level count from LEVELS rather than a hard-coded number', () => {
    expect(CAMPAIGN_LEVEL_COUNT).toBe(LEVELS.length);
    expect(LEVEL_BACKGROUND_MANIFEST).toHaveLength(LEVELS.length);
  });

  it('covers every campaign level exactly once, in level order', () => {
    expect(LEVEL_BACKGROUND_MANIFEST.map((entry) => entry.level)).toEqual(
      CAMPAIGN_LEVELS,
    );
  });

  it('records the LEVELS theme name for each level (traceable to LEVELS)', () => {
    for (const entry of LEVEL_BACKGROUND_MANIFEST) {
      expect(entry.themeName).toBe(LEVELS[entry.level - 1].name);
    }
  });

  it('maps every campaign level to a key drawn from the pool', () => {
    const pool = new Set(BACKGROUND_TEXTURE_KEYS);
    for (const entry of LEVEL_BACKGROUND_MANIFEST) {
      expect(pool.has(entry.textureKey), `level ${entry.level}`).toBe(true);
    }
  });

  it('gives each campaign level a distinct background (no repeats)', () => {
    const used = LEVEL_BACKGROUND_MANIFEST.map((entry) => entry.textureKey);
    expect(new Set(used).size).toBe(used.length);
  });

  it('keeps the curated per-level key list at least as long as the campaign', () => {
    expect(LEVEL_BACKGROUND_KEYS.length).toBeGreaterThanOrEqual(LEVELS.length);
    const pool = new Set(BACKGROUND_TEXTURE_KEYS);
    for (const key of LEVEL_BACKGROUND_KEYS) {
      expect(pool.has(key), `curated key "${key}"`).toBe(true);
    }
  });

  it('uses the curated list verbatim for the current campaign', () => {
    expect(LEVEL_BACKGROUND_MANIFEST.map((entry) => entry.textureKey)).toEqual(
      LEVEL_BACKGROUND_KEYS.slice(0, LEVELS.length),
    );
  });
});

describe('backgrounds — backgroundForLevel determinism', () => {
  it('returns the manifest key for every campaign level', () => {
    for (const entry of LEVEL_BACKGROUND_MANIFEST) {
      expect(backgroundForLevel(entry.level)).toBe(entry.textureKey);
    }
  });

  it('returns the same key for repeated calls (same level → same background)', () => {
    for (const level of CAMPAIGN_LEVELS) {
      const first = backgroundForLevel(level);
      const second = backgroundForLevel(level);
      const third = backgroundForLevel(level);
      expect(second).toBe(first);
      expect(third).toBe(first);
    }
  });

  it('is independent of iteration order (reversed and interleaved visits agree)', () => {
    const ascending = new Map(
      CAMPAIGN_LEVELS.map((level) => [level, backgroundForLevel(level)]),
    );

    const reversed = new Map<number, string>();
    for (const level of [...CAMPAIGN_LEVELS].reverse()) {
      reversed.set(level, backgroundForLevel(level));
    }
    expect([...reversed.entries()].sort((a, b) => a[0] - b[0])).toEqual(
      [...ascending.entries()],
    );

    // Interleave both ends of the campaign: 1, N, 2, N-1, …
    const interleaved = new Map<number, string>();
    for (let i = 0; i < CAMPAIGN_LEVELS.length; i += 1) {
      const level =
        i % 2 === 0
          ? CAMPAIGN_LEVELS[i / 2]
          : CAMPAIGN_LEVELS[CAMPAIGN_LEVELS.length - 1 - (i - 1) / 2];
      interleaved.set(level, backgroundForLevel(level));
    }
    expect(interleaved.size).toBe(CAMPAIGN_LEVELS.length);
    for (const level of CAMPAIGN_LEVELS) {
      expect(interleaved.get(level)).toBe(ascending.get(level));
    }
  });

  it('returns the same key from a freshly loaded module instance', async () => {
    const expected = CAMPAIGN_LEVELS.map((level) => backgroundForLevel(level));

    vi.resetModules();
    const reloaded = await import('./backgrounds');

    expect(CAMPAIGN_LEVELS.map((level) => reloaded.backgroundForLevel(level))).toEqual(
      expected,
    );
    expect(reloaded.LEVEL_BACKGROUND_MANIFEST).toEqual(
      LEVEL_BACKGROUND_MANIFEST,
    );
  });

  it('never throws and always returns a member of the pool', () => {
    const pool = new Set(BACKGROUND_TEXTURE_KEYS);
    for (const level of [
      -1000,
      -1,
      0,
      0.5,
      1,
      2.9,
      CAMPAIGN_LEVEL_COUNT,
      CAMPAIGN_LEVEL_COUNT + 1,
      CAMPAIGN_LEVEL_COUNT * 100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const key = backgroundForLevel(level);
      expect(pool.has(key), `level ${level} → ${key}`).toBe(true);
    }
  });
});

describe('backgrounds — documented clamp for out-of-range levels', () => {
  it('clamps levels below the campaign into level 1', () => {
    expect(backgroundForLevel(0)).toBe(backgroundForLevel(1));
    expect(backgroundForLevel(-1)).toBe(backgroundForLevel(1));
    expect(backgroundForLevel(-1000)).toBe(backgroundForLevel(1));
    expect(backgroundForLevel(Number.NEGATIVE_INFINITY)).toBe(
      backgroundForLevel(1),
    );
  });

  it('clamps levels above the campaign into the final level', () => {
    expect(backgroundForLevel(CAMPAIGN_LEVEL_COUNT + 1)).toBe(
      backgroundForLevel(CAMPAIGN_LEVEL_COUNT),
    );
    expect(backgroundForLevel(CAMPAIGN_LEVEL_COUNT * 100)).toBe(
      backgroundForLevel(CAMPAIGN_LEVEL_COUNT),
    );
    expect(backgroundForLevel(Number.POSITIVE_INFINITY)).toBe(
      backgroundForLevel(CAMPAIGN_LEVEL_COUNT),
    );
  });

  it('truncates non-integer levels toward zero before clamping', () => {
    expect(backgroundForLevel(2.9)).toBe(backgroundForLevel(2));
    expect(backgroundForLevel(2.5)).toBe(backgroundForLevel(2));
    expect(backgroundForLevel(0.5)).toBe(backgroundForLevel(1));
    expect(backgroundForLevel(CAMPAIGN_LEVEL_COUNT + 0.9)).toBe(
      backgroundForLevel(CAMPAIGN_LEVEL_COUNT),
    );
  });

  it('treats NaN as the first level (deterministic, never throws)', () => {
    expect(() => backgroundForLevel(Number.NaN)).not.toThrow();
    expect(backgroundForLevel(Number.NaN)).toBe(backgroundForLevel(1));
  });
});

describe('backgrounds — file-name helpers for the asset/loader slices', () => {
  it('derives a `<key>.jpg` file name for every pool key', () => {
    for (const key of BACKGROUND_TEXTURE_KEYS) {
      expect(backgroundFileName(key)).toBe(
        `${key}.${BACKGROUND_FILE_EXTENSION}`,
      );
      expect(backgroundFileName(key)).toMatch(/^background-[a-z0-9-]+\.jpg$/);
    }
  });

  it('derives the public asset path used by the loader', () => {
    expect(BACKGROUND_ASSET_DIR).toBe('assets/backgrounds');
    for (const key of BACKGROUND_TEXTURE_KEYS) {
      expect(backgroundAssetPath(key)).toBe(
        `${BACKGROUND_ASSET_DIR}/${backgroundFileName(key)}`,
      );
    }
    expect(backgroundAssetPath(BACKGROUND_TEXTURE_KEYS[0])).toMatch(
      /^assets\/backgrounds\/background-[a-z0-9-]+\.jpg$/,
    );
  });

  it('exposes a single extension constant the asset slice must match', () => {
    expect(BACKGROUND_FILE_EXTENSION).toBe('jpg');
  });
});

/**
 * Edge-case coverage for range-based spawn positioning
 * (AH-0MUKCLXLW0032R67, child AH-0MUKI7AYU004LZJG).
 *
 * The core happy-path tests live alongside the implementation in
 * `WaveManager.test.ts`; this file focuses on the boundaries the dedicated
 * test task calls out: many seeded draws, RNG domain boundaries, per-group
 * overrides, zero-width bands, RNG/config injection and `WaveManager`
 * threading. No exact-position assertions are made for genuine ranges —
 * only bounds and structural invariants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';
import { resetConfigStore, seedConfigStore } from '../core/configStore';
import type { EnemyConfig } from '../core/configTypes';
import { createSeededRng } from '../test/powerUpTestFixtures';
import type { LevelDefinition, WaveDefinition, WaveGroup } from './Formations';
import { WaveManager, planGroupSpawns } from './WaveManager';

/** A one-enemy single-formation group with optional range overrides. */
function group(overrides: Partial<WaveGroup> = {}): WaveGroup {
  return {
    enemyKey: 'scout',
    formation: 'single',
    count: 1,
    spacingX: 20,
    spacingY: 20,
    startX: 0,
    startY: 0,
    ...overrides,
  };
}

/** Resolver returning the scout seed with the supplied range fields. */
function configWith(
  overrides: Partial<Pick<EnemyConfig, 'startX' | 'startY' | 'startXMin' | 'startXMax' | 'startYMin' | 'startYMax'>>,
): (key: string) => EnemyConfig {
  return () => ({ ...DEFAULT_ENEMY_CONFIGS.scout, ...overrides });
}

function levelWith(waves: WaveDefinition[]): LevelDefinition {
  return { level: 1, name: 'Range Test', waves };
}

describe('planGroupSpawns — range edge cases (AH-0MUKI7AYU004LZJG)', () => {
  it('keeps every one of many seeded draws inside the configured band', () => {
    const cfg = configWith({ startXMin: 100, startXMax: 300, startYMin: 200, startYMax: 400 });
    const rng = createSeededRng(7);
    const xs: number[] = [];
    for (let i = 0; i < 100; i++) {
      const spawns = planGroupSpawns([group()], false, rng, cfg);
      const { startX, startY } = spawns[0];
      expect(startX).toBeGreaterThanOrEqual(100);
      expect(startX).toBeLessThanOrEqual(300);
      expect(startY).toBeGreaterThanOrEqual(200);
      expect(startY).toBeLessThanOrEqual(400);
      xs.push(startX);
    }
    // Genuine randomness: the draws are not all identical.
    expect(new Set(xs).size).toBeGreaterThan(1);
  });

  it('maps the RNG domain endpoints to the inclusive band endpoints', () => {
    const cfg = configWith({ startXMin: 100, startXMax: 300, startYMin: 200, startYMax: 400 });
    expect(planGroupSpawns([group()], false, () => 0, cfg)[0]).toMatchObject({ startX: 100, startY: 200 });
    const nearMax = planGroupSpawns([group()], false, () => 0.999999, cfg)[0];
    expect(nearMax.startX).toBeGreaterThan(299);
    expect(nearMax.startX).toBeLessThanOrEqual(300);
    expect(nearMax.startY).toBeGreaterThan(399);
    expect(nearMax.startY).toBeLessThanOrEqual(400);
  });

  it('normalises a reversed per-group range (min > max)', () => {
    const spawns = planGroupSpawns(
      [group({ startXMin: 900, startXMax: 100, startYMin: 500, startYMax: 300 })],
      false,
      () => 0.5,
      configWith({}),
    );
    expect(spawns[0]).toMatchObject({ startX: 500, startY: 400 });
  });

  it('a zero-width range consumes no randomness (fully deterministic)', () => {
    const rng = vi.fn(() => 0.5);
    const spawns = planGroupSpawns(
      [group({ startXMin: 50, startXMax: 50, startYMin: 60, startYMax: 60 })],
      false,
      rng,
      configWith({}),
    );
    expect(spawns[0]).toMatchObject({ startX: 50, startY: 60 });
    expect(rng).not.toHaveBeenCalled();
  });

  it('uses the injected archetype resolver and never the global store', () => {
    const resolver = vi.fn(
      configWith({ startXMin: 10, startXMax: 20, startYMin: 30, startYMax: 40 }),
    );
    const spawns = planGroupSpawns([group({ enemyKey: 'custom' })], false, () => 0.5, resolver);
    expect(resolver).toHaveBeenCalledWith('custom');
    expect(spawns[0]).toMatchObject({ startX: 15, startY: 35 });
  });
});

describe('WaveManager.planSpawns — RNG threading (AH-0MUKI7AYU004LZJG)', () => {
  beforeEach(() => {
    resetConfigStore();
    // Seed a genuine range so the base is random (not the degenerate default).
    seedConfigStore([
      {
        ...DEFAULT_ENEMY_CONFIGS.scout,
        startX: 100,
        startY: 200,
        startXMin: 100,
        startXMax: 300,
        startYMin: 200,
        startYMax: 400,
      },
    ]);
  });

  afterEach(() => {
    resetConfigStore();
  });

  it('threads the injected RNG into planGroupSpawns', () => {
    const wm = new WaveManager([
      levelWith([{ shootEnabled: false, groups: [group()] }]),
    ]);
    wm.beginGame();
    const spawns = wm.planSpawns(() => 0.5);
    expect(spawns[0]).toMatchObject({ startX: 200, startY: 300 });
  });

  it('is deterministic for the same seeded RNG and varies across seeds', () => {
    const wm = new WaveManager([
      levelWith([{ shootEnabled: false, groups: [group()] }]),
    ]);
    wm.beginGame();
    const a = wm.planSpawns(createSeededRng(1))[0].startX;
    const b = wm.planSpawns(createSeededRng(1))[0].startX;
    const c = wm.planSpawns(createSeededRng(2))[0].startX;
    expect(a).toBe(b);
    // Different seeds produce (almost certainly) different draws.
    expect(c).not.toBe(a);
  });
});

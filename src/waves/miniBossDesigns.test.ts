/**
 * The ten bespoke per-level mini-boss designs (AH-0MVCRBXSS008JSV0) —
 * catalogue integrity and 1:1 level mapping.
 *
 * These assert observable data properties plus the config the shared entity
 * actually receives, so a broken or duplicated design fails here rather than
 * mid-campaign.
 */

import { describe, expect, it } from 'vitest';

import {
  MINI_BOSS_DESIGN_LEVELS,
  MINI_BOSS_DESIGNS,
  miniBossConfigForLevel,
  miniBossDesignForLevel,
} from './miniBossDesigns';
import { resolveMiniBossConfig } from '../entities/MiniBoss';

describe('mini-boss designs — catalogue (AH-0MVCRBXSS008JSV0)', () => {
  it('AC4 — exactly 10 designs map 1:1 to levels 1–10', () => {
    expect(MINI_BOSS_DESIGNS).toHaveLength(MINI_BOSS_DESIGN_LEVELS);
    const levels = MINI_BOSS_DESIGNS.map((design) => design.level).sort(
      (a, b) => a - b,
    );
    expect(levels).toEqual(
      Array.from({ length: MINI_BOSS_DESIGN_LEVELS }, (_, i) => i + 1),
    );
    for (let level = 1; level <= MINI_BOSS_DESIGN_LEVELS; level++) {
      expect(miniBossDesignForLevel(level).level).toBe(level);
    }
  });

  it('AC1 — every design is a distinct named net-new archetype', () => {
    const names = MINI_BOSS_DESIGNS.map((design) => design.archetype);
    expect(new Set(names).size).toBe(MINI_BOSS_DESIGNS.length);
    for (const name of names) {
      expect(name.trim().length).toBeGreaterThan(0);
      // Bespoke alien names, never the generic fallback.
      expect(name).not.toBe('Mini-Boss');
    }
  });

  it('AC2 — every design has a distinct phase/pattern sequence', () => {
    const sequences = MINI_BOSS_DESIGNS.map((design) =>
      design.phases.join('>'),
    );
    expect(new Set(sequences).size).toBe(MINI_BOSS_DESIGNS.length);
    for (const design of MINI_BOSS_DESIGNS) {
      expect(design.phases.length).toBeGreaterThan(0);
      expect(design.hpPerPhase).toBeGreaterThan(0);
    }
  });

  it('AC2 — difficulty escalates with the level and stays below the final boss', () => {
    const pools = MINI_BOSS_DESIGNS.map(
      (design) => design.hpPerPhase * design.phases.length,
    );
    for (let i = 1; i < pools.length; i++) {
      expect(pools[i]).toBeGreaterThan(pools[i - 1]);
    }
    // The campaign peak (level 10) stays under the final boss's 4×50 pool.
    expect(pools[pools.length - 1]).toBeLessThan(4 * 50);
  });

  it('AC2 — minion waves only reference phases the design actually has', () => {
    for (const design of MINI_BOSS_DESIGNS) {
      for (const wave of design.minions ?? []) {
        expect(wave.phase).toBeGreaterThanOrEqual(1);
        expect(wave.phase).toBeLessThanOrEqual(design.phases.length);
        expect(wave.groups.length).toBeGreaterThan(0);
      }
    }
  });

  it('AC3 — every design resolves to a valid MiniBoss config the entity accepts', () => {
    for (const design of MINI_BOSS_DESIGNS) {
      const config = miniBossConfigForLevel(design.level, {
        x: 480,
        y: 190,
        formationOffset: { row: 0, col: 0 },
        rng: () => 0.5,
      });
      const resolved = resolveMiniBossConfig(config);
      expect(resolved.level).toBe(design.level);
      expect(resolved.name).toBe(design.archetype);
      expect(resolved.color).toBe(design.color);
      expect(resolved.hpPerPhase).toBe(design.hpPerPhase);
      expect(resolved.phases.map((phase) => phase.pattern)).toEqual(
        design.phases,
      );
      expect(resolved.minions).toHaveLength(design.minions?.length ?? 0);
    }
  });

  it('the config helper applies the position, RNG and HP override it is given', () => {
    const rng = () => 0.25;
    const config = miniBossConfigForLevel(5, {
      x: 123,
      y: 45,
      formationOffset: { row: 2, col: 3 },
      rng,
      hpPerPhase: 7,
    });
    expect(config.x).toBe(123);
    expect(config.y).toBe(45);
    expect(config.formationOffset).toEqual({ row: 2, col: 3 });
    expect(config.rng).toBe(rng);
    expect(config.hpPerPhase).toBe(7);
  });

  it('an out-of-range level fails loudly instead of silently reusing a design', () => {
    expect(() => miniBossDesignForLevel(0)).toThrow(RangeError);
    expect(() => miniBossDesignForLevel(MINI_BOSS_DESIGN_LEVELS + 1)).toThrow(
      RangeError,
    );
  });
});

/**
 * Formation + shot-pattern registries (AH-0MTHG51UN001ZAZW).
 *
 * Covers: FORMATION_BUILDERS lookup, orbital/single builders, fallback
 * for invalid formationKind, and shot-pattern validation/sanitization.
 */

import { describe, it, expect } from 'vitest';

import {
  FORMATION_BUILDERS,
  getFormationBuilder,
  buildOrbitalPhaseOffsets,
  buildSingleOffset,
  buildVFormationOffsets,
  computeFormationPosition,
} from './formations';
import { sanitizeShotPattern, isValidShotPattern } from './enemyShotPatterns';

describe('FORMATION_BUILDERS registry', () => {
  it('exposes a builder for every EnemyFormationKind', () => {
    const kinds = ['v', 'diver', 'rect', 'swarm', 'orbital', 'single'] as const;
    for (const k of kinds) expect(FORMATION_BUILDERS[k]).toEqual(expect.any(Function));
  });

  it('each builder returns correct count and is side-effect free', () => {
    for (const [kind, builder] of Object.entries(FORMATION_BUILDERS)) {
      const offsets = builder(6);
      // 'single' always 1 regardless of count (single-boss)
      if (kind === 'single') expect(offsets.length).toBe(1);
      else expect(offsets.length).toBe(6);
    }
  });

  it('orbital builder uses phase columns', () => {
    expect(buildOrbitalPhaseOffsets(4)).toEqual([
      { row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }, { row: 0, col: 3 },
    ]);
  });

  it('single builder always returns a single centred offset', () => {
    expect(buildSingleOffset(99)).toEqual([{ row: 0, col: 0 }]);
    expect(buildSingleOffset(0)).toEqual([{ row: 0, col: 0 }]);
  });

  it('getFormationBuilder falls back to V for unknown kinds without throwing', () => {
    expect(getFormationBuilder('unknown')).toBe(buildVFormationOffsets);
    expect(getFormationBuilder('')).toBe(buildVFormationOffsets);
    const offsets = getFormationBuilder('not-a-formation')(6);
    expect(offsets.length).toBe(6);
  });

  it('getFormationBuilder returns the correct builder for valid kinds', () => {
    expect(getFormationBuilder('orbital')).toBe(FORMATION_BUILDERS.orbital);
    expect(getFormationBuilder('v')).toBe(FORMATION_BUILDERS.v);
  });
});

describe('computeFormationPosition (shared base calculation)', () => {
  it('offsets the base position by column × spacingX and row × spacingY', () => {
    const pos = computeFormationPosition(100, 50, { row: 2, col: -1 }, 20, 30);
    expect(pos).toEqual({ x: 100 + -1 * 20, y: 50 + 2 * 30 });
  });

  it('returns the base position unchanged for a zero offset', () => {
    expect(computeFormationPosition(480, 200, { row: 0, col: 0 }, 40, 40)).toEqual({
      x: 480,
      y: 200,
    });
  });

  it('handles negative base positions and fractional offsets', () => {
    const pos = computeFormationPosition(-10, -20, { row: -0.5, col: 1.5 }, 8, 16);
    expect(pos).toEqual({ x: -10 + 1.5 * 8, y: -20 + -0.5 * 16 });
  });
});

describe('shot-pattern helpers', () => {
  it('isValidShotPattern matches the EnemyShotPattern union', () => {
    for (const p of ['none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated']) expect(isValidShotPattern(p)).toBe(true);
    expect(isValidShotPattern('invalid')).toBe(false);
    expect(isValidShotPattern('')).toBe(false);
  });

  it('sanitizeShotPattern returns none for invalid values', () => {
    expect(sanitizeShotPattern('invalid')).toBe('none');
    expect(sanitizeShotPattern('')).toBe('none');
    expect(sanitizeShotPattern('aimed')).toBe('aimed');
  });
});

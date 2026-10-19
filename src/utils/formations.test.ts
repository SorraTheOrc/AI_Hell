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
  buildMarchFormationOffsets,
  buildVFormationOffsets,
  computeFormationPosition,
  computeFormationReanchorDelta,
  computeOrbitalSlot,
  DEFAULT_ORBITAL_FORMATION_COUNT,
  formationSpawnCount,
  orbitalPhaseAngle,
  orbitalPhaseIndex,
} from './formations';
import { sanitizeShotPattern, isValidShotPattern } from './enemyShotPatterns';

describe('FORMATION_BUILDERS registry', () => {
  it('exposes a builder for every EnemyFormationKind', () => {
    const kinds = ['v', 'diver', 'rect', 'swarm', 'orbital', 'single', 'march'] as const;
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

  it('orbital builder uses phase columns and carries the group count', () => {
    expect(buildOrbitalPhaseOffsets(4)).toEqual([
      { row: 0, col: 0, phaseCount: 4 },
      { row: 0, col: 1, phaseCount: 4 },
      { row: 0, col: 2, phaseCount: 4 },
      { row: 0, col: 3, phaseCount: 4 },
    ]);
    // A larger group advertises its actual size so phases spread evenly.
    expect(buildOrbitalPhaseOffsets(12).every((o) => o.phaseCount === 12)).toBe(true);
  });

  it('march builder returns a rectangular block, wider than tall', () => {
    const offsets = buildMarchFormationOffsets(11);
    expect(offsets).toHaveLength(11);
    // One row of 11 centred columns for the classic block.
    expect(new Set(offsets.map((o) => o.row))).toEqual(new Set([0]));
    expect(offsets.map((o) => o.col)).toEqual([
      -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5,
    ]);

    const block = buildMarchFormationOffsets(22);
    expect(block).toHaveLength(22);
    // 11 columns × 2 rows.
    expect(new Set(block.map((o) => o.row))).toEqual(new Set([0, 1]));
  });

  it('single builder always returns a single centred offset', () => {
    expect(buildSingleOffset(99)).toEqual([{ row: 0, col: 0 }]);
    expect(buildSingleOffset(0)).toEqual([{ row: 0, col: 0 }]);
  });

  describe('formationSpawnCount', () => {
    it('reports the number of offsets a builder produces', () => {
      expect(formationSpawnCount('v', 6)).toBe(6);
      expect(formationSpawnCount('rect', 6)).toBe(6);
      expect(formationSpawnCount('orbital', 4)).toBe(4);
    });

    it('reports one for the single formation regardless of declared count', () => {
      expect(formationSpawnCount('single', 1)).toBe(1);
      expect(formationSpawnCount('single', 99)).toBe(1);
      expect(formationSpawnCount('single', 0)).toBe(1);
    });

    it('falls back to the V builder for unknown formation kinds', () => {
      expect(formationSpawnCount('not-a-formation', 5)).toBe(5);
    });
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

describe('computeFormationReanchorDelta (shared Diver re-anchor rule)', () => {
  it('translates the origin so a zero offset lands exactly on the attack end', () => {
    const delta = computeFormationReanchorDelta(
      { offset: { row: 0, col: 0 }, x: 150, y: 90 },
      100,
      50,
      20,
      30,
    );
    expect(delta).toEqual({ dx: 50, dy: 40 });
  });

  it('accounts for the requesting slot when it is offset from the origin', () => {
    // Slot = (100 + -1*20, 50 + 2*30) = (80, 110).
    const delta = computeFormationReanchorDelta(
      { offset: { row: 2, col: -1 }, x: 999, y: 999 },
      100,
      50,
      20,
      30,
    );
    expect(delta).toEqual({ dx: 919, dy: 889 });
  });

  it('applying the delta makes the requesting slot coincide with the attack end', () => {
    const request = { offset: { row: 1, col: 2 }, x: 512, y: 111 };
    const originX = 200;
    const originY = 220;
    const spacingX = 30;
    const spacingY = 26;
    const { dx, dy } = computeFormationReanchorDelta(
      request,
      originX,
      originY,
      spacingX,
      spacingY,
    );
    const slot = computeFormationPosition(
      originX + dx,
      originY + dy,
      request.offset,
      spacingX,
      spacingY,
    );
    expect(slot.x).toBeCloseTo(request.x, 10);
    expect(slot.y).toBeCloseTo(request.y, 10);
  });

  it('is a pure translation: every other unit shifts by the same delta', () => {
    const request = { offset: { row: 0, col: 0 }, x: 480, y: 90 };
    const originX = 240;
    const originY = 243;
    const spacingX = 30;
    const spacingY = 25;
    const { dx, dy } = computeFormationReanchorDelta(
      request,
      originX,
      originY,
      spacingX,
      spacingY,
    );
    // Some other slot on the grid moves by exactly (dx, dy).
    const before = computeFormationPosition(originX, originY, { row: 3, col: -2 }, spacingX, spacingY);
    const after = computeFormationPosition(originX + dx, originY + dy, { row: 3, col: -2 }, spacingX, spacingY);
    expect(after.x - before.x).toBeCloseTo(dx, 10);
    expect(after.y - before.y).toBeCloseTo(dy, 10);
  });
});

describe('orbital geometry (AH-0MVEXVME1004SIIS)', () => {
  it('derives the phase index from the orbital builder offset', () => {
    const offsets = buildOrbitalPhaseOffsets(5);
    expect(offsets.map((o) => orbitalPhaseIndex(o))).toEqual([0, 1, 2, 3, 4]);
  });

  it('N = 4 reproduces the existing square (0°, 90°, 180°, 270°)', () => {
    const phases = [0, 1, 2, 3].map((i) => orbitalPhaseAngle(i, 4));
    expect(phases).toEqual([0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]);
  });

  it.each([4, 5, 12])(
    'distributes N = %i phases evenly across the full turn',
    (count) => {
      const phases = Array.from({ length: count }, (_, i) =>
        orbitalPhaseAngle(i, count),
      );
      // phase_i = i × 2π / count.
      for (let i = 0; i < count; i++) {
        expect(phases[i]).toBeCloseTo((i * Math.PI * 2) / count, 12);
      }
      // Every phase is distinct (mod 2π) — no coincident slots.
      const mod2pi = phases.map((p) => p % (Math.PI * 2));
      expect(new Set(mod2pi.map((p) => p.toFixed(9))).size).toBe(count);
    },
  );

  it('defaults to the four-member square when the count is unknown', () => {
    expect(orbitalPhaseAngle(1)).toBeCloseTo(Math.PI / 2, 12);
    expect(DEFAULT_ORBITAL_FORMATION_COUNT).toBe(4);
  });

  it('clamps a non-positive count to one full-turn phase (never divides by zero)', () => {
    expect(orbitalPhaseAngle(0, 0)).toBe(0);
    expect(Number.isFinite(orbitalPhaseAngle(3, 0))).toBe(true);
  });

  it('computeOrbitalSlot returns the ring point at phase + elapsedAngle', () => {
    // Phase 0, no elapsed → (baseX + radius, baseY).
    expect(computeOrbitalSlot(100, 50, 0, 80)).toEqual({ x: 180, y: 50 });
    // Quarter turn → directly below the base (screen y grows downward).
    const quarter = computeOrbitalSlot(100, 50, Math.PI / 2, 80);
    expect(quarter.x).toBeCloseTo(100, 10);
    expect(quarter.y).toBeCloseTo(130, 10);
    // Elapsed angle advances the orbit by exactly that angle.
    const advanced = computeOrbitalSlot(0, 0, 0, 80, Math.PI / 2);
    expect(advanced.x).toBeCloseTo(0, 10);
    expect(advanced.y).toBeCloseTo(80, 10);
  });

  it('regression — a >4-member group produces no coincident orbital slots', () => {
    const count = 12;
    const slots = Array.from({ length: count }, (_, i) =>
      computeOrbitalSlot(0, 0, orbitalPhaseAngle(i, count), 80),
    );
    const keys = slots.map((s) => `${s.x.toFixed(6)},${s.y.toFixed(6)}`);
    expect(new Set(keys).size).toBe(count);
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

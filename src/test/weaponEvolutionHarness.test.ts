/**
 * Unit tests for the cross-cutting weapon-evolution verification harness
 * (AH-0MWU7BAA0009X1MN; epic AH-0MWL7OWPF003E4TP AC5, AC6, AC9).
 *
 * The suite proves the harness both ways:
 *
 * - **green** against the shipped pairing table and evolved definitions — the
 *   gate the field-tier child must keep satisfied; and
 * - **red** against deliberately broken providers — a denser evolved cadence, a
 *   silent fusion, an off-lattice step, a non-bar tile, a mid-bar morph and a
 *   damage-per-instance upgrade all report their exact rule, so the gate cannot
 *   pass vacuously once the implementation children land.
 *
 * The seeded input trace is pinned here too: one seed always yields one trace,
 * and two seeds yield different traces, so the determinism test in the shared
 * combat-core suite is not comparing two constant runs.
 */

import { describe, expect, it } from 'vitest';

import { beatSubdivisionMs, isOnGrid } from '../utils/beat';
import {
  EVOLVED_WEAPON_IDS,
  WEAPON_PAIRINGS,
  resolveEvolvedWeaponPattern,
} from '../utils/weaponEvolutions';
import type { EuclideanPattern } from '../utils/weaponLevels';
import {
  CADENCE_STEPS_PER_BAR,
  CADENCE_STEPS_PER_BEAT,
  DAMAGE_PARITY_LEVELS,
  EVOLVED_DAMAGE_INSTANCES_PER_ONSET,
  LATTICE_BPMS,
  catalogueInstancesPerOnset,
  checkBarDownbeatMorphs,
  checkBossHitBudget,
  checkDamageParity,
  checkLatticeConformance,
  createSeededFiringInputTrace,
  damageInstancesPerBeat,
  isBarDownbeat,
  nextBarDownbeat,
  onsetsPerBeat,
} from './weaponEvolutionHarness';

/** A 16-step pattern with the shipped 16th-note step. */
function pattern(
  k: number,
  n = 16,
  rotation = 0,
  stepMs = 187.5,
): EuclideanPattern {
  return { k, n, rotation, stepMs };
}

/** The rule ids a verdict reported, for concise assertions. */
function rules(verdict: { violations: readonly { rule: string }[] }): string[] {
  return verdict.violations.map((violation) => violation.rule);
}

describe('cadence units', () => {
  it('counts onsets and damage instances per beat from a pattern', () => {
    expect(CADENCE_STEPS_PER_BEAT).toBe(4);
    expect(CADENCE_STEPS_PER_BAR).toBe(16);
    expect(EVOLVED_DAMAGE_INSTANCES_PER_ONSET).toBe(1);

    // k=2 over a 16-step tile is half an onset per beat.
    expect(onsetsPerBeat(pattern(2))).toBe(0.5);
    expect(onsetsPerBeat(pattern(4))).toBe(1);
    expect(damageInstancesPerBeat(pattern(2))).toBe(0.5);
    expect(damageInstancesPerBeat(pattern(2), 3)).toBe(1.5);

    // An unusable pattern is silent rather than NaN.
    expect(onsetsPerBeat(pattern(0))).toBe(0);
    expect(onsetsPerBeat({ k: 2, n: 0, rotation: 0, stepMs: 187.5 })).toBe(0);
    expect(damageInstancesPerBeat(pattern(2), 0)).toBe(0);
  });

  it('reads the catalogue per-volley bullet count as the halves instance rate', () => {
    // Every catalogue weapon emits at least one bullet per onset…
    for (const pairing of WEAPON_PAIRINGS) {
      for (const baseId of pairing.baseIds) {
        expect(catalogueInstancesPerOnset(baseId)).toBeGreaterThanOrEqual(1);
      }
    }
    // …and a fan weapon's volley is counted, not flattened to one.
    expect(catalogueInstancesPerOnset('spread')).toBeGreaterThan(1);
  });
});

describe('checkDamageParity — no more instances per cadence tick (epic AC5)', () => {
  it('holds for every shipped pairing at every evolution level', () => {
    const result = checkDamageParity();

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
    expect(result.rows).toHaveLength(
      WEAPON_PAIRINGS.length * DAMAGE_PARITY_LEVELS.length,
    );
    for (const row of result.rows) {
      expect(row.holds).toBe(true);
      // Both halves are measured, at their full per-volley bullet count…
      expect(row.halves).toHaveLength(2);
      // …and the fusion never out-fires the two halves it replaces together.
      expect(row.evolvedInstancesPerBeat).toBeLessThanOrEqual(
        row.halfSumInstancesPerBeat + 1e-9,
      );
    }
  });

  it('reports a fusion that emits more instances than both halves as red', () => {
    const result = checkDamageParity({
      evolvedPatternFor: () => pattern(16),
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('damage-parity/evolved-exceeds-halves');
  });

  it('reports a fusion that widens its volley past both halves as red', () => {
    // The evolved cadence keeps its tile, but each onset buys eight
    // projectiles on top of the halves' output — the "fusion as damage
    // upgrade" failure mode.
    const result = checkDamageParity({
      evolvedPatternFor: (evolvedId, level) =>
        densify(resolveEvolvedWeaponPattern(evolvedId, level), 8),
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('damage-parity/evolved-exceeds-halves');
  });

  it('reports a silent fusion as red', () => {
    const result = checkDamageParity({
      evolvedPatternFor: () => pattern(0),
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('damage-parity/evolved-silent');
  });
});

/** Widens a pattern's density by `factor`, keeping it on a 16-step tile. */
function densify(source: EuclideanPattern, factor: number): EuclideanPattern {
  return {
    k: Math.min(source.n, source.k * factor),
    n: source.n,
    rotation: source.rotation,
    stepMs: source.stepMs,
  };
}

describe('checkBossHitBudget — 200 hits at every level (epic AC5)', () => {
  it('holds when the boss pool requires its hits at every evolution level', () => {
    const result = checkBossHitBudget(200);

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
    for (const row of result.rows) {
      expect(row.hitsRequired).toBe(200);
    }
  });

  it('reports a level that buys extra damage per instance as red', () => {
    const result = checkBossHitBudget(
      200,
      DAMAGE_PARITY_LEVELS,
      (level) => (level >= 5 ? 2 : 1),
    );

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('boss/level-changes-hits');
    expect(
      result.rows.find((row) => row.level === 5)?.hitsRequired,
    ).toBe(100);
  });
});

describe('checkLatticeConformance — whole 16th-note onsets (epic AC6)', () => {
  it('holds for every shipped evolution at every level and tempo', () => {
    const result = checkLatticeConformance();

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
    expect(result.rows).toHaveLength(
      EVOLVED_WEAPON_IDS.length *
        DAMAGE_PARITY_LEVELS.length *
        LATTICE_BPMS.length,
    );

    for (const row of result.rows) {
      const sixteenthStepMs = beatSubdivisionMs(
        CADENCE_STEPS_PER_BEAT,
        row.bpm,
      );
      // The step is the shared 16th-note step at this tempo…
      expect(row.pattern.stepMs).toBeCloseTo(sixteenthStepMs, 9);
      // …every onset is a whole 16th-note tick…
      for (const onsetMs of row.onsetTimesMs) {
        expect(isOnGrid(onsetMs, sixteenthStepMs)).toBe(true);
        expect(onsetMs / sixteenthStepMs).toBe(Math.round(onsetMs / sixteenthStepMs));
      }
      // …and a tile is a whole number of bars, so a rung boundary is a bar
      // downbeat.
      expect(row.pattern.n % CADENCE_STEPS_PER_BAR).toBe(0);
    }
  });

  it('reports a cadence off the shared 16th-note step as red', () => {
    const result = checkLatticeConformance({
      evolvedIds: ['chain_ricochet'],
      evolvedPatternFor: () => pattern(2, 16, 0, 200),
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('lattice/step-off-16th');
    expect(rules(result)).toContain('lattice/onset-off-16th');
  });

  it('reports a tile that is not a whole number of bars as red', () => {
    const result = checkLatticeConformance({
      evolvedIds: ['cluster_barrage'],
      // Three onsets over 12 steps: still a Euclidean rhythm on the 16th-note
      // step, but its tile boundary falls two beats in — mid-bar.
      evolvedPatternFor: () => pattern(3, 12, 0),
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('lattice/tile-not-whole-bars');
    expect(rules(result)).not.toContain('lattice/onset-off-16th');
  });

  it('reports a malformed (k, n, rotation) as red', () => {
    const result = checkLatticeConformance({
      evolvedIds: ['fan_escort'],
      evolvedPatternFor: () => pattern(0, 16, 0),
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('lattice/invalid-shape');
  });
});

describe('bar-downbeat morphs (epic AC6)', () => {
  it('quantises a morph to the next bar downbeat, never mid-bar', () => {
    const stepMs = beatSubdivisionMs(CADENCE_STEPS_PER_BEAT); // 187.5 ms
    const barMs = CADENCE_STEPS_PER_BAR * stepMs; // 3000 ms

    expect(nextBarDownbeat(0, stepMs)).toBe(0);
    expect(nextBarDownbeat(1, stepMs)).toBe(barMs);
    expect(nextBarDownbeat(1125, stepMs)).toBe(barMs);
    expect(nextBarDownbeat(barMs, stepMs)).toBe(barMs);
    expect(nextBarDownbeat(barMs + 1, stepMs)).toBe(2 * barMs);

    expect(isBarDownbeat(barMs, stepMs)).toBe(true);
    expect(isBarDownbeat(1125, stepMs)).toBe(false);
  });

  it('holds for the shipped scheduler at every tempo and mid-bar probe', () => {
    const result = checkBarDownbeatMorphs();

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
  });

  it('reports a scheduler that morphs immediately as red', () => {
    const result = checkBarDownbeatMorphs({
      morphAtFor: (timeMs) => timeMs,
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('morph/not-bar-downbeat');
  });

  it('reports a morph scheduled beyond the next bar as red', () => {
    const result = checkBarDownbeatMorphs({
      morphAtFor: (timeMs, stepMs) =>
        nextBarDownbeat(timeMs, stepMs) + CADENCE_STEPS_PER_BAR * stepMs,
    });

    expect(result.holds).toBe(false);
    expect(rules(result)).toContain('morph/beyond-next-bar');
  });
});

describe('createSeededFiringInputTrace — determinism input (epic AC9)', () => {
  it('produces one identical trace for one seed', () => {
    const first = createSeededFiringInputTrace(7, { frames: 40 });
    const second = createSeededFiringInputTrace(7, { frames: 40 });

    expect(second).toEqual(first);
    expect(first.steps).toHaveLength(40);
    expect(first.totalMs).toBe(
      first.steps.reduce((total, step) => total + step.frameMs, 0),
    );
    for (const step of first.steps) {
      expect(step.frameMs).toBeGreaterThanOrEqual(8);
      expect(step.frameMs).toBeLessThanOrEqual(32);
    }
  });

  it('produces a different trace for a different seed', () => {
    const first = createSeededFiringInputTrace(7, {
      frames: 40,
      equipChance: 0.5,
    });
    const second = createSeededFiringInputTrace(8, {
      frames: 40,
      equipChance: 0.5,
    });

    expect(second).not.toEqual(first);
  });

  it('collects weapons deterministically and respects the pool', () => {
    const trace = createSeededFiringInputTrace(3, {
      frames: 60,
      pool: ['ricochet', 'arc'],
      equipChance: 0.5,
    });

    const collected = trace.steps.flatMap((step) => step.equipWeaponIds);
    expect(collected.length).toBeGreaterThan(0);
    for (const weaponId of collected) {
      expect(['ricochet', 'arc']).toContain(weaponId);
    }
  });
});

/**
 * Aggression invariant checker and fixture tests (AH-0MWBBU8LA002OX1Y).
 *
 * Pins the shared definition of a valid ring: conservation, integer bounds and
 * the guaranteed beatable hex, plus the ring-size and adversarial fixtures the
 * redistributing clock's tests will assert through.
 */

import { describe, expect, it } from 'vitest';

import {
  checkRingAggression,
  ringAggressionTotal,
  type HexAggressionMap,
  type RingAggressionRules,
} from './aggressionInvariants';
import {
  AUTHORED_DEFINITIONS,
  aggressionMapOf,
  aggressionScenario,
  authoredBase,
  emptyRing,
  everyHexMax,
  exactlyOneBeatable,
  partialSaveRing,
  runTickSequence,
  SUPPORTED_RING_SIZES,
} from './__fixtures__/aggressionScenarios';

/** Builds rules from an aggression array with sane defaults. */
function makeRules(
  aggressions: readonly number[],
  overrides: Partial<Omit<RingAggressionRules, 'hexes'>> = {},
): RingAggressionRules {
  const hexes: HexAggressionMap = new Map(
    aggressions.map((aggression, index) => [`hex-${index}`, aggression]),
  );
  return {
    hexes,
    budget: overrides.budget ?? ringAggressionTotal(hexes),
    beatableCeiling: overrides.beatableCeiling ?? 3,
    maxAggression: overrides.maxAggression ?? 9,
  };
}

describe('ringAggressionTotal', () => {
  it('sums every hex aggression', () => {
    const hexes = new Map<string, number>([
      ['a', 2],
      ['b', 5],
      ['c', 3],
    ]);
    expect(ringAggressionTotal(hexes)).toBe(10);
  });

  it('returns zero for an empty ring', () => {
    expect(ringAggressionTotal(new Map())).toBe(0);
  });
});

describe('checkRingAggression — valid distributions', () => {
  it('reports no violations for a well-formed distribution', () => {
    expect(checkRingAggression(makeRules([1, 2, 3, 4, 5, 6]))).toHaveLength(0);
  });

  it('accepts every hex at the beatable ceiling', () => {
    const rules = makeRules([3, 3, 3, 3, 3, 3], { beatableCeiling: 3 });
    expect(checkRingAggression(rules)).toHaveLength(0);
  });

  it('accepts a single beatable hex', () => {
    expect(
      checkRingAggression(makeRules([0], { beatableCeiling: 0 })),
    ).toHaveLength(0);
  });
});

describe('checkRingAggression — conservation and budget', () => {
  it('reports a conservation violation when the total exceeds the budget', () => {
    const violations = checkRingAggression(makeRules([2, 2, 2, 2, 2, 2], { budget: 11 }));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('conservation');
    expect(violations[0].hexIds).toHaveLength(6);
  });

  it('reports a conservation violation when the total is below the budget', () => {
    const violations = checkRingAggression(makeRules([1, 1, 1, 1, 1, 1], { budget: 7 }));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('conservation');
  });

  it('reports a budget violation when the budget itself is unusable', () => {
    const violations = checkRingAggression(makeRules([1, 2], { budget: Number.NaN }));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('budget');
  });

  it('does not report conservation when a value is non-finite', () => {
    const violations = checkRingAggression(makeRules([Number.NaN, 2]));
    const rules = violations.map((violation) => violation.rule);
    expect(rules).toContain('bounds');
    expect(rules).not.toContain('conservation');
  });
});

describe('checkRingAggression — bounds and whole numbers', () => {
  it('reports a bounds violation for a negative hex', () => {
    const violations = checkRingAggression(makeRules([-1, 2, 3]));
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('bounds');
    expect(violations[0].hexIds).toEqual(['hex-0']);
  });

  it('reports every negative hex in one bounds violation', () => {
    const violations = checkRingAggression(makeRules([-1, -2, 3]));
    expect(violations).toHaveLength(1);
    expect([...violations[0].hexIds].sort()).toEqual(['hex-0', 'hex-1']);
  });

  it('reports a whole-number violation for a fractional hex', () => {
    const violations = checkRingAggression(makeRules([2.5, 3, 4]));
    const whole = violations.filter((violation) => violation.rule === 'whole-number');
    expect(whole).toHaveLength(1);
    expect(whole[0].hexIds).toEqual(['hex-0']);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('reports a bounds violation for %s', (_name, value) => {
    const violations = checkRingAggression(makeRules([value, 3, 4]));
    const bounds = violations.filter((violation) => violation.rule === 'bounds');
    expect(bounds).toHaveLength(1);
    expect(bounds[0].hexIds).toContain('hex-0');
  });

  it('reports a bounds violation when a hex exceeds maxAggression', () => {
    const violations = checkRingAggression(makeRules([10, 2, 3], { maxAggression: 9 }));
    expect(violations.filter((v) => v.rule === 'bounds')).toHaveLength(1);
  });
});

describe('checkRingAggression — beatable guarantee', () => {
  it('reports a beatable violation when every hex exceeds the ceiling', () => {
    const violations = checkRingAggression(makeRules([4, 5, 6], { beatableCeiling: 3 }));
    const beatable = violations.filter((violation) => violation.rule === 'beatable');
    expect(beatable).toHaveLength(1);
    expect(beatable[0].hexIds).toEqual(['hex-0', 'hex-1', 'hex-2']);
  });

  it('does not report a beatable violation when one hex is at the ceiling', () => {
    const violations = checkRingAggression(makeRules([4, 5, 3], { beatableCeiling: 3 }));
    expect(violations.filter((violation) => violation.rule === 'beatable')).toHaveLength(0);
  });

  it('does not count a corrupt (negative) hex as the beatable hex', () => {
    const violations = checkRingAggression(makeRules([-1, 4, 5], { beatableCeiling: 3 }));
    expect(violations.filter((violation) => violation.rule === 'beatable')).toHaveLength(1);
  });
});

describe('checkRingAggression — purity', () => {
  it('never throws', () => {
    expect(() => checkRingAggression(makeRules([1, 2, 3]))).not.toThrow();
  });

  it('never mutates the input map or rules', () => {
    const hexes = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    const snapshot = new Map(hexes);
    const rules: RingAggressionRules = Object.freeze({
      hexes,
      budget: 3,
      beatableCeiling: 3,
      maxAggression: 9,
    });
    checkRingAggression(rules);
    expect(hexes).toEqual(snapshot);
    expect(rules.hexes).toBe(hexes);
  });

  it('produces at most one violation per rule', () => {
    const violations = checkRingAggression(
      makeRules([-1, 10, 10], { budget: 5, beatableCeiling: 2 }),
    );
    const rules = violations.map((violation) => violation.rule);
    expect(rules.length).toBe(new Set(rules).size);
  });
});

describe('aggression scenarios', () => {
  it.each(SUPPORTED_RING_SIZES)('builds a %i-hex ring', (ringIndex) => {
    const scenario = aggressionScenario(ringIndex);
    expect(scenario.ring.hexes).toHaveLength(ringIndex * 6);
  });

  it('derives ring 1 and ring 2 from the authored definitions', () => {
    for (const ringIndex of [1, 2]) {
      const scenario = aggressionScenario(ringIndex);
      const authored = AUTHORED_DEFINITIONS.filter(
        (definition) => definition.ringIndex === ringIndex,
      );
      const expected = new Map(
        authored.map((definition) => [definition.id, definition.baseAggression]),
      );
      expect(aggressionMapOf(scenario)).toEqual(expected);
    }
  });

  it('provides an authored-base scenario that is valid', () => {
    expect(checkRingAggression(authoredBase(1))).toHaveLength(0);
  });

  it('provides an every-hex-max adversarial scenario', () => {
    const rules = everyHexMax(1);
    expect(Math.max(...rules.hexes.values())).toBe(9);
  });

  it('provides an exactly-one-beatable adversarial scenario', () => {
    const rules = exactlyOneBeatable(1);
    expect(checkRingAggression(rules)).toHaveLength(0);
  });

  it('provides an empty-ring scenario', () => {
    expect(ringAggressionTotal(emptyRing(2).hexes)).toBe(0);
  });

  it('provides a partial-save scenario', () => {
    const rules = partialSaveRing(2);
    expect(rules.hexes.size).toBeLessThan(12);
    expect(checkRingAggression(rules)).toHaveLength(0);
  });
});

describe('runTickSequence', () => {
  it('captures one snapshot per tick and advances the clock', () => {
    const payload = aggressionScenario(1);
    const snapshots = runTickSequence(payload, 3);
    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((snapshot) => snapshot.tick)).toEqual([0, 1, 2]);
    expect(snapshots[2].payload.frontierTick).toBe(3);
  });

  it('never mutates the starting payload', () => {
    const payload = aggressionScenario(1);
    const before = JSON.stringify(payload);
    runTickSequence(payload, 2);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

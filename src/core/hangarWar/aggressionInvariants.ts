/**
 * Ring aggression invariant checker — the single shared definition of a valid
 * ring aggression distribution (AH-0MWBBU8LA002OX1Y, part of **HexMap
 * aggression increases too quickly**).
 *
 * The redistributing frontier clock, the defence report and every test police
 * the same four rules from here rather than restating them:
 *
 * | Rule | Meaning |
 * | --- | --- |
 * | `budget` | The declared budget must itself be a finite, non-negative whole number. |
 * | `bounds` | Every aggression is finite, non-negative and at or below `maxAggression`. |
 * | `whole-number` | Every finite aggression is an integer. |
 * | `conservation` | The aggressions sum exactly to `budget`. |
 * | `beatable` | At least one hex is at or below `beatableCeiling`. |
 *
 * A valid distribution returns an empty array. Each broken rule produces
 * **exactly one** violation record naming the rule and every offending hex, so
 * a test can assert on the rule rather than a formatted string.
 *
 * Purity: the checker never throws, never mutates and reads no clock or
 * storage — corrupt input is reported, never coerced silently.
 *
 * @module src/core/hangarWar/aggressionInvariants
 */

/** A hex id → aggression map (iterated in insertion order, which is stable). */
export type HexAggressionMap = ReadonlyMap<string, number>;

/** The rules a ring's aggression distribution is checked against. */
export interface RingAggressionRules {
  /** Aggression keyed by hex id. */
  readonly hexes: HexAggressionMap;
  /** The expected total aggression for the ring. */
  readonly budget: number;
  /** The highest aggression still regarded as beatable. */
  readonly beatableCeiling: number;
  /** The greatest aggression a single hex may carry. */
  readonly maxAggression: number;
}

/** A rule name that can be violated. */
export type RingAggressionRule =
  | 'conservation'
  | 'bounds'
  | 'whole-number'
  | 'beatable'
  | 'budget';

/** One broken rule and the hex ids responsible for it. */
export interface RingAggressionViolation {
  /** The rule that was broken. */
  readonly rule: RingAggressionRule;
  /** The offending hex ids (`[]` for a `budget` violation). */
  readonly hexIds: readonly string[];
}

/** True when `value` is a finite, non-negative whole number. */
function isWholeCount(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * The single shared sum of a ring's aggressions.
 *
 * Callers use this instead of hand-rolling a loop so the total is computed
 * identically everywhere. Non-finite values are included in the sum (the
 * checker reports them separately); they never throw.
 *
 * @param hexes — the aggression map to sum.
 * @returns the total aggression.
 */
export function ringAggressionTotal(hexes: HexAggressionMap): number {
  let total = 0;
  for (const aggression of hexes.values()) {
    total += aggression;
  }
  return total;
}

/**
 * Checks a ring's aggression distribution against the invariant rules.
 *
 * @param rules — the distribution and the rules to check it against.
 * @returns every violation found (empty when the distribution is valid).
 */
export function checkRingAggression(
  rules: RingAggressionRules,
): readonly RingAggressionViolation[] {
  const violations: RingAggressionViolation[] = [];
  const { hexes, budget, beatableCeiling, maxAggression } = rules;

  // The budget itself must be a usable whole count.
  if (!isWholeCount(budget)) {
    violations.push({ rule: 'budget', hexIds: [] });
  }

  const boundsOffenders: string[] = [];
  const fractionOffenders: string[] = [];
  for (const [hexId, aggression] of hexes) {
    if (!Number.isFinite(aggression) || aggression < 0 || aggression > maxAggression) {
      boundsOffenders.push(hexId);
    } else if (!Number.isInteger(aggression)) {
      fractionOffenders.push(hexId);
    }
  }
  if (boundsOffenders.length > 0) {
    violations.push({ rule: 'bounds', hexIds: boundsOffenders });
  }
  if (fractionOffenders.length > 0) {
    violations.push({ rule: 'whole-number', hexIds: fractionOffenders });
  }

  // Conservation is only meaningful once the budget and every value are usable.
  const allFinite = Array.from(hexes.values()).every((value) =>
    Number.isFinite(value),
  );
  if (isWholeCount(budget) && allFinite && ringAggressionTotal(hexes) !== budget) {
    violations.push({ rule: 'conservation', hexIds: [...hexes.keys()] });
  }

  // At least one hex must be genuinely beatable: a finite aggression in
  // `[0, beatableCeiling]`. Corrupt values do not count as the beatable hex.
  if (hexes.size > 0) {
    const hasBeatable = Array.from(hexes.values()).some(
      (aggression) =>
        Number.isFinite(aggression) &&
        aggression >= 0 &&
        aggression <= beatableCeiling,
    );
    if (!hasBeatable) {
      violations.push({ rule: 'beatable', hexIds: [...hexes.keys()] });
    }
  }

  return violations;
}

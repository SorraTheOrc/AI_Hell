/**
 * Unit tests for the shared auto-target eligibility rule
 * (AH-0MVNSIG1O0049G69, test-first item AH-0MVVHA66X002OM83).
 *
 * Auto-targeting offence (the Arc chain, the Orbital Strike bolt) may pick an
 * enemy, never the inert `asteroid` world hazard. These assert the rule as
 * observable behaviour of the public helpers, with no Phaser scene boot and no
 * geometry involved, so the rule is pinned once for the game and every gym.
 */

import { describe, expect, test } from 'vitest';

import {
  INERT_WORLD_HAZARD_ARCHETYPES,
  MINED_WORLD_HAZARD_ARCHETYPES,
  isEligibleAutoTarget,
  isInertWorldHazard,
  isMinedWorldHazard,
} from './targetEligibility';

/**
 * The minimal candidate shape the rule reads: the `alive` flag and the
 * `archetype` key. `alive` is optional at the type level so gym
 * `TrainingTarget`s and historical stub harnesses stay targetable.
 */
interface Candidate {
  alive?: boolean;
  archetype?: string;
}

/** A live candidate carrying the given archetype (omitted when `undefined`). */
function candidate(archetype?: string): Candidate {
  return archetype === undefined ? {} : { archetype };
}

describe('INERT_WORLD_HAZARD_ARCHETYPES', () => {
  test('AH-0MVVHA66X002OM83 AC1 — lists exactly the asteroid world hazard', () => {
    expect([...INERT_WORLD_HAZARD_ARCHETYPES]).toEqual(['asteroid']);
  });

  test('AH-0MVVHA66X002OM83 AC1 — lane traffic stays targetable', () => {
    expect(INERT_WORLD_HAZARD_ARCHETYPES).not.toContain('lane-traffic');
  });
});

describe('isInertWorldHazard', () => {
  test('AH-0MVVHA66X002OM83 AC1 — the asteroid archetype is the inert hazard', () => {
    expect(isInertWorldHazard('asteroid')).toBe(true);
  });

  test('AH-0MVVHA66X002OM83 AC1 — hostile archetypes are not inert hazards', () => {
    expect(isInertWorldHazard('scout')).toBe(false);
    expect(isInertWorldHazard('lane-traffic')).toBe(false);
  });

  test('AH-0MVVHA66X002OM83 AC1 — an absent archetype is never a hazard', () => {
    expect(isInertWorldHazard(undefined)).toBe(false);
  });
});

describe('isEligibleAutoTarget', () => {
  test('AH-0MVVHA66X002OM83 AC1 — a live enemy is an eligible auto-target', () => {
    expect(isEligibleAutoTarget(candidate('scout'))).toBe(true);
  });

  test('AH-0MVVHA66X002OM83 AC1 — lane traffic stays eligible (Orbital Strike precedent)', () => {
    expect(isEligibleAutoTarget(candidate('lane-traffic'))).toBe(true);
  });

  test('AH-0MVVHA66X002OM83 AC1 — an entity with no archetype stays eligible (gym TrainingTarget)', () => {
    expect(isEligibleAutoTarget(candidate())).toBe(true);
  });

  test('AH-0MVVHA66X002OM83 AC1 — the inert asteroid hazard is never an auto-target', () => {
    expect(isEligibleAutoTarget(candidate('asteroid'))).toBe(false);
  });

  test('AH-0MVVHA66X002OM83 AC1 — a dead enemy is never an auto-target', () => {
    expect(isEligibleAutoTarget({ ...candidate('scout'), alive: false })).toBe(
      false,
    );
  });

  test('AH-0MVVHA66X002OM83 AC1 — a dead asteroid is never an auto-target', () => {
    expect(
      isEligibleAutoTarget({ ...candidate('asteroid'), alive: false }),
    ).toBe(false);
  });

  test('AH-0MVVHA66X002OM83 AC1 — an explicit live flag keeps an enemy eligible', () => {
    expect(isEligibleAutoTarget({ ...candidate('scout'), alive: true })).toBe(
      true,
    );
  });
});

/**
 * The Mining Laser's inverted rule (AH-0MW9QMMOT0014IU0, parent **Mining
 * laser** AH-0MW81181P007BDRU). Auto-targeting offence skips the inert
 * `asteroid` world hazard; the Mining Laser targets **only** that hazard. The
 * two archetype sets are exact inverses, and adding the inverse predicate must
 * leave {@link isEligibleAutoTarget} (Arc chain, Orbital Strike) unchanged.
 */
describe('MINED_WORLD_HAZARD_ARCHETYPES — the Mining Laser inverse rule', () => {
  test('AH-0MW9QMMOT0014IU0 AC6 — lists exactly the asteroid world hazard', () => {
    expect([...MINED_WORLD_HAZARD_ARCHETYPES]).toEqual(['asteroid']);
  });

  test('AH-0MW9QMMOT0014IU0 AC6 — the two rules are exact inverses for every archetype', () => {
    // Same membership today — a change to either list must be a deliberate
    // review decision about how the Mining Laser and auto-targeting offence
    // divide the field.
    expect([...MINED_WORLD_HAZARD_ARCHETYPES]).toEqual([
      ...INERT_WORLD_HAZARD_ARCHETYPES,
    ]);

    for (const archetype of [
      'asteroid',
      'scout',
      'harvester',
      'boss',
      'lane-traffic',
      undefined,
    ]) {
      expect(isMinedWorldHazard(archetype)).toBe(
        isInertWorldHazard(archetype),
      );
    }
  });

  test('AH-0MW9QMMOT0014IU0 AC6 — the asteroid is mined and never an auto-target', () => {
    expect(isInertWorldHazard('asteroid')).toBe(true);
    expect(isMinedWorldHazard('asteroid')).toBe(true);
    expect(isEligibleAutoTarget(candidate('asteroid'))).toBe(false);
  });

  test('AH-0MW9QMMOT0014IU0 AC6 — isEligibleAutoTarget behaviour is unchanged', () => {
    // Arc/Strike keep their rule: live enemies (and untyped gym targets) are
    // eligible, the inert asteroid hazard is not.
    expect(isEligibleAutoTarget(candidate('scout'))).toBe(true);
    expect(isEligibleAutoTarget(candidate('harvester'))).toBe(true);
    expect(isEligibleAutoTarget(candidate('lane-traffic'))).toBe(true);
    expect(isEligibleAutoTarget(candidate())).toBe(true);
    expect(isEligibleAutoTarget(candidate('asteroid'))).toBe(false);
  });

  test('AH-0MW9QMMOT0014IU0 AC6 — hostile archetypes are not mined', () => {
    expect(isMinedWorldHazard('scout')).toBe(false);
    expect(isMinedWorldHazard('lane-traffic')).toBe(false);
    expect(isMinedWorldHazard(undefined)).toBe(false);
  });
});

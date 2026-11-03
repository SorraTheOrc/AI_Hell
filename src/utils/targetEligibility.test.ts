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
  isEligibleAutoTarget,
  isInertWorldHazard,
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

/**
 * Shared Orbital Strike target-rule tests (AH-0MVU3341U001B40T).
 *
 * **REGRESSION (producer rejection, 2026-10-29T15:58Z).** The strike used to
 * take the nearest entry of `getEnemyEntities()`, which includes the
 * non-blocking `asteroid` world hazard — so a rock drifting closer than the
 * nearest enemy absorbed the bolt. The reported symptom was "it fires on
 * asteroids; we want it to fire on the nearest enemy".
 *
 * The rule lives once in `src/scenes/core/strikeTargeting.ts` and is consumed
 * by the shared `CombatScene.onOrbitalStrike`, so `PlayScene` and every gym
 * inherit it. These are pure unit tests of that rule — no scene boot needed.
 *
 * @module scenes/core/strikeTargeting.test
 */

import { describe, expect, it } from 'vitest';

import {
  ORBITAL_STRIKE_EXCLUDED_ARCHETYPES,
  isOrbitalStrikeTarget,
  selectOrbitalStrikeTarget,
  type StrikeTargetEntity,
} from './strikeTargeting';

/** A ship/origin at the arena centre. */
const ORIGIN = { x: 480, y: 270 };

/** Builds a targetable entity with the observable fields the rule reads. */
function entity(
  archetype: string | undefined,
  at: { x: number; y: number },
  alive = true,
): StrikeTargetEntity {
  return archetype === undefined
    ? { alive, ...at }
    : { alive, archetype, ...at };
}

describe('Orbital Strike target rule — nearest enemy (AH-0MVU3341U001B40T)', () => {
  it('selects the live enemy nearest the ship', () => {
    const near = entity('scout', { x: ORIGIN.x + 40, y: ORIGIN.y });
    const far = entity('tank', { x: ORIGIN.x + 220, y: ORIGIN.y });

    expect(selectOrbitalStrikeTarget(ORIGIN, [far, near])).toBe(near);
  });

  it('never selects an asteroid, even when it is the nearest entity', () => {
    const nearerAsteroid = entity('asteroid', { x: ORIGIN.x + 10, y: ORIGIN.y });
    const enemy = entity('scout', { x: ORIGIN.x + 200, y: ORIGIN.y });

    expect(selectOrbitalStrikeTarget(ORIGIN, [nearerAsteroid, enemy])).toBe(
      enemy,
    );
  });

  it('reports no target when the field holds only asteroids', () => {
    const rocks = [
      entity('asteroid', { x: ORIGIN.x + 30, y: ORIGIN.y }),
      entity('asteroid', { x: ORIGIN.x - 60, y: ORIGIN.y + 20 }),
    ];

    expect(selectOrbitalStrikeTarget(ORIGIN, rocks)).toBeNull();
  });

  it('skips dead enemies', () => {
    const dead = entity('scout', { x: ORIGIN.x + 20, y: ORIGIN.y }, false);
    const live = entity('diver', { x: ORIGIN.x + 160, y: ORIGIN.y });

    expect(selectOrbitalStrikeTarget(ORIGIN, [dead, live])).toBe(live);
    expect(isOrbitalStrikeTarget(dead)).toBe(false);
  });

  it('treats an untyped entity as targetable (gym and stub compatibility)', () => {
    const untyped = entity(undefined, { x: ORIGIN.x + 50, y: ORIGIN.y });

    expect(isOrbitalStrikeTarget(untyped)).toBe(true);
    expect(selectOrbitalStrikeTarget(ORIGIN, [untyped])).toBe(untyped);
  });

  it('excludes exactly the asteroid archetype', () => {
    expect(ORBITAL_STRIKE_EXCLUDED_ARCHETYPES).toEqual(['asteroid']);
    // A hostile non-asteroid hazard (lane traffic) is still a valid target.
    expect(
      isOrbitalStrikeTarget(
        entity('lane-traffic', { x: ORIGIN.x + 5, y: ORIGIN.y }),
      ),
    ).toBe(true);
  });
});

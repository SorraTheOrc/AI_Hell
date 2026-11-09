/**
 * Shared Mining Laser target-rule tests (AH-0MW9QMMOT0014IU0, parent
 * **Mining laser** AH-0MW81181P007BDRU).
 *
 * The Mining Laser is the documented **inverse** of the auto-targeting
 * asteroid-skip rule: it may only ever select the inert `asteroid` world
 * hazard, never an enemy, and it picks the nearest one by **wrapped**
 * distance so a rock beyond a screen seam (even one currently off-screen) can
 * be the closest target. When no live asteroid exists it selects nothing — the
 * caller fires no shot.
 *
 * The rule lives once in `src/scenes/core/miningLaserTargeting.ts`, beside the
 * Orbital Strike's `strikeTargeting.ts` sibling, and is consumed by the shared
 * combat core so `PlayScene` and every gym inherit it. These are pure unit
 * tests of that rule — no scene boot needed.
 *
 * @module scenes/core/miningLaserTargeting.test
 */

import { describe, expect, it } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import {
  isEligibleAutoTarget,
  isInertWorldHazard,
  isMinedWorldHazard,
} from '../../utils/targetEligibility';
import {
  isMiningLaserTarget,
  selectMiningLaserTarget,
  type MiningLaserTargetEntity,
} from './miningLaserTargeting';

/** The four-edge wrap model the playfield actually uses. */
const WORLD = { width: GAME_WIDTH, height: GAME_HEIGHT };

/** A ship/origin at the arena centre. */
const ORIGIN = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };

/** Builds a targetable entity with the observable fields the rule reads. */
function entity(
  archetype: string | undefined,
  at: { x: number; y: number },
  alive = true,
): MiningLaserTargetEntity {
  return archetype === undefined
    ? { alive, ...at }
    : { alive, archetype, ...at };
}

/** A live asteroid at the given position (all size tiers share the archetype). */
function asteroid(at: { x: number; y: number }, alive = true) {
  return entity('asteroid', at, alive);
}

describe('Mining Laser target rule — asteroids only (AH-0MW9QMMOT0014IU0)', () => {
  it('AC2/AC3 — a live asteroid of any size tier is eligible', () => {
    // Small, medium and large asteroids all report the same archetype; the
    // rule deliberately has no size/tier notion (any-tier targeting).
    expect(isMiningLaserTarget(asteroid({ x: 10, y: 20 }))).toBe(true);
  });

  it('AC3 — non-asteroid enemies are never eligible', () => {
    for (const archetype of [
      'scout',
      'harvester',
      'boss',
      'lane-traffic',
      'unknown',
    ]) {
      expect(
        isMiningLaserTarget(entity(archetype, { x: 10, y: 20 })),
      ).toBe(false);
    }
    // An entity with no archetype at all is never an asteroid.
    expect(isMiningLaserTarget(entity(undefined, { x: 10, y: 20 }))).toBe(
      false,
    );
  });

  it('AC4 — a dead asteroid is never eligible', () => {
    expect(isMiningLaserTarget(asteroid({ x: 10, y: 20 }, false))).toBe(false);
  });

  it('AC1 — the predicate reads the shared mined-hazard rule', () => {
    for (const archetype of [
      'asteroid',
      'scout',
      'harvester',
      'lane-traffic',
      undefined,
    ]) {
      expect(isMiningLaserTarget(entity(archetype, { x: 0, y: 0 }))).toBe(
        isMinedWorldHazard(archetype),
      );
    }
  });
});

describe('Mining Laser selection — nearest live asteroid (AH-0MW9QMMOT0014IU0)', () => {
  it('AC2 — selects the nearest asteroid among several', () => {
    const near = asteroid({ x: ORIGIN.x + 40, y: ORIGIN.y });
    const far = asteroid({ x: ORIGIN.x + 220, y: ORIGIN.y });

    expect(selectMiningLaserTarget(ORIGIN, [far, near], WORLD)).toBe(near);
  });

  it('AC3 — a nearer non-asteroid enemy is ignored in favour of an asteroid', () => {
    const nearerEnemies = [
      entity('scout', { x: ORIGIN.x + 5, y: ORIGIN.y }),
      entity('harvester', { x: ORIGIN.x + 6, y: ORIGIN.y }),
      entity('boss', { x: ORIGIN.x + 7, y: ORIGIN.y }),
      entity('lane-traffic', { x: ORIGIN.x + 8, y: ORIGIN.y }),
      entity(undefined, { x: ORIGIN.x + 9, y: ORIGIN.y }),
    ];
    const rock = asteroid({ x: ORIGIN.x + 200, y: ORIGIN.y });

    expect(selectMiningLaserTarget(ORIGIN, [...nearerEnemies, rock], WORLD)).toBe(
      rock,
    );
  });

  it('AC4 — skips a dead nearer asteroid in favour of a live farther one', () => {
    const dead = asteroid({ x: ORIGIN.x + 10, y: ORIGIN.y }, false);
    const live = asteroid({ x: ORIGIN.x + 150, y: ORIGIN.y });

    expect(selectMiningLaserTarget(ORIGIN, [dead, live], WORLD)).toBe(live);
  });

  it('AC4 — returns null when every asteroid is dead', () => {
    const rocks = [
      asteroid({ x: ORIGIN.x + 30, y: ORIGIN.y }, false),
      asteroid({ x: ORIGIN.x - 60, y: ORIGIN.y + 20 }, false),
    ];

    expect(selectMiningLaserTarget(ORIGIN, rocks, WORLD)).toBeNull();
  });

  it('AC4 — returns null on an empty field', () => {
    expect(selectMiningLaserTarget(ORIGIN, [], WORLD)).toBeNull();
  });

  it('AC4 — returns null when the field holds only non-asteroid enemies', () => {
    const enemies = [
      entity('scout', { x: ORIGIN.x + 20, y: ORIGIN.y }),
      entity('harvester', { x: ORIGIN.x + 40, y: ORIGIN.y }),
      entity(undefined, { x: ORIGIN.x + 60, y: ORIGIN.y }),
    ];

    expect(selectMiningLaserTarget(ORIGIN, enemies, WORLD)).toBeNull();
  });
});

describe('Mining Laser selection — wrapped distance (AH-0MW9QMMOT0014IU0)', () => {
  it('AC2 — the x seam is crossed: a rock beyond the right edge is nearest', () => {
    const ship = { x: 20, y: GAME_HEIGHT / 2 };
    const acrossSeam = asteroid({ x: 940, y: GAME_HEIGHT / 2 });
    const sameSide = asteroid({ x: 200, y: GAME_HEIGHT / 2 });

    // Raw Euclidean: 920 px vs 180 px. Wrapped: 40 px vs 180 px.
    expect(selectMiningLaserTarget(ship, [sameSide, acrossSeam], WORLD)).toBe(
      acrossSeam,
    );
  });

  it('AC2 — the y seam is crossed: a rock beyond the bottom edge is nearest', () => {
    const ship = { x: GAME_WIDTH / 2, y: 30 };
    const acrossSeam = asteroid({ x: GAME_WIDTH / 2, y: 520 });
    const sameSide = asteroid({ x: GAME_WIDTH / 2, y: 200 });

    // Raw Euclidean: 490 px vs 170 px. Wrapped: 50 px vs 170 px.
    expect(selectMiningLaserTarget(ship, [sameSide, acrossSeam], WORLD)).toBe(
      acrossSeam,
    );
  });

  it('AC2 — both seams are crossed at once (corner wrap)', () => {
    const ship = { x: 20, y: 30 };
    const acrossBoth = asteroid({ x: 940, y: 520 });
    const sameCorner = asteroid({ x: 200, y: 200 });

    expect(
      selectMiningLaserTarget(ship, [sameCorner, acrossBoth], WORLD),
    ).toBe(acrossBoth);
  });

  it('AC2 — an asteroid currently off-screen across a seam can be the nearest', () => {
    const ship = { x: 940, y: GAME_HEIGHT / 2 };
    // Centre 12 px past the left edge (the body is partly off-screen there).
    const offScreen = asteroid({ x: -12, y: GAME_HEIGHT / 2 });
    const onScreen = asteroid({ x: 700, y: GAME_HEIGHT / 2 });

    expect(selectMiningLaserTarget(ship, [onScreen, offScreen], WORLD)).toBe(
      offScreen,
    );
  });

  it('AC2 — omitting the world keeps raw Euclidean distance', () => {
    const ship = { x: 20, y: GAME_HEIGHT / 2 };
    const acrossSeam = asteroid({ x: 940, y: GAME_HEIGHT / 2 });
    const sameSide = asteroid({ x: 200, y: GAME_HEIGHT / 2 });

    expect(selectMiningLaserTarget(ship, [sameSide, acrossSeam])).toBe(
      sameSide,
    );
  });
});

describe('Mining Laser retargeting (AH-0MW9QMMOT0014IU0)', () => {
  it('AC5 — re-running selection after the target dies picks the new nearest', () => {
    const first = asteroid({ x: ORIGIN.x + 40, y: ORIGIN.y });
    const second = asteroid({ x: ORIGIN.x + 120, y: ORIGIN.y });
    const field = [first, second];

    expect(selectMiningLaserTarget(ORIGIN, field, WORLD)).toBe(first);

    // The shot that kills the target marks it dead; the next tick retargets.
    (first as { alive: boolean }).alive = false;

    expect(selectMiningLaserTarget(ORIGIN, field, WORLD)).toBe(second);
  });

  it('AC5 — a freshly spawned split child becomes the new nearest target', () => {
    const parent = asteroid({ x: ORIGIN.x + 80, y: ORIGIN.y });
    const other = asteroid({ x: ORIGIN.x + 300, y: ORIGIN.y });
    const field = [parent, other];

    expect(selectMiningLaserTarget(ORIGIN, field, WORLD)).toBe(parent);

    // Destroying the parent spawns two children near where it broke apart.
    (parent as { alive: boolean }).alive = false;
    const childNear = asteroid({ x: ORIGIN.x + 60, y: ORIGIN.y + 15 });
    const childFar = asteroid({ x: ORIGIN.x + 95, y: ORIGIN.y - 15 });
    field.push(childNear, childFar);

    expect(selectMiningLaserTarget(ORIGIN, field, WORLD)).toBe(childNear);
  });
});

describe('Mining Laser rule is the exact inverse of the auto-target rule (AH-0MW9QMMOT0014IU0)', () => {
  it('AC6 — for live bodies the two rules never both accept or both reject', () => {
    for (const archetype of [
      'asteroid',
      'scout',
      'harvester',
      'boss',
      'lane-traffic',
      undefined,
    ]) {
      const candidate = entity(archetype, { x: 0, y: 0 });
      // The Mining Laser takes exactly what auto-targeting offence skips.
      expect(isMiningLaserTarget(candidate)).toBe(
        !isEligibleAutoTarget(candidate),
      );
      // An asteroid is both the mined hazard and the inert hazard.
      if (archetype === 'asteroid') {
        expect(isInertWorldHazard(archetype)).toBe(true);
        expect(isMinedWorldHazard(archetype)).toBe(true);
      }
    }
  });
});

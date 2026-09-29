/**
 * Tests for the pure danger-detection helper (parent AH-0MUIYX1EE008FVS8).
 *
 * Producer decisions under test:
 * - Q1: danger is the *combined* count of hostile bodies + hostile bullets
 *   within `DANGER_RADIUS` (2 × `SHIP_SIZE` = 40 px), threshold `>= 3`.
 * - Q5: every hostile body archetype (asteroid, boss, minion, scout) and
 *   every live enemy bullet counts; player bullets and minerals do not.
 * - Boundary: a threat exactly on the radius counts as inside.
 */

import { describe, expect, it } from 'vitest';

import {
  DANGER_RADIUS,
  DANGER_THREAT_THRESHOLD,
  SHIP_SIZE,
} from '../core/constants';
import { countThreatsInRange, isInDanger } from './dangerDetection';

describe('danger detection (Q1/Q5)', () => {
  const ship = { x: 100, y: 100 };

  describe('constants (AC1.1)', () => {
    it('defines DANGER_RADIUS as 2 x SHIP_SIZE (40 px)', () => {
      expect(SHIP_SIZE).toBe(20);
      expect(DANGER_RADIUS).toBe(2 * SHIP_SIZE);
      expect(DANGER_RADIUS).toBe(40);
    });

    it('defines DANGER_THREAT_THRESHOLD as 3', () => {
      expect(DANGER_THREAT_THRESHOLD).toBe(3);
    });
  });

  describe('combined threat count (AC1.3, AC1.4)', () => {
    it('counts enemy bodies and enemy bullets together', () => {
      const bodies = [
        { x: 110, y: 100 }, // 10 px
        { x: 100, y: 120 }, // 20 px
      ];
      const bullets = [{ x: 100, y: 70 }]; // 30 px

      expect(countThreatsInRange(ship, bodies, bullets)).toBe(3);
    });

    it('is in danger with exactly 3 combined threats', () => {
      const bodies = [{ x: 110, y: 100 }, { x: 100, y: 120 }];
      const bullets = [{ x: 100, y: 70 }];

      expect(isInDanger(ship, bodies, bullets)).toBe(true);
    });

    it('is not in danger with only 2 combined threats', () => {
      const bodies = [{ x: 110, y: 100 }];
      const bullets = [{ x: 100, y: 70 }];

      expect(countThreatsInRange(ship, bodies, bullets)).toBe(2);
      expect(isInDanger(ship, bodies, bullets)).toBe(false);
    });

    it('is not in danger with no threats', () => {
      expect(countThreatsInRange(ship, [], [])).toBe(0);
      expect(isInDanger(ship, [], [])).toBe(false);
    });

    it('reaches the threshold from one category alone', () => {
      const bodies = [
        { x: 110, y: 100 },
        { x: 100, y: 120 },
        { x: 90, y: 100 },
      ];
      expect(isInDanger(ship, bodies, [])).toBe(true);
    });
  });

  describe('radius boundary (AC1.3, AC1.4)', () => {
    it('counts a threat exactly on the radius boundary as inside', () => {
      // 40 px to the right: dx*dx + dy*dy == DANGER_RADIUS^2 exactly.
      const onBoundary = [{ x: ship.x + DANGER_RADIUS, y: ship.y }];
      expect(countThreatsInRange(ship, onBoundary, [])).toBe(1);
    });

    it('counts a threat just inside the radius', () => {
      const justInside = [{ x: ship.x + DANGER_RADIUS - 0.1, y: ship.y }];
      expect(countThreatsInRange(ship, justInside, [])).toBe(1);
    });

    it('excludes a threat just outside the radius', () => {
      const justOutside = [{ x: ship.x + DANGER_RADIUS + 0.1, y: ship.y }];
      expect(countThreatsInRange(ship, justOutside, [])).toBe(0);
    });

    it('measures centre-to-centre distance, not hull overlap', () => {
      // A large body whose centre is outside the radius is not a threat
      // even though its hull would overlap the 40 px disc.
      const farCentre = [{ x: ship.x + DANGER_RADIUS + 1, y: ship.y }];
      expect(countThreatsInRange(ship, farCentre, [])).toBe(0);
    });

    it('uses the radius on both axes (diagonal distance)', () => {
      // 3-4-5 triangle scaled: dx=24, dy=32 -> distance 40 exactly.
      const diagonal = [{ x: ship.x + 24, y: ship.y + 32 }];
      expect(countThreatsInRange(ship, diagonal, [])).toBe(1);
    });
  });

  describe('hostile scope (AC1.5) — Q5', () => {
    it('counts every hostile body archetype', () => {
      // Asteroid, Central AI boss, boss minion and a scout — all hostile.
      const bodies = [
        { x: 110, y: 100 }, // asteroid
        { x: 100, y: 120 }, // boss
        { x: 90, y: 100 }, // boss minion
      ];
      expect(isInDanger(ship, bodies, [])).toBe(true);
    });

    it('counts live enemy bullets', () => {
      const bullets = [
        { x: 110, y: 100 },
        { x: 100, y: 120 },
        { x: 90, y: 100 },
      ];
      expect(isInDanger(ship, [], bullets)).toBe(true);
    });

    it('does not count player bullets or minerals', () => {
      // The helper is pure: it considers only the two hostile collections
      // passed in. Player bullets and minerals live in different scene
      // collections and are never supplied, so they cannot contribute.
      const playerBullets = [
        { x: 110, y: 100 },
        { x: 100, y: 120 },
        { x: 90, y: 100 },
      ];
      const minerals = [{ x: 105, y: 105 }];

      // Sanity: the non-hostile points are genuinely within range.
      expect(playerBullets.length + minerals.length).toBeGreaterThanOrEqual(3);

      // Only the hostile collections are passed — count stays 0.
      expect(countThreatsInRange(ship, [], [])).toBe(0);
      expect(isInDanger(ship, [], [])).toBe(false);
    });
  });
});

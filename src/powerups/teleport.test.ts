/**
 * Unit tests for the shared P7 teleport safe-spot resolver
 * (parent AH-0MU3VOQKH005YOBH, feature AH-0MU44M9NQ0006613).
 */

import { describe, expect, it } from 'vitest';

import { findTeleportDestination, type TeleportBody } from './teleport';

const WIDTH = 960;
const HEIGHT = 540;
const MARGIN = 14; // SHIP_SIZE / 2 + 4

/** Whether (x, y) clears every body by its (defaulted) radius. */
function isClear(
  x: number,
  y: number,
  bodies: TeleportBody[],
  options: { safeRadius?: number; hitRadius?: number } = {},
): boolean {
  const safeRadius = options.safeRadius ?? 60;
  const hitRadius = options.hitRadius ?? 0;
  return bodies.every(
    (b) => Math.hypot(b.x - x, b.y - y) >= safeRadius + (b.radius ?? hitRadius),
  );
}

describe('findTeleportDestination', () => {
  it('returns a position clear of every enemy and bullet', () => {
    const enemies = [{ x: 380, y: 400 }];
    const bullets = [{ x: 600, y: 400 }];

    const dest = findTeleportDestination(
      300,
      400,
      0,
      enemies,
      bullets,
      WIDTH,
      HEIGHT,
    );

    expect(Math.hypot(dest.x - 300, dest.y - 400)).toBeGreaterThan(0);
    expect(isClear(dest.x, dest.y, enemies)).toBe(true);
    expect(isClear(dest.x, dest.y, bullets)).toBe(true);
  });

  it('skips the nearest ray candidate when an enemy blocks it', () => {
    // Heading right from (300,400): the first ray candidate is (380,400).
    const blocking = [{ x: 380, y: 400 }];

    const dest = findTeleportDestination(
      300,
      400,
      0,
      blocking,
      [],
      WIDTH,
      HEIGHT,
    );

    expect(dest).not.toEqual({ x: 380, y: 400 });
    expect(isClear(dest.x, dest.y, blocking)).toBe(true);
  });

  it('clamps the destination inside the screen margin', () => {
    const dest = findTeleportDestination(950, 20, 0, [], [], WIDTH, HEIGHT);

    expect(dest.x).toBeGreaterThanOrEqual(MARGIN);
    expect(dest.x).toBeLessThanOrEqual(WIDTH - MARGIN);
    expect(dest.y).toBeGreaterThanOrEqual(MARGIN);
    expect(dest.y).toBeLessThanOrEqual(HEIGHT - MARGIN);
  });

  it('is deterministic for identical inputs', () => {
    const args = [300, 400, 0, [{ x: 380, y: 400 }], [], WIDTH, HEIGHT] as const;

    const a = findTeleportDestination(...args);
    const b = findTeleportDestination(...args);

    expect(a).toEqual(b);
  });

  it('honours a per-body radius override', () => {
    // With safeRadius 10, an enemy 15 px away is clear at radius 0 but
    // blocks the candidate at radius 20.
    const clear = findTeleportDestination(
      300,
      400,
      0,
      [{ x: 395, y: 400, radius: 0 }],
      [],
      WIDTH,
      HEIGHT,
      { safeRadius: 10 },
    );
    const blocked = findTeleportDestination(
      300,
      400,
      0,
      [{ x: 395, y: 400, radius: 20 }],
      [],
      WIDTH,
      HEIGHT,
      { safeRadius: 10 },
    );

    expect(clear).not.toEqual(blocked);
    expect(isClear(blocked.x, blocked.y, [{ x: 395, y: 400, radius: 20 }], {
      safeRadius: 10,
    })).toBe(true);
  });
});

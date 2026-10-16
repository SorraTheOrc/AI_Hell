/**
 * Tests for the shared thruster-hum profile classification
 * (`src/utils/thrusterProfile.ts`, AH-0MV78QUIX001EZN2 AC3/AC5).
 *
 * The classification is implemented once in shared code and consumed by
 * Player (shared by the game and every gym), so the arbitration rule is
 * pinned here independently of any scene:
 * - Asteroids `leftSide` / `rightSide` (turn) → side profile.
 * - fourDirectional `left` / `right` (lateral strafe) → side profile.
 * - Asteroids `main` (forward), `nose` (retro) and fourDirectional
 *   `top` / `bottom` (vertical) → default (forward) profile.
 * - Any side engine firing alongside a forward engine → side wins.
 */
import { describe, expect, it } from 'vitest';

import {
  THRUSTER_SIDE_ENGINES,
  getThrusterProfile,
  isSideEngine,
} from './thrusterProfile';

// ── isSideEngine ───────────────────────────────────────────────────

describe('isSideEngine — engine port classification', () => {
  it('classifies both schemes lateral/turn ports as side', () => {
    for (const engine of ['leftSide', 'rightSide', 'left', 'right']) {
      expect(isSideEngine(engine)).toBe(true);
    }
  });

  it('classifies forward/main, retro and vertical ports as not side', () => {
    for (const engine of ['main', 'nose', 'top', 'bottom']) {
      expect(isSideEngine(engine)).toBe(false);
    }
  });

  it('treats unknown ports conservatively as not side (default profile)', () => {
    expect(isSideEngine('unexpected-port')).toBe(false);
  });

  it('exposes the side set so callers can enumerate it', () => {
    expect(
      [...THRUSTER_SIDE_ENGINES].sort(),
    ).toEqual(['left', 'leftSide', 'right', 'rightSide']);
  });
});

// ── getThrusterProfile — Asteroids scheme ───────────────────────────

describe('getThrusterProfile — Asteroids scheme', () => {
  it('maps forward-only thrust to the default profile', () => {
    expect(getThrusterProfile([{ engine: 'main', scale: 1 }])).toBe('forward');
  });

  it('maps turn-left to the side profile', () => {
    expect(
      getThrusterProfile([{ engine: 'rightSide', scale: 1 }]),
    ).toBe('side');
  });

  it('maps turn-right to the side profile', () => {
    expect(
      getThrusterProfile([{ engine: 'leftSide', scale: 1 }]),
    ).toBe('side');
  });

  it('maps the nose retro-thruster to the default profile', () => {
    expect(getThrusterProfile([{ engine: 'nose', scale: 1 }])).toBe('forward');
  });

  it('side-wins when forward and turn are held together', () => {
    expect(
      getThrusterProfile([
        { engine: 'main', scale: 1 },
        { engine: 'rightSide', scale: 1 },
      ]),
    ).toBe('side');
  });

  it('returns the default profile when no engines fire', () => {
    expect(getThrusterProfile([])).toBe('forward');
  });
});

// ── getThrusterProfile — fourDirectional scheme ─────────────────────

describe('getThrusterProfile — fourDirectional scheme', () => {
  it('maps lateral strafe (left/right port) to the side profile', () => {
    expect(getThrusterProfile([{ engine: 'left', scale: 1 }])).toBe('side');
    expect(getThrusterProfile([{ engine: 'right', scale: 1 }])).toBe('side');
  });

  it('maps vertical thrust (top/bottom port) to the default profile', () => {
    expect(getThrusterProfile([{ engine: 'top', scale: 1 }])).toBe('forward');
    expect(getThrusterProfile([{ engine: 'bottom', scale: 1 }])).toBe('forward');
  });

  it('side-wins on a diagonal with a lateral component', () => {
    expect(
      getThrusterProfile([
        { engine: 'bottom', scale: 1 },
        { engine: 'right', scale: 1 },
      ]),
    ).toBe('side');
  });

  it('keeps an up-only diagonal forward', () => {
    expect(getThrusterProfile([{ engine: 'bottom', scale: 1 }])).toBe('forward');
  });
});

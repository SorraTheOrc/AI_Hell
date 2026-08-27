/**
 * Tests for the pure MovementInput → firing-engines mapping
 * (child AH-0MTBOE8JM0040Z3Y of AH-0MTAF76Q1008BLBE).
 *
 * Covers AC1–AC4:
 * - AC1: no thrust → no engines fire.
 * - AC2: cardinal thrust → exactly the opposing engine fires at scale 1.0
 *   (thrust up → bottom, down → top, left → right, right → left).
 * - AC3: diagonal thrust → both opposing engines fire, each at the
 *   component magnitude of its axis (boolean axes are magnitude 1.0).
 * - AC4: mixed component magnitudes → each flame scale equals its
 *   component value.
 */
import { describe, expect, it } from 'vitest';

import { MovementInput } from './movement';
import { enginesForThrust, EnginePort, selectEngines } from './engineSelection';

// ── Helpers ─────────────────────────────────────────────────────────

function input(
  up = false,
  down = false,
  left = false,
  right = false,
): MovementInput {
  return { up, down, left, right };
}

function firing(engine: EnginePort, scale: number) {
  return { engine, scale };
}

// ── AC1 — No thrust ────────────────────────────────────────────────

describe('selectEngines — no thrust (AC1)', () => {
  it('fires no engines when no direction is held', () => {
    expect(selectEngines(input())).toEqual([]);
  });
});

// ── AC2 — Cardinal thrust ──────────────────────────────────────────

describe('selectEngines — cardinal thrust (AC2)', () => {
  it('thrust up fires only the bottom engine at scale 1.0', () => {
    expect(selectEngines(input(true))).toEqual([firing('bottom', 1)]);
  });

  it('thrust down fires only the top engine at scale 1.0', () => {
    expect(selectEngines(input(false, true))).toEqual([firing('top', 1)]);
  });

  it('thrust left fires only the right engine at scale 1.0', () => {
    expect(selectEngines(input(false, false, true))).toEqual([
      firing('right', 1),
    ]);
  });

  it('thrust right fires only the left engine at scale 1.0', () => {
    expect(selectEngines(input(false, false, false, true))).toEqual([
      firing('left', 1),
    ]);
  });
});

// ── AC3 — Diagonal thrust ──────────────────────────────────────────

describe('selectEngines — diagonal thrust (AC3)', () => {
  it('up+right fires the bottom and left engines', () => {
    expect(selectEngines(input(true, false, false, true))).toEqual([
      firing('bottom', 1),
      firing('left', 1),
    ]);
  });

  it('up+left fires the bottom and right engines', () => {
    expect(selectEngines(input(true, false, true))).toEqual([
      firing('bottom', 1),
      firing('right', 1),
    ]);
  });

  it('down+right fires the top and left engines', () => {
    expect(selectEngines(input(false, true, false, true))).toEqual([
      firing('top', 1),
      firing('left', 1),
    ]);
  });

  it('down+left fires the top and right engines', () => {
    expect(selectEngines(input(false, true, true))).toEqual([
      firing('top', 1),
      firing('right', 1),
    ]);
  });
});

// ── AC4 — Mixed component magnitudes ───────────────────────────────

describe('enginesForThrust — component magnitudes (AC4)', () => {
  it('scales each flame by its thrust component (0.5 down + 1.0 right)', () => {
    // dy = +0.5 (thrust down) → top engine at 0.5; dx = +1 (thrust right)
    // → left engine at 1.0.
    expect(enginesForThrust(1, 0.5)).toEqual([
      firing('top', 0.5),
      firing('left', 1),
    ]);
  });

  it('scales partial diagonal components independently (0.3 left, 0.7 up)', () => {
    // dx = -0.3 (thrust left) → right engine at 0.3; dy = -0.7 (thrust
    // up) → bottom engine at 0.7.
    expect(enginesForThrust(-0.3, -0.7)).toEqual([
      firing('bottom', 0.7),
      firing('right', 0.3),
    ]);
  });

  it('returns no engines for a zero vector', () => {
    expect(enginesForThrust(0, 0)).toEqual([]);
  });
});
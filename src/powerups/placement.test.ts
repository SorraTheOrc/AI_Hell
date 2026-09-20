/**
 * Unit tests for the pluggable avoiding placement strategy
 * (parent AH-0MU3VOQKH005YOBH, feature AH-0MU44M90T003EQ2G).
 *
 * All assertions are deterministic: the RNG is either seeded or
 * scripted, and the independent overlap oracle lives in the shared test
 * fixtures rather than mirroring the production check.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLACEMENT_MAX_ATTEMPTS,
  nudgeAwayFromDrops,
  RandomAvoidingPlacement,
  type PlacementContext,
  type PowerUpPlacement,
} from './placement';
import {
  createSeededRng,
  createSequenceRng,
  isClearOfBodies,
  stubBody,
  type StubBody,
} from '../test/powerUpTestFixtures';

/** Standard playable context used across the tests. */
function makeContext(overrides: Partial<PlacementContext> = {}): PlacementContext {
  return {
    width: 200,
    height: 120,
    margin: 10,
    dropRadius: 8,
    enemies: [],
    player: stubBody(1000, 1000, 1),
    ...overrides,
  };
}

/** The drop body at *point* for the independent overlap oracle. */
function candidate(x: number, y: number, radius: number): StubBody {
  return stubBody(x, y, radius);
}

describe('RandomAvoidingPlacement', () => {
  // ── AC1: interface + implementation ──────────────────────────────

  it('AC1 — satisfies the PowerUpPlacement interface (used polymorphically)', () => {
    const placement: PowerUpPlacement = new RandomAvoidingPlacement({
      rng: createSeededRng(1),
    });

    const point = placement.place(makeContext());
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });

  // ── AC2: in-bounds, inside the margin ────────────────────────────

  it('AC2 — always returns a position inside the configured margin', () => {
    const context = makeContext({ width: 200, height: 120, margin: 10, dropRadius: 8 });
    const minX = context.margin + context.dropRadius;
    const maxX = context.width - context.margin - context.dropRadius;
    const minY = context.margin + context.dropRadius;
    const maxY = context.height - context.margin - context.dropRadius;

    for (let seed = 1; seed <= 20; seed += 1) {
      const { x, y } = new RandomAvoidingPlacement({
        rng: createSeededRng(seed),
      }).place(context);
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(y).toBeLessThanOrEqual(maxY);
    }
  });

  // ── AC3: never overlaps a live enemy or the player ───────────────

  it('AC3 — never overlaps a supplied enemy or the player', () => {
    const context = makeContext({
      enemies: [stubBody(50, 50, 15), stubBody(150, 60, 20), stubBody(100, 20, 12)],
      player: stubBody(100, 100, 12),
    });
    const bodies = [...context.enemies, context.player];

    for (let seed = 1; seed <= 50; seed += 1) {
      const { x, y } = new RandomAvoidingPlacement({
        rng: createSeededRng(seed),
      }).place(context);
      expect(
        isClearOfBodies(candidate(x, y, context.dropRadius), bodies),
      ).toBe(true);
    }
  });

  // ── AC4: retry path ──────────────────────────────────────────────

  it('AC4 — retries past an overlapping candidate and uses the next free one', () => {
    // Bounds x,y ∈ [10, 90]; scripted candidates: (10,10) overlaps the
    // enemy, then (90,90) is clear.
    const enemy = stubBody(10, 10, 10);
    const context = makeContext({
      width: 100,
      height: 100,
      margin: 0,
      dropRadius: 10,
      enemies: [enemy],
    });

    let calls = 0;
    const scripted = createSequenceRng([0, 0, 1, 1]);
    const rng = () => {
      calls += 1;
      return scripted();
    };

    const point = new RandomAvoidingPlacement({ rng, maxAttempts: 2 }).place(context);

    expect(point).toEqual({ x: 90, y: 90 });
    expect(calls).toBe(4); // two candidates × two coordinates
    expect(isClearOfBodies(candidate(point.x, point.y, 10), [enemy])).toBe(true);
  });

  it('AC4 — defaults to more than one attempt', () => {
    const enemy = stubBody(10, 10, 10);
    const context = makeContext({
      width: 100,
      height: 100,
      margin: 0,
      dropRadius: 10,
      enemies: [enemy],
    });

    // First candidate overlaps, second is clear; with the default attempt
    // limit the strategy must try again rather than fall back immediately.
    const point = new RandomAvoidingPlacement({
      rng: createSequenceRng([0, 0, 1, 1]),
    }).place(context);

    expect(point).toEqual({ x: 90, y: 90 });
    expect(DEFAULT_PLACEMENT_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  // ── AC4: fallback path ───────────────────────────────────────────

  it('AC4 — falls back to a deterministic safe position when every attempt overlaps', () => {
    // Every random candidate lands on the enemy at (10,10).
    const enemy = stubBody(10, 10, 10);
    const context = makeContext({
      width: 100,
      height: 100,
      margin: 0,
      dropRadius: 10,
      enemies: [enemy],
      player: stubBody(1000, 1000, 1),
    });

    let calls = 0;
    const rng = () => {
      calls += 1;
      return 0;
    };

    const placement = new RandomAvoidingPlacement({ rng, maxAttempts: 3 });
    const first = placement.place(context);
    const callsAfterFirst = calls;
    const second = placement.place(context);

    expect(callsAfterFirst).toBe(6); // 3 attempts × 2 coordinates per place() call
    expect(first).toEqual(second); // deterministic
    expect(first).not.toEqual({ x: 10, y: 10 }); // not the blocked candidate
    expect(
      isClearOfBodies(candidate(first.x, first.y, 10), [enemy, context.player]),
    ).toBe(true);
  });

  it('AC4 — fallback is deterministic for identical contexts', () => {
    // The scripted first candidate (18,18) always overlaps, forcing the
    // fallback on every call.
    const context = makeContext({
      enemies: [stubBody(18, 18, 20)],
      player: stubBody(60, 100, 15),
    });

    const a = new RandomAvoidingPlacement({ rng: createSequenceRng([0, 0]), maxAttempts: 2 }).place(context);
    const b = new RandomAvoidingPlacement({ rng: createSequenceRng([0, 0]), maxAttempts: 2 }).place(context);

    expect(a).toEqual(b);
  });

  // ── Degenerate bounds ────────────────────────────────────────────

  it('handles a playable area smaller than the drop without throwing', () => {
    const context = makeContext({
      width: 10,
      height: 10,
      margin: 0,
      dropRadius: 10,
      enemies: [],
    });

    const point = new RandomAvoidingPlacement({
      rng: createSeededRng(1),
    }).place(context);

    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });
});

describe('nudgeAwayFromDrops (AH-0MU7JTFM5000R4ME)', () => {
  it('returns the natural point unchanged when already separated', () => {
    const p = nudgeAwayFromDrops([{ x: 0, y: 0 }], 100, 100, 40, 200, 200);
    expect(p).toEqual({ x: 100, y: 100 });
  });

  it('keeps the separation even when drops stack on the same point', () => {
    const existing: { x: number; y: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const p = nudgeAwayFromDrops(existing, 100, 100, 40, 200, 200);
      if (!p) break;
      existing.push(p);
    }
    expect(existing.length).toBe(4);
    for (let i = 0; i < existing.length; i++) {
      for (let j = i + 1; j < existing.length; j++) {
        expect(
          Math.hypot(existing[i].x - existing[j].x, existing[i].y - existing[j].y),
        ).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it('returns null when no in-bounds separated position exists', () => {
    // The playfield is smaller than the minimum separation, so no in-bounds
    // nudged point can move the drop far enough from (50, 50).
    const p = nudgeAwayFromDrops([{ x: 50, y: 50 }], 50, 50, 200, 120, 120);
    expect(p).toBeNull();
  });

  it('with no existing drops the natural point is always kept', () => {
    expect(nudgeAwayFromDrops([], 42, 42, 40, 200, 200)).toEqual({ x: 42, y: 42 });
  });
});

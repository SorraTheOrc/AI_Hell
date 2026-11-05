/**
 * Blocked-drop stick-then-throw contract (parent AH-0MW0UAQ23005AC9L,
 * test child AH-0MW3H015M0034U0G).
 *
 * These are the failing-first unit tests for the pure blocked-discard stepper
 * (`src/scenes/core/blockedDropDiscard.ts`), written before the behaviour was
 * wired into the shared drop layer so the stepper cannot drift once it is
 * consumed by `PlayScene` and every gym.
 *
 * The suite is deliberately Phaser-free and scene-free: it imports no Phaser,
 * instantiates no scene and drives the stepper with structural doubles, an
 * injected `rng` and explicit `dt` slices (no timers, no fake clocks), so every
 * case is deterministic.
 *
 * Producer answers pinned here (parent Appendix):
 *
 * - **Q1a** — the 1.5 s window starts on the first frame the blocked drop
 *   overlaps the ship.
 * - **Q2a** — the stick is explicit: it must not depend on the Magnet power-up
 *   (zero stacks is the proof).
 * - **Q3a** — a drop that becomes collectable during the window is collected
 *   normally and the throw is cancelled.
 *
 * Every assertion carries a message naming the behaviour it pins.
 */

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  BLOCKED_DROP_STICK_SECONDS,
  BLOCKED_DROP_THROW_SPEED,
  GAME_HEIGHT,
  GAME_WIDTH,
} from '../../core/constants';
import { PowerUp } from '../../powerups/PowerUp';
import { applyDropMagnet, type DropLifecycleDrop } from './dropLayer';
import {
  cancelAllBlockedDiscards,
  cancelBlockedDiscard,
  isDiscarding,
  randomUnitDirection,
  startBlockedStick,
  stepBlockedDiscards,
  type BlockedDiscardDrop,
  type ScreenBounds,
} from './blockedDropDiscard';

// ── Deterministic helpers ──────────────────────────────────────────

/** The ship sits at the screen centre in these cases. */
const SHIP = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };

/** One 10 ms frame — the suite accumulates whole frames, never the clock. */
const FRAME = 0.01;

/** Screen bounds used when a case does not override them. */
const SCREEN: ScreenBounds = { width: GAME_WIDTH, height: GAME_HEIGHT };

/** Graphics + lifecycle structural double (the `dropLayer.test.ts` style). */
type GraphicsDouble = {
  setPosition: Mock<(x: number, y: number) => void>;
  setScale: Mock<(x: number, y?: number) => void>;
  destroy: Mock<() => void>;
};

interface DropDouble extends BlockedDiscardDrop, DropLifecycleDrop {
  graphics: GraphicsDouble;
}

function makeDrop(x: number = SHIP.x, y: number = SHIP.y): DropDouble {
  return {
    x,
    y,
    graphics: { setPosition: vi.fn(), setScale: vi.fn(), destroy: vi.fn() },
    powerUp: new PowerUp('speed_boost'),
  };
}

/** Steps whole frames until `seconds` of accumulated `dt` has been simulated. */
function stepSeconds(
  drops: DropDouble[],
  seconds: number,
  rng: () => number,
  ship: { x: number; y: number } = SHIP,
  bounds: ScreenBounds = SCREEN,
): DropDouble[] {
  let kept = drops;
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    kept = stepBlockedDiscards(kept, ship, FRAME, rng, bounds);
  }
  return kept;
}

/** Small deterministic PRNG (mulberry32) — the seeded-run case only. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Q1a: the stick window ──────────────────────────────────────────

describe('blockedDropDiscard — stick window (Q1a)', () => {
  it('does not launch after 1.49 s of accumulated dt and launches at exactly 1.5 s', () => {
    const drop = makeDrop();
    startBlockedStick(drop, SHIP);

    let kept = stepSeconds([drop], 1.49, () => 0);
    expect(kept, 'a sticking drop stays on the field during the stick window').toHaveLength(1);
    expect(
      drop.blockedDiscard?.stickSeconds,
      'the stick window accumulates the elapsed dt (1.49 s of it here)',
    ).toBeCloseTo(1.49, 10);
    expect(
      isDiscarding(drop),
      '1.49 s of accumulated dt is inside the window, so the drop is never launched',
    ).toBe(false);

    kept = stepSeconds(kept, BLOCKED_DROP_STICK_SECONDS - 1.49, () => 0);
    expect(kept, 'the launched drop is still on the field on the launch frame').toHaveLength(1);
    expect(
      isDiscarding(drop),
      'exactly 1.5 s of accumulated dt elapses the window and launches the drop',
    ).toBe(true);
  });

  it('starts the window on the first overlapping frame, so the elapsed time is measured from that frame', () => {
    const drop = makeDrop();
    // No overlap yet: the seam never starts the stick, so no stick time passes.
    let kept = stepSeconds([drop], 0.5, () => 0);
    expect(
      drop.blockedDiscard,
      'a blocked drop that has not overlapped the ship has no stick state',
    ).toBeUndefined();

    // First overlapping frame (the seam's `canCollect === false` branch).
    startBlockedStick(drop, SHIP);
    kept = stepSeconds(kept, BLOCKED_DROP_STICK_SECONDS - FRAME, () => 0);
    expect(
      isDiscarding(drop),
      'the window is measured from the first overlap frame, not from the blocked cue',
    ).toBe(false);

    kept = stepSeconds(kept, FRAME, () => 0);
    expect(
      isDiscarding(drop),
      'the drop launches 1.5 s after the first overlapping frame',
    ).toBe(true);
  });

  it('accumulates no stick time for a blocked drop that never overlaps the ship', () => {
    const offShip = makeDrop(100, 100);
    const kept = stepSeconds([offShip], 2.5, () => 0);

    expect(kept, 'a non-overlapping drop is never removed by the discard stepper').toHaveLength(1);
    expect(
      offShip.blockedDiscard,
      'a blocked drop that never overlaps the ship accumulates no stick time',
    ).toBeUndefined();
    expect(offShip.x, 'a non-overlapping blocked drop keeps its own x position').toBe(100);
    expect(offShip.y, 'a non-overlapping blocked drop keeps its own y position').toBe(100);
    expect(
      offShip.graphics.destroy,
      'a non-overlapping blocked drop is never destroyed by the throw',
    ).not.toHaveBeenCalled();
  });
});

// ── Q2a: the stick is explicit, not Magnet-driven ──────────────────

describe('blockedDropDiscard — explicit stick without Magnet (Q2a)', () => {
  it('tracks the ship every frame with zero Magnet stacks and still throws after the window', () => {
    const drop = makeDrop();
    startBlockedStick(drop, SHIP);

    let ship = { x: SHIP.x, y: SHIP.y };
    let kept: DropDouble[] = [drop];
    for (let i = 0; i < 100; i++) {
      ship = { x: ship.x + 3, y: ship.y - 2 };
      // Zero Magnet stacks: the magnet pull is a strict no-op every frame.
      applyDropMagnet(kept, ship, 0, FRAME);
      kept = stepBlockedDiscards(kept, ship, FRAME, () => 0, SCREEN);

      expect(drop.x, 'a sticking drop tracks the ship x every frame without Magnet').toBe(ship.x);
      expect(drop.y, 'a sticking drop tracks the ship y every frame without Magnet').toBe(ship.y);
      expect(
        drop.graphics.setPosition,
        'the sticking drop syncs its Graphics to the ship every frame without Magnet',
      ).toHaveBeenLastCalledWith(ship.x, ship.y);
    }

    kept = stepSeconds(kept, BLOCKED_DROP_STICK_SECONDS - 1, () => 0, ship);
    expect(
      isDiscarding(drop),
      'the 1.5 s throw still happens with zero Magnet stacks, so the stick never depends on Magnet',
    ).toBe(true);
    expect(kept, 'the launched drop is still on the field on the launch frame').toHaveLength(1);
  });
});

// ── The throw ──────────────────────────────────────────────────────

describe('blockedDropDiscard — the throw', () => {
  it('records a unit-length direction from the injected rng and never from Math.random', () => {
    const mathRandom = vi.spyOn(Math, 'random');
    const drop = makeDrop();
    startBlockedStick(drop, SHIP);

    // rng 0.25 → a quarter turn → straight down the screen.
    const kept = stepSeconds([drop], BLOCKED_DROP_STICK_SECONDS, () => 0.25);

    expect(kept, 'the launched drop is still on the field on the launch frame').toHaveLength(1);
    expect(drop.blockedDiscard?.discarding, 'elapsing the window marks the drop as discarding').toBe(
      true,
    );
    const direction = drop.blockedDiscard;
    expect(
      direction?.directionX,
      'the stored throw direction is taken from the injected rng (quarter turn → x ≈ 0)',
    ).toBeCloseTo(0, 10);
    expect(
      direction?.directionY,
      'the stored throw direction is taken from the injected rng (quarter turn → y = 1)',
    ).toBeCloseTo(1, 10);
    expect(
      Math.hypot(direction?.directionX ?? 0, direction?.directionY ?? 0),
      'the stored throw direction is unit length so the throw speed is constant',
    ).toBeCloseTo(1, 10);
    expect(
      mathRandom,
      'the stepper never reads Math.random — the rng is always injected',
    ).not.toHaveBeenCalled();
  });

  it('advances a discarding drop BLOCKED_DROP_THROW_SPEED × dt along its stored direction', () => {
    const drop = makeDrop();
    startBlockedStick(drop, SHIP);
    stepSeconds([drop], BLOCKED_DROP_STICK_SECONDS, () => 0); // rng 0 → straight right

    const launchX = drop.x;
    const launchY = drop.y;
    // The ship moves far away: a straight-line throw ignores it completely.
    const kept = stepBlockedDiscards([drop], { x: 0, y: 0 }, 0.25, () => 0.9, SCREEN);

    expect(kept, 'a launched drop mid-screen is still on the field').toHaveLength(1);
    expect(
      drop.x,
      'the launched drop advances BLOCKED_DROP_THROW_SPEED × dt along its stored direction',
    ).toBeCloseTo(launchX + BLOCKED_DROP_THROW_SPEED * 0.25, 10);
    expect(
      drop.y,
      'the launched drop travels in a straight line, ignoring where the ship moved',
    ).toBeCloseTo(launchY, 10);
    expect(
      drop.graphics.setPosition,
      'the travelling drop syncs its Graphics every frame',
    ).toHaveBeenLastCalledWith(drop.x, drop.y);
  });
});

// ── The four screen edges ──────────────────────────────────────────

describe('blockedDropDiscard — removal at every screen edge', () => {
  const edges = [
    { edge: 'left', rng: 0.5, axis: 'x' as const, limit: 0, atMin: true },
    { edge: 'right', rng: 0, axis: 'x' as const, limit: GAME_WIDTH, atMin: false },
    { edge: 'top', rng: 0.75, axis: 'y' as const, limit: 0, atMin: true },
    { edge: 'bottom', rng: 0.25, axis: 'y' as const, limit: GAME_HEIGHT, atMin: false },
  ];

  for (const { edge, rng, axis, limit, atMin } of edges) {
    it(`destroys and removes a launched drop once it reaches the ${edge} screen edge`, () => {
      const drop = makeDrop();
      startBlockedStick(drop, SHIP);
      let kept = stepSeconds([drop], BLOCKED_DROP_STICK_SECONDS, () => rng);

      // One frame of flight: still on the field, already travelling.
      kept = stepBlockedDiscards(kept, SHIP, FRAME, () => rng, SCREEN);
      expect(kept, `a launched drop is kept while it is still short of the ${edge} edge`).toHaveLength(
        1,
      );
      expect(drop.graphics.destroy, `no drop is destroyed before it reaches the ${edge} edge`)
        .not.toHaveBeenCalled();

      // Fly until the edge is reached (bounded well above the screen crossing).
      for (let i = 0; i < 400 && kept.length > 0; i++) {
        kept = stepBlockedDiscards(kept, SHIP, FRAME, () => rng, SCREEN);
      }

      expect(kept, `the drop is removed from the kept list at the ${edge} edge`).toHaveLength(0);
      const reached = atMin ? drop[axis] <= limit : drop[axis] >= limit;
      expect(reached, `the drop has reached the ${edge} edge when it is retired`).toBe(true);
      expect(
        drop.graphics.destroy,
        `the Graphics of a drop discarded at the ${edge} edge is destroyed`,
      ).toHaveBeenCalledTimes(1);
    });
  }
});

// ── Q3a: a freed slot cancels the throw ────────────────────────────

describe('blockedDropDiscard — a freed slot cancels the throw (Q3a)', () => {
  it('never throws a drop that becomes collectable during the stick window and clears its stick state', () => {
    const drop = makeDrop();
    startBlockedStick(drop, SHIP);
    let kept = stepSeconds([drop], 1, () => 0);
    expect(
      drop.blockedDiscard?.stickSeconds,
      'the drop is mid-window when a slot frees (1 s accumulated)',
    ).toBeCloseTo(1, 10);
    expect(isDiscarding(drop), 'a mid-window drop has not been thrown yet').toBe(false);

    // The slot frees: the collect seam collects the drop and cancels the throw.
    cancelBlockedDiscard(drop);
    kept = kept.filter((candidate) => candidate !== drop);

    expect(kept, 'the collected drop leaves the field instead of being thrown').toHaveLength(0);
    expect(
      drop.blockedDiscard,
      'collecting during the stick window clears the stick state',
    ).toBeUndefined();
    expect(isDiscarding(drop), 'a collected drop is never marked as discarding').toBe(false);

    // Stepping the rest of the run never revives the cancelled throw.
    stepSeconds([drop], BLOCKED_DROP_STICK_SECONDS, () => 0);
    expect(
      isDiscarding(drop),
      'a drop collected during the stick window is never thrown afterwards',
    ).toBe(false);
    expect(drop.x, 'a collected drop is not moved by the cancelled throw').toBe(SHIP.x);
  });
});

// ── Collection and run restart clear the state ─────────────────────

describe('blockedDropDiscard — state cleared on collection and on run restart', () => {
  it('clears stick and discard state on collection and on run restart so a half-thrown drop cannot survive a new run', () => {
    const sticking = makeDrop();
    startBlockedStick(sticking, SHIP);
    stepSeconds([sticking], 1, () => 0);

    const launched = makeDrop();
    startBlockedStick(launched, SHIP);
    let kept = stepSeconds([launched], BLOCKED_DROP_STICK_SECONDS + 2 * FRAME, () => 0);
    expect(isDiscarding(launched), 'the seeded drop is already travelling before the restart').toBe(
      true,
    );
    const travelledX = launched.x;

    cancelBlockedDiscard(sticking);
    cancelAllBlockedDiscards(kept);

    expect(sticking.blockedDiscard, 'collection clears the stick state').toBeUndefined();
    expect(
      launched.blockedDiscard,
      'a run restart clears the discard state, even for an already-thrown drop',
    ).toBeUndefined();
    expect(isDiscarding(launched), 'clearing the restart state ends the throw').toBe(false);

    kept = stepSeconds(kept, 2, () => 0);
    expect(kept, 'the cleared drops stay on the field through the next run').toHaveLength(1);
    expect(
      launched.x,
      'a drop whose discard state was cleared on restart is never advanced again',
    ).toBe(travelledX);
    expect(
      launched.graphics.destroy,
      'a drop whose discard state was cleared on restart is never destroyed by the throw',
    ).not.toHaveBeenCalled();
  });
});

// ── Determinism and variety ────────────────────────────────────────

describe('blockedDropDiscard — seeded directions', () => {
  it('varies the throw direction across seeds while staying deterministic per seed', () => {
    const directionFor = (seed: number): { x: number; y: number } => {
      const drop = makeDrop();
      startBlockedStick(drop, SHIP);
      stepSeconds([drop], BLOCKED_DROP_STICK_SECONDS, mulberry32(seed));
      return {
        x: drop.blockedDiscard?.directionX ?? 0,
        y: drop.blockedDiscard?.directionY ?? 0,
      };
    };

    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const directions = seeds.map(directionFor);
    for (const [index, direction] of directions.entries()) {
      expect(
        Math.hypot(direction.x, direction.y),
        `seed ${seeds[index]} produces a unit-length throw direction`,
      ).toBeCloseTo(1, 10);
    }

    expect(directionFor(1), 'the same seed always produces the same throw direction').toEqual(
      directionFor(1),
    );
    const distinct = new Set(
      directions.map((direction) => `${direction.x.toFixed(3)},${direction.y.toFixed(3)}`),
    );
    expect(
      distinct.size,
      'the throw direction varies across seeds instead of being a fixed vector',
    ).toBeGreaterThan(1);
  });

  it('derives a unit-length direction from any rng value', () => {
    for (const value of [0, 0.1, 0.5, 0.999]) {
      const direction = randomUnitDirection(() => value);
      expect(
        Math.hypot(direction.x, direction.y),
        `rng value ${value} yields a unit-length throw direction`,
      ).toBeCloseTo(1, 10);
    }
  });
});

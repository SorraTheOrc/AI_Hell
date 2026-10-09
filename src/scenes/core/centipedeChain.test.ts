/**
 * Centipede chain model tests (classic-arcade archetype, AH-0MV01EJ92008ZZ86).
 *
 * Pure behaviour tests for the shared chain law: the lead weaves and
 * descends, handles the arena edges, following segments trail at a fixed
 * spacing, a middle-segment kill splits the chain into two independent
 * sub-chains (with the lead/tail cases handled), and the chain speeds up
 * monotonically as segments are destroyed. No Phaser boot.
 */

import { describe, expect, it } from 'vitest';

import {
  CentipedeChain,
  centipedeSpeedMultiplier,
  type CentipedeChainOptions,
} from './centipedeChain';

const ARENA = { minX: 0, minY: 0, maxX: 200, maxY: 200 };

function makeChain(overrides: Partial<CentipedeChainOptions> = {}): CentipedeChain {
  return new CentipedeChain({
    startX: 100,
    startY: 0,
    arena: ARENA,
    segmentCount: 6,
    spacing: 20,
    lateralSpeed: 100,
    descentSpeed: 10,
    ...overrides,
  });
}

/** Advances the whole chain in small fixed steps to keep the path smooth. */
function advanceFor(chain: CentipedeChain, seconds: number, step = 0.05): void {
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i++) chain.advance(step);
}

describe('CentipedeChain — construction and trail', () => {
  it('starts as one live chain with the lead at the spawn point', () => {
    const chain = makeChain();
    expect(chain.segmentCount).toBe(6);
    expect(chain.aliveCount()).toBe(6);
    expect(chain.subChainCount()).toBe(1);
    expect(chain.runs()).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(chain.headIndex()).toBe(0);
    expect(chain.segment(0)?.x).toBeCloseTo(100, 5);
    expect(chain.segment(0)?.y).toBeCloseTo(0, 5);
  });

  it('trails every following segment at the configured spacing behind the lead', () => {
    const chain = makeChain();
    chain.advance(0.5);
    for (let i = 0; i < chain.segmentCount; i++) {
      const seg = chain.segment(i)!;
      expect(seg.alive).toBe(true);
      // The straight-line gap never exceeds the arc-length spacing.
      if (i > 0) {
        const prev = chain.segment(i - 1)!;
        const gap = Math.hypot(seg.x - prev.x, seg.y - prev.y);
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(chain.spacing + 1e-6);
      }
    }
  });
});

describe('CentipedeChain — weave, descent and edge handling', () => {
  it('weaves laterally by reversing at the arena edge', () => {
    const chain = makeChain();
    let sawIncrease = false;
    let turned = false;
    let previousX = chain.segment(0)!.x;
    for (let i = 0; i < 40; i++) {
      chain.advance(0.05);
      const x = chain.segment(0)!.x;
      if (x > previousX) sawIncrease = true;
      if (sawIncrease && x < previousX) turned = true;
      previousX = x;
      expect(x).toBeGreaterThanOrEqual(ARENA.minX - 1e-6);
      expect(x).toBeLessThanOrEqual(ARENA.maxX + 1e-6);
    }
    expect(sawIncrease).toBe(true);
    expect(turned).toBe(true);
  });

  it('descends over time', () => {
    const chain = makeChain({ startY: 20 });
    const before = chain.segment(0)!.y;
    advanceFor(chain, 1);
    expect(chain.segment(0)!.y).toBeGreaterThan(before);
  });

  it('never leaves the arena vertically and wraps at the bottom edge', () => {
    const chain = makeChain({ startY: 150, descentSpeed: 40 });
    let minObserved = Infinity;
    for (let i = 0; i < 200; i++) {
      chain.advance(0.05);
      const y = chain.segment(0)!.y;
      expect(y).toBeGreaterThanOrEqual(ARENA.minY - 1e-6);
      expect(y).toBeLessThanOrEqual(ARENA.maxY + 1e-6);
      minObserved = Math.min(minObserved, y);
    }
    // Wrapping re-enters near the top at least once.
    expect(minObserved).toBeLessThan(ARENA.minY + 5);
  });
});

describe('CentipedeChain — split on segment death', () => {
  it('splits a middle segment into two independent sub-chains', () => {
    const chain = makeChain();
    chain.advance(0.2);
    chain.destroySegment(2);

    expect(chain.aliveCount()).toBe(5);
    expect(chain.subChainCount()).toBe(2);
    expect(chain.runs()).toEqual([
      [0, 1],
      [3, 4, 5],
    ]);

    // Both sub-chains keep moving independently after the split.
    const frontHead = chain.segment(0)!;
    const backHead = chain.segment(3)!;
    const frontBefore = { x: frontHead.x, y: frontHead.y };
    const backBefore = { x: backHead.x, y: backHead.y };
    advanceFor(chain, 0.5);
    expect(frontHead.x !== frontBefore.x || frontHead.y !== frontBefore.y).toBe(true);
    expect(backHead.x !== backBefore.x || backHead.y !== backBefore.y).toBe(true);
  });

  it('keeps the two sub-chains independent when one is thinned further', () => {
    const chain = makeChain();
    chain.advance(0.2);
    chain.destroySegment(2);
    const frontMembers = chain.runs()[0];

    // Destroy the back sub-chain's head: the front sub-chain is untouched.
    chain.destroySegment(3);
    expect(chain.runs()).toEqual([
      [0, 1],
      [4, 5],
    ]);
    expect(chain.runs()[0]).toEqual(frontMembers);

    // Destroy the front sub-chain: the back sub-chain is untouched.
    chain.destroySegment(0);
    expect(chain.runs()).toEqual([[1], [4, 5]]);
  });

  it('handles the lead-destruction case (one shortened chain, new lead)', () => {
    const chain = makeChain();
    chain.advance(0.2);
    chain.destroySegment(0);
    expect(chain.aliveCount()).toBe(5);
    expect(chain.subChainCount()).toBe(1);
    expect(chain.runs()).toEqual([[1, 2, 3, 4, 5]]);
    expect(chain.headIndex()).toBe(1);
  });

  it('handles the tail-destruction case (one shortened chain, same lead)', () => {
    const chain = makeChain();
    chain.advance(0.2);
    chain.destroySegment(5);
    expect(chain.aliveCount()).toBe(5);
    expect(chain.subChainCount()).toBe(1);
    expect(chain.runs()).toEqual([[0, 1, 2, 3, 4]]);
    expect(chain.headIndex()).toBe(0);
  });

  it('becomes empty once every segment is destroyed (advance is a no-op)', () => {
    const chain = makeChain();
    for (let id = 0; id < chain.segmentCount; id++) chain.destroySegment(id);
    expect(chain.aliveCount()).toBe(0);
    expect(chain.subChainCount()).toBe(0);
    expect(chain.runs()).toEqual([]);
    expect(chain.headIndex()).toBe(-1);
    expect(() => chain.advance(1)).not.toThrow();
  });

  it('ignores repeated or unknown segment kills', () => {
    const chain = makeChain();
    chain.destroySegment(2);
    chain.destroySegment(2);
    chain.destroySegment(99);
    expect(chain.aliveCount()).toBe(5);
    expect(chain.subChainCount()).toBe(2);
  });
});

describe('CentipedeChain — speed-up as segments are destroyed', () => {
  it('is monotonically increasing as the live count falls', () => {
    const multipliers: number[] = [];
    for (let alive = 6; alive >= 1; alive--) {
      multipliers.push(centipedeSpeedMultiplier(alive, 6));
    }
    for (let i = 1; i < multipliers.length; i++) {
      expect(multipliers[i]).toBeGreaterThan(multipliers[i - 1]);
    }
    expect(multipliers[0]).toBe(1);
  });

  it('makes the live chain move faster after segments are destroyed', () => {
    const full = makeChain();
    const thinned = makeChain();
    thinned.destroySegment(1);
    thinned.destroySegment(2);
    thinned.destroySegment(3);

    full.advance(0.5);
    thinned.advance(0.5);

    expect(thinned.speedMultiplier()).toBeGreaterThan(full.speedMultiplier());
    // The thinned lead travelled further along its weave than the full lead.
    expect(Math.abs(thinned.segment(0)!.x - 100)).toBeGreaterThan(
      Math.abs(full.segment(0)!.x - 100),
    );
  });
});

describe('CentipedeChain — tick ownership', () => {
  it('only the current head of a sub-chain advances it', () => {
    const chain = makeChain();
    const before = chain.segment(0)!.x;
    chain.tick(0.5, 3); // not the head — no advance
    expect(chain.segment(0)!.x).toBe(before);
    chain.tick(0.5, 0); // head — advances
    expect(chain.segment(0)!.x).not.toBe(before);
  });

  it('each sub-chain head advances its own sub-chain after a split', () => {
    const chain = makeChain();
    chain.destroySegment(2);
    const frontBefore = chain.segment(0)!.x;
    const backBefore = chain.segment(3)!.x;
    chain.tick(0.5, 0);
    chain.tick(0.5, 3);
    expect(chain.segment(0)!.x).not.toBe(frontBefore);
    expect(chain.segment(3)!.x).not.toBe(backBefore);
  });
});

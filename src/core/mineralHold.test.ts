/**
 * Shared mineral hold model tests (AH-0MUII3DHM008L7JF, gap 5; AH-0MUKC6IML0082ZR4).
 *
 * The hold model is the single source of truth for capacity, per-pickup
 * collect amount and overflow carry used by `GameState` (game) and
 * `GymFormationScene` (gyms). These tests pin the overflow semantics that
 * the gym previously lacked (it reset to 0 instead of carrying the surplus).
 *
 * AH-0MUKC6IML0082ZR4 introduces a capacity-progression system: the first
 * hold starts at a configurable first-hold capacity (default 5), and each
 * {@link resolve} call doubles the capacity (default multiplier 2).
 */

import { describe, expect, it } from 'vitest';

import { MineralHold } from './mineralHold';
import {
  DEFAULT_MINERAL_COLLECT_AMOUNT,
  DEFAULT_MINERAL_HOLD_CAPACITY,
} from './rules';

describe('MineralHold', () => {
  it('starts empty at the default first-hold capacity and collect amount', () => {
    const hold = new MineralHold();
    expect(hold.store).toBe(0);
    expect(hold.capacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(hold.capacity).toBe(5);
    expect(hold.collectAmount).toBe(DEFAULT_MINERAL_COLLECT_AMOUNT);
    expect(hold.isFull).toBe(false);
  });

  it('starts at the default growth multiplier (2)', () => {
    const hold = new MineralHold();
    expect(hold.growthMultiplier).toBe(2);
  });

  it('collect() adds the configured pickup amount by default', () => {
    const hold = new MineralHold({ collectAmount: 3 });
    hold.collect();
    expect(hold.store).toBe(3);
  });

  it('ignores non-positive collection amounts', () => {
    const hold = new MineralHold({ capacity: 10 });
    expect(hold.collect(0)).toBe(0);
    expect(hold.collect(-2)).toBe(0);
    expect(hold.store).toBe(0);
  });

  it('caps the store at capacity and reports the overflow', () => {
    const hold = new MineralHold({ capacity: 5 });
    const overflow = hold.collect(8);
    expect(hold.store).toBe(5);
    expect(overflow).toBe(3);
    expect(hold.overflow).toBe(3);
    expect(hold.isFull).toBe(true);
  });

  it('resolve() carries the overflow (store = collected − capacity), never 0', () => {
    const hold = new MineralHold({ capacity: 5 });
    hold.collect(8);
    hold.resolve();
    expect(hold.store).toBe(3);
    expect(hold.isFull).toBe(false);
  });

  it('resolve() empties the hold when there was no overflow', () => {
    const hold = new MineralHold({ capacity: 5 });
    hold.collect(5);
    hold.resolve();
    expect(hold.store).toBe(0);
  });

  it('reset() empties the store and clears the recorded overflow', () => {
    const hold = new MineralHold({ capacity: 5 });
    hold.collect(9);
    hold.reset();
    expect(hold.store).toBe(0);
    expect(hold.overflow).toBe(0);
    // A resolve after reset must not resurrect the stale overflow.
    hold.resolve();
    expect(hold.store).toBe(0);
  });

  describe('capacity progression (AH-0MUKC6IML0082ZR4)', () => {
    it('AC1 — first hold is full at 5 minerals, not before', () => {
      const hold = new MineralHold();
      expect(hold.capacity).toBe(5);

      // 4 minerals must not fill the hold.
      hold.collect(4);
      expect(hold.isFull).toBe(false);

      // The 5th mineral fills it.
      hold.collect(1);
      expect(hold.isFull).toBe(true);
    });

    it('AC2 — capacity doubles on each resolve: 5 → 10 → 20 → 40', () => {
      const hold = new MineralHold();

      expect(hold.capacity).toBe(5);
      hold.collect(5);
      hold.resolve();

      expect(hold.capacity).toBe(10);
      hold.collect(10);
      hold.resolve();

      expect(hold.capacity).toBe(20);
      hold.collect(20);
      hold.resolve();

      expect(hold.capacity).toBe(40);
      hold.collect(40);
      hold.resolve();

      expect(hold.capacity).toBe(80);
    });

    it('AC2 — capacity(n) = firstHoldCapacity × multiplier^(n−1) for custom tunables', () => {
      const hold = new MineralHold({
        capacity: 3,
        growthMultiplier: 3,
      });

      expect(hold.capacity).toBe(3);
      hold.collect(3);
      hold.resolve();
      expect(hold.capacity).toBe(9);

      hold.collect(9);
      hold.resolve();
      expect(hold.capacity).toBe(27);
    });

    it('AC3 — reset() restores the first-hold capacity (run-scoped)', () => {
      const hold = new MineralHold();

      hold.collect(5);
      hold.resolve();
      hold.collect(10);
      hold.resolve();
      expect(hold.capacity).toBe(20);

      hold.reset();
      expect(hold.capacity).toBe(5);
      expect(hold.store).toBe(0);
      expect(hold.isFull).toBe(false);
    });

    it('AC5 — overflow carries across a capacity increase and is clamped', () => {
      const hold = new MineralHold();

      // Fill the first (5) hold with a surplus; the capacity grows to 10
      // and the 3 surplus carries into the larger next hold.
      const overflow = hold.collect(8);
      expect(overflow).toBe(3);
      expect(hold.store).toBe(5);

      hold.resolve();
      expect(hold.capacity).toBe(10);
      expect(hold.store).toBe(3);
      expect(hold.isFull).toBe(false);
    });

    it('AC5 — store is clamped to [0, capacity] after resolve', () => {
      const hold = new MineralHold();

      hold.collect(100);
      hold.resolve();

      // Overflow (95) would exceed the 10-mineral next hold, so the store
      // is clamped to the new capacity.
      expect(hold.capacity).toBe(10);
      expect(hold.store).toBe(10);
      expect(hold.store).toBeLessThanOrEqual(hold.capacity);
      expect(hold.store).toBeGreaterThanOrEqual(0);
    });
  });
});

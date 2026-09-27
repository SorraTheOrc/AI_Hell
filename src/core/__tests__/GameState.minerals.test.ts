/**
 * GameState ship's hold (minerals) tests (AH-0MUBVGI62004ED9Q;
 * capacity progression AH-0MUKC6IML0082ZR4).
 *
 * Test-first task defining the contract for parent AC2: the ship's hold
 * grows with collected minerals up to a capacity, overflow is carried into
 * the next hold, the store is run-scoped (reset on startGame, never written
 * to the leaderboard). AH-0MUKC6IML0082ZR4 adds the run-scoped capacity
 * progression: the first hold fills at 5 and each resolution doubles the
 * next hold's requirement (5 → 10 → 20 → 40).
 */

import { describe, expect, it } from 'vitest';

import { GameState } from '../GameState';
import {
  DEFAULT_MINERAL_HOLD_CAPACITY,
  DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER,
} from '../rules';

describe('GameState mineral hold', () => {
  it('starts with an empty hold at the default first-hold capacity', () => {
    const gs = new GameState();
    expect(gs.minerals).toBe(0);
    expect(gs.mineralCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(gs.mineralCapacity).toBe(5);
    expect(gs.mineralHoldGrowthMultiplier).toBe(
      DEFAULT_MINERAL_HOLD_GROWTH_MULTIPLIER,
    );
    expect(gs.mineralHoldGrowthMultiplier).toBe(2);
    expect(gs.isHoldFull()).toBe(false);
  });

  it('addMinerals increases the store by the given collection amount', () => {
    const gs = new GameState();
    gs.addMinerals(1);
    expect(gs.minerals).toBe(1);
    gs.addMinerals(2);
    expect(gs.minerals).toBe(3);
  });

  it('ignores non-positive collection amounts', () => {
    const gs = new GameState();
    gs.addMinerals(0);
    gs.addMinerals(-3);
    expect(gs.minerals).toBe(0);
  });

  it('is not full at one below capacity and full exactly at capacity', () => {
    const gs = new GameState();
    gs.addMinerals(4);
    expect(gs.isHoldFull()).toBe(false);
    const overflow = gs.addMinerals(1);
    expect(gs.minerals).toBe(5);
    expect(overflow).toBe(0);
    expect(gs.isHoldFull()).toBe(true);
  });

  it('caps the store at capacity and reports the overflow', () => {
    const gs = new GameState();
    const overflow = gs.addMinerals(8);
    expect(gs.minerals).toBe(5);
    expect(overflow).toBe(3);
    expect(gs.isHoldFull()).toBe(true);
  });

  it('resolveHold grows the capacity and carries the overflow (store = collected − capacity)', () => {
    const gs = new GameState();
    gs.addMinerals(8); // store = 5, overflow = 3
    gs.resolveHold();
    expect(gs.mineralCapacity).toBe(10);
    expect(gs.minerals).toBe(3);
    expect(gs.isHoldFull()).toBe(false);
  });

  it('doubles the capacity on each resolveHold: 5 → 10 → 20 → 40', () => {
    const gs = new GameState();

    gs.addMinerals(5);
    gs.resolveHold();
    expect(gs.mineralCapacity).toBe(10);

    gs.addMinerals(10);
    gs.resolveHold();
    expect(gs.mineralCapacity).toBe(20);

    gs.addMinerals(20);
    gs.resolveHold();
    expect(gs.mineralCapacity).toBe(40);
  });

  it('clamps the carried store to the new capacity on resolveHold', () => {
    const gs = new GameState();
    gs.addMinerals(100); // store = 5, overflow = 95
    gs.resolveHold();
    // The new hold is 10, so the 95 surplus is clamped to 10.
    expect(gs.mineralCapacity).toBe(10);
    expect(gs.minerals).toBe(10);
    expect(gs.minerals).toBeLessThanOrEqual(gs.mineralCapacity);
    expect(gs.minerals).toBeGreaterThanOrEqual(0);
  });

  it('resolveHold with no overflow empties the hold', () => {
    const gs = new GameState();
    gs.addMinerals(5);
    gs.resolveHold();
    expect(gs.minerals).toBe(0);
  });

  it('resets the mineral store and capacity on startGame()', () => {
    const gs = new GameState();
    gs.addMinerals(5);
    gs.resolveHold(); // capacity grows to 10
    gs.addMinerals(10);
    gs.startGame();
    expect(gs.minerals).toBe(0);
    expect(gs.mineralCapacity).toBe(5);
    expect(gs.isHoldFull()).toBe(false);
  });

  it('does not persist the mineral store into the leaderboard JSON', () => {
    const gs = new GameState();
    gs.addMinerals(7);
    const json = gs.toJSON();
    expect(json).not.toHaveProperty('minerals');
    expect(Object.keys(json)).not.toContain('minerals');
  });
});

/**
 * GameState ship's hold (minerals) tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC2: the ship's hold
 * grows with collected minerals up to a capacity, overflow is carried into
 * the next hold, the store is run-scoped (reset on startGame, never written
 * to the leaderboard).
 */

import { describe, expect, it } from 'vitest';

import { GameState } from '../GameState';
import { DEFAULT_MINERAL_HOLD_CAPACITY } from '../rules';

describe('GameState mineral hold', () => {
  it('starts with an empty hold at the default capacity', () => {
    const gs = new GameState();
    expect(gs.minerals).toBe(0);
    expect(gs.mineralCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(gs.mineralCapacity).toBe(20);
    expect(gs.isHoldFull()).toBe(false);
  });

  it('addMinerals increases the store by the given collection amount', () => {
    const gs = new GameState();
    gs.addMinerals(1);
    expect(gs.minerals).toBe(1);
    gs.addMinerals(5);
    expect(gs.minerals).toBe(6);
  });

  it('ignores non-positive collection amounts', () => {
    const gs = new GameState();
    gs.addMinerals(0);
    gs.addMinerals(-3);
    expect(gs.minerals).toBe(0);
  });

  it('caps the store at capacity and reports the overflow', () => {
    const gs = new GameState();
    const overflow = gs.addMinerals(25);
    expect(gs.minerals).toBe(20);
    expect(overflow).toBe(5);
    expect(gs.isHoldFull()).toBe(true);
  });

  it('reports the hold full exactly at capacity (no overflow)', () => {
    const gs = new GameState();
    const overflow = gs.addMinerals(20);
    expect(gs.minerals).toBe(20);
    expect(overflow).toBe(0);
    expect(gs.isHoldFull()).toBe(true);
  });

  it('resolveHold resets the store to 0 carrying the overflow (store = collected − capacity)', () => {
    const gs = new GameState();
    gs.addMinerals(23); // store = 20, overflow = 3
    gs.resolveHold();
    expect(gs.minerals).toBe(3);
    expect(gs.isHoldFull()).toBe(false);
  });

  it('resolveHold with no overflow empties the hold', () => {
    const gs = new GameState();
    gs.addMinerals(20);
    gs.resolveHold();
    expect(gs.minerals).toBe(0);
  });

  it('resets the mineral store on startGame()', () => {
    const gs = new GameState();
    gs.addMinerals(10);
    gs.startGame();
    expect(gs.minerals).toBe(0);
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

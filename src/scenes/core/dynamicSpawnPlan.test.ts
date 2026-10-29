/**
 * Unit tests for the shared dynamic-spawn plan/release seam
 * (D3, docs/GYM_PARITY.md).
 *
 * The planners are thin wrappers over the pure `waves/*Spawner` modules (each
 * already unit-tested); what is new and shared is the **time-ordered release**
 * rule both `PlayScene` and `GymLevel` run, so that is what this file pins.
 */

import { describe, expect, it } from 'vitest';

import { releaseDueSpawns, type TimedSpawnEvent } from './dynamicSpawnPlan';

function event(timeSeconds: number, id: string): TimedSpawnEvent & { id: string } {
  return { timeSeconds, id };
}

describe('releaseDueSpawns (shared plan release rule)', () => {
  it('releases every due event in plan order and stops at the first future one', () => {
    const plan = [event(1, 'a'), event(2, 'b'), event(5, 'c')];
    const spawned: string[] = [];

    const cursor = releaseDueSpawns(plan, 0, 2, (e) => spawned.push(e.id));

    expect(spawned).toEqual(['a', 'b']);
    expect(cursor).toBe(2);
  });

  it('does not re-release events already past the cursor', () => {
    const plan = [event(1, 'a'), event(2, 'b'), event(3, 'c')];
    const spawned: string[] = [];

    // First frame releases a and b.
    let cursor = releaseDueSpawns(plan, 0, 2, (e) => spawned.push(e.id));
    // Second frame at the same elapsed time must not replay them.
    cursor = releaseDueSpawns(plan, cursor, 2, (e) => spawned.push(e.id));

    expect(spawned).toEqual(['a', 'b']);
    expect(cursor).toBe(2);
  });

  it('releases nothing before the first scheduled time', () => {
    const plan = [event(1.5, 'a')];
    const spawned: string[] = [];

    const cursor = releaseDueSpawns(plan, 0, 1.49, (e) => spawned.push(e.id));

    expect(spawned).toEqual([]);
    expect(cursor).toBe(0);
  });

  it('treats an event exactly at the elapsed time as due (no float slip)', () => {
    const plan = [event(0.1 + 0.2, 'a')]; // 0.30000000000000004
    const spawned: string[] = [];

    const cursor = releaseDueSpawns(plan, 0, 0.3, (e) => spawned.push(e.id));

    expect(spawned).toEqual(['a']);
    expect(cursor).toBe(1);
  });

  it('handles an empty plan and a cursor past the end', () => {
    expect(releaseDueSpawns([], 0, 100, () => {
      throw new Error('must not spawn');
    })).toBe(0);
    expect(releaseDueSpawns([event(1, 'a')], 1, 100, () => {
      throw new Error('must not spawn');
    })).toBe(1);
  });
});

/**
 * Shared scheduled-asteroid hazard layer (AH-0MV9AWR7A0084XJ0).
 *
 * The layer is the single plan → release lifecycle both `PlayScene` and the
 * level gyms run, so these tests assert the observable contract: the plan is
 * the shared planner's output, releases happen once each and in schedule
 * order, and the cursor/reset semantics keep a wave's schedule isolated.
 */

import { describe, expect, it, vi } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { createSeededRng } from '../../core/rng';
import { computeSpawns } from '../../waves/AsteroidSpawner';
import { AsteroidHazardLayer } from './asteroidHazard';
import { WAVE_TIME_LIMIT_SECONDS } from './waveTimeout';

/** Plans one wave on a fresh layer with a deterministic RNG. */
function planWave(
  layer: AsteroidHazardLayer,
  globalWaveIndex = 0,
  seed = 1234,
): readonly ReturnType<typeof computeSpawns>[number][] {
  return layer.plan(
    globalWaveIndex,
    GAME_WIDTH,
    GAME_HEIGHT,
    WAVE_TIME_LIMIT_SECONDS,
    createSeededRng(seed),
  );
}

describe('AsteroidHazardLayer — shared plan/release lifecycle', () => {
  it('plans exactly the shared planner output for the wave and seed', () => {
    const layer = new AsteroidHazardLayer();
    const expected = computeSpawns(
      2,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      createSeededRng(99),
    );

    const plan = planWave(layer, 2, 99);

    expect(plan).toEqual(expected);
    expect(layer.getPlan()).toEqual(expected);
    expect(layer.getReleasedCount()).toBe(0);
  });

  it('is deterministic: the same seed yields the same plan, a different seed does not', () => {
    const a = new AsteroidHazardLayer();
    const b = new AsteroidHazardLayer();
    const c = new AsteroidHazardLayer();

    expect(planWave(a, 4, 7)).toEqual(planWave(b, 4, 7));
    expect(planWave(c, 4, 8)).not.toEqual(planWave(a, 4, 7));
  });

  it('releases nothing before the first scheduled time, then exactly the due events in order', () => {
    const layer = new AsteroidHazardLayer();
    const plan = planWave(layer);
    expect(plan.length).toBeGreaterThan(1);

    const spawn = vi.fn();
    const firstDue = plan[0].timeSeconds;

    // Just before the first event: nothing released.
    expect(layer.releaseDue(firstDue - 0.01, spawn)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(layer.getReleasedCount()).toBe(0);

    // At the first event's time: exactly one released (the epsilon makes the
    // scheduled instant inclusive).
    expect(layer.releaseDue(firstDue + 1e-9, spawn)).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe(plan[0]);

    // Advancing to the end releases the rest, still in schedule order.
    layer.releaseDue(WAVE_TIME_LIMIT_SECONDS, spawn);
    expect(spawn).toHaveBeenCalledTimes(plan.length);
    expect(spawn.mock.calls.map(([event]) => event)).toEqual([...plan]);
    expect(layer.getReleasedCount()).toBe(plan.length);
  });

  it('never releases the same event twice when releaseDue is called repeatedly', () => {
    const layer = new AsteroidHazardLayer();
    const plan = planWave(layer);
    const spawn = vi.fn();

    for (let tick = 0; tick <= 40; tick += 1) {
      layer.releaseDue(tick, spawn);
    }

    expect(spawn).toHaveBeenCalledTimes(plan.length);
  });

  it('replanning replaces the previous wave plan and resets the cursor', () => {
    const layer = new AsteroidHazardLayer();
    planWave(layer, 0, 11);
    layer.releaseDue(WAVE_TIME_LIMIT_SECONDS, () => {});

    const secondPlan = planWave(layer, 1, 12);

    expect(layer.getPlan()).toEqual(secondPlan);
    expect(layer.getReleasedCount()).toBe(0);
    // The replacement plan is live immediately: its first event can fire.
    const spawn = vi.fn();
    layer.releaseDue(secondPlan[0].timeSeconds + 1e-9, spawn);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reset drops the plan and the cursor so a disabled hazard can never fire', () => {
    const layer = new AsteroidHazardLayer();
    planWave(layer);
    const spawn = vi.fn();

    layer.reset();

    expect(layer.getPlan()).toEqual([]);
    expect(layer.getReleasedCount()).toBe(0);
    expect(layer.releaseDue(WAVE_TIME_LIMIT_SECONDS, spawn)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });
});

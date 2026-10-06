import { describe, expect, it } from 'vitest';

import {
  detonateWaveTimeoutSurvivors,
  type WaveTimeoutDetonatable,
} from './waveTimeout';

/** Minimal recording detonatable for the shared helper. */
class RecordingEntity implements WaveTimeoutDetonatable {
  alive = true;
  destroyCalls: number[] = [];

  destroySelf(scale = 1): void {
    this.alive = false;
    this.destroyCalls.push(scale);
  }
}

describe('waveTimeout — shared helper is a no-op (AH-0MUNS3ZQ1002DJ9S)', () => {
  it('returns 0 and leaves every survivor alive with no explosion VFX', () => {
    const survivors = [new RecordingEntity(), new RecordingEntity()];

    const detonated = detonateWaveTimeoutSurvivors(survivors);

    // No entity is detonated (the retired major-explosion cue never plays).
    expect(detonated).toBe(0);
    for (const entity of survivors) {
      expect(entity.alive).toBe(true);
      expect(entity.destroyCalls).toEqual([]);
    }
  });

  it('is a no-op even with an exclude predicate supplied', () => {
    const asteroid = new RecordingEntity();
    const ship = new RecordingEntity();

    const detonated = detonateWaveTimeoutSurvivors(
      [asteroid, ship],
      (entity) => entity === asteroid,
    );

    expect(detonated).toBe(0);
    expect(asteroid.alive).toBe(true);
    expect(ship.alive).toBe(true);
    expect(asteroid.destroyCalls).toEqual([]);
    expect(ship.destroyCalls).toEqual([]);
  });
});

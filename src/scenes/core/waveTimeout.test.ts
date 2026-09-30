import { afterEach, describe, expect, it, vi } from 'vitest';

import * as effectsModule from '../../audio/effects';
import {
  detonateWaveTimeoutSurvivors,
  WAVE_TIMEOUT_EXPLOSION_SCALE,
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

describe('waveTimeout — shared wave-timeout detonation helper (AH-0MUK5ONAA0007YEX)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detonates every alive survivor at the shared 10x scale, playing the shared major-explosion cue once each', () => {
    const cue = vi
      .spyOn(effectsModule, 'playMajorExplosionSound')
      .mockImplementation(() => undefined);
    const survivors = [new RecordingEntity(), new RecordingEntity()];

    const detonated = detonateWaveTimeoutSurvivors(survivors);

    expect(detonated).toBe(2);
    expect(cue).toHaveBeenCalledTimes(2);
    for (const entity of survivors) {
      expect(entity.alive).toBe(false);
      expect(entity.destroyCalls).toEqual([WAVE_TIMEOUT_EXPLOSION_SCALE]);
    }
  });

  it('skips entities already dead and does not play the cue for them', () => {
    const cue = vi
      .spyOn(effectsModule, 'playMajorExplosionSound')
      .mockImplementation(() => undefined);
    const dead = new RecordingEntity();
    dead.alive = false;
    const live = new RecordingEntity();

    const detonated = detonateWaveTimeoutSurvivors([dead, live]);

    expect(detonated).toBe(1);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(dead.destroyCalls).toEqual([]);
    expect(live.destroyCalls).toEqual([WAVE_TIMEOUT_EXPLOSION_SCALE]);
  });

  it('honours the exclude predicate (carried-over asteroids survive with no cue)', () => {
    const cue = vi
      .spyOn(effectsModule, 'playMajorExplosionSound')
      .mockImplementation(() => undefined);
    const asteroid = new RecordingEntity();
    const ship = new RecordingEntity();

    const detonated = detonateWaveTimeoutSurvivors(
      [asteroid, ship],
      (entity) => entity === asteroid,
    );

    expect(detonated).toBe(1);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(asteroid.alive).toBe(true);
    expect(asteroid.destroyCalls).toEqual([]);
    expect(ship.destroyCalls).toEqual([WAVE_TIMEOUT_EXPLOSION_SCALE]);
  });
});

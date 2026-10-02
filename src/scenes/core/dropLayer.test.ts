/**
 * Unit tests for the shared power-up drop layer (AH-0MUII3CXX0023H24, AC1–AC4).
 *
 * These exercise the pure helpers directly with structural doubles, so the
 * lifecycle/collection/magnet/cue rules are pinned independently of any
 * scene. Cross-scene behavioural equivalence lives in
 * `CombatScene.equivalence.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as effects from '../../audio/effects';
import { POWER_UP_DROP_SIZE } from '../../core/constants';
import { DEFAULT_RULES } from '../../core/rules';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { WeightedRandomSpawner } from '../../powerups/spawner';
import type { DropId } from '../../powerups/types';
import { WEAPON_DROP_IDS } from '../../powerups/types';
import { dropCollectRadius } from '../../powerups/icons';
import {
  advanceDropLifecycles,
  applyDropMagnet,
  buildDefaultDropSpawner,
  collectOverlappingDrops,
  playDropPickupCue,
  type DropLifecycleDrop,
} from './dropLayer';

/** A drop double with a real PowerUp lifecycle and spied Graphics. */
function makeDrop(
  overrides: Partial<{
    x: number;
    y: number;
    scale: number;
    state: PowerUpState;
    absorbing: boolean;
  }> = {},
): {
  drop: DropLifecycleDrop;
  graphics: { setPosition: ReturnType<typeof vi.fn>; setScale: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  powerUp: PowerUp;
} {
  const powerUp = new PowerUp('P5');
  if (overrides.scale !== undefined) powerUp.currentScale = overrides.scale;
  if (overrides.state !== undefined) powerUp.state = overrides.state;
  const graphics = {
    setPosition: vi.fn(),
    setScale: vi.fn(),
    destroy: vi.fn(),
  };
  const drop: DropLifecycleDrop = {
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    graphics,
    powerUp,
    absorbing: overrides.absorbing,
  };
  return { drop, graphics, powerUp };
}

describe('dropLayer — buildDefaultDropSpawner (AC1)', () => {
  it('builds a weighted spawner over the combined power-up + weapon pool with the configured weights', () => {
    const spawner = buildDefaultDropSpawner(
      DEFAULT_RULES.powerUpWeights,
      DEFAULT_RULES.weaponWeights,
      () => 0,
    );
    const weights = (spawner as WeightedRandomSpawner<DropId>).getWeights();
    for (const id of ['P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'] as const) {
      expect(weights[id]).toBe(DEFAULT_RULES.powerUpWeights[id]);
    }
    for (const id of ['spread', 'dual', 'rapid', 'reset'] as const) {
      expect(weights[id]).toBe(DEFAULT_RULES.weaponWeights[id]);
    }
    // Deterministic rng 0 selects the first pool entry.
    expect(spawner.next()).toBe('P3');
  });

  it('gives P8 Extra Life a ≈ 3/27 share of power-up draws (≈2.8× its former 1/25)', () => {
    // Deterministic sweep RNG: sample evenly across [0, 1) so each id's count
    // is exactly proportional to its weight — no statistical noise and no seed
    // dependence. The sample count is a multiple of the combined pool weight
    // (27 power-up + 14 weapon = 41), so every band boundary lands exactly.
    const SAMPLE_COUNT = 41_000;
    let cursor = 0;
    const sweepRng = () => cursor++ / SAMPLE_COUNT;
    const spawner = buildDefaultDropSpawner(
      DEFAULT_RULES.powerUpWeights,
      DEFAULT_RULES.weaponWeights,
      sweepRng,
    );

    let powerUps = 0;
    let extraLives = 0;
    for (let n = 0; n < SAMPLE_COUNT; n++) {
      const id = spawner.next();
      if ((WEAPON_DROP_IDS as readonly DropId[]).includes(id)) continue;
      powerUps += 1;
      if (id === 'P8') extraLives += 1;
    }

    // P8 weight 3 of the 27 total power-up weight → exactly 3/27 = 1/9.
    const p8Share = extraLives / powerUps;
    expect(p8Share).toBeCloseTo(3 / 27, 3);
    // Tied to the shipped weight table (not a hard-coded expectation).
    const weightTotal = Object.values(DEFAULT_RULES.powerUpWeights).reduce(
      (a, b) => a + b,
      0,
    );
    expect(p8Share).toBeCloseTo(DEFAULT_RULES.powerUpWeights.P8 / weightTotal, 3);
    // Relative weight tripled (1 → 3): ≈ 2.8× the former 1/25 normalised share.
    expect(p8Share / (1 / 25)).toBeCloseTo((3 / 27) / (1 / 25), 2);
  });
});

describe('dropLayer — advanceDropLifecycles (AC1)', () => {
  it('advances the lifecycle, syncs the graphics scale and keeps live drops', () => {
    const { drop, graphics, powerUp } = makeDrop();
    const kept = advanceDropLifecycles([drop], 0.25);

    expect(kept).toEqual([drop]);
    expect(powerUp.currentScale).toBeCloseTo(0.5, 5);
    expect(graphics.setScale).toHaveBeenCalledWith(powerUp.currentScale);
    expect(graphics.destroy).not.toHaveBeenCalled();
  });

  it('destroys despawned Graphics, drops them and runs the despawn hook once', () => {
    const powerUp = new PowerUp('P5', 0.1, 0.1, 0.3);
    const graphics = { setPosition: vi.fn(), setScale: vi.fn(), destroy: vi.fn() };
    const drop: DropLifecycleDrop = { x: 0, y: 0, graphics, powerUp };
    const onDespawn = vi.fn();

    const kept = advanceDropLifecycles([drop], 0.5, onDespawn);

    expect(kept).toEqual([]);
    expect(powerUp.state).toBe(PowerUpState.DESPAWNED);
    expect(onDespawn).toHaveBeenCalledTimes(1);
    expect(onDespawn).toHaveBeenCalledWith(drop);
    expect(graphics.destroy).toHaveBeenCalledTimes(1);
  });

  it('skips absorbing drops (owned by their absorb animation)', () => {
    const { drop, graphics } = makeDrop({ absorbing: true });
    const kept = advanceDropLifecycles([drop], 0.5);
    expect(kept).toEqual([]);
    expect(graphics.setScale).not.toHaveBeenCalled();
  });
});

describe('dropLayer — collectOverlappingDrops (AC1)', () => {
  const hull = 10; // SHIP_SIZE / 2
  const fullScale = 1;
  const boundary = hull + dropCollectRadius(POWER_UP_DROP_SIZE, fullScale);

  it('collects a collectible drop whose hull touches the visible bubble', () => {
    const { drop } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
    const onCollect = vi.fn();
    const kept = collectOverlappingDrops([drop], { x: 0, y: 0 }, onCollect);
    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(onCollect).toHaveBeenCalledWith(drop);
    expect(kept).toEqual([]);
  });

  it('leaves a drop just beyond the bubble boundary untouched', () => {
    const { drop } = makeDrop({ x: boundary + 1, y: 0, scale: fullScale });
    const onCollect = vi.fn();
    const kept = collectOverlappingDrops([drop], { x: 0, y: 0 }, onCollect);
    expect(onCollect).not.toHaveBeenCalled();
    expect(kept).toEqual([drop]);
  });

  it('does not collect a drop below the 3% scale gate', () => {
    const { drop } = makeDrop({ x: 0, y: 0, scale: 0.02 });
    const onCollect = vi.fn();
    const kept = collectOverlappingDrops([drop], { x: 0, y: 0 }, onCollect);
    expect(onCollect).not.toHaveBeenCalled();
    expect(kept).toEqual([drop]);
  });

  it('returns the drops untouched when there is no player', () => {
    const { drop } = makeDrop({ scale: fullScale });
    const onCollect = vi.fn();
    expect(collectOverlappingDrops([drop], null, onCollect)).toEqual([drop]);
    expect(onCollect).not.toHaveBeenCalled();
  });
});

describe('dropLayer — applyDropMagnet (AC2)', () => {
  it('pulls a collectible drop toward the player and syncs its graphics', () => {
    const { drop, graphics } = makeDrop({ x: 30, y: 0, scale: 1 });
    applyDropMagnet([drop], { x: 0, y: 0 }, 1, 0.5); // 120 px/s × 0.5 s
    expect(drop.x).toBeCloseTo(0, 5);
    expect(drop.y).toBeCloseTo(0, 5);
    expect(graphics.setPosition).toHaveBeenCalledWith(drop.x, drop.y);
  });

  it('does nothing without magnet stacks', () => {
    const { drop, graphics } = makeDrop({ x: 30, y: 0, scale: 1 });
    applyDropMagnet([drop], { x: 0, y: 0 }, 0, 0.5);
    expect(drop.x).toBe(30);
    expect(graphics.setPosition).not.toHaveBeenCalled();
  });

  it('does nothing without a player', () => {
    const { drop } = makeDrop({ x: 30, y: 0, scale: 1 });
    applyDropMagnet([drop], null, 1, 0.5);
    expect(drop.x).toBe(30);
  });
});

describe('dropLayer — playDropPickupCue (AC4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('plays the generic pop plus the dedicated P5/P8/P9 cue', () => {
    const pop = vi.spyOn(effects, 'playPowerUpCollectPopSound');
    const speed = vi.spyOn(effects, 'playSpeedBoostCollectSound');
    const life = vi.spyOn(effects, 'playExtraLifeCollectSound');
    const magnet = vi.spyOn(effects, 'playMagnetCollectSound');
    const generic = vi.spyOn(effects, 'playPowerUpCollectSound');

    playDropPickupCue({ dropId: 'P5' });
    expect(pop).toHaveBeenCalledTimes(1);
    expect(speed).toHaveBeenCalledTimes(1);

    playDropPickupCue({ dropId: 'P8' });
    expect(life).toHaveBeenCalledTimes(1);

    playDropPickupCue({ dropId: 'P9' });
    expect(magnet).toHaveBeenCalledTimes(1);

    expect(generic).not.toHaveBeenCalled();
  });

  it('plays the dedicated weapon/Reset cue for weapon drops', () => {
    const spread = vi.spyOn(effects, 'playSpreadPickupSound');
    const dual = vi.spyOn(effects, 'playDualPickupSound');
    const rapid = vi.spyOn(effects, 'playRapidPickupSound');
    const reset = vi.spyOn(effects, 'playResetPickupSound');
    const generic = vi.spyOn(effects, 'playPowerUpCollectSound');

    playDropPickupCue({ dropId: 'spread', weaponDropId: 'spread' });
    playDropPickupCue({ dropId: 'dual', weaponDropId: 'dual' });
    playDropPickupCue({ dropId: 'rapid', weaponDropId: 'rapid' });
    playDropPickupCue({ dropId: 'reset', weaponDropId: 'reset' });

    expect(spread).toHaveBeenCalledTimes(1);
    expect(dual).toHaveBeenCalledTimes(1);
    expect(rapid).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(generic).not.toHaveBeenCalled();
  });

  it('falls back to the generic chime for types without a dedicated cue', () => {
    const generic = vi.spyOn(effects, 'playPowerUpCollectSound');
    const pop = vi.spyOn(effects, 'playPowerUpCollectPopSound');
    playDropPickupCue({ dropId: 'P3' });
    playDropPickupCue({ dropId: 'P4' });
    expect(generic).toHaveBeenCalledTimes(2);
    expect(pop).toHaveBeenCalledTimes(2);
  });
});

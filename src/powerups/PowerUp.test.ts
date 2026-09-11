import { describe, it, expect, beforeEach } from 'vitest';

import {
  POWER_UP_GROW_DURATION,
  POWER_UP_SHRINK_DURATION,
  POWER_UP_LIFETIME,
  POWER_UP_COLLECTION_THRESHOLD,
  POWER_UP_SPAWN_INTERVAL as CORE_SPAWN_INTERVAL,
} from '../core/constants';

import {
  PowerUpType,
  PowerUpId,
  POWER_UP_CATALOGUE,
} from './types';
import {
  PowerUp,
  PowerUpState,
  POWER_UP_LIFECYCLE_GROW_DURATION,
  POWER_UP_LIFECYCLE_SHRINK_DURATION,
  POWER_UP_LIFECYCLE_TOTAL_LIFETIME,
  POWER_UP_COLLECTION_THRESHOLD_PERCENT,
  POWER_UP_SPAWN_INTERVAL,
  roundRobinSpawner,
  spawnOrder,
  getPowerUpById,
} from './PowerUp';

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_GROW_DURATION = 0.5; // seconds
const TEST_SHRINK_DURATION = 0.5; // seconds
const TEST_TOTAL_LIFETIME = POWER_UP_LIFETIME; // seconds — mirrors POWER_UP_LIFETIME (12.5 s, 2.5× original)

// ── Constants tests ─────────────────────────────────────────────────

describe('power-up lifecycle constants', () => {
  it('defines a positive spawn interval (12.5 s default)', () => {
    expect(POWER_UP_SPAWN_INTERVAL).toBeGreaterThan(0);
  });

  it('defines a positive total lifetime (12.5 s default)', () => {
    expect(POWER_UP_LIFECYCLE_TOTAL_LIFETIME).toBeGreaterThan(0);
  });

  it('defines positive grow and shrink windows', () => {
    expect(POWER_UP_LIFECYCLE_GROW_DURATION).toBeGreaterThan(0);
    expect(POWER_UP_LIFECYCLE_SHRINK_DURATION).toBeGreaterThan(0);
  });

  it('defines a small collection threshold (3%)', () => {
    expect(POWER_UP_COLLECTION_THRESHOLD_PERCENT).toBeGreaterThan(0);
    expect(POWER_UP_COLLECTION_THRESHOLD_PERCENT).toBeLessThan(10);
  });

  it('mirrors the canonical values in src/core/constants.ts (single source of truth)', () => {
    expect(POWER_UP_LIFECYCLE_GROW_DURATION).toBe(POWER_UP_GROW_DURATION);
    expect(POWER_UP_LIFECYCLE_SHRINK_DURATION).toBe(POWER_UP_SHRINK_DURATION);
    expect(POWER_UP_LIFECYCLE_TOTAL_LIFETIME).toBe(POWER_UP_LIFETIME);
    expect(POWER_UP_COLLECTION_THRESHOLD_PERCENT).toBe(
      POWER_UP_COLLECTION_THRESHOLD,
    );
    expect(POWER_UP_SPAWN_INTERVAL).toBe(CORE_SPAWN_INTERVAL);
  });
});

// ── Catalogue tests ─────────────────────────────────────────────────

describe('power-up catalogue (types)', () => {
  it('contains the non-combat types P5, P8, P9 (plus combat P3,P4,P6,P7)', () => {
    const ids = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];
    expect(ids).toContain('P5');
    expect(ids).toContain('P8');
    expect(ids).toContain('P9');
    // Combat gym adds P3,P4,P6,P7 (AH-0MTC2P6G3007PJ40)
    expect(ids).toContain('P3');
    expect(ids).toContain('P4');
    expect(ids).toContain('P6');
    expect(ids).toContain('P7');
  });

  it('P5 is Speed Boost', () => {
    const p5 = getPowerUpById('P5');
    expect(p5).toBeDefined();
    expect(p5!.type).toBe(PowerUpType.SPEED_BOOST);
    expect(p5!.id).toBe('P5');
  });

  it('P8 is Extra Life', () => {
    const p8 = getPowerUpById('P8');
    expect(p8).toBeDefined();
    expect(p8!.type).toBe(PowerUpType.EXTRA_LIFE);
    expect(p8!.id).toBe('P8');
  });

  it('P9 is Magnet', () => {
    const p9 = getPowerUpById('P9');
    expect(p9).toBeDefined();
    expect(p9!.type).toBe(PowerUpType.MAGNET);
    expect(p9!.id).toBe('P9');
  });

  it('throws for an unknown power-up id', () => {
    expect(() => getPowerUpById('P1' as PowerUpId)).toThrow('Unknown power-up');
  });
});

// ── Round-robin spawner AC1: spawn order ────────────────────────────

describe('round-robin spawner AC2: spawn cadence', () => {
  it('produces exactly one spawn per interval slot', () => {
    expect(roundRobinSpawner(1)).toHaveLength(1);
    expect(roundRobinSpawner(2)).toHaveLength(2);
    expect(roundRobinSpawner(5)).toHaveLength(5);
  });

  it('spawn interval equals drop lifetime — the next spawn coincides with the previous despawn (exactly one drop on screen)', () => {
    // One spawn every 12.5 s, 12.5 s lifetime → at every spawn tick the previous
    // drop has just finished fading, so at most one drop exists at a time.
    expect(POWER_UP_SPAWN_INTERVAL).toBe(POWER_UP_LIFECYCLE_TOTAL_LIFETIME);
  });

  it('a drop spawned at t=0 despawns exactly when the next spawn fires', () => {
    const lifespan = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    lifespan.advance(POWER_UP_SPAWN_INTERVAL);
    expect(lifespan.state).toBe(PowerUpState.DESPAWNED);

    // Just before the spawn tick the drop is still alive (not yet removed).
    const nearlyDone = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    nearlyDone.advance(POWER_UP_SPAWN_INTERVAL - 0.001);
    expect(nearlyDone.state).not.toBe(PowerUpState.DESPAWNED);
  });
});

describe('round-robin spawner AC1: spawn order', () => {
  it('cycles P5 → P8 → P9 in ascending GDD order', () => {
    const order = roundRobinSpawner(3);
    expect(order[0]).toBe('P5');
    expect(order[1]).toBe('P8');
    expect(order[2]).toBe('P9');
  });

  it('repeats the cycle', () => {
    const order = roundRobinSpawner(6);
    expect(order[0]).toBe('P5');
    expect(order[1]).toBe('P8');
    expect(order[2]).toBe('P9');
    expect(order[3]).toBe('P5');
    expect(order[4]).toBe('P8');
    expect(order[5]).toBe('P9');
  });

  it('handles partial cycles correctly', () => {
    const order = roundRobinSpawner(4);
    expect(order).toEqual(['P5', 'P8', 'P9', 'P5']);
  });

  it('handles a single spawn', () => {
    const order = roundRobinSpawner(1);
    expect(order).toEqual(['P5']);
  });
});

describe('spawnOrder', () => {
  it('returns the fixed cycle array', () => {
    expect(spawnOrder()).toEqual(['P5', 'P8', 'P9']);
  });

  it('returns a new array each call (not shared reference)', () => {
    const a = spawnOrder();
    const b = spawnOrder();
    expect(a).not.toBe(b);
  });
});

// ── PowerUp lifecycle AC3: grow/shrink windows ──────────────────────

describe('PowerUp lifecycle AC3: delta-time driven growth/shrink', () => {
  let powerUp: PowerUp;

  beforeEach(() => {
    powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
  });

  it('starts at scale 0 (not yet visible)', () => {
    expect(powerUp.currentScale).toBeCloseTo(0);
    expect(powerUp.state).toBe(PowerUpState.GROWING);
  });

  it('grows from 0 to full over the grow window', () => {
    // Advance by the full grow duration
    powerUp.advance(TEST_GROW_DURATION);
    expect(powerUp.currentScale).toBeCloseTo(1);
    expect(powerUp.state).toBe(PowerUpState.HOLDING);
  });

  it('grows proportionally within the grow window', () => {
    // Half the grow duration → half the scale
    powerUp.advance(TEST_GROW_DURATION / 2);
    expect(powerUp.currentScale).toBeCloseTo(0.5);
  });

  it('framerate-independent: different delta sequences reach the same scale', () => {
    // Two deltas of 0.25 s each should reach scale 0.5
    let pu1 = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    pu1.advance(0.25);
    pu1.advance(0.25);

    // One delta of 0.5 s should reach the same scale
    let pu2 = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    pu2.advance(0.5);

    expect(pu1.currentScale).toBeCloseTo(pu2.currentScale);
  });

  it('holds at full size for the hold duration', () => {
    // Grow (0.5 s) + hold (4.0 s)
    powerUp.advance(TEST_GROW_DURATION + TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    expect(powerUp.state).toBe(PowerUpState.HOLDING);
    expect(powerUp.currentScale).toBeCloseTo(1);
  });

  it('shrinks from full to 0 over the shrink window', () => {
    // Grow + hold, then shrink
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    powerUp.advance(TEST_SHRINK_DURATION);
    expect(powerUp.currentScale).toBeCloseTo(0);
    expect(powerUp.state).toBe(PowerUpState.DESPAWNED);
  });

  it('shrinks proportionally within the shrink window', () => {
    // Grow + hold, then half shrink
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    powerUp.advance(TEST_SHRINK_DURATION / 2);
    expect(powerUp.currentScale).toBeCloseTo(0.5);
    expect(powerUp.state).toBe(PowerUpState.SHRINKING);
  });

  it('is framerate-independent during shrink too', () => {
    let pu1 = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    pu1.advance(TEST_GROW_DURATION);
    pu1.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    pu1.advance(0.25);
    pu1.advance(0.25);

    let pu2 = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    pu2.advance(TEST_GROW_DURATION);
    pu2.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    pu2.advance(TEST_SHRINK_DURATION);

    // After full shrink both should be at 0
    expect(pu1.currentScale).toBeCloseTo(pu2.currentScale);
  });
});

// ── PowerUp lifecycle AC4: collection threshold ─────────────────────

describe('PowerUp lifecycle AC4: 3% collection threshold', () => {
  let powerUp: PowerUp;

  beforeEach(() => {
    powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
  });

  it('is NOT collectible during early growth (below 3%)', () => {
    // Advance to just below the 3% threshold
    const thresholdTime = (POWER_UP_COLLECTION_THRESHOLD_PERCENT / 100) * TEST_GROW_DURATION;
    powerUp.advance(thresholdTime - 0.001);
    expect(powerUp.currentScale).toBeCloseTo(
      ((thresholdTime - 0.001) / TEST_GROW_DURATION),
    );
    expect(powerUp.isCollectible()).toBe(false);
  });

  it('becomes collectible once scale exceeds 3%', () => {
    // Advance past 3% threshold
    const thresholdTime = (POWER_UP_COLLECTION_THRESHOLD_PERCENT / 100) * TEST_GROW_DURATION;
    powerUp.advance(thresholdTime + 0.01);
    expect(powerUp.isCollectible()).toBe(true);
  });

  it('is collectible throughout the hold phase', () => {
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.advance(2); // well into hold phase
    expect(powerUp.isCollectible()).toBe(true);
  });

  it('is NOT collectible after shrinking below 3%', () => {
    // Grow + hold + most of shrink
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    // Shrink until scale is just below 3%: scale = 1 - elapsed/shrinkDuration
    // We want 1 - elapsed/0.5 < 0.03 → elapsed > 0.485
    powerUp.advance(TEST_SHRINK_DURATION * (1 - POWER_UP_COLLECTION_THRESHOLD_PERCENT / 100) + 0.001);
    expect(powerUp.isCollectible()).toBe(false);
  });

  it('returns the correct threshold value (3%)', () => {
    expect(POWER_UP_COLLECTION_THRESHOLD_PERCENT).toBe(3);
  });

  it('is collectible just above 3%', () => {
    // At exactly 3% the scale is 0.03 which is NOT > 0.03.
    // Advance slightly past the threshold so scale > 3%.
    const thresholdTime = (POWER_UP_COLLECTION_THRESHOLD_PERCENT / 100) * TEST_GROW_DURATION;
    powerUp.advance(thresholdTime + 0.001);
    expect(powerUp.isCollectible()).toBe(true);
  });
});

// ── PowerUp lifecycle AC5: uncollected despawn ──────────────────────

describe('PowerUp lifecycle AC5: uncollected despawn', () => {
  let powerUp: PowerUp;

  beforeEach(() => {
    powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
  });

  it('reaches DESPAWNED state after full lifecycle', () => {
    powerUp.advance(TEST_GROW_DURATION + TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION + TEST_SHRINK_DURATION + 0.1);
    expect(powerUp.state).toBe(PowerUpState.DESPAWNED);
  });

  it('remains at scale 0 after despawn', () => {
    powerUp.advance(TEST_GROW_DURATION + TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION + TEST_SHRINK_DURATION + 1);
    expect(powerUp.currentScale).toBeCloseTo(0);
  });

  it('is not collectible after despawn', () => {
    powerUp.advance(TEST_GROW_DURATION + TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION + TEST_SHRINK_DURATION + 1);
    expect(powerUp.isCollectible()).toBe(false);
  });

  it('does not apply any effect when despawned naturally', () => {
    // Despawn the drop naturally without collecting it.
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    powerUp.advance(TEST_SHRINK_DURATION + 1);

    // After full lifecycle the drop is gone: it cannot be collected
    // and no effect is ever applied (AC5).
    const effectAfterDespawn = powerUp.tryCollect();
    expect(effectAfterDespawn).toBeUndefined();
  });

  it('has a canCollect flag that becomes false after collection/despawn', () => {
    powerUp.advance(TEST_GROW_DURATION);
    expect(powerUp.canCollect()).toBe(true);

    powerUp.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    powerUp.advance(TEST_SHRINK_DURATION + 1);
    expect(powerUp.canCollect()).toBe(false);
  });
});

// ── PowerUp collection ──────────────────────────────────────────────

describe('PowerUp collection', () => {
  it('applies effect once when collected during hold phase', () => {
    const powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    powerUp.advance(TEST_GROW_DURATION); // now at full size, holding
    const effect = powerUp.tryCollect();
    expect(effect).toBeDefined();
    expect(effect?.type).toBe(PowerUpType.SPEED_BOOST);
  });

  it('does not apply effect again after collection', () => {
    const powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.tryCollect();
    // Try to collect again — should return undefined
    const second = powerUp.tryCollect();
    expect(second).toBeUndefined();
  });

  it('does not apply effect if collected below 3% threshold', () => {
    const powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    // Advance just a tiny bit — below 3%
    powerUp.advance(0.001);
    const effect = powerUp.tryCollect();
    expect(effect).toBeUndefined();
    expect(powerUp.canCollect()).toBe(false);
  });

  it('does not apply effect if collected during shrink below 3%', () => {
    const powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    powerUp.advance(TEST_GROW_DURATION);
    powerUp.advance(TEST_TOTAL_LIFETIME - TEST_GROW_DURATION - TEST_SHRINK_DURATION);
    // Shrink almost to the end — below 3%
    powerUp.advance(TEST_SHRINK_DURATION * 0.98);
    const effect = powerUp.tryCollect();
    expect(effect).toBeUndefined();
  });

  it('tracks whether it has been collected', () => {
    const powerUp = new PowerUp('P5', TEST_GROW_DURATION, TEST_SHRINK_DURATION, TEST_TOTAL_LIFETIME);
    powerUp.advance(TEST_GROW_DURATION);
    expect(powerUp.isCollected()).toBe(false);
    powerUp.tryCollect();
    expect(powerUp.isCollected()).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';

import { PowerUpType } from './types';
import {
  EffectsRegistry,
  P5_SPEED_MULTIPLIER,
  P8_LIVES_START,
  P8_LIVES_MAX,
  P9_MAX_STACKS,
  applySpeedMultiplier,
  magnetRadius,
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
} from './effects';
import { MAX_SPEED, SHIP_SIZE } from '../core/constants';

// Movement config used to verify live speed application.
const BASE_CONFIG = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
};

describe('P5 Speed Boost (AC1): +50% live speed for 10 s', () => {
  it('exposes a 1.5× multiplier while active', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    expect(reg.speedMultiplier()).toBe(P5_SPEED_MULTIPLIER);
    expect(P5_SPEED_MULTIPLIER).toBe(1.5);
  });

  it('applies the multiplier live to both thrust and max-speed', () => {
    const boosted = applySpeedMultiplier(BASE_CONFIG, P5_SPEED_MULTIPLIER);
    expect(boosted.thrust).toBeCloseTo(BASE_CONFIG.thrust * 1.5);
    expect(boosted.maxSpeed).toBeCloseTo(BASE_CONFIG.maxSpeed * 1.5);
    expect(boosted.friction).toBe(BASE_CONFIG.friction);
  });

  it('lasts 10 s then is removed (multiplier back to 1)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(9.999);
    expect(reg.speedMultiplier()).toBe(1.5); // still active just before expiry
    reg.tick(0.001 + 0.001); // cross 10 s
    expect(reg.speedMultiplier()).toBe(1);
    expect(reg.isActive('P5')).toBe(false);
  });

  it('is inert before any pickup', () => {
    const reg = new EffectsRegistry();
    expect(reg.speedMultiplier()).toBe(1);
    expect(reg.isActive('P5')).toBe(false);
  });
});

describe('P5 timer refresh (AC2): refresh, not additive, not ignored', () => {
  it('refreshes an active P5 to the full 10 s duration', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(6); // 4 s remaining
    expect(reg.remaining('P5')).toBeCloseTo(4);

    reg.applyCollect('P5'); // re-collect
    expect(reg.remaining('P5')).toBeCloseTo(10); // refreshed, not 14 (additive)
    expect(reg.speedMultiplier()).toBe(1.5);
  });

  it('does not stack duration across repeated refreshes (never additive)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(1);
    reg.applyCollect('P5');
    reg.tick(1);
    reg.applyCollect('P5');
    // Refreshed twice — the timer is 10 s, never 10+10=20.
    expect(reg.remaining('P5')).toBeCloseTo(10);
    reg.tick(10); // one full duration after the last refresh
    expect(reg.isActive('P5')).toBe(false);
    // Had durations accumulated (additive), the effect would still be active.
  });

  it('refresh is not ignored: re-collecting extends the active window', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(10); // expires
    reg.applyCollect('P5'); // re-collect after expiry
    expect(reg.isActive('P5')).toBe(true);
    expect(reg.remaining('P5')).toBeCloseTo(10);
  });
});

describe('P8 Extra Life (AC3): +1 life, start 3, cap 5', () => {
  it('starts at 3 lives', () => {
    const reg = new EffectsRegistry();
    expect(reg.lives()).toBe(P8_LIVES_START);
    expect(P8_LIVES_START).toBe(3);
  });

  it('adds +1 life on each pickup', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P8');
    expect(reg.lives()).toBe(4);
    reg.applyCollect('P8');
    expect(reg.lives()).toBe(5);
  });

  it('caps at 5 lives; excess pickups are ignored', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 10; i++) {
      reg.applyCollect('P8');
    }
    expect(reg.lives()).toBe(P8_LIVES_MAX);
    expect(P8_LIVES_MAX).toBe(5);
  });

  it('does not touch the speed multiplier', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P8');
    expect(reg.speedMultiplier()).toBe(1);
  });
});

describe('P9 Magnet (AC4): one permanent stack per pickup, cap 5', () => {
  it('starts at 0 stacks', () => {
    const reg = new EffectsRegistry();
    expect(reg.magnetStacks()).toBe(0);
  });

  it('adds one stack per pickup', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P9');
    expect(reg.magnetStacks()).toBe(1);
    reg.applyCollect('P9');
    expect(reg.magnetStacks()).toBe(2);
    reg.applyCollect('P9');
    expect(reg.magnetStacks()).toBe(3);
  });

  it('caps at 5 stacks; pickups beyond 5 are no-ops', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 8; i++) {
      reg.applyCollect('P9');
    }
    expect(reg.magnetStacks()).toBe(P9_MAX_STACKS);
    expect(P9_MAX_STACKS).toBe(5);
  });

  it('stacks are permanent — ticking does not decay them', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P9');
    reg.applyCollect('P9');
    reg.tick(100);
    expect(reg.magnetStacks()).toBe(2);
  });
});

describe('P9 magnet math (AC5): radius and attraction speed', () => {
  it('base radius is 2× ship size', () => {
    expect(MAGNET_RADIUS_BASE_MULTIPLIER).toBe(2);
    expect(magnetRadius(SHIP_SIZE, 0)).toBeCloseTo(SHIP_SIZE * 2);
  });

  it('each stack adds +50% of the base radius', () => {
    const base = magnetRadius(SHIP_SIZE, 0);
    expect(magnetRadius(SHIP_SIZE, 1)).toBeCloseTo(base * 1.5);
    const twoStacks = magnetRadius(SHIP_SIZE, 2);
    expect(twoStacks).toBeCloseTo(base * 2);
    expect(MAGNET_RADIUS_PER_STACK).toBe(0.5);
  });

  it('the radius formula matches 2× ship size +50% per stack', () => {
    // radius(stack) = 2·shipSize·(1 + 0.5·stack)
    const shipSize = 20;
    expect(magnetRadius(shipSize, 1)).toBeCloseTo(2 * shipSize * 1.5);
    expect(magnetRadius(shipSize, 2)).toBeCloseTo(2 * shipSize * 2);
    expect(magnetRadius(shipSize, 3)).toBeCloseTo(2 * shipSize * 2.5);
    expect(magnetRadius(shipSize, 5)).toBeCloseTo(2 * shipSize * 3.5);
  });

  it('attraction speed is slower than the ship max speed', () => {
    expect(MAGNET_ATTRACTION_SPEED).toBeGreaterThan(0);
    expect(MAGNET_ATTRACTION_SPEED).toBeLessThan(MAX_SPEED);
  });
});

describe('registry aggregation (feed for the HUD, parent AC4/AC6)', () => {
  it('reports active timed effects for aggregation', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    const active = reg.activeEffects();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('P5');
    expect(active[0].type).toBe(PowerUpType.SPEED_BOOST);
    expect(active[0].duration).toBe(10);
  });

  it('drops an effect from the active list on expiry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(10.5);
    expect(reg.activeEffects()).toHaveLength(0);
  });

  it('includes stack and lives in the model', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P8');
    reg.applyCollect('P9');
    reg.applyCollect('P9');
    expect(reg.lives()).toBe(4);
    expect(reg.magnetStacks()).toBe(2);
  });
});

// ── Combat gym effects (AH-0MTC2P6G3007PJ40) ──────────────────────────

describe('P3 Shield (AC4): 15 s bubble, absorbs one hit, refresh on re-collect', () => {
  it('is shielded while active, blocks one hit then pops', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    expect(reg.isShielded).toBe(true);
    expect(reg.isHitImmune).toBe(true);
    expect(reg.tryAbsorbShield()).toBe(true); // absorbs first hit
    expect(reg.isShielded).toBe(false); // popped
    expect(reg.tryAbsorbShield()).toBe(false); // no second absorb
  });

  it('expires after 15 s', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    reg.tick(14.9);
    expect(reg.isShielded).toBe(true);
    reg.tick(0.2);
    expect(reg.isShielded).toBe(false);
  });

  it('refreshes on re-collect (never additive)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    reg.tick(10); // 5 s remaining
    reg.applyCollect('P3'); // refresh
    expect(reg.remaining('P3')).toBeCloseTo(15);
    reg.tick(14.9);
    expect(reg.isShielded).toBe(true);
    reg.tick(0.2);
    expect(reg.isShielded).toBe(false);
  });
});

describe('P4 Bomb (AC5): instant bullet clear, no registry state', () => {
  it('is a no-op in the registry (scene clears bullets)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P4');
    expect(reg.isShielded).toBe(false);
    expect(reg.isPhased).toBe(false);
    expect(reg.activeEffects()).toHaveLength(0);
    // Re-collect is also a benign no-op.
    reg.applyCollect('P4');
    expect(reg.activeEffects()).toHaveLength(0);
  });
});

describe('P6 Phase Shift (AC6): 3 s intangibility, pass-through, refresh', () => {
  it('is phased while active', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    expect(reg.isPhased).toBe(true);
    expect(reg.isHitImmune).toBe(true);
  });

  it('expires after 3 s', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.tick(2.9);
    expect(reg.isPhased).toBe(true);
    reg.tick(0.2);
    expect(reg.isPhased).toBe(false);
  });

  it('refreshes on re-collect', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.tick(2); // 1 s remaining
    reg.applyCollect('P6'); // refresh
    expect(reg.remaining('P6')).toBeCloseTo(3);
    // applyPhaseShift refresh path
    reg.tick(1);
    reg.applyPhaseShift();
    expect(reg.remaining('P6')).toBeCloseTo(3);
  });
});

describe('P7 Teleport (AC7): FIFO stacks, consume, grants P6', () => {
  it('FIFO stacks grow on collect', () => {
    const reg = new EffectsRegistry();
    expect(reg.hasTeleport()).toBe(false);
    reg.applyCollect('P7');
    reg.applyCollect('P7');
    expect(reg.teleportStacks()).toBe(2);
    expect(reg.hasTeleport()).toBe(true);
  });

  it('consumeTeleport removes one stack and grants P6', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P7');
    reg.applyCollect('P7');
    expect(reg.consumeTeleport()).toBe(true);
    expect(reg.teleportStacks()).toBe(1);
    expect(reg.isPhased).toBe(true); // phase granted on teleport
  });

  it('returns false when empty, and stacks appear in activeEffects', () => {
    const reg = new EffectsRegistry();
    expect(reg.consumeTeleport()).toBe(false);
    reg.applyCollect('P7');
    reg.applyCollect('P7');
    const active = reg.activeEffects();
    const t = active.find((e) => e.id === 'P7');
    expect(t).toBeDefined();
    expect(t!.stacks).toBe(2);
  });
});

describe('combat hit model (AC8): hit immunity via shield / phase', () => {
  it('no immunity when neither shield nor phase is active', () => {
    const reg = new EffectsRegistry();
    expect(reg.isHitImmune).toBe(false);
  });

  it('shield or phase grants hit immunity, lost on absorb or expiry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    expect(reg.isHitImmune).toBe(true);
    reg.tryAbsorbShield();
    expect(reg.isHitImmune).toBe(false);
    reg.applyCollect('P6');
    expect(reg.isHitImmune).toBe(true);
    reg.tick(3.1);
    expect(reg.isHitImmune).toBe(false);
  });
});
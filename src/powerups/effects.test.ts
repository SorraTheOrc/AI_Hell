import { describe, it, expect } from 'vitest';

import { PowerUpType } from './types';
import {
  EffectsRegistry,
  P5_SPEED_MULTIPLIER,
  P8_LIVES_START,
  P8_LIVES_MAX,
  P9_MAX_STACKS,
  P10_MAX_STACKS,
  P10_SCOOP_DURATION,
  applySpeedMultiplier,
  magnetRadius,
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
} from './effects';
import { MAX_SPEED, PHASE_DURATION, PHASE_REARM_COOLDOWN, SHIP_SIZE } from '../core/constants';

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

  it('exposes the same 1.5× multiplier for fire rate while active (AC1/AC3)', () => {
    const reg = new EffectsRegistry();
    expect(reg.fireRateMultiplier()).toBe(1);
    reg.applyCollect('P5');
    expect(reg.fireRateMultiplier()).toBe(P5_SPEED_MULTIPLIER);
    expect(reg.fireRateMultiplier()).toBe(reg.speedMultiplier());
  });

  it('fire-rate multiplier returns to 1 immediately on expiry (AC2)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(9.999);
    expect(reg.fireRateMultiplier()).toBe(1.5);
    reg.tick(0.002);
    expect(reg.fireRateMultiplier()).toBe(1);
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

  it('fire-rate multiplier refreshes with the timer and never stacks (AC2)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(6);
    reg.applyCollect('P5'); // refresh
    expect(reg.remaining('P5')).toBeCloseTo(10);
    expect(reg.fireRateMultiplier()).toBe(1.5);
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

  it('setLives drives the counter directly, clamped to [0, P8_LIVES_MAX]', () => {
    const reg = new EffectsRegistry();
    reg.setLives(2);
    expect(reg.lives()).toBe(2);
    reg.setLives(0);
    expect(reg.lives()).toBe(0);
    reg.setLives(-5);
    expect(reg.lives()).toBe(0);
    reg.setLives(99);
    expect(reg.lives()).toBe(P8_LIVES_MAX);
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
  it('base radius is 1× ship size (50% of the original 2×)', () => {
    expect(MAGNET_RADIUS_BASE_MULTIPLIER).toBe(1);
    expect(magnetRadius(SHIP_SIZE, 0)).toBeCloseTo(SHIP_SIZE * 1);
  });

  it('each stack adds +50% of the base radius', () => {
    const base = magnetRadius(SHIP_SIZE, 0);
    expect(magnetRadius(SHIP_SIZE, 1)).toBeCloseTo(base * 1.5);
    const twoStacks = magnetRadius(SHIP_SIZE, 2);
    expect(twoStacks).toBeCloseTo(base * 2);
    expect(MAGNET_RADIUS_PER_STACK).toBe(0.5);
  });

  it('the radius formula matches 1× ship size +50% per stack', () => {
    // radius(stack) = 1·shipSize·(1 + 0.5·stack)
    const shipSize = 20;
    expect(magnetRadius(shipSize, 1)).toBeCloseTo(1 * shipSize * 1.5);
    expect(magnetRadius(shipSize, 2)).toBeCloseTo(1 * shipSize * 2);
    expect(magnetRadius(shipSize, 3)).toBeCloseTo(1 * shipSize * 2.5);
    expect(magnetRadius(shipSize, 5)).toBeCloseTo(1 * shipSize * 3.5);
  });

  it('attraction speed is slower than the ship max speed', () => {
    expect(MAGNET_ATTRACTION_SPEED).toBeGreaterThan(0);
    expect(MAGNET_ATTRACTION_SPEED).toBeLessThan(MAX_SPEED);
  });
});

describe('P10 Mineral Scoop (AH-0MUPMR9TX00756BQ): timed pickup + permanent stacks', () => {
  it('a field pickup activates a 15 s timed effect and adds no permanent stacks', () => {
    const reg = new EffectsRegistry();
    expect(reg.isScoopActive()).toBe(false);

    reg.applyCollect('P10'); // field drop — not permanent

    expect(reg.isScoopActive()).toBe(true);
    expect(reg.remaining('P10')).toBeCloseTo(P10_SCOOP_DURATION, 5);
    expect(P10_SCOOP_DURATION).toBe(15);
    expect(reg.scoopStacks()).toBe(0); // refresh-only, never stacking
  });

  it('the timed pickup expires after 15 s', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P10');
    reg.tick(14.9);
    expect(reg.isScoopActive()).toBe(true);
    reg.tick(0.2);
    expect(reg.isScoopActive()).toBe(false);
  });

  it('re-collecting refreshes the timer to full without adding stacks', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P10');
    reg.tick(10);
    expect(reg.remaining('P10')).toBeCloseTo(5, 3);

    reg.applyCollect('P10'); // refresh
    expect(reg.remaining('P10')).toBeCloseTo(15, 5);
    expect(reg.scoopStacks()).toBe(0);
  });

  it('the hold-full upgrade is permanent and stacks up to 5', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 8; i++) reg.applyCollect('P10', true);

    expect(reg.scoopStacks()).toBe(P10_MAX_STACKS);
    expect(P10_MAX_STACKS).toBe(5);
    expect(reg.isScoopActive()).toBe(false); // permanent path is not timed

    reg.tick(1000);
    expect(reg.scoopStacks()).toBe(P10_MAX_STACKS);
  });

  it('scoopEffectStacks() drives the shared radius curve for both paths', () => {
    const reg = new EffectsRegistry();
    expect(reg.scoopEffectStacks()).toBe(0); // inactive → no pull

    reg.applyCollect('P10'); // timed → one stack's worth of pull
    expect(reg.scoopEffectStacks()).toBe(1);

    reg.applyCollect('P10', true); // permanent stack → overrides to real stacks
    expect(reg.scoopEffectStacks()).toBe(1);
    reg.applyCollect('P10', true);
    expect(reg.scoopEffectStacks()).toBe(2);
  });

  it('activeEffects() surfaces the timed row and the permanent stack row (never x0)', () => {
    const reg = new EffectsRegistry();
    expect(reg.activeEffects().filter((e) => e.id === 'P10')).toHaveLength(0);

    reg.applyCollect('P10');
    const timed = reg.activeEffects().find((e) => e.id === 'P10');
    expect(timed?.type).toBe(PowerUpType.MINERAL_SCOOP);
    expect(timed?.remaining).toBeCloseTo(15, 5);
    expect(timed?.stacks).toBeUndefined();

    reg.applyCollect('P10', true);
    reg.applyCollect('P10', true);
    const stacked = reg.activeEffects().filter((e) => e.id === 'P10');
    // One timed row (from the field pickup) + one stacks row (permanent).
    expect(stacked).toHaveLength(2);
    const stackRow = stacked.find((e) => e.stacks !== undefined);
    expect(stackRow?.stacks).toBe(2);
    expect(stacked.some((e) => e.stacks === 0)).toBe(false);
  });

  it('reset() clears both the timed effect and the permanent stacks', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P10');
    reg.applyCollect('P10', true);
    reg.applyCollect('P10', true);

    reg.reset();

    expect(reg.isScoopActive()).toBe(false);
    expect(reg.scoopStacks()).toBe(0);
    expect(reg.scoopEffectStacks()).toBe(0);
    expect(reg.activeEffects().some((e) => e.id === 'P10')).toBe(false);
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

describe('P6 Phase Shift (Q2/Q3/Q6): charge-based auto-trigger', () => {
  it('collecting P6 stores one charge and does not phase immediately', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    expect(reg.isPhased).toBe(false);
    expect(reg.phaseCharges()).toBe(1);
    expect(reg.isPhasePermanent()).toBe(false);
  });

  it('auto-triggers for 1.5 s when in danger with a charge and consumes it', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');

    expect(reg.updateDanger(true, 0.016)).toBe(true);
    expect(reg.isPhased).toBe(true);
    expect(reg.remaining('P6')).toBeCloseTo(PHASE_DURATION);
    expect(PHASE_DURATION).toBe(1.5);
    expect(reg.phaseCharges()).toBe(0);
  });

  it('does not trigger without a charge', () => {
    const reg = new EffectsRegistry();
    expect(reg.updateDanger(true, 0.016)).toBe(false);
    expect(reg.isPhased).toBe(false);
  });

  it('does not trigger when not in danger', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    expect(reg.updateDanger(false, 0.016)).toBe(false);
    expect(reg.isPhased).toBe(false);
    expect(reg.phaseCharges()).toBe(1);
  });

  it('expires after 1.5 s', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.updateDanger(true, 0.016);
    reg.tick(1.4);
    expect(reg.isPhased).toBe(true);
    reg.tick(0.2);
    expect(reg.isPhased).toBe(false);
  });

  it('permanent P6 triggers repeatedly across distinct danger episodes', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    expect(reg.isPhasePermanent()).toBe(true);

    // Episode 1.
    expect(reg.updateDanger(true, 0.016)).toBe(true);
    reg.tick(PHASE_DURATION + 0.01); // expire
    expect(reg.isPhased).toBe(false);
    reg.updateDanger(false, PHASE_REARM_COOLDOWN + 0.01); // danger clears

    // Episode 2.
    expect(reg.updateDanger(true, 0.016)).toBe(true);
    expect(reg.phaseCharges()).toBe(0); // permanent never consumes
  });

  it('does not immediately re-trigger while danger is continuous (Q2)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION + 0.01); // expire while still in danger

    // Advance well past the cooldown but keep danger continuously true.
    expect(reg.updateDanger(true, 5)).toBe(false);
    expect(reg.isPhased).toBe(false);
  });

  it('re-arms once danger clears and the cooldown elapses, but not before', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION + 0.01); // expire → cooldown starts

    // Danger clears, but the cooldown has not elapsed yet.
    reg.updateDanger(false, 0.1);
    expect(reg.updateDanger(true, 0)).toBe(false); // blocked by cooldown

    // Cooldown elapses → auto-trigger allowed again.
    expect(reg.updateDanger(true, PHASE_REARM_COOLDOWN)).toBe(true);
  });

  it('P7 teleport grants a direct 1.5 s phase without consuming a charge', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P7');
    expect(reg.consumeTeleport()).toBe(true);
    expect(reg.isPhased).toBe(true);
    expect(reg.remaining('P6')).toBeCloseTo(PHASE_DURATION);
    expect(reg.phaseCharges()).toBe(0);
  });

  it('applyPhaseShift refreshes an active phase to the full duration', () => {
    const reg = new EffectsRegistry();
    reg.applyPhaseShift();
    reg.tick(1);
    expect(reg.remaining('P6')).toBeCloseTo(0.5);
    reg.applyPhaseShift();
    expect(reg.remaining('P6')).toBeCloseTo(PHASE_DURATION);
  });

  it('reset() restores the initial charge state', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.applyCollect('P6', true);
    reg.reset();
    expect(reg.phaseCharges()).toBe(0);
    expect(reg.isPhasePermanent()).toBe(false);
    expect(reg.isPhased).toBe(false);
  });
});

describe('P6 charge display model (parent AH-0MUIYX1EE008FVS8, C6)', () => {
  it('surfaces a finite charge as a P6 stack entry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    const p6 = reg.activeEffects().find((e) => e.id === 'P6')!;
    expect(p6).toBeDefined();
    expect(p6.stacks).toBe(1);
    expect(p6.permanent).toBeUndefined();
  });

  it('accumulates repeated pickups into the displayed count', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.applyCollect('P6');
    const p6 = reg.activeEffects().find((e) => e.id === 'P6')!;
    expect(p6.stacks).toBe(2);
  });

  it('drops the charge entry once the charge is consumed', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.updateDanger(true, 0.016);

    const chargeEntries = reg
      .activeEffects()
      .filter((e) => e.id === 'P6' && e.stacks !== undefined);
    expect(chargeEntries).toHaveLength(0);
    // The active phase timer entry is still present.
    expect(reg.activeEffects().some((e) => e.id === 'P6')).toBe(true);
  });

  it('surfaces the permanent reward as unlimited (permanent flag)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    const p6 = reg.activeEffects().find((e) => e.id === 'P6')!;
    expect(p6).toBeDefined();
    expect(p6.permanent).toBe(true);
    expect(p6.stacks).toBeUndefined();
  });

  it('does not surface a zero charge count', () => {
    const reg = new EffectsRegistry();
    expect(reg.activeEffects().filter((e) => e.id === 'P6')).toHaveLength(0);
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
    reg.updateDanger(true, 0.016);
    expect(reg.isHitImmune).toBe(true);
    reg.tick(PHASE_DURATION + 0.01);
    expect(reg.isHitImmune).toBe(false);
  });
});
describe('weapon effects (AH-0MU3VOQKH005YOBH): timed weapons in the combat gym', () => {
  it('equips a weapon with the full 10 s duration', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    expect(reg.hasWeapon('spread')).toBe(true);
    const weapons = reg.activeWeapons();
    expect(weapons).toHaveLength(1);
    expect(weapons[0].weaponId).toBe('spread');
    expect(weapons[0].duration).toBe(10);
    expect(weapons[0].remaining).toBe(10);
  });

  it('equips an AOE weapon with the same 10 s timed model (F5 AC3/AC6)', () => {
    const reg = new EffectsRegistry();
    expect(reg.applyWeapon('nova')).toBe(true);
    expect(reg.hasWeapon('nova')).toBe(true);
    const weapons = reg.activeWeapons();
    expect(weapons).toHaveLength(1);
    expect(weapons[0].weaponId).toBe('nova');
    expect(weapons[0].duration).toBe(10);
    expect(weapons[0].remaining).toBe(10);

    // Expires independently after its own countdown, like Spread/Dual/Rapid.
    reg.tick(10.1);
    expect(reg.hasWeapon('nova')).toBe(false);
    expect(reg.activeWeapons()).toHaveLength(0);
  });

  it('an AOE weapon and a conventional weapon expire independently', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('mortar');
    reg.tick(6);
    reg.applyWeapon('arc');

    expect(reg.activeWeapons().map((w) => w.weaponId).sort()).toEqual([
      'arc',
      'mortar',
    ]);

    // 4 s later mortar hits 10 s; arc still has 6 s remaining.
    reg.tick(4.1);
    expect(reg.hasWeapon('mortar')).toBe(false);
    expect(reg.hasWeapon('arc')).toBe(true);
    expect(reg.activeWeapons()[0].remaining).toBeCloseTo(5.9, 1);
  });

  it('equips distinct weapons independently and expires them on tick', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    reg.applyWeapon('dual');
    expect(reg.activeWeapons()).toHaveLength(2);

    reg.tick(10.1);
    expect(reg.activeWeapons()).toHaveLength(0);
    expect(reg.hasWeapon('spread')).toBe(false);
  });

  it('refreshes an active weapon to full duration instead of stacking', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('rapid');
    reg.tick(6);
    expect(reg.activeWeapons()[0].remaining).toBeCloseTo(4);

    reg.applyWeapon('rapid');
    expect(reg.activeWeapons()[0].remaining).toBe(10);
    expect(reg.activeWeapons()).toHaveLength(1);
  });

  it('Reset clears every active weapon', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    reg.applyWeapon('dual');
    expect(reg.tryResetWeapons()).toBe(true);
    expect(reg.activeWeapons()).toHaveLength(0);

    // Weapons collected after the reset equip normally.
    expect(reg.applyWeapon('rapid')).toBe(true);
    expect(reg.hasWeapon('rapid')).toBe(true);
  });

  it('Reset clears AOE weapons as well as conventional ones (F5 AC3)', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('nova');
    reg.applyWeapon('arc');
    reg.applyWeapon('spread');
    expect(reg.tryResetWeapons()).toBe(true);
    expect(reg.activeWeapons()).toHaveLength(0);
    expect(reg.hasWeapon('nova')).toBe(false);
    expect(reg.hasWeapon('arc')).toBe(false);
  });

  it('Reset with no active weapons is a no-op', () => {
    const reg = new EffectsRegistry();
    expect(reg.tryResetWeapons()).toBe(false);
  });

  it('weapon effects are independent of power-up effects in the same registry', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    reg.applyCollect('P3');
    reg.applyCollect('P9');

    expect(reg.activeWeapons()).toHaveLength(1);
    expect(reg.activeEffects().map((e) => e.id).sort()).toEqual(['P3', 'P9']);
    expect(reg.hasWeapon('spread')).toBe(true);
  });

  it('reset() clears weapon state for a scene restart', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('dual');
    reg.applyCollect('P8');
    expect(reg.lives()).toBe(4);

    reg.reset();
    expect(reg.activeWeapons()).toHaveLength(0);
    expect(reg.hasWeapon('dual')).toBe(false);
    expect(reg.lives()).toBe(3);
  });
});

import { describe, it, expect } from 'vitest';

import { PowerUpType } from './types';
import {
  EffectsRegistry,
  P8_LIVES_START,
  P9_MAGNET_DURATION,
  P10_SCOOP_DURATION,
  applySpeedMultiplier,
  magnetRadius,
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
} from './effects';
import {
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  resolvePowerUpAtLevel,
} from './powerUpLevels';
import { PHASE_DURATION, PHASE_REARM_COOLDOWN, MAX_SPEED, SHIP_SIZE } from '../core/constants';
import {
  activateEffectAtUpgradeLevel,
  createEffectRegistry,
} from '../test/powerUpEffectFixtures';

// Movement config used to verify live speed application.
const BASE_CONFIG = {
  thrust: 300,
  maxSpeed: 175,
  friction: 100,
};

/** Resolved P5 speed multiplier at the given upgrade level. */
function p5Multiplier(upgradeLevel: number): number {
  return resolvePowerUpAtLevel('P5', upgradeLevel).speedMultiplier!;
}

// ── AC1 — single run-scoped level store ──────────────────────────────

describe('single run-scoped level store (AC1)', () => {
  it('consumes an injected store: applyCollect advances it by exactly one', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(store.getLevel('P5')).toBe(0);
    reg.applyCollect('P5');
    expect(store.getLevel('P5')).toBe(1);
    reg.applyCollect('P5');
    expect(store.getLevel('P5')).toBe(2);
  });

  it('setStore rebinds to a different store instance', () => {
    const reg = new EffectsRegistry();
    const store = new PowerUpLevelStore();
    reg.setStore(store);
    reg.applyCollect('P3');
    expect(store.getLevel('P3')).toBe(1);
  });

  it('setStoreResolver picks up the current store dynamically (respawn-safe)', () => {
    const reg = new EffectsRegistry();
    let store = new PowerUpLevelStore();
    reg.setStoreResolver(() => store);
    reg.applyCollect('P5');
    expect(store.getLevel('P5')).toBe(1);

    // A new store (e.g. a respawned player) is consumed without re-wiring.
    store = new PowerUpLevelStore();
    reg.applyCollect('P5');
    expect(store.getLevel('P5')).toBe(1);
  });

  it('falls back to the private store when the resolver yields null', () => {
    const reg = new EffectsRegistry();
    reg.setStoreResolver(() => null);
    reg.applyCollect('P5');
    // No injected store is available; the registry's own store still works.
    expect(reg.isActive('P5')).toBe(true);
  });

  it('a hold-full power-up reward raises the level by exactly one (no double-count)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    store.collect('P5'); // field pickup → level 1
    reg.applyCollect('P5', true); // hold-full reward → level 2
    expect(store.getLevel('P5')).toBe(2);
  });

  it('the level persists across a timed activation expiring (AC6)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P5');
    expect(store.getLevel('P5')).toBe(1);
    reg.tick(1000);
    expect(reg.isActive('P5')).toBe(false);
    expect(store.getLevel('P5')).toBe(1); // level never expires
  });
});

// ── AC2 — resolved stats replace raw constants ───────────────────────

describe('resolved stats replace raw constants (AC2)', () => {
  it('P5 multiplier is the level-resolved value while active, 1 otherwise', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.speedMultiplier()).toBe(1);
    reg.applyCollect('P5');
    expect(reg.speedMultiplier()).toBeCloseTo(p5Multiplier(0), 10);
    // A level-up strengthens the live effect (resolved-live).
    reg.applyCollect('P5');
    expect(reg.speedMultiplier()).toBeCloseTo(p5Multiplier(1), 10);
    expect(reg.speedMultiplier()).toBeGreaterThan(p5Multiplier(0));
  });

  it('fire-rate multiplier is the same level-resolved P5 value (single source)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    expect(reg.fireRateMultiplier()).toBe(reg.speedMultiplier());
    expect(reg.fireRateMultiplier()).toBeCloseTo(p5Multiplier(0), 10);
  });

  it('P3 duration is resolved from the catalogue and grows with level', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    const base = resolvePowerUpAtLevel('P3', 0).shieldDuration!;
    expect(reg.remaining('P3')).toBeCloseTo(base, 10);
    expect(base).toBe(15);

    // Level-up: the refreshed duration is the resolved level-1 value.
    reg.applyCollect('P3');
    const upgraded = resolvePowerUpAtLevel('P3', 1).shieldDuration!;
    expect(reg.remaining('P3')).toBeCloseTo(upgraded, 10);
    expect(upgraded).toBeGreaterThan(base);
  });

  it('P5 duration is resolved from the catalogue and grows with level', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    const base = resolvePowerUpAtLevel('P5', 0).speedDuration!;
    expect(reg.remaining('P5')).toBeCloseTo(base, 10);
    expect(base).toBe(10);

    reg.applyCollect('P5');
    const upgraded = resolvePowerUpAtLevel('P5', 1).speedDuration!;
    expect(reg.remaining('P5')).toBeCloseTo(upgraded, 10);
    expect(upgraded).toBeGreaterThan(base);
  });

  it('P6 phase duration is resolved from the catalogue', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.updateDanger(true, 0.016);
    expect(reg.remaining('P6')).toBeCloseTo(
      resolvePowerUpAtLevel('P6', 0).phaseDuration!,
      10,
    );
  });

  it('P7 arrival phase duration is resolved from the catalogue', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P7');
    reg.consumeTeleport();
    expect(reg.remaining('P6')).toBeCloseTo(
      resolvePowerUpAtLevel('P7', 0).teleportPhaseDuration!,
      10,
    );
  });

  it('P9/P10 field-pickup durations stay the documented non-levelled constant', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P9');
    reg.applyCollect('P10');
    expect(reg.remaining('P9')).toBeCloseTo(P9_MAGNET_DURATION, 10);
    expect(reg.remaining('P10')).toBeCloseTo(P10_SCOOP_DURATION, 10);
    // Levelling P9 does not change its timed field window.
    reg.applyCollect('P9');
    expect(reg.remaining('P9')).toBeCloseTo(P9_MAGNET_DURATION, 10);
  });
});

// ── AC3 — stack/charge/lives reconciliation ──────────────────────────

describe('P8 lives derived from the level model (AC3)', () => {
  it('starts at the store start and adds the level-resolved life gain', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.lives()).toBe(P8_LIVES_START);
    expect(P8_LIVES_START).toBe(POWER_UP_LIVES_START);
    reg.applyCollect('P8');
    expect(reg.lives()).toBe(store.lives());
    expect(reg.lives()).toBe(4);
  });

  it('caps lives at the level-derived cap of 5', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 10; i++) reg.applyCollect('P8');
    expect(reg.lives()).toBe(5);
  });

  it('setLives drives the shared store directly, clamped to [0, cap]', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.setLives(2);
    expect(reg.lives()).toBe(2);
    expect(store.lives()).toBe(2);
    reg.setLives(0);
    expect(reg.lives()).toBe(0);
    reg.setLives(-5);
    expect(reg.lives()).toBe(0);
    reg.setLives(99);
    expect(reg.lives()).toBe(5);
  });
});

describe('P9 Magnet hybrid (AC3)', () => {
  it('a field pickup levels P9, opens the timed effect and adds no stack', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.isMagnetActive()).toBe(false);

    reg.applyCollect('P9');

    expect(store.getLevel('P9')).toBe(1);
    expect(reg.isMagnetActive()).toBe(true);
    expect(reg.remaining('P9')).toBeCloseTo(P9_MAGNET_DURATION, 5);
    expect(reg.magnetStacks()).toBe(0); // refresh-only, never stacking
  });

  it('re-collecting refreshes the timer and levels up, still no stacks', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P9');
    reg.tick(10);
    expect(reg.remaining('P9')).toBeCloseTo(5, 3);

    reg.applyCollect('P9'); // refresh + level 2
    expect(reg.remaining('P9')).toBeCloseTo(15, 5);
    expect(reg.magnetStacks()).toBe(0);
    expect(store.getLevel('P9')).toBe(2);
  });

  it('the hold-full reward adds permanent stacks, capped at the level cap', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    for (let i = 0; i < 8; i++) reg.applyCollect('P9', true);

    expect(reg.magnetStacks()).toBe(5);
    expect(store.magnetStacks()).toBe(5);
    expect(reg.isMagnetActive()).toBe(true); // permanent path is active
    reg.tick(1000);
    expect(reg.magnetStacks()).toBe(5);
  });

  it('magnetEffectStacks() drives the shared radius curve for both paths', () => {
    const reg = new EffectsRegistry();
    expect(reg.magnetEffectStacks()).toBe(0); // inactive → no pull

    reg.applyCollect('P9'); // timed → one stack's worth of pull
    expect(reg.magnetEffectStacks()).toBe(1);

    reg.applyCollect('P9', true); // permanent stack → overrides to real stacks
    expect(reg.magnetEffectStacks()).toBe(1);
    reg.applyCollect('P9', true);
    expect(reg.magnetEffectStacks()).toBe(2);
  });

  it('activeEffects() surfaces the timed row and the permanent stack row (never x0)', () => {
    const reg = new EffectsRegistry();
    expect(reg.activeEffects().filter((e) => e.id === 'P9')).toHaveLength(0);

    reg.applyCollect('P9');
    const timed = reg.activeEffects().find((e) => e.id === 'P9');
    expect(timed?.type).toBe(PowerUpType.MAGNET);
    expect(timed?.remaining).toBeCloseTo(15, 5);
    expect(timed?.stacks).toBeUndefined();

    reg.applyCollect('P9', true);
    reg.applyCollect('P9', true);
    const stacked = reg.activeEffects().filter((e) => e.id === 'P9');
    expect(stacked).toHaveLength(2);
    const stackRow = stacked.find((e) => e.stacks !== undefined);
    expect(stackRow?.stacks).toBe(2);
    expect(stacked.some((e) => e.stacks === 0)).toBe(false);
  });

  it('reset() clears both the timed effect and the permanent stacks', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P9');
    reg.applyCollect('P9', true);
    reg.applyCollect('P9', true);

    reg.reset();

    expect(reg.isMagnetActive()).toBe(false);
    expect(reg.magnetStacks()).toBe(0);
    expect(reg.magnetEffectStacks()).toBe(0);
    expect(store.getLevel('P9')).toBe(0);
    expect(reg.activeEffects().some((e) => e.id === 'P9')).toBe(false);
  });
});

describe('P10 Mineral Scoop hybrid (AC3)', () => {
  it('a field pickup levels P10, opens the timed effect and adds no stack', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.isScoopActive()).toBe(false);

    reg.applyCollect('P10');

    expect(store.getLevel('P10')).toBe(1);
    expect(reg.isScoopActive()).toBe(true);
    expect(reg.remaining('P10')).toBeCloseTo(P10_SCOOP_DURATION, 5);
    expect(reg.scoopStacks()).toBe(0); // refresh-only, never stacking
  });

  it('the hold-full reward adds permanent stacks, capped at the level cap', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 8; i++) reg.applyCollect('P10', true);

    expect(reg.scoopStacks()).toBe(5);
    expect(reg.isScoopActive()).toBe(false); // permanent path is not timed
    reg.tick(1000);
    expect(reg.scoopStacks()).toBe(5);
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

  it('reset() clears both the timed effect and the permanent stacks', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P10');
    reg.applyCollect('P10', true);
    reg.applyCollect('P10', true);

    reg.reset();

    expect(reg.isScoopActive()).toBe(false);
    expect(reg.scoopStacks()).toBe(0);
    expect(reg.scoopEffectStacks()).toBe(0);
    expect(store.getLevel('P10')).toBe(0);
    expect(reg.activeEffects().some((e) => e.id === 'P10')).toBe(false);
  });
});

// ── AC6 — timing / reset semantics ───────────────────────────────────

describe('timing and reset semantics (AC6)', () => {
  it('a level-up while P5 is active persists after the active effect expires', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P5'); // level 1
    reg.tick(1);
    reg.applyCollect('P5'); // level 2, refreshes timer
    expect(reg.speedMultiplier()).toBeCloseTo(p5Multiplier(1), 10);
    reg.tick(1000);
    expect(reg.isActive('P5')).toBe(false);
    expect(store.getLevel('P5')).toBe(2); // level survives expiry
  });

  it('reset() clears the level store and the registry timing state together', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P5');
    reg.applyCollect('P3');
    reg.applyWeapon('spread');
    expect(store.getLevel('P5')).toBe(1);

    reg.reset();

    expect(store.getLevel('P5')).toBe(0);
    expect(store.getLevel('P3')).toBe(0);
    expect(reg.isActive('P5')).toBe(false);
    expect(reg.isActive('P3')).toBe(false);
    expect(reg.activeWeapons()).toHaveLength(0);
  });
});

// ── P3 Shield ────────────────────────────────────────────────────────

describe('P3 Shield: level-resolved bubble, absorbs one hit, refresh on re-collect', () => {
  it('is shielded while active, blocks one hit then pops at level 0', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    expect(reg.isShielded).toBe(true);
    expect(reg.isHitImmune).toBe(true);
    expect(reg.tryAbsorbShield()).toBe(true); // absorbs first hit
    expect(reg.isShielded).toBe(false); // popped
    expect(reg.tryAbsorbShield()).toBe(false); // no shield left
  });

  it('expires after its resolved duration', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    const duration = resolvePowerUpAtLevel('P3', 0).shieldDuration!;
    reg.tick(duration - 0.1);
    expect(reg.isShielded).toBe(true);
    reg.tick(0.2);
    expect(reg.isShielded).toBe(false);
  });

  it('refreshes on re-collect to the new level duration (never additive)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P3');
    reg.tick(15);
    // Re-collect after expiry is a level-up: level-resolved longer window.
    reg.applyCollect('P3');
    const upgraded = resolvePowerUpAtLevel('P3', 1).shieldDuration!;
    expect(reg.remaining('P3')).toBeCloseTo(upgraded, 10);
  });
});

// ── P3 multi-hit absorption (AH-0MUVM9RAO004Y3LB) ───────────────────

describe('P3 Shield: multi-hit absorption (AH-0MUVM9RAO004Y3LB)', () => {
  it('absorbs exactly the level-resolved count before popping', () => {
    for (let upgradeLevel = 0; upgradeLevel <= 3; upgradeLevel++) {
      const fixture = createEffectRegistry();
      const stats = activateEffectAtUpgradeLevel(fixture, 'P3', upgradeLevel);
      const expected = stats.shieldAbsorptions!;

      expect(fixture.registry.isShielded).toBe(true);
      expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(expected);

      // Every hit up to (and including) the last is absorbed, and the
      // shield stays active until that final absorb pops it.
      for (let hit = 1; hit <= expected; hit++) {
        expect(fixture.registry.tryAbsorbShield()).toBe(true);
        if (hit < expected) {
          expect(fixture.registry.isShielded).toBe(true);
          expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(
            expected - hit,
          );
        } else {
          expect(fixture.registry.isShielded).toBe(false);
          expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(0);
        }
      }
      // One hit after the last is no longer absorbed.
      expect(fixture.registry.tryAbsorbShield()).toBe(false);
    }
  });

  it('grows the absorptions count with the level (base 1 → cap 3)', () => {
    const base = resolvePowerUpAtLevel('P3', 0).shieldAbsorptions!;
    const upgraded = resolvePowerUpAtLevel('P3', 1).shieldAbsorptions!;
    const capped = resolvePowerUpAtLevel('P3', 1000).shieldAbsorptions!;
    expect(base).toBe(1);
    expect(upgraded).toBeGreaterThan(base);
    expect(capped).toBe(3);
  });

  it('refresh-not-stack: re-collecting resets remaining to the resolved count', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'P3', 0);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(1);

    // A second collection is a level-up; the count is refreshed to the
    // level-1 resolved value, never the old count plus the new one.
    fixture.registry.applyCollect('P3');
    const level1 = resolvePowerUpAtLevel('P3', 1).shieldAbsorptions!;
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(level1);
    expect(fixture.registry.shieldAbsorptionsRemaining()).not.toBe(1 + level1);
  });

  it('clears remaining absorptions on expiry but keeps the run-scoped level', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'P3', 1);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBeGreaterThan(1);

    fixture.registry.tick(1000);

    expect(fixture.registry.isShielded).toBe(false);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(0);
    expect(fixture.store.getUpgradeLevel('P3')).toBe(1); // level survives
  });

  it('reset() clears the remaining absorptions and the level', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'P3', 2);
    fixture.registry.tryAbsorbShield();

    fixture.registry.reset();

    expect(fixture.registry.isShielded).toBe(false);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(0);
    expect(fixture.store.getUpgradeLevel('P3')).toBe(0);
  });

  it('activeEffects() surfaces P3 with the remaining absorptions and updates on absorb', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'P3', 1);

    const before = fixture.registry
      .activeEffects()
      .find((e) => e.id === 'P3')!;
    expect(before.stacks).toBe(fixture.registry.shieldAbsorptionsRemaining());

    fixture.registry.tryAbsorbShield();
    const after = fixture.registry
      .activeEffects()
      .find((e) => e.id === 'P3')!;
    expect(after.stacks).toBe(before.stacks! - 1);
  });
});

// ── P4 Bomb ──────────────────────────────────────────────────────────

describe('P4 Bomb: ranged one-shot pickup / permanent periodic (AH-0MUVM9RAO004Y3LB)', () => {
  it('a field pickup queues exactly one pulse and leaves no permanent state', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P4');

    expect(reg.isBombPermanent()).toBe(false);
    expect(reg.activeEffects()).toHaveLength(0);
    expect(store.getLevel('P4')).toBe(1);

    // The queued pulse fires once, then never again.
    expect(reg.updateBomb(0.016)).toBe(true);
    expect(reg.updateBomb(10)).toBe(false);
    expect(reg.updateBomb(10)).toBe(false);
  });

  it('a hold-full reward is permanent: immediate pulse then the resolved interval', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P4', true);
    expect(reg.isBombPermanent()).toBe(true);
    expect(
      reg.activeEffects().some((e) => e.id === 'P4' && e.permanent),
    ).toBe(true);

    const interval = reg.bombInterval();
    expect(interval).toBeCloseTo(
      1 / resolvePowerUpAtLevel('P4', 0).bombFrequency!,
      10,
    );

    expect(reg.updateBomb(0.016)).toBe(true); // immediate
    expect(reg.updateBomb(interval - 0.1)).toBe(false);
    expect(reg.updateBomb(0.2)).toBe(true); // interval elapsed
  });

  it('resolves bombRange/bombInterval live so a level-up strengthens later pulses', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P4');
    const baseRange = reg.bombRange();
    const baseInterval = reg.bombInterval();

    reg.applyCollect('P4');

    expect(reg.bombRange()).toBeGreaterThan(baseRange);
    expect(reg.bombInterval()).toBeLessThan(baseInterval);
  });

  it('reset() clears the permanent flag and any pending pulse', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P4', true);

    reg.reset();

    expect(reg.isBombPermanent()).toBe(false);
    expect(reg.activeEffects().some((e) => e.id === 'P4')).toBe(false);
    expect(reg.updateBomb(1)).toBe(false);
  });
});

// ── P6 Phase Shift ───────────────────────────────────────────────────

describe('P6 Phase Shift: charge-based auto-trigger', () => {
  it('collecting P6 stores level-resolved charges and does not phase immediately', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P6');
    expect(reg.isPhased).toBe(false);
    expect(reg.phaseCharges()).toBe(1);
    expect(reg.isPhasePermanent()).toBe(false);
  });

  it('auto-triggers for the resolved phase duration and consumes a charge', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');

    expect(reg.updateDanger(true, 0.016)).toBe(true);
    expect(reg.isPhased).toBe(true);
    expect(reg.remaining('P6')).toBeCloseTo(
      resolvePowerUpAtLevel('P6', 0).phaseDuration!,
      10,
    );
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

  it('expires after its duration', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION - 0.1);
    expect(reg.isPhased).toBe(true);
    reg.tick(0.2);
    expect(reg.isPhased).toBe(false);
  });

  it('permanent P6 triggers repeatedly across distinct danger episodes', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    expect(reg.isPhasePermanent()).toBe(true);

    expect(reg.updateDanger(true, 0.016)).toBe(true);
    reg.tick(PHASE_DURATION + 0.01);
    expect(reg.isPhased).toBe(false);
    reg.updateDanger(false, PHASE_REARM_COOLDOWN + 0.01);

    expect(reg.updateDanger(true, 0.016)).toBe(true);
    expect(reg.phaseCharges()).toBe(0); // permanent never consumes
  });

  it('does not immediately re-trigger while danger is continuous', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION + 0.01);
    expect(reg.updateDanger(true, 5)).toBe(false);
    expect(reg.isPhased).toBe(false);
  });

  it('re-arms once danger clears and the cooldown elapses, but not before', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6', true);
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION + 0.01);

    reg.updateDanger(false, 0.1);
    expect(reg.updateDanger(true, 0)).toBe(false); // blocked by cooldown
    expect(reg.updateDanger(true, PHASE_REARM_COOLDOWN)).toBe(true);
  });

  it('applyPhaseShift refreshes an active phase to the full P7 duration', () => {
    const reg = new EffectsRegistry();
    reg.applyPhaseShift();
    reg.tick(1);
    reg.applyPhaseShift();
    expect(reg.remaining('P6')).toBeCloseTo(
      resolvePowerUpAtLevel('P7', 0).teleportPhaseDuration!,
      10,
    );
  });

  it('reset() restores the initial charge state', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('P6');
    reg.applyCollect('P6', true);
    reg.reset();
    expect(reg.phaseCharges()).toBe(0);
    expect(reg.isPhasePermanent()).toBe(false);
    expect(reg.isPhased).toBe(false);
    expect(store.getLevel('P6')).toBe(0);
  });
});

describe('P6 charge display model', () => {
  it('surfaces a finite charge as a P6 stack entry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    const p6 = reg.activeEffects().find((e) => e.id === 'P6')!;
    expect(p6).toBeDefined();
    expect(p6.stacks).toBe(1);
    expect(p6.permanent).toBeUndefined();
  });

  it('accumulates the level-derived grants into the displayed count', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6'); // level 1 → +1
    reg.applyCollect('P6'); // level 2 → +2 (upgrade)
    const p6 = reg.activeEffects().find((e) => e.id === 'P6')!;
    expect(p6.stacks).toBe(3);
  });

  it('drops the charge entry once the charge is consumed', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P6');
    reg.updateDanger(true, 0.016);

    const chargeEntries = reg
      .activeEffects()
      .filter((e) => e.id === 'P6' && e.stacks !== undefined);
    expect(chargeEntries).toHaveLength(0);
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

// ── P7 Teleport ──────────────────────────────────────────────────────

describe('P7 Teleport: derived FIFO stacks, consume, grants P6', () => {
  it('stacks grow by the level-resolved grant on each collect', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.hasTeleport()).toBe(false);
    reg.applyCollect('P7'); // level 1 → +1
    expect(reg.teleportStacks()).toBe(1);
    reg.applyCollect('P7'); // level 2 → +2
    expect(reg.teleportStacks()).toBe(3);
    expect(reg.hasTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(3);
  });

  it('consumeTeleport removes one stack and grants P6', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P7');
    reg.applyCollect('P7');
    const before = reg.teleportStacks();
    expect(reg.consumeTeleport()).toBe(true);
    expect(reg.teleportStacks()).toBe(before - 1);
    expect(reg.isPhased).toBe(true); // phase granted on teleport
    expect(reg.phaseCharges()).toBe(0); // does not consume a charge
  });

  it('returns false when empty, and stacks appear in activeEffects', () => {
    const reg = new EffectsRegistry();
    expect(reg.consumeTeleport()).toBe(false);
    reg.applyCollect('P7');
    reg.applyCollect('P7');
    const t = reg.activeEffects().find((e) => e.id === 'P7');
    expect(t).toBeDefined();
    expect(t!.stacks).toBe(3);
  });
});

// ── Hit immunity ─────────────────────────────────────────────────────

describe('combat hit model: hit immunity via shield / phase', () => {
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

// ── Magnet math ──────────────────────────────────────────────────────

describe('magnet math: radius and attraction speed', () => {
  it('base radius is 1× ship size (50% of the original 2×)', () => {
    expect(MAGNET_RADIUS_BASE_MULTIPLIER).toBe(1);
    expect(magnetRadius(SHIP_SIZE, 0)).toBeCloseTo(SHIP_SIZE * 1);
  });

  it('each stack adds +50% of the base radius', () => {
    const base = magnetRadius(SHIP_SIZE, 0);
    expect(magnetRadius(SHIP_SIZE, 1)).toBeCloseTo(base * 1.5);
    expect(magnetRadius(SHIP_SIZE, 2)).toBeCloseTo(base * 2);
    expect(MAGNET_RADIUS_PER_STACK).toBe(0.5);
  });

  it('attraction speed is slower than the ship max speed', () => {
    expect(MAGNET_ATTRACTION_SPEED).toBeGreaterThan(0);
    expect(MAGNET_ATTRACTION_SPEED).toBeLessThan(MAX_SPEED);
  });
});

// ── HUD aggregation ──────────────────────────────────────────────────

describe('registry aggregation (feed for the HUD)', () => {
  it('reports active timed effects for aggregation', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    const active = reg.activeEffects();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('P5');
    expect(active[0].type).toBe(PowerUpType.SPEED_BOOST);
    expect(active[0].duration).toBe(resolvePowerUpAtLevel('P5', 0).speedDuration);
  });

  it('drops an effect from the active list on expiry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    reg.tick(1000);
    expect(reg.activeEffects()).toHaveLength(0);
  });

  it('includes derived lives and stacks in the model', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P8');
    reg.applyCollect('P9', true); // permanent stacks require the upgrade path
    reg.applyCollect('P9', true);
    expect(reg.lives()).toBe(4);
    expect(reg.magnetStacks()).toBe(2);
  });

  it('applies the multiplier live to both thrust and max-speed', () => {
    const boosted = applySpeedMultiplier(BASE_CONFIG, 1.5);
    expect(boosted.thrust).toBeCloseTo(BASE_CONFIG.thrust * 1.5);
    expect(boosted.maxSpeed).toBeCloseTo(BASE_CONFIG.maxSpeed * 1.5);
    expect(boosted.friction).toBe(BASE_CONFIG.friction);
  });
});

// ── Weapon effects ───────────────────────────────────────────────────

describe('weapon effects: timed weapons in the combat gym', () => {
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

  it('equips an AOE weapon with the same 10 s timed model', () => {
    const reg = new EffectsRegistry();
    expect(reg.applyWeapon('nova')).toBe(true);
    expect(reg.hasWeapon('nova')).toBe(true);
    reg.tick(10.1);
    expect(reg.hasWeapon('nova')).toBe(false);
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
    reg.tick(4.1);
    expect(reg.hasWeapon('mortar')).toBe(false);
    expect(reg.hasWeapon('arc')).toBe(true);
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

  it('reset() clears weapon state and the level store for a scene restart', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyWeapon('dual');
    reg.applyCollect('P8');
    expect(reg.lives()).toBe(4);

    reg.reset();
    expect(reg.activeWeapons()).toHaveLength(0);
    expect(reg.hasWeapon('dual')).toBe(false);
    expect(reg.lives()).toBe(3);
    expect(store.getLevel('P8')).toBe(0);
  });
});

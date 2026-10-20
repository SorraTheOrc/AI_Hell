import { describe, it, expect } from 'vitest';

import {
  EffectsRegistry,
  P8_LIVES_START,
  P9_MAGNET_DURATION,
  P10_SCOOP_DURATION,
  applySpeedMultiplier,
  magnetRadius,
  selectAutoDefence,
  MAGNET_ATTRACTION_SPEED,
  MAGNET_RADIUS_BASE_MULTIPLIER,
  MAGNET_RADIUS_PER_STACK,
} from './effects';
import {
  POWER_UP_LIVES_START,
  PowerUpLevelStore,
  resolvePowerUpAtLevel,
} from './powerUpLevels';
import { POWER_UP_CATALOGUE, type PowerUpId } from './types';
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

/** Resolved Speed Boost speed multiplier at the given upgrade level. */
function p5Multiplier(upgradeLevel: number): number {
  return resolvePowerUpAtLevel('speed_boost', upgradeLevel).speedMultiplier!;
}

// ── AC1 — single run-scoped level store ──────────────────────────────

describe('single run-scoped level store (AC1)', () => {
  it('consumes an injected store: applyCollect advances it by exactly one', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(store.getLevel('speed_boost')).toBe(0);
    reg.applyCollect('speed_boost');
    expect(store.getLevel('speed_boost')).toBe(1);
    reg.applyCollect('speed_boost');
    expect(store.getLevel('speed_boost')).toBe(2);
  });

  it('setStore rebinds to a different store instance', () => {
    const reg = new EffectsRegistry();
    const store = new PowerUpLevelStore();
    reg.setStore(store);
    reg.applyCollect('shield');
    expect(store.getLevel('shield')).toBe(1);
  });

  it('setStoreResolver picks up the current store dynamically (respawn-safe)', () => {
    const reg = new EffectsRegistry();
    let store = new PowerUpLevelStore();
    reg.setStoreResolver(() => store);
    reg.applyCollect('speed_boost');
    expect(store.getLevel('speed_boost')).toBe(1);

    // A new store (e.g. a respawned player) is consumed without re-wiring.
    store = new PowerUpLevelStore();
    reg.applyCollect('speed_boost');
    expect(store.getLevel('speed_boost')).toBe(1);
  });

  it('falls back to the private store when the resolver yields null', () => {
    const reg = new EffectsRegistry();
    reg.setStoreResolver(() => null);
    reg.applyCollect('speed_boost');
    // No injected store is available; the registry's own store still works.
    expect(reg.isActive('speed_boost')).toBe(true);
  });

  it('a hold-full power-up reward raises the level by exactly one (no double-count)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    store.collect('speed_boost'); // field pickup → level 1
    reg.applyCollect('speed_boost', true); // hold-full reward → level 2
    expect(store.getLevel('speed_boost')).toBe(2);
  });

  it('the temporary level reverts when a timed activation expires (AC6)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('speed_boost');
    expect(store.getEffectiveLevel('speed_boost')).toBe(1);
    reg.tick(1000);
    expect(reg.isActive('speed_boost')).toBe(false);
    // Field-pickup-only: the temporary level is removed on expiry (AC1).
    expect(store.getEffectiveLevel('speed_boost')).toBe(0);
    expect(store.getTempStacks('speed_boost')).toBe(0);
  });
});

// ── AC2 — resolved stats replace raw constants ───────────────────────

describe('resolved stats replace raw constants (AC2)', () => {
  it('P5 multiplier is the level-resolved value while active, 1 otherwise', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.speedMultiplier()).toBe(1);
    reg.applyCollect('speed_boost');
    expect(reg.speedMultiplier()).toBeCloseTo(p5Multiplier(0), 10);
    // A level-up strengthens the live effect (resolved-live).
    reg.applyCollect('speed_boost');
    expect(reg.speedMultiplier()).toBeCloseTo(p5Multiplier(1), 10);
    expect(reg.speedMultiplier()).toBeGreaterThan(p5Multiplier(0));
  });

  it('fire-rate multiplier is the same level-resolved P5 value (single source)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    expect(reg.fireRateMultiplier()).toBe(reg.speedMultiplier());
    expect(reg.fireRateMultiplier()).toBeCloseTo(p5Multiplier(0), 10);
  });

  it('P3 duration is resolved from the catalogue and grows with level', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield');
    const base = resolvePowerUpAtLevel('shield', 0).shieldDuration!;
    expect(reg.remaining('shield')).toBeCloseTo(base, 10);
    expect(base).toBe(15);

    // Level-up: the refreshed duration is the resolved level-1 value.
    reg.applyCollect('shield');
    const upgraded = resolvePowerUpAtLevel('shield', 1).shieldDuration!;
    expect(reg.remaining('shield')).toBeCloseTo(upgraded, 10);
    expect(upgraded).toBeGreaterThan(base);
  });

  it('P5 duration is resolved from the catalogue and grows with level', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const base = resolvePowerUpAtLevel('speed_boost', 0).speedDuration!;
    expect(reg.remaining('speed_boost')).toBeCloseTo(base, 10);
    expect(base).toBe(10);

    reg.applyCollect('speed_boost');
    const upgraded = resolvePowerUpAtLevel('speed_boost', 1).speedDuration!;
    expect(reg.remaining('speed_boost')).toBeCloseTo(upgraded, 10);
    expect(upgraded).toBeGreaterThan(base);
  });

  it('P6 phase duration is resolved from the catalogue', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016);
    expect(reg.remaining('phase_shift')).toBeCloseTo(
      resolvePowerUpAtLevel('phase_shift', 0).phaseDuration!,
      10,
    );
  });

  it('P7 arrival phase duration is resolved from the catalogue', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport');
    reg.consumeTeleport();
    expect(reg.remaining('phase_shift')).toBeCloseTo(
      resolvePowerUpAtLevel('teleport', 0).teleportPhaseDuration!,
      10,
    );
  });

  it('P9/P10 field-pickup durations stay the documented non-levelled constant', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet');
    reg.applyCollect('mineral_scoop');
    expect(reg.remaining('magnet')).toBeCloseTo(P9_MAGNET_DURATION, 10);
    expect(reg.remaining('mineral_scoop')).toBeCloseTo(P10_SCOOP_DURATION, 10);
    // Levelling Magnet does not change its timed field window.
    reg.applyCollect('magnet');
    expect(reg.remaining('magnet')).toBeCloseTo(P9_MAGNET_DURATION, 10);
  });
});

// ── AC3 — stack/charge/lives reconciliation ──────────────────────────

describe('P8 lives derived from the level model (AC3)', () => {
  it('starts at the store start and adds the level-resolved life gain', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.lives()).toBe(P8_LIVES_START);
    expect(P8_LIVES_START).toBe(POWER_UP_LIVES_START);
    reg.applyCollect('extra_life');
    expect(reg.lives()).toBe(store.lives());
    expect(reg.lives()).toBe(4);
  });

  it('caps lives at the level-derived cap of 5', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 10; i++) reg.applyCollect('extra_life');
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

    reg.applyCollect('magnet');

    expect(store.getLevel('magnet')).toBe(1);
    expect(reg.isMagnetActive()).toBe(true);
    expect(reg.remaining('magnet')).toBeCloseTo(P9_MAGNET_DURATION, 5);
    expect(reg.magnetStacks()).toBe(0); // refresh-only, never stacking
  });

  it('re-collecting refreshes the timer and levels up, still no stacks', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('magnet');
    reg.tick(10);
    expect(reg.remaining('magnet')).toBeCloseTo(5, 3);

    reg.applyCollect('magnet'); // refresh + level 2
    expect(reg.remaining('magnet')).toBeCloseTo(15, 5);
    expect(reg.magnetStacks()).toBe(0);
    expect(store.getLevel('magnet')).toBe(2);
  });

  it('the hold-full reward adds permanent stacks, capped at the level cap', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    for (let i = 0; i < 8; i++) reg.applyCollect('magnet', true);

    expect(reg.magnetStacks()).toBe(5);
    expect(store.magnetStacks()).toBe(5);
    expect(reg.isMagnetActive()).toBe(true); // permanent path is active
    reg.tick(1000);
    expect(reg.magnetStacks()).toBe(5);
  });

  it('magnetEffectStacks() drives the shared radius curve for both paths', () => {
    const reg = new EffectsRegistry();
    expect(reg.magnetEffectStacks()).toBe(0); // inactive → no pull

    reg.applyCollect('magnet'); // timed → one stack's worth of pull
    expect(reg.magnetEffectStacks()).toBe(1);

    reg.applyCollect('magnet', true); // permanent stack → overrides to real stacks
    expect(reg.magnetEffectStacks()).toBe(1);
    reg.applyCollect('magnet', true);
    expect(reg.magnetEffectStacks()).toBe(2);
  });

  it('activeEffects() surfaces the timed row and the permanent stack row (never x0)', () => {
    const reg = new EffectsRegistry();
    expect(reg.activeEffects().filter((e) => e.id === 'magnet')).toHaveLength(0);

    reg.applyCollect('magnet');
    const timed = reg.activeEffects().find((e) => e.id === 'magnet');
    expect(timed?.type).toBe('magnet');
    expect(timed?.remaining).toBeCloseTo(15, 5);
    expect(timed?.stacks).toBeUndefined();

    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    const stacked = reg.activeEffects().filter((e) => e.id === 'magnet');
    expect(stacked).toHaveLength(2);
    const stackRow = stacked.find((e) => e.stacks !== undefined);
    expect(stackRow?.stacks).toBe(2);
    expect(stacked.some((e) => e.stacks === 0)).toBe(false);
  });

  it('reset() clears both the timed effect and the permanent stacks', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('magnet');
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);

    reg.reset();

    expect(reg.isMagnetActive()).toBe(false);
    expect(reg.magnetStacks()).toBe(0);
    expect(reg.magnetEffectStacks()).toBe(0);
    expect(store.getLevel('magnet')).toBe(0);
    expect(reg.activeEffects().some((e) => e.id === 'magnet')).toBe(false);
  });
});

describe('P10 Mineral Scoop hybrid (AC3)', () => {
  it('a field pickup levels P10, opens the timed effect and adds no stack', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.isScoopActive()).toBe(false);

    reg.applyCollect('mineral_scoop');

    expect(store.getLevel('mineral_scoop')).toBe(1);
    expect(reg.isScoopActive()).toBe(true);
    expect(reg.remaining('mineral_scoop')).toBeCloseTo(P10_SCOOP_DURATION, 5);
    expect(reg.scoopStacks()).toBe(0); // refresh-only, never stacking
  });

  it('the hold-full reward adds permanent stacks, capped at the level cap', () => {
    const reg = new EffectsRegistry();
    for (let i = 0; i < 8; i++) reg.applyCollect('mineral_scoop', true);

    expect(reg.scoopStacks()).toBe(5);
    expect(reg.isScoopActive()).toBe(false); // permanent path is not timed
    reg.tick(1000);
    expect(reg.scoopStacks()).toBe(5);
  });

  it('scoopEffectStacks() drives the shared radius curve for both paths', () => {
    const reg = new EffectsRegistry();
    expect(reg.scoopEffectStacks()).toBe(0); // inactive → no pull

    reg.applyCollect('mineral_scoop'); // timed → one stack's worth of pull
    expect(reg.scoopEffectStacks()).toBe(1);

    reg.applyCollect('mineral_scoop', true); // permanent stack → overrides to real stacks
    expect(reg.scoopEffectStacks()).toBe(1);
    reg.applyCollect('mineral_scoop', true);
    expect(reg.scoopEffectStacks()).toBe(2);
  });

  it('reset() clears both the timed effect and the permanent stacks', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('mineral_scoop');
    reg.applyCollect('mineral_scoop', true);
    reg.applyCollect('mineral_scoop', true);

    reg.reset();

    expect(reg.isScoopActive()).toBe(false);
    expect(reg.scoopStacks()).toBe(0);
    expect(reg.scoopEffectStacks()).toBe(0);
    expect(store.getLevel('mineral_scoop')).toBe(0);
    expect(reg.activeEffects().some((e) => e.id === 'mineral_scoop')).toBe(false);
  });
});

// ── AC6 — timing / reset semantics ───────────────────────────────────

describe('timing and reset semantics (AC6)', () => {
  it('a temporary level-up is removed when the active effect expires', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('speed_boost'); // temporary level 1
    reg.tick(1);
    reg.applyCollect('speed_boost'); // temporary level 2, refreshes timer
    expect(reg.speedMultiplier()).toBeCloseTo(p5Multiplier(1), 10);
    reg.tick(1000);
    expect(reg.isActive('speed_boost')).toBe(false);
    expect(store.getEffectiveLevel('speed_boost')).toBe(0); // temporary level gone
  });

  it('reset() clears the level store and the registry timing state together', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('speed_boost');
    reg.applyCollect('shield');
    reg.applyWeapon('spread');
    expect(store.getLevel('speed_boost')).toBe(1);

    reg.reset();

    expect(store.getLevel('speed_boost')).toBe(0);
    expect(store.getLevel('shield')).toBe(0);
    expect(reg.isActive('speed_boost')).toBe(false);
    expect(reg.isActive('shield')).toBe(false);
    expect(reg.activeWeapons()).toHaveLength(0);
  });
});

// ── Shield ────────────────────────────────────────────────────────

describe('P3 Shield: level-resolved bubble, absorbs one hit, refresh on re-collect', () => {
  it('is shielded while active, blocks one hit then pops at level 0', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield');
    expect(reg.isShielded).toBe(true);
    expect(reg.isHitImmune).toBe(true);
    expect(reg.tryAbsorbShield()).toBe(true); // absorbs first hit
    expect(reg.isShielded).toBe(false); // popped
    expect(reg.tryAbsorbShield()).toBe(false); // no shield left
  });

  it('expires after its resolved duration', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield');
    const duration = resolvePowerUpAtLevel('shield', 0).shieldDuration!;
    reg.tick(duration - 0.1);
    expect(reg.isShielded).toBe(true);
    reg.tick(0.2);
    expect(reg.isShielded).toBe(false);
  });

  it('refreshes on re-collect to the new level duration (never additive)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield'); // base window
    // Re-collect before expiry is a level-up: resolved-live longer window,
    // refreshed (never additive).
    reg.applyCollect('shield');
    const upgraded = resolvePowerUpAtLevel('shield', 1).shieldDuration!;
    expect(reg.remaining('shield')).toBeCloseTo(upgraded, 10);
  });
});

// ── Shield multi-hit absorption (AH-0MUVM9RAO004Y3LB) ───────────────────

describe('P3 Shield: multi-hit absorption (AH-0MUVM9RAO004Y3LB)', () => {
  it('absorbs exactly the level-resolved count before popping', () => {
    for (let upgradeLevel = 0; upgradeLevel <= 3; upgradeLevel++) {
      const fixture = createEffectRegistry();
      const stats = activateEffectAtUpgradeLevel(fixture, 'shield', upgradeLevel);
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
    const base = resolvePowerUpAtLevel('shield', 0).shieldAbsorptions!;
    const upgraded = resolvePowerUpAtLevel('shield', 1).shieldAbsorptions!;
    const capped = resolvePowerUpAtLevel('shield', 1000).shieldAbsorptions!;
    expect(base).toBe(1);
    expect(upgraded).toBeGreaterThan(base);
    expect(capped).toBe(3);
  });

  it('refresh-not-stack: re-collecting resets remaining to the resolved count', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'shield', 0);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(1);

    // A second collection is a level-up; the count is refreshed to the
    // level-1 resolved value, never the old count plus the new one.
    fixture.registry.applyCollect('shield');
    const level1 = resolvePowerUpAtLevel('shield', 1).shieldAbsorptions!;
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(level1);
    expect(fixture.registry.shieldAbsorptionsRemaining()).not.toBe(1 + level1);
  });

  it('clears remaining absorptions on expiry and reverts the temporary level', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'shield', 1);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBeGreaterThan(1);

    fixture.registry.tick(1000);

    expect(fixture.registry.isShielded).toBe(false);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(0);
    // The upgrade came from field pickups only, so it reverts on expiry.
    expect(fixture.store.getEffectiveLevel('shield')).toBe(0);
    expect(fixture.store.getUpgradeLevel('shield')).toBe(0);
  });

  it('reset() clears the remaining absorptions and the level', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'shield', 2);
    fixture.registry.tryAbsorbShield();

    fixture.registry.reset();

    expect(fixture.registry.isShielded).toBe(false);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(0);
    expect(fixture.store.getUpgradeLevel('shield')).toBe(0);
  });

  it('activeEffects() surfaces P3 with the remaining absorptions and updates on absorb', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'shield', 1);

    const before = fixture.registry
      .activeEffects()
      .find((e) => e.id === 'shield')!;
    expect(before.stacks).toBe(fixture.registry.shieldAbsorptionsRemaining());

    fixture.registry.tryAbsorbShield();
    const after = fixture.registry
      .activeEffects()
      .find((e) => e.id === 'shield')!;
    expect(after.stacks).toBe(before.stacks! - 1);
  });
});

// ── Bomb ──────────────────────────────────────────────────────────

describe('P4 Bomb: ranged one-shot pickup / permanent periodic (AH-0MUVM9RAO004Y3LB)', () => {
  it('a field pickup queues exactly one pulse and leaves no permanent state', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('bomb');

    expect(reg.isBombPermanent()).toBe(false);
    expect(reg.activeEffects()).toHaveLength(0);
    expect(store.getLevel('bomb')).toBe(1);

    // The queued pulse fires once, then never again.
    expect(reg.updateBomb(0.016)).toBe(true);
    expect(reg.updateBomb(10)).toBe(false);
    expect(reg.updateBomb(10)).toBe(false);
  });

  it('a hold-full reward is permanent: immediate pulse then the resolved interval', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('bomb', true);
    expect(reg.isBombPermanent()).toBe(true);
    expect(
      reg.activeEffects().some((e) => e.id === 'bomb' && e.permanent),
    ).toBe(true);

    const interval = reg.bombInterval();
    expect(interval).toBeCloseTo(
      1 / resolvePowerUpAtLevel('bomb', 0).bombFrequency!,
      10,
    );

    expect(reg.updateBomb(0.016)).toBe(true); // immediate
    expect(reg.updateBomb(interval - 0.1)).toBe(false);
    expect(reg.updateBomb(0.2)).toBe(true); // interval elapsed
  });

  it('resolves bombRange/bombInterval live so a level-up strengthens later pulses', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('bomb');
    const baseRange = reg.bombRange();
    const baseInterval = reg.bombInterval();

    reg.applyCollect('bomb');

    expect(reg.bombRange()).toBeGreaterThan(baseRange);
    expect(reg.bombInterval()).toBeLessThan(baseInterval);
  });

  it('reset() clears the permanent flag and any pending pulse', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('bomb', true);

    reg.reset();

    expect(reg.isBombPermanent()).toBe(false);
    expect(reg.activeEffects().some((e) => e.id === 'bomb')).toBe(false);
    expect(reg.updateBomb(1)).toBe(false);
  });
});

// ── Smart Bomb (AH-0MV1BIWP9003EHRQ) ──────────────────────────────

describe('Smart Bomb: one-shot pickup / permanent periodic (AH-0MV1BIWP9003EHRQ)', () => {
  it('a field pickup queues exactly one pulse and leaves no permanent state', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('smart_bomb');

    expect(reg.isSmartBombPermanent()).toBe(false);
    expect(reg.activeEffects()).toHaveLength(0);
    expect(store.getLevel('smart_bomb')).toBe(1);

    // The queued pulse fires once, then never again.
    expect(reg.updateSmartBomb(0.016)).toBe(true);
    expect(reg.updateSmartBomb(10)).toBe(false);
    expect(reg.updateSmartBomb(10)).toBe(false);
  });

  it('a hold-full reward is permanent: immediate pulse then the resolved interval', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('smart_bomb', true);
    expect(reg.isSmartBombPermanent()).toBe(true);
    expect(
      reg.activeEffects().some((e) => e.id === 'smart_bomb' && e.permanent),
    ).toBe(true);

    const interval = reg.smartBombInterval();
    expect(interval).toBeCloseTo(
      1 / resolvePowerUpAtLevel('smart_bomb', 0).smartBombFrequency!,
      10,
    );

    expect(reg.updateSmartBomb(0.016)).toBe(true); // immediate
    expect(reg.updateSmartBomb(interval - 0.1)).toBe(false);
    expect(reg.updateSmartBomb(0.2)).toBe(true); // interval elapsed
  });

  it('resolves aoeRadius/smartBombDamage/smartBombFrequency live so a level-up strengthens later pulses', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('smart_bomb');
    const base = reg.smartBombAoe();
    const baseInterval = reg.smartBombInterval();

    reg.applyCollect('smart_bomb');

    const levelled = reg.smartBombAoe();
    expect(levelled.radius).toBeGreaterThan(base.radius);
    expect(levelled.damage).toBeGreaterThanOrEqual(base.damage!);
    expect(reg.smartBombInterval()).toBeLessThan(baseInterval);
  });

  it('smartBombAoe() exposes the shared AoEDescriptor shape (damage + clear flags)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('smart_bomb');

    const aoe = reg.smartBombAoe();
    expect(aoe.trigger).toBe('screenPulse');
    expect(aoe.damagesEnemies).toBe(true);
    expect(aoe.clearsEnemyBullets).toBe(true);
    expect(aoe.damage).toBe(1);
    expect(aoe.radius).toBe(
      resolvePowerUpAtLevel('smart_bomb', 0).aoeRadius,
    );
  });

  // ── Re-balanced schedules (AH-0MV8GPGBL009M0D8) ──
  //
  // The parent re-balance shrinks the pulse to `min(400, 200 × (1 + 0.02 ×
  // level))` px (base 200 = 10× ship size, cap 2× base) and slows the
  // permanent pulse to `max(10, 30 − 2 × level)` s, resolved through the
  // shared effect path (smartBombInterval/smartBombAoe).
  it('pins the re-balanced smart-bomb interval (30 → 10 s) and radius (200 → 400 px) schedules', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    // Level 0 (first grant) — the base schedule.
    store.collect('smart_bomb');
    expect(reg.smartBombInterval()).toBeCloseTo(30, 9);
    expect(reg.smartBombAoe().radius).toBe(200);
    expect(reg.smartBombAoe().damage).toBe(1);

    // Upgrade level 1 — interval −2 s (28 s), radius +2 % of base (204 px).
    store.collect('smart_bomb');
    expect(reg.smartBombInterval()).toBeCloseTo(28, 9);
    expect(reg.smartBombAoe().radius).toBe(204);
    expect(reg.smartBombAoe().damage).toBe(2);

    // The interval floors at 10 s from upgrade level 10 (max(10, 30 − 2×level)).
    while (store.getUpgradeLevel('smart_bomb') < 10) store.collect('smart_bomb');
    expect(reg.smartBombInterval()).toBeCloseTo(10, 9);

    // The radius clamps at 2× base (400 px) by upgrade level 50 and holds.
    while (store.getUpgradeLevel('smart_bomb') < 50) store.collect('smart_bomb');
    expect(reg.smartBombAoe().radius).toBe(400);
    expect(reg.smartBombInterval()).toBeCloseTo(10, 9);
    // Damage is unchanged by the re-balance (1 → 3 across levels).
    expect(reg.smartBombAoe().damage).toBe(3);
  });

  it('reset() clears the permanent flag and any pending pulse', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('smart_bomb', true);

    reg.reset();

    expect(reg.isSmartBombPermanent()).toBe(false);
    expect(reg.activeEffects().some((e) => e.id === 'smart_bomb')).toBe(false);
    expect(reg.updateSmartBomb(1)).toBe(false);
  });
});

// ── Force Field reflector (AH-0MV1BIX1W006XF95) ────────────────────

describe('Force Field: timed bullet reflector (AH-0MV1BIX1W006XF95)', () => {
  it('a field pickup opens the reflect window with the level-resolved budget', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('force_field');

    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.forceFieldRemaining()).toBe(
      resolvePowerUpAtLevel('force_field', 0).forceFieldReflects,
    );
    expect(reg.remaining('force_field')).toBe(
      resolvePowerUpAtLevel('force_field', 0).forceFieldDuration,
    );
    // The HUD row carries the remaining reflect budget.
    const entry = reg.activeEffects().find((e) => e.id === 'force_field');
    expect(entry?.stacks).toBe(reg.forceFieldRemaining());
  });

  it('returns at most its reflect budget and then stops reflecting', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');
    const budget = reg.forceFieldRemaining();
    expect(budget).toBeGreaterThan(0);

    for (let i = 0; i < budget; i++) {
      expect(reg.tryConsumeForceFieldReflect()).toBe(true);
    }
    // Budget spent: the bubble is still up but no longer reflects.
    expect(reg.forceFieldRemaining()).toBe(0);
    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.tryConsumeForceFieldReflect()).toBe(false);
  });

  it('never reflects when no field is active', () => {
    const reg = new EffectsRegistry();
    expect(reg.isForceFieldActive()).toBe(false);
    expect(reg.tryConsumeForceFieldReflect()).toBe(false);
  });

  it('re-collecting refreshes the window and budget to the level-resolved values', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');
    const baseBudget = reg.forceFieldRemaining();
    // Spend one, then collect again — refreshes to the new level's budget.
    expect(reg.tryConsumeForceFieldReflect()).toBe(true);
    reg.applyCollect('force_field');
    expect(reg.forceFieldRemaining()).toBeGreaterThanOrEqual(baseBudget);
    expect(reg.isForceFieldActive()).toBe(true);
  });

  it('expiry ends reflection and clears the budget', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');

    reg.tick((reg.remaining('force_field') ?? 0) + 0.1);

    expect(reg.isForceFieldActive()).toBe(false);
    expect(reg.forceFieldRemaining()).toBe(0);
    expect(reg.tryConsumeForceFieldReflect()).toBe(false);
  });

  it('a permanent reward keeps the bubble up and reflecting for the run', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field', true);
    expect(reg.isForceFieldActive()).toBe(true);

    // A permanent bubble has no temporary window, so ticking never expires it.
    reg.tick(1000);
    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.forceFieldRemaining()).toBe(
      resolvePowerUpAtLevel('force_field', 0).forceFieldReflects,
    );
  });

  it('exposes the shared reflect radius used by the bubble visual', () => {
    const reg = new EffectsRegistry();
    expect(reg.forceFieldRadius()).toBeGreaterThan(SHIP_SIZE);
  });

  it('reset() clears the reflect window and budget', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');

    reg.reset();

    expect(reg.isForceFieldActive()).toBe(false);
    expect(reg.forceFieldRemaining()).toBe(0);
    expect(reg.tryConsumeForceFieldReflect()).toBe(false);
  });
});

// ── Mystery UFO: run-scoped level contract (collector-drone epic) ──
//
// The instant mineral+score bounty (AH-0MV1BIXFO006Z1I7) is retired by the
// visible collector-drone epic (AH-0MV9G113S009B37I): a field pickup will
// spawn a visible drone instead of granting a direct hold/score payout, and
// the retired instant-bounty score axis is removed with the level-variable
// feature (AH-0MVBMPZ2C0008VAE), which also anchors the collector-drone
// lifetime/capacity/radius/spawn-interval axes on the shared curve. These tests pin only the **survivor registry
// contract** — run-scoped level advancement, a permanent hold-full path and
// reset semantics — so the suite stays green as the instant path is
// removed. The "no direct payout, one drone spawn" behaviour is asserted by
// the spawn-wiring feature's own tests (AH-0MVBMQ04X0051002) and the shared
// fixtures in `src/test/collectorDroneFixtures.ts`.

describe('Mystery UFO: run-scoped level contract (AH-0MV9G113S009B37I)', () => {
  it('collecting advances the run-scoped level exactly once', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('mystery_ufo');

    expect(store.getEffectiveLevel('mystery_ufo')).toBe(1);
  });

  it('leaves no timed window or stored timed-effect state', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('mystery_ufo');

    expect(reg.isActive('mystery_ufo')).toBe(false);
    expect(reg.remaining('mystery_ufo')).toBeUndefined();
    expect(reg.activeEffects().some((e) => e.id === 'mystery_ufo')).toBe(false);
  });

  it('a hold-full reward is a permanent grant and stacks with field pickups', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    // Field pickup → temporary stack only.
    reg.applyCollect('mystery_ufo');
    expect(store.permanentGrants('mystery_ufo')).toBe(0);
    expect(store.getEffectiveLevel('mystery_ufo')).toBe(1);

    // Hold-full reward → permanent grant, level stacks on top.
    reg.applyCollect('mystery_ufo', true);
    expect(store.permanentGrants('mystery_ufo')).toBe(1);
    expect(store.getEffectiveLevel('mystery_ufo')).toBe(2);
  });

  it('reset() clears the run-scoped level', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('mystery_ufo');
    expect(store.getEffectiveLevel('mystery_ufo')).toBe(1);

    reg.reset();
    expect(store.getEffectiveLevel('mystery_ufo')).toBe(0);
    expect(store.permanentGrants('mystery_ufo')).toBe(0);
  });

  it('a field pickup queues exactly one collector-drone spawn and no payout (AC1)', () => {
    const reg = new EffectsRegistry();

    expect(reg.consumeMysteryUfoSpawns()).toBe(0);
    reg.applyCollect('mystery_ufo');
    expect(reg.consumeMysteryUfoSpawns()).toBe(1);
    // Drained: a second drain grants nothing, so no pickup is double-spawned.
    expect(reg.consumeMysteryUfoSpawns()).toBe(0);
    // The permanent auto-spawn is only armed by the full-hull reward.
    expect(reg.isMysteryUfoPermanent()).toBe(false);
  });

  it('accumulates one spawn per field pickup before a drain', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('mystery_ufo');
    reg.applyCollect('mystery_ufo');
    expect(reg.consumeMysteryUfoSpawns()).toBe(2);
  });

  it('a hold-full (permanent) reward arms the auto-spawn but queues no one-shot (AC4)', () => {
    const reg = new EffectsRegistry();

    reg.applyCollect('mystery_ufo', true);

    expect(reg.isMysteryUfoPermanent()).toBe(true);
    expect(reg.consumeMysteryUfoSpawns()).toBe(0);
  });

  it('resolves the permanent spawn interval from the shared curve (30 s base, descending)', () => {
    const reg = new EffectsRegistry();

    // Level 0 (unowned) is the curve base: 30 s.
    expect(reg.mysteryUfoSpawnInterval()).toBe(30);
    // The first collection resolves at level 1; the interval descends.
    reg.applyCollect('mystery_ufo');
    expect(reg.mysteryUfoSpawnInterval()).toBe(
      resolvePowerUpAtLevel('mystery_ufo', 1).mysteryUfoSpawnInterval,
    );
    expect(reg.mysteryUfoSpawnInterval()).toBeLessThan(30);
  });

  it('reset() clears the pending spawns and re-disarms the permanent reward', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('mystery_ufo');
    reg.applyCollect('mystery_ufo', true);

    reg.reset();

    expect(reg.consumeMysteryUfoSpawns()).toBe(0);
    expect(reg.isMysteryUfoPermanent()).toBe(false);
  });
});

// ── Phase Shift ───────────────────────────────────────────────────

describe('P6 Phase Shift: charge-based auto-trigger', () => {
  it('collecting P6 stores level-resolved charges and does not phase immediately', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift');
    expect(reg.isPhased).toBe(false);
    expect(reg.phaseCharges()).toBe(1);
    expect(reg.isPhasePermanent()).toBe(false);
  });

  it('auto-triggers for the resolved phase duration and consumes a charge', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');

    expect(reg.updateDanger(true, 0.016)).toBe('phase_shift');
    expect(reg.isPhased).toBe(true);
    expect(reg.remaining('phase_shift')).toBeCloseTo(
      resolvePowerUpAtLevel('phase_shift', 0).phaseDuration!,
      10,
    );
    expect(reg.phaseCharges()).toBe(0);
  });

  it('does not trigger without a charge', () => {
    const reg = new EffectsRegistry();
    expect(reg.updateDanger(true, 0.016)).toBeNull();
    expect(reg.isPhased).toBe(false);
  });

  it('does not trigger when not in danger', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    expect(reg.updateDanger(false, 0.016)).toBeNull();
    expect(reg.isPhased).toBe(false);
    expect(reg.phaseCharges()).toBe(1);
  });

  it('expires after its duration', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION - 0.1);
    expect(reg.isPhased).toBe(true);
    reg.tick(0.2);
    expect(reg.isPhased).toBe(false);
  });

  it('permanent P6 is a finite pool: triggers again once its spent charge recharges (AC4)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift', true);
    expect(reg.isPhasePermanent()).toBe(true);

    // The hold-full reward adds exactly one charge; the first danger episode
    // spends it and starts the recharge timer (AH-0MV82I7TX0009JMT AC4).
    expect(reg.updateDanger(true, 0.016)).toBe('phase_shift');
    reg.tick(PHASE_DURATION + 0.01);
    expect(reg.isPhased).toBe(false);
    expect(reg.phaseCharges()).toBe(0);
    reg.updateDanger(false, PHASE_REARM_COOLDOWN + 0.01);

    // Danger cleared and re-armed, but the empty pool blocks a new trigger —
    // the permanent reward is never unlimited.
    expect(reg.updateDanger(true, 0.016)).toBeNull();
    reg.updateDanger(false, 0.016); // re-arm again (the failed try latched)

    // Once the spent charge recharges the next episode can trigger again.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(reg.phaseCharges()).toBe(1);
    expect(reg.updateDanger(true, 0.016)).toBe('phase_shift');
    expect(reg.phaseCharges()).toBe(0);
  });

  it('does not immediately re-trigger while danger is continuous', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift', true);
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION + 0.01);
    expect(reg.updateDanger(true, 5)).toBeNull();
    expect(reg.isPhased).toBe(false);
  });

  it('re-arms once danger clears and the cooldown elapses, but not before', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift', true);
    reg.updateDanger(true, 0.016);
    reg.tick(PHASE_DURATION + 0.01);

    reg.updateDanger(false, 0.1);
    expect(reg.updateDanger(true, 0)).toBeNull(); // blocked by cooldown
    // The finite pool recharges while danger stays clear (AC4), so the
    // re-armed episode can trigger once the cooldown elapses.
    store.tickRecharge(store.phaseRechargeTime() + 1);
    expect(reg.updateDanger(true, PHASE_REARM_COOLDOWN)).toBe('phase_shift');
  });

  it('applyPhaseShift refreshes an active phase to the full P7 duration', () => {
    const reg = new EffectsRegistry();
    reg.applyPhaseShift();
    reg.tick(1);
    reg.applyPhaseShift();
    expect(reg.remaining('phase_shift')).toBeCloseTo(
      resolvePowerUpAtLevel('teleport', 0).teleportPhaseDuration!,
      10,
    );
  });

  it('reset() restores the initial charge state', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift');
    reg.applyCollect('phase_shift', true);
    reg.reset();
    expect(reg.phaseCharges()).toBe(0);
    expect(reg.isPhasePermanent()).toBe(false);
    expect(reg.isPhased).toBe(false);
    expect(store.getLevel('phase_shift')).toBe(0);
  });
});

// ── Automatic defence selection: Phase Shift vs Teleport ─────────────

describe('selectAutoDefence: finite-pool charge-count selection (AC2)', () => {
  it('returns null when neither defence is available', () => {
    expect(selectAutoDefence(0, 0)).toBeNull();
  });

  it('returns the only available defence', () => {
    expect(selectAutoDefence(1, 0)).toBe('phase_shift');
    expect(selectAutoDefence(0, 2)).toBe('teleport');
  });

  it('spends the ability with the greater available count', () => {
    expect(selectAutoDefence(1, 3)).toBe('teleport');
    expect(selectAutoDefence(3, 1)).toBe('phase_shift');
  });

  it('breaks an exact tie with the injected RNG (both outcomes reachable)', () => {
    expect(selectAutoDefence(2, 2, () => 0.0)).toBe('phase_shift');
    expect(selectAutoDefence(2, 2, () => 0.49)).toBe('phase_shift');
    expect(selectAutoDefence(2, 2, () => 0.5)).toBe('teleport');
    expect(selectAutoDefence(2, 2, () => 0.99)).toBe('teleport');
  });

  it('never treats a pool as unbounded: an empty phase pool cannot outrank Teleport', () => {
    // Both pools are finite — an empty phase pool contributes zero available
    // count, so a stored Teleport is selected (the permanent-Infinity branch
    // is gone, AH-0MV82I8IL0012RXY AC2).
    expect(selectAutoDefence(0, 5)).toBe('teleport');
    expect(selectAutoDefence(0, 0)).toBeNull();
  });
});

describe('updateDanger: automatic Teleport selection (AC1/AC2/AC5)', () => {
  it('selects Teleport without consuming the stack (the scene warps)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport');

    expect(reg.updateDanger(true, 0.016)).toBe('teleport');
    // The registry does not own the warp, so it must not consume the stack.
    expect(reg.teleportStacks()).toBe(1);
    expect(reg.isPhased).toBe(false);
  });

  it('latches the danger episode so Teleport is not drained continuously', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport');
    reg.applyCollect('teleport'); // level 2 → 3 stacks

    expect(reg.updateDanger(true, 0.016)).toBe('teleport');
    // Still in danger on the same episode → no second selection.
    expect(reg.updateDanger(true, 5)).toBeNull();
    expect(reg.teleportStacks()).toBe(3);
  });

  it('re-arms only after danger clears and the phase cooldown elapses', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport');

    expect(reg.updateDanger(true, 0.016)).toBe('teleport');
    // The scene completes the warp: consume the stack + grant phase.
    expect(reg.consumeTeleport()).toBe(true);
    expect(reg.isPhased).toBe(true);
    reg.tick(PHASE_DURATION + 0.01); // phase expires → cooldown starts

    // Re-collect a Teleport stack for the next episode.
    reg.applyCollect('teleport');

    reg.updateDanger(false, 0.1); // danger clears, cooldown still running
    expect(reg.updateDanger(true, 0)).toBeNull(); // blocked by cooldown
    expect(reg.updateDanger(true, PHASE_REARM_COOLDOWN)).toBe('teleport');
  });

  it('spends the more abundant stock when both are available', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift'); // 1 charge
    reg.applyCollect('teleport'); // 1 stack
    reg.applyCollect('teleport'); // level 2 → 3 stacks
    expect(reg.phaseCharges()).toBe(1);
    expect(reg.teleportStacks()).toBe(3);

    expect(reg.updateDanger(true, 0.016)).toBe('teleport');
  });

  it('uses the seeded RNG for the exact-tie pick', () => {
    const phaseFirst = new EffectsRegistry(undefined, () => 0.0);
    phaseFirst.applyCollect('phase_shift');
    phaseFirst.applyCollect('teleport');
    expect(phaseFirst.updateDanger(true, 0.016)).toBe('phase_shift');

    const teleportFirst = new EffectsRegistry(undefined, () => 0.99);
    teleportFirst.applyCollect('phase_shift');
    teleportFirst.applyCollect('teleport');
    expect(teleportFirst.updateDanger(true, 0.016)).toBe('teleport');
  });

  it('a permanent Phase Shift ties Teleport by count (seeded RNG decides)', () => {
    // The permanent reward is an ownership flag, not an unbounded supply: a
    // single-charge finite pool exactly ties one stored Teleport, so the
    // tie-break RNG decides (no permanent-Infinity branch, AC2).
    const phaseFirst = new EffectsRegistry(undefined, () => 0.0);
    phaseFirst.applyCollect('phase_shift', true);
    phaseFirst.applyCollect('teleport');
    expect(phaseFirst.updateDanger(true, 0.016)).toBe('phase_shift');
    expect(phaseFirst.teleportStacks()).toBe(1); // Teleport conserved

    const teleportFirst = new EffectsRegistry(undefined, () => 0.99);
    teleportFirst.applyCollect('phase_shift', true);
    teleportFirst.applyCollect('teleport');
    expect(teleportFirst.updateDanger(true, 0.016)).toBe('teleport');
  });

  it('an empty Phase Shift pool (even a permanent owner) selects Teleport instead', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift', true); // permanent owner, 1 charge
    expect(reg.updateDanger(true, 0.016)).toBe('phase_shift');
    reg.tick(PHASE_DURATION + 0.01); // phase expires → re-arm cooldown starts
    expect(reg.phaseCharges()).toBe(0);

    // Danger clears and the cooldown elapses; the empty phase pool now
    // contributes zero available count, so a stored Teleport fires (AC3).
    reg.applyCollect('teleport');
    reg.updateDanger(false, PHASE_REARM_COOLDOWN + 0.01);
    expect(reg.updateDanger(true, 0.016)).toBe('teleport');
    expect(reg.teleportStacks()).toBe(1); // not consumed here (scene warps)
  });
});

describe('shared tick advances the recharge clock (AH-0MV82I8IL0012RXY AC1/AC5)', () => {
  it('EffectsRegistry.tick(dt) recovers a spent Phase Shift charge through the shared path', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016); // consumes the single charge
    expect(reg.phaseCharges()).toBe(0);

    // Mid-recharge the pool stays empty...
    reg.tick(store.phaseRechargeTime() / 2);
    expect(reg.phaseCharges()).toBe(0);

    // ...and the shared tick completes the timer and returns the charge.
    reg.tick(store.phaseRechargeTime() / 2 + 1);
    expect(reg.phaseCharges()).toBe(1);
  });

  it('EffectsRegistry.tick(dt) recovers a spent Teleport stack through the shared path', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('teleport');
    reg.consumeTeleport(); // consumes the stack, starts its recharge timer
    expect(reg.teleportStacks()).toBe(0);

    reg.tick(store.teleportRechargeTime() + 1);
    expect(reg.teleportStacks()).toBe(1);
  });

  it('the recharge advance is run-scoped: reset() clears it with the store', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016);
    expect(reg.phaseCharges()).toBe(0);

    reg.reset();
    reg.tick(store.phaseRechargeTime() + 1);
    expect(reg.phaseCharges()).toBe(0); // nothing left recharging after reset
  });
});

describe('registry HUD recharge accessors (AH-0MV82I8IL0012RXY AC4)', () => {
  it('phaseRechargeTime()/teleportRechargeTime() delegate to the level store', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.phaseRechargeTime()).toBe(store.phaseRechargeTime());
    expect(reg.teleportRechargeTime()).toBe(store.teleportRechargeTime());
  });

  it('recharge times start at the base and shorten as the level rises', () => {
    const reg = new EffectsRegistry();
    const basePhase = reg.phaseRechargeTime();
    const baseTeleport = reg.teleportRechargeTime();
    expect(basePhase).toBeCloseTo(30, 6);
    expect(baseTeleport).toBeCloseTo(15, 6);

    reg.applyCollect('phase_shift');
    reg.applyCollect('phase_shift');
    reg.applyCollect('teleport');
    reg.applyCollect('teleport');
    expect(reg.phaseRechargeTime()).toBeLessThan(basePhase);
    expect(reg.teleportRechargeTime()).toBeLessThan(baseTeleport);
  });

  it('the accessors report the recharge clock while a charge is out recharging', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016); // charge consumed → timer running
    expect(reg.phaseCharges()).toBe(0);
    expect(reg.phaseRechargeTime()).toBe(store.phaseRechargeTime());
    expect(reg.phaseRechargeTime()).toBeCloseTo(30, 6);
  });
});

describe('P6 charge display model', () => {
  it('surfaces a finite charge as a P6 stack entry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    const p6 = reg.activeEffects().find((e) => e.id === 'phase_shift')!;
    expect(p6).toBeDefined();
    expect(p6.stacks).toBe(1);
    expect(p6.permanent).toBeUndefined();
  });

  it('accumulates the level-derived grants into the displayed count', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift'); // level 1 → +1
    reg.applyCollect('phase_shift'); // level 2 → +2 (upgrade)
    const p6 = reg.activeEffects().find((e) => e.id === 'phase_shift')!;
    expect(p6.stacks).toBe(3);
  });

  it('drops the charge entry once the charge is consumed', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016);

    const chargeEntries = reg
      .activeEffects()
      .filter((e) => e.id === 'phase_shift' && e.stacks !== undefined);
    expect(chargeEntries).toHaveLength(0);
    expect(reg.activeEffects().some((e) => e.id === 'phase_shift')).toBe(true);
  });

  it('surfaces the permanent reward via the ownership marker, not an unlimited supply', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift', true);
    const p6 = reg.activeEffects().find((e) => e.id === 'phase_shift')!;
    expect(p6).toBeDefined();
    expect(p6.permanent).toBe(true);
    // The pool is finite and recharges (AH-0MV82I7TX0009JMT): the
    // permanent reward gates ownership, the finite charge count is read
    // via phaseCharges() (surfaced by the HUD as ` ×N`), not as stacks here.
    expect(p6.stacks).toBeUndefined();
  });

  it('does not surface a zero charge count', () => {
    const reg = new EffectsRegistry();
    expect(reg.activeEffects().filter((e) => e.id === 'phase_shift')).toHaveLength(0);
  });
});

// ── Teleport ──────────────────────────────────────────────────────

describe('P7 Teleport: derived FIFO stacks, consume, grants P6', () => {
  it('stacks grow by the level-resolved grant on each collect', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.hasTeleport()).toBe(false);
    reg.applyCollect('teleport'); // level 1 → +1
    expect(reg.teleportStacks()).toBe(1);
    reg.applyCollect('teleport'); // level 2 → +2
    expect(reg.teleportStacks()).toBe(3);
    expect(reg.hasTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(3);
  });

  it('consumeTeleport removes one stack and grants P6', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport');
    reg.applyCollect('teleport');
    const before = reg.teleportStacks();
    expect(reg.consumeTeleport()).toBe(true);
    expect(reg.teleportStacks()).toBe(before - 1);
    expect(reg.isPhased).toBe(true); // phase granted on teleport
    expect(reg.phaseCharges()).toBe(0); // does not consume a charge
  });

  it('returns false when empty, and stacks appear in activeEffects', () => {
    const reg = new EffectsRegistry();
    expect(reg.consumeTeleport()).toBe(false);
    reg.applyCollect('teleport');
    reg.applyCollect('teleport');
    const t = reg.activeEffects().find((e) => e.id === 'teleport');
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
    reg.applyCollect('shield');
    expect(reg.isHitImmune).toBe(true);
    reg.tryAbsorbShield();
    expect(reg.isHitImmune).toBe(false);
    reg.applyCollect('phase_shift');
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
    reg.applyCollect('speed_boost');
    const active = reg.activeEffects();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('speed_boost');
    expect(active[0].type).toBe('speed_boost');
    expect(active[0].duration).toBe(resolvePowerUpAtLevel('speed_boost', 0).speedDuration);
  });

  it('drops an effect from the active list on expiry', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.tick(1000);
    expect(reg.activeEffects()).toHaveLength(0);
  });

  it('includes derived lives and stacks in the model', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('extra_life');
    reg.applyCollect('magnet', true); // permanent stacks require the upgrade path
    reg.applyCollect('magnet', true);
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
    reg.applyCollect('shield');
    reg.applyCollect('magnet');
    expect(reg.activeWeapons()).toHaveLength(1);
    expect(reg.activeEffects().map((e) => e.id).sort()).toEqual(['magnet', 'shield']);
    expect(reg.hasWeapon('spread')).toBe(true);
  });

  it('reset() clears weapon state and the level store for a scene restart', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyWeapon('dual');
    reg.applyCollect('extra_life');
    expect(reg.lives()).toBe(4);

    reg.reset();
    expect(reg.activeWeapons()).toHaveLength(0);
    expect(reg.hasWeapon('dual')).toBe(false);
    expect(reg.lives()).toBe(3);
    expect(store.getLevel('extra_life')).toBe(0);
  });
});

// ── Worked examples A & B (AH-0MUX802450085VZZ, F1 contract) ────────
//
// The parent's worked examples, asserted step-by-step. A field pickup is a
// temporary level tied to the item's timed window; a hold-full reward is a
// permanent level with no timeout.

describe('temporary/permanent field-pickup contract (F1 worked examples)', () => {
  it('example A — field pickups only: level reverts on expiry', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    // 1. Pick up Shield → lvl0 for 15 s.
    reg.applyCollect('shield');
    expect(store.getEffectiveLevel('shield')).toBe(1);
    expect(store.getUpgradeLevel('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(reg.isShielded).toBe(true);

    // 2. Pick up Shield again before expiry → lvl1 for 15 s (window refreshed).
    reg.applyCollect('shield');
    expect(store.getEffectiveLevel('shield')).toBe(2);
    expect(store.getUpgradeLevel('shield')).toBe(1);
    expect(store.getTempStacks('shield')).toBe(2);
    expect(reg.remaining('shield')).toBeCloseTo(
      resolvePowerUpAtLevel('shield', 1).shieldDuration!,
      5,
    );

    // 3. Expiry → back to unowned (no permanent level retained).
    reg.tick(1000);
    expect(reg.isShielded).toBe(false);
    expect(store.getEffectiveLevel('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
  });

  it('example B — hold-full reward then field pickups: reverts to permanent', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    // 1. Take Shield from a hold-full reward → lvl0, permanent, no timeout.
    reg.applyCollect('shield', true);
    expect(store.getPermanentLevel('shield')).toBe(1);
    expect(store.getEffectiveLevel('shield')).toBe(1);
    reg.tick(1000); // permanent shield never expires
    expect(reg.isShielded).toBe(true);
    expect(store.getEffectiveLevel('shield')).toBe(1);

    // 2. Pick up Shield in the field → lvl1 (temporary), for x s.
    reg.applyCollect('shield');
    expect(store.getTempStacks('shield')).toBe(1);
    expect(store.getPermanentLevel('shield')).toBe(1);
    expect(store.getEffectiveLevel('shield')).toBe(2);

    // 3. Expiry → back to lvl0 permanent (still active).
    reg.tick(1000);
    expect(store.getTempStacks('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(1);
    expect(store.getEffectiveLevel('shield')).toBe(1);
    expect(reg.isShielded).toBe(true);

    // 4. Take Shield from another hold-full reward → lvl1, permanent.
    reg.applyCollect('shield', true);
    expect(store.getPermanentLevel('shield')).toBe(2);
    expect(store.getEffectiveLevel('shield')).toBe(2);
  });

  it('keeps stored P6 charges / P7 teleports after the window expires (AC9)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('teleport');
    const teleports = reg.teleportStacks();
    expect(teleports).toBeGreaterThan(0);
    // Teleport has no timed window; simulate an expiry of a (hypothetical) window.
    store.clearTemporary('teleport');
    expect(store.getEffectiveLevel('teleport')).toBe(0);
    expect(reg.teleportStacks()).toBe(teleports); // not clawed back

    reg.applyCollect('phase_shift');
    const charges = reg.phaseCharges();
    expect(charges).toBeGreaterThan(0);
    store.clearTemporary('phase_shift');
    expect(reg.phaseCharges()).toBe(charges);
  });

  it('P9 hybrid: a hold-full stack is unaffected by a later field expiry', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('magnet', true); // permanent stack
    expect(reg.magnetStacks()).toBe(1);

    reg.applyCollect('magnet'); // field pickup → temporary level
    expect(store.getTempStacks('magnet')).toBe(1);
    reg.tick(1000); // timed window expires
    expect(store.getTempStacks('magnet')).toBe(0);
    expect(reg.magnetStacks()).toBe(1); // permanent stack retained
  });
});

// ── HUD level/temporary accessors (AH-0MUX802450085VZZ) ─────────────
//
// The HUD derives one merged row per power-up/weapon from these accessors:
// the effective level in the label and `∞`/countdown in the value.

describe('HUD level and temporary-window accessors (AH-0MUX802450085VZZ)', () => {
  it('powerUpLevel() reports the effective permanent + temporary level', () => {
    const reg = new EffectsRegistry();
    expect(reg.powerUpLevel('speed_boost')).toBe(0);

    reg.applyCollect('speed_boost');
    expect(reg.powerUpLevel('speed_boost')).toBe(1);

    reg.applyCollect('speed_boost');
    expect(reg.powerUpLevel('speed_boost')).toBe(2);
  });

  it('powerUpTemporaryRemaining() is undefined for a permanent-only base', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost', true);
    expect(reg.powerUpTemporaryRemaining('speed_boost')).toBeUndefined();
  });

  it('powerUpTemporaryRemaining() counts down a field window and clears to the permanent base', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost', true);
    reg.applyCollect('speed_boost'); // field pickup on top of the permanent base

    expect(reg.powerUpTemporaryRemaining('speed_boost')).toBeGreaterThan(0);

    reg.tick(1000); // window expires
    expect(reg.powerUpTemporaryRemaining('speed_boost')).toBeUndefined();
    expect(reg.powerUpLevel('speed_boost')).toBe(1); // level reverted to permanent
  });

  it('a field pickup on a permanent weapon opens a temporary window that expires back to the permanent base', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread', true); // permanent-only
    expect(reg.activeWeapons()[0].permanent).toBe(true);
    expect(reg.activeWeapons()[0].tempWindow).toBeFalsy();

    reg.applyWeapon('spread'); // field pickup on top
    expect(reg.activeWeapons()[0].tempWindow).toBe(true);
    expect(reg.activeWeapons()[0].remaining).toBe(10);

    reg.tick(10.1);
    expect(reg.hasWeapon('spread')).toBe(true); // permanent base remains
    expect(reg.activeWeapons()[0].tempWindow).toBeFalsy();
    expect(reg.activeWeapons()[0].permanent).toBe(true);
  });
});

describe('unified PowerUpId dispatch (F3)', () => {
  it('dispatches every catalogue entry through the registry keyed only by PowerUpId', () => {
    const { registry, store } = createEffectRegistry();
    for (const id of Object.keys(POWER_UP_CATALOGUE) as PowerUpId[]) {
      registry.applyCollect(id);
      expect(store.getLevel(id), `level for ${id}`).toBe(1);
    }
  });
});

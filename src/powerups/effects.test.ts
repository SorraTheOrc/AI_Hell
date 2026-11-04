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
  isConsumablePowerUpId,
  resolvePowerUpAtLevel,
  resolveTemporaryWindow,
} from './powerUpLevels';
import { POWER_UP_CATALOGUE, type PowerUpId } from './types';
import { beatPeriodMs } from '../utils/beat';
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

  it('P3 pickup grants exactly one charge, clamped at the level-resolved cap', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield');
    // A field pickup grants exactly one charge (clamped at the level cap),
    // never a timed bubble (parent AH-0MVUVSW4J0009QUW AC1).
    expect(reg.consumableCharges('shield')).toBe(1);
    expect(reg.remaining('shield')).toBeUndefined();
    expect(reg.isShielded).toBe(true);

    // The level-resolved cap grows with level — a second collection before
    // the level window expires clamps the pool to the new cap.
    reg.applyCollect('shield');
    expect(reg.consumableCharges('shield')).toBe(
      resolvePowerUpAtLevel('shield', 1).shieldAbsorptions!,
    );
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

  it('holds the granted charge across the level-window TTL (no clawback)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield');
    // The pickup opens no effect window; the level window only reverts the
    // temporary stack at its TTL, and the granted charge is never clawed
    // back (parent AH-0MVUVSW4J0009QUW AC6).
    const ttl = reg.powerUpTemporaryRemaining('shield')!;
    reg.tick(ttl + 0.1);
    expect(reg.isShielded).toBe(true); // charge still held
    expect(reg.consumableCharges('shield')).toBe(1);
    expect(reg.powerUpTemporaryRemaining('shield')).toBeUndefined();
    expect(reg.tryAbsorbShield()).toBe(true);
    expect(reg.isShielded).toBe(false);
  });

  it('re-collects a second charge (total clamped at the level-resolved cap)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield'); // base window
    // Re-collect before expiry is a level-up: the pool gains one more charge,
    // clamped at the new level's cap (never a bubble refresh).
    reg.applyCollect('shield');
    expect(reg.consumableCharges('shield')).toBe(
      resolvePowerUpAtLevel('shield', 1).shieldAbsorptions!,
    );
    expect(reg.remaining('shield')).toBeUndefined();
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

  it('a level-window TTL expiry reverts the temporary level but keeps the charge', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'shield', 1);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBeGreaterThan(0);

    // A levelWindow TTL (not a bubble) expires: the temporary stack reverts,
    // and the granted charges survive untouched (AC6 — no clawback).
    fixture.registry.tick(1000);

    expect(fixture.registry.isShielded).toBe(true);
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBeGreaterThan(0);
    // The upgrade came from field pickups only, so the level reverts.
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

  it('surfaces the remaining charges through the pool accessor and spends on absorb', () => {
    const fixture = createEffectRegistry();
    activateEffectAtUpgradeLevel(fixture, 'shield', 1);

    // The registry's timed map never holds `shield` after a pickup (parent
    // AC1): the armed state and the HUD stack read the pool accessor, not an
    // activeEffects row. A level-window entry is skipped by activeEffects.
    expect(
      fixture.registry.activeEffects().some((e) => e.id === 'shield'),
    ).toBe(false);
    const before = fixture.registry.shieldAbsorptionsRemaining();
    expect(before).toBeGreaterThan(0);

    fixture.registry.tryAbsorbShield();
    expect(fixture.registry.shieldAbsorptionsRemaining()).toBe(before - 1);
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

describe('Force Field: absorbed-hit bullet reflector (AH-0MV1BIX1W006XF95)', () => {
  it('a field pickup grants exactly one charge and no effect window', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('force_field');

    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.forceFieldRemaining()).toBe(1);
    expect(reg.remaining('force_field')).toBeUndefined();
    // The HUD row carries the remaining pool count (parent AC3).
    expect(reg.powerUpLevel('force_field')).toBe(1);
  });

  it('reflects exactly one bullet per granted charge, then stops', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');
    expect(reg.forceFieldRemaining()).toBe(1);

    expect(reg.tryConsumeForceFieldReflect()).toBe(true);
    // Charge spent: a pickup-only bubble pops (armed means holds a charge).
    expect(reg.forceFieldRemaining()).toBe(0);
    expect(reg.isForceFieldActive()).toBe(false);
    expect(reg.tryConsumeForceFieldReflect()).toBe(false);
  });

  it('never reflects when no field is active', () => {
    const reg = new EffectsRegistry();
    expect(reg.isForceFieldActive()).toBe(false);
    expect(reg.tryConsumeForceFieldReflect()).toBe(false);
  });

  it('re-collecting grants a second charge (clamped at the level cap)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');
    // Spend one, then collect again — a second charge lands on the pool.
    expect(reg.tryConsumeForceFieldReflect()).toBe(true);
    reg.applyCollect('force_field');
    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.forceFieldRemaining()).toBeGreaterThanOrEqual(1);
  });

  it('a level-window TTL expiry keeps the granted charge (no clawback)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field');

    const ttl = reg.powerUpTemporaryRemaining('force_field')!;
    reg.tick(ttl + 0.1);

    // The level reverts, the granted charge survives and still reflects.
    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.forceFieldRemaining()).toBe(1);
    expect(reg.tryConsumeForceFieldReflect()).toBe(true);
  });

  it('a permanent reward keeps the bubble up and re-arms as charges return', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('force_field', true);
    expect(reg.isForceFieldActive()).toBe(true);
    // A hold-full reward adds one charge, never a level (parent AC1).
    expect(reg.forceFieldRemaining()).toBe(1);

    // A permanent bubble has nothing to count down, so ticking never expires
    // it, and the unspent charge stays in the pool.
    reg.tick(1000);
    expect(reg.isForceFieldActive()).toBe(true);
    expect(reg.forceFieldRemaining()).toBe(1);

    // Spend it: the bubble stays up but dims (empty pool), then a regenerated
    // charge re-arms it (parent AC3).
    expect(reg.tryConsumeForceFieldReflect()).toBe(true);
    expect(reg.forceFieldRemaining()).toBe(0);
    expect(reg.isForceFieldActive()).toBe(true);
    reg.tick(reg.consumableRechargeRemaining('force_field')! + 0.01);
    expect(reg.forceFieldRemaining()).toBe(1);
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

  it('leaves no timed effect or stored effect state', () => {
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

    // Hold-full reward → one charge and ownership, never a level (parent
    // AH-0MVTQMREN009DSFW AC1).
    reg.applyCollect('mystery_ufo', true);
    expect(store.permanentGrants('mystery_ufo')).toBe(0);
    expect(store.isConsumableOwned('mystery_ufo')).toBe(true);
    expect(store.consumableCharges('mystery_ufo')).toBe(1);
    expect(store.getEffectiveLevel('mystery_ufo')).toBe(1);
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
    reg.applyCollect('teleport'); // second pickup is a no-op on the single-use pool

    expect(reg.updateDanger(true, 0.016)).toBe('teleport');
    // Still in danger on the same episode → no second selection.
    expect(reg.updateDanger(true, 5)).toBeNull();
    expect(reg.teleportStacks()).toBe(1);
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

  it('spends the more abundant Phase Shift stock (greater-count rule)', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift'); // 1 charge
    reg.applyCollect('phase_shift'); // level 2 → 3 charges
    reg.applyCollect('teleport'); // single ready warp
    expect(reg.phaseCharges()).toBe(3);
    expect(reg.teleportStacks()).toBe(1);

    expect(reg.updateDanger(true, 0.016)).toBe('phase_shift');
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
    expect(baseTeleport).toBeCloseTo(60, 6);

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
  it('keeps one ready warp however many times Teleport is collected (single-use)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    expect(reg.hasTeleport()).toBe(false);
    reg.applyCollect('teleport'); // level 1 → one ready warp
    expect(reg.teleportStacks()).toBe(1);
    reg.applyCollect('teleport'); // level 2 → still one ready warp
    expect(reg.teleportStacks()).toBe(1);
    expect(reg.hasTeleport()).toBe(true);
    expect(store.teleportStacks()).toBe(1);
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
    expect(t!.stacks).toBe(1);
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
    // Magnet renders as a timed effect; the Shield pickup opens only a level
    // window (no effect row — the HUD reads the pool accessor).
    expect(reg.activeEffects().map((e) => e.id).sort()).toEqual(['magnet']);
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
  it('example A — field pickups only: level reverts on expiry, charges stay', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    // 1. Pick up Shield → one charge granted, no effect window.
    reg.applyCollect('shield');
    expect(store.getEffectiveLevel('shield')).toBe(1);
    expect(store.getUpgradeLevel('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(reg.isShielded).toBe(true);
    expect(reg.remaining('shield')).toBeUndefined();

    // 2. Pick up Shield again before expiry → a second charge, clamped at the
    //    new level's cap (field-pickup levelling unchanged; no bubble to
    //    refresh).
    reg.applyCollect('shield');
    expect(store.getEffectiveLevel('shield')).toBe(2);
    expect(store.getUpgradeLevel('shield')).toBe(1);
    expect(store.getTempStacks('shield')).toBe(2);
    expect(reg.consumableCharges('shield')).toBe(
      resolvePowerUpAtLevel('shield', 1).shieldAbsorptions!,
    );

    // 3. Level-window expiry → the level reverts to unowned (no permanent
    //    level retained) but the granted charges are never clawed back
    //    (AC6); the shield stays armed while a charge is held.
    reg.tick(1000);
    expect(reg.isShielded).toBe(true);
    expect(reg.consumableCharges('shield')).toBeGreaterThan(0);
    expect(store.getEffectiveLevel('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
  });

  it('example B — hold-full reward then field pickups: reverts to permanent', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    // 1. Take Shield from a hold-full reward → owned (one charge), no level
    // and no endless window (parent AH-0MVTQMREN009DSFW AC1/AC3).
    reg.applyCollect('shield', true);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(store.isConsumableOwned('shield')).toBe(true);
    expect(store.consumableCharges('shield')).toBe(1);
    expect(store.getEffectiveLevel('shield')).toBe(0);
    reg.tick(1000);
    expect(store.getEffectiveLevel('shield')).toBe(0);

    // 2. Pick up Shield in the field → lvl1 (temporary), for x s.
    reg.applyCollect('shield');
    expect(store.getTempStacks('shield')).toBe(1);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(store.getEffectiveLevel('shield')).toBe(1);

    // 3. Expiry → back to the owned-but-unlevelled base (level 0) with its
    // charge still banked (no clawback).
    reg.tick(1000);
    expect(store.getTempStacks('shield')).toBe(0);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(store.getEffectiveLevel('shield')).toBe(0);
    expect(store.consumableCharges('shield')).toBe(1);
    expect(store.isConsumableOwned('shield')).toBe(true);

    // 4. A second hold-full reward adds another charge, never a level (the
    // level-0 pool cap of 1 discards the excess).
    reg.applyCollect('shield', true);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(store.getEffectiveLevel('shield')).toBe(0);
    expect(store.consumableCharges('shield')).toBe(1);
  });

  it('keeps stored P6 charges / P7 teleports after the window expires (AC9)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('teleport');
    const teleports = reg.teleportStacks();
    expect(teleports).toBeGreaterThan(0);
    // Simulate the level window expiring (exactly what the TTL does at
    // expiry) and check the granted teleports are kept.
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

  it('a permanent grant mid-window closes the field window immediately (AC3)', () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('dual'); // field pickup: open 10 s window
    expect(reg.activeWeapons()[0].tempWindow).toBe(true);

    reg.applyWeapon('dual', true); // hold-full reward lands mid-window

    // The weapon strategy is immediate clear: a permanent weapon has no
    // window, so the row reads ∞ straight away and ticking cannot strand a
    // countdown (AH-0MVUGI4IC006PUS5).
    const weapon = reg.activeWeapons()[0];
    expect(weapon.permanent).toBe(true);
    expect(weapon.tempWindow).toBeFalsy();
    expect(reg.hasWeapon('dual')).toBe(true);

    reg.tick(10.1);
    expect(reg.hasWeapon('dual')).toBe(true);
    expect(reg.activeWeapons()[0].tempWindow).toBeFalsy();
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

// ── Thorn Field recharge (AH-0MVJ8YKR70096C6T) ─────────────────────────

describe('Thorn Field: automatic ram recharge (AH-0MVJ8YKR70096C6T)', () => {
  it('resolves the level-derived recharge interval and maximum budget', () => {
    const { registry } = createEffectRegistry();
    registry.applyCollect('thorns', true);
    // Base level: 12 s between recharges, 2 rams to recharge up to.
    expect(registry.thornsRechargeTime()).toBeCloseTo(12, 6);
    expect(registry.thornsMaxAbsorbs()).toBe(2);
  });

  it('permanently owned field refills one spent ram per level-resolved interval', () => {
    const { registry, store } = createEffectRegistry();
    // A **permanently owned** field (scripted level counts as owned, Q-A1=b)
    // regenerates one spent ram per level-resolved interval through the
    // shared pool clock — the only regeneration path (parent
    // AH-0MVTQMREN009DSFW AC2).
    store.setPermanentLevel('thorns', 7);
    registry.applyCollect('thorns', true);
    // Fill the level-resolved budget (a hold-full grant added one charge, and
    // scripted top-ups are the game's grant seam).
    const budget = registry.thornsMaxAbsorbs();
    store.grantConsumableCharge('thorns', budget);
    expect(registry.thornsRemaining()).toBe(budget);

    expect(registry.tryConsumeThornsRam()).toBe(true);
    expect(registry.thornsRemaining()).toBe(budget - 1);
    const interval = registry.thornsRechargeTime();
    // The shared pool clock starts the moment a ram is spent.
    expect(registry.thornsRechargeRemaining()).toBeCloseTo(interval, 6);

    registry.tick(interval - 0.1);
    expect(registry.thornsRemaining()).toBe(budget - 1);
    expect(registry.thornsRechargeRemaining()).toBeLessThan(0.2);

    registry.tick(0.2);
    expect(registry.thornsRemaining()).toBe(budget);
    // A full budget recharges nothing.
    expect(registry.thornsRechargeRemaining()).toBe(0);
  });

  it('never recharges past the level-resolved maximum', () => {
    const { registry } = createEffectRegistry();
    registry.applyCollect('thorns', true); // owned: one charge of a cap of two
    expect(registry.thornsRemaining()).toBe(1);
    while (registry.thornsRemaining() > 0) registry.tryConsumeThornsRam();
    expect(registry.thornsRemaining()).toBe(0);
    // Four intervals elapse in one long frame: only the one spent charge
    // returns, and the pool never exceeds the level-resolved cap.
    registry.tick(12 * 4);
    expect(registry.thornsRemaining()).toBe(1);
    expect(registry.thornsRemaining()).toBeLessThanOrEqual(
      registry.thornsMaxAbsorbs(),
    );
  });

  it('is frame-rate independent: many small ticks recharge exactly one ram', () => {
    const { registry, store } = createEffectRegistry();
    registry.applyCollect('thorns', true);
    store.grantConsumableCharge('thorns', 2); // fill the level-0 pool (cap 2)
    registry.tryConsumeThornsRam();
    expect(registry.thornsRemaining()).toBe(1);

    const step = 0.1;
    const interval = registry.thornsRechargeTime();
    const ticks = Math.round(interval / step) - 1;
    for (let i = 0; i < ticks; i += 1) registry.tick(step);
    expect(registry.thornsRemaining()).toBe(1);
    // The single final tick crosses the interval.
    registry.tick(step * 2);
    expect(registry.thornsRemaining()).toBe(2);
  });

  it('a pickup-only charge never regenerates and the level window revert keeps it', () => {
    const { registry } = createEffectRegistry();
    // A pickup-only field grants exactly one charge that never refills
    // (Q-A1=b): even after the level window expires the granted charge stays
    // usable, and no clock starts for a spent pickup charge.
    registry.applyCollect('thorns');
    expect(registry.thornsRemaining()).toBe(1);

    registry.tryConsumeThornsRam();
    expect(registry.thornsRemaining()).toBe(0);
    expect(registry.thornsRechargeRemaining()).toBe(0);

    // The level window expires; the air clears but no charge is owed.
    registry.tick(60);
    expect(registry.thornsRemaining()).toBe(0);
    expect(registry.tryConsumeThornsRam()).toBe(false);
  });

  it('keeps a hold-full (permanent) field recharging for the whole run', () => {
    const { registry } = createEffectRegistry();
    registry.applyCollect('thorns', true); // permanent
    while (registry.thornsRemaining() > 0) registry.tryConsumeThornsRam();
    expect(registry.thornsRemaining()).toBe(0);

    registry.tick(12 * 3); // a permanent grant has nothing to count down
    // Only the one spent charge returns — the pool is not topped back up to
    // the cap (parent AC2).
    expect(registry.thornsRemaining()).toBe(1);
  });

  it('a stronger level recharges faster (shorter interval, same cap)', () => {
    const { registry, store } = createEffectRegistry();
    // The thrower is levelled directly (a hold-full reward of a consumable no
    // longer levels it — parent AH-0MVTQMREN009DSFW AC1): level 6 → upgrade 5
    // → 6 rams at the curve cap.
    store.setPermanentLevel('thorns', 7);
    registry.applyCollect('thorns', true);
    expect(registry.thornsRechargeTime()).toBeLessThan(12);
    expect(registry.thornsMaxAbsorbs()).toBe(6);

    while (registry.thornsRemaining() > 0) registry.tryConsumeThornsRam();
    registry.tick(registry.thornsRechargeTime() + 0.01);
    expect(registry.thornsRemaining()).toBe(1);
  });

  it('reset() clears the recharge clock', () => {
    const { registry } = createEffectRegistry();
    registry.applyCollect('thorns', true);
    registry.tryConsumeThornsRam();
    expect(registry.thornsRechargeRemaining()).toBeGreaterThan(0);

    registry.reset();
    expect(registry.thornsRemaining()).toBe(0);
    expect(registry.thornsRechargeRemaining()).toBe(0);
  });

  it('reports the recharge countdown only while a ram is owed', () => {
    const { registry } = createEffectRegistry();
    expect(registry.thornsRechargeRemaining()).toBe(0); // inactive
    registry.applyCollect('thorns', true);
    expect(registry.thornsRechargeRemaining()).toBe(0); // full budget
    registry.tryConsumeThornsRam();
    expect(registry.thornsRechargeRemaining()).toBeGreaterThan(0);
    registry.tick(registry.thornsRechargeTime() + 0.01);
    expect(registry.thornsRechargeRemaining()).toBe(0); // refilled
  });
});
// ── Orbital Strike bolt retention latch (AH-0MVS2T2DJ0069C0Y) ───────
//
// REGRESSION (test-first by AH-0MVS2SW8V007ZBJQ, implemented by
// AH-0MVS2T2DJ0069C0Y): the no-silent-waste contract is that a decided bolt
// stays **latched** until the shared core resolves it, exactly once, never a
// banked volley. `EffectsRegistry.updateStrike` reports a due bolt every frame
// and `resolveStrike()` is the acknowledgement that consumes it.

describe('Orbital Strike bolt retention latch (AH-0MVS2T2DJ0069C0Y)', () => {
  it('reports a due bolt on every frame until the shared core resolves it', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike'); // a field pickup is due right now

    // The bolt waits for a valid target: it must stay due, never vanish.
    expect(reg.updateStrike(1 / 60)).toBe(true);
    expect(reg.updateStrike(1 / 60)).toBe(true);
    expect(reg.updateStrike(1 / 60)).toBe(true);

    // Acknowledging the landed bolt consumes exactly one shot.
    reg.resolveStrike();
    expect(reg.updateStrike(1 / 60)).toBe(false);
    expect(reg.updateStrike(1 / 60)).toBe(false);
  });

  it('banks at most one bolt across a long enemy-free gap', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true); // permanent
    const interval = reg.strikeInterval();

    // Several intervals elapse with nobody able to resolve the bolt.
    for (let t = 0; t < interval * 3; t += 0.1) {
      expect(reg.updateStrike(0.1)).toBe(true);
    }

    // One acknowledgement clears the *whole* gap — never a banked volley.
    reg.resolveStrike();
    expect(reg.updateStrike(0.1)).toBe(false);
  });

  it('does not advance the permanent interval while a bolt is latched', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true);
    const interval = reg.strikeInterval();

    // Hold the bolt latched for most of an interval without acknowledging it.
    for (let t = 0; t < interval - 1; t += 0.5) {
      reg.updateStrike(0.5);
    }
    reg.resolveStrike();

    // The next bolt is still a full interval away — the clock was frozen,
    // not pre-spent by the gap.
    expect(reg.updateStrike(interval - 1)).toBe(false);
    expect(reg.updateStrike(2)).toBe(true);
  });

  it('resolveStrike is a no-op when no bolt is due', () => {
    const reg = new EffectsRegistry();
    // An acknowledgement with nothing latched must not mint a bolt.
    expect(() => reg.resolveStrike()).not.toThrow();
    expect(reg.updateStrike(1 / 60)).toBe(false);
  });
});

// ── Orbital Strike beat-aligned cadence (AH-0MVRE6N08001TE4V) ─────────
//
// REGRESSION (producer rejection 2026-10-29): the permanent strike's first
// grant fired only once every 30 s, so in play it read as "it does nothing".
// The cadence is now expressed in whole beats of the shared 80 BPM grid
// (`src/utils/beat.ts`) so a bolt lands on the same pulse the rest of the
// game's cues are quantised to: 9 beats (6.75 s, ≈ 7 s) from the first grant,
// one beat sooner per level, floored at 3 beats (2.25 s).

describe('Orbital Strike beat-aligned cadence (AH-0MVRE6N08001TE4V)', () => {
  it('fires the permanent bolt every 9 beats (~7 s) from the first grant', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true); // hold-full (permanent) reward

    // The opening bolt is due immediately; land it so the interval runs.
    expect(reg.updateStrike(0.1)).toBe(true);
    reg.resolveStrike();

    const beatSeconds = beatPeriodMs() / 1000; // 0.75 s at the default 80 BPM
    expect(reg.strikeInterval()).toBeCloseTo(9 * beatSeconds, 12);
    // "Around every 7 seconds", snapped to the beat grid.
    expect(Math.abs(reg.strikeInterval() - 7)).toBeLessThanOrEqual(
      beatSeconds / 2,
    );

    // Drive the shared clock at 60 Hz until the next bolt comes due: the
    // observed cadence — not just the resolved constant — is the behaviour
    // the player hears and sees.
    const step = 1 / 60;
    let frames = 0;
    while (!reg.updateStrike(step)) {
      frames += 1;
      expect(frames).toBeLessThan(60 * 30); // never a 30 s gap again
    }
    expect((frames + 1) * step).toBeCloseTo(9 * beatSeconds, 1);
  });

  it('keeps every level on a whole number of beats, down to the 3-beat floor', () => {
    const beatSeconds = beatPeriodMs() / 1000;
    const reg = new EffectsRegistry();

    let previous = Infinity;
    // Each hold-full grant adds one permanent upgrade level (0 → 9).
    for (let grant = 1; grant <= 10; grant++) {
      reg.applyCollect('strike', true);
      const interval = reg.strikeInterval();
      const beats = interval / beatSeconds;
      expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-9);
      expect(beats).toBeGreaterThanOrEqual(3);
      expect(beats).toBeLessThanOrEqual(9);
      expect(interval).toBeLessThanOrEqual(previous);
      previous = interval;
    }
    // The floor is reached (6 upgrades × 1 beat) and held from there on.
    expect(reg.strikeInterval()).toBeCloseTo(3 * beatSeconds, 12);
  });
});

//
// The HUD renders the permanent strike row's `next in Ns` from this accessor,
// so the registry — not the HUD — owns the clock. The accessor must report a
// live, positive seconds-remaining value only while the interval is genuinely
// running: no permanent strike, or a latched/landing bolt, has nothing to
// count down.

describe('Orbital Strike next-bolt countdown accessor (AH-0MVS2T40T006QL7H)', () => {
  it('is undefined when no permanent strike is armed', () => {
    const reg = new EffectsRegistry();
    expect(reg.strikeNextBoltSeconds()).toBeUndefined();

    // A field pickup is a one-shot with no interval to count down.
    reg.applyCollect('strike');
    expect(reg.strikeNextBoltSeconds()).toBeUndefined();
  });

  it('counts down the level-resolved interval for a permanent strike', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true); // hold-full (permanent) reward
    const interval = reg.strikeInterval();

    // Land the opening bolt so the interval clock runs.
    expect(reg.updateStrike(0.1)).toBe(true);
    reg.resolveStrike();

    const before = reg.strikeNextBoltSeconds();
    expect(before).toBeDefined();
    expect(before!).toBeGreaterThan(0);
    expect(before!).toBeLessThanOrEqual(interval);

    // The countdown is live: advancing the shared clock decreases it.
    expect(reg.updateStrike(5)).toBe(false);
    const after = reg.strikeNextBoltSeconds();
    expect(after).toBeDefined();
    expect(after!).toBeLessThan(before!);
    expect(after!).toBeGreaterThan(0);
  });

  it('is undefined while a bolt is latched so the countdown never stalls', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true);
    const interval = reg.strikeInterval();

    // A bolt comes due with nobody able to resolve it (no live target): the
    // interval clock is frozen, so there is no honest countdown to show.
    expect(reg.updateStrike(interval + 1)).toBe(true);
    expect(reg.strikeNextBoltSeconds()).toBeUndefined();

    // Once the shared core lands the bolt, the countdown resumes.
    reg.resolveStrike();
    const resumed = reg.strikeNextBoltSeconds();
    expect(resumed).toBeDefined();
    expect(resumed!).toBeGreaterThan(0);
    expect(resumed!).toBeLessThanOrEqual(interval);
  });

  it('never returns a negative or non-finite countdown', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true);
    const interval = reg.strikeInterval();

    for (let elapsed = 0; elapsed <= interval * 3; elapsed += 0.25) {
      const seconds = reg.strikeNextBoltSeconds();
      if (seconds !== undefined) {
        expect(Number.isFinite(seconds)).toBe(true);
        expect(seconds).toBeGreaterThan(0);
      }
      if (reg.updateStrike(0.25)) reg.resolveStrike();
    }
  });
});

// ── Instant-kind temporary windows (AH-0MVUGI448000GNMJ) ─────────────

describe('instant-kind temporary windows (AH-0MVUGI448000GNMJ)', () => {
  /** The ten kinds with no timed effect of their own. */
  const INSTANT_KINDS: PowerUpId[] = [
    'bomb',
    'smart_bomb',
    'strike',
    'phase_shift',
    'teleport',
    'extra_life',
    'mystery_ufo',
    // The three absorbed-hit kinds were reclassified as instant kinds by
    // AH-0MVVD8SXO004QLZW (their window axes retired): a field pickup opens
    // the same per-upgrade level window, sized by the flat catalogue TTL.
    'shield',
    'force_field',
    'thorns',
  ];

  it('opens a per-upgrade level window for every instant kind and reverts at it', () => {
    for (const id of INSTANT_KINDS) {
      const store = new PowerUpLevelStore();
      const reg = new EffectsRegistry(store);

      reg.applyCollect(id);

      const window = resolveTemporaryWindow(id, store.getUpgradeLevel(id));
      expect(window).toBe(POWER_UP_CATALOGUE[id].temporaryWindow);
      expect(reg.powerUpTemporaryRemaining(id)).toBeCloseTo(window, 10);
      // A level window is not a timed gameplay effect: no effect row and no
      // timed remaining value (the HUD countdown comes from the level API).
      expect(reg.isActive(id)).toBe(false);
      expect(reg.remaining(id)).toBeUndefined();
      expect(
        reg
          .activeEffects()
          .some((e) => e.id === id && e.remaining !== undefined),
      ).toBe(false);

      reg.tick(window + 0.1);

      expect(reg.powerUpTemporaryRemaining(id)).toBeUndefined();
      expect(store.getTempStacks(id)).toBe(0);
      expect(store.getEffectiveLevel(id)).toBe(0);
    }
  });

  it('a permanent grant opens no level window and never silently expires (AC2)', () => {
    for (const id of INSTANT_KINDS) {
      const reg = new EffectsRegistry();
      reg.applyCollect(id, true);

      // A **consumable** hold-full reward adds a charge instead of a level
      // (parent AH-0MVTQMREN009DSFW AC1), so only the non-consumable instant
      // kinds gain a level here.
      const levelAfterGrant = isConsumablePowerUpId(id) ? 0 : 1;
      expect(reg.powerUpTemporaryRemaining(id)).toBeUndefined();
      expect(reg.powerUpLevel(id)).toBe(levelAfterGrant);

      reg.tick(600);

      expect(reg.powerUpTemporaryRemaining(id)).toBeUndefined();
      expect(reg.powerUpLevel(id)).toBe(levelAfterGrant);
    }
  });

  it('preserves every one-shot and immediate consumable grant (AC3)', () => {
    const bomb = new EffectsRegistry();
    bomb.applyCollect('bomb');
    expect(bomb.updateBomb(0.016)).toBe(true);
    expect(bomb.updateBomb(100)).toBe(false);

    const smart = new EffectsRegistry();
    smart.applyCollect('smart_bomb');
    expect(smart.updateSmartBomb(0.016)).toBe(true);
    expect(smart.updateSmartBomb(100)).toBe(false);

    const strike = new EffectsRegistry();
    strike.applyCollect('strike');
    expect(strike.updateStrike(0.016)).toBe(true);
    strike.resolveStrike();
    expect(strike.updateStrike(100)).toBe(false);

    const ufo = new EffectsRegistry();
    ufo.applyCollect('mystery_ufo');
    expect(ufo.consumeMysteryUfoSpawns()).toBe(1);
    expect(ufo.consumeMysteryUfoSpawns()).toBe(0);

    const phase = new EffectsRegistry();
    phase.applyCollect('phase_shift');
    expect(phase.phaseCharges()).toBe(1);

    const teleport = new EffectsRegistry();
    teleport.applyCollect('teleport');
    expect(teleport.teleportStacks()).toBe(1);

    const life = new EffectsRegistry();
    life.applyCollect('extra_life');
    expect(life.lives()).toBe(P8_LIVES_START + 1);
  });

  it('a phase-shift level window never makes the ship intangible', () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');

    expect(reg.isPhased).toBe(false);
    expect(reg.isHitImmune).toBe(false);
    expect(reg.powerUpTemporaryRemaining('phase_shift')).toBeGreaterThan(0);

    // The activation is a separate, much shorter timer.
    expect(reg.updateDanger(true, 0.016)).toBe('phase_shift');
    expect(reg.isPhased).toBe(true);
    reg.tick(PHASE_DURATION + 0.01);
    expect(reg.isPhased).toBe(false);
    expect(reg.powerUpTemporaryRemaining('phase_shift')).toBeGreaterThan(0);
  });

  it('refreshes an open window to the full TTL instead of stacking timers (AC5)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('bomb');
    const ttl = reg.powerUpTemporaryRemaining('bomb')!;
    reg.tick(ttl - 2);
    expect(reg.powerUpTemporaryRemaining('bomb')).toBeCloseTo(2, 10);

    reg.applyCollect('bomb');
    // The level stacks, but there is still exactly one timer, refreshed.
    expect(store.getTempStacks('bomb')).toBe(2);
    expect(reg.powerUpTemporaryRemaining('bomb')).toBeCloseTo(ttl, 10);

    reg.tick(ttl + 0.1);
    expect(store.getTempStacks('bomb')).toBe(0);
  });

  it('latches a strike bolt with its decision-time damage (AC4)', () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);

    reg.applyCollect('strike', true); // permanent → upgrade level 0
    const permanentDamage = reg.strikeDamage();
    reg.applyCollect('strike'); // field pickup → upgrade level 1
    const pickupDamage = reg.strikeDamage();
    expect(pickupDamage).toBeGreaterThan(permanentDamage);

    // Decide (latch) the bolt with nobody to land it on…
    expect(reg.updateStrike(0.016)).toBe(true);
    const window = reg.powerUpTemporaryRemaining('strike')!;
    // …let the temporary level revert while it waits…
    reg.tick(window + 0.1);
    expect(store.getEffectiveLevel('strike')).toBe(1);

    // …and the already-decided bolt keeps its pickup-time damage.
    expect(reg.strikeDamage()).toBe(pickupDamage);

    reg.resolveStrike();
    expect(reg.strikeDamage()).toBe(permanentDamage);
  });

  it('keeps a queued bomb/smart-bomb pulse priced at decision time (AC4)', () => {
    const bombStore = new PowerUpLevelStore();
    const bomb = new EffectsRegistry(bombStore);
    bomb.applyCollect('bomb', true);
    bomb.applyCollect('bomb');
    const pickupRange = bomb.bombPulseRange();
    const bombWindow = bomb.powerUpTemporaryRemaining('bomb')!;
    bomb.tick(bombWindow + 0.1);
    expect(bombStore.getEffectiveLevel('bomb')).toBe(1);
    expect(bomb.bombPulseRange()).toBe(pickupRange);
    expect(bomb.updateBomb(0.016)).toBe(true);
    expect(bomb.bombPulseRange()).toBe(pickupRange);

    const smartStore = new PowerUpLevelStore();
    const smart = new EffectsRegistry(smartStore);
    smart.applyCollect('smart_bomb', true);
    smart.applyCollect('smart_bomb');
    const pickupAoe = smart.smartBombPulseAoe();
    const smartWindow = smart.powerUpTemporaryRemaining('smart_bomb')!;
    smart.tick(smartWindow + 0.1);
    expect(smartStore.getEffectiveLevel('smart_bomb')).toBe(1);
    expect(smart.smartBombPulseAoe()).toEqual(pickupAoe);
    expect(smart.updateSmartBomb(0.016)).toBe(true);
    expect(smart.smartBombPulseAoe()).toEqual(pickupAoe);
  });
});

// ── Shared consumable charge pool: one-event consumption (F3) ───────
//
// Registry-level contract for AH-0MVUXH1LV0058TS3 (parent
// AH-0MVTQMREN009DSFW): a permanently-owned consumable spends exactly one
// shared-pool charge per event, its armed/budget accessors project that pool,
// and regeneration advances only through `tick(dt)` — the single call site the
// game and every gym share.

describe('Shared consumable charge pool: one-event consumption (F3)', () => {
  /** The six catalogue consumables (parent producer decision 1). */
  const CONSUMABLE_IDS: PowerUpId[] = [
    'shield',
    'thorns',
    'phase_shift',
    'teleport',
    'force_field',
    'mystery_ufo',
  ];

  /** The four kinds whose one-event spend is a registry-local seam. */
  const SPENDABLE_IDS: PowerUpId[] = [
    'shield',
    'thorns',
    'force_field',
    'mystery_ufo',
  ];

  /** A fresh registry bound to its run-scoped store. */
  function poolFixture(): {
    registry: EffectsRegistry;
    store: PowerUpLevelStore;
  } {
    const store = new PowerUpLevelStore();
    return { registry: new EffectsRegistry(store), store };
  }

  /** Spends one event of `id` through the registry's per-kind seam. */
  function spendOneEvent(registry: EffectsRegistry, id: PowerUpId): boolean {
    switch (id) {
      case 'shield':
        return registry.tryAbsorbShield();
      case 'thorns':
        return registry.tryConsumeThornsRam();
      case 'force_field':
        return registry.tryConsumeForceFieldReflect();
      case 'mystery_ufo':
        return registry.consumeMysteryUfoCharge();
      default:
        throw new Error(`no one-event spend seam for ${id}`);
    }
  }

  it('AC1 — a permanent Shield is armed only while a charge is held', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('shield', true);

    // A hold-full reward adds one charge, never a level and never a window.
    expect(store.isConsumableOwned('shield')).toBe(true);
    expect(store.getPermanentLevel('shield')).toBe(0);
    expect(registry.consumableCharges('shield')).toBe(1);
    expect(registry.isShielded).toBe(true);
    expect(registry.isHitImmune).toBe(true);
    expect(registry.shieldAbsorptionsRemaining()).toBe(1);
    expect(registry.powerUpTemporaryRemaining('shield')).toBeUndefined();

    // One absorbed hit spends the single level-0 charge and disarms it.
    expect(registry.tryAbsorbShield()).toBe(true);
    expect(registry.consumableCharges('shield')).toBe(0);
    expect(registry.shieldAbsorptionsRemaining()).toBe(0);
    expect(registry.isShielded).toBe(false);
    expect(registry.tryAbsorbShield()).toBe(false);

    // The pool regenerates on the level-derived interval, through tick only.
    expect(registry.consumableRechargeRemaining('shield')).toBeCloseTo(
      resolvePowerUpAtLevel('shield', 0).shieldRecharge!,
      6,
    );
    registry.tick(registry.consumableRechargeRemaining('shield')! - 0.1);
    expect(registry.isShielded).toBe(false);
    registry.tick(0.2);
    expect(registry.consumableCharges('shield')).toBe(1);
    expect(registry.isShielded).toBe(true);
    expect(registry.tryAbsorbShield()).toBe(true);
  });

  it('AC2 — a permanent Thorn Field spends one charge per free ram', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('thorns', true);

    // Level 0: one granted charge, cap of two rams.
    expect(store.consumableChargeCap('thorns')).toBe(2);
    expect(registry.thornsRemaining()).toBe(1);
    expect(registry.hasThornsRam()).toBe(true);
    expect(registry.thornsRechargeRemaining()).toBe(0); // nothing owed yet

    expect(registry.tryConsumeThornsRam()).toBe(true);
    expect(registry.thornsRemaining()).toBe(0);
    expect(registry.hasThornsRam()).toBe(false);
    expect(registry.tryConsumeThornsRam()).toBe(false);
    // The countdown is the shared pool's clock (thornsRecharge 12 s at level 0).
    expect(registry.thornsRechargeRemaining()).toBeCloseTo(
      resolvePowerUpAtLevel('thorns', 0).thornsRecharge!,
      6,
    );

    registry.tick(registry.thornsRechargeRemaining() + 0.01);
    expect(registry.thornsRemaining()).toBe(1);
    expect(registry.hasThornsRam()).toBe(true);
    expect(registry.tryConsumeThornsRam()).toBe(true); // re-use

    // The permanent field no longer tops itself back up to the cap: only the
    // one spent charge returns, so the pool can never refill endlessly.
    registry.tick(registry.thornsRechargeTime() * 10);
    expect(registry.thornsRemaining()).toBe(1);
    expect(registry.thornsRemaining()).toBeLessThanOrEqual(
      registry.thornsMaxAbsorbs(),
    );
  });

  it('AC3 — a permanent Force Field spends one charge per reflected bullet and dims when empty', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('force_field', true);

    expect(store.consumableChargeCap('force_field')).toBe(3);
    expect(registry.consumableCharges('force_field')).toBe(1);
    expect(registry.isForceFieldActive()).toBe(true);
    expect(registry.forceFieldRemaining()).toBe(1);

    expect(registry.tryConsumeForceFieldReflect()).toBe(true);
    expect(registry.consumableCharges('force_field')).toBe(0);
    expect(registry.forceFieldRemaining()).toBe(0);
    // Empty, but the owned bubble stays up (dimmed) and refuses to reflect.
    expect(registry.isForceFieldActive()).toBe(true);
    expect(registry.tryConsumeForceFieldReflect()).toBe(false);
    expect(registry.consumableRechargeRemaining('force_field')).toBeCloseTo(
      resolvePowerUpAtLevel('force_field', 0).forceFieldRecharge!,
      6,
    );

    registry.tick(registry.consumableRechargeRemaining('force_field')! + 0.01);
    expect(registry.forceFieldRemaining()).toBe(1);
    expect(registry.tryConsumeForceFieldReflect()).toBe(true); // re-arms
  });

  it('AC4 — a permanent Mystery UFO spends one charge per drone spawn, one per interval', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('mystery_ufo', true);

    expect(registry.isMysteryUfoPermanent()).toBe(true);
    expect(registry.consumableCharges('mystery_ufo')).toBe(1);
    // The spawn interval and the pool's regeneration interval are one axis.
    expect(registry.mysteryUfoSpawnInterval()).toBeCloseTo(
      store.consumableRechargeTime('mystery_ufo'),
      6,
    );

    // One spawn spends the only level-0 charge; the cap refuses a second
    // spawn in the same interval instead of spawning forever.
    expect(registry.consumeMysteryUfoCharge()).toBe(true);
    expect(registry.consumableCharges('mystery_ufo')).toBe(0);
    expect(registry.consumeMysteryUfoCharge()).toBe(false);

    registry.tick(registry.mysteryUfoSpawnInterval() + 0.01);
    expect(registry.consumableCharges('mystery_ufo')).toBe(1);
    expect(registry.consumeMysteryUfoCharge()).toBe(true);
  });

  it('AC4 — the UFO charge cap never exceeds the level-derived axis', () => {
    const { registry, store } = poolFixture();
    store.setPermanentLevel('mystery_ufo', 4); // scripted level (not a grant)
    registry.applyCollect('mystery_ufo', true);

    const cap = store.consumableChargeCap('mystery_ufo');
    expect(cap).toBeGreaterThan(1);
    // A grant adds one charge, clamped at the cap — never more.
    expect(registry.consumableCharges('mystery_ufo')).toBeLessThanOrEqual(cap);
    for (let i = 0; i < 10; i++) {
      const before = registry.consumableCharges('mystery_ufo');
      expect(registry.consumeMysteryUfoCharge()).toBe(before > 0);
    }
    expect(registry.consumableCharges('mystery_ufo')).toBe(0);
  });

  it('AC5 — Phase Shift spends and regenerates through the shared pool', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('phase_shift', true);
    expect(registry.phaseCharges()).toBe(1);
    expect(registry.consumableCharges('phase_shift')).toBe(1);

    expect(registry.updateDanger(true, 0)).toBe('phase_shift');
    expect(registry.consumableCharges('phase_shift')).toBe(0);
    // Nothing regenerates without a tick.
    expect(registry.consumableCharges('phase_shift')).toBe(0);
    expect(registry.consumableRechargeRemaining('phase_shift')).toBeCloseTo(
      store.consumableRechargeTime('phase_shift'),
      6,
    );

    registry.tick(registry.consumableRechargeRemaining('phase_shift')! + 0.01);
    expect(registry.consumableCharges('phase_shift')).toBe(1);
  });

  it('AC5 — Teleport spends and regenerates through the shared pool', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('teleport', true);
    expect(registry.teleportStacks()).toBe(1);

    expect(registry.consumeTeleport()).toBe(true);
    expect(registry.consumableCharges('teleport')).toBe(0);
    expect(registry.consumeTeleport()).toBe(false);
    expect(registry.consumableRechargeRemaining('teleport')).toBeCloseTo(
      store.consumableRechargeTime('teleport'),
      6,
    );

    registry.tick(registry.consumableRechargeRemaining('teleport')! + 0.01);
    expect(registry.teleportStacks()).toBe(1);
    expect(registry.consumeTeleport()).toBe(true);
  });

  it('AC6 — reports charges and countdown for every consumable in every state', () => {
    for (const id of CONSUMABLE_IDS) {
      const { registry, store } = poolFixture();
      const cap = store.consumableChargeCap(id);

      // Not owned, never charged: zero charges and no countdown.
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(registry.consumableRechargeRemaining(id), id).toBeUndefined();

      // Full: no countdown while nothing is owed.
      registry.applyCollect(id, true);
      store.grantConsumableCharge(id, cap);
      expect(registry.consumableCharges(id), id).toBe(cap);
      expect(registry.consumableRechargeRemaining(id), id).toBeUndefined();

      // Partial: a spent charge starts a live countdown.
      expect(registry.tryConsumeConsumableCharge(id), id).toBe(true);
      expect(registry.consumableCharges(id), id).toBe(cap - 1);
      expect(registry.consumableRechargeRemaining(id), id).toBeCloseTo(
        store.consumableRechargeTime(id),
        6,
      );

      // Empty: still counting down; the charge returns on the shared tick.
      while (registry.tryConsumeConsumableCharge(id)) {
        // drain the remaining charges
      }
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(registry.consumableRechargeRemaining(id), id).toBeGreaterThan(0);
      registry.tick(store.consumableRechargeTime(id) + 0.01);
      expect(registry.consumableCharges(id), id).toBeGreaterThan(0);
    }
  });

  it('AC6 — a partial pool with no spent charge has no countdown (no fabricated timer)', () => {
    const { registry, store } = poolFixture();
    registry.applyCollect('thorns', true); // one charge, cap two
    expect(registry.consumableCharges('thorns')).toBe(1);
    expect(registry.consumableCharges('thorns')).toBeLessThan(
      store.consumableChargeCap('thorns'),
    );
    // Nothing was spent, so no regeneration is in flight.
    expect(registry.consumableRechargeRemaining('thorns')).toBeUndefined();
  });

  it('AC6 — non-consumables have no charge pool and no countdown', () => {
    const { registry } = poolFixture();
    registry.applyCollect('bomb', true);
    expect(registry.consumableCharges('bomb')).toBe(0);
    expect(registry.consumableRechargeRemaining('bomb')).toBeUndefined();
    expect(registry.tryConsumeConsumableCharge('bomb')).toBe(false);
  });

  it('AC7 — spend → empty → regenerate → re-use per pool-backed kind, tick-only', () => {
    for (const id of SPENDABLE_IDS) {
      const { registry, store } = poolFixture();
      registry.applyCollect(id, true);
      expect(registry.consumableCharges(id), id).toBe(1);

      // No charge returns without a tick: the pool holds still.
      expect(registry.consumableCharges(id), id).toBe(1);
      registry.tick(0);
      expect(registry.consumableCharges(id), id).toBe(1);

      expect(spendOneEvent(registry, id), id).toBe(true);
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(spendOneEvent(registry, id), id).toBe(false);

      const interval = store.consumableRechargeTime(id);
      registry.tick(interval - 0.01);
      expect(registry.consumableCharges(id), id).toBe(0);
      registry.tick(0.02);
      expect(registry.consumableCharges(id), id).toBe(1);
      expect(spendOneEvent(registry, id), id).toBe(true);
    }
  });

  it('AC7 — many small ticks and one long tick regenerate identically', () => {
    const oneBigTick = poolFixture();
    const manySmallTicks = poolFixture();
    for (const { registry } of [oneBigTick, manySmallTicks]) {
      registry.applyCollect('shield', true);
      registry.tryAbsorbShield();
    }
    const interval = oneBigTick.store.consumableRechargeTime('shield');
    oneBigTick.registry.tick(interval + 0.01);
    for (let i = 0; i < 451; i++) manySmallTicks.registry.tick(0.1);
    expect(oneBigTick.registry.consumableCharges('shield')).toBe(1);
    expect(manySmallTicks.registry.consumableCharges('shield')).toBe(1);
  });

  it('AC7 — reset clears every pool, timer and armed state', () => {
    const { registry } = poolFixture();
    for (const id of CONSUMABLE_IDS) registry.applyCollect(id, true);
    expect(registry.isShielded).toBe(true);
    expect(registry.isForceFieldActive()).toBe(true);

    registry.reset();

    for (const id of CONSUMABLE_IDS) {
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(registry.consumableRechargeRemaining(id), id).toBeUndefined();
      expect(registry.isConsumableOwned(id), id).toBe(false);
    }
    expect(registry.isShielded).toBe(false);
    expect(registry.isForceFieldActive()).toBe(false);
    // A long tick after the reset cannot resurrect a cleared pool.
    registry.tick(3600);
    for (const id of CONSUMABLE_IDS) {
      expect(registry.consumableCharges(id), id).toBe(0);
    }
  });

  it('AC1 — a field pickup of the three budget kinds grants exactly one charge and no effect window', () => {
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      const { registry, store } = poolFixture();
      registry.applyCollect(id);

      // Exactly one charge into the shared pool, clamped at the cap.
      expect(store.isConsumableOwned(id), id).toBe(false);
      expect(registry.consumableCharges(id), id).toBe(1);
      // No effect window: no timed map entry, no remaining countdown, no row.
      expect(registry.isActive(id), id).toBe(false);
      expect(registry.remaining(id), id).toBeUndefined();
      expect(registry.powerUpTemporaryRemaining(id), id).toBeDefined(); // level window only
      expect(
        registry.activeEffects().some((e) => e.id === id),
        `${id} active row`,
      ).toBe(false);
    }
  });

  it('AC1 — each budget-kind pickup grants one charge the level-resolved cap never exceeds', () => {
    const { registry, store } = poolFixture();
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      registry.applyCollect(id);
      expect(registry.consumableCharges(id)).toBe(1);
      expect(registry.consumableCharges(id)).toBeLessThanOrEqual(
        store.consumableChargeCap(id),
      );
    }
  });

  it('AC2 — one pickup charge resolves exactly one event and never regenerates', () => {
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      const { registry, store } = poolFixture();
      registry.applyCollect(id); // pickup-only: not owned

      expect(spendOneEvent(registry, id), id).toBe(true);
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(spendOneEvent(registry, id), id).toBe(false);

      // A pickup-granted charge never regenerates (Q-A1=b): long ticks grant
      // nothing and no regeneration clock starts.
      expect(registry.consumableRechargeRemaining(id), id).toBeUndefined();
      registry.tick(store.consumableRechargeTime(id) * 10);
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(spendOneEvent(registry, id), id).toBe(false);
    }
  });

  it('AC2 — a permanently granted budget kind keeps the spend/regenerate/re-use cycle', () => {
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      const { registry, store } = poolFixture();
      registry.applyCollect(id, true); // owned + one charge
      expect(store.isConsumableOwned(id), id).toBe(true);

      expect(spendOneEvent(registry, id), id).toBe(true);
      expect(registry.consumableCharges(id), id).toBe(0);
      registry.tick(store.consumableRechargeTime(id) + 0.01);
      expect(registry.consumableCharges(id), id).toBe(1);
      expect(spendOneEvent(registry, id), id).toBe(true); // re-use
    }
  });

  it('AC4b — the no-regeneration gate is catalogue data, scoped to the three budget kinds', () => {
    // Pickup-only budget kinds: regenerating ceiling 0 (Q-A1=b).
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      const { store } = poolFixture();
      store.collect(id); // field pickup only — never owned
      expect(store.isConsumableOwned(id), id).toBe(false);
      expect(store.consumableRegenCeiling(id), id).toBe(0);
    }
    // Phase Shift / Teleport keep their shipped pickup regeneration.
    for (const id of ['phase_shift', 'teleport'] as PowerUpId[]) {
      const { store } = poolFixture();
      store.collect(id);
      expect(store.consumableRegenCeiling(id), id).toBeGreaterThan(0);
    }
    // A permanent grant (ownership) raises the budget ceiling back to the
    // level-derived cap.
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      const { store } = poolFixture();
      store.collect(id, true);
      expect(store.isConsumableOwned(id), id).toBe(true);
      expect(store.consumableRegenCeiling(id), id).toBe(
        store.consumableChargeCap(id),
      );
    }
  });

  it('AC4b — Phase Shift and Teleport field pickups keep their shipped regeneration (regression)', () => {
    // The Q-A1=b no-regeneration gate is scoped to the three budget kinds: a
    // Phase Shift / Teleport **field pickup** still grants a charge that
    // spends once and then refills on the shared tick — the shipped
    // regeneration (AH-0MV82I7TX0009JMT) is unchanged by the absorbed-hit
    // conversion.
    for (const id of ['phase_shift', 'teleport'] as PowerUpId[]) {
      const { registry, store } = poolFixture();
      registry.applyCollect(id); // field pickup — never owned
      expect(store.isConsumableOwned(id), id).toBe(false);
      expect(registry.consumableCharges(id), id).toBe(1);

      // One pickup charge resolves exactly one event through the shipped seam
      // and starts its own regeneration timer (no ownership gate here).
      const spent =
        id === 'phase_shift'
          ? registry.updateDanger(true, 0.016) === 'phase_shift'
          : registry.consumeTeleport();
      expect(spent, id).toBe(true);
      expect(registry.consumableCharges(id), id).toBe(0);
      expect(registry.consumableRechargeRemaining(id), id).toBeCloseTo(
        store.consumableRechargeTime(id),
        6,
      );

      // No charge returns without a tick; the shared tick completes the timer
      // and the pool refills for reuse — pickup regeneration is intact.
      registry.tick(store.consumableRechargeTime(id) / 2);
      expect(registry.consumableCharges(id), id).toBe(0);
      registry.tick(store.consumableRechargeTime(id) / 2 + 0.01);
      expect(registry.consumableCharges(id), id).toBe(1);

      if (id === 'phase_shift') {
        registry.updateDanger(false, PHASE_REARM_COOLDOWN + 0.01);
        expect(registry.updateDanger(true, 0.016)).toBe('phase_shift');
      } else {
        expect(registry.consumeTeleport()).toBe(true);
      }
      expect(registry.consumableCharges(id), id).toBe(0);
    }
  });

  it('AC6 — temporary-level TTL expiry never reduces already-granted charges (no clawback)', () => {
    for (const id of ['shield', 'thorns', 'force_field'] as PowerUpId[]) {
      const { registry, store } = poolFixture();
      registry.applyCollect(id);
      const granted = registry.consumableCharges(id);
      expect(granted).toBe(1);

      // Let the per-upgrade level window fully expire.
      const ttl = registry.powerUpTemporaryRemaining(id)!;
      registry.tick(ttl + 0.1);

      expect(store.getTempStacks(id), id).toBe(0);
      expect(store.getEffectiveLevel(id), id).toBe(0);
      // The granted charge is untouched by the level revert.
      expect(registry.consumableCharges(id), id).toBe(granted);
      expect(spendOneEvent(registry, id), id).toBe(true);
    }
  });

  it('AC6 — a permanent grant replays into the same charged state (checkpoint resume seam)', () => {
    const first = poolFixture();
    const replayed = poolFixture();
    for (const { registry } of [first, replayed]) {
      // The checkpoint resumes by replaying permanent grants through
      // `grantPermanentPowerUp` → `applyCollect(id, true)`; the pickup charge
      // is never persisted (AC6).
      registry.applyCollect('shield');
      registry.applyCollect('shield', true);
    }
    expect(first.registry.consumableCharges('shield')).toBe(
      replayed.registry.consumableCharges('shield'),
    );
    expect(replayed.registry.isConsumableOwned('shield')).toBe(true);
  });
});

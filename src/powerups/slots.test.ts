/**
 * Six-slot loadout — shared accounting and drop eligibility
 * (parent "Limit the number of powerup slots" AH-0MVLIJT3M005HPHF).
 *
 * ## The rule under test
 *
 * A kind occupies one of the six slots while it is held **permanently**
 * (hold-full / mini-boss reward) **or** **temporarily** (an active field
 * pickup); the slot frees when the field-pickup window expires. Exempt
 * catalogue entries (`availableWhenSlotsFull`) and the slot-exempt `reset`
 * utility never occupy a slot. Producer decisions 2026-10-27: Q4(a), Q7(a);
 * see the parent work item.
 *
 * The helper is pure and derived: no new counter, no Phaser import, no
 * `Math.random()`/wall-clock read. Occupancy comes from the four existing
 * snapshots (`getLevels()`, `getTempPowerUpIds()`, `getWeaponLevels()`,
 * `getTempWeaponIds()`), which is why the power-up cases below are exercised
 * through the real `PowerUpLevelStore` and the weapon cases through the
 * explicit snapshot parameters (the live-`Player` variant lives in
 * `slots.weaponLevels.test.ts`).
 *
 * @module powerups/slots.test
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_SLOT_CAP } from '../core/constants';
import { POWER_UP_CATALOGUE, type DropId, type PowerUpId } from './types';
import { PowerUpLevelStore } from './powerUpLevels';
import { CHOICE_POOL } from './choice';
import {
  eligibleForSlotPool,
  filterOptionsWithinSlotPool,
  isWithinSlotPool,
  resolveSlotState,
  type PowerUpSlotState,
} from './slots';
import type { WeaponId } from '../utils/weapons';

type PowerUpLevels = Array<{ id: PowerUpId; level: number }>;
type WeaponLevels = Array<{ id: WeaponId; level: number }>;

/** Builds a permanent power-up snapshot at level 1 (one grant each). */
const ownedPowerUps = (...ids: PowerUpId[]): PowerUpLevels =>
  ids.map((id) => ({ id, level: 1 }));

/** Builds a permanent weapon snapshot at level 1 (one grant each). */
const ownedWeapons = (...ids: WeaponId[]): WeaponLevels =>
  ids.map((id) => ({ id, level: 1 }));

/** Every catalogue power-up id, in catalogue order. */
const CATALOGUE_IDS = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

/** A full state built from six permanent kinds (four power-ups, two weapons). */
function sixFilledSlots(): PowerUpSlotState {
  return resolveSlotState(
    ownedPowerUps('shield', 'bomb', 'speed_boost', 'phase_shift'),
    ownedWeapons('spread', 'dual'),
  );
}

// ── AC1 — one named cap ─────────────────────────────────────────────

describe('the six-slot cap (AC1)', () => {
  it('is a state derived only from the four run-scoped snapshots', () => {
    const state = sixFilledSlots();

    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect([...state.heldIds].sort()).toEqual(
      ['shield', 'bomb', 'speed_boost', 'phase_shift', 'spread', 'dual'].sort(),
    );
  });
});

// ── AC1 — shared accounting ─────────────────────────────────────────

describe('resolveSlotState (AC1 — one shared pool of six held kinds)', () => {
  it('fills the pool with six distinct permanent power-up grants', () => {
    const owned = ownedPowerUps(
      'shield',
      'bomb',
      'speed_boost',
      'phase_shift',
      'teleport',
      'magnet',
    );

    const state = resolveSlotState(owned, []);

    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect([...state.ownedIds].sort()).toEqual(owned.map((entry) => entry.id).sort());
    expect([...state.heldIds].sort()).toEqual(owned.map((entry) => entry.id).sort());
  });

  it('shares the six slots between power-up and weapon kinds', () => {
    const state = resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'speed_boost'),
      ownedWeapons('spread', 'dual', 'rapid'),
    );

    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect([...state.ownedIds].sort()).toEqual(
      ['shield', 'bomb', 'speed_boost', 'spread', 'dual', 'rapid'].sort(),
    );
  });

  it('levels a repeat grant of an owned kind up without consuming a second slot', () => {
    const store = new PowerUpLevelStore();

    store.collect('shield', true); // hold-full reward: opens the slot
    store.collect('shield', true); // hold-full reward: levels it up

    const state = resolveSlotState(store.getLevels(), []);

    // The store still reports one permanent kind, at level 2.
    expect(store.getLevels()).toEqual([{ id: 'shield', level: 2 }]);
    expect(state.used).toBe(1);
    expect(state.free).toBe(5);
    expect(state.isFull).toBe(false);
  });

  it('counts a permanent weapon grant in the same pool', () => {
    const state = resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'speed_boost', 'phase_shift', 'teleport'),
      ownedWeapons('spread'),
    );

    expect(state.used).toBe(6);
    expect(state.isFull).toBe(true);
    expect(state.ownedIds.has('spread')).toBe(true);
  });

  // AC1 / producer Q4a — a temporary (field) pickup occupies a slot too.
  it('counts an active temporary field-pickup stack as a held kind', () => {
    const store = new PowerUpLevelStore();

    store.collect('magnet'); // field pickup only: a temporary stack

    const state = resolveSlotState(store.getLevels(), [], store.getTempPowerUpIds());

    expect(store.getTempStacks('magnet')).toBe(1);
    expect(store.getLevels()).toEqual([]);
    expect(state.used).toBe(1);
    expect(state.free).toBe(5);
    expect(state.isFull).toBe(false);
    // Held but not permanently owned — the choice still treats it as a new
    // permanent kind (it owns its slot, so taking it adds no seventh kind).
    expect(state.heldIds.has('magnet')).toBe(true);
    expect(state.ownedIds.has('magnet')).toBe(false);
  });

  it('counts a temporary weapon stack in the same pool', () => {
    const state = resolveSlotState([], [], ['shield', 'bomb'], ['spread']);

    expect(state.used).toBe(3);
    expect(state.heldIds.has('spread')).toBe(true);
    expect(state.ownedIds.has('spread')).toBe(false);
  });

  it('does not double-count a kind held both permanently and temporarily', () => {
    const store = new PowerUpLevelStore();

    store.collect('magnet'); // temporary stack
    store.collect('magnet', true); // then a hold-full reward

    const state = resolveSlotState(store.getLevels(), [], store.getTempPowerUpIds());

    expect(state.used).toBe(1);
    expect(state.ownedIds.has('magnet')).toBe(true);
    expect(state.heldIds.has('magnet')).toBe(true);
  });

  it('releases the slot when the temporary window expires', () => {
    const store = new PowerUpLevelStore();
    store.collect('magnet');
    expect(resolveSlotState(store.getLevels(), [], store.getTempPowerUpIds()).used).toBe(1);

    // What the effect path does when the timed window elapses.
    store.clearTemporary('magnet');

    const state = resolveSlotState(store.getLevels(), [], store.getTempPowerUpIds());
    expect(store.getTempPowerUpIds()).toEqual([]);
    expect(state.used).toBe(0);
    expect(state.isFull).toBe(false);
  });

  it('fills the pool from a mix of permanent and temporary holdings', () => {
    const store = new PowerUpLevelStore();
    for (const id of ['shield', 'bomb', 'speed_boost', 'phase_shift'] as const) {
      store.collect(id, true);
    }
    store.collect('magnet'); // temporary fifth kind

    const state = resolveSlotState(
      store.getLevels(),
      ownedWeapons('spread'),
      store.getTempPowerUpIds(),
    );

    expect(state.used).toBe(6);
    expect(state.isFull).toBe(true);
    expect(state.heldIds.has('magnet')).toBe(true);
  });

  // Producer Q7a — the exemption flag excludes an entry from the count.
  it('never counts an available-when-full entry, permanently owned or not', () => {
    const store = new PowerUpLevelStore();
    for (const id of ['shield', 'bomb', 'speed_boost', 'phase_shift', 'teleport', 'magnet'] as const) {
      store.collect(id, true);
    }
    store.collect('extra_life', true); // exempt: available when full
    store.collect('mystery_ufo'); // exempt: temporary pickup

    const state = resolveSlotState(store.getLevels(), [], store.getTempPowerUpIds());

    // The exempt kinds are held (so they stay eligible) but never counted.
    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect(state.heldIds.has('extra_life')).toBe(true);
    expect(state.heldIds.has('mystery_ufo')).toBe(true);
  });

  it('never counts the permanent cannon or the slot-exempt reset utility', () => {
    // The cannon is a `WeaponId` but is never a drop, so it can never occupy
    // one of the six slots — even if a permanent grant ever slipped through
    // the `isTimedWeapon` guard. `reset` is a `WeaponDropId` that is not a
    // `WeaponId` at all, so it can never hold a level either.
    const cannonOnly: WeaponLevels = [{ id: 'cannon', level: 5 }];

    const state = resolveSlotState([], cannonOnly, [], []);

    expect(state.used).toBe(0);
    expect(state.isFull).toBe(false);
    expect(state.ownedIds.size).toBe(0);
    expect(state.heldIds.has('reset')).toBe(false);
  });

  it('reports zero free slots at exactly the cap (never negative)', () => {
    const state = sixFilledSlots();

    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
  });
});

// ── AC2/AC3/AC5 — eligibility ───────────────────────────────────────

describe('drop eligibility (AC3 below the cap, AC2+AC5 at the cap)', () => {
  it('keeps the whole catalogue eligible below the cap (AC3 — no behaviour change)', () => {
    const state = resolveSlotState(ownedPowerUps('shield'), []);

    expect(state.isFull).toBe(false);
    expect(eligibleForSlotPool(CHOICE_POOL, state)).toEqual([...CHOICE_POOL]);
    for (const id of CATALOGUE_IDS) {
      expect(isWithinSlotPool(id, state)).toBe(true);
    }
  });

  it('offers only held kinds plus flagged entries at the cap (AC2/AC5)', () => {
    const owned: PowerUpId[] = ['shield', 'bomb', 'frenzy', 'thorns', 'salvage', 'strike'];

    const state = resolveSlotState(ownedPowerUps(...owned), []);

    expect(state.isFull).toBe(true);
    expect(eligibleForSlotPool(CHOICE_POOL, state).sort()).toEqual(
      [...owned, 'extra_life', 'mystery_ufo'].sort(),
    );
  });

  it('keeps a kind held only temporarily eligible at the cap (Q4a)', () => {
    const state = resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'frenzy', 'thorns', 'salvage'),
      [],
      ['strike'], // temporary sixth kind
    );

    expect(state.isFull).toBe(true);
    expect(isWithinSlotPool('strike', state)).toBe(true);
    expect(isWithinSlotPool('teleport', state)).toBe(false);
  });

  it('never offers a non-held weapon at the cap (AC2)', () => {
    const state = sixFilledSlots();

    expect(isWithinSlotPool('wave_laser', state)).toBe(false);
    expect(eligibleForSlotPool(CHOICE_POOL, state)).not.toContain('wave_laser');
  });

  it('keeps an owned weapon eligible at the cap (AC2 — one shared pool)', () => {
    const state = sixFilledSlots();

    expect(isWithinSlotPool('spread', state)).toBe(true);
    expect(eligibleForSlotPool(CHOICE_POOL, state)).toContain('spread');
  });

  it('never gates the slot-exempt reset utility at the cap', () => {
    const state = sixFilledSlots();

    // `reset` cannot hold a level, so the cap never suppresses it.
    expect(isWithinSlotPool('reset', state)).toBe(true);
  });

  it('never returns an empty eligible set (weapon-only build at the cap)', () => {
    // A weapon-heavy build can consume the whole pool before any power-up
    // reward (documented design consequence). The draw must still degrade to
    // the held weapons plus the flagged entries — never to nothing.
    const weapons = ownedWeapons('spread', 'dual', 'rapid', 'wave_laser', 'ricochet', 'cluster');

    const state = resolveSlotState([], weapons);
    const eligible = eligibleForSlotPool(CHOICE_POOL, state);

    expect(state.isFull).toBe(true);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible).toContain('spread');
    expect(eligible).toContain('extra_life');
    expect(eligible).toContain('mystery_ufo');
    expect(eligible).not.toContain('shield');
  });

  it('reads the exemption from the catalogue flag, not an id special case (AC5)', () => {
    const state = sixFilledSlots();

    // The two `availableWhenSlotsFull` entries stay available even when the
    // player holds neither; that decision comes from catalogue data only.
    expect(isWithinSlotPool('extra_life', state)).toBe(true);
    expect(isWithinSlotPool('mystery_ufo', state)).toBe(true);
    expect(isWithinSlotPool('teleport', state)).toBe(false);
    expect(isWithinSlotPool('smart_bomb', state)).toBe(false);
  });

  it('never mutates its inputs and is a pure function of them', () => {
    const powerUps = ownedPowerUps('shield', 'bomb');
    const weapons = ownedWeapons('spread');
    const tempPowerUps: PowerUpId[] = ['magnet'];
    const tempWeapons: WeaponId[] = ['dual'];
    const before = JSON.stringify({ powerUps, weapons, tempPowerUps, tempWeapons });

    const first = resolveSlotState(powerUps, weapons, tempPowerUps, tempWeapons);
    const second = resolveSlotState(powerUps, weapons, tempPowerUps, tempWeapons);

    expect(JSON.stringify({ powerUps, weapons, tempPowerUps, tempWeapons })).toBe(before);
    expect(first.used).toBe(second.used);
    expect([...first.heldIds].sort()).toEqual([...second.heldIds].sort());
    expect(eligibleForSlotPool(CHOICE_POOL, first)).toEqual(
      eligibleForSlotPool(CHOICE_POOL, second),
    );
  });
});

// ── AC4 — offer surfaces outside buildChoiceCandidates ───────────────
describe('filterOptionsWithinSlotPool — every offer path obeys the cap (AC4)', () => {
  /** A minimal offer shape: the drop id is all the gate reads. */
  const offers = (...ids: DropId[]): Array<{ id: DropId; label: string }> =>
    ids.map((id) => ({ id, label: id }));

  const idsOf = (list: ReadonlyArray<{ id: DropId }>): DropId[] =>
    list.map((entry) => entry.id);

  it('drops offers for kinds outside a full pool and keeps held, exempt and slot-exempt kinds', () => {
    // Six filled slots: shield, bomb, speed_boost, phase_shift, spread, dual.
    const state = sixFilledSlots();

    const filtered = filterOptionsWithinSlotPool(
      offers('railgun', 'spread', 'extra_life', 'reset', 'mystery_ufo', 'teleport'),
      state,
    );

    // The mini-boss unlock of a brand-new weapon kind (railgun) and a new
    // power-up kind (teleport) are the seventh-slot paths this gate closes
    // (parent AH-0MVLIJT3M005HPHF AC4).
    expect(idsOf(filtered)).toEqual([
      'spread',
      'extra_life',
      'reset',
      'mystery_ufo',
    ]);
  });

  it('keeps an offer for a kind held only temporarily at the cap', () => {
    // Five permanent kinds plus an active field pickup of `railgun` fill the
    // pool, so making that kind permanent adds no new kind.
    const state = resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'speed_boost', 'phase_shift', 'magnet'),
      [],
      [],
      ['railgun'],
    );
    expect(state.isFull).toBe(true);

    expect(idsOf(filterOptionsWithinSlotPool(offers('railgun', 'broadside'), state))).toEqual([
      'railgun',
    ]);
  });

  it('keeps every offer below the cap (below-cap behaviour unchanged, AC3)', () => {
    const state = resolveSlotState(ownedPowerUps('shield'), ownedWeapons('spread'));
    expect(state.isFull).toBe(false);

    const all = offers(...CHOICE_POOL);
    expect(filterOptionsWithinSlotPool(all, state)).toEqual(all);
  });

  it('never mutates the offer list it filters and returns an empty list for empty input', () => {
    const state = sixFilledSlots();
    const input = offers('railgun', 'spread');
    const snapshot = JSON.stringify(input);

    const filtered = filterOptionsWithinSlotPool(input, state);

    expect(JSON.stringify(input)).toBe(snapshot);
    expect(filtered).not.toBe(input);
    expect(filterOptionsWithinSlotPool([], state)).toEqual([]);
  });
});

// ── AC4 — mixed-loadout invariant (AH-0MVVJRFDV007OI49) ─────────────
//
// The HUD agreement tests replay committed loadouts
// (`src/test/sixSlotLoadoutFixtures.ts`), including a temporary Strike and an
// exempt entry. These cases pin the model half of that contract without
// Phaser: whatever the mix, a reachable loadout can never report more than
// `POWER_UP_SLOT_CAP` counted kinds, and `free` is always the clamped
// remainder the HUD slot budget will display.

describe('mixed-loadout invariant (AC4)', () => {
  it('counts a mixed permanent + temporary loadout with exempt entries at exactly six', () => {
    const state = resolveSlotState(
      // Two counted power-ups plus the two exempt catalogue entries.
      ownedPowerUps('magnet', 'mineral_scoop', 'mystery_ufo', 'extra_life'),
      // Two counted permanent weapons.
      ownedWeapons('mortar', 'spread'),
      // An active temporary Strike holds a slot while its window is open (Q4a).
      ['strike'],
      // A temporary weapon stack holds one too (Q4a).
      ['rear_guard'],
    );

    expect(state.used).toBe(POWER_UP_SLOT_CAP);
    expect(state.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    expect(state.free).toBe(POWER_UP_SLOT_CAP - state.used);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);

    // Exempt entries are held yet never counted (Q7a): Extra Life has no HUD
    // row at all, so occupancy must not depend on being displayed.
    expect(state.heldIds.has('mystery_ufo')).toBe(true);
    expect(state.heldIds.has('extra_life')).toBe(true);
    // The temporary kinds do count while their windows are open.
    expect(state.heldIds.has('strike')).toBe(true);
    expect(state.heldIds.has('rear_guard')).toBe(true);
  });

  it('reports free = cap - used below the cap (the budget the HUD displays)', () => {
    const state = resolveSlotState(
      ownedPowerUps('magnet', 'mystery_ufo'),
      ownedWeapons('spread'),
      ['speed_boost'],
      ['rapid'],
    );

    expect(state.used).toBe(4);
    expect(state.free).toBe(POWER_UP_SLOT_CAP - state.used);
    expect(state.isFull).toBe(false);
  });

  it('clamps free at zero when a snapshot reports more counted kinds than the cap', () => {
    // A snapshot no acquisition surface can produce (the gates only admit a
    // sixth kind into an empty slot), pinned so the remainder can never go
    // negative and the HUD budget can never render a negative free count.
    const state = resolveSlotState(
      ownedPowerUps(
        'shield',
        'bomb',
        'speed_boost',
        'phase_shift',
        'magnet',
      ),
      ownedWeapons('spread', 'dual'),
    );

    expect(state.used).toBe(POWER_UP_SLOT_CAP + 1);
    expect(state.free).toBe(0);
    expect(state.free).toBeGreaterThanOrEqual(0);
  });
});

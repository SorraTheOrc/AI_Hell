/**
 * Six-slot permanent loadout — shared accounting and drop eligibility
 * (test-first slice AH-0MVNT2SD300874CP, parent "Limit the number of powerup
 * slots" AH-0MVLIJT3M005HPHF).
 *
 * ## Test-first status (read before editing)
 *
 * The shared helper (`src/powerups/slots.ts`) and the cap constant
 * (`POWER_UP_SLOT_CAP` in `src/core/constants.ts`) are added by the follow-on
 * item AH-0MVNT2TEK001BNQ4. This slice pins their **contract before they
 * exist**, so every behavioural assertion below is registered with Vitest's
 * `it(...)` — the repo's documented test-first convention (see
 * `src/powerups/powerUpIdNaming.test.ts`) — which keeps the suite green for
 * the developer test gate and the dev-push full-suite gate while the
 * assertions are genuinely red against the absent module.
 *
 * When AH-0MVNT2TEK001BNQ4 lands, flip each `.fails` to a plain `it(...)`.
 * Activation is the only permitted edit: the assertions themselves must not
 * change (that is what makes this a contract rather than a wish list).
 *
 * The helper is loaded through a *non-literal* dynamic import on purpose: a
 * static `import './slots'` would fail collection of this whole file (red
 * suite) instead of producing an expected test failure.
 *
 * ## The contract this slice pins
 *
 * - `src/core/constants.ts` exports `POWER_UP_SLOT_CAP = 6`.
 * - `src/powerups/slots.ts` exports:
 *   - `resolveSlotState(powerUpLevels, weaponLevels)` → `{ used, free,
 *     isFull, ownedIds }`, where the inputs are the permanent-only snapshots
 *     `PowerUpLevelStore.getLevels()` and `Player.getWeaponLevels()` return;
 *   - `isWithinSlotPool(dropId, state)` → may this drop be drawn/offered?
 *   - `eligibleForSlotPool(dropIds, state)` → the same list, filtered.
 *
 * The helper is pure and derived: no new counter, no Phaser import, no
 * `Math.random()`/wall-clock read. Only the two existing permanent-grant
 * stores decide occupancy, which is why every accounting case below is
 * exercised through the real `PowerUpLevelStore` (the weapon half needs a
 * live `Player`, so it lives in `slots.weaponLevels.test.ts`).
 *
 * @module powerups/slots.test
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_CATALOGUE, type DropId, type PowerUpId } from './types';
import { PowerUpLevelStore } from './powerUpLevels';
import { CHOICE_POOL } from './choice';
import type { WeaponId } from '../utils/weapons';

// ── Pinned contract (implemented by AH-0MVNT2TEK001BNQ4) ────────────

/**
 * A permanent-only snapshot, as returned by the two ownership stores.
 *
 * The weapon snapshot is `WeaponId`-keyed because that is exactly what
 * `Player.getWeaponLevels()` returns — it includes the never-permanent
 * `cannon`, which the accounting must ignore (see the cannon/reset case).
 */
type PowerUpLevels = Array<{ id: PowerUpId; level: number }>;
type WeaponLevels = Array<{ id: WeaponId; level: number }>;

/** Slot occupancy plus the owned-kind view the eligibility predicates need. */
interface PowerUpSlotState {
  readonly used: number;
  readonly free: number;
  readonly isFull: boolean;
  readonly ownedIds: ReadonlySet<DropId>;
}

/** The shared helper module's surface, pinned by this slice. */
interface SlotsModule {
  resolveSlotState(powerUpLevels: PowerUpLevels, weaponLevels: WeaponLevels): PowerUpSlotState;
  isWithinSlotPool(dropId: DropId, state: PowerUpSlotState): boolean;
  eligibleForSlotPool(dropIds: readonly DropId[], state: PowerUpSlotState): DropId[];
}

/**
 * Module specifiers are `string`-typed so TypeScript does not try to resolve
 * modules that this test-first slice deliberately lands before. The cast on
 * the result restores the pinned surface.
 */
const SLOTS_MODULE: string = './slots';
const CONSTANTS_MODULE: string = '../core/constants';

async function loadSlots(): Promise<SlotsModule> {
  return (await import(/* @vite-ignore */ SLOTS_MODULE)) as SlotsModule;
}

async function loadCap(): Promise<number> {
  const constants = (await import(/* @vite-ignore */ CONSTANTS_MODULE)) as {
    POWER_UP_SLOT_CAP?: number;
  };
  const cap = constants.POWER_UP_SLOT_CAP;
  if (typeof cap !== 'number') {
    throw new Error('src/core/constants.ts must export POWER_UP_SLOT_CAP');
  }
  return cap;
}

/** Builds a permanent power-up snapshot at level 1 (one grant each). */
const ownedPowerUps = (...ids: PowerUpId[]): PowerUpLevels =>
  ids.map((id) => ({ id, level: 1 }));

/** Builds a permanent weapon snapshot at level 1 (one grant each). */
const ownedWeapons = (...ids: WeaponId[]): WeaponLevels =>
  ids.map((id) => ({ id, level: 1 }));

/** Every catalogue power-up id, in catalogue order. */
const CATALOGUE_IDS = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

// ── AC1 — one named cap ─────────────────────────────────────────────

describe('POWER_UP_SLOT_CAP (AC1 — a single named cap governs permanent ownership)', () => {
  // Test-first: expected failure until `slots.ts` + the constant land.
  it('exports the cap as 6 from src/core/constants.ts', async () => {
    expect(await loadCap()).toBe(6);
  });
});

// ── AC1 — shared accounting ─────────────────────────────────────────

describe('resolveSlotState (AC1 — one shared pool of six permanent kinds)', () => {
  it('fills the pool with six distinct permanent power-up grants', async () => {
    const slots = await loadSlots();
    const owned = ownedPowerUps(
      'shield',
      'bomb',
      'speed_boost',
      'phase_shift',
      'teleport',
      'magnet',
    );

    const state = slots.resolveSlotState(owned, []);

    expect(state.used).toBe(await loadCap());
    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect([...state.ownedIds].sort()).toEqual(owned.map((entry) => entry.id).sort());
  });

  it('shares the six slots between power-up and weapon kinds', async () => {
    const slots = await loadSlots();

    const state = slots.resolveSlotState(
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

  it('levels a repeat grant of an owned kind up without consuming a second slot', async () => {
    const slots = await loadSlots();
    const store = new PowerUpLevelStore();

    store.collect('shield', true); // hold-full reward: opens the slot
    store.collect('shield', true); // hold-full reward: levels it up

    const state = slots.resolveSlotState(store.getLevels(), []);

    // The store still reports one permanent kind, at level 2.
    expect(store.getLevels()).toEqual([{ id: 'shield', level: 2 }]);
    expect(state.used).toBe(1);
    expect(state.free).toBe(5);
    expect(state.isFull).toBe(false);
  });

  it('counts a permanent weapon grant in the same pool', async () => {
    const slots = await loadSlots();

    const state = slots.resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'speed_boost', 'phase_shift', 'teleport'),
      ownedWeapons('spread'),
    );

    expect(state.used).toBe(6);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
    expect(state.ownedIds.has('spread')).toBe(true);
  });

  it('ignores temporary field-pickup stacks', async () => {
    const slots = await loadSlots();
    const store = new PowerUpLevelStore();

    store.collect('magnet'); // field pickup only: a temporary stack

    const state = slots.resolveSlotState(store.getLevels(), []);

    expect(store.getTempStacks('magnet')).toBe(1);
    expect(store.getLevels()).toEqual([]);
    expect(state.used).toBe(0);
    expect(state.free).toBe(6);
    expect(state.isFull).toBe(false);
  });

  it('never counts the permanent cannon or the reset utility', async () => {
    const slots = await loadSlots();
    // The cannon is a `WeaponId` but is never a drop, so it can never occupy
    // one of the six slots — even if a permanent grant ever slipped through
    // the `isTimedWeapon` guard. `reset` is a `WeaponDropId` that is not a
    // `WeaponId` at all, so it cannot even appear in a weapon-level snapshot.
    const cannonOnly: WeaponLevels = [{ id: 'cannon', level: 5 }];

    const state = slots.resolveSlotState([], cannonOnly);

    expect(state.used).toBe(0);
    expect(state.isFull).toBe(false);
    expect(state.ownedIds.size).toBe(0);
    expect(state.ownedIds.has('reset')).toBe(false);
  });

  it('reports zero free slots when an exempt grant overflows the pool', async () => {
    const slots = await loadSlots();
    // Extra Life is available when full, so a player can keep taking it after
    // the six slots are occupied. Occupancy is the count of owned kinds, but
    // `free` must never go negative.
    const overflowing = ownedPowerUps(
      'shield',
      'bomb',
      'speed_boost',
      'phase_shift',
      'teleport',
      'magnet',
      'extra_life',
    );

    const state = slots.resolveSlotState(overflowing, []);

    expect(state.used).toBe(7);
    expect(state.free).toBe(0);
    expect(state.isFull).toBe(true);
  });
});

// ── AC2/AC3/AC5 — eligibility ───────────────────────────────────────

describe('drop eligibility (AC3 below the cap, AC2+AC5 at the cap)', () => {
  it('keeps the whole catalogue eligible below the cap (AC3 — no behaviour change)', async () => {
    const slots = await loadSlots();

    const state = slots.resolveSlotState(ownedPowerUps('shield'), []);

    expect(state.isFull).toBe(false);
    expect(slots.eligibleForSlotPool(CHOICE_POOL, state)).toEqual([...CHOICE_POOL]);
    for (const id of CATALOGUE_IDS) {
      expect(slots.isWithinSlotPool(id, state)).toBe(true);
    }
  });

  it('offers only owned kinds plus flagged entries at the cap (AC2/AC5)', async () => {
    const slots = await loadSlots();
    const owned: PowerUpId[] = ['shield', 'bomb', 'frenzy', 'thorns', 'salvage', 'strike'];

    const state = slots.resolveSlotState(ownedPowerUps(...owned), []);

    expect(state.isFull).toBe(true);
    expect(slots.eligibleForSlotPool(CHOICE_POOL, state).sort()).toEqual(
      [...owned, 'extra_life', 'mystery_ufo'].sort(),
    );
  });

  it('never offers a non-owned weapon at the cap (AC2)', async () => {
    const slots = await loadSlots();
    const state = slots.resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'frenzy', 'thorns', 'salvage', 'strike'),
      [],
    );

    expect(slots.isWithinSlotPool('spread', state)).toBe(false);
    expect(slots.isWithinSlotPool('wave_laser', state)).toBe(false);
    expect(slots.eligibleForSlotPool(CHOICE_POOL, state)).not.toContain('spread');
  });

  it('keeps an owned weapon eligible at the cap (AC2 — one shared pool)', async () => {
    const slots = await loadSlots();
    const state = slots.resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'frenzy', 'thorns', 'salvage'),
      ownedWeapons('spread'),
    );

    expect(state.used).toBe(6);
    expect(state.isFull).toBe(true);
    expect(slots.isWithinSlotPool('spread', state)).toBe(true);
    expect(slots.eligibleForSlotPool(CHOICE_POOL, state)).toContain('spread');
  });

  it('never returns an empty eligible set (weapon-only build at the cap)', async () => {
    const slots = await loadSlots();
    // A weapon-heavy build can consume the whole pool before any power-up
    // reward (documented design consequence). The draw must still degrade to
    // the owned weapons plus the flagged entries — never to nothing.
    const weapons = ownedWeapons('spread', 'dual', 'rapid', 'wave_laser', 'ricochet', 'cluster');

    const state = slots.resolveSlotState([], weapons);
    const eligible = slots.eligibleForSlotPool(CHOICE_POOL, state);

    expect(state.isFull).toBe(true);
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible).toContain('spread');
    expect(eligible).toContain('extra_life');
    expect(eligible).toContain('mystery_ufo');
    expect(eligible).not.toContain('shield');
  });

  it('reads the exemption from the catalogue flag, not an id special case (AC5)', async () => {
    const slots = await loadSlots();
    const state = slots.resolveSlotState(
      ownedPowerUps('shield', 'bomb', 'frenzy', 'thorns', 'salvage', 'strike'),
      [],
    );

    // The two `availableWhenSlotsFull` entries stay available even though the
    // player owns neither; that decision comes from catalogue data only.
    expect(slots.isWithinSlotPool('extra_life', state)).toBe(true);
    expect(slots.isWithinSlotPool('mystery_ufo', state)).toBe(true);
    expect(slots.isWithinSlotPool('speed_boost', state)).toBe(false);
    expect(slots.isWithinSlotPool('smart_bomb', state)).toBe(false);
  });

  it('never mutates its inputs and is a pure function of them', async () => {
    const slots = await loadSlots();
    const powerUps = ownedPowerUps('shield', 'bomb');
    const weapons = ownedWeapons('spread');
    const before = JSON.stringify({ powerUps, weapons });

    const first = slots.resolveSlotState(powerUps, weapons);
    const second = slots.resolveSlotState(powerUps, weapons);

    expect(JSON.stringify({ powerUps, weapons })).toBe(before);
    expect(first.used).toBe(second.used);
    expect([...first.ownedIds].sort()).toEqual([...second.ownedIds].sort());
    expect(slots.eligibleForSlotPool(CHOICE_POOL, first)).toEqual(
      slots.eligibleForSlotPool(CHOICE_POOL, second),
    );
  });
});

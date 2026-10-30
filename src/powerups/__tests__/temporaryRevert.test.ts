/**
 * Temporary-revert contract, all kinds (AH-0MVUGI3BF00423OO, F1 — red first).
 *
 * Parent AH-0MVSTKGC3003OMAC (AC8) requires the defect to be proved **red**
 * before the fix lands: a field pickup on a permanently-owned item must add a
 * temporary level component that reverts at its own per-upgrade window. Seven
 * instant kinds currently keep their temporary stack forever, so the same
 * pickup compounds into permanent power for the rest of the run.
 *
 * Every case is driven through the contract's public seams only (AC4):
 * `PowerUpLevelStore.getEffectiveLevel` / `getTempStacks` /
 * `getTempPowerUpIds`, and `EffectsRegistry.tick` /
 * `powerUpTemporaryRemaining` / `isActive`. Time is advanced with explicit
 * `tick(dt)` deltas — never a wall-clock sleep — so the suite is
 * deterministic.
 *
 * ## The window contract (parent Resolved decision 1)
 *
 * - **Timed kinds** keep their level-resolved effect duration as the
 *   temporary window (the window is opened at the upgrade level it starts
 *   at, which is effective level 2 → upgrade level 1 after a permanent grant,
 *   and effective level 1 → upgrade level 0 for a field-only pickup).
 * - **Instant kinds** gain a per-upgrade TTL from the catalogue (the parent
 *   proposes 10 s for bomb / smart bomb / orbital strike / extra life and
 *   15 s for phase shift / teleport / mystery UFO).
 *
 * `KIND_WINDOWS` is a `Record<PowerUpId, …>` so a seventeenth power-up cannot
 * be added without stating its window (AC1).
 *
 * ## Red-before/green-after
 *
 * The seven instant kinds were authored at their pre-fix state using Vitest's
 * `it.fails` (the repo's red-before/green-after convention, see
 * `src/core/levelScaling.test.ts`): the recorded red run lives on
 * AH-0MVUGI3BF00423OO, and AH-0MVUGI448000GNMJ flipped them to `it` when the
 * per-upgrade TTL windows landed. They are plain `it` cases now, so a
 * regression turns the suite red instead of silently passing an expected
 * failure.
 *
 * AH-0MVUGI4WG008HU3M (parent AC4/AC6) extends the table with the two
 * consequences that must follow the expiry: the already-granted consumable
 * resources survive it (AC1) and the six-slot occupancy is released for every
 * kind (AC4).
 *
 * @module powerups/__tests__/temporaryRevert
 */

import { describe, expect, it } from 'vitest';

import {
  EffectsRegistry,
  P9_MAGNET_DURATION,
  P10_SCOOP_DURATION,
} from '../effects';
import {
  POWER_UP_LEVEL_IDS,
  PowerUpLevelStore,
  resolvePowerUpAtLevel,
} from '../powerUpLevels';
import { SLOTS_FULL_EXEMPT_IDS, resolveSlotState } from '../slots';
import type { PowerUpId } from '../types';

/** Extra seconds past a window so the expiry tick is unambiguous. */
const PAST_WINDOW = 0.5;

/** One kind's temporary-window contract. */
interface KindWindow {
  /** Whether the kind already has a timed effect on the pre-fix tree. */
  timed: boolean;
  /** The window length (seconds), given the upgrade level it opened at. */
  seconds: (upgradeLevel: number) => number;
}

/**
 * The per-upgrade temporary window every field pickup must get.
 *
 * Timed kinds reuse their level-resolved duration; the seven instant kinds
 * declare the catalogue TTL the parent's Resolved decision 1 introduces.
 */
const KIND_WINDOWS: Record<PowerUpId, KindWindow> = {
  shield: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('shield', level).shieldDuration!,
  },
  bomb: { timed: false, seconds: () => 10 },
  speed_boost: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('speed_boost', level).speedDuration!,
  },
  phase_shift: { timed: false, seconds: () => 15 },
  teleport: { timed: false, seconds: () => 15 },
  extra_life: { timed: false, seconds: () => 10 },
  // Magnet / Mineral Scoop are hybrids: the field pickup's attraction is a
  // fixed 15 s window (the hold-full reward is the permanent stack).
  magnet: { timed: true, seconds: () => P9_MAGNET_DURATION },
  mineral_scoop: { timed: true, seconds: () => P10_SCOOP_DURATION },
  smart_bomb: { timed: false, seconds: () => 10 },
  force_field: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('force_field', level).forceFieldDuration!,
  },
  mystery_ufo: { timed: false, seconds: () => 15 },
  frenzy: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('frenzy', level).frenzyDuration!,
  },
  chrono: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('chrono', level).chronoDuration!,
  },
  thorns: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('thorns', level).thornsDuration!,
  },
  salvage: {
    timed: true,
    seconds: (level) =>
      resolvePowerUpAtLevel('salvage', level).salvageDuration!,
  },
  strike: { timed: false, seconds: () => 10 },
};

/** A tick that is unambiguously past a window opened at `windowUpgradeLevel`. */
function expiryTick(id: PowerUpId, windowUpgradeLevel: number): number {
  return KIND_WINDOWS[id].seconds(windowUpgradeLevel) + PAST_WINDOW;
}

/** Runs `body` under `it` for every kind (flipped from red once F3 landed). */
function contractTest(id: PowerUpId, name: string, body: () => void): void {
  it(`${id}: ${name}`, body);
}

// ── Case 1 — permanent grant + field pickup ─────────────────────────

function expectPermanentPlusFieldReverts(id: PowerUpId): void {
  const store = new PowerUpLevelStore();
  const reg = new EffectsRegistry(store);

  // A hold-full reward makes the item permanent; the field pickup on top of
  // it must raise the effective level by exactly one, temporarily.
  reg.applyCollect(id, true);
  const permanentLevel = store.getPermanentLevel(id);
  expect(permanentLevel).toBe(1);

  reg.applyCollect(id, false);
  expect(store.getEffectiveLevel(id)).toBe(permanentLevel + 1);
  expect(store.getTempStacks(id)).toBe(1);

  // The window was opened at effective level 2 → upgrade level 1.
  reg.tick(expiryTick(id, 1));

  expect(store.getEffectiveLevel(id)).toBe(permanentLevel);
  expect(store.getTempStacks(id)).toBe(0);
  expect(store.getPermanentLevel(id)).toBe(permanentLevel);
  // The permanent base has nothing left to count down. (No
  // `isActive` assertion here: Magnet/Mineral Scoop permanence is a store
  // stack, not a timed effect, so their permanent base is not `active`.)
  expect(reg.powerUpTemporaryRemaining(id)).toBeUndefined();
}

// ── Case 2 — field pickup only ──────────────────────────────────────

function expectFieldOnlyReverts(id: PowerUpId): void {
  const store = new PowerUpLevelStore();
  const reg = new EffectsRegistry(store);

  reg.applyCollect(id, false);
  expect(store.getEffectiveLevel(id)).toBe(1);
  expect(store.getTempStacks(id)).toBe(1);
  if (KIND_WINDOWS[id].timed) {
    expect(reg.isActive(id)).toBe(true);
  }

  // The field-only window was opened at effective level 1 → upgrade level 0.
  reg.tick(expiryTick(id, 0));

  expect(store.getEffectiveLevel(id)).toBe(0);
  expect(store.getTempStacks(id)).toBe(0);
  expect(store.getPermanentLevel(id)).toBe(0);
  // No stale temporary stack and therefore no six-slot occupancy.
  expect(store.getTempPowerUpIds()).not.toContain(id);
  expect(reg.powerUpTemporaryRemaining(id)).toBeUndefined();
  if (KIND_WINDOWS[id].timed) {
    expect(reg.isActive(id)).toBe(false);
  }
}

// ── Case 3 — permanent grant mid-window (AC3) ───────────────────────

function expectPermanentGrantMidWindowReverts(id: PowerUpId): void {
  const store = new PowerUpLevelStore();
  const reg = new EffectsRegistry(store);

  // A field pickup opens the temporary window first...
  reg.applyCollect(id, false);
  expect(store.getEffectiveLevel(id)).toBe(1);
  expect(store.getTempStacks(id)).toBe(1);

  // ...then a hold-full reward lands while that window is still open. Both
  // allowed behaviours (keep the window and let it expire, or clear the
  // temporary component immediately) must end at the permanent level with no
  // stale temporary stack.
  reg.applyCollect(id, true);
  const permanentLevel = store.getPermanentLevel(id);
  expect(permanentLevel).toBe(1);

  // AC4 — the chosen power-up strategy is explicit: the permanent grant
  // **keeps** the open window (it never cancels its expiry), so the temporary
  // level is still there and still counting down immediately after the grant.
  expect(store.getTempStacks(id)).toBe(1);
  expect(store.getEffectiveLevel(id)).toBe(permanentLevel + 1);
  expect(reg.powerUpTemporaryRemaining(id)).toBeGreaterThan(0);

  // The window was opened by the field pickup at level 1 → upgrade level 0.
  reg.tick(expiryTick(id, 0));

  expect(store.getEffectiveLevel(id)).toBe(permanentLevel);
  expect(store.getTempStacks(id)).toBe(0);
  expect(store.getTempPowerUpIds()).not.toContain(id);
  expect(reg.powerUpTemporaryRemaining(id)).toBeUndefined();
}

// ── The contract table ──────────────────────────────────────────────

// ── Consumables persist across the real window expiry
//    (AH-0MVUGI4WG008HU3M AC1, parent Resolved decision 2) ────────────
//
// Driven through the registry's real expiry path (`tick`), not a manual
// `clearTemporary`: a consumable is a resource, so reverting the level must
// leave lives / charges / stored teleports untouched, and a long run must
// never expire or auto-consume them.

describe('consumables survive the temporary-level expiry (AH-0MVUGI4WG008HU3M AC1)', () => {
  const CONSUMABLES: ReadonlyArray<{
    id: PowerUpId;
    resource: (store: PowerUpLevelStore) => number;
  }> = [
    { id: 'extra_life', resource: (store) => store.lives() },
    { id: 'phase_shift', resource: (store) => store.phaseCharges() },
    { id: 'teleport', resource: (store) => store.teleportStacks() },
  ];

  for (const { id, resource } of CONSUMABLES) {
    it(`${id}: the level reverts at its window, the granted resource stays`, () => {
      const store = new PowerUpLevelStore();
      const reg = new EffectsRegistry(store);

      reg.applyCollect(id, false);
      const granted = resource(store);
      expect(granted).toBeGreaterThan(0);
      expect(store.getEffectiveLevel(id)).toBe(1);

      reg.tick(expiryTick(id, 0));

      expect(store.getEffectiveLevel(id)).toBe(0);
      expect(store.getTempStacks(id)).toBe(0);
      expect(resource(store)).toBe(granted);

      // Ten more minutes of run time never consumes an unconsumed
      // consumable: only the level had a timer, the resource never does.
      reg.tick(600);
      expect(resource(store)).toBe(granted);
    });
  }
});

// ── Slot accounting follows the expiry (AH-0MVUGI4WG008HU3M AC4) ────
//
// The six-slot occupancy is derived from `getLevels()` + `getTempPowerUpIds()`,
// so a temporary stack must stop occupying a slot when its own window expires
// — for *every* kind, including the seven instant kinds that had no window
// before AH-0MVUGI448000GNMJ. A permanently-owned kind keeps its slot.

describe('slot accounting follows the temporary window (AH-0MVUGI4WG008HU3M AC4)', () => {
  /** The run's derived slot state straight from the shared store snapshots. */
  function slotState(store: PowerUpLevelStore) {
    return resolveSlotState(
      store.getLevels(),
      [],
      store.getTempPowerUpIds(),
    );
  }

  for (const id of POWER_UP_LEVEL_IDS) {
    it(`${id}: a field-only pickup releases its slot at expiry`, () => {
      const store = new PowerUpLevelStore();
      const reg = new EffectsRegistry(store);

      const baseline = slotState(store);
      expect(baseline.used).toBe(0);

      reg.applyCollect(id, false);

      const held = slotState(store);
      expect(store.getTempPowerUpIds()).toContain(id);
      expect(held.heldIds.has(id)).toBe(true);
      // Exempt kinds are held but never *counted* (producer Q7a), so only the
      // counted kinds must raise `used` by one.
      const counted = !SLOTS_FULL_EXEMPT_IDS.includes(id);
      expect(held.used).toBe(counted ? 1 : 0);

      // The window the field pickup opened at effective level 1 → upgrade 0.
      reg.tick(expiryTick(id, 0));

      const released = slotState(store);
      expect(store.getTempPowerUpIds()).not.toContain(id);
      expect(released.heldIds.has(id)).toBe(false);
      expect(released.used).toBe(baseline.used);
      expect(released.free).toBe(baseline.free);
    });
  }

  const PERMANENT_CONTROLS: readonly PowerUpId[] = ['shield', 'bomb'];

  for (const id of PERMANENT_CONTROLS) {
    it(`${id}: a permanently-owned kind keeps its slot after the window expires`, () => {
      const store = new PowerUpLevelStore();
      const reg = new EffectsRegistry(store);

      reg.applyCollect(id, true); // permanent grant owns the slot
      reg.applyCollect(id, false); // field pickup on top: same slot

      expect(slotState(store).used).toBe(1);

      // The field pickup opened at effective level 2 → upgrade level 1.
      reg.tick(expiryTick(id, 1));

      const settled = slotState(store);
      expect(store.getTempPowerUpIds()).not.toContain(id);
      expect(store.getPermanentLevel(id)).toBe(1);
      expect(settled.ownedIds.has(id)).toBe(true);
      expect(settled.heldIds.has(id)).toBe(true);
      expect(settled.used).toBe(1);
    });
  }
});

describe('temporary-revert contract (AH-0MVUGI3BF00423OO, F1)', () => {
  it('states a window for every POWER_UP_LEVEL_IDS kind and nothing else', () => {
    expect(Object.keys(KIND_WINDOWS).sort()).toEqual(
      [...POWER_UP_LEVEL_IDS].sort(),
    );
  });

  for (const id of POWER_UP_LEVEL_IDS) {
    contractTest(
      id,
      'permanent grant + field pickup reverts to the permanent level',
      () => expectPermanentPlusFieldReverts(id),
    );
    contractTest(id, 'a field pickup only reverts to unowned', () =>
      expectFieldOnlyReverts(id),
    );
    contractTest(
      id,
      'a permanent grant mid-window leaves no stale temporary stack',
      () => expectPermanentGrantMidWindowReverts(id),
    );
  }
});

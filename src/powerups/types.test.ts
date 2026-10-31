/**
 * Power-up catalogue slot-exemption flag (test-first slice
 * AH-0MVNT2SD300874CP, AC5 of parent AH-0MVLIJT3M005HPHF).
 *
 * ## Test-first status (read before editing)
 *
 * `PowerUpEntry.availableWhenSlotsFull` is added by the follow-on item
 * AH-0MVNT2TEK001BNQ4. The exemption assertions are therefore registered with
 * Vitest's `it(...)` (the repo's documented test-first convention — see
 * `powerUpIdNaming.test.ts`) so the suite stays green while they are red
 * against the missing flag. Flip `.fails` to a plain `it(...)` when the flag
 * lands; the assertions themselves must not change.
 *
 * The two data-default assertions (`every other entry non-exempt`, `a newly
 * added entry is non-exempt unless it opts in`) are plain `it(...)` because
 * they already hold today: an absent flag *is* the documented `false`
 * default, and they become the regression gate for later catalogue entries.
 *
 * The flag is read structurally rather than through `PowerUpEntry` so this
 * file type-checks before the field exists; `?? false` is exactly the
 * documented default.
 *
 * @module powerups/types.test
 */

import { describe, expect, it } from 'vitest';

import {
  CONSUMABLE_POWER_UP_IDS,
  POWER_UP_CATALOGUE,
  WEAPON_DROP_IDS,
  type PowerUpEntry,
  type PowerUpId,
} from './types';
import {
  DEFAULT_WEAPON_TEMPORARY_WINDOW,
  POWER_UP_LEVEL_IDS,
  resolvePowerUpAtLevel,
  resolveTemporaryWindow,
  resolveWeaponTemporaryWindow,
} from './powerUpLevels';
import { WEAPON_TIMEOUT_MS } from '../core/constants';
import {
  CHOICE_DESCRIPTION_MAX_LINES,
  wrapChoiceDescription,
} from '../scenes/core/choiceDescriptionWrap';

/** The dropped ids allowed to spawn / be offered while all six slots are full. */
const EXEMPT_IDS: readonly PowerUpId[] = ['extra_life', 'mystery_ufo'];

/** Every catalogue id, in catalogue order. */
const CATALOGUE_IDS = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

/** Extended view of an entry once the exemption flag exists. */
type ExemptibleEntry = PowerUpEntry & { availableWhenSlotsFull?: boolean };

/**
 * Extended view of an entry once the consumable flag exists.
 *
 * Read structurally (`=== true`) like the exemption helper above so this file
 * type-checks against the catalogue before the flag is declared, and so a
 * stray non-boolean value cannot silently make an entry a consumable.
 */
type ConsumableEntry = PowerUpEntry & { consumable?: boolean };

function isConsumable(entry: PowerUpEntry): boolean {
  return (entry as ConsumableEntry).consumable === true;
}

/**
 * Reads the exemption flag with its documented default (`false`).
 *
 * `=== true` rather than truthiness so a stray non-boolean value cannot
 * silently exempt an entry.
 */
function isExemptWhenFull(entry: PowerUpEntry): boolean {
  return (entry as ExemptibleEntry).availableWhenSlotsFull === true;
}

describe('POWER_UP_CATALOGUE.availableWhenSlotsFull (AC5 — data-driven exemption)', () => {
  // Test-first: expected failure until the catalogue flag lands.
  it('marks Extra Life and Mystery UFO as available when the slots are full', () => {
    expect(isExemptWhenFull(POWER_UP_CATALOGUE.extra_life)).toBe(true);
    expect(isExemptWhenFull(POWER_UP_CATALOGUE.mystery_ufo)).toBe(true);
  });

  it('leaves every other catalogue entry non-exempt', () => {
    const others = CATALOGUE_IDS.filter((id) => !EXEMPT_IDS.includes(id));

    // Guard the guard: the catalogue must have grown beyond the two
    // exemptions, otherwise the loop below would assert nothing.
    expect(others.length).toBe(CATALOGUE_IDS.length - EXEMPT_IDS.length);
    expect(others.length).toBeGreaterThan(0);

    for (const id of others) {
      expect(isExemptWhenFull(POWER_UP_CATALOGUE[id])).toBe(false);
    }
  });

  it('defaults a newly added catalogue entry to non-exempt unless it opts in', () => {
    // A hypothetical future entry: the id is not in the union until it ships,
    // which is exactly the point — the default must not depend on the id.
    const added: PowerUpEntry = {
      id: 'hypothetical_new_power_up' as PowerUpId,
      name: 'Hypothetical',
      description: 'Stands in for any future catalogue entry.',
    };

    expect(isExemptWhenFull(added)).toBe(false);

    // Opting in is a pure data change on the entry, with no code edit.
    const optedIn: ExemptibleEntry = { ...added, availableWhenSlotsFull: true };
    expect(isExemptWhenFull(optedIn)).toBe(true);
  });
});

// ── Consumable catalogue flag (AH-0MVUXFDFN009QK84, F1) ────────────

/**
 * The agreed consumable set — the five spendable-budget kinds plus Mystery
 * UFO (parent AH-0MVTQMREN009DSFW, producer decision 1) — **in catalogue
 * order**.
 *
 * This is the *expected data* for the assertions below; the implementation
 * derives `CONSUMABLE_POWER_UP_IDS` from the catalogue flags, so the tests
 * prove that data and derivation agree instead of restating a hand-maintained
 * list in production code.
 */
const EXPECTED_CONSUMABLES: readonly PowerUpId[] = [
  'shield',
  'phase_shift',
  'teleport',
  'force_field',
  'mystery_ufo',
  'thorns',
];

describe('POWER_UP_CATALOGUE.consumable (AH-0MVUXFDFN009QK84 AC1/AC2)', () => {
  it('marks exactly the six agreed kinds as consumables', () => {
    // Guard the guard: a table of six is what "exactly the six" means.
    expect(EXPECTED_CONSUMABLES).toHaveLength(6);

    for (const id of CATALOGUE_IDS) {
      expect(isConsumable(POWER_UP_CATALOGUE[id]), id).toBe(
        EXPECTED_CONSUMABLES.includes(id),
      );
    }
  });

  it('derives CONSUMABLE_POWER_UP_IDS from the catalogue, in catalogue order', () => {
    // The derived export is the only place the set is spelled out, so it must
    // equal the catalogue's own filtered order — never a second list.
    const derivedFromFlags = CATALOGUE_IDS.filter((id) =>
      isConsumable(POWER_UP_CATALOGUE[id]),
    );
    expect(CONSUMABLE_POWER_UP_IDS).toEqual(derivedFromFlags);
    expect(CONSUMABLE_POWER_UP_IDS).toEqual(EXPECTED_CONSUMABLES);
  });

  it('fails if the catalogue flags and the derived list ever disagree', () => {
    // Membership must be the flag's exact meaning, entry by entry: an entry
    // that gains or loses `consumable: true` shows up immediately.
    for (const id of CATALOGUE_IDS) {
      expect(CONSUMABLE_POWER_UP_IDS.includes(id), id).toBe(
        isConsumable(POWER_UP_CATALOGUE[id]),
      );
    }
  });

  it('keeps every weapon drop out of the consumable set', () => {
    for (const id of WEAPON_DROP_IDS) {
      expect(
        (CONSUMABLE_POWER_UP_IDS as readonly string[]).includes(id),
        id,
      ).toBe(false);
    }
  });
});

describe('consumable catalogue copy states the charge model (AC5)', () => {
  it('describes one charge per event, level-derived regeneration and a charge-granting hold-full reward', () => {
    for (const id of CONSUMABLE_POWER_UP_IDS) {
      const description = POWER_UP_CATALOGUE[id].description;
      // One charge buys one event…
      expect(description, id).toMatch(/charge/i);
      // …charges come back on a level-derived interval…
      expect(description, id).toMatch(/level-derived/i);
      expect(description, id).toMatch(/regenerat|recharge/i);
      // …and a hold-full reward adds a charge, not a level.
      expect(description, id).toMatch(/hold-full/i);
      expect(description, id).toMatch(/not a level|rather than a level/i);
    }
  });

  it('keeps every catalogue description inside the two-line hold-full area', () => {
    // The hold-full overlay and the gym help render the catalogue copy in a
    // two-line box; copy that overflows is silently ellipsised, so the charge
    // wording above must not push any entry past the budget.
    for (const id of CATALOGUE_IDS) {
      const wrapped = wrapChoiceDescription(
        POWER_UP_CATALOGUE[id].description,
      );
      expect(wrapped.truncated, id).toBe(false);
      expect(wrapped.lines.length, id).toBeLessThanOrEqual(
        CHOICE_DESCRIPTION_MAX_LINES,
      );
    }
  });
});

// ── Per-upgrade temporary-window TTL (AH-0MVUGI3Q4009MW6A, F2) ──────

/**
 * The producer-approved TTLs (seconds) for the seven instant kinds — the
 * field-pickup window each entry must declare in the catalogue.
 *
 * These are the *expected data*, not a resolver input: the resolver is
 * proved data-driven below by mutating a catalogue entry.
 */
const INSTANT_WINDOWS: ReadonlyMap<PowerUpId, number> = new Map([
  ['bomb', 10],
  ['smart_bomb', 10],
  ['strike', 10],
  ['phase_shift', 15],
  ['teleport', 15],
  ['extra_life', 10],
  ['mystery_ufo', 15],
]);

/** Time-cost-free level-scaled sample levels for the timed kinds. */
const SAMPLE_LEVELS = [0, 1, 7] as const;

describe('per-upgrade temporary window (AH-0MVUGI3Q4009MW6A, F2)', () => {
  it('declares the approved TTL on each of the seven instant catalogue entries', () => {
    // Guard the guard: the table must cover exactly seven kinds.
    expect(INSTANT_WINDOWS.size).toBe(7);

    for (const [id, seconds] of INSTANT_WINDOWS) {
      expect(POWER_UP_CATALOGUE[id].temporaryWindow).toBe(seconds);
    }
  });

  it('leaves the timed kinds to their level-resolved effect duration', () => {
    const timedIds = POWER_UP_LEVEL_IDS.filter((id) => !INSTANT_WINDOWS.has(id));
    // 16 kinds total, 7 instant → 9 timed.
    expect(timedIds).toHaveLength(9);

    for (const id of timedIds) {
      expect(POWER_UP_CATALOGUE[id].temporaryWindow).toBeUndefined();
    }
  });

  it('resolves the catalogue TTL for every instant kind', () => {
    for (const [id, seconds] of INSTANT_WINDOWS) {
      // The instant window is level-independent: the level argument must not
      // change it.
      expect(resolveTemporaryWindow(id, 0)).toBe(seconds);
      expect(resolveTemporaryWindow(id, 9)).toBe(seconds);
    }
  });

  it('keeps a level-scaled timed kind level-scaled through the resolver', () => {
    // Shield: 15 s base, saturating at a 30 s cap.
    expect(resolveTemporaryWindow('shield', 0)).toBe(15);
    expect(resolveTemporaryWindow('shield', 10)).toBe(
      resolvePowerUpAtLevel('shield', 10).shieldDuration,
    );
    expect(resolveTemporaryWindow('shield', 10)).toBeGreaterThan(15);
    expect(resolveTemporaryWindow('shield', 10)).toBeLessThanOrEqual(30);
    // Speed Boost (10 s base) and the non-levelled Magnet/Mineral Scoop
    // windows resolve from the same catalogue-backed seam.
    expect(resolveTemporaryWindow('speed_boost', 0)).toBe(10);
    expect(resolveTemporaryWindow('magnet', 0)).toBe(15);
    expect(resolveTemporaryWindow('mineral_scoop', 0)).toBe(15);
  });

  it('returns a finite positive window for every POWER_UP_LEVEL_IDS entry', () => {
    for (const id of POWER_UP_LEVEL_IDS) {
      for (const level of SAMPLE_LEVELS) {
        const ttl = resolveTemporaryWindow(id, level);
        expect(Number.isFinite(ttl)).toBe(true);
        expect(ttl).toBeGreaterThan(0);
      }
    }
  });

  it('is data-driven: a catalogue TTL change changes the resolved window', () => {
    const entry = POWER_UP_CATALOGUE.bomb;
    const original = entry.temporaryWindow;
    try {
      // Test-time override of the data only — no code change.
      entry.temporaryWindow = 42;
      expect(resolveTemporaryWindow('bomb', 0)).toBe(42);
    } finally {
      entry.temporaryWindow = original;
    }
    expect(resolveTemporaryWindow('bomb', 0)).toBe(10);
  });

  it('fails loudly when a kind declares no TTL at all', () => {
    const entry = POWER_UP_CATALOGUE.bomb;
    const original = entry.temporaryWindow;
    try {
      delete entry.temporaryWindow;
      expect(() => resolveTemporaryWindow('bomb', 0)).toThrow(/no temporary ttl/i);
    } finally {
      entry.temporaryWindow = original;
    }
  });

  it('surfaces the default weapon TTL through the same resolver shape', () => {
    expect(DEFAULT_WEAPON_TEMPORARY_WINDOW).toBe(WEAPON_TIMEOUT_MS / 1000);
    expect(resolveWeaponTemporaryWindow()).toBe(DEFAULT_WEAPON_TEMPORARY_WINDOW);
    // A future weapon definition can declare its own window…
    expect(resolveWeaponTemporaryWindow({ temporaryWindow: 4 })).toBe(4);
    // …but an invalid declaration fails loudly rather than shortening to 0.
    expect(() => resolveWeaponTemporaryWindow({ temporaryWindow: 0 })).toThrow();
  });
});

/**
 * Power-up catalogue slot-exemption flag (test-first slice
 * AH-0MVNT2SD300874CP, AC5 of parent AH-0MVLIJT3M005HPHF).
 *
 * ## Test-first status (read before editing)
 *
 * `PowerUpEntry.availableWhenSlotsFull` is added by the follow-on item
 * AH-0MVNT2TEK001BNQ4. The exemption assertions are therefore registered with
 * Vitest's `it.fails(...)` (the repo's documented test-first convention — see
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

import { POWER_UP_CATALOGUE, type PowerUpEntry, type PowerUpId } from './types';

/** The dropped ids allowed to spawn / be offered while all six slots are full. */
const EXEMPT_IDS: readonly PowerUpId[] = ['extra_life', 'mystery_ufo'];

/** Every catalogue id, in catalogue order. */
const CATALOGUE_IDS = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

/** Extended view of an entry once the exemption flag exists. */
type ExemptibleEntry = PowerUpEntry & { availableWhenSlotsFull?: boolean };

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
  it.fails('marks Extra Life and Mystery UFO as available when the slots are full', () => {
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

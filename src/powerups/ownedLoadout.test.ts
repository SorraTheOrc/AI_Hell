/**
 * Owned permanent loadout builder tests (AH-0MVCRKAPL000L68Y).
 *
 * The hold-full overlay's top-left `YOUR UPGRADES` panel is derived from the
 * permanent weapon/power-up snapshots through one pure builder, so these tests
 * pin the four rules the panel must never break: permanent-only input, no
 * `cannon`/`reset` row, deterministic catalogue ordering, and `Lv.N` labels
 * (including `Lv.1`).
 */

import { describe, expect, it } from 'vitest';

import { buildOwnedLoadout } from './ownedLoadout';
import type { WeaponId } from '../utils/weapons';

describe('buildOwnedLoadout', () => {
  it('lists weapons first then power-ups, in catalogue order, with Lv.N labels', () => {
    // Deliberately unsorted input: the panel's order must come from the
    // catalogue, not from collection order.
    const rows = buildOwnedLoadout(
      [
        { id: 'shield', level: 3 },
        { id: 'magnet', level: 1 },
      ],
      [
        { id: 'rapid', level: 1 },
        { id: 'spread', level: 2 },
      ],
    );

    expect(rows.map((row) => row.label)).toEqual([
      'Spread Shot Lv.2',
      'Rapid Fire Lv.1',
      'Shield Lv.3',
      'Magnet Lv.1',
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      'weapon',
      'weapon',
      'powerup',
      'powerup',
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      'spread',
      'rapid',
      'shield',
      'magnet',
    ]);
  });

  it('always shows the level, including Lv.1 (producer Q2 = A)', () => {
    const [row] = buildOwnedLoadout([], [{ id: 'spread', level: 1 }]);
    expect(row.name).toBe('Spread Shot');
    expect(row.level).toBe(1);
    expect(row.label).toBe('Spread Shot Lv.1');
  });

  it('excludes the permanent cannon and the reset utility', () => {
    const rows = buildOwnedLoadout(
      [],
      [
        { id: 'cannon', level: 5 },
        { id: 'reset' as unknown as WeaponId, level: 1 },
        { id: 'dual', level: 1 },
      ],
    );

    // Only the real permanent weapon drop survives — the cannon is not a
    // drop and reset removes weapons instead of granting one.
    expect(rows.map((row) => row.id)).toEqual(['dual']);
  });

  it('ignores non-positive or non-finite levels', () => {
    const rows = buildOwnedLoadout(
      [
        { id: 'shield', level: 0 },
        { id: 'bomb', level: Number.NaN },
        { id: 'frenzy', level: 2 },
      ],
      [{ id: 'spear' as never, level: 1 }],
    );
    expect(rows.map((row) => row.id)).toEqual(['frenzy']);
  });

  it('returns no rows when nothing is owned permanently', () => {
    expect(buildOwnedLoadout([], [])).toEqual([]);
    expect(buildOwnedLoadout()).toEqual([]);
  });

  it('never invents a row for an id outside the permanent snapshots', () => {
    const rows = buildOwnedLoadout([{ id: 'shield', level: 2 }], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Shield Lv.2');
    // Every label comes from the shared choice catalogue naming.
    expect(rows[0].name).toBe('Shield');
  });
});

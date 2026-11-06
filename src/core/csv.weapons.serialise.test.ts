/**
 * Weapon-catalogue CSV round-trip
 * (test-first child AH-0MW0Q1CG5003YFLT; implementation child AH-0MW0Q1DCZ006AUGP).
 *
 * `serializeWeaponCatalogue` is the write half of the codec: the dev tuning
 * panel (child 7) and the seed generator (child 3) both produce a committed
 * CSV with it, so the property that matters is **round-trip identity** — a
 * catalogue written by the game must parse back to exactly the same
 * catalogue, nested descriptors and pattern rows included.
 *
 * The strongest form of that property is asserted first: the frozen parity
 * fixture (all 16 shipped weapons, every data-representable field) is
 * serialised and re-parsed. If any column is dropped, misnamed, loses
 * precision or mis-rounds an angle, that single test fails.
 *
 * Registered with `describe.skipIf(!weaponCodecReady)` until the codec lands
 * (see `src/test/weaponCsvCodecContract.ts`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCsvRows } from './csv';
import { weaponCodec, weaponCodecReady } from '../test/weaponCsvCodecContract';
import type { WeaponCodec } from '../test/weaponCsvCodecContract';
import type { WeaponDefinition, WeaponId } from '../utils/weapons';

/** The frozen pre-migration catalogue snapshot (see `weaponCatalogueParity.test.ts`). */
const FROZEN: Record<WeaponId, WeaponDefinition> = JSON.parse(
  readFileSync(resolve(__dirname, '../data/weapon-catalogue-parity.json'), 'utf8'),
) as Record<WeaponId, WeaponDefinition>;

/** The subset of the frozen fixture used for the readable-cell assertions. */
const FIXTURE_SUBSET: Partial<Record<WeaponId, WeaponDefinition>> = {
  cannon: FROZEN.cannon,
  rapid: FROZEN.rapid,
  spread: FROZEN.spread,
  dual: FROZEN.dual,
};

/** Serialises, then re-parses with the same codec. */
function roundTrip(codec: WeaponCodec, catalogue: Partial<Record<WeaponId, WeaponDefinition>>) {
  const { weaponsCsv, patternsCsv } = codec.serializeWeaponCatalogue(catalogue);
  return { weaponsCsv, patternsCsv, ...codec.parseWeaponCatalogue(weaponsCsv, patternsCsv) };
}

describe.skipIf(!weaponCodecReady)('serializeWeaponCatalogue', () => {
  it('round-trips the frozen parity fixture with no loss', () => {
    const codec = weaponCodec();
    const { catalogue, errors } = roundTrip(codec, FROZEN);

    expect(errors).toStrictEqual([]);
    expect(catalogue).toStrictEqual(FROZEN);
  });

  it('round-trips the pattern rows, including side offsets and fan angles', () => {
    const codec = weaponCodec();
    const { catalogue, errors } = roundTrip(codec, FIXTURE_SUBSET);

    expect(errors).toStrictEqual([]);
    expect(catalogue.spread?.offsets).toStrictEqual(FROZEN.spread.offsets);
    expect(catalogue.dual?.offsets).toStrictEqual(FROZEN.dual.offsets);
    expect(catalogue.dual?.sideOffsets).toStrictEqual(FROZEN.dual.sideOffsets);
  });

  it('writes the documented header comment block', () => {
    const codec = weaponCodec();
    const { weaponsCsv, patternsCsv } = codec.serializeWeaponCatalogue(FIXTURE_SUBSET);

    // Designers edit these files by hand: the comment block is the schema doc.
    expect(weaponsCsv.startsWith('#')).toBe(true);
    expect(weaponsCsv).toMatch(/0xRRGGBB/i);
    expect(weaponsCsv).toMatch(/subdivision/i);
    expect(weaponsCsv).toMatch(/blank/i);
    expect(patternsCsv.startsWith('#')).toBe(true);
    expect(patternsCsv).toMatch(/degree/i);
  });

  it('writes the WEAPON_COLUMN_ORDER header row', () => {
    const codec = weaponCodec();
    const { weaponsCsv } = codec.serializeWeaponCatalogue(FIXTURE_SUBSET);
    const header = weaponsCsv
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('#'));

    expect(header).toBe([...codec.WEAPON_COLUMN_ORDER].join(','));
  });

  it('writes colours as 0xRRGGBB hex, not decimal integers', () => {
    const codec = weaponCodec();
    const { weaponsCsv } = codec.serializeWeaponCatalogue({ cannon: FROZEN.cannon });
    const [row] = parseCsvRows(weaponsCsv);

    expect(row.bulletColor).toBe('0x00ffff');
    expect(row.muzzleColor).toBe('0x00ffff');
  });

  it('leaves absent optional cells blank instead of writing 0', () => {
    const codec = weaponCodec();
    const { weaponsCsv } = codec.serializeWeaponCatalogue({ cannon: FROZEN.cannon });
    const [row] = parseCsvRows(weaponsCsv);

    // Blank means "this weapon has no such capability"; `0` would mean a zero
    // budget and change behaviour on the next parse.
    for (const column of ['bounce', 'splits', 'orbitPods', 'aoeTrigger', 'hitscanLength', 'maxHitPoints']) {
      expect(row[column] ?? '').toBe('');
    }
  });

  it('writes numbers in their shortest round-tripping form', () => {
    const codec = weaponCodec();
    const { weaponsCsv } = codec.serializeWeaponCatalogue({ cannon: FROZEN.cannon });
    const [row] = parseCsvRows(weaponsCsv);

    expect(row.subdivisions).toBe('2');
    expect(row.bulletSize).toBe('1');
    expect(row.bulletLifetime).toBe('0.75');
    expect(row.muzzleDuration).toBe('0.12');
  });

  it('derives the subdivisions cell from the fire rate', () => {
    const codec = weaponCodec();
    const { weaponsCsv } = codec.serializeWeaponCatalogue({ rapid: FROZEN.rapid });
    const [row] = parseCsvRows(weaponsCsv);

    // 250 ms on the 80 BPM grid is 3 shots per beat.
    expect(row.subdivisions).toBe('3');
  });

  it('writes one pattern row per bullet with a contiguous index', () => {
    const codec = weaponCodec();
    const { patternsCsv } = codec.serializeWeaponCatalogue({
      shard_swarm: FROZEN.shard_swarm,
      dual: FROZEN.dual,
    });
    const rows = parseCsvRows(patternsCsv);

    const shardRows = rows.filter((row) => row.weaponId === 'shard_swarm');
    expect(shardRows.map((row) => row.index)).toStrictEqual(['0', '1', '2', '3', '4']);

    const dualRows = rows.filter((row) => row.weaponId === 'dual');
    expect(dualRows.map((row) => row.sideOffsetPx)).toStrictEqual(['-8', '8']);
  });

  it('writes pattern angles in degrees with three decimals', () => {
    const codec = weaponCodec();
    const { patternsCsv } = codec.serializeWeaponCatalogue({ spread: FROZEN.spread });
    const rows = parseCsvRows(patternsCsv);

    expect(rows.map((row) => row.angleDeg)).toStrictEqual(['-30.000', '0.000', '30.000']);
  });

  it('leaves sideOffsetPx blank for weapons without perpendicular offsets', () => {
    const codec = weaponCodec();
    const { patternsCsv } = codec.serializeWeaponCatalogue({ cannon: FROZEN.cannon });
    const [row] = parseCsvRows(patternsCsv);

    expect(row.sideOffsetPx ?? '').toBe('');
  });
});

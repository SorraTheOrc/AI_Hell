/**
 * Frozen weapon-catalogue parity fixture
 * (test-first child AH-0MW0Q1CG5003YFLT, epic AH-0MW0Q01VM004EPY7).
 *
 * `src/data/weapon-catalogue-parity.json` is a **frozen snapshot** of
 * `WEAPON_CATALOGUE` taken before the catalogue moved into CSV data
 * (`src/utils/weapons.ts` at commit af1ce2e7). It is the safety net for the
 * whole migration: whatever the runtime catalogue is built from — the
 * TypeScript literal today, the parsed CSV after child 4 — it must stay
 * **deep-equal** to this snapshot, so a typo in a spreadsheet cell can never
 * silently retune the game.
 *
 * The fixture was produced once from the shipped catalogue with
 * `JSON.stringify(WEAPON_CATALOGUE, null, 2)` (loaded through
 * `vite.ssrLoadModule`, so no hand-copying), which is why colours appear as
 * decimal Phaser integers rather than `0xRRGGBB`; the CSV they are authored in
 * uses the hex form (see `src/core/csv.weapons.serialise.test.ts`).
 *
 * ## Coverage — and the one deliberate exclusion
 *
 * {@link DATA_FIELDS} is typed as `Record<keyof Omit<WeaponDefinition,
 * 'levelBulletSize'>, true>`, so **adding a data-representable field to
 * `WeaponDefinition` breaks the build here** until the fixture, the CSV
 * schema and this list are updated together. The excluded field is:
 *
 * - `levelBulletSize` — never authored in data. It is injected by
 *   `resolveWeaponDefinition` from `src/utils/weaponLevels.ts` when a weapon
 *   is resolved at a level, so it is absent from the base catalogue and from
 *   the fixture. Every other `WeaponDefinition` field is data-representable
 *   and must appear in the snapshot.
 *
 * ## What is asserted before the CSV exists
 *
 * The first four tests run against today's tree: they pin the fixture to the
 * shipped catalogue (so the snapshot cannot be regenerated in a way that
 * silently accepts a retune), assert its field coverage, and prove that every
 * frozen `fireRateMs` is the beat subdivision of the weapon's nominal
 * `subdivisions`. The CSV parity assertion activates once the codec
 * (AH-0MW0Q1DCZ006AUGP) and the seed files (AH-0MW0Q1E59007PS6M) exist.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { beatSubdivisionMs } from '../utils/beat';
import {
  DEFAULT_WEAPON_SUBDIVISIONS,
  WEAPON_CATALOGUE,
  type WeaponDefinition,
  type WeaponId,
} from '../utils/weapons';
import { weaponCodec, weaponCodecReady } from '../test/weaponCsvCodecContract';

const DATA_DIR = resolve(__dirname);

/** The frozen pre-migration catalogue: 16 weapons, every data field. */
const FROZEN: Record<WeaponId, WeaponDefinition> = JSON.parse(
  readFileSync(resolve(DATA_DIR, 'weapon-catalogue-parity.json'), 'utf8'),
) as Record<WeaponId, WeaponDefinition>;

/**
 * Every `WeaponDefinition` field the CSV data can express.
 *
 * The type is the point: it is `keyof Omit<WeaponDefinition, 'levelBulletSize'>`,
 * so this object literal must name every remaining field or `tsc` fails.
 */
const DATA_FIELDS: Record<keyof Omit<WeaponDefinition, 'levelBulletSize'>, true> = {
  id: true,
  name: true,
  description: true,
  offsets: true,
  sideOffsets: true,
  fireRateMs: true,
  bulletColor: true,
  bulletShape: true,
  bulletShapeLength: true,
  bulletRim: true,
  bulletThickness: true,
  bulletSize: true,
  bulletLifetime: true,
  maxHitPoints: true,
  bounce: true,
  splits: true,
  orbit: true,
  aoe: true,
  hitscan: true,
  bulletTrail: true,
  bulletFlame: true,
  muzzleFlash: true,
  impactFx: true,
};

/** The fixture's weapon ids, sorted. */
const FROZEN_IDS = Object.keys(FROZEN).sort();

/** The union of every field name the fixture records, sorted. */
function fixtureFieldUnion(): string[] {
  const fields = new Set<string>();
  for (const definition of Object.values(FROZEN)) {
    for (const field of Object.keys(definition)) fields.add(field);
  }
  return [...fields].sort();
}

describe('frozen weapon-catalogue parity fixture', () => {
  it('covers all sixteen shipped weapons', () => {
    expect(FROZEN_IDS).toStrictEqual(Object.keys(WEAPON_CATALOGUE).sort());
    expect(FROZEN_IDS).toHaveLength(16);
  });

  it('stays deep-equal to the catalogue the game actually ships', () => {
    // This is the parity guarantee: whichever source builds WEAPON_CATALOGUE
    // (the TypeScript literal today, the parsed CSV after child 4), it must
    // reproduce the frozen pre-migration values exactly.
    expect(WEAPON_CATALOGUE).toStrictEqual(FROZEN);
  });

  it('records every data-representable WeaponDefinition field', () => {
    expect(fixtureFieldUnion()).toStrictEqual(Object.keys(DATA_FIELDS).sort());
  });

  it('excludes levelBulletSize, which only weapon leveling injects', () => {
    // Documented exclusion: `resolveWeaponDefinition` adds it per level, so it
    // is never authored data and never part of the frozen base values.
    expect(fixtureFieldUnion()).not.toContain('levelBulletSize');
    for (const definition of Object.values(FROZEN)) {
      expect('levelBulletSize' in definition).toBe(false);
    }
  });

  it('freezes a fireRateMs that is the beat subdivision of the nominal cadence', () => {
    // The CSV stores `subdivisions`; the runtime derives `fireRateMs` from it.
    // Pinning the derivation here means a designer edit to a subdivisions cell
    // is a cadence change the parity test (and the game) can see.
    for (const id of FROZEN_IDS as WeaponId[]) {
      expect(FROZEN[id].fireRateMs, id).toBe(
        beatSubdivisionMs(DEFAULT_WEAPON_SUBDIVISIONS[id]),
      );
    }
  });
});

/** The committed seed files that child 3 authors. */
const WEAPONS_CSV_PATH = resolve(DATA_DIR, 'weapons.csv');
const PATTERNS_CSV_PATH = resolve(DATA_DIR, 'weapon-patterns.csv');
const SEED_AND_CODEC_READY =
  weaponCodecReady && existsSync(WEAPONS_CSV_PATH) && existsSync(PATTERNS_CSV_PATH);

describe.skipIf(!SEED_AND_CODEC_READY)(
  'parity with the committed weapons CSV',
  () => {
    it('parses weapons.csv + weapon-patterns.csv to exactly the frozen fixture', () => {
      const { catalogue, errors } = weaponCodec().parseWeaponCatalogue(
        readFileSync(WEAPONS_CSV_PATH, 'utf8'),
        readFileSync(PATTERNS_CSV_PATH, 'utf8'),
      );

      expect(errors).toStrictEqual([]);
      expect(catalogue).toStrictEqual(FROZEN);
    });
  },
);

/**
 * Weapon-catalogue CSV codec behaviour
 * (test-first child AH-0MW0Q1CG5003YFLT; implementation child AH-0MW0Q1DCZ006AUGP).
 *
 * These tests ARE the specification of `parseWeaponCatalogue` /
 * `parseWeaponPatterns` / `coerceWeaponRow` / `validateWeaponRow` in
 * `src/core/csv.ts`. They were written before the codec existed: run against
 * the pre-implementation tree they fail with
 * {@link WEAPON_CODEC_PENDING_MESSAGE}. They are registered with
 * `describe.skipIf(!weaponCodecReady)` so the contract can be committed ahead
 * of the codec without leaving `dev` red — the suite activates automatically
 * the moment child 2 exports the entry point.
 *
 * Contract decisions (see `src/test/weaponCsvCodecContract.ts` for the full
 * rationale):
 *
 * - The codec never imports the shipped catalogue and never throws: an
 *   invalid row is omitted, its diagnostic recorded, and the caller
 *   (child 4) falls back to the code default for that id.
 * - A blank optional cell coerces to an **absent** field, never `0`, because
 *   dispatch is presence-based (`weapon.orbit ? … : …`). An explicit `0`
 *   stays `0`.
 * - Pattern angles are authored in degrees and converted with
 *   `(degrees * Math.PI) / 180`.
 * - `fireRateMs` is always derived from `subdivisions` through
 *   `beatSubdivisionMs`, never authored.
 */

import { describe, expect, it } from 'vitest';

import { beatSubdivisionMs } from '../utils/beat';
import type { WeaponDefinition, WeaponId } from '../utils/weapons';
import {
  CONTRACT_WEAPON_COLUMNS,
  weaponCodec,
  weaponCodecReady,
} from '../test/weaponCsvCodecContract';

// ── Fixtures ────────────────────────────────────────────────────────

/**
 * The known-good two-row catalogue used by most tests: a permanent
 * single-shot weapon at 2 shots/beat and a fast one at 3 shots/beat, so the
 * derived fire rates (375 ms / 250 ms) differ and are visibly derived.
 */
const TWO_ROW_WEAPONS_CSV = `id,name,description,subdivisions,bulletColor,bulletShape,bulletSize,bulletLifetime,muzzleColor,muzzleRadius,muzzleDuration
cannon,Cannon,One bullet straight ahead.,2,0x00ffff,circle,1,0.75,0x00ffff,7,0.12
rapid,Rapid,High fire rate single shots.,3,0xffff00,spark,1,0.375,0xffff00,7,0.1
`;

/** One pattern row per bullet, in the long `weaponId,index,angleDeg,sideOffsetPx` format. */
const TWO_ROW_PATTERNS_CSV = `weaponId,index,angleDeg,sideOffsetPx
cannon,0,0.000,
rapid,0,0.000,
`;

/** The typed result the two-row fixture must parse to. */
const TWO_ROW_EXPECTED: Partial<Record<WeaponId, WeaponDefinition>> = {
  cannon: {
    id: 'cannon',
    name: 'Cannon',
    description: 'One bullet straight ahead.',
    offsets: [0],
    // 2 shots per beat on the default 80 BPM grid → 750 / 2.
    fireRateMs: beatSubdivisionMs(2),
    bulletColor: 0x00ffff,
    bulletShape: 'circle',
    bulletSize: 1,
    bulletLifetime: 0.75,
    muzzleFlash: { color: 0x00ffff, radius: 7, duration: 0.12 },
  },
  rapid: {
    id: 'rapid',
    name: 'Rapid',
    description: 'High fire rate single shots.',
    offsets: [0],
    fireRateMs: beatSubdivisionMs(3),
    bulletColor: 0xffff00,
    bulletShape: 'spark',
    bulletSize: 1,
    bulletLifetime: 0.375,
    muzzleFlash: { color: 0xffff00, radius: 7, duration: 0.1 },
  },
};

/** Minimum columns a weapon row must carry. */
const BASE_ROW: Record<string, string> = {
  id: 'cannon',
  name: 'Cannon',
  description: 'One bullet straight ahead.',
  subdivisions: '2',
  bulletColor: '0x00ffff',
  bulletShape: 'circle',
  bulletSize: '1',
  bulletLifetime: '0.75',
};

/** Renders a single-weapon weapons CSV from a base row plus overrides. */
function singleWeaponCsv(overrides: Record<string, string> = {}): string {
  const row = { ...BASE_ROW, ...overrides };
  const columns = Object.keys(row);
  return `${columns.join(',')}\n${columns.map((c) => row[c]).join(',')}\n`;
}

/** Renders a pattern CSV from `[weaponId, index, angleDeg, sideOffsetPx]` tuples. */
function buildPatternsCsv(
  rows: Array<[string, number, string, string]>,
): string {
  const body = rows.map((r) => r.join(',')).join('\n');
  return `weaponId,index,angleDeg,sideOffsetPx\n${body}\n`;
}

/** Parses a weapons CSV against a matching single-row pattern file. */
function parseOne(overrides: Record<string, string> = {}) {
  const id = overrides.id ?? BASE_ROW.id;
  return weaponCodec().parseWeaponCatalogue(
    singleWeaponCsv(overrides),
    buildPatternsCsv([[id, 0, '0.000', '']]),
  );
}

// ── parseWeaponCatalogue ────────────────────────────────────────────

describe.skipIf(!weaponCodecReady)('parseWeaponCatalogue', () => {
  it('parses a known-good two-row fixture into typed definitions', () => {
    const { catalogue, errors } = weaponCodec().parseWeaponCatalogue(
      TWO_ROW_WEAPONS_CSV,
      TWO_ROW_PATTERNS_CSV,
    );

    expect(errors).toStrictEqual([]);
    expect(catalogue).toStrictEqual(TWO_ROW_EXPECTED);
  });

  it('derives fireRateMs from the beat subdivision instead of reading a column', () => {
    const { catalogue } = weaponCodec().parseWeaponCatalogue(
      TWO_ROW_WEAPONS_CSV,
      TWO_ROW_PATTERNS_CSV,
    );

    // 80 BPM → 750 ms beat; 2 shots/beat → 375 ms, 3 shots/beat → 250 ms.
    expect(catalogue.cannon?.fireRateMs).toBe(375);
    expect(catalogue.rapid?.fireRateMs).toBe(250);
    expect(catalogue.cannon?.fireRateMs).toBe(beatSubdivisionMs(2));
    expect(catalogue.rapid?.fireRateMs).toBe(beatSubdivisionMs(3));
  });

  it('ignores comment lines and blank lines in both files', () => {
    const commentedWeapons = `# Weapon catalogue — codec contract fixture
# colours are 0xRRGGBB, subdivisions are shots per beat

id,name,description,subdivisions,bulletColor,bulletShape,bulletSize,bulletLifetime,muzzleColor,muzzleRadius,muzzleDuration
cannon,Cannon,One bullet straight ahead.,2,0x00ffff,circle,1,0.75,0x00ffff,7,0.12

# rapid is the fast one
rapid,Rapid,High fire rate single shots.,3,0xffff00,spark,1,0.375,0xffff00,7,0.1
`;
    const commentedPatterns = `# one row per pattern bullet, angles in degrees
weaponId,index,angleDeg,sideOffsetPx

cannon,0,0.000,
rapid,0,0.000,
`;

    const { catalogue, errors } = weaponCodec().parseWeaponCatalogue(
      commentedWeapons,
      commentedPatterns,
    );

    expect(errors).toStrictEqual([]);
    expect(catalogue).toStrictEqual(TWO_ROW_EXPECTED);
  });

  it('parses colours from 0xRRGGBB in either case', () => {
    const { catalogue } = parseOne({
      bulletColor: '0x00FFFF',
      bulletShape: 'disc',
      muzzleColor: '0xAbCdEf',
    });

    expect(catalogue.cannon?.bulletColor).toBe(0x00ffff);
    expect(catalogue.cannon?.muzzleFlash?.color).toBe(0xabcdef);
  });

  it('rejects a non-hex colour with a diagnostic naming the weapon and column', () => {
    const { catalogue, errors } = parseOne({ bulletColor: 'cyan' });

    expect(catalogue.cannon).toBeUndefined();
    expect(errors.join('\n')).toMatch(/cannon/);
    expect(errors.join('\n')).toContain('bulletColor');
    expect(errors.join('\n')).toContain('cyan');
  });

  it('leaves absent optional columns absent rather than zero', () => {
    const { catalogue } = parseOne();

    const cannon = catalogue.cannon;
    expect(cannon).toBeDefined();
    // Presence-based dispatch (`weapon.orbit ? … : …`, `bounce ?? …`) must not
    // see a zero standing in for "this weapon has no such capability".
    expect('bounce' in (cannon as WeaponDefinition)).toBe(false);
    expect('splits' in (cannon as WeaponDefinition)).toBe(false);
    expect('orbit' in (cannon as WeaponDefinition)).toBe(false);
    expect('aoe' in (cannon as WeaponDefinition)).toBe(false);
    expect('maxHitPoints' in (cannon as WeaponDefinition)).toBe(false);
    expect('sideOffsets' in (cannon as WeaponDefinition)).toBe(false);
  });

  it('keeps an explicit zero optional value present', () => {
    const { catalogue } = parseOne({ bounce: '0' });

    const cannon = catalogue.cannon as WeaponDefinition;
    expect('bounce' in cannon).toBe(true);
    expect(cannon.bounce).toBe(0);
  });

  it('rejects an invalid bulletShape with a diagnostic naming the column and value', () => {
    const { catalogue, errors } = parseOne({ bulletShape: 'triangle' });

    expect(catalogue.cannon).toBeUndefined();
    expect(errors.join('\n')).toContain('bulletShape');
    expect(errors.join('\n')).toContain('triangle');
  });

  it('rejects an invalid aoeTrigger with a diagnostic naming the column and value', () => {
    const { catalogue, errors } = parseOne({
      aoeTrigger: 'onExplode',
      aoeRadius: '34',
      aoeDamagesEnemies: 'true',
      aoeClearsEnemyBullets: 'true',
    });

    expect(catalogue.cannon).toBeUndefined();
    expect(errors.join('\n')).toContain('aoeTrigger');
    expect(errors.join('\n')).toContain('onExplode');
  });

  it('rejects a malformed number with a diagnostic naming the weapon and column', () => {
    const { catalogue, errors } = parseOne({ bulletSize: 'wide' });

    expect(catalogue.cannon).toBeUndefined();
    expect(errors.join('\n')).toContain('cannon');
    expect(errors.join('\n')).toContain('bulletSize');
  });

  it('rejects a negative bulletSize and a non-positive bulletLifetime', () => {
    const negativeSize = parseOne({ bulletSize: '-1' });
    const zeroLifetime = parseOne({ bulletLifetime: '0' });

    expect(negativeSize.catalogue.cannon).toBeUndefined();
    expect(negativeSize.errors.join('\n')).toContain('bulletSize');
    expect(zeroLifetime.catalogue.cannon).toBeUndefined();
    expect(zeroLifetime.errors.join('\n')).toContain('bulletLifetime');
  });

  it('rejects a row missing a required column', () => {
    const csv = `id,name,description,subdivisions,bulletColor,bulletShape,bulletLifetime
cannon,Cannon,No bullet size here.,2,0x00ffff,circle,0.75
`;
    const { catalogue, errors } = weaponCodec().parseWeaponCatalogue(
      csv,
      buildPatternsCsv([['cannon', 0, '0.000', '']]),
    );

    expect(catalogue.cannon).toBeUndefined();
    expect(errors.join('\n')).toContain('bulletSize');
  });

  it('rejects a row missing any of the eight required columns', () => {
    const required = [
      'id',
      'name',
      'description',
      'subdivisions',
      'bulletColor',
      'bulletShape',
      'bulletSize',
      'bulletLifetime',
    ];

    for (const column of required) {
      const row = { ...BASE_ROW };
      delete row[column];
      const columns = Object.keys(row);
      const csv = `${columns.join(',')}\n${columns.map((c) => row[c]).join(',')}\n`;
      const { catalogue, errors } = weaponCodec().parseWeaponCatalogue(
        csv,
        buildPatternsCsv([['cannon', 0, '0.000', '']]),
      );

      expect(errors.join('\n'), column).toContain(column);
      expect(catalogue.cannon, column).toBeUndefined();
    }
  });

  it('rejects duplicate id rows, keeping the first definition and reporting the duplicate', () => {
    const csv = `id,name,description,subdivisions,bulletColor,bulletShape,bulletSize,bulletLifetime
cannon,Cannon,First wins.,2,0x00ffff,circle,1,0.75
cannon,Cannon duplicate,Loses.,2,0xff0000,diamond,1,0.75
`;
    const { catalogue, errors } = weaponCodec().parseWeaponCatalogue(
      csv,
      buildPatternsCsv([['cannon', 0, '0.000', '']]),
    );

    expect(catalogue.cannon?.name).toBe('Cannon');
    expect(catalogue.cannon?.bulletColor).toBe(0x00ffff);
    expect(errors.join('\n')).toMatch(/duplicate/i);
    expect(errors.join('\n')).toContain('cannon');
  });

  it('reports an incomplete descriptor group instead of shipping half a descriptor', () => {
    const incompleteAoe = parseOne({ aoeTrigger: 'onFire' });
    const incompleteMuzzle = parseOne({ muzzleRadius: '', muzzleDuration: '' });

    // `aoeRadius` is required once `aoeTrigger` opts the weapon into the AOE
    // family; a half-built descriptor would dispatch into the AOE seam with an
    // undefined radius. The same holds for the muzzle-flash and impact-FX
    // specs, whose radius and duration have no meaningful default.
    expect(incompleteAoe.catalogue.cannon).toBeUndefined();
    expect(incompleteAoe.errors.join('\n')).toContain('aoeRadius');
    expect(incompleteMuzzle.catalogue.cannon).toBeUndefined();
    expect(incompleteMuzzle.errors.join('\n')).toContain('muzzleRadius');
  });

  it('builds the orbit descriptor from its flat orbitPods/orbitRadius columns', () => {
    const { catalogue, errors } = parseOne({ orbitPods: '2', orbitRadius: '28' });

    expect(errors).toStrictEqual([]);
    expect(catalogue.cannon?.orbit).toStrictEqual({ pods: 2, radius: 28 });
  });

  it('builds the AOE descriptor from its flat aoe* columns', () => {
    const { catalogue, errors } = parseOne({
      aoeTrigger: 'onFire',
      aoeRadius: '27',
      aoeDamagesEnemies: 'true',
      aoeClearsEnemyBullets: '1',
      aoeProjectileSpeed: '180',
      aoeChains: '2',
      aoeDamage: '3',
    });

    expect(errors).toStrictEqual([]);
    expect(catalogue.cannon?.aoe).toStrictEqual({
      trigger: 'onFire',
      radius: 27,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      projectileSpeed: 180,
      chains: 2,
      damage: 3,
    });
  });

  it('builds the hitscan descriptor from hitscanLength/hitscanDuration', () => {
    const { catalogue, errors } = parseOne({
      hitscanLength: '960',
      hitscanDuration: '0.3',
    });

    expect(errors).toStrictEqual([]);
    expect(catalogue.cannon?.hitscan).toStrictEqual({ length: 960, duration: 0.3 });
  });

  it('builds the muzzle-flash and impact-FX specs from their flat columns', () => {
    const { catalogue, errors } = parseOne({
      impactColor: '0xff0000',
      impactRadius: '12',
      impactDuration: '0.18',
      impactCue: 'playWaveLaserImpactSound',
    });

    expect(errors).toStrictEqual([]);
    expect(catalogue.cannon?.impactFx).toStrictEqual({
      color: 0xff0000,
      radius: 12,
      duration: 0.18,
      cue: 'playWaveLaserImpactSound',
    });
    expect(catalogue.cannon?.muzzleFlash).toStrictEqual({
      color: 0x00ffff,
      radius: 7,
      duration: 0.12,
    });
  });

  it('never throws on malformed input', () => {
    const codec = weaponCodec();

    expect(() => codec.parseWeaponCatalogue('', '')).not.toThrow();
    expect(() => codec.parseWeaponCatalogue('id,,,\n,,,', 'nonsense')).not.toThrow();
    expect(codec.parseWeaponCatalogue('', '').catalogue).toStrictEqual({});
  });
});

// ── parseWeaponPatterns ─────────────────────────────────────────────

describe.skipIf(!weaponCodecReady)('parseWeaponPatterns', () => {
  it('converts authored degrees to radians, ordered by index', () => {
    const { patterns, errors } = weaponCodec().parseWeaponPatterns(
      buildPatternsCsv([
        ['spread', 2, '30.000', ''],
        ['spread', 0, '-30.000', ''],
        ['spread', 1, '0.000', ''],
      ]),
    );

    expect(errors).toStrictEqual([]);
    expect(patterns.spread?.offsets).toStrictEqual([
      (-30 * Math.PI) / 180,
      (0 * Math.PI) / 180,
      (30 * Math.PI) / 180,
    ]);
  });

  it('reads sideOffsetPx into sideOffsets and omits sideOffsets when every cell is blank', () => {
    const { patterns, errors } = weaponCodec().parseWeaponPatterns(
      buildPatternsCsv([
        ['dual', 0, '0.000', '-8'],
        ['dual', 1, '0.000', '8'],
        ['cannon', 0, '0.000', ''],
      ]),
    );

    expect(errors).toStrictEqual([]);
    expect(patterns.dual?.sideOffsets).toStrictEqual([-8, 8]);
    expect(patterns.cannon?.offsets).toStrictEqual([0]);
    expect('sideOffsets' in (patterns.cannon ?? {})).toBe(false);
  });

  it('reports a pattern row whose weaponId has no weapons row', () => {
    const { patterns, errors } = weaponCodec().parseWeaponPatterns(
      buildPatternsCsv([['ghost', 0, '0.000', '']]),
    );

    expect((patterns as Record<string, unknown>).ghost).toBeUndefined();
    expect(errors.join('\n')).toContain('ghost');
  });

  it('reports a malformed angle instead of emitting NaN radians', () => {
    const { patterns, errors } = weaponCodec().parseWeaponPatterns(
      buildPatternsCsv([['cannon', 0, 'ahead', '']]),
    );

    expect(patterns.cannon?.offsets ?? []).not.toContain(NaN);
    expect(errors.join('\n')).toContain('angleDeg');
  });
});

// ── coerceWeaponRow ─────────────────────────────────────────────────

/** A fully-populated raw row: every column the codec understands. */
const FULL_RAW_ROW: Record<string, string> = {
  id: 'wave_laser',
  name: 'Wave Laser',
  description: 'Beam.',
  subdivisions: '0.5',
  bulletColor: '0xff0000',
  bulletShape: 'line',
  bulletSize: '1.2',
  bulletLifetime: '0.3',
  bulletShapeLength: '7',
  bulletRim: '0xffffff',
  bulletThickness: '3',
  bulletTrail: '',
  bulletFlame: '',
  maxHitPoints: '',
  bounce: '',
  splits: '',
  orbitPods: '',
  orbitRadius: '',
  aoeTrigger: '',
  aoeRadius: '',
  aoeDamagesEnemies: '',
  aoeClearsEnemyBullets: '',
  aoeDamage: '',
  aoeChains: '',
  aoeProjectileSpeed: '',
  hitscanLength: '960',
  hitscanDuration: '0.3',
  muzzleColor: '0xff0000',
  muzzleRadius: '12',
  muzzleDuration: '0.15',
  impactColor: '',
  impactRadius: '',
  impactDuration: '',
  impactCue: '',
};

describe.skipIf(!weaponCodecReady)('coerceWeaponRow', () => {
  it('coerces a full row to typed scalars', () => {
    const row = weaponCodec().coerceWeaponRow(FULL_RAW_ROW);

    expect(row).toStrictEqual({
      id: 'wave_laser',
      name: 'Wave Laser',
      description: 'Beam.',
      subdivisions: 0.5,
      bulletColor: 0xff0000,
      bulletShape: 'line',
      bulletSize: 1.2,
      bulletLifetime: 0.3,
      bulletShapeLength: 7,
      bulletRim: 0xffffff,
      bulletThickness: 3,
      hitscanLength: 960,
      hitscanDuration: 0.3,
      muzzleColor: 0xff0000,
      muzzleRadius: 12,
      muzzleDuration: 0.15,
    });
  });

  it('leaves every blank optional column absent', () => {
    const row = weaponCodec().coerceWeaponRow(BASE_ROW);

    // Not `undefined`-valued keys: presence-based dispatch tests `in`/truthiness,
    // and `toStrictEqual` distinguishes an absent key from an undefined one.
    expect(row).toStrictEqual({
      id: 'cannon',
      name: 'Cannon',
      description: 'One bullet straight ahead.',
      subdivisions: 2,
      bulletColor: 0x00ffff,
      bulletShape: 'circle',
      bulletSize: 1,
      bulletLifetime: 0.75,
    });
  });

  it('keeps an explicit 0 instead of coercing it away', () => {
    const row = weaponCodec().coerceWeaponRow({ ...BASE_ROW, bounce: '0' });

    expect('bounce' in row).toBe(true);
    expect(row.bounce).toBe(0);
  });

  it('coerces the descriptor booleans from true/false/1/0', () => {
    const row = weaponCodec().coerceWeaponRow({
      ...BASE_ROW,
      aoeTrigger: 'onFire',
      aoeRadius: '34',
      aoeDamagesEnemies: '1',
      aoeClearsEnemyBullets: 'false',
    });

    expect(row.aoeTrigger).toBe('onFire');
    expect(row.aoeDamagesEnemies).toBe(true);
    expect(row.aoeClearsEnemyBullets).toBe(false);
  });
});

// ── validateWeaponRow ───────────────────────────────────────────────

describe.skipIf(!weaponCodecReady)('validateWeaponRow', () => {
  it('accepts a known-good row', () => {
    const result = weaponCodec().validateWeaponRow(FULL_RAW_ROW);

    expect(result).toStrictEqual({ ok: true, errors: [] });
  });

  it('rejects an unknown weapon id, naming the id', () => {
    const result = weaponCodec().validateWeaponRow({ ...BASE_ROW, id: 'plasma' });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('plasma');
    expect(result.errors.join('\n')).toContain('id');
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    const result = weaponCodec().validateWeaponRow({
      ...BASE_ROW,
      bulletColor: 'cyan',
      bulletShape: 'triangle',
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const joined = result.errors.join('\n');
    expect(joined).toContain('bulletColor');
    expect(joined).toContain('bulletShape');
  });
});

// ── The declared column contract ────────────────────────────────────

describe.skipIf(!weaponCodecReady)('WEAPON_COLUMN_ORDER', () => {
  it('is the stable column contract the serialiser and the Vite plugin share', () => {
    const { WEAPON_COLUMN_ORDER } = weaponCodec();

    // Order is part of the contract: the serialiser writes this header and the
    // dev write API validates against it, so a reordering is a breaking
    // spreadsheet change, not a detail.
    expect([...WEAPON_COLUMN_ORDER]).toStrictEqual([...CONTRACT_WEAPON_COLUMNS]);
    expect(new Set(WEAPON_COLUMN_ORDER).size).toBe(WEAPON_COLUMN_ORDER.length);
    expect(WEAPON_COLUMN_ORDER[0]).toBe('id');
  });
});

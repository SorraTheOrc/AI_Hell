/**
 * Elite (anomaly) data-model validation tests (AH-0MWU664T300140IL).
 *
 * Covers the data foundation of the elite variant axis:
 *
 * - AC1: the CSV gains `eliteBehaviour` / `eliteBonusHp` columns, wired
 *   through the stable column order and the codec.
 * - AC2: `EnemyConfig` carries the two optional fields (asserted through
 *   the codec round-trip).
 * - AC3: the shared validation module rejects an unknown behaviour id, an
 *   elite on an uncounted hazard archetype and an out-of-range bonus hit
 *   point — **at load**, not at spawn.
 * - AC4: a blank/absent value is neutral and reproduces today's behaviour.
 * - AC5: the bounded vocabulary lives once in `eliteVocabulary.ts`.
 *
 * The seeded-budget module (`src/waves/eliteSpawn.ts`) and its tests belong
 * to AH-0MWU665DM00669U0 (I2), so this file deliberately imports neither.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ELITE_BEHAVIOURS,
  ELITE_BONUS_HP_MAX,
  ELITE_BONUS_HP_MIN,
  UNCOUNTED_HAZARD_KEYS,
  EliteConfigError,
  assertEliteArchetype,
  isEliteBehaviour,
  isUncountedHazardKey,
  validateEliteArchetype,
} from './eliteVocabulary';
import type { EnemyConfig } from './configTypes';
import { DEFAULT_ENEMY_CONFIGS } from './configDefaults';
import {
  ENEMY_COLUMN_ORDER,
  coerceEnemyConfig,
  parseCsvRows,
  serializeEnemyConfigs,
  validateEnemyConfig,
} from './csv';
import {
  loadEnemyConfig,
  resetConfigStore,
  seedConfigStore,
} from './configStore';

// ── Fixtures ─────────────────────────────────────────────────────────

/** A complete, valid `scout` CSV row (no elite columns → neutral). */
const BASE_ROW: Record<string, string> = {
  key: 'scout',
  displayName: 'Scout',
  formationKind: 'v',
  count: '6',
  spacingX: '26',
  spacingY: '22',
  driftSpeed: '40',
  startX: '240',
  startY: '270',
  size: '16',
  color: '0x00ff00',
  bulletColor: '0xff4444',
  bulletSize: '3',
  shotPattern: 'aimed',
  fireInterval: '1200',
  bulletSpeed: '90',
  bulletLifetime: '1.4',
  burstCount: '1',
  shotProbability: '1',
  health: '1',
  movementClass: 'formation',
  attackClass: 'projectile',
  wrapAware: 'true',
};

/** Cast an intentionally-invalid value past the bounded union for a test. */
function asBehaviour(value: string): EnemyConfig['eliteBehaviour'] {
  return value as unknown as EnemyConfig['eliteBehaviour'];
}

afterEach(() => {
  resetConfigStore();
});

// ── AC5: one bounded vocabulary ──────────────────────────────────────

describe('bounded elite vocabulary lives in one place (AC5)', () => {
  it('pins exactly the three admitted behaviours and freezes the list', () => {
    expect([...ELITE_BEHAVIOURS]).toEqual([
      'splitter',
      'reinforced',
      'volatile',
    ]);
    expect(Object.isFrozen(ELITE_BEHAVIOURS)).toBe(true);
    expect(ELITE_BONUS_HP_MIN).toBe(1);
    expect(ELITE_BONUS_HP_MAX).toBe(3);
  });

  it('recognises only the bounded behaviour ids', () => {
    for (const id of ELITE_BEHAVIOURS) {
      expect(isEliteBehaviour(id)).toBe(true);
    }
    expect(isEliteBehaviour('bogus')).toBe(false);
    expect(isEliteBehaviour('')).toBe(false);
    expect(isEliteBehaviour(undefined)).toBe(false);
    expect(isEliteBehaviour(1)).toBe(false);
  });

  it('treats every uncounted hazard the AC names as ineligible', () => {
    for (const key of ['lane-traffic', 'asteroid', 'centipede'] as const) {
      expect(isUncountedHazardKey(key)).toBe(true);
    }
    for (const ghost of [
      'ghost-chase',
      'ghost-ambush',
      'ghost-flank',
      'ghost-wander',
    ]) {
      expect(isUncountedHazardKey(ghost)).toBe(true);
    }
    expect(isUncountedHazardKey('scout')).toBe(false);
    // The frozen list is the single source the helper reads.
    expect([...UNCOUNTED_HAZARD_KEYS]).toContain('asteroid');
  });
});

// ── AC3: unknown behaviour id fails loudly at load ───────────────────

describe('unknown eliteBehaviour fails loudly at load (AC3)', () => {
  it('validateEliteArchetype names the unknown id and lists the valid set', () => {
    const result = validateEliteArchetype({
      key: 'scout',
      eliteBehaviour: 'bogus-behaviour',
      eliteBonusHp: 1,
    });

    expect(result.ok).toBe(false);
    const error = result.errors.find((e) => e.field === 'eliteBehaviour');
    expect(error).toBeDefined();
    expect(error?.message).toContain('bogus-behaviour');
    expect(error?.message.toLowerCase()).toContain('unknown');
    // The message points at the one vocabulary, not a second copy.
    for (const id of ELITE_BEHAVIOURS) {
      expect(error?.message).toContain(id);
    }
  });

  it('validateEnemyConfig rejects a CSV row carrying an unknown id', () => {
    const result = validateEnemyConfig(
      { ...BASE_ROW, eliteBehaviour: 'bogus-behaviour' },
      DEFAULT_ENEMY_CONFIGS,
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('bogus-behaviour');
  });

  it('loadEnemyConfig throws for a seeded unknown id (load, not spawn)', () => {
    seedConfigStore([
      {
        ...DEFAULT_ENEMY_CONFIGS.scout,
        eliteBehaviour: asBehaviour('bogus-behaviour'),
      },
    ]);

    expect(() => loadEnemyConfig('scout')).toThrow(EliteConfigError);
    expect(() => loadEnemyConfig('scout')).toThrow(/bogus-behaviour/);
  });
});

// ── AC3: elites on uncounted hazards fail loudly at load ─────────────

describe('elite on an uncounted hazard fails loudly at load (AC3)', () => {
  it.each([...UNCOUNTED_HAZARD_KEYS])(
    'validateEliteArchetype rejects %s',
    (hazardKey) => {
      const result = validateEliteArchetype({
        key: hazardKey,
        eliteBehaviour: 'splitter',
        eliteBonusHp: 1,
      });

      expect(result.ok).toBe(false);
      const error = result.errors.find((e) => e.field === 'uncountedHazard');
      expect(error).toBeDefined();
      expect(error?.message).toContain(hazardKey);
      expect(error?.message.toLowerCase()).toContain('elite');
    },
  );

  it('allows a counted archetype to carry an elite', () => {
    expect(
      validateEliteArchetype({
        key: 'scout',
        eliteBehaviour: 'splitter',
        eliteBonusHp: 2,
      }).ok,
    ).toBe(true);
  });

  it('loadEnemyConfig throws for a seeded elite on the asteroid hazard', () => {
    seedConfigStore([
      {
        ...DEFAULT_ENEMY_CONFIGS.asteroid,
        eliteBehaviour: 'volatile',
      },
    ]);

    expect(() => loadEnemyConfig('asteroid')).toThrow(/uncounted hazard/);
  });
});

// ── AC4: blank/absent is neutral (today's behaviour) ─────────────────

describe('blank eliteBehaviour reproduces today behaviour (AC4)', () => {
  it('a legacy row without the elite columns coerces to neutral', () => {
    const config = coerceEnemyConfig({ ...BASE_ROW }, DEFAULT_ENEMY_CONFIGS);

    expect(config.eliteBehaviour).toBeUndefined();
    expect(config.eliteBonusHp).toBeUndefined();
    expect(validateEliteArchetype(config).ok).toBe(true);
  });

  it('explicit blank cells are neutral and validate cleanly', () => {
    const config = coerceEnemyConfig(
      { ...BASE_ROW, eliteBehaviour: '', eliteBonusHp: '' },
      DEFAULT_ENEMY_CONFIGS,
    );

    expect(config.eliteBehaviour).toBeUndefined();
    expect(config.eliteBonusHp).toBeUndefined();
    expect(
      validateEliteArchetype({ ...BASE_ROW, eliteBehaviour: '', eliteBonusHp: '' })
        .ok,
    ).toBe(true);
  });

  it('the shipped scout seed loads neutrally without throwing', () => {
    resetConfigStore();

    const config = loadEnemyConfig('scout');

    expect(config.eliteBehaviour).toBeUndefined();
    expect(config.eliteBonusHp).toBeUndefined();
  });

  it('serialises neutral elite columns as blank and round-trips neutrally', () => {
    const csvString = serializeEnemyConfigs([{ ...DEFAULT_ENEMY_CONFIGS.scout }]);
    const header = csvString.split('\n')[0].split(',');
    expect(header).toContain('eliteBehaviour');
    expect(header).toContain('eliteBonusHp');

    const config = coerceEnemyConfig(
      parseCsvRows(csvString)[0],
      DEFAULT_ENEMY_CONFIGS,
    );
    expect(config.eliteBehaviour).toBeUndefined();
    expect(config.eliteBonusHp).toBeUndefined();
  });
});

// ── AC1/AC3: bonus hit-point range ───────────────────────────────────

describe('eliteBonusHp is a positive integer in 1–3 (AC1/AC3)', () => {
  it.each(['1', '2', '3'])('accepts %s', (value) => {
    expect(
      validateEliteArchetype({
        key: 'scout',
        eliteBehaviour: 'splitter',
        eliteBonusHp: value,
      }).ok,
    ).toBe(true);
  });

  it.each([
    ['0', 'range'],
    ['4', 'range'],
    ['1.5', 'integer'],
    ['-1', 'positive'],
    ['many', 'integer'],
  ])('rejects %s with an actionable message', (value, hint) => {
    const result = validateEliteArchetype({
      key: 'scout',
      eliteBehaviour: 'splitter',
      eliteBonusHp: value,
    });

    expect(result.ok).toBe(false);
    const error = result.errors.find((e) => e.field === 'eliteBonusHp');
    expect(error).toBeDefined();
    expect(error?.message.toLowerCase()).toContain(hint);
    expect(error?.message).toContain(value);
  });

  it('is neutral when blank, even without a behaviour', () => {
    expect(
      validateEliteArchetype({ key: 'scout', eliteBonusHp: '' }).ok,
    ).toBe(true);
  });

  it('validateEnemyConfig rejects an out-of-range bonus', () => {
    const result = validateEnemyConfig(
      { ...BASE_ROW, eliteBehaviour: 'splitter', eliteBonusHp: '9' },
      DEFAULT_ENEMY_CONFIGS,
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('eliteBonusHp');
  });

  it('loadEnemyConfig throws for a seeded out-of-range bonus', () => {
    seedConfigStore([{ ...DEFAULT_ENEMY_CONFIGS.scout, eliteBonusHp: 9 }]);

    expect(() => loadEnemyConfig('scout')).toThrow(/eliteBonusHp/);
  });
});

// ── AC1/AC2: codec + column-order wiring ──────────────────────────────

describe('CSV codec and column-order wiring (AC1/AC2)', () => {
  it('exposes the elite columns in the stable enemy column order', () => {
    expect(ENEMY_COLUMN_ORDER).toContain('eliteBehaviour');
    expect(ENEMY_COLUMN_ORDER).toContain('eliteBonusHp');
  });

  it('preserves a valid elite through coercion and serialisation', () => {
    const config = coerceEnemyConfig(
      { ...BASE_ROW, eliteBehaviour: 'splitter', eliteBonusHp: '2' },
      DEFAULT_ENEMY_CONFIGS,
    );
    expect(config.eliteBehaviour).toBe('splitter');
    expect(config.eliteBonusHp).toBe(2);

    const roundTripped = coerceEnemyConfig(
      parseCsvRows(serializeEnemyConfigs([config]))[0],
      DEFAULT_ENEMY_CONFIGS,
    );
    expect(roundTripped.eliteBehaviour).toBe('splitter');
    expect(roundTripped.eliteBonusHp).toBe(2);
  });

  it('preserves an invalid cell verbatim so load-time validation can reject it', () => {
    const config = coerceEnemyConfig(
      { ...BASE_ROW, eliteBehaviour: 'bogus', eliteBonusHp: '7' },
      DEFAULT_ENEMY_CONFIGS,
    );

    // The codec must not silently normalise the author's mistake away.
    expect(config.eliteBehaviour).toBe('bogus');
    expect(config.eliteBonusHp).toBe(7);

    // So the single load-time validator sees exactly what was authored.
    expect(validateEliteArchetype(config).ok).toBe(false);
    expect(() => assertEliteArchetype(config)).toThrow(EliteConfigError);
  });
});

// ── AC1/AC4: the shipped CSV stays neutral and valid ─────────────────

describe('shipped enemy-config CSV is elite-neutral (AC1/AC4)', () => {
  const csvText = fs.readFileSync(
    path.resolve(process.cwd(), 'src/data/enemy-configs.csv'),
    'utf8',
  );

  it('documents both elite columns in the header comment block', () => {
    expect(csvText).toContain('eliteBehaviour');
    expect(csvText).toContain('eliteBonusHp');
  });

  it('gives every committed row blank elite cells that validate as neutral', () => {
    const rows = parseCsvRows(csvText);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.eliteBehaviour ?? '', row.key).toBe('');
      expect(row.eliteBonusHp ?? '', row.key).toBe('');

      const result = validateEliteArchetype({
        key: row.key,
        eliteBehaviour: row.eliteBehaviour,
        eliteBonusHp: row.eliteBonusHp,
      });
      expect(result.ok, `${row.key}: ${result.errors.map((e) => e.message).join('; ')}`)
        .toBe(true);
    }
  });
});

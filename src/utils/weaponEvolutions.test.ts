/**
 * Weapon evolutions: authored pairing table, pure resolver and validator
 * (epic AH-0MWL7OWPF003E4TP, child AH-0MWU7B2RO00194UF).
 *
 * This suite pins the foundation contract every downstream child reads:
 *
 * - the three pilot pairings exist **exactly as named**, and every evolved
 *   definition carries a name, icon, colour and a 16th-lattice cadence;
 * - the resolver answers `owned` before `field` before `none` for a pairing
 *   whose **both halves are active**, republishes its `baseIds` for
 *   hex-matchup classification (AC11), and a catalogue without pairing data
 *   always resolves `none` — today's behaviour (AC2);
 * - an unknown weapon id in a pairing **fails loudly** at validation time
 *   (and, through the module-load assertion, at import time);
 * - evolved cadence rungs stay on the shared 16th-note lattice and rung 0's
 *   density agrees with the nominal subdivision.
 *
 * The module-load failure test mocks `./weapons`, so the module under test is
 * imported dynamically inside that one test after `vi.resetModules()`; every
 * other test reads the already-loaded shipped module.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVOLVED_WEAPON_DEFINITIONS,
  EVOLVED_WEAPON_IDS,
  OWNED_EVOLUTION_MIN_LEVEL,
  WEAPON_EVOLUTION_TABLE,
  WEAPON_PAIRINGS,
  assertValidWeaponEvolutionTable,
  getEvolvedWeaponDefinition,
  resolveEvolvedWeaponDefinition,
  resolveEvolvedWeaponPattern,
  resolveWeaponEvolution,
  validateWeaponEvolutionTable,
  type EvolvedWeaponDefinition,
  type EvolvedWeaponId,
  type WeaponEvolutionTable,
  type WeaponPairing,
} from './weaponEvolutions';
import { WEAPON_IDS, type WeaponId } from './weapons';
import { MAX_PERMANENT_LEVEL } from '../core/hangarWar/hangarEconomy';
import {
  DAMAGE_PARITY_LEVELS,
  LATTICE_BPMS,
  checkBarDownbeatMorphs,
  checkDamageParity,
  checkLatticeConformance,
} from '../test/weaponEvolutionHarness';

/** A valid definition reused as the base for malformed-table tests. */
const CHAIN_DEFINITION = getEvolvedWeaponDefinition('chain_ricochet');

/** Builds a table with only the passed pairings, plus optional definitions. */
function tableOf(
  pairings: readonly WeaponPairing[],
  definitions: readonly EvolvedWeaponDefinition[] = EVOLVED_WEAPON_DEFINITIONS,
): WeaponEvolutionTable {
  return { pairings, definitions };
}

/** Convenience: one owned level row. */
function owned(id: WeaponId, level: number): { id: WeaponId; level: number } {
  return { id, level };
}

afterEach(() => {
  vi.doUnmock('./weapons');
  vi.resetModules();
});

describe('shipped pairing table', () => {
  it('validates cleanly with no errors', () => {
    const result = validateWeaponEvolutionTable();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('declares the three pilot pairings exactly as named', () => {
    const pairs = WEAPON_PAIRINGS.map((pairing) => ({
      baseIds: [...pairing.baseIds],
      evolvedId: pairing.evolvedId,
      name: getEvolvedWeaponDefinition(pairing.evolvedId).name,
    }));

    expect(pairs).toEqual([
      {
        baseIds: ['ricochet', 'arc'],
        evolvedId: 'chain_ricochet',
        name: 'Chain Ricochet',
      },
      {
        baseIds: ['cluster', 'mortar'],
        evolvedId: 'cluster_barrage',
        name: 'Cluster Barrage',
      },
      {
        baseIds: ['spread', 'options'],
        evolvedId: 'fan_escort',
        name: 'Fan Escort',
      },
    ]);
  });

  it('has one definition per evolved id, with name, icon and colour', () => {
    expect(EVOLVED_WEAPON_DEFINITIONS.map((d) => d.id)).toEqual([
      ...EVOLVED_WEAPON_IDS,
    ]);

    for (const definition of EVOLVED_WEAPON_DEFINITIONS) {
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(['chain', 'barrage', 'fan']).toContain(definition.icon);
      expect(definition.colour).toBeGreaterThanOrEqual(0);
      expect(definition.colour).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('keeps the authored table valid without throwing at module load', () => {
    expect(() => assertValidWeaponEvolutionTable()).not.toThrow();
  });
});

describe('resolveWeaponEvolution', () => {
  it('resolves none when nothing pairs', () => {
    const resolution = resolveWeaponEvolution({ activeWeaponIds: ['cannon'] });

    expect(resolution).toEqual({
      evolvedId: null,
      baseIds: [],
      reason: 'none',
    });
  });

  it('resolves none when only one half of a pairing is active', () => {
    expect(
      resolveWeaponEvolution({ activeWeaponIds: ['cannon', 'ricochet'] }),
    ).toEqual({ evolvedId: null, baseIds: [], reason: 'none' });
    expect(
      resolveWeaponEvolution({ activeWeaponIds: ['cannon', 'arc'] }),
    ).toEqual({ evolvedId: null, baseIds: [], reason: 'none' });
  });

  it('resolves the field tier when both halves overlap in the active set', () => {
    const resolution = resolveWeaponEvolution({
      activeWeaponIds: ['cannon', 'ricochet', 'arc'],
    });

    expect(resolution.evolvedId).toBe('chain_ricochet');
    expect([...resolution.baseIds]).toEqual(['ricochet', 'arc']);
    expect(resolution.reason).toBe('field');
  });

  it('resolves the owned tier once both halves are permanently owned at level 2', () => {
    const resolution = resolveWeaponEvolution({
      activeWeaponIds: ['cannon', 'ricochet', 'arc'],
      permanentWeaponLevels: [
        owned('ricochet', OWNED_EVOLUTION_MIN_LEVEL),
        owned('arc', OWNED_EVOLUTION_MIN_LEVEL),
      ],
    });

    expect(resolution.evolvedId).toBe('chain_ricochet');
    expect([...resolution.baseIds]).toEqual(['ricochet', 'arc']);
    expect(resolution.reason).toBe('owned');
  });

  it('keeps the owned tier live when a timed pickup window expires', () => {
    // Both halves are permanently owned at level ≥ 2, so neither can expire;
    // a temporary stack on one half only adds a timed window on top. When it
    // ends, the half stays active (permanent) and the fusion is still owned —
    // the field tier would have stopped with the window (epic AC4).
    const activeWeaponIds: WeaponId[] = ['cannon', 'ricochet', 'arc'];
    const permanentWeaponLevels = [owned('ricochet', 2), owned('arc', 2)];

    expect(
      resolveWeaponEvolution({ activeWeaponIds, permanentWeaponLevels })
        .reason,
    ).toBe('owned');
    // A field-only pair at the same levels would be `field`; the owned pair is
    // the stronger reason and must not be shadowed by it.
    expect(
      resolveWeaponEvolution({
        activeWeaponIds,
        permanentWeaponLevels: [owned('ricochet', 1), owned('arc', 1)],
      }).reason,
    ).toBe('field');
  });

  it('ends the owned tier once a Reset drops the halves from the active set (epic AC4)', () => {
    // `Player.resetWeapon()` (the Reset power-up) drops permanently granted
    // weapons from the active set while keeping their permanent levels, so a
    // fusion must never outlive the weapons it fuses.
    const resolution = resolveWeaponEvolution({
      activeWeaponIds: ['cannon'],
      permanentWeaponLevels: [
        owned('cluster', 5),
        owned('mortar', 2),
      ],
    });

    expect(resolution).toEqual({ evolvedId: null, baseIds: [], reason: 'none' });
  });

  it('ends a level-1 pair once a half leaves the active set', () => {
    const retired = resolveWeaponEvolution({
      activeWeaponIds: ['cannon', 'cluster'],
      permanentWeaponLevels: [owned('cluster', 1), owned('mortar', 1)],
    });

    expect(retired).toEqual({ evolvedId: null, baseIds: [], reason: 'none' });
  });

  it('keeps the owned tier live at MAX_PERMANENT_LEVEL (the cap hides no pairing)', () => {
    // The hangar ladder tops out at `MAX_PERMANENT_LEVEL = 5` with base 1, so
    // an owned pairing bought to the cap must still resolve — the cap can
    // never hide a pairing or drop it below the owned threshold (epic AC4).
    const atCap = resolveWeaponEvolution({
      activeWeaponIds: ['cannon', 'spread', 'options'],
      permanentWeaponLevels: [
        owned('spread', MAX_PERMANENT_LEVEL),
        owned('options', MAX_PERMANENT_LEVEL),
      ],
    });

    expect(atCap.evolvedId).toBe('fan_escort');
    expect(atCap.reason).toBe('owned');
    expect(MAX_PERMANENT_LEVEL).toBeGreaterThanOrEqual(
      OWNED_EVOLUTION_MIN_LEVEL,
    );

    // A paired cap on one half and the threshold on the other still owns.
    expect(
      resolveWeaponEvolution({
        activeWeaponIds: ['cannon', 'spread', 'options'],
        permanentWeaponLevels: [
          owned('spread', MAX_PERMANENT_LEVEL),
          owned('options', OWNED_EVOLUTION_MIN_LEVEL),
        ],
      }),
    ).toMatchObject({ evolvedId: 'fan_escort', reason: 'owned' });
  });

  it('treats a level-1 owned pair as the field tier, not the owned tier', () => {
    const activeWeaponIds: WeaponId[] = ['cannon', 'spread', 'options'];
    const permanentWeaponLevels = [owned('spread', 1), owned('options', 1)];

    expect(
      resolveWeaponEvolution({ activeWeaponIds, permanentWeaponLevels }),
    ).toEqual({
      evolvedId: 'fan_escort',
      baseIds: ['spread', 'options'],
      reason: 'field',
    });
    expect(
      resolveWeaponEvolution({
        activeWeaponIds: ['cannon'],
        permanentWeaponLevels,
      }),
    ).toEqual({ evolvedId: null, baseIds: [], reason: 'none' });
  });

  it('reports owned ahead of field when both tiers could apply', () => {
    const resolution = resolveWeaponEvolution({
      activeWeaponIds: ['cannon', 'spread', 'options'],
      permanentWeaponLevels: [owned('spread', 3), owned('options', 4)],
    });

    expect(resolution.reason).toBe('owned');
    expect(resolution.evolvedId).toBe('fan_escort');
  });

  it('resolves the first authored pairing deterministically when several are live', () => {
    const activeWeaponIds: WeaponId[] = [
      'cannon',
      'spread',
      'options',
      'ricochet',
      'arc',
    ];

    expect(resolveWeaponEvolution({ activeWeaponIds }).evolvedId).toBe(
      'chain_ricochet',
    );
    // A later owned pair still wins over an earlier field-only pair.
    expect(
      resolveWeaponEvolution({
        activeWeaponIds,
        permanentWeaponLevels: [owned('spread', 2), owned('options', 2)],
      }).evolvedId,
    ).toBe('fan_escort');
  });

  it('is pure and deterministic across repeated calls', () => {
    const input = { activeWeaponIds: ['cannon', 'ricochet', 'arc'] as const };
    const first = resolveWeaponEvolution({ activeWeaponIds: [...input.activeWeaponIds] });
    const second = resolveWeaponEvolution({ activeWeaponIds: [...input.activeWeaponIds] });

    expect(second).toEqual(first);
    // The published base ids are a copy, so a caller cannot mutate the table.
    expect(second.baseIds).not.toBe(first.baseIds);
    expect([...WEAPON_PAIRINGS[0].baseIds]).toEqual(['ricochet', 'arc']);
  });

  it('resolves none for a catalogue without pairing data', () => {
    const resolution = resolveWeaponEvolution(
      {
        activeWeaponIds: ['cannon', 'ricochet', 'arc'],
        permanentWeaponLevels: [owned('ricochet', 5), owned('arc', 5)],
      },
      [],
    );

    expect(resolution).toEqual({
      evolvedId: null,
      baseIds: [],
      reason: 'none',
    });
  });
});

describe('base-id classification (epic AC11)', () => {
  it('republishes each pairing base ids so a fusion classifies as its halves', () => {
    for (const pairing of WEAPON_PAIRINGS) {
      const resolution = resolveWeaponEvolution({
        activeWeaponIds: ['cannon', ...pairing.baseIds],
      });

      expect(resolution.evolvedId).toBe(pairing.evolvedId);
      expect([...resolution.baseIds]).toEqual([...pairing.baseIds]);
      // Base ids are catalogue weapons, and the evolved id is not one — a
      // fusion is classified by its halves, never by an unknown catalogue id.
      for (const baseId of resolution.baseIds) {
        expect(WEAPON_IDS).toContain(baseId);
      }
      expect(WEAPON_IDS).not.toContain(pairing.evolvedId);
    }
  });
});

describe('validateWeaponEvolutionTable', () => {
  it('fails loudly on an unknown weapon id in a pairing', () => {
    const result = validateWeaponEvolutionTable(
      tableOf([
        {
          baseIds: ['ricochet', 'not_a_weapon' as WeaponId],
          evolvedId: 'chain_ricochet',
        } as WeaponPairing,
      ]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain(
      "unknown weapon id 'not_a_weapon'",
    );
    expect(() =>
      assertValidWeaponEvolutionTable(
        tableOf([
          {
            baseIds: ['ricochet', 'not_a_weapon' as WeaponId],
            evolvedId: 'chain_ricochet',
          } as WeaponPairing,
        ]),
      ),
    ).toThrow(/unknown weapon id 'not_a_weapon'/);
  });

  it('fails on a pairing that resolves to an unknown evolved id', () => {
    const result = validateWeaponEvolutionTable(
      tableOf([
        {
          baseIds: ['ricochet', 'arc'],
          evolvedId: 'not_evolved' as EvolvedWeaponId,
        },
      ]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain("has no definition");
  });

  it('fails on a duplicated pairing, including a reversed pair', () => {
    const result = validateWeaponEvolutionTable(
      tableOf([
        WEAPON_PAIRINGS[0],
        {
          baseIds: ['arc', 'ricochet'],
          evolvedId: 'cluster_barrage',
        },
      ]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('is declared more than once');
  });

  it('fails on a definition with no pairing to resolve it', () => {
    const result = validateWeaponEvolutionTable(
      tableOf(
        [WEAPON_PAIRINGS[0]],
        [CHAIN_DEFINITION, getEvolvedWeaponDefinition('cluster_barrage')],
      ),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('has no pairing to resolve it');
  });

  it('accepts an empty table (catalogue without pairing data)', () => {
    const empty = tableOf([], []);
    expect(validateWeaponEvolutionTable(empty)).toEqual({
      valid: true,
      errors: [],
    });
    expect(() => assertValidWeaponEvolutionTable(empty)).not.toThrow();
  });

  it('fails on a cadence rung that leaves the 16th-note lattice', () => {
    const offLattice: EvolvedWeaponDefinition = {
      ...CHAIN_DEFINITION,
      ladder: [{ minLevel: 0, k: 1, n: 15, rotation: 0 }],
    };
    const result = validateWeaponEvolutionTable(
      tableOf([WEAPON_PAIRINGS[0]], [offLattice]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('16th-note lattice');
  });

  it('fails when rung 0 density disagrees with the nominal subdivision', () => {
    const mismatched: EvolvedWeaponDefinition = {
      ...CHAIN_DEFINITION,
      subdivisions: 1,
    };
    const result = validateWeaponEvolutionTable(
      tableOf([WEAPON_PAIRINGS[0]], [mismatched]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain(
      'does not match its nominal subdivision',
    );
  });

  it('fails when a ladder density decreases', () => {
    const decreasing: EvolvedWeaponDefinition = {
      ...CHAIN_DEFINITION,
      ladder: [
        { minLevel: 0, k: 2, n: 16, rotation: 0 },
        { minLevel: 3, k: 1, n: 16, rotation: 0 },
      ],
    };
    const result = validateWeaponEvolutionTable(
      tableOf([WEAPON_PAIRINGS[0]], [decreasing]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('density must not decrease');
  });

  it('fails when the ladder does not start at level 0 or misorders levels', () => {
    const lateStart: EvolvedWeaponDefinition = {
      ...CHAIN_DEFINITION,
      ladder: [{ minLevel: 2, k: 2, n: 16, rotation: 0 }],
    };
    const result = validateWeaponEvolutionTable(
      tableOf([WEAPON_PAIRINGS[0]], [lateStart]),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('must start at minLevel 0');
  });
});

describe('load-time failure', () => {
  it('throws at import when an authored pairing names an unknown weapon id', async () => {
    vi.resetModules();
    vi.doMock('./weapons', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./weapons')>();
      return {
        ...actual,
        WEAPON_IDS: actual.WEAPON_IDS.filter((id) => id !== 'arc'),
      };
    });

    await expect(import('./weaponEvolutions')).rejects.toThrow(
      /unknown weapon id 'arc'/,
    );
  });
});

describe('evolved cadence', () => {
  it('keeps every authored rung on the shared 16th-note lattice', () => {
    for (const definition of EVOLVED_WEAPON_DEFINITIONS) {
      expect(definition.ladder[0].minLevel).toBe(0);
      let previousDensity = 0;
      for (const rung of definition.ladder) {
        expect(rung.n % 4).toBe(0);
        expect(rung.k).toBeGreaterThan(0);
        expect(rung.k).toBeLessThanOrEqual(rung.n);
        expect(rung.rotation).toBeGreaterThanOrEqual(0);
        expect(rung.rotation).toBeLessThan(rung.n);
        const density = rung.k / rung.n;
        expect(density).toBeGreaterThanOrEqual(previousDensity);
        previousDensity = density;
      }
    }
  });

  it('gives rung 0 the definition nominal subdivision', () => {
    for (const definition of EVOLVED_WEAPON_DEFINITIONS) {
      const base = definition.ladder[0];
      expect(base.k / base.n).toBeCloseTo(definition.subdivisions / 4, 12);
    }
  });

  it('resolves the rung active at the evolution level on the 16th-note step', () => {
    expect(resolveEvolvedWeaponPattern('chain_ricochet', 0)).toEqual({
      k: 2,
      n: 16,
      rotation: 0,
      stepMs: 187.5,
    });
    expect(resolveEvolvedWeaponPattern('chain_ricochet', 3)).toEqual({
      k: 2,
      n: 16,
      rotation: 1,
      stepMs: 187.5,
    });
    expect(resolveEvolvedWeaponPattern('chain_ricochet', 6).k).toBe(3);
    expect(resolveEvolvedWeaponPattern('chain_ricochet', 99).k).toBe(4);
    // Negative/fractional levels clamp to the base rung.
    expect(resolveEvolvedWeaponPattern('cluster_barrage', -2).k).toBe(1);
    expect(resolveEvolvedWeaponPattern('cluster_barrage', 5.9).k).toBe(1);
    expect(resolveEvolvedWeaponPattern('cluster_barrage', 6).k).toBe(2);
  });

  it('scales the step with the shared tempo', () => {
    expect(resolveEvolvedWeaponPattern('fan_escort', 0, 160).stepMs).toBe(93.75);
  });

  it('throws on an unknown evolved id', () => {
    expect(() =>
      resolveEvolvedWeaponPattern('not_evolved' as EvolvedWeaponId, 0),
    ).toThrow(/Unknown evolved weapon id/);
  });

  it('exposes the shipped table used by the load-time assertion', () => {
    expect(WEAPON_EVOLUTION_TABLE.pairings).toBe(WEAPON_PAIRINGS);
    expect(WEAPON_EVOLUTION_TABLE.definitions).toBe(
      EVOLVED_WEAPON_DEFINITIONS,
    );
  });
});

// ── Cross-cutting verification harness (AH-0MWU7BAA0009X1MN) ────────

describe('cross-cutting verification harness (AH-0MWU7BAA0009X1MN)', () => {
  it('shows an evolved weapon never emits more damage instances per cadence tick than the halves it replaces', () => {
    const result = checkDamageParity();

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
    // Every shipped pairing is measured at every evolution level, so a future
    // pairing or a retuned rung cannot skip the comparison.
    expect(result.rows).toHaveLength(
      WEAPON_PAIRINGS.length * DAMAGE_PARITY_LEVELS.length,
    );
    for (const row of result.rows) {
      // The fusion never out-fires the two halves it replaces together.
      expect(row.evolvedInstancesPerBeat).toBeLessThanOrEqual(
        row.halfSumInstancesPerBeat + 1e-9,
      );
    }
  });

  it('resolves every evolved cadence to whole 16th-note onsets at every tempo', () => {
    const result = checkLatticeConformance();

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
    expect(result.rows).toHaveLength(
      EVOLVED_WEAPON_IDS.length *
        DAMAGE_PARITY_LEVELS.length *
        LATTICE_BPMS.length,
    );
  });

  it('morphs evolved patterns only on a bar downbeat', () => {
    const result = checkBarDownbeatMorphs();

    expect(result.violations).toEqual([]);
    expect(result.holds).toBe(true);
  });

  it('goes red against a rule-breaking evolved cadence (red-first gate)', () => {
    // A fusion that out-fires both halves fails the damage-parity rule...
    const denser = checkDamageParity({
      evolvedPatternFor: () => ({ k: 16, n: 16, rotation: 0, stepMs: 187.5 }),
    });
    expect(denser.holds).toBe(false);
    expect(denser.violations[0]?.rule).toBe(
      'damage-parity/evolved-exceeds-halves',
    );

    // ...and a cadence that leaves the 16th-note lattice fails the grid rule.
    const offLattice = checkLatticeConformance({
      evolvedIds: ['chain_ricochet'],
      evolvedPatternFor: () => ({ k: 2, n: 15, rotation: 0, stepMs: 200 }),
    });
    expect(offLattice.holds).toBe(false);
    expect(offLattice.violations.map((violation) => violation.rule)).toContain(
      'lattice/step-off-16th',
    );
  });
});

// ── Fused fire definition (field tier, AH-0MWU7BAXI003HBP3) ─────────

describe('resolveEvolvedWeaponDefinition — the fused fire definition', () => {
  it('fires exactly one forward shot per onset, so a fusion is never a damage multiplier', () => {
    for (const pairing of WEAPON_PAIRINGS) {
      const def = resolveEvolvedWeaponDefinition(pairing.evolvedId);
      // One offset = one damage instance per cadence tick (harness AC5).
      expect(def.offsets).toEqual([0]);
      expect(def.sideOffsets).toBeUndefined();
      // An evolved weapon is a travelling pattern, never the base response.
      expect(def.aoe).toBeUndefined();
      expect(def.orbit).toBeUndefined();
      expect(def.hitscan).toBeUndefined();
    }
  });

  it('carries the evolved name, description and palette colour', () => {
    const def = resolveEvolvedWeaponDefinition('chain_ricochet');
    const evolved = getEvolvedWeaponDefinition('chain_ricochet');

    expect(def.name).toBe(evolved.name);
    expect(def.description).toBe(evolved.description);
    expect(def.bulletColor).toBe(evolved.colour);
    // The shot keeps the primary half's catalogue identity, so hex matchup
    // classification still reads a base id (epic AC11).
    expect(def.id).toBe('ricochet');
  });

  it('uses the evolved rhythm average as its nominal fire interval', () => {
    for (const pairing of WEAPON_PAIRINGS) {
      const def = resolveEvolvedWeaponDefinition(pairing.evolvedId, 0, 80);
      const pattern = resolveEvolvedWeaponPattern(pairing.evolvedId, 0, 80);
      expect(def.fireRateMs).toBeCloseTo(
        (pattern.stepMs * pattern.n) / pattern.k,
        9,
      );
    }
  });

  it('is deterministic and level-clamped', () => {
    const first = resolveEvolvedWeaponDefinition('cluster_barrage', 3);
    const second = resolveEvolvedWeaponDefinition('cluster_barrage', 3);
    expect(second).toEqual(first);
    // Fractional / non-finite levels clamp without throwing.
    expect(() =>
      resolveEvolvedWeaponDefinition('cluster_barrage', Number.NaN),
    ).not.toThrow();
  });
});

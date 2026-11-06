/**
 * Dev-only weapon-data diagnostics (AH-0MW0Q1EYJ007RRFI AC "boot-time
 * self-check" + "cadence ownership note").
 *
 * The diagnostic is the visible seam between the two cadence sources:
 *
 * - `src/data/weapons.csv` `subdivisions` → the **legacy nominal** interval
 *   (level-stat quantisation and the hold-full ghost metronome);
 * - the Euclidean ladder resolved by `resolveWeaponPattern` → the **live**
 *   fire cadence, whose authored data is `src/data/weapon-levels.json`.
 *
 * Both directions are asserted: silent where the two agree, a named warning
 * for an **undocumented** divergence, and silence for the documented,
 * deliberate set.
 *
 * Before AH-0MW23FEDK006BRHK the committed seed had 14 divergent weapons:
 * the level-0 output trim (AH-0MVWAVKS0005P9VN) lowered the nominal
 * `subdivisions` without re-timing the live ladder. The re-time made every
 * trimmed weapon's nominal and live cadence agree, leaving exactly the three
 * deliberate superposition rungs — `cannon`, `rapid` and `railgun` — which are
 * registered in `DELIBERATE_CADENCE_DIVERGENCES` with their design reason. A
 * divergence outside that registry still warns, and a stale registry entry
 * warns too, so the exemption cannot silently mask a future drift.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DELIBERATE_CADENCE_DIVERGENCES,
  collectWeaponDataDiagnostics,
  emitWeaponDataWarnings,
  findUndocumentedCadenceDivergences,
  findWeaponCadenceDivergences,
  formatWeaponCadenceWarning,
  validateCadenceDivergenceRegistry,
  warnOnWeaponDataDivergences,
  type WeaponCadenceDivergence,
} from './weaponDataDiagnostics';
import { DEFAULT_WEAPON_SUBDIVISIONS, type WeaponId } from './weapons';

/**
 * The committed seed's divergence set, in catalogue order. A change here is a
 * data change (a `subdivisions` edit or a ladder re-timing), so it must be
 * deliberate.
 */
const EXPECTED_DIVERGENT: readonly WeaponId[] = ['cannon', 'rapid', 'railgun'];

/** Level-0 ladder density (onsets per beat) per weapon, for the named cases. */
const LADDER_ONSETS_PER_BEAT: Record<WeaponId, number> = {
  cannon: 2.25,
  spread: 0.5,
  dual: 0.5,
  rapid: 3.25,
  wave_laser: 0.5,
  ricochet: 0.5,
  cluster: 0.25,
  options: 0.5,
  nova: 0.25,
  mortar: 0.5,
  arc: 1,
  rear_guard: 1,
  broadside: 0.25,
  railgun: 0.5,
  shard_swarm: 0.5,
  heavy_slug: 0.25,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('weapon cadence divergence detection', () => {
  it('names every divergent weapon and stays silent where the sources agree', () => {
    const divergences = findWeaponCadenceDivergences();

    expect(divergences.map((divergence) => divergence.weaponId)).toStrictEqual([
      ...EXPECTED_DIVERGENT,
    ]);
    // Every re-timed weapon's live rung now equals its trimmed nominal
    // `subdivisions`, so no other weapon may appear here.
    for (const weaponId of Object.keys(DEFAULT_WEAPON_SUBDIVISIONS) as WeaponId[]) {
      if (EXPECTED_DIVERGENT.includes(weaponId)) continue;
      expect(
        divergences.map((divergence) => divergence.weaponId),
        weaponId,
      ).not.toContain(weaponId);
    }
  });

  it('reports the authored nominal value and the live ladder density', () => {
    const divergences = findWeaponCadenceDivergences();

    for (const divergence of divergences) {
      expect(divergence.nominalSubdivisions, divergence.weaponId).toBe(
        DEFAULT_WEAPON_SUBDIVISIONS[divergence.weaponId],
      );
      expect(divergence.ladderOnsetsPerBeat, divergence.weaponId).toBe(
        LADDER_ONSETS_PER_BEAT[divergence.weaponId],
      );
      expect(divergence.nominalSubdivisions, divergence.weaponId).not.toBe(
        divergence.ladderOnsetsPerBeat,
      );
    }
    // Spot-check the three deliberate superposition ladders.
    expect(
      divergences.find((divergence) => divergence.weaponId === 'cannon'),
    ).toStrictEqual({
      weaponId: 'cannon',
      nominalSubdivisions: 2,
      ladderOnsetsPerBeat: 2.25,
    });
    expect(
      divergences.find((divergence) => divergence.weaponId === 'rapid'),
    ).toStrictEqual({
      weaponId: 'rapid',
      nominalSubdivisions: 3,
      ladderOnsetsPerBeat: 3.25,
    });
    expect(
      divergences.find((divergence) => divergence.weaponId === 'railgun'),
    ).toStrictEqual({
      weaponId: 'railgun',
      nominalSubdivisions: 0.25,
      ladderOnsetsPerBeat: 0.5,
    });
  });

  it('the deliberate registry is exactly the committed divergent set', () => {
    // A registry entry must describe a real divergence, and every divergence
    // must be documented: this is the AC3 contract that the dev diagnostic
    // and the balance documentation cannot drift apart.
    expect(Object.keys(DELIBERATE_CADENCE_DIVERGENCES).sort()).toStrictEqual(
      [...EXPECTED_DIVERGENT].sort(),
    );
    for (const [weaponId, reason] of Object.entries(
      DELIBERATE_CADENCE_DIVERGENCES,
    )) {
      expect(reason.length, weaponId).toBeGreaterThan(40);
    }
  });

  it('leaves no undocumented divergence in the committed seed', () => {
    expect(findUndocumentedCadenceDivergences()).toStrictEqual([]);
    expect(
      formatWeaponCadenceWarning(findUndocumentedCadenceDivergences()),
    ).toBeNull();
    expect(validateCadenceDivergenceRegistry()).toStrictEqual([]);
  });

  it('still names a divergence that is not in the documented registry', () => {
    // A designer who retimes a rung without touching the CSV (or vice versa)
    // must be told, even though the three superposition rungs are exempt.
    const drift: WeaponCadenceDivergence = {
      weaponId: 'spread',
      nominalSubdivisions: 0.5,
      ladderOnsetsPerBeat: 1,
    };

    expect(findUndocumentedCadenceDivergences([drift])).toStrictEqual([drift]);
    const message = formatWeaponCadenceWarning(
      findUndocumentedCadenceDivergences([drift]),
    );
    expect(message).toContain('spread: nominal 0.5 vs live ladder 1 onsets/beat');
    expect(message).toContain('not in the documented deliberate set');
  });

  it('reports a stale registry entry instead of masking it', () => {
    // The cannon's exemption is only valid while its live rung stays 9/16. If
    // a retune makes it agree with the nominal, the entry must be dropped.
    const stale = validateCadenceDivergenceRegistry([
      {
        weaponId: 'rapid',
        nominalSubdivisions: 3,
        ladderOnsetsPerBeat: 3.25,
      },
    ]);

    expect(stale).toHaveLength(2);
    expect(stale.join('\n')).toContain('cannon');
    expect(stale.join('\n')).toContain('railgun');
    expect(stale.join('\n')).toContain('drop the stale registry entry');
  });
});

describe('cadence warning text', () => {
  it('names every undocumented divergent weapon and the live cadence source', () => {
    const message = formatWeaponCadenceWarning(findWeaponCadenceDivergences());

    expect(message).not.toBeNull();
    expect(message).toContain('src/data/weapon-levels.json');
    expect(message).toContain('resolveWeaponPattern');
    expect(message).toContain('not in the documented deliberate set');
    for (const id of EXPECTED_DIVERGENT) {
      expect(message, id).toContain(`${id}: nominal`);
    }
    // Agreeing weapons must not be named in the warning.
    expect(message).not.toContain('spread: nominal');
    expect(message).not.toContain('wave_laser: nominal');
  });

  it('is null when the nominal table and the live ladder agree everywhere', () => {
    expect(formatWeaponCadenceWarning([])).toBeNull();
  });
});

describe('boot-time emission', () => {
  it('logs one console warning per message and nothing for an empty list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    emitWeaponDataWarnings([]);
    expect(warn).not.toHaveBeenCalled();

    emitWeaponDataWarnings(['first', 'second']);
    expect(warn).toHaveBeenNthCalledWith(1, 'first');
    expect(warn).toHaveBeenNthCalledWith(2, 'second');
  });

  it('collects no warning for the committed seed: the divergence set is documented', () => {
    // AC3: after the re-time the only nominal-vs-live divergences are the
    // registered deliberate superposition rungs, so a dev boot is silent.
    const diagnostics = collectWeaponDataDiagnostics();

    expect(diagnostics).toStrictEqual([]);
  });

  it('stays silent in the test suite and warns in a dev server session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Vitest runs with MODE === 'test': a diagnostic must not pollute output.
    warnOnWeaponDataDivergences();
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    warnOnWeaponDataDivergences();
    // The committed seed is clean, so even a dev server logs nothing here;
    // the emission path itself is covered by the explicit-list test above.
    expect(warn).not.toHaveBeenCalled();
  });
});

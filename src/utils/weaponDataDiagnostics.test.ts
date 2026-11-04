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
 * Both directions are asserted: silent where the two agree, and a named
 * warning for every divergent weapon (including the six canonical
 * superposition weapons — cannon, rapid, arc, railgun, shard_swarm,
 * heavy_slug — whose irregular level-0 rhythm is deliberate).
 *
 * The committed expected set is 14 divergent / 2 identical rather than the
 * six in the work item's original wording: the level-0 output trim
 * (AH-0MVWAVKS0005P9VN) later lowered the nominal `subdivisions` for the
 * straight-ladder weapons without re-timing the ladder, so the two sources
 * now also diverge for spread, dual, wave_laser, ricochet, cluster, options,
 * rear_guard and broadside. The diagnostic reports that truth (and the
 * discrepancy is filed as a discovery from this item); it must not be tuned
 * to hide it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectWeaponDataDiagnostics,
  emitWeaponDataWarnings,
  findWeaponCadenceDivergences,
  formatWeaponCadenceWarning,
  warnOnWeaponDataDivergences,
} from './weaponDataDiagnostics';
import { DEFAULT_WEAPON_SUBDIVISIONS, type WeaponId } from './weapons';

/**
 * The committed seed's divergence set, in catalogue order. A change here is a
 * data change (a `subdivisions` edit or a ladder re-timing), so it must be
 * deliberate.
 */
const EXPECTED_DIVERGENT: readonly WeaponId[] = [
  'cannon',
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'arc',
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
];

/** The epic's canonical six-weapon superposition fixture (irregular ladders). */
const SUPERPOSITION_IDS: readonly WeaponId[] = [
  'cannon',
  'rapid',
  'arc',
  'railgun',
  'shard_swarm',
  'heavy_slug',
];

/** Level-0 ladder density (onsets per beat) per weapon, for the named cases. */
const LADDER_ONSETS_PER_BEAT: Record<WeaponId, number> = {
  cannon: 2.25,
  spread: 1,
  dual: 1,
  rapid: 3.25,
  wave_laser: 1,
  ricochet: 1,
  cluster: 0.5,
  options: 1,
  nova: 0.25,
  mortar: 0.5,
  arc: 2.25,
  rear_guard: 2,
  broadside: 0.5,
  railgun: 0.5,
  shard_swarm: 2.5,
  heavy_slug: 0.75,
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
    // The only weapons whose nominal subdivision matches the level-0 ladder
    // density exactly: the AOE Nova and Mortar.
    expect(divergences.map((divergence) => divergence.weaponId)).not.toContain(
      'nova',
    );
    expect(divergences.map((divergence) => divergence.weaponId)).not.toContain(
      'mortar',
    );
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
    // Spot-check the six canonical ladders, where the divergence is deliberate.
    expect(
      divergences.find((divergence) => divergence.weaponId === 'cannon'),
    ).toStrictEqual({
      weaponId: 'cannon',
      nominalSubdivisions: 2,
      ladderOnsetsPerBeat: 2.25,
    });
    expect(
      divergences.find((divergence) => divergence.weaponId === 'heavy_slug'),
    ).toStrictEqual({
      weaponId: 'heavy_slug',
      nominalSubdivisions: 0.25,
      ladderOnsetsPerBeat: 0.75,
    });
  });

  it('keeps the six canonical superposition weapons in the warned set', () => {
    const warned = new Set(
      findWeaponCadenceDivergences().map((divergence) => divergence.weaponId),
    );

    for (const id of SUPERPOSITION_IDS) {
      expect(warned.has(id), id).toBe(true);
    }
  });
});

describe('cadence warning text', () => {
  it('names every divergent weapon and the live cadence source', () => {
    const message = formatWeaponCadenceWarning(findWeaponCadenceDivergences());

    expect(message).not.toBeNull();
    expect(message).toContain('src/data/weapon-levels.json');
    expect(message).toContain('resolveWeaponPattern');
    for (const id of EXPECTED_DIVERGENT) {
      expect(message, id).toContain(`${id}: nominal`);
    }
    // Silent weapons must not be named in the warning.
    expect(message).not.toContain('nova: nominal');
    expect(message).not.toContain('mortar: nominal');
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

  it('collects the cadence warning for the committed seed and no load warning', () => {
    const diagnostics = collectWeaponDataDiagnostics();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('Weapon cadence divergence');
  });

  it('stays silent in the test suite and warns in a dev server session', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Vitest runs with MODE === 'test': a diagnostic must not pollute output.
    warnOnWeaponDataDivergences();
    expect(warn).not.toHaveBeenCalled();

    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    warnOnWeaponDataDivergences();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Weapon cadence divergence');
  });
});

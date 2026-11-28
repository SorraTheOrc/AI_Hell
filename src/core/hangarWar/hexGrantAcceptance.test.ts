/**
 * Catalogue-guard witness and documentation correction for hex-awarded weapons
 * (AH-0MWWARFUK009KQM7, consuming AH-0MWW6PNA5008NC91).
 *
 * The parent feature derived one hangar entry per shipped weapon and added the
 * fail-closed guard (e): every authored `hexRingDefinitions.grants` id must
 * resolve to a catalogue entry or sit on the short documented effect-free
 * allowlist. This suite is the acceptance witness for that guard and for the
 * claim that making the reward usable changed no balance:
 *
 * - AC5 — the guard **fails on the pre-derivation tree**, naming all five
 *   weapon grants (`rapid`, `arc`, `broadside`, `dual`, `nova`), and passes on
 *   the shipped tree. The allowlist is now **empty** (AH-0MWWARIW6003F7OV
 *   modelled the three ring-2 modifier grants as hull-training entries);
 *   `core-bank` was never on it because no authored hex grants that id.
 * - AC6 — the five grants ship grant-only: zero price, the `GRANT_ONLY_MIN_RING`
 *   gate and no economy row, so no purchase path appears; the four authored
 *   prices are byte-identical to before and player strength / the ring
 *   aggression budget are unchanged by the weapon grants
 *   (`STARTING_WEAPON_STRENGTH_WEIGHT = 0`).
 * - AC7/AC8 — no committed documentation describes a swallowed weapon grant as
 *   intended behaviour any more: the "effect-free `core-bank`" statement, the
 *   un-itemised-`rapid` examples and the capture cycle's "has not itemised yet"
 *   note are corrected, and the three ring-2 grant ids are documented as
 *   modelled hull training rather than "strength entries".
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  GRANT_ONLY_MIN_RING,
  HANGAR_CATALOGUE,
  HANGAR_EXCLUDED_WEAPON_IDS,
  HEX_GRANT_EFFECT_FREE_ALLOWLIST,
  WEAPON_UNLOCK_ECONOMY,
  buildHangarCatalogue,
  isPurchasableEntry,
  validateHangarCatalogue,
  type HangarCatalogueDiagnostic,
  type HangarCatalogueValidation,
} from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { WEAPON_CATALOGUE } from '../../utils/weapons';
import {
  STARTING_WEAPON_STRENGTH_WEIGHT,
  resolvePlayerStrength,
} from './hangarEconomy';
import { DEFAULT_FRONTIER_TUNING, ringAggressionBudget } from './hexDefence';
import { resolveGrantAlias } from './grantAliases';
import { createRingState } from './hexRing';
import { createDefaultPayload } from './hangarWarStore';

/** The five distinct weapons the authored rings award (AC3/AC5). */
const HEX_GRANTED_WEAPON_IDS = [
  'rapid',
  'arc',
  'broadside',
  'dual',
  'nova',
] as const;

/** The three ring-2 modifier grants that now carry modelled hull training. */
const HULL_TRAINING_MODIFIER_GRANTS = [
  'armour-plating',
  'firepower-up',
  'systems-upgrade',
] as const;

/** The diagnostics for the authored-grant guard (e). */
function hexGrantDiagnostics(
  result: HangarCatalogueValidation,
): readonly HangarCatalogueDiagnostic[] {
  return result.diagnostics.filter((entry) => entry.field === 'hexGrant');
}

/** Every id named by the authored-grant guard (e). */
function hexGrantErrorIds(result: HangarCatalogueValidation): string[] {
  return hexGrantDiagnostics(result)
    .filter((entry) => entry.severity === 'error')
    .flatMap((entry) => [...entry.ids]);
}

const EVALUATION_PATH = path.resolve(process.cwd(), 'docs/EVALUATION.md');
const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const OUTER_LOOP_PATH = path.resolve(
  process.cwd(),
  'docs/OUTER_LOOP_CANDIDATES.md',
);
const RING_TIMING_PATH = path.resolve(process.cwd(), 'src/ai/eval/ringTiming.ts');
const CAPTURE_CYCLE_PATH = path.resolve(
  process.cwd(),
  'src/core/hangarWar/captureCycle.ts',
);

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

describe('hex-grant referential-integrity guard (AC5)', () => {
  it('fails on the pre-derivation tree, naming all five weapon grants', () => {
    // The tree as it was before the derivation: no entry for the five weapon
    // grants. This is the failure the missing guard (e) allowed to ship.
    const preDerivation = buildHangarCatalogue(WEAPON_CATALOGUE, [
      ...HANGAR_EXCLUDED_WEAPON_IDS,
      ...HEX_GRANTED_WEAPON_IDS,
    ]);
    const result = validateHangarCatalogue({ entries: preDerivation });

    expect(result.ok).toBe(false);
    const named = new Set(hexGrantErrorIds(result));
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      expect(named, `guard (e) must name ${id}`).toContain(id);
    }
    // `rapid` is granted by two authored hexes, so both are witnessed.
    expect(hexGrantErrorIds(result).filter((id) => id === 'rapid')).toHaveLength(
      2,
    );
    // Every diagnostic is actionable: it names the id and the rule.
    for (const diagnostic of hexGrantDiagnostics(result)) {
      expect(diagnostic.message).toContain('hexGrant');
    }
  });

  it('passes on the shipped tree with no authored-grant diagnostic', () => {
    const result = validateHangarCatalogue();
    expect(result.ok).toBe(true);
    expect(hexGrantDiagnostics(result)).toEqual([]);

    // The five authored grants resolve to real, itemised weapon entries.
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      const entry = HANGAR_CATALOGUE.find((candidate) => candidate.id === id);
      expect(entry, `catalogue entry for ${id}`).toBeDefined();
      expect(entry!.kind).toBe('weapon');
    }

    // Every authored grant is covered by the guard: the ring data grants no id
    // outside the catalogue (the documented allowlist is now empty).
    const authoredGrants = new Set<string>(
      HEX_RING_DEFINITIONS.map((definition) => String(definition.grants)),
    );
    for (const grant of authoredGrants) {
      // The guard resolves an authored spelling through the one alias table
      // (`extra-life` → `hardened_plating`, `waveLaser` → `wave_laser`).
      const entryId = resolveGrantAlias(grant)?.entryId ?? grant;
      const itemised = HANGAR_CATALOGUE.some((entry) => entry.id === entryId);
      expect(
        itemised || HEX_GRANT_EFFECT_FREE_ALLOWLIST.includes(grant),
        `authored grant ${grant} is itemised or allowlisted`,
      ).toBe(true);
    }
  });

  it('empties the allowlist and models the three ring-2 grants instead', () => {
    // The former effect-free allowlist is empty (AH-0MWWARIW6003F7OV), so a
    // future uncatalogued grant fails closed rather than joining a dumping
    // ground.
    expect(HEX_GRANT_EFFECT_FREE_ALLOWLIST).toEqual([]);
    expect(HEX_GRANT_EFFECT_FREE_ALLOWLIST).not.toContain('core-bank');
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      expect(HEX_GRANT_EFFECT_FREE_ALLOWLIST).not.toContain(id);
    }

    // The three ids are genuinely authored by ring-2 hexes, and each is now a
    // named, grant-only hull-training catalogue modifier.
    const authored: string[] = HEX_RING_DEFINITIONS.map((definition) =>
      String(definition.grants),
    );
    for (const id of HULL_TRAINING_MODIFIER_GRANTS) {
      expect(authored, `an authored hex grants ${id}`).toContain(id);
      const entry = HANGAR_CATALOGUE.find((candidate) => candidate.id === id);
      expect(entry, `catalogue entry for ${id}`).toBeDefined();
      expect(entry!.kind).toBe('modifier');
      expect(isPurchasableEntry(entry!), `${id} is not for sale`).toBe(false);
    }
    expect(authored).not.toContain('core-bank');
  });
});

describe('making the reward usable changes no balance (AC6)', () => {
  it('ships all five grants grant-only — no price and no purchase path', () => {
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      const entry = HANGAR_CATALOGUE.find((candidate) => candidate.id === id)!;
      expect(entry.kind).toBe('weapon');
      expect(entry.price, `${id} price`).toEqual({ minerals: 0, cores: 0 });
      expect(entry.minRing, `${id} ring gate`).toBe(GRANT_ONLY_MIN_RING);
      expect(isPurchasableEntry(entry), `${id} is not for sale`).toBe(false);
      expect(
        WEAPON_UNLOCK_ECONOMY[id],
        `${id} has no authored economy row`,
      ).toBeUndefined();
    }
  });

  it('leaves the four authored prices byte-identical', () => {
    expect(WEAPON_UNLOCK_ECONOMY).toEqual({
      spread: { price: { minerals: 0, cores: 0 }, minRing: 1, starter: true },
      wave_laser: { price: { minerals: 120, cores: 1 }, minRing: 1 },
      ricochet: { price: { minerals: 90, cores: 2 }, minRing: 1 },
      cluster: { price: { minerals: 160, cores: 1 }, minRing: 1 },
    });
    // The catalogue's own copies of those rows agree with the economy table.
    for (const [id, row] of Object.entries(WEAPON_UNLOCK_ECONOMY)) {
      const entry = HANGAR_CATALOGUE.find((candidate) => candidate.id === id)!;
      expect(entry.price, `${id} catalogue price`).toEqual(row!.price);
      expect(entry.minRing, `${id} catalogue ring gate`).toBe(row!.minRing);
    }
  });

  it('does not inflate player strength or the ring aggression budget', () => {
    expect(STARTING_WEAPON_STRENGTH_WEIGHT).toBe(0);

    const plain = createDefaultPayload(11);
    const armed = createDefaultPayload(11);
    armed.hangar.unlockedWeapons = [
      ...armed.hangar.unlockedWeapons,
      ...HEX_GRANTED_WEAPON_IDS,
    ];
    armed.hangar.activeLoadout = {
      ...armed.hangar.activeLoadout,
      startingWeapons: [...HEX_GRANTED_WEAPON_IDS],
    };

    const plainStrength = resolvePlayerStrength(plain.hangar);
    expect(resolvePlayerStrength(armed.hangar)).toBe(plainStrength);

    const ring = createRingState(2, HEX_RING_DEFINITIONS);
    expect(
      ringAggressionBudget(
        resolvePlayerStrength(armed.hangar),
        ring,
        DEFAULT_FRONTIER_TUNING,
      ),
    ).toBe(
      ringAggressionBudget(plainStrength, ring, DEFAULT_FRONTIER_TUNING),
    );
  });
});

describe('no documentation describes a swallowed weapon grant as intended (AC7/AC8)', () => {
  it('EVALUATION.md names the reward hull and no longer calls `core-bank` effect-free', () => {
    const text = read(EVALUATION_PATH);
    expect(text).not.toMatch(/effect-free `core-bank`/i);
    expect(text).not.toMatch(/does not itemise[^.]*owned but contributes no run stats/i);
    // The ring-1 sixth grant is the grant-only special-mission hull.
    expect(text).toMatch(/`hull-4`/);
    // The five hex-granted weapons are named as owned and deployable.
    for (const id of HEX_GRANTED_WEAPON_IDS) {
      expect(text, `EVALUATION.md names ${id}`).toMatch(
        new RegExp(`\\b${id}\\b`),
      );
    }
  });

  it('the ring-timing model no longer examples `rapid` as un-itemised', () => {
    const text = read(RING_TIMING_PATH);
    expect(text).not.toMatch(/`hull-9`, `rapid`, `core-bank`/);
    expect(text).not.toMatch(/exactly as `rapid` \/ `core-bank`/);
    expect(text).not.toMatch(/effect-free `core-bank` modifier/);
  });

  it('the capture cycle no longer claims an authored grant is un-itemised', () => {
    const text = read(CAPTURE_CYCLE_PATH);
    expect(text).not.toMatch(/grant strength the catalogue has not itemised yet/);
  });

  it('the Game Design Document calls `rapid` a weapon, not a strength entry', () => {
    const text = read(GDD_PATH);
    expect(text).not.toMatch(/the `rapid` strength entry/);
    // The three ring-2 grants are documented by id as modelled hull training.
    for (const id of HULL_TRAINING_MODIFIER_GRANTS) {
      expect(text, `the GDD names ${id}`).toContain(id);
    }
    expect(text).not.toMatch(/`armour-plating` \/ `firepower-up` \/ `systems-upgrade` strength entries/);
  });

  it('no committed design doc claims a granted weapon is effect-free', () => {
    for (const filePath of [
      EVALUATION_PATH,
      GDD_PATH,
      README_PATH,
      OUTER_LOOP_PATH,
    ]) {
      const text = read(filePath);
      expect(text, `${path.basename(filePath)}`).not.toMatch(
        /a grant the catalogue does not itemise[^.]*owned but contributes no run stats/i,
      );
    }
  });
});

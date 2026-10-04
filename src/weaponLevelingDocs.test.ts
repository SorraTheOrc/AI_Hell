/**
 * Docs guard for weapon leveling (AH-0MUQOT1I60038CO7, AC4/AC5).
 *
 * The upgrade-variable catalogue and its diminishing-returns curve must be
 * documented in the player-facing references — GDD §4.4.2 (the catalogue
 * table plus a per-variable cap/rate rationale) and the README. This guard
 * fails if that documentation is removed or weakened, and cross-checks every
 * implemented `WEAPON_UPGRADE_SPECS` label against the GDD table so the
 * docs cannot silently drift from the code catalogue.
 *
 * Like the sibling `aoeDocs.test.ts`, this is a deliberate docs grep: it
 * asserts the canonical documentation (the AC), not runtime behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  MVP_UPGRADE_VARIABLES,
  UPGRADE_VARIABLES,
  WEAPON_UPGRADE_SPECS,
} from './utils/weaponLevels';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');

describe('weapon leveling is documented (AH-0MUQOT1I60038CO7 AC4/AC5)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('the GDD has a dedicated §4.4.2 Weapon Leveling subsection', () => {
    expect(gdd).toContain('#### 4.4.2 Weapon Leveling');
    expect(gdd).toMatch(/run-scoped integer level/);
  });

  it('the GDD documents the diminishing-returns curve formula', () => {
    expect(gdd).toContain('effective(level) = cap − (cap − base) × e^(−k × level)');
    expect(gdd).toMatch(/asymptotic|asymptotically|finite ceiling|hard, finite/i);
  });

  it('the GDD lists every catalogued variable label', () => {
    for (const variable of UPGRADE_VARIABLES) {
      expect(gdd).toContain(WEAPON_UPGRADE_SPECS[variable].label);
    }
  });

  it('the GDD marks the MVP variables and the >= 12-variable breadth', () => {
    expect(UPGRADE_VARIABLES.length).toBeGreaterThanOrEqual(12);
    for (const variable of MVP_UPGRADE_VARIABLES) {
      expect(gdd).toContain(WEAPON_UPGRADE_SPECS[variable].label);
    }
    expect(gdd).toMatch(/\*\*MVP\*\*/);
  });

  it('the GDD records a cap/rate rationale for the curve', () => {
    // The rationale paragraph names the ceiling(s) and the saturation rate.
    expect(gdd).toMatch(/Rationale for each cap\/rate/);
    expect(gdd).toMatch(/3× ceiling/);
  });

  it('the GDD records the beat-grid constraint on fire-rate upgrades', () => {
    expect(gdd).toMatch(/must not produce an off-grid interval|beat subdivision/i);
  });

  it('the README points at the leveling module and resolver', () => {
    expect(readme).toContain('src/utils/weaponLevels.ts');
    expect(readme).toContain('resolveWeaponAtLevel');
    expect(readme).toMatch(/weapon leveling/i);
  });
});

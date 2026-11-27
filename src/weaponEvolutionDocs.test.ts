/**
 * Docs guard for the weapon-evolution pairing table and its shipped status
 * (epic AH-0MWL7OWPF003E4TP AC12; gym parity + documentation child
 * AH-0MWU7BCVS00682HR).
 *
 * The pairing table is authored once as `WEAPON_PAIRINGS` +
 * `EVOLVED_WEAPON_DEFINITIONS` in `src/utils/weaponEvolutions.ts`. Three
 * surfaces quote it: GDD §4.4 (the pairing table + shipped note), GDD §8.3
 * (the backlog entry promoted to shipped) and `docs/GYM_PARITY.md` (the
 * `GymWeapons` pairing-parity row). This guard fails if any of those quotes
 * drift from the shipped data, or if the "proposed, not shipped" pointer is
 * re-introduced after the feature landed.
 *
 * Like the sibling docs guards (`weaponBalanceDocs.test.ts`,
 * `weaponLevelingDocs.test.ts`), every expected string is derived from the
 * code catalogue, not re-implemented arithmetic, so the documentation cannot
 * silently disagree with `weaponEvolutions.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  getEvolvedWeaponDefinition,
  WEAPON_PAIRINGS,
  type WeaponPairing,
} from './utils/weaponEvolutions';

const ROOT = process.cwd();
const GDD_PATH = path.resolve(ROOT, 'docs/Game Design Document.md');
const GYM_PARITY_PATH = path.resolve(ROOT, 'docs/GYM_PARITY.md');
const README_PATH = path.resolve(ROOT, 'README.md');

const GDD_POWER_UPS_HEADING = '### 4.4 Power-Ups';
const GDD_POWER_UPS_END = '#### 4.4.1';
const GDD_BACKLOG_EVOLUTION_HEADING = '#### Weapon evolutions — ranked 8';

/** Slices a markdown document between two headings. */
function slice(doc: string, start: string, end: string): string {
  const from = doc.indexOf(start);
  expect(from, `missing section: ${start}`).toBeGreaterThanOrEqual(0);
  const to = doc.indexOf(end, from);
  expect(to, `missing section end: ${end}`).toBeGreaterThan(from);
  return doc.slice(from, to);
}

/** The table row (or paragraph line) that quotes a pairing's two base ids. */
function pairingLine(doc: string, pairing: WeaponPairing): string {
  const needle = `\`${pairing.baseIds[0]}\` + \`${pairing.baseIds[1]}\``;
  const line = doc
    .split('\n')
    .find((candidate) => candidate.includes(needle));
  expect(line, `missing pairing line: ${needle}`).toBeDefined();
  return line as string;
}

const gdd = fs.readFileSync(GDD_PATH, 'utf8');
const gymParity = fs.readFileSync(GYM_PARITY_PATH, 'utf8');
const readme = fs.readFileSync(README_PATH, 'utf8');

/** GDD §4.4 (power-up/weapon table + the pairing note) before §4.4.1. */
const powerUpsSection = slice(gdd, GDD_POWER_UPS_HEADING, GDD_POWER_UPS_END);
/** The §8.3 backlog entry for weapon evolutions. */
const backlogEntry = slice(
  gdd,
  GDD_BACKLOG_EVOLUTION_HEADING,
  '#### Anomaly (elite) enemies and wave twists',
);

describe('weapon-evolution pairing docs match the shipped table (AC12)', () => {
  it('the GDD §4.4 pairing table quotes every shipped pairing with its name and effect', () => {
    for (const pairing of WEAPON_PAIRINGS) {
      const definition = getEvolvedWeaponDefinition(pairing.evolvedId);
      const line = pairingLine(powerUpsSection, pairing);
      // One row names the two halves, the evolved display name and the exact
      // effect description the shipped definition carries.
      expect(line, pairing.evolvedId).toContain(definition.name);
      expect(line, pairing.evolvedId).toContain(definition.description);
    }
  });

  it('the GDD §4.4 note is marked shipped, not proposed', () => {
    // The old backlog pointer is retired; the shipped note names the resolver.
    expect(powerUpsSection).not.toContain(
      'Proposed, not shipped (backlog §8.3): **weapon evolutions**',
    );
    expect(powerUpsSection).toContain('Weapon evolutions — shipped');
    expect(powerUpsSection).toContain('resolveWeaponEvolution');
    expect(powerUpsSection).toContain('src/utils/weaponEvolutions.ts');
  });

  it('the GDD §8.3 entry is promoted to shipped with a Landed note', () => {
    expect(backlogEntry).toContain('— **shipped**');
    expect(backlogEntry).toContain('**Landed:**');
    expect(backlogEntry).toContain('§4.4 *Power-Ups*');
    expect(backlogEntry).toContain('src/utils/weaponEvolutions.ts');
    expect(backlogEntry).toContain('docs/GYM_PARITY.md');
    // The original proposal text is retained as rationale.
    expect(backlogEntry).toContain('retained as the original proposal');
  });

  it('the GymWeapons parity row records the pairing demonstration (AC8)', () => {
    const row = gymParity
      .split('\n')
      .find((line) => line.startsWith('| `GymWeapons` |'));
    expect(row, 'GymWeapons matrix row').toBeDefined();
    // Enabled objects name the evolved pairings and the shared fire path.
    expect(row).toContain('weapon-evolution pairing');
    expect(row).toContain('Chain Ricochet');
    expect(row).toContain('Cluster Barrage');
    expect(row).toContain('Fan Escort');
    expect(row).toContain('Player.tryFire');
    // The demonstration seam equips both halves through the shared Player path.
    expect(row).toContain('equipPairing');
    expect(row).toContain('equipOwnedPairing');
    expect(row).toContain('GymWeapons.test.ts');
  });

  it('the README names the shipped pairing table and resolver', () => {
    expect(readme).toContain('src/utils/weaponEvolutions.ts');
    expect(readme).toContain('WEAPON_PAIRINGS');
    expect(readme).toContain('resolveWeaponEvolution');
    for (const pairing of WEAPON_PAIRINGS) {
      const definition = getEvolvedWeaponDefinition(pairing.evolvedId);
      expect(readme, definition.name).toContain(definition.name);
    }
  });

  it('the GDD and README note the two-id hex-matchup classification (AH-0MWXJEZET003B2IC)', () => {
    // GDD §4.4 must record that an evolved weapon resolves to BOTH base ids,
    // with the weakness-beats-strength precedence, so the docs cannot silently
    // regress to the single-id (primary-half-only) description.
    expect(powerUpsSection).toContain('**both** of its **base** ids');
    expect(powerUpsSection).toContain('`weaknesses` resolves `effective`');
    expect(powerUpsSection).toContain('`strengths` resolves `resisted`');
    expect(powerUpsSection).toContain('AH-0MWXJEZET003B2IC');
    // README names the same two-id classification.
    expect(readme).toContain('classifying as **both** of its **base** ids');
  });
});

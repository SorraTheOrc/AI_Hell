/**
 * Docs guard for the AOE weapon family (parent AH-0MUOOB3OR001V8CD, F7).
 *
 * The AOE weapons must be documented in the player-facing references — the
 * GDD §4.4 catalogue (names, fire rates and area effects), the README weapon
 * sections, and the gym-parity documentation (the intentional GymWeapons
 * practice-target divergence). This guard fails if that documentation is
 * removed or weakened, so the docs cannot silently drift from the
 * implemented catalogue.
 *
 * Like the sibling `gymParityDocs.test.ts`, this is a deliberate docs grep:
 * it asserts the canonical documentation text (the AC), not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const ENEMY_DOCS_PATH = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);

describe('AOE weapons are documented (F7 AC1/AC2/AC5)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const enemyDocs = fs.readFileSync(ENEMY_DOCS_PATH, 'utf8');

  it('the GDD §4.4 catalogue lists Nova, Mortar and Arc', () => {
    for (const name of ['Nova', 'Mortar', 'Arc']) {
      expect(gdd).toContain(`**${name}**`);
    }
  });

  it('the GDD documents each AOE weapon’s fire rate and area effect', () => {
    // Fire rates (on-grid) and effect radii from the catalogue.
    for (const value of [
      '3000 ms',
      '1500 ms',
      '750 ms',
      '45 px',
      '35 px',
      '60 px',
    ]) {
      expect(gdd).toContain(value);
    }
    // The trigger model and the P4 non-interference note.
    expect(gdd).toMatch(/onFire/);
    expect(gdd).toMatch(/onImpact/);
    expect(gdd).toMatch(/AOE does not alter P4 Bomb/);
  });

  it('the README references the AOE weapons in the weapon catalogue', () => {
    for (const name of ['Nova', 'Mortar', 'Arc']) {
      expect(readme).toContain(name);
    }
    expect(readme).toMatch(/AOE family/);
  });

  it('the parity docs record the GymWeapons practice-target divergence', () => {
    expect(enemyDocs).toMatch(/practice target/i);
    expect(enemyDocs).toContain('GymWeapons');
    expect(enemyDocs).toMatch(/onAoeFired/);
  });
});

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

import { AOE_RADII } from './utils/weapons';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const ENEMY_DOCS_PATH = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);
const GYM_PARITY_PATH = path.resolve(process.cwd(), 'docs/GYM_PARITY.md');

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
    // Fire rates (on-grid) and effect radii from the catalogue. The radii are
    // read from `AOE_RADII` so a balance trim (AH-0MVWAVKS0005P9VN) cannot
    // leave the GDD quoting a stale circle.
    for (const value of [
      '3000 ms',
      '1500 ms',
      '750 ms',
      `${AOE_RADII.nova} px`,
      `${AOE_RADII.mortar} px`,
      `${AOE_RADII.arc} px`,
    ]) {
      expect(gdd).toContain(value);
    }
    // The trigger model and the Bomb non-interference note.
    expect(gdd).toMatch(/onFire/);
    expect(gdd).toMatch(/AOE does not alter Bomb/);
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

/**
 * Docs guard for the standing auto-targeting eligibility rule
 * (AH-0MVNSIG1O0049G69 AC8, documented by AH-0MVVHAD7Z005X5UW).
 *
 * Only *auto-targeting* offence (the Arc chain and the Orbital Strike bolt)
 * must skip the inert `asteroid` world hazard; aimed and area weapons may
 * still hit rock. The rule lives once in `src/utils/targetEligibility.ts` and
 * must be stated as such in the player-facing references, so a future AOE
 * weapon cannot silently regress into "fires on asteroids" and the docs never
 * promise behaviour the code does not deliver. Assertions are section-scoped:
 * a phrase elsewhere in the file cannot satisfy them.
 */
describe('auto-targeting eligibility rule is documented (AH-0MVVHAD7Z005X5UW)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const enemyDocs = fs.readFileSync(ENEMY_DOCS_PATH, 'utf8');
  const gymParity = fs.readFileSync(GYM_PARITY_PATH, 'utf8');

  /** Markdown emphasis stripped, so prose assertions cannot trip on `**`. */
  const plain = (source: string): string => source.replace(/[*_`]/g, '');

  /** The single line of the GDD §4.4 catalogue row with the given id. */
  const gddRow = (id: string): string =>
    gdd.split('\n').find((line) => line.startsWith(`| ${id} |`)) ?? '';

  /** The paragraph that contains `marker` (paragraphs split on blank lines). */
  const paragraphWith = (source: string, marker: string): string =>
    source.split(/\n\s*\n/).find((block) => block.includes(marker)) ?? '';

  /** The divergence table row whose label is `label`. */
  const divergenceRow = (label: string): string =>
    gymParity
      .split('\n')
      .find(
        (line) => line.startsWith('|') && line.includes(`| ${label} |`),
      ) ?? '';

  it('the GDD §4.4 Arc row states rock is never a target (AC1)', () => {
    const arc = plain(gddRow('A3'));
    expect(arc).toContain('Arc');
    expect(arc).toMatch(/asteroids? are never (arc )?targets/i);
    expect(arc).toMatch(/without consuming a link/i);
    expect(arc).toContain('isEligibleAutoTarget');
    expect(arc).toContain('src/utils/targetEligibility.ts');
  });

  it('the GDD AOE appendix states the standing scope rule (AC2)', () => {
    const paragraph = plain(
      paragraphWith(gdd, 'AOE weapons — Nova, Mortar and Arc'),
    );
    expect(paragraph).toMatch(/auto-targeting/i);
    expect(paragraph).toMatch(/aimed/i);
    expect(paragraph).toContain('isEligibleAutoTarget');
    expect(paragraph).toContain('src/utils/targetEligibility.ts');
    expect(paragraph).toMatch(/Smart Bomb/);
    expect(paragraph).toContain('src/utils/targetEligibility.test.ts');
  });

  it('the enemy guide excludes the asteroid archetype from auto-targeting (AC3)', () => {
    const asteroidSection = plain(
      enemyDocs.split('### 1.3 E6 Asteroid')[1] ?? '',
    );
    expect(asteroidSection).toMatch(/auto-targeting/i);
    expect(asteroidSection).toMatch(/Orbital Strike/);
    expect(asteroidSection).toMatch(/Arc/);
    expect(asteroidSection).toMatch(/archetype string/i);
  });

  it('the practice-target divergence note keeps the auto-targeting scope (AC3)', () => {
    const note = plain(paragraphWith(enemyDocs, 'onAoeFired'));
    expect(note).toMatch(/auto-targeting/i);
    expect(note).toMatch(/archetype/i);
    expect(note).toMatch(/Arc/);
  });

  it('the parity docs keep the archetype-less practice targets targetable (AC4)', () => {
    const row = divergenceRow('`GymWeapons`');
    expect(row).toContain('TrainingTarget');
    expect(row).toMatch(/archetype/i);
    expect(row).toMatch(/Arc/);

    const divergence = divergenceRow('AOE practice targets');
    expect(divergence).toContain('TrainingTarget');
    expect(divergence).toMatch(/archetype/i);
  });
});

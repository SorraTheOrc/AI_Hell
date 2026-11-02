/**
 * Docs guard for hold-full option descriptions (AH-0MV2N2591007UGPD AC7).
 *
 * The three-part option block (name → two-line shared-catalogue description
 * area → change summary / `★ New`) and the level-neutral catalogue wording must be recorded
 * in the player-facing references — GDD §4.4.1 and the README — so the copy
 * cannot silently drift. Like the sibling `choiceWeightingDocs.test.ts`, this
 * is a deliberate docs grep: it asserts the canonical documentation (the AC),
 * not runtime behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getHelpDescription } from './utils/gymHelp';
import { WEAPON_CATALOGUE } from './utils/weapons';
import { POWER_UP_CATALOGUE } from './powerups/types';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');

/** The GDD §4.4.1 hold-full choice section (up to §4.4.2). */
function holdFullChoiceSection(gdd: string): string {
  const start = gdd.indexOf('#### 4.4.1 Minerals, the Ship');
  expect(
    start,
    'the GDD has the §4.4.1 hold-full choice section',
  ).toBeGreaterThan(-1);
  const end = gdd.indexOf('#### 4.4.2', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

describe('hold-full option descriptions are documented (AH-0MV2N2591007UGPD)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('getHelpDescription resolves the shared catalogue copy', () => {
    expect(getHelpDescription('spread')).toBe(
      WEAPON_CATALOGUE.spread.description,
    );
    expect(getHelpDescription('shield')).toBe(
      POWER_UP_CATALOGUE.shield.description,
    );
  });

  it('the GDD §4.4.1 records the three-part option block and two-line area', () => {
    expect(gdd).toMatch(/three-part block/i);
    expect(gdd).toMatch(/two-line description area/i);
    expect(gdd).toContain('getHelpDescription');
    expect(gdd).toMatch(/level-neutral/i);
  });

  it('the README records the option description area', () => {
    expect(readme).toMatch(/three-part block/i);
    expect(readme).toMatch(/two-line shared-catalogue description area/i);
    expect(readme).toContain('getHelpDescription');
  });
});

/**
 * Docs guard for the owned-permanents panel (AH-0MVCRKAPL000L68Y AC9).
 *
 * The top-left `YOUR UPGRADES` panel and its **permanent-only** rule are part
 * of the overlay's contract, so the GDD §4.4.1 and the README must record them
 * — and the §4.4.1 launcher list must name every hold-full launcher, including
 * the power-ups-only `GymPowerUpLeveling` gym.
 */
describe('the owned-permanents panel is documented (AH-0MVCRKAPL000L68Y)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const section = holdFullChoiceSection(gdd);

  it('GDD §4.4.1 records the YOUR UPGRADES panel and its permanent-only rule', () => {
    expect(section).toContain('YOUR UPGRADES');
    expect(section).toContain('YOUR UPGRADES — none yet');
    expect(section).toContain('buildOwnedLoadout');
    expect(section).toContain('src/powerups/ownedLoadout.ts');
    // Permanent only: no field-pickup row, no inflated level.
    expect(section).toMatch(/permanent level only|Only permanent state/i);
    expect(section).toContain('Lv.<N>');
  });

  it('GDD §4.4.1 names every hold-full launcher, including GymPowerUpLeveling', () => {
    for (const launcher of [
      'PlayScene.openMineralChoice',
      'GymFormationScene.openMineralChoice',
      'GymWeaponLeveling.openMineralChoice',
      'GymPowerUpLeveling.openMineralChoice',
    ]) {
      expect(section, `§4.4.1 records ${launcher}`).toContain(launcher);
    }
  });

  it('the README records the owned-permanents panel', () => {
    expect(readme).toContain('YOUR UPGRADES');
    expect(readme).toContain('buildOwnedLoadout');
    expect(readme).toMatch(/permanent/i);
  });
});

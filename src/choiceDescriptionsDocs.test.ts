/**
 * Docs guard for hold-full option descriptions (AH-0MV2N2591007UGPD AC7).
 *
 * The three-line option block (name → shared-catalogue description → change
 * summary / `★ New`) and the level-neutral catalogue wording must be recorded
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

  it('the GDD §4.4.1 records the three-line option block and shared resolver', () => {
    expect(gdd).toMatch(/three-line block/i);
    expect(gdd).toContain('getHelpDescription');
    expect(gdd).toMatch(/level-neutral/i);
  });

  it('the README records the option description line', () => {
    expect(readme).toMatch(/three-line block/i);
    expect(readme).toContain('getHelpDescription');
  });
});

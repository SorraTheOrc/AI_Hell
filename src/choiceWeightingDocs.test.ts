/**
 * Docs guard for hold-full choice weighting (AH-0MUY47W62005FF74 AC4/AC6).
 *
 * The 1.1× owned-upgrade bias and its named constant
 * (`OWNED_UPGRADE_BONUS_WEIGHT`, `src/powerups/choice.ts`) must be recorded in
 * the player-facing references — GDD §4.5 and the README — so the tuning
 * intent cannot silently drift from the code. Like the sibling
 * `powerUpLevelingDocs.test.ts`, this is a deliberate docs grep: it asserts
 * the canonical documentation (the AC), not runtime behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { OWNED_UPGRADE_BONUS_WEIGHT } from './powerups/choice';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');

describe('hold-full choice weighting is documented (AH-0MUY47W62005FF74)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('the weighting constant is named and exported from the strategy module', () => {
    expect(OWNED_UPGRADE_BONUS_WEIGHT).toBe(1.1);
    expect(readme).toContain('OWNED_UPGRADE_BONUS_WEIGHT');
  });

  it('the GDD §4.5 records the owned-upgrade weighting', () => {
    expect(gdd).toMatch(/OWNED_UPGRADE_BONUS_WEIGHT|1\.1×/);
    expect(gdd).toMatch(/10% more likely|10% more often/i);
  });

  it('the README records the 1.1× owned-upgrade weight', () => {
    expect(readme).toMatch(/1\.1×/);
    expect(readme).toMatch(/10% more often|10% more likely/i);
  });
});

/**
 * Docs guard for power-up leveling (AH-0MUU2QJE2007JNR6 AC8).
 *
 * The power-up level-curve catalogue and its shared diminishing-returns
 * curve must be documented in the player-facing references — GDD §4.4.3
 * and the README. This guard fails if that documentation is removed or
 * weakened, and cross-checks every implemented `POWER_UP_LEVEL_SPECS` label
 * against the GDD table so the docs cannot silently drift from the code
 * catalogue.
 *
 * Like the sibling `weaponLevelingDocs.test.ts`, this is a deliberate docs
 * grep: it asserts the canonical documentation (the AC), not runtime
 * behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { POWER_UP_CATALOGUE, type PowerUpId } from './powerups/types';
import { POWER_UP_LEVEL_SPECS } from './powerups/powerUpLevels';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');

const ids = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

describe('power-up leveling is documented (AH-0MUU2QJE2007JNR6 AC8)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('the GDD has a dedicated §4.4.3 Power-Up Leveling subsection', () => {
    expect(gdd).toContain('#### 4.4.3 Power-Up Leveling');
    expect(gdd).toMatch(/run-scoped integer level/);
  });

  it('the GDD documents the shared diminishing-returns curve', () => {
    expect(gdd).toContain('effective(level) = cap − (cap − base) × e^(−k × level)');
    expect(gdd).toContain('src/utils/curve.ts');
  });

  it('the GDD lists every power-up level variable label', () => {
    for (const id of ids) {
      for (const spec of POWER_UP_LEVEL_SPECS[id]) {
        expect(gdd).toContain(spec.label);
      }
    }
  });

  it('the GDD records the stack-reconciliation and hybrid semantics', () => {
    expect(gdd).toMatch(/Stack reconciliation/);
    expect(gdd).toMatch(/permanent stack/);
  });

  it('the README points at the power-up leveling module and resolver', () => {
    expect(readme).toContain('src/powerups/powerUpLevels.ts');
    expect(readme).toContain('resolvePowerUpAtLevel');
    expect(readme).toMatch(/power-up leveling/i);
  });
});

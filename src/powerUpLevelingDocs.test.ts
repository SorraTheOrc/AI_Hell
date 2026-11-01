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
import {
  POWER_UP_LEVEL_SPECS,
  resolvePowerUpAtLevel,
} from './powerups/powerUpLevels';

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

  it('the GDD §4.4.3 table pins the consumable charge numbers to the catalogue (AH-0MVTQMREN009DSFW AC1)', () => {
    // The per-consumable charge caps and regeneration intervals must read as
    // the same numbers the resolver produces, so the player-facing docs
    // cannot drift from the catalogue: level-0 values, the level cap/floor
    // and the shipped Phase/Teleport/Thorn intervals all below.
    const shield0 = resolvePowerUpAtLevel('shield', 0).shieldRecharge;
    const shieldFloor = resolvePowerUpAtLevel('shield', 10).shieldRecharge;
    const field0 = resolvePowerUpAtLevel('force_field', 0).forceFieldRecharge;
    const fieldFloor = resolvePowerUpAtLevel('force_field', 10).forceFieldRecharge;
    const ufo0 = resolvePowerUpAtLevel('mystery_ufo', 0).mysteryUfoChargeCap;
    const ufoCap = resolvePowerUpAtLevel('mystery_ufo', 10).mysteryUfoChargeCap;
    expect(shield0).toBe(45);
    expect(shieldFloor).toBe(20);
    expect(field0).toBe(45);
    expect(fieldFloor).toBe(20);
    expect(ufo0).toBe(1);
    expect(ufoCap).toBe(3);
    expect(gdd).toContain(`Shield recharge (${shield0} s → ${shieldFloor} s,`);
    expect(gdd).toContain(`Field recharge (${field0} s → ${fieldFloor} s,`);
    expect(gdd).toContain(`UFO charges (${ufo0} → ${ufoCap},`);
    expect(gdd).toContain('Phase recharge (1/30 → 1/10');
    expect(gdd).toContain('Teleport recharge (1/15 → 1/5');
    expect(gdd).toContain('Thorn recharge (12 s → 5 s,');
  });

  it('the GDD records the stack-reconciliation and hybrid semantics', () => {
    expect(gdd).toMatch(/Stack reconciliation/);
    expect(gdd).toMatch(/permanent stack/);
  });

  it('the GDD and README document the linear/clamped curve family (AH-0MV8GPGBL009M0D8)', () => {
    // The power-up side now mixes exponential-saturation with the
    // linear-clamped curve for additive-capped schedules (the Smart Bomb
    // radius/interval); both curves must stay documented.
    expect(gdd).toMatch(/linear[/-]clamped/);
    expect(gdd).toContain('clamp(base + k × level, [min(base, cap), max(base, cap)])');
    expect(readme).toMatch(/linear[/-]clamped/);
  });

  it('the GDD and README document the re-balanced Smart Bomb radius and interval (AH-0MV8GPGBL009M0D8)', () => {
    // The old screen-wide smart bomb (1200 → 2400 px, 0.2/s → 0.5/s) is
    // replaced by a modest 200 → 400 px ship-centred radius pulsing on a
    // 30 → 10 s interval; the docs must record the new schedules.
    expect(gdd).toMatch(/200\s*→\s*400/);
    expect(gdd).toMatch(/30\s*s?\s*→\s*10\s*s/);
    expect(readme).toMatch(/200\s*→\s*400/);
    expect(readme).toMatch(/30\s*→\s*10\s*s/);
  });

  it('the README points at the power-up leveling module and resolver', () => {
    expect(readme).toContain('src/powerups/powerUpLevels.ts');
    expect(readme).toContain('resolvePowerUpAtLevel');
    expect(readme).toMatch(/power-up leveling/i);
  });
});

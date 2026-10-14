/**
 * Docs guard for the wave balance rules (AH-0MV84U0Y2006KXE8; parent
 * AH-0MV29XQ0H009P9WP, F6; covers parent AC6).
 *
 * This is a deliberate docs grep: the deliverable of F6 is the documentation
 * of the wave balance rules R1–R3 and their cross-linking from the README and
 * the Game Design Document, so this guard fails if that documentation is
 * removed or the classification regresses to "data-only". It does not assert
 * rule behaviour — that is covered by `src/core/waveBalance.test.ts`,
 * `src/core/difficultySequencer.test.ts` and
 * `src/waves/campaignBalanceAudit.test.ts`.
 *
 * Acceptance criteria validated:
 *
 * - AC6: the enemy guide §1.5 documents R1–R3, the effective-attack
 *   semantics, every named tunable constant, the generator enforcement and
 *   the audit validator; the README and the Game Design Document cross-link
 *   the balance rules.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const README = path.resolve(process.cwd(), 'README.md');
const GDD = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const ENEMY_GUIDE = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

describe('Wave balance rules documentation (AH-0MV84U0Y2006KXE8)', () => {
  const readme = read(README);
  const gdd = read(GDD);
  const guide = read(ENEMY_GUIDE);

  it('the enemy guide documents the R1–R3 balance section (AC6)', () => {
    expect(guide).toContain('### 1.5 Wave balance rules R1–R3');
    for (const rule of [
      'R1 — opening-wave purity',
      'R2 — no all-chaser wave',
      'R3 — bounded ranged mix',
    ]) {
      expect(guide).toContain(rule);
    }
  });

  it('the enemy guide documents every named tunable constant (AC6)', () => {
    for (const constant of [
      'OPENING_WAVE_POSITIONS',
      'OPENING_MOVEMENT_CLASSES',
      'CHASER_MOVEMENT_CLASS',
      'RANGED_ATTACK_CLASSES',
      'RANGED_SHARE_CAP',
      'DEFAULT_MOVEMENT_CLASS',
      'deriveAttackClassFromShotPattern',
    ]) {
      expect(guide).toContain(constant);
    }
  });

  it('the enemy guide documents the effective-attack semantics (AC6)', () => {
    expect(guide).toContain('effective contact');
    expect(guide).toContain('shootEnabled === false');
  });

  it('the enemy guide documents generator enforcement and the audit validator (AC6)', () => {
    expect(guide).toContain('Rules win over exact target match');
    expect(guide).toContain('auditWaves()');
    expect(guide).toContain('src/waves/campaignBalanceAudit.test.ts');
  });

  it('the enemy guide no longer describes the classification as data-only (AC6)', () => {
    expect(guide).not.toContain('data-only');
    expect(guide).not.toContain('no gameplay code reads');
  });

  it('the README and Game Design Document cross-link the balance rules (AC6)', () => {
    expect(readme).toContain('enemy guide §1.5');
    expect(readme).toContain('src/core/waveBalance.ts');
    expect(gdd).toContain('§1.5');
  });
});

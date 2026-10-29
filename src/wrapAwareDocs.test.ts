/**
 * Docs guard for the seam-awareness (`wrapAware`) documentation slice
 * (AH-0MVKXC0KS001FH9H, parent AH-0MV9G3DZ9003P7P8 AC5).
 *
 * This is a deliberate docs grep, matching the established docs-guard pattern
 * (`enemyRosterDocs.test.ts`, `gymParityDocs.test.ts`): the deliverable here is
 * prose, so the only observable behaviour is the documented text. Behaviour
 * itself is covered by the unit suites (`enemyTargeting.test.ts`,
 * `enemyWrap.test.ts`, `enemyConfig.test.ts`, `csv.test.ts`).
 *
 * Each assertion is scoped to the section that must carry the fact, so an
 * unrelated mention elsewhere in the guide cannot satisfy the guard.
 *
 * Acceptance criteria validated:
 *
 * - AC1: §1.7 documents `wrapAware` (type, default `true`, effect on aimed
 *   fire and movement) and the rationale for the `march` / `centipede`
 *   exclusions.
 * - AC2: the CSV `#` header block (and the §8.1 `EnemyConfig` table) lists
 *   `wrapAware` with its default and neutral-value semantics.
 * - AC3: the docs state the gym↔game parity obligation and the process for
 *   adding an exclusion (explicit seed entry, code comment, documented
 *   divergence).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GUIDE = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);
const CSV = path.resolve(process.cwd(), 'src/data/enemy-configs.csv');

/** Return the body of `heading` up to the next heading matching `stop`. */
function sectionBody(source: string, heading: string, stop: RegExp): string {
  const start = source.indexOf(heading);
  if (start === -1) return '';
  const rest = source.slice(start + heading.length);
  const next = rest.search(stop);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Collapse prose line-wrapping so assertions match text, not markdown wrapping. */
const prose = (source: string): string => source.replace(/\s+/g, ' ');

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

describe('wrapAware documentation (AH-0MVKXC0KS001FH9H)', () => {
  const guide = read(GUIDE);
  const seamSection = prose(
    sectionBody(guide, '### 1.7 Seam awareness', /\n## /),
  );
  const paritySection = prose(sectionBody(guide, '### 5.1 Gym parity', /\n## /));
  const configSection = prose(
    sectionBody(guide, '### 8.1 EnemyConfig shape', /\n### /),
  );
  const csvHeader = read(CSV)
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .join(' ');

  it('has the seam-awareness section and names the parameter (AC1)', () => {
    expect(guide).toContain('### 1.7 Seam awareness');
    expect(seamSection).toContain('wrapAware');
    expect(seamSection).toContain('EnemyConfig.wrapAware?: boolean');
  });

  it('documents the default and the neutral-value semantics (AC1, AC2)', () => {
    expect(seamSection).toMatch(/default is \*\*`true`\*\*/);
    expect(seamSection).toMatch(/neutral value is \*\*`true`\*\*/);
    expect(seamSection).toMatch(/absent, blank or malformed-absent/i);
  });

  it('documents the effect on aimed fire through the shared helper (AC1)', () => {
    expect(seamSection).toContain('aimVectorToTarget');
    expect(seamSection).toContain('wrappedAxisDelta');
    expect(seamSection).toMatch(/bit-identical/i);
  });

  it('documents the effect on movement through the shared seam (AC1)', () => {
    expect(seamSection).toContain('enemyWrap');
    expect(seamSection).toContain('applyPostMotionWrapAll');
    expect(seamSection).toContain('PLAYFIELD_WORLD');
    expect(seamSection).toMatch(/position-only/i);
  });

  it('no longer defers post-motion wrapping to a later slice (AC1)', () => {
    // Regression pin: the aimed-fire slice shipped with a "later slice of the
    // same epic" placeholder that this docs slice had to replace once the
    // movement slice landed.
    expect(seamSection).not.toMatch(/later slice/i);
  });

  it('documents the rationale for the march and centipede exclusions (AC1)', () => {
    expect(seamSection).toContain('WRAP_AWARE_EXCLUSION_KEYS');
    expect(seamSection).toMatch(/`march`/);
    expect(seamSection).toMatch(/reverse/);
    expect(seamSection).toMatch(/`centipede`/);
    expect(seamSection).toMatch(/weave/);
  });

  it('states the exclusion process and the parity obligation (AC3)', () => {
    expect(seamSection).toMatch(/Every new archetype is wrap-aware by default/i);
    expect(seamSection).toMatch(/never a fork/i);
    // Process: seed list, code comment, documented divergence, pinned test.
    expect(seamSection).toMatch(/`WRAP_AWARE_EXCLUSION_KEYS` in[\s\S]*configDefaults/);
    expect(seamSection).toMatch(/code comment/i);
    expect(seamSection).toMatch(/documented divergence/i);
    // Parity: the same seams run in the game and every gym.
    expect(seamSection).toMatch(/Gyms and the game run the same seams/i);
    expect(seamSection).toContain('CombatScene.equivalence.test.ts');
  });

  it('lists the post-motion wrap seam and the divergence in §5.1 (AC3)', () => {
    expect(paritySection).toContain('enemyWrap');
    expect(paritySection).toMatch(/march.*centipede.*opt out of seam awareness/i);
    expect(paritySection).toContain('WRAP_AWARE_EXCLUSION_KEYS');
  });

  it('lists wrapAware in the §8.1 EnemyConfig table with its default (AC2)', () => {
    expect(configSection).toMatch(
      /\| `wrapAware` \| `boolean\?` \|[\s\S]*Default `true`/,
    );
    expect(configSection).toContain('BaseEnemy.wrapAware');
  });

  it('documents wrapAware in the CSV header comment block (AC2)', () => {
    expect(csvHeader).toContain('wrapAware');
    expect(csvHeader).toMatch(/`true` \(the default/);
    expect(csvHeader).toMatch(/`false` opts out/);
    expect(csvHeader).toMatch(/march/);
    expect(csvHeader).toMatch(/centipede/);
  });
});

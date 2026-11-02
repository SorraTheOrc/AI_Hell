/**
 * Docs guard for the campaign-wide enemy-type variety contract
 * (AH-0MVSE7KGQ002L2E2; parent epic AH-0MVI5XXOU00954EA, parent AC8).
 *
 * This is a deliberate docs grep, matching the existing
 * `src/waveBalanceDocs.test.ts` and `src/waves/modeLedger.test.ts` precedent:
 * the deliverable of the documentation item *is* the prose, so the guard fails
 * when the documented level identities drift from `LEVEL_IDENTITY` or the
 * invariant section disappears. It does not assert rule behaviour — that is
 * covered by `src/core/waveBalance.test.ts`, `src/waves/campaignVariety.test.ts`
 * and `src/waves/campaignVerification.test.ts`.
 *
 * Acceptance criteria validated:
 *
 * - AC1: GDD §3.2 describes each level's dominant archetype and secondary mix
 *   and the default-campaign note documents the sequential-distinctness rule.
 * - AC2/AC3: the enemy guide's §1.5.10 documents the variety invariant, the
 *   shared composition-signature definition, R4 and the `LEVEL_IDENTITY` table,
 *   cross-referenced to the code modules.
 * - AC4: the identity table matches `LEVEL_IDENTITY` (the single source of
 *   truth), so prose cannot silently diverge from the shipped campaign.
 * - AC5: the README campaign and balance sections link the invariant.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { LEVEL_IDENTITY } from './campaignVariety';

const README = path.resolve(process.cwd(), 'README.md');
const GDD = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const ENEMY_GUIDE = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

/** The exact Markdown row the enemy guide publishes for one level. */
function expectedIdentityRow(level: number): string {
  const identity = LEVEL_IDENTITY[level];
  const dominant =
    identity.dominant === null ? '— (deliberate mix)' : `\`${identity.dominant}\``;
  const showcase = identity.showcase.map((key) => `\`${key}\``).join(', ');
  return `| ${level} | ${identity.label} | ${dominant} | ${showcase} |`;
}

describe('Campaign variety documentation (AH-0MVSE7KGQ002L2E2)', () => {
  const readme = read(README);
  const gdd = read(GDD);
  const guide = read(ENEMY_GUIDE);

  it('the enemy guide documents the variety invariant section (AC2/AC3)', () => {
    expect(guide).toContain('#### 1.5.10 Campaign-wide variety invariant');
    for (const phrase of [
      'AC1 — sequential distinctness',
      'AC2 — whole-campaign coverage',
      'AC3 — level identity preserved',
      'Shared composition-signature definition',
      'Mixed `fixed` / `curve` / `dynamic` mechanism',
    ]) {
      expect(guide).toContain(phrase);
    }
  });

  it('the enemy guide cross-references the shared code modules (AC2)', () => {
    for (const reference of [
      'src/waves/campaignVariety.ts',
      'src/core/waveBalance.ts',
      'src/waves/sequencedLevels.ts',
      'src/waves/Formations.ts',
      'compositionSignature()',
      'groupsComposition()',
      'waveComposition()',
      'auditCampaignVariety()',
      'SequencerOptions.avoidCompositions',
      '§1.5.4',
    ]) {
      expect(guide).toContain(reference);
    }
  });

  it('the enemy guide identity table matches LEVEL_IDENTITY exactly (AC3/AC4)', () => {
    for (const level of Object.keys(LEVEL_IDENTITY).map(Number)) {
      expect(
        guide,
        `guide identity row for level ${level}`,
      ).toContain(expectedIdentityRow(level));
    }
  });

  it('the GDD §3.2 table carries an identity column and the invariant (AC1)', () => {
    expect(gdd).toContain('Identity (dominant — secondary mix)');
    expect(gdd).toContain('**Enemy-type variety invariant');
    expect(gdd).toContain('no two sequential waves inside a level share the same enemy composition');
    expect(gdd).toContain('`LEVEL_IDENTITY`');
    expect(gdd).toContain('src/waves/campaignVariety.ts');
    expect(gdd).toContain('§1.5.10');
  });

  it('the default-campaign note documents the sequential-distinctness rule (AC1)', () => {
    expect(gdd).toContain('**Sequential-distinctness rule (parent AH-0MVI5XXOU00954EA).**');
    expect(gdd).toContain('`avoidCompositions`');
    expect(gdd).toContain('`auditCampaignVariety()`');
    expect(gdd).toContain('campaignVariety.test.ts');
  });

  it('the README campaign and balance sections link the invariant (AC5)', () => {
    expect(readme).toContain('no two sequential waves inside a level share the same enemy composition');
    expect(readme).toContain('src/waves/campaignVariety.ts');
    expect(readme).toContain('enemy guide §1.5.10');
  });
});

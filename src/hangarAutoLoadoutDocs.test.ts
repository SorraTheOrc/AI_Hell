/**
 * Docs guard: the auto-fit loadout rule is documented
 * (AH-0MWOWEYZQ006IR9T, parent AH-0MWOROJYT004WPSD AC10, documenting the
 * shipped behaviour AH-0MWOWEPO2004B0MR).
 *
 * The shipped hangar fits a boss-aware suggestion when it opens on an empty
 * loadout, and offers one explicit `⚡ APPLY SUGGESTED BUILDOUT` row for every
 * other case. Three surfaces carry that rule: the GDD's *Hangar economy and
 * unlock tree* section (the design of record), `docs/GYM_PARITY.md` (the
 * `GymHangar` row proves the selector is shared core, not a gym copy) and the
 * module JSDoc of `hangarAutoLoadout.ts` / `hangarScreen.ts`.
 *
 * These are deliberate docs greps — structure and required terms only, never
 * prose wording — matching `src/buyToUpgradeDocs.test.ts`. The red-before
 * cases are the missing statements: the rule, the empty-loadout trigger, the
 * explicit control and the shared-consumer record.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const GDD = read('docs/Game Design Document.md');
const GYM_PARITY = read('docs/GYM_PARITY.md');
const OUTER_LOOP = read('docs/OUTER_LOOP_CANDIDATES.md');
const README = read('README.md');
const AUTO_LOADOUT_MODULE = read('src/core/hangarWar/hangarAutoLoadout.ts');
const HANGAR_SCREEN_MODULE = read('src/scenes/hangarWar/hangarScreen.ts');

/**
 * The `#### The auto-fit loadout rule` subsection body — the design of record
 * for this rule, up to the next `####` heading.
 */
function autoFitSection(): string {
  const heading = /^####\s+The auto-fit loadout rule\s*$/m.exec(GDD);
  if (!heading || heading.index === undefined) return '';
  const rest = GDD.slice(heading.index + heading[0].length);
  const next = /\n####\s/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The cells of one `GymHangar`-style matrix row, or `[]` when absent. */
function rowCells(matrix: string, scene: string): string[] {
  const line = matrix
    .split('\n')
    .find((candidate) => candidate.startsWith(`| \`${scene}\``));
  return line === undefined ? [] : line.split('|').map((cell) => cell.trim());
}

/** The module-level JSDoc block of a source file (up to its `@module` tag). */
function moduleJsdoc(source: string): string {
  const start = source.indexOf('/**');
  const tag = source.indexOf('@module');
  if (start < 0 || tag < 0) return '';
  const close = source.indexOf('*/', tag);
  return close < 0 ? source.slice(start) : source.slice(start, close);
}

describe('the design of record states the auto-fit loadout rule (AH-0MWOWEYZQ006IR9T)', () => {
  it('GDD § Hangar economy and unlock tree carries an auto-fit loadout subsection', () => {
    const section = autoFitSection();
    expect(section.trim().length).toBeGreaterThan(400);
    // The shipped behaviour and the documenting item are both named.
    expect(section).toContain('AH-0MWOWEPO2004B0MR');
    expect(section).toContain('AH-0MWOWEYZQ006IR9T');
  });

  it('states that an empty loadout is auto-fitted when the hangar opens', () => {
    const section = autoFitSection();
    expect(section).toMatch(/auto-fits?\b|auto-fit\b/i);
    expect(section).toMatch(/empty/i);
    expect(section).toMatch(/hangar opens|on open|when the hangar opens/i);
    // The trigger is the raw persisted list, not a matchup verdict.
    expect(section).toContain('isDefaultHangarLoadout');
    expect(section).toMatch(/never "the selector found no strong weapon"/i);
  });

  it('states that a deliberate loadout is preserved', () => {
    const section = autoFitSection();
    expect(section).toMatch(/preserved/i);
    expect(section).toMatch(/deliberate|hand-picked/i);
    expect(section).toMatch(/never silently rewritten|never rewritten/i);
  });

  it('states that the explicit apply-suggested-buildout control applies on demand', () => {
    const section = autoFitSection();
    expect(section).toContain('⚡ APPLY SUGGESTED BUILDOUT');
    expect(section).toMatch(/on demand/i);
    // The row is the only path that replaces a hand-picked loadout.
    expect(section).toMatch(/only\b[^.]*path/i);
  });

  it('keeps the starter-never-auto-equips rule intact (ownership alone never equips)', () => {
    const section = autoFitSection();
    expect(section).toMatch(/starter/i);
    expect(section).toMatch(/owning|ownership/i);
    expect(section).toMatch(/never auto-equips/i);
    // The old bare "default-empty" wording is superseded, not contradicted.
    expect(section).toMatch(/supersed/i);
    expect(section).toMatch(/legal/i);
  });

  it('records the selection rule: strong first, weak never, one per family, then level', () => {
    const section = autoFitSection();
    expect(section).toMatch(/strong weapons first/i);
    expect(section).toMatch(/weak\b[^.]*never selected|never selected[^.]*weak/i);
    expect(section).toMatch(/at most one weapon per behaviour family/i);
    expect(section).toMatch(/defensive power-up/i);
    expect(section).toMatch(/highest permanent level/i);
    expect(section).toMatch(/catalogue order/i);
  });

  it('bounds the rule by the one shared six-slot cap and the one-rule constraint', () => {
    const section = autoFitSection();
    expect(section).toContain('POWER_UP_SLOT_CAP');
    expect(section).toMatch(/six-slot/i);
    expect(section).toMatch(/one shared|single pure rule|one pure rule/i);
    // The rule lives in the shared selector module, never in scene code.
    expect(section).toContain('src/core/hangarWar/hangarAutoLoadout.ts');
    expect(section).toContain('selectAutoLoadout');
  });
});

describe('docs/GYM_PARITY.md records the shared auto-loadout selector (AH-0MWOWEYZQ006IR9T)', () => {
  it('names the documenting item in the provenance table', () => {
    expect(GYM_PARITY).toContain('AH-0MWOWEYZQ006IR9T');
    expect(GYM_PARITY).toMatch(/auto-fit loadout/i);
  });

  it('records the selector and the new row as the GymHangar enabled objects', () => {
    const cells = rowCells(GYM_PARITY, 'GymHangar');
    expect(cells.length).toBeGreaterThan(7);
    // The suggestion and its row are shared model output, not gym code.
    expect(cells[3]).toContain('selectAutoLoadout');
    expect(cells[3]).toContain('⚡ APPLY SUGGESTED BUILDOUT');
    // The gym renders the model's row read-only.
    expect(cells[3]).toMatch(/read-only/i);
  });

  it('records the game-only auto-fit and the shared read-only render in the reason cell', () => {
    const cells = rowCells(GYM_PARITY, 'GymHangar');
    expect(cells[7]).toContain('AH-0MWOWEYZQ006IR9T');
    expect(cells[7]).toContain('isDefaultHangarLoadout');
    expect(cells[7]).toContain('HangarScene');
    // The gym performs no fit and no apply, so the rule cannot drift.
    expect(cells[7]).toMatch(/no fit|performs no/i);
    expect(cells[7]).toMatch(/read-only/i);
  });
});

describe('the surrounding docs agree with the rule (AH-0MWOWEYZQ006IR9T)', () => {
  it('README names the auto-fit trigger and the explicit row', () => {
    expect(README).toMatch(/auto-fits/i);
    expect(README).toContain('⚡ APPLY SUGGESTED BUILDOUT');
    expect(README).toContain('AH-0MWOWEYZQ006IR9T');
  });

  it('OUTER_LOOP Candidate B keeps the owned-not-equipped decision beside the rule', () => {
    expect(OUTER_LOOP).toMatch(/owned\*\*, not equipped/i);
    expect(OUTER_LOOP).toContain('⚡ APPLY SUGGESTED BUILDOUT');
    expect(OUTER_LOOP).toContain('AH-0MWOWEPO2004B0MR');
  });
});

describe('the module JSDoc documents the rule, the trigger and the button (AH-0MWOWEYZQ006IR9T)', () => {
  it('hangarAutoLoadout.ts documents the rule, the empty-loadout trigger and the row', () => {
    const jsdoc = moduleJsdoc(AUTO_LOADOUT_MODULE);
    expect(jsdoc.trim().length).toBeGreaterThan(0);
    expect(jsdoc).toMatch(/auto-fit/i);
    expect(jsdoc).toContain('isDefaultHangarLoadout');
    expect(jsdoc).toContain('⚡ APPLY SUGGESTED BUILDOUT');
    // Consumed by the game and by GymHangar.
    expect(jsdoc).toContain('GymHangar');
  });

  it('hangarScreen.ts documents the rule, the empty-loadout trigger and the row', () => {
    const jsdoc = moduleJsdoc(HANGAR_SCREEN_MODULE);
    expect(jsdoc.trim().length).toBeGreaterThan(0);
    expect(jsdoc).toContain('selectAutoLoadout');
    expect(jsdoc).toMatch(/auto-fit/i);
    expect(jsdoc).toContain('isDefaultHangarLoadout');
    expect(jsdoc).toContain('⚡ APPLY SUGGESTED BUILDOUT');
  });
});

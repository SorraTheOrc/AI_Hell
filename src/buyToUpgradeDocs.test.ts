/**
 * Docs guard: the hangar's buy-to-upgrade path is the permanent-upgrade source
 * of record (AH-0MWI5AQSJ000J0BM, parent AH-0MWHW4ALS0039JFU).
 *
 * The shipped hangar lets the player spend banked minerals/cores to raise the
 * **permanent level** of an already-owned level-bearing **weapon** — a
 * persistent path that is distinct from the run's in-run pickup and hold-full
 * rewards, whose permanent component dies with the run. Two producer decisions
 * shape the rule: one shared `MAX_PERMANENT_LEVEL` ceiling (Q1 = a) and
 * **level-bearing kinds only** (Q2 = a), so a consumable's charge pool and the
 * field-pickup-only kind are refused as `non-upgradeable`. Power-up ownership
 * and its upgrade path are **deferred** to AH-0MWKT12BT001106T — a hangar
 * power-up's first permanent level row has no shipped acquisition source — so
 * the design of record must not claim power-ups are upgradeable in play today.
 *
 * These are deliberate docs greps — structure and required terms only, never
 * prose wording — serving the same purpose as
 * `src/hexDefenderRatingDocs.test.ts` and
 * `src/outerLoopCandidatesDocs.test.ts`. The code-comment half of the guard
 * exists because the run-level docs used to say a permanent level comes from
 * hold-full rewards **only**, which stopped being the whole truth once the
 * hangar sold a level.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const GDD = read('docs/Game Design Document.md');
const OUTER_LOOP = read('docs/OUTER_LOOP_CANDIDATES.md');
const PLAYER = read('src/entities/Player.ts');
const POWER_UP_LEVELS = read('src/powerups/powerUpLevels.ts');
const EFFECTS = read('src/powerups/effects.ts');
const POWER_UP_TYPES = read('src/powerups/types.ts');

/** The §8.2 body (up to the level-2 heading `9. Appendix`). */
const gdd82Body = (): string => {
  const start = GDD.search(/^###\s+8\.2\s/m);
  if (start < 0) return '';
  const rest = GDD.slice(start);
  const next = /\n##\s+9\./.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};

/** The buy-to-upgrade subsection of §8.2 (heading plus body, up to the next `####`). */
const gddBuyToUpgradeSection = (): string => {
  const body = gdd82Body();
  const heading = /^####\s+Buying permanent levels[^\n]*$/m.exec(body);
  if (!heading || heading.index === undefined) return '';
  const rest = body.slice(heading.index);
  const next = /\n####\s/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};

/** The §8.2 capture-cycle body (up to the next `####` heading). */
const gddCaptureCycleSection = (): string => {
  const heading = /^####\s+The capture cycle\s*$/im.exec(GDD);
  if (!heading || heading.index === undefined) return '';
  const rest = GDD.slice(heading.index + heading[0].length);
  const nextHeading = /\n####\s/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
};

/** The 'leave a defending bot' step of the capture cycle (step 3). */
const gddLeaveDefenderStep = (): string => {
  const section = gddCaptureCycleSection();
  const start = section.search(/^\s*3\.\s+\*\*Leave a defending bot\.\*\*/m);
  if (start < 0) return '';
  const rest = section.slice(start);
  const nextStep = /\n\s*4\.\s+\*\*/.exec(rest);
  return nextStep ? rest.slice(0, nextStep.index) : rest;
};

/** Candidate D's body, up to the next level-2 heading. */
const candidateDBody = (): string => {
  const heading = /^##\s+Candidate D\s*[—–-]\s*Hangar War\s*$/im.exec(OUTER_LOOP);
  if (!heading || heading.index === undefined) return '';
  const rest = OUTER_LOOP.slice(heading.index + heading[0].length);
  const nextHeading = /\n##\s+/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
};

describe('the design of record names the hangar buy-to-upgrade path (AH-0MWI5AQSJ000J0BM)', () => {
  it('GDD §8.2 has a buy-to-upgrade subsection inside the hangar economy', () => {
    const section = gddBuyToUpgradeSection();
    expect(section.trim().length).toBeGreaterThan(200);
    expect(section).toMatch(/buy-to-upgrade/i);
  });

  it('GDD §8.2 makes the hangar purchase the permanent weapon-upgrade source, distinct from the run path', () => {
    const section = gddBuyToUpgradeSection();
    expect(section).toMatch(/permanent/i);
    expect(section).toMatch(/weapon/i);
    expect(section).toMatch(/minerals/i);
    expect(section).toMatch(/cores/i);
    // Distinct from the in-run pickup / hold-full reward path.
    expect(section).toMatch(/distinct from/i);
    expect(section).toMatch(/in-run|hold-full|pickup/i);
  });

  it('GDD §8.2 documents the one shared MAX_PERMANENT_LEVEL ceiling (producer Q1 = a)', () => {
    const section = gddBuyToUpgradeSection();
    expect(section).toMatch(/MAX_PERMANENT_LEVEL/);
    expect(section).toMatch(/Q1 = \(a\)/i);
    expect(section).toMatch(/ceiling|cap/i);
    // The ceiling is one authored number, not a parallel copy.
    expect(section).toMatch(/one shared|single|read by both|one authored/i);
  });

  it('GDD §8.2 documents the level-bearing-only rule (producer Q2 = a)', () => {
    const section = gddBuyToUpgradeSection();
    expect(section).toMatch(/level-bearing/i);
    expect(section).toMatch(/Q2 = \(a\)/i);
    expect(section).toMatch(/consumable/i);
    expect(section).toMatch(/field-pickup-only/i);
    expect(section).toMatch(/non-upgradeable/i);
  });

  it('GDD §8.2 records the power-up deferral and does not claim power-ups are upgradeable in play', () => {
    const section = gddBuyToUpgradeSection();
    expect(section).toMatch(/AH-0MWKT12BT001106T/);
    expect(section).toMatch(/deferred/i);
    expect(section).toMatch(/power-up/i);
    // The section is explicit that power-ups are not upgradeable in play today.
    expect(section).toMatch(/(not|never)\b[^.]*\bupgradeable in play/i);
  });

  it('GDD §8.2 capture cycle records that a defender inherits hangar-bought weapon levels at capture time', () => {
    const step = gddLeaveDefenderStep();
    expect(step.trim().length).toBeGreaterThan(0);
    expect(step).toMatch(/hangar-bought/i);
    expect(step).toMatch(/weapon level/i);
    expect(step).toMatch(/capture time/i);
    expect(step).toMatch(/AH-0MWH42DWQ004SAOJ/);
  });

  it('OUTER_LOOP Candidate D records the same upgrade source, ceiling, level rule and deferral', () => {
    const body = candidateDBody();
    expect(body).toMatch(/buy-to-upgrade/i);
    expect(body).toMatch(/permanent/i);
    expect(body).toMatch(/weapon/i);
    expect(body).toMatch(/MAX_PERMANENT_LEVEL/);
    expect(body).toMatch(/Q1 = \(a\)/i);
    expect(body).toMatch(/level-bearing/i);
    expect(body).toMatch(/Q2 = \(a\)/i);
    expect(body).toMatch(/AH-0MWKT12BT001106T/);
    expect(body).toMatch(/deferred/i);
    expect(body).toMatch(/AH-0MWH42DWQ004SAOJ/);
  });

  it('the weapon-level comment names the hangar path instead of hold-full rewards only', () => {
    expect(PLAYER).not.toMatch(/component \(hold-full rewards only\)/);
    expect(PLAYER).toMatch(/permanent\*\*[^]{0,200}?component[^]{0,300}?hangar/i);
  });

  it('the power-up level docs name the deferred hangar path beside the permanent-component rule', () => {
    // Power-ups genuinely have no in-play purchase source yet, so the in-run
    // statement stays — but it must point at the deferred hangar path rather
    // than reading as the only path forever.
    for (const source of [POWER_UP_LEVELS, EFFECTS, POWER_UP_TYPES]) {
      expect(source).toMatch(/hold-full rewards/i);
      expect(source).toMatch(/AH-0MWKT12BT001106T/);
      expect(source).toMatch(/buy-to-upgrade|hangar/i);
    }
  });
});

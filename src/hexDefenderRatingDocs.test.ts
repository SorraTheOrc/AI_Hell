/**
 * Docs guard: the defender-rating rule change is the design of record
 * (AH-0MWHF75EY004LRBA, parent AH-0MWH42DWQ004SAOJ).
 *
 * The design of record previously stated that a defending bot's rating comes
 * from the hull's hangar upgrades **only** (GDD §8.2 capture-cycle step 3 and
 * Candidate D's intake assumption A4). Shipped behaviour superseded the rule:
 * a captured hex's defending bot now carries the run's permanent upgrades at
 * capture time — weapon levels, power-up levels and owned consumable charges —
 * converted through the economy's one mapping table into
 * `hull rating + 3 × armour + 2 × firepower + 2 × systems`. A document that
 * still states the hangar-only rule would contradict the implementation, so
 * these are deliberate docs greps — structure and required terms only, never
 * prose wording — serving the same purpose as `src/outerLoopCandidatesDocs.test.ts`
 * and `src/defenceReportRolledInDocs.test.ts`.
 *
 * The balance consequence (producer decision Q3 = A: the frontier aggression
 * budget is unchanged, so defence simply gets easier) is asserted as an
 * **accepted** consequence, not a bug.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const GDD = read('docs/Game Design Document.md');
const OUTER_LOOP = read('docs/OUTER_LOOP_CANDIDATES.md');
const README = read('README.md');
const TYPES = read('src/core/hangarWar/types.ts');
const HEX_DEFENCE = read('src/core/hangarWar/hexDefence.ts');

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
  return nextStep ? rest.slice(0, nextStep.index) : '';
};

/** The §8.1 paragraph introducing the defender-rating formula. */
const gddFormulaParagraph = (): string => {
  // The formula is introduced as "...lives here, and the defender-rating
  // formula (...) is defined once so phase B's defence resolver has no second
  // source of truth."
  const idx = GDD.indexOf('defender-rating formula');
  if (idx < 0) return '';
  return GDD.slice(Math.max(0, idx - 200), idx + 1600);
};

/** Candidate D's body, up to the next level-2 heading. */
const candidateDBody = (): string => {
  const heading = /^##\s+Candidate D\s*[—–-]\s*Hangar War\s*$/im.exec(OUTER_LOOP);
  if (!heading || heading.index === undefined) return '';
  const rest = OUTER_LOOP.slice(heading.index + heading[0].length);
  const nextHeading = /\n##\s+/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
};

/** The `Defending bot assignment` row of Candidate D's systems table. */
const defendingBotAssignmentRow = (): string => {
  const row = candidateDBody()
    .split('\n')
    .find((line) => line.includes('**Defending bot assignment**'));
  return row ?? '';
};

describe('the design of record describes the capture-cycle rating rule (AH-0MWHF75EY004LRBA)', () => {
  it('GDD capture-cycle step 3 records that the rating carries the run\'s permanent upgrades', () => {
    const step = gddLeaveDefenderStep();
    expect(step.trim().length).toBeGreaterThan(0);
    expect(step).toMatch(/carries the run's permanent upgrades at capture time/i);
    // The step keeps the no-flown-battle rule.
    expect(step).toMatch(/never a flown\s+battle/i);
  });

  it('GDD capture-cycle step 3 gives the hull rating plus contribution total with the shipped weights', () => {
    const step = gddLeaveDefenderStep();
    expect(step).toMatch(/3 × armour/i);
    expect(step).toMatch(/2 × firepower/i);
    expect(step).toMatch(/2 × systems/i);
    expect(step).toMatch(/hull rating/i);
    // The bare-hull reference points stay (Scrap/Bulwark/Juggernaut).
    expect(step).toMatch(/Scrap Hull/i);
    expect(step).toMatch(/Juggernaut Hull/i);
  });

  it('GDD §8.1 formula paragraph describes the upgrade contribution and the mapping table', () => {
    const paragraph = gddFormulaParagraph();
    expect(paragraph).toMatch(/UPGRADE_STAT_BUCKETS/);
    expect(paragraph).toMatch(/firepower/i);
    expect(paragraph).toMatch(/armour/i);
    expect(paragraph).toMatch(/systems/i);
    expect(paragraph).toMatch(/hull rating \+ 3 × armour \+ 2 × firepower \+ 2 × systems/i);
  });

  it('GDD documents the balance consequence as accepted (producer decision Q3 = A)', () => {
    const gdd = gddLeaveDefenderStep() + gddFormulaParagraph();
    expect(gdd).toMatch(/Q3 = A/i);
    expect(gdd).toMatch(/accepted consequence/i);
    expect(gdd).toMatch(/defence simply gets easier/i);
  });

  it('OUTER_LOOP Defending bot assignment row records the run\'s upgrades at capture time', () => {
    const row = defendingBotAssignmentRow();
    expect(row).toMatch(/carries the run's permanent upgrades at capture time/i);
    expect(row).toMatch(/never from a live battle/i);
    expect(row).toMatch(/3 × armour/i);
  });

  it('OUTER_LOOP records that intake assumption A4 is superseded, not still the rule', () => {
    const body = candidateDBody();
    expect(body).toMatch(/intake assumption A4/i);
    expect(body).toMatch(/supersed\w*/i);
    expect(body).toMatch(/Q3 = A/i);
  });

  it('README states the left bot keeps the run\'s permanent upgrades', () => {
    expect(README).toMatch(/keeps the run's permanent/i);
    expect(README).toMatch(/owned consumable charges/i);
  });

  it('code comments describe the snapshot contribution, not the hangar-only rule', () => {
    // types.ts no longer resolves the rating from the hull's hangar upgrades
    // alone; hexDefence.ts no longer says "(from the hull's hangar upgrades)".
    expect(TYPES).toMatch(/permanent-upgrade contribution/i);
    expect(HEX_DEFENCE).toMatch(/permanent-upgrade contribution/i);
    expect(TYPES).not.toMatch(/Defence strength resolved from the hull's hangar upgrades\./);
    expect(HEX_DEFENCE).not.toMatch(/from the hull's hangar upgrades\./);
  });
});

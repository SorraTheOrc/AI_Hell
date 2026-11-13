/**
 * Docs guard: the between-sortie defence report is documented as **rolled into
 * the hex map** (attack arrows + left-hand attack panel), never as a standalone
 * screen (AH-0MWEXJ7VJ007XTCQ, parent AH-0MWDC3L9I008INDP).
 *
 * The report screen was removed from the shipped scene array and its content
 * moved onto `HexMapScene`; a document that still names the old screen would
 * send a reader looking for a transition that no longer exists. These are
 * deliberate docs greps — structure and required terms only, never prose
 * wording — serving the same purpose as `src/outerLoopCandidatesDocs.test.ts`
 * and `src/scenes/core/gymParityDocs.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const README = read('README.md');
const GDD = read('docs/Game Design Document.md');
const OUTER_LOOP = read('docs/OUTER_LOOP_CANDIDATES.md');
const GYM_PARITY = read('docs/GYM_PARITY.md');
const GAMEPLAY_CAPTURE = read('docs/dev/gameplay-capture.md');

/** The docs that described the removed standalone report screen. */
const ROLLED_IN_DOCS: ReadonlyArray<[string, string]> = [
  ['README.md', README],
  ['docs/Game Design Document.md', GDD],
  ['docs/OUTER_LOOP_CANDIDATES.md', OUTER_LOOP],
  ['docs/GYM_PARITY.md', GYM_PARITY],
  ['docs/dev/gameplay-capture.md', GAMEPLAY_CAPTURE],
];

/** The §8.2 section body for `#### The defence report` (up to the next `####`). */
const gddDefenceReportSection = (): string => {
  const heading = /^####\s+The defence report\s*$/im.exec(GDD);
  if (!heading || heading.index === undefined) return '';
  const rest = GDD.slice(heading.index + heading[0].length);
  const nextHeading = /\n####\s/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
};

/** Candidate D's `### UI / scene surface` body (up to the next `###`). */
const candidateDSurfaceSection = (): string => {
  const candidate = /^##\s+Candidate D\s*[—–-]\s*Hangar War\s*$/im.exec(OUTER_LOOP);
  if (!candidate || candidate.index === undefined) return '';
  const bodyStart = candidate.index + candidate[0].length;
  const candidateRest = OUTER_LOOP.slice(bodyStart);
  const nextCandidate = /\n##\s+/.exec(candidateRest);
  const body = nextCandidate
    ? candidateRest.slice(0, nextCandidate.index)
    : candidateRest;
  const heading = /^###\s+UI \/ scene surface\s*$/im.exec(body);
  if (!heading || heading.index === undefined) return '';
  const rest = body.slice(heading.index + heading[0].length);
  const nextHeading = /\n###\s/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
};

describe('the between-sortie report is documented as rolled into the map (AH-0MWEXJ7VJ007XTCQ)', () => {
  it.each(ROLLED_IN_DOCS)(
    '%s no longer names a standalone `DefenceReportScene`',
    (_label, doc) => {
      expect(doc).not.toContain('DefenceReportScene');
    },
  );

  it('README describes the map carrying the report, not a report scene', () => {
    // The scene list keeps `HexMapScene` and states the report sits on it.
    expect(README).toMatch(/`HexMapScene`[^\n]*between-sortie defence report/);
    expect(README).toMatch(/no separate report screen/i);
    // The old standalone bullet is gone: the scene list is one entry shorter.
    expect(README).not.toMatch(/^- `DefenceReportScene`/m);
  });

  it('GDD §8.2 describes the map-integrated report surface', () => {
    const section = gddDefenceReportSection();
    expect(section.trim().length).toBeGreaterThan(0);
    // The surface: rolled into the map, arrows on the ring, a left-hand panel.
    expect(section).toMatch(/rolled into the hex map/i);
    expect(section).toContain('HexMapScene');
    expect(section).toMatch(/attack arrow/i);
    expect(section).toMatch(/left-hand attack panel/i);
    // The record is carried as transient launch data, not persisted.
    expect(section).toMatch(/transient launch data/i);
    // The no-battle rule survives the move.
    expect(section).toMatch(/no battle was\s+simulated/i);
  });

  it('GDD lists two Hangar War screens and lands the report on the map', () => {
    expect(GDD).toMatch(/runs\nthrough two screens/);
    expect(GDD).not.toMatch(/`DefenceReportScene`/);
    // A winning deployment's order is reward overlay → map, not → report → map.
    expect(GDD).toMatch(/mini-boss \*\*reward\*\* overlay[\s\S]{0,220}?`HexMapScene`/);
  });

  it('OUTER_LOOP Candidate D describes the report rolled into the ring map', () => {
    const surface = candidateDSurfaceSection();
    expect(surface.trim().length).toBeGreaterThan(0);
    expect(surface).toMatch(/rolled into the hex ring map/i);
    expect(surface).toMatch(/attack arrow/i);
    expect(surface).toMatch(/left-hand attack panel/i);
    // The attract bot has no report step to auto-advance.
    expect(OUTER_LOOP).toMatch(/no report step to auto-advance/i);
  });

  it('gameplay-capture documents two Hangar War capture targets and the map landing', () => {
    expect(GAMEPLAY_CAPTURE).toMatch(/The two screens are registered in/);
    // The map is named as the post-deployment capture surface.
    expect(GAMEPLAY_CAPTURE).toMatch(/lands on `HexMapScene`/);
    // The old three-screen list is gone.
    expect(GAMEPLAY_CAPTURE).not.toMatch(/`HangarScene`\/`HexMapScene`\/`DefenceReportScene`/);
  });
});

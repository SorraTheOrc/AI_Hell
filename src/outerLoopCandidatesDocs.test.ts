/**
 * Docs guard for the outer-loop candidates document (AH-0MVRNIWHG0099ZS3).
 *
 * This is a deliberate docs grep: it asserts the canonical structure of the
 * design deliverable, not source behaviour. The deliverable is
 * `docs/OUTER_LOOP_CANDIDATES.md`, the decision-ready catalogue of outer-loop
 * candidates for the game (parent AH-0MVNSSY9L001P1CC).
 *
 * It follows the sibling convention established by
 * `src/classicPowerUpWeaponResearchDocs.test.ts` (and
 * `src/classicEnemyResearchDocs.test.ts`) for research catalogues.
 *
 * The guard asserts **headings and required terms only, never prose wording**,
 * so the document stays freely editable by the content slice and by later
 * revisions.
 *
 * Acceptance criteria validated:
 *
 * - AC1: The document exists, frames the problem with the inner/middle/outer
 *   tier definitions and the comparison criteria, and states it is design-only.
 * - AC2/AC3: Each of the three candidates carries the twelve required section
 *   headings.
 * - AC4: A comparison section carries a ranked comparison table.
 * - AC5: The "Considered but not selected" and "Producer decision record"
 *   sections exist.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(
  process.cwd(),
  'docs/OUTER_LOOP_CANDIDATES.md',
);

/** The three loop tiers the document must define. */
const TIERS = ['Inner', 'Middle', 'Outer'];

/** The comparison criteria agreed in the work item. */
const CRITERIA = [
  /fiction/i,
  /reuse of shipped systems/i,
  /new[- ]system cost/i,
  /persistence complexity/i,
  /session[- ]length fit/i,
  /legibility of progress/i,
  /gym\s*\/\s*bot testability/i,
  /trivialis/i,
];

/**
 * The three candidates, each keyed by the `## Candidate ...` heading it must
 * carry. Candidates B and C are the two additional directions; Candidate A is
 * the producer's proposal recorded as proposed.
 */
const CANDIDATES = [
  {
    label: 'Candidate A — Contested Regions / Home World',
    heading: /^##\s+Candidate A\s*[—–-]\s*Contested Regions\s*\/\s*Home World\s*$/im,
  },
  {
    label: 'Candidate B — Salvage Fleet',
    heading: /^##\s+Candidate B\s*[—–-]\s*Salvage Fleet\s*$/im,
  },
  {
    label: 'Candidate C — Signal Decode',
    heading: /^##\s+Candidate C\s*[—–-]\s*Signal Decode\s*$/im,
  },
];

/** The twelve required `###` section headings per candidate. */
const REQUIRED_SECTIONS = [
  'Fantasy / pitch',
  'Loop structure',
  'States',
  'New systems required',
  'Reuse of existing systems',
  'Persistence and save model',
  'Session shape',
  'UI / scene surface',
  'Gym testability and the bot',
  'Pillar impact',
  'Effort and risk',
  'Minimal first slice',
];

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Locate `## Candidate ...`'s body: up to the next level-2 heading. */
const candidateSection = (doc: string, heading: RegExp): string => {
  const match = heading.exec(doc);
  if (!match || match.index === undefined) return '';
  const start = match.index;
  const rest = doc.slice(start + match[0].length);
  const nextHeading = /\n##\s+/.exec(rest);
  return nextHeading
    ? rest.slice(0, nextHeading.index)
    : rest;
};

const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

describe('Outer-loop candidates are documented (AH-0MVRNIWHG0099ZS3)', () => {
  it('the outer-loop candidates document exists (AC1)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  // ── AC1: framing — design-only statement, tiers, criteria ───────────

  it('states that the document is design-only and nothing is scheduled (AC1)', () => {
    expect(doc.search(/design[- ]only/i)).toBeGreaterThan(-1);
    expect(doc.search(/not scheduled/i)).toBeGreaterThan(-1);
  });

  it('defines the inner/middle/outer loop tiers (AC1)', () => {
    const tierTable = doc.search(/\|\s*Tier\s*\|/i);
    expect(tierTable).toBeGreaterThan(-1);
    const table = doc.slice(tierTable, tierTable + 1500);
    for (const tier of TIERS) {
      expect(table).toMatch(new RegExp(`\\b${tier}\\b`, 'i'));
    }
    // Timescales: seconds (inner), a run (middle), hours (outer).
    expect(table).toMatch(/seconds/i);
    expect(table).toMatch(/\brun\b/i);
    expect(table).toMatch(/hours/i);
    // The outer loop is the one that does not exist today.
    expect(table).toMatch(/\b(no|does not exist|not)\b/i);
  });

  it('publishes the comparison criteria before the candidates (AC1, AC4)', () => {
    const criteriaIdx = doc.search(/comparison criteria/i);
    const firstCandidateIdx = CANDIDATES[0].heading.exec(doc)?.index ?? -1;
    expect(criteriaIdx).toBeGreaterThan(-1);
    expect(firstCandidateIdx).toBeGreaterThan(criteriaIdx);
    // Every agreed criterion is named.
    for (const criterion of CRITERIA) {
      expect(criteriaIdx >= 0 ? doc.slice(criteriaIdx, firstCandidateIdx) : doc).toMatch(
        criterion,
      );
    }
  });

  // ── AC2/AC3: three candidates, twelve headings each ─────────────────

  describe.each(CANDIDATES.map((candidate) => [candidate.label, candidate.heading] as const))(
    '%s',
    (_label, heading) => {
      const body = candidateSection(doc, heading);

      it('exists as a level-2 section (AC2/AC3)', () => {
        expect(heading.exec(doc)).not.toBeNull();
      });

      it.each(REQUIRED_SECTIONS)(
        'carries the "%s" heading (AC2/AC3)',
        (section) => {
          const headingPattern = new RegExp(
            `^###\\s+${escapeRegExp(section)}\\s*$`,
            'im',
          );
          expect(body).toMatch(headingPattern);
        },
      );
    },
  );

  // ── AC4: comparison table ──────────────────────────────────────────

  it('contains a "Comparison" section with a criteria comparison table (AC4)', () => {
    const comparisonHeading = /^##\s+Comparison\s*$/im.exec(doc);
    expect(comparisonHeading).not.toBeNull();
    const start = comparisonHeading?.index ?? 0;
    const afterHeading = doc.slice(start + (comparisonHeading?.[0].length ?? 0));
    const nextHeading = /\n##\s+/.exec(afterHeading);
    const section = nextHeading
      ? afterHeading.slice(0, nextHeading.index)
      : afterHeading;

    // A markdown table: a header row, a separator row, at least one body row.
    expect(section).toMatch(/\|.*\|/);
    expect(section).toMatch(/\|[\s:-]+\|/);
    // The table compares all three candidates on the agreed criteria.
    expect(section).toMatch(/Candidate A/i);
    expect(section).toMatch(/Candidate B/i);
    expect(section).toMatch(/Candidate C/i);
    expect(section).toMatch(/recommend/i);
  });

  // ── AC5: deferrals and the staged producer decision ────────────────

  it('contains a "Considered but not selected" section (AC5)', () => {
    expect(doc).toMatch(/^##\s+Considered but not selected\s*$/im);
  });

  it('contains a "Recommendation" section (AC4)', () => {
    expect(doc).toMatch(/^##\s+Recommendation\s*$/im);
  });

  it('contains a pending "Producer decision record" section (AC5)', () => {
    const headingMatch = /^##\s+Producer decision record\s*$/im.exec(doc);
    expect(headingMatch).not.toBeNull();
    const start = headingMatch?.index ?? 0;
    const section = doc.slice(start);
    // The record is a table left pending, plus a follow-on work-item note.
    expect(section).toMatch(/\|.*\|/);
    expect(section).toMatch(/pending/i);
    expect(section).toMatch(/follow[- ]on/i);
  });
});

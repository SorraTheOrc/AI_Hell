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
 * - AC7 (cross-link slice AH-0MVRNJ6BB009IGZX): the document is referenced from
 *   the GDD §8 future-scope section and from the README, and every reference
 *   resolves to a file on disk.
 * - AC11–AC12 (Candidate D slice AH-0MVTE4EOS008RMQ7): Candidate D — Hangar War
 *   carries the twelve required sections plus a Progression rules subsection,
 *   and the cross-cutting progression-rules section exists and names every
 *   candidate.
 * - AC16 (producer decision, AH-0MVNSSY9L001P1CC): the producer chose
 *   Candidate D, the choice is recorded in the decision record with a date and
 *   in GDD §8, the ring timing is an evening's play (one-ring MVP 40–60 minutes;
 *   ring 2 is 12 hexes), the anti-checklist mitigations and the playstyles the
 *   loop must support are documented, and the build-out work item is
 *   cross-referenced from the decision record and the GDD.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(
  process.cwd(),
  'docs/OUTER_LOOP_CANDIDATES.md',
);

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');

/**
 * The work item created to build the chosen loop (AC16).
 *
 * A stable id, asserted so the decision record and GDD §8 can never claim a
 * choice without pointing at the item that builds it.
 */
const BUILD_OUT_ITEM_ID = 'AH-0MVU3VNJI00066YE';

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
  {
    label: 'Candidate D — Hangar War',
    heading: /^##\s+Candidate D\s*[—–-]\s*Hangar War\s*$/im,
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

      // AC12 (AH-0MVTE4EOS008RMQ7): every candidate states how it complies
      // with the cross-cutting progression rules.
      it('states how it complies with the progression rules (AC12)', () => {
        expect(body).toMatch(/^###\s+Progression rules\s*$/im);
      });
    },
  );

  // ── AC16: the chosen loop is documented as chosen, with its design ──

  describe('Chosen loop — Candidate D (AC16)', () => {
    const body = candidateSection(doc, CANDIDATES[3].heading);

    it.each([
      'Playstyles supported',
      'Known-ahead intel and anti-checklist mitigations',
    ])('documents the "%s" subsection (AC16)', (section) => {
      expect(body).toMatch(
        new RegExp(`^###\\s+${escapeRegExp(section)}\\s*$`, 'im'),
      );
    });

    it('targets an evening-length one-ring MVP and a larger second ring (AC16)', () => {
      // MVP (one ring) is 40–60 minutes; ring 2 is 12 hexes.
      expect(body).toMatch(/40\s*[–—-]\s*60\s*minutes/i);
      expect(body).toMatch(/12\s+hexes/i);
      expect(body).toMatch(/ring/i);
    });

    it('makes boss and weapon strength known ahead of a deployment (AC16)', () => {
      expect(body).toMatch(/known ahead/i);
      expect(body).toMatch(/boss/i);
      expect(body).toMatch(/weak/i);
    });

    it('records the playstyles the loop must support (AC16)', () => {
      expect(body).toMatch(/grind/i);
      expect(body).toMatch(/completer|completion/i);
      expect(body).toMatch(/hardest hex/i);
    });

    it('records the post-MVP anti-checklist mitigations (AC16)', () => {
      expect(body).toMatch(/special missions/i);
      expect(body).toMatch(/upgraded bots/i);
      expect(body).toMatch(/extra hull|hull type|upgrade bays/i);
    });

    it('keeps the shipped run loadout when stating Rule 1 compliance (AC16)', () => {
      const rule = /###\s+Progression rules[\s\S]*$/i.exec(body)?.[0] ?? '';
      // The fleet starts minimal, but the run keeps its six slots plus the two
      // slot-free kinds; the outer loop must not strip the middle loop.
      expect(rule).toMatch(/six/i);
      expect(rule).toMatch(/Extra Life/i);
      expect(rule).toMatch(/Mystery UFO/i);
    });
  });

  // ── AC12: cross-cutting progression rules ──────────────────────────

  it('records the progression rules common to every candidate (AC12)', () => {
    const heading = /^##\s+Progression rules common to every candidate\s*$/im.exec(
      doc,
    );
    expect(heading).not.toBeNull();
    const afterHeading = doc.slice((heading?.index ?? 0) + (heading?.[0].length ?? 0));
    const nextHeading = /\n##\s+/.exec(afterHeading);
    const section = nextHeading
      ? afterHeading.slice(0, nextHeading.index)
      : afterHeading;

    // Rule 1: a reduced starting kit, so power is discovered through play.
    expect(section).toMatch(/reduced set of power-ups and upgrades/i);
    // AC16 clarification: the reduction is in what the fleet owns before a run —
    // the shipped run keeps its six shared slots plus the two slot-free kinds.
    expect(section).toMatch(/six/i);
    expect(section).toMatch(/Extra Life/i);
    expect(section).toMatch(/Mystery UFO/i);
    // Rule 2: mini-bosses introduce upgrades/weapons the player must first
    // defeat, then may use.
    expect(section).toMatch(/mini-bosses/i);
    expect(section).toMatch(/defeat/i);
    // The section is published before the candidates and names each of them,
    // so no candidate can quietly opt out.
    const firstCandidateIdx = CANDIDATES[0].heading.exec(doc)?.index ?? -1;
    expect(heading?.index ?? -1).toBeLessThan(firstCandidateIdx);
    for (const candidate of CANDIDATES) {
      expect(section).toContain(candidate.label.split(' — ')[0]);
    }
  });

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
    // AC14 (AH-0MVTE4EOS008RMQ7): Candidate D is scored in the same table.
    expect(section).toMatch(/Candidate D/i);
    expect(section).toMatch(/recommend/i);
  });

  // ── AC5: deferrals and the staged producer decision ────────────────

  it('contains a "Considered but not selected" section (AC5)', () => {
    expect(doc).toMatch(/^##\s+Considered but not selected\s*$/im);
  });

  it('contains a "Recommendation" section (AC4)', () => {
    expect(doc).toMatch(/^##\s+Recommendation\s*$/im);
  });

  it('records the producer decision for the chosen candidate (AC5, AC16)', () => {
    const headingMatch = /^##\s+Producer decision record\s*$/im.exec(doc);
    expect(headingMatch).not.toBeNull();
    const start = headingMatch?.index ?? 0;
    const section = doc.slice(start);
    // The record is a table with a follow-on note.
    expect(section).toMatch(/\|.*\|/);
    expect(section).toMatch(/follow[- ]on/i);

    // AC16: the producer chose Candidate D, so its row carries a decision and a
    // date instead of "pending".
    const chosenRow =
      section.split('\n').find((line) => /\|.*Candidate D/i.test(line)) ?? '';
    expect(chosenRow).not.toBe('');
    expect(chosenRow).not.toMatch(/pending/i);
    expect(chosenRow).toMatch(/accept|chosen|selected/i);
    expect(chosenRow).toMatch(/\d{4}-\d{2}-\d{2}/);

    // The decision names the work item that builds the chosen loop.
    expect(section).toContain(BUILD_OUT_ITEM_ID);
  });
});

/**
 * Every markdown link target in `text` that points at the deliverable.
 * Kept deliberately narrow: the guard only resolves links to *this* document
 * (AC7 of the parent item), never the rest of the file's prose.
 */
const outerLoopLinkTargets = (text: string): string[] => {
  const targets: string[] = [];
  const pattern = /\]\(([^)\s]*OUTER_LOOP_CANDIDATES[^)\s]*)\)/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    targets.push(match[1]);
    match = pattern.exec(text);
  }
  return targets;
};

describe('Outer-loop candidates are cross-linked, not orphaned (AH-0MVRNJ6BB009IGZX)', () => {
  it.each([
    ['the Game Design Document §8 future scope', GDD_PATH],
    ['the README', README_PATH],
  ])('is referenced from %s (AC7)', (_label, filePath) => {
    expect(fs.existsSync(filePath)).toBe(true);
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('OUTER_LOOP_CANDIDATES');
  });

  it.each([
    ['the Game Design Document §8 future scope', GDD_PATH],
    ['the README', README_PATH],
  ])('every reference from %s resolves to a file (AC7)', (_label, filePath) => {
    const text = fs.readFileSync(filePath, 'utf8');
    const targets = outerLoopLinkTargets(text);
    // A prose mention without a resolvable link would re-orphan the document.
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const [filePart] = target.split('#');
      const resolved = path.resolve(path.dirname(filePath), filePart);
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });
});

/** The GDD's §8 future-scope text (up to the next level-2 heading). */
const gddFutureScope = (): string => {
  const text = fs.readFileSync(GDD_PATH, 'utf8');
  const heading = /^##\s*8\.\s*Future Scope.*$/im.exec(text);
  if (!heading || heading.index === undefined) return '';
  const rest = text.slice(heading.index + heading[0].length);
  const nextHeading = /\n##\s+/.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
};

/** AC16: the decision of record, its timing and its cross-references. */
describe('The chosen loop is recorded in the GDD (AC16)', () => {
  it('names Candidate D as the chosen outer loop', () => {
    const scope = gddFutureScope();
    expect(scope).toMatch(/Candidate D/i);
    expect(scope).toMatch(/chose|chosen|selected/i);
  });

  it('records the ring timing the producer set (one-ring MVP 40–60 minutes)', () => {
    const scope = gddFutureScope();
    expect(scope).toMatch(/40\s*[–—-]\s*60\s*minutes/i);
    expect(scope).toMatch(/12\s+hexes/i);
  });

  it('records the known-ahead intel, the playstyles and the mitigation backlog', () => {
    const scope = gddFutureScope();
    expect(scope).toMatch(/known ahead/i);
    expect(scope).toMatch(/grind/i);
    expect(scope).toMatch(/special missions/i);
    expect(scope).toMatch(/upgraded bots/i);
  });

  it('keeps the shipped run loadout explicit (six slots, Extra Life, Mystery UFO)', () => {
    const scope = gddFutureScope();
    expect(scope).toMatch(/six/i);
    expect(scope).toMatch(/Extra Life/i);
    expect(scope).toMatch(/Mystery UFO/i);
  });

  it('points at the work item that builds the chosen loop', () => {
    expect(gddFutureScope()).toContain(BUILD_OUT_ITEM_ID);
    expect(doc).toContain(BUILD_OUT_ITEM_ID);
  });
});

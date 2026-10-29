/**
 * Docs guard for the AI Hell Music System chapter
 * (AH-0MVAUUV1U005UM4W — "Update GDD with Audio Design Chapter").
 *
 * This is a deliberate docs guard: the deliverable is a Markdown GDD addendum
 * plus the GDD cross-links that keep the document set self-consistent, and
 * this guard fails if the chapter loses a section of the approved structure,
 * loses its musical substance, or if a cross-link (or the explicit
 * out-of-MVP scope stance) is removed. It asserts no runtime behaviour: no
 * music code ships with this item (AC4).
 *
 * It follows the sibling `*Docs.test.ts` convention established by
 * `src/powerUpWeaponRosterDocs.test.ts` and `src/enemyRosterDocs.test.ts`.
 *
 * Acceptance criteria validated:
 *
 * - AC1: `docs/AUDIO_DESIGN_CHAPTER.md` exists and carries the eight numbered
 *   sections plus Appendix A and Appendix B of the approved chapter
 *   structure, with the producer's retro-arcade musical substance
 *   (Phrygian Dominant + Lydian; Combat Motifs A/B; Star Drift; the three
 *   progressions) and no substance borrowed from the card-game exemplar the
 *   structure was modelled on.
 * - AC2: GDD §7.3's "Background Music" subsection links the chapter and still
 *   states music is out of MVP scope.
 * - AC3: GDD §8's "Background music" row links the chapter.
 * - AC4: The chapter defers SFX authority to GDD §7.3 and the ToneForge cue
 *   mapping, so it cannot be read as a second, competing SFX catalogue.
 * - AC5: The cross-links resolve to a file that exists on disk.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOCS = path.resolve(process.cwd(), 'docs');
const CHAPTER = path.resolve(DOCS, 'AUDIO_DESIGN_CHAPTER.md');
const GDD = path.resolve(DOCS, 'Game Design Document.md');

/** The link text both GDD references must carry. */
const CHAPTER_LINK = 'AUDIO_DESIGN_CHAPTER.md';

/** The eight numbered sections of the approved chapter structure (AC1). */
const SECTIONS = [
  [1, 'Audio Vision Statement'],
  [2, 'Musical Identity'],
  [3, 'Instrumentation Palette'],
  [4, 'Dynamic Mixing Rules'],
  [5, 'State-Driven Music Transitions'],
  [6, 'Implementation Guidelines'],
  [7, 'Composer and Sound Designer Briefs'],
  [8, 'Audio Accessibility'],
] as const;

/** The subsections the chapter must keep in their parent sections (AC1). */
const SUBSECTIONS = [
  '2.1 Tonal Language',
  '2.2 Core Motifs',
  '2.3 Chord Progressions',
  '5.1 Transition Design Principles',
  '5.2 Transition Matrix',
  '5.3 Stinger System',
  '6.1 Audio Middleware',
  '6.2 Music Event Architecture',
  '6.3 Parameter Mapping Table',
  '6.4 Technical Specifications',
  '6.5 Audio Budget Table',
  '7.1 Composer Brief',
  '7.2 Sound Designer Brief',
] as const;

/**
 * The musical substance of the producer's *Music & Thematic Audio Design*
 * brief that the chapter must reproduce faithfully (AC1).
 */
const MUSICAL_SUBSTANCE = [
  'Phrygian Dominant',
  'Lydian',
  'Incoming Wave',
  'Survival Pulse',
  'Star Drift',
  'E – F – G♯ – A – B – C – D',
  'C – D – E – F♯ – G – A – B',
] as const;

/**
 * Substance belonging to the card-game exemplar whose *structure* was reused.
 * None of it may appear in the AI Hell chapter (AC1).
 */
const FOREIGN_SUBSTANCE = [
  /tableau/i,
  /harpsichord/i,
  /candlelit/i,
  /\bdorian\b/i,
  /\bcello\b/i,
  /card[- ]table/i,
] as const;

const exists = (file: string): boolean => fs.existsSync(file);
const read = (file: string): string =>
  exists(file) ? fs.readFileSync(file, 'utf8') : '';

/** Return the slice of `text` between `start` and the next occurrence of `end`. */
const sliceBetween = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  if (from === -1) return '';
  const to = text.indexOf(end, from + start.length);
  return to === -1 ? text.slice(from) : text.slice(from, to);
};

describe('AI Hell Music System chapter documentation (AH-0MVAUUV1U005UM4W)', () => {
  const chapter = read(CHAPTER);
  const gdd = read(GDD);

  /** GDD §7.3's "Background Music" subsection body. */
  const backgroundMusic = sliceBetween(
    gdd,
    '#### Background Music',
    '\n#### ',
  );

  /** GDD §8's "Background music" future-scope row. */
  const futureScope = sliceBetween(gdd, '## 8. Future Scope', '## 9.');
  const backgroundMusicRow = futureScope
    .split('\n')
    .find((line) => /\|\s*\*\*Background music\*\*/.test(line)) ?? '';

  it('the Audio Design Chapter exists as a GDD addendum (AC1)', () => {
    expect(exists(CHAPTER)).toBe(true);
    expect(chapter).toMatch(/^#\s+AI Hell Music System/m);
  });

  it.each(SECTIONS)(
    'the chapter keeps section %i "%s" (AC1)',
    (number, title) => {
      expect(chapter).toMatch(
        new RegExp(`^## ${number}\\. ${title}$`, 'm'),
      );
    },
  );

  it.each(SUBSECTIONS)('the chapter keeps subsection "%s" (AC1)', (heading) => {
    const [number, ...rest] = heading.split(' ');
    expect(chapter).toMatch(
      new RegExp(`^### ${number.replace('.', '\\.')} ${rest.join(' ')}$`, 'm'),
    );
  });

  it('the chapter keeps Appendix A and Appendix B (AC1)', () => {
    expect(chapter).toMatch(/^## Appendix A — Motif Reference Sheet$/m);
    expect(chapter).toMatch(/^## Appendix B — Glossary$/m);
  });

  it('the chapter table of contents indexes every section and appendix (AC1, AC5)', () => {
    const toc = sliceBetween(chapter, '## Contents', '## 1. ');
    expect(toc.length).toBeGreaterThan(0);
    for (const [number, title] of SECTIONS) {
      expect(toc).toContain(`${number}. ${title}`);
    }
    expect(toc).toContain('Appendix A');
    expect(toc).toContain('Appendix B');
  });

  it.each(MUSICAL_SUBSTANCE)(
    'the chapter carries the producer\'s musical substance "%s" (AC1)',
    (substance) => {
      expect(chapter).toContain(substance);
    },
  );

  it('the chapter carries no card-game exemplar substance (AC1)', () => {
    for (const foreign of FOREIGN_SUBSTANCE) {
      expect(chapter, `chapter leaked exemplar substance ${foreign}`).not.toMatch(
        foreign,
      );
    }
  });

  it('the chapter is framed as design reference, out of MVP scope (AC2, AC3)', () => {
    expect(chapter).toMatch(/out of MVP scope/i);
    expect(chapter).toMatch(/design reference/i);
  });

  it("GDD §7.3's Background Music subsection links the chapter (AC2)", () => {
    expect(backgroundMusic).not.toBe('');
    expect(backgroundMusic).toContain(CHAPTER_LINK);
  });

  it("GDD §7.3's Background Music subsection still keeps music out of the MVP (AC2)", () => {
    expect(backgroundMusic).toMatch(/out of scope for the MVP/i);
  });

  it("GDD §8's Background music row links the chapter (AC3)", () => {
    expect(backgroundMusicRow).not.toBe('');
    expect(backgroundMusicRow).toContain(CHAPTER_LINK);
  });

  it('the chapter defers SFX authority to GDD §7.3 and the ToneForge cue mapping (AC4)', () => {
    expect(chapter).toMatch(/§7\.3/);
    expect(chapter).toContain('AUDIO_TONEFORGE_CUE_MAPPING.md');
  });

  it('every GDD cross-link resolves to the chapter file on disk (AC5)', () => {
    const targets = [backgroundMusic, backgroundMusicRow]
      .join('\n')
      .match(/\[[^\]]+\]\(([^)]+)\)/g);
    expect(targets).not.toBeNull();
    for (const link of targets ?? []) {
      // Both GDD references use `AUDIO_DESIGN_CHAPTER.md`; one may carry a
      // `./` prefix. Either spelling must resolve to the same on-disk file.
      const target = link
        .slice(link.indexOf('(') + 1, -1)
        .replace(/^\.\//, '');
      expect(target).toBe(CHAPTER_LINK);
      expect(path.resolve(DOCS, target)).toBe(CHAPTER);
    }
    expect(exists(path.resolve(DOCS, CHAPTER_LINK))).toBe(true);
  });
});

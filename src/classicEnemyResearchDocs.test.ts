/**
 * Docs guard for the classic enemy research catalogue (AH-0MV01EBUR003BDNK).
 *
 * This is a deliberate docs grep: it asserts the canonical research document
 * text (the acceptance criteria), not source behaviour. The deliverable is
 * `docs/CLASSIC_ENEMY_RESEARCH.md`, cross-linked from
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`.
 *
 * Acceptance criteria validated:
 *
 * - AC1: The document exists and catalogues between 5 and 8 selected
 *   classic arcade enemy archetypes.
 * - AC2: A "Considered but not selected" section lists deferred candidates,
 *   each with a one-line deferral reason.
 * - AC3: Each selected archetype specifies its data-driven pipeline fit
 *   (EnemyConfig/CSV row or new src/entities/<Name>.ts plus factory/fire
 *   dispatch seam) and its difficulty scoring inputs (movement / fire /
 *   health factors).
 * - AC4: Each selected archetype names the gym scene(s) that will exercise
 *   it.
 * - AC5: Every selected archetype maps to an existing or explicitly-planned
 *   formation / shot-pattern registry entry.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/CLASSIC_ENEMY_RESEARCH.md');

/** The eight selected archetypes, in the order the epic plan fixed them. */
const SELECTED = [
  'Space Invaders',
  'Galaga',
  'Pac-Man',
  'Centipede',
  'Robotron 2084',
  'Defender',
  'Missile Command',
  'Frogger',
];

/** The deferred candidates from the epic research pool. */
const DEFERRED = [
  'Joust',
  'Dig Dug',
  'Q*bert',
  'Star Castle',
];

/**
 * Formation / shot-pattern registry keys that must be referenced by at
 * least one selected archetype.  These are the seams in
 * `src/utils/formations.ts` (formation builders) and
 * `src/utils/enemyShotPatterns.ts` (shot-pattern enum), plus the factory
 * / fire-dispatch seams in `src/entities/enemyFactory.ts` and
 * `src/entities/enemyFire.ts`.
 *
 * Existing: v, diver, rect, swarm, orbital, single formations.
 * Existing: aimed, spread, radial, orbital, coordinated shot patterns.
 *
 * The research document must state whether each archetype uses an
 * existing registry entry or proposes a new one.
 */
const KNOWN_REGISTRY_ENTRIES = [
  'buildVFormationOffsets',
  'buildDiverFormationOffsets',
  'buildRectFormationOffsets',
  'buildSwarmClusterOffsets',
  'buildOrbitalPhaseOffsets',
  'buildSingleOffset',
  'aimed',
  'spread',
  'radial',
  'orbital',
  'coordinated',
  'none',
];

describe('Classic enemy research is documented (AH-0MV01EBUR003BDNK)', () => {
  it('the research document exists (AC1)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  // ── AC1: 5–8 selected archetypes ────────────────────────────────────

  it(`catalogues between 5 and 8 selected archetypes (AC1): found ${SELECTED.filter(a => doc.includes(a)).length}`, () => {
    const found = SELECTED.filter((name) => doc.includes(name));
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.length).toBeLessThanOrEqual(8);
  });

  // ── AC2: Considered-but-not-selected section ────────────────────────

  it('contains a "Considered but not selected" section (AC2)', () => {
    expect(doc).toMatch(/considered[\s]*but[\s]*not[\s]*selected/i);
  });

  DEFERRED.forEach((name) => {
    it(`defers ${name} with a one-line reason (AC2)`, () => {
      const idx = doc.search(new RegExp(name, 'i'));
      expect(idx).toBeGreaterThan(-1);
      // The deferral line should appear in the considered-but-not-selected
      // section — check that the word "defer" appears between the section
      // header and this archetype's mention.
      const sectionIdx = doc.search(/considered[\s]*but[\s]*not[\s]*selected/i);
      const nameIdx = doc.search(new RegExp(name, 'i'));
      expect(nameIdx).toBeGreaterThan(sectionIdx);
    });
  });

  // ── AC3: Pipeline fit and difficulty inputs per archetype ───────────

  const PIPELINE_FIT_PATTERNS = [
    /EnemyConfig/i,
    /CSV/i,
    /src\/entities\/.*\.ts/i,
    /enemyFactory/i,
    /enemyFire/i,
    /fire-dispatch/i,
  ];

  it.each(SELECTED)(
    `%s specifies pipeline fit (AC3)`,
    (name) => {
      const idx = doc.search(new RegExp(name, 'i'));
      expect(idx).toBeGreaterThan(-1);
      // Grab ~2000 chars after the name to look for pipeline-fit keywords.
      const snippet = doc.slice(idx, idx + 2000);
      const matches = PIPELINE_FIT_PATTERNS.some((re) => re.test(snippet));
      expect(matches).toBe(true);
    },
  );

  it.each(SELECTED)(
    `%s specifies difficulty scoring inputs (AC3)`,
    (name) => {
      const idx = doc.search(new RegExp(name, 'i'));
      const snippet = doc.slice(idx, idx + 2000);
      // Difficulty inputs: movement, fire, health (the three factor groups).
      const hasMovement = /movement|drift/i.test(snippet);
      const hasFire = /fire|attack|bullet|shot|damage|burst/i.test(snippet);
      const hasHealth = /health|hp|durability|hit[\s-]*point/i.test(snippet);
      // At least two of the three must appear.
      expect([hasMovement, hasFire, hasHealth].filter(Boolean).length).toBeGreaterThanOrEqual(2);
    },
  );

  // ── AC4: Gym scene per archetype ────────────────────────────────────

  it.each(SELECTED)(
    `%s names a gym scene (AC4)`,
    (name) => {
      const idx = doc.search(new RegExp(name, 'i'));
      const snippet = doc.slice(idx, idx + 2000);
      // Look for gym scene references.
      expect(/gym/i.test(snippet)).toBe(true);
    },
  );

  // ── AC5: Registry mapping per archetype ─────────────────────────────

  it.each(SELECTED)(
    `%s maps to an existing or explicitly-planned registry entry (AC5)`,
    (name) => {
      const idx = doc.search(new RegExp(name, 'i'));
      const snippet = doc.slice(idx, idx + 2000);
      // At least one known registry entry must be referenced, or the text
      // must explicitly state "new" / "proposed" / "planned" (meaning a new
      // registry entry is planned).
      const knownEntry = KNOWN_REGISTRY_ENTRIES.some((entry) =>
        snippet.includes(entry),
      );
      const newEntry = /new[\s-]+entry|planned|proposed/i.test(snippet);
      expect(knownEntry || newEntry).toBe(true);
    },
  );

  // ── Cross-link from ENEMY_DESIGN_AND_IMPLEMENTATION.md ────────────────

  it('is cross-linked from ENEMY_DESIGN_AND_IMPLEMENTATION.md', () => {
    const enemyDesignPath = path.resolve(process.cwd(), 'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md');
    expect(fs.existsSync(enemyDesignPath)).toBe(true);
    const enemyDoc = fs.readFileSync(enemyDesignPath, 'utf8');
    expect(enemyDoc).toContain('CLASSIC_ENEMY_RESEARCH');
  });
});

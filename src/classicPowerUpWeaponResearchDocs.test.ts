/**
 * Docs guard for the classic power-up & weapon research catalogue
 * (AH-0MV1BIUGE005BJO8).
 *
 * This is a deliberate docs grep: it asserts the canonical research document
 * text (the acceptance criteria), not source behaviour. The deliverable is
 * `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md`, cross-linked from
 * `docs/Game Design Document.md` §4.4.
 *
 * It follows the sibling convention established by
 * `src/classicEnemyResearchDocs.test.ts` for the enemy research catalogue.
 *
 * Acceptance criteria validated:
 *
 * - AC1: The document exists and catalogues between 5 and 8 selected
 *   classic arcade power-up/weapon concepts.
 * - AC2: A "Considered but not selected" section lists the deferred
 *   candidates, each with a one-line deferral reason.
 * - AC3: Each selected weapon specifies its `WeaponId`/`WEAPON_CATALOGUE`
 *   seam, its fire subdivision on the shared 80 BPM beat grid, and its
 *   `weaponLevels.ts` upgrade variables.
 * - AC4: Each selected power-up specifies its `PowerUpId`/
 *   `POWER_UP_CATALOGUE` seam, its `powerUpLevels.ts` upgrade variables and
 *   its `powerUpWeights` drop weight.
 * - AC5: Each selected concept names the gym scene(s) that will exercise it,
 *   to satisfy the gym-to-game parity rule.
 * - AC6: The document is cross-linked from the GDD §4.4.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(
  process.cwd(),
  'docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md',
);
const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');

/** The eight selected concepts, in the order the work item fixed them. */
const SELECTED_WEAPONS = [
  'R-Type wave laser',
  'Centipede ricochet shot',
  'Missile Command cluster/MIRV missile',
  'Gradius Options orbiting satellites',
];

/** The four selected power-ups. */
const SELECTED_POWER_UPS = [
  'Pac-Man power pellet',
  'Defender smart bomb',
  'Gradius force field',
  'Space Invaders mystery UFO',
];

const SELECTED = [...SELECTED_WEAPONS, ...SELECTED_POWER_UPS];

/**
 * The deferred candidates from the epic research pool, each of which must
 * appear after the "Considered but not selected" header with a reason.
 */
const DEFERRED = [
  'Galaga Dual Fighter',
  'smart bomb weapon form',
  'Tempest Superzapper',
  'Sinistar Sinibomb',
  'Galaga Repulsor',
  'Frogger Super Leap',
  'Asteroids Decoy',
  'Gauntlet Potion',
];

/** Catalogue/registry seams a selected concept must name. */
const SEAM_PATTERN = /WEAPON_CATALOGUE|POWER_UP_CATALOGUE|WeaponId|PowerUpId/;
const GYM_PATTERN = /gym/i;

describe('Classic power-up & weapon research is documented (AH-0MV1BIUGE005BJO8)', () => {
  it('the research document exists (AC1)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  const snippetFor = (anchor: string): string => {
    const idx = doc.search(new RegExp(anchor, 'i'));
    if (idx < 0) return '';
    return doc.slice(idx, idx + 3000);
  };

  // ── AC1: 5–8 selected concepts ──────────────────────────────────────

  it(`catalogues between 5 and 8 selected concepts (AC1): found ${SELECTED.filter(a => doc.search(new RegExp(a, 'i')) >= 0).length}`, () => {
    const found = SELECTED.filter(
      (anchor) => doc.search(new RegExp(anchor, 'i')) >= 0,
    );
    expect(found.length).toBeGreaterThanOrEqual(5);
    expect(found.length).toBeLessThanOrEqual(8);
  });

  // ── AC2: Considered-but-not-selected section ────────────────────────

  const deferredSectionIdx = doc.search(
    /considered[\s]*but[\s]*not[\s]*selected/i,
  );

  it('contains a "Considered but not selected" section (AC2)', () => {
    expect(deferredSectionIdx).toBeGreaterThan(-1);
  });

  it.each(DEFERRED)(
    `defers %s in the considered-but-not-selected section (AC2)`,
    (anchor) => {
      const idx = doc.search(new RegExp(anchor, 'i'));
      expect(idx).toBeGreaterThan(deferredSectionIdx);
      // The deferral row must carry a reason, not just the name.
      const row = doc.slice(idx, idx + 400);
      expect(
        /defer|reason|out[- ]of[- ]scope|not expressible|requires/i.test(row),
      ).toBe(true);
    },
  );

  // ── AC3: weapon pipeline fit ────────────────────────────────────────

  it.each(SELECTED_WEAPONS)(
    `%s names a WeaponId/WEAPON_CATALOGUE seam, a beat subdivision and weaponLevels variables (AC3)`,
    (anchor) => {
      const snippet = snippetFor(anchor);
      expect(SEAM_PATTERN.test(snippet)).toBe(true);
      expect(/subdivision|beats?\/beat|per beat|on[- ]grid/i.test(snippet)).toBe(
        true,
      );
      expect(/weaponLevels/i.test(snippet)).toBe(true);
      expect(
        /AoEDescriptor|trigger|dispatch seam|seam|catalogue[- ]only|catalogue entry/i.test(
          snippet,
        ),
      ).toBe(true);
    },
  );

  // ── AC4: power-up pipeline fit ──────────────────────────────────────

  it.each(SELECTED_POWER_UPS)(
    `%s names a PowerUpId/POWER_UP_CATALOGUE seam, powerUpLevels variables and a drop weight (AC4)`,
    (anchor) => {
      const snippet = snippetFor(anchor);
      expect(SEAM_PATTERN.test(snippet)).toBe(true);
      expect(/powerUpLevels/i.test(snippet)).toBe(true);
      expect(/powerUpWeights|drop weight/i.test(snippet)).toBe(true);
      expect(/timed|stored|permanent/i.test(snippet)).toBe(true);
      expect(/icon/i.test(snippet)).toBe(true);
    },
  );

  // ── AC5: gym scene per concept ──────────────────────────────────────

  it.each(SELECTED)(`%s names a gym scene (AC5)`, (anchor) => {
    expect(GYM_PATTERN.test(snippetFor(anchor))).toBe(true);
  });

  // ── AC6: cross-link from the GDD ────────────────────────────────────

  it('is cross-linked from the Game Design Document (AC6)', () => {
    expect(fs.existsSync(GDD_PATH)).toBe(true);
    const gdd = fs.readFileSync(GDD_PATH, 'utf8');
    expect(gdd).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
  });
});

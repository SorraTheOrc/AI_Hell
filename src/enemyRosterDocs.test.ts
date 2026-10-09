/**
 * Docs guard for the classic-arcade roster integration (AH-0MV01ER86000DNRF).
 *
 * Cross-cutting docs slice of the research epic (AH-0MUYAQ6YH0010G52). This
 * is a deliberate docs grep: the deliverable is the cross-linking of the
 * user-facing documentation to the research catalogue, and this guard fails
 * if a cross-link or a roster entry is removed. It does not assert source
 * behaviour (that is covered by the per-archetype entity/scene tests).
 *
 * Acceptance criteria validated:
 *
 * - AC1: README, the Game Design Document and the enemy guide each reference
 *   `docs/CLASSIC_ENEMY_RESEARCH.md`.
 * - AC2: The enemy guide §1 catalog and the README list every implemented
 *   classic-arcade archetype.
 * - AC3: The Game Design Document §4.1 and §8 reference the roster and the
 *   deferred candidates.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const README = path.resolve(process.cwd(), 'README.md');
const GDD = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const ENEMY_GUIDE = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);
const RESEARCH = path.resolve(process.cwd(), 'docs/CLASSIC_ENEMY_RESEARCH.md');

/** The eight implemented classic-arcade archetypes (name + config key). */
const IMPLEMENTED = [
  { name: 'Space Invaders', key: 'march' },
  { name: 'Galaga', key: 'capturer' },
  { name: 'Pac-Man', key: 'ghost-chase' },
  { name: 'Centipede', key: 'centipede' },
  { name: 'Robotron', key: 'grunt' },
  { name: 'Defender', key: 'raider' },
  { name: 'Missile Command', key: 'orbital-strike' },
  { name: 'Frogger', key: 'lane-traffic' },
];

/** Candidates explicitly deferred to the research doc's not-selected section. */
const DEFERRED = ['Joust', 'Dig Dug', 'Q*bert', 'Star Castle'];

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

describe('Classic-arcade roster documentation integration (AH-0MV01ER86000DNRF)', () => {
  const readme = read(README);
  const gdd = read(GDD);
  const guide = read(ENEMY_GUIDE);

  it('the research catalogue exists (AC1)', () => {
    expect(fs.existsSync(RESEARCH)).toBe(true);
  });

  it('README references the research catalogue (AC1)', () => {
    expect(readme).toContain('CLASSIC_ENEMY_RESEARCH');
  });

  it('the Game Design Document references the research catalogue (AC1)', () => {
    expect(gdd).toContain('CLASSIC_ENEMY_RESEARCH');
  });

  it('the enemy guide references the research catalogue (AC1)', () => {
    expect(guide).toContain('CLASSIC_ENEMY_RESEARCH');
  });

  it.each(IMPLEMENTED)(
    'the enemy guide §1 catalog lists $name ($key) (AC2)',
    ({ name, key }) => {
      expect(
        guide.includes(name) || guide.includes(key),
        `${name} (${key}) missing from the enemy guide`,
      ).toBe(true);
    },
  );

  it.each(IMPLEMENTED)(
    'the README roster lists $name ($key) (AC2)',
    ({ name, key }) => {
      expect(
        readme.includes(name) || readme.includes(key),
        `${name} (${key}) missing from the README roster`,
      ).toBe(true);
    },
  );

  it('the Game Design Document §4.1/§8 reflects the roster and deferrals (AC3)', () => {
    // §4.1 names the archetypes; §8 records the deferred candidates.
    for (const { name } of IMPLEMENTED) {
      expect(gdd, `GDD missing ${name}`).toContain(name);
    }
    for (const candidate of DEFERRED) {
      expect(gdd, `GDD missing deferred candidate ${candidate}`).toContain(
        candidate,
      );
    }
  });
});

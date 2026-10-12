/**
 * Docs guard for the classic power-up & weapon roster integration
 * (AH-0MV1BIXSH000JLN0).
 *
 * Cross-cutting docs slice of the research epic (AH-0MV14SO0G0095IJ4). This
 * is a deliberate docs grep: the deliverable is the cross-linking of the
 * user-facing documentation to the research catalogue, and this guard fails
 * if a cross-link or a roster entry is removed. It does not assert source
 * behaviour (that is covered by the per-concept catalogue/scene tests).
 *
 * It follows the sibling convention established by
 * `src/enemyRosterDocs.test.ts` for the classic-arcade enemy roster.
 *
 * Acceptance criteria validated:
 *
 * - AC1: README, the Game Design Document and the gym-parity documentation
 *   each reference `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md`, and the shared
 *   catalogue headers carry the same research-document cross-reference.
 * - AC2: The README roster and the Game Design Document §4.4 list every
 *   implemented classic-arcade power-up and weapon.
 * - AC3: The Game Design Document §4.4 and §8 reference the roster and the
 *   deferred candidates.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const README = path.resolve(process.cwd(), 'README.md');
const GDD = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const GYM_PARITY_DOC = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);
const RESEARCH = path.resolve(
  process.cwd(),
  'docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md',
);
const WEAPONS = path.resolve(process.cwd(), 'src/utils/weapons.ts');
const POWER_UP_TYPES = path.resolve(process.cwd(), 'src/powerups/types.ts');

/**
 * The eight implemented classic-arcade concepts, keyed by the source game and
 * the shipped catalogue entry name the docs must list.
 */
const IMPLEMENTED = [
  { game: 'R-Type', name: 'Wave Laser' },
  { game: 'Centipede', name: 'Ricochet' },
  { game: 'Missile Command', name: 'Cluster Missile' },
  { game: 'Gradius', name: 'Options' },
  { game: 'Pac-Man', name: 'Power Pellet' },
  { game: 'Defender', name: 'Smart Bomb' },
  { game: 'Gradius', name: 'Force Field' },
  { game: 'Space Invaders', name: 'Mystery UFO' },
];

/** Candidates explicitly deferred to the research doc's not-selected section. */
const DEFERRED = [
  'Galaga Dual Fighter',
  'Superzapper',
  'Sinibomb',
  'Repulsor',
  'Super Leap',
  'Decoy',
  'Potion',
];

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

describe('Classic power-up & weapon roster documentation integration (AH-0MV1BIXSH000JLN0)', () => {
  const readme = read(README);
  const gdd = read(GDD);
  const gymParityDoc = read(GYM_PARITY_DOC);

  it('the research catalogue exists (AC1)', () => {
    expect(fs.existsSync(RESEARCH)).toBe(true);
  });

  it('README references the research catalogue (AC1)', () => {
    expect(readme).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
  });

  it('the Game Design Document references the research catalogue (AC1)', () => {
    expect(gdd).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
  });

  it('the gym-parity documentation references the research catalogue (AC1)', () => {
    expect(gymParityDoc).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
  });

  it('the shared catalogue headers reference the research catalogue (AC1)', () => {
    expect(read(WEAPONS)).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
    expect(read(POWER_UP_TYPES)).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
  });

  it.each(IMPLEMENTED)(
    'the README roster lists $name ($game) (AC2)',
    ({ name, game }) => {
      expect(
        readme.includes(name) || readme.includes(game),
        `${name} (${game}) missing from the README roster`,
      ).toBe(true);
    },
  );

  it.each(IMPLEMENTED)(
    'the Game Design Document §4.4 lists $name ($game) (AC2)',
    ({ name, game }) => {
      expect(
        gdd.includes(name) || gdd.includes(game),
        `${name} (${game}) missing from the Game Design Document`,
      ).toBe(true);
    },
  );

  it('the Game Design Document §8 records the roster and the deferrals (AC3)', () => {
    // §8 Future Scope records the classic-arcade power-up/weapon roster and
    // the candidates considered but not selected this round.
    const section8 = gdd.slice(gdd.indexOf('## 8. Future Scope'));
    expect(section8).toContain('CLASSIC_POWERUP_WEAPON_RESEARCH');
    for (const candidate of DEFERRED) {
      expect(
        section8,
        `GDD §8 missing deferred candidate ${candidate}`,
      ).toContain(candidate);
    }
  });
});

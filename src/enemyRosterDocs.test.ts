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

/**
 * The elite (anomaly) **variant axis** guard
 * (AH-0MWU667OG00287SY, parent AH-0MWL7P1AO003LKXT AC10).
 *
 * An elite is not a roster entry: it is a variant of an existing counted
 * archetype. This guard therefore asserts the axis itself — the authored CSV
 * cells, the normative GDD entries (§4.1 archetypes, §4.6 difficulty axes,
 * §8.3 mechanic) and the measured balance evidence — rather than a new
 * archetype row. Source behaviour is pinned by the elite unit/campaign tests
 * and the gym-parity guard.
 */
describe('Elite (anomaly) variant axis is documented (AH-0MWU667OG00287SY)', () => {
  const gdd = read(GDD);
  const csv = read(path.resolve(process.cwd(), 'src/data/enemy-configs.csv'));
  const balancing = read(path.resolve(process.cwd(), 'docs/BALANCING.md'));

  /** The authored rows (key + behaviour + bonus), parsed by header position. */
  const authored = (() => {
    const lines = csv.split('\n');
    const headerIndex = lines.findIndex((line) => line.startsWith('key,displayName'));
    if (headerIndex < 0) return [];
    const header = lines[headerIndex].split(',');
    const behaviour = header.indexOf('eliteBehaviour');
    const bonus = header.indexOf('eliteBonusHp');
    return lines
      .slice(headerIndex + 1)
      .filter((line) => line.trim() !== '')
      .map((line) => line.split(','))
      .filter((cells) => (cells[behaviour] ?? '').trim() !== '')
      .map((cells) => ({
        key: cells[0],
        behaviour: cells[behaviour],
        bonus: cells[bonus],
      }));
  })();

  it('the shipped CSV authors bounded variants on counted archetypes (AC1)', () => {
    expect(authored.length).toBeGreaterThan(0);
    for (const row of authored) {
      expect(
        ['splitter', 'reinforced', 'volatile'],
        `${row.key} behaviour`,
      ).toContain(row.behaviour.trim());
      const bonus = Number(row.bonus);
      expect(Number.isInteger(bonus), `${row.key} bonus`).toBe(true);
      expect(bonus).toBeGreaterThanOrEqual(1);
      expect(bonus).toBeLessThanOrEqual(3);
    }
  });

  it('GDD §4.1 describes the variant axis (AC3)', () => {
    // The archetype catalogue names the axis next to the roster and points at
    // the shared vocabulary/spawn modules the game and gyms use.
    expect(gdd).toMatch(/Elite \(anomaly\) variant/);
    for (const behaviour of ['splitter', 'reinforced', 'volatile']) {
      expect(gdd, `GDD §4.1 missing ${behaviour}`).toContain(behaviour);
    }
    expect(gdd).toContain('src/core/eliteVocabulary.ts');
    expect(gdd).toContain('src/scenes/core/eliteMechanics.ts');
  });

  it('GDD §4.6 records the elite axis and its level-1 exemption (AC3)', () => {
    const section = gdd.slice(gdd.indexOf('### 4.6 Level Progression Mechanics'));
    expect(section).toContain('ELITE_WAVE_CHANCE');
    expect(section).toMatch(/level 1 .*elite|elite.*level 1/i);
  });

  it('GDD §8.3 documents the mechanic and links the measured evidence (AC3)', () => {
    const section = gdd.slice(
      gdd.indexOf('#### Anomaly (elite) enemies and wave twists'),
      gdd.indexOf('## 9.') >= 0
        ? gdd.indexOf('## 9.')
        : gdd.indexOf('### 8.4'),
    );
    expect(section).toContain('AH-0MWL7P1AO003LKXT');
    expect(section).toContain('docs/BALANCING.md');
    expect(section).toContain('experience-target');
  });

  it('docs/BALANCING.md carries the measured before/after table (AC2)', () => {
    expect(balancing).toContain('Elite (anomaly) wave budget');
    expect(balancing).toContain('--elite-chance');
    expect(balancing).toContain('experience-target');
  });
});

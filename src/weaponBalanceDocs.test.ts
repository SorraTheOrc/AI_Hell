/**
 * Docs guard for the weapon balance tables and the strength budget
 * (parent AH-0MVRENEME004FS8T AC1/AC7; published by AH-0MVWAVLLG002I284).
 *
 * The 40 % level-0 trim (AH-0MVWAVKS0005P9VN) and the flattened upgrade curve
 * (AH-0MVWAVL6R001UI60) changed numbers that are quoted across the
 * player-facing references. This guard fails if any of those quotes drift from
 * the shipped catalogue: the GDD §4.4 weapon rows (cadence + AOE radius), the
 * GDD §4.4.2 variable catalogue (base/cap/k/level-1), the strength-budget
 * tables and ceilings, `README.md`'s nominal fire-rate list and
 * `docs/BALANCING.md`'s budget reference. It also pins GDD §2.7 to
 * `experience-targets.json`, because that narrative may only move with a
 * `targetsVersion` bump.
 *
 * Like the sibling docs guards (`weaponLevelingDocs.test.ts`,
 * `aoeDocs.test.ts`), this is a deliberate docs grep: every expected string is
 * derived from the code catalogue, not from re-implemented arithmetic, so the
 * documentation cannot silently disagree with `weapons.ts` /
 * `weaponLevels.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { curveValue, type CurveSpec } from './utils/curve';
import { weaponStrength } from './utils/weaponStrength';
import {
  AOE_RADII,
  DEFAULT_WEAPON_SUBDIVISIONS,
  WEAPON_CATALOGUE,
  type WeaponId,
} from './utils/weapons';
import {
  UPGRADE_VARIABLES,
  WEAPON_UPGRADE_SPECS,
} from './utils/weaponLevels';

const ROOT = process.cwd();
const GDD_PATH = path.resolve(ROOT, 'docs/Game Design Document.md');
const README_PATH = path.resolve(ROOT, 'README.md');
const BALANCING_PATH = path.resolve(ROOT, 'docs/BALANCING.md');
const TARGETS_PATH = path.resolve(ROOT, 'src/data/experience-targets.json');

/** Beat period at the default 80 BPM (ms). */
const BEAT_PERIOD_MS = 750;

/** Slices a markdown document between two headings. */
function slice(doc: string, start: string, end: string): string {
  const from = doc.indexOf(start);
  expect(from, `missing section: ${start}`).toBeGreaterThanOrEqual(0);
  const to = doc.indexOf(end, from);
  expect(to, `missing section end: ${end}`).toBeGreaterThan(from);
  return doc.slice(from, to);
}

/** A markdown table row (or paragraph) that starts with `prefix`. */
function rowStartingWith(doc: string, prefix: string): string {
  const row = doc
    .split('\n')
    .find((line) => line.startsWith(prefix));
  expect(row, `missing row starting with ${prefix}`).toBeDefined();
  return row as string;
}

/** Shots-per-beat token as the docs spell it (e.g. `2/beat`, `1/2-beat`). */
function beatToken(subdivision: number): string {
  if (subdivision >= 1) return `${subdivision}/beat`;
  return `1/${Math.round(1 / subdivision)}-beat`;
}

/** The weapon's nominal fire interval (ms) on the default beat grid. */
function fireIntervalMs(weapon: WeaponId): number {
  return BEAT_PERIOD_MS / DEFAULT_WEAPON_SUBDIVISIONS[weapon];
}

/** How the GDD's variable table renders a level-1 value. */
function level1Cell(spec: CurveSpec): string {
  const value = curveValue(spec, 1);
  return spec.discrete ? `${value}` : `≈${value.toFixed(2)}`;
}

const gdd = fs.readFileSync(GDD_PATH, 'utf8');
const readme = fs.readFileSync(README_PATH, 'utf8');
const balancing = fs.readFileSync(BALANCING_PATH, 'utf8');
const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')) as {
  targetsVersion: number;
};

/** GDD §4.4 (power-up/weapon table) and §4.4.2 (weapon leveling) sections. */
const powerUpsSection = slice(gdd, '### 4.4 Power-Ups', '#### 4.4.2 Weapon Leveling');
const levelingSection = slice(
  gdd,
  '#### 4.4.2 Weapon Leveling',
  '#### 4.4.3 Power-Up Leveling',
);

describe('weapon balance documentation matches the catalogue (AC7)', () => {
  it('the GDD §4.4 weapon rows quote the post-trim cadence and AOE radius', () => {
    // Cadence rows: each row spells its rate the way the catalogue reads it.
    const cadenceRows: ReadonlyArray<[string, WeaponId, string]> = [
      ['| P2 |', 'rapid', '3/beat'],
      ['| P3 |', 'wave_laser', '0.5/beat'],
      ['| P4 |', 'ricochet', '0.5/beat'],
      ['| P5 |', 'cluster', 'every 4 beats'],
      ['| P6 |', 'options', '0.5/beat'],
    ];
    for (const [prefix, weapon, subdivisionText] of cadenceRows) {
      const row = rowStartingWith(powerUpsSection, prefix);
      expect(row, `${prefix} cadence`).toContain(`${fireIntervalMs(weapon)} ms`);
      expect(row, `${prefix} subdivision`).toContain(subdivisionText);
    }
    // AOE rows: the radius is the trimmed one, quoted as a whole pixel.
    const radiusRows: ReadonlyArray<[string, keyof typeof AOE_RADII]> = [
      ['| A1 |', 'nova'],
      ['| A2 |', 'mortar'],
      ['| A3 |', 'arc'],
    ];
    for (const [prefix, weapon] of radiusRows) {
      const row = rowStartingWith(powerUpsSection, prefix);
      expect(row, `${prefix} radius`).toContain(`within **${AOE_RADII[weapon]} px**`);
      // No stale pre-trim radius survives in the same row.
      for (const stale of [45, 35, 60]) {
        if (stale !== AOE_RADII[weapon]) {
          expect(row, `${prefix} stale ${stale} px`).not.toContain(
            `within **${stale} px**`,
          );
        }
      }
    }
  });

  it('the GDD §4.4.2 variable catalogue quotes base/cap/k/level-1 from WEAPON_UPGRADE_SPECS', () => {
    const tableRows = levelingSection
      .split('\n')
      .filter((line) => line.startsWith('| '))
      // The MVP rows bold their label; compare against the plain label.
      .map((line) => line.replace(/\*\*/g, ''));
    for (const variable of UPGRADE_VARIABLES) {
      const spec = WEAPON_UPGRADE_SPECS[variable];
      const row = tableRows.find((line) =>
        line.includes(`${spec.label} (`),
      );
      expect(row, `GDD row for ${spec.label}`).toBeDefined();
      expect(row, `base/cap/k/level-1 for ${spec.label}`).toContain(
        `| ${spec.base} | ${spec.cap} | ${spec.k.toFixed(2)} | ${level1Cell(spec)} |`,
      );
    }
  });

  it('the GDD §4.4.2 documents the strength budget, its output definition and its ceilings', () => {
    for (const anchor of [
      'Weapon strength budget',
      'WEAPON_STRENGTH_BUDGET',
      'weaponStrength.ts',
      'projectile:** pattern bullets × shots/s',
      'pierce:** hit-point budget × hits/s',
      'bounce:** `(1 + bounce)` targets × hits/s',
      'split:** (missile + every warhead) × hits/s',
      'orbit:** pod count × shots/s',
      'radius² × shots/s',
      '60 %',
      '1.5× the cannon',
      '2.5×',
      '50 %',
    ]) {
      expect(levelingSection, anchor).toContain(anchor);
    }
    // AC1: the pre-change baseline table and the committed post-change table
    // are both present, so the 40 % trim stays auditable.
    const preChange = slice(
      levelingSection,
      'Pre-change level-0 baselines',
      'Post-change level-0 table',
    );
    const postChange = slice(
      levelingSection,
      'Post-change level-0 table',
      'Worked example',
    );
    for (const weapon of Object.keys(WEAPON_CATALOGUE) as WeaponId[]) {
      expect(preChange, `pre-change row for ${weapon}`).toMatch(
        new RegExp(`\\| ${weapon} `),
      );
      const rateRow = postChange
        .split('\n')
        .find((line) => line.startsWith(`| ${weapon} `));
      expect(rateRow, `post-change row for ${weapon}`).toBeDefined();
      // The doc table is pinned to the executable measure, not a re-derivation.
      expect(rateRow, `post-change output for ${weapon}`).toContain(
        `${weaponStrength(weapon, 0).output.toFixed(2)} `,
      );
    }
    // The worked example quotes the resolved cannon-pattern numbers.
    const worked = slice(levelingSection, 'Worked example', '**Beat-grid invariant.**');
    expect(worked).toContain('5.33 hits/s');
    expect(worked).toContain('26.67 hits/s');
    expect(worked).toContain('37 %');
  });

  it('README.md quotes the shipped nominal fire rates and the single-hit wave laser', () => {
    const listed: WeaponId[] = [
      'cannon',
      'spread',
      'dual',
      'rapid',
      'wave_laser',
      'ricochet',
      'cluster',
      'options',
      'nova',
      'mortar',
      'arc',
    ];
    for (const weapon of listed) {
      const token = `\`${weapon}\``;
      const entry = readme
        .split('\n')
        .filter((line) => line.startsWith('- `src/utils/weapons.ts`'))
        .find((line) => line.includes(`${token} `) || line.includes(`${token} (`));
      expect(entry, `README weapons entry for ${weapon}`).toBeDefined();
      expect(entry as string, `README fire rate for ${weapon}`).toContain(
        `${weapon} ${beatToken(DEFAULT_WEAPON_SUBDIVISIONS[weapon])} = ${fireIntervalMs(weapon)} ms`,
      );
    }
    expect(readme).toContain('single red hitscan beam');
    // No pre-trim cadence survives anywhere in the README.
    for (const stale of [
      'rapid 6/beat',
      'spread 1/beat',
      'dual 1/beat',
      'ricochet 1/beat',
      'cluster 1/2-beat',
      'options 1/beat',
    ]) {
      expect(readme, `stale README cadence: ${stale}`).not.toContain(stale);
    }
  });

  it('BALANCING.md references the strength budget and the flattened fire-rate curve', () => {
    for (const anchor of [
      '### Strength budget (the numeric half of Q3 = B)',
      'WEAPON_STRENGTH_BUDGET',
      'src/utils/weaponStrength.ts',
      '§4.4 Power-Ups',
      '§4.4.2 Weapon Leveling',
      '60 %',
      '1.5×',
      '2.5× L0',
      '50 % of the pre-change saturated output',
    ]) {
      expect(balancing, anchor).toContain(anchor);
    }
    // The ladder paragraphs describe the shipped (flattened) curve.
    expect(balancing).toContain('cap 2.2×, `k = 0.12`');
    expect(balancing).toContain('Rungs at or above the 2.2× asymptote are omitted');
  });

  it('GDD §2.7 stays in step with the committed experience targets (AC5)', () => {
    const experience = slice(
      gdd,
      '### 2.7 Intended experience: measurable targets',
      '## 3. MVP Vertical-Slice Content',
    );
    expect(experience).toContain(`targets v${targets.targetsVersion}`);
    // waveReached is the band the measured gate compared against; it may only
    // change together with the artefact (targetsVersion bump + this narrative).
    expect(experience).toContain('6.46 ± 4.96');
  });
});

/**
 * Docs guard for the weapon-tuning data surfaces and the designer retuning
 * guide (AH-0MW0Q1JK8001ZJ8I, epic AH-0MW0Q01VM004EPY7 AC6).
 *
 * The designer-facing contract lives in
 * `docs/BALANCING.md` → "Weapon tuning CSV": the files, every column with its
 * units and legal values, the hand-edit and panel workflows, the
 * blank-means-absent convention, degrees-authored angles, the on-beat-grid
 * fire-rate authored as shots per beat, the runtime invariants with their
 * fallback, and — explicitly — what each surface **cannot** do.
 *
 * The column list is derived from `WEAPON_COLUMN_ORDER` (and the enum cells
 * from `VALID_BULLET_SHAPES` / `VALID_AOE_TRIGGERS`), not re-typed, so a new
 * column or enum value cannot be added to the codec without the designer guide
 * covering it. Like the sibling docs guards (`weaponLevelingDocs.test.ts`,
 * `src/ai/eval/balancingDocs.test.ts`) this is a deliberate docs grep: it
 * asserts the canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  VALID_AOE_TRIGGERS,
  VALID_BULLET_SHAPES,
  WEAPON_COLUMN_ORDER,
  WEAPON_PATTERN_COLUMN_ORDER,
} from './core/csv';
import { WEAPON_IDS } from './utils/weapons';

const ROOT = process.cwd();
const BALANCING_PATH = path.resolve(ROOT, 'docs/BALANCING.md');
const GYM_PARITY_PATH = path.resolve(ROOT, 'docs/GYM_PARITY.md');
const README_PATH = path.resolve(ROOT, 'README.md');

const SECTION_HEADING = '## Weapon tuning CSV (AH-0MW0Q01VM004EPY7)';
const SECTION_END = '## Weapon Euclidean upgrade ladder (AH-0MVYA291J000CK64)';
const GYM_SECTION_HEADING =
  '### The weapon panel is a tuning surface, not a gameplay gym (AH-0MW0Q01VM004EPY7)';

const balancing = fs.readFileSync(BALANCING_PATH, 'utf8');
const gymParity = fs.readFileSync(GYM_PARITY_PATH, 'utf8');
const readme = fs.readFileSync(README_PATH, 'utf8');

/** The retuning section, from its heading to the cadence section that follows. */
function retuningSection(): string {
  const from = balancing.indexOf(SECTION_HEADING);
  expect(from, `missing section: ${SECTION_HEADING}`).toBeGreaterThanOrEqual(0);
  const to = balancing.indexOf(SECTION_END, from);
  expect(to, `missing section end: ${SECTION_END}`).toBeGreaterThan(from);
  return balancing.slice(from, to);
}

/** Table cell values of a markdown row, trimmed. */
function cells(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Rows of the section whose first cell is exactly the given code span. */
function rowsForColumn(section: string, column: string): string[][] {
  return section
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map(cells)
    .filter((row) => row[0] === `\`${column}\``);
}

describe('the weapon-tuning data surfaces are documented (AH-0MW0Q01VM004EPY7)', () => {
  it('has a dedicated retuning section before the cadence section', () => {
    expect(balancing).toContain(SECTION_HEADING);
    expect(retuningSection().length).toBeGreaterThan(2_000);
  });

  it('names all three data files and their roles', () => {
    const section = retuningSection();
    expect(section).toContain('`src/data/weapons.csv`');
    expect(section).toContain('`src/data/weapon-patterns.csv`');
    expect(section).toContain('`src/data/weapon-levels.json`');
    // The cadence file is the live fire rate; the CSV cell is the legacy value.
    expect(section).toMatch(/legacy nominal/);
  });

  it('documents every weapons.csv column exactly once, with meaning and units/legality', () => {
    const section = retuningSection();
    for (const column of WEAPON_COLUMN_ORDER) {
      const rows = rowsForColumn(section, column);
      expect(rows, `no table row for column \`${column}\``).toHaveLength(1);
      const [, meaning = '', legal = ''] = rows[0];
      expect(meaning.length, `\`${column}\` has no meaning`).toBeGreaterThan(10);
      expect(legal.length, `\`${column}\` has no units/legal values`).toBeGreaterThan(2);
    }
  });

  it('lists the full weapon id roster and both enum vocabularies', () => {
    const section = retuningSection();
    for (const id of WEAPON_IDS) expect(section, `missing id ${id}`).toContain(`\`${id}\``);
    for (const shape of VALID_BULLET_SHAPES) {
      expect(section, `missing bulletShape ${shape}`).toContain(`\`${shape}\``);
    }
    for (const trigger of VALID_AOE_TRIGGERS) {
      expect(section, `missing aoeTrigger ${trigger}`).toContain(`\`${trigger}\``);
    }
  });

  it('documents the long-format pattern CSV, authored in degrees', () => {
    const section = retuningSection();
    for (const column of WEAPON_PATTERN_COLUMN_ORDER) {
      expect(section, `missing pattern column \`${column}\``).toContain(`\`${column}\``);
    }
    expect(section).toMatch(/degrees/i);
    expect(section).toMatch(/radians/i);
  });

  it('states the blank-means-absent convention and why', () => {
    const section = retuningSection();
    expect(section).toMatch(/blank cell (means|marks)/i);
    expect(section).toMatch(/presence/i);
    expect(section).toMatch(/never\s+(read as|treated as)\s+`?0`?/i);
  });

  it('documents the two authoring workflows and the read-only production behaviour', () => {
    const section = retuningSection();
    expect(section).toContain('npm run dev');
    expect(section).toContain('npm run build');
    expect(section).toMatch(/Save As/);
    expect(section).toMatch(/read-only/i);
    // A rebuild, not a refresh, is required for a shipped build.
    expect(section).toMatch(/rebuild/i);
  });

  it('documents the runtime invariants and the fallback ladder', () => {
    const section = retuningSection();
    for (const invariant of [
      'beat grid',
      'unique bullet colour',
      'shape family',
    ]) {
      expect(section.toLowerCase()).toContain(invariant);
    }
    expect(section).toMatch(/code default/i);
    expect(section).toMatch(/still boots|never (crash|crashes)/i);
    expect(section).toContain('src/utils/weaponCatalogue.ts');
  });

  it('states the on-beat fire rate authored as shots per beat', () => {
    const section = retuningSection();
    expect(section).toMatch(/shots per beat/i);
    expect(section).toMatch(/80 BPM/);
    expect(section).toMatch(/legacy nominal/);
    expect(section).toContain('`src/data/weapon-levels.json`');
  });

  it('works through the three required retunes with their verification', () => {
    const section = retuningSection();
    expect(section).toMatch(/bullet colour/i);
    expect(section).toContain('bulletColor');
    expect(section).toContain('`aoeRadius`');
    expect(section).toMatch(/nova/i);
    // The cadence retune is a rung edit, not a `subdivisions` edit.
    expect(section).toMatch(/\{ ?"?k"? ?:/);
    expect(section).toMatch(/verify|check/i);
  });

  it('states what each surface cannot do, with the follow-up path', () => {
    const section = retuningSection();
    // CSV row cannot add a weapon: it needs an icon arm and an audio cue arm.
    expect(section).toContain('src/powerups/icons.ts');
    expect(section).toContain('src/audio/effects.ts');
    expect(section).toMatch(/cannot add a weapon/i);
    // The CSV cannot change cadence; the ladder file cannot add a weapon either.
    expect(section).toMatch(/cannot change (the )?(fire )?cadence/i);
    expect(section).toMatch(/weapon-levels\.json[^.]*cannot add a weapon|weapon-levels\.json` cannot add a weapon/i);
  });

  it('documents the retune tripwires a deliberate change must regenerate', () => {
    const section = retuningSection();
    expect(section).toContain('src/data/weapon-catalogue-parity.json');
    expect(section).toContain('src/data/weapon-levels-parity.json');
    expect(section).toContain('src/data/weaponsCsvSeed.test.ts');
    expect(section).toContain('npm run generate:weapon-csv-seed');
  });

  it('has no broken relative links in the retuning section', () => {
    const section = retuningSection();
    const targets = [...section.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((match) => match[1])
      .filter((target) => !/^(https?:|#|mailto:)/.test(target))
      .map((target) => target.split('#')[0])
      .filter((target) => target !== '');
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      const resolved = path.resolve(path.dirname(BALANCING_PATH), target);
      expect(fs.existsSync(resolved), `broken relative link: ${target}`).toBe(true);
    }
  });
});

describe('the gym-parity matrix carries the weapon tuning-surface note (AH-0MW0Q01VM004EPY7)', () => {
  it('states that the panel is a tuning surface, not a gameplay gym', () => {
    expect(gymParity).toContain(GYM_SECTION_HEADING);
    const from = gymParity.indexOf(GYM_SECTION_HEADING);
    const section = gymParity.slice(from, from + 4_000);
    expect(section).toContain('`GymWeaponTuning`');
    expect(section).toMatch(/tuning surface, not a gameplay gym/i);
  });

  it('forbids a data-driven divergence between PlayScene and the gyms', () => {
    const from = gymParity.indexOf(GYM_SECTION_HEADING);
    const section = gymParity.slice(from, from + 4_000);
    expect(section).toContain('`PlayScene`');
    expect(section).toContain('`src/data/weapons.csv`');
    expect(section).toContain('`src/data/weapon-levels.json`');
    expect(section).toMatch(/must not diverge|never diverge/i);
    expect(section).toContain('src/utils/weapons.ts');
    expect(section).toContain('docs/BALANCING.md');
  });
});

describe('README points at the weapon data files (AH-0MW0Q01VM004EPY7)', () => {
  it('lists the weapon CSVs under the configuration section', () => {
    const from = readme.indexOf('#### Configuration (CSV)');
    expect(from).toBeGreaterThanOrEqual(0);
    const section = readme.slice(from, readme.indexOf('#### Sequenced Waves', from));
    expect(section).toContain('src/data/weapons.csv');
    expect(section).toContain('src/data/weapon-patterns.csv');
    expect(section).toContain('docs/BALANCING.md');
    expect(section).toContain('WeaponTuning');
  });
});

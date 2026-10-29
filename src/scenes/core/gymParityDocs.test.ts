import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Docs guard for the gym-parity principle (AH-0MUGZDTFX004RBD1, AC4).
 *
 * The producer directive is that gyms are the canonical parity reference for
 * the game, and that any gameplay behaviour change must be applied
 * consistently to the corresponding gym scene(s) and the game unless a
 * documented reason exists to diverge. `AGENTS.md` must state that rule
 * explicitly and name the files it covers, so a reader knows exactly which
 * scenes are in scope.
 *
 * This is the automated grep required by AC4: it fails if the rule text or the
 * named gym/game directories are removed or weakened. It asserts the evidence
 * inside the named section rather than anywhere in the file, so an unrelated
 * mention of a gym cannot satisfy the guard.
 */
const AGENTS_MD = path.resolve(process.cwd(), 'AGENTS.md');
const GYM_PARITY_SECTION = '## Game Architecture Conventions';
const ENEMY_DESIGN_MD = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);
const ENEMY_SPAWN_SEAM_SECTION = '### 5.1 Gym parity';

/**
 * Content §5.1 must state for the shared spawn seam (AH-0MVRMI2M50098WN5 AC1).
 * Each requirement is a label plus the pattern that proves it, so the guard
 * can report exactly which statement a future edit deleted.
 */
const SPAWN_SEAM_DOC_REQUIREMENTS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  {
    label: 'the shared seam module',
    pattern: /src\/scenes\/core\/spawnTransit\.ts/,
  },
  { label: 'the autonomous-mover exemption', pattern: /autonomous/i },
  {
    label: 'the orbital live-slot branch',
    pattern: /formationSlot|orbital/i,
  },
  { label: 'the grid-slot/offset fallback', pattern: /grid slot|offset fallback/i },
  { label: 'the PlayScene spawn site', pattern: /PlayScene/ },
  { label: 'the GymFormationScene spawn site', pattern: /GymFormationScene/ },
  { label: 'the GymLevel spawn site', pattern: /GymLevel/ },
  { label: 'the GymBoss spawn site', pattern: /GymBoss/ },
  { label: 'the shootEnabled hand-off', pattern: /shootEnabled/ },
  { label: 'the march block adoption', pattern: /march/i },
  { label: 'the parity matrix link', pattern: /docs\/GYM_PARITY\.md/ },
];

/** Requirements (by label) that `source` does not state. */
function unmetSpawnSeamDoc(source: string): string[] {
  const text = source.replace(/\s+/g, ' ');
  return SPAWN_SEAM_DOC_REQUIREMENTS.filter(
    (requirement) => !requirement.pattern.test(text),
  ).map((requirement) => requirement.label);
}

/**
 * Spawn-seam statements the `AGENTS.md` shared-core surface must keep
 * (AH-0MVRMI2M50098WN5 AC3).
 */
const AGENTS_SPAWN_SEAM_REQUIREMENTS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  {
    label: 'the spawn seam module in the shared core',
    pattern: /src\/scenes\/core\/spawnTransit\.ts/,
  },
  {
    label: 'the parity matrix link',
    pattern: /docs\/GYM_PARITY\.md/,
  },
];

/** Requirements (by label) that `source` does not state. */
function unmetAgentsSpawnSeamDoc(source: string): string[] {
  const text = source.replace(/\s+/g, ' ');
  return AGENTS_SPAWN_SEAM_REQUIREMENTS.filter(
    (requirement) => !requirement.pattern.test(text),
  ).map((requirement) => requirement.label);
}

/** Return the body of `heading` up to the next level-2 heading (or EOF). */
function sectionBody(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) return '';
  const rest = source.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('AGENTS.md documents the gym-parity principle (AH-0MUGZDTFX004RBD1)', () => {
  const source = fs.readFileSync(AGENTS_MD, 'utf8');
  // Collapse prose line-wrapping so assertions match the rule text, not the
  // markdown wrapping.
  const rule = sectionBody(source, GYM_PARITY_SECTION).replace(/\s+/g, ' ');

  it('has a Game Architecture Conventions section (AC1)', () => {
    expect(source).toContain(GYM_PARITY_SECTION);
    expect(rule.trim().length).toBeGreaterThan(0);
  });

  it('states gyms are the canonical parity reference for the game (AC1)', () => {
    expect(rule).toMatch(/gyms are the canonical parity reference/i);
  });

  it('requires gameplay changes to apply to the corresponding gym scene(s) and the game (AC1)', () => {
    expect(rule).toMatch(/applied consistently/i);
    expect(rule).toMatch(/gym scene\(s\) and the game/i);
  });

  it('allows divergence only with a documented reason (AC1)', () => {
    expect(rule).toMatch(/documented reason/i);
    expect(rule).toMatch(/to diverge/i);
  });

  it('names the gym scene directory and its generic base (AC2)', () => {
    expect(rule).toContain('src/scenes/gym/');
    expect(rule).toContain('src/scenes/gym/core/');
  });

  it('names the game-side scene and the shared core (AC2)', () => {
    expect(rule).toContain('PlayScene');
    expect(rule).toContain('src/scenes/core/');
  });

  it('names the spawn seam in the shared-core surface (AC3)', () => {
    const section = sectionBody(source, GYM_PARITY_SECTION);
    expect(unmetAgentsSpawnSeamDoc(section)).toEqual([]);
  });

  it('fails when the spawn seam or the matrix link is removed (AC3 red-before)', () => {
    const section = sectionBody(source, GYM_PARITY_SECTION);
    const withoutSeam = section.replace(
      /src\/scenes\/core\/spawnTransit\.ts/g,
      '',
    );
    expect(unmetAgentsSpawnSeamDoc(withoutSeam)).toContain(
      'the spawn seam module in the shared core',
    );
    const withoutMatrix = section.replace(/docs\/GYM_PARITY\.md/g, '');
    expect(unmetAgentsSpawnSeamDoc(withoutMatrix)).toContain(
      'the parity matrix link',
    );
  });
});

// ── Gym parity matrix guard (AH-0MVRMHUOG005P38A) ──────────────────
//
// The sweep publishes `docs/GYM_PARITY.md`: one row per gym scene with the
// shipped objects it runs, its spawn seam, combat-loop inheritance and a
// verdict. These assertions make the matrix self-maintaining: a new
// production `Gym*.ts` scene without a row fails, a row without a permitted
// verdict fails, and a row without a file/section reference fails. The
// red-before case is demonstrated against a fixture scene directory, so the
// guard can be proven to catch a missing row without touching the repo.

const GYM_SCENE_DIR = path.resolve(process.cwd(), 'src/scenes/gym');
const GYM_PARITY_MATRIX = path.resolve(process.cwd(), 'docs/GYM_PARITY.md');

/** Verdict vocabulary the matrix is allowed to use. */
const GYM_VERDICTS = [
  'parity',
  'intentional divergence',
  'divergence to fix',
] as const;

/** Production `Gym*.ts` scene keys directly under `dir` (tests excluded). */
function gymSceneKeys(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter(
      (file) => /^Gym[A-Za-z0-9]*\.ts$/.test(file) && !file.endsWith('.test.ts'),
    )
    .map((file) => path.basename(file, '.ts'))
    .sort();
}

/** Scene keys declared in the first column of a matrix table row. */
function matrixSceneKeys(matrix: string): string[] {
  const keys: string[] = [];
  for (const line of matrix.split('\n')) {
    const match = /^\|\s*`(Gym[A-Za-z0-9]+)`/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Raw cells of every gym table row (leading/trailing empties included). */
function matrixRows(matrix: string): string[][] {
  return matrix
    .split('\n')
    .filter((line) => /^\|\s*`Gym[A-Za-z0-9]+`/.test(line))
    .map((line) => line.split('|'));
}

/** The verdict a matrix row declares, with markdown code markers removed. */
function rowVerdict(cells: readonly string[]): string {
  return (cells[6] ?? '').replace(/`/g, '').trim();
}

/** Scene keys that have no row in `matrix`. */
function findUnlistedGymScenes(
  sceneKeys: readonly string[],
  matrix: string,
): string[] {
  const listed = new Set(matrixSceneKeys(matrix));
  return sceneKeys.filter((key) => !listed.has(key));
}

describe('docs/GYM_PARITY.md records every gym scene (AH-0MVRMHUOG005P38A)', () => {
  const matrix = fs.readFileSync(GYM_PARITY_MATRIX, 'utf8');
  const sceneKeys = gymSceneKeys(GYM_SCENE_DIR);

  it('audits the 14 production gym scenes (AC1)', () => {
    expect(sceneKeys).toEqual([
      'GymBoss',
      'GymBotTuning',
      'GymCentipede',
      'GymCurveSequencer',
      'GymFodderEnemies',
      'GymLevel',
      'GymMinerals',
      'GymMiniBoss',
      'GymPlayer',
      'GymPowerUpLeveling',
      'GymPowerUpsCombat',
      'GymPowerUpsUtility',
      'GymWeaponLeveling',
      'GymWeapons',
    ]);
  });

  it('lists a matrix row for every gym scene (AC1, AC3)', () => {
    expect(findUnlistedGymScenes(sceneKeys, matrix)).toEqual([]);
  });

  it('lists the generic GymFormationScene base as its own row (AC1)', () => {
    expect(matrixSceneKeys(matrix)).toContain('GymFormationScene');
  });

  it('reports a gym scene with no row as unlisted (AC3 red-before)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-parity-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'GymFixtureScene.ts'),
        'export class GymFixtureScene {}\n',
      );
      const discovered = gymSceneKeys(dir);
      expect(discovered).toEqual(['GymFixtureScene']);
      expect(findUnlistedGymScenes(discovered, matrix)).toEqual([
        'GymFixtureScene',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report an already-listed scene as unlisted (AC3 green)', () => {
    expect(findUnlistedGymScenes(['GymLevel', 'GymBoss'], matrix)).toEqual([]);
  });

  it('classifies every row with a permitted verdict (AC2)', () => {
    const rows = matrixRows(matrix);
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const cells of rows) {
      const scene = cells[1].trim();
      const verdict = rowVerdict(cells);
      expect(
        GYM_VERDICTS.some((allowed) => verdict.startsWith(allowed)),
        `${scene} has verdict ${JSON.stringify(verdict)}`,
      ).toBe(true);
    }
  });

  it('gives every row a reason/evidence reference (AC2, AC4)', () => {
    for (const cells of matrixRows(matrix)) {
      const scene = cells[1].trim();
      const reason = (cells[7] ?? '').trim();
      expect(reason.length, `${scene} has an empty reason cell`).toBeGreaterThan(
        0,
      );
      expect(
        reason,
        `${scene} reason lacks a file/section reference`,
      ).toMatch(/[\w./-]+\.(ts|md|mjs)|§\d|docs\//);
    }
  });

  it('points every divergence-to-fix row at a numbered detail section (AC4)', () => {
    for (const cells of matrixRows(matrix)) {
      const scene = cells[1].trim();
      const verdict = rowVerdict(cells);
      if (!verdict.startsWith('divergence to fix')) continue;
      expect(
        cells[7] ?? '',
        `${scene} must reference a D-numbered detail section`,
      ).toMatch(/\bD[1-9]\b/);
    }
  });

  it('states that PlayScene is the reference and the game never follows a gym (AC1)', () => {
    expect(matrix).toMatch(/PlayScene[^\n]*is the reference/i);
    expect(matrix).toMatch(/never be changed to match a gym/i);
  });

  it('documents how to re-audit and names the automated guards (AC1)', () => {
    expect(matrix).toMatch(/## How to re-audit/i);
    expect(matrix).toContain('CombatScene.equivalence.test.ts');
    expect(matrix).toContain('spawnParity.test.ts');
    expect(matrix).toContain('gymParityDocs.test.ts');
  });

  it('records the three spawn divergences as fixed by AH-0MVRMHSKH0066J9B (AC6)', () => {
    expect(matrix).toContain('AH-0MVRMHSKH0066J9B');
    expect(matrix).toMatch(/orbital transit/i);
    expect(matrix).toMatch(/shootEnabled/i);
    expect(matrix).toMatch(/march block/i);
    expect(matrix).toMatch(/fixed-by-sibling/i);
  });

  it('re-justifies the five documented intentional divergences (AC2)', () => {
    expect(matrix).toMatch(/obstacle course/i);
    expect(matrix).toMatch(/AOE practice targets/i);
    expect(matrix).toMatch(/flat supply cadence/i);
    expect(matrix).toMatch(/gym-only HUDs/i);
    expect(matrix).toMatch(/absence of run telemetry/i);
    expect(matrix).toContain('docs/BALANCING.md');
    expect(matrix).toContain('ENEMY_DESIGN_AND_IMPLEMENTATION.md');
  });
});

// ── §5.1 spawn-seam docs guard (AH-0MVRMI2M50098WN5) ──────────────
//
// §5.1 is where a developer joining the spawn code is sent, so it must name
// the shared wormhole-transit seam (`src/scenes/core/spawnTransit.ts`), state
// the resolver rule, list the four consuming spawn sites, record the
// `shootEnabled`/march adoption on the level-launch path and point at the
// parity matrix. The red-before cases edit a copy of the real section in
// memory, so the guard is proven to fail when a future edit deletes the seam
// or the matrix link without touching the repository.

describe('docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md §5.1 documents the shared spawn seam (AH-0MVRMI2M50098WN5)', () => {
  const source = fs.readFileSync(ENEMY_DESIGN_MD, 'utf8');
  const section = sectionBody(source, ENEMY_SPAWN_SEAM_SECTION);

  it('is a non-empty §5.1 section', () => {
    expect(source).toContain(ENEMY_SPAWN_SEAM_SECTION);
    expect(section.trim().length).toBeGreaterThan(0);
  });

  it('names the seam, the rule, the four spawn sites and the matrix (AC1)', () => {
    expect(unmetSpawnSeamDoc(section)).toEqual([]);
  });

  it('fails when the spawn-seam module is deleted (AC4 red-before)', () => {
    const stale = section.replace(/src\/scenes\/core\/spawnTransit\.ts/g, '');
    expect(unmetSpawnSeamDoc(stale)).toContain('the shared seam module');
  });

  it('fails when the parity-matrix link is deleted (AC4 red-before)', () => {
    const stale = section.replace(/docs\/GYM_PARITY\.md/g, '');
    expect(unmetSpawnSeamDoc(stale)).toContain('the parity matrix link');
  });

  it('fails when a consuming spawn site is dropped (AC4 red-before)', () => {
    const stale = section.replace(/GymBoss/g, 'a gym');
    expect(unmetSpawnSeamDoc(stale)).toContain('the GymBoss spawn site');
  });

  it('keeps the documented intentional divergences (AC2)', () => {
    expect(section).toMatch(/obstacle course/i);
    expect(section).toMatch(/AOE practice targets/i);
    expect(section).toMatch(/flat supply cadence/i);
    expect(section).toContain('docs/BALANCING.md');
  });

  it('points at the guard tests that enforce the convention (AC1)', () => {
    expect(section).toContain('spawnParity.test.ts');
    expect(section).toContain('CombatScene.equivalence.test.ts');
    expect(section).toContain('gymParityDocs.test.ts');
  });

  it('does not point at a non-existent matrix path (AC1)', () => {
    expect(source).toContain('[`docs/GYM_PARITY.md`](./GYM_PARITY.md)');
    expect(fs.existsSync(path.resolve(process.cwd(), 'docs/GYM_PARITY.md'))).toBe(
      true,
    );
  });
});

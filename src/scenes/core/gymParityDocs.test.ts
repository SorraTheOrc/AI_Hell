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

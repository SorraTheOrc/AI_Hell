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

  it('audits the 21 production gym scenes (AC1)', () => {
    expect(sceneKeys).toEqual([
      'GymAsteroidStress',
      'GymBoss',
      'GymBotTuning',
      'GymCentipede',
      'GymCurveSequencer',
      'GymFodderEnemies',
      'GymHangar',
      'GymHexWar',
      'GymLevel',
      'GymMinerals',
      'GymMiniBoss',
      'GymPerformance',
      'GymPlayer',
      'GymPowerUpLeveling',
      'GymPowerUpsCombat',
      'GymPowerUpsUtility',
      'GymRechargeTuning',
      'GymRhythm',
      'GymWeaponLeveling',
      'GymWeaponTuning',
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

// ── Hangar-war gym rows (AH-0MVUXCC5J0028OGQ) ────────────────────
//
// The Hangar War's two gym scenes are read-only views of shipped screens. The
// docs item (B8) refreshes their rows so the matrix keeps naming the same
// model/renderer pair the game runs, rather than the scaffolding they started
// from.

describe('docs/GYM_PARITY.md carries current Hangar War rows (AH-0MVUXCC5J0028OGQ)', () => {
  const matrix = fs.readFileSync(GYM_PARITY_MATRIX, 'utf8');

  /** Raw cells of one scene's matrix row (empty when absent). */
  const rowCells = (scene: string): string[] =>
    matrixRows(matrix).find((cells) => cells[1].trim() === `\`${scene}\``) ?? [];

  it('records the Hangar War specification refresh', () => {
    expect(matrix).toContain('AH-0MVUXCC5J0028OGQ');
    expect(matrix).toMatch(/Hangar War/i);
    expect(matrix).toMatch(/ring specification/i);
  });

  it('points GymHangar at the shipped hangar screen and its game scene', () => {
    const cells = rowCells('GymHangar');
    expect(cells.length).toBeGreaterThan(7);
    // Enabled objects: the same model builder + renderer the game renders.
    expect(cells[3]).toContain('buildHangarScreenModel');
    expect(cells[3]).toContain('renderHangarScreen');
    // Reason: the game scene it mirrors.
    expect(cells[7]).toContain('HangarScene');
    // Verdict stays a documented divergence (a non-combat harness).
    expect(rowVerdict(cells)).toBe('intentional divergence');
  });

  it('points GymHexWar at the shipped map, frontier tick and rolled-in report', () => {
    const cells = rowCells('GymHexWar');
    expect(cells.length).toBeGreaterThan(7);
    expect(cells[3]).toContain('buildHexMapModel');
    expect(cells[3]).toContain('renderHexMap');
    expect(cells[3]).toContain('runFrontierTick');
    expect(cells[3]).toContain('buildDefenceReport');
    // The report is rolled into the map: arrows plus the left-hand attack
    // panel, no standalone report screen (AH-0MWEXJ21W003M7RR).
    expect(cells[3]).toContain('attack arrow');
    expect(cells[3]).toContain('left-hand attack panel');
    expect(cells[3]).not.toContain('renderDefenceReport');
    expect(cells[7]).toContain('HexMapScene');
    expect(cells[7]).not.toContain('DefenceReportScene');
    expect(rowVerdict(cells)).toBe('intentional divergence');
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

// ── Blocked-drop stick/discard docs guard (AH-0MW3H06AC004R47P) ────
//
// The blocked-drop rule belongs to the shared drop core, not to any gym, so
// the three places a reader looks (the matrix, the README's shared drop-layer
// paragraph and GDD §4.4) must name the same module, the same two constants
// and the same parent. `docs/GYM_PARITY.md` must record the behaviour as
// shared core rather than a divergence, otherwise a future sweep could
// "fix" it into a per-gym copy.

const README_MD = path.resolve(process.cwd(), 'README.md');
const GAME_DESIGN_MD = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const GYM_PARITY_DROP_SECTION = '## Blocked-drop stick and discard is shared core';
const GDD_POWER_UPS_SECTION = '### 4.4 Power-Ups';

describe('blocked-drop stick/discard is documented as shared core (AH-0MW3H06AC004R47P)', () => {
  const matrix = fs.readFileSync(GYM_PARITY_MATRIX, 'utf8');
  const readme = fs.readFileSync(README_MD, 'utf8');
  const gdd = fs.readFileSync(GAME_DESIGN_MD, 'utf8');
  const matrixSection = sectionBody(matrix, GYM_PARITY_DROP_SECTION).replace(
    /\s+/g,
    ' ',
  );
  const readmeDropParagraph = (readme.match(/Shared power-up drop layer[^\n]*/) ?? [
    '',
  ])[0];
  const gddPowerUps = sectionBody(gdd, GDD_POWER_UPS_SECTION).replace(/\s+/g, ' ');

  it('records the rule in docs/GYM_PARITY.md as shared core, not a divergence (AC3)', () => {
    expect(matrix).toContain(GYM_PARITY_DROP_SECTION);
    expect(matrixSection.trim().length).toBeGreaterThan(0);
    expect(matrixSection).toMatch(/not a divergence/i);
    expect(matrixSection).toMatch(/shared step|shared `CombatCoreScene/i);
    expect(matrixSection).toContain('src/scenes/core/blockedDropDiscard.ts');
    expect(matrixSection).toContain('AH-0MW0UAQ23005AC9L');
  });

  it('names both constants in the matrix section (AC3)', () => {
    expect(matrixSection).toContain('BLOCKED_DROP_STICK_SECONDS');
    expect(matrixSection).toContain('BLOCKED_DROP_THROW_SPEED');
  });

  it('names the stepper, its two constants and the eight consumers in the README (AC2)', () => {
    expect(readmeDropParagraph).toContain('src/scenes/core/blockedDropDiscard.ts');
    expect(readmeDropParagraph).toContain('BLOCKED_DROP_STICK_SECONDS');
    expect(readmeDropParagraph).toContain('BLOCKED_DROP_THROW_SPEED');
    expect(readmeDropParagraph).toMatch(/all eight drop consumers/i);
    expect(readmeDropParagraph).toContain('AH-0MW0UAQ23005AC9L');
  });

  it('states the stick/throw/edge/cancel rule and the parent in GDD §4.4 (AC1)', () => {
    expect(gdd).toContain(GDD_POWER_UPS_SECTION);
    expect(gddPowerUps).toContain('AH-0MW0UAQ23005AC9L');
    expect(gddPowerUps).toMatch(/sticks to the ship/i);
    expect(gddPowerUps).toMatch(/random direction/i);
    expect(gddPowerUps).toMatch(/screen edge/i);
    expect(gddPowerUps).toMatch(/cancelled/i);
    expect(gddPowerUps).toMatch(/no longer\s+collectable/i);
  });
});

// ── Shared asteroid silhouette/atlas render path (AH-0MW508UAQ002IC5N) ──
//
// The batched asteroid rendering change (AH-0MW5088LA007XYQM) must be
// recorded in the matrix as a **shared** seam, not a per-scene divergence, so
// a future sweep cannot "fix" it into a per-gym copy. The row for the F1
// stress gym has to agree with the render-path section: the same shared
// `Asteroid` entity, a scenario-only divergence, and no claim of a divergent
// rendering path.

const ASTEROID_ATLAS_SECTION = '## Shared asteroid silhouette atlas';

/** Statements the render-path section must keep, each with its evidence. */
const ASTEROID_RENDER_DOC_REQUIREMENTS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  {
    label: 'the shared seam module',
    pattern: /src\/utils\/asteroidTextures\.ts/,
  },
  { label: 'the palette geometry', pattern: /asteroidPaletteShapes/ },
  { label: 'the deterministic variant choice', pattern: /asteroidVariantFromDraws/ },
  { label: 'the one silhouette drawing implementation', pattern: /drawAsteroidSilhouette/ },
  { label: 'the atlas layout', pattern: /asteroidAtlasLayout/ },
  { label: 'the one-per-game atlas bake', pattern: /acquireAsteroidPalette/ },
  { label: 'the shared texture key', pattern: /ASTEROID_ATLAS_KEY/ },
  { label: 'the entity render seam', pattern: /Asteroid\.bakedBodyFrame/ },
  { label: 'the game consumer', pattern: /PlayScene/ },
  { label: 'the generic formation-gym consumer', pattern: /GymFormationScene/ },
  { label: 'the stress-gym consumer', pattern: /GymAsteroidStress/ },
  { label: 'the shared materialiser', pattern: /createAsteroidFromEvent/ },
  { label: 'the render-path item', pattern: /AH-0MW5088LA007XYQM/ },
  {
    label: 'the no-divergence statement',
    pattern: /no divergent rendering path|not a\s+divergence/i,
  },
];

/** Requirements (by label) that `source` does not state. */
function unmetAsteroidRenderDoc(source: string): string[] {
  const text = source.replace(/\s+/g, ' ');
  return ASTEROID_RENDER_DOC_REQUIREMENTS.filter(
    (requirement) => !requirement.pattern.test(text),
  ).map((requirement) => requirement.label);
}

describe('docs/GYM_PARITY.md records the shared asteroid render path (AH-0MW508UAQ002IC5N)', () => {
  const matrix = fs.readFileSync(GYM_PARITY_MATRIX, 'utf8');
  const section = sectionBody(matrix, ASTEROID_ATLAS_SECTION);

  /** Raw cells of one scene's matrix row (empty when absent). */
  const rowCells = (scene: string): string[] =>
    matrixRows(matrix).find((cells) => cells[1].trim() === `\`${scene}\``) ?? [];

  it('has a non-empty shared-asteroid-atlas section (AC1)', () => {
    expect(matrix).toContain(ASTEROID_ATLAS_SECTION);
    expect(section.trim().length).toBeGreaterThan(0);
  });

  it('names the seam, the consumers and the no-divergence position (AC1)', () => {
    expect(unmetAsteroidRenderDoc(section)).toEqual([]);
  });

  it('fails when the shared seam module is deleted (AC3 red-before)', () => {
    const stale = section.replace(/src\/utils\/asteroidTextures\.ts/g, '');
    expect(unmetAsteroidRenderDoc(stale)).toContain(
      'the shared seam module',
    );
  });

  it('fails when a consumer is dropped (AC3 red-before)', () => {
    const stale = section.replace(/GymAsteroidStress/g, 'a gym');
    expect(unmetAsteroidRenderDoc(stale)).toContain(
      'the stress-gym consumer',
    );
  });

  it('points the F1 stress-gym row at the render-path section (AC2)', () => {
    const cells = rowCells('GymAsteroidStress');
    expect(cells.length).toBeGreaterThan(7);
    // Enabled objects and reason both name the shared atlas path.
    expect(cells[3]).toContain('asteroidTextures.ts');
    expect(cells[7]).toContain('asteroidTextures.ts');
    // The row links back to the section anchor, so the two cannot drift.
    expect(cells[7]).toContain('#shared-asteroid-silhouette-atlas');
  });

  it('records no rendering divergence on the stress-gym row (AC2)', () => {
    const cells = rowCells('GymAsteroidStress');
    expect(cells[7]).toMatch(/no rendering divergence/i);
    // A contradictory claim would re-introduce a rendering divergence.
    expect(cells[7]).not.toMatch(/divergent render(ing)? path/i);
    expect(rowVerdict(cells)).toBe('intentional divergence');
  });

  it('lists every asteroid-bearing consumer as the shared entity path (AC4)', () => {
    // The section must name the base/gym consumers; the guard in
    // `CombatScene.equivalence.test.ts` proves each imports the shared entity.
    for (const scene of ['PlayScene', 'GymFormationScene', 'GymAsteroidStress']) {
      expect(section).toContain(scene);
    }
  });
});

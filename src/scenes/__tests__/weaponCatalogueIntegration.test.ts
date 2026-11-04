/**
 * Weapon-catalogue designer round-trip & production safety — integration suite
 * (AH-0MW0Q1IOR005FFGR, epic AH-0MW0Q01VM004EPY7).
 *
 * The unit suites prove each seam in isolation (the CSV codec, the runtime
 * guards, the ladder parser, the store's transport). This suite proves the
 * loop a **designer** actually runs, end to end, and that the shipped build
 * stays safe and read-only:
 *
 * 1. **Hand-edit round-trip** — edit `bulletColor` + `subdivisions` +
 *    `aoeRadius` in a fixture copy of the committed CSVs, reload the
 *    catalogue, and assert the resolved `WeaponDefinition`s (including
 *    `resolveWeaponDefinition(id, 0)`) reflect the edit.
 * 2. **Panel round-trip** — PUT through the real dev CSV plugin middleware
 *    (temp project root), re-read, assert the resolved definition reflects
 *    the write and that a second identical save is a no-op.
 * 2b. **Ladder round-trip** — edit one weapon's level-0 rung in a fixture copy
 *    of `src/data/weapon-levels.json`, reload, and assert only that weapon's
 *    rhythm changes; a malformed ladder falls back to the code ladder with a
 *    diagnostic and boot still succeeds.
 * 3. **Fallback path** — a corrupted row (bad colour) and an off-beat
 *    subdivision each fall back to `DEFAULT_WEAPON_CATALOGUE` for that weapon
 *    only, with the rest staying CSV-driven and a diagnostic recorded.
 * 4. **Production path** — with no dev plugin (production build flags), the
 *    bundled CSV is used, writes are refused and **no** fetch is attempted.
 * 5. **Parity in-game** — `PlayScene`, `GymWeapons`, `GymRhythm` and
 *    `GymWeaponLeveling` resolve the same edited colour/size/impact spec and
 *    fire the same rhythm (`docs/GYM_PARITY.md`).
 * 6. **No behavioural regression** — a frozen snapshot pins every weapon's
 *    level-0 and level-3 resolved definition, cross-checked against the
 *    pre-migration catalogue and ladder parity fixtures.
 *
 * Mocked bundled data is the only way to "edit" a committed CSV/JSON in a test
 * without writing tracked repository data, so the data-fixture cases mock
 * `src/core/bundledConfig` and re-import in a fresh module registry
 * (`vi.resetModules()` + dynamic `import()`), the pattern
 * `src/utils/weaponsCatalogueLoad.test.ts` and
 * `src/utils/weaponLevelsData.test.ts` established. Anything touching a scene
 * or the store uses the real (unmocked) module registry.
 *
 * @vitest-environment happy-dom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';

import { configCsvPlugin } from '../../../vite/plugins/configCsvPlugin';
import { beatPeriodMs } from '../../utils/beat';
import {
  WEAPON_COLUMN_ORDER,
  parseCsvRows,
  parseWeaponCatalogue,
  serializeCsvLine,
} from '../../core/csv';
import {
  DEFAULT_WEAPON_CATALOGUE,
  WEAPON_CATALOGUE,
  WEAPON_IDS,
  type WeaponDefinition,
  type WeaponId,
} from '../../utils/weapons';
import {
  SIXTEENTH_NOTE_STEP_MS,
  resolveWeaponDefinition,
  resolveWeaponPattern,
} from '../../utils/weaponLevels';
import { resolvePlayerBulletVisual } from '../../utils/bulletVisuals';
import { euclidPattern } from '../../utils/euclid';
import {
  WEAPON_CATALOGUE_READ_ONLY_REASON,
  WEAPONS_CSV_PATH,
  WEAPON_PATTERNS_CSV_PATH,
  getPersistedWeaponDefinition,
  resetWeaponCatalogueStore,
  saveWeaponDefinition,
  seedWeaponCatalogueStore,
} from '../../core/weaponCatalogueStore';
import { installCsvFetchBridge } from '../../test/csvFetchBridge';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { PlayScene } from '../PlayScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { GymWeapons } from '../gym/GymWeapons';
import { GymRhythm, GYM_RHYTHM_BAR_STEPS } from '../gym/GymRhythm';
import { GymWeaponLeveling } from '../gym/GymWeaponLeveling';

// ── Committed fixtures ──────────────────────────────────────────────

const DATA_DIR = resolve(__dirname, '../../data');
const WEAPONS_CSV = readFileSync(join(DATA_DIR, 'weapons.csv'), 'utf8');
const PATTERNS_CSV = readFileSync(join(DATA_DIR, 'weapon-patterns.csv'), 'utf8');
const LEVELS_JSON = readFileSync(join(DATA_DIR, 'weapon-levels.json'), 'utf8');

/** The committed catalogue as parsed from the committed CSVs. */
const COMMITTED_PARSE = parseWeaponCatalogue(WEAPONS_CSV, PATTERNS_CSV);
const COMMITTED_CATALOGUE = COMMITTED_PARSE.catalogue;
const COMMITTED_SUBDIVISIONS = COMMITTED_PARSE.subdivisions;

/** Frozen pre-migration fixtures (see `src/data/*Parity.test.ts`). */
const FROZEN_CATALOGUE = JSON.parse(
  readFileSync(join(DATA_DIR, 'weapon-catalogue-parity.json'), 'utf8'),
) as Record<WeaponId, WeaponDefinition>;
const FROZEN_LEVELS = JSON.parse(
  readFileSync(join(DATA_DIR, 'weapon-levels-parity.json'), 'utf8'),
) as { levels: number[]; weapons: Record<WeaponId, EuclideanPatternFixture[]> };
const FROZEN_RESOLVED = JSON.parse(
  readFileSync(join(DATA_DIR, 'weapon-resolved-parity.json'), 'utf8'),
) as { levels: number[]; weapons: Record<WeaponId, WeaponDefinition[]> };

/** The subset of a frozen Euclidean pattern this suite reads. */
interface EuclideanPatternFixture {
  k: number;
  n: number;
  rotation: number;
  stepMs: number;
}

/** The committed ladder rhythm for `weaponId` at level 0 (see fixture above). */
function committedLevelZeroPattern(
  weaponId: WeaponId,
): EuclideanPatternFixture {
  return FROZEN_LEVELS.weapons[weaponId][0];
}

// ── Fixture editing helpers ─────────────────────────────────────────

const CSV_COLUMNS = WEAPON_COLUMN_ORDER as readonly string[];

/**
 * Hand-edits one cell of a weapon row in a CSV fixture copy — the designer's
 * spreadsheet edit, preserving the comment block, header and every other row.
 */
function editWeaponCell(
  csv: string,
  id: string,
  column: string,
  value: string,
): string {
  const row = parseCsvRows(csv).find((candidate) => candidate.id === id);
  if (row === undefined) throw new Error(`fixture has no row for ${id}`);
  const lines = csv.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${id},`));
  if (index === -1) throw new Error(`fixture has no line for ${id}`);
  lines[index] = serializeCsvLine({ ...row, [column]: value }, CSV_COLUMNS);
  return lines.join('\n');
}

/** The committed ladder data as an editable plain object. */
function committedLadders(): Record<WeaponId, unknown[]> {
  return JSON.parse(LEVELS_JSON) as Record<WeaponId, unknown[]>;
}

// ── Mocked bundled-data loader ──────────────────────────────────────

interface WeaponDataModules {
  weapons: typeof import('../../utils/weapons');
  levels: typeof import('../../utils/weaponLevels');
  diagnostics: typeof import('../../utils/weaponDataDiagnostics');
}

/**
 * Loads the weapon modules against fixture data in a fresh module registry.
 *
 * Only the named `src/core/bundledConfig` exports are overridden (the real
 * export names, e.g. `bundledWeaponsCsv`); everything else in that module (the
 * enemy/ship/difficulty blobs) stays real.
 */
async function loadWeaponData(overrides: {
  bundledWeaponsCsv?: string;
  bundledWeaponPatternsCsv?: string;
  bundledWeaponLevelsJson?: string;
}): Promise<WeaponDataModules> {
  vi.resetModules();
  vi.doMock('../../core/bundledConfig', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../../core/bundledConfig')>();
    return { ...actual, ...overrides };
  });
  const weapons = await import('../../utils/weapons');
  const levels = await import('../../utils/weaponLevels');
  const diagnostics = await import('../../utils/weaponDataDiagnostics');
  return { weapons, levels, diagnostics };
}

// ── Dev-plugin harness (temp project root) ──────────────────────────

let tempRoot: string | null = null;
const servers: Server[] = [];
const bootedGames: BootedGame[] = [];

/** Boot the CSV plugin middleware behind a real ephemeral HTTP server. */
async function startPluginServer(root: string): Promise<string> {
  const plugin = configCsvPlugin({ root });
  let middleware:
    | ((req: unknown, res: unknown, next: () => void) => void)
    | null = null;
  const fakeServer = {
    config: { command: 'serve', mode: 'development' },
    middlewares: {
      use: (fn: (req: unknown, res: unknown, next: () => void) => void) => {
        middleware = fn;
      },
    },
  } as unknown as ViteDevServer;

  const configureServer = plugin.configureServer as
    | ((server: ViteDevServer) => void)
    | undefined;
  configureServer?.(fakeServer);

  const httpServer = createServer((req, res) => {
    // happy-dom enforces the same-origin policy, and the bridge deliberately
    // crosses origins (http://localhost:3000 → http://127.0.0.1:<port>), so
    // every response carries permissive CORS headers and a preflight is
    // answered here (see `src/test/csvFetchBridge.ts`).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (!middleware) {
      res.statusCode = 404;
      res.end();
      return;
    }
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  servers.push(httpServer);

  return new Promise((resolveUrl) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolveUrl(`http://127.0.0.1:${port}`);
    });
  });
}

/** Writes the committed weapon files into a temp project root. */
function writeWeaponFixtures(root: string): void {
  mkdirSync(join(root, 'src', 'data'), { recursive: true });
  writeFileSync(join(root, WEAPONS_CSV_PATH), WEAPONS_CSV);
  writeFileSync(join(root, WEAPON_PATTERNS_CSV_PATH), PATTERNS_CSV);
}

beforeEach(() => {
  resetWeaponCatalogueStore();
});

afterEach(() => {
  for (const booted of bootedGames.splice(0)) booted.game.destroy(true);
  for (const server of servers.splice(0)) server.close();
  if (tempRoot !== null) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
  vi.doUnmock('../../core/bundledConfig');
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetWeaponCatalogueStore();
});

// ── 1. Hand-edit round-trip ─────────────────────────────────────────

describe('hand-edit round-trip (AC1)', () => {
  it('reflects an edited bulletColor, subdivisions and aoeRadius in every resolved definition', async () => {
    const editedCsv = editWeaponCell(
      editWeaponCell(
        editWeaponCell(WEAPONS_CSV, 'cannon', 'bulletColor', '0x12ab34'),
        'cannon',
        'subdivisions',
        '4',
      ),
      'mortar',
      'aoeRadius',
      '240',
    );

    const { weapons, levels } = await loadWeaponData({
      bundledWeaponsCsv: editedCsv,
      bundledWeaponPatternsCsv: PATTERNS_CSV,
    });

    // Booted cleanly: the hand edit is valid data, not a fallback.
    expect(weapons.WEAPON_CATALOGUE_LOAD_REPORT.errors).toStrictEqual([]);
    expect(
      weapons.WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromFallback,
    ).toStrictEqual([]);

    // The runtime catalogue reflects the edited cells.
    expect(weapons.WEAPON_CATALOGUE.cannon.bulletColor).toBe(0x12ab34);
    expect(weapons.WEAPON_CATALOGUE.cannon.fireRateMs).toBe(
      beatPeriodMs(80) / 4,
    );
    expect(weapons.WEAPON_CATALOGUE.mortar.aoe?.radius).toBe(240);
    // The nominal (legacy) subdivision table follows the same CSV cell.
    expect(weapons.DEFAULT_WEAPON_SUBDIVISIONS.cannon).toBe(4);

    // `resolveWeaponDefinition(id, 0)` returns the edited base definition.
    const resolvedCannon = levels.resolveWeaponDefinition('cannon', 0);
    expect(resolvedCannon).toStrictEqual(weapons.WEAPON_CATALOGUE.cannon);
    expect(resolvedCannon.bulletColor).toBe(0x12ab34);
    expect(resolvedCannon.fireRateMs).toBe(187.5);
    expect(levels.resolveWeaponDefinition('mortar', 0).aoe?.radius).toBe(240);

    // Weapons the designer did not touch still come from the committed CSV.
    for (const weaponId of WEAPON_IDS) {
      if (weaponId === 'cannon' || weaponId === 'mortar') continue;
      expect(weapons.WEAPON_CATALOGUE[weaponId], weaponId).toStrictEqual(
        COMMITTED_CATALOGUE[weaponId],
      );
    }
  });
});

// ── 2. Panel round-trip through the real dev plugin ─────────────────

describe('panel round-trip through the dev CSV plugin (AC1)', () => {
  it('PUTs a panel save, re-reads the file, and the second save is a no-op', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'weapon-catalogue-integration-'));
    writeWeaponFixtures(tempRoot);
    const baseUrl = await startPluginServer(tempRoot);
    installCsvFetchBridge(baseUrl);
    // Dev-server flags: the real PUT + re-read path, not the test shortcut.
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');

    const target: WeaponDefinition = {
      ...getPersistedWeaponDefinition('spread'),
      bulletColor: 0x12cd34,
      bulletSize: 1.35,
    };

    const first = await saveWeaponDefinition(target);
    expect(first.ok, first.reason).toBe(true);

    // The committed-to-disk temp CSV carries the edited cells…
    const onDisk = readFileSync(join(tempRoot, WEAPONS_CSV_PATH), 'utf8');
    const spreadRow = parseCsvRows(onDisk).find((row) => row.id === 'spread');
    expect(spreadRow?.bulletColor).toBe('0x12cd34');
    expect(spreadRow?.bulletSize).toBe('1.35');

    // …and the catalogue re-read makes the running game reflect the file.
    expect(getPersistedWeaponDefinition('spread').bulletColor).toBe(0x12cd34);
    expect(WEAPON_CATALOGUE.spread.bulletSize).toBe(1.35);
    const resolved = resolveWeaponDefinition('spread', 0);
    expect(resolved.bulletColor).toBe(0x12cd34);
    expect(resolved.bulletSize).toBe(1.35);
    expect(resolvePlayerBulletVisual(resolved)).toStrictEqual(
      resolvePlayerBulletVisual(target),
    );

    // The second identical save is a no-op: byte-identical file, one row.
    const second = await saveWeaponDefinition(target);
    expect(second.ok, second.reason).toBe(true);
    expect(readFileSync(join(tempRoot, WEAPONS_CSV_PATH), 'utf8')).toBe(onDisk);
    expect(
      parseCsvRows(onDisk).filter((row) => row.id === 'spread'),
    ).toHaveLength(1);
    expect(resolveWeaponDefinition('spread', 0)).toStrictEqual(resolved);
  });

  it('refuses an off-beat panel save and leaves the temp CSV untouched', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'weapon-catalogue-integration-'));
    writeWeaponFixtures(tempRoot);
    const baseUrl = await startPluginServer(tempRoot);
    installCsvFetchBridge(baseUrl);
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');

    const before = readFileSync(join(tempRoot, WEAPONS_CSV_PATH), 'utf8');
    const result = await saveWeaponDefinition({
      ...getPersistedWeaponDefinition('spread'),
      fireRateMs: 200,
    });

    expect(result.ok).toBe(false);
    expect(readFileSync(join(tempRoot, WEAPONS_CSV_PATH), 'utf8')).toBe(before);
    expect(WEAPON_CATALOGUE.spread.fireRateMs).toBe(
      COMMITTED_CATALOGUE.spread!.fireRateMs,
    );
  });
});

// ── 2b. Ladder round-trip ───────────────────────────────────────────

describe('ladder round-trip (AC1)', () => {
  it('retunes only the edited weapon’s rhythm while every other ladder is unchanged', async () => {
    const edited = committedLadders();
    edited.cannon = [{ k: 8, n: 16, rotation: 2 }, ...edited.cannon.slice(1)];

    const { levels } = await loadWeaponData({
      bundledWeaponLevelsJson: JSON.stringify(edited),
    });

    // 8/16 @ rotation 2 is the edited level-0 rhythm (was 9/16 @ rotation 0).
    expect(levels.resolveWeaponPattern('cannon', 0)).toStrictEqual(
      levels.latticeEuclidean(8, 16, 2),
    );
    expect(levels.euclideanOnsetsPerBeat(
      levels.resolveWeaponPattern('cannon', 0),
    )).toBeCloseTo(2, 9);
    expect(levels.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual(
      [],
    );
    expect(levels.WEAPON_LEVELS_LOAD_REPORT.errors).toStrictEqual([]);

    // Every other weapon's ladder is still the committed one.
    for (const weaponId of WEAPON_IDS) {
      if (weaponId === 'cannon') continue;
      expect(levels.resolveWeaponPattern(weaponId, 0), weaponId).toStrictEqual(
        committedLevelZeroPattern(weaponId),
      );
    }
  });

  it('falls back to the code ladder for a malformed rung, with a diagnostic, and boots', async () => {
    const edited = committedLadders();
    // k > n is well-typed JSON but cannot describe a lattice tile.
    edited.cannon = [{ k: 17, n: 16, rotation: 0 }, ...edited.cannon.slice(1)];

    const { weapons, levels, diagnostics } = await loadWeaponData({
      bundledWeaponLevelsJson: JSON.stringify(edited),
    });

    // Boot still succeeds with the full roster…
    expect(Object.keys(weapons.WEAPON_CATALOGUE)).toHaveLength(WEAPON_IDS.length);
    // …the affected weapon falls back to the code ladder…
    expect(levels.WEAPON_LEVELS_LOAD_REPORT.resolvedFromFallback).toStrictEqual([
      'cannon',
    ]);
    expect(levels.resolveWeaponPattern('cannon', 0)).toStrictEqual(
      committedLevelZeroPattern('cannon'),
    );
    // …and the diagnostic names the weapon and rung for the designer.
    const reported = diagnostics.collectWeaponDataDiagnostics().join('\n');
    expect(reported).toContain('cannon[0]');
    expect(reported).toContain('src/data/weapon-levels.json');
  });
});

// ── 3. Fallback path ────────────────────────────────────────────────

describe('fallback path: a broken row falls back for that weapon only (AC1)', () => {
  it('falls back a bad colour to DEFAULT_WEAPON_CATALOGUE, keeping the rest CSV-driven', async () => {
    const editedCsv = editWeaponCell(
      editWeaponCell(WEAPONS_CSV, 'cannon', 'bulletColor', '0xZZZZZZ'),
      'rapid',
      'bulletSize',
      '1.4',
    );

    const { weapons, diagnostics } = await loadWeaponData({
      bundledWeaponsCsv: editedCsv,
      bundledWeaponPatternsCsv: PATTERNS_CSV,
    });

    expect(weapons.WEAPON_CATALOGUE_LOAD_REPORT.resolvedFromFallback).toStrictEqual([
      'cannon',
    ]);
    expect(weapons.WEAPON_CATALOGUE.cannon).toStrictEqual(
      weapons.DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    // The untouched edit in the same fixture still came from the CSV.
    expect(weapons.WEAPON_CATALOGUE.rapid.bulletSize).toBe(1.4);
    expect(weapons.WEAPON_CATALOGUE_LOAD_REPORT.errors.join('\n')).toContain(
      'cannon',
    );
    expect(diagnostics.collectWeaponDataDiagnostics().join('\n')).toContain(
      'cannon',
    );
  });

  it('falls back an off-beat subdivision through the runtime guard, keeping the rest CSV-driven', async () => {
    const editedCsv = editWeaponCell(
      editWeaponCell(WEAPONS_CSV, 'cannon', 'subdivisions', '1.37'),
      'rapid',
      'bulletSize',
      '1.4',
    );

    const { weapons, diagnostics } = await loadWeaponData({
      bundledWeaponsCsv: editedCsv,
      bundledWeaponPatternsCsv: PATTERNS_CSV,
    });

    // The row parsed, but the runtime roster guard rejected it.
    expect(
      weapons.WEAPON_CATALOGUE_INVARIANT_REPORT.resolvedFromFallback,
    ).toStrictEqual(['cannon']);
    expect(weapons.WEAPON_CATALOGUE.cannon).toStrictEqual(
      DEFAULT_WEAPON_CATALOGUE.cannon,
    );
    // The nominal subdivision falls back with the rejected definition.
    expect(weapons.DEFAULT_WEAPON_SUBDIVISIONS.cannon).toBe(
      COMMITTED_SUBDIVISIONS.cannon,
    );
    expect(weapons.WEAPON_CATALOGUE.rapid.bulletSize).toBe(1.4);
    const reported = diagnostics.collectWeaponDataDiagnostics().join('\n');
    expect(reported).toContain('cannon');
    expect(reported).toContain('beat grid');
  });
});

// ── 4. Production path ──────────────────────────────────────────────

describe('production path: bundled CSV, read-only, no network (AC2)', () => {
  it('uses the bundled CSV, refuses writes and attempts no fetch', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    vi.resetModules();
    const weapons = await import('../../utils/weapons');
    const store = await import('../../core/weaponCatalogueStore');
    const levels = await import('../../utils/weaponLevels');

    // The shipped build is read-only.
    expect(store.isWeaponCatalogueWritable()).toBe(false);

    const result = await store.saveWeaponDefinition({
      ...store.getPersistedWeaponDefinition('spread'),
      bulletColor: 0x12cd34,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(WEAPON_CATALOGUE_READ_ONLY_REASON);
    expect(fetchMock).not.toHaveBeenCalled();

    // The bundled CSV still supplies the runtime catalogue and resolver.
    expect(weapons.WEAPON_CATALOGUE).toStrictEqual(COMMITTED_CATALOGUE);
    expect(levels.resolveWeaponDefinition('spread', 0)).toStrictEqual(
      COMMITTED_CATALOGUE.spread,
    );
  });
});

// ── 5. Gym↔game parity for data-driven values ───────────────────────

/** The edited cannon colour — unique across the roster so it identifies its bullets. */
const EDITED_CANNON_COLOR = 0x12cd34;
/** The edited per-weapon impact spec carried by cannon's bullets. */
const EDITED_CANNON_IMPACT = {
  color: 0x654321,
  radius: 13,
  duration: 0.2,
  cue: 'playCannonImpactSound',
} as const;
/** The edited bullet-size multiplier (applied to the visual spec's radius). */
const EDITED_CANNON_SIZE = 1.5;

/** Fixed simulation step used to drive the scenes deterministically. */
const DT = 1 / 60;
/** Ticks covering just over one 3 s bar (16 sixteenths @ 80 BPM). */
const PARITY_TICKS = 200;

/** A scene whose player auto-fires a travelling cannon bullet. */
type BulletFiringScene = PlayScene | GymWeapons | GymWeaponLeveling;

/** The live player bullets a scene exposes. */
function bulletsOf(scene: BulletFiringScene) {
  return scene instanceof PlayScene ? scene.getPlayerBullets() : scene.getBullets();
}

/** Boots PlayScene (with the scenes its transitions need) and tracks it. */
async function bootPlayScene(): Promise<PlayScene> {
  const booted = await bootScene([
    PlayScene,
    MineralChoiceScene,
    GameOverScene,
    MenuScene,
  ]);
  bootedGames.push(booted);
  return booted.scene as PlayScene;
}

/** Boots one gym scene and tracks it for teardown. */
async function bootGym<
  T extends GymWeapons | GymRhythm | GymWeaponLeveling,
>(sceneClass: new () => T): Promise<T> {
  const booted = await bootScene([sceneClass]);
  bootedGames.push(booted);
  return booted.scene as T;
}

/** Installs the edited cannon definition exactly as a designer save would. */
function seedEditedCannon(): WeaponDefinition {
  const base = getPersistedWeaponDefinition('cannon');
  const edited: WeaponDefinition = {
    ...base,
    bulletColor: EDITED_CANNON_COLOR,
    bulletSize: EDITED_CANNON_SIZE,
    impactFx: { ...EDITED_CANNON_IMPACT },
  };
  seedWeaponCatalogueStore({ cannon: edited });
  return edited;
}

/** The lattice-step offsets (within one bar) of a weapon's level-0 rhythm. */
function expectedOnsetOffsets(weaponId: WeaponId): number[] {
  const pattern = resolveWeaponPattern(weaponId, 0);
  const barSteps = pattern.n;
  return euclidPattern(pattern.k, pattern.n, pattern.rotation)
    .onsets.map((onset) => onset % barSteps)
    .sort((a, b) => a - b);
}

/** Maps a shot time (ms) to its sixteenth-note step within the bar. */
function stepOfShot(shotTimeMs: number, barSteps: number): number {
  const step = Math.round(shotTimeMs / SIXTEENTH_NOTE_STEP_MS);
  return ((step % barSteps) + barSteps) % barSteps;
}

describe('gym↔game parity for the edited weapon (AC3)', () => {
  it('every scene resolves the same colour, size and impact spec and the same rhythm', async () => {
    const edited = seedEditedCannon();
    const expectedVisual = resolvePlayerBulletVisual(edited);
    const expectedOffsets = expectedOnsetOffsets('cannon');

    const play = await bootPlayScene();
    const weaponsGym = await bootGym(GymWeapons);
    const levelingGym = await bootGym(GymWeaponLeveling);
    const rhythmGym = await bootGym(GymRhythm);

    const scenes: ReadonlyArray<[string, BulletFiringScene]> = [
      ['PlayScene', play],
      ['GymWeapons', weaponsGym],
      ['GymWeaponLeveling', levelingGym],
    ];

    // 1. Identical resolved definition (colour, size, impact) per scene.
    for (const [name, scene] of scenes) {
      const player = scene.getPlayer();
      expect(player, `${name} created no player`).not.toBeNull();
      const definition = player!.getWeaponDef('cannon');
      expect(definition.bulletColor, name).toBe(EDITED_CANNON_COLOR);
      expect(definition.bulletSize, name).toBe(EDITED_CANNON_SIZE);
      expect(definition.impactFx, name).toStrictEqual(EDITED_CANNON_IMPACT);
      expect(resolvePlayerBulletVisual(definition), name).toStrictEqual(
        expectedVisual,
      );
      // The shared resolver, not a per-scene copy, owns the fire rhythm.
      expect(player!.getFirePattern('cannon'), name).toStrictEqual(
        resolveWeaponPattern('cannon', 0),
      );
    }

    const rhythmPlayer = rhythmGym.getPlayer();
    expect(rhythmPlayer, 'GymRhythm created no player').not.toBeNull();
    expect(rhythmPlayer!.getWeaponDef('cannon')).toStrictEqual(edited);
    expect(rhythmPlayer!.getFirePattern('cannon')).toStrictEqual(
      resolveWeaponPattern('cannon', 0),
    );

    // 2. Fired bullets carry the edited colour/impact in every firing scene,
    //    and their onsets land on the same rhythm.
    const observedOffsets = new Map<string, number[]>();
    for (const [name, scene] of scenes) {
      const seen = new Set<unknown>();
      const offsets: number[] = [];
      for (let tick = 0; tick < PARITY_TICKS; tick++) {
        scene.tick(DT);
        for (const bullet of bulletsOf(scene)) {
          if (bullet.color !== EDITED_CANNON_COLOR || seen.has(bullet)) continue;
          seen.add(bullet);
          expect(bullet.impactFx, name).toStrictEqual(EDITED_CANNON_IMPACT);
          expect(bullet.shape, name).toBe(edited.bulletShape);
          const shotTime = scene.getPlayer()!.getLastShotTime('cannon');
          expect(shotTime, `${name} fired without a scheduled onset`).toBeDefined();
          offsets.push(stepOfShot(shotTime as number, GYM_RHYTHM_BAR_STEPS));
        }
      }
      expect(seen.size, `${name} fired no edited weapon`).toBeGreaterThan(0);
      // Every onset is one of the lattice's onsets — never an off-beat shot.
      for (const offset of offsets) {
        expect(expectedOffsets, name).toContain(offset);
      }
      observedOffsets.set(name, [...new Set(offsets)].sort((a, b) => a - b));
    }

    // The same rhythm in every firing scene: a full bar's onset offsets.
    const playOffsets = observedOffsets.get('PlayScene')!;
    expect(playOffsets).toStrictEqual(expectedOffsets);
    expect(observedOffsets.get('GymWeapons')).toStrictEqual(playOffsets);
    expect(observedOffsets.get('GymWeaponLeveling')).toStrictEqual(playOffsets);

    // 3. GymRhythm auditions the same rhythm: its cannon onsets per bar are
    //    exactly the shared lattice's onsets.
    const barSteps = resolveWeaponPattern('cannon', 0).n;
    for (let tick = 0; tick < PARITY_TICKS; tick++) rhythmGym.tick(DT);
    const barZeroSteps = rhythmGym
      .getFiredEvents()
      .filter((event) => event.weaponId === 'cannon' && event.bar === 0)
      .map((event) => event.step)
      .sort((a, b) => a - b);
    expect(barZeroSteps).toStrictEqual(expectedOffsets);
    expect(barSteps).toBe(GYM_RHYTHM_BAR_STEPS);
  });
});

// ── 6. No behavioural regression: frozen resolved definitions ───────

describe('frozen resolved-definition snapshot (AC6)', () => {
  it('pins every weapon’s level-0 and level-3 resolved definition', () => {
    resetWeaponCatalogueStore();
    expect(FROZEN_RESOLVED.levels).toStrictEqual([0, 3]);
    expect(Object.keys(FROZEN_RESOLVED.weapons).sort()).toStrictEqual(
      [...WEAPON_IDS].sort(),
    );

    for (const weaponId of WEAPON_IDS) {
      FROZEN_RESOLVED.levels.forEach((level, index) => {
        expect(
          resolveWeaponDefinition(weaponId, level),
          `${weaponId} @ level ${level}`,
        ).toStrictEqual(FROZEN_RESOLVED.weapons[weaponId][index]);
      });
    }
  });

  it('matches the pre-migration catalogue at level 0 and ladder at level 3', () => {
    for (const weaponId of WEAPON_IDS) {
      // Level 0 is the base definition, unchanged by the CSV migration.
      expect(
        FROZEN_RESOLVED.weapons[weaponId][0],
        `${weaponId} level 0`,
      ).toStrictEqual(FROZEN_CATALOGUE[weaponId]);
      // The level-3 rhythm is the pre-migration authored ladder.
      expect(
        resolveWeaponPattern(weaponId, 3),
        `${weaponId} level 3`,
      ).toStrictEqual(FROZEN_LEVELS.weapons[weaponId][3]);
    }
  });
});

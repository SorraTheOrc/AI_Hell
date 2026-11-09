/**
 * Tests for the GymIndex entry scene (AC2/AC3/AC4/AC6) and its keyboard
 * navigation (AH-0MUDZFBYY008P7ZE) plus the collapsible group layout
 * (AH-0MW6OIQAA001YVGA):
 *  - boots as the entry scene and shows the title,
 *  - lists every gym scene under `src/scenes/gym/` sorted alphabetically
 *    by label, excluding `.test.ts` modules and itself,
 *  - clicking an entry immediately starts that scene by its key,
 *  - the shared "← INDEX" button on a gym scene returns to the index,
 *  - the plain-scenes column groups its rows into collapsible, accordion
 *    headers that never leave the title-to-hint band,
 *  - keyboard navigation: default focus, grid-aware arrow movement over the
 *    *visible* rows only (Left/Right between columns, Up/Down within a
 *    column), linear Tab cycling, Enter/Space activation and group toggling,
 *    and shutdown cleanup.
 *
 * Since AH-0MV13G5EV008D41E the ENEMIES column is a single "Fodder Enemies"
 * row (booting the reusable `GymFodderEnemies` scene bare, whose in-panel
 * dropdown includes the Centipede chain) plus the dedicated `GymBoss` "Boss"
 * row and the dedicated `GymMiniBoss` "Mini-Boss" row; the Bosses column and
 * the per-config rows are gone. The Centipede is
 * *not* a separate ENEMIES row (AH-0MV4ZOIZR0086T66).
 *
 * Discovery runs through the real `import.meta.glob` (Vitest supports it),
 * so these tests exercise the actual files on disk — a new `Gym<Name>.ts`
 * appearing in the folder is picked up without editing the list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { advanceGame, bootScene, BootedGame } from '../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { FocusManager } from '../utils/focusManager';
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../utils/gymNavigation';
import {
  GymIndex,
  type GymIndexVisibleRow,
  GYM_INDEX_TITLE,
  GYM_INDEX_HINT,
  GYM_INDEX_COLUMN_X,
  GYM_INDEX_ENEMIES_HEADER,
  GYM_INDEX_DEV_UTILITIES_HEADER,
  FODDER_ENEMIES_SCENE_KEY,
  FODDER_ENEMIES_LABEL,
  BOSS_SCENE_KEY,
  BOSS_SCENE_LABEL,
  MINI_BOSS_SCENE_KEY,
  MINI_BOSS_SCENE_LABEL,
  CENTIPEDE_SCENE_KEY,
} from './GymIndex';
import {
  GYM_INDEX_OTHER_GROUP_ID,
  GYM_INDEX_ROW_HEIGHT,
  groupHeaderLabel,
} from './gymIndexGroups';
import { GymBoss } from './gym/GymBoss';
import { MenuScene } from './MenuScene';

/** Finds an on-screen text by label. */
function findText(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
  return found!;
}

/** Finds an on-screen text by label at a specific column X (labels may repeat across columns). */
function findTextAt(scene: Phaser.Scene, label: string, x: number): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      child.text === label &&
      Math.round(child.x) === Math.round(x),
  );
  expect(found, `text "${label}" at x=${x} not found`).toBeDefined();
  return found!;
}

/** Finds a group header by its title, whatever its expanded/collapsed indicator. */
function findGroupHeader(scene: Phaser.Scene, title: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      (child.text === groupHeaderLabel(title, false) ||
        child.text === groupHeaderLabel(title, true)),
  );
  expect(found, `group header "${title}" not found`).toBeDefined();
  return found!;
}

/** Interactive (focusable) row texts, in display order. */
function focusableRows(scene: Phaser.Scene): Phaser.GameObjects.Text[] {
  return (scene.children.list as Phaser.GameObjects.Text[]).filter(
    (c) => c instanceof Phaser.GameObjects.Text && c.input?.enabled,
  );
}

/** Reserves the row box height when Phaser's text metrics are unavailable in the stub renderer. */
function rowBoxHeight(row: Phaser.GameObjects.Text): number {
  return Number.isFinite(row.height) && row.height > 0 ? row.height : GYM_INDEX_ROW_HEIGHT;
}

describe('GymIndex — gym entry scene (AC2-AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  async function bootIndex(): Promise<GymIndex> {
    booted = await bootScene([GymIndex]);
    return booted!.scene as GymIndex;
  }

  it('AC2 — boots as an active scene and renders the title', async () => {
    const scene = await bootIndex();
    expect(scene.sys.isActive()).toBe(true);
    expect(findText(scene, GYM_INDEX_TITLE)).toBeDefined();
  });

  it('AC3+AC4 — discovers the gym folder, excludes .test.ts, sorts alphabetically by label', async () => {
    const scene = await bootIndex();

    // GymPlayer, GymMinerals, GymPowerUpsUtility, GymWeapons and
    // GymPowerUpsCombat are on disk. GymBoss is excluded from the *plain
    // scene list* (left column) — the real, multi-phase boss is surfaced as
    // the dedicated "Boss" row in the ENEMIES column instead
    // (AH-0MUAYB28C004KK7X, AH-0MV13G5EV008D41E). GymCentipede is likewise
    // excluded from the plain scene list and surfaced as a dedicated ENEMIES
    // row (AH-0MV4ZOIZR0086T66). GymPowerUpLeveling (the power-up leveling
    // gallery, AH-0MUV5CLVQ006V9HR) is auto-discovered like every
    // `Gym<Name>.ts`. Labels strip the leading "Gym" and are
    // sorted alphabetically. GymFodderEnemies is not listed as a bare scene
    // — a single fodder row boots it.
    expect(scene.listedScenes.map((s) => s.label)).toEqual([
      'AsteroidStress',
      'BotTuning',
      'Hangar',
      'HexWar',
      'Level',
      'Minerals',
      'Performance',
      'Player',
      'PowerUpLeveling',
      'PowerUpsCombat',
      'PowerUpsUtility',
      'RechargeTuning',
      'Rhythm',
      'WeaponLeveling',
      'Weapons',
      'WeaponTuning',
    ]);
    expect(scene.listedScenes.map((s) => s.key)).toEqual([
      'GymAsteroidStress',
      'GymBotTuning',
      'GymHangar',
      'GymHexWar',
      'GymLevel',
      'GymMinerals',
      'GymPerformance',
      'GymPlayer',
      'GymPowerUpLeveling',
      'GymPowerUpsCombat',
      'GymPowerUpsUtility',
      'GymRechargeTuning',
      'GymRhythm',
      'GymWeaponLeveling',
      'GymWeapons',
      'GymWeaponTuning',
    ]);

    // Middle column: the reusable fodder gym (its in-panel dropdown selects
    // the archetype, including the Centipede chain), the dedicated boss and
    // the dedicated config-driven mini-boss. No per-config rows and no `boss`
    // "Boss Swarm" row, and no separate Centipede row
    // (AH-0MV4ZOIZR0086T66, AH-0MVCRAYSH0014BQJ).
    expect(scene.listedEnemyScenes).toEqual([
      { key: FODDER_ENEMIES_SCENE_KEY, label: FODDER_ENEMIES_LABEL, sceneKey: FODDER_ENEMIES_SCENE_KEY },
      { key: BOSS_SCENE_KEY, label: BOSS_SCENE_LABEL, sceneKey: BOSS_SCENE_KEY },
      { key: MINI_BOSS_SCENE_KEY, label: MINI_BOSS_SCENE_LABEL, sceneKey: MINI_BOSS_SCENE_KEY },
    ]);
    expect(scene.listedEnemyScenes.every((s) => s.enemyKey === undefined)).toBe(true);

    // The Centipede is reachable only through the Fodder Enemies dropdown —
    // it must not leak back onto the index as a bare scene, a dedicated
    // ENEMIES row, or a Dev Utilities row.
    expect(scene.listedScenes.map((s) => s.key)).not.toContain(CENTIPEDE_SCENE_KEY);
    expect(scene.listedScenes.map((s) => s.key)).not.toContain(MINI_BOSS_SCENE_KEY);
    expect(scene.listedEnemyScenes.map((s) => s.key)).not.toContain(CENTIPEDE_SCENE_KEY);
    expect(scene.listedDevUtilityScenes.map((s) => s.key)).not.toContain(
      CENTIPEDE_SCENE_KEY,
    );

    // No .test.ts module leaks into the list, and the index itself is not
    // listed (it lives outside the globbed folder).
    for (const entry of scene.listedScenes) {
      expect(entry.key.endsWith('.test')).toBe(false);
      expect(entry.key).not.toBe('GymIndex');
    }
  });

  it('AC1 — clicking the "Fodder Enemies" row boots GymFodderEnemies bare (default scout)', async () => {
    const scene = await bootIndex();

    const enemyKeys = scene.listedEnemyScenes.map((e) => e.key);
    expect(enemyKeys).toContain(FODDER_ENEMIES_SCENE_KEY);

    const enemiesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const fodderRow = findTextAt(scene, FODDER_ENEMIES_LABEL, enemiesCol);
    expect(fodderRow.getData('sceneKey')).toBe(FODDER_ENEMIES_SCENE_KEY);
    fodderRow.emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive(BOSS_SCENE_KEY)).toBe(false);
    const gym = booted!.game.scene.getScene(FODDER_ENEMIES_SCENE_KEY) as unknown as {
      activeEnemyKey: string;
    };
    expect(gym.activeEnemyKey).toBe('scout');
  });

  it('AC1 — the dedicated boss row lives in the ENEMIES column and boots GymBoss', async () => {
    const scene = await bootIndex();

    // The index registers every discovered scene so scene.start(key) works.
    for (const { key } of scene.listedScenes) {
      expect(booted!.game.scene.getScene(key)).not.toBeNull();
    }

    const enemiesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const bossRow = findTextAt(scene, BOSS_SCENE_LABEL, enemiesCol);
    expect(bossRow.getData('sceneKey')).toBe(BOSS_SCENE_KEY);
    bossRow.emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(BOSS_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(false);
  });

  it('AC1 — the dedicated mini-boss row lives in the ENEMIES column and boots GymMiniBoss', async () => {
    const scene = await bootIndex();

    const enemiesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const miniBossRow = findTextAt(scene, MINI_BOSS_SCENE_LABEL, enemiesCol);
    expect(miniBossRow.getData('sceneKey')).toBe(MINI_BOSS_SCENE_KEY);
    miniBossRow.emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(MINI_BOSS_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive(BOSS_SCENE_KEY)).toBe(false);
    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(false);
  });
});

describe('GymIndex — back to index from a gym scene (AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  it('the ← INDEX button on a gym scene switches back to GymIndex', async () => {
    // Boot the gym scene with the index registered alongside it (the first
    // class auto-starts, the rest are available for scene.start).
    booted = await bootScene([GymBoss, GymIndex]);
    const boss = booted!.scene as GymBoss;
    expect(boss.sys.isActive()).toBe(true);

    expect(booted!.game.scene.isActive(GYM_INDEX_KEY)).toBe(false);

    // Pointer-press the shared back button.
    findText(boss, BACK_TO_INDEX_LABEL).emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(GYM_INDEX_KEY)).toBe(true);
    expect(booted!.game.scene.isActive('GymBoss')).toBe(false);
  });
});

describe('GymIndex — three-column layout (AH-0MV13G5EV008D41E)', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  it('AC5 — renders a three-column layout (scenes | ENEMIES | Dev Utilities)', async () => {
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    const scenesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const enemiesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const devCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities;

    // Both ENEMIES rows sit in the middle column and boot their scene directly.
    expect(findTextAt(idx, FODDER_ENEMIES_LABEL, enemiesCol).getData('sceneKey')).toBe(
      FODDER_ENEMIES_SCENE_KEY,
    );
    expect(findTextAt(idx, BOSS_SCENE_LABEL, enemiesCol).getData('sceneKey')).toBe(BOSS_SCENE_KEY);

    // Headers sit above their columns; the Bosses header is gone entirely.
    expect(findTextAt(idx, GYM_INDEX_ENEMIES_HEADER, enemiesCol)).toBeDefined();
    expect(findTextAt(idx, GYM_INDEX_DEV_UTILITIES_HEADER, devCol)).toBeDefined();
    expect(
      (idx.children.list as Phaser.GameObjects.Text[]).some(
        (c) => c instanceof Phaser.GameObjects.Text && c.text === 'Bosses',
      ),
    ).toBe(false);

    // No per-enemy config rows remain in the index.
    expect(idx.listedEnemyScenes.some((s) => s.enemyKey !== undefined)).toBe(false);

    // The plain-scenes column is grouped, so a scene is reached through its
    // group header: Minerals is the collapsed "▸ Minerals" header.
    expect(findTextAt(idx, groupHeaderLabel('Minerals', false), scenesCol)).toBeDefined();

    // Columns are strictly ordered left-to-right.
    expect(scenesCol).toBeLessThan(enemiesCol);
    expect(enemiesCol).toBeLessThan(devCol);
    expect(GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities).toBeLessThan(GAME_WIDTH);
  });
});

describe('GymIndex — Dev Utilities section (AH-0MUGXDVPH005TIZL)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
    document.getElementById('gym-curve-panel')?.remove();
  });

  it('AC1+AC2 — lists GymCurveSequencer under a DEV UTILITIES column', async () => {
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;

    expect(idx.listedDevUtilityScenes).toEqual([
      { key: 'GymCurveSequencer', label: 'CurveSequencer', sceneKey: 'GymCurveSequencer' },
    ]);
    // It must be categorised away from the plain scene list.
    expect(idx.listedScenes.some((s) => s.key === 'GymCurveSequencer')).toBe(false);

    const devCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities;
    expect(findTextAt(idx, GYM_INDEX_DEV_UTILITIES_HEADER, devCol)).toBeDefined();
    const row = findTextAt(idx, 'CurveSequencer', devCol);
    expect(row.getData('sceneKey')).toBe('GymCurveSequencer');

    // The Dev Utilities column sits to the right of the other two.
    expect(devCol).toBeGreaterThan(GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies);
  });

  it('AC2 — clicking the Dev Utilities row launches GymCurveSequencer', async () => {
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;

    const devCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities;
    findTextAt(idx, 'CurveSequencer', devCol).emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted.game.scene.isActive('GymCurveSequencer')).toBe(true);
  });
});

describe('GymIndex — ESC key navigation (AH-0MU9LRTK3004KR04)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  it('pressing ESC switches from GymIndex to MenuScene', async () => {
    // Boot both scenes so MenuScene is registered but not active.
    booted = await bootScene([GymIndex, MenuScene]);
    const scene = booted!.scene as GymIndex;
    expect(scene.sys.isActive()).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);

    // Fire a KeyboardEvent with key 'Escape'.
    // Phaser's keyboard manager listens on window (inputKeyboardEventTarget),
    // so dispatch on window rather than document.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(scene.sys.isActive()).toBe(false);
  });

  it('pressing a non-ESC key does not switch scenes', async () => {
    booted = await bootScene([GymIndex, MenuScene]);
    const scene = booted!.scene as GymIndex;
    expect(scene.sys.isActive()).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);

    // Fire an inert key (not Enter/Space — those activate the focused row).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
    await advanceGame(booted!.game, 350);

    expect(scene.sys.isActive()).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });
});

describe('GymIndex — collapsible groups (AH-0MW6OIQAA001YVGA, AC1-AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
    document.getElementById('gym-curve-panel')?.remove();
  });

  async function bootIndex(): Promise<GymIndex> {
    booted = await bootScene([GymIndex]);
    return booted!.scene as GymIndex;
  }

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressKey(scene: GymIndex, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  /** Asserts every rendered row sits between the title and the bottom hint. */
  function expectRowsInsideBand(scene: GymIndex): void {
    const title = findText(scene, GYM_INDEX_TITLE);
    const hint = findText(scene, GYM_INDEX_HINT);
    const titleBottom =
      title.y + (Number.isFinite(title.height) && title.height > 0 ? title.height / 2 : 14);
    const hintTop = hint.y - (Number.isFinite(hint.height) && hint.height > 0 ? hint.height / 2 : 7);

    const rows = focusableRows(scene);
    expect(rows).toHaveLength(scene.visibleRows.length);
    for (const row of rows) {
      const half = rowBoxHeight(row) / 2;
      expect(row.y - half, `"${row.text}" overlaps the title`).toBeGreaterThanOrEqual(titleBottom);
      expect(row.y + half, `"${row.text}" overlaps the bottom hint`).toBeLessThanOrEqual(hintTop);
      expect(row.y + half, `"${row.text}" falls off the canvas`).toBeLessThanOrEqual(GAME_HEIGHT);
      // Every row stays inside the canvas horizontally as well.
      const halfWidth = Number.isFinite(row.width) && row.width > 0 ? row.width / 2 : 0;
      expect(row.x - halfWidth).toBeGreaterThanOrEqual(0);
      expect(row.x + halfWidth).toBeLessThanOrEqual(GAME_WIDTH);
    }
  }

  it('AC2 — groups every discovered plain scene into the documented categories', async () => {
    const scene = await bootIndex();

    expect(scene.listedGroups.map((g) => g.title)).toEqual([
      'Player & Combat',
      'Worlds',
      'Power-ups',
      'Weapons',
      'Tuning',
      'Minerals',
    ]);
    // Totality: every discovered scene sits in exactly one group.
    const grouped = scene.listedGroups.flatMap((g) => g.members.map((m) => m.key));
    expect([...grouped].sort()).toEqual(scene.listedScenes.map((s) => s.key).sort());
    expect(new Set(grouped).size).toBe(scene.listedScenes.length);
    expect(scene.listedGroups.some((g) => g.id === GYM_INDEX_OTHER_GROUP_ID)).toBe(false);
  });

  it('AC3 — all groups start collapsed, showing one header row per group and no members', async () => {
    const scene = await bootIndex();

    expect(scene.getExpandedGroup('scenes')).toBeNull();
    for (const group of scene.listedGroups) {
      const header = findGroupHeader(scene, group.title);
      expect(header.text).toBe(groupHeaderLabel(group.title, false));
      for (const member of group.members) {
        expect(
          (scene.children.list as Phaser.GameObjects.Text[]).some(
            (c) => c instanceof Phaser.GameObjects.Text && c.text === member.label,
          ),
          `collapsed member "${member.label}" must not render`,
        ).toBe(false);
      }
    }

    // 6 group headers + 3 ENEMIES rows + 1 Dev Utilities row.
    expect(scene.getFocusControlCount()).toBe(6 + 3 + 1);
  });

  it('AC1 — every rendered row stays between the title and the bottom hint in every expanded state', async () => {
    const scene = await bootIndex();
    expectRowsInsideBand(scene);

    // Expand each group in turn (accordion); every visible row must still fit.
    for (const group of scene.listedGroups) {
      findGroupHeader(scene, group.title).emit('pointerdown');
      expect(scene.getExpandedGroup('scenes')).toBe(group.id);
      expectRowsInsideBand(scene);
    }
  });

  it('AC3 — clicking a header toggles it, revealing its members directly below', async () => {
    const scene = await bootIndex();

    findGroupHeader(scene, 'Worlds').emit('pointerdown');

    const rows = scene.getColumnRows('scenes');
    expect(scene.getExpandedGroup('scenes')).toBe('worlds');
    expect(rows.map((r) => `${r.kind}:${r.label}`)).toEqual([
      `header:${groupHeaderLabel('Player & Combat', false)}`,
      `header:${groupHeaderLabel('Worlds', true)}`,
      'member:Hangar',
      'member:HexWar',
      'member:Level',
      `header:${groupHeaderLabel('Power-ups', false)}`,
      `header:${groupHeaderLabel('Weapons', false)}`,
      `header:${groupHeaderLabel('Tuning', false)}`,
      `header:${groupHeaderLabel('Minerals', false)}`,
    ]);
    // Members render at the column X, tinted differently from their header.
    const scenesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const member = findTextAt(scene, 'HexWar', scenesCol);
    const header = findGroupHeader(scene, 'Worlds');
    expect(member.style.backgroundColor).not.toBe(header.style.backgroundColor);
    // Focus follows the toggled header.
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Worlds', true));

    // Clicking it again collapses it and hides the members.
    findGroupHeader(scene, 'Worlds').emit('pointerdown');
    expect(scene.getExpandedGroup('scenes')).toBeNull();
    expect(findGroupHeader(scene, 'Worlds').text).toBe(groupHeaderLabel('Worlds', false));
    expect(
      (scene.children.list as Phaser.GameObjects.Text[]).some(
        (c) => c instanceof Phaser.GameObjects.Text && c.text === 'HexWar',
      ),
    ).toBe(false);
  });

  it('AC3 — Enter/Space toggle a focused header and keep focus on it', async () => {
    const scene = await bootIndex();
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Player & Combat', false));

    pressKey(scene, { key: 'Enter' });
    expect(scene.getExpandedGroup('scenes')).toBe('playerAndCombat');
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Player & Combat', true));
    expect(scene.getColumnRows('scenes').filter((r) => r.kind === 'member')).toHaveLength(4);

    pressKey(scene, { key: ' ' });
    expect(scene.getExpandedGroup('scenes')).toBeNull();
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Player & Combat', false));
    expect(scene.getColumnRows('scenes').filter((r) => r.kind === 'member')).toHaveLength(0);
  });

  it('AC3 — expanding one group collapses the previously expanded group (accordion)', async () => {
    const scene = await bootIndex();

    findGroupHeader(scene, 'Weapons').emit('pointerdown');
    expect(scene.getColumnRows('scenes').filter((r) => r.kind === 'member')).toHaveLength(3);

    findGroupHeader(scene, 'Tuning').emit('pointerdown');
    const members = scene.getColumnRows('scenes').filter((r) => r.kind === 'member');
    expect(members.map((r) => r.label)).toEqual(['BotTuning', 'RechargeTuning']);
    expect(members.every((r) => r.groupId === 'tuning')).toBe(true);
    expect(findGroupHeader(scene, 'Weapons').text).toBe(groupHeaderLabel('Weapons', false));
    // One header per group, only one of them expanded.
    const headers = scene.getColumnRows('scenes').filter((r) => r.kind === 'header');
    expect(headers.filter((r) => r.groupId === 'tuning')).toHaveLength(1);
    expect(scene.getColumnRows('scenes').some((r) => r.groupId === 'weapons')).toBe(true);
  });

  it('AC5 — ENEMIES and Dev Utilities stay flat (they fit) and keep their launch rows', async () => {
    const scene = await bootIndex();

    // No group headers outside the plain-scenes column.
    const enemiesRows = scene.getColumnRows('enemies');
    const devRows = scene.getColumnRows('devUtilities');
    expect(enemiesRows.map((r) => `${r.kind}:${r.label}`)).toEqual([
      `member:${FODDER_ENEMIES_LABEL}`,
      `member:${BOSS_SCENE_LABEL}`,
      `member:${MINI_BOSS_SCENE_LABEL}`,
    ]);
    expect(devRows.map((r) => `${r.kind}:${r.label}`)).toEqual(['member:CurveSequencer']);

    // Their launch rows still boot the same scenes.
    const enemiesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    expect(findTextAt(scene, BOSS_SCENE_LABEL, enemiesCol).getData('sceneKey')).toBe(BOSS_SCENE_KEY);
    const devCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities;
    findTextAt(scene, 'CurveSequencer', devCol).emit('pointerdown');
    await advanceGame(booted!.game, 350);
    expect(booted!.game.scene.isActive('GymCurveSequencer')).toBe(true);
  });

  it('AC6 — a grouped member launches exactly the scene key the flat row used', async () => {
    const scene = await bootIndex();

    findGroupHeader(scene, 'Worlds').emit('pointerdown');
    const scenesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const hexWar = findTextAt(scene, 'HexWar', scenesCol);
    expect(hexWar.getData('sceneKey')).toBe('GymHexWar');

    hexWar.emit('pointerdown');
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive('GymHexWar')).toBe(true);
    expect(booted!.game.scene.isActive(GYM_INDEX_KEY)).toBe(false);
  });

  it('AC6 — expanded state is not persisted: a re-created index starts all-collapsed', async () => {
    const scene = await bootIndex();

    findGroupHeader(scene, 'Weapons').emit('pointerdown');
    expect(scene.getExpandedGroup('scenes')).toBe('weapons');

    scene.scene.restart();
    await advanceGame(booted!.game, 350);

    expect(scene.getExpandedGroup('scenes')).toBeNull();
    expect(
      scene.visibleRows.filter((row) => row.kind === 'member' && row.columnId === 'scenes'),
    ).toHaveLength(0);
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Player & Combat', false));
  });
});

describe('GymIndex — keyboard navigation over visible rows (AH-0MUDZFBYY008P7ZE)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
    document.getElementById('gym-curve-panel')?.remove();
  });

  async function bootIndex(): Promise<GymIndex> {
    booted = await bootScene([GymIndex]);
    return booted!.scene as GymIndex;
  }

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressKey(scene: GymIndex, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  /** Visible rows of one column (group headers + expanded members), top → bottom. */
  function columnLabels(scene: GymIndex, columnId: 'scenes' | 'enemies' | 'devUtilities'): string[] {
    return scene.getColumnRows(columnId).map((row) => row.label);
  }

  /** Visible labels per column, left-to-right (the visual grid). */
  function gridLabels(scene: GymIndex): string[][] {
    return [
      columnLabels(scene, 'scenes'),
      columnLabels(scene, 'enemies'),
      columnLabels(scene, 'devUtilities'),
    ];
  }

  /** Visible labels in reading order (columns left → right). */
  function readingOrder(scene: GymIndex): string[] {
    return scene.visibleRows.map((row: GymIndexVisibleRow) => row.label);
  }

  it('AC4 — every visible row is registered and the first is focused + highlighted', async () => {
    const scene = await bootIndex();
    const order = readingOrder(scene);

    expect(order.length).toBeGreaterThan(0);
    // Only visible rows are focusable: collapsed members are absent.
    expect(scene.getFocusControlCount()).toBe(order.length);
    expect(focusableRows(scene)).toHaveLength(order.length);

    // Exactly one row focused by default — the first group header.
    expect(scene.getFocusedIndex()).toBe(0);
    expect(scene.getFocusedLabel()).toBe(order[0]);
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Player & Combat', false));

    const rows = focusableRows(scene);
    // Default row carries the focus highlight (bright colour + stroke)...
    expect(rows[0].style.stroke).toBeTruthy();
    expect(rows[0].style.strokeThickness).toBeGreaterThan(0);
    // ...while every other row is rendered unfocused (no stroke).
    for (const row of rows.slice(1)) {
      expect(row.style.strokeThickness ?? 0).toBe(0);
    }
  });

  it('AC4 — Left/Right move between columns and wrap at both ends', async () => {
    const scene = await bootIndex();
    const cols = gridLabels(scene);

    expect(scene.getFocusedLabel()).toBe(cols[0][0]);

    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(cols[1][0]);
    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(cols[2][0]);
    pressKey(scene, { key: 'ArrowRight' }); // wraps to the leftmost column
    expect(scene.getFocusedLabel()).toBe(cols[0][0]);

    pressKey(scene, { key: 'ArrowLeft' }); // wraps to the rightmost column
    expect(scene.getFocusedLabel()).toBe(cols[2][0]);
    pressKey(scene, { key: 'ArrowLeft' });
    expect(scene.getFocusedLabel()).toBe(cols[1][0]);
    pressKey(scene, { key: 'ArrowLeft' });
    expect(scene.getFocusedLabel()).toBe(cols[0][0]);
  });

  it('AC4 — Up/Down cycle the visible rows of the current column, headers included', async () => {
    const scene = await bootIndex();
    const scenesCol = columnLabels(scene, 'scenes');

    expect(scene.getFocusedLabel()).toBe(scenesCol[0]);
    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe(scenesCol[1]);
    pressKey(scene, { key: 'ArrowUp' });
    expect(scene.getFocusedLabel()).toBe(scenesCol[0]);
    pressKey(scene, { key: 'ArrowUp' }); // wraps to the bottom of the column
    expect(scene.getFocusedLabel()).toBe(scenesCol[scenesCol.length - 1]);
    pressKey(scene, { key: 'ArrowDown' }); // wraps back to the top
    expect(scene.getFocusedLabel()).toBe(scenesCol[0]);

    // ENEMIES column wraps within itself too.
    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(columnLabels(scene, 'enemies')[0]);
    pressKey(scene, { key: 'ArrowUp' });
    expect(scene.getFocusedLabel()).toBe(
      columnLabels(scene, 'enemies')[columnLabels(scene, 'enemies').length - 1],
    );
    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe(columnLabels(scene, 'enemies')[0]);
  });

  it('AC4 — Up/Down also reach the expanded group members', async () => {
    const scene = await bootIndex();

    // Expand the first group: its members join the column's visible rows.
    pressKey(scene, { key: 'Enter' });
    const scenesCol = columnLabels(scene, 'scenes');
    expect(scenesCol.slice(0, 5)).toEqual([
      groupHeaderLabel('Player & Combat', true),
      'AsteroidStress',
      'Performance',
      'Player',
      'Rhythm',
    ]);

    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('AsteroidStress');
    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('Performance');
    pressKey(scene, { key: 'ArrowUp' });
    expect(scene.getFocusedLabel()).toBe('AsteroidStress');
    pressKey(scene, { key: 'ArrowUp' });
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Player & Combat', true));
  });

  it('AC4 — entering a shorter column clamps to a valid, highlighted visible row', async () => {
    const scene = await bootIndex();
    const cols = gridLabels(scene);

    // Drive focus to the bottom of the longest (plain scenes) column.
    for (let i = 0; i < cols[0].length - 1; i++) pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe(cols[0][cols[0].length - 1]);

    // Right into the shorter ENEMIES column — clamps to its last visible row.
    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(cols[1][cols[1].length - 1]);
    expect(scene.getFocusedIndex()).toBeLessThan(scene.getFocusControlCount());

    // Right again into the single-row Dev Utilities column.
    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(cols[2][0]);

    // The focused row is a real on-screen row carrying the focus highlight —
    // never an out-of-range index or a header.
    const focused = focusableRows(scene).find((c) => c.text === scene.getFocusedLabel());
    expect(focused).toBeDefined();
    expect(focused!.style.strokeThickness ?? 0).toBeGreaterThan(0);
  });

  it('AC4 — Tab stays linear over visible rows while collapsed members are never focusable', async () => {
    const scene = await bootIndex();
    const order = readingOrder(scene);

    // Cycle the whole visible set; each step lands on the next visible row.
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(order[1]);
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(order[2]);
    pressKey(scene, { key: 'Tab', shiftKey: true });
    expect(scene.getFocusedLabel()).toBe(order[1]);

    // Walk every visible row and back: the cycle contains no collapsed member.
    // Reset to the first visible row (bounded, so a broken cycle cannot hang).
    for (let i = 0; i < order.length && scene.getFocusedLabel() !== order[0]; i++) {
      pressKey(scene, { key: 'Tab' });
    }
    expect(scene.getFocusedLabel()).toBe(order[0]);
    const seen: string[] = [scene.getFocusedLabel()];
    for (let i = 1; i < order.length; i++) {
      pressKey(scene, { key: 'Tab' });
      seen.push(scene.getFocusedLabel());
    }
    expect(seen).toEqual(order);
    // No collapsed member ever enters the cycle.
    const collapsedMembers = scene.listedScenes.map((s) => s.label);
    for (const label of seen) {
      expect(collapsedMembers, `"${label}" is a collapsed member`).not.toContain(label);
    }
    // Wraps back to the first visible row.
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(order[0]);
  });

  it('AC4 — activation works after moving between columns', async () => {
    const scene = await bootIndex();

    // Move Right into the ENEMIES column, then activate its first row.
    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(FODDER_ENEMIES_LABEL);

    pressKey(scene, { key: 'Enter' });
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive('GymIndex')).toBe(false);
  });

  it('AC4 — Enter launches a group member reached with the arrow keys', async () => {
    const scene = await bootIndex();

    // Expand the Worlds group from the keyboard, then walk to its first member.
    pressKey(scene, { key: 'ArrowDown' }); // → Worlds
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Worlds', false));
    pressKey(scene, { key: 'Enter' });
    expect(scene.getFocusedLabel()).toBe(groupHeaderLabel('Worlds', true));

    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('Hangar');
    pressKey(scene, { key: 'Enter' });
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive('GymHangar')).toBe(true);
    expect(booted!.game.scene.isActive('GymIndex')).toBe(false);
  });

  it('AC6+AC7 — the hint advertises columns, rows and expand/collapse', async () => {
    const scene = await bootIndex();
    const hint = findText(scene, GYM_INDEX_HINT);

    expect(hint.text).toContain('←/→');
    expect(hint.text).toContain('↑/↓');
    expect(hint.text).toContain('expand');
  });

  it('AC6 — Space activates the focused "Fodder Enemies" row via GymFodderEnemies', async () => {
    const scene = await bootIndex();
    const targetIndex = columnLabels(scene, 'scenes').length; // first ENEMIES row

    for (let i = 0; i < targetIndex; i++) pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(FODDER_ENEMIES_LABEL);

    pressKey(scene, { key: ' ' });
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(true);
    const gym = booted!.game.scene.getScene(FODDER_ENEMIES_SCENE_KEY) as unknown as {
      activeEnemyKey: string;
    };
    expect(gym.activeEnemyKey).toBe('scout');
  });

  it('AC6 — Enter activates the focused dedicated boss (GymBoss) row', async () => {
    const scene = await bootIndex();
    const targetIndex =
      columnLabels(scene, 'scenes').length +
      scene.listedEnemyScenes.findIndex((e) => e.sceneKey === BOSS_SCENE_KEY);
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    for (let i = 0; i < targetIndex; i++) pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(BOSS_SCENE_LABEL);

    pressKey(scene, { key: 'Enter' });
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(BOSS_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(false);
  });

  it('AC6 — Enter activates the focused Dev Utilities row directly', async () => {
    const scene = await bootIndex();
    const dev = scene.listedDevUtilityScenes[0];
    expect(dev).toBeDefined();
    const targetIndex = columnLabels(scene, 'scenes').length + columnLabels(scene, 'enemies').length;

    for (let i = 0; i < targetIndex; i++) pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(dev!.label);

    pressKey(scene, { key: 'Enter' });
    await advanceGame(booted!.game, 350);

    expect(booted!.game.scene.isActive(dev!.key)).toBe(true);
  });

  it('AC6 — ESC still returns to the menu and scene shutdown releases the focus manager', async () => {
    const shutdownSpy = vi.spyOn(FocusManager.prototype, 'shutdown');
    try {
      booted = await bootScene([GymIndex, MenuScene]);
      const scene = booted.scene as GymIndex;
      expect(scene.getFocusControlCount()).toBeGreaterThan(0);

      // ESC navigation is untouched by the added keyboard handling.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await advanceGame(booted!.game, 350);

      expect(booted.game.scene.isActive('MenuScene')).toBe(true);
      expect(shutdownSpy).toHaveBeenCalled();
    } finally {
      shutdownSpy.mockRestore();
    }
  });
});

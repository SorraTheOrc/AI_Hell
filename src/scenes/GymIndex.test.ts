/**
 * Tests for the GymIndex entry scene (AC2/AC3/AC4/AC6) and its keyboard
 * navigation (AH-0MUDZFBYY008P7ZE):
 *  - boots as the entry scene and shows the title,
 *  - lists every gym scene under `src/scenes/gym/` sorted alphabetically
 *    by label, excluding `.test.ts` modules and itself,
 *  - clicking an entry immediately starts that scene by its key,
 *  - the shared "← INDEX" button on a gym scene returns to the index,
 *  - keyboard navigation: default focus, Tab/arrow cycling with wrap,
 *    Enter/Space activation per row flavour, and shutdown cleanup.
 *
 * Since AH-0MV13G5EV008D41E the ENEMIES column is a single "Fodder Enemies"
 * row (booting the reusable `GymFodderEnemies` scene bare) plus the dedicated
 * `GymBoss` "Boss" row; the Bosses column and the per-config rows are gone.
 *
 * Discovery runs through the real `import.meta.glob` (Vitest supports it),
 * so these tests exercise the actual files on disk — a new `Gym<Name>.ts`
 * appearing in the folder is picked up without editing the list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { GAME_WIDTH } from '../core/constants';
import { FocusManager } from '../utils/focusManager';
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../utils/gymNavigation';
import {
  GymIndex,
  GYM_INDEX_TITLE,
  GYM_INDEX_COLUMN_X,
  GYM_INDEX_ENEMIES_HEADER,
  GYM_INDEX_DEV_UTILITIES_HEADER,
  FODDER_ENEMIES_SCENE_KEY,
  FODDER_ENEMIES_LABEL,
  BOSS_SCENE_KEY,
  BOSS_SCENE_LABEL,
} from './GymIndex';
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
    // (AH-0MUAYB28C004KK7X, AH-0MV13G5EV008D41E). Labels strip the leading
    // "Gym" and are sorted alphabetically. GymFodderEnemies is likewise not
    // listed as a bare scene — a single fodder row boots it.
    expect(scene.listedScenes.map((s) => s.label)).toEqual([
      'Centipede',
      'Level',
      'Minerals',
      'Player',
      'PowerUpsCombat',
      'PowerUpsUtility',
      'WeaponLeveling',
      'Weapons',
    ]);
    expect(scene.listedScenes.map((s) => s.key)).toEqual([
      'GymCentipede',
      'GymLevel',
      'GymMinerals',
      'GymPlayer',
      'GymPowerUpsCombat',
      'GymPowerUpsUtility',
      'GymWeaponLeveling',
      'GymWeapons',
    ]);

    // Middle column: exactly two scene rows — the reusable fodder gym and the
    // dedicated boss. No per-config rows (the archetype dropdown lives inside
    // GymFodderEnemies) and no `boss` "Boss Swarm" row.
    expect(scene.listedEnemyScenes).toEqual([
      { key: FODDER_ENEMIES_SCENE_KEY, label: FODDER_ENEMIES_LABEL, sceneKey: FODDER_ENEMIES_SCENE_KEY },
      { key: BOSS_SCENE_KEY, label: BOSS_SCENE_LABEL, sceneKey: BOSS_SCENE_KEY },
    ]);
    expect(scene.listedEnemyScenes.every((s) => s.enemyKey === undefined)).toBe(true);

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
    await new Promise((r) => setTimeout(r, 350));

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
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive(BOSS_SCENE_KEY)).toBe(true);
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
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive(GYM_INDEX_KEY)).toBe(true);
    expect(booted!.game.scene.isActive('GymBoss')).toBe(false);
  });
});

describe('GymIndex — layout (AH-0MV13G5EV008D41E)', () => {
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

    // A plain scene (Minerals) is in the left column.
    expect(findTextAt(idx, 'Minerals', scenesCol)).toBeDefined();

    // Columns are strictly ordered left-to-right.
    expect(scenesCol).toBeLessThan(enemiesCol);
    expect(enemiesCol).toBeLessThan(devCol);
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
    await new Promise((r) => setTimeout(r, 350));

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
    await new Promise((r) => setTimeout(r, 350));

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
    await new Promise((r) => setTimeout(r, 350));

    expect(scene.sys.isActive()).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });
});

describe('GymIndex — keyboard navigation (AH-0MUDZFBYY008P7ZE)', () => {
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

  /** Expected focus order: columns left→right, top→bottom within a column. */
  function readingOrder(scene: GymIndex): string[] {
    return [
      ...scene.listedScenes.map((s) => s.label),
      ...scene.listedEnemyScenes.map((s) => s.label),
      ...scene.listedDevUtilityScenes.map((s) => s.label),
    ];
  }

  /** Focusable on-screen rows (interactive text objects, headers excluded). */
  function focusableRows(scene: GymIndex): Phaser.GameObjects.Text[] {
    return (scene.children.list as Phaser.GameObjects.Text[]).filter(
      (c) => c instanceof Phaser.GameObjects.Text && c.input?.enabled,
    );
  }

  it('AC1 — every row is registered and the first is focused + highlighted', async () => {
    const scene = await bootIndex();
    const order = readingOrder(scene);

    expect(order.length).toBeGreaterThan(0);
    // Every rendered row across all three columns is registered.
    expect(scene.getFocusControlCount()).toBe(order.length);
    expect(focusableRows(scene)).toHaveLength(order.length);

    // Exactly one row focused by default — the first in reading order.
    expect(scene.getFocusedIndex()).toBe(0);
    expect(scene.getFocusedLabel()).toBe(order[0]);

    const rows = focusableRows(scene);
    // Default row carries the focus highlight (bright colour + stroke)...
    expect(rows[0].style.stroke).toBeTruthy();
    expect(rows[0].style.strokeThickness).toBeGreaterThan(0);
    // ...while every other row is rendered unfocused (no stroke).
    for (const row of rows.slice(1)) {
      expect(row.style.strokeThickness ?? 0).toBe(0);
    }
  });

  it('AC2 — Tab/arrows cycle focus in reading order and wrap at both ends', async () => {
    const scene = await bootIndex();
    const order = readingOrder(scene);
    const n = order.length;

    expect(scene.getFocusedIndex()).toBe(0);

    // Forward: Tab, ArrowDown, ArrowRight.
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(order[1 % n]);
    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe(order[2 % n]);
    pressKey(scene, { key: 'ArrowRight' });
    expect(scene.getFocusedLabel()).toBe(order[3 % n]);

    // Backward: Shift+Tab, ArrowUp, ArrowLeft.
    pressKey(scene, { key: 'Tab', shiftKey: true });
    expect(scene.getFocusedLabel()).toBe(order[2 % n]);
    pressKey(scene, { key: 'ArrowUp' });
    expect(scene.getFocusedLabel()).toBe(order[1 % n]);
    pressKey(scene, { key: 'ArrowLeft' });
    expect(scene.getFocusedIndex()).toBe(0);

    // Wrap backwards from the first row to the last.
    pressKey(scene, { key: 'ArrowLeft' });
    expect(scene.getFocusedIndex()).toBe(n - 1);
    expect(scene.getFocusedLabel()).toBe(order[n - 1]);

    // Wrap forwards from the last row back to the first.
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedIndex()).toBe(0);
    expect(scene.getFocusedLabel()).toBe(order[0]);
  });

  it('AC3 — Enter activates the default-focused plain scene row', async () => {
    const scene = await bootIndex();
    const first = scene.listedScenes[0];
    expect(scene.getFocusedLabel()).toBe(first.label);

    pressKey(scene, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive(first.key)).toBe(true);
    expect(booted!.game.scene.isActive('GymIndex')).toBe(false);
  });

  it('AC3 — Space activates the focused "Fodder Enemies" row via GymFodderEnemies', async () => {
    const scene = await bootIndex();
    const enemyIndex = scene.listedEnemyScenes.findIndex(
      (e) => e.key === FODDER_ENEMIES_SCENE_KEY,
    );
    expect(enemyIndex).toBeGreaterThanOrEqual(0);
    const targetIndex = scene.listedScenes.length + enemyIndex;

    for (let i = 0; i < targetIndex; i++) pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(FODDER_ENEMIES_LABEL);

    pressKey(scene, { key: ' ' });
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(true);
    const gym = booted!.game.scene.getScene(FODDER_ENEMIES_SCENE_KEY) as unknown as {
      activeEnemyKey: string;
    };
    expect(gym.activeEnemyKey).toBe('scout');
  });

  it('AC3 — Enter activates the focused dedicated boss (GymBoss) row', async () => {
    const scene = await bootIndex();
    const bossIndex = scene.listedEnemyScenes.findIndex((e) => e.sceneKey === BOSS_SCENE_KEY);
    expect(bossIndex).toBeGreaterThanOrEqual(0);
    const targetIndex = scene.listedScenes.length + bossIndex;

    for (let i = 0; i < targetIndex; i++) pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(BOSS_SCENE_LABEL);

    pressKey(scene, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive(BOSS_SCENE_KEY)).toBe(true);
    expect(booted!.game.scene.isActive(FODDER_ENEMIES_SCENE_KEY)).toBe(false);
  });

  it('AC3 — Enter activates the focused Dev Utilities row directly', async () => {
    const scene = await bootIndex();
    const dev = scene.listedDevUtilityScenes[0];
    expect(dev).toBeDefined();
    const targetIndex =
      scene.listedScenes.length +
      scene.listedEnemyScenes.length;

    for (let i = 0; i < targetIndex; i++) pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe(dev!.label);

    pressKey(scene, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive(dev!.key)).toBe(true);
  });

  it('AC4 — ESC still returns to the menu and scene shutdown releases the focus manager', async () => {
    const shutdownSpy = vi.spyOn(FocusManager.prototype, 'shutdown');
    try {
      booted = await bootScene([GymIndex, MenuScene]);
      const scene = booted.scene as GymIndex;
      expect(scene.getFocusControlCount()).toBeGreaterThan(0);

      // ESC navigation is untouched by the added keyboard handling.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 350));

      expect(booted.game.scene.isActive('MenuScene')).toBe(true);
      expect(shutdownSpy).toHaveBeenCalled();
    } finally {
      shutdownSpy.mockRestore();
    }
  });
});

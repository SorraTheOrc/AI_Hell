/**
 * Tests for the GymIndex entry scene (AC2/AC3/AC4/AC6):
 *  - boots as the entry scene and shows the title,
 *  - lists every gym scene under `src/scenes/gym/` sorted alphabetically
 *    by label, excluding `.test.ts` modules and itself,
 *  - clicking an entry immediately starts that scene by its key,
 *  - the shared "← INDEX" button on a gym scene returns to the index.
 *
 * Discovery runs through the real `import.meta.glob` (Vitest supports it),
 * so these tests exercise the actual files on disk — a new `Gym<Name>.ts`
 * appearing in the folder is picked up without editing the list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { GAME_WIDTH } from '../core/constants';
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../utils/gymNavigation';
import {
  GymIndex,
  GYM_INDEX_TITLE,
  GYM_INDEX_COLUMN_X,
  GYM_INDEX_ENEMIES_HEADER,
  GYM_INDEX_BOSSES_HEADER,
  GYM_INDEX_DEV_UTILITIES_HEADER,
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
    // the dedicated "Boss" row in the Bosses column instead
    // (AH-0MUAYB28C004KK7X, AH-0MTV8OV9V002D8B7). Labels strip the leading
    // "Gym" and are sorted alphabetically. GymEnemies is likewise not listed
    // as a bare scene — individual enemies appear via listedEnemyScenes (one
    // entry per EnemyConfig). The 5 legacy per-enemy gyms
    // (Scout/Diver/Tank/Phaser/Swarm) were retired (AH-0MTHG5JVP006U6K7).
    expect(scene.listedScenes.map((s) => s.label)).toEqual([
      'Minerals',
      'Player',
      'PowerUpsCombat',
      'PowerUpsUtility',
      'Weapons',
    ]);
    expect(scene.listedScenes.map((s) => s.key)).toEqual([
      'GymMinerals',
      'GymPlayer',
      'GymPowerUpsCombat',
      'GymPowerUpsUtility',
      'GymWeapons',
    ]);
    // Middle column: one config row per non-boss seed archetype, no scene
    // rows. The `boss` config row is grouped in the Bosses column instead
    // (AH-0MTV8OV9V002D8B7).
    const enemyKeys = scene.listedEnemyScenes
      .filter((s) => s.enemyKey)
      .map((s) => s.enemyKey)
      .sort();
    expect(enemyKeys).toEqual(['asteroid', 'diver', 'phaser', 'scout', 'swarm', 'tank']);
    expect(
      scene.listedEnemyScenes
        .filter((s) => s.enemyKey)
        .every((s) => s.key === `GymEnemies:${s.enemyKey}`),
    ).toBe(true);
    // AC3 — neither the boss config nor the dedicated boss scene is in ENEMIES.
    expect(scene.listedEnemyScenes.some((s) => s.enemyKey === 'boss')).toBe(false);
    expect(scene.listedEnemyScenes.some((s) => s.sceneKey === 'GymBoss')).toBe(false);
    // Both boss rows live together in the Bosses column, with distinct
    // labels: "Boss" (the GymBoss scene / real Central AI) and "Boss Swarm"
    // (the plain `boss` config).
    expect(scene.listedBossScenes).toEqual([
      { key: 'GymBoss', label: 'Boss', sceneKey: 'GymBoss' },
      { key: 'GymEnemies:boss', label: 'Boss Swarm', enemyKey: 'boss' },
    ]);

    // No .test.ts module leaks into the list, and the index itself is not
    // listed (it lives outside the globbed folder).
    for (const entry of scene.listedScenes) {
      expect(entry.key.endsWith('.test')).toBe(false);
      expect(entry.key).not.toBe('GymIndex');
    }
  });

  it('AC1 — the real boss is a "Boss" Bosses-column row that boots GymBoss', async () => {
    const scene = await bootIndex();

    // The index registers every discovered left-column scene so scene.start(key) works.
    for (const { key } of scene.listedScenes) {
      expect(booted!.game.scene.getScene(key)).not.toBeNull();
    }

    // The real (multi-phase Central AI) boss is the dedicated GymBoss row in
    // the Bosses (right-most) column.
    const bossRow = scene.listedBossScenes.find((s) => s.sceneKey === 'GymBoss');
    expect(bossRow?.label).toBe('Boss');

    findTextAt(scene, 'Boss', GAME_WIDTH * GYM_INDEX_COLUMN_X.bosses).emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('GymBoss')).toBe(true);
    expect(booted!.game.scene.isActive('GymEnemies')).toBe(false);
  });

  it('AC1+AC2 — the boss config archetype is labelled "Boss Swarm" and boots GymEnemies with enemyKey boss', async () => {
    const scene = await bootIndex();

    // Both boss rows are in the Bosses column; the config row is the one
    // carrying `enemyKey`.
    const bossConfig = scene.listedBossScenes.find((s) => s.enemyKey === 'boss');
    expect(bossConfig?.label).toBe('Boss Swarm');

    findTextAt(scene, 'Boss Swarm', GAME_WIDTH * GYM_INDEX_COLUMN_X.bosses).emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('GymEnemies')).toBe(true);
    const enemies = booted!.game.scene.getScene('GymEnemies') as unknown as {
      activeEnemyKey: string;
    };
    expect(enemies.activeEnemyKey).toBe('boss');
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
describe('GymIndex — enemy config discovery (AH-0MTHG5BSP006A81R)', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  it('routes an enemy entry to GymEnemies with the correct enemyKey', async () => {
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    const scout = idx.listedEnemyScenes.find((s) => s.enemyKey === 'scout');
    expect(scout).toBeDefined();
    // Enemy "Scout" row is unique after retirement; bare GymScout no longer exists.
    const matches = (idx.children.list as Phaser.GameObjects.Text[]).filter(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === scout!.label,
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const enemyRow =
      matches.find((c) => (c as unknown as { getData?: (k: string) => unknown }).getData?.('enemyKey') === 'scout') ??
      matches[0]!;
    enemyRow.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));
    expect(booted.game.scene.isActive('GymEnemies')).toBe(true);
  });

  it('Save As enemy appears on next index load without code changes', async () => {
    const { DEFAULT_ENEMY_CONFIGS } = await import('../core/enemyConfig');
    const { seedConfigStore } = await import('../core/configStore');
    seedConfigStore([
      ...Object.values(DEFAULT_ENEMY_CONFIGS),
      { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'zzz-custom', displayName: 'Zzz Custom' },
    ]);
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    expect(idx.listedEnemyScenes.some((s) => s.enemyKey === 'zzz-custom')).toBe(true);
    expect(idx.listedEnemyScenes.some((s) => s.label === 'Zzz Custom')).toBe(true);
  });

  it('AC2 — a stale persisted boss displayName does not shadow the "Boss Swarm" label', async () => {
    // The gym panel's Save persists the whole config (including displayName).
    // A config saved by an older build labelled the `boss` seed "Boss"; that
    // stale label must not shadow the registry rename, or the index would show
    // two identical "Boss" rows (AH-0MTV8OV9V002D8B7).
    const { DEFAULT_ENEMY_CONFIGS } = await import('../core/enemyConfig');
    const { seedConfigStore } = await import('../core/configStore');
    seedConfigStore([
      ...Object.values(DEFAULT_ENEMY_CONFIGS).filter((c) => c.key !== 'boss'),
      { ...DEFAULT_ENEMY_CONFIGS.boss, displayName: 'Boss' },
    ]);
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    const bossConfig = idx.listedBossScenes.find((s) => s.enemyKey === 'boss');
    expect(bossConfig?.label).toBe('Boss Swarm');
    // The dedicated scene row stays "Boss" — the two labels must remain distinct.
    expect(idx.listedBossScenes.find((s) => s.sceneKey === 'GymBoss')?.label).toBe('Boss');
  });

  it('an empty registry does not crash the index (falls back to seed keys)', async () => {
    const { resetConfigStore } = await import('../core/configStore');
    resetConfigStore();
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    expect(idx.listedEnemyScenes.length).toBeGreaterThan(0);
    expect(idx.listedEnemyScenes.some((s) => s.enemyKey === 'scout')).toBe(true);
  });

  it('AC5 — renders a three-column layout (scenes | ENEMIES | Bosses)', async () => {
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    const scenesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const enemiesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const bossesCol = GAME_WIDTH * GYM_INDEX_COLUMN_X.bosses;

    // AC2/AC3 — the real boss row is in the right-most Bosses column and
    // carries no enemyKey (it boots the GymBoss scene directly).
    const bossSceneRow = findTextAt(idx, 'Boss', bossesCol);
    expect(bossSceneRow.getData('sceneKey')).toBe('GymBoss');
    expect(bossSceneRow.getData('enemyKey')).toBeUndefined();

    // AC1 — the `boss` config row is grouped in the Bosses column too and
    // still routes through GymEnemies via enemyKey.
    const bossConfigRow = findTextAt(idx, 'Boss Swarm', bossesCol);
    expect(bossConfigRow.getData('enemyKey')).toBe('boss');

    // AC3 — the boss config is absent from the ENEMIES column (no row with
    // that enemyKey sits at the middle column X).
    expect(idx.listedEnemyScenes.some((s) => s.enemyKey === 'boss')).toBe(false);

    // A regular enemy config (Scout) is in the ENEMIES column.
    expect(findTextAt(idx, 'Scout', enemiesCol)).toBeDefined();

    // Headers sit above their columns.
    expect(findTextAt(idx, GYM_INDEX_ENEMIES_HEADER, enemiesCol)).toBeDefined();
    expect(findTextAt(idx, GYM_INDEX_BOSSES_HEADER, bossesCol)).toBeDefined();

    // A plain scene (Minerals) is in the left column.
    expect(findTextAt(idx, 'Minerals', scenesCol)).toBeDefined();

    // Columns are strictly ordered left-to-right.
    expect(scenesCol).toBeLessThan(enemiesCol);
    expect(enemiesCol).toBeLessThan(bossesCol);
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

    // The Dev Utilities column sits to the right of the other three.
    expect(devCol).toBeGreaterThan(GAME_WIDTH * GYM_INDEX_COLUMN_X.bosses);
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

    // Fire a non-ESC key.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise((r) => setTimeout(r, 350));

    expect(scene.sys.isActive()).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });
});


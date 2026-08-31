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
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../utils/gymNavigation';
import { GymIndex, GYM_INDEX_TITLE } from './GymIndex';
import { GymBoss } from './gym/GymBoss';

/** Finds an on-screen text by label. */
function findText(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
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

    // GymPlayer, GymPhaser, GymScout, GymTank, GymDiver, GymSwarm,
    // GymPowerUps, GymWeapons, GymBoss are on disk. Labels strip the
    // leading "Gym" and are sorted alphabetically.
    // GymEnemies is no longer listed as a bare scene — individual enemies
    // appear via listedEnemyScenes instead (one entry per EnemyConfig).
    // 5 legacy per-enemy gyms (Scout/Diver/Tank/Phaser/Swarm) have been retired
    // (AH-0MTHG5JVP006U6K7) — individual enemies now appear via listedEnemyScenes.
    expect(scene.listedScenes.map((s) => s.label)).toEqual([
      'Boss',
      'Player',
      'PowerUps',
      'Weapons',
    ]);
    expect(scene.listedScenes.map((s) => s.key)).toEqual([
      'GymBoss',
      'GymPlayer',
      'GymPowerUps',
      'GymWeapons',
    ]);
    // Enemy section: one entry per seed config (+ any Save As entries)
    const enemyKeys = scene.listedEnemyScenes.map((s) => s.enemyKey).sort();
    expect(enemyKeys).toEqual(expect.arrayContaining(['scout', 'diver', 'tank', 'phaser', 'swarm', 'boss'].sort()));
    expect(scene.listedEnemyScenes.every((s) => s.key === `GymEnemies:${s.enemyKey}`)).toBe(true);

    // No .test.ts module leaks into the list, and the index itself is not
    // listed (it lives outside the globbed folder).
    for (const entry of scene.listedScenes) {
      expect(entry.key.endsWith('.test')).toBe(false);
      expect(entry.key).not.toBe('GymIndex');
    }
  });

  it('AC4 — registers discovered scenes and clicking an entry starts it immediately', async () => {
    const scene = await bootIndex();

    // The index registers every discovered scene so scene.start(key) works.
    for (const { key } of scene.listedScenes) {
      expect(booted!.game.scene.getScene(key)).not.toBeNull();
    }

    // Click the "Boss" entry — the GymBoss scene should start.
    findText(scene, 'Boss').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('GymBoss')).toBe(true);
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
    const { saveEnemyConfig, DEFAULT_ENEMY_CONFIGS } = await import('../core/enemyConfig');
    saveEnemyConfig({ ...DEFAULT_ENEMY_CONFIGS.scout, key: 'zzz-custom', displayName: 'Zzz Custom' });
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    expect(idx.listedEnemyScenes.some((s) => s.enemyKey === 'zzz-custom')).toBe(true);
    expect(idx.listedEnemyScenes.some((s) => s.label === 'Zzz Custom')).toBe(true);
  });

  it('corrupt storage does not crash the index (falls back via loadAllEnemyConfigs)', async () => {
    localStorage.setItem('ai-hell-enemy-config:scout', 'not-json');
    booted = await bootScene([GymIndex]);
    const idx = booted.scene as GymIndex;
    expect(idx.listedEnemyScenes.length).toBeGreaterThan(0);
    expect(idx.listedEnemyScenes.some((s) => s.enemyKey === 'scout')).toBe(true);
  });
});


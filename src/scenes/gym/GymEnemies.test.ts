/**
 * AH-0MTHG5B83007W4W4 — Single reusable enemy gym scene (GymEnemies).
 *
 * Happy-dom boot per seed (count/spacing), corruption fallback, and
 * discoverability via the gym index glob. Respawn-when-all-killed delegates
 * to GymFormationScene — asserted implicitly via aliveCount behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS, ENEMY_CONFIG_STORAGE_PREFIX } from '../../core/enemyConfig';
import { GymEnemies, GYM_ENEMIES_DEFAULT_KEY } from './GymEnemies';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';

// GymIndex discovery helper (glob) — verify GymEnemies is listed without extra registration.
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';

function findButton(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text && c.text === label,
  );
  expect(found, `button "${label}" not found`).toBeDefined();
  return found!;
}

describe('GymEnemies — single reusable enemy gym', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootWithKey(enemyKey?: string): Promise<GymEnemies> {
    // Boot via a one-off wrapper so init({ enemyKey }) is invoked before create().
    // Direct bootScene([GymEnemies]) would default to scout; wrapper lets us
    // exercise per-seed formation without changing the harness.
    const key = enemyKey ?? GYM_ENEMIES_DEFAULT_KEY;
    class Wrapper extends GymEnemies {
      override init(_data?: { enemyKey?: string }): void {
        super.init({ enemyKey: key });
      }
    }
    // Give wrapper a unique Phaser key to avoid collisions across loops.
    Object.defineProperty(Wrapper, 'name', { value: `Wrapper_${key}` });
    booted = await bootScene([Wrapper as unknown as typeof Phaser.Scene]);
    return booted.scene as unknown as GymEnemies;
  }

  it('boots with default key (scout) when no init data is provided', async () => {
    booted = await bootScene([GymEnemies]);
    const scene = booted.scene as GymEnemies;
    expect(scene.sys.isActive()).toBe(true);
    expect(scene.activeEnemyKey).toBe(GYM_ENEMIES_DEFAULT_KEY);
    expect(scene.formationEntities.length).toBe(DEFAULT_ENEMY_CONFIGS.scout.count);
  });

  it.each(Object.keys(DEFAULT_ENEMY_CONFIGS))('spawns correct count for seed "%s"', async (key) => {
    const scene = await bootWithKey(key);
    const expected = DEFAULT_ENEMY_CONFIGS[key].count;
    expect(scene.formationEntities.length).toBe(expected);
    expect(scene.aliveCount).toBe(expected);
  });

  it.each(Object.keys(DEFAULT_ENEMY_CONFIGS))('respects spacing/start/drift for seed "%s"', async (key) => {
    const scene = await bootWithKey(key);
    const cfg = DEFAULT_ENEMY_CONFIGS[key];
    // Spacing / drift / start are wired from EnemyConfig; spot-check via
    // formation base position. formationX drifts during bootDelay (~150ms)
    // so allow driftSpeed*0.3s tolerance.
    expect(scene.formationX).toBeGreaterThanOrEqual(cfg.startX - 1);
    expect(scene.formationX).toBeLessThanOrEqual(cfg.startX + cfg.driftSpeed * 0.3 + 2);
    expect(scene.formationY).toBeCloseTo(cfg.startY, 0);
    // For non-orbital/swarm kinds, each entity sits on its slot (Scout wiggles ±2px).
    // Phaser orbits around the base (spacing unused) and Swarm weaves (±30% spacing),
    // so only assert slot fidelity for v/diver/rect/single.
    if (cfg.formationKind === 'v' || cfg.formationKind === 'diver' || cfg.formationKind === 'rect' || cfg.formationKind === 'single') {
      for (const e of scene.formationEntities) {
        const { row, col } = (e as unknown as { offset: { row: number; col: number } }).offset;
        expect(Math.abs(e.x - (scene.formationX + col * cfg.spacingX))).toBeLessThanOrEqual(3);
        expect(e.y).toBeCloseTo(scene.formationY + row * cfg.spacingY, 0);
      }
    } else {
      // Orbital/swarm: just confirm entities are near the formation (within a screen-width band)
      for (const e of scene.formationEntities) {
        expect(Math.abs(e.x - scene.formationX)).toBeLessThan(400);
        expect(Math.abs(e.y - scene.formationY)).toBeLessThan(400);
      }
    }
  });

  it('uses displayName-derived hint/status and player component', async () => {
    const scene = await bootWithKey('scout');
    // Status line contains the displayName lowercased
    const status = (scene as unknown as { statusText: Phaser.GameObjects.Text }).statusText;
    expect(status.text.toLowerCase()).toContain('scout');
    // Hint contains the formationKind
    const hint = scene.children.list.find(
      (c): c is Phaser.GameObjects.Text =>
        c instanceof Phaser.GameObjects.Text && c.text.includes('formation (config-driven)'),
    );
    expect(hint).toBeDefined();
    expect(scene.getPlayer()).not.toBeNull();
    expect(findButton(scene, 'EXPLODE')).toBeDefined();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });

  it('boots without throwing when storage entry is corrupt (fallback to seed)', async () => {
    localStorage.setItem(`${ENEMY_CONFIG_STORAGE_PREFIX}scout`, 'not-json{{{');
    // Wrapper for scout will load the corrupt entry and fall back
    const scene = await bootWithKey('scout');
    expect(scene.formationEntities.length).toBe(DEFAULT_ENEMY_CONFIGS.scout.count);
    expect(scene.aliveCount).toBe(DEFAULT_ENEMY_CONFIGS.scout.count);
  });

  it('boots without throwing when storage is empty (seed defaults)', async () => {
    // localStorage already cleared in beforeEach
    const scene = await bootWithKey('tank');
    expect(scene.formationEntities.length).toBe(DEFAULT_ENEMY_CONFIGS.tank.count);
  });

  it('custom Save As key falls back to Scout entity but uses custom count/spacing', async () => {
    const custom = {
      ...DEFAULT_ENEMY_CONFIGS.scout,
      key: 'my-boss',
      displayName: 'My Boss',
      count: 3,
      spacingX: 40,
      spacingY: 40,
    };
    localStorage.setItem(`${ENEMY_CONFIG_STORAGE_PREFIX}my-boss`, JSON.stringify(custom));
    const scene = await bootWithKey('my-boss');
    expect(scene.formationEntities.length).toBe(3);
    // Unknown key → Scout fallback, so entities are alive and shootEnabled toggles
    expect(scene.aliveCount).toBe(3);
  });

  it('EXPLODE reduces aliveCount and is harmless when empty (no respawn yet — delegates to base)', async () => {
    const scene = await bootWithKey('scout');
    const btn = findButton(scene, 'EXPLODE');
    const initial = scene.aliveCount;
    btn.emit('pointerdown');
    expect(scene.aliveCount).toBe(initial - 1);
    for (let i = initial - 1; i > 0; i--) btn.emit('pointerdown');
    expect(scene.aliveCount).toBe(0);
    expect(() => btn.emit('pointerdown')).not.toThrow();
    expect(scene.aliveCount).toBe(0);
  });

  it('is discoverable by GymIndex via import.meta.glob (no extra registration)', async () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const found = entries.find((e) => e.key === 'GymEnemies');
    expect(found, 'GymEnemies not discovered by glob').toBeDefined();
    expect(found!.label.toLowerCase()).toContain('enemies');
  });
});

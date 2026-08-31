/**
 * AH-0MTHG5B83007W4W4 — Single reusable enemy gym scene (GymEnemies).
 *
 * Happy-dom boot per seed (count/spacing), corruption fallback, and
 * discoverability via the gym index glob. Respawn-when-all-killed delegates
 * to GymFormationScene — asserted implicitly via aliveCount behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS, ENEMY_CONFIG_STORAGE_PREFIX } from '../../core/enemyConfig';
import { PLAYER_SPAWN } from '../../core/constants';
import { GymEnemies, GYM_ENEMIES_DEFAULT_KEY } from './GymEnemies';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { SWARM_BURST_INTERVAL } from '../../entities/Swarm';

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
    document.getElementById('enemy-gym-panel')?.remove();
    // Also remove any GymPlayer panel leakage if overlapping test runs
    document.getElementById('gym-config-panel')?.remove();
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

  // ── Editor panel (AH-0MTHG5BIB006PP0P) ──────────────────────────

  it('renders the editor panel with sliders/selects/colour and Save/Save As controls queryable by DOM', async () => {
    await bootWithKey('scout');
    const panel = document.getElementById('enemy-gym-panel');
    expect(panel, 'enemy-gym-panel missing').not.toBeNull();
    expect(panel!.querySelector('input[data-config="driftSpeed"]')).not.toBeNull();
    expect(panel!.querySelector('input[data-config="spacingX"]')).not.toBeNull();
    expect(panel!.querySelector('input[data-config="count"]')).not.toBeNull();
    expect(panel!.querySelector('input[data-config="fireInterval"]')).not.toBeNull();
    expect(panel!.querySelector('input[data-config="bulletSpeed"]')).not.toBeNull();
    expect(panel!.querySelector('select[data-config="formationKind"]')).not.toBeNull();
    expect(panel!.querySelector('select[data-config="shotPattern"]')).not.toBeNull();
    expect(panel!.querySelector('input[data-config="color"]')).not.toBeNull();
    expect(document.getElementById('enemy-gym-save')).not.toBeNull();
    expect(document.getElementById('enemy-gym-save-as')).not.toBeNull();
    expect(document.getElementById('enemy-gym-save-as-input')).not.toBeNull();
    expect(document.getElementById('enemy-gym-save-status')).not.toBeNull();
  });

  it('panel input live-updates in-memory config and is observable via currentConfig', async () => {
    const scene = await bootWithKey('scout');
    const input = document.querySelector<HTMLInputElement>('input[data-config="driftSpeed"]')!;
    const before = scene.currentConfig.driftSpeed;
    input.value = String(before + 20);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scene.currentConfig.driftSpeed).toBe(before + 20);
  });

  it('Save overwrites the active config and round-trips via loadEnemyConfig', async () => {
    const { loadEnemyConfig: lec } = await import('../../core/enemyConfig');
    await bootWithKey('scout');
    const input = document.querySelector<HTMLInputElement>('input[data-config="spacingX"]')!;
    input.value = '55';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    (document.getElementById('enemy-gym-save') as HTMLButtonElement).click();
    expect(document.getElementById('enemy-gym-save-status')!.textContent).toContain('Saved');
    expect(lec('scout').spacingX).toBe(55);
  });

  it('Save As creates a new entry and is discoverable; round-trip holds', async () => {
    const { loadEnemyConfig: lec2, listEnemyConfigKeys: lkeys } = await import('../../core/enemyConfig');
    const scene = await bootWithKey('scout');
    (document.getElementById('enemy-gym-save-as-input') as HTMLInputElement).value = 'My New Enemy';
    (document.getElementById('enemy-gym-save-as') as HTMLButtonElement).click();
    expect(document.getElementById('enemy-gym-save-status')!.textContent).toContain('my-new-enemy');
    expect(lkeys()).toContain('my-new-enemy');
    expect(lec2('my-new-enemy').displayName).toBe('My New Enemy');
    expect(scene.activeEnemyKey).toBe('my-new-enemy');
    expect(lec2('my-new-enemy').spacingX).toBe(scene.currentConfig.spacingX);
  });

  it('Save As validates empty name and shows an error without creating a file', async () => {
    const { listEnemyConfigKeys: lkeys2 } = await import('../../core/enemyConfig');
    await bootWithKey('scout');
    const before = lkeys2().slice();
    (document.getElementById('enemy-gym-save-as-input') as HTMLInputElement).value = '   ';
    (document.getElementById('enemy-gym-save-as') as HTMLButtonElement).click();
    expect(document.getElementById('enemy-gym-save-status')!.textContent!.toLowerCase()).toContain('must not be empty');
    expect(lkeys2()).toEqual(before);
  });

  it('Save As validates duplicate key and shows an error without overwriting', async () => {
    const { loadEnemyConfig: lec3 } = await import('../../core/enemyConfig');
    await bootWithKey('scout');
    const original = lec3('scout');
    (document.getElementById('enemy-gym-save-as-input') as HTMLInputElement).value = 'scout';
    (document.getElementById('enemy-gym-save-as') as HTMLButtonElement).click();
    expect(document.getElementById('enemy-gym-save-status')!.textContent!.toLowerCase()).toContain('already exists');
    expect(lec3('scout')).toEqual(original);
  });

  it('SHUTDOWN removes the panel from the DOM (no leakage)', async () => {
    const scene = await bootWithKey('scout');
    expect(document.getElementById('enemy-gym-panel')).not.toBeNull();
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(document.getElementById('enemy-gym-panel')).toBeNull();
  });

  // ── Respawn + Player toggle ──────────────────────────────────

  it('renders Respawn (green) and Player toggle buttons in the panel', async () => {
    await bootWithKey('scout');
    const respawn = document.getElementById('enemy-gym-respawn') as HTMLButtonElement | null;
    const toggle = document.getElementById('enemy-gym-toggle-player') as HTMLButtonElement | null;
    expect(respawn, 'enemy-gym-respawn missing').not.toBeNull();
    expect(toggle, 'enemy-gym-toggle-player missing').not.toBeNull();
    expect(respawn!.textContent.toLowerCase()).toContain('respawn');
    expect(toggle!.textContent.toLowerCase()).toContain('player');
  });

  it('Respawn clears existing enemies and spawns a fresh formation at start', async () => {
    const scene = await bootWithKey('scout');
    const beforeIds = scene.formationEntities.slice();
    // Explode one so the formation is no longer at full strength
    findButton(scene, 'EXPLODE').emit('pointerdown');
    expect(scene.aliveCount).toBe(beforeIds.length - 1);
    (document.getElementById('enemy-gym-respawn') as HTMLButtonElement).click();
    expect(scene.aliveCount).toBe(beforeIds.length);
    expect(scene.formationEntities.length).toBe(beforeIds.length);
    // New objects, not the old instances
    for (const e of beforeIds) expect(scene.formationEntities).not.toContain(e);
    expect(scene.formationX).toBeCloseTo(scene.currentConfig.startX, 0);
    expect(scene.formationY).toBeCloseTo(scene.currentConfig.startY, 0);
  });

  it('Respawn honors live slider values (count/spacing) without requiring Save', async () => {
    const scene = await bootWithKey('scout');
    const beforeCount = scene.formationEntities.length;
    const countInput = document.querySelector<HTMLInputElement>('input[data-config="count"]')!;
    countInput.value = String(beforeCount + 2);
    countInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scene.currentConfig.count).toBe(beforeCount + 2);
    (document.getElementById('enemy-gym-respawn') as HTMLButtonElement).click();
    expect(scene.formationEntities.length).toBe(beforeCount + 2);
    expect(scene.aliveCount).toBe(beforeCount + 2);
  });

  it('Player toggle hides the player and clears its bullets; toggling again restores it', async () => {
    const scene = await bootWithKey('scout');
    expect(scene.getPlayer()).not.toBeNull();
    expect(scene.isPlayerEnabled).toBe(true);
    (document.getElementById('enemy-gym-toggle-player') as HTMLButtonElement).click();
    expect(scene.getPlayer()).toBeNull();
    expect(scene.isPlayerEnabled).toBe(false);
    expect(document.getElementById('enemy-gym-toggle-player')!.textContent!.toLowerCase()).toContain('off');
    expect(scene.getPlayerBullets().length).toBe(0);
    (document.getElementById('enemy-gym-toggle-player') as HTMLButtonElement).click();
    expect(scene.getPlayer()).not.toBeNull();
    expect(scene.isPlayerEnabled).toBe(true);
    expect(document.getElementById('enemy-gym-toggle-player')!.textContent!.toLowerCase()).toContain('on');
  });

  // ── Swarm AC3 — aimed burst hits player (AH-0MTFTJ01K000JG4I) ─────
  // Retired GymSwarm AC3 (epic AH-0MTFPDKDU006QUDC, one-off flake under
  // full-suite parallel load) preserved in the config-driven gym after
  // the 5bbaa2d GymEnemies merge. Mirrors the GymScout AC2 poll idiom
  // (commit e48b046): the swarm uses the same deterministic tick +
  // frozen scene.time.now seam as the scout. The retired single-volley
  // form relied on one burst's random spread (±0.15 rad per bullet) —
  // ~12% of volleys all-miss at full-suite load — so this contract
  // polls with bounded quarter-interval clock steps until a burst lands.
  describe('swarm — AC3 a player bullet destroys a swarm member; a swarm burst hitting the player respawns it (AH-0MTFTJ01K000JG4I)', () => {
    it('a player bullet destroys one swarm member and a subsequent aimed swarm burst hits the player (hits → respawn + invulnerability + sound)', async () => {
      const scene = await bootWithKey('swarm');
      const player = scene.getPlayer()!;
      expect(player).not.toBeNull();

      // Park a player bullet on the first swarm member — destroyed + bullet consumed.
      // Use the live world position so the overlap is deterministic (hit radius 20 + 3 = 23 px).
      const victim = scene.formationEntities[0] as unknown as {
        alive: boolean;
        bodyVisible: boolean;
        x: number;
        y: number;
      };
      expect(victim.alive).toBe(true);
      const countBefore = scene.aliveCount;
      const pb = scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
      scene.tick(0.05);
      expect(victim.alive).toBe(false);
      expect(scene.aliveCount).toBe(countBefore - 1);
      expect(victim.bodyVisible).toBe(false);
      expect(scene.getPlayerBullets()).not.toContain(pb);

      // Remaining members fire bursts aimed at the live player. Each burst
      // applies an independent random spread (±0.15 rad per bullet), so a
      // single volley can all-miss the ship entirely (measured ~12% of volleys
      // at full-suite load). Never rely on one volley's luck: poll with bounded
      // quarter-interval clock steps so the swarm re-fires fresh aimed volleys
      // until one lands (mirrors the GymScout AC2 poll idiom, commit e48b046).
      vi.spyOn(effectsModule, 'playDestructionSound');
      scene.toggleShooting();
      const hitsBefore = scene.getPlayerHitCount();
      for (let i = 0; i < 160 && scene.getPlayerHitCount() === hitsBefore; i++) {
        scene.time.now += SWARM_BURST_INTERVAL / 4;
        scene.tick(0.05);
      }

      expect(scene.getPlayerHitCount()).toBeGreaterThan(0);
      expect(player.x).toBeCloseTo(PLAYER_SPAWN.x, 5);
      expect(player.y).toBeCloseTo(PLAYER_SPAWN.y, 5);
      expect(scene.isPlayerInvulnerable()).toBe(true);
      expect(effectsModule.playDestructionSound).toHaveBeenCalled();
    });
  });

});

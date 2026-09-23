/**
 * AH-0MTHG5B83007W4W4 — Single reusable enemy gym scene (GymEnemies).
 *
 * Happy-dom boot per seed (count/spacing), corruption fallback, and
 * discoverability via the gym index glob. Wipe → 3s countdown → respawn
 * (AH-0MTFXKA5Q003LBH5) is core-library owned — smoke-tested here to prove
 * every enemyKey inherits it without per-scene code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS, ENEMY_CONFIG_STORAGE_PREFIX } from '../../core/enemyConfig';
import { PLAYER_SPAWN, POWER_UP_DROP_SIZE, SHIP_SIZE } from '../../core/constants';
import { loadRules, saveRules } from '../../core/rules';
import { GymEnemies, GYM_ENEMIES_DEFAULT_KEY, ENEMY_DIFFICULTY_ID } from './GymEnemies';
import { enemyDifficulty } from '../../core/enemyDifficulty';
import { Asteroid } from '../../entities/Asteroid';
import { TANK_COLOR } from '../../entities/Tank';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { SWARM_BURST_INTERVAL } from '../../entities/Swarm';

// GymIndex discovery helper (glob) — verify GymEnemies is listed without extra registration.
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { RoundRobinSpawner, WeightedRandomSpawner } from '../../powerups/spawner';
import { RandomAvoidingPlacement, type PowerUpPlacement } from '../../powerups/placement';
import type { DropId, PowerUpId } from '../../powerups/types';
import type { PowerUpSpawner } from '../../powerups/spawner';
import {
  createSeededRng,
  isClearOfBodies,
  stubBody,
} from '../../test/powerUpTestFixtures';

function findButton(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text && c.text === label,
  );
  expect(found, `button "${label}" not found`).toBeDefined();
  return found!;
}

// Phaser Graphics command ids (src/gameobjects/graphics/Commands.js).
const LINE_STYLE = 6;
const STROKE_PATH = 9;

/**
 * Effective body stroke colour of an enemy, read from the body Graphics
 * command buffer: the colour of the LINE_STYLE queued before the first
 * stroked path. Returns null when the body is stroked with no explicit
 * style — the pre-fix Tank bug, where the colour leaked from Phaser's
 * module-global renderer stroke tint (AH-0MTVYBL2L0085G6G).
 */
function bodyStrokeColor(entity: Phaser.GameObjects.GameObject): number | null {
  const children =
    (entity as unknown as { list?: Phaser.GameObjects.GameObject[] }).list ?? [];
  const body = children.find(
    (c): c is Phaser.GameObjects.Graphics =>
      c instanceof Phaser.GameObjects.Graphics && c.commandBuffer.includes(STROKE_PATH),
  );
  if (!body) return null;
  const buf = body.commandBuffer as number[];
  const firstStroke = buf.indexOf(STROKE_PATH);
  for (let i = firstStroke - 1; i >= 0; i--) {
    if (buf[i] === LINE_STYLE) return buf[i + 2];
  }
  return null;
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

    // The roaming Asteroid is a non-formation enemy: its position is driven
    // by its own constant-velocity updatePosition (straight-line drift +
    // wrap + rotation), not by a formation slot. It still spawns near its
    // configured start with a small boot-delay drift budget.
    if (key === 'asteroid') {
      const e = scene.formationEntities[0];
      expect(Math.abs(e.x - cfg.startX)).toBeLessThan(40);
      expect(Math.abs(e.y - cfg.startY)).toBeLessThan(40);
      return;
    }

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

  it('EXPLODE reduces aliveCount and is harmless when empty (wipe → countdown starts on next tick)', async () => {
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

  // ── Wipe → 3s countdown → respawn smoke (AH-0MTFXKA5Q003LBH5) ─
  // Core-library owned in GymFormationScene — one parameterized smoke across
  // every enemyKey proves the inheritance with no per-scene duplication.
  it.each(Object.keys(DEFAULT_ENEMY_CONFIGS))(
    'wipe → 3s countdown → respawn inherited for seed "%s" (no per-scene code)',
    async (key) => {
      const scene = await bootWithKey(key);
      const count = scene.formationEntities.length;
      expect(scene.isRespawnCountdownActive()).toBe(false);

      // Destroy every enemy (1 HP each).
      for (const e of scene.formationEntities) e.destroySelf();
      expect(scene.aliveCount).toBe(0);

      // Countdown starts on the next tick, visible centred text.
      scene.tick(0.016);
      expect(scene.isRespawnCountdownActive()).toBe(true);
      expect(scene.getRespawnCountdownText()).not.toBeNull();
      expect(scene.getRespawnCountdownText()!.visible).toBe(true);
      expect(scene.getRespawnCountdownText()!.text).toMatch(/Respawning in 3/);

      // Fast-forward exactly 3 s → formation respawns, countdown hidden.
      const spawnSound = vi.spyOn(effectsModule, 'playSpawnSound');
      const callsBefore = spawnSound.mock.calls.length;
      scene.tick(1.0);
      scene.tick(1.0);
      scene.tick(1.0);
      expect(scene.isRespawnCountdownActive()).toBe(false);
      expect(scene.aliveCount).toBe(count);
      expect(scene.formationEntities.every((e) => e.alive)).toBe(true);
      expect(scene.getRespawnCountdownText()!.visible).toBe(false);
      expect(spawnSound.mock.calls.length).toBeGreaterThan(callsBefore);
    },
  );

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

  // ── Live difficulty readout (AH-0MTZWZ7MC002B01K, AC5) ─────────

  it('renders a live difficulty readout matching the library score for the active config', async () => {
    const scene = await bootWithKey('scout');
    const el = document.getElementById(ENEMY_DIFFICULTY_ID);
    expect(el, 'difficulty readout missing').not.toBeNull();
    const expected = enemyDifficulty(scene.currentConfig).score.toFixed(1);
    expect(el!.textContent).toBe(`${expected} / 100`);
  });

  it('updates the difficulty readout when a slider changes the archetype', async () => {
    const scene = await bootWithKey('scout');
    const el = document.getElementById(ENEMY_DIFFICULTY_ID)!;
    const before = el.textContent ?? '';

    // Raising driftSpeed (a difficulty factor) must update the readout and
    // must not decrease the computed score.
    const input = document.querySelector<HTMLInputElement>('input[data-config="driftSpeed"]')!;
    input.value = '200';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const after = el.textContent ?? '';
    expect(after).not.toBe(before);
    expect(after).toBe(`${enemyDifficulty(scene.currentConfig).score.toFixed(1)} / 100`);
  });

  it('updates the difficulty readout when the shot pattern select changes', async () => {
    const scene = await bootWithKey('scout');
    const el = document.getElementById(ENEMY_DIFFICULTY_ID)!;
    const before = el.textContent ?? '';

    const select = document.querySelector<HTMLSelectElement>('select[data-config="shotPattern"]')!;
    select.value = 'radial';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(el.textContent).not.toBe(before);
    expect(el.textContent).toBe(`${enemyDifficulty(scene.currentConfig).score.toFixed(1)} / 100`);
  });

  // ── shotProbability slider (AH-0MU0F1T2H003B4K0, AC6) ──────────

  it('renders a shotProbability slider immediately after fireInterval with a 0–1 fraction range', async () => {
    await bootWithKey('scout');
    const panel = document.getElementById('enemy-gym-panel')!;
    const slider = panel.querySelector<HTMLInputElement>('input[data-config="shotProbability"]');
    expect(slider, 'shotProbability slider missing').not.toBeNull();
    expect(slider!.min).toBe('0');
    expect(slider!.max).toBe('1');
    expect(Number(slider!.step)).toBe(0.05);

    // DOM order: fireInterval then shotProbability then bulletSpeed.
    const configInputs = [...panel.querySelectorAll<HTMLInputElement>('input[data-config]')]
      .map((el) => el.dataset['config']);
    expect(configInputs.indexOf('shotProbability')).toBe(configInputs.indexOf('fireInterval') + 1);
  });

  it('seeds the shotProbability slider from the active config (swarm 0.25, others 1.0)', async () => {
    await bootWithKey('swarm');
    const swarmSlider = document.querySelector<HTMLInputElement>('input[data-config="shotProbability"]')!;
    expect(Number(swarmSlider.value)).toBe(0.25);

    // Tear the swarm boot down before booting the scout harness.
    booted?.game.destroy(true);
    booted = null;

    const scene = await bootWithKey('scout');
    expect(scene.currentConfig.shotProbability).toBe(1.0);
    const scoutSlider = document.querySelector<HTMLInputElement>('input[data-config="shotProbability"]')!;
    expect(Number(scoutSlider.value)).toBe(1.0);
  });

  it('live-applies shotProbability to the spawned entities without a respawn', async () => {
    const scene = await bootWithKey('swarm');
    const slider = document.querySelector<HTMLInputElement>('input[data-config="shotProbability"]')!;
    slider.value = '0.05';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scene.currentConfig.shotProbability).toBe(0.05);
    for (const e of scene.formationEntities) {
      expect((e as unknown as { _shotProbability: number })._shotProbability).toBe(0.05);
    }
  });

  it('Save round-trips shotProbability through localStorage', async () => {
    const { loadEnemyConfig: lec } = await import('../../core/enemyConfig');
    const scene = await bootWithKey('swarm');
    const slider = document.querySelector<HTMLInputElement>('input[data-config="shotProbability"]')!;
    slider.value = '0.3';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    (document.getElementById('enemy-gym-save') as HTMLButtonElement).click();
    expect(scene.currentConfig.shotProbability).toBe(0.3);
    expect(lec('swarm').shotProbability).toBeCloseTo(0.3, 5);
  });

  it('Save As round-trips shotProbability into the new custom enemy', async () => {
    const { loadEnemyConfig: lec } = await import('../../core/enemyConfig');
    await bootWithKey('scout');
    const slider = document.querySelector<HTMLInputElement>('input[data-config="shotProbability"]')!;
    slider.value = '0.45';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    (document.getElementById('enemy-gym-save-as-input') as HTMLInputElement).value = 'Prob Enemy';
    (document.getElementById('enemy-gym-save-as') as HTMLButtonElement).click();
    expect(lec('prob-enemy').shotProbability).toBeCloseTo(0.45, 5);
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

  // ── Tank body colour invariance (AH-0MTVYBL2L0085G6G) ────────────
  // The first-rendered tank used to inherit Phaser's module-global
  // leftover stroke tint (its explicit lineStyle was wiped by clear()),
  // so its colour changed with thrust input and the "wrong" tank moved
  // to the next alive one on destruction. These assertions read the actual
  // queued stroke from the body Graphics command buffer.
  describe('tank body colour is invariant to thrust input and destruction order (AH-0MTVYBL2L0085G6G)', () => {
    it('AC1/AC2/AC3 — every alive tank keeps TANK_COLOR across thrust frames and after destroying the first alive tank', async () => {
      const scene = await bootWithKey('tank');
      const expected = DEFAULT_ENEMY_CONFIGS.tank.color;
      expect(expected).toBe(TANK_COLOR);

      const assertAllAliveAreTankColoured = () => {
        for (const e of scene.formationEntities) {
          if (!e.alive) continue;
          expect(bodyStrokeColor(e)).toBe(expected);
        }
      };

      // AC1 — all alive tanks carry an explicit tank stroke before any input.
      expect(scene.aliveCount).toBeGreaterThan(0);
      assertAllAliveAreTankColoured();

      // AC1 — hold thrust (both control schemes receive the same key map;
      // arrows are the canonical bindings here) and advance frames. The
      // player's flame redraw is exactly what used to perturb the first
      // tank's inherited stroke tint. The tank stroke must not move.
      const cursors = scene.getCursors()!;
      expect(cursors).toBeDefined();
      cursors.right.isDown = true;
      for (let i = 0; i < 10; i++) {
        scene.tick(1 / 60);
        assertAllAliveAreTankColoured();
      }
      cursors.right.isDown = false;
      for (let i = 0; i < 10; i++) {
        scene.tick(1 / 60);
        assertAllAliveAreTankColoured();
      }

      // AC2 — destroying the first alive tank (top-left, row-major spawn
      // order) must not hand a stale colour to the next alive tank. Repeat
      // for the next two alive in spawn order.
      for (let n = 0; n < 3; n++) {
        const victim = scene.formationEntities.find((e) => e.alive);
        if (!victim) break;
        victim.destroySelf();
        expect(victim.alive).toBe(false);
        scene.tick(1 / 60);
        expect(scene.aliveCount).toBeGreaterThan(0);
        assertAllAliveAreTankColoured();
      }
    });
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

  describe('stop/restart of the SAME registered instance — gym-index vector (AH-0MTPLHLZ3006MOC4)', () => {
    it('AC1/AC2 — repeated scene.start across enemy keys never crashes and never doubles entities', async () => {
      // Boot the real registered GymEnemies instance (no per-key wrapper).
      booted = await bootScene([GymEnemies]);
      const manager = booted.game.scene;
      const sameInstance = booted.scene as GymEnemies;
      expect(sameInstance.activeEnemyKey).toBe(GYM_ENEMIES_DEFAULT_KEY);

      // Cycle through several enemy keys via the real scene manager — the
      // exact gym-index restart vector (scene.start on the same registered
      // key stops + restarts the SAME instance).  Before the fix, each
      // restart pushed a fresh formation on top of the stale destroyed
      // entities from the previous run, so tick() dereferenced their
      // undefined `scene` and crashed.
      const cycle = ['tank', 'swarm', 'diver', 'phaser', 'scout'];
      for (const key of cycle) {
        expect(() => manager.start('GymEnemies', { enemyKey: key })).not.toThrow();

        const scene = manager.getScene('GymEnemies') as GymEnemies;
        // The restart must reuse the SAME scene instance (the leak vector).
        expect(scene).toBe(sameInstance);
        expect(scene.activeEnemyKey).toBe(key);
        // AC2 — exactly the freshly spawned count: no leftover references
        // from the previous run (no doubling), all alive.
        const expected = DEFAULT_ENEMY_CONFIGS[key].count;
        expect(scene.formationEntities.length).toBe(expected);
        expect(scene.aliveCount).toBe(expected);
        // AC1 — the restarted scene ticks without touching stale entities.
        expect(() => scene.tick(0.016)).not.toThrow();
        expect(scene.aliveCount).toBe(expected);
      }
    });
  });

  // ── AC1: count slider max (AH-0MTV8Q1LV001KOA5) ──────────────────

  it('AC1 — count slider max is 200', async () => {
    await bootWithKey('scout');
    const countInput = document.querySelector<HTMLInputElement>(
      'input[data-config="count"]',
    )!;
    expect(countInput.max).toBe('200');
    expect(countInput.min).toBe('1');
    expect(countInput.step).toBe('1');
  });
});

describe('GymEnemies — power-up spawning layer (AH-0MU44M9CA007GBTZ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  const INTERVAL = 15;

  /** Boots GymEnemies with a deterministic, short-interval power-up layer. */
  function makeScene(enemyKey: string): typeof Phaser.Scene {
    class PowerUpGymEnemies extends GymEnemies {
      override init(): void {
        super.init({ enemyKey });
        this.config.powerUps = {
          spawner: new RoundRobinSpawner<PowerUpId>(['P3', 'P4', 'P6', 'P7']),
          placement: new RandomAvoidingPlacement({ rng: createSeededRng(1) }),
          spawnInterval: INTERVAL,
        };
      }
    }
    Object.defineProperty(PowerUpGymEnemies, 'name', {
      value: `PowerUpGymEnemies_${enemyKey}`,
    });
    return PowerUpGymEnemies as unknown as typeof Phaser.Scene;
  }

  /** Asserts the current drop is clear of every live enemy and the player. */
  function expectDropClear(scene: GymEnemies): void {
    const drop = scene.getPowerUpDrops()[0];
    expect(drop).toBeDefined();
    const bodies = scene.formationEntities
      .filter((enemy) => enemy.alive)
      .map((enemy) => stubBody(enemy.x, enemy.y, enemy.getHitRadius()));
    const player = scene.getPlayer();
    if (player) bodies.push(stubBody(player.x, player.y, SHIP_SIZE / 2));
    expect(
      isClearOfBodies(stubBody(drop.x, drop.y, POWER_UP_DROP_SIZE), bodies),
    ).toBe(true);
  }

  it('AC1/AC3 — spawns one drop at a time and avoids enemies/player (scout)', async () => {
    booted = await bootScene([makeScene(GYM_ENEMIES_DEFAULT_KEY)]);
    const scene = booted.scene as unknown as GymEnemies;

    expect(scene.isPowerUpLayerEnabled()).toBe(true);
    expect(scene.getPowerUpSpawnCount()).toBe(1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      scene.tick(INTERVAL);
      expect(scene.getPowerUpDrops()).toHaveLength(1);
      expectDropClear(scene);
    }
  });

  it.each(Object.keys(DEFAULT_ENEMY_CONFIGS))(
    'AC1/AC3 — spawns and avoids overlap for every archetype ("%s")',
    async (key) => {
      booted = await bootScene([makeScene(key)]);
      const scene = booted.scene as unknown as GymEnemies;

      expect(scene.isPowerUpLayerEnabled()).toBe(true);
      scene.tick(INTERVAL);
      expectDropClear(scene);
    },
  );
});

describe('GymEnemies — weapon drops (AH-0MU3VOQKH005YOBH)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots GymEnemies whose spawner yields weapon drops (at the player). */
  function makeWeaponScene(
    enemyKey: string,
    spawner: PowerUpSpawner<DropId>,
    placementPowerUps: PowerUpPlacement = {
      place: (context) => ({ x: context.player.x, y: context.player.y }),
    },
  ): typeof Phaser.Scene {
    class WeaponGymEnemies extends GymEnemies {
      override init(): void {
        super.init({ enemyKey });
        this.config.powerUps = {
          spawner,
          placement: placementPowerUps,
          spawnInterval: 1000,
        };
      }
    }
    Object.defineProperty(WeaponGymEnemies, 'name', {
      value: `WeaponGymEnemies_${enemyKey}`,
    });
    return WeaponGymEnemies as unknown as typeof Phaser.Scene;
  }

  it('AC4 — a weapon drop is collectible and equips the weapon in the registry', async () => {
    booted = await bootScene([
      makeWeaponScene(
        GYM_ENEMIES_DEFAULT_KEY,
        new WeightedRandomSpawner<DropId>(['rapid'], createSeededRng(1)),
      ),
    ]);
    const scene = booted.scene as unknown as GymEnemies;

    // The boot loop advances the drop past the 3% threshold, so the
    // 'rapid' drop spawned on the ship is collected and equipped.
    expect(scene.getEffectsRegistry().hasWeapon('rapid')).toBe(true);
    expect(scene.getPowerUpDrops()).toHaveLength(0);
  });

  it.each(Object.keys(DEFAULT_ENEMY_CONFIGS))(
    'AC3 — spawns a weapon drop avoiding enemies for archetype "%s"',
    async (key) => {
      booted = await bootScene([
        makeWeaponScene(
          key,
          new WeightedRandomSpawner<DropId>(
            ['spread', 'dual', 'rapid'],
            createSeededRng(2),
          ),
          // Place away from the player so the drop survives to be asserted.
          new RandomAvoidingPlacement({ rng: createSeededRng(3) }),
        ),
      ]);
      const scene = booted.scene as unknown as GymEnemies;

      const drop = scene.getPowerUpDrops()[0];
      expect(drop).toBeDefined();
      expect(drop.weaponDropId).toBeDefined();
      const bodies = scene.formationEntities
        .filter((enemy) => enemy.alive)
        .map((enemy) => stubBody(enemy.x, enemy.y, enemy.getHitRadius()));
      const player = scene.getPlayer();
      if (player) bodies.push(stubBody(player.x, player.y, SHIP_SIZE / 2));
      expect(
        isClearOfBodies(stubBody(drop.x, drop.y, POWER_UP_DROP_SIZE), bodies),
      ).toBe(true);
    },
  );

  it('AC4 — the Reset drop clears equipped weapons', async () => {
    booted = await bootScene([
      makeWeaponScene(
        GYM_ENEMIES_DEFAULT_KEY,
        new WeightedRandomSpawner<DropId>(['spread'], createSeededRng(1)),
      ),
    ]);
    const scene = booted.scene as unknown as GymEnemies;
    const registry = scene.getEffectsRegistry();
    const player = scene.getPlayer()!;

    scene.spawnPowerUpDrop('spread', player.x, player.y);
    scene.spawnPowerUpDrop('dual', player.x, player.y);
    scene.tick(0.1);
    expect(registry.activeWeapons()).toHaveLength(2);

    scene.spawnPowerUpDrop('reset', player.x, player.y);
    scene.tick(0.1);
    expect(registry.activeWeapons()).toHaveLength(0);
  });
});

describe('GymEnemies — power-up collection and HUD (AH-0MU44M9NQ0006613)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots GymEnemies whose first drop lands on the ship and is a P8. */
  function makeCollectScene(enemyKey: string): typeof Phaser.Scene {
    const atPlayer: PowerUpPlacement = {
      place: (context) => ({ x: context.player.x, y: context.player.y }),
    };
    class CollectGymEnemies extends GymEnemies {
      override init(): void {
        super.init({ enemyKey });
        this.config.powerUps = {
          spawner: new RoundRobinSpawner<PowerUpId>(['P8']),
          placement: atPlayer,
          spawnInterval: 1000,
        };
      }
    }
    Object.defineProperty(CollectGymEnemies, 'name', {
      value: `CollectGymEnemies_${enemyKey}`,
    });
    return CollectGymEnemies as unknown as typeof Phaser.Scene;
  }

  it('AC2/AC5 — a drop collected on the ship applies its effect and the HUD renders', async () => {
    booted = await bootScene([makeCollectScene(GYM_ENEMIES_DEFAULT_KEY)]);
    const scene = booted.scene as unknown as GymEnemies;

    // The boot loop advances the drop past the 3% threshold, so the P8
    // spawned on the ship is collected: lives go 3 → 4 and the HUD is shown.
    expect(scene.getHUD()).not.toBeNull();
    expect(scene.getEffectsRegistry().lives()).toBe(4);
    expect(scene.getPowerUpDrops()).toHaveLength(0);
  });
});

describe('GymEnemies — live spawn-interval control (AH-0MU44M9Z0007ZGPI)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.getElementById('enemy-gym-panel')?.remove();
  });

  function getSlider(): HTMLInputElement {
    const slider = document.querySelector<HTMLInputElement>(
      '#power-up-spawn-interval',
    );
    expect(slider, 'spawn-interval slider missing').not.toBeNull();
    return slider!;
  }

  it('AC1/AC3 — slider is present and seeded from the rules config', async () => {
    saveRules({ ...loadRules(), powerUpSpawnInterval: 7 });

    booted = await bootScene([GymEnemies]);
    const scene = booted.scene as GymEnemies;

    expect(getSlider().value).toBe('7');
    expect(scene.getPowerUpSpawnInterval()).toBe(7);
  });

  it('AC2/AC4 — changing the slider applies live and persists across a reboot', async () => {
    booted = await bootScene([GymEnemies]);
    const scene = booted.scene as GymEnemies;

    const slider = getSlider();
    slider.value = '4';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(scene.getPowerUpSpawnInterval()).toBe(4);
    expect(loadRules().powerUpSpawnInterval).toBe(4);

    // Reboot the scene: the value is restored from the rules config.
    booted.game.destroy(true);
    booted = null;
    booted = await bootScene([GymEnemies]);
    const rested = booted.scene as GymEnemies;

    expect(rested.getPowerUpSpawnInterval()).toBe(4);
    expect(getSlider().value).toBe('4');
  });

  it('AC5 — SHUTDOWN removes the spawn-interval panel from the DOM', async () => {
    booted = await bootScene([GymEnemies]);
    const scene = booted.scene as GymEnemies;

    expect(document.getElementById('enemy-gym-panel')).not.toBeNull();
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(document.getElementById('enemy-gym-panel')).toBeNull();
  });
});

describe('GymEnemies — asteroid support (AH-0MU8BZ2ZM004J47F)', () => {
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
  });

  async function bootAsteroidGym(): Promise<GymEnemies> {
    const key = 'asteroid';
    class Wrapper extends GymEnemies {
      override init(_data?: { enemyKey?: string }): void {
        super.init({ enemyKey: key });
      }
    }
    Object.defineProperty(Wrapper, 'name', { value: 'Wrapper_asteroid_gym_test' });
    booted = await bootScene([Wrapper as unknown as typeof Phaser.Scene]);
    return booted.scene as unknown as GymEnemies;
  }

  function liveAsteroids(scene: GymEnemies): Asteroid[] {
    return scene.formationEntities.filter(
      (e): e is Asteroid => e instanceof Asteroid && e.alive,
    );
  }

  it('asteroid is selectable in the gym — spawns as a large tier enemy', async () => {
    const scene = await bootAsteroidGym();

    const asteroids = liveAsteroids(scene);
    expect(asteroids.length).toBe(1);
    expect(asteroids[0].getSizeTier()).toBe('large');
    expect(asteroids[0].alive).toBe(true);
    expect(scene.activeEnemyKey).toBe('asteroid');
  });

  it('asteroid renders correctly — procedural neon grey body visible', async () => {
    const scene = await bootAsteroidGym();
    const asteroid = liveAsteroids(scene)[0];

    // The body is drawn (a stroked path) and tinted with the grey palette.
    expect(bodyStrokeColor(asteroid as unknown as Phaser.GameObjects.GameObject)).toBe(0x888888);
  });

  it('asteroids rotate and drift independently in the gym (no formation drift)', async () => {
    const scene = await bootAsteroidGym();
    const asteroid = liveAsteroids(scene)[0];
    const startX = asteroid.x;
    const startY = asteroid.y;
    const vx = asteroid.vx;
    const vy = asteroid.vy;
    const rotBefore = asteroid.rotation;

    scene.tick(0.5);

    expect(asteroid.alive).toBe(true);
    // Independent straight-line constant velocity — NOT formation drift
    // (the asteroid config's driftSpeed is 0, so baseX never moves).
    expect(asteroid.x - startX).toBeCloseTo(vx * 0.5, 4);
    expect(asteroid.y - startY).toBeCloseTo(vy * 0.5, 4);
    // Continuous rotation is applied.
    expect(asteroid.rotation - rotBefore).toBeCloseTo(asteroid.rotationSpeed * 0.5, 3);
  });

  it('EXPLODE on the large asteroid spawns exactly 2 medium children (split chain)', async () => {
    const scene = await bootAsteroidGym();
    expect(scene.aliveCount).toBe(1);

    // Explode the (only) large asteroid.
    scene.explodeRandom();
    let asteroids = liveAsteroids(scene);
    expect(scene.aliveCount).toBe(2);
    expect(asteroids.length).toBe(2);
    expect(asteroids.every((a) => a.getSizeTier() === 'medium')).toBe(true);

    // Child directions differ from each other by >= pi/3.
    const a1 = Math.atan2(asteroids[0].vy, asteroids[0].vx);
    const a2 = Math.atan2(asteroids[1].vy, asteroids[1].vx);
    const delta = Math.abs(a1 - a2);
    const wrapped = Math.min(delta, Math.PI * 2 - delta);
    expect(wrapped).toBeGreaterThanOrEqual(Math.PI / 3 - 0.01);

    // Explode until the whole chain is cleared (2 mediums -> 4 smalls) —
    // the wipe only starts once EVERY split child is destroyed.
    let guard = 0;
    while (scene.aliveCount > 0 && guard++ < 20) {
      scene.explodeRandom();
    }
    expect(scene.aliveCount).toBe(0);
    expect(guard).toBeLessThanOrEqual(7); // 1 large + 2 medium + 4 small = 7 detonations
    // Wipe -> respawn countdown starts on the next tick, then 3 s later a
    // fresh large asteroid returns (mirrors the core wipe idiom above).
    scene.tick(0.016);
    expect(scene.isRespawnCountdownActive()).toBe(true);
    scene.tick(3.5);
    const respawned = liveAsteroids(scene);
    expect(respawned.length).toBe(1);
    expect(respawned[0].getSizeTier()).toBe('large');
  });

  it('a player bullet destroying the asteroid spawns split children', async () => {
    const scene = await bootAsteroidGym();
    const asteroid = liveAsteroids(scene)[0];

    const pb = scene.spawnPlayerBullet(asteroid.x, asteroid.y, 0, 0);
    scene.tick(0.05);

    // Bullet consumed, parent destroyed, 2 medium children take its place.
    expect(asteroid.alive).toBe(false);
    expect(scene.getPlayerBullets()).not.toContain(pb);
    const children = liveAsteroids(scene);
    expect(children.length).toBe(2);
    expect(children.every((c) => c.getSizeTier() === 'medium')).toBe(true);

    // Split again via bullet on one medium -> 2 smalls.
    const medium = children[0];
    scene.spawnPlayerBullet(medium.x, medium.y, 0, 0);
    scene.tick(0.05);
    const afterMedium = liveAsteroids(scene);
    expect(
      afterMedium.filter((a) => a.getSizeTier() === 'small').length,
    ).toBe(2);
    expect(
      afterMedium.filter((a) => a.getSizeTier() === 'medium').length,
    ).toBe(1);
  });

  it('asteroids never fire in the gym even when SHOOT is toggled on', async () => {
    const scene = await bootAsteroidGym();
    const before = scene.activeBullets.length;

    scene.toggleShooting(); // SHOOT: ON
    for (let i = 0; i < 5; i++) scene.tick(0.1);

    // No enemy bullets ever produced; the toggle cannot arm asteroids.
    expect(scene.activeBullets.length).toBe(before);
    for (const asteroid of liveAsteroids(scene)) {
      expect(asteroid.shootEnabled).toBe(false);
    }
  });
});

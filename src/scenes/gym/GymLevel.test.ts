/**
 * AH-0MUNU6MGM007CI45 — Dedicated Level Gym scene.
 *
 * Covers the launch contract from the difficulty-curve editor: sequential
 * wave playback (`level mode`), single-wave playback (`wave mode`), the
 * spread + dual starting weapons, the level-name HUD, and the standard
 * back-to-index / ESC-to-menu navigation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../../utils/gymNavigation';
import { GymIndex } from '../GymIndex';
import { MenuScene } from '../MenuScene';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import { sequenceVariedWaves } from './GymCurveSequencer';
import {
  GYM_LEVEL_DEFAULT_LABEL,
  GymLevel,
  type GymLevelData,
} from './GymLevel';

/** Waits for Phaser scene transitions to settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Finds an on-screen text by exact label. */
function findText(
  scene: Phaser.Scene,
  label: string,
): Phaser.GameObjects.Text | undefined {
  return scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
}

/** A single-group, non-firing wave with `count` scouts. */
function scoutWave(count: number): WaveDefinition {
  return {
    groups: [
      {
        enemyKey: 'scout',
        formation: 'v',
        count,
        spacingX: 30,
        spacingY: 26,
        startX: 200,
        startY: 150,
      },
    ],
    shootEnabled: false,
  };
}

/** Wraps waves in a level definition for the launch contract. */
function makeLevel(name: string, waves: WaveDefinition[]): LevelDefinition {
  return { level: 1, name, waves };
}

describe('GymLevel — generated level gym scene (AC3/AC4/AC5)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  /** Boots the scene and restarts it with launch data. */
  async function bootWith(
    data: GymLevelData,
    extraScenes: (typeof Phaser.Scene)[] = [],
  ): Promise<GymLevel> {
    booted = await bootScene([GymLevel, ...extraScenes]);
    const manager = booted.game.scene;
    manager.start('GymLevel', data);
    await tick();
    return manager.getScene('GymLevel') as GymLevel;
  }

  // ── AC3 — sequential wave playback ───────────────────────────────

  it('AC3 — level mode queues every wave and starts on the first', async () => {
    const scene = await bootWith({
      level: makeLevel('Test Level', [scoutWave(2), scoutWave(3)]),
    });

    expect(scene.getWavesToPlayCount()).toBe(2);
    expect(scene.getCurrentWaveIndex()).toBe(0);
    expect(scene.isLevelComplete()).toBe(false);
    // First wave spawned exactly its declared count.
    expect(scene.getEnemies()).toHaveLength(2);
    expect(scene.getEnemies().every((e) => e.alive)).toBe(true);
  });

  it('AC3 — clearing a wave advances to the next without leftovers', async () => {
    const scene = await bootWith({
      level: makeLevel('Test Level', [scoutWave(2), scoutWave(3)]),
    });

    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);

    expect(scene.getCurrentWaveIndex()).toBe(1);
    expect(scene.isLevelComplete()).toBe(false);
    // Exactly the second wave's enemies are live (no leftovers).
    expect(scene.getEnemies()).toHaveLength(3);
    expect(scene.getEnemies().every((e) => e.alive)).toBe(true);
  });

  it('AC3 — clearing the final wave completes the level and clears the field', async () => {
    const scene = await bootWith({
      level: makeLevel('Test Level', [scoutWave(2), scoutWave(3)]),
    });

    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);
    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);

    expect(scene.isLevelComplete()).toBe(true);
    expect(scene.getEnemies()).toHaveLength(0);
  });

  it('AC3 — wave mode plays exactly one wave then completes', async () => {
    const scene = await bootWith({
      level: makeLevel('Wave 1', [scoutWave(4)]),
    });

    expect(scene.getWavesToPlayCount()).toBe(1);
    expect(scene.getEnemies()).toHaveLength(4);

    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);

    expect(scene.isLevelComplete()).toBe(true);
    expect(scene.getWavesToPlayCount()).toBe(1);
  });

  it('AC3 — a generated level plays distinct wave compositions, not repeats', async () => {
    // Regression for the producer-audit rejection of this work item: a level
    // launched from a flat curve used to play the *same* wave three times.
    // Build the level exactly as the curve editor does, from a flat curve.
    const waves = sequenceVariedWaves([30, 30, 30]).map((wave) => ({
      groups: wave.groups.map((group) => ({
        enemyKey: group.enemyKey,
        formation: group.formation,
        count: group.count,
        spacingX: group.spacingX,
        spacingY: group.spacingY,
        startX: group.startX,
        startY: group.startY,
      })),
      shootEnabled: wave.shootEnabled,
    }));
    const scene = await bootWith({
      level: makeLevel('Varied Level', waves),
    });

    // Composition signature per wave (`Type×count`), sampled as each wave is
    // played. The contract `sequenceVariedWaves` guarantees is a *distinct
    // composition* per wave, which is stronger than "distinct type" but also
    // holds when two waves share an archetype and differ only in count (e.g.
    // after the enemy-bullet-speed halving, AH-0MUWZ5GST003NMFQ, the second
    // wave can be `Phaser×1` where the first is `Phaser×12`).
    const waveSignature = (): string => {
      const counts = new Map<string, number>();
      for (const enemy of scene.getEnemies()) {
        const name = enemy.constructor.name;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name}x${count}`)
        .join('+');
    };

    const firstWave = waveSignature();
    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);
    const secondWave = waveSignature();

    expect(scene.getWavesToPlayCount()).toBe(3);
    expect(scene.getCurrentWaveIndex()).toBe(1);
    // The second wave is not simply a repeat of the first.
    expect(secondWave).not.toBe(firstWave);
  });

  it('AC3 — an empty launch data set is safe (no crash, empty label)', async () => {
    booted = await bootScene([GymLevel]);
    const scene = booted.scene as GymLevel;
    expect(scene.getWavesToPlayCount()).toBe(0);
    expect(scene.getLabel()).toBe(GYM_LEVEL_DEFAULT_LABEL);
    expect(() => scene.tick(0.016)).not.toThrow();
  });

  // ── AC4 — starting weapons ───────────────────────────────────────

  it('AC4 — spread and dual weapons are active at scene start', async () => {
    const scene = await bootWith({ level: makeLevel('Armed', [scoutWave(1)]) });
    const ship = scene.getShip();
    expect(ship).not.toBeNull();
    expect(ship!.hasWeapon('spread')).toBe(true);
    expect(ship!.hasWeapon('dual')).toBe(true);
    expect(ship!.getActiveWeapons()).toEqual(
      expect.arrayContaining(['spread', 'dual']),
    );
  });

  // ── Producer audit fix — player input + audio parity ────────────

  it('binds arrow/WASD keys so the player ship can move (gym parity)', async () => {
    const scene = await bootWith({ level: makeLevel('Move', [scoutWave(1)]) });
    const ship = scene.getShip();
    expect(ship).not.toBeNull();

    // Every player-bearing gym binds both key sets. Without them the shared
    // `_readPlayerInput()` returns null and the ship is frozen — the
    // regression raised in the producer audit.
    expect(scene.getCursors(), 'arrow keys not bound').toBeDefined();
    expect(scene.getWasd(), 'WASD keys not bound').toBeDefined();

    // Hold the right arrow in four-directional mode and step one frame.
    ship!.setScheme('fourDirectional');
    scene.getCursors()!.right.isDown = true;
    const beforeX = ship!.x;
    scene.update(0, 1000);
    scene.getCursors()!.right.isDown = false;

    expect(ship!.x).toBeGreaterThan(beforeX);
  });

  it('plays the shared spawn sound for each launched wave (gym parity)', async () => {
    const spawnSound = vi.spyOn(effectsModule, 'playSpawnSound');
    booted = await bootScene([GymLevel]);
    spawnSound.mockClear();

    booted.game.scene.start('GymLevel', {
      level: makeLevel('Audio', [scoutWave(1), scoutWave(1)]),
    });
    await tick();
    const scene = booted.game.scene.getScene('GymLevel') as GymLevel;

    // One spawn cue for the first wave.
    expect(spawnSound).toHaveBeenCalledTimes(1);

    // Clearing the first wave spawns the second and plays the cue again.
    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);
    expect(spawnSound).toHaveBeenCalledTimes(2);
  });

  // ── AC5 — HUD + navigation ───────────────────────────────────────

  it('AC5 — the HUD shows the level name and wave progress', async () => {
    const scene = await bootWith({
      level: makeLevel('Entry', [scoutWave(1), scoutWave(1)]),
    });
    expect(
      findText(scene, 'Entry — Wave 1/2'),
      'level-name HUD text missing',
    ).toBeDefined();

    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);
    expect(findText(scene, 'Entry — Wave 2/2')).toBeDefined();
  });

  it('AC5 — the ← INDEX button returns to the gym index', async () => {
    const scene = await bootWith({ level: makeLevel('Nav', [scoutWave(1)]) }, [GymIndex]);
    expect(booted!.game.scene.isActive(GYM_INDEX_KEY)).toBe(false);

    const button = findText(scene, BACK_TO_INDEX_LABEL);
    expect(button, 'back-to-index button missing').toBeDefined();
    button!.emit('pointerdown');
    await tick();

    expect(booted!.game.scene.isActive(GYM_INDEX_KEY)).toBe(true);
  });

  it('AC5 — ESC returns to the main menu', async () => {
    const scene = await bootWith({ level: makeLevel('Nav', [scoutWave(1)]) }, [MenuScene]);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(scene.sys.isActive()).toBe(false);
  });
});

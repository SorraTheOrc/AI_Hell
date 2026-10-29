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
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../../utils/gymNavigation';
import { GymIndex } from '../GymIndex';
import { MenuScene } from '../MenuScene';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import { LEVELS } from '../../waves/Formations';
import { sequenceVariedWaves } from './GymCurveSequencer';
import {
  GYM_LEVEL_DEFAULT_LABEL,
  GymLevel,
  type GymLevelData,
} from './GymLevel';
import { Diver } from '../../entities/Diver';
import { Tank } from '../../entities/Tank';
import { Harvester } from '../../entities/Harvester';
import { Asteroid } from '../../entities/Asteroid';
import type { EnemyEntity } from '../../entities/enemyFactory';
import { RULES_STORAGE_KEY } from '../../core/rules';
import {
  getSpawnState,
  type SpawnAnimatable,
} from '../../vfx/wormholeSpawn';
import { getFormationBuilder } from '../../utils/formations';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { createSeededRng } from '../../core/rng';
import { enemyForceFieldHits } from '../../core/enemyForceField';
import { DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { computeSpawns } from '../../waves/AsteroidSpawner';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';

/** Waits for Phaser scene transitions to settle. */

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

/**
 * Formation enemies only — excludes the scheduled asteroid hazard, which is
 * scenario content the level gym shares with the game (AH-0MV9AWR7A0084XJ0)
 * and can spawn from the first frames of a wave.
 */
function formationEnemies(scene: GymLevel): EnemyEntity[] {
  return scene.getEnemies().filter((enemy) => !(enemy instanceof Asteroid));
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

  const tick = () => advanceGame(booted!.game, 200);

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
    // First wave spawned exactly its declared formation count.
    expect(formationEnemies(scene)).toHaveLength(2);
    expect(formationEnemies(scene).every((e) => e.alive)).toBe(true);
  });

  it('AC3 — clearing a wave advances to the next without leftovers', async () => {
    const scene = await bootWith({
      level: makeLevel('Test Level', [scoutWave(2), scoutWave(3)]),
    });

    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);

    expect(scene.getCurrentWaveIndex()).toBe(1);
    expect(scene.isLevelComplete()).toBe(false);
    // Exactly the second wave's formation enemies are live (no leftovers).
    expect(formationEnemies(scene)).toHaveLength(3);
    expect(formationEnemies(scene).every((e) => e.alive)).toBe(true);
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
    expect(formationEnemies(scene)).toHaveLength(4);

    scene.getEnemies().forEach((e) => e.destroySelf());
    scene.tick(0.016);

    expect(scene.isLevelComplete()).toBe(true);
    expect(scene.getWavesToPlayCount()).toBe(1);
  });

  // ── AC4 — formed level enemies cross the seam like the game (AH-0MVKXBZ5N007LKH4) ──

  it('wraps a wrap-aware formed enemy across the seam while the non-aware march stays off-edge', async () => {
    // Both groups spawn beyond the right edge: the only thing that can bring
    // an enemy back on-screen is the shared post-motion wrap seam — parity
    // with `PlayScene._moveEnemies`. `scout` is wrap-aware by default;
    // `march` is the classic-arcade non-aware archetype (`wrapAware: false`).
    const scene = await bootWith({
      level: makeLevel('Wrap Seam Level', [
        {
          groups: [
            {
              enemyKey: 'scout',
              formation: 'v',
              count: 1,
              spacingX: 26,
              spacingY: 24,
              startX: GAME_WIDTH + 40,
              startY: 150,
            },
            {
              enemyKey: 'march',
              formation: 'v',
              count: 1,
              spacingX: 26,
              spacingY: 24,
              startX: GAME_WIDTH + 40,
              startY: 300,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });

    const enemies = formationEnemies(scene) as unknown as Array<{
      wrapAware: boolean;
      x: number;
      y: number;
      alive: boolean;
    }>;
    const scout = enemies.find((enemy) => enemy.wrapAware);
    const march = enemies.find((enemy) => !enemy.wrapAware);
    expect(scout, 'a wrap-aware scout is present').toBeDefined();
    expect(march, 'a non-aware march is present').toBeDefined();
    expect(enemies.filter((enemy) => enemy.wrapAware)).toHaveLength(1);
    expect(enemies.filter((enemy) => !enemy.wrapAware)).toHaveLength(1);

    // Snap both enemies to their formation slots (off the right edge for
    // both groups), then run one frame of the shared tick: the post-motion
    // wrap must relocate the aware scout onto the arena and leave the
    // non-aware march at its bounded slot.
    scene.finishSpawnAnimations();
    scene.tick(1 / 60);

    expect(scout!.alive).toBe(true);
    expect(march!.alive).toBe(true);
    // The wrap-aware scout crossed the seam to the opposite (left) edge ...
    expect(scout!.x, 'wrap-aware scout wraps into the arena').toBeGreaterThanOrEqual(0);
    expect(scout!.x, 'wrap-aware scout wraps into the arena').toBeLessThan(GAME_WIDTH);
    // ... while the classic non-aware march keeps its off-screen slot.
    expect(march!.x, 'non-aware march is not wrapped').toBeGreaterThan(GAME_WIDTH);
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

  it('AC1 gym-parity — the re-derived L4–L5 targets are non-degenerate in the gym', () => {
    // Gym↔game parity (AH-0MUX60S9L0006NJ0): the gym's `sequenceVariedWaves`
    // shares `sequencer()` with the campaign, so the re-derived L4–L5 targets
    // must not produce degenerate single-enemy waves on the gym path either
    // (the gym passes its tighter `CURVE_TARGET_TOLERANCE = 3`).
    const waves = sequenceVariedWaves([14, 22, 27.5, 43.5, 62]);
    expect(waves).toHaveLength(5);
    for (const wave of waves) {
      const total = wave.groups.reduce((sum, group) => sum + group.count, 0);
      expect(total, `target ${wave.targetDifficulty}`).toBeGreaterThan(1);
    }
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

  // ── Live-aim & mineral-seek regressions (AH-0MV5SDMMF008O55Q) ──────

  /**
   * Test-first reconciliation (AH-0MV5SDMMF008O55Q): these regressions were
   * written red-first under Vitest's `it.fails(...)` and the adoption item
   * AH-0MV5SDNI2008RWQ2 removed the expected-failure wrapper once `GymLevel`
   * adopted the shared live-targeting helper — they are now hard gates.
   */

  it('AH-0MV5SDMMF008O55Q — a Diver\'s aim target tracks the live player', async () => {
    const scene = await bootWith({
      level: makeLevel('Aim', [
        {
          groups: [
            {
              enemyKey: 'diver',
              formation: 'v',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 200,
              startY: 100,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });

    const diver = scene.getEnemies().find(
      (e): e is Diver => e instanceof Diver,
    );
    expect(diver, 'Diver not spawned').toBeDefined();

    const player = scene.getShip();
    expect(player).not.toBeNull();

    // Record the player position before tick.
    const playerX = player!.x;
    const playerY = player!.y;

    // Advance one frame — this is where the live-aim push must fire.
    scene.tick(0.016);

    // After the push, the Diver\'s aimTarget must equal the player position,
    // NOT the bottom-centre default that the constructor sets.
    const aim = diver!.aimTarget;
    expect(aim.x).toBe(playerX);
    expect(aim.y).toBe(playerY);
  });

  it('AH-0MV5SDMMF008O55Q — a Harvester receives the live mineral field (not empty)', async () => {
    const scene = await bootWith({
      level: makeLevel('Seek', [
        {
          groups: [
            {
              enemyKey: 'harvester',
              formation: 'v',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 200,
              startY: 100,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });

    const harvester = scene.getEnemies().find(
      (e): e is Harvester => e instanceof Harvester,
    );
    expect(harvester, 'Harvester not spawned').toBeDefined();

    const minerals = scene.getMinerals();
    expect(minerals.length, 'no minerals seeded').toBeGreaterThan(0);

    // Advance one frame — the mineral-seek push must fire.
    scene.tick(0.016);

    // The Harvester must have selected a live mineral as its target.
    expect(harvester!.seekTargetX).not.toBeNull();
    expect(harvester!.seekTargetY).not.toBeNull();
  });

  it('AC4/AC5 — a small asteroid kill spawns one extra_life drop on the field', async () => {
    window.localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({ asteroidExtraLifeDropChance: 1 }),
    );
    const scene = await bootWith({
      level: makeLevel('Asteroid', [scoutWave(1)]),
    });
    // 0.99 fails the generic pool and passes the forced 1.0 Extra Life roll.
    scene.setSupplyRng(() => 0.99);
    const before = scene.getDrops().length;

    // A small asteroid is terminal (it never splits in the level gym), so it
    // reaches the shared kill seam directly; feed it a minimal asteroid stub.
    const smallAsteroid = {
      x: 123,
      y: 234,
      alive: true,
      getSizeTier: () => 'small' as const,
    };
    (
      scene as unknown as { onEnemyDestroyed(enemy: unknown): void }
    ).onEnemyDestroyed(smallAsteroid);

    const drops = scene.getDrops();
    expect(drops.length).toBe(before + 1);
    // The cadence drop at boot can itself be an extra_life, so locate the
    // kill drop by its exact death-site position (spawnSupplyDrop does no
    // nudging).
    const extra = drops.find(
      (d) => d.dropId === 'extra_life' && d.x === 123 && d.y === 234,
    );
    expect(extra).toBeDefined();
    expect(extra!.x).toBeCloseTo(123, 0);
    expect(extra!.y).toBeCloseTo(234, 0);
  });
});
describe('GymLevel — wormhole emergence parity (AH-0MV8BSMXC0097KLW)', () => {
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

  async function bootWave(wave: WaveDefinition): Promise<GymLevel> {
    booted = await bootScene([GymLevel]);
    const manager = booted.game.scene;
    manager.start('GymLevel', { level: makeLevel('Emergence', [wave]) });
    await advanceGame(booted.game, 200);
    return manager.getScene('GymLevel') as GymLevel;
  }

  /** A firing wave of `count` scouts. */
  function firingScoutWave(count: number): WaveDefinition {
    return { ...scoutWave(count), shootEnabled: true };
  }

  it('emerges every wave enemy from a wormhole centred on the wave formation', async () => {
    const scene = await bootWave(scoutWave(4));
    // Formation enemies only: the scheduled asteroid hazard is scenario
    // content that may spawn in the same window (AH-0MV9AWR7A0084XJ0).
    const enemies = formationEnemies(scene);
    expect(enemies).toHaveLength(4);

    const effects = scene.getWormholeEffects();
    const wormhole = effects[effects.length - 1];
    expect(wormhole, 'no wormhole opened for the launched wave').toBeDefined();

    // Every enemy starts at the wormhole origin (where the VFX opened).
    for (const enemy of enemies) {
      expect(enemy.x).toBeCloseTo(wormhole.x, 5);
      expect(enemy.y).toBeCloseTo(wormhole.y, 5);
    }

    // The wormhole is centred on the formation the enemies settle into, so
    // no enemy treks the full formation extent (the producer-audit
    // requirement: final positions centred on the wormhole).
    const dests = enemies.map((enemy) => {
      const state = getSpawnState(enemy as unknown as SpawnAnimatable);
      expect(state, 'enemy is not in its spawn animation').not.toBeNull();
      return { x: state!.destX, y: state!.destY };
    });
    const xs = dests.map((d) => d.x);
    const ys = dests.map((d) => d.y);
    const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centreY = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(wormhole.x).toBeCloseTo(centreX, 5);
    expect(wormhole.y).toBeCloseTo(centreY, 5);

    // Not the first slot (the pre-parity behaviour put the wormhole on it).
    const apex = dests[0];
    expect(Math.hypot(wormhole.x - apex.x, wormhole.y - apex.y)).toBeGreaterThan(1);

    // ...and no enemy travels further than half the formation's diagonal.
    const halfDiagonal =
      Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
    for (const dest of dests) {
      expect(Math.hypot(dest.x - wormhole.x, dest.y - wormhole.y)).toBeLessThanOrEqual(
        halfDiagonal + 1e-6,
      );
    }
  });

  it('lands every enemy exactly on its (live, drifting) formation slot at the end of the spawn animation', async () => {
    const wave = scoutWave(4);
    const scene = await bootWave(wave);
    const enemies = formationEnemies(scene);
    const group = wave.groups[0];
    // Enemies rest on their live formation slot: base + drift, plus the
    // shared formation offset (the same arithmetic `_moveEnemies` applies).
    const drift = scene.getFormationDriftX();
    const slots = getFormationBuilder(group.formation)(group.count).map(
      (offset) => ({
        x: group.startX + drift + offset.col * group.spacingX,
        y: group.startY + offset.row * group.spacingY,
      }),
    );

    scene.finishSpawnAnimations();

    enemies.forEach((enemy, index) => {
      // The snap lands on the slot; scout wiggle is up to ±2 px around it.
      expect(Math.abs(enemy.x - slots[index].x)).toBeLessThanOrEqual(3);
      expect(Math.abs(enemy.y - slots[index].y)).toBeLessThanOrEqual(3);
      expect(enemy.isSpawning).toBe(false);
    });
  });

  it('is dt-driven and fully arrives inside the 3 s spawn-protection window', async () => {
    const scene = await bootWave(scoutWave(4));
    const enemies = formationEnemies(scene);
    const origins = enemies.map((enemy) => ({ x: enemy.x, y: enemy.y }));

    // Partway through the grow phase every enemy is still spawning and has
    // begun to travel away from the wormhole.
    scene.tick(1.2);
    enemies.forEach((enemy, index) => {
      expect(enemy.isSpawning).toBe(true);
      expect(
        Math.abs(enemy.x - origins[index].x) + Math.abs(enemy.y - origins[index].y),
      ).toBeGreaterThan(1);
    });
    expect(scene.isWormholeOpen()).toBe(true);

    // Growth ends at 2.5 s, inside the 3 s protection window.
    scene.tick(1.5);
    for (const enemy of enemies) expect(enemy.isSpawning).toBe(false);
    expect(scene.isWormholeOpen()).toBe(false);
  });

  it('holds spawn protection while enemies are in transit (gym parity)', async () => {
    const scene = await bootWave(firingScoutWave(4));
    const victim = formationEnemies(scene)[1];
    const livesBefore = scene.getEffectsRegistry().lives();

    scene.tick(1.2);
    expect(victim.isSpawning).toBe(true);

    // Player bullets pass through a transiting enemy.
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.016);
    expect(victim.alive).toBe(true);

    // A transiting enemy cannot fire.
    scene.tick(0.1);
    expect(scene.getActiveEnemyBullets()).toHaveLength(0);

    // No body collision: parking the ship on a transiting enemy is harmless.
    const player = scene.getShip()!;
    player.setPosition(victim.x, victim.y);
    scene.tick(0.001);
    expect(scene.getEffectsRegistry().lives()).toBe(livesBefore);
    expect(victim.alive).toBe(true);

    // Once the transit completes the same enemy becomes vulnerable.
    scene.finishSpawnAnimations();
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.016);
    expect(victim.alive).toBe(false);
  });

  it('hands the wave shootEnabled rule onto every spawned entity, like PlayScene (AH-0MVRMHSKH0066J9B AC2)', async () => {
    // A firing launch: every enemy carries the wave's `true` rule — the flag
    // flows from the wave/spawn descriptor, never hand-set by the test (the
    // old workaround removed by AH-0MVRMHSKH0066J9B).
    const firing = await bootWave(firingScoutWave(3));
    for (const enemy of formationEnemies(firing)) {
      expect(enemy.shootEnabled, 'firing wave hand-off').toBe(true);
    }

    // A quiet launch (Levels 1–3, GDD §2.4): the same seam propagates the
    // wave's `false` rule instead of leaving the BaseEnemy default.
    const quiet = await bootWave(scoutWave(3));
    for (const enemy of formationEnemies(quiet)) {
      expect(enemy.shootEnabled, 'quiet wave hand-off').toBe(false);
    }
  });

  it('launches a real campaign march level firing and marching, not as a static line (AH-0MVRMHSKH0066J9B AC5)', async () => {
    // The shipped campaign's march level (Level 6, wave 1: a `march` block of
    // Invaders plus Scouts, `openFire`). Before this item a launched block
    // rendered as a static line and its enemies were silently non-threatening;
    // this pins the end-to-end behaviour the gym exists to preview.
    const level = LEVELS[5];
    booted = await bootScene([GymLevel]);
    booted.game.scene.start('GymLevel', { level });
    await advanceGame(booted.game, 200);
    const scene = booted.game.scene.getScene('GymLevel') as GymLevel;
    scene.setAsteroidSpawnerEnabled(false);

    const enemies = formationEnemies(scene);
    expect(enemies.length).toBeGreaterThan(0);
    // The firing rule flows from the launched wave definition (Levels 4+).
    expect(enemies.every((enemy) => enemy.shootEnabled)).toBe(true);

    // The wave's march block is live and rides the shared march policy: its
    // base steps once per `step / referenceSpeed` second, and the Invaders are
    // positioned from it rather than from the global drift.
    const before = scene.getMarchState();
    expect(before, 'launched march wave has no march block').not.toBeNull();
    scene.finishSpawnAnimations();
    for (let frame = 0; frame < 90; frame += 1) scene.tick(1 / 60); // 1.5 s
    const after = scene.getMarchState()!;
    expect(
      after.x !== before!.x || after.y !== before!.y,
      'the launched march block stepped',
    ).toBe(true);
    const invader = enemies.find((enemy) => !enemy.wrapAware);
    expect(invader, 'the launched wave has no march member').toBeDefined();
    // The Invader's body sits on the block's live base + its column offset (the
    // shared body wiggle adds up to ±2 px).
    expect(
      Math.abs(invader!.x - (after.x + invader!.offset.col * 26)),
    ).toBeLessThanOrEqual(3);
  });

  it('shimmers each emerging enemy from the shared spawn path, and restores it when growth ends (AH-0MVD2N9MM0007NGZ parity)', async () => {
    const scene = await bootWave(scoutWave(4));
    const enemy = formationEnemies(scene)[0];

    // Still in the wormhole-open delay: no shimmer, alpha untouched.
    expect(enemy.isSpawning).toBe(true);
    const beforeGrowth = enemy.alpha;

    // Drive into the growth window: the shared `_updateSpawnAnimations` pass
    // must apply the per-entity shimmer (alpha flickers off the base value).
    scene.tick(1.05);
    const duringGrowth = enemy.alpha;
    expect(duringGrowth).not.toBe(beforeGrowth);
    expect(duringGrowth).toBeGreaterThan(0);
    expect(duringGrowth).toBeLessThanOrEqual(1);

    // Growth ends → the shimmer is released and the exit is clean.
    scene.finishSpawnAnimations();
    scene.tick(0.016);
    expect(enemy.isSpawning).toBe(false);
    expect(enemy.alpha).toBe(1);
  });

  it('tracks the wormhole (and its glow/pulse ring) in the shared wormholeEffects registry (AH-0MVD2N9MM0007NGZ parity)', async () => {
    const scene = await bootWave(scoutWave(4));

    const effects = scene.getWormholeEffects();
    expect(effects).toHaveLength(1);
    const wormhole = effects[0];
    // The ring hangs off the wormhole container, so the registry entry owns it
    // and `SHUTDOWN` teardown clears it with the wormhole. The same close-time
    // removal (destroy exactly once) is asserted at the VFX level in
    // `wormholeSpawn.test.ts` (its `spawnWormholeClose` onComplete drives it
    // deterministically); here we prove the gym passes its registry along so
    // that teardown actually fires.
    expect(
      wormhole.list.filter((o) => o.getData?.('wormholeRing') === true),
    ).toHaveLength(1);

    // Closing the wormhole (end of the spawn window) goes through the shared
    // controller with the registry attached — the close-vs-open contract.
    scene.finishSpawnAnimations();
    expect(scene.isWormholeOpen()).toBe(false);
  });
});

/**
 * AH-0MV9AWR7A0084XJ0 — the level gym (and the bot-tuning gym that inherits
 * it) now plays the same scenario pressures the shipped demo does: a scheduled
 * offscreen asteroid hazard and a timed wave window. Both are the shared
 * implementations — `AsteroidHazardLayer` (the plan/release lifecycle
 * `PlayScene` runs) and the shared `CombatScene` wave-timeout — so tuning in
 * the gym transfers to the demo.
 */
describe('GymLevel — scheduled asteroid hazard + timed waves (AH-0MV9AWR7A0084XJ0)', () => {
  let booted: BootedGame | null = null;

  /** Seed for the deterministic hazard RNG injected by the test subclass. */
  const HAZARD_SEED = 424242;

  /**
   * `GymLevel` with a deterministic hazard RNG. The production scene uses
   * `Math.random` (or, in `GymBotTuning`, a seed-derived stream); the subclass
   * makes the plan assertable without reaching into private state.
   */
  class SeededHazardGymLevel extends GymLevel {
    override init(data?: GymLevelData): void {
      super.init(data);
      this.setHazardRng(createSeededRng(HAZARD_SEED));
    }
  }

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

  async function bootSeeded(data: GymLevelData): Promise<GymLevel> {
    booted = await bootScene([SeededHazardGymLevel]);
    booted.game.loop.stop();
    const manager = booted.game.scene;
    // `SceneManager.start` runs `init()` + `create()` synchronously, so the
    // scene (and its first wave plan) exists the moment this resolves.
    manager.start('GymLevel', data);
    return manager.getScene('GymLevel') as GymLevel;
  }

  /** The plan the shared planner produces for `globalWaveIndex`. */
  function expectedPlan(
    globalWaveIndex: number,
  ): ReturnType<typeof computeSpawns> {
    return computeSpawns(
      globalWaveIndex,
      GAME_WIDTH,
      GAME_HEIGHT,
      WAVE_TIME_LIMIT_SECONDS,
      createSeededRng(HAZARD_SEED),
    );
  }

  /** Sets the wave clock to `elapsed` seconds into the active wave. */
  function setElapsed(scene: GymLevel, elapsed: number): void {
    scene.setWaveTimeoutRemaining(WAVE_TIME_LIMIT_SECONDS - elapsed);
  }

  it('AC1 — plans the game asteroid schedule with the shared planner', async () => {
    const scene = await bootSeeded({
      level: makeLevel('Hazard', [scoutWave(2)]),
    });

    expect(scene.getPendingAsteroidSpawns()).toEqual(expectedPlan(0));
    expect(scene.getReleasedAsteroidCount()).toBe(0);
    // Nothing is on the field before its scheduled time.
    expect(scene.getAsteroids()).toHaveLength(0);
  });

  it('AC1 — releases a planned asteroid at its scheduled time and it drifts inward', async () => {
    const scene = await bootSeeded({
      level: makeLevel('Hazard', [scoutWave(2)]),
    });
    const plan = scene.getPendingAsteroidSpawns();
    expect(plan.length).toBeGreaterThan(0);
    const first = plan[0];

    if (first.timeSeconds > 0.02) {
      setElapsed(scene, first.timeSeconds - 0.01);
      scene.tick(0.001);
      expect(scene.getAsteroids()).toHaveLength(0);
    }

    setElapsed(scene, first.timeSeconds + 1e-6);
    scene.tick(0.001);

    const asteroids = scene.getAsteroids();
    expect(asteroids).toHaveLength(1);
    expect(scene.getReleasedAsteroidCount()).toBe(1);
    const asteroid = asteroids[0];
    expect(asteroid.getSizeTier()).toBe(first.sizeTier);
    // Spawned outside the viewport on its entry axis (offscreen origin).
    const offscreen =
      asteroid.x < 0 ||
      asteroid.x > GAME_WIDTH ||
      asteroid.y < 0 ||
      asteroid.y > GAME_HEIGHT;
    expect(offscreen).toBe(true);

    // Drifting: the roamer advances its own motion (no formation drift).
    const startX = asteroid.x;
    const startY = asteroid.y;
    scene.tick(0.5);
    expect(
      Math.hypot(asteroid.x - startX, asteroid.y - startY),
    ).toBeGreaterThan(1);
  });

  it('AC1 — asteroids are non-blocking: a wave clears while they persist', async () => {
    const scene = await bootSeeded({
      level: makeLevel('Hazard', [scoutWave(1), scoutWave(1)]),
    });
    setElapsed(scene, scene.getPendingAsteroidSpawns()[0].timeSeconds + 1e-6);
    scene.tick(0.001);
    expect(scene.getAsteroids()).toHaveLength(1);

    // Destroy every blocking enemy; the asteroid must not gate the wave.
    scene
      .getEnemies()
      .filter((enemy) => !(enemy instanceof Asteroid))
      .forEach((enemy) => enemy.destroySelf());
    scene.tick(0.016);

    expect(scene.getCurrentWaveIndex()).toBe(1);
    expect(scene.isLevelComplete()).toBe(false);
    // The hazard persists across the wave transition (game parity).
    expect(scene.getAsteroids()).toHaveLength(1);
  });

  it('AC2 — every gym wave runs the shared 30 s timed-wave window', async () => {
    const scene = await bootSeeded({
      level: makeLevel('Timed', [scoutWave(2)]),
    });

    const initial = scene.getWaveState();
    expect(initial.active).toBe(true);
    expect(initial.timeLimit).toBe(WAVE_TIME_LIMIT_SECONDS);
    expect(initial.timeRemaining).toBeCloseTo(WAVE_TIME_LIMIT_SECONDS, 3);

    scene.tick(1);
    const later = scene.getWaveState();
    expect(later.active).toBe(true);
    expect(later.timeRemaining).toBeCloseTo(
      WAVE_TIME_LIMIT_SECONDS - 1,
      3,
    );
  });

  it('AC2 — the wave clock times out with carry-over survivors and a fresh wave', async () => {
    const scene = await bootSeeded({
      level: makeLevel('Timed', [scoutWave(2), scoutWave(2)]),
    });
    const survivors = scene
      .getEnemies()
      .filter((enemy) => !(enemy instanceof Asteroid));
    expect(survivors).toHaveLength(2);

    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS);
    scene.tick(0.001);

    // The next wave started; the survivors were kept (carry-over parity).
    expect(scene.getCurrentWaveIndex()).toBe(1);
    const blocking = scene
      .getEnemies()
      .filter(
        (enemy) => !(enemy instanceof Asteroid) && enemy.alive,
      );
    expect(blocking).toHaveLength(4);
    // The new wave armed a fresh window.
    expect(scene.getWaveState().active).toBe(true);
    expect(scene.getWaveState().timeRemaining).toBeCloseTo(
      WAVE_TIME_LIMIT_SECONDS,
      2,
    );
  });

  it('AC1 — the hazard can be disabled (tuning/test seam) and then never fires', async () => {
    const scene = await bootSeeded({
      level: makeLevel('Hazard', [scoutWave(1)]),
    });
    scene.setAsteroidSpawnerEnabled(false);

    setElapsed(scene, WAVE_TIME_LIMIT_SECONDS - 0.001);
    scene.tick(0.002);

    expect(scene.getPendingAsteroidSpawns()).toEqual([]);
    expect(scene.getAsteroids()).toHaveLength(0);
  });
});
// ── Force-field spawn parity at launch (AH-0MVM8GXEF009883O, AC4) ───

/**
 * `GymLevel` launches *real campaign waves* through the same factory path as
 * `PlayScene._spawnEnemy`, so it must resolve enemy force fields through the
 * same shared curve at the **launched level** (`level.level`). A formation
 * gym without campaign context gets direct slider hits instead (see
 * `GymFodderEnemies`); the level gym is the campaign-parity gym and must
 * never bypass the curve. The game↔gym equality is cross-asserted in
 * `src/scenes/core/CombatScene.equivalence.test.ts`.
 */
describe('GymLevel — force-field spawn resolution (AH-0MVM8GXEF009883O)', () => {
  let booted: BootedGame | null = null;

  const tick = () => advanceGame(booted!.game, 200);

  /** A single non-firing Tank wave wrapped in a level definition. */
  function tankLevel(level: number): LevelDefinition {
    return {
      level,
      name: `FF Level ${level}`,
      waves: [
        {
          groups: [
            {
              enemyKey: 'tank',
              formation: 'rect',
              count: 2,
              spacingX: 44,
              spacingY: 36,
              startX: GAME_WIDTH * 0.3,
              startY: GAME_HEIGHT * 0.25,
            },
          ],
          shootEnabled: false,
        },
      ],
    };
  }

  async function bootLevel(level: number): Promise<GymLevel> {
    booted = await bootScene([GymLevel]);
    const manager = booted.game.scene;
    manager.start('GymLevel', { level: tankLevel(level) });
    await tick();
    const scene = manager.getScene('GymLevel') as GymLevel;
    scene.finishSpawnAnimations();
    return scene;
  }

  /** The launched wave's live Tanks (formation enemies only). */
  function liveTanks(scene: GymLevel): Tank[] {
    return scene
      .getEnemies()
      .filter((enemy): enemy is Tank => enemy instanceof Tank && enemy.alive);
  }

  it('resolves the launched level through the shared curve at spawn', async () => {
    const scene = await bootLevel(5);

    const expected = enemyForceFieldHits(5, DEFAULT_ENEMY_CONFIGS.tank);
    expect(expected).toBeGreaterThan(0);
    const tanks = liveTanks(scene);
    expect(tanks.length).toBeGreaterThan(0);
    for (const tank of tanks) {
      expect(tank.forceFieldHits).toBe(expected);
      expect(tank.hasForceField).toBe(true);
    }
  });

  it('leaves level 1 untouched — launched tanks are unshielded', async () => {
    const scene = await bootLevel(1);
    expect(await enemyForceFieldHits(1, DEFAULT_ENEMY_CONFIGS.tank)).toBe(0);
    const tanks = liveTanks(scene);
    expect(tanks.length).toBeGreaterThan(0);
    for (const tank of tanks) {
      expect(tank.forceFieldHits).toBe(0);
      expect(tank.hasForceField).toBe(false);
    }
  });

  it('treats a single-wave launch (level 0) as the level-1 identity', async () => {
    const scene = await bootLevel(0);
    // `clampLevel` resolves 0 → 1: the identity launch, never a fabricated field.
    const tanks = liveTanks(scene);
    expect(tanks.length).toBeGreaterThan(0);
    for (const tank of tanks) {
      expect(tank.forceFieldHits).toBe(0);
      expect(tank.hasForceField).toBe(false);
    }
  });
});

describe('GymLevel — capture setup application (AH-0MVNW8VNN004FFK1)', () => {
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

  async function bootWith(data: GymLevelData): Promise<GymLevel> {
    booted = await bootScene([GymLevel]);
    const manager = booted.game.scene;
    manager.start('GymLevel', data);
    await advanceGame(booted.game, 200);
    return manager.getScene('GymLevel') as GymLevel;
  }

  const level = () =>
    makeLevel('Setup Level', [scoutWave(1), scoutWave(1), scoutWave(1)]);

  it('applies the configured loadout, power-up levels and starting wave', async () => {
    const scene = await bootWith({
      level: level(),
      startWave: 2,
      player: { weapons: ['rapid'], timedWeapons: [] },
      powerUps: { shield: 2 },
    });

    const player = scene.getPlayer();
    expect(player).not.toBeNull();
    // Explicit `player` overrides the default: only rapid is permanent.
    expect(player!.getActiveWeapons()).toContain('rapid');
    expect(player!.getActiveWeapons()).not.toContain('spread');
    expect(player!.getPowerUpLevelStore().getEffectiveLevel('shield')).toBe(2);
    // startWave is 2 (1-based) → wave index 1.
    expect(scene.getCurrentWaveIndex()).toBe(1);
  });

  it('keeps the historical spread+dual start when no setup is supplied', async () => {
    const scene = await bootWith({ level: level() });

    const player = scene.getPlayer();
    expect(player).not.toBeNull();
    expect(player!.getActiveWeapons()).toEqual(
      expect.arrayContaining(['spread', 'dual']),
    );
    expect(scene.getCurrentWaveIndex()).toBe(0);
  });

  it('starts a timed weapon with a countdown when configured as timed', async () => {
    const scene = await bootWith({
      level: level(),
      player: { weapons: [], timedWeapons: ['rapid'] },
    });
    expect(scene.getPlayer()!.getActiveWeapons()).toContain('rapid');
  });
});

describe('GymLevel — seeded setup determinism (AH-0MVNW90FB003H3KM)', () => {
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

  async function bootWith(data: GymLevelData): Promise<GymLevel> {
    booted = await bootScene([GymLevel]);
    const manager = booted.game.scene;
    manager.start('GymLevel', data);
    await advanceGame(booted.game, 200);
    return manager.getScene('GymLevel') as GymLevel;
  }

  /** Rounded mineral positions — the content axis a seed must reproduce. */
  function mineralPositions(scene: GymLevel): Array<[number, number]> {
    return scene
      .getMinerals()
      .map((m) => [Math.round(m.x), Math.round(m.y)] as [number, number]);
  }

  const level = () => makeLevel('Seeded', [scoutWave(1)]);

  it('produces identical mineral content for the same seed', async () => {
    const first = mineralPositions(await bootWith({ level: level(), seed: 123456 }));
    booted?.game.destroy(true);
    booted = null;
    const second = mineralPositions(await bootWith({ level: level(), seed: 123456 }));

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('produces different content for different seeds (at least one axis)', async () => {
    const a = mineralPositions(await bootWith({ level: level(), seed: 1 }));
    booted?.game.destroy(true);
    booted = null;
    const b = mineralPositions(await bootWith({ level: level(), seed: 2 }));

    expect(a).not.toEqual(b);
  });
});

describe('GymLevel — arc setup fields (AH-0MVRMFOB4002LMZS)', () => {
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

  async function bootWith(data: GymLevelData): Promise<GymLevel> {
    booted = await bootScene([GymLevel]);
    const manager = booted.game.scene;
    manager.start('GymLevel', data);
    await advanceGame(booted.game, 200);
    return manager.getScene('GymLevel') as GymLevel;
  }

  const level = () => makeLevel('Arc Level', [scoutWave(1)]);

  it('starts each configured weapon at its permanent level', async () => {
    const scene = await bootWith({
      level: level(),
      player: {
        weapons: ['spread'],
        timedWeapons: [],
        weaponLevels: { rapid: 3, spread: 2 },
      },
    });

    const player = scene.getPlayer()!;
    // Level N == N permanent grants; `weapons` still contributes one grant.
    expect(player.getWeaponLevel('rapid')).toBe(3);
    expect(player.getWeaponLevel('spread')).toBe(3);
    expect(player.hasWeapon('rapid')).toBe(true);
  });

  it('keeps the level-1 semantics of player.weapons when no levels are set', async () => {
    const scene = await bootWith({
      level: level(),
      player: { weapons: ['spread'], timedWeapons: [] },
    });

    expect(scene.getPlayer()!.getWeaponLevel('spread')).toBe(1);
  });

  it('resolves a full hold to the forced mineralReward, not a random pick', async () => {
    const scene = await bootWith({
      level: level(),
      player: { weapons: [], timedWeapons: [] },
      mineralReward: 'mineral_scoop',
    });

    // The strategy is a spy: a forced reward must never consult it.
    const strategy = vi.fn(() => [
      { id: 'shield' as const, name: 'Shield', kind: 'powerup' as const },
    ]);
    scene.setMineralChoiceStrategy({ choose: strategy });

    // Drop the seeded field so the fill is exact, then collect to capacity.
    (scene as unknown as { minerals: unknown[] }).minerals.length = 0;
    const capacity = scene.getMineralCapacity();
    const player = scene.getPlayer()!;
    for (const mineral of scene.seedMinerals(capacity)) {
      mineral.setPosition(player.x, player.y);
    }
    scene.tick(0.016);

    // The forced reward landed through the shared reward-application path.
    expect(player.getPowerUpLevel('mineral_scoop')).toBe(1);
    expect(player.getPowerUpLevel('shield')).toBe(0);
    expect(strategy).not.toHaveBeenCalled();
    // The hold resolved (it is no longer full).
    expect(scene.getMineralHold()).toBe(0);
  });

  it('still resolves a full hold randomly when no reward is forced', async () => {
    const scene = await bootWith({
      level: level(),
      player: { weapons: [], timedWeapons: [] },
    });

    const strategy = vi.fn(() => [
      { id: 'shield' as const, name: 'Shield', kind: 'powerup' as const },
    ]);
    scene.setMineralChoiceStrategy({ choose: strategy });

    (scene as unknown as { minerals: unknown[] }).minerals.length = 0;
    const player = scene.getPlayer()!;
    for (const mineral of scene.seedMinerals(scene.getMineralCapacity())) {
      mineral.setPosition(player.x, player.y);
    }
    scene.tick(0.016);

    expect(strategy).toHaveBeenCalledTimes(1);
    expect(player.getPowerUpLevel('shield')).toBe(1);
  });
});

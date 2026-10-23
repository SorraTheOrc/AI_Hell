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
import { sequenceVariedWaves } from './GymCurveSequencer';
import {
  GYM_LEVEL_DEFAULT_LABEL,
  GymLevel,
  type GymLevelData,
} from './GymLevel';
import { Diver } from '../../entities/Diver';
import { Harvester } from '../../entities/Harvester';
import { RULES_STORAGE_KEY } from '../../core/rules';
import {
  getSpawnState,
  type SpawnAnimatable,
} from '../../vfx/wormholeSpawn';
import { getFormationBuilder } from '../../utils/formations';

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

  /** Boots the gym on one wave and returns the scene. */
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
    const enemies = scene.getEnemies();
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
    const enemies = scene.getEnemies();
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
    const enemies = scene.getEnemies();
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
    const victim = scene.getEnemies()[1];
    const livesBefore = scene.getEffectsRegistry().lives();

    scene.tick(1.2);
    expect(victim.isSpawning).toBe(true);

    // Player bullets pass through a transiting enemy.
    scene.spawnPlayerBullet(victim.x, victim.y, 0, 0);
    scene.tick(0.016);
    expect(victim.alive).toBe(true);

    // A transiting enemy cannot fire.
    victim.shootEnabled = true;
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
});

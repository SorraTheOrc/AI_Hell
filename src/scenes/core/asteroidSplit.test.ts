/**
 * Shared asteroid-split helper tests (AH-0MUII3F7Q002O7WX, gap 8).
 *
 * Covers the helper's observable behaviour (child count, tier, spawn
 * position, velocity fan and rotation) plus the repo-wide source guard that
 * pins the single definition and proves the game and both asteroid-bearing
 * gyms consume it rather than re-implementing the split closure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  collectProductionSourceFiles,
  definesFunction,
} from '../../test/duplicateBodyGuard';
import {
  ASTEROID_MEDIUM_ROTATION_SPEED,
  ASTEROID_MEDIUM_SPEED,
  ASTEROID_SMALL_ROTATION_SPEED,
  ASTEROID_SMALL_SPEED,
  Asteroid,
  type AsteroidSizeTier,
} from '../../entities/Asteroid';
import { splitAsteroid } from './asteroidSplit';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('AsteroidSplitHarness');
  }
}

/** Every production TypeScript file under `src/` (excluding tests). */
function productionSourceFiles(): string[] {
  return collectProductionSourceFiles(path.resolve(process.cwd(), 'src'));
}

/** Relative, sorted paths of the files that satisfy `predicate`. */
function relativeDefiners(
  predicate: (source: string) => boolean,
): string[] {
  return productionSourceFiles()
    .filter((file) => predicate(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(process.cwd(), file))
    .sort();
}

describe('asteroidSplit — shared helper behaviour', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function bootHarness(): Promise<HarnessScene> {
    const booted = await bootScene([HarnessScene]);
    games.push(booted);
    return booted.scene as HarnessScene;
  }

  function makeParent(
    scene: Phaser.Scene,
    tier: AsteroidSizeTier,
    x = 100,
    y = 200,
  ): Asteroid {
    const parent = new Asteroid(scene, {
      x,
      y,
      formationOffset: { row: 0, col: 0 },
      sizeTier: tier,
    });
    scene.add.existing(parent);
    return parent;
  }

  it('a large parent spawns exactly two medium children at its position', async () => {
    const scene = await bootHarness();
    const parent = makeParent(scene, 'large');
    const registered: Asteroid[] = [];

    const children = splitAsteroid({
      scene,
      parent,
      register: (child) => registered.push(child),
    });

    expect(children).toHaveLength(2);
    // Registration happens once per child, in spawn order.
    expect(registered).toEqual(children);
    for (const child of children!) {
      expect(child.getSizeTier()).toBe('medium');
      expect(child.x).toBe(100);
      expect(child.y).toBe(200);
      expect(Math.hypot(child.vx, child.vy)).toBeCloseTo(
        ASTEROID_MEDIUM_SPEED,
        5,
      );
      expect(child.currentRotationSpeed).toBe(ASTEROID_MEDIUM_ROTATION_SPEED);
      // Children join the scene's display list (added by the helper).
      expect(scene.children.list).toContain(child);
    }
  });

  it('a medium parent spawns two small children with the small-tier physics', async () => {
    const scene = await bootHarness();
    const parent = makeParent(scene, 'medium', 40, 60);
    const registered: Asteroid[] = [];

    const children = splitAsteroid({
      scene,
      parent,
      register: (child) => registered.push(child),
    });

    expect(children).toHaveLength(2);
    expect(registered).toHaveLength(2);
    for (const child of children!) {
      expect(child.getSizeTier()).toBe('small');
      expect(child.x).toBe(40);
      expect(child.y).toBe(60);
      expect(Math.hypot(child.vx, child.vy)).toBeCloseTo(
        ASTEROID_SMALL_SPEED,
        5,
      );
      expect(child.currentRotationSpeed).toBe(ASTEROID_SMALL_ROTATION_SPEED);
    }
  });

  it('a small parent destroys cleanly — no children and no registration', async () => {
    const scene = await bootHarness();
    const parent = makeParent(scene, 'small');
    const registered: Asteroid[] = [];

    const children = splitAsteroid({
      scene,
      parent,
      register: (child) => registered.push(child),
    });

    expect(children).toBeNull();
    expect(registered).toHaveLength(0);
  });

  it('child directions differ from the parent and from each other by at least π/3', async () => {
    const scene = await bootHarness();
    const parent = makeParent(scene, 'large');
    parent.setPosition(0, 0);

    const children = splitAsteroid({
      scene,
      parent,
      register: () => {},
    })!;

    const parentAngle = Math.atan2(parent.vy, parent.vx);
    const angles = children.map((child) => Math.atan2(child.vy, child.vx));
    const separation = Math.abs(angles[0] - angles[1]);
    const wrapped = Math.min(separation, Math.PI * 2 - separation);
    expect(wrapped).toBeGreaterThanOrEqual(Math.PI / 3 - 0.01);
    for (const angle of angles) {
      const fromParent = Math.abs(angle - parentAngle);
      const wrappedFromParent = Math.min(fromParent, Math.PI * 2 - fromParent);
      expect(wrappedFromParent).toBeGreaterThanOrEqual(Math.PI / 3 - 0.01);
    }
  });
});

describe('asteroidSplit — single definition and shared consumption (AC1)', () => {
  const HELPER = 'splitAsteroid';
  const HELPER_FILE = 'src/scenes/core/asteroidSplit.ts';
  const CONSUMER_FILES = [
    'src/scenes/PlayScene.ts',
    'src/scenes/gym/GymEnemies.ts',
    'src/scenes/gym/GymMinerals.ts',
  ];

  function read(relativePath: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
  }

  it('defines the helper exactly once, in the shared module', () => {
    const definers = relativeDefiners((source) =>
      definesFunction(source, HELPER),
    );
    expect(definers).toEqual([HELPER_FILE]);
  });

  it('the game and both gyms consume the helper', () => {
    for (const file of CONSUMER_FILES) {
      expect(read(file), `${file} must call the shared helper`).toContain(
        `${HELPER}(`,
      );
    }
  });

  it('no production scene re-implements the split by calling getSplitChildren', () => {
    const definers = relativeDefiners((source) =>
      source.includes('getSplitChildren('),
    );
    // Only the entity (the child-spec source of truth) and the shared helper.
    expect(definers).toEqual([
      'src/entities/Asteroid.ts',
      'src/scenes/core/asteroidSplit.ts',
    ]);
  });
});

/**
 * Tests for the indestructible obstacle entity (AH-0MUAYB2XR007N10W).
 *
 * The entity must satisfy the shared `CombatEnemyEntity` structural
 * contract (position + `alive` + `getHitRadius()` + a no-op `destroySelf()`)
 * so the Player gym can consume the shared collision pass unchanged. These
 * tests assert that observable contract; the Player-gym behaviour
 * (bullet absorption, crash-destroys-player) lives in `GymPlayer.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  Obstacle,
  OBSTACLE_BARRIER_COLOR,
  OBSTACLE_PILLAR_COLOR,
  type ObstacleConfig,
} from './Obstacle';

/** Bare host scene that creates the obstacles under test. */
class ObstacleHostScene extends Phaser.Scene {
  created: Obstacle[] = [];

  constructor() {
    super({ key: 'ObstacleHostScene' });
  }

  create(): void {
    const specs: ObstacleConfig[] = [
      { x: 100, y: 120, radius: 24, kind: 'barrier' },
      { x: 300, y: 220, radius: 16, kind: 'pillar' },
      { x: 500, y: 320, radius: 12 },
    ];
    for (const spec of specs) {
      const obstacle = new Obstacle(this, spec);
      this.add.existing(obstacle);
      this.created.push(obstacle);
    }
  }
}

describe('Obstacle entity', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Obstacle[]> {
    booted = await bootScene([ObstacleHostScene]);
    return (booted.scene as ObstacleHostScene).created;
  }

  it('places each obstacle at its configured position with the configured radius', async () => {
    const [barrier, pillar, defaultKind] = await boot();

    expect(barrier.x).toBe(100);
    expect(barrier.y).toBe(120);
    expect(barrier.getHitRadius()).toBe(24);

    expect(pillar.x).toBe(300);
    expect(pillar.y).toBe(220);
    expect(pillar.getHitRadius()).toBe(16);

    // Radius is the collider for every kind.
    expect(defaultKind.getHitRadius()).toBe(12);
  });

  it('defaults to the barrier family and its warning colour', async () => {
    const [barrier, pillar, defaultKind] = await boot();

    expect(barrier.kind).toBe('barrier');
    expect(barrier.color).toBe(OBSTACLE_BARRIER_COLOR);
    expect(pillar.kind).toBe('pillar');
    expect(pillar.color).toBe(OBSTACLE_PILLAR_COLOR);
    // Omitted kind falls back to barrier.
    expect(defaultKind.kind).toBe('barrier');
  });

  it('is indestructible: destroySelf() is a no-op and the obstacle stays alive', async () => {
    const [barrier] = await boot();
    expect(barrier.alive).toBe(true);

    barrier.destroySelf();
    barrier.destroySelf(2);

    expect(barrier.alive).toBe(true);
    expect(barrier.active).toBe(true);
  });

  it('is torn down by the inherited GameObject.destroy() on scene teardown', async () => {
    const [barrier] = await boot();
    expect(barrier.active).toBe(true);

    barrier.destroy();

    expect(barrier.active).toBe(false);
  });
});

/**
 * Centipede gym parity tests (AH-0MV01EJ92008ZZ86).
 *
 * The dedicated `GymCentipede` scene exercises the *same* shared
 * `CentipedeChain` / `Centipede` code the game runs: the linked chain weaves
 * and descends, segments never fire, and shooting a middle segment splits
 * the chain into two independent sub-chains.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { Centipede } from '../../entities/Centipede';
import { CentipedeChain } from '../core/centipedeChain';
import { CENTIPEDE_SEGMENT_COUNT } from '../../waves/CentipedeSpawner';
import { GymCentipede } from './GymCentipede';

describe('GymCentipede — linked chain parity', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<GymCentipede> {
    booted = await bootScene([GymCentipede]);
    return booted.scene as GymCentipede;
  }

  it('spawns one shared chain of segment entities', async () => {
    const scene = await boot();
    expect(scene.centipedeSegments).toHaveLength(CENTIPEDE_SEGMENT_COUNT);
    expect(scene.centipedeSegments.every((s) => s instanceof Centipede)).toBe(true);
    expect(scene.chain).toBeInstanceOf(CentipedeChain);
    expect(scene.chain!.aliveCount()).toBe(CENTIPEDE_SEGMENT_COUNT);
    expect(scene.chain!.subChainCount()).toBe(1);
    // Renders: every segment is on the display list.
    for (const segment of scene.centipedeSegments) {
      expect(scene.children.list).toContain(segment);
    }
  });

  it('weaves and descends while staying inside the arena', async () => {
    const scene = await boot();
    const lead = scene.centipedeSegments[0];
    const startX = lead.x;
    const startY = lead.y;
    scene.tick(0.06);
    scene.tick(0.06);
    // The lead moves (weave + descent) but never leaves the viewport.
    expect(lead.x !== startX || lead.y !== startY).toBe(true);
    for (let i = 0; i < 20; i++) {
      scene.tick(0.2);
      for (const segment of scene.centipedeSegments.filter((s) => s.alive)) {
        expect(segment.x).toBeGreaterThanOrEqual(0);
        expect(segment.x).toBeLessThanOrEqual(GAME_WIDTH);
        expect(segment.y).toBeGreaterThanOrEqual(0);
        expect(segment.y).toBeLessThanOrEqual(GAME_HEIGHT);
      }
    }
  });

  it('segments never fire at any level (no enemy bullets)', async () => {
    const scene = await boot();
    scene.tick(2);
    for (const segment of scene.centipedeSegments) {
      expect(segment.shootEnabled).toBe(false);
      expect(segment.effectiveShotPattern).toBe('none');
    }
    expect(scene.enemyBulletCount).toBe(0);
  });

  it('splits the chain into two sub-chains when a middle segment dies', async () => {
    const scene = await boot();
    const chain = scene.chain!;
    expect(chain.subChainCount()).toBe(1);

    scene.centipedeSegments[2].destroySelf();

    expect(chain.aliveCount()).toBe(CENTIPEDE_SEGMENT_COUNT - 1);
    expect(chain.subChainCount()).toBe(2);
    expect(chain.runs()).toEqual([
      [0, 1],
      [3, 4, 5],
    ]);
  });
});

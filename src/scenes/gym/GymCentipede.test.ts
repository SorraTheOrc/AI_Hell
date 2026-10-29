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
import { DEFAULT_ENEMY_CONFIGS } from '../../core/enemyConfig';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import { Centipede } from '../../entities/Centipede';
import { Scout } from '../../entities/Scout';
import { CentipedeChain } from '../core/centipedeChain';
import { CENTIPEDE_SEGMENT_COUNT } from '../../waves/CentipedeSpawner';
import { centipedeArena } from '../../waves/CentipedeSpawner';
import { GymCentipede } from './GymCentipede';
import { GymFodderEnemies } from './GymFodderEnemies';

describe('GymCentipede — linked chain parity', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
  });

  async function boot(): Promise<GymCentipede> {
    const game = await bootScene([GymCentipede]);
    games.push(game);
    return game.scene as GymCentipede;
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

  it('keeps the classic Centipede bounded while a wrap-aware gym crosses the seam (divergence asserted)', async () => {
    const centipede = await boot();
    // Classic-arcade exclusion: the centipede is seeded `wrapAware: false`,
    // and the gym threads the same resolved flag (gym↔game parity).
    expect(
      centipede.centipedeSegments.every((segment) => segment.wrapAware === false),
    ).toBe(true);

    // Disable the gym player so no stray player bullet can end the weave: the
    // assertion is about the chain's own bounded motion.
    (
      centipede as unknown as { setPlayerEnabled(enabled: boolean): boolean }
    ).setPlayerEnabled(false);

    // A long weave turns at the arena wall and never crosses the playfield
    // seam a wrap-aware enemy would cross.
    const arena = centipedeArena(GAME_WIDTH, GAME_HEIGHT);
    const lead = centipede.centipedeSegments[0];
    let turned = false;
    let previousX = lead.x;
    for (let frame = 0; frame < 120; frame++) {
      centipede.tick(0.1);
      const x = centipede.centipedeSegments[0].x;
      if (x < previousX) turned = true;
      previousX = x;
      expect(x).toBeGreaterThanOrEqual(arena.minX - 1e-6);
      expect(x).toBeLessThanOrEqual(arena.maxX + 1e-6);
    }
    expect(turned, 'the lead reverses at the arena wall').toBe(true);

    // The same shared tick, in a wrap-aware gym: a roster slot over the right
    // edge is carried to the opposite edge instead of staying bounded.
    resetConfigStore();
    seedConfigStore(Object.values(DEFAULT_ENEMY_CONFIGS));
    const fodderGame = await bootScene(
      [GymFodderEnemies],
      'centipede-divergence-fodder',
    );
    games.push(fodderGame);
    const fodder = fodderGame.scene as GymFodderEnemies;
    const COLUMNS_OVER_THE_SEAM = 40;
    const aware = new Scout(fodder, {
      x: 0,
      y: 100,
      formationOffset: { row: 0, col: COLUMNS_OVER_THE_SEAM },
    });
    fodder.registerDynamicEntity(aware);
    const slotX =
      fodder.formationX +
      COLUMNS_OVER_THE_SEAM * DEFAULT_ENEMY_CONFIGS.scout.spacingX;
    expect(slotX, 'setup gate: the slot is over the seam').toBeGreaterThan(
      GAME_WIDTH,
    );

    fodder.tick(0);
    expect(aware.x).toBeGreaterThanOrEqual(0);
    expect(aware.x).toBeLessThan(GAME_WIDTH);
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

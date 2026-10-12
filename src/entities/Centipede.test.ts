/**
 * Centipede segment entity tests (classic-arcade archetype,
 * AH-0MV01EJ92008ZZ86).
 *
 * Behaviour-focused: the entity reads its position from the shared chain,
 * only the sub-chain lead advances it, it never fires, and destroying it
 * splits the chain through the shared destruction path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { fireForEnemy } from './enemyFire';
import { CentipedeChain, type CentipedeChainOptions } from '../scenes/core/centipedeChain';
import { CENTIPEDE_COLOR, CENTIPEDE_SIZE, Centipede } from './Centipede';

class Harness extends Phaser.Scene {
  constructor() {
    super('CentipedeHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

function chain(overrides: Partial<CentipedeChainOptions> = {}): CentipedeChain {
  return new CentipedeChain({
    startX: 100,
    startY: 20,
    arena: { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    segmentCount: 5,
    spacing: 20,
    lateralSpeed: 100,
    descentSpeed: 10,
    ...overrides,
  });
}

describe('Centipede entity', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function scene(): Promise<Phaser.Scene> {
    booted = await bootScene([Harness]);
    return booted.scene;
  }

  function make(
    s: Phaser.Scene,
    sharedChain: CentipedeChain,
    id = 0,
  ): Centipede {
    return new Centipede(s, {
      x: sharedChain.segment(id)?.x ?? 0,
      y: sharedChain.segment(id)?.y ?? 0,
      formationOffset: OFFSET,
      chain: sharedChain,
      segmentId: id,
    });
  }

  it('draws at the configured size/colour and reports the centipede archetype', async () => {
    const s = await scene();
    const entity = make(s, chain());
    expect(entity.archetype).toBe('centipede');
    expect(entity.effectiveSize).toBe(CENTIPEDE_SIZE);
    expect(entity.effectiveColor).toBe(CENTIPEDE_COLOR);
    expect(entity.segmentId).toBe(0);
    expect(entity.chain).toBeInstanceOf(CentipedeChain);
    entity.destroy(true);
  });

  it('never fires at any level (no fire method; dispatcher yields nothing)', async () => {
    const s = await scene();
    const entity = make(s, chain());
    entity.shootEnabled = true; // ignored
    expect(entity.shootEnabled).toBe(false);
    expect(entity.effectiveShotPattern).toBe('none');
    expect(fireForEnemy(entity, 'centipede', 5_000)).toEqual([]);
    // The entity has no `tryFire*` method for the dispatcher to call.
    expect((entity as unknown as Record<string, unknown>)['tryFireAimedBullet']).toBeUndefined();
    entity.destroy(true);
  });

  it('is not a formation enemy (the chain owns its movement)', async () => {
    const s = await scene();
    const entity = make(s, chain());
    expect(entity.isFormationEnemy()).toBe(false);
    entity.destroy(true);
  });

  it('reads its position from the shared chain each frame', async () => {
    const s = await scene();
    const shared = chain();
    const entities = Array.from({ length: shared.segmentCount }, (_, i) =>
      make(s, shared, i),
    );

    // Only the lead advances the chain; the rest read the refreshed positions.
    for (const entity of entities) {
      entity.applyFormationPosition(0, 0, 0.2, 0, 0);
    }
    expect(entities[0].x).toBeCloseTo(shared.segment(0)!.x, 5);
    expect(entities[0].y).toBeCloseTo(shared.segment(0)!.y, 5);
    expect(entities[0].y).toBeGreaterThan(20);
    for (const entity of entities) entity.destroy(true);
  });

  it('does not advance the chain when a non-lead segment updates first', async () => {
    const s = await scene();
    const shared = chain();
    const lead = make(s, shared, 0);
    const follower = make(s, shared, 3);

    const before = shared.segment(0)!.x;
    follower.applyFormationPosition(0, 0, 0.5, 0, 0);
    expect(shared.segment(0)!.x).toBe(before);
    lead.applyFormationPosition(0, 0, 0.5, 0, 0);
    expect(shared.segment(0)!.x).not.toBe(before);
    lead.destroy(true);
    follower.destroy(true);
  });

  it('splits the chain when a middle segment is destroyed', async () => {
    const s = await scene();
    const shared = chain();
    const entities = Array.from({ length: shared.segmentCount }, (_, i) =>
      make(s, shared, i),
    );
    entities.forEach((e) => e.applyFormationPosition(0, 0, 0.1, 0, 0));

    entities[2].destroySelf();
    expect(entities[2].alive).toBe(false);
    expect(shared.aliveCount()).toBe(4);
    expect(shared.subChainCount()).toBe(2);
    expect(shared.runs()).toEqual([
      [0, 1],
      [3, 4],
    ]);

    for (const entity of entities) entity.destroy(true);
  });
});

/**
 * Pac-Man ghost entity tests (AH-0MV01EH2U008XT3Q).
 *
 * Behaviour-focused: the entity steers toward its personality target with
 * the shared policy, alternates scatter/chase on the shared timer, and never
 * fires. Body contact is the shared enemy-body rule (asserted through the
 * base-class destruction path).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { fireForEnemy } from './enemyFire';
import {
  GHOST_AMBUSH_COLOR,
  GHOST_CHASE_COLOR,
  GHOST_FLANK_COLOR,
  GHOST_SIZE,
  GHOST_PURSUIT_SPEED,
  GHOST_WANDER_COLOR,
  Ghost,
  personalityFromKey,
} from './Ghost';

class Harness extends Phaser.Scene {
  constructor() {
    super('GhostHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

describe('Ghost entity', () => {
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
    personality: 'chase' | 'ambush' | 'flank' | 'wander',
    overrides: Partial<ConstructorParameters<typeof Ghost>[1]> = {},
  ): Ghost {
    return new Ghost(s, {
      x: 100,
      y: 200,
      formationOffset: OFFSET,
      personality,
      scatterSeconds: 0,
      chaseSeconds: 100,
      wanderAngle: 0,
      ...overrides,
    });
  }

  it('maps archetype keys to personalities and defaults to chase for unknown keys', () => {
    expect(personalityFromKey('ghost-chase')).toBe('chase');
    expect(personalityFromKey('ghost-ambush')).toBe('ambush');
    expect(personalityFromKey('ghost-flank')).toBe('flank');
    expect(personalityFromKey('ghost-wander')).toBe('wander');
    expect(personalityFromKey('ghost-nonsense')).toBe('chase');
    expect(personalityFromKey('scout')).toBe('chase');
  });

  it('draws at the configured size and a personality colour', async () => {
    const s = await scene();
    const chase = make(s, 'chase');
    expect(chase.effectiveSize).toBe(GHOST_SIZE);
    expect(chase.effectiveColor).toBe(GHOST_CHASE_COLOR);
    expect(chase.archetype).toBe('ghost-chase');

    const ambush = make(s, 'ambush');
    expect(ambush.effectiveColor).toBe(GHOST_AMBUSH_COLOR);
    const flank = make(s, 'flank');
    expect(flank.effectiveColor).toBe(GHOST_FLANK_COLOR);
    const wander = make(s, 'wander');
    expect(wander.effectiveColor).toBe(GHOST_WANDER_COLOR);
    for (const g of [chase, ambush, flank, wander]) g.destroy(true);
  });

  it('never fires at any level (no fire method; dispatcher yields nothing)', async () => {
    const s = await scene();
    for (const personality of ['chase', 'ambush', 'flank', 'wander'] as const) {
      const g = make(s, personality);
      g.shootEnabled = true; // ignored
      expect(g.shootEnabled, personality).toBe(false);
      expect(g.effectiveShotPattern, personality).toBe('none');
      expect(fireForEnemy(g, `ghost-${personality}`, 5_000), personality).toEqual([]);
      // The entity has no `tryFire*` method for the dispatcher to call.
      expect((g as unknown as Record<string, unknown>)['tryFireNone']).toBeUndefined();
      expect((g as unknown as Record<string, unknown>)['tryFireAimedBullet']).toBeUndefined();
      g.destroy(true);
    }
  });

  it('pursues the player directly when in chase mode', async () => {
    const s = await scene();
    const g = make(s, 'chase');
    g.setAimTarget(400, 200);
    const before = g.x;
    for (let i = 0; i < 10; i++) g.applyFormationPosition(0, 0, 0.1, 0, 0);
    // Moved toward the player (right) at the pursuit speed.
    expect(g.x).toBeGreaterThan(before);
    expect(g.x - before).toBeCloseTo(GHOST_PURSUIT_SPEED * 1.0, 4);
    expect(g.y).toBeCloseTo(200, 4);
    g.destroy(true);
  });

  it('alternates scatter → chase on the shared timer as time elapses', async () => {
    const s = await scene();
    const g = make(s, 'chase', { scatterSeconds: 0.2, chaseSeconds: 0.2 });
    expect(g.mode).toBe('scatter');
    g.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(g.mode).toBe('scatter');
    g.applyFormationPosition(0, 0, 0.15, 0, 0);
    expect(g.mode).toBe('chase');
    g.applyFormationPosition(0, 0, 0.15, 0, 0);
    expect(g.mode).toBe('scatter');
    g.destroy(true);
  });

  it('the four personalities expose different steering targets under identical input', async () => {
    const s = await scene();
    const targets: string[] = [];
    for (const personality of ['chase', 'ambush', 'flank', 'wander'] as const) {
      const g = make(s, personality, { wanderAngle: 0 });
      // Same initial world: player to the right and moving right.
      g.setAimTarget(400, 200);
      g.setAimTarget(410, 200);
      g.applyFormationPosition(0, 0, 0.1, 0, 0);
      const t = g.getSteeringTarget();
      targets.push(`${t.x.toFixed(3)},${t.y.toFixed(3)}`);
      g.destroy(true);
    }
    expect(new Set(targets).size).toBe(4);
  });

  it('is destroyed by the shared single-hit enemy-body rule', async () => {
    const s = await scene();
    const g = make(s, 'chase');
    expect(g.health).toBe(1);
    expect(g.alive).toBe(true);
    expect(g.getHitRadius()).toBeGreaterThan(0);
    expect(g.takeDamage()).toBe(0);
    expect(g.alive).toBe(false);
    expect(g.bodyVisible).toBe(false);
    g.destroy(true);
  });
});

/**
 * Grunt entity tests (classic-arcade archetype, AH-0MV01EKTL001NRE6).
 *
 * Behaviour-focused: the entity homes on the live player with the shared
 * bounded-steering policy (so it never snap-reverses), never fires, ignores
 * the formation base (the horde is not a formation), and is destroyed by the
 * shared single-hit enemy-body rule.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { fireForEnemy } from './enemyFire';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { GRUNT_COLOR, GRUNT_SIZE } from '../scenes/core/gruntSteering';
import { GRUNT_SPEED, Grunt } from './Grunt';

class Harness extends Phaser.Scene {
  constructor() {
    super('GruntHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

describe('Grunt entity', () => {
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
    overrides: Partial<ConstructorParameters<typeof Grunt>[1]> = {},
  ): Grunt {
    return new Grunt(s, {
      x: 100,
      y: 200,
      formationOffset: OFFSET,
      rng: () => 0,
      ...overrides,
    });
  }

  it('reports the grunt archetype and draws at the shared tuning', async () => {
    const s = await scene();
    const g = make(s);
    expect(g.archetype).toBe('grunt');
    expect(g.effectiveSize).toBe(GRUNT_SIZE);
    expect(g.effectiveColor).toBe(GRUNT_COLOR);
    expect(g.homingSpeed).toBe(GRUNT_SPEED);
    g.destroy(true);
  });

  it('seeds its initial heading from the injected RNG', async () => {
    const s = await scene();
    const g = make(s, { rng: () => 0.25 });
    expect(g.heading).toBeCloseTo(0.25 * Math.PI * 2, 9);
    g.destroy(true);
  });

  it('never fires at any level (no fire method; dispatcher yields nothing)', async () => {
    const s = await scene();
    const g = make(s);
    g.shootEnabled = true; // ignored
    expect(g.shootEnabled).toBe(false);
    expect(g.effectiveShotPattern).toBe('none');
    expect(fireForEnemy(g, 'grunt', 5_000)).toEqual([]);
    // The entity has no `tryFire*` method for the dispatcher to call.
    expect((g as unknown as Record<string, unknown>)['tryFireNone']).toBeUndefined();
    expect((g as unknown as Record<string, unknown>)['tryFireAimedBullet']).toBeUndefined();
    g.destroy(true);
  });

  it('homes on the live player once a target is pushed', async () => {
    const s = await scene();
    const g = make(s);
    expect(g.hasAimTarget).toBe(false);
    g.setAimTarget(400, 200);
    expect(g.hasAimTarget).toBe(true);
    expect(g.getSteeringTarget()).toEqual({ x: 400, y: 200 });

    const before = g.x;
    for (let i = 0; i < 10; i++) g.applyFormationPosition(0, 0, 0.1, 0, 0);
    // Travelled straight at the homing speed for ~1 s toward the target.
    expect(g.x - before).toBeCloseTo(GRUNT_SPEED * 1.0, 4);
    expect(g.y).toBeCloseTo(200, 4);
    g.destroy(true);
  });

  it('turns toward the target with bounded steering (no instant reversal)', async () => {
    const s = await scene();
    const g = make(s); // heading 0 → facing +x
    // Target directly behind the grunt: a snap turn would reverse heading.
    g.setAimTarget(0, 200);
    const beforeX = g.x;
    g.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(g.heading).toBeGreaterThan(0);
    expect(g.heading).toBeLessThan(Math.PI / 2);
    // It travelled forward (x increased), not backwards toward the target.
    expect(g.x).toBeGreaterThan(beforeX);
    g.destroy(true);
  });

  it('ignores the formation base (the horde is not a formation)', async () => {
    const s = await scene();
    const g = make(s);
    g.setAimTarget(400, 200);
    const before = g.x;
    // A huge formation base must not teleport the homing grunt.
    g.applyFormationPosition(10_000, 10_000, 0.1, 500, 500);
    expect(g.x - before).toBeCloseTo(GRUNT_SPEED * 0.1, 4);
    g.destroy(true);
  });

  it('coasts straight along its heading until a target arrives', async () => {
    const s = await scene();
    const g = make(s, { heading: 0 });
    const beforeX = g.x;
    g.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(g.x - beforeX).toBeCloseTo(GRUNT_SPEED * 0.1, 4);
    expect(g.y).toBeCloseTo(200, 9);
    g.destroy(true);
  });

  it('stays inside the play area (spawns are reachable)', async () => {
    const s = await scene();
    const g = make(s, { x: 5, y: 5, heading: Math.PI });
    g.setAimTarget(0, 0);
    for (let i = 0; i < 200; i++) g.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(g.x).toBeGreaterThanOrEqual(GRUNT_SIZE / 2);
    expect(g.x).toBeLessThanOrEqual(GAME_WIDTH - GRUNT_SIZE / 2);
    expect(g.y).toBeGreaterThanOrEqual(GRUNT_SIZE / 2);
    expect(g.y).toBeLessThanOrEqual(GAME_HEIGHT - GRUNT_SIZE / 2);
    g.destroy(true);
  });

  it('is destroyed by the shared single-hit enemy-body rule', async () => {
    const s = await scene();
    const g = make(s);
    expect(g.health).toBe(1);
    expect(g.alive).toBe(true);
    expect(g.getHitRadius()).toBeGreaterThan(0);
    expect(g.takeDamage()).toBe(0);
    expect(g.alive).toBe(false);
    expect(g.bodyVisible).toBe(false);
    g.destroy(true);
  });
});

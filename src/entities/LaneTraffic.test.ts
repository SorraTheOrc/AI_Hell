/**
 * LaneTraffic entity tests (Frogger archetype, AH-0MV01EPM40008N8T).
 *
 * Behaviour-focused: the entity owns its constant-speed horizontal motion
 * with edge wrap (so the game and every gym run the same code), never fires,
 * is single-hit destructible, is a non-blocking world hazard (mineral-inert),
 * and never participates in formation movement.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { GAME_WIDTH } from '../core/constants';
import { fireForEnemy } from './enemyFire';
import {
  LANE_TRAFFIC_COLOR,
  LANE_TRAFFIC_DEFAULT_SIZE,
  LANE_TRAFFIC_DEFAULT_SPEED,
  LaneTraffic,
} from './LaneTraffic';

class Harness extends Phaser.Scene {
  constructor() {
    super('LaneTrafficHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

describe('LaneTraffic entity', () => {
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
    overrides: Partial<ConstructorParameters<typeof LaneTraffic>[1]> = {},
  ): LaneTraffic {
    return new LaneTraffic(s, {
      x: 100,
      y: 300,
      formationOffset: OFFSET,
      ...overrides,
    });
  }

  it('reports the archetype and shared default tuning', async () => {
    const s = await scene();
    const t = make(s);
    expect(t).toBeInstanceOf(LaneTraffic);
    expect(t.archetype).toBe('lane-traffic');
    expect(t.effectiveSize).toBe(LANE_TRAFFIC_DEFAULT_SIZE);
    expect(t.effectiveColor).toBe(LANE_TRAFFIC_COLOR);
    // Default travel is to the right at the default lane speed.
    expect(t.vx).toBe(LANE_TRAFFIC_DEFAULT_SPEED);
    t.destroy(true);
  });

  it('honours config-driven size/colour/speed/direction overrides', async () => {
    const s = await scene();
    const t = make(s, { size: 30, color: 0x123456, speed: 90, direction: -1 });
    expect(t.effectiveSize).toBe(30);
    expect(t.effectiveColor).toBe(0x123456);
    expect(t.vx).toBe(-90);
    t.destroy(true);
  });

  it('moves at a constant horizontal velocity and keeps its lane y fixed', async () => {
    const s = await scene();
    const t = make(s, { x: 200, y: 275, speed: 120 });
    t.updatePosition(0.5);
    expect(t.x).toBeCloseTo(200 + 60, 5);
    expect(t.y).toBe(275);
    // Same speed over the next interval: no acceleration, no drift.
    t.updatePosition(0.5);
    expect(t.x).toBeCloseTo(200 + 120, 5);
    expect(t.y).toBe(275);
    t.destroy(true);
  });

  it('wraps at both horizontal arena edges', async () => {
    const s = await scene();
    // Right edge: moves past GAME_WIDTH, reappears at the left.
    const right = make(s, { x: GAME_WIDTH - 1, y: 200, speed: 100 });
    right.updatePosition(0.1);
    expect(right.x).toBeCloseTo(9, 5);
    right.destroy(true);

    // Left edge: moves past 0, reappears at the right.
    const left = make(s, { x: 1, y: 200, speed: 100, direction: -1 });
    left.updatePosition(0.1);
    expect(left.x).toBeCloseTo(GAME_WIDTH - 9, 5);
    left.destroy(true);
  });

  it('never fires: fire dispatch resolves to tryFireNone', async () => {
    const s = await scene();
    const t = make(s);
    // Forcing the flag on is a no-op — the override pins it false.
    t.shootEnabled = true;
    expect(t.shootEnabled).toBe(false);
    expect(t.effectiveShotPattern).toBe('none');
    expect(fireForEnemy(t, 'lane-traffic', 1234)).toEqual([]);
    t.destroy(true);
  });

  it('is a single-hit hazard destroyed by one point of damage', async () => {
    const s = await scene();
    const t = make(s);
    expect(t.health).toBe(1);
    expect(t.alive).toBe(true);
    expect(t.takeDamage()).toBe(0);
    expect(t.alive).toBe(false);
    t.destroy(true);
  });

  it('does not participate in formation movement', async () => {
    const s = await scene();
    const t = make(s, { x: 200, y: 200 });
    expect(t.isFormationEnemy()).toBe(false);
    t.applyFormationPosition(500, 500, 0.016, 20, 20);
    // Position is unchanged by the no-op formation positioning.
    expect(t.x).toBe(200);
    expect(t.y).toBe(200);
    t.destroy(true);
  });

  it('is mineral-inert (hazard, like the Asteroid)', async () => {
    const s = await scene();
    const t = make(s);
    t.collectMineral();
    t.collectMineral();
    expect(t.mineralCount).toBe(0);
    expect(t.mineralRedropCount(() => 1)).toBe(0);
    t.destroy(true);
  });
});

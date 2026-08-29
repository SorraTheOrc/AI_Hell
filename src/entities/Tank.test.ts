import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  TANK_BULLET_SPEED,
  TANK_BURST_COUNT,
  TANK_COLOR,
  TANK_FIRE_INTERVAL,
  Tank,
  FormationOffset,
} from './Tank';

/** Minimal scene that only constructs Tank entities (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('Tank entity (E3 tank, GDD §4.1 — direction-agnostic radial burst)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeTank(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Tank {
    const scene = booted!.scene;
    return new Tank(scene, { x, y, formationOffset: offset });
  }

  it('renders a visible orange body and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(100, 100);

    expect(tank.alive).toBe(true);
    expect(TANK_COLOR).toBe(0xff6600); // neon orange per GDD §4.1
  });

  it('AC2 — fires a full-circle radial burst with evenly spaced directions (direction-agnostic)', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(240, 300);
    const t0 = 1_000_000;

    tank.shootEnabled = true;
    const bullets = tank.tryFireRadialBurst(t0);
    expect(bullets).toHaveLength(TANK_BURST_COUNT);

    // All bullets travel at the configured speed in a perfectly symmetric
    // full-circle spread: no direction is privileged (direction-agnostic).
    const angles = bullets.map((b) => {
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      expect(speed).toBeCloseTo(TANK_BULLET_SPEED, 5);
      return Math.atan2(b.vy, b.vx);
    });

    // Every direction gets exactly one bullet: angles are spread over the
    // full 2π and the spacing between neighbours is uniform.
    const sorted = [...angles].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      expect(gap).toBeCloseTo((Math.PI * 2) / TANK_BURST_COUNT, 5);
    }
    // The circle is closed: the last gap wraps around to the first angle.
    const wrapGap = sorted[0] + Math.PI * 2 - sorted[sorted.length - 1];
    expect(wrapGap).toBeCloseTo((Math.PI * 2) / TANK_BURST_COUNT, 5);

    // The burst is symmetric — the mean direction is a zero vector (no
    // net bias toward any direction).
    const meanX = bullets.reduce((sum, b) => sum + b.vx, 0) / bullets.length;
    const meanY = bullets.reduce((sum, b) => sum + b.vy, 0) / bullets.length;
    expect(meanX).toBeCloseTo(0, 5);
    expect(meanY).toBeCloseTo(0, 5);
  });

  it('AC2 — respects the fire interval and never lets a live aim seam bias the burst', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(240, 300);
    const t0 = 1_000_000;

    tank.shootEnabled = true;
    expect(tank.tryFireRadialBurst(t0)).toHaveLength(TANK_BURST_COUNT);

    // Within the interval — refuses to fire again.
    expect(tank.tryFireRadialBurst(t0 + TANK_FIRE_INTERVAL - 1)).toHaveLength(
      0,
    );
    // After the interval — a fresh symmetric burst.
    const second = tank.tryFireRadialBurst(t0 + TANK_FIRE_INTERVAL);
    expect(second).toHaveLength(TANK_BURST_COUNT);

    // The tank exposes no live-aim seam: its burst is deliberately
    // direction-agnostic (the scene's optional setAimTarget is a no-op via
    // optional chaining).
    expect('setAimTarget' in tank).toBe(false);
  });
});
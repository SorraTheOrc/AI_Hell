/**
 * Tests for entity hit radius calculation.
 *
 * Verifies that each enemy entity's getHitRadius() returns a value proportional
 * to its visual half-size plus the configurable HIT_RADIUS_BUFFER_PX (default 2).
 *
 * Related: AH-0MTVYCDIQ005DVAD (tighten enemy hit radii), AH-0MTYESPML001O95A.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { HIT_RADIUS_BUFFER_PX } from '../core/constants';

import { Scout } from './Scout';
import { Diver } from './Diver';
import { Tank } from './Tank';
import { PhaserEntity } from './Phaser';
import { Swarm } from './Swarm';
import { Boss } from './Boss';

// ── Fixture ──────────────────────────────────────────────────────────────

let booted: BootedGame | undefined;
let scene: Phaser.Scene;

afterEach(() => {
  if (booted?.game) {
    booted.game.destroy(true);
    booted = undefined;
  }
});

async function boot(): Promise<void> {
  class HarnessScene extends Phaser.Scene {
    constructor() {
      super('HitRadiusHarness');
    }
  }
  booted = await bootScene([HarnessScene]);
  scene = booted.scene;
}

// ── Constant ─────────────────────────────────────────────────────────────

describe('HIT_RADIUS_BUFFER_PX constant', () => {
  it('is declared as 2 px', () => {
    expect(HIT_RADIUS_BUFFER_PX).toBe(2);
  });
});

// ── Scout ────────────────────────────────────────────────────────────────

describe('Scout.getHitRadius()', () => {
  it('returns Math.ceil(SCOUT_SIZE / 2 + HIT_RADIUS_BUFFER_PX) = 10', async () => {
    await boot();
    const scout = new Scout(scene, {
      x: 0,
      y: 0,
      formationOffset: { row: 0, col: 0 },
    });
    expect(scout.getHitRadius()).toBe(10); // ceil(8 + 2)
  });
});

// ── Diver ────────────────────────────────────────────────────────────────

describe('Diver.getHitRadius()', () => {
  it('returns Math.ceil(DIVER_SIZE / 2 + HIT_RADIUS_BUFFER_PX) = 11', async () => {
    await boot();
    const diver = new Diver(scene, {
      x: 0,
      y: 0,
      formationOffset: { row: 0, col: 0 },
      burstCount: 3,
    });
    expect(diver.getHitRadius()).toBe(11); // ceil(9 + 2)
  });
});

// ── Tank ─────────────────────────────────────────────────────────────────

describe('Tank.getHitRadius()', () => {
  it('returns Math.ceil(TANK_SIZE / 2 + HIT_RADIUS_BUFFER_PX) = 16', async () => {
    await boot();
    const tank = new Tank(scene, {
      x: 0,
      y: 0,
      formationOffset: { row: 0, col: 0 },
      burstCount: 8,
    });
    expect(tank.getHitRadius()).toBe(16); // ceil(14 + 2)
  });
});

// ── Phaser ───────────────────────────────────────────────────────────────

describe('Phaser.getHitRadius()', () => {
  it('returns Math.ceil(PHASER_SIZE / 2 + HIT_RADIUS_BUFFER_PX) = 9', async () => {
    await boot();
    const phaser = new PhaserEntity(scene, {
      x: 0,
      y: 0,
      formationOffset: { row: 0, col: 0 },
      burstCount: 4,
      color: 0xff00ff,
    });
    expect(phaser.getHitRadius()).toBe(9); // ceil(7 + 2)
  });
});

// ── Swarm ────────────────────────────────────────────────────────────────

describe('Swarm.getHitRadius()', () => {
  it('returns Math.ceil(SWARM_SIZE / 2 + HIT_RADIUS_BUFFER_PX) = 10', async () => {
    await boot();
    const swarm = new Swarm(scene, {
      x: 0,
      y: 0,
      formationOffset: { row: 0, col: 0 },
    }, 0);
    expect(swarm.getHitRadius()).toBe(10); // ceil(7.5 + 2) = ceil(9.5)
  });
});

// ── Boss ─────────────────────────────────────────────────────────────────

describe('Boss.getHitRadius()', () => {
  it('returns BOSS_RADIUS + HIT_RADIUS_BUFFER_PX = 52', async () => {
    await boot();
    const boss = new Boss(scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });
    expect(boss.getHitRadius()).toBe(52); // 50 + 2
  });

  it('hit radius is >= 48px (matches visual size ~50 with buffer)', async () => {
    await boot();
    const boss = new Boss(scene, {
      x: 480,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });
    expect(boss.getHitRadius()).toBeGreaterThanOrEqual(48);
  });
});

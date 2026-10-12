/**
 * OrbitalStrike entity tests (classic-arcade archetype, AH-0MV01ENX00055CG1).
 *
 * Behaviour-focused: the entity telegraphs its impact point with a visible
 * marker for a configurable tell of at least 500 ms, then a fast projectile
 * falls to that point and detonates in a radial burst. The strike is a
 * non-blocking hazard (never registered with wave completion) and never
 * collides with or damages other enemies (matching the asteroid accounting
 * convention, GDD §2.4/§2.6).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  OrbitalStrike,
  TELEGRAPH_DURATION,
  ORBITAL_STRIKE_COLOR,
  ORBITAL_STRIKE_TELEGRAPH_COLOR,
  ORBITAL_STRIKE_BULLET_COLOR,
  ORBITAL_STRIKE_BURST_BULLET_LIFETIME,
} from './OrbitalStrike';

class Harness extends Phaser.Scene {
  constructor() {
    super('OrbitalStrikeHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

describe('OrbitalStrike entity', () => {
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
    overrides: Partial<ConstructorParameters<typeof OrbitalStrike>[1]> = {},
  ): OrbitalStrike {
    return new OrbitalStrike(s, {
      x: 480,
      y: 270,
      formationOffset: OFFSET,
      ...overrides,
    });
  }

  it('reports the orbital-strike archetype and configured tuning', async () => {
    const s = await scene();
    const strike = make(s);
    expect(strike.archetype).toBe('orbital-strike');
    expect((strike as any)._size).toBe(20);
    expect((strike as any)._color).toBe(ORBITAL_STRIKE_COLOR);
    strike.destroy(true);
  });

  it('has a telegraph duration of at least 500 ms', async () => {
    const s = await scene();
    const strike = make(s);
    expect(strike.tellDuration).toBeGreaterThanOrEqual(500);
    expect(strike.tellDuration).toBe(TELEGRAPH_DURATION);
    strike.destroy(true);
  });

  it('starts in the telegraph phase and reports isTelling', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);
    expect(strike.phase).toBe('telegraph');
    expect(strike.isTelling).toBe(true);
    strike.destroy(true);
  });

  it('transitions to the falling phase after the telegraph duration', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);

    // Drive the simulation past the telegraph duration (dt in seconds).
    strike.update((TELEGRAPH_DURATION + 100) / 1000);

    expect(strike.phase).toBe('falling');
    expect(strike.isTelling).toBe(false);
    strike.destroy(true);
  });

  it('resolves the impact point when the falling phase begins', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);

    strike.update((TELEGRAPH_DURATION + 100) / 1000);

    expect(strike.impactPoint).not.toBeNull();
    expect(strike.impactPoint!.x).toBe(500);
    expect(strike.impactPoint!.y).toBe(400);
    strike.destroy(true);
  });

  it('detonates in a radial burst when the projectile reaches the impact point', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);

    // Move into the falling phase.
    strike.update((TELEGRAPH_DURATION + 100) / 1000);
    expect(strike.phase).toBe('falling');

    // Place the projectile at/past the impact point and update.
    const falling = (strike as any)._fallingBullet;
    falling.graphics.y = 500;
    strike.update(0.016);

    expect(strike.phase).toBe('detonated');
    const burst = strike.getBurstBullets();
    expect(burst.length).toBe(6);
    for (const bullet of burst) {
      expect(bullet.color).toBe(ORBITAL_STRIKE_BULLET_COLOR);
      expect(bullet.lifetime).toBe(ORBITAL_STRIKE_BURST_BULLET_LIFETIME);
    }
    strike.destroy(true);
  });

  it('produces a radial burst with evenly spaced directions', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 4);

    strike.update((TELEGRAPH_DURATION + 100) / 1000);
    (strike as any)._fallingBullet.graphics.y = 500;
    strike.update(0.016);

    const burst = strike.getBurstBullets();
    expect(burst.length).toBe(4);
    // Adjacent bullets differ by a quarter turn each (2π / 4), allowing
    // for angle wrapping across the ±π boundary.
    const angle = (b: { vx: number; vy: number }) =>
      Math.atan2(b.vy, b.vx);
    const wrap = (a: number) => {
      let x = a;
      while (x > Math.PI) x -= Math.PI * 2;
      while (x < -Math.PI) x += Math.PI * 2;
      return x;
    };
    for (let i = 1; i < burst.length; i++) {
      const delta = wrap(angle(burst[i]) - angle(burst[i - 1]));
      expect(Math.abs(delta)).toBeCloseTo(Math.PI / 2, 5);
    }
    strike.destroy(true);
  });

  it('clears collected burst bullets', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);

    strike.update((TELEGRAPH_DURATION + 100) / 1000);
    (strike as any)._fallingBullet.graphics.y = 500;
    strike.update(0.016);

    expect(strike.getBurstBullets().length).toBeGreaterThan(0);
    strike.clearBurstBullets();
    expect(strike.getBurstBullets().length).toBe(0);
    strike.destroy(true);
  });

  it('is not registered with wave completion (non-blocking hazard)', async () => {
    // The entity exposes no wave-registration API: its only lifecycle methods
    // are update/initStrike/isActive. Its isActive() reflects its own phase,
    // never wave state, so a wave can neither stall nor clear early on it.
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);
    expect(strike.isActive()).toBe(true);
    expect(strike.alive).toBe(true);
    expect((strike as unknown as Record<string, unknown>).registerWithWave).toBeUndefined();
    strike.destroy(true);
  });

  it('never collides with or damages other enemies (no enemy-targeting API)', async () => {
    const s = await scene();
    const strike = make(s);
    strike.initStrike(500, 400, 6);
    // No damageEnemy / collideWithEnemy style seam exists on the entity.
    expect((strike as unknown as Record<string, unknown>).damageEnemy).toBeUndefined();
    expect((strike as unknown as Record<string, unknown>).collideWithEnemy).toBeUndefined();
    strike.destroy(true);
  });

  it('accepts a custom telegraph colour override', async () => {
    const s = await scene();
    const custom = 0x00ffff;
    const strike = make(s, { telegraphColor: custom });
    expect((strike as any)._telegraphColorOverride).toBe(custom);
    expect(ORBITAL_STRIKE_TELEGRAPH_COLOR).toBe(0xffffff);
    strike.destroy(true);
  });

  it('accepts custom size and health from config', async () => {
    const s = await scene();
    const strike = make(s, { size: 30, health: 3 });
    expect((strike as any)._size).toBe(30);
    expect(strike.health).toBe(3);
    strike.destroy(true);
  });
});

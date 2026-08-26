import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  buildVFormationOffsets,
  SCOUT_BULLET_COLOR,
  SCOUT_BULLET_SPEED,
  SCOUT_COLOR,
  SCOUT_FIRE_INTERVAL,
  Scout,
  FormationOffset,
} from './Scout';

/** Minimal scene that only constructs Scouts (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('buildVFormationOffsets (GDD §4.1 V-formation geometry)', () => {
  it('returns no offsets for a zero/empty formation', () => {
    expect(buildVFormationOffsets(0)).toEqual([]);
    expect(buildVFormationOffsets(-3)).toEqual([]);
  });

  it('produces the requested number of scouts', () => {
    expect(buildVFormationOffsets(6).length).toBe(6);
    expect(buildVFormationOffsets(10).length).toBe(10);
  });

  it('builds a symmetric V: row 0 has one scout, each row widens by one', () => {
    const offsets = buildVFormationOffsets(6);
    const rows = new Map<number, number>();
    for (const o of offsets) {
      rows.set(o.row, (rows.get(o.row) ?? 0) + 1);
    }
    expect(rows.get(0)).toBe(1);
    expect(rows.get(1)).toBe(2);
    expect(rows.get(2)).toBe(3);
  });

  it('spreads wings symmetrically around the apex column', () => {
    const offsets = buildVFormationOffsets(6);
    const colsByRow = new Map<number, number[]>();
    for (const o of offsets) {
      rows(colsByRow, o.row, o.col);
    }
    for (const cols of colsByRow.values()) {
      const sorted = [...cols].sort((a, b) => a - b);
      // Each row's columns are mirror-symmetric: -k..+k spaced by 2.
      expect(sorted[0] + sorted[sorted.length - 1]).toBe(0);
    }
  });
});

function rows(map: Map<number, number[]>, key: number, value: number): void {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

describe('Scout entity (visuals, firing, destruction)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  function makeScout(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Scout {
    const scene = booted!.scene;
    return new Scout(scene, { x, y, formationOffset: offset });
  }

  it('renders a visible green body and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);

    expect(scout.alive).toBe(true);
    expect(scout.bodyVisible).toBe(true);
    expect(SCOUT_COLOR).toBe(0x00ff00); // neon green per GDD §4.1
  });

  it('fires an aimed bullet only when shoot mode is enabled and the interval has elapsed', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);
    const t0 = 1_000_000;

    // Disabled — never fires.
    scout.shootEnabled = false;
    expect(scout.tryFireAimedBullet(t0)).toBeNull();

    // Enabled — fires immediately (no previous shot recorded).
    scout.shootEnabled = true;
    const bullet = scout.tryFireAimedBullet(t0);
    expect(bullet).not.toBeNull();
    expect(bullet!.color).toBe(SCOUT_BULLET_COLOR);

    // Within the fire interval — refuses to fire again.
    expect(scout.tryFireAimedBullet(t0 + SCOUT_FIRE_INTERVAL - 1)).toBeNull();

    // After the interval elapses — fires again.
    expect(scout.tryFireAimedBullet(t0 + SCOUT_FIRE_INTERVAL + 1)).not.toBeNull();
  });

  it('aims bullets at the configured target position', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    // Scout on the left; target default is bottom-centre of the screen.
    const scout = new Scout(scene, {
      x: 100,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });
    const target = scout.aimTarget;

    scout.shootEnabled = true;
    const bullet = scout.tryFireAimedBullet(1_000_000)!;

    const dist = Math.sqrt(
      (target.x - scout.x) ** 2 + (target.y - scout.y) ** 2,
    );
    const expectedVx = ((target.x - scout.x) / dist) * SCOUT_BULLET_SPEED;
    const expectedVy = ((target.y - scout.y) / dist) * SCOUT_BULLET_SPEED;

    expect(bullet.vx).toBeCloseTo(expectedVx, 5);
    expect(bullet.vy).toBeCloseTo(expectedVy, 5);
    // Scout below-left of target ⇒ the shot travels down and to the right.
    expect(bullet.vy).toBeGreaterThan(0);
    expect(bullet.vx).toBeGreaterThan(0);
  });

  it('destroySelf hides the body and plays an explosion (no-op when already destroyed)', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);

    scout.destroySelf();
    expect(scout.alive).toBe(false);
    expect(scout.bodyVisible).toBe(false);

    // Destroying twice is harmless.
    expect(() => scout.destroySelf()).not.toThrow();
  });

  it('scouts pass freely through each other — overlapping scouts neither repel nor separate (GDD §2.6)', async () => {
    booted = await bootScene([HarnessScene]);
    const left = new Scout(booted.scene, {
      x: 480,
      y: 270,
      formationOffset: { row: 0, col: 0 },
    });
    const right = new Scout(booted.scene, {
      x: 480,
      y: 270,
      formationOffset: { row: 0, col: 0 },
    });

    left.applyFormationPosition(480, 270, 0.016, 26, 22);
    right.applyFormationPosition(480, 270, 0.016, 26, 22);

    // A collision system would push overlapping bodies apart (by at least
    // one full body width). Here the scouts stay co-located: y is exact
    // (wiggle is x-only), x differs only by each scout's independent
    // ±2 px wiggle animation.
    expect(left.alive).toBe(true);
    expect(right.alive).toBe(true);
    expect(left.y).toBe(270);
    expect(right.y).toBe(270);
    expect(Math.abs(left.x - right.x)).toBeLessThanOrEqual(4.2);
  });
});
/**
 * Unit tests for the shared live-targeting seam
 * (parent AH-0MV4XFQ0J0082BN6, child AH-0MV5SDN24006SD2B).
 *
 * `pushAimTargets` and `pushSeekTargets` are the single place that pushes a
 * scene's live player position and live mineral field into its enemies
 * through the optional `setAimTarget` / `setSeekTargets` seams. They are
 * pure — no Phaser and no scene dependency — so they are asserted directly
 * here; `PlayScene`, `GymFormationScene` and `GymLevel` adopt them in
 * AH-0MV5SDNI2008RWQ2.
 */

import { describe, expect, it } from 'vitest';

import type { Mineral } from '../../entities/Mineral';
import {
  aimVectorToTarget,
  pushAimTargets,
  pushSeekTargets,
  wrappedAxisDelta,
  type LiveTargetingEnemy,
} from './enemyTargeting';

/** A structural mineral stub — the seam only reads identity/position. */
const mineral = (x: number, y: number): Mineral =>
  ({ x, y } as unknown as Mineral);

/** An enemy recording every seam call it receives. */
class RecordingEnemy implements LiveTargetingEnemy {
  readonly aim: Array<[number, number]> = [];
  readonly seek: Array<readonly Mineral[]> = [];
  readonly advanced: number[] = [];

  setAimTarget(x: number, y: number): void {
    this.aim.push([x, y]);
  }

  setSeekTargets(minerals: readonly Mineral[]): void {
    this.seek.push(minerals);
  }

  updatePosition(dt: number): void {
    this.advanced.push(dt);
  }
}

/** An enemy with no targeting seams at all — must be skipped silently. */
const bare = {} as LiveTargetingEnemy;

describe('pushAimTargets', () => {
  it('pushes the live player position to every enemy through setAimTarget', () => {
    const a = new RecordingEnemy();
    const b = new RecordingEnemy();

    pushAimTargets([a, b], { x: 123, y: 456 });

    expect(a.aim).toEqual([[123, 456]]);
    expect(b.aim).toEqual([[123, 456]]);
  });

  it('reads the live position on every call (no snapshot)', () => {
    const enemy = new RecordingEnemy();
    const player = { x: 10, y: 20 };

    pushAimTargets([enemy], player);
    player.x = 99;
    player.y = 88;
    pushAimTargets([enemy], player);

    expect(enemy.aim).toEqual([
      [10, 20],
      [99, 88],
    ]);
  });

  it('is a no-op when there is no player', () => {
    const enemy = new RecordingEnemy();

    pushAimTargets([enemy], null);

    expect(enemy.aim).toEqual([]);
  });

  it('skips enemies without the aim seam', () => {
    const enemy = new RecordingEnemy();

    expect(() => pushAimTargets([bare, enemy], { x: 1, y: 2 })).not.toThrow();
    expect(enemy.aim).toEqual([[1, 2]]);
  });

  it('pushes aim only — it never seeks or advances motion', () => {
    const enemy = new RecordingEnemy();

    pushAimTargets([enemy], { x: 5, y: 6 });

    expect(enemy.seek).toEqual([]);
    expect(enemy.advanced).toEqual([]);
  });
});

describe('pushSeekTargets', () => {
  it('forwards the live mineral field to every enemy through setSeekTargets', () => {
    const a = new RecordingEnemy();
    const b = new RecordingEnemy();
    const field = [mineral(1, 2), mineral(3, 4)];

    pushSeekTargets([a, b], field);

    expect(a.seek).toEqual([field]);
    expect(b.seek).toEqual([field]);
  });

  it("forwards the caller's field by reference so a seeker reads the live field", () => {
    const enemy = new RecordingEnemy();
    const field: Mineral[] = [mineral(1, 1)];

    pushSeekTargets([enemy], field);
    field.push(mineral(9, 9));

    // The seam receives the exact live array, not a defensive copy: the
    // Harvester's nearest-mineral selection then observes in-place changes.
    expect(enemy.seek[0]).toBe(field);
    expect(enemy.seek[0]).toHaveLength(2);
  });

  it('pushes an empty field too, so a seeker clears its target', () => {
    const enemy = new RecordingEnemy();

    pushSeekTargets([enemy], []);

    expect(enemy.seek).toEqual([[]]);
  });

  it('skips enemies without the seek seam', () => {
    const enemy = new RecordingEnemy();

    expect(() => pushSeekTargets([bare, enemy], [])).not.toThrow();
    expect(enemy.seek).toHaveLength(1);
  });

  it('pushes seek only — it never aims or advances motion', () => {
    const enemy = new RecordingEnemy();

    pushSeekTargets([enemy], []);

    expect(enemy.aim).toEqual([]);
    expect(enemy.advanced).toEqual([]);
  });
});

describe('live-targeting seam — scene-agnostic contract', () => {
  it('accepts a readonly enemy list, so a scene never copies its field', () => {
    const enemies = Object.freeze([
      new RecordingEnemy(),
    ]) as readonly LiveTargetingEnemy[];

    expect(() => {
      pushAimTargets(enemies, { x: 0, y: 0 });
      pushSeekTargets(enemies, []);
    }).not.toThrow();
  });

  it('does not mutate the enemies list', () => {
    const enemies = [new RecordingEnemy()];
    const before = [...enemies];

    pushAimTargets(enemies, { x: 1, y: 2 });
    pushSeekTargets(enemies, []);

    expect(enemies).toEqual(before);
  });
});

// ── Seam-aware aim maths (AH-0MVKXBTNJ003F1TC, parent AH-0MV9G3DZ9003P7P8) ──

/**
 * The playfield wrap model: the same `GAME_WIDTH` × `GAME_HEIGHT` period the
 * enemy bullets wrap on.
 */
const WORLD = { width: 960, height: 540 } as const;

const point = (x: number, y: number) => ({ x, y });

describe('wrappedAxisDelta', () => {
  it('returns the direct delta mid-arena (the direct line is already shortest)', () => {
    expect(wrappedAxisDelta(400, 500, 960)).toBe(100);
    expect(wrappedAxisDelta(500, 400, 960)).toBe(-100);
  });

  it('crosses the horizontal seam when the opposite edge is nearer', () => {
    // 900 − 100 = 800 > 960 / 2, so the shortest route is 160 px to the left.
    expect(wrappedAxisDelta(100, 900, 960)).toBe(-160);
    expect(wrappedAxisDelta(900, 100, 960)).toBe(160);
  });

  it('crosses the vertical seam with the height period', () => {
    // 500 − 50 = 450 > 540 / 2, so the shortest route is 90 px upwards.
    expect(wrappedAxisDelta(50, 500, 540)).toBe(-90);
    expect(wrappedAxisDelta(500, 50, 540)).toBe(90);
  });

  it('keeps the direct delta at exactly half the axis (a tie, never an arbitrary flip)', () => {
    expect(wrappedAxisDelta(0, 480, 960)).toBe(480);
    expect(wrappedAxisDelta(480, 0, 960)).toBe(-480);
  });

  it('returns the direct delta when there is no wrap model (defensive)', () => {
    expect(wrappedAxisDelta(0, 100, 0)).toBe(100);
    expect(wrappedAxisDelta(0, 100, -960)).toBe(100);
    expect(wrappedAxisDelta(0, 100, Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe('aimVectorToTarget — shortest wrapped path', () => {
  it('aims a wrap-aware enemy across the left/right seam', () => {
    const aim = aimVectorToTarget(point(100, 270), point(900, 270), true, WORLD);

    expect(aim.dx).toBe(-160);
    expect(aim.dy).toBe(0);
    expect(aim.distance).toBeCloseTo(160, 12);
    // Fires to the left (out of the left edge, arriving from the right) —
    // NOT the long 800 px line to the right.
    expect(aim.heading).toBeCloseTo(Math.PI, 12);
  });

  it('aims across the right/left seam in the opposite direction', () => {
    const aim = aimVectorToTarget(point(860, 270), point(60, 270), true, WORLD);

    expect(aim.dx).toBe(160);
    expect(aim.heading).toBeCloseTo(0, 12);
  });

  it('aims across the top/bottom seam', () => {
    const aim = aimVectorToTarget(point(480, 50), point(480, 500), true, WORLD);

    expect(aim.dx).toBe(0);
    expect(aim.dy).toBe(-90);
    expect(aim.heading).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('aims across the bottom/top seam', () => {
    const aim = aimVectorToTarget(point(480, 500), point(480, 50), true, WORLD);

    expect(aim.dy).toBe(90);
    expect(aim.heading).toBeCloseTo(Math.PI / 2, 12);
  });

  it('wraps both axes in the same shot (corner-to-corner through two seams)', () => {
    const aim = aimVectorToTarget(point(100, 50), point(900, 500), true, WORLD);

    expect(aim.dx).toBe(-160);
    expect(aim.dy).toBe(-90);
    expect(aim.distance).toBeCloseTo(Math.hypot(160, 90), 12);
    expect(aim.heading).toBeCloseTo(Math.atan2(-90, -160), 12);
  });

  it('keeps the direct aim mid-arena for a wrap-aware enemy (no behaviour change)', () => {
    const aim = aimVectorToTarget(point(400, 270), point(500, 300), true, WORLD);

    expect(aim.dx).toBe(100);
    expect(aim.dy).toBe(30);
    expect(aim.heading).toBe(Math.atan2(30, 100));
  });

  it('keeps the direct aim bit-identically for a non-aware enemy, across the seam too', () => {
    const aim = aimVectorToTarget(point(100, 200), point(900, 500), false, WORLD);

    expect(aim.dx).toBe(800);
    expect(aim.dy).toBe(300);
    expect(aim.distance).toBe(Math.sqrt(800 * 800 + 300 * 300));
    expect(aim.heading).toBe(Math.atan2(300, 800));
  });

  it('never divides by zero when the enemy sits on the target', () => {
    expect(
      aimVectorToTarget(point(400, 300), point(400, 300), true, WORLD),
    ).toEqual({ dx: 0, dy: 0, distance: 1, heading: 0 });
    expect(
      aimVectorToTarget(point(400, 300), point(400, 300), false, WORLD),
    ).toEqual({ dx: 0, dy: 0, distance: 1, heading: 0 });
  });

  it('is pure: it reads the positions without mutating them', () => {
    const from = Object.freeze(point(100, 50));
    const to = Object.freeze(point(900, 500));

    expect(() => aimVectorToTarget(from, to, true, WORLD)).not.toThrow();
    expect(from).toEqual({ x: 100, y: 50 });
    expect(to).toEqual({ x: 900, y: 500 });
  });
});

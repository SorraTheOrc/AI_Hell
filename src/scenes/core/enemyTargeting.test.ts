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
  pushAimTargets,
  pushSeekTargets,
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

/**
 * Wrap-aware enemy movement — test-first contract
 * (AH-0MVKXBV0O005Q77P, parent AH-0MV9G3DZ9003P7P8, AC3 + AC5).
 *
 * **TEST-FIRST → GREEN.** Pinned in Vitest's `it.fails` (the repo's
 * red-before/green-after convention — see `src/core/enemyForceField.test.ts`
 * and `src/core/levelScaling.test.ts`) before the shared post-motion wrap
 * existed; the implementation item (AH-0MVKXBWDY008R0YH) created the module
 * and flipped every case back to `it` (a leftover `it.fails` would now fail
 * the suite). The module is imported statically so the compiler also holds
 * it to the pinned surface.
 *
 * ## Pinned contract (AH-0MVKXBWDY008R0YH must match exactly)
 *
 * `src/scenes/core/enemyWrap.ts` — Phaser-free, pure, deterministic, no I/O.
 * It **re-uses** `WrapWorld` from `./enemyTargeting` (one wrap model, no
 * second copy):
 *
 * - `wrapPosition(x, y, world): { x, y }` — four-edge wrap of a point into
 *   `[0, world.width) × [0, world.height)`, matching the player/asteroid
 *   model. An exact multiple of the period maps to `0`; any overshoot —
 *   including more than one period — wraps by modulo. A non-finite or
 *   non-positive axis length means "no wrap model" for that axis: that
 *   coordinate is returned unchanged (defensive, mirrors `wrappedAxisDelta`).
 * - `applyPostMotionWrap(body, world): boolean` — the single shared
 *   post-motion step. When `body.wrapAware` is `true` it writes
 *   `wrapPosition(...)` through `body.setPosition(x, y)` (exactly one call)
 *   and returns `true`; when `false` it writes nothing and returns `false`.
 *   It is **position-only**: it never reads or writes velocity, heading,
 *   rotation or any other state field.
 * - `applyPostMotionWrapAll(bodies, world): number` — applies the seam to a
 *   scene's live entity list and returns how many bodies were wrapped.
 * - `WrapAwareBody` — structural contract
 *   `{ x, y, readonly wrapAware, setPosition(x, y) }`, satisfied by every
 *   `BaseEnemy`, so the scene loop needs no per-archetype adapter.
 *
 * The shared scene loops (`PlayScene._moveEnemies` and
 * `GymFormationScene.tick`) call `applyPostMotionWrapAll` once after their
 * positioning pass, so the game and every gym run the same post-motion step.
 *
 * @module scenes/core/enemyWrap.test
 */

import { afterAll, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { Asteroid } from '../../entities/Asteroid';
import { Diver } from '../../entities/Diver';
import { Ghost } from '../../entities/Ghost';
import { Grunt } from '../../entities/Grunt';
import { Harvester } from '../../entities/Harvester';
import { PhaserEntity } from '../../entities/Phaser';
import { Scout } from '../../entities/Scout';
import { Swarm } from '../../entities/Swarm';
import { Tank } from '../../entities/Tank';
import { createReusableBoot } from '../../test/gameHarness';
import { centipedeArena } from '../../waves/CentipedeSpawner';
import { createCentipedeSegment } from '../gym/core/centipedeFormation';
import { CentipedeChain } from './centipedeChain';
import type { WrapWorld } from './enemyTargeting';
import {
  applyPostMotionWrap,
  applyPostMotionWrapAll,
  wrapPosition,
} from './enemyWrap';
import { advanceMarch, createMarchState } from './marchFormation';

/**
 * The shared post-motion wrap surface this suite pins. Imported statically
 * now that the seam exists (AH-0MVKXBWDY008R0YH), so the compiler — not only
 * the runtime — holds the implementation to the contract.
 */
interface WrapAwareBody {
  x: number;
  y: number;
  readonly wrapAware: boolean;
  setPosition(x: number, y: number): void;
}

/** The playfield wrap model: the same period enemy bullets and the player wrap on. */
const WORLD: WrapWorld = { width: GAME_WIDTH, height: GAME_HEIGHT };
const OFFSET = { row: 0, col: 0 };

const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('EnemyWrapHarness');
  }
}

/**
 * Records every write the seam makes and carries sentinel motion fields, so a
 * position-only seam can be distinguished from one that also reflects or
 * rewrites velocity.
 */
class RecordingBody implements WrapAwareBody {
  x: number;
  y: number;
  readonly wrapAware: boolean;
  readonly writes: Array<[number, number]> = [];
  readonly vx = 11;
  readonly vy = -7;
  readonly heading = 0.5;

  constructor(x: number, y: number, wrapAware = true) {
    this.x = x;
    this.y = y;
    this.wrapAware = wrapAware;
  }

  setPosition(x: number, y: number): void {
    this.writes.push([x, y]);
    this.x = x;
    this.y = y;
  }
}

// ── The pure wrap maths ─────────────────────────────────────────────

describe('wrapPosition — pure four-edge wrap', () => {
  it('wraps a point that crosses the right edge to the left', async () => {

    expect(wrapPosition(GAME_WIDTH + 40, 100, WORLD)).toEqual({
      x: 40,
      y: 100,
    });
  });

  it('wraps a point that crosses the left edge to the right', async () => {

    expect(wrapPosition(-40, 100, WORLD)).toEqual({
      x: GAME_WIDTH - 40,
      y: 100,
    });
  });

  it('wraps a point that crosses the bottom edge to the top', async () => {

    expect(wrapPosition(100, GAME_HEIGHT + 40, WORLD)).toEqual({
      x: 100,
      y: 40,
    });
  });

  it('wraps a point that crosses the top edge to the bottom', async () => {

    expect(wrapPosition(100, -40, WORLD)).toEqual({
      x: 100,
      y: GAME_HEIGHT - 40,
    });
  });

  it('wraps both axes when a corner overshoots two edges at once', async () => {

    expect(wrapPosition(GAME_WIDTH + 5, -5, WORLD)).toEqual({ x: 5, y: GAME_HEIGHT - 5 });
  });

  it('maps an exact boundary to the wrap origin', async () => {

    expect(wrapPosition(GAME_WIDTH, GAME_HEIGHT, WORLD)).toEqual({ x: 0, y: 0 });
    expect(wrapPosition(0, 0, WORLD)).toEqual({ x: 0, y: 0 });
    expect(wrapPosition(-GAME_WIDTH, -GAME_HEIGHT, WORLD)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it('wraps a multi-period overshoot by modulo, not by one edge', async () => {

    expect(
      wrapPosition(-GAME_WIDTH * 2 - 30, GAME_HEIGHT * 3 + 45, WORLD),
    ).toEqual({ x: GAME_WIDTH - 30, y: 45 });
  });

  it('returns coordinates unchanged when the world has no wrap model', async () => {

    expect(wrapPosition(1234, -5, { width: 0, height: Number.NaN })).toEqual({
      x: 1234,
      y: -5,
    });
    expect(wrapPosition(-9876, 5432, { width: -960, height: 0 })).toEqual({
      x: -9876,
      y: 5432,
    });
  });
});

// ── The shared post-motion seam ─────────────────────────────────────

describe('applyPostMotionWrap — the single shared post-motion step', () => {
  it('wraps a wrap-aware body across the edge and reports the move', async () => {
    const body = new RecordingBody(-40, 100);

    expect(applyPostMotionWrap(body, WORLD)).toBe(true);
    expect(body.x).toBe(GAME_WIDTH - 40);
    expect(body.y).toBe(100);
    expect(body.writes).toEqual([[GAME_WIDTH - 40, 100]]);
  });

  it('never wraps a non-aware body, even far outside the arena bounds', async () => {
    const body = new RecordingBody(-100, GAME_HEIGHT + 100, false);

    expect(applyPostMotionWrap(body, WORLD)).toBe(false);
    expect(body.x).toBe(-100);
    expect(body.y).toBe(GAME_HEIGHT + 100);
    expect(body.writes).toEqual([]);
  });

  it('leaves every non-position field alone (velocity and heading preserved)', async () => {
    const body = new RecordingBody(GAME_WIDTH + 5, 100);

    expect(applyPostMotionWrap(body, WORLD)).toBe(true);
    expect(body.vx).toBe(11);
    expect(body.vy).toBe(-7);
    expect(body.heading).toBe(0.5);
  });

  it('applies the seam to a whole scene list and counts only the wrapped bodies', async () => {
    const aware = new RecordingBody(GAME_WIDTH + 5, 100);
    const unaware = new RecordingBody(GAME_WIDTH + 5, 100, false);
    const awareTop = new RecordingBody(100, -5);

    expect(applyPostMotionWrapAll([aware, unaware, awareTop], WORLD)).toBe(2);
    expect(aware.x).toBe(5);
    expect(unaware.x).toBe(GAME_WIDTH + 5);
    expect(unaware.writes).toEqual([]);
    expect(awareTop.y).toBe(GAME_HEIGHT - 5);
  });

  it('leaves a non-aware archetype position untouched at the seam', async () => {
    const { scene } = await reuse.boot([HarnessScene]);
    // The classic march archetype is wrap-aware: false (seed exclusion).
    const march = new Scout(scene, {
      x: GAME_WIDTH + 5,
      y: -5,
      formationOffset: OFFSET,
      wrapAware: false,
    });

    expect(march.wrapAware).toBe(false);
    expect(applyPostMotionWrap(march, WORLD)).toBe(false);
    expect(march.x).toBe(GAME_WIDTH + 5);
    expect(march.y).toBe(-5);
  });
});

// ── Every wrap-aware movement class at the seam ─────────────────────

/** One edge overshoot case: `from` is outside, `to` is the opposite edge. */
const EDGES = [
  { edge: 'right', from: { x: GAME_WIDTH + 40, y: 100 }, to: { x: 40, y: 100 } },
  {
    edge: 'left',
    from: { x: -40, y: 100 },
    to: { x: GAME_WIDTH - 40, y: 100 },
  },
  {
    edge: 'bottom',
    from: { x: 100, y: GAME_HEIGHT + 40 },
    to: { x: 100, y: 40 },
  },
  {
    edge: 'top',
    from: { x: 100, y: -40 },
    to: { x: 100, y: GAME_HEIGHT - 40 },
  },
] as const;

/** One wrap-aware movement class and the shipped entity that carries it. */
interface MovementClassCase {
  readonly movementClass: string;
  make(scene: Phaser.Scene, x: number, y: number): WrapAwareBody;
}

const WRAP_AWARE_CLASSES: readonly MovementClassCase[] = [
  {
    movementClass: 'dive',
    make: (scene, x, y) => new Diver(scene, { x, y, formationOffset: OFFSET }),
  },
  {
    movementClass: 'chase',
    make: (scene, x, y) => new Grunt(scene, { x, y, formationOffset: OFFSET }),
  },
  {
    movementClass: 'chase (ghost personality)',
    make: (scene, x, y) =>
      new Ghost(scene, {
        x,
        y,
        formationOffset: OFFSET,
        personality: 'chase',
      }),
  },
  {
    movementClass: 'orbit',
    make: (scene, x, y) =>
      new PhaserEntity(scene, { x, y, formationOffset: OFFSET }),
  },
  {
    movementClass: 'drift',
    make: (scene, x, y) =>
      new Swarm(scene, { x, y, formationOffset: OFFSET }, 0),
  },
  {
    movementClass: 'roam',
    make: (scene, x, y) =>
      new Asteroid(scene, { x, y, formationOffset: OFFSET }),
  },
  {
    movementClass: 'roam (mineral seeker)',
    make: (scene, x, y) =>
      new Harvester(scene, { x, y, formationOffset: OFFSET }),
  },
  {
    movementClass: 'hold-and-move',
    make: (scene, x, y) => new Tank(scene, { x, y, formationOffset: OFFSET }),
  },
];

describe.each(WRAP_AWARE_CLASSES)(
  'wrap-aware movement class: $movementClass',
  ({ movementClass, make }) => {
    it(
      `wraps a ${movementClass} entity across each of the four edges`,
      async () => {
        const { scene } = await reuse.boot([HarnessScene]);

        for (const { edge, from, to } of EDGES) {
          const body = make(scene, from.x, from.y);
          const label = `${movementClass} (${edge})`;

          expect(body.wrapAware, `${label} is wrap-aware by default`).toBe(true);
          expect(applyPostMotionWrap(body, WORLD), label).toBe(true);
          expect(body.x, `${label} x`).toBe(to.x);
          expect(body.y, `${label} y`).toBe(to.y);
        }
      },
    );
  },
);

describe('post-motion seam — position only', () => {
  it('preserves a grunt heading and an asteroid velocity when wrapping', async () => {
    const { scene } = await reuse.boot([HarnessScene]);

    const grunt = new Grunt(scene, {
      x: GAME_WIDTH + 5,
      y: 100,
      formationOffset: OFFSET,
      heading: 1.25,
    });
    const heading = grunt.heading;
    expect(applyPostMotionWrap(grunt, WORLD)).toBe(true);
    expect(grunt.x).toBe(5);
    expect(grunt.heading).toBe(heading);

    const asteroid = new Asteroid(scene, {
      x: GAME_WIDTH + 5,
      y: 100,
      formationOffset: OFFSET,
      vx: 12,
      vy: -7,
    });
    expect(applyPostMotionWrap(asteroid, WORLD)).toBe(true);
    expect(asteroid.vx).toBe(12);
    expect(asteroid.vy).toBe(-7);
  });
});

// ── The classic-arcade exclusions stay bounded ──────────────────────

describe('classic-arcade exclusions remain bounded', () => {
  it(
    'keeps march reversing and dropping at the arena edge, never wrapped by the seam',
    async () => {
      const { scene } = await reuse.boot([HarnessScene]);

      // The shared march law (primary pin: marchFormation.test.ts) still
      // reverses at the right bound and drops one row; the seam must not
      // turn that bounded behaviour into a wrap.
      const options = {
        step: 10,
        drop: 5,
        referenceSpeed: 10,
        minX: 0,
        maxX: 15,
        initialCount: 1,
      };
      let state = createMarchState(10, 100, 1);
      state = advanceMarch(state, 1, 1, options);
      expect(state.x).toBe(15);
      expect(state.dir).toBe(-1);
      expect(state.y).toBe(105);

      // A march enemy parked beyond the edge is non-aware and stays put.
      const march = new Scout(scene, {
        x: GAME_WIDTH + 5,
        y: 100,
        formationOffset: OFFSET,
        wrapAware: false,
      });
      expect(march.wrapAware).toBe(false);
      expect(applyPostMotionWrap(march, WORLD)).toBe(false);
      expect(march.x).toBe(GAME_WIDTH + 5);
    },
  );

  it(
    'keeps centipede weaving within its arena bounds, never wrapped by the seam',
    async () => {
      const { scene } = await reuse.boot([HarnessScene]);
      const arena = centipedeArena(GAME_WIDTH, GAME_HEIGHT);
      // Start the lead just inside the right bound so it reaches the wall and
      // reverses within the loop — the point is to observe the *turn*, not to
      // march the whole arena width first.
      const chain = new CentipedeChain({
        startX: arena.maxX - 5,
        startY: arena.minY,
        arena,
        segmentCount: 3,
        spacing: 20,
        lateralSpeed: 90,
        descentSpeed: 16,
        initialDir: 1,
      });

      // The chain still weaves inside the arena bounds (the existing chain
      // law). Only the *lead* is bounded by the triangle wave: followers are
      // placed a fixed arc-length behind it along the recorded path, so at
      // spawn they trail back past `startX` and can sit left of `minX` before
      // the chain has travelled far enough. What matters for this contract is
      // that the weave stays bounded and the seam never wraps it.
      let turned = false;
      let previousX = chain.segment(0)!.x;
      for (let i = 0; i < 60; i++) {
        chain.advance(0.05);
        const leadX = chain.segment(0)!.x;
        if (leadX < previousX) turned = true;
        previousX = leadX;
        expect(leadX).toBeGreaterThanOrEqual(arena.minX - 1e-6);
        expect(leadX).toBeLessThanOrEqual(arena.maxX + 1e-6);
      }
      expect(turned).toBe(true);

      // The shipped centipede segment is non-aware: the seam never wraps it.
      const segment = createCentipedeSegment(scene, 0, 0, OFFSET);
      expect(segment.wrapAware).toBe(false);
      segment.setPosition(GAME_WIDTH + 5, -5);
      expect(applyPostMotionWrap(segment, WORLD)).toBe(false);
      expect(segment.x).toBe(GAME_WIDTH + 5);
      expect(segment.y).toBe(-5);
    },
  );
});

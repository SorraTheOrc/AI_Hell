/**
 * Orbital Strike bolt VFX contract tests (AH-0MVS2SW8V007ZBJQ).
 *
 * **TEST-FIRST.** This suite pins the strike's visual identity **before** the
 * implementation exists: `src/vfx/orbitalStrike.ts` is authored by the sibling
 * item **AH-0MVS2SXTM000H5PL** (wired into the shared strike path by
 * AH-0MVS2T0VQ00973W5). Every case was wrapped in Vitest's `it.fails` (the
 * repo's red-before/green-after convention — see `src/core/levelScaling.test.ts`
 * and `src/scenes/core/miniBossDeathSweep.test.ts`) so the suite stayed green
 * on pre-change HEAD; the implementation item **flipped every `it.fails` back
 * to `it`** once the module landed, and a leftover `it.fails` would have failed
 * the suite. The module here is loaded through a non-literal dynamic import on
 * purpose: a static `import './orbitalStrike'` would fail `tsc --noEmit` (and
 * therefore the build) while the module does not exist yet.
 *
 * ## Pinned contract (AH-0MVS2SXTM000H5PL must match exactly)
 *
 * `src/vfx/orbitalStrike.ts` — the same scene-agnostic helper shape as
 * `aoeEffect.ts` / `thornsAbsorb.ts`: exported constants plus one spawn
 * function returning a handle.
 *
 * - `ORBITAL_STRIKE_COLOR` — the strike's own colour (Phaser integer).
 * - `ORBITAL_STRIKE_DURATION` — total effect lifetime in **seconds**
 *   (`<= 0.35`, so back-to-back permanent pulses never stack into a wash).
 * - `ORBITAL_STRIKE_BOLT_WIDTH` — the descending bolt column's widest drawn
 *   extent in px (the effect is capped to the target column).
 * - `ORBITAL_STRIKE_MARKER_RADIUS` — the target marker / impact flash radius
 *   in px (the effect never draws wider than this around the impact point).
 * - `ORBITAL_STRIKE_DEPTH` — render depth, above the fight.
 * - `spawnOrbitalStrike(scene, x, y, options?)` → handle with
 *   `{ graphics, isComplete() }`; `options` carries an optional caller-owned
 *   `registry`, plus `duration` / `color` overrides.
 *
 * Composition contract (all code-drawn Graphics, no textures):
 *
 * - The Graphics is **positioned at the impact point** `(x, y)` and the
 *   composition is drawn in local coordinates around the origin.
 * - A **descending bolt column**: a vertical shape (straight vertical segment
 *   or a filled rect) that starts **well above** the impact point and runs
 *   down to it, drawn only within `±ORBITAL_STRIKE_BOLT_WIDTH` of the target
 *   column.
 * - A **target marker** at the impact point: a stroked shape at least 8 × 8 px
 *   inside `ORBITAL_STRIKE_MARKER_RADIUS` — a reticle the player can read
 *   while the bolt is still in the air.
 * - An **impact flash**: a filled shape (`FILL_PATH` / `FILL_TRIANGLE`) at the
 *   impact point.
 * - Nothing is drawn outside `±ORBITAL_STRIKE_MARKER_RADIUS` in x: the bolt is
 *   a column, never a screen-wide flash.
 * - Teardown matches the shared pattern: the Graphics is appended to the
 *   caller registry on spawn, removed and destroyed when the effect completes,
 *   and `isComplete()` reports true only after that teardown.
 *
 * Distinctness from the Smart Bomb ring is **geometric**, never colour-based:
 * `spawnNovaRing` emits concentric arcs and no vertical column, so the two
 * effects stay distinguishable even when forced to the same colour.
 *
 * @module vfx/orbitalStrike.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import * as effectsModule from '../audio/effects';
import { NOVA_RING_DURATION, spawnNovaRing } from './aoeEffect';

// ── The not-yet-existing module, via a non-literal dynamic import ───

/** Options accepted by {@link OrbitalStrikeContract.spawnOrbitalStrike}. */
interface OrbitalStrikeOptions {
  registry?: Phaser.GameObjects.Graphics[];
  duration?: number;
  color?: number;
}

/** Handle returned by the strike spawner. */
interface OrbitalStrikeHandle {
  readonly graphics: Phaser.GameObjects.Graphics;
  isComplete(): boolean;
}

/** The `src/vfx/orbitalStrike.ts` surface this suite pins. */
interface OrbitalStrikeContract {
  ORBITAL_STRIKE_COLOR: number;
  ORBITAL_STRIKE_DURATION: number;
  ORBITAL_STRIKE_BOLT_WIDTH: number;
  ORBITAL_STRIKE_MARKER_RADIUS: number;
  ORBITAL_STRIKE_DEPTH: number;
  spawnOrbitalStrike(
    scene: Phaser.Scene,
    x: number,
    y: number,
    options?: OrbitalStrikeOptions,
  ): OrbitalStrikeHandle;
}

/** Non-literal specifier so TypeScript does not resolve the missing module. */
const ORBITAL_STRIKE_MODULE = './orbitalStrike';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function strikeModule(): Promise<OrbitalStrikeContract> {
  return (await import(ORBITAL_STRIKE_MODULE)) as OrbitalStrikeContract;
}

// ── Graphics command-buffer geometry reader ─────────────────────────

/**
 * Phaser Graphics opcodes (`node_modules/phaser/src/gameobjects/graphics/
 * Commands.js`) with their argument counts, so the buffer can be walked
 * without desynchronising on any op.
 */
const OPCODE_ARG_COUNT: Record<number, number> = {
  0: 7, // ARC (x, y, radius, start, end, anticlockwise, overshoot)
  1: 0, // BEGIN_PATH
  2: 0, // CLOSE_PATH
  3: 4, // FILL_RECT (x, y, width, height)
  4: 2, // LINE_TO
  5: 2, // MOVE_TO
  6: 3, // LINE_STYLE (width, colour, alpha)
  7: 2, // FILL_STYLE (colour, alpha)
  8: 0, // FILL_PATH
  9: 0, // STROKE_PATH
  10: 6, // FILL_TRIANGLE
  11: 6, // STROKE_TRIANGLE
  14: 0, // SAVE
  15: 0, // RESTORE
  16: 2, // TRANSLATE
  17: 2, // SCALE
  18: 1, // ROTATE
  21: 8, // GRADIENT_FILL_STYLE
  22: 5, // GRADIENT_LINE_STYLE
};

/** One drawn path: its vertices plus whether it was stroked or filled. */
interface DrawnPath {
  points: Array<{ x: number; y: number }>;
  stroked: boolean;
  filled: boolean;
}

/** A vertical column: drawn from `top` down to `bottom` at `x`. */
interface VerticalColumn {
  x: number;
  top: number;
  bottom: number;
  height: number;
  halfWidth: number;
}

/** Walks a Graphics command buffer into drawable paths. */
function readPaths(graphics: Phaser.GameObjects.Graphics): DrawnPath[] {
  const buf = graphics.commandBuffer as number[];
  const paths: DrawnPath[] = [];
  let current: DrawnPath = { points: [], stroked: false, filled: false };

  const flush = (): void => {
    if (current.points.length > 0 || current.stroked || current.filled) {
      paths.push(current);
    }
    current = { points: [], stroked: false, filled: false };
  };

  for (let i = 0; i < buf.length; i += 1 + (OPCODE_ARG_COUNT[buf[i]] ?? 0)) {
    const op = buf[i];
    switch (op) {
      case 0: {
        // An ARC carries the centre, so a stroked circle contributes its
        // centre *and* its radius to the path's extent.
        const [x, y, radius] = [buf[i + 1], buf[i + 2], buf[i + 3]];
        current.points.push(
          { x: x - radius, y: y - radius },
          { x: x + radius, y: y + radius },
        );
        break;
      }
      case 3:
        // FILL_RECT is a self-contained filled shape (x, y, w, h).
        paths.push({
          points: [
            { x: buf[i + 1], y: buf[i + 2] },
            { x: buf[i + 1] + buf[i + 3], y: buf[i + 2] + buf[i + 4] },
          ],
          stroked: false,
          filled: true,
        });
        break;
      case 4:
      case 5:
        current.points.push({ x: buf[i + 1], y: buf[i + 2] });
        break;
      case 8:
        current.filled = true;
        break;
      case 9:
        current.stroked = true;
        break;
      case 10:
      case 11:
        paths.push({
          points: [
            { x: buf[i + 1], y: buf[i + 2] },
            { x: buf[i + 3], y: buf[i + 4] },
            { x: buf[i + 5], y: buf[i + 6] },
          ],
          stroked: op === 11,
          filled: op === 10,
        });
        break;
      default:
        break;
    }
  }
  flush();
  return paths;
}

/** Bounding box of every point drawn in a set of paths. */
function boundsOf(paths: readonly DrawnPath[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const points = paths.flatMap((path) => path.points);
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

/** Counts the filled shapes (`FILL_PATH` / `FILL_TRIANGLE`) in a buffer. */
function filledShapeCount(graphics: Phaser.GameObjects.Graphics): number {
  const buf = graphics.commandBuffer as number[];
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (OPCODE_ARG_COUNT[buf[i]] ?? 0)) {
    if (buf[i] === 8 || buf[i] === 10) count += 1;
  }
  return count;
}

/**
 * The vertical columns a composition draws: consecutive straight vertical
 * segments the height of at least `minHeight` px, plus tall filled rects.
 * Returns one entry per column drawn (its x, top, bottom, height/width).
 */
function verticalColumns(
  graphics: Phaser.GameObjects.Graphics,
  minHeight: number,
): VerticalColumn[] {
  const columns: VerticalColumn[] = [];
  for (const path of readPaths(graphics)) {
    for (let i = 1; i < path.points.length; i += 1) {
      const a = path.points[i - 1];
      const b = path.points[i];
      const height = Math.abs(b.y - a.y);
      if (Math.abs(b.x - a.x) <= 1 && height >= minHeight) {
        const xs = [a.x, b.x];
        columns.push({
          x: (a.x + b.x) / 2,
          top: Math.min(a.y, b.y),
          bottom: Math.max(a.y, b.y),
          height,
          halfWidth: Math.max(...xs) - Math.min(...xs),
        });
      }
    }
    // A tall filled rect is the other legitimate way to draw the column.
    if (path.filled && path.points.length === 2) {
      const width = Math.abs(path.points[1].x - path.points[0].x);
      const height = Math.abs(path.points[1].y - path.points[0].y);
      if (height >= minHeight && width <= 8 * 20) {
        const centre = (path.points[0].x + path.points[1].x) / 2;
        columns.push({
          x: centre,
          top: Math.min(path.points[0].y, path.points[1].y),
          bottom: Math.max(path.points[0].y, path.points[1].y),
          height,
          halfWidth: width / 2,
        });
      }
    }
  }
  return columns;
}

// ── Fixtures ────────────────────────────────────────────────────────

/** The strike target used by every fixture below. */
const TARGET_X = 420;
const TARGET_Y = 300;

/** A column must be at least this tall to read as a bolt from off-screen. */
const MIN_COLUMN_HEIGHT = 100;

/** Minimal bootable scene for the VFX helper. */
class StrikeVfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'OrbitalStrikeVfxStubScene' });
  }
}

/** A captured tween config (the surface the teardown assertions drive). */
interface CapturedTween {
  duration: number;
  onComplete?: () => void;
}

describe('orbitalStrike — descending bolt composition (AH-0MVS2SXTM000H5PL)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([StrikeVfxStubScene]);
    return booted.scene;
  }

  it('spawns the bolt at the impact point and registers it for teardown', async () => {
    const { spawnOrbitalStrike } = await strikeModule();
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y, { registry });

    expect(handle.graphics.x).toBe(TARGET_X);
    expect(handle.graphics.y).toBe(TARGET_Y);
    expect(registry).toContain(handle.graphics);
    expect(scene.children.list).toContain(handle.graphics);
    // The descent is animated, so the effect schedules at least one tween.
    expect(tweenSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('draws a vertical bolt column from well above the target down to it', async () => {
    const { spawnOrbitalStrike, ORBITAL_STRIKE_BOLT_WIDTH } = await strikeModule();
    const scene = await boot();

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y);
    const columns = verticalColumns(handle.graphics, MIN_COLUMN_HEIGHT);

    expect(columns.length).toBeGreaterThanOrEqual(1);
    const column = columns[0];
    // The bolt comes *from orbit*: it starts well above the target...
    expect(column.top).toBeLessThanOrEqual(-MIN_COLUMN_HEIGHT);
    // ...and lands on it.
    expect(column.bottom).toBeGreaterThanOrEqual(-4);
    // ...drawn only in the target's column, never across the screen.
    expect(column.halfWidth).toBeLessThanOrEqual(ORBITAL_STRIKE_BOLT_WIDTH / 2 + 1);
    expect(Math.abs(column.x)).toBeLessThanOrEqual(ORBITAL_STRIKE_BOLT_WIDTH / 2 + 1);
  });

  it('marks the target while the bolt falls and flashes on impact', async () => {
    const { spawnOrbitalStrike, ORBITAL_STRIKE_MARKER_RADIUS } = await strikeModule();
    const scene = await boot();

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y);
    const paths = readPaths(handle.graphics);

    // The target marker: a stroked shape (reticle/brackets) at least 8 x 8 px,
    // drawn inside the marker radius so it reads as aimed at the impact point.
    const marker = paths.find((path) => {
      if (!path.stroked || path.points.length === 0) return false;
      const bounds = boundsOf([path]);
      const outside = path.points.some(
        (point) => Math.hypot(point.x, point.y) > ORBITAL_STRIKE_MARKER_RADIUS * 1.01,
      );
      const wide = bounds.maxX - bounds.minX;
      const tall = bounds.maxY - bounds.minY;
      return !outside && wide >= 8 && tall >= 8;
    });
    expect(marker, 'no target marker drawn at the impact point').toBeDefined();

    // The impact flash: a filled shape at the impact point.
    expect(filledShapeCount(handle.graphics)).toBeGreaterThanOrEqual(1);
  });

  it('stays within the target column and the marker radius (no screen-wide wash)', async () => {
    const {
      spawnOrbitalStrike,
      ORBITAL_STRIKE_BOLT_WIDTH,
      ORBITAL_STRIKE_MARKER_RADIUS,
    } = await strikeModule();
    const scene = await boot();

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y);
    const bounds = boundsOf(readPaths(handle.graphics));
    const maxColumnHalfWidth = Math.max(
      ORBITAL_STRIKE_BOLT_WIDTH / 2,
      ORBITAL_STRIKE_MARKER_RADIUS,
    );

    expect(Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX))).toBeLessThanOrEqual(
      maxColumnHalfWidth + 1,
    );
  });

  it('completes within the 0.35 s budget and never stacks into a wash', async () => {
    const { spawnOrbitalStrike, ORBITAL_STRIKE_DURATION } = await strikeModule();
    const scene = await boot();
    const registries: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y, {
      registry: registries,
    });

    // Short enough that a permanent strike's pulses never overlap.
    expect(ORBITAL_STRIKE_DURATION).toBeGreaterThan(0);
    expect(ORBITAL_STRIKE_DURATION).toBeLessThanOrEqual(0.35);
    for (const [config] of tweenSpy.mock.calls as unknown as [CapturedTween][]) {
      expect(config.duration).toBeLessThanOrEqual(ORBITAL_STRIKE_DURATION * 1000);
    }
    expect(handle.isComplete()).toBe(false);
  });
});

describe('orbitalStrike — distinct from the Smart Bomb ring (AH-0MUOOB3OR001V8CD AC1)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([StrikeVfxStubScene]);
    return booted.scene;
  }

  it('is compositionally — not merely chromatically — distinct from spawnNovaRing', async () => {
    const { spawnOrbitalStrike } = await strikeModule();
    const scene = await boot();
    // Force both effects to the same colour so *only* the shape can differ:
    // a recoloured nova ring must not be able to satisfy this test.
    const sharedColour = 0x9ffcff;

    const strike = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y, {
      color: sharedColour,
    });
    const ring = spawnNovaRing(scene, TARGET_X, TARGET_Y, 40, {
      color: sharedColour,
      duration: NOVA_RING_DURATION,
    });

    // The ring is concentric arcs: it draws no vertical column at all.
    expect(verticalColumns(ring.graphics, MIN_COLUMN_HEIGHT)).toHaveLength(0);
    // The bolt is a descending column that no ringing pulse can produce.
    expect(
      verticalColumns(strike.graphics, MIN_COLUMN_HEIGHT).length,
    ).toBeGreaterThanOrEqual(1);
    // ...and the strike is a different effect instance, not the ring handle.
    expect(strike.graphics).not.toBe(ring.graphics);
  });
});

describe('orbitalStrike — registry participation and completion', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([StrikeVfxStubScene]);
    return booted.scene;
  }

  it('removes itself from the registry and destroys on completion', async () => {
    const { spawnOrbitalStrike } = await strikeModule();
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y, { registry });
    expect(handle.isComplete()).toBe(false);

    drainScheduledTweens(tweenSpy);

    expect(handle.isComplete()).toBe(true);
    expect(registry).not.toContain(handle.graphics);
    expect(handle.graphics.active).toBe(false);
  });

  it('works without a registry (fire-and-forget effect)', async () => {
    const { spawnOrbitalStrike } = await strikeModule();
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const handle = spawnOrbitalStrike(scene, TARGET_X, TARGET_Y);

    expect(() => drainScheduledTweens(tweenSpy)).not.toThrow();
    expect(handle.isComplete()).toBe(true);
    expect(handle.graphics.active).toBe(false);
  });
});

describe('orbitalStrike — dedicated impact cue (AH-0MVS2T0VQ00973W5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /**
   * The bolt owns its cue (the `thornsAbsorb.ts` precedent): every consumer
   * that spawns the bolt — `PlayScene` and every combat gym, through the one
   * shared strike path — gets the sound, so no call site can forget it and no
   * scene can diverge.
   */
  it('plays the orbital-strike cue exactly once, on impact — not during the descent', async () => {
    const { spawnOrbitalStrike } = await strikeModule();
    booted = await bootScene([StrikeVfxStubScene]);
    const scene = booted.scene;
    const cueSpy = vi.spyOn(effectsModule, 'playOrbitalStrikeSound');
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnOrbitalStrike(scene, TARGET_X, TARGET_Y);

    // The bolt is still falling: the cue must land with the flash, not with
    // the spawn, so the sound matches what the player sees.
    expect(cueSpy).not.toHaveBeenCalled();

    drainScheduledTweens(tweenSpy);

    expect(cueSpy).toHaveBeenCalledTimes(1);
    cueSpy.mockRestore();
  });
});

/**
 * Runs every scheduled tween's completion callback **once**, repeating while
 * the callbacks schedule follow-up stages (descent → impact flash), so a
 * multi-stage effect can be driven to completion without wall-clock waits.
 *
 * Only the calls added since the previous pass are invoked: re-running an
 * already-fired `onComplete` would replay its stage (and any one-shot side
 * effects such as the impact cue) once per pass.
 */
function drainScheduledTweens(spy: {
  mock: { calls: unknown[][] };
}): void {
  let processed = 0;
  for (let pass = 0; pass < 10; pass += 1) {
    const scheduled = spy.mock.calls.length;
    if (scheduled === processed) return;
    for (const call of spy.mock.calls.slice(processed, scheduled)) {
      const config = call[0] as CapturedTween;
      config.onComplete?.();
    }
    processed = scheduled;
  }
}

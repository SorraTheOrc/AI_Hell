/**
 * Procedural explosion frame textures — headless contract
 * (AH-0MVJ8TB610098DSY).
 *
 * The burst imagery is generated at runtime into cached Phaser canvas
 * textures: no committed image files, no asset pipeline. These tests pin the
 * pure side of that seam — the silhouette geometry per frame, the morph index,
 * the white (tintable) painter and the generate-once cache — through a
 * recording texture provider, so nothing here needs a real canvas or WebGL
 * (AC1, AC2, AC6, AC7).
 */

import { describe, expect, it } from 'vitest';

import {
  EXPLOSION_CORE_ALPHA,
  EXPLOSION_EMBER_ALPHA,
  EXPLOSION_EMBER_LINE_WIDTH,
  EXPLOSION_FRAME_COUNT,
  EXPLOSION_FRAME_KEY_PREFIX,
  EXPLOSION_LOBE_ALPHA,
  EXPLOSION_MID_ALPHA,
  EXPLOSION_TEXTURE_SIZE,
  drawExplosionFrame,
  ensureExplosionFrameTextures,
  explosionFrameKey,
  explosionFrameShape,
  explosionFramesAvailable,
  frameIndexFor,
  type ExplosionCanvasContext,
  type ExplosionTextureProvider,
} from './explosionTextures';

// ── Recording doubles ─────────────────────────────────────────────

/** A recorded canvas operation. */
interface RecordedFill {
  readonly style: unknown;
  readonly alpha: number;
  /** Number of polygon vertices in the filled path. */
  readonly points: number;
}

/** A recorded canvas stroke. */
interface RecordedStroke {
  readonly style: unknown;
  readonly alpha: number;
  readonly lineWidth: number;
  readonly points: number;
}

interface RecordingContext extends ExplosionCanvasContext {
  readonly fills: RecordedFill[];
  readonly strokes: RecordedStroke[];
  readonly cleared: number;
}

/** Creates a context double that records the painter's drawing operations. */
function makeRecordingContext(): RecordingContext {
  let points = 0;
  const context = {
    globalAlpha: 1,
    fillStyle: '#000000' as unknown,
    strokeStyle: '#000000' as unknown,
    lineWidth: 1,
    fills: [] as RecordedFill[],
    strokes: [] as RecordedStroke[],
    cleared: 0,
    clearRect(): void {
      context.cleared += 1;
    },
    beginPath(): void {
      points = 0;
    },
    moveTo(): void {
      points += 1;
    },
    lineTo(): void {
      points += 1;
    },
    closePath(): void {
      /* vertices are counted by moveTo/lineTo */
    },
    fill(): void {
      context.fills.push({
        style: context.fillStyle,
        alpha: context.globalAlpha,
        points,
      });
    },
    stroke(): void {
      context.strokes.push({
        style: context.strokeStyle,
        alpha: context.globalAlpha,
        lineWidth: context.lineWidth,
        points,
      });
    },
  };
  return context;
}

interface RecordingProvider extends ExplosionTextureProvider {
  readonly created: string[];
  readonly contexts: RecordingContext[];
  readonly keys: Set<string>;
}

/** Creates a texture provider double that records canvas creation. */
function makeRecordingProvider(): RecordingProvider {
  const keys = new Set<string>();
  const created: string[] = [];
  const contexts: RecordingContext[] = [];
  return {
    keys,
    created,
    contexts,
    exists(key: string): boolean {
      return keys.has(key);
    },
    createCanvas(key: string) {
      if (keys.has(key)) return null;
      keys.add(key);
      created.push(key);
      const context = makeRecordingContext();
      contexts.push(context);
      return { getContext: () => context, refresh: () => undefined };
    },
  };
}

// ── Frame family geometry (AC1, AC2) ──────────────────────────────

describe('explosion frame family (AC1, AC2)', () => {
  it('exposes a small frame family of a sane texture size', () => {
    expect(EXPLOSION_FRAME_COUNT).toBeGreaterThanOrEqual(3);
    expect(EXPLOSION_FRAME_COUNT).toBeLessThanOrEqual(8);
    expect(EXPLOSION_TEXTURE_SIZE).toBeGreaterThanOrEqual(32);
    // Power-of-two-friendly, and never gigantic (one shared set per game).
    expect(EXPLOSION_TEXTURE_SIZE).toBeLessThanOrEqual(256);
  });

  it('keys every frame uniquely under the documented prefix', () => {
    const keys = Array.from({ length: EXPLOSION_FRAME_COUNT }, (_v, i) =>
      explosionFrameKey(i),
    );
    expect(new Set(keys).size).toBe(EXPLOSION_FRAME_COUNT);
    for (const key of keys) expect(key.startsWith(EXPLOSION_FRAME_KEY_PREFIX)).toBe(true);
  });

  it('is deterministic: the same frame index always yields the same silhouette', () => {
    for (let frame = 0; frame < EXPLOSION_FRAME_COUNT; frame++) {
      expect(explosionFrameShape(frame)).toEqual(explosionFrameShape(frame));
    }
  });

  it('grows the outer lobe radius and shrinks the hot core across the family', () => {
    const shapes = Array.from({ length: EXPLOSION_FRAME_COUNT }, (_v, i) =>
      explosionFrameShape(i),
    );
    for (let i = 1; i < shapes.length; i++) {
      expect(shapes[i].radius).toBeGreaterThan(shapes[i - 1].radius);
    }
    // The filled frames (all but the final ember) lose their hot core.
    const filled = shapes.filter((s) => s.mode === 'fill');
    expect(filled.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < filled.length; i++) {
      expect(filled[i].coreRadius).toBeLessThan(filled[i - 1].coreRadius);
    }
  });

  it('every frame is a visibly different silhouette (ragged lobe count rises)', () => {
    const shapes = Array.from({ length: EXPLOSION_FRAME_COUNT }, (_v, i) =>
      explosionFrameShape(i),
    );
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        expect(shapes[i].outer, `frames ${i}/${j}`).not.toEqual(shapes[j].outer);
      }
    }
    expect(shapes[shapes.length - 1].lobes).toBeGreaterThan(shapes[0].lobes);
  });

  it('keeps every vertex inside the unit silhouette circle', () => {
    for (let frame = 0; frame < EXPLOSION_FRAME_COUNT; frame++) {
      const shape = explosionFrameShape(frame);
      for (const point of [...shape.outer, ...shape.mid, ...shape.core]) {
        expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(1.0000001);
      }
      expect(shape.outer.length).toBeGreaterThanOrEqual(16);
    }
  });

  it('ends in a thin ember shell rather than a dot (AC2)', () => {
    const last = explosionFrameShape(EXPLOSION_FRAME_COUNT - 1);
    expect(last.mode).toBe('ember');
    // Nothing left to fill: the final state is a thin stroked ring at full
    // radius, so it reads as an ember instead of a shrinking dot.
    expect(last.core).toEqual([]);
    expect(last.radius).toBeGreaterThanOrEqual(0.9);

    const first = explosionFrameShape(0);
    expect(first.mode).toBe('fill');
    expect(first.core.length).toBeGreaterThan(0);
  });

  it('clamps out-of-range frame indices to the family', () => {
    expect(explosionFrameShape(-3).frame).toBe(0);
    expect(explosionFrameShape(EXPLOSION_FRAME_COUNT + 5).frame).toBe(
      EXPLOSION_FRAME_COUNT - 1,
    );
    expect(explosionFrameShape(1.9).frame).toBe(1);
  });
});

// ── Frame index morph (AC2) ──────────────────────────────────────

describe('frameIndexFor (AC2)', () => {
  it('walks the whole family exactly once over the particle lifetime', () => {
    const seen = new Set<number>();
    for (let step = 0; step <= 20; step++) {
      seen.add(frameIndexFor(step / 20));
    }
    expect(seen.size).toBe(EXPLOSION_FRAME_COUNT);
  });

  it('starts on the first frame and always ends on the ember frame', () => {
    for (const offset of [0, 0.25, 0.5, 0.75, 0.99]) {
      expect(frameIndexFor(0, offset), `offset ${offset}`).toBe(0);
      expect(frameIndexFor(1, offset), `offset ${offset}`).toBe(
        EXPLOSION_FRAME_COUNT - 1,
      );
    }
  });

  it('never steps backwards as the particle ages', () => {
    for (const offset of [0, 0.4, 0.9]) {
      let previous = -1;
      for (let step = 0; step <= 50; step++) {
        const frame = frameIndexFor(step / 50, offset);
        expect(frame).toBeGreaterThanOrEqual(previous);
        previous = frame;
      }
    }
  });

  it('clamps out-of-range ages and non-finite input', () => {
    expect(frameIndexFor(-1)).toBe(0);
    expect(frameIndexFor(2)).toBe(EXPLOSION_FRAME_COUNT - 1);
    expect(frameIndexFor(Number.NaN)).toBe(0);
    expect(frameIndexFor(0.5, Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  it('is a function of the normalised age only — the offset just phase-shifts it', () => {
    // Two particles at the same age with different seeded offsets are both
    // reproducible from the same age/offset pair (never from wall-clock state).
    expect(frameIndexFor(0.5, 0.3)).toBe(frameIndexFor(0.5, 0.3));
    expect(frameIndexFor(0.5, 0)).toBeLessThanOrEqual(frameIndexFor(0.5, 0.3));
  });
});

// ── Painter (AC1) ────────────────────────────────────────────────

describe('drawExplosionFrame (AC1)', () => {
  it('paints filled frames in white so a per-particle tint controls the colour', () => {
    const context = makeRecordingContext();
    drawExplosionFrame(context, explosionFrameShape(1));

    expect(context.cleared).toBe(1);
    expect(context.strokes).toEqual([]);
    expect(context.fills.length).toBe(3);
    expect(context.fills.map((f) => f.style)).toEqual([
      '#ffffff',
      '#ffffff',
      '#ffffff',
    ]);
    // Lobe → body → hot core get progressively brighter.
    expect(context.fills.map((f) => f.alpha)).toEqual([
      EXPLOSION_LOBE_ALPHA,
      EXPLOSION_MID_ALPHA,
      EXPLOSION_CORE_ALPHA,
    ]);
    // Nested polygons: the lobe/body/core fills all trace the same sampling, so
    // the shrinking is expressed by the silhouette radii below.
    const shape = explosionFrameShape(1);
    expect(shape.coreRadius).toBeLessThan(shape.radius);
    const points = context.fills.map((f) => f.points);
    expect(points[0]).toBe(shape.outer.length);
    expect(points[2]).toBe(shape.core.length);
  });

  it('strokes the ember frame as a thin shell instead of filling it', () => {
    const context = makeRecordingContext();
    drawExplosionFrame(context, explosionFrameShape(EXPLOSION_FRAME_COUNT - 1));

    expect(context.fills).toEqual([]);
    expect(context.strokes.length).toBe(1);
    expect(context.strokes[0].style).toBe('#ffffff');
    expect(context.strokes[0].alpha).toBe(EXPLOSION_EMBER_ALPHA);
    expect(context.strokes[0].lineWidth).toBe(EXPLOSION_EMBER_LINE_WIDTH);
    expect(context.strokes[0].points).toBe(
      explosionFrameShape(EXPLOSION_FRAME_COUNT - 1).outer.length,
    );
  });
});

// ── Generate-once cache (AC1, AC7) ───────────────────────────────

describe('ensureExplosionFrameTextures (AC1, AC7)', () => {
  it('creates the whole frame family once and reports the created keys', () => {
    const provider = makeRecordingProvider();
    const created = ensureExplosionFrameTextures(provider);

    expect(created).toEqual(
      Array.from({ length: EXPLOSION_FRAME_COUNT }, (_v, i) => explosionFrameKey(i)),
    );
    expect(provider.created.length).toBe(EXPLOSION_FRAME_COUNT);
    expect(provider.contexts.length).toBe(EXPLOSION_FRAME_COUNT);
    // Every frame was actually painted (not just registered).
    for (const context of provider.contexts) {
      expect(context.cleared).toBe(1);
      expect(context.fills.length + context.strokes.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: a second call creates nothing and touches no canvas', () => {
    const provider = makeRecordingProvider();
    ensureExplosionFrameTextures(provider);
    const createdAgain = ensureExplosionFrameTextures(provider);

    expect(createdAgain).toEqual([]);
    expect(provider.created.length).toBe(EXPLOSION_FRAME_COUNT);
  });

  it('only creates the frames that are missing', () => {
    const provider = makeRecordingProvider();
    ensureExplosionFrameTextures(provider);
    provider.keys.delete(explosionFrameKey(2));

    const created = ensureExplosionFrameTextures(provider);
    expect(created).toEqual([explosionFrameKey(2)]);
  });

  it('never throws for a provider that cannot create canvases', () => {
    const noop = {
      exists: () => false,
      createCanvas: () => null,
    } as unknown as ExplosionTextureProvider;
    expect(ensureExplosionFrameTextures(noop)).toEqual([]);
    expect(ensureExplosionFrameTextures(null)).toEqual([]);
    expect(ensureExplosionFrameTextures(undefined)).toEqual([]);
    // A stubbed scene that exposes a texture-like object without the API.
    expect(
      ensureExplosionFrameTextures({} as unknown as ExplosionTextureProvider),
    ).toEqual([]);
  });

  it('reports availability from the registered frame family', () => {
    const provider = makeRecordingProvider();
    expect(explosionFramesAvailable(provider)).toBe(false);
    ensureExplosionFrameTextures(provider);
    expect(explosionFramesAvailable(provider)).toBe(true);
    expect(explosionFramesAvailable(null)).toBe(false);
    expect(explosionFramesAvailable({} as unknown as ExplosionTextureProvider)).toBe(
      false,
    );
  });
});

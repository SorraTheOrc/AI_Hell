/**
 * Procedural explosion frame textures (AH-0MVJ8TB610098DSY).
 *
 * The explosion VFX is no longer a cloud of filled circles: every particle is
 * an **image** whose silhouette morphs as it shrinks. The imagery is generated
 * at runtime, straight into cached Phaser canvas textures — the repo keeps its
 * zero-binary-asset convention (no committed sprite sheets, no asset pipeline),
 * and every frame is a pure function of its index, so the same frames are
 * produced on every run and in every scene.
 *
 * ## Frame family
 *
 * One burst draws from {@link EXPLOSION_FRAME_COUNT} frames that trace the life
 * of a blast:
 *
 *   0. compact, hot, dense core with few lobes,
 *   1. wider ragged lobes (flame front breaking up),
 *   2. ragged lobe ring with a shrinking core,
 *   3. thin spiked lobes with almost no core,
 *   4. a thin ember shell — the last state, never a dot.
 *
 * Each frame is a stylised neon blast of **angular, ragged polygons** (GDD
 * §7.1 "geometric, angular shapes … no organic forms"), not a photographic
 * smoke puff.
 *
 * ## Rendering contract
 *
 * Frames are drawn in **white** at several alphas, so a caller tints a
 * per-particle explosion image with its own colour (`setTint`) and the
 * silhouette shading is preserved. The outer polygon is drawn at a low alpha,
 * an inner polygon at a higher alpha and the hot core at full alpha; the final
 * ember frame is a stroked shell instead of nested fills.
 *
 * ## Headless safety
 *
 * Texture creation is expressed through {@link ExplosionTextureProvider} — the
 * exact surface a `Phaser.Textures.TextureManager` already provides — so unit
 * tests inject a recording double and assert the generated frames without a
 * real canvas, and {@link ensureExplosionFrameTextures} is a no-op for a
 * provider that cannot create canvases (belt-and-braces for stubbed scenes).
 */

/** Edge length (px) of every generated explosion frame texture. */
export const EXPLOSION_TEXTURE_SIZE = 64;

/**
 * Number of morph frames in a burst family — the silhouette walks through
 * this many distinct shapes from spawn to expiry (AC2).
 */
export const EXPLOSION_FRAME_COUNT = 5;

/** Prefix of every generated frame texture key. */
export const EXPLOSION_FRAME_KEY_PREFIX = 'explosion-frame';

/** Texture key for morph frame `frame`. */
export function explosionFrameKey(frame: number): string {
  return `${EXPLOSION_FRAME_KEY_PREFIX}-${frame}`;
}

/** A point on a normalised (unit-radius) silhouette polygon. */
export interface ExplosionShapePoint {
  readonly x: number;
  readonly y: number;
}

/** How a frame's silhouette is painted. */
export type ExplosionFrameMode = 'fill' | 'ember';

/** The generated silhouette geometry of one morph frame. */
export interface ExplosionFrameShape {
  /** Frame index (0 … {@link EXPLOSION_FRAME_COUNT} - 1). */
  readonly frame: number;
  /** `fill` paints nested filled polygons; `ember` strokes a thin shell. */
  readonly mode: ExplosionFrameMode;
  /** Number of flame lobes around the silhouette. */
  readonly lobes: number;
  /** Outer silhouette radius as a fraction of the texture half-size (0-1). */
  readonly radius: number;
  /** Hot-core radius as a fraction of the texture half-size (0-1). */
  readonly coreRadius: number;
  /** Outer (ragged lobe) silhouette, normalised to the texture half-size. */
  readonly outer: readonly ExplosionShapePoint[];
  /** Mid silhouette between the lobes and the core. */
  readonly mid: readonly ExplosionShapePoint[];
  /** Hot core silhouette (empty for the ember frame). */
  readonly core: readonly ExplosionShapePoint[];
}

/** Per-frame silhouette tuning; index is the frame number. */
interface FrameSpec {
  readonly mode: ExplosionFrameMode;
  readonly radius: number;
  readonly coreRadius: number;
  readonly lobes: number;
  readonly raggedness: number;
  readonly samples: number;
}

/**
 * The frame family, in morph order. The outer radius grows, the core shrinks
 * and the raggedness rises across the family, so the sequence reads as a
 * blast cooling from a hot core into thin embers.
 */
const FRAME_SPECS: readonly FrameSpec[] = [
  { mode: 'fill', radius: 0.6, coreRadius: 0.34, lobes: 5, raggedness: 0.08, samples: 40 },
  { mode: 'fill', radius: 0.74, coreRadius: 0.3, lobes: 6, raggedness: 0.14, samples: 44 },
  { mode: 'fill', radius: 0.86, coreRadius: 0.22, lobes: 7, raggedness: 0.2, samples: 48 },
  { mode: 'fill', radius: 0.96, coreRadius: 0.12, lobes: 8, raggedness: 0.26, samples: 52 },
  { mode: 'ember', radius: 0.97, coreRadius: 0, lobes: 9, raggedness: 0.32, samples: 56 },
];

/** Line width (px) of the final ember shell stroke. */
export const EXPLOSION_EMBER_LINE_WIDTH = 3;

/** Alpha of the outer lobe fill (the soft flame front). */
export const EXPLOSION_LOBE_ALPHA = 0.45;
/** Alpha of the mid fill (the brighter flame body). */
export const EXPLOSION_MID_ALPHA = 0.75;
/** Alpha of the hot-core fill and the ember shell stroke. */
export const EXPLOSION_CORE_ALPHA = 1;
/** Alpha of the final ember shell stroke. */
export const EXPLOSION_EMBER_ALPHA = 0.9;

/**
 * Builds one ragged silhouette polygon, normalised to a unit radius.
 *
 * The lobe modulation is normalised so the polygon's **maximum** radius is
 * exactly `radiusFactor` — the silhouette always fits inside the texture and
 * the frames nest inside each other, while the angular raggedness still varies
 * the lobe outline.
 */
function silhouette(
  spec: FrameSpec,
  radiusFactor: number,
  phase: number,
): ExplosionShapePoint[] {
  const relative: number[] = [];
  for (let i = 0; i < spec.samples; i++) {
    const theta = (i / spec.samples) * Math.PI * 2;
    // Deterministic lobe modulation — no PRNG, so the same frame is produced
    // every run (and every scene) without seeding anything.
    const wobble = Math.sin(theta * spec.lobes + phase) * spec.raggedness;
    const spike =
      Math.abs(Math.sin(theta * spec.lobes * 0.5 + phase * 0.5)) *
      spec.raggedness *
      0.5;
    relative.push(Math.max(0.05, 1 + wobble + spike));
  }

  const peak = Math.max(...relative);
  const scale = radiusFactor / peak;
  return relative.map((r, i) => {
    const theta = (i / spec.samples) * Math.PI * 2;
    const radius = r * scale;
    return { x: Math.cos(theta) * radius, y: Math.sin(theta) * radius };
  });
}

/**
 * Returns the deterministic silhouette geometry for `frame`.
 *
 * Pure and PRNG-free: the shape is a function of the frame index only, so the
 * generated textures are identical on every run (and can be asserted
 * headlessly). Out-of-range indices are clamped to the frame family.
 */
export function explosionFrameShape(frame: number): ExplosionFrameShape {
  const index = Math.max(
    0,
    Math.min(EXPLOSION_FRAME_COUNT - 1, Math.floor(frame)),
  );
  const spec = FRAME_SPECS[index];
  const phase = index * 1.1;
  const midRadius = (spec.radius + spec.coreRadius) / 2;
  return {
    frame: index,
    mode: spec.mode,
    lobes: spec.lobes,
    radius: spec.radius,
    coreRadius: spec.coreRadius,
    outer: silhouette(spec, spec.radius, phase),
    mid: silhouette(spec, midRadius, phase * 0.5),
    core:
      spec.coreRadius > 0 ? silhouette(spec, spec.coreRadius, phase * 0.25) : [],
  };
}

/**
 * The minimal 2D canvas context surface the frame painter touches. The style
 * fields are `unknown` because a real `CanvasRenderingContext2D` types them as
 * `string | CanvasGradient | CanvasPattern` — this module only ever assigns
 * CSS colour strings, so a wider type keeps the seam structurally compatible
 * with Phaser's texture manager without weakening the painter.
 */
export interface ExplosionCanvasContext {
  globalAlpha: number;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  clearRect?(x: number, y: number, width: number, height: number): unknown;
  beginPath(): unknown;
  moveTo(x: number, y: number): unknown;
  lineTo(x: number, y: number): unknown;
  closePath(): unknown;
  fill(): unknown;
  stroke(): unknown;
}

/** A generated canvas texture (a `Phaser.Textures.CanvasTexture` subset). */
export interface ExplosionCanvasTexture {
  getContext(): ExplosionCanvasContext | null;
  refresh(): unknown;
}

/**
 * The texture-creation seam — structurally identical to the pieces of
 * `Phaser.Textures.TextureManager` this module uses, so a scene can hand its
 * manager over directly and unit tests can hand over a recording double.
 */
export interface ExplosionTextureProvider {
  exists(key: string): boolean;
  createCanvas(
    key: string,
    width: number,
    height: number,
  ): ExplosionCanvasTexture | null;
}

/** Traces `points` (scaled to the texture half-size) as a closed path. */
function tracePolygon(
  context: ExplosionCanvasContext,
  points: readonly ExplosionShapePoint[],
  half: number,
): void {
  context.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = half + points[i].x * half;
    const y = half + points[i].y * half;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
}

/**
 * Paints one frame's silhouette in white (so callers can tint it) onto
 * `context`. Exported so the painter itself is unit-testable.
 */
export function drawExplosionFrame(
  context: ExplosionCanvasContext,
  shape: ExplosionFrameShape,
): void {
  const half = EXPLOSION_TEXTURE_SIZE / 2;
  context.clearRect?.(0, 0, EXPLOSION_TEXTURE_SIZE, EXPLOSION_TEXTURE_SIZE);

  if (shape.mode === 'ember') {
    context.globalAlpha = EXPLOSION_EMBER_ALPHA;
    context.strokeStyle = '#ffffff';
    context.lineWidth = EXPLOSION_EMBER_LINE_WIDTH;
    tracePolygon(context, shape.outer, half);
    context.stroke();
    context.globalAlpha = 1;
    return;
  }

  context.fillStyle = '#ffffff';
  context.globalAlpha = EXPLOSION_LOBE_ALPHA;
  tracePolygon(context, shape.outer, half);
  context.fill();

  context.globalAlpha = EXPLOSION_MID_ALPHA;
  tracePolygon(context, shape.mid, half);
  context.fill();

  if (shape.core.length > 0) {
    context.globalAlpha = EXPLOSION_CORE_ALPHA;
    tracePolygon(context, shape.core, half);
    context.fill();
  }

  context.globalAlpha = 1;
}

/**
 * Creates the missing explosion frame textures on `provider` and returns the
 * keys it created (in frame order).
 *
 * Idempotent: keys that already exist are left untouched, so the frame
 * textures are generated **once per game** and shared by every burst, every
 * scene and every gym (AC7). A provider that cannot create canvases (or a
 * stubbed scene with no texture manager) yields `[]` and never throws — the
 * renderer then degrades to its headless path.
 */
export function ensureExplosionFrameTextures(
  provider: ExplosionTextureProvider | null | undefined,
): string[] {
  if (
    !provider ||
    typeof provider.exists !== 'function' ||
    typeof provider.createCanvas !== 'function'
  ) {
    return [];
  }

  const created: string[] = [];
  for (let frame = 0; frame < EXPLOSION_FRAME_COUNT; frame++) {
    const key = explosionFrameKey(frame);
    if (provider.exists(key)) continue;
    const texture = provider.createCanvas(
      key,
      EXPLOSION_TEXTURE_SIZE,
      EXPLOSION_TEXTURE_SIZE,
    );
    if (!texture) continue;
    const context = texture.getContext();
    if (context) drawExplosionFrame(context, explosionFrameShape(frame));
    texture.refresh();
    created.push(key);
  }
  return created;
}

/** Whether the explosion frame family is registered on `provider`. */
export function explosionFramesAvailable(
  provider: ExplosionTextureProvider | null | undefined,
): boolean {
  if (!provider || typeof provider.exists !== 'function') return false;
  return provider.exists(explosionFrameKey(0));
}

/**
 * Frame index for a particle of normalised `age` (0 = spawn, 1 = expiry).
 *
 * The index is a function of the normalised age **only**, plus the particle's
 * seeded `frameOffset` (0 … 1) which shifts where in the age curve the
 * silhouette breaks up, so two particles spawned together do not morph in
 * lockstep. It is monotonic — a particle never steps back to an earlier,
 * denser frame — and always ends on the ember frame (AC2).
 */
export function frameIndexFor(
  age: number,
  frameOffset = 0,
  frameCount: number = EXPLOSION_FRAME_COUNT,
): number {
  const clampedAge = Math.min(1, Math.max(0, Number.isFinite(age) ? age : 0));
  const offset = Math.min(1, Math.max(0, Number.isFinite(frameOffset) ? frameOffset : 0));
  const raw = Math.floor(clampedAge * frameCount + offset);
  return Math.min(frameCount - 1, Math.max(0, raw));
}

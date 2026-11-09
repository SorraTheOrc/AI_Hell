/**
 * Shared asteroid silhouette palette baked into **one** texture atlas
 * (AH-0MW5088LA007XYQM, parent AH-0MW4857B0004GMWR AC3–AC7).
 *
 * ## Why
 *
 * Every asteroid used to draw its own seeded jagged polygon in
 * `Asteroid._drawBody()`. The shared enemy-body bake seam
 * (`./enemyBodyTextures`) keys its cache on the drawn commands, so **every
 * rock** became its own canvas texture — one draw call each, and once
 * `MAX_BAKED_ENEMY_BODY_TEXTURES` (64) was reached the rest kept a
 * `Graphics` body that was re-tessellated and re-submitted every frame. An
 * unbounded asteroid field could therefore both exhaust the shared texture
 * budget and fall back to the per-frame `Graphics` path
 * (`docs/PERFORMANCE.md`, `docs/GYM_PARITY.md`).
 *
 * ## What this module does
 *
 * It pre-generates a small, **fixed** palette of jagged silhouettes per size
 * tier (8–12 shapes, {@link ASTEROID_PALETTE_VARIANTS_PER_TIER}) from a fixed
 * seed ({@link ASTEROID_PALETTE_SEED}), bakes all of them into a **single**
 * canvas texture once per game, and registers one atlas frame per silhouette.
 * Every asteroid then renders as a plain `Phaser.GameObjects.Image` pointing at
 * that one texture, so Phaser batches the whole field into one texture bind —
 * no per-rock texture, no cache exhaustion, no per-frame `Graphics` body.
 *
 * ## Determinism
 *
 * Two independent guarantees, neither of which touches gameplay:
 *
 * - the **palette** is a pure function of the fixed seed, so every game, gym
 *   and replay bakes byte-identical silhouettes;
 * - an **asteroid's variant** is derived from the draws it takes from its own
 *   seeded RNG ({@link asteroidVariantFromDraws}), so a seeded run reproduces
 *   each rock's look. `Asteroid._drawBody()` still consumes exactly the same
 *   RNG draws as the old unique-shape generator, so the stream position an
 *   asteroid leaves behind — and therefore every later heading, split fan and
 *   fire roll — is unchanged.
 *
 * ## Headless safety
 *
 * {@link acquireAsteroidPalette} returns `null` for a scene that cannot bake
 * canvas textures (stub/headless scenes, and the unit harness' inert 2D
 * context), and the entity then keeps the pre-change `Graphics` body. The
 * palette geometry ({@link asteroidPaletteShapes}) is pure and always
 * available, so the drawn record is identical either way.
 *
 * @module utils/asteroidTextures
 */

import type Phaser from 'phaser';

import type { AsteroidSizeTier } from '../entities/Asteroid';
import {
  canBakeTextures,
  enemyBodyExtent,
  enemyBodyTextureSize,
} from './enemyBodyTextures';

/** One point of a silhouette, centred on the asteroid's origin (px). */
export interface AsteroidVertex {
  readonly x: number;
  readonly y: number;
}

/** A silhouette: the closed polygon a jagged asteroid body is stroked as. */
export type AsteroidSilhouette = readonly AsteroidVertex[];

/** The size tier / colour data the palette is built from (subset of `ASTEROID_TIER_DATA`). */
export interface AsteroidPaletteTierSpec {
  /** Canonical tier half-size multiplier: the silhouette's full width (px). */
  readonly size: number;
  /** Tier body colour (hex number). */
  readonly color: number;
}

/** Per-tier palette inputs, keyed by size tier. */
export type AsteroidPaletteTiers = Record<
  AsteroidSizeTier,
  AsteroidPaletteTierSpec
>;

/** Texture key of the single shared asteroid atlas (one per game). */
export const ASTEROID_ATLAS_KEY = 'asteroid-atlas-v1';

/**
 * Number of shared silhouettes per size tier.
 *
 * Inside the 8–12 range the operator approved: enough variety that a field
 * does not read as one repeated rock, few enough that the whole palette is one
 * small texture.
 */
export const ASTEROID_PALETTE_VARIANTS_PER_TIER = 10;

/**
 * Fixed palette seed. Changing it re-generates every silhouette, so bump
 * {@link ASTEROID_ATLAS_KEY} with it to avoid reusing stale frames.
 */
export const ASTEROID_PALETTE_SEED = 0x51a7e001;

/** Silhouettes per atlas row (a fixed layout, so frames are reproducible). */
const ATLAS_COLUMNS = 4;

/** Tiers in canonical palette order (the order the seed stream is consumed in). */
export const ASTEROID_PALETTE_TIERS: readonly AsteroidSizeTier[] = [
  'large',
  'medium',
  'small',
];

/** One registered atlas frame: where one tier silhouette lives in the atlas. */
export interface AsteroidAtlasFrame {
  /** Frame name inside the shared texture (e.g. `large-3`). */
  readonly name: string;
  /** Variant index in the tier palette. */
  readonly variant: number;
  /** Frame rect inside the atlas (px). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Frames of one tier inside the atlas. */
export interface AsteroidAtlasTierLayout {
  /** Cell edge length (px) — the baked texture size of one silhouette. */
  readonly cellSize: number;
  /** Frames, in variant order. */
  readonly frames: readonly AsteroidAtlasFrame[];
}

/** The whole atlas layout: one texture, one frame per (tier, variant). */
export interface AsteroidAtlasLayout {
  /** Texture key the frames belong to. */
  readonly key: string;
  /** Atlas width (px). */
  readonly width: number;
  /** Atlas height (px). */
  readonly height: number;
  readonly tiers: Readonly<Record<AsteroidSizeTier, AsteroidAtlasTierLayout>>;
}

/** A usable palette: the texture key plus the frame/cell data per tier. */
export interface AsteroidPalette {
  /** The single shared texture every asteroid body renders from. */
  readonly key: string;
  readonly variantsPerTier: number;
  readonly tiers: Readonly<
    Record<AsteroidSizeTier, { cellSize: number; frames: readonly string[] }>
  >;
}

/**
 * Deterministic 32-bit PRNG (mulberry32), used only for the **palette**.
 *
 * The palette must not draw from the per-asteroid RNG stream: it is shared by
 * the whole game, so it needs its own fixed stream.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32-bit FNV-1a hash of a numeric sequence.
 *
 * Values are hashed through their shortest round-trip string form, so the same
 * draws always hash to the same variant and different draws practically never
 * collide on a different basis.
 */
function hashDraws(values: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // Separator so `[1, 23]` and `[12, 3]` differ.
    hash ^= 0x2c;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Picks the shared palette variant an asteroid renders from the draws it took
 * from its **own** seeded RNG stream.
 *
 * Pure and total: the result is always a valid variant index, so an asteroid
 * can never reference a frame the palette does not bake.
 *
 * @param draws — the shape draws consumed from the asteroid's RNG stream
 * @param variants — palette size (defaults to the shared constant)
 */
export function asteroidVariantFromDraws(
  draws: readonly number[],
  variants: number = ASTEROID_PALETTE_VARIANTS_PER_TIER,
): number {
  const count = Math.max(1, Math.floor(variants));
  if (draws.length === 0) return 0;
  return hashDraws(draws) % count;
}

/** One seeded jagged polygon, sized to a tier's canonical full size. */
function generateSilhouette(
  rng: () => number,
  size: number,
): AsteroidSilhouette {
  const radius = Math.max(0, size) / 2;
  // 7–9 vertices, ±0.2 rad angular jitter, 0.7–1.0 × radius: exactly the look
  // of the pre-palette per-rock generator (`Asteroid._drawBody`).
  const numVertices = 7 + Math.floor(rng() * 3);
  const vertices: AsteroidVertex[] = [];
  for (let index = 0; index < numVertices; index += 1) {
    const baseAngle = (index / numVertices) * Math.PI * 2;
    const jitter = (rng() - 0.5) * 0.4;
    const radialVariation = 0.7 + rng() * 0.3;
    vertices.push({
      x: Math.cos(baseAngle + jitter) * radius * radialVariation,
      y: Math.sin(baseAngle + jitter) * radius * radialVariation,
    });
  }
  return vertices;
}

interface SilhouetteCache {
  readonly signature: string;
  readonly shapes: Readonly<
    Record<AsteroidSizeTier, readonly AsteroidSilhouette[]>
  >;
}

let silhouetteCache: SilhouetteCache | null = null;

/**
 * The palette geometry: every tier's silhouettes, generated once from the
 * fixed seed.
 *
 * Pure and memoised on the tier sizes, so the atlas bake and every entity's
 * drawn record read the **same** polygon data.
 *
 * @param tiers — canonical tier size/colour data (`ASTEROID_TIER_DATA`)
 * @param variants — silhouettes per tier (defaults to the shared constant)
 */
export function asteroidPaletteShapes(
  tiers: AsteroidPaletteTiers,
  variants: number = ASTEROID_PALETTE_VARIANTS_PER_TIER,
): Readonly<Record<AsteroidSizeTier, readonly AsteroidSilhouette[]>> {
  const count = Math.max(1, Math.floor(variants));
  const signature = `${ASTEROID_PALETTE_SEED}|${count}|${ASTEROID_PALETTE_TIERS.map(
    (tier) => `${tier}:${tiers[tier].size}`,
  ).join(',')}`;
  if (silhouetteCache?.signature === signature) return silhouetteCache.shapes;

  const rng = mulberry32(ASTEROID_PALETTE_SEED);
  const shapes = {} as Record<AsteroidSizeTier, readonly AsteroidSilhouette[]>;
  for (const tier of ASTEROID_PALETTE_TIERS) {
    const tierShapes: AsteroidSilhouette[] = [];
    for (let variant = 0; variant < count; variant += 1) {
      tierShapes.push(generateSilhouette(rng, tiers[tier].size));
    }
    shapes[tier] = tierShapes;
  }
  silhouetteCache = { signature, shapes };
  return shapes;
}

/**
 * Strokes one silhouette into a `Graphics` at `scale`.
 *
 * The single drawing implementation for both the atlas bake and each
 * asteroid's drawn body record, so the sprite and the recorded shape can never
 * diverge (the shared-core parity rule).
 *
 * @param graphics — target graphics (a scratch bake object or the entity body)
 * @param silhouette — vertices to stroke, in order
 * @param scale — multiplier applied to every vertex (entity size vs tier size)
 * @param color — stroke colour (hex number)
 * @param lineWidth — stroke width (px), identical to the pre-palette 2 px
 */
export function drawAsteroidSilhouette(
  graphics: Phaser.GameObjects.Graphics,
  silhouette: AsteroidSilhouette,
  scale: number,
  color: number,
  lineWidth = 2,
): void {
  if (silhouette.length === 0) return;
  graphics.lineStyle(lineWidth, color, 1);
  const first = silhouette[0];
  graphics.beginPath();
  graphics.moveTo(first.x * scale, first.y * scale);
  for (let index = 1; index < silhouette.length; index += 1) {
    const vertex = silhouette[index];
    graphics.lineTo(vertex.x * scale, vertex.y * scale);
  }
  graphics.closePath();
  graphics.strokePath();
}

/**
 * The atlas layout: a pure function of the tier sizes and palette size.
 *
 * Frames never overlap and always sit inside the atlas, which is what lets a
 * frame be added to the texture without cropping a rock.
 */
export function asteroidAtlasLayout(
  tiers: AsteroidPaletteTiers,
  variants: number = ASTEROID_PALETTE_VARIANTS_PER_TIER,
): AsteroidAtlasLayout {
  const count = Math.max(1, Math.floor(variants));
  const rows = Math.ceil(count / ATLAS_COLUMNS);
  const tierLayouts = {} as Record<AsteroidSizeTier, AsteroidAtlasTierLayout>;
  let width = 0;
  let height = 0;

  for (const tier of ASTEROID_PALETTE_TIERS) {
    const cellSize = enemyBodyTextureSize(enemyBodyExtent(tiers[tier].size));
    const frames: AsteroidAtlasFrame[] = [];
    for (let variant = 0; variant < count; variant += 1) {
      const column = variant % ATLAS_COLUMNS;
      const row = Math.floor(variant / ATLAS_COLUMNS);
      frames.push({
        name: `${tier}-${variant}`,
        variant,
        x: column * cellSize,
        y: height + row * cellSize,
        width: cellSize,
        height: cellSize,
      });
    }
    tierLayouts[tier] = { cellSize, frames };
    width = Math.max(width, cellSize * Math.min(count, ATLAS_COLUMNS));
    height += rows * cellSize;
  }

  return { key: ASTEROID_ATLAS_KEY, width, height, tiers: tierLayouts };
}

/**
 * Bakes the palette into the atlas texture (once) and registers its frames.
 *
 * The bake replays the same stroke commands the entity records — centred in
 * each cell by a `save`/`translate`/`restore` pair — so the sprite is the same
 * silhouette, only drawn once instead of every frame.
 */
function bakeAsteroidAtlas(
  scene: Phaser.Scene,
  tiers: AsteroidPaletteTiers,
  layout: AsteroidAtlasLayout,
  variants: number,
): void {
  if (!scene.textures.exists(layout.key)) {
    const shapes = asteroidPaletteShapes(tiers, variants);
    const bake = scene.make.graphics({ x: 0, y: 0 }, false);
    try {
      for (const tier of ASTEROID_PALETTE_TIERS) {
        const tierLayout = layout.tiers[tier];
        for (const frame of tierLayout.frames) {
          const silhouette = shapes[tier][frame.variant];
          bake.save();
          bake.translateCanvas(
            frame.x + frame.width / 2,
            frame.y + frame.height / 2,
          );
          drawAsteroidSilhouette(bake, silhouette, 1, tiers[tier].color);
          bake.restore();
        }
      }
      bake.generateTexture(layout.key, layout.width, layout.height);
    } finally {
      bake.destroy();
    }
  }

  const texture = scene.textures.get(layout.key);
  if (!texture) return;
  for (const tier of ASTEROID_PALETTE_TIERS) {
    for (const frame of layout.tiers[tier].frames) {
      if (!texture.has(frame.name)) {
        texture.add(frame.name, 0, frame.x, frame.y, frame.width, frame.height);
      }
    }
  }
}

/**
 * Acquires the game's shared asteroid palette, baking the atlas on first use.
 *
 * Cache scope is the game's `TextureManager` (shared by every scene and gym),
 * so the atlas is baked at most once per game and every asteroid in every
 * scene renders from the same texture.
 *
 * @returns the palette, or `null` when the scene cannot bake canvas textures
 *   (the caller then keeps the pre-change `Graphics` body)
 */
export function acquireAsteroidPalette(
  scene: Phaser.Scene | undefined,
  tiers: AsteroidPaletteTiers,
  variants: number = ASTEROID_PALETTE_VARIANTS_PER_TIER,
): AsteroidPalette | null {
  if (!canBakeTextures(scene)) return null;
  const count = Math.max(1, Math.floor(variants));
  const layout = asteroidAtlasLayout(tiers, count);

  bakeAsteroidAtlas(scene!, tiers, layout, count);
  if (!scene!.textures.exists(layout.key)) return null;

  const tierPalettes = {} as Record<
    AsteroidSizeTier,
    { cellSize: number; frames: readonly string[] }
  >;
  for (const tier of ASTEROID_PALETTE_TIERS) {
    const tierLayout = layout.tiers[tier];
    tierPalettes[tier] = {
      cellSize: tierLayout.cellSize,
      frames: tierLayout.frames.map((frame) => frame.name),
    };
  }

  return { key: layout.key, variantsPerTier: count, tiers: tierPalettes };
}

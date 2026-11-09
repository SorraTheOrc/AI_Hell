/**
 * Shared asteroid silhouette palette + single atlas (AH-0MW5088LA007XYQM).
 *
 * Pins the two properties the batched asteroid renderer depends on: the
 * palette is a **bounded, fixed-seed** geometry (8–12 silhouettes per tier,
 * reproducible across runs), and it is baked into **one** texture whose frames
 * are all inside the atlas. The rendering behaviour itself (an asteroid
 * sprite sharing that texture, and the shared texture-cache budget staying
 * free) is pinned in `src/entities/Asteroid.palette.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { ASTEROID_TIER_DATA } from '../entities/Asteroid';
import { bootScene, BootedGame } from '../test/gameHarness';
import {
  ASTEROID_ATLAS_KEY,
  ASTEROID_PALETTE_TIERS,
  ASTEROID_PALETTE_VARIANTS_PER_TIER,
  acquireAsteroidPalette,
  asteroidAtlasLayout,
  asteroidPaletteShapes,
  asteroidVariantFromDraws,
} from './asteroidTextures';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('AsteroidTexturesHarnessScene');
  }
}

describe('asteroid palette geometry', () => {
  it('keeps the palette inside the approved 8–12 silhouettes per tier', () => {
    expect(ASTEROID_PALETTE_VARIANTS_PER_TIER).toBeGreaterThanOrEqual(8);
    expect(ASTEROID_PALETTE_VARIANTS_PER_TIER).toBeLessThanOrEqual(12);
  });

  it('generates exactly the palette size for every size tier', () => {
    const shapes = asteroidPaletteShapes(ASTEROID_TIER_DATA);
    for (const tier of ASTEROID_PALETTE_TIERS) {
      expect(shapes[tier]).toHaveLength(ASTEROID_PALETTE_VARIANTS_PER_TIER);
    }
  });

  it('draws jagged polygons that stay inside the tier half-size', () => {
    const shapes = asteroidPaletteShapes(ASTEROID_TIER_DATA);
    for (const tier of ASTEROID_PALETTE_TIERS) {
      const half = ASTEROID_TIER_DATA[tier].size / 2;
      for (const silhouette of shapes[tier]) {
        // 7–9 vertices, exactly the pre-palette generator's rocks.
        expect(silhouette.length).toBeGreaterThanOrEqual(7);
        expect(silhouette.length).toBeLessThanOrEqual(9);
        for (const vertex of silhouette) {
          const radius = Math.sqrt(vertex.x ** 2 + vertex.y ** 2);
          // 0.7–1.0 × the half-size: never clipped by the frame, and never a
          // smooth circle (the rock reads as jagged).
          expect(radius).toBeGreaterThanOrEqual(half * 0.7 - 1e-9);
          expect(radius).toBeLessThanOrEqual(half + 1e-9);
        }
        const radii = silhouette.map((v) => Math.sqrt(v.x ** 2 + v.y ** 2));
        expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(half * 0.1);
      }
    }
  });

  it('gives every variant in a tier a distinct silhouette', () => {
    const shapes = asteroidPaletteShapes(ASTEROID_TIER_DATA);
    for (const tier of ASTEROID_PALETTE_TIERS) {
      const serialised = shapes[tier].map((silhouette) => JSON.stringify(silhouette));
      expect(new Set(serialised).size).toBe(ASTEROID_PALETTE_VARIANTS_PER_TIER);
    }
  });

  it('is reproducible from the fixed seed — a fresh module produces the same palette', async () => {
    const first = JSON.stringify(asteroidPaletteShapes(ASTEROID_TIER_DATA));

    vi.resetModules();
    const reloaded = await import('./asteroidTextures');
    const second = JSON.stringify(
      reloaded.asteroidPaletteShapes(ASTEROID_TIER_DATA),
    );

    expect(second).toBe(first);
  });
});

describe('asteroidAtlasLayout', () => {
  it('registers one frame per (tier, variant) with unique names', () => {
    const layout = asteroidAtlasLayout(ASTEROID_TIER_DATA);
    const names: string[] = [];
    for (const tier of ASTEROID_PALETTE_TIERS) {
      const frames = layout.tiers[tier].frames;
      expect(frames).toHaveLength(ASTEROID_PALETTE_VARIANTS_PER_TIER);
      expect(frames.map((frame) => frame.variant)).toEqual(
        Array.from({ length: ASTEROID_PALETTE_VARIANTS_PER_TIER }, (_, i) => i),
      );
      names.push(...frames.map((frame) => frame.name));
    }
    // Two variants must never share a frame name.
    expect(new Set(names).size).toBe(names.length);
    expect(layout.key).toBe(ASTEROID_ATLAS_KEY);
  });

  it('places every frame inside the atlas', () => {
    const layout = asteroidAtlasLayout(ASTEROID_TIER_DATA);
    for (const tier of ASTEROID_PALETTE_TIERS) {
      for (const frame of layout.tiers[tier].frames) {
        expect(frame.x).toBeGreaterThanOrEqual(0);
        expect(frame.y).toBeGreaterThanOrEqual(0);
        expect(frame.x + frame.width).toBeLessThanOrEqual(layout.width);
        expect(frame.y + frame.height).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it('never overlaps two frames (a rock can never be cropped by its neighbour)', () => {
    const layout = asteroidAtlasLayout(ASTEROID_TIER_DATA);
    const frames = ASTEROID_PALETTE_TIERS.flatMap(
      (tier) => layout.tiers[tier].frames,
    );
    for (let a = 0; a < frames.length; a += 1) {
      for (let b = a + 1; b < frames.length; b += 1) {
        const first = frames[a];
        const second = frames[b];
        const overlaps =
          first.x < second.x + second.width &&
          second.x < first.x + first.width &&
          first.y < second.y + second.height &&
          second.y < first.y + first.height;
        expect(overlaps).toBe(false);
      }
    }
  });
});

describe('asteroidVariantFromDraws', () => {
  it('is deterministic for the same draws', () => {
    const draws = [8, 0.1, 0.2, 0.3, 0.4];
    expect(asteroidVariantFromDraws(draws)).toBe(asteroidVariantFromDraws(draws));
  });

  it('always returns a variant the palette bakes', () => {
    for (let index = 0; index < 200; index += 1) {
      const variant = asteroidVariantFromDraws([1, index / 200, index / 7]);
      expect(Number.isInteger(variant)).toBe(true);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(ASTEROID_PALETTE_VARIANTS_PER_TIER);
    }
  });

  it('spreads a real draw stream across more than one variant', () => {
    const variants = new Set<number>();
    for (let index = 0; index < 40; index += 1) {
      variants.add(
        asteroidVariantFromDraws([9, index / 40, (index * 7) / 40, 0.5]),
      );
    }
    expect(variants.size).toBeGreaterThan(1);
  });

  it('never exceeds a caller-supplied palette size', () => {
    expect(asteroidVariantFromDraws([1, 2, 3], 3)).toBeLessThan(3);
  });

  it('falls back to variant 0 for an empty stream', () => {
    expect(asteroidVariantFromDraws([])).toBe(0);
  });
});

describe('acquireAsteroidPalette', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('bakes one atlas texture and registers every palette frame', async () => {
    booted = await bootScene([HarnessScene]);
    const palette = acquireAsteroidPalette(booted.scene, ASTEROID_TIER_DATA);

    expect(palette).not.toBeNull();
    expect(palette!.key).toBe(ASTEROID_ATLAS_KEY);
    expect(palette!.variantsPerTier).toBe(ASTEROID_PALETTE_VARIANTS_PER_TIER);

    const texture = booted.scene.textures.get(palette!.key);
    expect(texture.key).toBe(ASTEROID_ATLAS_KEY);
    for (const tier of ASTEROID_PALETTE_TIERS) {
      expect(palette!.tiers[tier].frames).toHaveLength(
        ASTEROID_PALETTE_VARIANTS_PER_TIER,
      );
      for (const frame of palette!.tiers[tier].frames) {
        expect(texture.has(frame)).toBe(true);
      }
    }
  });

  it('reuses the same texture on every later acquisition (baked once per game)', async () => {
    booted = await bootScene([HarnessScene]);
    const first = acquireAsteroidPalette(booted.scene, ASTEROID_TIER_DATA)!;
    const texture = booted.scene.textures.get(first.key);

    const second = acquireAsteroidPalette(booted.scene, ASTEROID_TIER_DATA)!;

    expect(second.key).toBe(first.key);
    expect(booted.scene.textures.get(second.key)).toBe(texture);
  });

  it('refuses a scene that cannot bake canvas textures', () => {
    expect(acquireAsteroidPalette(undefined, ASTEROID_TIER_DATA)).toBeNull();
    expect(
      acquireAsteroidPalette({} as unknown as Phaser.Scene, ASTEROID_TIER_DATA),
    ).toBeNull();
  });
});

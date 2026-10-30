/**
 * Smoke tests for the shared background texture fixture
 * (`src/test/backgroundFixtures.ts`, slice 1 of parent AH-0MVIB7PD50029ZY1).
 *
 * The fixture lets scene-level background suites register a synthetic texture
 * for every manifest key instead of shipping real JPEGs. This suite pins that
 * contract: every key becomes a registered texture of the declared fixture
 * size, keys are visually distinct (deterministic colour), registration is
 * idempotent, and the "missing keys" probe the scene suites rely on is
 * accurate.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from './gameHarness';
import { BACKGROUND_TEXTURE_KEYS } from '../data/backgrounds';
import {
  BACKGROUND_FIXTURE_SIZE,
  backgroundFixtureColour,
  missingBackgroundTextures,
  registerBackgroundTextures,
} from './backgroundFixtures';

class BackgroundFixtureScene extends Phaser.Scene {}

describe('backgroundFixtures — shared synthetic background textures', () => {
  const games: Phaser.Game[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.destroy(true);
  });

  async function bootFixtureScene(): Promise<Phaser.Scene> {
    const booted = await bootScene([BackgroundFixtureScene]);
    games.push(booted.game);
    return booted.scene;
  }

  it('registers a texture for every pool key', async () => {
    const scene = await bootFixtureScene();
    expect(missingBackgroundTextures(scene)).toEqual(
      [...BACKGROUND_TEXTURE_KEYS],
    );

    registerBackgroundTextures(scene);

    expect(missingBackgroundTextures(scene)).toEqual([]);
    for (const key of BACKGROUND_TEXTURE_KEYS) {
      expect(scene.textures.exists(key), key).toBe(true);
      const texture = scene.textures.get(key);
      expect(texture.source[0].width).toBe(BACKGROUND_FIXTURE_SIZE);
      expect(texture.source[0].height).toBe(BACKGROUND_FIXTURE_SIZE);
    }
  });

  it('is idempotent — registering twice keeps one texture per key', async () => {
    const scene = await bootFixtureScene();
    registerBackgroundTextures(scene);
    const before = BACKGROUND_TEXTURE_KEYS.map(
      (key) => scene.textures.get(key).source[0],
    );

    expect(() => registerBackgroundTextures(scene)).not.toThrow();

    const after = BACKGROUND_TEXTURE_KEYS.map(
      (key) => scene.textures.get(key).source[0],
    );
    expect(after).toEqual(before);
  });

  it('registers only the requested subset when keys are passed', async () => {
    const scene = await bootFixtureScene();
    const subset = BACKGROUND_TEXTURE_KEYS.slice(0, 3);

    registerBackgroundTextures(scene, subset);

    expect(missingBackgroundTextures(scene, subset)).toEqual([]);
    expect(missingBackgroundTextures(scene)).toHaveLength(
      BACKGROUND_TEXTURE_KEYS.length - subset.length,
    );
  });

  it('gives every key a deterministic, distinct placeholder colour', () => {
    const colours = BACKGROUND_TEXTURE_KEYS.map(backgroundFixtureColour);
    expect(new Set(colours.map((colour) => colour.toLowerCase())).size).toBe(
      BACKGROUND_TEXTURE_KEYS.length,
    );
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    // Same input → same colour (no randomness in the fixture).
    expect(backgroundFixtureColour(BACKGROUND_TEXTURE_KEYS[0])).toBe(
      colours[0],
    );
  });

  it('reports missing keys without mutating the texture manager', async () => {
    const scene = await bootFixtureScene();
    const missing = missingBackgroundTextures(scene);
    expect(missing).toHaveLength(BACKGROUND_TEXTURE_KEYS.length);
    expect(missingBackgroundTextures(scene)).toEqual(missing);
  });
});

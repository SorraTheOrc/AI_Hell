/**
 * Cached enemy-body texture helpers (AH-0MW2IRYAH0055WCN).
 *
 * The pure surface — the cache key, the texture size and the "cannot bake"
 * guard — is pinned here. The rendering behaviour (a baked body sprite, shared
 * per silhouette) is pinned against a real Phaser scene in
 * `src/entities/BaseEnemy.bodyTexture.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';

import {
  ENEMY_BODY_EXTENT_MARGIN,
  ENEMY_BODY_TEXTURE_KEY_PREFIX,
  ENEMY_BODY_TEXTURE_PADDING,
  MAX_BAKED_ENEMY_BODY_TEXTURES,
  bakeEnemyBodyTexture,
  enemyBodyExtent,
  enemyBodyTextureKey,
  enemyBodyTextureSize,
} from './enemyBodyTextures';

/** A stand-in command buffer shaped like a stroked shape's commands. */
const TANK_LIKE = [1, 2.5, 0xff6600, 1, 10, 0, 8, 0, 6, -8, 4, 8, 5, 0];

describe('enemyBodyTextureKey', () => {
  it('is a pure function of the drawn commands and the extent', () => {
    expect(enemyBodyTextureKey([TANK_LIKE], 12)).toBe(
      enemyBodyTextureKey([TANK_LIKE], 12),
    );
  });

  it('changes when any drawn command changes', () => {
    const recoloured = [...TANK_LIKE];
    recoloured[2] = 0x00ff00;

    expect(enemyBodyTextureKey([recoloured], 12)).not.toBe(
      enemyBodyTextureKey([TANK_LIKE], 12),
    );
  });

  it('changes when the texture extent changes', () => {
    expect(enemyBodyTextureKey([TANK_LIKE], 12)).not.toBe(
      enemyBodyTextureKey([TANK_LIKE], 20),
    );
  });

  it('does not collide on adjacent numeric values', () => {
    expect(enemyBodyTextureKey([[1, 23]], 12)).not.toBe(
      enemyBodyTextureKey([[12, 3]], 12),
    );
  });

  it('distinguishes a composite of two layers from either layer alone', () => {
    const ring = [1, 2, 0xff00ff, 1, 0, 0, 9];
    const core = [2, 0xff00ff, 0.8, 0, 0, 5];

    expect(enemyBodyTextureKey([ring, core], 12)).not.toBe(
      enemyBodyTextureKey([ring], 12),
    );
    expect(enemyBodyTextureKey([ring, core], 12)).not.toBe(
      enemyBodyTextureKey([core, ring], 12),
    );
  });

  it('namespaces every key with the shared prefix', () => {
    expect(enemyBodyTextureKey([TANK_LIKE], 12)).toMatch(
      new RegExp(`^${ENEMY_BODY_TEXTURE_KEY_PREFIX}-[0-9a-z]+$`),
    );
  });
});

describe('enemyBodyExtent / enemyBodyTextureSize', () => {
  it('covers the silhouette plus its stroke margin', () => {
    expect(enemyBodyExtent(16)).toBe(8 + ENEMY_BODY_EXTENT_MARGIN);
  });

  it('sizes the texture to the full extent plus transparent padding', () => {
    // extent 12 → 24 px of geometry + padding on both sides.
    expect(enemyBodyTextureSize(12)).toBe(24 + ENEMY_BODY_TEXTURE_PADDING * 2);
  });

  it('never returns a degenerate texture', () => {
    // Zero/NaN extent still yields padding on both sides, so the texture is
    // never zero-sized (a zero-width canvas texture is invalid).
    expect(enemyBodyTextureSize(0)).toBe(ENEMY_BODY_TEXTURE_PADDING * 2);
    expect(enemyBodyTextureSize(Number.NaN)).toBe(
      ENEMY_BODY_TEXTURE_PADDING * 2,
    );
    expect(enemyBodyExtent(0)).toBe(ENEMY_BODY_EXTENT_MARGIN);
  });
});

describe('bakeEnemyBodyTexture guards', () => {
  it('refuses a scene that cannot create canvas textures', () => {
    expect(
      bakeEnemyBodyTexture({} as unknown as Phaser.Scene, [], 12),
    ).toBeNull();
    expect(bakeEnemyBodyTexture(undefined, [], 12)).toBeNull();
  });

  it('refuses when no source layer has anything drawn', () => {
    const textures = {
      createCanvas: () => undefined,
      exists: () => false,
    };
    const scene = {
      textures,
      make: { graphics: () => undefined },
      sys: { game: { renderer: {} } },
    } as unknown as Phaser.Scene;
    const empty = { commandBuffer: [] } as unknown as Phaser.GameObjects.Graphics;

    expect(bakeEnemyBodyTexture(scene, [empty], 12)).toBeNull();
  });

  it('bounds the per-game texture cache', () => {
    // Every key already in the manager looks like a baked body texture, so the
    // cache is reported full and the caller keeps its Graphics body.
    const keys = Array.from(
      { length: MAX_BAKED_ENEMY_BODY_TEXTURES },
      (_, index) => `${ENEMY_BODY_TEXTURE_KEY_PREFIX}-${index}`,
    );
    const textures = {
      createCanvas: () => undefined,
      exists: () => false,
      getTextureKeys: () => keys,
    };
    const scene = {
      textures,
      make: { graphics: () => undefined },
      sys: { game: { renderer: {} } },
    } as unknown as Phaser.Scene;
    const drawn = { commandBuffer: TANK_LIKE } as unknown as Phaser.GameObjects.Graphics;

    expect(bakeEnemyBodyTexture(scene, [drawn], 12)).toBeNull();
  });
});

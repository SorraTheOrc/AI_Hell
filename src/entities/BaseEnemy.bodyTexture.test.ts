/**
 * Baked enemy-body rendering (AH-0MW2IRYAH0055WCN).
 *
 * The enemy body silhouette never changes after construction, so it is baked
 * once per distinct silhouette into a cached texture and rendered as one
 * batched sprite instead of re-tessellating a Graphics command buffer on every
 * frame. These tests pin the observable behaviour of that seam against a real
 * Phaser scene: the body is a sprite, identical silhouettes share one cached
 * texture, a different silhouette does not, and hiding the body on destruction
 * still hides what is actually drawn.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { ENEMY_BODY_TEXTURE_KEY_PREFIX } from '../utils/enemyBodyTextures';
import { PhaserEntity } from './Phaser';
import { Tank } from './Tank';

/** Minimal scene that only constructs enemy entities (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BodyTextureHarnessScene');
  }
}

/** The entity's rendered body sprites (exactly one when the body is baked). */
function bodySprites(entity: Phaser.GameObjects.Container): Phaser.GameObjects.Image[] {
  return entity.list.filter(
    (child): child is Phaser.GameObjects.Image =>
      child instanceof Phaser.GameObjects.Image,
  );
}

/** The entity's drawn body Graphics (the bake source). */
function bodyGraphicsOf(
  entity: Phaser.GameObjects.Container,
): Phaser.GameObjects.Graphics {
  return (entity as unknown as { bodyGraphics: Phaser.GameObjects.Graphics })
    .bodyGraphics;
}

/** Every baked enemy-body texture currently in the game's texture manager. */
function bodyTextureKeys(scene: Phaser.Scene): string[] {
  return scene.textures
    .getTextureKeys()
    .filter((key) => key.startsWith(`${ENEMY_BODY_TEXTURE_KEY_PREFIX}-`));
}

describe('baked enemy body layer (AH-0MW2IRYAH0055WCN)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HarnessScene]);
    return booted.scene;
  }

  it('renders the body as one cached sprite instead of a Graphics layer', async () => {
    const scene = await boot();
    const tank = new Tank(scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });

    const sprites = bodySprites(tank);
    expect(sprites).toHaveLength(1);
    expect(sprites[0].texture.key).toMatch(
      new RegExp(`^${ENEMY_BODY_TEXTURE_KEY_PREFIX}-`),
    );

    // The drawn Graphics is kept as the silhouette's record but is no longer
    // part of the rendered container.
    const body = bodyGraphicsOf(tank);
    expect(body.commandBuffer.length).toBeGreaterThan(0);
    expect(tank.list).not.toContain(body);
  });

  it('shares one cached texture across every enemy with the same silhouette', async () => {
    const scene = await boot();
    const offsets = [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
    ];
    const tanks = offsets.map(
      (formationOffset) => new Tank(scene, { x: 100, y: 100, formationOffset }),
    );

    const keys = tanks.map((tank) => bodySprites(tank)[0].texture.key);
    expect(new Set(keys).size).toBe(1);
    expect(bodyTextureKeys(scene)).toHaveLength(1);
  });

  it('bakes a different texture for a different body colour', async () => {
    const scene = await boot();
    const orange = new Tank(scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });
    const green = new Tank(scene, {
      x: 200,
      y: 100,
      formationOffset: { row: 0, col: 0 },
      color: 0x00ff00,
    });

    expect(bodySprites(green)[0].texture.key).not.toBe(
      bodySprites(orange)[0].texture.key,
    );
    expect(bodyTextureKeys(scene)).toHaveLength(2);
  });

  it('hides the rendered body on destruction', async () => {
    const scene = await boot();
    const tank = new Tank(scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });
    const sprite = bodySprites(tank)[0];
    expect(sprite.alpha).toBe(1);

    tank.destroySilently();

    expect(sprite.alpha).toBe(0);
  });

  it('bakes the Phaser ring and core as one body sprite', async () => {
    const scene = await boot();
    const phaser = new PhaserEntity(scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });

    const sprites = bodySprites(phaser);
    expect(sprites).toHaveLength(1);
    expect(sprites[0].texture.key).toMatch(
      new RegExp(`^${ENEMY_BODY_TEXTURE_KEY_PREFIX}-`),
    );
    expect(phaser.bodyVisible).toBe(true);

    phaser.destroySilently();

    expect(sprites[0].alpha).toBe(0);
    expect(phaser.bodyVisible).toBe(false);
  });

  it('keeps the body drawn when the scene cannot bake textures', async () => {
    const scene = await boot();
    const tank = new Tank(scene, {
      x: 100,
      y: 100,
      formationOffset: { row: 0, col: 0 },
    });
    const image = bodySprites(tank)[0];

    // Simulate a scene that loses canvas support (the unit-test harness has an
    // inert 2D context): the next enemy keeps its Graphics body, which is the
    // pre-change rendering path.
    const textures = scene.textures as unknown as { createCanvas: unknown };
    const original = textures.createCanvas;
    textures.createCanvas = undefined;
    try {
      const fallback = new Tank(scene, {
        x: 200,
        y: 100,
        formationOffset: { row: 0, col: 0 },
      });

      expect(bodySprites(fallback)).toHaveLength(0);
      expect(fallback.list).toContain(bodyGraphicsOf(fallback));
      // The already-baked enemy is unaffected.
      expect(bodySprites(tank)).toEqual([image]);
      expect(tank.list).toContain(image);
    } finally {
      textures.createCanvas = original;
    }
  });
});

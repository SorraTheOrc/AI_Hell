/**
 * Shared background layer — create / dim / swap / destroy
 * (parent AH-0MVIB7PD50029ZY1, slice AH-0MVSEB7SA004B26C).
 *
 * `PlayScene` used to draw its own inline black rectangle and `CombatScene`
 * relied on the camera's configured `backgroundColor`; gyms drew no backdrop
 * at all. This module owns the whole lifecycle exactly once so the game and
 * every gym render the same backdrop from the same code (AGENTS.md
 * gym↔game parity rule). The shared `CombatCoreScene` wraps it as the
 * {@link CombatCoreScene._createBackground} / `_setBackgroundLevel` hooks and
 * destroys it from `teardownRunState()`.
 *
 * ## Layering
 *
 * - the photo ({@link BackgroundLayer.image}) sits at {@link BACKGROUND_DEPTH}
 *   — full canvas (960×540), origin top-left, camera-fixed
 *   (`scrollFactor(0)`), **non-interactive**;
 * - the dim overlay ({@link BackgroundLayer.dim}) sits at
 *   {@link BACKGROUND_DIM_DEPTH}: above the photo, below the juice layers and
 *   gameplay, so the neon vector art stays legible against a busy nebula;
 * - with no texture the layer draws the solid {@link BACKGROUND_FALLBACK_COLOR}
 *   rectangle instead (no throw, no repeated warning) and hides the dim overlay
 *   (dimming black is pointless).
 *
 * ## Texture availability
 *
 * Creating an `Image` for a texture that is not registered would make Phaser
 * warn and draw its `__MISSING` placeholder, so {@link
 * BackgroundLayer.setLevel} checks `scene.textures.exists(key)` first. A level
 * whose texture arrives *later* (a loader finishing after the scene starts) is
 * picked up when the level is set again: while a photo is displayed an
 * unchanged level is a strict no-op, while a fallback retries the lookup.
 *
 * @module scenes/core/backgroundLayer
 */

import Phaser from 'phaser';

import { backgroundForLevel } from '../../data/backgrounds';
import {
  BACKGROUND_DEPTH,
  BACKGROUND_DIM_ALPHA,
  BACKGROUND_DIM_COLOR,
  BACKGROUND_DIM_DEPTH,
  BACKGROUND_FALLBACK_COLOR,
  GAME_HEIGHT,
  GAME_WIDTH,
} from '../../core/constants';

/**
 * Handle to one scene's background layer — the entire lifecycle surface every
 * scene consumes.
 */
export interface BackgroundLayer {
  /**
   * The level's photo, or `null` while the solid fallback is showing.
   * Deliberately non-interactive: no hit area is ever attached.
   */
  readonly image: Phaser.GameObjects.Image | null;
  /** The readability dim overlay, above the photo and below gameplay. */
  readonly dim: Phaser.GameObjects.Rectangle;
  /**
   * Shows `level`'s background (`backgroundForLevel`) — idempotent: an
   * unchanged level with a displayed photo creates nothing and destroys
   * nothing. A missing texture falls back to the solid colour.
   */
  setLevel(level: number): void;
  /** Removes every display object this layer created; safe to repeat. */
  destroy(): void;
  /** The current level's texture key, or `null` after {@link destroy}. */
  textureKey(): string | null;
}

/** Phaser fill colour for a `#rrggbb` tuning constant. */
function fillOf(colour: string): number {
  return Phaser.Display.Color.HexStringToColor(colour).color;
}

/** The single implementation behind {@link BackgroundLayer}. */
class SharedBackgroundLayer implements BackgroundLayer {
  private readonly scene: Phaser.Scene;
  private readonly dimLayer: Phaser.GameObjects.Rectangle;
  private photo: Phaser.GameObjects.Image | null = null;
  private fallback: Phaser.GameObjects.Rectangle | null = null;
  private key: string | null = null;
  private destroyed = false;

  constructor(
    scene: Phaser.Scene,
    dim: Phaser.GameObjects.Rectangle,
  ) {
    this.scene = scene;
    this.dimLayer = dim;
  }

  get image(): Phaser.GameObjects.Image | null {
    return this.photo;
  }

  get dim(): Phaser.GameObjects.Rectangle {
    return this.dimLayer;
  }

  textureKey(): string | null {
    return this.key;
  }

  setLevel(level: number): void {
    if (this.destroyed) return;
    const key = backgroundForLevel(level);
    // Idempotent while a photo for this level is already displayed: a
    // level-refresh tick must never churn the display list. A fallback retries
    // the lookup so a texture registered after creation is picked up.
    if (key === this.key && this.photo !== null) return;

    this.key = key;
    if (this.scene.textures.exists(key)) {
      this.destroyPhoto();
      this.destroyFallback();
      // Full canvas, camera-fixed and non-interactive: no `setInteractive`
      // call, so pointer input passes straight through to the gameplay layer.
      this.photo = this.scene.add
        .image(0, 0, key)
        .setOrigin(0)
        .setDisplaySize(GAME_WIDTH, GAME_HEIGHT)
        .setScrollFactor(0)
        .setDepth(BACKGROUND_DEPTH);
      this.dimLayer.setVisible(true);
      return;
    }

    this.destroyPhoto();
    this.dimLayer.setVisible(false);
    this.ensureFallback();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyPhoto();
    this.destroyFallback();
    this.dimLayer.destroy();
    this.key = null;
  }

  /** Draws the solid fallback once, when the scene has no backdrop texture. */
  private ensureFallback(): void {
    if (this.fallback !== null) return;
    const colour = BACKGROUND_FALLBACK_COLOR;
    if (colour === null) return;
    this.fallback = this.scene.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, fillOf(colour))
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(BACKGROUND_DEPTH);
  }

  private destroyPhoto(): void {
    this.photo?.destroy();
    this.photo = null;
  }

  private destroyFallback(): void {
    this.fallback?.destroy();
    this.fallback = null;
  }
}

/**
 * Creates the shared background layer for `scene`, showing `level`'s backdrop.
 *
 * Never throws: an unregistered texture simply yields the solid fallback, so a
 * scene can boot before its backdrop asset is available.
 *
 * @param scene - The scene that owns the layer (and its display list).
 * @param level - 1-based campaign level (defaults to level 1).
 */
export function createBackgroundLayer(
  scene: Phaser.Scene,
  level = 1,
): BackgroundLayer {
  const dim = scene.add
    .rectangle(
      0,
      0,
      GAME_WIDTH,
      GAME_HEIGHT,
      fillOf(BACKGROUND_DIM_COLOR),
      BACKGROUND_DIM_ALPHA,
    )
    .setOrigin(0)
    .setScrollFactor(0)
    .setDepth(BACKGROUND_DIM_DEPTH)
    .setVisible(false);
  const layer = new SharedBackgroundLayer(scene, dim);
  layer.setLevel(level);
  return layer;
}

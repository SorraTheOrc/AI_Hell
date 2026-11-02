/**
 * Shared deterministic background-texture fixtures for scene-level suites
 * (slice 1 of parent AH-0MVIB7PD50029ZY1).
 *
 * This module is **test infrastructure only** — nothing here is imported by
 * production code. Scene tests that need background textures (the shared
 * background layer, the warp VFX, `PlayScene` wiring and the gym parity
 * suites) call {@link registerBackgroundTextures} instead of shipping real
 * JPEGs or inventing their own texture stubs. Every key from the production
 * manifest gets a small synthetic canvas texture, so a suite can boot a real
 * scene under happy-dom (whose canvas context is stubbed — no pixels are
 * rendered) and still exercise the real `scene.textures` lookups.
 *
 * Registration is **idempotent**: an already-registered key is left untouched,
 * so suites can call it in `beforeEach` without leaking textures or churning
 * the texture manager.
 *
 * @module test/backgroundFixtures
 */

import type Phaser from 'phaser';

import { BACKGROUND_TEXTURE_KEYS } from '../data/backgrounds';

/**
 * Side length (px) of every synthetic background texture.
 *
 * Deliberately tiny: the fixture is only ever used to satisfy texture lookups
 * (`scene.textures.exists` / `image(key)`) in tests where no pixel is read
 * back. Backgrounds render at the full 960×540 canvas by scaled image
 * placement, so the fixture size carries no gameplay meaning.
 */
export const BACKGROUND_FIXTURE_SIZE = 8;

/**
 * Deterministic placeholder colour for a background texture key.
 *
 * Derived from the key's character codes (FNV-1a over the key) so different
 * keys get visibly different, stable colours — useful when a failing test
 * prints which texture it saw — and the same key always gets the same colour
 * (no randomness, so fixtures never make a suite flaky).
 *
 * @param textureKey - A key from `BACKGROUND_TEXTURE_KEYS`.
 * @returns A lowercase `#rrggbb` colour string.
 */
export function backgroundFixtureColour(textureKey: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < textureKey.length; i += 1) {
    hash ^= textureKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Keep every channel mid-to-dark so a placeholder never reads as a bright
  // overlay if a renderer is ever available.
  const channel = (shift: number): number => 0x20 + ((hash >>> shift) & 0x7f);
  const toHex = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${toHex(channel(0))}${toHex(channel(8))}${toHex(channel(16))}`;
}

/**
 * Which of `keys` have no registered texture in this scene.
 *
 * Scene suites use this for a single, readable precondition/assertion instead
 * of repeating `scene.textures.exists(...)` loops.
 *
 * @param scene - The scene whose texture manager to inspect.
 * @param keys  - Keys to check (defaults to the full production pool).
 * @returns The missing keys, in the order given.
 */
export function missingBackgroundTextures(
  scene: Phaser.Scene,
  keys: readonly string[] = BACKGROUND_TEXTURE_KEYS,
): string[] {
  return keys.filter((key) => !scene.textures.exists(key));
}

/**
 * Registers a synthetic texture for every requested background key.
 *
 * Each texture is a {@link BACKGROUND_FIXTURE_SIZE}² canvas filled with its
 * deterministic {@link backgroundFixtureColour}. Already-registered keys are
 * skipped, so the helper is idempotent and safe in `beforeEach`.
 *
 * @param scene - The scene whose texture manager receives the fixtures.
 * @param keys  - Keys to register (defaults to the full production pool).
 * @returns The keys that were registered by **this** call (for callers that
 *   assert on the freshly created set); use
 *   {@link missingBackgroundTextures} to assert the overall state.
 */
export function registerBackgroundTextures(
  scene: Phaser.Scene,
  keys: readonly string[] = BACKGROUND_TEXTURE_KEYS,
): string[] {
  const registered: string[] = [];
  for (const key of keys) {
    if (scene.textures.exists(key)) continue;
    const texture = scene.textures.createCanvas(
      key,
      BACKGROUND_FIXTURE_SIZE,
      BACKGROUND_FIXTURE_SIZE,
    );
    if (texture === null) continue;
    const context = texture.getContext();
    context.fillStyle = backgroundFixtureColour(key);
    context.fillRect(0, 0, BACKGROUND_FIXTURE_SIZE, BACKGROUND_FIXTURE_SIZE);
    texture.refresh();
    registered.push(key);
  }
  return registered;
}

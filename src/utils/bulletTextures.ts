/**
 * Cached bullet-shape **textures** (AH-0MW2DAY2L004QSKF).
 *
 * ## Why
 *
 * Every projectile used to be its own `Phaser.GameObjects.Graphics` object:
 * the shape was re-triangulated (earcut) and the whole Graphics pipeline was
 * re-batched and re-submitted every frame. At 100 late-game enemies with
 * ~200–345 live bullets that measured **≈ 10 % of the frame window
 * (≈ 68 % of JS)** and drove most of the 84.75 % native GL submission time —
 * the #1 measured hotspot (`docs/PERFORMANCE.md`, Ranked hotspots).
 *
 * A shape's silhouette (shape + colour + rim + tail) never changes in flight,
 * so it is **baked once per spec** into a Phaser canvas texture and every
 * bullet of that spec is one plain sprite: a single batched draw call for all
 * bullets sharing the texture, no per-frame path triangulation and no
 * per-object Graphics pipeline.
 *
 * ## Visual equivalence
 *
 * The bake path is the **same** `drawBulletShape` seam the game and every gym
 * already used (AGENTS.md gym↔game parity), so the silhouette is identical by
 * construction — only *when* it is drawn changes (once, at bake time, instead
 * of every frame). Time-driven parts (`spec.time`) are baked at `time = 0`,
 * which is the **mean phase** of every animated part (the pellet's pulse ring,
 * the heavy shell's breathing glow, the shard's glint, the missile/warhead
 * flames), and the shapes whose motion reads as a pulse/breathe/shimmer are
 * then animated with **sprite scale/alpha** by {@link animateBulletView} — no
 * per-frame `drawBulletShape` redraw. `shapeAnimates` still names the shapes
 * that move in flight.
 *
 * ## Caching
 *
 * Textures live in the game's `TextureManager`, so the cache is **per game**
 * and shared by every scene, every bullet and every gym: the second bullet of
 * a spec costs nothing. {@link bulletTextureKey} is a pure function of the
 * visual spec, so two bullets with the same look always share one texture.
 *
 * @module utils/bulletTextures
 */

import type Phaser from 'phaser';

import {
  DEFAULT_SHAPE_LENGTH,
  drawBulletShape,
  type BulletVisualSpec,
} from './bulletVisuals';
import { canonicalShape } from './bulletShape';
import type { BulletShape } from './weapons';

/** How a baked bullet texture is animated in flight. */
export type BulletViewAnimation = 'none' | 'pulse' | 'breathe' | 'shimmer';

/** A cached bullet texture: its texture key and its in-flight animation. */
export interface BulletTexture {
  /** Texture key in the game's `TextureManager`. */
  readonly key: string;
  /** How the sprite animates in flight; `none` → a static sprite. */
  readonly animation: BulletViewAnimation;
}

/**
 * Transparent padding (px) added around every baked shape so an anti-aliased
 * rim/glow is never clipped by the texture edge.
 */
export const BULLET_TEXTURE_PADDING = 2;

/**
 * Radial extent of each shape as a multiple of the bullet radius. The value
 * covers the widest part of the silhouette (a rim, a glow ring, a bump or a
 * nose); the elongated axis is additionally covered by the shape length and
 * the tail/flame multipliers. Deliberately generous — an over-sized texture
 * costs a few bytes, a clipped bullet is a visual defect.
 */
const SHAPE_RADIAL_EXTENT: Record<BulletShape, number> = {
  circle: 1.1,
  disc: 1.1,
  line: 1,
  teardrop: 1.1,
  // The missile body/nose grows with the shape length (see the special case
  // in `bulletTextureExtent`), so this entry only covers its fins/rim.
  missile: 1.2,
  ring: 1.25,
  shell: 1.1,
  // The heavy shell's breathing glow ring sits at 1.9 × its 1.6 × body.
  'heavy-shell': 3.2,
  shard: 1.25,
  bolt: 1,
  'phaser-bolt': 1.05,
  fleck: 1.1,
  dart: 1.05,
  // The boss pellet's concentric "targeting halo" ring.
  'boss-pellet': 1.6,
  // The spiral pellet's trailing wake arc.
  'spiral-pellet': 1.9,
  'pulse-ring': 1.25,
  // The tracer's tail flare sweeps past its (long) body.
  tracer: 1.75,
  warhead: 1.15,
  diamond: 1.25,
  spark: 1.1,
  chevron: 1,
  // The pellet's three bumps and its faint outer pulse ring.
  pellet: 1.7,
};

/** Packs a colour into a short stable key fragment (`0x00ff00` → `ff00`). */
function hex(color: number): string {
  return (color >>> 0).toString(16).padStart(6, '0');
}

/** Rounds a numeric key fragment so float noise never splits the cache. */
function num(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * Half the side length (px) of the square texture a spec is baked into.
 *
 * Pure, so the bake size is testable without a Phaser boot. Covers the
 * elongated axis (`length`), the radial silhouette (rims/glows/bumps), the
 * fading tail and the animated flame, plus {@link BULLET_TEXTURE_PADDING}.
 *
 * @param spec - The visual metadata driving the draw.
 */
export function bulletTextureExtent(spec: BulletVisualSpec): number {
  const shape = canonicalShape(spec.shape);
  const radius = Math.max(0.1, spec.radius);
  const lengthMultiplier = spec.length ?? DEFAULT_SHAPE_LENGTH[shape];

  const radial = radius * SHAPE_RADIAL_EXTENT[shape];
  // The missile's nose sits at `0.4 × length + 1.1 × radius` from its centre
  // (_missile), so its extent grows with the length multiplier as well.
  const nose =
    shape === 'missile' ? radius * (lengthMultiplier * 0.4 + 1.1) : 0;
  const halfLength = (radius * lengthMultiplier) / 2;
  const wake = radius * ((spec.tail ?? 0) + (spec.flame ?? 0));

  return Math.ceil(
    Math.max(radial, nose, halfLength) + wake + BULLET_TEXTURE_PADDING,
  );
}

/**
 * Stable cache key for a bullet visual spec.
 *
 * Every field that changes the baked pixels is encoded (canonical shape,
 * colour, radius, elongation, rim, stroke thickness, alpha, tail and flame),
 * so two specs share a texture **exactly** when they look the same. Absent
 * `length`/`alpha`/`thickness` normalise to their documented defaults, so
 * `undefined` and an explicit default never mint two textures.
 *
 * @param spec - The visual metadata driving the draw.
 */
export function bulletTextureKey(spec: BulletVisualSpec): string {
  const shape = canonicalShape(spec.shape);
  const length = spec.length ?? DEFAULT_SHAPE_LENGTH[shape];
  const rim = spec.rimColor === undefined ? 'none' : hex(spec.rimColor);
  return [
    'bullet',
    shape,
    hex(spec.color),
    num(spec.radius),
    num(length),
    rim,
    num(spec.thickness ?? 1),
    num(spec.alpha ?? 1),
    num(spec.tail ?? 0),
    num(spec.flame ?? 0),
  ].join('-');
}

/**
 * How a baked shape animates in flight.
 *
 * `pulse` (the Scout/Invader pellet), `breathe` (the Tank's heavy shell) and
 * `shimmer` (the Diver's shard) are time-driven by `spec.time` in the drawn
 * shape; their motion is reproduced with sprite scale/alpha so no per-frame
 * `drawBulletShape` redraw is needed (AH-0MW2DAY2L004QSKF AC2). Every other
 * shape is static in flight.
 *
 * @param shape - The shape primitive.
 */
export function bulletViewAnimation(shape: BulletShape): BulletViewAnimation {
  switch (canonicalShape(shape)) {
    case 'pellet':
      return 'pulse';
    case 'heavy-shell':
      return 'breathe';
    case 'shard':
      return 'shimmer';
    default:
      return 'none';
  }
}

/** The sprite surface {@link animateBulletView} drives. */
export interface BulletAnimatedView {
  setScale(x: number, y?: number): unknown;
  setAlpha(value: number): unknown;
}

/**
 * Applies the in-flight animation for a baked bullet texture.
 *
 * Pure in `elapsed` (the bullet's own age), so the motion is deterministic
 * and identical in the game, every gym and any seeded run — it never depends
 * on the wall clock or frame rate. `none` is a no-op, so a static bullet
 * never pays for animation.
 *
 * @param view - The bullet sprite.
 * @param animation - The animation resolved by {@link bulletViewAnimation}.
 * @param elapsed - Seconds since the bullet spawned.
 */
export function animateBulletView(
  view: BulletAnimatedView,
  animation: BulletViewAnimation,
  elapsed: number,
): void {
  const t = Number.isFinite(elapsed) ? elapsed : 0;
  switch (animation) {
    case 'pulse': {
      // The pellet's faint pulse breathes at ~7 rad/s (_pellet); a small
      // scale swell plus an alpha breath reads as the same living pod.
      const pulse = Math.sin(t * 7);
      view.setScale(1 + 0.05 * pulse);
      view.setAlpha(0.92 + 0.04 * pulse);
      return;
    }
    case 'breathe': {
      // The heavy shell's slow breathing glow (1.8 rad/s in _heavyShell).
      const breathe = 0.5 + 0.5 * Math.sin(t * 1.8);
      view.setScale(1 + 0.02 * breathe);
      view.setAlpha(0.92 + 0.08 * breathe);
      return;
    }
    case 'shimmer': {
      // The shard's sweeping arc-energy glint (~9 rad/s in _shard).
      view.setAlpha(0.85 + 0.15 * Math.abs(Math.cos(t * 9)));
      return;
    }
    default:
      return;
  }
}

/**
 * Returns the cached texture for `spec`, baking it on first use.
 *
 * Idempotent and cheap after the first call: the key is a pure function of
 * the spec and the texture lives in the game's `TextureManager` (shared by
 * every scene, bullet and gym). The bake draws the shared `drawBulletShape`
 * seam into an **offscreen** Graphics (`scene.make.graphics`, never added to
 * the display list), bakes it with `generateTexture`, and destroys it — so no
 * per-bullet Graphics object is ever created (AC1).
 *
 * @param scene - The scene whose texture manager owns the cache.
 * @param spec - The visual metadata driving the draw.
 */
export function ensureBulletTexture(
  scene: Phaser.Scene,
  spec: BulletVisualSpec,
): BulletTexture {
  const shape = canonicalShape(spec.shape);
  const key = bulletTextureKey(spec);
  const animation = bulletViewAnimation(shape);

  if (!scene.textures.exists(key)) {
    const extent = bulletTextureExtent(spec);
    const size = extent * 2;
    // Offscreen: `make.graphics(..., false)` never enters the display list.
    const bake = scene.make.graphics({}, false);
    // Centre the shape in the texture: generateTexture draws the command
    // buffer at its own local coordinates, so the shape's origin is
    // translated to the texture centre.
    drawBulletShape(bake, spec, extent, extent);
    bake.generateTexture(key, size, size);
    bake.destroy();
  }

  return { key, animation };
}

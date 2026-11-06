/**
 * Cached enemy-body **textures** (AH-0MW2IRYAH0055WCN).
 *
 * ## Why
 *
 * After the projectile silhouettes were baked into textures
 * (`./bulletTextures`, AH-0MW2DAY2L004QSKF) the largest remaining per-frame
 * `Graphics` draw submission in the measured 100-enemy stress scenario was the
 * **enemy body itself**: every regular enemy drew its silhouette into its own
 * `Phaser.GameObjects.Graphics`, and Phaser re-walks that command buffer,
 * re-tessellates every stroke (`StrokePath` → `batch`, `earcut` for fills) and
 * re-submits it on **every frame**, even though the silhouette never changes
 * after construction. At `--cpu-throttle 4` that measured as
 * `GraphicsWebGLRenderer` 3.92 %, `batch` 2.92 % and the Graphics render-node
 * `run` functions 3.24 % of the measured window (≈ 11 % of the window,
 * ≈ 47 % of all JS) — the #1 remaining draw-submission hotspot
 * (`docs/PERFORMANCE.md`, [Baked enemy body textures](PERFORMANCE.md#baked-enemy-body-textures-ah-0mw2iryah0055wcn)).
 *
 * A body silhouette is a pure function of the commands a subclass queued in
 * `_drawBody()`, so it is **baked once per distinct silhouette** into a Phaser
 * canvas texture and every enemy with that silhouette renders as one plain
 * sprite: a single batched quad per enemy, no per-frame path triangulation and
 * no per-object Graphics pipeline pass.
 *
 * ## Visual equivalence
 *
 * The bake renders the **same command buffer** the subclass drew — it does not
 * re-implement any drawing — through Phaser's own canvas Graphics renderer
 * (`Graphics.generateTexture`), so the silhouette is identical by construction
 * and only *when* it is drawn changes (once, at bake time, instead of every
 * frame). The only transform added is a translation that centres the shape in
 * the texture, because `generateTexture` maps the Graphics origin onto the
 * texture's top-left corner.
 *
 * ## Caching
 *
 * Textures live in the game's `TextureManager`, so the cache is **per game**
 * and shared by every enemy, every scene and every gym. {@link
 * enemyBodyTextureKey} is a pure function of the drawn command buffers, so two
 * enemies with the same silhouette (same archetype, size and colour) always
 * share one texture — and two with a different one never collide. The cache is
 * bounded ({@link MAX_BAKED_ENEMY_BODY_TEXTURES}); past the bound a new
 * silhouette keeps its `Graphics` body, so a pathological stream of unique
 * silhouettes (the asteroid field's seeded jagged polygons are one per rock)
 * cannot grow the texture cache without limit.
 *
 * ## Headless safety
 *
 * {@link bakeEnemyBodyTexture} returns `null` for a scene that cannot create
 * canvas textures or render (stub scenes, and the unit-test harness whose 2D
 * context is inert), and the caller then attaches the `Graphics` exactly as
 * before. Rendering behaviour therefore degrades to the pre-change path rather
 * than failing.
 *
 * @module utils/enemyBodyTextures
 */

import type Phaser from 'phaser';

/** Transparent padding (px) baked around a silhouette so an anti-aliased edge is never clipped. */
export const ENEMY_BODY_TEXTURE_PADDING = 2;

/**
 * How far (px) a body silhouette may reach beyond the entity's `size / 2`.
 *
 * Every archetype draws within ±`size / 2` plus half its stroke width (the
 * widest is the harvester's 3 px shell), so 4 px covers the stroke and the
 * anti-aliased edge with no wasted texture area.
 */
export const ENEMY_BODY_EXTENT_MARGIN = 4;

/** Half-extent (px) a silhouette of the given entity `size` can occupy. */
export function enemyBodyExtent(size: number): number {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
  return safeSize / 2 + ENEMY_BODY_EXTENT_MARGIN;
}

/** Prefix of every baked enemy-body texture key. */
export const ENEMY_BODY_TEXTURE_KEY_PREFIX = 'enemy-body';

/**
 * Maximum number of baked enemy-body textures per game.
 *
 * Reached only by a stream of *unique* silhouettes (each asteroid's jagged
 * polygon is seeded, so every rock is its own spec). 64 covers every
 * archetype × size × colour the shipped game and gyms field with room to
 * spare; past it, new silhouettes keep their `Graphics` body, which is the
 * pre-change behaviour.
 */
export const MAX_BAKED_ENEMY_BODY_TEXTURES = 64;

/** A baked body texture: its cache key and its square texture size. */
export interface EnemyBodyTexture {
  /** Texture key in the game's `TextureManager`. */
  readonly key: string;
  /** Square texture edge length (px). */
  readonly size: number;
}

/**
 * 32-bit FNV-1a hash of a numeric sequence.
 *
 * Values are hashed through their shortest round-trip string form, so two
 * different geometries never hash to the same digest for a different reason
 * than a genuine 32-bit collision.
 */
function hashNumbers(values: readonly unknown[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const text = typeof value === 'number' ? String(value) : `${typeof value}`;
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
 * Pure cache key for a body silhouette.
 *
 * A function of the drawn command buffers (which encode shape, colour, line
 * width and alpha) and the texture extent, so it changes whenever the rendered
 * silhouette would.
 */
export function enemyBodyTextureKey(
  commandBuffers: readonly (readonly unknown[])[],
  extent: number,
): string {
  const parts: unknown[] = ['v1', extent, commandBuffers.length];
  for (const buffer of commandBuffers) {
    parts.push(buffer.length);
    for (const command of buffer) parts.push(command);
  }
  return `${ENEMY_BODY_TEXTURE_KEY_PREFIX}-${hashNumbers(parts).toString(36)}`;
}

/** Square texture edge length for a silhouette with the given half-extent (px). */
export function enemyBodyTextureSize(extent: number): number {
  const safeExtent = Number.isFinite(extent) && extent > 0 ? extent : 0;
  return Math.max(
    1,
    Math.ceil(safeExtent * 2) + ENEMY_BODY_TEXTURE_PADDING * 2,
  );
}

/** Number of already-baked enemy-body textures in this game. */
function bakedTextureCount(
  textures: Phaser.Textures.TextureManager,
): number {
  const keys = textures.getTextureKeys?.() ?? [];
  let count = 0;
  for (const key of keys) {
    if (key.startsWith(`${ENEMY_BODY_TEXTURE_KEY_PREFIX}-`)) count += 1;
  }
  return count;
}

/**
 * Whether this scene can bake a texture at all.
 *
 * False for stub/headless scenes (no texture manager, no renderer, or no
 * canvas support), which is what keeps the change a no-op in the unit-test
 * harness. Exported so every bake seam (this one and the shared asteroid
 * atlas in `./asteroidTextures`) applies the **same** guard.
 */
export function canBakeTextures(scene: Phaser.Scene | undefined): boolean {
  if (!scene) return false;
  const textures = scene.textures;
  if (!textures || typeof textures.createCanvas !== 'function') return false;
  if (typeof textures.exists !== 'function') return false;
  if (typeof scene.make?.graphics !== 'function') return false;
  return Boolean(scene.sys?.game?.renderer);
}

/**
 * Bake (or reuse) a cached texture for one enemy body silhouette.
 *
 * @param scene — the scene the enemy belongs to (texture manager + renderer)
 * @param sources — the static `Graphics` layers that make up the body, in
 *   render order; their command buffers are baked as one composite
 * @param extent — half-extent (px) the silhouette occupies around its origin,
 *   which sets the square texture size
 * @returns the cached texture descriptor, or `null` when the scene cannot bake
 *   (the caller then renders the `Graphics` layers directly)
 */
export function bakeEnemyBodyTexture(
  scene: Phaser.Scene | undefined,
  sources: readonly Phaser.GameObjects.Graphics[],
  extent: number,
): EnemyBodyTexture | null {
  if (!canBakeTextures(scene)) return null;

  const drawable = sources.filter(
    (source) => (source?.commandBuffer?.length ?? 0) > 0,
  );
  if (drawable.length === 0) return null;

  const textures = scene!.textures;
  const size = enemyBodyTextureSize(extent);
  const key = enemyBodyTextureKey(
    drawable.map((source) => source.commandBuffer),
    extent,
  );
  if (textures.exists(key)) return { key, size };
  if (bakedTextureCount(textures) >= MAX_BAKED_ENEMY_BODY_TEXTURES) return null;

  // Bake into a scratch Graphics that is never on a display list: the
  // centring translation has to be the first command, and the source
  // buffers are appended after it.
  const bake = scene!.make.graphics({ x: 0, y: 0 }, false);
  try {
    bake.translateCanvas(size / 2, size / 2);
    for (const source of drawable) {
      for (const command of source.commandBuffer) bake.commandBuffer.push(command);
    }
    bake.generateTexture(key, size, size);
  } finally {
    bake.destroy();
  }

  return textures.exists(key) ? { key, size } : null;
}

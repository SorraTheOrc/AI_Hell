/**
 * Mineral collectable entity (GDD §4.5 — Minerals, AH-0MUBVGI62004ED9Q).
 *
 * Renders as a small gold dot that is collected by overlap with the player
 * ship or absorbed by non-asteroid enemies. Minerals are stationary, persist
 * until collected, and are never hit by bullets. They cause no damage or
 * collision response on contact with any entity.
 *
 * The mineral is itself a `Phaser.GameObjects.Graphics` — it draws its gold
 * dot directly, so a single display-list object represents the collectable
 * (mirroring the Player ship, which is also a Graphics). `bodyGraphics` is
 * exposed as a convenience reference to the object's own graphics context for
 * callers that inspect the rendered shape.
 *
 * @module src/entities/Mineral
 */

import Phaser from 'phaser';

import {
  MINERAL_COLOR,
  MINERAL_DEPTH,
  MINERAL_REDROP_SCATTER_RADIUS,
  MINERAL_SIZE,
} from '../core/constants';

/**
 * Configuration for creating a mineral collectable.
 */
export interface MineralConfig {
  /** X position to spawn at. */
  x: number;
  /** Y position to spawn at. */
  y: number;
  /** Callback invoked when the mineral is collected (player/enemy overlap). */
  onCollect?: () => void;
}

/**
 * A small, stationary gold dot collectable.
 *
 * Minerals are collected by the player ship on overlap and absorbed by
 * non-asteroid enemies. They are never hit by bullets (`bullet` overlaps are
 * ignored) and cause no damage or collision response. Asteroids are inert to
 * minerals — an `asteroid` overlap is a no-op. Minerals persist until
 * collected: they never drift and never despawn on a timer.
 */
export class Mineral extends Phaser.GameObjects.Graphics {
  /** Whether the mineral is still on-screen (not yet collected). */
  alive = true;

  /** Stored collection callback (fired exactly once, on collection). */
  private readonly _onCollect?: () => void;

  /**
   * Create a mineral collectable at the given position.
   *
   * @param scene — Phaser scene
   * @param config — spawn position and optional collection callback
   */
  constructor(scene: Phaser.Scene, config: MineralConfig) {
    super(scene, { x: config.x, y: config.y });

    this._onCollect = config.onCollect;

    // Render above regular gameplay graphics (depth 1) but below UI.
    this.setDepth(MINERAL_DEPTH);
    this._drawBody();

    // Self-register on the display list — a Graphics built via `new` is not
    // shown until added to the scene (mirrors Player's `add.existing` note).
    scene.add.existing(this);
  }

  /**
   * The rendered body graphics — the mineral's own graphics context, since
   * the mineral draws its gold dot directly. Exposed for tests and callers
   * that inspect the rendered shape.
   */
  get bodyGraphics(): Phaser.GameObjects.Graphics {
    return this;
  }

  /**
   * Draw the mineral body as a small filled gold circle.
   */
  private _drawBody(): void {
    this.clear();
    this.fillStyle(MINERAL_COLOR, 1);
    this.fillCircle(0, 0, MINERAL_SIZE);
  }

  /**
   * Handle an overlap event from another entity.
   *
   * - `player` → collect the mineral (fire callback, mark dead, hide)
   * - `enemy`  → absorb the mineral (fire callback, mark dead, hide)
   * - `asteroid` → no effect (asteroids are inert to minerals)
   * - `bullet` → no effect (minerals are not hit by bullets)
   *
   * Collection fires the callback exactly once: subsequent overlaps are
   * ignored because a collected mineral is no longer alive.
   *
   * @param type — The type of entity that overlapped this mineral.
   */
  handleOverlap(type: string): void {
    if (!this.alive) return;

    if (type === 'player' || type === 'enemy') {
      this.alive = false;
      this.setVisible(false);
      this._onCollect?.();
    }
    // Asteroid and bullet overlaps are no-ops.
  }

  /**
   * Update position by delta time. Minerals are stationary — this is a no-op
   * kept so the scene's update loop can call it uniformly across entities.
   *
   * @param _dt — Delta time in seconds (ignored).
   */
  updatePosition(_dt: number): void {
    // Minerals do not move.
  }
}

/**
 * Spawns `count` mineral collectables scattered uniformly within
 * {@link MINERAL_REDROP_SCATTER_RADIUS} px of `(x, y)`. This is the single
 * shared implementation of the re-drop scatter maths used by both
 * `BaseEnemy.spawnMineralDrops` and the shared kill-drop rule
 * (`resolveMineralKillDrops`).
 *
 * Each drop consumes two `rng` draws in a fixed order (angle, then radius),
 * so callers that depended on the original `BaseEnemy.spawnMineralDrops`
 * draw sequence are byte-for-byte unchanged.
 *
 * @param scene — scene that owns the new mineral display objects
 * @param x — scatter-centre x position
 * @param y — scatter-centre y position
 * @param count — number of minerals to spawn (returns none when ≤ 0)
 * @param rng — random-number generator (defaults to `Math.random`)
 */
export function scatterMineralDrops(
  scene: Phaser.Scene,
  x: number,
  y: number,
  count: number,
  rng: () => number = Math.random,
): Mineral[] {
  if (count <= 0) return [];

  const drops: Mineral[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = rng() * Math.PI * 2;
    const radius = rng() * MINERAL_REDROP_SCATTER_RADIUS;
    drops.push(
      new Mineral(scene, {
        x: x + Math.cos(angle) * radius,
        y: y + Math.sin(angle) * radius,
      }),
    );
  }
  return drops;
}

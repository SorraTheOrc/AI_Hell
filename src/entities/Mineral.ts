/**
 * Mineral collectable entity (GDD §4.5 — Minerals, AH-0MUBVGI62004ED9Q).
 *
 * Renders as a small dot that is collected by overlap with the player
 * ship or absorbed by non-asteroid enemies. Minerals are stationary, persist
 * until collected, and are never hit by bullets. They cause no damage or
 * collision response on contact with any entity.
 *
 * Body colour is gold ({@link MINERAL_COLOR}) by default; Salvage bounty
 * drops render orange ({@link MINERAL_SALVAGE_COLOR}) so the bonus is
 * visible on the field (AH-0MVJ72I8O0009T09). The colour is cosmetic — a
 * salvage mineral is still worth exactly one mineral.
 *
 * A mineral also carries a **value**: the minerals it is worth when collected
 * by the player or absorbed by an enemy. An ordinary dot is worth one
 * ({@link Mineral.value} defaults to the `mineralCollectAmount` rule); a red
 * **deposit** left by a wreck that resolved ≥ {@link MINERAL_DEPOSIT_THRESHOLD}
 * minerals is worth {@link MINERAL_DEPOSIT_VALUE} in a single pickup
 * (AH-0MVJ79739008396I).
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
import { loadRules } from '../core/rules';

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
  /**
   * Body fill colour, default {@link MINERAL_COLOR} (gold). Salvage bounty
   * drops pass {@link MINERAL_SALVAGE_COLOR} so the bonus reads orange
   * (AH-0MVJ72I8O0009T09); every existing caller keeps the gold default.
   */
  color?: number;
  /**
   * Minerals this collectable is worth when collected by the player or
   * absorbed by an enemy. Defaults to the `mineralCollectAmount` rule (1) so
   * an ordinary dot is unchanged; a red **deposit** passes
   * {@link MINERAL_DEPOSIT_VALUE} (10) and pays out in a single pickup
   * (AH-0MVJ79739008396I).
   */
  value?: number;
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
   * Body fill colour: gold ({@link MINERAL_COLOR}) by default, orange
   * ({@link MINERAL_SALVAGE_COLOR}) for Salvage bounty drops.
   */
  readonly color: number;

  /**
   * Minerals this collectable is worth: `mineralCollectAmount` (1) for an
   * ordinary dot, {@link MINERAL_DEPOSIT_VALUE} (10) for a red deposit
   * (AH-0MVJ79739008396I). The player pickup and enemy absorption both credit
   * exactly this value, so a deposit pays out in a single collection.
   */
  readonly value: number;

  /**
   * Create a mineral collectable at the given position.
   *
   * @param scene — Phaser scene
   * @param config — spawn position, optional collection callback and optional
   *   body colour (defaults to gold, {@link MINERAL_COLOR})
   */
  constructor(scene: Phaser.Scene, config: MineralConfig) {
    super(scene, { x: config.x, y: config.y });

    this._onCollect = config.onCollect;
    this.color = config.color ?? MINERAL_COLOR;
    this.value = config.value ?? loadRules().mineralCollectAmount;

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
   * Draw the mineral body as a small filled circle in {@link color}
   * (gold by default, salvage orange when configured).
   */
  private _drawBody(): void {
    this.clear();
    this.fillStyle(this.color, 1);
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
 * @param color — body fill colour (defaults to gold, {@link MINERAL_COLOR});
 *   salvage bounty drops pass {@link MINERAL_SALVAGE_COLOR}. Additive and
 *   optional, so every existing caller is unchanged and the RNG draw order
 *   is untouched.
 */
export function scatterMineralDrops(
  scene: Phaser.Scene,
  x: number,
  y: number,
  count: number,
  rng: () => number = Math.random,
  color: number = MINERAL_COLOR,
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
        color,
      }),
    );
  }
  return drops;
}

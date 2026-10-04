/**
 * Shared mineral scoop attraction — pulls live minerals toward the player ship
 * (P10 Mineral Scoop).
 *
 * The mineral-field analogue of {@link ./magnet}: the magnet targets the
 * power-up/weapon drop list, the scoop targets the mineral field. Both share
 * the same range and speed so their ergonomics match. Used by `PlayScene`,
 * `GymFormationScene` (inherited by `GymMinerals`) and `GymPowerUpsUtility`
 * through the shared `CombatCoreScene._applyMineralScoop` template method, so
 * the game and every gym run identical attraction code (repo-wide gym↔game
 * parity rule).
 *
 * @module powerups/mineralScoop
 */

import { MAGNET_ATTRACTION_SPEED } from '../core/constants';
import { magnetRadius } from './effects';

/**
 * A mineral with a mutable position and a Phaser-Graphics `setPosition` for
 * visual sync. `Mineral` (a `Phaser.GameObjects.Graphics`) satisfies this
 * structurally; unit tests can inject plain doubles.
 */
export interface MovableMineral {
  x: number;
  y: number;
  /** False once collected/absorbed — a dead mineral is never attracted. */
  alive: boolean;
  /** Syncs the rendered position with the logical one. */
  setPosition(x: number, y: number): void;
}

/**
 * Scoop attraction radius (px) for `stacks` effective stacks: the same curve
 * as the P9 magnet — base 1× ship size, +50% of the base per stack.
 */
export function mineralScoopRadius(shipSize: number, stacks: number): number {
  return magnetRadius(shipSize, stacks);
}

/**
 * Applies mineral-scoop attraction to all live minerals within range.
 *
 * For each live (`alive === true`) mineral inside the scoop radius, the
 * mineral is pulled toward the player by `MAGNET_ATTRACTION_SPEED * dt` pixels
 * (clamped to the remaining distance) and its rendered position is synced so
 * the pull is visible. The scoop only **attracts** — it never collects, hides
 * or destroys a mineral; collection remains the job of `collectMinerals`.
 *
 * @param minerals — mutable mineral objects (position + alive + setPosition).
 * @param player — player with `x`/`y` coordinates (and optional `size`).
 * @param stacks — effective scoop stacks (0 → no attraction).
 * @param dt — elapsed time in seconds (frame delta).
 *
 * When `player.size` is present it is used; otherwise `SHIP_SIZE` (20) is
 * assumed.
 */
export function applyMineralScoop<T extends MovableMineral>(
  minerals: T[],
  player: { x: number; y: number; size?: number },
  stacks: number,
  dt: number,
): void {
  if (stacks <= 0) return;

  const shipSize = player.size ?? 20;
  const radius = mineralScoopRadius(shipSize, stacks);

  for (const mineral of minerals) {
    if (!mineral || !mineral.alive) continue;

    const dx = player.x - mineral.x;
    const dy = player.y - mineral.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0.001 || dist > radius) continue;

    const step = Math.min(MAGNET_ATTRACTION_SPEED * dt, dist);
    mineral.x += (dx / dist) * step;
    mineral.y += (dy / dist) * step;

    // Keep the visual position in sync with the logical position.
    mineral.setPosition(mineral.x, mineral.y);
  }
}

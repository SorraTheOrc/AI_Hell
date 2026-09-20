/**
 * Shared magnet attraction — pulls collectible drops toward the player ship.
 *
 * Used by both gym scenes and PlayScene so they exercise the same production
 * code path (RCA root cause: gym-game divergence).
 *
 * @module powerups/magnet
 */

import { MAGNET_ATTRACTION_SPEED } from '../core/constants';
import { magnetRadius } from './effects';

/**
 * A drop with a mutable position, a Phaser Graphics object for visual sync,
 * and a PowerUp lifecycle with a canCollect() gate.
 */
export interface MovableDrop {
  x: number;
  y: number;
  graphics: { setPosition(x: number, y: number): void };
  powerUp: { canCollect(): boolean };
}

/**
 * Applies magnet attraction to all collectible drops within range.
 *
 * For each drop whose `canCollect()` returns true and lies within the magnet
 * radius, the drop is pulled toward the player by `MAGNET_ATTRACTION_SPEED * dt`
 * pixels (clamped to remaining distance). The drop's graphics object is updated
 * to match the new logical position so the visual pull animation is visible.
 *
 * @param drops  — mutable drop objects (position + graphics).
 * @param player — player with `x`/`y` coordinates (and optional `size`).
 * @param stacks — current P9 magnet stack count (0 → no attraction).
 * @param dt     — elapsed time in seconds (frame delta).
 *
 * When `player.size` is present it is used; otherwise `SHIP_SIZE` (20) is
 * assumed.
 */
export function applyMagnetAttraction<T extends MovableDrop>(
  drops: T[],
  player: { x: number; y: number; size?: number },
  stacks: number,
  dt: number,
): void {
  if (stacks <= 0) return;

  const shipSize = player.size ?? 20;
  const radius = magnetRadius(shipSize, stacks);

  for (const drop of drops) {
    if (!drop) continue;
    // Only attract drops that are collectible (fully grown).
    if (!drop.powerUp.canCollect()) continue;

    const dx = player.x - drop.x;
    const dy = player.y - drop.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0.001 || dist > radius) continue;

    const step = Math.min(MAGNET_ATTRACTION_SPEED * dt, dist);
    drop.x += (dx / dist) * step;
    drop.y += (dy / dist) * step;

    // Keep the visual position in sync with the logical position
    // so the player sees the drop being pulled toward the ship.
    drop.graphics.setPosition(drop.x, drop.y);
  }
}

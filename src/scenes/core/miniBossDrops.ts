/**
 * Guaranteed mini-boss Extra Life drop (AH-0MW8178ZR0090CNY AC4).
 *
 * Defeating a mini-boss is the biggest scheduled highlight of a level, so it
 * should reliably pay back a life. Every mini-boss defeat spawns **exactly one**
 * `extra_life` field pickup at (or nudged near) the death position, **in
 * addition to** the spin-the-wheel reward (§4.4.4). This is a field pickup, not
 * a wheel wedge: Extra Life stays excluded from every reward surface.
 *
 * The guarantee is deliberately independent of the run state:
 *
 * - it spawns at the **5-life cap** and with a **full six-slot pool** — the
 *   drop is still placed on the field; the existing collection gate and life
 *   cap simply make it useless to collect at the cap;
 * - the scene's normal **drop separation nudge** applies, so the pickup never
 *   lands on top of another drop.
 *
 * The rule lives once here and is consumed by both `PlayScene` and the
 * `GymMiniBoss` gym, so the guarantee can never drift between the game and the
 * gym (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * @module scenes/core/miniBossDrops
 */

import type { DropId } from '../../powerups/types';

/** The Extra Life drop id a mini-boss defeat guarantees. */
export const MINI_BOSS_GUARANTEED_DROP_ID: DropId = 'extra_life';

/** Places one drop of `id` at `(x, y)` through the scene's own pipeline. */
export type MiniBossDropSpawner = (
  id: DropId,
  x: number,
  y: number,
) => void;

/**
 * Spawns the guaranteed mini-boss Extra Life field pickup at the death
 * position (AH-0MW8178ZR0090CNY AC4): exactly one `extra_life` drop, in
 * addition to the reward, regardless of the life cap or slot occupancy.
 *
 * The caller supplies its own drop pipeline, so the guarantee composes with
 * each scene's placement (§ the normal separation nudge) without the helper
 * needing to know a scene type.
 *
 * @param spawnDrop - The scene's drop pipeline (`PlayScene` /
 *   `GymMiniBoss`).
 * @param deathX - The mini-boss's x at the moment of the lethal blow.
 * @param deathY - The mini-boss's y at the moment of the lethal blow.
 */
export function spawnGuaranteedMiniBossExtraLife(
  spawnDrop: MiniBossDropSpawner,
  deathX: number,
  deathY: number,
): void {
  spawnDrop(MINI_BOSS_GUARANTEED_DROP_ID, deathX, deathY);
}

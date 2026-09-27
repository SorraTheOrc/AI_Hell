/**
 * Shared combat effect visuals (P3 shield bubble + P6 phase ghost).
 *
 * `PlayScene`, `GymPowerUpsCombat` and `GymFormationScene` each drew their
 * own copy of the shield bubble / phase ghost. Centralising the drawing here
 * keeps the three scenes visually identical and impossible to drift: the
 * same colour, line width, radius and alpha are used everywhere.
 *
 * The parameter values are fixed by the play-scene P3/P6 work
 * (AH-0MU8QV3O9008JVNQ shield bubble, AH-0MU8QVC9Y008R8I5 phase ghost) and
 * the gym parity item AH-0MUICQC34005QOYF.
 *
 * @module scenes/core/CombatEffectVisuals
 */

import type Phaser from 'phaser';

import { SHIP_SIZE } from '../../core/constants';
import type { EffectsRegistry } from '../../powerups/effects';

/** Shield-bubble colour (P3). */
export const SHIELD_BUBBLE_COLOR = 0x3399ff;
/** Shield-bubble stroke line width (px). */
export const SHIELD_BUBBLE_LINE_WIDTH = 2;
/** Shield-bubble radius as a multiple of `SHIP_SIZE`. */
export const SHIELD_BUBBLE_RADIUS_FACTOR = 1.6;
/** Shield-bubble fill alpha. */
export const SHIELD_BUBBLE_FILL_ALPHA = 0.12;
/** Shield-bubble stroke alpha. */
export const SHIELD_BUBBLE_STROKE_ALPHA = 0.9;
/** Phase-ghost ship alpha while P6 is active (and not blinking). */
export const PHASE_GHOST_ALPHA = 0.45;

/** Minimal positional target for the shield bubble (the ship). */
export interface EffectVisualTarget {
  x: number;
  y: number;
}

/** Minimal alpha target for the phase ghost (the ship). */
export interface GhostVisualTarget {
  setAlpha(alpha: number): unknown;
}

/**
 * Clears *graphics* and draws the shared P3 shield bubble around *player*
 * when the registry says the player is shielded.
 *
 * Cleared (never drawn) when there is no graphics, no player, or the shield
 * is inactive, so a popped shield always removes the bubble.
 *
 * @param graphics — the scene-owned shield-bubble graphics (may be null).
 * @param player — the ship position (may be null).
 * @param registry — the shared active-effect registry.
 * @returns true when a bubble was drawn.
 */
export function drawShieldBubble(
  graphics: Phaser.GameObjects.Graphics | null,
  player: EffectVisualTarget | null,
  registry: EffectsRegistry,
): boolean {
  if (!graphics) return false;
  graphics.clear();
  if (!player || !registry.isShielded) return false;
  const radius = SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR;
  graphics.lineStyle(
    SHIELD_BUBBLE_LINE_WIDTH,
    SHIELD_BUBBLE_COLOR,
    SHIELD_BUBBLE_STROKE_ALPHA,
  );
  graphics.strokeCircle(player.x, player.y, radius);
  graphics.fillStyle(SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_FILL_ALPHA);
  graphics.fillCircle(player.x, player.y, radius);
  return true;
}

/**
 * Applies the shared P6 phase-ghost alpha to the ship.
 *
 * While the post-hit invulnerability blink is active the blink owns the
 * alpha, so this helper is a no-op. Otherwise the ship is ghosted
 * ({@link PHASE_GHOST_ALPHA}) while phased and fully opaque when not.
 *
 * @param player — the ship (may be null, in which case it is a no-op).
 * @param registry — the shared active-effect registry.
 * @param invulnerable — whether the post-hit blink is currently active.
 */
export function applyPhaseGhost(
  player: GhostVisualTarget | null,
  registry: EffectsRegistry,
  invulnerable: boolean,
): void {
  if (!player || invulnerable) return;
  player.setAlpha(registry.isPhased ? PHASE_GHOST_ALPHA : 1);
}

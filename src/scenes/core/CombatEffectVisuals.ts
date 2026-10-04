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
 * The P3 shield bubble also winds down as it expires (AH-0MUAYB5HR001HDYC):
 * the rim pulses continuously for the whole active lifetime, the fill ramps
 * up to a documented "opaque" alpha in the final second, and the fill then
 * shrinks inside the hull radius in the final half second before the bubble
 * clears at expiry. The animation is a pure function of
 * `EffectsRegistry.remaining('P3')`, so it is frame-rate independent and
 * identical in the game and every gym.
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
/**
 * Seconds before expiry at which the shield-bubble ending fade begins: the
 * fill starts ramping up toward {@link SHIELD_BUBBLE_ENDING_FILL_ALPHA}
 * (AH-0MUAYB5HR001HDYC). The rim pulses for the whole active lifetime.
 */
export const SHIELD_BUBBLE_ENDING_SECONDS = 1.0;
/**
 * Seconds before expiry at which the shield-bubble fill starts shrinking
 * from the full bubble radius toward {@link SHIELD_BUBBLE_SHRINK_MIN_FACTOR}.
 */
export const SHIELD_BUBBLE_SHRINK_SECONDS = 0.5;
/**
 * Shield-bubble fill alpha at the end of the ending window — deliberately
 * above {@link SHIELD_BUBBLE_FILL_ALPHA} so the bubble reads as "opaque"
 * (but still below 1 so the ship stays visible).
 */
export const SHIELD_BUBBLE_ENDING_FILL_ALPHA = 0.6;
/**
 * Minimum shield-bubble fill radius factor (× `SHIP_SIZE`) reached at expiry.
 * Kept below `0.5` so the fill ends up inside the ship hull radius.
 */
export const SHIELD_BUBBLE_SHRINK_MIN_FACTOR = 0.3;
/**
 * Shield-bubble rim pulse angular rate (radians per second of remaining
 * time). The rim pulses continuously for the whole active lifetime.
 */
export const SHIELD_BUBBLE_PULSE_RATE = 12;
/**
 * Lowest stroke-alpha multiplier at the bottom of a rim pulse. Keeps the
 * pulsing rim visible (never fully transparent) at its dimmest.
 */
export const SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER = 0.35;
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
 * The bubble has a continuously pulsing rim (stroke alpha oscillates for the
 * whole active lifetime, from collection until it disappears) and a
 * time-based ending fade in the final second (AH-0MUAYB5HR001HDYC): the fill
 * ramps up to {@link SHIELD_BUBBLE_ENDING_FILL_ALPHA}, then in the final
 * {@link SHIELD_BUBBLE_SHRINK_SECONDS} the fill shrinks toward
 * {@link SHIELD_BUBBLE_SHRINK_MIN_FACTOR} (inside the hull) before the
 * bubble clears at expiry. The animation is a pure function of
 * `registry.remaining('P3')` — frame-rate independent and deterministic.
 *
 * Cleared (never drawn) when there is no graphics, no player, the shield is
 * inactive, or its timer has reached zero, so a popped shield always removes
 * the bubble.
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

  const remaining = registry.remaining('P3');
  if (remaining === undefined || remaining <= 0) return false;

  const fullRadius = SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR;
  let fillAlpha = SHIELD_BUBBLE_FILL_ALPHA;
  let fillRadius = fullRadius;

  // Rim pulse: runs continuously for the whole active lifetime (operator
  // clarification, AH-0MUAYB5HR001HDYC) — the shield is never a steady ring.
  // The phase is locked so the pulse passes through the base alpha at T-1 s,
  // keeping the transition into the ending window seamless.
  const pulse =
    0.5 +
    0.5 *
      Math.cos(
        (remaining - SHIELD_BUBBLE_ENDING_SECONDS) * SHIELD_BUBBLE_PULSE_RATE,
      );
  const strokeAlpha =
    SHIELD_BUBBLE_STROKE_ALPHA *
    (SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER +
      (1 - SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER) * pulse);

  if (remaining <= SHIELD_BUBBLE_ENDING_SECONDS) {
    // Fill ramps from the steady alpha up to the documented "opaque" alpha.
    const progress = 1 - remaining / SHIELD_BUBBLE_ENDING_SECONDS; // 0..1
    fillAlpha =
      SHIELD_BUBBLE_FILL_ALPHA +
      (SHIELD_BUBBLE_ENDING_FILL_ALPHA - SHIELD_BUBBLE_FILL_ALPHA) * progress;

    // Final half second: shrink the fill from the bubble radius toward a
    // radius inside the hull, so the shield reads as ineffective.
    if (remaining < SHIELD_BUBBLE_SHRINK_SECONDS) {
      const shrink = remaining / SHIELD_BUBBLE_SHRINK_SECONDS; // 1..0
      const minRadius = SHIP_SIZE * SHIELD_BUBBLE_SHRINK_MIN_FACTOR;
      fillRadius = minRadius + (fullRadius - minRadius) * shrink;
    }
  }

  graphics.lineStyle(SHIELD_BUBBLE_LINE_WIDTH, SHIELD_BUBBLE_COLOR, strokeAlpha);
  graphics.strokeCircle(player.x, player.y, fullRadius);
  graphics.fillStyle(SHIELD_BUBBLE_COLOR, fillAlpha);
  graphics.fillCircle(player.x, player.y, fillRadius);
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

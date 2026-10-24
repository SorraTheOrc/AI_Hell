/**
 * Shared combat effect visuals (Shield shield bubble + Phase Shift phase ghost).
 *
 * `PlayScene`, `GymPowerUpsCombat` and `GymFormationScene` each drew their
 * own copy of the shield bubble / phase ghost. Centralising the drawing here
 * keeps the three scenes visually identical and impossible to drift: the
 * same colour, line width, radius and alpha are used everywhere.
 *
 * The parameter values are fixed by the play-scene Shield/Phase Shift work
 * (AH-0MU8QV3O9008JVNQ shield bubble, AH-0MU8QVC9Y008R8I5 phase ghost) and
 * the gym parity item AH-0MUICQC34005QOYF.
 *
 * The Shield shield bubble also winds down as it expires (AH-0MUAYB5HR001HDYC):
 * the rim pulses continuously for the whole active lifetime, the fill ramps
 * up to a documented "opaque" alpha in the final second, and the fill then
 * shrinks inside the hull radius in the final half second before the bubble
 * clears at expiry. The animation is a pure function of
 * `EffectsRegistry.remaining('shield')`, so it is frame-rate independent and
 * identical in the game and every gym.
 *
 * @module scenes/core/CombatEffectVisuals
 */

import type Phaser from 'phaser';

import { SHIP_SIZE, FORCE_FIELD_COLOR } from '../../core/constants';
import { ICON_COLORS } from '../../powerups/icons';
import type { EffectsRegistry } from '../../powerups/effects';

/** Shield-bubble colour (Shield). */
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
/** Phase-ghost ship alpha while Phase Shift is active (and not blinking). */
export const PHASE_GHOST_ALPHA = 0.45;

// ── Thorn Field aura (AH-0MVJ8YKR70096C6T) ──────────────────────────

/**
 * Thorn-aura colour — the neon lime the Thorn Field drop icon uses
 * (`ICON_COLORS.thorns`), so the in-world aura and the HUD icon read as one
 * effect. Imported rather than re-declared so the two can never drift.
 */
export const THORNS_AURA_COLOR = ICON_COLORS.thorns;
/** Thorn-aura spike line width (px). */
export const THORNS_AURA_LINE_WIDTH = 2;
/**
 * Thorn-aura outer radius as a multiple of `SHIP_SIZE` — deliberately wider
 * than the Shield bubble (1.6×) so the spiked halo sits outside it and the
 * two effects never read as one.
 */
export const THORNS_AURA_RADIUS_FACTOR = 2.3;
/** Inner (valley) radius of the spiked halo as a fraction of the outer radius. */
export const THORNS_AURA_INNER_FACTOR = 0.62;
/** Spike count at a single remaining ram (the weakest armed field). */
export const THORNS_AURA_MIN_SPIKES = 8;
/** Extra spikes per additional remaining ram, so the charge count is readable. */
export const THORNS_AURA_SPIKES_PER_CHARGE = 2;
/** Hard spike-count ceiling (the 6-ram cap yields 18). */
export const THORNS_AURA_MAX_SPIKES = 18;
/** Spike-star rotation rate (radians per second of caller clock). */
export const THORNS_AURA_ROTATION_RATE = 1.6;
/** Faint aura fill alpha (inside the hull, under the ship). */
export const THORNS_AURA_FILL_ALPHA = 0.08;
/** Dimmest stroke alpha — used at one remaining ram (still clearly visible). */
export const THORNS_AURA_MIN_STROKE_ALPHA = 0.55;
/** Brightest stroke alpha, reached at a full level-resolved budget. */
export const THORNS_AURA_STROKE_ALPHA = 0.95;

/**
 * Clears *graphics* and draws the shared Thorn Field aura around *player*
 * while the field is armed (active with at least one ram remaining).
 *
 * The aura is a rotating star of lime spikes echoing the Thorn Field drop
 * icon (`drawThorns` in `powerups/icons.ts`): the spike count and the stroke
 * alpha both scale with the remaining ram budget (a spent field is never
 * haloed), and the rim brightens as the next automatic recharge approaches.
 * Every input is registry state plus the caller's frame clock, so the game,
 * every gym and unit tests agree frame for frame — and no scene can hand-roll
 * a divergent halo (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * Cleared (never drawn) when there is no graphics, no player, the field is
 * inactive, or its budget is spent — so an exhausted or expired field always
 * removes the aura.
 *
 * @param graphics — the scene-owned thorns-aura graphics (may be null).
 * @param player — the ship position (may be null).
 * @param registry — the shared active-effect registry.
 * @param elapsedSeconds — optional frame clock (seconds) driving the slow
 *   rotation; deterministic for a given value (defaults to 0 = no rotation).
 * @returns true when an aura was drawn.
 */
export function drawThornsAura(
  graphics: Phaser.GameObjects.Graphics | null,
  player: EffectVisualTarget | null,
  registry: EffectsRegistry,
  elapsedSeconds = 0,
): boolean {
  if (!graphics) return false;
  graphics.clear();
  if (!player) return false;

  const charges = registry.thornsRemaining();
  if (!registry.isActive('thorns') || charges <= 0) return false;

  const maxCharges = Math.max(1, registry.thornsMaxAbsorbs());
  const chargeFraction = Math.min(1, charges / maxCharges);
  const spikeCount = Math.min(
    THORNS_AURA_MAX_SPIKES,
    THORNS_AURA_MIN_SPIKES + (charges - 1) * THORNS_AURA_SPIKES_PER_CHARGE,
  );
  const outerRadius = SHIP_SIZE * THORNS_AURA_RADIUS_FACTOR;
  const innerRadius = outerRadius * THORNS_AURA_INNER_FACTOR;
  const rotation = elapsedSeconds * THORNS_AURA_ROTATION_RATE;

  // Brightness tracks the remaining budget: a nearly-spent field is dimmer
  // and only regains its full glow as rams return.
  let strokeAlpha =
    THORNS_AURA_MIN_STROKE_ALPHA +
    (THORNS_AURA_STROKE_ALPHA - THORNS_AURA_MIN_STROKE_ALPHA) * chargeFraction;

  // Recharge readiness: brighten as the next ram approaches, so an armed
  // field at zero recharge progress still reads as "working on it".
  const interval = registry.thornsRechargeTime();
  const rechargeRemaining = registry.thornsRechargeRemaining();
  if (interval > 0 && rechargeRemaining > 0) {
    const readiness = Math.min(1, Math.max(0, 1 - rechargeRemaining / interval));
    strokeAlpha = Math.min(1, strokeAlpha + 0.15 * readiness);
  }

  graphics.fillStyle(THORNS_AURA_COLOR, THORNS_AURA_FILL_ALPHA * chargeFraction);
  graphics.fillCircle(player.x, player.y, innerRadius);

  graphics.lineStyle(THORNS_AURA_LINE_WIDTH, THORNS_AURA_COLOR, strokeAlpha);
  graphics.beginPath();
  const step = (Math.PI * 2) / (spikeCount * 2);
  for (let i = 0; i < spikeCount * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = rotation + step * i - Math.PI / 2;
    const px = player.x + Math.cos(angle) * radius;
    const py = player.y + Math.sin(angle) * radius;
    if (i === 0) graphics.moveTo(px, py);
    else graphics.lineTo(px, py);
  }
  graphics.closePath();
  graphics.strokePath();
  return true;
}

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
 * Clears *graphics* and draws the shared Shield shield bubble around *player*
 * when the registry says the player is shielded.
 *
 * The bubble has a continuously pulsing rim (stroke alpha oscillates for the
 * whole active lifetime, from collection until it disappears) and a
 * time-based ending fade in the final second (AH-0MUAYB5HR001HDYC): the fill
 * ramps up to {@link SHIELD_BUBBLE_ENDING_FILL_ALPHA}, then in the final
 * {@link SHIELD_BUBBLE_SHRINK_SECONDS} the fill shrinks toward
 * {@link SHIELD_BUBBLE_SHRINK_MIN_FACTOR} (inside the hull) before the
 * bubble clears at expiry. The animation is a pure function of
 * `registry.remaining('shield')` — frame-rate independent and deterministic.
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

  const remaining = registry.remaining('shield');
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

// ── Force Field reflect bubble (Gradius homage, AH-0MV1BIX1W006XF95) ──

/** Force-bubble stroke line width (px). */
export const FORCE_FIELD_LINE_WIDTH = 2;
/** Force-bubble fill alpha. */
export const FORCE_FIELD_FILL_ALPHA = 0.14;
/** Force-bubble stroke alpha. */
export const FORCE_FIELD_STROKE_ALPHA = 0.9;

/**
 * Clears *graphics* and draws the shared Force Field reflect bubble around
 * *player* while the registry says the field is active.
 *
 * The bubble is a pulsing hexagonal boundary (the same radius the shared
 * combat core uses for reflection) with inward chevron "reflect" motifs, so
 * the player can read exactly which incoming shots will bounce. Its rim
 * pulses continuously and the fill brightens in the final second before it
 * expires, mirroring the shared Shield bubble treatment.
 *
 * Cleared (never drawn) when there is no graphics, no player, or the field is
 * inactive, so an expired field always removes the bubble.
 *
 * @param graphics — the scene-owned force-field graphics (may be null).
 * @param player — the ship position (may be null).
 * @param registry — the shared active-effect registry.
 * @returns true when a bubble was drawn.
 */
export function drawForceFieldBubble(
  graphics: Phaser.GameObjects.Graphics | null,
  player: EffectVisualTarget | null,
  registry: EffectsRegistry,
): boolean {
  if (!graphics) return false;
  graphics.clear();
  if (!player || !registry.isForceFieldActive()) return false;

  const remaining = registry.remaining('force_field');
  if (remaining === undefined || remaining <= 0) return false;

  const radius = registry.forceFieldRadius();
  const centerX = player.x;
  const centerY = player.y;

  // Continuous rim pulse (never a steady ring).
  const pulse = 0.5 + 0.5 * Math.cos(remaining * 12);
  const strokeAlpha =
    FORCE_FIELD_STROKE_ALPHA * (0.4 + 0.6 * pulse);
  const fillAlpha =
    remaining <= 1 ? FORCE_FIELD_FILL_ALPHA + (0.5 - FORCE_FIELD_FILL_ALPHA) * (1 - remaining) : FORCE_FIELD_FILL_ALPHA;

  graphics.lineStyle(FORCE_FIELD_LINE_WIDTH, FORCE_FIELD_COLOR, strokeAlpha);
  // Hexagonal boundary (flat-top) — echoes the code-drawn drop icon.
  graphics.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const px = centerX + Math.cos(angle) * radius;
    const py = centerY + Math.sin(angle) * radius;
    if (i === 0) graphics.moveTo(px, py);
    else graphics.lineTo(px, py);
  }
  graphics.closePath();
  graphics.strokePath();
  graphics.fillStyle(FORCE_FIELD_COLOR, fillAlpha);
  graphics.fillCircle(centerX, centerY, radius * 0.85);

  // Three inward chevrons reading as "bullets bounce back".
  for (let i = 0; i < 3; i++) {
    const angle = (Math.PI / 3) * (2 * i) - Math.PI / 2;
    const tipX = centerX + Math.cos(angle) * radius * 0.55;
    const tipY = centerY + Math.sin(angle) * radius * 0.55;
    const backX = centerX + Math.cos(angle) * radius * 0.18;
    const backY = centerY + Math.sin(angle) * radius * 0.18;
    const perpX = Math.cos(angle + Math.PI / 2) * radius * 0.22;
    const perpY = Math.sin(angle + Math.PI / 2) * radius * 0.22;
    graphics.beginPath();
    graphics.moveTo(backX - perpX, backY - perpY);
    graphics.lineTo(tipX, tipY);
    graphics.lineTo(backX + perpX, backY + perpY);
    graphics.strokePath();
  }
  return true;
}

/**
 * Applies the shared Phase Shift phase-ghost alpha to the ship.
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

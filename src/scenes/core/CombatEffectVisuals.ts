/**
 * Shared combat effect visuals (Shield shield bubble + Phase Shift phase ghost
 * + player Force Field reflect bubble + Thorn Field aura + enemy force-field
 * bubble/break flash).
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
/**
 * Spike count at a single remaining ram (the weakest armed field). Dense
 * enough to read as a thorn halo rather than a star (operator audit
 * feedback, AH-0MVJ8YKR70096C6T: "spikier — more spikes, not larger").
 */
export const THORNS_AURA_MIN_SPIKES = 14;
/** Extra spikes per additional remaining ram, so the charge count is readable. */
export const THORNS_AURA_SPIKES_PER_CHARGE = 3;
/** Hard spike-count ceiling (the 6-ram cap yields 29). */
export const THORNS_AURA_MAX_SPIKES = 32;
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
 * The aura is a fixed-orientation star of lime spikes echoing the Thorn
 * Field drop icon (`drawThorns` in `powerups/icons.ts`): the spike count and
 * the stroke alpha both scale with the remaining ram budget (a spent field is
 * never haloed), and the rim brightens as the next automatic recharge
 * approaches. It deliberately does **not** rotate (operator audit feedback,
 * AH-0MVJ8YKR70096C6T), so the halo reads as a spiky field rather than a
 * spinning blade. Every input is registry state, so the game, every gym and
 * unit tests agree frame for frame — and no scene can hand-roll a divergent
 * halo (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * Cleared (never drawn) when there is no graphics, no player, the field is
 * inactive, or its budget is spent — so an exhausted or expired field always
 * removes the aura.
 *
 * @param graphics — the scene-owned thorns-aura graphics (may be null).
 * @param player — the ship position (may be null).
 * @param registry — the shared active-effect registry.
 * @returns true when an aura was drawn.
 */
export function drawThornsAura(
  graphics: Phaser.GameObjects.Graphics | null,
  player: EffectVisualTarget | null,
  registry: EffectsRegistry,
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
    const angle = step * i - Math.PI / 2;
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

// ── Enemy force-field bubble + break flash (AH-0MVM8GW7W004SI0E) ─────
//
// Enemy force fields (epic AH-0MVJ8W4GE007OMNT AC3) need a barrier the player
// can read at a glance: "barrier first, hull second". The bubble lives here,
// once, so `BaseEnemy` draws it identically in the game and in every gym — no
// scene may hand-roll a divergent copy (gym↔game parity,
// AH-0MUGZDTFX004RBD1). The colour is deliberately distinct from both player
// bubbles (`SHIELD_BUBBLE_COLOR` 0x3399ff and `FORCE_FIELD_COLOR` 0x33ffcc),
// and the ring is segmented rather than a smooth circle so an enemy barrier
// never reads as the player's shield.

/**
 * Enemy force-field bubble colour (violet-magenta). Distinct from the player
 * Shield bubble (0x3399ff) and the player Force Field bubble (0x33ffcc) so
 * the two sides of the arena never read as the same effect.
 */
export const ENEMY_FORCE_FIELD_COLOR = 0xff44dd;
/** Enemy force-field ring line width (px). */
export const ENEMY_FORCE_FIELD_LINE_WIDTH = 2;
/**
 * Enemy force-field bubble radius as a multiple of the enemy's body radius
 * (`size / 2`), so the ring sits just outside the hull of every archetype.
 */
export const ENEMY_FORCE_FIELD_RADIUS_FACTOR = 1.45;
/** Enemy force-field fill alpha (faint — the ship stays readable inside). */
export const ENEMY_FORCE_FIELD_FILL_ALPHA = 0.1;
/** Enemy force-field ring alpha at a full-strength field. */
export const ENEMY_FORCE_FIELD_STROKE_ALPHA = 0.9;
/**
 * Enemy force-field ring alpha at one remaining hit — the dimmest the barrier
 * gets. The ring brightens with the remaining hits so its strength is
 * readable (one hit left looks nearly spent, a full field glows).
 */
export const ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA = 0.5;
/** Arc segments in the enemy force-field ring (a segmented barrier, not a disc). */
export const ENEMY_FORCE_FIELD_SEGMENTS = 12;
/** Fraction of each ring segment left as a gap (0–1) — the barrier "panels". */
export const ENEMY_FORCE_FIELD_SEGMENT_GAP_FRACTION = 0.3;
/** Points used to approximate one ring segment's arc. */
const ENEMY_FORCE_FIELD_ARC_STEPS = 4;

/**
 * Clears *graphics* and draws the shared enemy force-field bubble around
 * *target* while the field carries hits.
 *
 * The bubble is a **segmented ring** (gaps between arc panels) plus a faint
 * fill, sized from the enemy's `size` (its body diameter). The ring alpha
 * tracks the remaining hits, so the barrier reads as weakening as it is
 * absorbed. Every input is entity state, so the game, every gym and unit tests
 * agree exactly.
 *
 * Cleared (never drawn) when there is no graphics, no target, or the field
 * carries no hits — so a broken field always removes the bubble.
 *
 * @param graphics — the entity-owned force-field graphics (may be null).
 * @param target — the enemy centre (local coordinates; may be null).
 * @param size — the enemy's body diameter in px (bubble radius is
 *   `size / 2 × ENEMY_FORCE_FIELD_RADIUS_FACTOR`).
 * @param remainingHits — field hits still carried (defaults to 1).
 * @param maxHits — field hits at full strength, for the brightness ramp
 *   (defaults to `remainingHits`, i.e. full strength).
 * @returns true when a bubble was drawn.
 */
export function drawEnemyForceFieldBubble(
  graphics: Phaser.GameObjects.Graphics | null,
  target: EffectVisualTarget | null,
  size: number,
  remainingHits = 1,
  maxHits = remainingHits,
): boolean {
  if (!graphics) return false;
  graphics.clear();
  if (!target || remainingHits <= 0) return false;

  const radius = Math.max(
    1,
    (size / 2) * ENEMY_FORCE_FIELD_RADIUS_FACTOR,
  );
  const charge =
    maxHits > 0 ? Math.min(1, Math.max(0, remainingHits / maxHits)) : 1;
  const strokeAlpha =
    ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA +
    (ENEMY_FORCE_FIELD_STROKE_ALPHA - ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA) *
      charge;

  // Faint fill marks the protected volume; the ship stays visible inside it.
  graphics.fillStyle(
    ENEMY_FORCE_FIELD_COLOR,
    ENEMY_FORCE_FIELD_FILL_ALPHA * (0.5 + 0.5 * charge),
  );
  graphics.fillCircle(target.x, target.y, radius);

  // Segmented ring: each panel is an arc approximated by short segments.
  graphics.lineStyle(
    ENEMY_FORCE_FIELD_LINE_WIDTH,
    ENEMY_FORCE_FIELD_COLOR,
    strokeAlpha,
  );
  const segmentAngle = (Math.PI * 2) / ENEMY_FORCE_FIELD_SEGMENTS;
  const gap = segmentAngle * ENEMY_FORCE_FIELD_SEGMENT_GAP_FRACTION;
  for (let panel = 0; panel < ENEMY_FORCE_FIELD_SEGMENTS; panel += 1) {
    const start = panel * segmentAngle + gap / 2;
    const end = (panel + 1) * segmentAngle - gap / 2;
    graphics.beginPath();
    for (let step = 0; step <= ENEMY_FORCE_FIELD_ARC_STEPS; step += 1) {
      const angle = start + ((end - start) * step) / ENEMY_FORCE_FIELD_ARC_STEPS;
      const px = target.x + Math.cos(angle) * radius;
      const py = target.y + Math.sin(angle) * radius;
      if (step === 0) graphics.moveTo(px, py);
      else graphics.lineTo(px, py);
    }
    graphics.strokePath();
  }
  return true;
}

/** Break-flash radius as a multiple of the bubble radius (bursts outward). */
export const ENEMY_FORCE_FIELD_BREAK_RADIUS_FACTOR = 1.9;
/** Break-flash lifetime (seconds) — brief so a volley does not stack into a blur. */
export const ENEMY_FORCE_FIELD_BREAK_DURATION = 0.3;
/** Final scale the break flash expands to while fading. */
export const ENEMY_FORCE_FIELD_BREAK_END_SCALE = 1.7;
/** Break-flash depth — above ships so the shatter reads over the collision. */
export const ENEMY_FORCE_FIELD_BREAK_DEPTH = 60;

/**
 * Draws the enemy force-field **break** flash at the graphics origin: a
 * double ring of shards that reads as the barrier shattering outward. Pure
 * drawing (no tween), so the spawn helper below and unit tests share one
 * definition.
 *
 * @param graphics — the flash graphics (may be null → no-op).
 * @param radius — outer ring radius in px.
 * @param color — flash colour (defaults to {@link ENEMY_FORCE_FIELD_COLOR}).
 */
export function drawEnemyForceFieldBreakFlash(
  graphics: Phaser.GameObjects.Graphics | null,
  radius: number,
  color: number = ENEMY_FORCE_FIELD_COLOR,
): void {
  if (!graphics) return;
  graphics.clear();

  // Two rings: the broken barrier and its inner echo.
  graphics.lineStyle(ENEMY_FORCE_FIELD_LINE_WIDTH, color, 0.95);
  graphics.strokeCircle(0, 0, radius * 0.55);
  graphics.strokeCircle(0, 0, radius);

  // Radial shards bursting between the rings.
  for (let i = 0; i < ENEMY_FORCE_FIELD_SEGMENTS; i += 1) {
    const angle = (i / ENEMY_FORCE_FIELD_SEGMENTS) * Math.PI * 2;
    const inner = radius * (i % 2 === 0 ? 0.62 : 0.72);
    const outer = radius * (i % 2 === 0 ? 1.18 : 1.02);
    graphics.beginPath();
    graphics.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
    graphics.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
    graphics.strokePath();
  }
}

/** Options for {@link spawnEnemyForceFieldBreakFlash}. */
export interface EnemyForceFieldBreakFlashOptions {
  /**
   * Optional registry the spawned flash is added to while alive (removed on
   * completion) — lets scenes track/tear down the effect and tests observe
   * it without pixel assertions.
   */
  registry?: Phaser.GameObjects.Graphics[];
  /** Outer ring radius override (px). */
  radius?: number;
  /** Flash lifetime override (seconds). */
  duration?: number;
  /** Flash colour override (Phaser integer). */
  color?: number;
}

/**
 * Spawns the shared enemy force-field break flash at `(x, y)`: the barrier's
 * double shard ring expands and fades, then destroys itself.
 *
 * Spawned by `BaseEnemy` on the hit that spends the field's last hit, so the
 * game and every gym run the identical break cue (gym↔game parity).
 *
 * @returns The flash Graphics (destroyed when the tween completes).
 */
export function spawnEnemyForceFieldBreakFlash(
  scene: Phaser.Scene,
  x: number,
  y: number,
  options: EnemyForceFieldBreakFlashOptions = {},
): Phaser.GameObjects.Graphics {
  const radius = options.radius ?? 24;
  const duration = options.duration ?? ENEMY_FORCE_FIELD_BREAK_DURATION;
  const registry = options.registry;
  const color = options.color ?? ENEMY_FORCE_FIELD_COLOR;

  const flash = scene.add.graphics();
  flash.setPosition(x, y);
  flash.setDepth(ENEMY_FORCE_FIELD_BREAK_DEPTH);
  drawEnemyForceFieldBreakFlash(flash, radius, color);
  registry?.push(flash);

  scene.tweens.add({
    targets: flash,
    alpha: 0,
    scale: ENEMY_FORCE_FIELD_BREAK_END_SCALE,
    duration: duration * 1000,
    ease: 'Power2',
    onComplete: () => {
      if (registry) {
        const index = registry.indexOf(flash);
        if (index >= 0) registry.splice(index, 1);
      }
      flash.destroy();
    },
  });

  return flash;
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

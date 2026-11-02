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
 * The Shield shield bubble's timed-window ending animation (the final-second
 * fill ramp, the final half-second fill shrink and the countdown-driven rim
 * pulse, AH-0MUAYB5HR001HDYC) is **retired, not silently dropped**: its only
 * trigger was the effect-window countdown, and a charge-bounded shield has no
 * window to count down — the bubble is armed while the shared charge pool
 * holds a charge and pops on the last absorb (parent AH-0MVTQMREN009DSFW
 * AC1 / AH-0MVUVSW4J0009QUW). Every armed state draws the same steady bright
 * rim + translucent fill, identical in the game and every gym. Dead-code
 * decision recorded on AH-0MVVD8TCJ004RLXP.
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
 * Retired shield-bubble ending animation (AH-0MUAYB5HR001HDYC). The
 * final-second fill ramp (`SHIELD_BUBBLE_ENDING_FILL_ALPHA`), the final
 * half-second fill shrink (`SHIELD_BUBBLE_SHRINK_SECONDS` /
 * `SHIELD_BUBBLE_SHRINK_MIN_FACTOR`) and the countdown-driven rim pulse
 * (`SHIELD_BUBBLE_PULSE_RATE` / `SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER`) are
 * **retired, not silently dropped**: their only trigger was the
 * effect-window countdown, which the absorbed-hit model removes (parent
 * AH-0MVTQMREN009DSFW / AH-0MVUVSW4J0009QUW). "Armed means the pool holds a
 * charge" (AH-0MVVD8TCJ004RLXP) pops the bubble on the last spend and has no
 * window to count down, so every armed state draws the same steady bright
 * rim (`SHIELD_BUBBLE_STROKE_ALPHA`) + translucent fill — mirroring the
 * permanently-owned Force Field bubble.
 */
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
 * inactive, or its budget is spent — so an exhausted or spent field always
 * removes the aura. "Armed" reads the shared charge pool for owned and
 * pickup charges alike (`hasThornsRam`), so a field pickup's aura is drawn
 * while its one charge is held and pops on the last free ram; an empty
 * permanent pool clears the aura and it returns when a charge regenerates
 * (parent AH-0MVTQMREN009DSFW AC2 / F6 AC4).
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

  // Armed means the shared charge pool holds at least one charge (parent
  // AH-0MVTQMREN009DSFW AC2): `hasThornsRam` reads the pool for owned and
  // pickup charges alike, so a field pickup's aura is drawn while its one
  // charge is held and pops on the last free ram, and an empty permanent
  // pool clears the halo (no always-on aura) with it returning when a charge
  // regenerates (parent AC2 + F6 AC4).
  const charges = registry.thornsRemaining();
  if (!registry.hasThornsRam() || charges <= 0) return false;

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
 * while the registry says the player is shielded.
 *
 * **Armed means the shared charge pool holds at least one charge** (parent
 * AH-0MVTQMREN009DSFW AC1 / AH-0MVUVSW4J0009QUW): `isShielded` reads the pool
 * for owned and pickup charges alike, so a field pickup's bubble is drawn
 * while its one charge is held and pops on the last absorb, and an empty
 * permanent pool clears the bubble (no always-on armed visual) with the look
 * returning when the charge regenerates through the shared tick.
 *
 * The timed-window ending animation — the final-second fill ramp, the
 * final half-second fill shrink and the countdown-driven rim pulse
 * (AH-0MUAYB5HR001HDYC) — is **retired, not silently dropped** (dead-code
 * decision recorded on AH-0MVVD8TCJ004RLXP): its only trigger was the
 * effect-window countdown, which no longer exists, and a bubble armed by a
 * held charge has no window to count down. Every armed state therefore draws
 * the same **steady bright rim** (`SHIELD_BUBBLE_STROKE_ALPHA`) and
 * translucent fill — mirroring the permanently-owned Force Field bubble —
 * and the ending cue is the pop on the last spend.
 *
 * Cleared (never drawn) when there is no graphics, no player, or the shield
 * is disarmed (the pool holds no charge), so a popped shield always removes
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

  // `isShielded` reads the shared charge pool (owned and pickup charges
  // alike), so a field pickup's temporary-level TTL can never pop a bubble
  // while its charge is held — the bubble follows the pool, not the level.
  const fullRadius = SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR;
  graphics.lineStyle(
    SHIELD_BUBBLE_LINE_WIDTH,
    SHIELD_BUBBLE_COLOR,
    SHIELD_BUBBLE_STROKE_ALPHA,
  );
  graphics.strokeCircle(player.x, player.y, fullRadius);
  graphics.fillStyle(SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_FILL_ALPHA);
  graphics.fillCircle(player.x, player.y, fullRadius);
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
 * Force-bubble fill alpha while the field is active but its reflect budget is
 * exhausted (`forceFieldRemaining() <= 0`). Deliberately fainter than
 * {@link FORCE_FIELD_FILL_ALPHA} yet still visible, so a spent field reads
 * "up but inert" — never "expired" (AH-0MVBKT2WO001AR14 Q1 = b: dim when
 * spent).
 */
export const FORCE_FIELD_SPENT_FILL_ALPHA = 0.05;
/**
 * Force-bubble stroke alpha while the field is active but its reflect budget
 * is exhausted. Deliberately fainter than {@link FORCE_FIELD_STROKE_ALPHA}
 * yet still visible, so a spent field reads "up but inert" — never "expired"
 * (AH-0MVBKT2WO001AR14 Q1 = b: dim when spent).
 */
export const FORCE_FIELD_SPENT_STROKE_ALPHA = 0.35;

/**
 * Clears *graphics* and draws the shared Force Field reflect bubble around
 * *player* while the registry says the field is active.
 *
 * The bubble is a hexagonal boundary (the same radius the shared combat core
 * uses for reflection) with inward chevron "reflect" motifs, so the player
 * can read exactly which incoming shots will bounce. It is drawn steady — no
 * countdown-driven rim pulse and no final-second brighten, the timed-window
 * cues retired together with the Shield wind-down (AH-0MVVD8TCJ004RLXP) —
 * bright while a charge is held and dimmed while an owned pool is empty.
 *
 * **Reconciliation with "armed means holds a charge"** (AH-0MVVD8TCJ004RLXP):
 * `isForceFieldActive` reads **permanence or pool** — `isConsumableOwned`
 * or a held charge — so arming follows the pool while permanence keeps an
 * owned, empty field visibly "up but inert". A field pickup grants exactly
 * one charge and opens no effect window, so its bubble is drawn while the
 * charge is held and **pops on the last spend**; a permanent (hold-full)
 * field stays active for the whole run and its bubble **dims while the pool
 * is empty** (AH-0MVRDMG0N000Y03Z) and brightens again as a charge
 * regenerates through the shared tick.
 *
 * **Spent dim (AH-0MVBKT2WO001AR14 Q1 = b).** While the field is active but
 * `forceFieldRemaining() <= 0` the bubble is drawn with the reduced
 * {@link FORCE_FIELD_SPENT_STROKE_ALPHA}/{@link FORCE_FIELD_SPENT_FILL_ALPHA}
 * baseline instead of vanishing. The rim, fill and three chevrons all stay,
 * so a spent owned field still reads as up; it just reads as inert. A
 * permanent-only field has no countdown, so the armed/spent baselines are
 * the only two states the bubble draws.
 *
 * Cleared (never drawn) when there is no graphics, no player, or the field
 * is inactive — a pickup-only field reads `active=false` at zero charges, so
 * its spent bubble pops — so a disarmed field always removes the bubble.
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

  // Spent (cannot reflect any more) dims rather than vanishes (Q1 = b). For
  // a permanently-owned field `isForceFieldActive` stays true for the run, so
  // an empty pool shows the dim baseline (AH-0MVRDMG0N000Y03Z) and brightens
  // as a charge returns; a pickup-only field reads inactive at zero charges,
  // so its bubble pops on the last spend — the spent-dim rule reconciled
  // with "armed means holds a charge" (AH-0MVVD8TCJ004RLXP).
  const spent = registry.forceFieldRemaining() <= 0;
  const strokeAlpha = spent
    ? FORCE_FIELD_SPENT_STROKE_ALPHA
    : FORCE_FIELD_STROKE_ALPHA;
  const fillAlpha = spent
    ? FORCE_FIELD_SPENT_FILL_ALPHA
    : FORCE_FIELD_FILL_ALPHA;

  const radius = registry.forceFieldRadius();
  const centerX = player.x;
  const centerY = player.y;

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

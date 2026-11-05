/**
 * Countdown-fraction seam for the HUD timer ring (GDD §4.4; child of
 * AH-0MVZ8YQQV006Q09W "Timed upgrades show a timer", AC1).
 *
 * Every HUD row with a live countdown draws a sweeping arc ring around its icon
 * (see `src/powerups/icons.ts`). The fraction that ring sweeps comes from here
 * and nowhere else, so the game and every gym read the same arithmetic:
 *
 * - **`arriving`** — a consumable recharge or the permanent Orbital Strike
 *   next-bolt cadence. The wait starts spent and the ring fills from `0` to `1`
 *   as the charge/bolt becomes due.
 * - **`expiring`** — a power-up timed window or a weapon field-pickup window.
 *   The window opens full and the ring drains from `1` to `0` as it burns down.
 *
 * Both directions are the same ratio — `remaining / total` — because both timer
 * sources already report "time left" and "the span that time belongs to": the
 * mode names the sweep direction the renderer uses, never a second formula. In
 * both cases `0` means "nothing left of this countdown" and `1` means "the whole
 * countdown is still ahead", which is exactly what the ring draws.
 *
 * ## Contract
 *
 * - `remaining` is the time left (seconds) — the value the row's `next in Ns`
 *   label or `Ns` value column already reports, so ring and text can never
 *   disagree.
 * - `total` is the span that remaining belongs to — the recharge interval for an
 *   arriving timer, the window's captured `duration` for an expiring one (never a
 *   hard-coded TTL).
 * - The result is always a finite number in `[0, 1]`: a remaining above the
 *   total clamps to `1`, a negative remaining to `0`, and an unusable input
 *   (`total` missing, non-finite or `≤ 0`; `remaining` missing or non-finite)
 *   yields `0` rather than `NaN`/`Infinity` leaking into the renderer.
 * - The function is pure: no clock, no registry, no side effects, and the input
 *   object is never mutated — callers may pass a frozen literal.
 *
 * @module src/ui/hudCountdown
 */

/** Which way a countdown spends itself: `arriving` fills, `expiring` drains. */
export type CountdownMode = 'arriving' | 'expiring';

/** Inputs to {@link resolveCountdownFraction}: time left, its span, direction. */
export interface CountdownFractionInput {
  /** Time left in seconds; `undefined` is treated as "nothing left". */
  remaining?: number;
  /** The span `remaining` belongs to (seconds); `undefined`/`≤ 0` ⇒ `0`. */
  total?: number;
  /** The sweep direction the caller renders; does not change the ratio. */
  mode: CountdownMode;
}

/**
 * Resolve the `0 → 1` sweep fraction for one live countdown.
 *
 * `mode` intentionally does not alter the arithmetic (both directions are
 * `remaining / total`); it is part of the signature so a call site states which
 * way the ring sweeps, and so a future divergence has one seam to change. It is
 * read here to keep the contract explicit.
 *
 * @param input - `{ remaining, total, mode }`.
 * @returns A clamped fraction in `[0, 1]`, or `0` when the inputs are unusable.
 */
export function resolveCountdownFraction({
  remaining,
  total,
  mode,
}: CountdownFractionInput): number {
  // Direction is a rendering concern: `arriving` fills 0 → 1 while `expiring`
  // drains 1 → 0, both tracking this same "time left / total span" ratio.
  void mode;

  if (remaining === undefined || total === undefined) return 0;
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(remaining)) return 0;

  return Math.min(1, Math.max(0, remaining / total));
}

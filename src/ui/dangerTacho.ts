/**
 * Danger tacho HUD read-out (AH-0MWL7ORK8007LXJI AC5).
 *
 * The graze chain is only a reward if the player can see it climbing, so this
 * module renders the campaign's `DANGER ×N` read-out beside the score: the
 * current danger multiplier, a pip per tier so the chain is legible as
 * **shape** rather than colour alone, and a bar that drains with the decay
 * window so the player can see the multiplier about to fall.
 *
 * The resolution half ({@link resolveDangerTacho}) is pure and Phaser-free, so
 * its accessibility rules — a pip count per tier, a text label that never
 * relies on colour, a drain fraction in `[0, 1]` — are unit-testable without a
 * canvas. {@link DangerTacho} only draws that state.
 *
 * Never a second source of truth: the tier, multiplier and decay fraction are
 * read from the shared `GrazeTracker` (`src/core/graze.ts`), so the scene's
 * read-out cannot disagree with the score the shared pass awards.
 *
 * @module ui/dangerTacho
 */

import Phaser from 'phaser';

import { HUD_DEPTH } from '../core/constants';

/** Container name, so a test or a capture can find the read-out. */
export const DANGER_TACHO_NAME = 'hud-danger-tacho';

/** Label for the read-out (the multiplier is appended as `×N`). */
export const DANGER_TACHO_PREFIX = 'DANGER';

/** Width (px) of the decay drain bar. */
export const DANGER_TACHO_BAR_WIDTH = 96;

/** Height (px) of the decay drain bar. */
export const DANGER_TACHO_BAR_HEIGHT = 5;

/** Size (px) of one tier pip. */
export const DANGER_TACHO_PIP_SIZE = 7;

/** Gap (px) between tier pips. */
export const DANGER_TACHO_PIP_GAP = 3;

/** Number of tier pips drawn (one per danger tier). */
export const DANGER_TACHO_PIP_COUNT = 5;

/** Read-out colour — matches the shared cyan HUD text. */
export const DANGER_TACHO_COLOR = 0x00ffff;

/** Colour of a reached tier pip. */
export const DANGER_TACHO_PIP_FILLED = 0x00ffff;

/** Colour of an unreached tier pip (drawn hollow, not just darker). */
export const DANGER_TACHO_PIP_EMPTY = 0x226677;

/** Glyph shown while the chain climbs (tier gained). */
export const DANGER_TACHO_GAIN_GLYPH = '▲';

/** Glyph shown while the chain decays (tier lost) — a distinct shape. */
export const DANGER_TACHO_LOSS_GLYPH = '▼';

/** Seconds a tier-change glyph stays up. */
export const DANGER_TACHO_FLASH_SECONDS = 0.45;

/**
 * The read-out's render state, resolved from the shared tracker. Pure and
 * side-effect free.
 */
export interface DangerTachoState {
  /** The label to draw, e.g. `DANGER ×2`. */
  readonly label: string;
  /** Tier index (`0` = `×1`). */
  readonly tierIndex: number;
  /** The danger multiplier (`1`, `1.5`, `2`, `3` or `5`). */
  readonly multiplier: number;
  /** Reached tier pips (1 + tier index). */
  readonly filledPips: number;
  /** Total pips drawn (one per tier). */
  readonly totalPips: number;
  /** Fraction of the decay window still remaining (`1 → 0`, 0 at `×1`). */
  readonly decayFraction: number;
  /**
   * `gain` / `loss` while a tier change is being announced, `null` when the
   * chain is steady. Carried by a distinct glyph (shape), never colour alone.
   */
  readonly change: 'gain' | 'loss' | null;
}

/** Formats the multiplier as `×1`, `×1.5`, `×2`, `×3`, `×5`. */
export function formatDangerMultiplier(multiplier: number): string {
  const value = Number.isFinite(multiplier) ? multiplier : 1;
  return `×${Number.isInteger(value) ? String(value) : value.toFixed(1)}`;
}

/**
 * Resolves the read-out state.
 *
 * @param multiplier — the current danger multiplier from the tracker.
 * @param tierIndex — the current tier index from the tracker.
 * @param decayFraction — the tracker's remaining decay window (`1 → 0`).
 * @param change — the tier change being announced, if any.
 */
export function resolveDangerTacho(
  multiplier: number,
  tierIndex: number,
  decayFraction: number,
  change: 'gain' | 'loss' | null = null,
): DangerTachoState {
  const tier = Number.isFinite(tierIndex)
    ? Math.max(0, Math.min(DANGER_TACHO_PIP_COUNT - 1, Math.floor(tierIndex)))
    : 0;
  const fraction = Number.isFinite(decayFraction)
    ? Math.max(0, Math.min(1, decayFraction))
    : 0;
  return {
    label: `${DANGER_TACHO_PREFIX} ${formatDangerMultiplier(multiplier)}`,
    tierIndex: tier,
    multiplier: Number.isFinite(multiplier) ? multiplier : 1,
    filledPips: tier + 1,
    totalPips: DANGER_TACHO_PIP_COUNT,
    decayFraction: fraction,
    change,
  };
}

/** Options for {@link DangerTacho}. */
export interface DangerTachoOptions {
  /** Font size of the label (default 14 px monospace). */
  fontSize?: number;
  /** Text colour (defaults to the shared HUD cyan). */
  textColor?: string;
}

/**
 * Draws a {@link DangerTachoState}: the `DANGER ×N` label, one pip per tier
 * (filled for tiers reached, hollow for the rest) and the decay drain bar.
 *
 * The read-out is drawn right-anchored at the container's position, so a scene
 * can place it under a top-right score read-out.
 */
export class DangerTacho extends Phaser.GameObjects.Container {
  private readonly _label: Phaser.GameObjects.Text;
  private readonly _graphics: Phaser.GameObjects.Graphics;
  private _state: DangerTachoState = resolveDangerTacho(1, 0, 0);
  private _previousTier = 0;
  /** Seconds remaining on the tier-change glyph. */
  private _flashRemaining = 0;
  /** Pending tier-change announcement. */
  private _pendingChange: 'gain' | 'loss' | null = null;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    options: DangerTachoOptions = {},
  ) {
    super(scene, x, y);
    this.name = DANGER_TACHO_NAME;
    // HUD depth, so the read-out always draws above gameplay.
    this.setDepth(HUD_DEPTH);
    this._label = scene.add
      .text(0, 0, this._state.label, {
        fontFamily: 'monospace',
        fontSize: `${options.fontSize ?? 14}px`,
        color: options.textColor ?? '#00ffff',
      })
      .setOrigin(1, 0);
    this._graphics = scene.add.graphics();
    this.add([this._graphics, this._label]);
    scene.add.existing(this);
    this.redraw();
  }

  /** The current render state. */
  getState(): DangerTachoState {
    return this._state;
  }

  /** The label text as drawn (`DANGER ×N`), for tests and captures. */
  getLabelText(): string {
    return this._label.text;
  }

  /** Filled tier pips as drawn. */
  getFilledPips(): number {
    return this._state.filledPips;
  }

  /** Whether a tier change is being announced right now. */
  isAnnouncingChange(): boolean {
    return this._pendingChange !== null;
  }

  /**
   * A graze was just credited: pop the read-out so the moment reads even when
   * the tier does not change (AC5).
   */
  confirmGraze(): void {
    this.scene.tweens.add({
      targets: this._label,
      scale: 1.15,
      duration: 70,
      yoyo: true,
      ease: 'Power2',
    });
  }

  /**
   * Advances the tier-change announcement timer and repaints from `state`.
   *
   * A tier **loss** raises the distinct `▼` glyph and empties the top pip —
   * a shape change, so the signal is never carried by colour alone (AC5).
   */
  updateState(state: DangerTachoState, dtSeconds = 0): void {
    if (state.tierIndex > this._previousTier) {
      this._pendingChange = 'gain';
      this._flashRemaining = DANGER_TACHO_FLASH_SECONDS;
    } else if (state.tierIndex < this._previousTier) {
      this._pendingChange = 'loss';
      this._flashRemaining = DANGER_TACHO_FLASH_SECONDS;
    }
    this._previousTier = state.tierIndex;

    this._flashRemaining = Math.max(0, this._flashRemaining - dtSeconds);
    const change = this._flashRemaining > 0 ? this._pendingChange : null;
    if (change === null) this._pendingChange = null;

    this._state = { ...state, change };
    this.redraw();
  }

  /** Paints the label, pips and drain bar from the current state. */
  private redraw(): void {
    const state = this._state;
    const glyph =
      state.change === 'gain'
        ? DANGER_TACHO_GAIN_GLYPH
        : state.change === 'loss'
          ? DANGER_TACHO_LOSS_GLYPH
          : '';
    this._label.setText(glyph ? `${glyph} ${state.label}` : state.label);

    const g = this._graphics;
    g.clear();

    // Tier pips, right-aligned beneath the label: filled = reached, hollow =
    // still to earn. Shape (filled vs hollow outline) carries the tier.
    const pipRowWidth =
      state.totalPips * DANGER_TACHO_PIP_SIZE +
      (state.totalPips - 1) * DANGER_TACHO_PIP_GAP;
    const pipTop = 20;
    let pipX = -pipRowWidth;
    for (let i = 0; i < state.totalPips; i += 1) {
      if (i < state.filledPips) {
        g.fillStyle(DANGER_TACHO_PIP_FILLED, 1);
        g.fillRect(
          pipX,
          pipTop,
          DANGER_TACHO_PIP_SIZE,
          DANGER_TACHO_PIP_SIZE,
        );
      } else {
        g.lineStyle(1, DANGER_TACHO_PIP_EMPTY, 1);
        g.strokeRect(
          pipX,
          pipTop,
          DANGER_TACHO_PIP_SIZE,
          DANGER_TACHO_PIP_SIZE,
        );
      }
      pipX += DANGER_TACHO_PIP_SIZE + DANGER_TACHO_PIP_GAP;
    }

    // Decay drain bar, right-aligned under the pips: full while the window is
    // fresh, empty the instant the multiplier is about to fall.
    const barTop = pipTop + DANGER_TACHO_PIP_SIZE + 3;
    g.fillStyle(0x111111, 0.85);
    g.fillRect(
      -DANGER_TACHO_BAR_WIDTH,
      barTop,
      DANGER_TACHO_BAR_WIDTH,
      DANGER_TACHO_BAR_HEIGHT,
    );
    if (state.decayFraction > 0) {
      g.fillStyle(DANGER_TACHO_COLOR, 1);
      g.fillRect(
        -DANGER_TACHO_BAR_WIDTH,
        barTop,
        DANGER_TACHO_BAR_WIDTH * state.decayFraction,
        DANGER_TACHO_BAR_HEIGHT,
      );
    }
  }
}

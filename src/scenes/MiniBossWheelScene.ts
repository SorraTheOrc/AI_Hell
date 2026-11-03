/**
 * Mini-boss spin-the-wheel reward overlay (parent AH-0MVLISU03006WDOD;
 * test-first pair AH-0MVSF61YO0002KE5 / AH-0MVSF63LN008YHMT).
 *
 * A modal overlay launched by the mini-boss defeat flow. It shows a compact
 * wheel with **one wedge per owned permanent kind** (from the shared
 * six-slot pool: weapon drops and power-up kinds alike) plus a single
 * **bonus** wedge. The player clicks (or presses any key) to spin; the wheel
 * starts fast and eases out, stops on the wedge the launcher resolved, lights
 * that wedge and hands the complete outcome back through a **single optional
 * result callback** — mirroring `MineralChoiceScene.onSelect`.
 *
 * ## Launcher-agnostic by construction
 *
 * The launcher (`PlayScene`, a gym, …) resolves the outcome from the
 * run-seeded RNG and the owned-kind snapshot via the shared
 * `powerups/miniBossWheel` module, then launches this scene with:
 *
 * - `wedges` — the resolved wedge list (`buildWheelWedges`), so the wheel and
 *   the outcome can never see a different pool;
 * - `outcome` — the resolved 100-slot outcome (`drawWheelOutcome`);
 * - `onResult` — one optional callback invoked exactly once when the spin
 *   lands (the callback applies the outcome and closes the overlay);
 * - `autoSpinMs` — demo/attract mode: spin automatically after this delay so
 *   the bot never stalls (normal play omits it and waits for input);
 * - `fireSchedule` — the frozen player-fire schedule for the reduced-volume
 *   ghost fire while play is paused, reusing the shared hold-full metronome.
 *
 * The scene never computes probabilities, never reads a launcher by key and
 * never touches the reward state itself: it only animates the supplied
 * outcome and reports it back. That is what keeps the game and every gym on
 * the same code path (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * ## Multi-upgrade reveal (producer answer, 2026-10-28)
 *
 * When the landed slot upgrades two or three kinds, the **landing wedge**
 * renders **all** the gained kinds' icons inside that one wedge ("all icons
 * present"); the other gained kinds are not lit up on separate wedges. The
 * complete outcome is still reported (and applied) exactly once.
 *
 * ## Spin tension curve (producer answer Q3)
 *
 * ≈{@link MINI_BOSS_WHEEL_SPIN_DURATION_MS} total, fast start easing out with
 * at most one revolution of travel beyond the base three turns, then a short
 * landed-wedge reveal ({@link MINI_BOSS_WHEEL_REVEAL_HOLD_MS}) before the
 * overlay closes.
 *
 * ## Code-first visuals
 *
 * Wedge icons come from the existing code-drawn set (`drawPowerUpIcon` /
 * `drawWeaponIcon`); the bonus wedge and the pointer are drawn here. No
 * external art assets (GDD §7.2).
 *
 * @module src/scenes/MiniBossWheelScene
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { HOLD_FULL_FIRE_VOLUME_SCALE } from '../core/rules';
import { isWeaponDrop, toChoiceOption } from '../powerups/choice';
import {
  MINI_BOSS_WHEEL_BONUS_ID,
  type MiniBossWheelOutcome,
  type MiniBossWheelWedge,
} from '../powerups/miniBossWheel';
import { drawPowerUpIcon, drawWeaponIcon } from '../powerups/icons';
import type { DropId } from '../powerups/types';
import { playWeaponFireSound } from '../audio/effects';
import {
  createHoldFullFireMetronome,
  type HoldFullFireMetronome,
  type HoldFullFireSchedule,
} from './core/holdFullFire';

/** Total spin duration (ms) — fast start, ease-out (producer answer Q3). */
export const MINI_BOSS_WHEEL_SPIN_DURATION_MS = 2200;
/**
 * Base number of full turns the wheel makes before settling on the target
 * wedge. The landing offset adds at most one further revolution, so the total
 * travel never exceeds four turns ("at most one overshoot revolution").
 */
export const MINI_BOSS_WHEEL_SPIN_TURNS = 3;
/**
 * How long (ms) the landed wedge stays highlighted before the result callback
 * runs and the overlay closes, so the player can read the result.
 */
export const MINI_BOSS_WHEEL_REVEAL_HOLD_MS = 450;

/** Scene key used by every launcher. */
export const MINI_BOSS_WHEEL_SCENE_KEY = 'MiniBossWheelScene';

/** Wheel centre on the 960×540 playfield. */
const WHEEL_CENTRE_X = GAME_WIDTH / 2;
const WHEEL_CENTRE_Y = 300;
/** Outer wheel radius (px). */
const WHEEL_RADIUS = 186;
/** Radius (px) at which a wedge's own icon is drawn. */
const WEDGE_ICON_RADIUS = WHEEL_RADIUS * 0.6;
/** Radius (px) at which a wedge's display name is drawn. */
const WEDGE_LABEL_RADIUS = WHEEL_RADIUS * 0.86;
/** Icon extent (px) used when drawing a wedge icon. */
const WEDGE_ICON_SIZE = 16;
/** Icon extent (px) used for the multi-upgrade reveal inside a wedge. */
const WEDGE_REVEAL_ICON_SIZE = 11;

/** Alternating wedge fills (neon-on-black style). */
const WEDGE_FILL_COLORS = [0x16222e, 0x1f2f3d] as const;
const WEDGE_STROKE_COLOR = 0x00ffff;
const WEDGE_STROKE_ALPHA = 0.8;
const WEDGE_LABEL_COLOR = '#00ffff';
const BONUS_WEDGE_FILL_COLOR = 0x3a2a05;
const BONUS_WEDGE_STROKE_COLOR = 0xffdd44;
const BONUS_LABEL_COLOR = '#ffdd44';
/** Text copy of the bonus wedge. */
const BONUS_WEDGE_LABEL = 'BONUS';
/** Landed-wedge highlight fill/stroke. */
const HIGHLIGHT_FILL_COLOR = 0xffdd44;
const HIGHLIGHT_ALPHA = 0.35;
const HIGHLIGHT_STROKE_COLOR = 0xffffff;
/** Pointer triangle colour (matches the reward heading). */
const POINTER_COLOR = 0xffdd44;
/** Heading copy/colour. */
const HEADING_COPY = 'MINI-BOSS REWARD — SPIN THE WHEEL';
const HEADING_COLOR = '#ffdd44';
/** Muted instruction copy shown until the player spins. */
const INSTRUCTION_COPY = 'CLICK OR PRESS ANY KEY TO SPIN';
const INSTRUCTION_COLOR = '#aaaaaa';

/** One wedge as rendered by the overlay (public, test-observable view). */
export interface MiniBossWheelWedgeVisual {
  /** Zero-based wedge index. */
  readonly index: number;
  /** The owned kind this wedge grants, or {@link MINI_BOSS_WHEEL_BONUS_ID}. */
  readonly id: DropId | typeof MINI_BOSS_WHEEL_BONUS_ID;
  /** `'bonus'` for the bonus wedge, `'kind'` for an owned permanent kind. */
  readonly kind: 'bonus' | 'kind';
  /** Player-facing wedge label (`Spread Shot`, `Shield`, `BONUS`, …). */
  readonly label: string;
  /** The icon ids currently rendered inside this wedge. */
  readonly iconIds: readonly DropId[];
}

/** Launcher-supplied payload. */
export interface MiniBossWheelSceneData {
  /** One wedge per owned permanent kind plus the bonus wedge. */
  readonly wedges?: readonly MiniBossWheelWedge[];
  /** The resolved outcome (which wedge to land on plus its gains). */
  readonly outcome?: MiniBossWheelOutcome | null;
  /**
   * The single optional result contract every launcher supplies. Called
   * exactly once when the spin lands; the launcher applies the outcome and
   * resumes play.
   */
  readonly onResult?: (outcome: MiniBossWheelOutcome) => void;
  /**
   * Demo/attract mode: auto-spin after this many milliseconds. `0`/absent
   * waits for a real player spin.
   */
  readonly autoSpinMs?: number;
  /** Frozen player-fire schedule for the reduced-volume paused ghost fire. */
  readonly fireSchedule?: HoldFullFireSchedule;
}

/** Internal spin lifecycle. */
type SpinPhase = 'idle' | 'spinning' | 'reveal' | 'resolved';

/**
 * The wedge the pointer must land on for the supplied outcome.
 *
 * - bonus outcome → the single bonus wedge;
 * - upgrade outcome → the wedge of the outcome's first gained kind (the gains
 *   are in the shared stable order, so this is deterministic and cannot drift
 *   from the resolver).
 *
 * Falls back to the last wedge (bonus) / first wedge when the supplied data is
 * incomplete, so the animation is always total.
 */
export function resolveTargetWedgeIndex(
  wedges: readonly MiniBossWheelWedge[],
  outcome: MiniBossWheelOutcome,
): number {
  if (outcome.slotKind === 'bonus') {
    const bonus = wedges.findIndex((wedge) => wedge.kind === 'bonus');
    return bonus >= 0 ? bonus : Math.max(0, wedges.length - 1);
  }
  const firstGain = outcome.gains[0];
  if (firstGain !== undefined) {
    const index = wedges.findIndex((wedge) => wedge.id === firstGain.id);
    if (index >= 0) return index;
  }
  return 0;
}

/** Cubic ease-out: fast start, long gentle settle. */
function easeOutCubic(progress: number): number {
  const inverse = 1 - progress;
  return 1 - inverse * inverse * inverse;
}

/** Clamps `value` into `[0, 1]`. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class MiniBossWheelScene extends Phaser.Scene {
  /** Launcher-supplied wedge list (one per owned kind + bonus). */
  private wedges: MiniBossWheelWedge[] = [];
  /** Launcher-supplied resolved outcome, or null when none was supplied. */
  private outcome: MiniBossWheelOutcome | null = null;
  /** The single optional result callback. */
  private onResult: ((outcome: MiniBossWheelOutcome) => void) | null = null;
  /** Demo-only auto-spin delay (ms); 0 waits for input. */
  private autoSpinMs = 0;
  /** Frozen player-fire schedule, or null when none was supplied. */
  private fireSchedule: HoldFullFireSchedule | null = null;

  /** The wedge the pointer lands on (resolved from the outcome once). */
  private targetWedgeIndex = 0;
  /** Current spin lifecycle phase. */
  private phase: SpinPhase = 'idle';
  /** Simulated time (ms) spent in the current spinning/reveal phase. */
  private phaseElapsedMs = 0;
  /** Total rotation (radians) the current spin travels. */
  private spinTravelRadians = 0;
  /** Current wheel rotation (radians — negative = clockwise travel). */
  private rotationRadians = 0;
  /** The landed wedge index, or null until the wheel stops. */
  private landedWedgeIndex: number | null = null;
  /** The icon ids rendered inside each wedge (mutated by the reveal). */
  private wedgeIconIds: DropId[][] = [];
  /** Base icon objects per wedge (index-aligned with `wedges`). */
  private wedgeIconObjects: Phaser.GameObjects.Graphics[][] = [];
  /** Icon objects drawn for the landed wedge's multi-upgrade reveal. */
  private revealIconObjects: Phaser.GameObjects.Graphics[] = [];
  /** How many times the result callback has fired (exactly once by design). */
  private resultCallCount = 0;

  /** Pending demo auto-spin timer. */
  private autoSpinTimer: Phaser.Time.TimerEvent | null = null;
  /** Live reduced-volume ghost-fire metronome. */
  private metronome: HoldFullFireMetronome | null = null;

  /** Rotating wheel container (body + icons + labels + highlight). */
  private wheel: Phaser.GameObjects.Container | null = null;
  /** Landed-wedge highlight graphics (hidden until the spin lands). */
  private highlight: Phaser.GameObjects.Graphics | null = null;
  /** Instruction text object (hidden once the spin starts). */
  private instruction: Phaser.GameObjects.Text | null = null;
  /** The bound keydown listener (removed on shutdown). */
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  /** The bound pointerdown listener (removed on shutdown). */
  private pointerdownHandler: (() => void) | null = null;

  constructor() {
    super(MINI_BOSS_WHEEL_SCENE_KEY);
  }

  init(data: MiniBossWheelSceneData = {}): void {
    this.wedges = data.wedges ? data.wedges.map((wedge) => ({ ...wedge })) : [];
    this.outcome = data.outcome ?? null;
    this.onResult = data.onResult ?? null;
    this.autoSpinMs = data.autoSpinMs ?? 0;
    this.fireSchedule = data.fireSchedule ?? null;
    this.targetWedgeIndex =
      this.outcome !== null
        ? resolveTargetWedgeIndex(this.wedges, this.outcome)
        : 0;
    this.phase = 'idle';
    this.phaseElapsedMs = 0;
    this.spinTravelRadians = 0;
    this.rotationRadians = 0;
    this.landedWedgeIndex = null;
    this.wedgeIconIds = this.wedges.map((wedge) =>
      wedge.kind === 'bonus' ? [] : [wedge.id as DropId],
    );
    this.wedgeIconObjects = [];
    this.revealIconObjects = [];
    this.resultCallCount = 0;
    this.autoSpinTimer = null;
    this.metronome = null;
    this.wheel = null;
    this.highlight = null;
    this.instruction = null;
    this.keydownHandler = null;
    this.pointerdownHandler = null;
  }

  create(): void {
    // Cover the whole screen above the paused launcher, like the hold-full
    // overlay (GDD §4.5).
    this.scene.bringToTop();
    this.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.92)
      .setOrigin(0);

    this.add
      .text(GAME_WIDTH / 2, 44, HEADING_COPY, {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: HEADING_COLOR,
      })
      .setOrigin(0.5);

    this.instruction = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 34, INSTRUCTION_COPY, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: INSTRUCTION_COLOR,
      })
      .setOrigin(0.5);

    this._buildWheel();
    this._buildPointer();

    // Player-initiated spin: any click or any key starts it. Once the spin
    // has started (or resolved) `spin()` is a no-op, so a repeated click can
    // never apply the outcome twice.
    const pointerdownHandler = () => this.spin();
    this.pointerdownHandler = pointerdownHandler;
    this.input.on('pointerdown', pointerdownHandler);

    const keydownHandler = () => this.spin();
    this.keydownHandler = keydownHandler;
    this.input.keyboard?.on('keydown', keydownHandler);

    // Demo/attract mode: spin automatically so the bot never stalls on the
    // wheel; normal play leaves `autoSpinMs` at 0 and waits for the player.
    if (this.autoSpinMs > 0) {
      this.autoSpinTimer = this.time.delayedCall(this.autoSpinMs, () =>
        this.spin(),
      );
    }

    this.metronome = this.fireSchedule
      ? createHoldFullFireMetronome(this.fireSchedule)
      : null;

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this._teardownInput(),
    );
  }

  /**
   * Starts the spin when the overlay is still waiting for input. Returns
   * whether a spin actually started, so an input handler (or a test) can tell
   * a first spin from a repeat that must be ignored.
   */
  spin(): boolean {
    if (this.phase !== 'idle' || this.outcome === null || this.wedges.length === 0) {
      return false;
    }
    this.phase = 'spinning';
    this.phaseElapsedMs = 0;
    this.rotationRadians = 0;
    this._resetReveal();
    // Cancel any pending demo auto-spin so it cannot fire a second time.
    this.autoSpinTimer?.remove(false);
    this.autoSpinTimer = null;
    this.instruction?.setVisible(false);
    this.spinTravelRadians = this._computeSpinTravel();
    this.wheel?.setRotation(0);
    return true;
  }

  /**
   * Drives the spin and the landed-wedge reveal with the scene's own elapsed
   * time so the animation is deterministic (fixed-delta test steps included),
   * plus the reduced-volume ghost fire from the frozen schedule.
   */
  override update(_time: number, delta: number): void {
    const stepMs = Math.max(0, delta);
    if (this.metronome !== null) {
      for (const weaponId of this.metronome.advance(stepMs)) {
        playWeaponFireSound(weaponId, {
          volume: HOLD_FULL_FIRE_VOLUME_SCALE,
        });
      }
    }

    if (this.phase === 'spinning') {
      this.phaseElapsedMs += stepMs;
      const progress = clamp01(
        this.phaseElapsedMs / MINI_BOSS_WHEEL_SPIN_DURATION_MS,
      );
      this.rotationRadians = -easeOutCubic(progress) * this.spinTravelRadians;
      this.wheel?.setRotation(this.rotationRadians);
      if (progress >= 1) this._landOnTarget();
      return;
    }

    if (this.phase === 'reveal') {
      this.phaseElapsedMs += stepMs;
      if (this.phaseElapsedMs >= MINI_BOSS_WHEEL_REVEAL_HOLD_MS) {
        this._resolve();
      }
    }
  }

  // ── Public, test-observable surface ────────────────────────────────

  /** One visual per wedge, in wheel order. */
  getWedges(): MiniBossWheelWedgeVisual[] {
    return this.wedges.map((wedge, index) => ({
      index,
      id: wedge.id,
      kind: wedge.kind,
      label:
        wedge.kind === 'bonus'
          ? BONUS_WEDGE_LABEL
          : toChoiceOption(wedge.id as DropId).name,
      iconIds: [...this.wedgeIconIds[index]],
    }));
  }

  /** Player-facing wedge labels, in wheel order. */
  getWedgeLabels(): string[] {
    return this.getWedges().map((wedge) => wedge.label);
  }

  /** The icon ids currently rendered inside each wedge, in wheel order. */
  getWedgeIconIds(): DropId[][] {
    return this.wedgeIconIds.map((ids) => [...ids]);
  }

  /** The launcher-supplied outcome, or null when none was supplied. */
  getOutcome(): MiniBossWheelOutcome | null {
    return this.outcome === null
      ? null
      : {
          slotKind: this.outcome.slotKind,
          gains: this.outcome.gains.map((gain) => ({ ...gain })),
        };
  }

  /** The wedge the pointer will land on for the supplied outcome. */
  getTargetWedgeIndex(): number {
    return this.targetWedgeIndex;
  }

  /** The landed wedge index, or null before the wheel stops. */
  getLandedWedgeIndex(): number | null {
    return this.landedWedgeIndex;
  }

  /** The lit wedge indexes (the landed wedge only, once it lands). */
  getHighlightedWedgeIndexes(): number[] {
    return this.landedWedgeIndex === null ? [] : [this.landedWedgeIndex];
  }

  /** Current wheel rotation in radians (negative = clockwise travel). */
  getRotationRadians(): number {
    return this.rotationRadians;
  }

  /** True while the wheel is spinning. */
  isSpinning(): boolean {
    return this.phase === 'spinning';
  }

  /** True once the outcome has been reported (the overlay then closes). */
  isResolved(): boolean {
    return this.phase === 'resolved';
  }

  /** How many times the result callback has fired (0 or 1). */
  getResultCallCount(): number {
    return this.resultCallCount;
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /** Builds the rotating wheel: body wedges, per-wedge icons and labels. */
  private _buildWheel(): void {
    const count = Math.max(1, this.wedges.length);
    const step = (Math.PI * 2) / count;
    const wheel = this.add.container(WHEEL_CENTRE_X, WHEEL_CENTRE_Y);
    this.wheel = wheel;

    const body = this.add.graphics();
    wheel.add(body);

    for (let index = 0; index < count; index += 1) {
      const wedge = this.wedges[index];
      const isBonus = wedge === undefined || wedge.kind === 'bonus';
      const centre = -Math.PI / 2 + index * step;
      const start = centre - step / 2;
      const end = centre + step / 2;

      body.fillStyle(
        isBonus
          ? BONUS_WEDGE_FILL_COLOR
          : WEDGE_FILL_COLORS[index % WEDGE_FILL_COLORS.length],
        1,
      );
      body.beginPath();
      body.moveTo(0, 0);
      body.arc(0, 0, WHEEL_RADIUS, start, end, false);
      body.closePath();
      body.fillPath();
      body.lineStyle(
        2,
        isBonus ? BONUS_WEDGE_STROKE_COLOR : WEDGE_STROKE_COLOR,
        WEDGE_STROKE_ALPHA,
      );
      body.strokePath();

      if (wedge === undefined) continue;

      // Code-drawn icon for an owned wedge (the bonus wedge is drawn by the
      // scene's own body colouring and label).
      const iconObjects: Phaser.GameObjects.Graphics[] = [];
      if (wedge.kind === 'kind') {
        const icon = this.add.graphics();
        this._drawIcon(icon, wedge.id as DropId, 0, 0, WEDGE_ICON_SIZE);
        icon.setPosition(
          Math.cos(centre) * WEDGE_ICON_RADIUS,
          Math.sin(centre) * WEDGE_ICON_RADIUS,
        );
        wheel.add(icon);
        iconObjects.push(icon);
      }
      this.wedgeIconObjects[index] = iconObjects;

      const label = this.add
        .text(
          Math.cos(centre) * WEDGE_LABEL_RADIUS,
          Math.sin(centre) * WEDGE_LABEL_RADIUS,
          isBonus ? BONUS_WEDGE_LABEL : toChoiceOption(wedge.id as DropId).name,
          {
            fontFamily: 'monospace',
            fontSize: '12px',
            color: isBonus ? BONUS_LABEL_COLOR : WEDGE_LABEL_COLOR,
            align: 'center',
          },
        )
        .setOrigin(0.5);
      wheel.add(label);
    }

    // The highlight is drawn on top of the body once the wheel lands.
    const highlight = this.add.graphics();
    highlight.setVisible(false);
    this.highlight = highlight;
    wheel.add(highlight);
  }

  /** Draws the static pointer above the wheel. */
  private _buildPointer(): void {
    const graphics = this.add.graphics();
    graphics.fillStyle(POINTER_COLOR, 1);
    graphics.beginPath();
    graphics.moveTo(WHEEL_CENTRE_X - 14, WHEEL_CENTRE_Y - WHEEL_RADIUS - 30);
    graphics.lineTo(WHEEL_CENTRE_X + 14, WHEEL_CENTRE_Y - WHEEL_RADIUS - 30);
    graphics.lineTo(WHEEL_CENTRE_X, WHEEL_CENTRE_Y - WHEEL_RADIUS - 8);
    graphics.closePath();
    graphics.fillPath();
  }

  /** Draws one shared code-first icon at a local position. */
  private _drawIcon(
    graphics: Phaser.GameObjects.Graphics,
    id: DropId,
    x: number,
    y: number,
    size: number,
  ): void {
    if (isWeaponDrop(id)) {
      drawWeaponIcon(graphics, id, x, y, size);
    } else {
      drawPowerUpIcon(graphics, id, x, y, size);
    }
  }

  // ── Spin lifecycle ────────────────────────────────────────────────

  /**
   * Total rotation for this spin: {@link MINI_BOSS_WHEEL_SPIN_TURNS} base
   * turns plus the offset that brings the target wedge under the pointer, so
   * the travel is always between three and four turns.
   */
  private _computeSpinTravel(): number {
    const count = Math.max(1, this.wedges.length);
    const step = (Math.PI * 2) / count;
    const targetOffset =
      ((this.targetWedgeIndex * step) % (Math.PI * 2) + Math.PI * 2) %
      (Math.PI * 2);
    return Math.PI * 2 * MINI_BOSS_WHEEL_SPIN_TURNS + targetOffset;
  }

  /** The wheel has stopped: light the landing wedge, reveal its gains. */
  private _landOnTarget(): void {
    this.phase = 'reveal';
    this.phaseElapsedMs = 0;
    this.landedWedgeIndex = this.targetWedgeIndex;
    this.wheel?.setRotation(this.rotationRadians);
    this._highlightLandedWedge();
    this._revealLandedGains();
  }

  /** Paints the landed wedge highlight in the wheel's local space. */
  private _highlightLandedWedge(): void {
    const highlight = this.highlight;
    if (highlight === null || this.landedWedgeIndex === null) return;
    const count = Math.max(1, this.wedges.length);
    const step = (Math.PI * 2) / count;
    const centre = -Math.PI / 2 + this.landedWedgeIndex * step;
    highlight.clear();
    highlight.fillStyle(HIGHLIGHT_FILL_COLOR, HIGHLIGHT_ALPHA);
    highlight.beginPath();
    highlight.moveTo(0, 0);
    highlight.arc(0, 0, WHEEL_RADIUS, centre - step / 2, centre + step / 2, false);
    highlight.closePath();
    highlight.fillPath();
    highlight.lineStyle(3, HIGHLIGHT_STROKE_COLOR, 1);
    highlight.strokePath();
    highlight.setVisible(true);
  }

  /**
   * Renders every gained kind's icon inside the single landing wedge
   * ("the wedge with the multi-results has all icons present") and removes
   * the wedge's own base icon so nothing is drawn twice.
   */
  private _revealLandedGains(): void {
    if (this.outcome === null || this.landedWedgeIndex === null) return;
    const gainedIds = [...new Set(this.outcome.gains.map((gain) => gain.id))];
    if (gainedIds.length === 0) return;

    const count = Math.max(1, this.wedges.length);
    const step = (Math.PI * 2) / count;
    const centre = -Math.PI / 2 + this.landedWedgeIndex * step;

    // Hide the wedge's own base icon(s) — the reveal draws the full set.
    for (const icon of this.wedgeIconObjects[this.landedWedgeIndex] ?? []) {
      icon.setVisible(false);
    }
    for (const icon of this.revealIconObjects) icon.destroy();
    this.revealIconObjects = [];

    const spread = Math.min(step * 0.7, Math.PI / 3);
    const denominator = Math.max(1, gainedIds.length - 1);
    gainedIds.forEach((id, index) => {
      const offset =
        gainedIds.length === 1
          ? 0
          : -spread / 2 + (spread * index) / denominator;
      const angle = centre + offset;
      const icon = this.add.graphics();
      this._drawIcon(
        icon,
        id,
        0,
        0,
        gainedIds.length === 1 ? WEDGE_ICON_SIZE : WEDGE_REVEAL_ICON_SIZE,
      );
      icon.setPosition(
        Math.cos(angle) * WEDGE_ICON_RADIUS,
        Math.sin(angle) * WEDGE_ICON_RADIUS,
      );
      this.wheel?.add(icon);
      this.revealIconObjects.push(icon);
    });

    this.wedgeIconIds[this.landedWedgeIndex] = gainedIds;
  }

  /** Reports the outcome exactly once, then closes the overlay. */
  private _resolve(): void {
    if (this.phase === 'resolved') return;
    this.phase = 'resolved';
    this.autoSpinTimer?.remove(false);
    this.autoSpinTimer = null;
    this.metronome = null;
    this._teardownInput();
    const outcome = this.outcome;
    const handler = this.onResult;
    this.onResult = null;
    this.resultCallCount += 1;
    if (outcome !== null) handler?.(outcome);
    this.scene.stop();
  }

  /**
   * Clears any reveal state left by a previous spin. Only reachable when
   * `spin()` starts from `idle`, so this is a defensive reset.
   */
  private _resetReveal(): void {
    for (const icon of this.revealIconObjects) icon.destroy();
    this.revealIconObjects = [];
    this.landedWedgeIndex = null;
    this.highlight?.clear();
    this.highlight?.setVisible(false);
    this.wedgeIconIds = this.wedges.map((wedge) =>
      wedge.kind === 'bonus' ? [] : [wedge.id as DropId],
    );
    for (const icons of this.wedgeIconObjects) {
      for (const icon of icons) icon.setVisible(true);
    }
  }

  /** Removes the input listeners (on resolution and on shutdown). */
  private _teardownInput(): void {
    if (this.pointerdownHandler !== null) {
      this.input.off('pointerdown', this.pointerdownHandler);
      this.pointerdownHandler = null;
    }
    if (this.keydownHandler !== null) {
      this.input.keyboard?.off('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }
}

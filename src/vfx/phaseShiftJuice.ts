/**
 * Phase Shift juice — screen-wide phase treatment (parent AH-0MUIYX1EE008FVS8).
 *
 * Phase Shift (P6) is now automatic, so the player needs an unmistakable,
 * screen-wide read that it fired. Per producer answer Q4 this module owns the
 * single shared treatment:
 *
 *   - a subtle **desaturation/dim** overlay,
 *   - a **chromatic split-tint** (two colour-offset ADD overlays that fringe
 *     everything on screen — enemies, bullets and minerals alike), and
 *   - a light **camera shake** on activation.
 *
 * The ship keeps its existing ghost alpha (`applyPhaseGhost` in
 * `scenes/core/CombatEffectVisuals.ts`) — this module never touches the ship.
 *
 * Design notes:
 *   - `resolvePhaseShiftJuiceParams()` is pure, total and deterministic (no
 *     Phaser import), so the tunable model is trivially unit-testable.
 *   - The overlays are screen-wide rather than per-object because Phaser
 *     `Graphics`/`Container` targets (enemies, bullets, minerals) do not
 *     implement the Tint component; a screen-wide tint is both the honest
 *     implementation and trivially clean to clear on expiry.
 *   - Every layer has an exported `PHASE_SHIFT_ENABLE_*` toggle mirroring
 *     `playerDeathJuice`, so a layer can be dropped without code surgery.
 *   - `PhaseShiftJuice.update(active, dt)` is edge-triggered: the treatment is
 *     applied on the frame the phase activates and cleared the frame it
 *     expires, leaving no residual tint or shake.
 *
 * @module vfx/phaseShiftJuice
 */

import Phaser from 'phaser';

import type { JuiceRegistry } from './playerDeathJuice';

// ── Tunables ────────────────────────────────────────────────────────

/** Depth of the phase overlays — above the world, below the death flash. */
export const PHASE_SHIFT_OVERLAY_DEPTH = 850;

/** Dark-blue desaturation/dim colour. */
export const PHASE_SHIFT_DIM_COLOR = 0x0a1a33;

/** Peak alpha of the desaturation/dim overlay (subtle). */
export const PHASE_SHIFT_DIM_ALPHA = 0.22;

/** Cyan side of the chromatic split. */
export const PHASE_SHIFT_SPLIT_COLOR_CYAN = 0x33ffee;

/** Red side of the chromatic split. */
export const PHASE_SHIFT_SPLIT_COLOR_RED = 0xff3355;

/** Peak alpha of each chromatic split overlay. */
export const PHASE_SHIFT_SPLIT_ALPHA = 0.1;

/** Horizontal offset (px) of the chromatic split overlays. */
export const PHASE_SHIFT_SPLIT_OFFSET = 3;

/** Scene-camera shake intensity on activation (light). */
export const PHASE_SHIFT_SHAKE_INTENSITY = 0.006;

/** Scene-camera shake duration on activation (ms). */
export const PHASE_SHIFT_SHAKE_DURATION_MS = 180;

/** Whether the desaturation/dim layer is enabled. */
export const PHASE_SHIFT_ENABLE_DIM = true;

/** Whether the chromatic split-tint layer is enabled. */
export const PHASE_SHIFT_ENABLE_SPLIT = true;

/** Whether the camera-shake layer is enabled. */
export const PHASE_SHIFT_ENABLE_SHAKE = true;

// ── Resolved parameter shape ───────────────────────────────────────

/** Fully-resolved Phase Shift juice parameters. */
export interface PhaseShiftJuiceParams {
  /** Depth of every phase overlay. */
  overlayDepth: number;
  /** Desaturation/dim colour (hex). */
  dimColor: number;
  /** Desaturation/dim peak alpha. */
  dimAlpha: number;
  /** Whether the desaturation/dim layer is enabled. */
  dimEnabled: boolean;
  /** Cyan chromatic-split colour (hex). */
  splitColorCyan: number;
  /** Red chromatic-split colour (hex). */
  splitColorRed: number;
  /** Per-overlay split alpha. */
  splitAlpha: number;
  /** Horizontal offset of the split overlays (px). */
  splitOffset: number;
  /** Whether the chromatic split-tint layer is enabled. */
  splitEnabled: boolean;
  /** Scene-camera shake intensity. */
  shakeIntensity: number;
  /** Scene-camera shake duration (ms). */
  shakeDurationMs: number;
  /** Whether the camera-shake layer is enabled. */
  shakeEnabled: boolean;
}

/**
 * Resolves the complete Phase Shift juice parameters. Pure, total and
 * deterministic (no Phaser import) — every value comes from the exported
 * tunables above and every toggle is reflected verbatim.
 */
export function resolvePhaseShiftJuiceParams(): PhaseShiftJuiceParams {
  return {
    overlayDepth: PHASE_SHIFT_OVERLAY_DEPTH,
    dimColor: PHASE_SHIFT_DIM_COLOR,
    dimAlpha: PHASE_SHIFT_DIM_ALPHA,
    dimEnabled: PHASE_SHIFT_ENABLE_DIM,
    splitColorCyan: PHASE_SHIFT_SPLIT_COLOR_CYAN,
    splitColorRed: PHASE_SHIFT_SPLIT_COLOR_RED,
    splitAlpha: PHASE_SHIFT_SPLIT_ALPHA,
    splitOffset: PHASE_SHIFT_SPLIT_OFFSET,
    splitEnabled: PHASE_SHIFT_ENABLE_SPLIT,
    shakeIntensity: PHASE_SHIFT_SHAKE_INTENSITY,
    shakeDurationMs: PHASE_SHIFT_SHAKE_DURATION_MS,
    shakeEnabled: PHASE_SHIFT_ENABLE_SHAKE,
  };
}

/** Options for {@link PhaseShiftJuice}. */
export interface PhaseShiftJuiceOptions {
  /**
   * Caller-owned registry every overlay is added to (and removed from on
   * clear), so a scene's `SHUTDOWN` teardown can destroy any leftovers.
   */
  registry?: JuiceRegistry;
  /** Parameter overrides (defaults to {@link resolvePhaseShiftJuiceParams}). */
  params?: PhaseShiftJuiceParams;
}

/**
 * Owns the screen-wide Phase Shift treatment for one scene.
 *
 * `update(active, dt)` is edge-triggered: when `active` rises, the overlays
 * are created and the shake fires once; while `active` stays true nothing is
 * re-created; when `active` falls, every overlay is destroyed and removed
 * from the registry. `destroy()` is an unconditional teardown for scene
 * shutdown.
 *
 * The controller is a safe no-op when the scene has no `add`/`scale`/`cameras`
 * facilities (headless stubs) and never throws.
 */
export class PhaseShiftJuice {
  private readonly scene: Phaser.Scene;
  private readonly params: PhaseShiftJuiceParams;
  private readonly registry: JuiceRegistry | undefined;
  private overlays: Phaser.GameObjects.Rectangle[] = [];
  private active = false;

  constructor(scene: Phaser.Scene, options: PhaseShiftJuiceOptions = {}) {
    this.scene = scene;
    this.params = options.params ?? resolvePhaseShiftJuiceParams();
    this.registry = options.registry;
  }

  /** Whether the treatment is currently applied. */
  get isActive(): boolean {
    return this.active;
  }

  /** The live overlay display objects (empty when inactive). */
  get activeOverlays(): readonly Phaser.GameObjects.Rectangle[] {
    return this.overlays;
  }

  /**
   * Advances the treatment for the current frame.
   *
   * @param active — whether Phase Shift is currently active.
   * @param _dt — frame delta (seconds); reserved for future pulsing.
   * @returns whether the treatment is applied after this call.
   */
  update(active: boolean, _dt = 0): boolean {
    if (active && !this.active) {
      this.active = true;
      this._apply();
    } else if (!active && this.active) {
      this.active = false;
      this._clear();
    }
    return this.active;
  }

  /** Clears every overlay and releases all resources. */
  destroy(): void {
    this.active = false;
    this._clear();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private _apply(): void {
    if (this.params.dimEnabled) {
      this._addOverlay(
        this.params.dimColor,
        this.params.dimAlpha,
        0,
        Phaser.BlendModes.NORMAL,
      );
    }
    if (this.params.splitEnabled) {
      this._addOverlay(
        this.params.splitColorCyan,
        this.params.splitAlpha,
        -this.params.splitOffset,
        Phaser.BlendModes.ADD,
      );
      this._addOverlay(
        this.params.splitColorRed,
        this.params.splitAlpha,
        this.params.splitOffset,
        Phaser.BlendModes.ADD,
      );
    }
    if (this.params.shakeEnabled) {
      this._shake();
    }
  }

  private _clear(): void {
    for (const overlay of this.overlays) {
      if (this.registry) {
        const index = this.registry.indexOf(overlay);
        if (index >= 0) this.registry.splice(index, 1);
      }
      overlay.destroy();
    }
    this.overlays = [];
  }

  private _addOverlay(
    color: number,
    alpha: number,
    offsetX: number,
    blendMode: Phaser.BlendModes,
  ): Phaser.GameObjects.Rectangle | null {
    const add = this.scene?.add as
      | { rectangle?: (...args: unknown[]) => Phaser.GameObjects.Rectangle }
      | undefined;
    if (!add || typeof add.rectangle !== 'function') return null;

    const width = this.scene.scale?.width ?? 0;
    const height = this.scene.scale?.height ?? 0;
    const overlay = add.rectangle(
      width / 2 + offsetX,
      height / 2,
      width,
      height,
      color,
      alpha,
    );
    overlay.setDepth(this.params.overlayDepth);
    overlay.setScrollFactor(0);
    overlay.setBlendMode(blendMode);
    overlay.setData('juiceLayer', 'phaseShift');
    this.registry?.push(overlay);
    this.overlays.push(overlay);
    return overlay;
  }

  private _shake(): void {
    const camera = this.scene?.cameras?.main;
    if (!camera || typeof camera.shake !== 'function') return;
    camera.shake(this.params.shakeDurationMs, this.params.shakeIntensity);
  }
}

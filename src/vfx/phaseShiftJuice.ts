/**
 * Phase Shift juice — screen-wide phase treatment (parent AH-0MUIYX1EE008FVS8).
 *
 * Phase Shift is now automatic, so the player needs an unmistakable,
 * screen-wide read that it fired. Per producer answer Q4 this module owns the
 * single shared treatment (upgraded in AH-0MVD2MXAB004K0V4, and made
 * unmistakable in AH-0MVNTXWJP004DBCW):
 *
 *   - a subtle **desaturation/dim** overlay,
 *   - a **chromatic split-tint** (two colour-offset ADD overlays that fringe
 *     everything on screen — enemies, bullets and minerals alike),
 *   - an **activation burst** — a short, sharp, wider chromatic-surge pair
 *     that fades out over ~200 ms on the frame the phase activates, so the
 *     automatic trigger visibly "fires" (glitch hit),
 *   - a **full-screen phase flash** on the rising edge (a phase-shift
 *     palette, never the player-death flash colour), decaying to zero over
 *     `PHASE_SHIFT_FLASH_DURATION_MS` of deterministic dt ticks,
 *   - a **cyan edge/vignette band layer** while phased (the defeat-screen
 *     vignette technique, `src/vfx/endOfRunJuice.ts`), gently pulsing, and
 *   - a **continuous shimmer** while phased — the split alpha raised to
 *     0.45 with a wider 14 px offset that oscillates, a gentle ≈2–4 Hz alpha
 *     flicker and a soft colour-pulse between the cyan/red hues.
 *
 * **Unmistakable treatment** (parent AH-0MVNTR89P0022JIU, approach C /
 * producer answer Q2-iii): the **activation edge** is aggressively
 * structural — a widened/stronger chromatic-surge pair plus the full-screen
 * flash plus the camera distortion burst from `cameraFilters.ts`, all in the
 * same frame. The **sustained state** stays soft: the pulsing split, the
 * cyan vignette bands and the gentle sustained camera filter, with no camera
 * shake anywhere. A filter driver is injected via {@link PhaseShiftJuiceOptions.filters}
 * when tests want a recording stub; otherwise the module creates its own
 * guarded driver (`createPhaseFilterDriver(scene)`), so the shipped game
 * applies the real camera filters while headless/canvas scenes degrade to
 * overlay-only layers without throwing.
 *
 * Deliberately **no camera shake**: a producer review rejected the first cut
 * of this feature because the shake made Phase Shift read like the
 * player-death juice (`playerDeathJuice.ts`). Dropping the shake keeps the two
 * events visually distinct while the structural layers sell the phase shift.
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
 *     expires, leaving no residual tint.
 *
 * @module vfx/phaseShiftJuice
 */

import Phaser from 'phaser';

import { createPhaseFilterDriver } from './cameraFilters';
import type { PhaseFilterDriver } from './cameraFilters';
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

/** Peak alpha of each chromatic split overlay (raised from 0.10 for the
 * vivid/pulsing upgrade — AH-0MVD2MXAB004K0V4 — and again to 0.45 for the
 * unmistakable treatment — AH-0MVNTXWJP004DBCW). */
export const PHASE_SHIFT_SPLIT_ALPHA = 0.45;

/** Base horizontal offset (px) of the chromatic split overlays (raised from
 * 3 px via 6 px to 14 px; oscillates around this value for the shimmer). The
 * wide split is what makes the phased state unmistakable against a busy
 * bullet-hell background. */
export const PHASE_SHIFT_SPLIT_OFFSET = 14;

/** Slow oscillation period (seconds) of the split offset — the split
 * "breathes" rather than sitting static. */
export const PHASE_SHIFT_OSCILLATION_PERIOD = 1.6;

/** Amplitude (px) of the split-offset oscillation around
 * {@link PHASE_SHIFT_SPLIT_OFFSET}. */
export const PHASE_SHIFT_OSCILLATION_AMPLITUDE = 1.5;

/** Alpha-flicker rate (Hz) of the continuous shimmer — a gentle 2–4 Hz
 * pulse, never a rapid strobe (seizure-safety note in the work item). */
export const PHASE_SHIFT_FLICKER_HZ = 3;

/** Fraction by which the split alpha dips at the flicker trough. */
export const PHASE_SHIFT_FLICKER_DEPTH = 0.25;

/** Activation-burst lifetime in milliseconds (~150–250 ms reads as a glitch
 * hit without dragging into death-juice territory). */
export const PHASE_SHIFT_BURST_DURATION_MS = 200;

/** Peak alpha of each activation-burst overlay (strengthened from 0.35 for
 * the unmistakable activation edge). */
export const PHASE_SHIFT_BURST_ALPHA = 0.7;

/** Horizontal offset (px) of the activation-burst overlays — sharper/wider
 * than the sustained split so the burst reads as a distinct hit (widened
 * from 12 px to 26 px for the unmistakable treatment). */
export const PHASE_SHIFT_BURST_OFFSET = 26;

/** Soft colour-pulse range (min→max multiplier) applied to the two split
 * hues over the oscillation cycle. */
export const PHASE_SHIFT_COLOUR_PULSE_RANGE: readonly [number, number] = [0.75, 1] as const;

/** Whether the activation-burst layer is enabled. */
export const PHASE_SHIFT_ENABLE_BURST = true;

/** Whether the continuous shimmer layers (flicker + colour pulse) are
 * enabled. */
export const PHASE_SHIFT_ENABLE_SHIMMER = true;

/** Whether the desaturation/dim layer is enabled. */
export const PHASE_SHIFT_ENABLE_DIM = true;

/** Whether the chromatic split-tint layer is enabled. */
export const PHASE_SHIFT_ENABLE_SPLIT = true;

// ── Unmistakable activation edge (AH-0MVNTXWJP004DBCW) ──────────────

/**
 * Full-screen phase-flash colour — a bright soft-cyan in the phase-shift
 * palette, deliberately **not** the player-death flash colour
 * (`PLAYER_DEATH_FLASH_COLOR` = ship cyan 0x00ffff), so the Phase Shift
 * event can never read as death juice.
 */
export const PHASE_SHIFT_FLASH_COLOR = 0xa8f0ff;

/** Peak alpha of the full-screen activation flash. */
export const PHASE_SHIFT_FLASH_ALPHA = 0.5;

/** Lifetime of the full-screen activation flash (ms). The flash decays
 * linearly over this window, driven by deterministic dt ticks (not a tween,
 * so headless tests stay deterministic). */
export const PHASE_SHIFT_FLASH_DURATION_MS = 180;

/** Whether the full-screen activation flash layer is enabled. */
export const PHASE_SHIFT_ENABLE_FLASH = true;

/** Colour of the cyan edge/vignette band layer (distinct from the death
 * palette; a deeper cyan than the split so the frame edge reads as a
 * dedicated band). */
export const PHASE_SHIFT_VIGNETTE_COLOR = 0x29d8ff;

/** Peak alpha of the cyan edge/vignette band layer. */
export const PHASE_SHIFT_VIGNETTE_ALPHA = 0.55;

/** Number of vignette bands stroked inward from the screen edge. */
export const PHASE_SHIFT_VIGNETTE_BANDS = 6;

/** Width (px) of each vignette band. */
export const PHASE_SHIFT_VIGNETTE_BAND_WIDTH = 14;

/** Whether the cyan edge/vignette band layer is enabled. */
export const PHASE_SHIFT_ENABLE_VIGNETTE = true;

/**
 * Whether the camera-filter distortion burst (pixelate + barrel, from
 * `cameraFilters.ts`) fires on the activation edge. Gated independently so
 * a build without WebGL filters degrades to overlay-only layers without
 * code surgery.
 */
export const PHASE_SHIFT_ENABLE_DISTORTION = true;

/**
 * Whether the gentle sustained camera filter layer (`cameraFilters.ts`) is
 * applied while phased. Only meaningful when the renderer supports camera
 * filters (WebGL); otherwise the driver is a no-op.
 */
export const PHASE_SHIFT_ENABLE_SUSTAINED_FILTER = true;

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
  /** Slow oscillation period (s) of the pulsing split. */
  oscillationPeriod: number;
  /** Amplitude (px) of the split-offset oscillation. */
  oscillationAmplitude: number;
  /** Subtle alpha-flicker rate (Hz), ≈2–4. */
  flickerHz: number;
  /** Fraction the split alpha dips at the flicker trough. */
  flickerDepth: number;
  /** Activation-burst lifetime (ms), ≈150–250. */
  burstDurationMs: number;
  /** Activation-burst peak alpha. */
  burstAlpha: number;
  /** Horizontal offset (px) of the activation-burst overlays. */
  burstOffset: number;
  /** Soft colour-pulse range [min, max] between the two split hues. */
  colourPulseRange: readonly [number, number];
  /** Whether the activation-burst layer set is enabled. */
  burstEnabled: boolean;
  /** Whether the continuous shimmer layers are enabled. */
  shimmerEnabled: boolean;
  /** Full-screen phase-flash colour (hex). */
  flashColor: number;
  /** Peak alpha of the full-screen activation flash. */
  flashAlpha: number;
  /** Lifetime of the activation flash (ms). */
  flashDurationMs: number;
  /** Whether the full-screen flash layer is enabled. */
  flashEnabled: boolean;
  /** Cyan edge/vignette band colour (hex). */
  vignetteColor: number;
  /** Peak alpha of the cyan edge/vignette band layer. */
  vignetteAlpha: number;
  /** Number of vignette bands stroked inward from the screen edge. */
  vignetteBands: number;
  /** Width (px) of each vignette band. */
  vignetteBandWidth: number;
  /** Whether the cyan edge/vignette band layer is enabled. */
  vignetteEnabled: boolean;
  /** Whether the camera-filter distortion burst fires on activation. */
  distortionEnabled: boolean;
  /** Whether the gentle sustained camera filter applies while phased. */
  sustainedFilterEnabled: boolean;
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
    oscillationPeriod: PHASE_SHIFT_OSCILLATION_PERIOD,
    oscillationAmplitude: PHASE_SHIFT_OSCILLATION_AMPLITUDE,
    flickerHz: PHASE_SHIFT_FLICKER_HZ,
    flickerDepth: PHASE_SHIFT_FLICKER_DEPTH,
    burstDurationMs: PHASE_SHIFT_BURST_DURATION_MS,
    burstAlpha: PHASE_SHIFT_BURST_ALPHA,
    burstOffset: PHASE_SHIFT_BURST_OFFSET,
    colourPulseRange: PHASE_SHIFT_COLOUR_PULSE_RANGE,
    burstEnabled: PHASE_SHIFT_ENABLE_BURST,
    shimmerEnabled: PHASE_SHIFT_ENABLE_SHIMMER,
    // Unmistakable treatment layers (AH-0MVNTXWJP004DBCW).
    flashColor: PHASE_SHIFT_FLASH_COLOR,
    flashAlpha: PHASE_SHIFT_FLASH_ALPHA,
    flashDurationMs: PHASE_SHIFT_FLASH_DURATION_MS,
    flashEnabled: PHASE_SHIFT_ENABLE_FLASH,
    vignetteColor: PHASE_SHIFT_VIGNETTE_COLOR,
    vignetteAlpha: PHASE_SHIFT_VIGNETTE_ALPHA,
    vignetteBands: PHASE_SHIFT_VIGNETTE_BANDS,
    vignetteBandWidth: PHASE_SHIFT_VIGNETTE_BAND_WIDTH,
    vignetteEnabled: PHASE_SHIFT_ENABLE_VIGNETTE,
    distortionEnabled: PHASE_SHIFT_ENABLE_DISTORTION,
    sustainedFilterEnabled: PHASE_SHIFT_ENABLE_SUSTAINED_FILTER,
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
  /**
   * Camera-filter driver for the distortion burst / sustained filter layers.
   * Defaults to {@link createPhaseFilterDriver} on the scene, so the shipped
   * game applies the filters automatically while headless or non-WebGL
   * scenes degrade to overlay-only layers. Inject a recording stub in tests.
   */
  filters?: PhaseFilterDriver;
}

/**
 * Owns the screen-wide Phase Shift treatment for one scene.
 *
 * `update(active, dt)` is edge-triggered: when `active` rises, the overlays
 * are created (and the camera distortion burst + sustained filter applied
 * through the driver); while `active` stays true nothing is re-created and
 * the shimmer / flash decay / filter ticks advance; when `active` falls,
 * every overlay is destroyed, removed from the registry and the driver is
 * cleared — no residual tint or filter state. `destroy()` is an
 * unconditional teardown for scene shutdown.
 *
 * The controller is a safe no-op when the scene has no `add`/`scale`/`cameras`
 * facilities (headless stubs) and never throws.
 */
export class PhaseShiftJuice {
  private readonly scene: Phaser.Scene;
  private readonly params: PhaseShiftJuiceParams;
  private readonly registry: JuiceRegistry | undefined;
  private readonly filters: PhaseFilterDriver;
  private overlays: (Phaser.GameObjects.Rectangle | Phaser.GameObjects.Graphics)[] = [];
  private active = false;
  /** Cyan split overlay (pulsing while shimmer is enabled). */
  private splitCyan: Phaser.GameObjects.Rectangle | null = null;
  /** Red split overlay (pulsing while shimmer is enabled). */
  private splitRed: Phaser.GameObjects.Rectangle | null = null;
  /** Full-screen activation flash overlay (decaying while active). */
  private flash: Phaser.GameObjects.Rectangle | null = null;
  /** Millis of flash lifetime remaining (drives the linear decay). */
  private flashRemainingMs = 0;
  /** Cyan edge/vignette band Graphics (pulsing while shimmer is enabled). */
  private vignette: Phaser.GameObjects.Graphics | null = null;
  /** Seconds elapsed since the current phase episode began (shimmer clock). */
  private elapsed = 0;

  constructor(scene: Phaser.Scene, options: PhaseShiftJuiceOptions = {}) {
    this.scene = scene;
    this.params = options.params ?? resolvePhaseShiftJuiceParams();
    this.registry = options.registry;
    this.filters = options.filters ?? createPhaseFilterDriver(scene);
  }

  /** Whether the treatment is currently applied. */
  get isActive(): boolean {
    return this.active;
  }

  /** The live overlay display objects (empty when inactive). */
  get activeOverlays(): readonly (
    | Phaser.GameObjects.Rectangle
    | Phaser.GameObjects.Graphics
  )[] {
    return this.overlays;
  }

  /**
   * Advances the treatment for the current frame.
   *
   * @param active — whether Phase Shift is currently active.
   * @param dt — frame delta (seconds); drives the flash decay, the sustained
   *   shimmer and the filter-driver ticks while the phase stays active.
   * @returns whether the treatment is applied after this call.
   */
  update(active: boolean, dt = 0): boolean {
    if (active && !this.active) {
      this.active = true;
      this.elapsed = 0;
      this._apply();
    } else if (!active && this.active) {
      this.active = false;
      this._clear();
    }
    if (this.active && dt > 0) {
      this.elapsed += dt;
      this._pulseShimmer();
      this._decayFlash(dt);
      if (this.params.sustainedFilterEnabled) {
        this.filters?.update(dt);
      }
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
      this.splitCyan = this._addOverlay(
        this.params.splitColorCyan,
        this.params.splitAlpha,
        -this.params.splitOffset,
        Phaser.BlendModes.ADD,
      );
      this.splitRed = this._addOverlay(
        this.params.splitColorRed,
        this.params.splitAlpha,
        this.params.splitOffset,
        Phaser.BlendModes.ADD,
      );
      // Activation burst: a short, sharp, wider chromatic-surge pair that
      // fades out over ~burstDurationMs. It reuses the split identity (never
      // the player-death palette) and involves no camera shake, so it reads
      // as a glitch hit rather than death juice. Gated by the split layer:
      // with the split disabled the surge would have nothing to surge.
      if (this.params.burstEnabled) {
        this._fadeOutBurst(
          this._addOverlay(
            this.params.splitColorCyan,
            this.params.burstAlpha,
            -this.params.burstOffset,
            Phaser.BlendModes.ADD,
          ),
        );
        this._fadeOutBurst(
          this._addOverlay(
            this.params.splitColorRed,
            this.params.burstAlpha,
            this.params.burstOffset,
            Phaser.BlendModes.ADD,
          ),
        );
      }
    }
    // Unmistakable activation edge: a full-screen phase flash plus a cyan
    // edge/vignette frame, and the camera distortion burst + sustained
    // filter layers through the injected (or auto-created) filter driver.
    if (this.params.flashEnabled) {
      this.flash = this._addOverlay(
        this.params.flashColor,
        this.params.flashAlpha,
        0,
        Phaser.BlendModes.NORMAL,
      );
      this.flashRemainingMs = this.params.flashDurationMs;
    }
    if (this.params.vignetteEnabled) {
      this.vignette = this._drawVignette();
    }
    if (this.params.distortionEnabled) {
      this.filters?.applyBurst();
    }
    if (this.params.sustainedFilterEnabled) {
      this.filters?.applySustained();
    }
  }

  /**
   * Continuous shimmer: the chromatic split "breathes" and the cyan vignette
   * bands pulse with the same clock. The two split hues pulse out of phase
   * (soft colour-pulse), the split alpha flickers at ≈2–4 Hz and the offset
   * oscillates around its base. Purely arithmetic object reuse — no
   * per-frame allocations, no render-to-texture, no shaders
   * (performance-neutral by design).
   */
  private _pulseShimmer(): void {
    const p = this.params;
    const t = this.elapsed;
    const slowPhase = (Math.PI * 2 * t) / p.oscillationPeriod;
    const breathe = 0.5 + 0.5 * Math.sin(slowPhase);
    if (p.shimmerEnabled && p.splitEnabled && this.splitCyan && this.splitRed) {
      const [pulseMin, pulseMax] = p.colourPulseRange;
      const cyanMult = pulseMin + (pulseMax - pulseMin) * (1 - breathe);
      const redMult = pulseMin + (pulseMax - pulseMin) * breathe;
      const flicker = 1 - p.flickerDepth * (0.5 + 0.5 * Math.sin(Math.PI * 2 * p.flickerHz * t));
      const offsetNow = p.splitOffset + p.oscillationAmplitude * Math.sin(slowPhase);
      const width = this.scene?.scale?.width ?? 0;
      const height = this.scene?.scale?.height ?? 0;
      this.splitCyan.setPosition(width / 2 - offsetNow, height / 2);
      this.splitCyan.setAlpha(p.splitAlpha * cyanMult * flicker);
      this.splitRed.setPosition(width / 2 + offsetNow, height / 2);
      this.splitRed.setAlpha(p.splitAlpha * redMult * flicker);
    }
    // The cyan edge/vignette bands pulse gently with the same clock, so the
    // *frame* stays alive throughout the phase without any camera shake.
    if (p.shimmerEnabled && this.vignette) {
      const vignettePulse = 0.9 + 0.1 * breathe;
      this.vignette.setAlpha(p.vignetteAlpha * vignettePulse);
    }
  }

  /**
   * Decays the activation flash linearly to zero over `flashDurationMs`,
   * driven by deterministic dt ticks (headless-safe).
   */
  private _decayFlash(dt: number): void {
    if (!this.flash) return;
    this.flashRemainingMs = Math.max(0, this.flashRemainingMs - dt * 1000);
    const progress = this.flashRemainingMs / this.params.flashDurationMs;
    this.flash.setAlpha(this.params.flashAlpha * progress);
  }

  /** Fades a burst overlay to zero over the burst duration (headless-safe). */
  private _fadeOutBurst(overlay: Phaser.GameObjects.Rectangle | null): void {
    if (!overlay) return;
    const tweens = this.scene?.tweens as
      | { add?: (...args: unknown[]) => unknown }
      | undefined;
    if (!tweens || typeof tweens.add !== 'function') return;
    tweens.add({
      targets: overlay,
      alpha: 0,
      duration: this.params.burstDurationMs,
      ease: 'Quad.easeOut',
    });
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
    this.splitCyan = null;
    this.splitRed = null;
    this.flash = null;
    this.flashRemainingMs = 0;
    this.vignette = null;
    this.elapsed = 0;
    // Exact teardown: the driver's clear() removes exactly the controllers
    // this juice owns, leaving any pre-existing camera filter untouched.
    this.filters?.clear();
  }

  /**
   * Draws the cyan edge/vignette band layer: a single Graphics stroking
   * {@link PHASE_SHIFT_VIGNETTE_BANDS} rectangles inward from the screen
   * edge, the outermost brightest (the defeat-screen vignette technique).
   * Headless-safe (returns `null` when the scene cannot create Graphics).
   */
  private _drawVignette(): Phaser.GameObjects.Graphics | null {
    const sceneAdd = this.scene?.add as
      | { graphics?: (...args: unknown[]) => Phaser.GameObjects.Graphics }
      | undefined;
    if (!sceneAdd || typeof sceneAdd.graphics !== 'function') return null;

    const width = this.scene.scale?.width ?? 0;
    const height = this.scene.scale?.height ?? 0;
    const vignette = sceneAdd.graphics.call(this.scene.add, { x: 0, y: 0 });
    vignette.setDepth(this.params.overlayDepth);
    vignette.setScrollFactor(0);
    vignette.setData('juiceLayer', 'phaseShift');
    vignette.setAlpha(this.params.vignetteAlpha);

    for (let i = 0; i < this.params.vignetteBands; i += 1) {
      const inset = i * this.params.vignetteBandWidth;
      const alpha = this.params.vignetteAlpha * (1 - i / this.params.vignetteBands);
      vignette.lineStyle(this.params.vignetteBandWidth, this.params.vignetteColor, alpha);
      vignette.strokeRect(
        inset,
        inset,
        Math.max(0, width - inset * 2),
        Math.max(0, height - inset * 2),
      );
    }

    this.registry?.push(vignette);
    this.overlays.push(vignette);
    return vignette;
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
    if (!overlay) return null;
    overlay.setDepth(this.params.overlayDepth);
    overlay.setScrollFactor(0);
    overlay.setBlendMode(blendMode);
    overlay.setData('juiceLayer', 'phaseShift');
    this.registry?.push(overlay);
    this.overlays.push(overlay);
    return overlay;
  }
}

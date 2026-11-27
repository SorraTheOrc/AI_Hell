/**
 * Wormhole-style teleport tunnel VFX (parent AH-0MWW50H0B002U6XU, slice
 * AH-0MWWDJ3Q1000CAE3).
 *
 * The unmistakable hyperspace transit that plays when the player teleports:
 * a wormhole tunnel grows from the ship's start position toward the resolved
 * destination, the ship travels the tunnel at normal speed, then the tunnel
 * collapses. The three ordered phases are driven by an explicit `update(dt)`
 * tick, never by wall-clock tweens.
 *
 * ## Three layers, each independently switchable
 *
 * 1. **Swirl** ({@link TELEPORT_TUNNEL_ENABLE_SWIRL}) — helical vortex lines
 *    that sell the tunnel as a coherent corridor; seeded per teleport and
 *    drawn with Phaser `Graphics`.
 * 2. **Ribs** ({@link TELEPORT_TUNNEL_ENABLE_RIBS}) — cross-section arcs spaced
 *    along the tunnel length to sell the wormhole volume.
 * 3. **Glow** ({@link TELEPORT_TUNNEL_ENABLE_GLOW}) — a soft radial gradient
 *    at the tunnel entrance that fades as the ship departs.
 *
 * Every toggle defaults from an exported `TELEPORT_TUNNEL_ENABLE_*` constant
 * (the `ENDOFRUN_ENABLE_*` house pattern) and can be overridden per call.
 *
 * ## Phases
 *
 * 1. **Grow** (`TELEPORT_TUNNEL_GROW_PHASE_SECONDS` ≈ 0.75 s) — the tunnel
 *    grows from zero length to its full destination length. World runs at
 *    ¼ speed; the ship is not steerable.
 * 2. **Transit** (`TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS` ≈ 0.4 s) — the tunnel
 *    holds full length; the ship travels at normal speed.
 * 3. **Collapse** (`TELEPORT_TUNNEL_COLLAPSE_PHASE_SECONDS` ≈ 0.25 s) — the
 *    tunnel collapses (geometry fades and contracts to zero). World returns
 *    to 1× speed.
 *
 * ## Determinism
 *
 * There is no `Math.random()` anywhere: {@link planTeleportTunnel} seeds a
 * {@link createSeededRng} generator with a caller-supplied seed, so the same
 * seed always produces the same tunnel geometry. Animation is driven by an
 * explicit `update(dt)` tick, so a test can advance exactly the total duration
 * and assert completion.
 *
 * ## Bounded and disposable
 *
 * One {@link Phaser.GameObjects.Container} holds every display object, the swirl
 * count is capped at {@link TELEPORT_TUNNEL_MAX_SWIRLS}, and both completion and
 * {@link TeleportTunnel.destroy} tear the container down exactly once.
 *
 * ## Depth
 *
 * The container sits at {@link TELEPORT_TUNNEL_DEPTH} — above the gameplay
 * baseline and enemies, so the tunnel reads as a transit overlay the ship
 * moves through while staying below the death flash and phase-shift juice
 * layers (−10).
 *
 * @module vfx/teleportTunnel
 */

import Phaser from 'phaser';

import {
  TELEPORT_TUNNEL_COLLAPSE_START_SECONDS,
  TELEPORT_TUNNEL_DEPTH,
  TELEPORT_TUNNEL_DURATION_SECONDS,
  TELEPORT_TUNNEL_ENABLE_GLOW,
  TELEPORT_TUNNEL_ENABLE_RIBS,
  TELEPORT_TUNNEL_ENABLE_SWIRL,
  TELEPORT_TUNNEL_GLOW_ALPHA,
  TELEPORT_TUNNEL_GLOW_COLOR,
  TELEPORT_TUNNEL_GROW_PHASE_SECONDS,
  TELEPORT_TUNNEL_GROW_START_SECONDS,
  TELEPORT_TUNNEL_MAX_SWIRLS,
  TELEPORT_TUNNEL_RADIUS,
  TELEPORT_TUNNEL_RIB_ALPHA_GROW,
  TELEPORT_TUNNEL_RIB_COLOR,
  TELEPORT_TUNNEL_RIB_COUNT,
  TELEPORT_TUNNEL_SWIRL_ALPHA_GROW,
  TELEPORT_TUNNEL_SWIRL_COLOR,
  TELEPORT_TUNNEL_SWIRL_COUNT,
  TELEPORT_TUNNEL_SWIRL_MAX_WIDTH,
  TELEPORT_TUNNEL_SWIRL_MIN_WIDTH,
  TELEPORT_TUNNEL_SWIRL_WAVES,
  TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS,
  TELEPORT_TUNNEL_TRANSIT_START_SECONDS,
} from '../core/constants';
import { createSeededRng } from '../core/rng';

// ── Timeline constants (re-exported for consumers) ──────────────────

/**
 * Length of the grow phase (seconds), re-exported so a scene consuming the
 * tunnel handle never has to reach into `constants.ts` for the timeline.
 */
export const TELEPORT_TUNNEL_GROW_DURATION = TELEPORT_TUNNEL_GROW_PHASE_SECONDS;

/** Length of the transit phase (seconds), re-exported for consumers. */
export const TELEPORT_TUNNEL_TRANSIT_DURATION = TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS;

/** Length of the collapse phase (seconds), re-exported for consumers. */
export const TELEPORT_TUNNEL_COLLAPSE_DURATION =
  TELEPORT_TUNNEL_DURATION_SECONDS -
  TELEPORT_TUNNEL_GROW_PHASE_SECONDS -
  TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS;

/** Total tunnel duration (seconds), re-exported for consumers. */
export const TELEPORT_TUNNEL_DURATION = TELEPORT_TUNNEL_DURATION_SECONDS;

// ── Phase model ─────────────────────────────────────────────────────

/** One of the tunnel's three ordered, non-overlapping phases (or `'complete'`). */
export type TeleportTunnelPhase = 'grow' | 'transit' | 'collapse' | 'complete';

/**
 * Resolves which phase a given elapsed time falls in.
 *
 * Phase boundaries belong to the phase that starts at them, so
 * `teleportTunnelPhaseAt(TELEPORT_TUNNEL_TRANSIT_START_SECONDS)` is `'transit'`
 * and `teleportTunnelPhaseAt(TELEPORT_TUNNEL_DURATION_SECONDS)` is
 * `'complete'`. Negative and `NaN` inputs resolve to `'grow'` (a not-yet-started
 * tunnel), never throwing.
 *
 * @param elapsedSeconds - Seconds advanced since the tunnel started.
 */
export function teleportTunnelPhaseAt(
  elapsedSeconds: number,
): TeleportTunnelPhase {
  // `>=` boundaries belong to the phase that starts at them; the negated
  // form keeps `NaN`/negative input in 'grow' without throwing.
  if (!(elapsedSeconds >= TELEPORT_TUNNEL_TRANSIT_START_SECONDS)) {
    return 'grow';
  }
  if (elapsedSeconds < TELEPORT_TUNNEL_COLLAPSE_START_SECONDS) {
    return 'transit';
  }
  if (elapsedSeconds < TELEPORT_TUNNEL_DURATION_SECONDS) {
    return 'collapse';
  }
  return 'complete';
}

// ── Plan (pure, deterministic) ──────────────────────────────────────

/** One helical swirl line in a {@link TeleportTunnelPlan}. */
export interface TeleportTunnelSwirl {
  /** Helical phase offset around the tunnel axis, radians in `[0, 2π)`. */
  readonly phase: number;
  /** Radial offset as a fraction of the tunnel radius, in `[0, 1]`. */
  readonly radialOffset: number;
  /** Stroke width, px in `[MIN_WIDTH, MAX_WIDTH]`. */
  readonly width: number;
}

/**
 * The complete, deterministic parameter set for one teleport tunnel.
 *
 * Two calls with the same `seed` return byte-identical plans, so a recorded
 * demo, a repeat test run and a captured video all look the same
 * (determinism contract, slice AC4).
 */
export interface TeleportTunnelPlan {
  /** The seed the plan's geometry was drawn from. */
  readonly seed: number;
  /** Tunnel entrance (the ship's start position), world px. */
  readonly startX: number;
  readonly startY: number;
  /** Tunnel exit (the resolved destination), world px. */
  readonly endX: number;
  readonly endY: number;
  /** Full tunnel length, px (the distance from start to destination). */
  readonly length: number;
  /** Tunnel heading, radians (the angle from start to destination). */
  readonly angle: number;
  /** Cross-section radius, px. */
  readonly radius: number;
  /** Total duration, seconds ({@link TELEPORT_TUNNEL_DURATION_SECONDS}). */
  readonly durationSeconds: number;
  /** Bounded swirl geometry, `≤ TELEPORT_TUNNEL_MAX_SWIRLS` entries. */
  readonly swirls: readonly TeleportTunnelSwirl[];
  /** Number of cross-section rib arcs. */
  readonly ribCount: number;
}

/** Derives a deterministic seed from the endpoint pair (order matters). */
function tunnelSeed(startX: number, startY: number, endX: number, endY: number): number {
  // Quantise to whole px so sub-pixel jitter does not change the geometry.
  const ax = Math.round(startX) | 0;
  const ay = Math.round(startY) | 0;
  const bx = Math.round(endX) | 0;
  const by = Math.round(endY) | 0;
  return (
    (Math.imul(ax, 73856093) ^
      Math.imul(ay, 19349663) ^
      Math.imul(bx, 83492791) ^
      Math.imul(by, 2654435761)) >>>
    0
  );
}

/**
 * Builds the deterministic layer parameters for a teleport tunnel from the
 * ship's start position to the resolved destination.
 *
 * Pure and total: no `Math.random()`, no wall-clock time. The endpoints only
 * seed the deterministic swirl geometry; the length and heading are derived
 * directly from them so the tunnel always spans the real jump.
 *
 * @param startX - Ship start X, world px.
 * @param startY - Ship start Y, world px.
 * @param endX - Resolved destination X, world px.
 * @param endY - Resolved destination Y, world px.
 */
export function planTeleportTunnel(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): TeleportTunnelPlan {
  const seed = tunnelSeed(startX, startY, endX, endY);
  const rng = createSeededRng(seed);
  const dx = endX - startX;
  const dy = endY - startY;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  // Never exceed the cap, whatever the tuning constant says.
  const swirlCount = Math.min(TELEPORT_TUNNEL_SWIRL_COUNT, TELEPORT_TUNNEL_MAX_SWIRLS);
  const swirls: TeleportTunnelSwirl[] = [];
  for (let i = 0; i < swirlCount; i++) {
    swirls.push({
      phase: rng() * Math.PI * 2,
      radialOffset: 0.35 + rng() * 0.65,
      width:
        TELEPORT_TUNNEL_SWIRL_MIN_WIDTH +
        rng() * (TELEPORT_TUNNEL_SWIRL_MAX_WIDTH - TELEPORT_TUNNEL_SWIRL_MIN_WIDTH),
    });
  }

  return {
    seed,
    startX,
    startY,
    endX,
    endY,
    length,
    angle,
    radius: TELEPORT_TUNNEL_RADIUS,
    durationSeconds: TELEPORT_TUNNEL_DURATION_SECONDS,
    swirls,
    ribCount: TELEPORT_TUNNEL_RIB_COUNT,
  };
}

// ── Layer resolution ────────────────────────────────────────────────

/** Per-call layer enable overrides (each defaults to its `TELEPORT_TUNNEL_ENABLE_*`). */
export interface TeleportTunnelLayerOverrides {
  /** Override {@link TELEPORT_TUNNEL_ENABLE_SWIRL}. */
  enableSwirl?: boolean;
  /** Override {@link TELEPORT_TUNNEL_ENABLE_RIBS}. */
  enableRibs?: boolean;
  /** Override {@link TELEPORT_TUNNEL_ENABLE_GLOW}. */
  enableGlow?: boolean;
}

/** The effective per-layer enable flags for one tunnel. */
export interface TeleportTunnelLayers {
  swirl: boolean;
  ribs: boolean;
  glow: boolean;
}

/**
 * Resolves the effective layer set: exported toggles by default, per-call
 * overrides on top. Pure and total.
 *
 * @param overrides - Optional per-layer overrides.
 */
export function resolveTeleportTunnelLayers(
  overrides: TeleportTunnelLayerOverrides = {},
): TeleportTunnelLayers {
  return {
    swirl: overrides.enableSwirl ?? TELEPORT_TUNNEL_ENABLE_SWIRL,
    ribs: overrides.enableRibs ?? TELEPORT_TUNNEL_ENABLE_RIBS,
    glow: overrides.enableGlow ?? TELEPORT_TUNNEL_ENABLE_GLOW,
  };
}

// ── Geometry helpers (pure) ─────────────────────────────────────────

/** Clamps `value` into `[0, 1]` (total: non-finite input resolves to 0). */
function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value < 1 ? value : 1;
}

/** Clamps `value` into `[0, 1]` and maps it through a smooth ease-out. */
function easeOutQuad(progress: number): number {
  const t = clamp01(progress);
  return 1 - (1 - t) * (1 - t);
}

/**
 * Visual grow progress `[0, 1]` of the tunnel **length** at `elapsedSeconds`.
 *
 * `0` at the start of grow, rises rapidly (ease-out) to `1` by the end of grow,
 * stays `1` through transit, then falls back to `0` across collapse. The tunnel
 * therefore grows to full length, holds, and retreats — exactly the three-phase
 * read (slice AC1/AC2).
 *
 * Pure and total; negative/`NaN` input resolves to `0`.
 *
 * @param elapsedSeconds - Seconds advanced since the tunnel started.
 */
export function teleportTunnelLengthProgress(elapsedSeconds: number): number {
  if (!(elapsedSeconds > 0)) return 0;
  if (elapsedSeconds < TELEPORT_TUNNEL_TRANSIT_START_SECONDS) {
    // Grow: rapid ease-out from 0 → 1 over the grow phase.
    return easeOutQuad(
      (elapsedSeconds - TELEPORT_TUNNEL_GROW_START_SECONDS) /
        TELEPORT_TUNNEL_GROW_PHASE_SECONDS,
    );
  }
  if (elapsedSeconds < TELEPORT_TUNNEL_COLLAPSE_START_SECONDS) {
    // Transit: hold full length.
    return 1;
  }
  if (elapsedSeconds < TELEPORT_TUNNEL_DURATION_SECONDS) {
    // Collapse: contract 1 → 0 across the collapse phase.
    return clamp01(
      1 -
        (elapsedSeconds - TELEPORT_TUNNEL_COLLAPSE_START_SECONDS) /
          (TELEPORT_TUNNEL_DURATION_SECONDS -
            TELEPORT_TUNNEL_COLLAPSE_START_SECONDS),
    );
  }
  return 0;
}

/**
 * Visual alpha `[0, 1]` of the tunnel at `elapsedSeconds`.
 *
 * Ramps up quickly at the start of grow, holds through grow + transit, then
 * fades to zero across collapse. `0` outside `(growStart, collapseEnd)`.
 *
 * @param elapsedSeconds - Seconds advanced since the tunnel started.
 */
export function teleportTunnelAlpha(elapsedSeconds: number): number {
  if (!(elapsedSeconds > 0)) return 0;
  if (elapsedSeconds >= TELEPORT_TUNNEL_DURATION_SECONDS) return 0;
  if (elapsedSeconds < TELEPORT_TUNNEL_TRANSIT_START_SECONDS) {
    // Fade in over the first ~20 % of grow, then hold.
    const growProgress =
      (elapsedSeconds - TELEPORT_TUNNEL_GROW_START_SECONDS) /
      TELEPORT_TUNNEL_GROW_PHASE_SECONDS;
    return clamp01(growProgress / 0.2);
  }
  if (elapsedSeconds < TELEPORT_TUNNEL_COLLAPSE_START_SECONDS) return 1;
  // Collapse: linear fade 1 → 0.
  return clamp01(
    1 -
      (elapsedSeconds - TELEPORT_TUNNEL_COLLAPSE_START_SECONDS) /
        (TELEPORT_TUNNEL_DURATION_SECONDS -
          TELEPORT_TUNNEL_COLLAPSE_START_SECONDS),
  );
}

// ── Handle ──────────────────────────────────────────────────────────

/** Options for {@link createTeleportTunnel}. */
export interface TeleportTunnelOptions extends TeleportTunnelLayerOverrides {
  /** Ship start X, world px (tunnel entrance). */
  startX: number;
  /** Ship start Y, world px (tunnel entrance). */
  startY: number;
  /** Resolved destination X, world px (tunnel exit). */
  endX: number;
  /** Resolved destination Y, world px (tunnel exit). */
  endY: number;
}

/**
 * Handle to one running tunnel — the entire lifecycle surface a scene consumes.
 */
export interface TeleportTunnel {
  /** The single container holding every tunnel display object. */
  readonly container: Phaser.GameObjects.Container;
  /** The deterministic parameter set this tunnel renders. */
  readonly plan: TeleportTunnelPlan;
  /** Seconds advanced so far (clamped to the total duration). */
  readonly elapsedSeconds: number;
  /** Current ordered phase ('grow' | 'transit' | 'collapse' | 'complete'). */
  readonly phase: TeleportTunnelPhase;
  /**
   * Current tunnel length as a fraction `[0, 1]` of the full jump length.
   * `teleportTunnelLengthProgress(elapsedSeconds)`.
   */
  readonly lengthProgress: number;
  /**
   * Advances the tunnel by `dtSeconds` (seconds). Non-positive and non-finite
   * deltas are ignored; the elapsed time clamps at the total duration, at which
   * point the effect tears itself down.
   */
  update(dtSeconds: number): void;
  /** `true` once {@link TELEPORT_TUNNEL_DURATION_SECONDS} has elapsed (never before). */
  isComplete(): boolean;
  /** Removes every display object this tunnel created; idempotent. */
  destroy(): void;
}

/** The single implementation behind {@link TeleportTunnel}. */
class TunnelEffect implements TeleportTunnel {
  private readonly containerRef: Phaser.GameObjects.Container;
  private readonly planRef: TeleportTunnelPlan;
  private readonly layers: TeleportTunnelLayers;
  private readonly swirl: Phaser.GameObjects.Graphics | null;
  private readonly ribs: Phaser.GameObjects.Graphics | null;
  private readonly glow: Phaser.GameObjects.Graphics | null;
  private elapsed = 0;
  private complete = false;
  private destroyed = false;

  constructor(scene: Phaser.Scene, options: TeleportTunnelOptions) {
    this.planRef = planTeleportTunnel(
      options.startX,
      options.startY,
      options.endX,
      options.endY,
    );
    this.layers = resolveTeleportTunnelLayers(options);

    // The whole tunnel is drawn in a local frame whose +x axis runs from the
    // entrance toward the exit, so rotation is a single container transform.
    this.containerRef = scene.add
      .container(this.planRef.startX, this.planRef.startY)
      .setDepth(TELEPORT_TUNNEL_DEPTH)
      .setRotation(this.planRef.angle);

    // Layer 3 — entrance glow (drawn first so it sits behind swirl/ribs).
    if (this.layers.glow) {
      const graphics = scene.add.graphics();
      graphics.fillStyle(TELEPORT_TUNNEL_GLOW_COLOR, TELEPORT_TUNNEL_GLOW_ALPHA);
      // Concentric filled circles fake a soft radial gradient without a shader.
      const glowRadius = this.planRef.radius * 1.4;
      for (let i = 8; i >= 1; i--) {
        graphics.fillCircle(0, 0, (glowRadius * i) / 8);
      }
      this.containerRef.add(graphics);
      this.glow = graphics;
    } else {
      this.glow = null;
    }

    // Layer 2 — cross-section rib arcs.
    if (this.layers.ribs) {
      const graphics = scene.add.graphics();
      this.containerRef.add(graphics);
      this.ribs = graphics;
    } else {
      this.ribs = null;
    }

    // Layer 1 — helical swirl lines.
    if (this.layers.swirl) {
      const graphics = scene.add.graphics();
      this.containerRef.add(graphics);
      this.swirl = graphics;
    } else {
      this.swirl = null;
    }

    this.redraw(0);
  }

  get container(): Phaser.GameObjects.Container {
    return this.containerRef;
  }

  get plan(): TeleportTunnelPlan {
    return this.planRef;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  get phase(): TeleportTunnelPhase {
    return teleportTunnelPhaseAt(this.elapsed);
  }

  get lengthProgress(): number {
    return teleportTunnelLengthProgress(this.elapsed);
  }

  update(dtSeconds: number): void {
    if (this.destroyed || this.complete) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

    this.elapsed = Math.min(
      this.elapsed + dtSeconds,
      this.planRef.durationSeconds,
    );
    this.redraw(this.elapsed);

    if (this.elapsed >= this.planRef.durationSeconds) {
      this.complete = true;
      this.teardown();
    }
  }

  isComplete(): boolean {
    return this.complete;
  }

  destroy(): void {
    this.teardown();
  }

  /** Redraws both geometry layers for `elapsed` seconds of progress. */
  private redraw(elapsed: number): void {
    if (this.destroyed || this.complete) return;
    const length = this.planRef.length * teleportTunnelLengthProgress(elapsed);
    const alpha = teleportTunnelAlpha(elapsed);
    const radius = this.planRef.radius;
    // Peak-alpha constants bake each layer's designed brightness into the
    // overall fade, so a tuned layer keeps its intended weight.
    const swirlAlpha = alpha * TELEPORT_TUNNEL_SWIRL_ALPHA_GROW;
    const ribAlpha = alpha * TELEPORT_TUNNEL_RIB_ALPHA_GROW;

    if (this.swirl !== null) {
      const graphics = this.swirl;
      graphics.clear();
      if (length > 0 && swirlAlpha > 0) {
        const waves = TELEPORT_TUNNEL_SWIRL_WAVES * Math.PI * 2;
        for (const swirl of this.planRef.swirls) {
          graphics.lineStyle(swirl.width, TELEPORT_TUNNEL_SWIRL_COLOR, swirlAlpha);
          graphics.beginPath();
          // Sample the helix as a sine wave in the local frame; the alternating
          // taper (radius shrinks with distance) fakes wormhole perspective.
          const samples = 24;
          for (let s = 0; s <= samples; s++) {
            const t = s / samples;
            const taper = 1 - 0.35 * t;
            const y =
              Math.sin(t * waves + swirl.phase) *
              radius *
              swirl.radialOffset *
              taper;
            const x = t * length;
            if (s === 0) graphics.moveTo(x, y);
            else graphics.lineTo(x, y);
          }
          graphics.strokePath();
        }
      }
    }

    if (this.ribs !== null) {
      const graphics = this.ribs;
      graphics.clear();
      if (length > 0 && ribAlpha > 0) {
        for (let i = 0; i <= this.planRef.ribCount; i++) {
          const t = i / this.planRef.ribCount;
          const taper = 1 - 0.35 * t;
          const x = t * length;
          const ribRadius = radius * taper;
          graphics.lineStyle(1.5, TELEPORT_TUNNEL_RIB_COLOR, ribAlpha);
          // A full ellipse cross-section across the tunnel axis sells the volume.
          graphics.beginPath();
          const samples = 16;
          for (let s = 0; s <= samples; s++) {
            const a = (s / samples) * Math.PI * 2;
            const px = x;
            const py = Math.sin(a) * ribRadius;
            if (s === 0) graphics.moveTo(px, py);
            else graphics.lineTo(px, py);
          }
          graphics.strokePath();
        }
      }
    }

    if (this.glow !== null) {
      // The glow is strongest at the entrance and fades as the tunnel grows and
      // then collapses, so it reads as the portal the ship opened.
      this.glow.setAlpha(alpha * TELEPORT_TUNNEL_GLOW_ALPHA);
    }
  }

  /** Destroys the container (and with it every child) exactly once. */
  private teardown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.containerRef.destroy();
  }
}

/**
 * Creates the teleport tunnel for `scene` and returns its handle.
 *
 * The caller owns the lifecycle: feed it the scene's frame delta through
 * {@link TeleportTunnel.update} (seconds). The tunnel tears itself down on
 * completion; {@link TeleportTunnel.destroy} is for an early teardown (scene
 * shutdown or an aborted teleport mid-sequence).
 *
 * Never throws and never uses `Math.random()`; the endpoints only seed the
 * deterministic swirl geometry.
 *
 * @param scene - The scene that owns the tunnel (and its display list).
 * @param options - Start/destination endpoints plus optional per-layer overrides.
 */
export function createTeleportTunnel(
  scene: Phaser.Scene,
  options: TeleportTunnelOptions,
): TeleportTunnel {
  return new TunnelEffect(scene, options);
}

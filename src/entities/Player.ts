/**
 * Player ship entity — a single Graphics object rendering the neon
 * direction-neutral hexagon hull and (while thrusting) flames on the
 * engines opposing the thrust.
 *
 * Rendering is delegated to Phaser.GameObjects.Graphics so the ship is
 * one display-list object; physics is delegated to the pure movement
 * model in `utils/movement.ts`.
 *
 * Ship tuning values (size, colours, flame, thrust, max speed) come from
 * the config module (`core/config.ts`) — either injected at construction
 * or loaded from saved config — and can be live-updated via `setConfig`.
 *
 * The engine flames are animated per port: each flame grows from length 0
 * toward its component-scaled max `shipSize × thrustFlameLength × scale`
 * at a rate proportional to `thrustAcceleration`, and decays at 4× that
 * rate when its engine stops firing. A change of the pressed keys while
 * still thrusting (e.g. turning) restarts every flame as a fresh burst
 * from length 0 so a direction change is immediately legible; releasing
 * all keys keeps the decay path so the flames shrink away naturally.
 * The animation is driven per-frame from the delta time in `preUpdate`
 * (pure model in `utils/flame.ts`), so it is framerate-independent and
 * re-targets the current config live.
 *
 * NOTE: instantiate with `scene.add.existing(player)` — like all Phaser
 * GameObjects, a Graphics built via `new` is not on the display list
 * until added to the scene.
 *
 * Per-frame updates use `preUpdate(time, delta)`: Phaser 4's UpdateList
 * invokes `preUpdate` (not `update`) on update-list members, and
 * `add.existing` only registers objects that define `preUpdate`.
 */

import Phaser from 'phaser';

import { loadShipConfig, ShipConfig } from '../core/config';

import {
  MovementInput,
  MovementState,
  MovementConfig,
  tick,
} from '../utils/movement';
import { updateFlameLength } from '../utils/flame';
import { EnginePort, enginesForThrust, selectEngines } from '../utils/engineSelection';

export interface PlayerConfig {
  x: number;
  y: number;
  /** Ship tuning values; defaults to the saved config when omitted. */
  config?: ShipConfig;
}

/**
 * The four cardinal engine ports on the hull. Positions are expressed as
 * unit offsets from the hull centre (scaled by `r = shipSize / 2` at draw
 * time); `nx`/`ny` is the port's outward normal — the direction its flame
 * shoots, which is opposite the thrust that fires it.
 * `arcStart`/`arcEnd` are the Phaser arc angles (radians, 0 = right,
 * positive = clockwise) of the small quarter-circle indicator drawn at
 * the port, centred on the outward direction.
 */
/**
 * Geometry of one cardinal engine port on the hull. Positions are
 * expressed as unit offsets from the hull centre (scaled by
 * `r = shipSize / 2` at draw time); `nx`/`ny` is the port's outward
 * normal — the direction its flame shoots, which is opposite the thrust
 * that fires it. `arcStart`/`arcEnd` are the Phaser arc angles (radians,
 * 0 = right, positive = clockwise) of the small quarter-circle indicator
 * drawn at the port, centred on the outward direction.
 */
interface EnginePortDef {
  port: EnginePort;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  arcStart: number;
  arcEnd: number;
}

const ENGINE_PORTS: ReadonlyArray<EnginePortDef> = [
  // top port — outward normal (0, -1): fires when thrusting down
  { port: 'top', dx: 0, dy: -1, nx: 0, ny: -1, arcStart: -Math.PI * 0.75, arcEnd: -Math.PI * 0.25 },
  // bottom port — outward normal (0, +1): fires when thrusting up
  { port: 'bottom', dx: 0, dy: 1, nx: 0, ny: 1, arcStart: Math.PI * 0.25, arcEnd: Math.PI * 0.75 },
  // left port — outward normal (-1, 0): fires when thrusting right
  { port: 'left', dx: -1, dy: 0, nx: -1, ny: 0, arcStart: Math.PI * 0.75, arcEnd: Math.PI * 1.25 },
  // right port — outward normal (+1, 0): fires when thrusting left
  { port: 'right', dx: 1, dy: 0, nx: 1, ny: 0, arcStart: -Math.PI * 0.25, arcEnd: Math.PI * 0.25 },
];

/**
 * The player ship renders as a cyan hexagon (flat top/bottom, centred
 * at its origin): a regular hexagon is invariant under 60° rotation,
 * so the hull never implies a heading (GDD §7.2 — geometric, angular
 * shapes; direction-neutral so thrust direction is read from the
 * engines' flames, not the silhouette).
 */
export class Player extends Phaser.GameObjects.Graphics {
  private _movementState: MovementState;
  private readonly _input: MovementInput;
  /** Animated flame length per engine port in px (0 = no flame drawn). */
  private _flameLens: Record<EnginePort, number> = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  };
  /**
   * Optional fractional thrust components (dx positive = right, dy
   * positive = down), set via {@link setThrustComponents} for
   * analog/partial input. When null, the boolean {@link _input} drives
   * engine selection (scale 1.0 per held axis).
   */
  private _componentThrust: { dx: number; dy: number } | null = null;
  private _config: MovementConfig;

  /**
   * Nominal movement config (pre-multiplier). P5 Speed Boost scales
   * thrust + max-speed about these values via {@link setSpeedMultiplier}.
   */
  private _baseConfig: MovementConfig;

  /** Current live speed multiplier (1 = normal, 1.5 = P5 boosted). */
  private _speedMultiplier = 1;

  // Visual tuning — runtime-updatable (constructor or setConfig).
  private _shipSize: number;
  private _shipColor: number;
  private _flameColor: number;
  private _flameInnerColor: number;
  private _flameLength: number;

  constructor(scene: Phaser.Scene, config: PlayerConfig) {
    super(scene, { x: config.x, y: config.y });

    this._movementState = { x: config.x, y: config.y, vx: 0, vy: 0 };
    this._input = { up: false, down: false, left: false, right: false };

    // Use the injected config, else fall back to the saved config
    // (which itself falls back to the built-in defaults).
    const ship = config.config ?? loadShipConfig();

    this._shipSize = ship.shipSize;
    this._shipColor = ship.shipColor;
    this._flameColor = ship.thrustFlameColor;
    this._flameInnerColor = ship.thrustFlameInnerColor;
    this._flameLength = ship.thrustFlameLength;
    this._baseConfig = {
      thrust: ship.thrustAcceleration,
      maxSpeed: ship.maxSpeed,
      friction: ship.frictionDeceleration,
    };
    this._config = { ...this._baseConfig };

    this._redraw();
  }

  // ── Drawing helpers ──────────────────────────────────────────────

  private _half(multiplier: number): number {
    return (this._shipSize / 2) * multiplier;
  }

  /** Redraws the whole ship (body, plus flame when one is visible). */
  private _redraw(): void {
    this.clear();
    this.lineStyle(2, this._shipColor, 1);

    // Direction-neutral hexagon with flat top/bottom, centred at the
    // origin — invariant under 60° rotation. Circumradius = shipSize / 2
    // (the same half-size the chevron used), preserving `shipSize`
    // semantics for physics-adjacent callers.
    const r = this._half(1);
    const sx = (r * Math.sqrt(3)) / 2; // r·cos(30°) — half-width
    const sy = r / 2; // r·sin(30°) — corner y-offset
    this.beginPath();
    this.moveTo(0, -r);
    this.lineTo(sx, -sy);
    this.lineTo(sx, sy);
    this.lineTo(0, r);
    this.lineTo(-sx, sy);
    this.lineTo(-sx, -sy);
    this.lineTo(0, -r); // explicit closing edge back to the top vertex
    this.closePath();
    this.strokePath();

    // Four small engine ports at the cardinal hull points (top, bottom,
    // left, right). Each is a quarter-circle arc facing outward — the
    // visual socket that engine flames originate from (AC2). Port radius
    // ≈ shipSize × 0.08 (small but visible at default shipSize=20 → ~1.6px).
    const portR = this._shipSize * 0.08;
    for (const p of ENGINE_PORTS) {
      this.arc(p.dx * r, p.dy * r, portR, p.arcStart, p.arcEnd, false);
    }

    this._drawFlame();
  }

  /**
   * Draws a flame from every engine port that is currently firing, each
   * animated length scaled by its thrust component (AC2/AC5).
   *
   * Each flame is anchored at its engine's port on the hull perimeter
   * (never the hull centre) and shoots along the port's outward normal —
   * i.e. away from the ship, opposite the thrust that fires it. Only
   * ports with a visible animated length draw anything, so no thrust
   * input means no flames at all (AC3).
   */
  private _drawFlame(): void {
    for (const port of ENGINE_PORTS) {
      const flameLen = this._flameLens[port.port];
      if (flameLen > 0) {
        this._drawPortFlame(port, flameLen);
      }
    }
  }

  /** Draws one engine's flame (outer + inner triangle) at a port. */
  private _drawPortFlame(port: EnginePortDef, flameLen: number): void {
    const r = this._half(1);
    const ox = port.dx * r;
    const oy = port.dy * r;
    const nx = port.nx;
    const ny = port.ny;

    const tipX = ox + nx * flameLen;
    const tipY = oy + ny * flameLen;

    // Perpendicular for wing spread
    const px = -ny * this._half(0.6);
    const py = nx * this._half(0.6);

    this.lineStyle(2, this._flameColor, 1);
    this.beginPath();
    this.moveTo(ox + px, oy + py);
    this.lineTo(tipX, tipY);
    this.lineTo(ox - px, oy - py);
    this.closePath();
    this.strokePath();

    // Inner flame — slightly smaller, brighter
    const innerScale = 0.6;
    const itipX = ox + nx * flameLen * innerScale;
    const itipY = oy + ny * flameLen * innerScale;
    const ipx = -ny * this._half(0.4) * innerScale;
    const ipy = nx * this._half(0.4) * innerScale;

    this.lineStyle(1, this._flameInnerColor, 1);
    this.beginPath();
    this.moveTo(ox + ipx, oy + ipy);
    this.lineTo(itipX, itipY);
    this.lineTo(ox - ipx, oy - ipy);
    this.closePath();
    this.strokePath();
  }

  // ── Input ────────────────────────────────────────────────────────

  setInput(input: MovementInput): void {
    const prev = { ...this._input };

    this._input.up = input.up;
    this._input.down = input.down;
    this._input.left = input.left;
    this._input.right = input.right;

    // Boolean keys take over from any fractional component thrust.
    this._componentThrust = null;

    // A change in the set of pressed keys restarts the thrust flames as
    // a fresh burst from length 0 — but only while the ship is still
    // thrusting afterwards (a new direction is held). Releasing all
    // keys keeps the decay path so the flames shrink away naturally.
    const keysChanged =
      prev.up !== this._input.up ||
      prev.down !== this._input.down ||
      prev.left !== this._input.left ||
      prev.right !== this._input.right;
    if (keysChanged && selectEngines(this._input).length > 0) {
      for (const port of ENGINE_PORTS) this._flameLens[port.port] = 0;
    }
  }

  getInput(): MovementInput {
    return { ...this._input };
  }

  /**
   * Feeds fractional thrust components so each flame scales by its
   * component (e.g. up 0.5 + right 1.0 → a half-length bottom flame and
   * a full-length left flame). Maps to the same engine-firing rule as
   * {@link setInput} (the engine whose outward normal opposes each
   * component fires). A subsequent {@link setInput} call takes over.
   */
  setThrustComponents(dx: number, dy: number): void {
    this._componentThrust = { dx, dy };
  }

  // ── Config ───────────────────────────────────────────────────────

  /**
   * Live-updates the ship's tuning values: physics (thrust, max speed)
   * and rendering (size, colours, flame length), re-drawing immediately.
   */
  setConfig(config: ShipConfig): void {
    this._shipSize = config.shipSize;
    this._shipColor = config.shipColor;
    this._flameColor = config.thrustFlameColor;
    this._flameInnerColor = config.thrustFlameInnerColor;
    this._flameLength = config.thrustFlameLength;
    this._baseConfig = {
      thrust: config.thrustAcceleration,
      maxSpeed: config.maxSpeed,
      friction: config.frictionDeceleration,
    };
    this._applySpeedMultiplier();

    this._redraw();
  }

  /**
   * Applies a live movement multiplier (P5 Speed Boost: +50%): thrust and
   * max-speed scale by `multiplier` about the nominal config; friction and
   * rendering are untouched. 1 = normal speed. Applied to physics only.
   */
  setSpeedMultiplier(multiplier: number): void {
    if (this._speedMultiplier === multiplier) return;
    this._speedMultiplier = multiplier;
    this._applySpeedMultiplier();
  }

  /**
   * Current effective movement config (multiplier applied). Exposed for
   * tests and the scene's magnet/speed integrations.
   */
  getMovementConfig(): MovementConfig {
    return { ...this._config };
  }

  private _applySpeedMultiplier(): void {
    this._config = {
      thrust: this._baseConfig.thrust * this._speedMultiplier,
      maxSpeed: this._baseConfig.maxSpeed * this._speedMultiplier,
      friction: this._baseConfig.friction,
    };
  }

  // ── Scene lifecycle ──────────────────────────────────────────────

  /**
   * Called by Phaser's UpdateList each frame (Phaser 4 invokes
   * `preUpdate(time, delta)` — not `update()` — for update-list
   * members; `delta` is in milliseconds). Advances each engine's flame
   * animation with the frame delta so growth/shrink is
   * framerate-independent (AC4).
   *
   * Each engine whose port opposes the current thrust grows toward its
   * component-scaled max length (`shipSize × thrustFlameLength × scale`,
   * AC5); an engine that stops firing decays at 4× the growth rate, so
   * turning leaves no flame behind at the old port.
   */
  preUpdate(_time: number, delta: number): void {
    const dt = delta / 1000;

    // Engines the current thrust fires, with their component scales
    // (fractional components when set, else the boolean keys at 1.0).
    const firing = this._componentThrust
      ? enginesForThrust(this._componentThrust.dx, this._componentThrust.dy)
      : selectEngines(this._input);
    const scales: Record<EnginePort, number> = {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    };
    for (const f of firing) scales[f.engine] = f.scale;

    let changed = false;
    const baseMax = this._shipSize * this._flameLength;
    for (const port of ENGINE_PORTS) {
      const scale = scales[port.port];
      // While firing, the flame animates toward the component-scaled max
      // (AC5); when not firing, it decays toward 0 at 4× the growth rate
      // (maxLength = baseMax so the decay rate matches a full-strength
      // flame and never stalls at maxLength 0).
      const maxLength = scale > 0 ? baseMax * scale : baseMax;
      const nextLen = updateFlameLength(
        this._flameLens[port.port],
        {
          thrusting: scale > 0,
          maxLength,
          thrustAcceleration: this._config.thrust,
        },
        dt,
      );
      if (nextLen !== this._flameLens[port.port]) changed = true;
      this._flameLens[port.port] = nextLen;
    }

    // Redraw only when the visual could have changed: an engine length
    // moved (growing or decaying). Turning at full flame changes which
    // engines fire, so the affected lengths move on the next frame.
    if (changed) {
      this._redraw();
    }
  }

  /**
   * Largest current animated flame length across all engines in px
   * (0 = no flame drawn). Kept for backward compatibility with the
   * single-flame API; prefer {@link getFlameLengths} for per-engine state.
   */
  getFlameLength(): number {
    return Math.max(...Object.values(this._flameLens));
  }

  /**
   * Current animated flame length per engine port in px (0 = no flame).
   * Exposed as observable state so tests can verify per-engine
   * animation (and per-component scaling) without pixel assertions.
   */
  getFlameLengths(): Record<EnginePort, number> {
    return { ...this._flameLens };
  }

  /** Apply a physics tick and update the transform. */
  physicsTick(dt: number, width: number, height: number): void {
    this._movementState = tick(
      this._movementState,
      this._input,
      dt,
      width,
      height,
      this._config,
    );
    this.setPosition(this._movementState.x, this._movementState.y);
  }
}
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
 * The thrust flame is animated: it grows from length 0 toward
 * `shipSize × thrustFlameLength` at a rate proportional to
 * `thrustAcceleration`, and decays at 4× that rate when thrust stops.
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
  isThrusting,
  MovementInput,
  MovementState,
  MovementConfig,
  tick,
} from '../utils/movement';
import { updateFlameLength } from '../utils/flame';
import { EnginePort, selectEngines } from '../utils/engineSelection';

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
const ENGINE_PORTS: ReadonlyArray<{
  port: EnginePort;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  arcStart: number;
  arcEnd: number;
}> = [
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
  /** Current animated flame length in px (0 = no flame drawn). */
  private _flameLen = 0;
  /** Last drawn thrust direction — redraw when it changes at full flame. */
  private _flameDir: { dx: number; dy: number } = { dx: 0, dy: 0 };
  private _config: MovementConfig;

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
    this._config = {
      thrust: ship.thrustAcceleration,
      maxSpeed: ship.maxSpeed,
      friction: ship.frictionDeceleration,
    };

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

    if (this._flameLen > 0) {
      this._drawFlame();
    }
  }

  /**
   * Draws the thrust flame from the engine port opposing the thrust.
   *
   * The flame is anchored at the firing engine's port on the hull
   * perimeter (never the hull centre) and shoots along the port's outward
   * normal — i.e. away from the ship, opposite the thrust. (Per-engine
   * flames for all firing engines, scaled by thrust component, arrive in
   * AH-0MTBOLP3Z005VRR9; this interim version draws one flame from the
   * first firing engine.)
   */
  private _drawFlame(): void {
    const firing = selectEngines(this._input);
    if (firing.length === 0) return; // no thrust → no flame
    const port = ENGINE_PORTS.find((p) => p.port === firing[0].engine);
    if (!port) return;

    // Flame origin = the port position on the hull perimeter.
    const r = this._half(1);
    const ox = port.dx * r;
    const oy = port.dy * r;
    const nx = port.nx;
    const ny = port.ny;

    // Animated length — grows toward shipSize × thrustFlameLength while
    // thrusting and decays 4× as fast when thrust stops.
    const flameLen = this._flameLen;
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
    this._input.up = input.up;
    this._input.down = input.down;
    this._input.left = input.left;
    this._input.right = input.right;
  }

  getInput(): MovementInput {
    return { ...this._input };
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
    this._config = {
      thrust: config.thrustAcceleration,
      maxSpeed: config.maxSpeed,
      friction: config.frictionDeceleration,
    };

    this._redraw();
  }

  // ── Scene lifecycle ──────────────────────────────────────────────

  /**
   * Called by Phaser's UpdateList each frame (Phaser 4 invokes
   * `preUpdate(time, delta)` — not `update()` — for update-list
   * members; `delta` is in milliseconds). Advances the flame animation
   * with the frame delta so growth/shrink is framerate-independent.
   */
  preUpdate(_time: number, delta: number): void {
    const dt = delta / 1000;
    const maxLength = this._shipSize * this._flameLength;
    const prevLen = this._flameLen;

    const nextLen = updateFlameLength(
      prevLen,
      {
        thrusting: isThrusting(this._input),
        maxLength,
        thrustAcceleration: this._config.thrust,
      },
      dt,
    );

    const dir = this._dirFromInput();
    const dirChanged =
      dir.dx !== this._flameDir.dx || dir.dy !== this._flameDir.dy;

    this._flameLen = nextLen;

    // Redraw only when the visual could have changed: the length moved
    // (growing or decaying), or the flame's direction changed while a
    // flame is visible (e.g. turning at full length).
    if (nextLen !== prevLen || (nextLen > 0 && dirChanged)) {
      this._flameDir = dir;
      this._redraw();
    }
  }

  /**
   * Current animated flame length in px (0 = no flame). Exposed as
   * observable state so tests can verify the animation without
   * pixel-level rendering assertions.
   */
  getFlameLength(): number {
    return this._flameLen;
  }

  /** Returns the thrust direction vector from current input. */
  private _dirFromInput(): { dx: number; dy: number } {
    let dx = 0, dy = 0;
    if (this._input.left)  dx -= 1;
    if (this._input.right) dx += 1;
    if (this._input.up)    dy -= 1;
    if (this._input.down)  dy += 1;
    return { dx, dy };
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
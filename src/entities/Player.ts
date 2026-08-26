/**
 * Player ship entity — a single Graphics object rendering the neon
 * chevron ship and (while thrusting) a flame on the opposite side.
 *
 * Rendering is delegated to Phaser.GameObjects.Graphics so the ship is
 * one display-list object; physics is delegated to the pure movement
 * model in `utils/movement.ts`.
 *
 * Ship tuning values (size, colours, flame, thrust, max speed) come from
 * the config module (`core/config.ts`) — either injected at construction
 * or loaded from saved config — and can be live-updated via `setConfig`.
 *
 * NOTE: instantiate with `scene.add.existing(player)` — like all Phaser
 * GameObjects, a Graphics built via `new` is not on the display list
 * until added to the scene.
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

export interface PlayerConfig {
  x: number;
  y: number;
  /** Ship tuning values; defaults to the saved config when omitted. */
  config?: ShipConfig;
}

/**
 * The player ship renders as a cyan chevron (pointing "up").
 * When thrust is applied in a direction, an orange flame appears
 * on the opposite side of the ship.
 */
export class Player extends Phaser.GameObjects.Graphics {
  private _movementState: MovementState;
  private readonly _input: MovementInput;
  private _flameVisible = false;
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
    };

    this._redraw();
  }

  // ── Drawing helpers ──────────────────────────────────────────────

  private _half(multiplier: number): number {
    return (this._shipSize / 2) * multiplier;
  }

  /** Redraws the whole ship (body, plus flame if currently thrusting). */
  private _redraw(): void {
    this.clear();
    this.lineStyle(2, this._shipColor, 1);

    // Chevron pointing up: nose at top, indent at bottom
    const half = this._half(1);
    this.beginPath();
    this.moveTo(0, -half);
    this.lineTo(half, half * 0.4);
    this.lineTo(0, half * 0.2);
    this.lineTo(-half, half * 0.4);
    this.closePath();
    this.strokePath();

    if (this._flameVisible) {
      this._drawFlame();
    }
  }

  /** Draws the thrust flame opposite to the current thrust direction. */
  private _drawFlame(): void {
    const dir = this._dirFromInput();
    const len = Math.sqrt(dir.dx * dir.dx + dir.dy * dir.dy) || 1;
    // Flame points AWAY from the thrust direction (behind the ship).
    const nx = -dir.dx / len;
    const ny = -dir.dy / len;

    const flameLen = this._shipSize * this._flameLength;
    const tipX = nx * flameLen;
    const tipY = ny * flameLen;

    // Perpendicular for wing spread
    const px = -ny * this._half(0.6);
    const py = nx * this._half(0.6);

    this.lineStyle(2, this._flameColor, 1);
    this.beginPath();
    this.moveTo(px, py);
    this.lineTo(tipX, tipY);
    this.lineTo(-px, -py);
    this.closePath();
    this.strokePath();

    // Inner flame — slightly smaller, brighter
    const innerScale = 0.6;
    const itipX = nx * flameLen * innerScale;
    const itipY = ny * flameLen * innerScale;
    const ipx = -ny * this._half(0.4) * innerScale;
    const ipy = nx * this._half(0.4) * innerScale;

    this.lineStyle(1, this._flameInnerColor, 1);
    this.beginPath();
    this.moveTo(ipx, ipy);
    this.lineTo(itipX, itipY);
    this.lineTo(-ipx, -ipy);
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
    };

    this._redraw();
  }

  // ── Scene lifecycle ──────────────────────────────────────────────

  /** Called by Phaser each frame (Player is on the scene update list). */
  update(): void {
    const thrusting = isThrusting(this._input);

    if (thrusting !== this._flameVisible) {
      this._flameVisible = thrusting;
      this._redraw();
    }
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
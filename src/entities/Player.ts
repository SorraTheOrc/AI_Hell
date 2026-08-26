/**
 * Player ship entity — neon chevron drawn on a graphics object.
 *
 * Handles visual rendering (ship + thrust flame) but delegates physics
 * to the pure movement model in `utils/movement.ts`.
 */

import Phaser from 'phaser';

import {
  SHIP_COLOR,
  SHIP_SIZE,
  THRUST_ACCELERATION,
  THRUST_FLAME_LENGTH,
  MAX_SPEED,
} from '../core/constants';

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
}

/**
 * The player ship renders as a cyan chevron (pointing "up").
 * When thrust is applied in a direction, an orange flame appears
 * on the opposite side.
 */
export class Player extends Phaser.GameObjects.Container {
  private readonly shipGraphics: Phaser.GameObjects.Graphics;
  private readonly flameGraphics: Phaser.GameObjects.Graphics;
  private _movementState: MovementState;
  private readonly _input: MovementInput;
  private _flameVisible = false;
  private readonly _config: MovementConfig;

  constructor(scene: Phaser.Scene, config: PlayerConfig) {
    super(scene, config.x, config.y);

    this._movementState = { x: config.x, y: config.y, vx: 0, vy: 0 };
    this._input = { up: false, down: false, left: false, right: false };
    this._config = { thrust: THRUST_ACCELERATION, maxSpeed: MAX_SPEED };

    // Ship body — neon cyan chevron
    this.shipGraphics = scene.add.graphics();
    this.shipGraphics.lineStyle(2, SHIP_COLOR, 1);
    this._drawShip();
    this.shipGraphics.setDepth(1);
    this.add(this.shipGraphics);

    // Thrust flame — orange/yellow triangle behind the ship
    this.flameGraphics = scene.add.graphics();
    this.flameGraphics.setDepth(0);
    this.add(this.flameGraphics);
  }

  // ── Drawing helpers ──────────────────────────────────────────────

  private _half(multiplier: number): number {
    return (SHIP_SIZE / 2) * multiplier;
  }

  // ── Drawing ──────────────────────────────────────────────────────

  private _drawShip(): void {
    this.shipGraphics.clear();
    const half = this._half(1);

    // Chevron pointing up: nose at top, indent at bottom
    this.shipGraphics.beginPath();
    this.shipGraphics.moveTo(0, -half);
    this.shipGraphics.lineTo(half, half * 0.4);
    this.shipGraphics.lineTo(0, half * 0.2);
    this.shipGraphics.lineTo(-half, half * 0.4);
    this.shipGraphics.closePath();
    this.shipGraphics.strokePath();
  }

  private _drawFlame(direction: { dx: number; dy: number }): void {
    this.flameGraphics.clear();
    const flameLen = SHIP_SIZE * THRUST_FLAME_LENGTH;

    // Normalise direction
    const len = Math.sqrt(direction.dx * direction.dx + direction.dy * direction.dy) || 1;
    const nx = -direction.dx / len;
    const ny = -direction.dy / len;

    // Points: base at ship rear, tip behind flame length
    const tipX = nx * flameLen;
    const tipY = ny * flameLen;

    // Perpendicular for wing spread
    const px = -ny * this._half(0.6);
    const py = nx * this._half(0.6);

    this.flameGraphics.beginPath();
    this.flameGraphics.moveTo(px, py);
    this.flameGraphics.lineTo(tipX, tipY);
    this.flameGraphics.lineTo(-px, -py);
    this.flameGraphics.closePath();
    this.flameGraphics.strokePath();

    // Inner flame — slightly smaller, brighter
    const innerScale = 0.6;
    const itipX = nx * flameLen * innerScale;
    const itipY = ny * flameLen * innerScale;
    const ipx = -ny * this._half(0.4) * innerScale;
    const ipy = nx * this._half(0.4) * innerScale;

    this.flameGraphics.beginPath();
    this.flameGraphics.moveTo(ipx, ipy);
    this.flameGraphics.lineTo(itipX, itipY);
    this.flameGraphics.lineTo(-ipx, -ipy);
    this.flameGraphics.closePath();
    this.flameGraphics.strokePath();
  }

  private _clearFlame(): void {
    this.flameGraphics.clear();
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

  // ── Scene lifecycle ──────────────────────────────────────────────

  update(): void {
    const thrusting = isThrusting(this._input);

    if (thrusting !== this._flameVisible) {
      this._flameVisible = thrusting;
      if (thrusting) {
        const dir = this._dirFromInput();
        this._drawFlame(dir);
      } else {
        this._clearFlame();
      }
    }
  }

  /** Returns the thrust direction vector from current input (for flame rendering). */
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
    super.setPosition(this._movementState.x, this._movementState.y);
  }

  destroy(fromScene?: boolean): void {
    this.shipGraphics.destroy();
    this.flameGraphics.destroy();
    super.destroy(fromScene);
  }
}

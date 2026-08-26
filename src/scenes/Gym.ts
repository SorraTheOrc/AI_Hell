/**
 * Gym scene — the bare-bones testbed for player movement.
 *
 * Renders exactly one entity (the player ship) with thrust-based Newtonian
 * drift movement (GDD §2.2 revision). No enemies, no bullets, no HUD,
 * no power-ups — just the ship and space-style movement.
 */

import Phaser from 'phaser';

import { Player } from '../entities/Player';
import {
  MovementInput,
} from '../utils/movement';
import {
  GAME_WIDTH,
  GAME_HEIGHT,
} from '../core/constants';

export class GymScene extends Phaser.Scene {
  private player: Player | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: Record<string, Phaser.Input.Keyboard.Key> | undefined;

  constructor() {
    super({ key: 'GymScene' });
  }

  create(): void {
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });

    // ── Input handling ─────────────────────────────────────────────
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      ['W', 'A', 'S', 'D'],
    ) as Record<string, Phaser.Input.Keyboard.Key>;

    this.input.keyboard?.on('keydown', () => this._updateInput());
    this.input.keyboard?.on('keyup', () => this._updateInput());
  }

  private _updateInput(): void {
    if (!this.player || !this.cursors || !this.wasd) return;

    const input: MovementInput = {
      up: Phaser.Input.Keyboard.JustDown(this.cursors.up) || Phaser.Input.Keyboard.JustDown(this.wasd.W),
      down: Phaser.Input.Keyboard.JustDown(this.cursors.down) || Phaser.Input.Keyboard.JustDown(this.wasd.S),
      left: Phaser.Input.Keyboard.JustDown(this.cursors.left) || Phaser.Input.Keyboard.JustDown(this.wasd.A),
      right: Phaser.Input.Keyboard.JustDown(this.cursors.right) || Phaser.Input.Keyboard.JustDown(this.wasd.D),
    };

    this.player.setInput(input);
  }

  update(_time: number, delta: number): void {
    if (!this.player) return;

    const dt = delta / 1000;
    const width = this.scale.width;
    const height = this.scale.height;

    this.player.physicsTick(dt, width, height);
    this.player.update();
  }
}

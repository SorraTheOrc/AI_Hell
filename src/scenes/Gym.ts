/**
 * Gym scene — the bare-bones testbed for player movement.
 *
 * Renders exactly one entity (the player ship) with thrust-based Newtonian
 * drift movement (GDD §2.2 revision). No enemies, no bullets, no HUD,
 * no power-ups — just the ship and space-style movement.
 *
 * Input is polled level-triggered each frame (key.isDown) so a held key
 * applies continuous thrust, and diagonals combine when two perpendicular
 * keys are held simultaneously.
 */

import Phaser from 'phaser';

import { Player } from '../entities/Player';
import { keysToInput, WasdKeysLike } from '../utils/input';
import { GAME_WIDTH, GAME_HEIGHT } from '../core/constants';

export class GymScene extends Phaser.Scene {
  private player: Player | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;

  constructor() {
    super({ key: 'GymScene' });
  }

  create(): void {
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });

    // ── Input keys ─────────────────────────────────────────────────
    // cursor keys (arrows) + WASD via a comma-separated key string,
    // per the Phaser KeyboardPlugin API.
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    if (!this.cursors || !this.wasd) {
      // No keyboard input available — the ship just drifts idle.
      return;
    }
  }

  /**
   * Reads the current held-key state into a MovementInput.
   * Level-triggered per frame: a key that is held down returns true
   * every frame until released, so thrust accumulates continuously.
   */
  private _readInput() {
    return keysToInput(this.cursors, this.wasd);
  }

  update(_time: number, delta: number): void {
    if (!this.player) return;

    const input = this._readInput();
    if (input) this.player.setInput(input);

    const dt = delta / 1000;
    const width = this.scale.width;
    const height = this.scale.height;

    this.player.physicsTick(dt, width, height);
    this.player.update();
  }
}
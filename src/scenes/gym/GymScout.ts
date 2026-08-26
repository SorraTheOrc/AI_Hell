/**
 * Gym scene — E1 Scout testbed (GDD §4.1).
 *
 * Renders a V-formation of Scout enemies that advances across the screen,
 * wiggling subtly. Two on-screen controls drive the demonstration:
 *
 * - **Explode** — destroys a random surviving scout with an explosion
 *   animation.
 * - **Shoot**  — toggles aimed firing (simulates Level 4+ behaviour):
 *   when on, scouts periodically fire red shots aimed at a default target
 *   position (bottom-centre of the screen, standing in for the player).
 *
 * Standalone gym scope: no player ship, no other enemy types, no HUD, no
 * power-ups. Scouts pass freely through one another — no collision is
 * installed (GDD §2.6).
 */

import Phaser from 'phaser';

import { Scout, ScoutBullet, buildVFormationOffsets } from '../../entities/Scout';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { playSpawnSound, playDestructionSound } from '../../audio/effects';
import { addBackToIndexButton } from '../../utils/gymNavigation';

/** How many scouts spawn in the V-formation. */
export const SCOUT_FORMATION_COUNT = 6;
/** Horizontal spacing between wing columns (px). */
export const SCOUT_FORMATION_SPACING_X = 26;
/** Vertical spacing between formation rows (px). */
export const SCOUT_FORMATION_SPACING_Y = 22;
/** Forward (rightward) drift of the whole formation (px/s). */
export const SCOUT_FORMATION_DRIFT_SPEED = 40;
/** Initial formation base position. */
export const SCOUT_FORMATION_START_X = GAME_WIDTH * 0.25;
export const SCOUT_FORMATION_START_Y = GAME_HEIGHT * 0.5;

export class GymScout extends Phaser.Scene {
  private scouts: Scout[] = [];
  private bullets: ScoutBullet[] = [];

  private formationBaseX = SCOUT_FORMATION_START_X;
  private formationBaseY = SCOUT_FORMATION_START_Y;
  private shootEnabled = false;

  // UI toggles
  private shootButton!: Phaser.GameObjects.Text;
  private explodeButton!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'GymScout' });
  }

  create(): void {
    // ── Spawn the V-formation ──────────────────────────────────────
    const offsets = buildVFormationOffsets(SCOUT_FORMATION_COUNT);
    for (const offset of offsets) {
      const scout = new Scout(this, {
        x: this.formationBaseX + offset.col * SCOUT_FORMATION_SPACING_X,
        y: this.formationBaseY + offset.row * SCOUT_FORMATION_SPACING_Y,
        formationOffset: offset,
      });
      // Containers are not auto-added to the display list — without this
      // the scouts would never render (project convention, see Gym.ts).
      this.add.existing(scout);
      this.scouts.push(scout);
    }
    playSpawnSound();

    // ── Controls (top-left HUD, minimal) ───────────────────────────
    const labelStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#00ff00',
      backgroundColor: '#1a1a1a',
      padding: { x: 8, y: 4 },
    };

    this.explodeButton = this._addButton(10, 10, 'EXPLODE', labelStyle);
    this.shootButton = this._addButton(120, 10, 'SHOOT: OFF', labelStyle);

    this.explodeButton.on('pointerdown', () => this.explodeRandomScout());
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.statusText = this.add.text(10, 44, `SCORE: n/a — scouts: ${this.scouts.length}`, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#888888',
    });

    // ── Hint line ──────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, 'E1 Scout gym — V-formation demo', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#555555',
    }).setOrigin(0.5);

    // ── Back to gym index (AC5) ───────────────────────────────────
    addBackToIndexButton(this);
  }

  // ── Button helpers ───────────────────────────────────────────────

  private _addButton(
    x: number,
    y: number,
    label: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, style);
    button.setInteractive({ useHandCursor: true });
    return button;
  }

  /** Destroys a random surviving scout with an explosion animation. */
  explodeRandomScout(): void {
    const alive = this.scouts.filter((s) => s.alive);
    if (alive.length === 0) return;
    const victim = alive[Math.floor(Math.random() * alive.length)];
    victim.destroySelf();
    playDestructionSound();
    this.statusText.setText(`exploded: ${victim.offset.row}:${victim.offset.col} — scouts: ${this.aliveCount}`);
  }

  /** Toggles aimed firing for the whole formation. */
  toggleShooting(): void {
    this.shootEnabled = !this.shootEnabled;
    for (const scout of this.scouts) scout.shootEnabled = this.shootEnabled;
    this.shootButton.setText(this.shootEnabled ? 'SHOOT: ON' : 'SHOOT: OFF');
  }

  // ── Public test accessors ────────────────────────────────────────

  /** All scouts in the scene (alive or destroyed). */
  get formationScouts(): Scout[] {
    return this.scouts.slice();
  }

  /** Number of scouts still alive. */
  get aliveCount(): number {
    return this.scouts.filter((s) => s.alive).length;
  }

  /** Whether aimed firing is currently enabled. */
  get shootingEnabled(): boolean {
    return this.shootEnabled;
  }

  /** Bullets currently in flight. */
  get activeBullets(): ScoutBullet[] {
    return this.bullets.slice();
  }

  /** Current formation base x (for shape verification). */
  get formationX(): number {
    return this.formationBaseX;
  }

  /** Current formation base y. */
  get formationY(): number {
    return this.formationBaseY;
  }

  // ── Scene update loop ────────────────────────────────────────────

  update(_time: number, delta: number): void {
    const dt = delta / 1000;

    // Advance the formation base; when the whole formation has crossed
    // the right edge, respawn it off the left edge so it flies again.
    this.formationBaseX += SCOUT_FORMATION_DRIFT_SPEED * dt;
    if (this.formationBaseX > GAME_WIDTH + 60) {
      this.formationBaseX = this._respawnX();
    }

    // Position each scout from the formation base + its own offset.
    for (const scout of this.scouts) {
      scout.applyFormationPosition(
        this.formationBaseX,
        this.formationBaseY,
        dt,
        SCOUT_FORMATION_SPACING_X,
        SCOUT_FORMATION_SPACING_Y,
      );

      // Firing is driven per-scout once per frame; bullets collected here
      // keep the scene the single owner of bullet lifecycle.
      const bullet = scout.tryFireAimedBullet(this.time.now);
      if (bullet) this.bullets.push(bullet);
    }

    // Advance bullets; remove any that leave the screen.
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.graphics.x += bullet.vx * dt;
      bullet.graphics.y += bullet.vy * dt;
      if (this._bulletOffScreen(bullet.graphics)) {
        bullet.graphics.destroy();
        this.bullets.splice(i, 1);
      }
    }
  }

  private _bulletOffScreen(g: Phaser.GameObjects.Graphics): boolean {
    return (
      g.x < -20 ||
      g.x > GAME_WIDTH + 20 ||
      g.y < -20 ||
      g.y > GAME_HEIGHT + 20
    );
  }

  /** x-coordinate that puts the whole formation off the left edge. */
  private _respawnX(): number {
    const maxAbsCol = Math.max(
      ...this.scouts.map((s) => Math.abs(s.offset.col)),
      0,
    );
    return -maxAbsCol * SCOUT_FORMATION_SPACING_X - 40;
  }
}
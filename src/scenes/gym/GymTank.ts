/**
 * Gym scene — E3 Tank testbed (GDD §4.1).
 *
 * Renders a rectangular formation of Tank enemies that moves slowly
 * across the screen with deliberate, extended hold positions.
 * Two on-screen controls drive the demonstration:
 *
 * - **Explode** — destroys a random surviving tank with an explosion
 *   animation.
 * - **Shoot**  — toggles radial burst firing (simulates Level 4+
 *   behaviour): when on, tanks periodically fire 10-projectile radial
 *   bursts; when off, tanks only hold formation.
 *
 * Standalone gym scope: no player ship, no other enemy types, no HUD,
 * no power-ups. Tanks pass freely through one another — no collision
 * is installed (GDD §2.6).
 */

import Phaser from 'phaser';

import { Tank, TankBullet, buildRectFormationOffsets } from '../../entities/Tank';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { playSpawnSound, playDestructionSound } from '../../audio/effects';
import { addBackToIndexButton } from '../../utils/gymNavigation';

/** How many tanks spawn in the rectangular formation. */
export const TANK_FORMATION_COUNT = 6;
/** Horizontal spacing between columns (px). */
export const TANK_FORMATION_SPACING_X = 50;
/** Vertical spacing between rows (px). */
export const TANK_FORMATION_SPACING_Y = 45;
/** Forward (rightward) drift speed of the whole formation (px/s). */
export const TANK_FORMATION_DRIFT_SPEED = 18;
/** Initial formation base position. */
export const TANK_FORMATION_START_X = GAME_WIDTH * 0.25;
export const TANK_FORMATION_START_Y = GAME_HEIGHT * 0.5;

export class GymTank extends Phaser.Scene {
  private tanks: Tank[] = [];
  private bullets: TankBullet[] = [];

  private formationBaseX = TANK_FORMATION_START_X;
  private formationBaseY = TANK_FORMATION_START_Y;
  private shootEnabled = false;

  // UI toggles
  private shootButton!: Phaser.GameObjects.Text;
  private explodeButton!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'GymTank' });
  }

  create(): void {
    // ── Spawn the rectangular formation ────────────────────────────
    const offsets = buildRectFormationOffsets(TANK_FORMATION_COUNT);
    for (const offset of offsets) {
      const tank = new Tank(this, {
        x: this.formationBaseX + offset.col * TANK_FORMATION_SPACING_X,
        y: this.formationBaseY + offset.row * TANK_FORMATION_SPACING_Y,
        formationOffset: offset,
      });
      this.add.existing(tank);
      this.tanks.push(tank);
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

    this.explodeButton.on('pointerdown', () => this.explodeRandomTank());
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.statusText = this.add.text(10, 44, `SCORE: n/a — tanks: ${this.tanks.length}`, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#888888',
    });

    // ── Hint line ──────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, 'E3 Tank gym — slow formation demo', {
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

  /** Destroys a random surviving tank with an explosion animation. */
  explodeRandomTank(): void {
    const alive = this.tanks.filter((t) => t.alive);
    if (alive.length === 0) return;
    const victim = alive[Math.floor(Math.random() * alive.length)];
    victim.destroySelf();
    playDestructionSound();
    this.statusText.setText(`exploded: ${victim.offset.row}:${victim.offset.col} — tanks: ${this.aliveCount}`);
  }

  /** Toggles radial burst firing for the whole formation. */
  toggleShooting(): void {
    this.shootEnabled = !this.shootEnabled;
    for (const tank of this.tanks) tank.shootEnabled = this.shootEnabled;
    this.shootButton.setText(this.shootEnabled ? 'SHOOT: ON' : 'SHOOT: OFF');
  }

  // ── Public test accessors ────────────────────────────────────────

  /** All tanks in the scene (alive or destroyed). */
  get formationTanks(): Tank[] {
    return this.tanks.slice();
  }

  /** Number of tanks still alive. */
  get aliveCount(): number {
    return this.tanks.filter((t) => t.alive).length;
  }

  /** Whether radial burst firing is currently enabled. */
  get shootingEnabled(): boolean {
    return this.shootEnabled;
  }

  /** Bullets currently in flight. */
  get activeBullets(): TankBullet[] {
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

    // Advance the formation base slowly (Tanks move slower than Scouts).
    this.formationBaseX += TANK_FORMATION_DRIFT_SPEED * dt;
    if (this.formationBaseX > GAME_WIDTH + 60) {
      this.formationBaseX = this._respawnX();
    }

    // Position each tank from the formation base + its own offset.
    for (const tank of this.tanks) {
      tank.applyFormationPosition(
        this.formationBaseX,
        this.formationBaseY,
        dt,
        TANK_FORMATION_SPACING_X,
        TANK_FORMATION_SPACING_Y,
      );

      // Collect any radial-burst bullets.
      const newBullets = tank.tryFireRadialBurst(this.time.now);
      this.bullets.push(...newBullets);
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
      ...this.tanks.map((t) => Math.abs(t.offset.col)),
      0,
    );
    return -maxAbsCol * TANK_FORMATION_SPACING_X - 40;
  }
}

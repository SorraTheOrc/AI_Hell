/**
 * Gym scene — E2 Diver testbed (GDD §4.2).
 *
 * Renders a diamond-formation of Diver enemies that advance across the
 * screen. Each diver periodically breaks from formation, follows a curved
 * (parabolic) trajectory toward the player position, then returns to its
 * formation slot. Two on-screen controls drive the demonstration:
 *
 * - **Explode** — destroys a random surviving diver with an explosion
 *   animation.
 * - **Shoot**  — toggles spread-shot firing (simulates Level 4+ behaviour):
 *   when on, divers periodically fire short-burst spread shots (3–5
 *   projectiles at slight angles) during their dive trajectory.
 *
 * Standalone gym scope: no player ship, no other enemy types, no HUD,
 * no power-ups. Divers pass freely through one another — no collision
 * is installed (GDD §2.6).
 */

import Phaser from 'phaser';

import { Diver, DiverBullet, buildDiverFormationOffsets } from '../../entities/Diver';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { playSpawnSound, playDestructionSound } from '../../audio/effects';
import { addBackToIndexButton } from '../../utils/gymNavigation';

/** How many divers spawn in the diamond formation. */
export const DIVER_FORMATION_COUNT = 6;
/** Horizontal spacing between columns (px). */
export const DIVER_FORMATION_SPACING_X = 30;
/** Vertical spacing between rows (px). */
export const DIVER_FORMATION_SPACING_Y = 25;
/** Forward (rightward) drift speed of the whole formation (px/s). */
export const DIVER_FORMATION_DRIFT_SPEED = 30;
/** Initial formation base position. */
export const DIVER_FORMATION_START_X = GAME_WIDTH * 0.25;
export const DIVER_FORMATION_START_Y = GAME_HEIGHT * 0.45;

export class GymDiver extends Phaser.Scene {
  private divers: Diver[] = [];
  private bullets: DiverBullet[] = [];

  private formationBaseX = DIVER_FORMATION_START_X;
  private formationBaseY = DIVER_FORMATION_START_Y;
  private shootEnabled = false;

  // UI toggles
  private shootButton!: Phaser.GameObjects.Text;
  private explodeButton!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'GymDiver' });
  }

  create(): void {
    // ── Spawn the diamond formation ────────────────────────────────
    const offsets = buildDiverFormationOffsets(DIVER_FORMATION_COUNT);
    for (const offset of offsets) {
      const diver = new Diver(this, {
        x: this.formationBaseX + offset.col * DIVER_FORMATION_SPACING_X,
        y: this.formationBaseY + offset.row * DIVER_FORMATION_SPACING_Y,
        formationOffset: offset,
      });
      this.add.existing(diver);
      this.divers.push(diver);
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

    this.explodeButton.on('pointerdown', () => this.explodeRandomDiver());
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.statusText = this.add.text(10, 44, `SCORE: n/a — divers: ${this.divers.length}`, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#888888',
    });

    // ── Hint line ──────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, 'E2 Diver gym — curved-dive demo', {
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

  /** Destroys a random surviving diver with an explosion animation. */
  explodeRandomDiver(): void {
    const alive = this.divers.filter((d) => d.alive);
    if (alive.length === 0) return;
    const victim = alive[Math.floor(Math.random() * alive.length)];
    victim.destroySelf();
    playDestructionSound();
    this.statusText.setText(
      `exploded: ${victim.offset.row}:${victim.offset.col} — divers: ${this.aliveCount}`,
    );
  }

  /** Toggles spread-shot firing for the whole formation. */
  toggleShooting(): void {
    this.shootEnabled = !this.shootEnabled;
    for (const diver of this.divers) diver.shootEnabled = this.shootEnabled;
    this.shootButton.setText(this.shootEnabled ? 'SHOOT: ON' : 'SHOOT: OFF');
  }

  // ── Public test accessors ────────────────────────────────────────

  /** All divers in the scene (alive or destroyed). */
  get formationDivers(): Diver[] {
    return this.divers.slice();
  }

  /** Number of divers still alive. */
  get aliveCount(): number {
    return this.divers.filter((d) => d.alive).length;
  }

  /** Whether spread-shot firing is currently enabled. */
  get shootingEnabled(): boolean {
    return this.shootEnabled;
  }

  /** Bullets currently in flight. */
  get activeBullets(): DiverBullet[] {
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

  /** Returns the count of divers currently in each state. */
  get stateCounts(): { formation: number; diving: number; returning: number } {
    let formation = 0;
    let diving = 0;
    let returning = 0;
    for (const diver of this.divers) {
      switch (diver.behaviourState) {
        case 'formation': formation++; break;
        case 'diving': diving++; break;
        case 'returning': returning++; break;
      }
    }
    return { formation, diving, returning };
  }

  // ── Scene update loop ────────────────────────────────────────────

  update(_time: number, delta: number): void {
    const dt = delta / 1000;

    // Advance the formation base; when the whole formation has crossed
    // the right edge, respawn it off the left edge so it flies again.
    this.formationBaseX += DIVER_FORMATION_DRIFT_SPEED * dt;
    if (this.formationBaseX > GAME_WIDTH + 60) {
      this.formationBaseX = this._respawnX();
    }

    // Position each diver from the formation base + its own offset.
    for (const diver of this.divers) {
      diver.applyFormationPosition(
        this.formationBaseX,
        this.formationBaseY,
        dt,
        DIVER_FORMATION_SPACING_X,
        DIVER_FORMATION_SPACING_Y,
      );

      // Collect any spread-shot bullets.
      const newBullets = diver.tryFireSpreadBurst(this.time.now);
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
      ...this.divers.map((d) => Math.abs(d.offset.col)),
      0,
    );
    return -maxAbsCol * DIVER_FORMATION_SPACING_X - 40;
  }
}

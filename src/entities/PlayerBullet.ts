/**
 * Player bullet — a Graphics-drawn projectile with `vx`/`vy`, advanced
 * by the scene each frame and removed when it flies off-screen.
 *
 * No physics body: bullets are pure Graphics objects (consistent with
 * the project's `ScoutBullet` precedent). The scene owns the bullet
 * lifecycle (creation, advancement, off-screen removal).
 *
 * Bullet appearance (colour, shape, size) is determined by the weapon
 * that fired it — see `src/utils/weapons.ts`.
 */

import Phaser from 'phaser';

/**
 * A single player bullet: a Graphics object with position, velocity,
 * and a configurable colour/radius. The scene creates bullets via
 * `createPlayerBullet`, advances them via `advanceAndCull`, and
 * removes them when they leave the game area.
 */
export class PlayerBullet extends Phaser.GameObjects.Graphics {
  /** Horizontal velocity in px/s. */
  readonly vx: number;

  /** Vertical velocity in px/s. */
  readonly vy: number;

  /** Bullet radius in px. */
  readonly radius: number;

  /** Bullet colour (Phaser integer). */
  readonly color: number;

  /**
   * Creates a new bullet Graphics object. Visuals are a filled circle
   * (the project's bullet precedent — see ScoutBullet).
   *
   * @param scene - The Phaser scene.
   * @param x - World x position.
   * @param y - World y position.
   * @param vx - Horizontal velocity (px/s).
   * @param vy - Vertical velocity (px/s).
   * @param radius - Bullet radius in px.
   * @param color - Bullet colour (Phaser integer).
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    color: number,
  ) {
    super(scene, { x, y });
    this.vx = vx;
    this.vy = vy;
    this.radius = radius;
    this.color = color;
    this._draw();
  }

  /** Draws the bullet as a filled circle at the origin. */
  private _draw(): void {
    this.clear();
    this.fillStyle(this.color, 1);
    this.beginPath();
    this.arc(0, 0, this.radius, 0, Math.PI * 2, false);
    this.fillPath();
  }

  /**
   * Advances the bullet by `dt` seconds and re-draws at the new
   * position. Movement is a pure velocity integration.
   *
   * @param dt - Time step in seconds.
   */
  advance(dt: number): void {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this._draw();
  }
}

/**
 * Creates a `PlayerBullet` at the given position with the given
 * velocity, colour, and radius.
 *
 * @param scene - The Phaser scene the bullet is added to.
 * @param x - World x position.
 * @param y - World y position.
 * @param color - Bullet colour (Phaser integer).
 * @param radius - Bullet radius in px.
 * @param vx - Horizontal velocity (px/s).
 * @param vy - Vertical velocity (px/s).
 * @returns The new bullet Graphics object.
 */
export function createPlayerBullet(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  radius: number,
  vx: number,
  vy: number,
): PlayerBullet {
  const bullet = new PlayerBullet(scene, x, y, vx, vy, radius, color);
  scene.add.existing(bullet);
  return bullet;
}

/**
 * Advances a bullet by `dt` seconds and returns whether it is still
 * on-screen (within the game area plus a margin). Used by scenes to
 * cull bullets that fly off-screen.
 *
 * @param bullet - The bullet to advance.
 * @param dt - Time step in seconds.
 * @param width - Game width in px.
 * @param height - Game height in px.
 * @returns `true` if the bullet is still on-screen.
 */
export function advanceAndCull(
  bullet: PlayerBullet,
  dt: number,
  width: number,
  height: number,
): boolean {
  bullet.advance(dt);
  const margin = bullet.radius * 3;
  return (
    bullet.x > -margin &&
    bullet.x < width + margin &&
    bullet.y > -margin &&
    bullet.y < height + margin
  );
}
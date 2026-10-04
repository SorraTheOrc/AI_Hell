/**
 * Player bullet — a Graphics-drawn projectile with `vx`/`vy`, advanced
 * by the scene each frame and removed when its lifetime elapses.
 *
 * No physics body: bullets are pure Graphics objects (consistent with
 * the project's `ScoutBullet` precedent). The scene owns the bullet
 * lifecycle (creation, advancement, lifetime expiry).
 *
 * Bullets wrap around all four screen edges (like the player ship and
 * asteroids) and remain effective within their configured lifetime
 * (AH-0MU960UTE001PTV0).
 *
 * Bullet appearance (colour, shape, size) is determined by the weapon
 * that fired it — see `src/utils/weapons.ts`.
 */

import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { WeaponDefinition } from '../utils/weapons';

/**
 * A single player bullet: a Graphics object with position, velocity,
 * and a configurable colour/radius. The scene creates bullets via
 * `createPlayerBullet`, advances them via `advanceAndCull`, and
 * removes them when their lifetime elapses.
 *
 * Bullets wrap across all four screen edges (matching the player ship
 * and asteroid model) and survive until their lifetime expires.
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
   * Bullet lifetime in seconds. The bullet wraps across all four screen
   * edges while alive and is destroyed once this elapses.
   */
  readonly lifetime: number;

  /** Elapsed time (seconds) since this bullet was created. */
  private _elapsed = 0;

  /**
   * The AOE weapon definition when this bullet is an `'onImpact'` projectile
   * (Mortar). The owning scene detonates the descriptor's area effect when
   * the projectile hits or expires; `undefined` for an ordinary bullet.
   */
  aoeWeapon?: WeaponDefinition;

  /**
   * Optional callback invoked when the bullet's lifetime expires, before its
   * Graphics are destroyed. The shared combat core uses it to detonate an
   * AOE projectile on expiry; ordinary bullets leave it undefined.
   */
  onExpire?: (bullet: PlayerBullet) => void;

  /**
   * True once an `'onImpact'` AOE projectile has detonated, so the blast
   * resolves at most once even if both the collision and expiry paths observe
   * the same projectile.
   */
  aoeDetonated = false;

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
   * @param lifetime - Bullet lifetime in seconds (default 0.75 s, matching the
   *   reduced Cannon base range — AH-0MUU131PU006O7ZD).
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    vx: number,
    vy: number,
    radius: number,
    color: number,
    lifetime: number = 0.75,
  ) {
    super(scene, { x, y });
    this.vx = vx;
    this.vy = vy;
    this.radius = radius;
    this.color = color;
    this.lifetime = lifetime;
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
   * Advances the bullet by `dt` seconds, wrapping its position at all
   * four screen edges (matching the player ship / asteroid model), and
   * increments the elapsed-time counter.
   *
   * @param dt - Time step in seconds.
   */
  advance(dt: number): void {
    this._elapsed += dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    // Four-edge wrap — leave left → reappear right, etc.
    if (this.x < 0) this.x += GAME_WIDTH;
    if (this.x >= GAME_WIDTH) this.x -= GAME_WIDTH;
    if (this.y < 0) this.y += GAME_HEIGHT;
    if (this.y >= GAME_HEIGHT) this.y -= GAME_HEIGHT;
    this._draw();
  }

  /**
   * Returns whether this bullet has expired (elapsed time ≥ lifetime).
   */
  isExpired(): boolean {
    return this._elapsed >= this.lifetime;
  }
}

/**
 * Creates a `PlayerBullet` at the given position with the given
 * velocity, colour, radius, and lifetime.
 *
 * @param scene - The Phaser scene the bullet is added to.
 * @param x - World x position.
 * @param y - World y position.
 * @param color - Bullet colour (Phaser integer).
 * @param radius - Bullet radius in px.
 * @param vx - Horizontal velocity (px/s).
 * @param vy - Vertical velocity (px/s).
 * @param lifetime - Bullet lifetime in seconds (default 0.75 s, matching the
 *   reduced Cannon base range — AH-0MUU131PU006O7ZD).
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
  lifetime: number = 0.75,
): PlayerBullet {
  const bullet = new PlayerBullet(scene, x, y, vx, vy, radius, color, lifetime);
  scene.add.existing(bullet);
  return bullet;
}

/**
 * Advances a bullet by `dt` seconds, wrapping its position at all four
 * screen edges, and returns whether it is still alive (lifetime not
 * exhausted). Bullets are never culled by off-screen position — they
 * wrap across the seam and persist until their lifetime elapses.
 *
 * When the lifetime is exhausted the bullet's Graphics object is
 * destroyed so it is removed from the scene's display list; a bullet
 * that merely stopped advancing (but stayed rendered) was the defect
 * reported in AH-0MU960UTE001PTV0.
 *
 * @param bullet - The bullet to advance.
 * @param dt - Time step in seconds.
 * @returns `true` if the bullet is still alive.
 */
export function advanceAndCull(
  bullet: PlayerBullet,
  dt: number,
): boolean {
  bullet.advance(dt);
  if (bullet.isExpired()) {
    // Notify an `'onImpact'` projectile so its AOE blast resolves at the
    // expiry point before the Graphics are destroyed.
    bullet.onExpire?.(bullet);
    bullet.destroy();
    return false;
  }
  return true;
}

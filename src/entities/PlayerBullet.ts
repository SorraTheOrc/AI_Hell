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
 * A bullet with a **wall-bounce budget** (`bounces`, the Centipede ricochet
 * homage AH-0MV1BIV5L005NJAI) instead **reflects** off each edge it crosses,
 * decrementing the budget, and expires on the wall contact once the budget is
 * spent — it never wraps. An ordinary bullet leaves `bounces` undefined and
 * keeps the default four-edge wrap. The reflection lives here in the shared
 * entity so the game and every gym bounce identically.
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
 * and asteroid model) and survive until their lifetime expires, unless a
 * wall-bounce budget is set (see {@link PlayerBullet.bounces}).
 */
export class PlayerBullet extends Phaser.GameObjects.Graphics {
  /** Horizontal velocity in px/s (reflected on a wall bounce). */
  vx: number;

  /** Vertical velocity in px/s (reflected on a wall bounce). */
  vy: number;

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
   * The weapon definition when this bullet is a **splitting** projectile
   * (Missile Command cluster/MIRV homage, AH-0MV1BIVIJ007KYXU). The shared
   * combat core splits it exactly once — on the first impact or on expiry —
   * into `splits` radial warheads; `undefined` for an ordinary bullet.
   */
  splitWeapon?: WeaponDefinition;

  /**
   * True once a splitting projectile has spawned its warheads, so the split
   * resolves at most once even if both the collision and expiry paths observe
   * the same projectile. Never set for an ordinary bullet.
   */
  splitSpawned = false;

  /**
   * Remaining pass-through budget: how many **additional** enemies this
   * bullet may damage before it is consumed (R-Type wave laser,
   * AH-0MV1BIUSJ0090W92). `0` for an ordinary single-hit bullet. The shared
   * collision path decrements it once per newly hit enemy and consumes the
   * bullet when it reaches zero.
   */
  piercing = 0;

  /**
   * Remaining **wall-bounce budget**: how many arena-edge reflections this
   * bullet may make before it expires on the next wall contact (Centipede
   * ricochet homage, AH-0MV1BIV5L005NJAI). `undefined` means an ordinary
   * bullet that wraps at the edges; a number (including `0`) marks a
   * ricochet bullet that reflects while the budget remains and then expires
   * instead of wrapping.
   */
  bounces?: number;

  /**
   * True once a ricochet bullet has hit a wall with no bounces remaining, so
   * `isExpired()` reports it dead even before its lifetime elapses. Never set
   * for an ordinary (wrapping) bullet.
   */
  private _wallExpired = false;

  /**
   * Enemies this bullet has already damaged. The shared collision path checks
   * membership before applying damage so a piercing bullet which overlaps the
   * same enemy across frames damages it exactly once.
   */
  readonly piercedEnemies = new Set<object>();

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
   * Advances the bullet by `dt` seconds. An ordinary bullet wraps its
   * position at all four screen edges (matching the player ship / asteroid
   * model); a bullet with a wall-bounce budget (`bounces !== undefined`)
   * instead reflects off each edge it crosses, decrementing the budget, and
   * expires once the budget is spent. Either way the elapsed-time counter is
   * incremented.
   *
   * @param dt - Time step in seconds.
   */
  advance(dt: number): void {
    this._elapsed += dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (this.bounces === undefined) {
      // Four-edge wrap — leave left → reappear right, etc.
      if (this.x < 0) this.x += GAME_WIDTH;
      if (this.x >= GAME_WIDTH) this.x -= GAME_WIDTH;
      if (this.y < 0) this.y += GAME_HEIGHT;
      if (this.y >= GAME_HEIGHT) this.y -= GAME_HEIGHT;
    } else {
      this._bounceAtEdges();
    }
    this._draw();
  }

  /**
   * Reflects the bullet off any arena edge it has crossed, mirroring the
   * position back inside the arena and reversing the crossed velocity
   * component. A single wall contact (even at a corner, where both components
   * cross) spends exactly one bounce. When no bounces remain the bullet is
   * marked expired instead of wrapping (AH-0MV1BIV5L005NJAI).
   */
  private _bounceAtEdges(): void {
    let hitWall = false;
    if (this.x < 0) {
      this.x = -this.x;
      this.vx = -this.vx;
      hitWall = true;
    } else if (this.x >= GAME_WIDTH) {
      this.x = 2 * GAME_WIDTH - this.x;
      this.vx = -this.vx;
      hitWall = true;
    }
    if (this.y < 0) {
      this.y = -this.y;
      this.vy = -this.vy;
      hitWall = true;
    } else if (this.y >= GAME_HEIGHT) {
      this.y = 2 * GAME_HEIGHT - this.y;
      this.vy = -this.vy;
      hitWall = true;
    }
    if (!hitWall) return;
    if ((this.bounces ?? 0) > 0) {
      this.bounces = (this.bounces ?? 0) - 1;
    } else {
      this._wallExpired = true;
    }
  }

  /**
   * Returns whether this bullet has expired — either its lifetime has
   * elapsed or a ricochet bullet has exhausted its wall-bounce budget at an
   * edge.
   */
  isExpired(): boolean {
    return this._wallExpired || this._elapsed >= this.lifetime;
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

/**
 * Indestructible obstacle entity — a static hazard for the Player gym
 * (AH-0MUAYB2XR007N10W).
 *
 * The Player gym is a thruster-navigation training space: a deterministic
 * set of solid obstacles the ship must weave around. Obstacles are
 * **indestructible** — player bullets are absorbed on impact and a body
 * collision destroys the *player*, never the obstacle (the shared
 * `CombatScene._handleCollisions` path, with the gym overriding only the
 * two destruction hooks).
 *
 * The entity satisfies the shared `CombatEnemyEntity` structural contract
 * (`x`, `y`, `alive`, `getHitRadius()`, `destroySelf()`), so the Player gym
 * can expose obstacles through the inherited `getEnemyEntities()` accessor
 * and consume the *same* collision code as the shipped game and the other
 * gyms — no divergent collision loop. Because the shared collision is
 * circle-vs-circle, an obstacle's collider is its radius; the barrier and
 * pillar shapes both fit inside that circle so the collision matches the
 * visual bounds.
 *
 * Obstacles are a **gym-only training feature** (the shipped game has no
 * static hazards yet); the parity rationale is recorded in
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §5.1 and the Player gym scene
 * header, per the AGENTS.md gym↔game parity convention
 * (AH-0MUGZDTFX004RBD1).
 *
 * @module src/entities/Obstacle
 */

import Phaser from 'phaser';

/** Warning colour for barrier obstacles (neon amber). */
export const OBSTACLE_BARRIER_COLOR = 0xff8a00;
/** Warning colour for pillar obstacles (neon magenta). */
export const OBSTACLE_PILLAR_COLOR = 0xff2d6f;

/** The two obstacle families used by the Player gym's fixed course. */
export type ObstacleKind = 'barrier' | 'pillar';

/** Configuration for one obstacle. */
export interface ObstacleConfig {
  /** World-space x position (px). */
  x: number;
  /** World-space y position (px). */
  y: number;
  /** Collision radius (px) — the shared circle-vs-circle hit radius. */
  radius: number;
  /**
   * Obstacle family. `barrier` renders as a hexagon (walls/barriers),
   * `pillar` as a ringed circle (the "small variety"). Defaults to
   * `barrier`.
   */
  kind?: ObstacleKind;
  /** Body colour override; defaults to the kind's warning colour. */
  color?: number;
}

/**
 * An indestructible static obstacle.
 *
 * Extends `Phaser.GameObjects.Graphics` (like `PlayerBullet`) so it is a
 * single display-list object; the scene adds it with `this.add.existing()`.
 * `destroySelf()` is deliberately a no-op so no gameplay path can remove
 * the obstacle; scene teardown uses the inherited `GameObject.destroy()`.
 */
export class Obstacle extends Phaser.GameObjects.Graphics {
  /** Collision radius (px) used by the shared circle-vs-circle check. */
  readonly radius: number;

  /** Obstacle family (`barrier` or `pillar`). */
  readonly kind: ObstacleKind;

  /** Effective body colour (resolved from kind when not overridden). */
  readonly color: number;

  /** Obstacles never leave the field through gameplay — always alive. */
  private _alive = true;

  constructor(scene: Phaser.Scene, config: ObstacleConfig) {
    super(scene, { x: config.x, y: config.y });
    this.radius = config.radius;
    this.kind = config.kind ?? 'barrier';
    this.color =
      config.color ??
      (this.kind === 'barrier'
        ? OBSTACLE_BARRIER_COLOR
        : OBSTACLE_PILLAR_COLOR);
    this._draw();
  }

  /** Whether this obstacle is alive (always true until scene teardown). */
  get alive(): boolean {
    return this._alive;
  }

  /** Hit radius (px) consumed by the shared collision pass. */
  getHitRadius(): number {
    return this.radius;
  }

  /**
   * Indestructible: gameplay destruction is a no-op. The scene tears the
   * obstacle down with the inherited `GameObject.destroy()` on restart.
   */
  destroySelf(_scale?: number): void {
    // Intentionally empty — obstacles can never be destroyed in play.
  }

  /** Draws the obstacle body inside the collision circle. */
  private _draw(): void {
    this.clear();
    const r = this.radius;
    this.lineStyle(3, this.color, 1);

    if (this.kind === 'barrier') {
      // Hexagon with vertices on the collision circle.
      const sides = 6;
      this.fillStyle(this.color, 0.12);
      this.beginPath();
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
        const px = Math.cos(angle) * r;
        const py = Math.sin(angle) * r;
        if (i === 0) this.moveTo(px, py);
        else this.lineTo(px, py);
      }
      this.closePath();
      this.fillPath();
      this.strokePath();
      return;
    }

    // Pillar: a ringed circle with a solid core.
    this.strokeCircle(0, 0, r);
    this.fillStyle(this.color, 0.9);
    this.fillCircle(0, 0, Math.max(2, r * 0.25));
  }
}

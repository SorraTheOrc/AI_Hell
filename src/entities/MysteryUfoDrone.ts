/**
 * Mystery UFO collector drone entity (parent AH-0MV9G113S009B37I, child
 * AH-0MVBMPZFE00382DA).
 *
 * A small, self-contained neon-vector collector drone — a code-drawn scaled
 * copy of the player ship — that runs the full seek → collect → return →
 * pay out lifecycle:
 *
 * 1. **SEEK** — steer toward the nearest live mineral (via the shared
 *    `setSeekTargets` seam, mirroring the {@link Harvester} seeker).
 * 2. **COLLECT** — vacuum any mineral whose centre enters the collector
 *    radius into the hold.
 * 3. **RETURN** — fly home once the hold reaches capacity **or** the
 *    lifetime expires (whichever comes first).
 * 4. **PAYOUT** — on arrival, pay the exactly-held minerals into the sink;
 *    the drone then disappears.
 *
 * Termination is explicitly either-or (capacity reached *or* lifetime
 * expiry, whichever comes first); the pay-in is exactly the held minerals
 * (possibly 0 when the lifetime expires before anything was collected).
 *
 * The entity deliberately contains no scene wiring: the shared-core drone
 * pass (child AH-0MVBMPZS90038715) supplies the live mineral field via
 * {@link MysteryUfoDrone.setSeekTargets}, the live player position via
 * {@link MysteryUfoDrone.setHomeTarget}, advances motion via
 * {@link MysteryUfoDrone.updatePosition} and consumes the pay-in. The
 * `LiveTargetingEnemy` structural contract
 * (`setSeekTargets`+`updatePosition`) is satisfied, so the drone can be
 * driven by the shared `pushSeekTargets` helper.
 *
 * Destruction contract: `onEnemyBullet` / `onEnemyBody` mark the drone
 * destroyed (hiding it) while leaving `heldMinerals` readable, so the
 * shared drop pass can spill the hold at the crash site; `onPlayerBullet`
 * is a no-op (the player's own fire cannot harm the drone).
 *
 * @module src/entities/MysteryUfoDrone
 */

import Phaser from 'phaser';

import { HIT_RADIUS_BUFFER_PX, SHIP_COLOR } from '../core/constants';
import type { Mineral } from './Mineral';

// ── Visual / behaviour tuning ───────────────────────────────────────

/** Hull colour — the player ship's cyan hexagon (a scaled ship copy). */
export const MYSTERY_UFO_DRONE_COLOR = SHIP_COLOR;

/**
 * Visual half-size (circumradius) of the drone's hexagon hull in px — a
 * scaled-down player ship (the ship is 20 px across, the drone 12 px).
 */
export const MYSTERY_UFO_DRONE_SIZE = 6;

/** Seek / return cruise speed in px/s (tuned in the gyms). */
export const MYSTERY_UFO_DRONE_SPEED = 120;

/** Distance (px) from home at which the drone begins its payout. */
export const MYSTERY_UFO_DRONE_ARRIVE_DISTANCE = 2;

/** Render depth — the drone flies above the mineral field (depth 2). */
export const MYSTERY_UFO_DRONE_DEPTH = 2;

/**
 * The drone's lifecycle phases, in order: SEEK → COLLECT → RETURN →
 * PAYOUT → GONE. `'destroyed'` is the terminal phase entered only through
 * the destruction contract (enemy bullet / enemy body).
 */
export type MysteryUfoDroneState =
  | 'seek' // steering toward the nearest live mineral, nothing in radius
  | 'collect' // at least one mineral centre entered the collector radius this tick
  | 'return' // hold full or lifetime expired — flying home to pay out
  | 'payout' // arrived home; the pay-in fires with exactly the held minerals
  | 'gone' // paid out — the drone has disappeared
  | 'destroyed'; // destroyed by an enemy bullet / enemy body

/** Configuration accepted by {@link MysteryUfoDrone} (resolved level data). */
export interface MysteryUfoDroneConfig {
  /** World x position the drone spawns at. */
  x: number;
  /** World y position the drone spawns at. */
  y: number;
  /**
   * Resolved level value — max sortie time in seconds before the drone must
   * return (level-0 default 5 s).
   */
  lifetime: number;
  /**
   * Resolved level value — minerals the drone can hold before returning
   * (level-0 default 10). Termination fires once the hold reaches it.
   */
  capacity: number;
  /**
   * Resolved level value — collection (vacuum) radius in px (level-0
   * default 20). A mineral whose centre enters this radius is collected.
   */
  collectorRadius: number;
  /**
   * Optional home position (the player). Defaults to the spawn position;
   * the shared pass updates it live via {@link MysteryUfoDrone.setHomeTarget}.
   */
  homeX?: number;
  homeY?: number;
  /**
   * Optional pay-in sink, invoked exactly once on arrival with exactly the
   * held minerals. The shared-core pass drains this into the ship's hold.
   */
  onPayout?: (minerals: number) => void;
  /** Optional cruise-speed override (px/s). Defaults to {@link MYSTERY_UFO_DRONE_SPEED}. */
  speed?: number;
  /** Optional half-size override (px). Defaults to {@link MYSTERY_UFO_DRONE_SIZE}. */
  size?: number;
}

/**
 * A scaled-down player-ship collector drone.
 *
 * Renders as the same code-drawn cyan hexagon hull as the four-directional
 * player ship, scaled down (no external art). The drone is itself a
 * `Phaser.GameObjects.Graphics` — like the Player ship and the Mineral — so
 * a single display-list object represents the collector; `bodyGraphics` is
 * exposed as a convenience reference to the hull for callers that inspect
 * the rendered shape.
 */
export class MysteryUfoDrone extends Phaser.GameObjects.Graphics {
  /** Whether the drone is still active (not gone, not destroyed). */
  private _alive = true;

  /** Whether the drone was destroyed by an enemy bullet / enemy body. */
  private _destroyed = false;

  /** Whether the pay-in has already fired (fires exactly once). */
  private _paidOut = false;

  /** Current lifecycle phase. */
  private _state: MysteryUfoDroneState = 'seek';

  /** Minerals currently held (removed from the field). */
  private _heldMinerals = 0;

  /** Seekable mineral field supplied via {@link MysteryUfoDrone.setSeekTargets}. */
  private _targets: readonly Mineral[] = [];

  /** Current seek target x, or null when no live mineral is known. */
  private _targetX: number | null = null;
  private _targetY: number | null = null;

  /** Home position the drone returns to. */
  private _homeX: number;
  private _homeY: number;

  /** Simulated sortie time, accumulated in {@link MysteryUfoDrone.updatePosition}. */
  private _elapsed = 0;

  private readonly _lifetime: number;
  private readonly _capacity: number;
  private readonly _collectorRadius: number;
  private readonly _speed: number;
  private readonly _size: number;
  private readonly _onPayout: ((minerals: number) => void) | undefined;

  /**
   * Create a collector drone at `(config.x, config.y)` with the resolved
   * level values (`lifetime`, `capacity`, `collectorRadius`).
   *
   * @param scene — the Phaser scene owning the drone's display object.
   * @param config — resolved level stats plus spawn/home/optional tuning.
   */
  constructor(scene: Phaser.Scene, config: MysteryUfoDroneConfig) {
    super(scene, { x: config.x, y: config.y });

    this._lifetime = config.lifetime;
    this._capacity = config.capacity;
    this._collectorRadius = config.collectorRadius;
    this._speed = config.speed ?? MYSTERY_UFO_DRONE_SPEED;
    this._size = config.size ?? MYSTERY_UFO_DRONE_SIZE;
    this._onPayout = config.onPayout;

    this._homeX = config.homeX ?? config.x;
    this._homeY = config.homeY ?? config.y;

    this.setDepth(MYSTERY_UFO_DRONE_DEPTH);
    this._drawBody();

    // Self-register on the display list — a Graphics built via `new` is not
    // shown until added to the scene (mirrors Player and Mineral).
    scene.add.existing(this);
  }

  /**
   * The rendered hull — this entity's own graphics context, since the drone
   * draws its scaled ship hexagon directly (mirrors Mineral.playerHull).
   */
  get bodyGraphics(): Phaser.GameObjects.Graphics {
    return this;
  }

  // ── Read-only lifecycle accessors (tests / shared-core pass) ──────

  /**
   * Current lifecycle phase (SEEK → COLLECT → RETURN → PAYOUT → GONE).
   *
   * Named `droneState` rather than `state` because `Phaser.GameObjects.GameObject`
   * already declares a numeric `state` field; overriding it with an accessor
   * is rejected by TypeScript and would shadow Phaser's own state handling.
   */
  get droneState(): MysteryUfoDroneState {
    return this._state;
  }

  /** Whether the drone is still active (not gone, not destroyed). */
  get alive(): boolean {
    return this._alive;
  }

  /** Whether the drone was destroyed by an enemy bullet / enemy body. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /** Minerals currently in the hold (readable after destruction for the drop). */
  get heldMinerals(): number {
    return this._heldMinerals;
  }

  /** Whether the hold has reached capacity (termination trigger). */
  get isFull(): boolean {
    return this._heldMinerals >= this._capacity;
  }

  /** Resolved collector (vacuum) radius in px. */
  get collectorRadius(): number {
    return this._collectorRadius;
  }

  /** Resolved hold capacity in minerals. */
  get capacity(): number {
    return this._capacity;
  }

  /** Resolved sortie lifetime in seconds. */
  get lifetimeSeconds(): number {
    return this._lifetime;
  }

  /** Effective visual half-size (for the shared hit-radius check). */
  get effectiveSize(): number {
    return this._size;
  }

  /**
   * The drone's body hull is a scaled player ship; its collision radius
   * mirrors the shared enemy convention (`size / 2 + buffer`, matching
   * `BaseEnemy.getHitRadius`).
   */
  getHitRadius(): number {
    return Math.ceil(this._size / 2 + HIT_RADIUS_BUFFER_PX);
  }

  // ── Shared seek seam (LiveTargetingEnemy) ─────────────────────────

  /**
   * Receive the live mineral field. The drone picks the nearest live mineral
   * as its seek target; with no live mineral it clears the target and holds
   * station. Called from the shared tick in the game and the gyms.
   *
   * @param minerals — live minerals on the field (dead/collected excluded).
   */
  setSeekTargets(minerals: readonly Mineral[]): void {
    this._targets = minerals;
    this._selectNearestTarget();
  }

  /** Current seek target x, or null when no live mineral is known. */
  get seekTargetX(): number | null {
    return this._targetX;
  }

  /** Current seek target y, or null when no live mineral is known. */
  get seekTargetY(): number | null {
    return this._targetY;
  }

  /**
   * Update the home (return) target — the shared pass pushes the live player
   * position each tick so the drone pays out at the ship.
   */
  setHomeTarget(x: number, y: number): void {
    this._homeX = x;
    this._homeY = y;
  }

  // ── Movement / lifecycle ─────────────────────────────────────────

  /**
   * Advance the drone one tick.
   *
   * While seeking/collecting: elapses the lifetime, vacuums every live
   * mineral whose centre is inside the collector radius (up to capacity),
   * and steers toward the nearest remaining mineral. Once the hold reaches
   * capacity **or** the lifetime expires — whichever comes first — the drone
   * switches to RETURN. In RETURN it steers home; on arrival it fires the
   * pay-in (exactly the held minerals) and disappears.
   *
   * @param dt — elapsed time in seconds.
   */
  updatePosition(dt: number): void {
    if (!this._alive || this._destroyed) return;
    if (this._state === 'gone') return;

    if (this._state === 'seek' || this._state === 'collect') {
      this._elapsed += dt;

      // Vacuum minerals whose centre enters the collector radius.
      const collected = this._vacuum();

      // Termination: capacity reached OR lifetime expiry, whichever first.
      if (this._heldMinerals >= this._capacity || this._elapsed >= this._lifetime) {
        this._beginReturn();
        return;
      }

      this._state = collected > 0 ? 'collect' : 'seek';

      this._selectNearestTarget();
      if (this._targetX !== null && this._targetY !== null) {
        this._steer(this._targetX, this._targetY, dt);
      }
      return;
    }

    if (this._state === 'return') {
      this._steer(this._homeX, this._homeY, dt);
      const arrived =
        Math.hypot(this._homeX - this.x, this._homeY - this.y) <=
        MYSTERY_UFO_DRONE_ARRIVE_DISTANCE;
      if (arrived) this._payOut();
    }
  }

  // ── Destruction contract ─────────────────────────────────────────

  /**
   * An enemy bullet destroys the drone: it is hidden, marked destroyed and
   * its held minerals stay readable for the drop pass. Returns true when it
   * actually destroyed the drone (so the caller may consume the bullet).
   */
  onEnemyBullet(): boolean {
    return this._destroyByEnemy();
  }

  /** An enemy body collision destroys the drone exactly like a bullet. */
  onEnemyBody(): boolean {
    return this._destroyByEnemy();
  }

  /**
   * The player's own fire cannot destroy the drone — this is a no-op and
   * always returns false.
   */
  onPlayerBullet(): boolean {
    return false;
  }

  // ── Internals ────────────────────────────────────────────────────

  /** Draw the hull: a code-drawn cyan hexagon — the scaled player ship. */
  private _drawBody(): void {
    this.clear();
    this.lineStyle(2, MYSTERY_UFO_DRONE_COLOR, 1);

    const r = this._size;
    const sx = (r * Math.sqrt(3)) / 2; // r·cos(30°) — half-width
    const sy = r / 2; // r·sin(30°) — corner y-offset
    this.beginPath();
    this.moveTo(0, -r);
    this.lineTo(sx, -sy);
    this.lineTo(sx, sy);
    this.lineTo(0, r);
    this.lineTo(-sx, sy);
    this.lineTo(-sx, -sy);
    this.lineTo(0, -r); // explicit closing edge back to the top vertex
    this.closePath();
    this.strokePath();
  }

  /** Select the nearest live mineral as the seek target (clears when none). */
  private _selectNearestTarget(): void {
    let best: Mineral | null = null;
    let bestDist = Infinity;
    for (const mineral of this._targets) {
      if (!mineral.alive) continue;
      const d = Math.hypot(mineral.x - this.x, mineral.y - this.y);
      if (d < bestDist) {
        bestDist = d;
        best = mineral;
      }
    }
    this._targetX = best ? best.x : null;
    this._targetY = best ? best.y : null;
  }

  /**
   * Collect every live, supplied mineral whose centre is inside the collector
   * radius, up to the remaining capacity. Collected minerals are removed from
   * the field (marked dead + hidden) and counted in {@link MysteryUfoDrone._heldMinerals}.
   *
   * @returns the number of minerals collected this tick (`> 0` ⇒ state `'collect'`).
   */
  private _vacuum(): number {
    let collected = 0;
    for (const mineral of this._targets) {
      if (!mineral.alive) continue;
      if (this._heldMinerals >= this._capacity) break;
      const r = this._collectorRadius;
      if (Math.hypot(mineral.x - this.x, mineral.y - this.y) <= r) {
        // Remove from the field without firing the player/absorb callbacks —
        // the shared pass reconciles the field and owns absorb VFX.
        mineral.alive = false;
        mineral.setVisible(false);
        this._heldMinerals += 1;
        collected += 1;
      }
    }
    return collected;
  }

  /** Steer toward `(tx, ty)` at the cruise speed, clamping to the target. */
  private _steer(tx: number, ty: number, dt: number): void {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const step = Math.min(this._speed * dt, dist);
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
  }

  /** Switch to the return leg (hold full or lifetime expired). */
  private _beginReturn(): void {
    this._state = 'return';
  }

  /**
   * Pays out exactly the held minerals into the sink once, then disappears:
   * the drone is hidden and marked gone (no longer alive). The pay-in fires
   * synchronously, and the caller can inspect the drone
   * (`droneState === 'payout'`, `heldMinerals`) inside the callback.
   */
  private _payOut(): void {
    if (this._paidOut) return;
    this._paidOut = true;
    const minerals = this._heldMinerals;
    this._state = 'payout';
    this._onPayout?.(minerals);
    this._state = 'gone';
    this._alive = false;
    this.setVisible(false);
  }

  /** Mark the drone destroyed by an enemy — hides it, keeps held readable. */
  private _destroyByEnemy(): boolean {
    if (!this._alive || this._destroyed || this._paidOut) return false;
    this._destroyed = true;
    this._alive = false;
    this._state = 'destroyed';
    this.setVisible(false);
    return true;
  }
}

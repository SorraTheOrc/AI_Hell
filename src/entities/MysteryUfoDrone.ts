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
 *    radius into the hold, crediting its worth (`mineral.value`) up to the
 *    remaining capacity — a red deposit worth 10 is therefore clipped by the
 *    free space left in the hold and any surplus is destroyed with it
 *    (AH-0MVJ79739008396I).
 * 3. **RETURN** — fly home once the hold reaches capacity **or** the
 *    lifetime expires (whichever comes first).
 * 4. **PAYOUT** — on arrival, pay the exactly-held minerals into the sink;
 *    the drone then disappears.
 *
 * Rendering is alive for the whole sortie: the saucer's warm running lights
 * chase around the rim and its under-hull glow breathes in a continuous
 * pulse (AH-0MVSAJZOI008TRBB). The pulse animates the **existing** code-drawn
 * lights in {@link MysteryUfoDrone._drawBody} — it is not a separate emitter —
 * and keeps running in SEEK, COLLECT and RETURN alike, so the drone never
 * reads as a static sprite.
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

/** Hull colour — neon cyan, matching the ship's palette. */
export const MYSTERY_UFO_DRONE_COLOR = SHIP_COLOR;

/** Warm rim-light colour of the saucer's running lights. */
export const MYSTERY_UFO_DRONE_LIGHT_COLOR = 0xffdd66;

/** Dome glass tint (a paler cyan than the rim). */
export const MYSTERY_UFO_DRONE_DOME_COLOR = 0xaeffff;

/**
 * Visual half-size (circumradius) of the drone in px. The saucer's drawn rim
 * is wider than tall (see {@link saucerGeometry}), so the drone reads as a
 * classic flying saucer rather than a ship copy.
 */
export const MYSTERY_UFO_DRONE_SIZE = 6;

/** Number of running lights around the saucer rim. */
export const MYSTERY_UFO_DRONE_LIGHT_COUNT = 6;

/**
 * Angular speed of the running-light pulse (rad/s). Slow enough to read as a
 * chase of lights, fast enough that a 5 s sortie shows several sweeps.
 */
export const MYSTERY_UFO_DRONE_LIGHT_PULSE_SPEED = 6;

/** Lowest alpha a running light pulses to (never fully dark — the rim stays lit). */
export const MYSTERY_UFO_DRONE_LIGHT_PULSE_MIN_ALPHA = 0.3;

/** Peak alpha of a running light. */
export const MYSTERY_UFO_DRONE_LIGHT_PULSE_MAX_ALPHA = 1;

/** Phase offset (rad) between neighbouring running lights — the chase effect. */
export const MYSTERY_UFO_DRONE_LIGHT_PULSE_PHASE_STEP = 1.1;

/** Lowest alpha of the under-hull drive glow. */
export const MYSTERY_UFO_DRONE_GLOW_PULSE_MIN_ALPHA = 0.1;

/** Peak alpha of the under-hull drive glow. */
export const MYSTERY_UFO_DRONE_GLOW_PULSE_MAX_ALPHA = 0.3;

/** Glow pulse speed relative to the running-light chase (a slower breath). */
export const MYSTERY_UFO_DRONE_GLOW_PULSE_SPEED_FACTOR = 0.5;

/** Geometry of the code-drawn saucer, derived from its half-size. */
export interface MysteryUfoSaucerGeometry {
  /** Half-width of the elliptical rim (px). */
  rimHalfWidth: number;
  /** Half-height of the elliptical rim (px). */
  rimHalfHeight: number;
  /** Radius of the domed upper hull (px). */
  domeRadius: number;
  /** Vertical centre of the dome, relative to the drone origin (px). */
  domeOffsetY: number;
  /** Running-light positions around the rim, relative to the origin. */
  lights: Array<{ x: number; y: number; radius: number }>;
}

/**
 * Builds the saucer's geometry from the drone's half-size. Pure so the shape
 * is unit-testable: a wide rim (2× the half-size across), a domed upper hull
 * sitting above the rim, and a ring of evenly spaced running lights.
 *
 * @param size - The drone's visual half-size (px).
 */
export function saucerGeometry(size: number): MysteryUfoSaucerGeometry {
  const rimHalfWidth = size * 2;
  const rimHalfHeight = size * 0.7;
  const domeRadius = size * 0.95;
  const domeOffsetY = -size * 0.28;
  const lights: Array<{ x: number; y: number; radius: number }> = [];
  for (let i = 0; i < MYSTERY_UFO_DRONE_LIGHT_COUNT; i += 1) {
    // Follow the front (lower) half of the rim ellipse so the lights read as
    // a row of windows around the saucer's visible edge, each at a distinct
    // point on the arc.
    const t =
      Math.PI - (Math.PI * (i + 0.5)) / MYSTERY_UFO_DRONE_LIGHT_COUNT;
    lights.push({
      x: Math.cos(t) * rimHalfWidth * 0.75,
      y: Math.sin(t) * rimHalfHeight * 0.55 + rimHalfHeight * 0.1,
      radius: Math.max(0.6, size * 0.13),
    });
  }
  return { rimHalfWidth, rimHalfHeight, domeRadius, domeOffsetY, lights };
}

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

  /** Running-light / glow animation clock (s), advanced every live tick. */
  private _pulseTime = 0;

  /**
   * Minerals vacuumed during the **current** tick, in collection order
   * (`{ x, y }` at the position they were taken from). Cleared at the start
   * of every live tick, so the shared pass can spawn one sparkle per mineral
   * without the entity knowing anything about scene VFX.
   */
  private readonly _collectedThisTick: Array<{ x: number; y: number }> = [];

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
   * Minerals vacuumed during the current tick, in collection order. The list
   * is reset at the start of every live tick and is valid until the next
   * `updatePosition` call; the shared pass reads it immediately after the
   * update to spawn the per-mineral collect sparkles.
   */
  get collectedThisTick(): ReadonlyArray<{ x: number; y: number }> {
    return this._collectedThisTick;
  }

  /** Seconds the running-light / glow pulse has been animating. */
  get lightPulseTime(): number {
    return this._pulseTime;
  }

  /**
   * The alpha the running light at `index` is currently drawn with.
   *
   * A sine wave whose phase is offset per light, so the ring reads as a
   * chase of running lights rather than a ring that blinks as one. Pure and
   * public so the animation can be asserted without pixel inspection; the
   * saucer's draw calls this exact method.
   *
   * @param index — running-light index (0 … {@link MYSTERY_UFO_DRONE_LIGHT_COUNT}−1).
   */
  getRunningLightAlpha(index: number): number {
    const wave =
      Math.sin(
        this._pulseTime * MYSTERY_UFO_DRONE_LIGHT_PULSE_SPEED +
          index * MYSTERY_UFO_DRONE_LIGHT_PULSE_PHASE_STEP,
      ) *
        0.5 +
      0.5;
    return (
      MYSTERY_UFO_DRONE_LIGHT_PULSE_MIN_ALPHA +
      (MYSTERY_UFO_DRONE_LIGHT_PULSE_MAX_ALPHA -
        MYSTERY_UFO_DRONE_LIGHT_PULSE_MIN_ALPHA) *
        wave
    );
  }

  /**
   * The alpha the under-hull drive glow is currently drawn with — a slower
   * breath than the running-light chase. Public for the same reason as
   * {@link MysteryUfoDrone.getRunningLightAlpha}.
   */
  get glowPulseAlpha(): number {
    const wave =
      Math.sin(
        this._pulseTime *
          MYSTERY_UFO_DRONE_LIGHT_PULSE_SPEED *
          MYSTERY_UFO_DRONE_GLOW_PULSE_SPEED_FACTOR,
      ) *
        0.5 +
      0.5;
    return (
      MYSTERY_UFO_DRONE_GLOW_PULSE_MIN_ALPHA +
      (MYSTERY_UFO_DRONE_GLOW_PULSE_MAX_ALPHA -
        MYSTERY_UFO_DRONE_GLOW_PULSE_MIN_ALPHA) *
        wave
    );
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

    // Every live tick starts with a clean collection list (a RETURN tick
    // therefore reports nothing to sparkle) and advances the pulse. The
    // pulse reuses the drone's own Graphics: no extra emitter per frame.
    this._collectedThisTick.length = 0;
    this._advancePulse(dt);

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

  /**
   * Draws the classic flying-saucer silhouette (AH-0MVH7ZC5N003JS92): a wide
   * elliptical rim with glowing running lights, a domed upper hull and a
   * small under-hull glow. Pure code-drawn geometry (no external art) from
   * {@link saucerGeometry}, so the game and every gym render the same saucer.
   *
   * The running lights and the under-hull glow are drawn from the live pulse
   * accessors, so a redraw on each tick animates them without any extra
   * GameObject (AH-0MVSAJZOI008TRBB).
   */
  private _drawBody(): void {
    this.clear();
    const g = saucerGeometry(this._size);

    // Under-hull glow (a soft disc beneath the rim suggests the saucer's
    // drive glow); its alpha breathes with the pulse.
    this.fillStyle(MYSTERY_UFO_DRONE_COLOR, this.glowPulseAlpha);
    this.fillEllipse(0, g.rimHalfHeight * 0.55, g.rimHalfWidth * 1.05, g.rimHalfHeight * 0.9);

    // Wide elliptical rim — the saucer's defining disc.
    this.lineStyle(2, MYSTERY_UFO_DRONE_COLOR, 1);
    this.strokeEllipse(0, 0, g.rimHalfWidth * 2, g.rimHalfHeight * 2);

    // Domed upper hull — a half-circle sitting on the rim.
    this.fillStyle(MYSTERY_UFO_DRONE_DOME_COLOR, 0.35);
    this.beginPath();
    this.arc(0, g.domeOffsetY, g.domeRadius, Math.PI, 0, false);
    this.closePath();
    this.fillPath();
    this.lineStyle(2, MYSTERY_UFO_DRONE_DOME_COLOR, 0.95);
    this.beginPath();
    this.arc(0, g.domeOffsetY, g.domeRadius, Math.PI, 0, false);
    this.closePath();
    this.strokePath();

    // Running lights around the rim — each light's alpha comes from the
    // per-index pulse so the ring reads as a chase of running lights.
    for (let i = 0; i < g.lights.length; i += 1) {
      const light = g.lights[i];
      this.fillStyle(MYSTERY_UFO_DRONE_LIGHT_COLOR, this.getRunningLightAlpha(i));
      this.fillCircle(light.x, light.y, light.radius);
    }

    // Rim accent band: a thin inner ellipse to read the disc's depth.
    this.lineStyle(1, MYSTERY_UFO_DRONE_COLOR, 0.5);
    this.strokeEllipse(
      0,
      g.rimHalfHeight * 0.15,
      g.rimHalfWidth * 1.45,
      g.rimHalfHeight * 1.15,
    );
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
   * radius, crediting each one's **worth** up to the remaining capacity.
   *
   * The hold grows by `min(mineral.value, capacity − held)`, so an ordinary
   * dot adds 1 and a red deposit worth {@link MINERAL_DEPOSIT_VALUE} adds at
   * most the free space left in the hold (AH-0MVJ79739008396I). A deposit
   * that does not fit is still removed from the field — the surplus is
   * destroyed with it, never left behind, never paid into the hold and never
   * credited elsewhere. Collected minerals are marked dead + hidden.
   *
   * @returns the number of minerals collected this tick (`> 0` ⇒ state `'collect'`).
   */
  private _vacuum(): number {
    let collected = 0;
    for (const mineral of this._targets) {
      if (!mineral.alive) continue;
      const remaining = this._capacity - this._heldMinerals;
      if (remaining <= 0) break;
      const r = this._collectorRadius;
      if (Math.hypot(mineral.x - this.x, mineral.y - this.y) <= r) {
        // Remove from the field without firing the player/absorb callbacks —
        // the shared pass reconciles the field and owns absorb VFX.
        mineral.alive = false;
        mineral.setVisible(false);
        // Record where it was taken from: the shared pass spawns the collect
        // sparkle at that spot this tick (AH-0MVSAJZOI008TRBB).
        this._collectedThisTick.push({ x: mineral.x, y: mineral.y });
        // Credit at most the free space: a deposit's surplus is lost.
        this._heldMinerals += Math.min(mineral.value, remaining);
        collected += 1;
      }
    }
    return collected;
  }

  /**
   * Advances the pulse clock and redraws the saucer's lights/glow.
   *
   * Called once per live tick (SEEK, COLLECT and RETURN alike), so the drone
   * never freezes into a static picture. The redraw reuses the drone's own
   * Graphics — the pulse adds no GameObject and no per-frame emitter.
   *
   * @param dt — elapsed time in seconds.
   */
  private _advancePulse(dt: number): void {
    this._pulseTime += dt;
    this._drawBody();
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

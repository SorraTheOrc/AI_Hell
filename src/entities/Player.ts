/**
 * Player ship entity — a single Graphics object rendering the neon
 * direction-neutral hexagon hull and (while thrusting) flames on the
 * engines opposing the thrust.
 *
 * Rendering is delegated to Phaser.GameObjects.Graphics so the ship is
 * one display-list object; physics is delegated to a pluggable movement
 * model (`utils/movementModel.ts`) selected by the control scheme.
 *
 * Two control schemes are supported (AH-0MTF0EFNZ000RPVD):
 * - `fourDirectional` (default): WASD/arrows map to up/down/left/right
 *   thrust; four cardinal engine ports fire flames opposite the thrust.
 * - `asteroids`: W/Up = forward thrust in the ship's facing direction,
 *   A/Left and S/Right rotate the ship; three engines render (main rear
 *   thruster + two 70% forward-side thrusters) and fire while forward
 *   thrust is held, visually rotating with the hull.
 *
 * Ship tuning values (size, colours, flame, thrust, max speed, scheme)
 * come from the config module (`core/config.ts`) — either injected at
 * construction or loaded from saved config — and can be live-updated via
 * `setConfig`. `setScheme` swaps the movement model and input shape at
 * runtime (AC3).
 *
 * The engine flames are animated per port: each flame grows from length 0
 * toward its component-scaled max `shipSize × thrustFlameLength × scale`
 * at a rate proportional to `thrustAcceleration`, and decays at 4× that
 * rate when its engine stops firing. A change of the pressed keys while
 * still thrusting (e.g. turning) restarts every flame as a fresh burst
 * from length 0 so a direction change is immediately legible; releasing
 * all keys keeps the decay path so the flames shrink away naturally.
 * The animation is driven per-frame from the delta time in `preUpdate`
 * (pure model in `utils/flame.ts`), so it is framerate-independent and
 * re-targets the current config live.
 *
 * Weapon system: the ship auto-fires its equipped weapon (GDD §2.3) in
 * the direction of movement — the current velocity heading, or the most
 * recent non-zero heading when stationary. Weapons are persistent
 * (no timer) until replaced by another weapon power-up (GDD §4.4). The
 * heading + bullet-pattern math lives in `utils/weapons.ts`; the Player
 * exposes `getHeading()`, `equipWeapon()`, `resetWeapon()`, and a fire
 * cooldown the scene gates bullet emission with.
 *
 * NOTE: instantiate with `scene.add.existing(player)` — like all Phaser
 * GameObjects, a Graphics built via `new` is not on the display list
 * until added to the scene.
 *
 * Per-frame updates use `preUpdate(time, delta)`: Phaser 4's UpdateList
 * invokes `preUpdate` (not `update`) on update-list members, and
 * `add.existing` only registers objects that define `preUpdate`.
 */

import Phaser from 'phaser';

import { loadShipConfig, ShipConfig } from '../core/config';

import {
  MovementState,
  MovementConfig,
} from '../utils/movement';
import { updateFlameLength } from '../utils/flame';
import {
  AsteroidsModel,
  ControlInput,
  ControlSchemeType,
  FourDirectionalModel,
  MovementModel,
} from '../utils/movementModel';
import {
  WeaponId,
  WEAPON_CATALOGUE,
  getWeaponById,
  computeHeading,
} from '../utils/weapons';

export interface PlayerConfig {
  x: number;
  y: number;
  /** Ship tuning values; defaults to the saved config when omitted. */
  config?: ShipConfig;
}

/**
 * Geometry of one engine port on the hull. Positions are expressed as
 * unit offsets from the hull centre (scaled by `r = shipSize / 2` at
 * draw time); `nx`/`ny` is the port's outward normal — the direction
 * its flame shoots in the ship's local frame (which rotates with the
 * hull in the Asteroids scheme). `arcStart`/`arcEnd` are the Phaser
 * arc angles (radians, 0 = right, positive = clockwise) of the small
 * quarter-circle indicator drawn at the port, centred on the outward
 * direction. `size` scales the whole thruster visual (1 = full,
 * 0.7 = 70% — the Asteroids forward-side thrusters, AC2).
 */
interface EnginePortDef {
  port: string;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  arcStart: number;
  arcEnd: number;
  size: number;
}

/** 4-directional scheme: cardinal engine ports (opportunity Q3a). */
const FOUR_DIR_ENGINES: ReadonlyArray<EnginePortDef> = [
  // top port — outward normal (0, -1): fires when thrusting down
  { port: 'top', dx: 0, dy: -1, nx: 0, ny: -1, arcStart: -Math.PI * 0.75, arcEnd: -Math.PI * 0.25, size: 1 },
  // bottom port — outward normal (0, +1): fires when thrusting up
  { port: 'bottom', dx: 0, dy: 1, nx: 0, ny: 1, arcStart: Math.PI * 0.25, arcEnd: Math.PI * 0.75, size: 1 },
  // left port — outward normal (-1, 0): fires when thrusting right
  { port: 'left', dx: -1, dy: 0, nx: -1, ny: 0, arcStart: Math.PI * 0.75, arcEnd: Math.PI * 1.25, size: 1 },
  // right port — outward normal (+1, 0): fires when thrusting left
  { port: 'right', dx: 1, dy: 0, nx: 1, ny: 0, arcStart: -Math.PI * 0.25, arcEnd: Math.PI * 0.25, size: 1 },
];

/**
 * Asteroids scheme: three engines in the ship's local frame (nose = +x,
 * which rotates to the facing angle via the Graphics rotation). One main
 * rear thruster opposite the direction of travel, plus two smaller (70%)
 * forward-side thrusters further forward on the hull (AC2).
 */
const ASTEROIDS_ENGINES: ReadonlyArray<EnginePortDef> = [
  // main rear thruster — opposite the nose (+x); flame shoots backward
  { port: 'main', dx: -1, dy: 0, nx: -1, ny: 0, arcStart: Math.PI * 0.75, arcEnd: Math.PI * 1.25, size: 1 },
  // forward-side thrusters — further forward on the hull, 70% size
  { port: 'leftSide', dx: 0.35, dy: -0.8, nx: -0.7071, ny: -0.7071, arcStart: -Math.PI, arcEnd: -Math.PI * 0.5, size: 0.7 },
  { port: 'rightSide', dx: 0.35, dy: 0.8, nx: -0.7071, ny: 0.7071, arcStart: Math.PI * 0.5, arcEnd: Math.PI, size: 0.7 },
];

/** Effective movement config: shared physics + scheme-specific rotation. */
type PlayerMovementConfig = MovementConfig & { rotationSpeed: number };

/**
 * The player ship renders as a cyan hexagon (flat top/bottom, centred
 * at its origin): a regular hexagon is invariant under 60° rotation,
 * so the hull never implies a heading (GDD §7.2 — geometric, angular
 * shapes; direction-neutral so thrust direction is read from the
 * engines' flames, not the silhouette). In the Asteroids scheme the
 * whole object (hull + engines) rotates by the facing angle so the
 * engine positions make the rotation visible (AC2).
 */
export class Player extends Phaser.GameObjects.Graphics {
  private _movementState: MovementState & { facing?: number };
  private _input: ControlInput;
  /** The active pluggable movement model for the current scheme (AC5). */
  private _model!: MovementModel;
  private _scheme: ControlSchemeType = 'fourDirectional';
  /** Animated flame length per engine port in px (0 = no flame drawn). */
  private _flameLens: Record<string, number> = {};
  /**
   * Optional fractional thrust components (dx positive = right, dy
   * positive = down), set via {@link setThrustComponents} for
   * analog/partial input (4-directional scheme only). When null, the
   * boolean {@link _input} drives engine selection (scale 1.0 per axis).
   */
  private _componentThrust: { dx: number; dy: number } | null = null;
  private _config: PlayerMovementConfig;

  /**
   * Nominal movement config (pre-multiplier). P5 Speed Boost scales
   * thrust + max-speed about these values via {@link setSpeedMultiplier}.
   */
  private _baseConfig: PlayerMovementConfig;

  /** Current live speed multiplier (1 = normal, 1.5 = P5 boosted). */
  private _speedMultiplier = 1;

  // ── Weapon system (AC1, AC2) ────────────────────────────────────

  /** Currently equipped weapon ID (defaults to cannon). */
  private _equippedWeapon: WeaponId = 'cannon';
  /** Most-recent heading in radians (fallback when stationary). */
  private _lastHeading: number | null = null;
  /** Fire cooldown in milliseconds before the next shot is allowed. */
  private _fireCooldown = 0;
  /** Default heading in radians when the ship has never moved (0 = right). */
  private _defaultHeading = 0;

  // Visual tuning — runtime-updatable (constructor or setConfig).
  private _shipSize: number;
  private _shipColor: number;
  private _flameColor: number;
  private _flameInnerColor: number;
  private _flameLength: number;

  constructor(scene: Phaser.Scene, config: PlayerConfig) {
    super(scene, { x: config.x, y: config.y });

    this._movementState = { x: config.x, y: config.y, vx: 0, vy: 0, facing: 0 };
    this._input = { up: false, down: false, left: false, right: false };

    // Use the injected config, else fall back to the saved config
    // (which itself falls back to the built-in defaults).
    const ship = config.config ?? loadShipConfig();

    this._shipSize = ship.shipSize;
    this._shipColor = ship.shipColor;
    this._flameColor = ship.thrustFlameColor;
    this._flameInnerColor = ship.thrustFlameInnerColor;
    this._flameLength = ship.thrustFlameLength;
    this._baseConfig = {
      thrust: ship.thrustAcceleration,
      maxSpeed: ship.maxSpeed,
      friction: ship.frictionDeceleration,
      rotationSpeed: ship.asteroidsRotationSpeed,
    };
    this._config = { ...this._baseConfig };

    // Set up the model and scheme directly (avoids double-draw in the
    // constructor — `setScheme` calls `_redraw` internally).
    this._scheme = ship.controlScheme;
    this._model =
      ship.controlScheme === 'asteroids'
        ? new AsteroidsModel()
        : new FourDirectionalModel();
    this._input =
      ship.controlScheme === 'asteroids'
        ? { forward: false, turnLeft: false, turnRight: false }
        : { up: false, down: false, left: false, right: false };
    this._flameLens = {};
    for (const port of this._engines()) this._flameLens[port.port] = 0;

    this._redraw();
  }

  // ── Engine port layout ───────────────────────────────────────────

  /** The engine port definitions for the active scheme. */
  private _engines(): ReadonlyArray<EnginePortDef> {
    return this._scheme === 'asteroids' ? ASTEROIDS_ENGINES : FOUR_DIR_ENGINES;
  }

  // ── Drawing helpers ──────────────────────────────────────────────

  private _half(multiplier: number): number {
    return (this._shipSize / 2) * multiplier;
  }

  /** Redraws the whole ship (body, plus flame when one is visible). */
  private _redraw(): void {
    this.clear();
    this.lineStyle(2, this._shipColor, 1);

    // Direction-neutral hexagon with flat top/bottom, centred at the
    // origin — invariant under 60° rotation. Circumradius = shipSize / 2
    // (the same half-size the chevron used), preserving `shipSize`
    // semantics for physics-adjacent callers.
    const r = this._half(1);
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

    // Small engine ports at the scheme's hull positions. Each is a
    // quarter-circle arc facing outward — the visual socket that engine
    // flames originate from (AC2). Port radius ≈ shipSize × 0.08 × size
    // (small but visible at default shipSize=20 → ~1.6px).
    const portR = this._shipSize * 0.08;
    for (const p of this._engines()) {
      this.arc(p.dx * r, p.dy * r, portR * p.size, p.arcStart, p.arcEnd, false);
    }

    this._drawFlame();
  }

  /**
   * Draws a flame from every engine port that is currently firing, each
   * animated length scaled by its thrust component (AC2/AC5).
   *
   * Each flame is anchored at its engine's port on the hull perimeter
   * (never the hull centre) and shoots along the port's outward normal —
   * i.e. away from the ship, opposite the thrust that fires it. In the
   * Asteroids scheme the normal is expressed in the ship's local frame,
   * so the flame rotates with the hull. Only ports with a visible
   * animated length draw anything, so no thrust input means no flames at
   * all (AC3).
   */
  private _drawFlame(): void {
    for (const port of this._engines()) {
      const flameLen = this._flameLens[port.port];
      if (flameLen > 0) {
        this._drawPortFlame(port, flameLen);
      }
    }
  }

  /** Draws one engine's flame (outer + inner triangle) at a port. */
  private _drawPortFlame(port: EnginePortDef, flameLen: number): void {
    const r = this._half(1);
    const ox = port.dx * r;
    const oy = port.dy * r;
    const nx = port.nx;
    const ny = port.ny;

    const tipX = ox + nx * flameLen;
    const tipY = oy + ny * flameLen;

    // Perpendicular for wing spread — scaled by the thruster size so the
    // forward-side (70%) thrusters render smaller flames (AC2).
    const wing = this._half(0.6) * port.size;
    const px = -ny * wing;
    const py = nx * wing;

    this.lineStyle(2, this._flameColor, 1);
    this.beginPath();
    this.moveTo(ox + px, oy + py);
    this.lineTo(tipX, tipY);
    this.lineTo(ox - px, oy - py);
    this.closePath();
    this.strokePath();

    // Inner flame — slightly smaller, brighter
    const innerWing = this._half(0.4) * port.size;
    const ipx = -ny * innerWing;
    const ipy = nx * innerWing;

    this.lineStyle(1, this._flameInnerColor, 1);
    this.beginPath();
    this.moveTo(ox + ipx, oy + ipy);
    this.lineTo(tipX, tipY);
    this.lineTo(ox - ipx, oy - ipy);
    this.closePath();
    this.strokePath();
  }

  // ── Input ────────────────────────────────────────────────────────

  /**
   * Sets the current control input. Accepts either input shape —
   * 4-directional `{ up, down, left, right }` or Asteroids
   * `{ forward, turnLeft, turnRight }` — the active model interprets
   * the shape matching its scheme (AC5).
   */
  setInput(input: ControlInput): void {
    const prev = { ...this._input };

    this._input = { ...input };

    // Boolean keys take over from any fractional component thrust.
    this._componentThrust = null;

    // A change in the set of pressed keys restarts the thrust flames as
    // a fresh burst from length 0 — but only while the ship is still
    // thrusting afterwards (a new direction is held). Releasing all
    // keys keeps the decay path so the flames shrink away naturally.
    const keysChanged = !this._inputsEqual(prev, input);
    if (keysChanged && this._model.getEngineActivity(
      this._movementState,
      input,
      null,
    ).length > 0) {
      for (const port of this._engines()) this._flameLens[port.port] = 0;
    }
  }

  getInput(): ControlInput {
    return { ...this._input };
  }

  private _inputsEqual(a: ControlInput, b: ControlInput): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if ((a as unknown as Record<string, boolean>)[k]
        !== (b as unknown as Record<string, boolean>)[k]
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Feeds fractional thrust components so each flame scales by its
   * component (e.g. up 0.5 + right 1.0 → a half-length bottom flame and
   * a full-length left flame). Maps to the same engine-firing rule as
   * {@link setInput} (the engine whose outward normal opposes each
   * component fires). 4-directional scheme only — a subsequent
   * {@link setInput} call takes over.
   */
  setThrustComponents(dx: number, dy: number): void {
    this._componentThrust = { dx, dy };
  }

  /**
   * Returns a copy of the current movement state (position + velocity,
   * plus facing when the active scheme tracks one). Exposed for tests
   * and the scene's magnet/speed integrations.
   */
  getMovementState(): MovementState & { facing?: number } {
    return { ...this._movementState };
  }

  // ── Control scheme (AC3, AC5) ────────────────────────────────────

  /**
   * Returns the active control scheme.
   */
  getScheme(): ControlSchemeType {
    return this._scheme;
  }

  /**
   * Swaps the pluggable movement model to `scheme`, resetting the input
   * to the scheme's neutral state and the flame animation to zero, then
   * re-draws. The ship keeps its position/velocity; only the control
   * interpretation (and the visual engine layout) changes.
   */
  setScheme(scheme: ControlSchemeType): void {
    if (scheme === this._scheme) {
      // Early return — no scheme change, no redraw needed here.
      // Callers (e.g. setConfig) perform their own redraw for tuning
      // changes, so we never double-draw.
      return;
    }
    this._scheme = scheme;
    this._model = scheme === 'asteroids' ? new AsteroidsModel() : new FourDirectionalModel();
    // Reset the input to the scheme-appropriate neutral shape.
    this._input = scheme === 'asteroids'
      ? { forward: false, turnLeft: false, turnRight: false }
      : { up: false, down: false, left: false, right: false };
    this._componentThrust = null;
    // Facing state: keep any existing velocity/position, reset facing
    // to 0 so the ship starts pointing right in Asteroids mode.
    this._movementState = { ...this._movementState, facing: 0 };
    // Reset flame animation for the current engine layout.
    this._flameLens = {};
    for (const port of this._engines()) this._flameLens[port.port] = 0;
    this.setRotation(0);
    this._redraw();
  }

  // ── Config ───────────────────────────────────────────────────────

  /**
   * Live-updates the ship's tuning values: physics (thrust, max speed,
   * rotation speed), scheme and rendering (size, colours, flame length),
   * re-drawing immediately.
   */
  setConfig(config: ShipConfig): void {
    this._shipSize = config.shipSize;
    this._shipColor = config.shipColor;
    this._flameColor = config.thrustFlameColor;
    this._flameInnerColor = config.thrustFlameInnerColor;
    this._flameLength = config.thrustFlameLength;
    this._baseConfig = {
      thrust: config.thrustAcceleration,
      maxSpeed: config.maxSpeed,
      friction: config.frictionDeceleration,
      rotationSpeed: config.asteroidsRotationSpeed,
    };
    this._applySpeedMultiplier();
    // Loading a saved config restores its control scheme (AC4). If the
    // scheme changed, setScheme already redrew with the new engine
    // layout; otherwise we redraw here for the tuning changes.
    const schemeChanged = config.controlScheme !== this._scheme;
    this.setScheme(config.controlScheme);
    if (!schemeChanged) {
      this._redraw();
    }
  }

  /**
   * Applies a live movement multiplier (P5 Speed Boost: +50%): thrust and
   * max-speed scale by `multiplier` about the nominal config; friction and
   * rendering are untouched. 1 = normal speed. Applied to physics only.
   */
  setSpeedMultiplier(multiplier: number): void {
    if (this._speedMultiplier === multiplier) return;
    this._speedMultiplier = multiplier;
    this._applySpeedMultiplier();
  }

  /**
   * Current effective movement config (multiplier applied). Exposed for
   * tests and the scene's magnet/speed integrations.
   */
  getMovementConfig(): MovementConfig {
    const { thrust, maxSpeed, friction } = this._config;
    return { thrust, maxSpeed, friction };
  }

  private _applySpeedMultiplier(): void {
    this._config = {
      thrust: this._baseConfig.thrust * this._speedMultiplier,
      maxSpeed: this._baseConfig.maxSpeed * this._speedMultiplier,
      friction: this._baseConfig.friction,
      rotationSpeed: this._baseConfig.rotationSpeed,
    };
  }

  // ── Heading ──────────────────────────────────────────────────────

  /**
   * Returns the ship's current heading in radians (0 = right,
   * positive = clockwise). In the Asteroids scheme this is the ship's
   * facing angle (the direction its nose points, AC1); in the
   * 4-directional scheme it is derived from the current velocity vector,
   * falling back to the most recent non-zero heading when stationary
   * (AC1, GDD §2.3).
   *
   * @returns Heading in radians.
   */
  getHeading(): number {
    const facing = this._model.getFacing(this._movementState);
    if (facing !== null) return this._normaliseAngle(facing);
    this._lastHeading = computeHeading(
      this._movementState.vx,
      this._movementState.vy,
      this._lastHeading,
      this._defaultHeading,
    );
    return this._lastHeading;
  }

  private _normaliseAngle(angle: number): number {
    return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  }

  // ── Weapon slot (AC1, AC2) ──────────────────────────────────────

  /**
   * Equips the given weapon.  The weapon persists (no timer) until
   * replaced by another weapon power-up (AC2).
   *
   * @param weaponId — The weapon to equip.
   */
  equipWeapon(weaponId: WeaponId): void {
    if (!WEAPON_CATALOGUE[weaponId]) {
      return;
    }
    this._equippedWeapon = weaponId;
    this._readyFire();
  }

  /**
   * Resets the equipped weapon to the starting Cannon (AC2 — Reset
   * power-up).  Called by the Reset power-up on collection.
   */
  resetWeapon(): void {
    this._equippedWeapon = 'cannon';
    this._readyFire();
  }

  /** Returns the currently equipped weapon ID. */
  getEquippedWeapon(): WeaponId {
    return this._equippedWeapon;
  }

  /**
   * Returns the weapon definition for the currently equipped weapon.
   */
  getWeaponDef(): ReturnType<typeof getWeaponById> {
    return getWeaponById(this._equippedWeapon);
  }

  // ── Auto-fire emission (AC1) ────────────────────────────────────

  /** Returns true if the weapon is ready to fire (cooldown elapsed). */
  isFireReady(): boolean {
    return this._fireCooldown <= 0;
  }

  /** Returns the current fire cooldown in milliseconds (0 = ready). */
  getFireCooldown(): number {
    return this._fireCooldown;
  }

  /**
   * Advances the fire cooldown by `dtMs` milliseconds, clamping at 0.
   *
   * @param dtMs — Delta time in milliseconds.
   */
  tickFireCooldown(dtMs: number): void {
    if (this._fireCooldown > 0) {
      this._fireCooldown = Math.max(0, this._fireCooldown - dtMs);
    }
  }

  /**
   * Attempts to fire the equipped weapon given `dt` seconds have elapsed.
   * Decrements the cooldown; when the cooldown has fully elapsed, sets
   * it to the weapon's fire rate and returns `true` — the caller emits
   * the bullet pattern this frame.
   *
   * @param dt — Delta time in seconds since the last call.
   * @returns true if a shot was ready to fire this frame.
   */
  tryFire(dt: number): boolean {
    const fireRateMs = this.getWeaponDef().fireRateMs;
    this._fireCooldown -= dt * 1000;
    if (this._fireCooldown > 0) return false;
    this._fireCooldown = fireRateMs;
    return true;
  }

  /** Resets the fire cooldown to zero, allowing an immediate next shot. */
  private _readyFire(): void {
    this._fireCooldown = 0;
  }

  // ── Scene lifecycle ──────────────────────────────────────────────

  /**
   * Called by Phaser's UpdateList each frame (Phaser 4 invokes
   * `preUpdate(time, delta)` — not `update()` — for update-list
   * members; `delta` is in milliseconds). Advances each engine's flame
   * animation with the frame delta so growth/shrink is
   * framerate-independent (AC4).
   *
   * Each engine the active movement model reports as firing grows toward
   * its component-scaled max length (`shipSize × thrustFlameLength ×
   * scale`, AC5); an engine that stops firing decays at 4× the growth
   * rate, so turning leaves no flame behind at the old port. In the
   * Asteroids scheme the three engines (main + two 70% forward-side)
   * fire at full scale while forward thrust is held (AC2).
   */
  preUpdate(_time: number, delta: number): void {
    const dt = delta / 1000;

    // Engines the current thrust fires, with their component scales
    // (fractional components when set, else the boolean keys at 1.0).
    const firing = this._model.getEngineActivity(
      this._movementState,
      this._input,
      this._componentThrust,
    );
    const scales: Record<string, number> = {};
    for (const port of this._engines()) scales[port.port] = 0;
    for (const f of firing) scales[f.engine] = f.scale;

    let changed = false;
    const baseMax = this._shipSize * this._flameLength;
    for (const port of this._engines()) {
      const scale = scales[port.port];
      const size = port.size;
      // While firing, the flame animates toward the component-scaled max
      // (AC5) scaled by the thruster's own size (70% for the forward-side
      // thrusters, AC2); when not firing, it decays toward 0 at 4× the
      // growth rate (maxLength = baseMax so the decay rate matches a
      // full-strength flame and never stalls at maxLength 0).
      const maxLength = scale > 0 ? baseMax * scale * size : baseMax;
      const nextLen = updateFlameLength(
        this._flameLens[port.port],
        {
          thrusting: scale > 0,
          maxLength,
          thrustAcceleration: this._config.thrust,
        },
        dt,
      );
      if (nextLen !== this._flameLens[port.port]) changed = true;
      this._flameLens[port.port] = nextLen;
    }

    // Redraw only when the visual could have changed: an engine length
    // moved (growing or decaying). Turning at full flame changes which
    // engines fire, so the affected lengths move on the next frame.
    if (changed) {
      this._redraw();
    }
  }

  /**
   * Largest current animated flame length across all engines in px
   * (0 = no flame drawn). Kept for backward compatibility with the
   * single-flame API; prefer {@link getFlameLengths} for per-engine state.
   */
  getFlameLength(): number {
    return Math.max(...Object.values(this._flameLens));
  }

  /**
   * Current animated flame length per engine port in px (0 = no flame).
   * Exposed as observable state so tests can verify per-engine
   * animation (and per-component scaling) without pixel assertions.
   */
  getFlameLengths(): Record<string, number> {
    return { ...this._flameLens };
  }

  /** Apply a physics tick and update the transform. */
  physicsTick(dt: number, width: number, height: number): void {
    this._movementState = this._model.tick(
      this._movementState,
      this._input,
      dt,
      width,
      height,
      this._config,
    );
    // Asteroids scheme: rotate the hull (and engines) to the facing
    // angle. 4-directional scheme returns null → rotation 0.
    const facing = this._model.getFacing(this._movementState);
    this.setRotation(facing ?? 0);
    this.setPosition(this._movementState.x, this._movementState.y);
  }

  /**
   * Relocates the ship to (x, y) with zero velocity and no flame — the
   * respawn behaviour used by scenes after the player takes a hit.
   */
  respawn(x: number, y: number): void {
    this._movementState = { x, y, vx: 0, vy: 0, facing: 0 };
    this.setRotation(0);
    this.setPosition(x, y);
    for (const port of this._engines()) this._flameLens[port.port] = 0;
  }
}
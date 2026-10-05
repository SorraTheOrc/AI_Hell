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
 *   A/Left and D/Right rotate the ship; three engines render (main rear
 *   thruster + two 70% forward-side thrusters) and fire key-specifically
 *   (forward→main, turnLeft→rightSide, turnRight→leftSide), visually
 *   rotating with the hull. (AH-0MTFORPJ2003RWWQ)
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
 * Weapon system: the ship auto-fires all active weapons (GDD §2.3) in
 * the direction of movement — the current velocity heading, or the most
 * recent non-zero heading when stationary. Weapons are **cumulative and
 * timed** (GDD §4.4 revision): the permanent cannon plus every collected
 * weapon power-up (Spread/Dual/Rapid), each with its own independent
 * 10-second countdown from the moment of collection, after which it
 * silently expires and stops firing. The heading + bullet-pattern math
 * lives in `utils/weapons.ts`; the Player exposes `getHeading()`,
 * `equipWeapon()` (adds), `resetWeapon()` (clears timed weapons),
 * `tickWeaponTimers()`, and a shared **beat clock** that gates bullet
 * emission.
 *
 * Weapons are also **constantly upgradable** (parent AH-0MUPMPCB2009J54J):
 * each weapon carries a run-scoped **level** that every collection raises.
 * `getWeaponLevel()` reports it and `getWeaponDef()` returns a
 * level-resolved definition; `resetWeapon` keeps levels while
 * `resetWeaponLevels()` clears them on run restart.
 *
 * Fire timing is **globally quantised to an 80 BPM beat**
 * (AH-0MUAYB8EH005RJ8B): every active weapon's shots land on a tick of one
 * shared beat grid, phase-locked to the clock anchor, so simultaneously
 * active weapons stay in phase and never drift relative to collection time
 * or frame rate. A weapon collected mid-beat fires its first shot on the
 * next grid tick (by design). The grid math is pure
 * (`utils/beat.ts`); the clock advances with game time and pauses with the
 * game.
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
import { stopThrusterSound, updateThrusterSound } from '../audio/effects';
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
  isTimedWeapon,
  computeHeading,
  weaponFireRateMs,
  type WeaponDefinition,
} from '../utils/weapons';
import { resolveWeaponAtLevel, resolveWeaponDefinition, quantiseFireRateMs } from '../utils/weaponLevels';
import { BeatClock, createBeatClock } from '../utils/beat';
import { loadRules, type GameRules } from '../core/rules';
import { WEAPON_TIMEOUT_MS } from '../core/constants';
import { type PowerUpId } from '../powerups/types';
import { PowerUpLevelStore } from '../powerups/powerUpLevels';

/** Floating-point slack (ms) when comparing the beat clock against a grid tick. */
const BEAT_EPSILON_MS = 1e-6;

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
type PlayerMovementConfig = MovementConfig & {
  rotationSpeed: number;
  rotationAcceleration: number;
  rotationDeceleration: number;
};

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
  private _movementState: MovementState & { facing?: number; angularVelocity?: number };
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
  /** Current live fire-rate multiplier (1 = normal, 1.5 = P5 boosted). */
  private _fireRateMultiplier = 1;

  // ── Weapon system (AC1–AC4) ─────────────────────────────────────
  // Cumulative model: the permanent cannon plus any collected timed
  // weapons (Spread/Dual/Rapid), each with its own independent 10 s
  // countdown from collection. Fire timing is phase-locked to a shared
  // beat clock (AH-0MUAYB8EH005RJ8B) rather than per-weapon free-running
  // cooldowns, so every active weapon fires on the same 80 BPM grid.

  /** Permanent weapons — always active, never expire (cannon + chosen permanents). */
  private readonly _permanentWeapons: Set<WeaponId> = new Set(['cannon']);
  /** Collected timed weapons → remaining lifetime in ms (10 s each, independent countdown). */
  private _weaponTimers: Map<WeaponId, number> = new Map();
  /**
   * Run-scoped **level** of each weapon (weapon leveling, parent
   * AH-0MUPMPCB2009J54J). Uncollected weapons are absent (level 0 = base).
   * A collection levels the weapon up; the level persists across a weapon
   * timing out (AC3) and across a Reset (AC6), and is cleared only by
   * {@link resetWeaponLevels} on run restart (AC7).
   */
  private _weaponLevels: Map<WeaponId, number> = new Map();
  /** Run-scoped power-up level store — every collection levels the power-up (parent AH-0MUV5CLVO002ZHS9). */
  private _powerUpLevelStore: PowerUpLevelStore = new PowerUpLevelStore();
  /** Absolute beat-clock time (ms, a grid tick) of each active weapon's next shot. */
  private _weaponNextShot: Map<WeaponId, number> = new Map();
  /** Beat-clock time (ms, a grid tick) of each active weapon's most recent shot. */
  private _weaponLastShot: Map<WeaponId, number> = new Map();
  /**
   * Live game rules — BPM and per-weapon beat subdivisions (defaults to the
   * persisted rules). Fire intervals are derived from these, so a config
   * change changes the cadence (AH-0MUAYB8EH005RJ8B).
   */
  private _rules: GameRules = loadRules();
  /** Shared beat clock driving phase-locked auto-fire (anchored at player start). */
  private _beatClock: BeatClock = createBeatClock({ bpm: this._rules.beatBpm });
  /** Most-recently collected weapon (primary view); falls back to cannon. */
  private _primaryWeapon: WeaponId = 'cannon';
  /** Most-recent heading in radians (fallback when stationary). */
  private _lastHeading: number | null = null;
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

    this._movementState = { x: config.x, y: config.y, vx: 0, vy: 0, facing: 0, angularVelocity: 0 };
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
      rotationAcceleration: ship.asteroidsRotationAcceleration,
      rotationDeceleration: ship.asteroidsRotationDeceleration,
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

    // Anchor the permanent cannon's first shot on the beat grid at t=0.
    this._readyFire('cannon');

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
  getMovementState(): MovementState & { facing?: number; angularVelocity?: number } {
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
    // to 0 so the ship starts pointing right in Asteroids mode (and
    // zero the angular velocity so no residual spin carries over).
    this._movementState = { ...this._movementState, facing: 0, angularVelocity: 0 };
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
      rotationAcceleration: config.asteroidsRotationAcceleration,
      rotationDeceleration: config.asteroidsRotationDeceleration,
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
   * Applies a live fire-rate multiplier (P5 Speed Boost: +50% rate of fire).
   * The effective fire interval is divided by `multiplier`, so the ship fires
   * `multiplier`× as often — and every active weapon is re-scheduled on the
   * new interval grid so shots stay phase-locked (no drift) after the
   * change. 1 = normal fire rate.
   */
  setFireRateMultiplier(multiplier: number): void {
    if (this._fireRateMultiplier === multiplier) return;
    this._fireRateMultiplier = multiplier;
    const now = this._beatClock.now();
    for (const weaponId of this.getActiveWeapons()) {
      const interval = this._effectiveInterval(weaponId);
      let scheduled = this._beatClock.nextTick(interval);
      if (scheduled <= now + BEAT_EPSILON_MS) scheduled += interval;
      this._weaponNextShot.set(weaponId, scheduled);
    }
  }

  /**
   * Applies live game rules (BPM + per-weapon beat subdivisions) and
   * re-schedules every active weapon on the new grid, so a config change
   * immediately changes the firing cadence (AH-0MUAYB8EH005RJ8B). Mirrors
   * the `setConfig` hot-reload pattern.
   */
  setRules(rules: GameRules): void {
    this._rules = rules;
    for (const weaponId of this.getActiveWeapons()) {
      this._readyFire(weaponId);
    }
  }

  /**
   * Current live fire-rate multiplier (1 = normal, 1.5 = P5 boosted).
   * Exposed so scenes and tests can verify the applied multiplier without
   * inferring it from fire timing.
   */
  getFireRateMultiplier(): number {
    return this._fireRateMultiplier;
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
      rotationAcceleration: this._baseConfig.rotationAcceleration,
      rotationDeceleration: this._baseConfig.rotationDeceleration,
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

  // ── Weapon collection (AC1–AC4) ─────────────────────────────────

  /**
   * Returns the ids of all currently active weapons — the permanent
   * cannon plus every collected timed weapon that has not yet expired
   * (cannon first, then collected weapons in collection order). AC1.
   */
  getActiveWeapons(): WeaponId[] {
    return [...this._permanentWeapons, ...this._weaponTimers.keys()];
  }

  /**
   * Returns true when the given weapon is currently active (in the
   * collection, or the permanent cannon).
   */
  hasWeapon(weaponId: WeaponId): boolean {
    return this._permanentWeapons.has(weaponId) || this._weaponTimers.has(weaponId);
  }

  /**
   * Collects a weapon power-up: **adds** it to the active set with a
   * fresh 10-second countdown (AC1, AC2 — collection is cumulative, no
   * replacement). Re-collecting an already-active timed weapon resets
   * only that weapon's own timer; other weapons are unaffected. The
   * cannon is permanent and collecting it is a no-op.
   *
   * @param weaponId — The weapon power-up to add ('spread' | 'dual' | 'rapid').
   * @param permanent — When true, the weapon is granted permanently for the
   *   current run (used by the hold-full choice) and never expires.
   *
   * Both temporary and permanent collections **level the weapon up** (AC2);
   * the level persists for the run (AC3, AC6).
   */
  equipWeapon(weaponId: WeaponId, permanent = false): void {
    if (!isTimedWeapon(weaponId)) {
      return; // cannon is always active and never times out (AC2)
    }
    if (!WEAPON_CATALOGUE[weaponId]) {
      return;
    }
    // Every collection levels the weapon up (AC2): a temporary drop and a
    // permanent mineral choice both raise the run-scoped level. The level is
    // retained across timeouts (AC3) and Resets (AC6); only a run restart
    // clears it (AC7, `resetWeaponLevels`).
    this._weaponLevels.set(weaponId, this.getWeaponLevel(weaponId) + 1);
    if (permanent) {
      // Permanent for the run: active forever, no countdown to tick down.
      this._permanentWeapons.add(weaponId);
      this._weaponTimers.delete(weaponId);
      this._weaponNextShot.delete(weaponId);
      this._weaponLastShot.delete(weaponId);
      this._primaryWeapon = weaponId;
      this._readyFire(weaponId);
      return;
    }
    // Fresh independent 10 s countdown from the moment of collection (AC2).
    this._weaponTimers.set(weaponId, WEAPON_TIMEOUT_MS);
    this._primaryWeapon = weaponId;
    this._readyFire(weaponId);
  }

  /**
   * Clears all timed weapons (Spread, Dual, Rapid), leaving only the
   * permanent cannon (AC4 — Reset power-up). The Reset power-up itself
   * is never a weapon and is never added to the active set.
   *
   * Also clears any hold-full choice weapons granted permanently for the
   * run — a Reset returns the ship to the bare cannon.
   *
   * **Levels are retained** (AC6): a Reset stops the weapons firing but
   * keeps the run's upgrade progress, so re-collecting a weapon later
   * re-activates it at the same level. Only a run restart clears levels
   * ({@link resetWeaponLevels}).
   */
  resetWeapon(): void {
    this._weaponTimers.clear();
    this._weaponNextShot.clear();
    this._weaponLastShot.clear();
    this._permanentWeapons.clear();
    this._permanentWeapons.add('cannon');
    this._primaryWeapon = 'cannon';
    this._readyFire('cannon');
  }

  /**
   * Returns the run-scoped level of a weapon: `0` for a never-collected
   * weapon (the base, un-upgraded state), otherwise the number of times it
   * has been collected (AC5). Levels are unbounded.
   *
   * @param weaponId — The weapon whose level to read.
   */
  getWeaponLevel(weaponId: WeaponId): number {
    return this._weaponLevels.get(weaponId) ?? 0;
  }

  /**
   * Snapshot of every weapon the player has collected this run, with its
   * current level (id → level ≥ 1). Used by the hold-full choice to offer
   * weapon level-ups that reflect the run's progress (parent
   * AH-0MUPMPCB2009J54J). A never-collected weapon is omitted (level 0).
   */
  getWeaponLevels(): Array<{ id: WeaponId; level: number }> {
    return [...this._weaponLevels.entries()]
      .filter(([, level]) => level > 0)
      .map(([id, level]) => ({ id, level }));
  }

  /**
   * The **resolver level** for a weapon: the number of *upgrades* applied,
   * i.e. `collections − 1` (AC8). The first collection unlocks the weapon at
   * its base stats (level 1 = base, matching the pre-leveling timed-drop
   * behaviour); each further collection applies the next upgrade.
   */
  private _weaponUpgradeIndex(weaponId: WeaponId): number {
    return Math.max(0, this.getWeaponLevel(weaponId) - 1);
  }

  /**
   * Clears every weapon level back to base — the run-scoped reset performed
   * on run restart (AC7). Distinct from {@link resetWeapon}, which clears
   * only timed *activations* and deliberately retains levels (AC6).
   */
  resetWeaponLevels(): void {
    this._weaponLevels.clear();
  }

  /**
   * Collects a power-up: increments its run-scoped level (every
   * collection levels the power-up up, parent AH-0MUV5CLVO002ZHS9).
   * For `permanent` (hold-full) rewards, the permanent-grant count
   * also increments — relevant for P9/P10 hybrid semantics.
   *
   * @param id — The power-up collected.
   * @param permanent — True for a hold-full permanent reward.
   * @returns The new collection level.
   */
  collectPowerUp(id: PowerUpId, permanent = false): number {
    return this._powerUpLevelStore.collect(id, permanent);
  }

  /** The run-scoped collection level of `id` (0 when never collected). */
  getPowerUpLevel(id: PowerUpId): number {
    return this._powerUpLevelStore.getLevel(id);
  }

  /**
   * The player's single run-scoped power-up level store. Scenes inject this
   * **same instance** into their `EffectsRegistry` so the effect path and the
   * hold-full choice consume one level model with no double-counting
   * (AH-0MUV5CLW6005VF7K, Q1=A).
   */
  getPowerUpLevelStore(): PowerUpLevelStore {
    return this._powerUpLevelStore;
  }

  /**
   * Snapshot of every power-up the player has collected this run, with its
   * current level (id → level ≥ 1). Used by the hold-full choice to offer
   * power-up level-ups that reflect the run's progress (AH-0MUV5CLVO002ZHS9).
   * A never-collected power-up is omitted (level 0).
   */
  getPowerUpLevels(): Array<{ id: PowerUpId; level: number }> {
    return this._powerUpLevelStore.getLevels();
  }

  /**
   * Clears every power-up level back to base — the run-scoped reset
   * performed on run restart. Distinct from {@link resetWeapon}, which
   * clears only timed *activations* and deliberately retains levels.
   */
  resetPowerUpLevels(): void {
    this._powerUpLevelStore.reset();
  }

  /**
   * Returns the most-recently collected timed weapon, or 'cannon' when
   * no timed weapons are active. Backward-compatible single-weapon view
   * (used by scene audio cues and legacy callers).
   */
  getEquippedWeapon(): WeaponId {
    return this._primaryWeapon;
  }

  /**
   * Returns the **level-resolved** weapon definition for a given weapon id,
   * defaulting to the most-recently collected weapon (backward-compatible
   * no-arg form) (AC4).
   *
   * A weapon at level 0/1 returns the base catalogue definition unchanged
   * (AC8): the first collection unlocks the weapon at its base stats, and
   * each *further* collection applies the next upgrade. At upgrade index ≥ 1
   * the scalar and pattern variables are applied to a copy: `fireRateMs`
   * (quantised to the beat grid), `offsets` (projectile count / spread),
   * `bulletSize` and `bulletLifetime` multipliers, and the AOE descriptor's
   * `radius` for AOE weapons.
   *
   * @param weaponId — Weapon to look up (defaults to the primary weapon).
   */
  getWeaponDef(weaponId?: WeaponId): WeaponDefinition {
    const id = weaponId ?? this._primaryWeapon;
    return resolveWeaponDefinition(id, this._weaponUpgradeIndex(id));
  }

  /**
   * Advances every timed weapon's countdown by `dtMs` milliseconds and
   * removes (silently drops) any weapon whose 10-second timer has fully
   * elapsed — it stops firing immediately (AC2, AC5). The permanent
   * cannon never expires. Safe no-op with no timed weapons active.
   *
   * @param dtMs — Delta time in milliseconds.
   */
  tickWeaponTimers(dtMs: number): void {
    if (dtMs <= 0 || this._weaponTimers.size === 0) return;
    for (const [id, remaining] of [...this._weaponTimers]) {
      const next = remaining - dtMs;
      if (next <= 0) {
        this._weaponTimers.delete(id);
        this._weaponNextShot.delete(id);
        this._weaponLastShot.delete(id);
        if (this._primaryWeapon === id) {
          // Fall back to the most recently collected remaining weapon.
          const stillActive = [...this._weaponTimers.keys()];
          this._primaryWeapon = stillActive.length > 0
            ? stillActive[stillActive.length - 1]
            : 'cannon';
        }
      } else {
        this._weaponTimers.set(id, next);
      }
    }
  }

  // ── Auto-fire emission (AC1–AC3) ─────────────────────────────────

  /**
   * Effective fire interval for a weapon in ms — its configured beat
   * subdivision (`weaponSubdivisions` + `beatBpm` from the game rules),
   * scaled by the live fire-rate multiplier (P5 Speed Boost: `/1.5` fires
   * 50 % more often). At the default multiplier of 1 every interval is an
   * exact subdivision of the beat period (AH-0MUAYB8EH005RJ8B).
   */
  private _effectiveInterval(weaponId: WeaponId): number {
    const baseInterval = weaponFireRateMs(
      weaponId,
      this._rules.weaponSubdivisions,
      this._rules.beatBpm,
    );
    // Weapon leveling raises the fire rate on each *upgrade* (the second and
    // later collections; the first collection is base — AC8). Divide by the
    // upgrade's fire-rate multiplier, then re-quantise so the leveled cadence
    // stays on the shared beat grid (parent AH-0MUPMPCB2009J54J). At upgrade
    // index 0 the multiplier is 1 and the base interval is already on-grid,
    // so this is a no-op and the existing cadence (and P5 behaviour) is
    // unchanged.
    const upgradeIndex = this._weaponUpgradeIndex(weaponId);
    const levelMultiplier =
      upgradeIndex > 0
        ? resolveWeaponAtLevel(weaponId, upgradeIndex).fireRate
        : 1;
    const leveledInterval = quantiseFireRateMs(
      baseInterval / levelMultiplier,
      this._rules.beatBpm,
    );
    return leveledInterval / this._fireRateMultiplier;
  }

  /**
   * The current effective fire interval (ms) for `weaponId`, derived from
   * the configured BPM/subdivision and scaled by the live fire-rate
   * multiplier. Exposed so tests and scenes can observe the configured
   * cadence directly.
   */
  getFireInterval(weaponId: WeaponId): number {
    return this._effectiveInterval(weaponId);
  }

  /**
   * Advances the shared beat clock by `dt` seconds and returns the ids of
   * the weapons that fired this frame — i.e. whose next scheduled grid tick
   * has been reached (AC1).
   *
   * Every active weapon's next shot is the smallest multiple of its
   * (multiplier-scaled) interval at/after the current clock time, relative
   * to the shared anchor, so all simultaneously active weapons are
   * **phase-locked** to one grid and never drift (AC2). A weapon collected
   * mid-beat therefore waits for the next grid tick to fire (AC3). The shot
   * is attributed to the latest elapsed tick and the following tick is
   * scheduled, so phase cannot drift even across dropped frames.
   *
   * @param dt — Delta time in seconds since the last call.
   * @returns The ids of the weapons that fired this frame.
   */
  tryFire(dt: number): WeaponId[] {
    const now = this._beatClock.advance(dt * 1000);
    const fired: WeaponId[] = [];
    for (const weaponId of this.getActiveWeapons()) {
      const interval = this._effectiveInterval(weaponId);
      let next = this._weaponNextShot.get(weaponId);
      if (next === undefined) {
        next = this._beatClock.nextTick(interval);
        this._weaponNextShot.set(weaponId, next);
      }
      if (next <= now + BEAT_EPSILON_MS) {
        fired.push(weaponId);
        const shotTick = this._beatClock.shotTimeFor(interval);
        this._weaponLastShot.set(weaponId, shotTick);
        this._weaponNextShot.set(weaponId, shotTick + interval);
      }
    }
    return fired;
  }

  /** Schedules one weapon's next shot on the shared beat grid (next tick at/after now). */
  private _readyFire(weaponId: WeaponId): void {
    this._weaponNextShot.set(
      weaponId,
      this._beatClock.nextTick(this._effectiveInterval(weaponId)),
    );
  }

  /**
   * The shared beat clock driving phase-locked auto-fire
   * (AH-0MUAYB8EH005RJ8B). Scenes read/share this single instance so player
   * fire is anchored to one grid and the clock advances with game time.
   */
  getBeatClock(): BeatClock {
    return this._beatClock;
  }

  /**
   * Replaces the beat clock — e.g. with a scene-owned shared instance — and
   * re-schedules every active weapon on the new grid so phase-locking is
   * preserved.
   */
  setBeatClock(clock: BeatClock): void {
    this._beatClock = clock;
    this._weaponLastShot.clear();
    for (const weaponId of this.getActiveWeapons()) {
      this._readyFire(weaponId);
    }
  }

  /**
   * Beat-clock time (ms) of `weaponId`'s most recent shot — always an exact
   * grid tick. Observable so tests and scene harnesses can verify every
   * emitted shot lands on the beat without inferring it from bullet timing.
   */
  getLastShotTime(weaponId: WeaponId): number | undefined {
    return this._weaponLastShot.get(weaponId);
  }

  /**
   * Beat-clock time (ms) of `weaponId`'s next scheduled shot — always an
   * exact grid tick. Observable for phase-locking tests.
   */
  getNextShotTime(weaponId: WeaponId): number | undefined {
    return this._weaponNextShot.get(weaponId);
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
   *
   * Also drives the thruster hum (AH-0MTFOSOHN001Q620) via
   * `getEngineSoundLevel(state, input, thrustAcceleration)` →
   * `updateThrusterSound(level)`: a single ship-level hum scaled
   * proportionally to thrustAcceleration so the slider is audible.
   * Safe no-op without an AudioContext (headless tests, autoplay).
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

    // Drive the thruster hum from the movement model level. One call per
    // frame regardless of flame changes — the audio module's gain envelope
    // handles fade-in/decay internally; 0 silences and decays the hum,
    // retriggering ramps from the current gain so rapid toggling is clean.
    try {
      const level = this._model.getEngineSoundLevel(
        this._movementState,
        this._input,
        this._config.thrust,
      );
      updateThrusterSound(level);
    } catch {
      // Never crash the game loop on an audio error.
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
   * Also silences any active thruster hum (AC5 — no orphaned audio on
   * destroy/respawn or scene switch).
   */
  respawn(x: number, y: number): void {
    this._movementState = { x, y, vx: 0, vy: 0, facing: 0, angularVelocity: 0 };
    this.setRotation(0);
    this.setPosition(x, y);
    for (const port of this._engines()) this._flameLens[port.port] = 0;
    try { stopThrusterSound(); } catch { /* ignore */ }
  }

  /**
   * Respawns the player at the **current** position and facing, with
   * velocity zeroed — used for the in-place respawn after a hit.
   * Preserves the ship's facing and rotation so the ship does not
   * appear to "snap" to a default direction (AC3).
   */
  respawnInPlace(): void {
    const facing = this._movementState.facing ?? 0;
    this._movementState = {
      x: this._movementState.x,
      y: this._movementState.y,
      vx: 0,
      vy: 0,
      facing,
      angularVelocity: 0,
    };
    this.setRotation(facing);
    this.setPosition(this._movementState.x, this._movementState.y);
    for (const port of this._engines()) this._flameLens[port.port] = 0;
    try { stopThrusterSound(); } catch { /* ignore */ }
  }

  /**
   * Stops the thruster hum — call on scene shutdown / scene switch so
   * no hum survives beyond the ship's lifecycle (AC5).
   * Safe no-op if no hum is active.
   */
  stopThrusterAudio(): void {
    try { stopThrusterSound(); } catch { /* ignore */ }
  }

  /**
   * Phaser lifecycle hook: called when the GameObject is destroyed.
   * Ensures the thruster hum is stopped so no AudioNodes survive.
   * Mirrors the respawn path (AC5).
   */
  override destroy(fromScene?: boolean): void {
    try { stopThrusterSound(); } catch { /* ignore */ }
    try { super.destroy(fromScene); } catch { /* ignore — no displayList in tests */ }
  }
}
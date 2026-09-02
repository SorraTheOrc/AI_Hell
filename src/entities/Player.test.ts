/**
 * Tests for the Player entity — verifies that the config module
 * integration wires thrust / maxSpeed through correctly, and that
 * setConfig live-tunes the physics at runtime.
 *
 * Uses the same Phaser-boot pattern as the gym scene tests (happy-dom
 * stubs canvas rendering; no pixel-level assertions needed) — the player
 * gym scene (`GymPlayer`) is booted directly so the ship entity is on
 * the display list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { ShipConfig, DEFAULT_CONFIG } from '../core/config';
import { Player } from './Player';
import { GymPlayer } from '../scenes/gym/GymPlayer';
import * as effects from '../audio/effects';

describe('Player ship entity', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  async function bootPlayerScene(): Promise<Phaser.Scene> {
    booted = await bootScene([GymPlayer]);
    return booted!.scene;
  }

  const playerOf = (scene: Phaser.Scene) => {
    const children = scene.sys.displayList.getChildren();
    return children.find((c) => c instanceof Player) as Player | undefined;
  };

  // ── Body shape (direction-neutral hexagon) ─────────────────────

  it('draws a direction-neutral hexagon hull: 6 edges at circumradius shipSize/2 (AC1+AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Capture the body path vertices as the renderer issues them.
    // Idle (no input) → only the hull is drawn, no flame commands.
    const moveTo = { x: 0, y: 0 };
    const vertices: Array<{ x: number; y: number }> = [];
    const moveToSpy = vi
      .spyOn(player!, 'moveTo')
      .mockImplementation((x: number, y: number) => {
        moveTo.x = x;
        moveTo.y = y;
        return player!;
      });
    const lineToSpy = vi
      .spyOn(player!, 'lineTo')
      .mockImplementation((x: number, y: number) => {
        vertices.push({ x, y });
        return player!;
      });

    // A redraw of the body: setConfig always re-draws immediately.
    player!.setConfig(DEFAULT_CONFIG);

    // Hexagon → exactly 6 edge segments (the old chevron had 4);
    // no flame is drawn while idle, so 6 is the whole hull.
    expect(lineToSpy).toHaveBeenCalledTimes(6);

    // AC2 — circumradius equals shipSize / 2 (default 20 → 10): every
    // vertex lies on a circle of radius 10 around the hull centre.
    // The explicit closing edge returns to the start vertex, so dedupe.
    const half = DEFAULT_CONFIG.shipSize / 2;
    const all: Array<{ x: number; y: number }> = [];
    for (const v of [{ x: moveTo.x, y: moveTo.y }, ...vertices]) {
      if (!all.some((p) => p.x === v.x && p.y === v.y)) all.push(v);
    }
    expect(all).toHaveLength(6);
    for (const v of all) {
      expect(Math.hypot(v.x, v.y)).toBeCloseTo(half, 5);
    }

    // AC1 — direction-neutral: a regular hexagon's vertices are spaced
    // exactly 60° apart, so the shape is invariant under 60° rotation
    // (and trivially under the required 90°).
    const angles = all
      .map((v) => Math.atan2(v.y, v.x))
      .sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i] - angles[i - 1]).toBeCloseTo(Math.PI / 3, 5);
    }

    moveToSpy.mockRestore();
    lineToSpy.mockRestore();
  });

  it('keeps the hull colour config-driven via setConfig (AC4)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const lineStyleSpy = vi.spyOn(player!, 'lineStyle');
    const recoloured = { ...DEFAULT_CONFIG, shipColor: 0xff00ff };
    player!.setConfig(recoloured);

    // The ship body is stroked with the new shipColor (lineStyle called
    // with width 2, the configured colour, alpha 1 — same neon style as
    // the chevron, no fill).
    expect(lineStyleSpy).toHaveBeenCalledWith(
      2,
      recoloured.shipColor,
      1,
    );
  });

  // ── Engine ports at the cardinal hull points (AC1+AC2) ─────────

  it('draws four small engine ports at the cardinal hull points (AC1+AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const arcSpy = vi.spyOn(player!, 'arc');
    player!.setConfig(DEFAULT_CONFIG); // full redraw of body + ports

    // AC1 — exactly four port indicators, one per cardinal point.
    expect(arcSpy).toHaveBeenCalledTimes(4);

    // Port positions use the hull radius (= shipSize / 2):
    // top (0, -r), bottom (0, +r), left (-r, 0), right (+r, 0).
    const r = DEFAULT_CONFIG.shipSize / 2;
    const centers = arcSpy.mock.calls.map((c) => ({ x: c[0], y: c[1] }));
    expect(centers).toContainEqual({ x: 0, y: -r });
    expect(centers).toContainEqual({ x: 0, y: r });
    expect(centers).toContainEqual({ x: -r, y: 0 });
    expect(centers).toContainEqual({ x: r, y: 0 });
  });

  // ── Flame originates from the opposing engine port (AC3) ─────────

  it('anchors the flame at the engine port opposing the thrust, not the hull centre (AC3)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const calls: Array<{ x: number; y: number }> = [];
    vi.spyOn(player!, 'moveTo').mockImplementation(
      (x: number, y: number) => {
        calls.push({ x, y });
        return player!;
      },
    );

    // Thrust right → the LEFT engine fires: its port sits at (-r, 0),
    // i.e. x = -10 with the default shipSize=20.
    player!.setInput({ up: false, down: false, left: false, right: true });
    player!.preUpdate(0, 500); // grow the flame → redraw draws it

    const r = DEFAULT_CONFIG.shipSize / 2;
    // Outer flame wing vertices sit at the port x-offset (-r), never at
    // the hull centre (x = 0). Exact vertex: (-r, -r*0.6)=(-10,-6).
    expect(calls).toContainEqual({ x: -r, y: -r * 0.6 });
    expect(calls.some((c) => c.x > -r - 0.001 && c.x < 0 && c.y === 0)).toBe(false);
  });

  // ── Per-engine flames (AH-0MTBOLP3Z005VRR9 AC1–AC5) ─────────────

  it('fires exactly the opposing engine on cardinal thrust (AC1)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Thrust right → the LEFT engine opposes it: it is the only port
    // with a flame, grown to the full default max (15px) after 0.5s.
    player!.setInput({ up: false, down: false, left: false, right: true });
    player!.preUpdate(0, 500);

    const lens = player!.getFlameLengths();
    expect(lens.left).toBeCloseTo(15, 2);
    expect(lens.right).toBe(0);
    expect(lens.top).toBe(0);
    expect(lens.bottom).toBe(0);
  });

  it('fires the two opposing engines on diagonal thrust (AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Up+right → bottom (opposing up) and left (opposing right) both
    // fire at full component scale.
    player!.setInput({ up: true, down: false, left: false, right: true });
    player!.preUpdate(0, 500);

    const lens = player!.getFlameLengths();
    expect(lens.bottom).toBeCloseTo(15, 2);
    expect(lens.left).toBeCloseTo(15, 2);
    expect(lens.top).toBe(0);
    expect(lens.right).toBe(0);
  });

  it('draws no flames from any port when no thrust key is held (AC3)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    player!.preUpdate(0, 500);
    expect(player!.getFlameLengths()).toEqual({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });
  });

  it('decays the old engine and grows the new one when turning at full flame', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500);
    expect(player!.getFlameLengths().bottom).toBeCloseTo(15, 2);

    // Turn to thrusting right: the bottom flame must fully decay and the
    // left flame grow — no lingering flame at the old port.
    player!.setInput({ up: false, down: false, left: false, right: true });
    player!.preUpdate(0, 500);

    const lens = player!.getFlameLengths();
    expect(lens.bottom).toBe(0);
    expect(lens.left).toBeCloseTo(15, 2);
  });

  it('targets each engine max at shipSize × thrustFlameLength × component scale (AC5)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Full component scale (1.0) → max = 20 × 1 × 1 = 20px for the left
    // engine (fractional component scales are unit-tested in
    // engineSelection.test.ts; here the wiring multiplies them in).
    player!.setConfig({ ...DEFAULT_CONFIG, shipSize: 20, thrustFlameLength: 1 });
    player!.setInput({ up: false, down: false, left: false, right: true });
    player!.preUpdate(0, 500);

    expect(player!.getFlameLengths().left).toBeCloseTo(20, 2);
  });

  // ── Child AH-0MTBOMP93002AC25: AC1/AC2/AC5 structural coverage ──
  // was provided inline by children 2–4 (hexagon 6-edge test,
  // 4-port arc test, no-thrust test above) to avoid duplicating them.
  // This child adds the remaining AC3/AC4 location assertions, the
  // fractional-component scaling test (AC6), and the setConfig
  // regression test (AC7).

  it('positions diagonal flames at the two opposing engine ports (AC4 location)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const calls: Array<{ x: number; y: number }> = [];
    vi.spyOn(player!, 'moveTo').mockImplementation(
      (x: number, y: number) => {
        calls.push({ x, y });
        return player!;
      },
    );

    // Up+right → bottom and left engines fire. The outer flame wing
    // vertices sit at the bottom port (−r·0.6, r) and the left port
    // (−r, −r·0.6).
    player!.setInput({ up: true, down: false, left: false, right: true });
    player!.preUpdate(0, 500);

    const r = DEFAULT_CONFIG.shipSize / 2;
    expect(calls).toContainEqual({ x: -r * 0.6, y: r });
    expect(calls).toContainEqual({ x: -r, y: -r * 0.6 });
  });

  it('scales diagonal flames by mixed components — up 0.5, right 1.0 (AC6)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Fractional thrust: dx=1 (right) and dy=−0.5 (up). The bottom
    // engine (opposing up) grows toward half the max length, the left
    // engine (opposing right) toward the full length.
    player!.setThrustComponents(1, -0.5);
    player!.preUpdate(0, 500);

    const lens = player!.getFlameLengths();
    expect(lens.left).toBeCloseTo(15, 2); // component 1.0 → full max
    expect(lens.bottom).toBeCloseTo(7.5, 2); // component 0.5 → half max
    expect(lens.top).toBe(0);
    expect(lens.right).toBe(0);
  });

  it('setConfig re-draws the hexagon body, ports, and flame colours live (AC7)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const lineToSpy = vi.spyOn(player!, 'lineTo');
    const arcSpy = vi.spyOn(player!, 'arc');
    const lineStyleSpy = vi.spyOn(player!, 'lineStyle');

    const retuned = {
      ...DEFAULT_CONFIG,
      shipColor: 0x00ff00,
      thrustFlameColor: 0xff0000,
      shipSize: 30,
    };
    player!.setConfig(retuned);

    // Body re-drawn with the new shipColor (6-edge hexagon, no fill)
    // and the four engine ports still present.
    expect(lineToSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(arcSpy).toHaveBeenCalledTimes(4);
    expect(lineStyleSpy).toHaveBeenCalledWith(2, retuned.shipColor, 1);
  });

  // ── Physics via config ───────────────────────────────────────────

  it('uses the loaded config for physics by default', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Start at centre y=270. Thrust up for 1 second.
    // maxSpeed=175: velocity clamps to 175 in 1 tick.
    // Position: 270 - 175 = 95 (no wrap).
    const startY = player!.y;
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.physicsTick(1, scene.scale.width, scene.scale.height);

    const yAfterThrust = player!.y;
    expect(yAfterThrust).not.toBe(startY);

    // With default maxSpeed=175 the ship should land at ~95.
    expect(yAfterThrust).toBeCloseTo(95, 0);
  });

  it('setConfig updates physics so max-speed clamping changes', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Reset to centre (zero velocity from game start).
    player!.setPosition(480, 270);

    // Set a very low maxSpeed.
    const lowConfig: ShipConfig = { ...DEFAULT_CONFIG, maxSpeed: 50 };
    player!.setConfig(lowConfig);

    // Thrust up 1 second. With maxSpeed=50: vy=-50, y=270-50=220.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.physicsTick(1, scene.scale.width, scene.scale.height);
    const yLowSpeed = player!.y;
    expect(yLowSpeed).toBeCloseTo(220, 0);

    // setConfig back to default maxSpeed=175.
    player!.setConfig(DEFAULT_CONFIG);

    // Thrust up 1 second again. With maxSpeed=175: vy=-175,
    // y=220-175=45 (no wrap).
    player!.physicsTick(1, scene.scale.width, scene.scale.height);
    const yDefaultSpeed = player!.y;
    expect(yDefaultSpeed).toBeCloseTo(45, 0);

    // The ship moved further upward (lower y) at default maxSpeed than
    // at the low maxSpeed, confirming setConfig changed the physics.
    expect(yDefaultSpeed).toBeLessThan(yLowSpeed);
  });

  // ── Thrust flame animation ───────────────────────────────────────

  it('starts with no flame (length 0), and idle frames do not animate it', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    expect(player!.getFlameLength()).toBe(0);

    // Idle frames with no input must not grow a flame.
    player!.preUpdate(0, 16);
    expect(player!.getFlameLength()).toBe(0);
  });

  it('grows the flame while thrusting and decays it at release (AC1 + AC3)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Default config: shipSize=20, thrustFlameLength=0.75 → max 15px;
    // growth time-to-full at 300 thrust = 0.03s.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500); // 0.5s of thrust → full length
    expect(player!.getFlameLength()).toBeCloseTo(15, 2);

    // Release: decay is 4× growth (2000 px/s) → back to 0 in ~0.008s.
    player!.setInput({ up: false, down: false, left: false, right: false });
    player!.preUpdate(0, 125);
    expect(player!.getFlameLength()).toBe(0);
  });

  it('reaches the full length with enough thrust, regardless of frame rate (AC4)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Growth is dt-based, so the frame rate does not matter: 0.5s of
    // thrust spread over many small frames reaches the same full length
    // (default config → max 15px) as a single 0.5s step.
    player!.setInput({ up: true, down: false, left: false, right: false });
    for (let i = 0; i < 32; i++) player!.preUpdate(0, 16); // 512 ms total
    expect(player!.getFlameLength()).toBeCloseTo(15, 2);

    // Held at full length: flame stays at max (no flicker/overshoot).
    player!.preUpdate(0, 16);
    expect(player!.getFlameLength()).toBe(15);
  });

  it('targets the current setConfig max length mid-growth (AC4)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 20); // 0.02s → 10px toward the default 15px max
    expect(player!.getFlameLength()).toBeLessThan(15);

    // Ship grows to 40px with flame multiplier 1 → new max 40px.
    player!.setConfig({ ...DEFAULT_CONFIG, shipSize: 40, thrustFlameLength: 1 });
    player!.preUpdate(0, 20); // continues growing past the old 15px ceiling
    const lenAfterRetarget = player!.getFlameLength();
    expect(lenAfterRetarget).toBeGreaterThan(15);
    expect(lenAfterRetarget).toBeLessThanOrEqual(40);

    // A smaller max set mid-growth clamps the flame immediately.
    player!.setConfig({ ...DEFAULT_CONFIG, thrustFlameLength: 0.1 }); // max = 2
    player!.preUpdate(0, 5);
    expect(player!.getFlameLength()).toBeLessThanOrEqual(2);
  });

  it('redraws while the flame animates and skips redraws when nothing changes (AC5)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const clearSpy = vi.spyOn(player!, 'clear');

    // Idle: length stays 0 → no redraw churn.
    player!.preUpdate(0, 16);
    expect(clearSpy).not.toHaveBeenCalled();

    // Thrust: the flame appears mid-growth (not toggle-drawn at full
    // length only), so a redraw happens immediately.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 16);
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // Not yet full length? still redraws while growing.
    player!.preUpdate(0, 16);
    expect(clearSpy).toHaveBeenCalledTimes(2);

    // At full length with unchanged direction → no further redraws.
    player!.preUpdate(0, 5000);
    clearSpy.mockClear();
    player!.preUpdate(0, 16);
    expect(clearSpy).not.toHaveBeenCalled();

    // Direction change at full length → redraw exactly once.
    player!.setInput({ up: false, down: false, left: true, right: false });
    player!.preUpdate(0, 16);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the flame on full decay (final redraw at length 0)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    const clearSpy = vi.spyOn(player!, 'clear');

    // Grow to full, then release and fully decay in one big step.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500);
    player!.setInput({ up: false, down: false, left: false, right: false });
    clearSpy.mockClear();
    player!.preUpdate(0, 125);

    expect(player!.getFlameLength()).toBe(0);
    // The length changed (→ 0), so the final redraw erased the flame.
    expect(clearSpy).toHaveBeenCalled();
  });

  // ── Fresh burst on key change ───────────────────────────────────

  it('resets the flame to 0 when the pressed keys change while thrusting (AC1)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Grow to full with Up held.
    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500);
    expect(player!.getFlameLength()).toBeCloseTo(15, 2);

    // Switching to Left while still thrusting → fresh burst from 0.
    player!.setInput({ up: false, down: false, left: true, right: false });
    player!.preUpdate(0, 0); // zero-delta change frame → exactly 0
    expect(player!.getFlameLength()).toBe(0);

    // Regrows from 0 in the new direction: 20ms × 500 px/s = 10px.
    player!.preUpdate(0, 20);
    expect(player!.getFlameLength()).toBeCloseTo(10, 1);
    expect(player!.getFlameLength()).toBeLessThan(15);
  });

  it('regrows from 0 at a rate proportional to thrustAcceleration after a key change (AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    // Force a fresh burst (key change), then measure regrowth over dtMs.
    const regrow = (thrustAcceleration: number, dtMs: number) => {
      player!.setConfig({ ...DEFAULT_CONFIG, thrustAcceleration });

      // Alternate keys so each call is a real key change → fresh burst.
      player!.setInput({ up: false, down: false, left: true, right: false });
      player!.preUpdate(0, 0);
      player!.setInput({ up: true, down: false, left: false, right: false });
      player!.preUpdate(0, 0); // change frame → exactly 0
      player!.preUpdate(0, dtMs);
      return player!.getFlameLength();
    };

    // Same dt, higher thrust → longer flame: 10ms at 500 vs 1000 px/s.
    const slow = regrow(300, 10); // ≈5px
    const fast = regrow(600, 10); // ≈10px
    expect(slow).toBeCloseTo(5, 1);
    expect(fast).toBeCloseTo(10, 1);
    expect(fast).toBeGreaterThan(slow);
  });

  it('releasing all keys still decays instead of resetting to 0 instantly (AC3)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 500); // full 15px
    expect(player!.getFlameLength()).toBeCloseTo(15, 2);

    // Release all keys → decay path (not an instant reset): a short
    // frame leaves a partial flame shrinking at 4× growth (2000 px/s).
    player!.setInput({ up: false, down: false, left: false, right: false });
    player!.preUpdate(0, 4); // 4ms × 2000 px/s = 8px removed → ~7px remain
    const mid = player!.getFlameLength();
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(15);

    // Fully decayed afterwards.
    player!.preUpdate(0, 100);
    expect(player!.getFlameLength()).toBe(0);
  });

  it('does not reset the flame while the same keys are held (AC4)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();

    player!.setInput({ up: true, down: false, left: false, right: false });
    player!.preUpdate(0, 0); // change frame → 0
    player!.preUpdate(0, 10);
    const first = player!.getFlameLength();

    // Same keys held → continues growing, never reset back to 0.
    player!.preUpdate(0, 10);
    const second = player!.getFlameLength();
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(15);

    player!.preUpdate(0, 10);
    const third = player!.getFlameLength();
    expect(third).toBeGreaterThan(second);
  });

  // ── Weapon system: heading, equip, auto-fire ─────────────────────

  it('starts equipped with the cannon weapon (AC1, AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();
    expect(player!.getEquippedWeapon()).toBe('cannon');
  });

  it('getHeading returns 0° (right) when stationary with no prior movement', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();
    // Ship starts at centre with zero velocity.
    player!.setPosition(480, 270);
    player!.setInput({ up: false, down: false, left: false, right: false });
    expect(player!.getHeading()).toBe(0);
  });

  it('getHeading derives heading from velocity when moving', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();
    player!.setPosition(480, 270);
    player!.setInput({ up: false, down: false, left: false, right: true });
    player!.physicsTick(1, scene.scale.width, scene.scale.height);

    // Moving right → heading should be 0°.
    expect(player!.getHeading()).toBe(0);
  });

  it('getHeading falls back to most-recent heading when stationary (AC7)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player).toBeDefined();
    player!.setPosition(480, 270);

    // Move right first → heading = 0°.
    player!.setInput({ up: false, down: false, left: false, right: true });
    player!.physicsTick(1, scene.scale.width, scene.scale.height);
    expect(player!.getHeading()).toBe(0);

    // Stop moving → heading should still be 0° (most-recent fallback).
    player!.setInput({ up: false, down: false, left: false, right: false });
    player!.physicsTick(0.5, scene.scale.width, scene.scale.height);
    expect(player!.getHeading()).toBe(0);
  });

  it('equipWeapon swaps to the given weapon (AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player!.getEquippedWeapon()).toBe('cannon');

    player!.equipWeapon('spread');
    expect(player!.getEquippedWeapon()).toBe('spread');

    player!.equipWeapon('rapid');
    expect(player!.getEquippedWeapon()).toBe('rapid');
  });

  it('resetWeapon returns to cannon (AC2)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    player!.equipWeapon('spread');
    expect(player!.getEquippedWeapon()).toBe('spread');

    player!.resetWeapon();
    expect(player!.getEquippedWeapon()).toBe('cannon');
  });

  it('getWeaponDef returns the correct definition for the equipped weapon', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);

    // Cannon: single bullet, 400 ms fire rate.
    expect(player!.getWeaponDef().id).toBe('cannon');
    expect(player!.getWeaponDef().offsets).toEqual([0]);
    expect(player!.getWeaponDef().fireRateMs).toBe(400);

    player!.equipWeapon('rapid');
    expect(player!.getWeaponDef().id).toBe('rapid');
    expect(player!.getWeaponDef().offsets).toEqual([0]);
    expect(player!.getWeaponDef().fireRateMs).toBe(125);
  });

  it('tryFire fires once then blocks until cooldown elapses (AC1)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    player!.equipWeapon('cannon'); // 400 ms fire rate

    // First call: ready to fire.
    const fired1 = player!.tryFire(0.5); // 500 ms > 400 ms → fires
    expect(fired1).toBe(true);

    // Second call immediately: cooldown not elapsed.
    const fired2 = player!.tryFire(0.1); // 100 ms < 400 ms → blocked
    expect(fired2).toBe(false);

    // After remaining cooldown: fires again.
    const fired3 = player!.tryFire(0.35); // 350 ms more → 450 ms total ≥ 400 ms
    expect(fired3).toBe(true);
  });

  it('tryFire with rapid weapon fires much faster (AC1)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    player!.equipWeapon('rapid'); // 125 ms fire rate

    // At 125 ms intervals, should fire every time.
    expect(player!.tryFire(0.125)).toBe(true);
    expect(player!.tryFire(0.125)).toBe(true);
    expect(player!.tryFire(0.125)).toBe(true);
  });

  it('tryFire with spread weapon blocks between shots (AC1)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    player!.equipWeapon('spread'); // 600 ms fire rate

    // First shot at 600 ms.
    expect(player!.tryFire(0.6)).toBe(true);
    // Next shot blocked at 100 ms.
    expect(player!.tryFire(0.1)).toBe(false);
    // After 500 ms more (total 1100 ms ≥ 600 ms), fires again.
    expect(player!.tryFire(0.5)).toBe(true);
  });

  it('tickFireCooldown decrements the cooldown (AC1)', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    player!.equipWeapon('cannon');

    // Fire once to set cooldown.
    player!.tryFire(0.5);
    expect(player!.getFireCooldown()).toBeGreaterThan(0);

    // Tick cooldown forward.
    player!.tickFireCooldown(100);
    expect(player!.getFireCooldown()).toBeLessThanOrEqual(300);
  });

  it('isFireReady returns true when cooldown has elapsed', async () => {
    const scene = await bootPlayerScene();
    await tick();

    const player = playerOf(scene);
    expect(player!.isFireReady()).toBe(true);

    player!.tryFire(0.5);
    expect(player!.isFireReady()).toBe(false);

    player!.tickFireCooldown(500);
    expect(player!.isFireReady()).toBe(true);
  });
});

// ── Asteroids control scheme (AC1, AC2, AC3, AC5) ───────────────────

describe('Player — Asteroids control scheme', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  async function bootPlayerScene(): Promise<Phaser.Scene> {
    booted = await bootScene([GymPlayer]);
    return booted!.scene;
  }

  const playerOf = (scene: Phaser.Scene) => {
    const children = scene.sys.displayList.getChildren();
    return children.find((c) => c instanceof Player) as Player | undefined;
  };

  async function bootAsteroidsPlayer(): Promise<Player> {
    const scene = await bootPlayerScene();
    await tick();
    const player = playerOf(scene);
    expect(player).toBeDefined();
    player!.setScheme('asteroids');
    return player as Player;
  }

  it('setScheme swaps the pluggable movement model (AC5)', async () => {
    const player = await bootAsteroidsPlayer();
    expect(player.getScheme()).toBe('asteroids');

    player.setScheme('fourDirectional');
    expect(player.getScheme()).toBe('fourDirectional');
  });

  it('draws three engine ports on the hull when in Asteroids mode (AC2)', async () => {
    const player = await bootAsteroidsPlayer();

    const arcSpy = vi.spyOn(player, 'arc');
    player.setConfig({ ...DEFAULT_CONFIG, controlScheme: 'asteroids' });

    // Three engines: main rear + two forward-side thrusters.
    expect(arcSpy).toHaveBeenCalledTimes(3);

    // Port radius = shipSize × 0.08 × size. Default shipSize 20:
    // main 1.6px; forward-side thrusters 20 × 0.08 × 0.7 = 1.12px (70%).
    const radii = arcSpy.mock.calls.map((call) => call[2] as number);
    expect(Math.max(...radii)).toBeCloseTo(1.6, 5);
    const small = radii.filter((r) => r < 1.6);
    expect(small).toHaveLength(2);
    for (const r of small) expect(r).toBeCloseTo(1.12, 5);
  });

  it('rotates by rotationSpeed while a turn key is held (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    // Default rotationSpeed 3 rad/s → 1s turn right = 3 rad.
    player.setInput({ forward: false, turnLeft: false, turnRight: true });
    player.physicsTick(1, 960, 540);

    expect(player.getHeading()).toBeCloseTo(3, 5);
    expect(player.rotation).toBeCloseTo(3, 5);

    // Turn left 1s back toward 0.
    player.setInput({ forward: false, turnLeft: true, turnRight: false });
    player.physicsTick(1, 960, 540);
    expect(player.getHeading()).toBeCloseTo(0, 3);
  });

  it('wraps the rotation speed via the config slider (AC3)', async () => {
    const player = await bootAsteroidsPlayer();
    player.setConfig({
      ...DEFAULT_CONFIG,
      controlScheme: 'asteroids',
      asteroidsRotationSpeed: 6,
    });

    player.setInput({ forward: false, turnLeft: false, turnRight: true });
    player.physicsTick(1, 960, 540);
    expect(player.getHeading()).toBeCloseTo(6, 5);
  });

  it('thrusts in the facing direction when forward is held (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    // No rotation → facing 0 (right).
    player.setInput({ forward: true, turnLeft: false, turnRight: false });
    const x0 = player.x;
    player.physicsTick(1, 960, 540);
    expect(player.x).toBeGreaterThan(x0); // moved right
    expect(player.y).toBeCloseTo(270); // no vertical motion
  });

  it('accelerates along the current facing after turning (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    // Turn right for 0.5s → facing ≈ 1.5 rad; then thrust forward 1s.
    player.setInput({ forward: false, turnLeft: false, turnRight: true });
    player.physicsTick(0.5, 960, 540);
    player.setInput({ forward: true, turnLeft: false, turnRight: false });
    player.physicsTick(1, 960, 540);

    // Velocity direction matches the facing angle (screen coords).
    const { vx, vy } = player.getMovementState();
    const heading = Math.atan2(vy, vx);
    expect(heading).toBeCloseTo(1.5, 2);
    expect(player.getHeading()).toBeCloseTo(1.5, 2);
  });

  it('fires only the main engine while forward thrust is held (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    expect(player.getFlameLengths()).toEqual({
      main: 0,
      leftSide: 0,
      rightSide: 0,
    });

    player.setInput({ forward: true, turnLeft: false, turnRight: false });
    player.preUpdate(0, 500);

    const lens = player.getFlameLengths();
    // Only the main rear thruster fires at full size.
    expect(lens.main).toBeCloseTo(15, 2);
    expect(lens.leftSide).toBe(0);
    expect(lens.rightSide).toBe(0);
  });

  it('fires only the right-side engine on turn-left (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    player.setInput({ forward: false, turnLeft: true, turnRight: false });
    player.preUpdate(0, 500);

    const lens = player.getFlameLengths();
    // Side thrusters are 70% size.
    expect(lens.leftSide).toBe(0);
    expect(lens.rightSide).toBeCloseTo(15 * 0.7, 2);
    expect(lens.main).toBe(0);
  });

  it('fires only the left-side engine on turn-right (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    player.setInput({ forward: false, turnLeft: false, turnRight: true });
    player.preUpdate(0, 500);

    const lens = player.getFlameLengths();
    expect(lens.leftSide).toBeCloseTo(15 * 0.7, 2);
    expect(lens.rightSide).toBe(0);
    expect(lens.main).toBe(0);
  });

  it('fires main + right-side on forward + turn-left (AC2)', async () => {
    const player = await bootAsteroidsPlayer();

    player.setInput({ forward: true, turnLeft: true, turnRight: false });
    player.preUpdate(0, 500);

    const lens = player.getFlameLengths();
    expect(lens.main).toBeCloseTo(15, 2);
    expect(lens.rightSide).toBeCloseTo(15 * 0.7, 2);
    expect(lens.leftSide).toBe(0);
  });

  it('fires main + left-side on forward + turn-right (AC2)', async () => {
    const player = await bootAsteroidsPlayer();

    player.setInput({ forward: true, turnLeft: false, turnRight: true });
    player.preUpdate(0, 500);

    const lens = player.getFlameLengths();
    expect(lens.main).toBeCloseTo(15, 2);
    expect(lens.leftSide).toBeCloseTo(15 * 0.7, 2);
    expect(lens.rightSide).toBe(0);
  });

  it('shows no flames while coasting and decays them on release (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    player.setInput({ forward: true, turnLeft: false, turnRight: false });
    player.preUpdate(0, 500);
    expect(player.getFlameLengths().main).toBeGreaterThan(0);

    // Release: flames decay to zero.
    player.setInput({ forward: false, turnLeft: false, turnRight: false });
    player.preUpdate(0, 5000);
    expect(player.getFlameLengths().main).toBe(0);
  });

  it('respawn resets position, velocity, rotation and flames (AC1)', async () => {
    const player = await bootAsteroidsPlayer();

    player.setInput({ forward: true, turnLeft: false, turnRight: true });
    player.physicsTick(1, 960, 540);
    player.preUpdate(0, 500);

    player.respawn(100, 100);
    expect(player.x).toBe(100);
    expect(player.y).toBe(100);
    expect(player.getMovementState().vx).toBe(0);
    expect(player.getMovementState().vy).toBe(0);
    expect(player.rotation).toBe(0);
    expect(player.getFlameLengths()).toEqual({
      main: 0,
      leftSide: 0,
      rightSide: 0,
    });
  });
});

// ── Thruster hum wiring — Player → effects (AH-0MTHF3SJL009T2QL) ────────

describe('Player — Thruster hum wiring', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

  async function bootPlayerScene(): Promise<Phaser.Scene> {
    booted = await bootScene([GymPlayer]);
    return booted!.scene;
  }

  const playerOf = (scene: Phaser.Scene) => {
    const children = scene.sys.displayList.getChildren();
    return children.find((c) => c instanceof Player) as Player | undefined;
  };

  async function bootPlayer(): Promise<Player> {
    const scene = await bootPlayerScene();
    await tick();
    const p = playerOf(scene);
    expect(p).toBeDefined();
    return p as Player;
  }

  it('calls updateThrusterSound with level 0 while idle and >0 while thrusting (AC1, AC2)', async () => {
    const player = await bootPlayer();
    const spy = vi.spyOn(effects, 'updateThrusterSound');

    // Idle frame → level 0 (silence) so the hum decays quickly on release.
    player.setInput({ up: false, down: false, left: false, right: false });
    player.preUpdate(0, 16);
    expect(spy).toHaveBeenLastCalledWith(0);
    spy.mockClear();

    // Thrust held → level 1 at default thrust 300 (FLAME_REF_THRUST).
    player.setInput({ up: true, down: false, left: false, right: false });
    player.preUpdate(0, 16);
    expect(spy).toHaveBeenLastCalledWith(1);
  });

  it('scales the hum level proportionally to thrustAcceleration (AC2)', async () => {
    const player = await bootPlayer();
    const spy = vi.spyOn(effects, 'updateThrusterSound');

    // Half thrust → level 0.5 (slider audible).
    player.setConfig({ ...DEFAULT_CONFIG, thrustAcceleration: 150 });
    player.setInput({ up: true, down: false, left: false, right: false });
    player.preUpdate(0, 16);
    expect(spy).toHaveBeenLastCalledWith(expect.closeTo(0.5, 5));

    // Default thrust → level 1 (backward-compat no-arg case).
    spy.mockClear();
    player.setConfig({ ...DEFAULT_CONFIG, thrustAcceleration: 300 });
    player.preUpdate(0, 16);
    expect(spy).toHaveBeenLastCalledWith(1);
  });

  it('produces hum for any arrow/WASD thrust key in fourDirectional (AC3)', async () => {
    const player = await bootPlayer();
    const spy = vi.spyOn(effects, 'updateThrusterSound');

    const thrustKeys: Array<Record<string, boolean>> = [
      { up: true, down: false, left: false, right: false },
      { up: false, down: true, left: false, right: false },
      { up: false, down: false, left: true, right: false },
      { up: false, down: false, left: false, right: true },
      { up: true, down: false, left: true, right: false }, // diagonal
    ];
    for (const keys of thrustKeys) {
      spy.mockClear();
      player.setInput(keys as never);
      player.preUpdate(0, 16);
      expect(spy).toHaveBeenLastCalledWith(expect.any(Number));
      expect((spy.mock.calls.at(-1)![0] as number)).toBeGreaterThan(0);
    }
  });

  it('produces hum for forward and turn inputs in Asteroids, silence when coasting (AC4)', async () => {
    const player = await bootPlayer();
    player.setScheme('asteroids');
    const spy = vi.spyOn(effects, 'updateThrusterSound');

    player.setInput({ forward: true, turnLeft: false, turnRight: false });
    player.preUpdate(0, 16);
    expect(spy).toHaveBeenLastCalledWith(expect.any(Number));
    expect((spy.mock.calls.at(-1)![0] as number)).toBeGreaterThan(0);

    spy.mockClear();
    player.setInput({ forward: false, turnLeft: true, turnRight: false });
    player.preUpdate(0, 16);
    expect((spy.mock.calls.at(-1)![0] as number)).toBeGreaterThan(0);

    spy.mockClear();
    player.setInput({ forward: false, turnLeft: false, turnRight: true });
    player.preUpdate(0, 16);
    expect((spy.mock.calls.at(-1)![0] as number)).toBeGreaterThan(0);

    spy.mockClear();
    player.setInput({ forward: false, turnLeft: false, turnRight: false });
    player.preUpdate(0, 16);
    expect(spy).toHaveBeenLastCalledWith(0);
  });

  it('hum stops on respawn, destroy, and stopThrusterAudio (AC5)', async () => {
    const player = await bootPlayer();
    const stopSpy = vi.spyOn(effects, 'stopThrusterSound');

    // Respawns silence the hum so no orphaned audio after hit.
    player.setInput({ up: true, down: false, left: false, right: false });
    player.preUpdate(0, 16);
    player.respawn(100, 100);
    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockClear();

    // Explicit stop (scene switch) also silences.
    player.stopThrusterAudio();
    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockClear();

    // Destroy stops the hum and still calls super.destroy safely.
    player.destroy();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('does not change physics: thrust level only affects audio, not tick (AC6)', async () => {
    const player = await bootPlayer();
    player.setPosition(480, 270);

    // Two identical physics ticks must land at the same position even
    // though preUpdate now also drives audio — no coupling.
    player.setInput({ up: true, down: false, left: false, right: false });
    player.preUpdate(0, 16);
    player.physicsTick(1, 960, 540);
    const y1 = player.y;

    // Reset and repeat the same thrust frame.
    player.setPosition(480, 270);
    // Clear movement state velocity by respawning then re-thrusting:
    player.respawn(480, 270);
    player.setInput({ up: true, down: false, left: false, right: false });
    player.preUpdate(0, 16);
    player.physicsTick(1, 960, 540);
    expect(player.y).toBeCloseTo(y1, 5);
  });
});
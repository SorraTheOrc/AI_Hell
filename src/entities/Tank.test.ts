import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  colorToHSL,
  EXPLOSION_HUE_JITTER_DEG,
  resolvePatterns,
  scaledCount,
} from '../vfx/explosionParticles';
import {
  TANK_BULLET_SPEED,
  TANK_BURST_COUNT,
  TANK_COLOR,
  TANK_FIRE_INTERVAL,
  TANK_SIZE,
  Tank,
  FormationOffset,
} from './Tank';

/** Minimal scene that only constructs Tank entities (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('Tank entity (E3 tank, GDD §4.1 — direction-agnostic radial burst)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeTank(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Tank {
    const scene = booted!.scene;
    return new Tank(scene, { x, y, formationOffset: offset });
  }

  it('renders a visible orange body and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(100, 100);

    expect(tank.alive).toBe(true);
    expect(TANK_COLOR).toBe(0xff6600); // neon orange per GDD §4.1
  });

  it('strokes the hexagon with TANK_COLOR applied AFTER the buffer clear (browser render regression, AH-0MTVYBL2L0085G6G)', async () => {
    // Graphics is command-buffered: clear() wipes any styles queued before it.
    // The tank's outer hexagon had no lineStyle() queued after clear(), so in
    // a real browser it inherited Phaser's module-global leftover stroke tint
    // instead of the tank colour — the first-rendered tank changed colour with
    // unrelated redraws (e.g. the player's per-frame thrust flames) and the
    // "wrong" tank moved to the next alive one on destruction. Assert the
    // hexagon's effective stroke is TANK_COLOR, i.e. queued after the last
    // clear. Phaser Graphics command ids (src/gameobjects/graphics/Commands.js).
    const LINE_STYLE = 6;
    const STROKE_PATH = 9;

    booted = await bootScene([HarnessScene]);
    const tank = makeTank(100, 100);

    // The body is the container child whose buffer contains a stroked path
    // (the explosion layer's buffer is empty until a destruction).
    const children = (tank as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    const body = children.find(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics &&
        c.commandBuffer.includes(STROKE_PATH),
    );
    expect(body, 'expected a body Graphics child with a stroked path').toBeDefined();

    const buf: number[] = body!.commandBuffer as number[];
    const firstStrokeIdx = buf.indexOf(STROKE_PATH);
    let lineStyleIdx = -1;
    for (let i = firstStrokeIdx - 1; i >= 0; i--) {
      if (buf[i] === LINE_STYLE) {
        lineStyleIdx = i;
        break;
      }
    }
    expect(
      lineStyleIdx,
      'outer hexagon stroked with no explicit lineStyle after clear()',
    ).toBeGreaterThanOrEqual(0);
    // LINE_STYLE layout: [id, lineWidth, color, alpha].
    expect(buf[lineStyleIdx + 1]).toBe(2.5);
    expect(buf[lineStyleIdx + 2]).toBe(TANK_COLOR);
  });

  it('AC2 — fires a full-circle radial burst with evenly spaced directions (direction-agnostic)', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(240, 300);
    const t0 = 1_000_000;

    tank.shootEnabled = true;
    const bullets = tank.tryFireRadialBurst(t0);
    expect(bullets).toHaveLength(TANK_BURST_COUNT);

    // All bullets travel at the configured speed in a perfectly symmetric
    // full-circle spread: no direction is privileged (direction-agnostic).
    const angles = bullets.map((b) => {
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      expect(speed).toBeCloseTo(TANK_BULLET_SPEED, 5);
      return Math.atan2(b.vy, b.vx);
    });

    // Every direction gets exactly one bullet: angles are spread over the
    // full 2π and the spacing between neighbours is uniform.
    const sorted = [...angles].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      expect(gap).toBeCloseTo((Math.PI * 2) / TANK_BURST_COUNT, 5);
    }
    // The circle is closed: the last gap wraps around to the first angle.
    const wrapGap = sorted[0] + Math.PI * 2 - sorted[sorted.length - 1];
    expect(wrapGap).toBeCloseTo((Math.PI * 2) / TANK_BURST_COUNT, 5);

    // The burst is symmetric — the mean direction is a zero vector (no
    // net bias toward any direction).
    const meanX = bullets.reduce((sum, b) => sum + b.vx, 0) / bullets.length;
    const meanY = bullets.reduce((sum, b) => sum + b.vy, 0) / bullets.length;
    expect(meanX).toBeCloseTo(0, 5);
    expect(meanY).toBeCloseTo(0, 5);
  });

  it('AC2 — respects the fire interval and never lets a live aim seam bias the burst', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(240, 300);
    const t0 = 1_000_000;

    tank.shootEnabled = true;
    expect(tank.tryFireRadialBurst(t0)).toHaveLength(TANK_BURST_COUNT);

    // Within the interval — refuses to fire again.
    expect(tank.tryFireRadialBurst(t0 + TANK_FIRE_INTERVAL - 1)).toHaveLength(
      0,
    );
    // After the interval — a fresh symmetric burst.
    const second = tank.tryFireRadialBurst(t0 + TANK_FIRE_INTERVAL);
    expect(second).toHaveLength(TANK_BURST_COUNT);

    // The tank exposes no live-aim seam: its burst is deliberately
    // direction-agnostic (the scene's optional setAimTarget is a no-op via
    // optional chaining).
    expect('setAimTarget' in tank).toBe(false);
  });

  describe('scene-less (stale) tank — AH-0MTPLHLZ3006MOC4', () => {
    it('AC — destroySelf on a display-list-destroyed tank never throws (null-scene playExplosion guard)', async () => {
      booted = await bootScene([HarnessScene]);
      const tank = makeTank(100, 100);

      // Simulate Phaser's DisplayList.shutdown: destroys the object and sets
      // its `scene` to undefined (GameObject.destroy).  The stale object may
      // still sit in the scene's bookkeeping array with _alive === true — the
      // original crash manifested here when a player bullet hit it and
      // destroySelf → playExplosion read this.scene.tweens.
      (tank as unknown as { scene: Phaser.Scene | undefined }).scene =
        undefined;
      expect(tank.alive).toBe(true);

      expect(() => tank.destroySelf()).not.toThrow();
      expect(tank.alive).toBe(false);
    });
  });

  it('destruction spawns a radial+ring particle burst tinted around TANK_COLOR (AC1)', async () => {
    booted = await bootScene([HarnessScene]);
    const tank = makeTank(100, 100);
    expect(tank.getExplosionHandles().length).toBe(0);

    tank.destroySelf();

    const handles = tank.getExplosionHandles();
    expect(handles.length).toBe(1);
    expect(handles[0].patterns).toEqual(resolvePatterns('tank'));
    expect(handles[0].patterns).toEqual(['radial', 'ring']);
    expect(handles[0].totalCount).toBe(scaledCount(TANK_SIZE));

    const base = colorToHSL(TANK_COLOR);
    for (const p of handles[0].particles) {
      const hsl = colorToHSL(p.color);
      let delta = Math.abs(hsl.h - base.h) % 360;
      if (delta > 180) delta = 360 - delta;
      // +0.5° allows for hex↔HSL round-trip precision at the jitter edge.
      expect(delta).toBeLessThanOrEqual(EXPLOSION_HUE_JITTER_DEG + 0.5);
    }
  });
});
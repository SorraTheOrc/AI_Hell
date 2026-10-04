/**
 * Unit tests for the shared P3/P6 effect visuals
 * (`AH-0MUICQC34005QOYF`). Pins the exact shield-bubble/phase-ghost
 * parameters used by `PlayScene`, `GymPowerUpsCombat` and
 * `GymFormationScene`, so the three scenes cannot drift visually.
 */

import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';

import { SHIP_SIZE } from '../../core/constants';
import { EffectsRegistry } from '../../powerups/effects';
import {
  applyPhaseGhost,
  drawShieldBubble,
  PHASE_GHOST_ALPHA,
  SHIELD_BUBBLE_COLOR,
  SHIELD_BUBBLE_ENDING_FILL_ALPHA,
  SHIELD_BUBBLE_ENDING_SECONDS,
  SHIELD_BUBBLE_FILL_ALPHA,
  SHIELD_BUBBLE_LINE_WIDTH,
  SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER,
  SHIELD_BUBBLE_PULSE_RATE,
  SHIELD_BUBBLE_RADIUS_FACTOR,
  SHIELD_BUBBLE_SHRINK_MIN_FACTOR,
  SHIELD_BUBBLE_SHRINK_SECONDS,
  SHIELD_BUBBLE_STROKE_ALPHA,
} from './CombatEffectVisuals';

/** Records the Graphics draw calls the helper makes. */
class FakeGraphics {
  cleared = 0;
  lineStyleCalls: Array<[number, number, number]> = [];
  strokeCircleCalls: Array<[number, number, number]> = [];
  fillStyleCalls: Array<[number, number]> = [];
  fillCircleCalls: Array<[number, number, number]> = [];

  clear(): this {
    this.cleared += 1;
    return this;
  }

  lineStyle(width: number, color: number, alpha: number): this {
    this.lineStyleCalls.push([width, color, alpha]);
    return this;
  }

  strokeCircle(x: number, y: number, radius: number): this {
    this.strokeCircleCalls.push([x, y, radius]);
    return this;
  }

  fillStyle(color: number, alpha: number): this {
    this.fillStyleCalls.push([color, alpha]);
    return this;
  }

  fillCircle(x: number, y: number, radius: number): this {
    this.fillCircleCalls.push([x, y, radius]);
    return this;
  }
}

function graphics(g: FakeGraphics): Phaser.GameObjects.Graphics {
  return g as unknown as Phaser.GameObjects.Graphics;
}

/**
 * Minimal registry stub that reports an exact P3 remaining time, so the
 * time-based ending animation can be driven deterministically (no floating
 * point drift from ticking a real registry).
 */
function shieldAt(remaining: number, shielded = true): EffectsRegistry {
  return {
    isShielded: shielded,
    remaining: (id: string) => (id === 'P3' ? remaining : undefined),
  } as unknown as EffectsRegistry;
}

describe('CombatEffectVisuals — shared P3 shield bubble / P6 phase ghost', () => {
  it('pins the shared visual parameters', () => {
    expect(SHIELD_BUBBLE_COLOR).toBe(0x3399ff);
    expect(SHIELD_BUBBLE_LINE_WIDTH).toBe(2);
    expect(SHIELD_BUBBLE_RADIUS_FACTOR).toBe(1.6);
    expect(SHIELD_BUBBLE_FILL_ALPHA).toBe(0.12);
    expect(SHIELD_BUBBLE_STROKE_ALPHA).toBe(0.9);
    expect(PHASE_GHOST_ALPHA).toBe(0.45);
  });

  it('pins the ending-animation tuning surface', () => {
    expect(SHIELD_BUBBLE_ENDING_SECONDS).toBe(1.0);
    expect(SHIELD_BUBBLE_SHRINK_SECONDS).toBe(0.5);
    expect(SHIELD_BUBBLE_ENDING_FILL_ALPHA).toBeGreaterThan(SHIELD_BUBBLE_FILL_ALPHA);
    expect(SHIELD_BUBBLE_ENDING_FILL_ALPHA).toBeLessThanOrEqual(1);
    // Below 0.5 (SHIP_SIZE / 2) so the shrinking fill reads as inside the hull.
    expect(SHIELD_BUBBLE_SHRINK_MIN_FACTOR).toBeLessThan(0.5);
    expect(SHIELD_BUBBLE_PULSE_RATE).toBeGreaterThan(0);
    expect(SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER).toBeGreaterThan(0);
    expect(SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER).toBeLessThan(1);
  });

  it('draws the bubble at the shared colour/width/radius and steady fill while shielded', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P3');
    const g = new FakeGraphics();

    const drawn = drawShieldBubble(graphics(g), { x: 100, y: 50 }, registry);

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls[0][0]).toBe(SHIELD_BUBBLE_LINE_WIDTH);
    expect(g.lineStyleCalls[0][1]).toBe(SHIELD_BUBBLE_COLOR);
    // The rim pulses for the whole shield lifetime (operator clarification,
    // AH-0MUAYB5HR001HDYC), so its alpha is an oscillation within bounds.
    expect(g.lineStyleCalls[0][2]).toBeGreaterThan(0);
    expect(g.lineStyleCalls[0][2]).toBeLessThanOrEqual(SHIELD_BUBBLE_STROKE_ALPHA);
    expect(g.strokeCircleCalls).toEqual([[100, 50, SHIP_SIZE * 1.6]]);
    expect(g.fillStyleCalls).toEqual([[SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_FILL_ALPHA]]);
    expect(g.fillCircleCalls).toEqual([[100, 50, SHIP_SIZE * 1.6]]);
  });

  it('clears the bubble and draws nothing when the shield is inactive', () => {
    const registry = new EffectsRegistry();
    const g = new FakeGraphics();

    const drawn = drawShieldBubble(graphics(g), { x: 1, y: 2 }, registry);

    expect(drawn).toBe(false);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls).toEqual([]);
    expect(g.strokeCircleCalls).toEqual([]);
    expect(g.fillCircleCalls).toEqual([]);
  });

  it('is safe with no graphics or no player (and clears when only the player is missing)', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P3');

    expect(drawShieldBubble(null, { x: 1, y: 2 }, registry)).toBe(false);

    const g = new FakeGraphics();
    expect(drawShieldBubble(graphics(g), null, registry)).toBe(false);
    expect(g.cleared).toBe(1);
    expect(g.strokeCircleCalls).toEqual([]);
  });

  it('ghosts the ship while phased and restores full alpha otherwise', () => {
    const registry = new EffectsRegistry();
    const alphas: number[] = [];
    const player = { setAlpha: (a: number) => alphas.push(a) };

    registry.applyPhaseShift();
    applyPhaseGhost(player, registry, false);
    expect(alphas).toEqual([PHASE_GHOST_ALPHA]);

    const restored = new EffectsRegistry();
    applyPhaseGhost(player, restored, false);
    expect(alphas).toEqual([PHASE_GHOST_ALPHA, 1]);
  });

  it('leaves the alpha alone while the invulnerability blink is active and is safe with no player', () => {
    const registry = new EffectsRegistry();
    registry.applyPhaseShift();
    const alphas: number[] = [];
    const player = { setAlpha: (a: number) => alphas.push(a) };

    applyPhaseGhost(player, registry, true); // blinking owns the alpha
    expect(alphas).toEqual([]);

    expect(() => applyPhaseGhost(null, registry, false)).not.toThrow();
  });
});

describe('CombatEffectVisuals — P3 shield ending animation (AH-0MUAYB5HR001HDYC)', () => {
  it('keeps the steady fill and full radius while the rim pulses continuously above one second', () => {
    const strokeAlphas = new Set<number>();
    for (const remaining of [15, 12, 8, 5, 3, 2, 1.5, 1.01]) {
      const g = new FakeGraphics();
      const drawn = drawShieldBubble(graphics(g), { x: 10, y: 20 }, shieldAt(remaining));

      expect(drawn).toBe(true);
      expect(g.cleared).toBe(1);
      // Fill and radius stay at their steady values outside the ending window.
      expect(g.fillStyleCalls).toEqual([[SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_FILL_ALPHA]]);
      expect(g.fillCircleCalls).toEqual([[10, 20, SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR]]);
      expect(g.strokeCircleCalls).toEqual([[10, 20, SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR]]);
      // Rim alpha stays a visible, bounded oscillation.
      const strokeAlpha = g.lineStyleCalls[0][2];
      expect(strokeAlpha).toBeGreaterThan(0);
      expect(strokeAlpha).toBeLessThanOrEqual(SHIELD_BUBBLE_STROKE_ALPHA);
      strokeAlphas.add(strokeAlpha);
    }
    // Continuous pulse: the rim alpha must vary across the whole lifetime.
    expect(strokeAlphas.size).toBeGreaterThan(1);
  });

  it('pulses the rim and ramps the fill opaque during the final second', () => {
    const strokeAlphas = new Set<number>();
    for (let remaining = 0.95; remaining > 0; remaining -= 0.05) {
      const g = new FakeGraphics();
      const drawn = drawShieldBubble(graphics(g), { x: 0, y: 0 }, shieldAt(remaining));

      expect(drawn).toBe(true);
      // Fill is more opaque than the steady state (AC2).
      expect(g.fillStyleCalls[0][1]).toBeGreaterThan(SHIELD_BUBBLE_FILL_ALPHA);
      // Rim alpha stays a visible, bounded oscillation.
      const strokeAlpha = g.lineStyleCalls[0][2];
      expect(strokeAlpha).toBeGreaterThan(0);
      expect(strokeAlpha).toBeLessThanOrEqual(SHIELD_BUBBLE_STROKE_ALPHA);
      strokeAlphas.add(strokeAlpha);
    }
    // The rim pulses for the whole second, so the alpha must vary.
    expect(strokeAlphas.size).toBeGreaterThan(1);
  });

  it('reaches the documented opaque fill alpha at expiry', () => {
    const g = new FakeGraphics();
    drawShieldBubble(graphics(g), { x: 0, y: 0 }, shieldAt(0.001));
    expect(g.fillStyleCalls[0][1]).toBeGreaterThan(0.59);
  });

  it('shrinks the fill below the hull radius across the final half second, monotonically', () => {
    const full = SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR;
    const fillRadiusAt = (remaining: number): number => {
      const g = new FakeGraphics();
      drawShieldBubble(graphics(g), { x: 0, y: 0 }, shieldAt(remaining));
      return g.fillCircleCalls[0][2];
    };

    // The shrink window opens at the full bubble radius.
    expect(fillRadiusAt(SHIELD_BUBBLE_SHRINK_SECONDS)).toBeCloseTo(full, 6);

    const r45 = fillRadiusAt(0.45);
    const r25 = fillRadiusAt(0.25);
    const r05 = fillRadiusAt(0.05);
    expect(r45).toBeLessThan(full);
    expect(r25).toBeLessThan(r45);
    expect(r05).toBeLessThan(r25);
    // By expiry the fill is inside the hull (SHIP_SIZE / 2) — reads as ineffective.
    expect(r05).toBeLessThan(SHIP_SIZE / 2);
    expect(r05).toBeGreaterThanOrEqual(SHIP_SIZE * SHIELD_BUBBLE_SHRINK_MIN_FACTOR - 1e-9);

    // The pulsing rim keeps its full radius; only the fill shrinks.
    const g = new FakeGraphics();
    drawShieldBubble(graphics(g), { x: 0, y: 0 }, shieldAt(0.05));
    expect(g.strokeCircleCalls[0][2]).toBeCloseTo(full, 6);
  });

  it('clears and draws nothing at expiry', () => {
    const g = new FakeGraphics();
    const drawn = drawShieldBubble(graphics(g), { x: 0, y: 0 }, shieldAt(0));

    expect(drawn).toBe(false);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls).toEqual([]);
    expect(g.strokeCircleCalls).toEqual([]);
    expect(g.fillStyleCalls).toEqual([]);
    expect(g.fillCircleCalls).toEqual([]);
  });

  it('is a pure function of the remaining time (deterministic)', () => {
    const drawAt = (remaining: number) => {
      const g = new FakeGraphics();
      drawShieldBubble(graphics(g), { x: 7, y: 9 }, shieldAt(remaining));
      return {
        lineStyle: g.lineStyleCalls,
        stroke: g.strokeCircleCalls,
        fillStyle: g.fillStyleCalls,
        fill: g.fillCircleCalls,
      };
    };

    expect(drawAt(0.37)).toEqual(drawAt(0.37));
  });

  it('is safe with no graphics or no player during the ending window', () => {
    expect(drawShieldBubble(null, { x: 1, y: 2 }, shieldAt(0.2))).toBe(false);

    const g = new FakeGraphics();
    expect(drawShieldBubble(graphics(g), null, shieldAt(0.2))).toBe(false);
    expect(g.cleared).toBe(1);
    expect(g.strokeCircleCalls).toEqual([]);
  });
});

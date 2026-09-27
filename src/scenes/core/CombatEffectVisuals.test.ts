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
  SHIELD_BUBBLE_FILL_ALPHA,
  SHIELD_BUBBLE_LINE_WIDTH,
  SHIELD_BUBBLE_RADIUS_FACTOR,
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

describe('CombatEffectVisuals — shared P3 shield bubble / P6 phase ghost', () => {
  it('pins the shared visual parameters', () => {
    expect(SHIELD_BUBBLE_COLOR).toBe(0x3399ff);
    expect(SHIELD_BUBBLE_LINE_WIDTH).toBe(2);
    expect(SHIELD_BUBBLE_RADIUS_FACTOR).toBe(1.6);
    expect(SHIELD_BUBBLE_FILL_ALPHA).toBe(0.12);
    expect(SHIELD_BUBBLE_STROKE_ALPHA).toBe(0.9);
    expect(PHASE_GHOST_ALPHA).toBe(0.45);
  });

  it('draws the bubble at the shared colour/width/radius/alpha while shielded', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P3');
    const g = new FakeGraphics();

    const drawn = drawShieldBubble(graphics(g), { x: 100, y: 50 }, registry);

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls).toEqual([
      [SHIELD_BUBBLE_LINE_WIDTH, SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_STROKE_ALPHA],
    ]);
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

    registry.applyCollect('P6');
    applyPhaseGhost(player, registry, false);
    expect(alphas).toEqual([PHASE_GHOST_ALPHA]);

    const restored = new EffectsRegistry();
    applyPhaseGhost(player, restored, false);
    expect(alphas).toEqual([PHASE_GHOST_ALPHA, 1]);
  });

  it('leaves the alpha alone while the invulnerability blink is active and is safe with no player', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('P6');
    const alphas: number[] = [];
    const player = { setAlpha: (a: number) => alphas.push(a) };

    applyPhaseGhost(player, registry, true); // blinking owns the alpha
    expect(alphas).toEqual([]);

    expect(() => applyPhaseGhost(null, registry, false)).not.toThrow();
  });
});

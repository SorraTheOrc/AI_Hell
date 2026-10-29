/**
 * Unit tests for the shared Shield/Phase Shift effect visuals
 * (`AH-0MUICQC34005QOYF`). Pins the exact shield-bubble/phase-ghost
 * parameters used by `PlayScene`, `GymPowerUpsCombat` and
 * `GymFormationScene`, so the three scenes cannot drift visually.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { SHIP_SIZE } from '../../core/constants';
import { EffectsRegistry } from '../../powerups/effects';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  applyPhaseGhost,
  drawEnemyForceFieldBreakFlash,
  drawEnemyForceFieldBubble,
  drawForceFieldBubble,
  drawShieldBubble,
  drawThornsAura,
  ENEMY_FORCE_FIELD_BREAK_DEPTH,
  ENEMY_FORCE_FIELD_BREAK_DURATION,
  ENEMY_FORCE_FIELD_BREAK_END_SCALE,
  ENEMY_FORCE_FIELD_BREAK_RADIUS_FACTOR,
  ENEMY_FORCE_FIELD_COLOR,
  ENEMY_FORCE_FIELD_FILL_ALPHA,
  ENEMY_FORCE_FIELD_LINE_WIDTH,
  ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA,
  ENEMY_FORCE_FIELD_RADIUS_FACTOR,
  ENEMY_FORCE_FIELD_SEGMENTS,
  ENEMY_FORCE_FIELD_STROKE_ALPHA,
  spawnEnemyForceFieldBreakFlash,
  FORCE_FIELD_FILL_ALPHA,
  FORCE_FIELD_LINE_WIDTH,
  FORCE_FIELD_SPENT_FILL_ALPHA,
  FORCE_FIELD_SPENT_STROKE_ALPHA,
  FORCE_FIELD_STROKE_ALPHA,
  PHASE_GHOST_ALPHA,
  THORNS_AURA_COLOR,
  THORNS_AURA_LINE_WIDTH,
  THORNS_AURA_MAX_SPIKES,
  THORNS_AURA_MIN_SPIKES,
  THORNS_AURA_RADIUS_FACTOR,
  THORNS_AURA_SPIKES_PER_CHARGE,
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
  /** Count of path-drawing calls (beginPath/moveTo/lineTo/closePath/strokePath). */
  pathCommands = 0;
  /** Recorded vertices of moveTo/lineTo calls, in draw order. */
  pathPoints: Array<[number, number]> = [];

  clear(): this {
    this.cleared += 1;
    return this;
  }

  beginPath(): this {
    this.pathCommands += 1;
    return this;
  }

  moveTo(x: number, y: number): this {
    this.pathCommands += 1;
    this.pathPoints.push([x, y]);
    return this;
  }

  lineTo(x: number, y: number): this {
    this.pathCommands += 1;
    this.pathPoints.push([x, y]);
    return this;
  }

  closePath(): this {
    this.pathCommands += 1;
    return this;
  }

  strokePath(): this {
    this.pathCommands += 1;
    return this;
  }

  fillPath(): this {
    this.pathCommands += 1;
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
 * Minimal registry stub that reports an exact Shield remaining time, so the
 * time-based ending animation can be driven deterministically (no floating
 * point drift from ticking a real registry).
 */
function shieldAt(remaining: number, shielded = true): EffectsRegistry {
  return {
    isShielded: shielded,
    remaining: (id: string) => (id === 'shield' ? remaining : undefined),
  } as unknown as EffectsRegistry;
}

/**
 * Minimal registry stub reporting an active Force Field with a fixed temporary
 * window (`undefined` = permanent base with no window), radius and reflect
 * budget, so the bubble visual can be driven deterministically.
 *
 * The temporary window is exposed through `powerUpTemporaryRemaining` (the
 * gate the bubble must use). `remaining('force_field')` is deliberately `0`
 * for a permanent-only field — the old draw gate — so a regression back to
 * that gate fails the permanent-persistence tests (AH-0MVRDMG0N000Y03Z).
 */
function forceFieldAt(
  tempRemaining: number | undefined,
  active = true,
  radius = SHIP_SIZE * 1.8,
  budget = 3,
): EffectsRegistry {
  return {
    isForceFieldActive: () => active,
    forceFieldRadius: () => radius,
    forceFieldRemaining: () => budget,
    powerUpTemporaryRemaining: (id: string) =>
      id === 'force_field' ? tempRemaining : undefined,
    remaining: (id: string) =>
      id === 'force_field' ? (tempRemaining ?? 0) : undefined,
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
    registry.applyCollect('shield');
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
    registry.applyCollect('shield');

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

// ── Force Field reflect bubble (AH-0MV1BIX1W006XF95) ─────────────────

describe('CombatEffectVisuals — Force Field reflect bubble (AH-0MV1BIX1W006XF95)', () => {
  it('pins the shared force-bubble tuning', () => {
    expect(FORCE_FIELD_LINE_WIDTH).toBe(2);
    expect(FORCE_FIELD_STROKE_ALPHA).toBeGreaterThan(0);
    expect(FORCE_FIELD_STROKE_ALPHA).toBeLessThanOrEqual(1);
    expect(FORCE_FIELD_FILL_ALPHA).toBeGreaterThan(0);
    expect(FORCE_FIELD_FILL_ALPHA).toBeLessThan(1);
  });

  it('draws the hexagonal bubble at the shared radius while the field is active', () => {
    const g = new FakeGraphics();
    const radius = SHIP_SIZE * 1.8;
    const drawn = drawForceFieldBubble(
      graphics(g),
      { x: 100, y: 50 },
      forceFieldAt(5, true, radius),
    );

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    // Hexagon (6 vertices + close) + three chevrons (2 segments each).
    expect(g.pathCommands).toBeGreaterThan(10);
    expect(g.lineStyleCalls[0]?.[0]).toBe(FORCE_FIELD_LINE_WIDTH);
    expect(g.fillCircleCalls.some(([, , r]) => r === radius * 0.85)).toBe(true);
  });

  it('clears and draws nothing when the field is inactive', () => {
    const g = new FakeGraphics();
    const drawn = drawForceFieldBubble(
      graphics(g),
      { x: 1, y: 2 },
      forceFieldAt(5, false),
    );
    expect(drawn).toBe(false);
    expect(g.cleared).toBe(1);
    expect(g.pathCommands).toBe(0);
  });

  it('clears and draws nothing at temporary-window expiry (countdown 0)', () => {
    const g = new FakeGraphics();
    const drawn = drawForceFieldBubble(
      graphics(g),
      { x: 1, y: 2 },
      forceFieldAt(0),
    );
    expect(drawn).toBe(false);
    expect(g.pathCommands).toBe(0);
  });

  it('pins the spent-state alphas: visible yet distinctly fainter than active', () => {
    expect(FORCE_FIELD_SPENT_STROKE_ALPHA).toBeGreaterThan(0);
    expect(FORCE_FIELD_SPENT_STROKE_ALPHA).toBeLessThan(FORCE_FIELD_STROKE_ALPHA);
    expect(FORCE_FIELD_SPENT_FILL_ALPHA).toBeGreaterThan(0);
    expect(FORCE_FIELD_SPENT_FILL_ALPHA).toBeLessThan(FORCE_FIELD_FILL_ALPHA);
  });

  it('draws a permanent-only field (no temporary window) every frame', () => {
    const radius = SHIP_SIZE * 1.8;
    const registry = forceFieldAt(undefined, true, radius);
    const first = new FakeGraphics();
    const second = new FakeGraphics();

    expect(drawForceFieldBubble(graphics(first), { x: 10, y: 20 }, registry)).toBe(true);
    expect(drawForceFieldBubble(graphics(second), { x: 10, y: 20 }, registry)).toBe(true);
    expect(first.pathCommands).toBeGreaterThan(10);
    expect(second.fillCircleCalls.some(([, , r]) => r === radius * 0.85)).toBe(true);
    expect(second.fillStyleCalls[0]).toEqual([0x33ffcc, FORCE_FIELD_FILL_ALPHA]);
  });

  it('draws a spent permanent field dimmed and steady (no ending brighten)', () => {
    const g = new FakeGraphics();
    const drawn = drawForceFieldBubble(
      graphics(g),
      { x: 1, y: 2 },
      forceFieldAt(undefined, true, SHIP_SIZE * 1.8, 0),
    );

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls[0]?.[2]).toBeCloseTo(FORCE_FIELD_SPENT_STROKE_ALPHA);
    expect(g.fillStyleCalls[0]).toEqual([0x33ffcc, FORCE_FIELD_SPENT_FILL_ALPHA]);

    // A permanent-only field has no countdown, so its pulse phase is constant:
    // two draws are identical (never a last-second brighten).
    const later = new FakeGraphics();
    drawForceFieldBubble(
      graphics(later),
      { x: 1, y: 2 },
      forceFieldAt(undefined, true, SHIP_SIZE * 1.8, 0),
    );
    expect(later.lineStyleCalls).toEqual(g.lineStyleCalls);
    expect(later.fillStyleCalls).toEqual(g.fillStyleCalls);
  });

  it('dims a spent temporary field but keeps its final-second brighten on the spent baseline', () => {
    const steady = new FakeGraphics();
    drawForceFieldBubble(
      graphics(steady),
      { x: 1, y: 2 },
      forceFieldAt(3, true, SHIP_SIZE * 1.8, 0),
    );
    const ending = new FakeGraphics();
    drawForceFieldBubble(
      graphics(ending),
      { x: 1, y: 2 },
      forceFieldAt(0.5, true, SHIP_SIZE * 1.8, 0),
    );

    expect(steady.fillStyleCalls[0]).toEqual([0x33ffcc, FORCE_FIELD_SPENT_FILL_ALPHA]);
    expect(ending.fillStyleCalls[0][1]).toBeGreaterThan(FORCE_FIELD_SPENT_FILL_ALPHA);
  });

  it('keeps the active temporary-window brighten on the active baseline', () => {
    const g = new FakeGraphics();
    drawForceFieldBubble(
      graphics(g),
      { x: 1, y: 2 },
      forceFieldAt(0.5, true, SHIP_SIZE * 1.8, 3),
    );

    expect(g.fillStyleCalls[0][0]).toBe(0x33ffcc);
    expect(g.fillStyleCalls[0][1]).toBeGreaterThan(FORCE_FIELD_FILL_ALPHA);
  });

  it('keeps a real permanent field drawn after a temp window on top of it expires', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('force_field', true); // hold-full reward
    registry.applyCollect('force_field'); // field pickup opens a temp window
    expect(registry.powerUpTemporaryRemaining('force_field')).toBeGreaterThan(0);

    // The window expires back to the permanent base: still active, but the
    // temporary-window accessor reads `undefined` again (effects.test.ts pins
    // the store side; this pins the draw gate on top of it).
    registry.tick((registry.powerUpTemporaryRemaining('force_field') ?? 0) + 0.1);
    expect(registry.isForceFieldActive()).toBe(true);
    expect(registry.powerUpTemporaryRemaining('force_field')).toBeUndefined();

    const g = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(g), { x: 1, y: 2 }, registry)).toBe(true);
    expect(g.pathCommands).toBeGreaterThan(10);
  });

  it('dims a real permanent field once its reflect budget is spent', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('force_field', true);

    let reflected = 0;
    while (registry.tryConsumeForceFieldReflect()) reflected += 1;
    expect(reflected).toBeGreaterThan(0);
    expect(registry.forceFieldRemaining()).toBe(0);

    const g = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(g), { x: 1, y: 2 }, registry)).toBe(true);
    expect(g.fillStyleCalls[0]).toEqual([0x33ffcc, FORCE_FIELD_SPENT_FILL_ALPHA]);
  });

  it('is safe with no graphics or no player (and clears when only the player is missing)', () => {
    expect(drawForceFieldBubble(null, { x: 1, y: 2 }, forceFieldAt(5))).toBe(false);
    const g = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(g), null, forceFieldAt(5))).toBe(false);
    expect(g.cleared).toBe(1);
  });
});

// ── Thorn Field aura (AH-0MVJ8YKR70096C6T) ───────────────────────────

describe('CombatEffectVisuals — Thorn Field aura (AH-0MVJ8YKR70096C6T)', () => {
  it('pins the shared aura tuning (neon-lime spikes outside the shield bubble)', () => {
    expect(THORNS_AURA_COLOR).toBe(0x99ff33);
    expect(THORNS_AURA_LINE_WIDTH).toBe(2);
    // Wider than the Shield bubble (1.6×) so the halo reads as its own effect.
    expect(THORNS_AURA_RADIUS_FACTOR).toBeGreaterThan(1.6);
    // Spikier (audit feedback: "more spikes, not larger") — the aura carries
    // a dense halo, not a sparse star, at every budget.
    expect(THORNS_AURA_MIN_SPIKES).toBeGreaterThanOrEqual(12);
    expect(THORNS_AURA_SPIKES_PER_CHARGE).toBeGreaterThanOrEqual(3);
    expect(THORNS_AURA_MAX_SPIKES).toBeGreaterThanOrEqual(30);
  });

  it('draws a lime spiked halo around the ship while the field is armed', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('thorns', true);
    const g = new FakeGraphics();

    const drawn = drawThornsAura(graphics(g), { x: 100, y: 50 }, registry);

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls[0][0]).toBe(THORNS_AURA_LINE_WIDTH);
    expect(g.lineStyleCalls[0][1]).toBe(THORNS_AURA_COLOR);
    expect(g.pathCommands).toBeGreaterThan(THORNS_AURA_MIN_SPIKES * 2);
    // The aura is a spiked star, not another round bubble: no strokeCircle.
    expect(g.strokeCircleCalls).toEqual([]);
  });

  it('scales the spike count with the remaining ram budget', () => {
    const full = new EffectsRegistry();
    full.applyCollect('thorns', true);
    const gFull = new FakeGraphics();
    drawThornsAura(graphics(gFull), { x: 0, y: 0 }, full);

    // Spend most of the budget: fewer spikes and a dimmer stroke.
    while (full.thornsRemaining() > 1) full.tryConsumeThornsRam();
    const gSpent = new FakeGraphics();
    drawThornsAura(graphics(gSpent), { x: 0, y: 0 }, full);

    expect(gSpent.pathCommands).toBeLessThan(gFull.pathCommands);
    expect(gSpent.lineStyleCalls[0][2]).toBeLessThan(gFull.lineStyleCalls[0][2]);
  });

  it('is deterministic for the same registry state', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('thorns', true);
    const a = new FakeGraphics();
    const b = new FakeGraphics();
    drawThornsAura(graphics(a), { x: 10, y: 20 }, registry);
    drawThornsAura(graphics(b), { x: 10, y: 20 }, registry);
    expect(b.lineStyleCalls).toEqual(a.lineStyleCalls);
    expect(b.fillCircleCalls).toEqual(a.fillCircleCalls);
    expect(b.pathCommands).toBe(a.pathCommands);
  });

  it('does not rotate — the spike geometry is fixed as time advances', () => {
    // Regression for the audit rejection (AH-0MVJ8YKR70096C6T: "Do not
    // rotate the graphic for field of thorns"): advancing the shared clock
    // must not change a single spike vertex.
    const registry = new EffectsRegistry();
    registry.applyCollect('thorns', true);
    const before = new FakeGraphics();
    drawThornsAura(graphics(before), { x: 10, y: 20 }, registry);

    registry.tick(0.75);
    registry.tick(0.75);
    const after = new FakeGraphics();
    drawThornsAura(graphics(after), { x: 10, y: 20 }, registry);

    expect(after.pathPoints).toEqual(before.pathPoints);
  });

  it('clears and draws nothing when the field is inactive or its budget is spent', () => {
    const inactive = new FakeGraphics();
    expect(
      drawThornsAura(graphics(inactive), { x: 1, y: 2 }, new EffectsRegistry()),
    ).toBe(false);
    expect(inactive.cleared).toBe(1);
    expect(inactive.pathCommands).toBe(0);

    const spent = new EffectsRegistry();
    spent.applyCollect('thorns', true);
    while (spent.thornsRemaining() > 0) spent.tryConsumeThornsRam();
    const gSpent = new FakeGraphics();
    expect(drawThornsAura(graphics(gSpent), { x: 1, y: 2 }, spent)).toBe(false);
    expect(gSpent.pathCommands).toBe(0);
  });

  it('is safe with no graphics or no player (and clears when only the player is missing)', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('thorns', true);
    expect(drawThornsAura(null, { x: 1, y: 2 }, registry)).toBe(false);
    const g = new FakeGraphics();
    expect(drawThornsAura(graphics(g), null, registry)).toBe(false);
    expect(g.cleared).toBe(1);
  });
});

// ── Enemy force-field bubble + break flash (AH-0MVM8GW7W004SI0E) ─────

/** Minimal bootable scene for the break-flash spawn helper. */
class EnemyFieldVfxStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'EnemyFieldVfxStubScene' });
  }
}

describe('CombatEffectVisuals — enemy force-field bubble (AH-0MVM8GW7W004SI0E)', () => {
  it('pins the shared enemy-field tuning and a colour distinct from both player bubbles', () => {
    expect(ENEMY_FORCE_FIELD_COLOR).not.toBe(SHIELD_BUBBLE_COLOR);
    expect(ENEMY_FORCE_FIELD_COLOR).not.toBe(0x33ffcc); // FORCE_FIELD_COLOR
    expect(ENEMY_FORCE_FIELD_LINE_WIDTH).toBe(2);
    expect(ENEMY_FORCE_FIELD_RADIUS_FACTOR).toBeGreaterThan(1);
    expect(ENEMY_FORCE_FIELD_FILL_ALPHA).toBeGreaterThan(0);
    expect(ENEMY_FORCE_FIELD_FILL_ALPHA).toBeLessThan(1);
    expect(ENEMY_FORCE_FIELD_STROKE_ALPHA).toBeGreaterThan(0);
    expect(ENEMY_FORCE_FIELD_STROKE_ALPHA).toBeLessThanOrEqual(1);
    expect(ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA).toBeGreaterThan(0);
    expect(ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA).toBeLessThan(
      ENEMY_FORCE_FIELD_STROKE_ALPHA,
    );
    expect(ENEMY_FORCE_FIELD_SEGMENTS).toBeGreaterThan(1);
  });

  it('draws a segmented ring + faint fill at the shared radius around the enemy', () => {
    const g = new FakeGraphics();
    const drawn = drawEnemyForceFieldBubble(graphics(g), { x: 100, y: 50 }, 32, 3, 3);

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    const radius = (32 / 2) * ENEMY_FORCE_FIELD_RADIUS_FACTOR;
    // Ring: the shared colour/width, drawn once then segmented into panels.
    expect(g.lineStyleCalls).toHaveLength(1);
    expect(g.lineStyleCalls[0][0]).toBe(ENEMY_FORCE_FIELD_LINE_WIDTH);
    expect(g.lineStyleCalls[0][1]).toBe(ENEMY_FORCE_FIELD_COLOR);
    // A segmented barrier, not a plain circle: the ring is built from arcs.
    expect(g.strokeCircleCalls).toEqual([]);
    expect(g.pathCommands).toBeGreaterThan(ENEMY_FORCE_FIELD_SEGMENTS * 2);
    // Faint fill marks the inside of the barrier.
    expect(g.fillStyleCalls[0][0]).toBe(ENEMY_FORCE_FIELD_COLOR);
    expect(g.fillStyleCalls[0][1]).toBeGreaterThan(0);
    expect(g.fillStyleCalls[0][1]).toBeLessThan(ENEMY_FORCE_FIELD_FILL_ALPHA + 1e-9);
    expect(g.fillCircleCalls).toEqual([[100, 50, radius]]);
  });

  it('brightens the ring with the remaining field hits (readable strength)', () => {
    const strokeAlphaAt = (hits: number): number => {
      const g = new FakeGraphics();
      drawEnemyForceFieldBubble(graphics(g), { x: 0, y: 0 }, 32, hits, 5);
      return g.lineStyleCalls[0][2];
    };

    const weak = strokeAlphaAt(1);
    const strong = strokeAlphaAt(5);

    expect(weak).toBeGreaterThanOrEqual(ENEMY_FORCE_FIELD_MIN_STROKE_ALPHA);
    expect(strong).toBeLessThanOrEqual(ENEMY_FORCE_FIELD_STROKE_ALPHA);
    expect(strong).toBeGreaterThan(weak);
  });

  it('clears and draws nothing when the field is down (0 hits) or there is no target', () => {
    const spent = new FakeGraphics();
    expect(drawEnemyForceFieldBubble(graphics(spent), { x: 1, y: 2 }, 16, 0, 3)).toBe(false);
    expect(spent.cleared).toBe(1);
    expect(spent.lineStyleCalls).toEqual([]);
    expect(spent.fillCircleCalls).toEqual([]);

    const noTarget = new FakeGraphics();
    expect(drawEnemyForceFieldBubble(graphics(noTarget), null, 16, 2, 2)).toBe(false);
    expect(noTarget.cleared).toBe(1);
    expect(noTarget.lineStyleCalls).toEqual([]);
  });

  it('is safe with no graphics', () => {
    expect(drawEnemyForceFieldBubble(null, { x: 1, y: 2 }, 16, 2, 2)).toBe(false);
  });
});

describe('CombatEffectVisuals — enemy force-field break flash (AH-0MVM8GW7W004SI0E)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([EnemyFieldVfxStubScene]);
    return booted.scene;
  }

  it('pins the shared break-flash tuning (distinct cue, outward of the bubble)', () => {
    expect(ENEMY_FORCE_FIELD_BREAK_RADIUS_FACTOR).toBeGreaterThan(1);
    expect(ENEMY_FORCE_FIELD_BREAK_DURATION).toBeGreaterThan(0);
    expect(ENEMY_FORCE_FIELD_BREAK_END_SCALE).toBeGreaterThan(1);
    expect(ENEMY_FORCE_FIELD_BREAK_DEPTH).toBeGreaterThan(50);
  });

  it('draws an expanding double ring of shards in the barrier colour at the origin', () => {
    const g = new FakeGraphics();
    drawEnemyForceFieldBreakFlash(graphics(g), 40);

    expect(g.cleared).toBe(1);
    // Two rings read as the barrier shattering outward.
    expect(g.strokeCircleCalls).toHaveLength(2);
    expect(g.strokeCircleCalls[0][0]).toBe(0);
    expect(g.strokeCircleCalls[0][1]).toBe(0);
    expect(g.lineStyleCalls[0][1]).toBe(ENEMY_FORCE_FIELD_COLOR);
    // Shards radiate outward between the rings.
    expect(g.pathCommands).toBeGreaterThan(ENEMY_FORCE_FIELD_SEGMENTS);
  });

  it('spawns the flash at the break point, tracks it, and destroys it when the tween completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnEnemyForceFieldBreakFlash(scene, 300, 200, {
      registry,
      radius: 24,
    });

    expect(flash.x).toBe(300);
    expect(flash.y).toBe(200);
    expect(flash.depth).toBe(ENEMY_FORCE_FIELD_BREAK_DEPTH);
    expect(registry).toContain(flash);
    expect(scene.children.list).toContain(flash);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    const config = tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(ENEMY_FORCE_FIELD_BREAK_DURATION * 1000);
    expect(config.alpha).toBe(0);
    expect(config.scale).toBe(ENEMY_FORCE_FIELD_BREAK_END_SCALE);

    (config.onComplete as () => void)();
    expect(registry).not.toContain(flash);
    expect(flash.active).toBe(false);
  });
});

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
import { resolvePowerUpAtLevel } from '../../powerups/powerUpLevels';
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
 * Minimal registry stub reporting an active Force Field with a shared reflect
 * budget, so the bubble visual can be driven deterministically. The bubble's
 * armed gate is pool/permanence (`isForceFieldActive`), never a temporary
 * window (AH-0MVVD8TCJ004RLXP).
 */
function forceFieldAt(
  active = true,
  radius = SHIP_SIZE * 1.8,
  budget = 3,
): EffectsRegistry {
  return {
    isForceFieldActive: () => active,
    forceFieldRadius: () => radius,
    forceFieldRemaining: () => budget,
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

  it('draws the bubble at the shared colour/width/radius and steady fill while shielded', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('shield');
    const g = new FakeGraphics();

    const drawn = drawShieldBubble(graphics(g), { x: 100, y: 50 }, registry);

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls[0][0]).toBe(SHIELD_BUBBLE_LINE_WIDTH);
    expect(g.lineStyleCalls[0][1]).toBe(SHIELD_BUBBLE_COLOR);
    // The rim is a steady bright line at the armed baseline — the timed-window
    // countdown-driven pulse is retired with the wind-down
    // (AH-0MVVD8TCJ004RLXP).
    expect(g.lineStyleCalls[0][2]).toBe(SHIELD_BUBBLE_STROKE_ALPHA);
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

describe('CombatEffectVisuals — shield bubble armed by the charge pool (AH-0MVVD8TCJ004RLXP)', () => {
  it('draws a steady bright rim + steady fill while a pickup holds its one charge', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('shield'); // field pickup: one charge, level-window only
    expect(registry.isShielded).toBe(true);

    const g = new FakeGraphics();
    const drawn = drawShieldBubble(graphics(g), { x: 10, y: 20 }, registry);

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    // The timed-window ending fade is retired: every armed state draws the
    // same steady bright rim and translucent fill (dead-code decision
    // recorded on AH-0MVVD8TCJ004RLXP).
    expect(g.lineStyleCalls).toEqual([
      [SHIELD_BUBBLE_LINE_WIDTH, SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_STROKE_ALPHA],
    ]);
    expect(g.strokeCircleCalls).toEqual([[10, 20, SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR]]);
    expect(g.fillStyleCalls).toEqual([[SHIELD_BUBBLE_COLOR, SHIELD_BUBBLE_FILL_ALPHA]]);
    expect(g.fillCircleCalls).toEqual([[10, 20, SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR]]);
  });

  it('is steady — two draws with different level-window states are identical', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('shield');
    const a = new FakeGraphics();
    drawShieldBubble(graphics(a), { x: 7, y: 9 }, registry);

    // Advance the shared clock: the temporary level window counts down but
    // the granted charge is never clawed back, so the bubble must not change.
    registry.tick(3);
    const b = new FakeGraphics();
    drawShieldBubble(graphics(b), { x: 7, y: 9 }, registry);

    expect(b.lineStyleCalls).toEqual(a.lineStyleCalls);
    expect(b.fillStyleCalls).toEqual(a.fillStyleCalls);
    expect(b.strokeCircleCalls).toEqual(a.strokeCircleCalls);
  });

  it('keeps the bubble through the temporary-level TTL expiry while the charge is held', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('shield'); // pickup: one charge, level TTL 15 s
    expect(registry.powerUpTemporaryRemaining('shield')).toBeGreaterThan(0);

    // The level window expires: the temporary stack reverts but the granted
    // charge stays — the bubble must stay up because the pool, not the level,
    // is the arm signal (AH-0MVVD8TCJ004RLXP).
    registry.tick((registry.powerUpTemporaryRemaining('shield') ?? 0) + 1);
    expect(registry.powerUpTemporaryRemaining('shield')).toBeUndefined();
    expect(registry.isShielded).toBe(true);

    const g = new FakeGraphics();
    expect(drawShieldBubble(graphics(g), { x: 0, y: 0 }, registry)).toBe(true);
    expect(g.strokeCircleCalls).toEqual([[0, 0, SHIP_SIZE * SHIELD_BUBBLE_RADIUS_FACTOR]]);
  });

  it('pops when the last charge is spent and re-arms when a permanent shield recharges', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('shield', true); // hold-full: owned + one charge
    expect(registry.tryAbsorbShield()).toBe(true);
    expect(registry.isShielded).toBe(false);

    const popped = new FakeGraphics();
    expect(drawShieldBubble(graphics(popped), { x: 1, y: 2 }, registry)).toBe(false);
    expect(popped.strokeCircleCalls).toEqual([]);

    registry.tick((resolvePowerUpAtLevel('shield', 0).shieldRecharge ?? 0) + 0.1);
    expect(registry.isShielded).toBe(true);
    const rearmed = new FakeGraphics();
    expect(drawShieldBubble(graphics(rearmed), { x: 1, y: 2 }, registry)).toBe(true);
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
      forceFieldAt(true, radius),
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
      forceFieldAt(false),
    );
    expect(drawn).toBe(false);
    expect(g.cleared).toBe(1);
    expect(g.pathCommands).toBe(0);
  });

  it('pins the spent-state alphas: visible yet distinctly fainter than active', () => {
    expect(FORCE_FIELD_SPENT_STROKE_ALPHA).toBeGreaterThan(0);
    expect(FORCE_FIELD_SPENT_STROKE_ALPHA).toBeLessThan(FORCE_FIELD_STROKE_ALPHA);
    expect(FORCE_FIELD_SPENT_FILL_ALPHA).toBeGreaterThan(0);
    expect(FORCE_FIELD_SPENT_FILL_ALPHA).toBeLessThan(FORCE_FIELD_FILL_ALPHA);
  });

  it('draws a permanent-only field every frame', () => {
    const radius = SHIP_SIZE * 1.8;
    const registry = forceFieldAt(true, radius);
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
      forceFieldAt(true, SHIP_SIZE * 1.8, 0),
    );

    expect(drawn).toBe(true);
    expect(g.cleared).toBe(1);
    expect(g.lineStyleCalls[0]?.[2]).toBe(FORCE_FIELD_SPENT_STROKE_ALPHA);
    expect(g.fillStyleCalls[0]).toEqual([0x33ffcc, FORCE_FIELD_SPENT_FILL_ALPHA]);

    // The retired timed-window ending cues mean the bubble is steady: two
    // draws are identical (never a last-second brighten).
    const later = new FakeGraphics();
    drawForceFieldBubble(
      graphics(later),
      { x: 1, y: 2 },
      forceFieldAt(true, SHIP_SIZE * 1.8, 0),
    );
    expect(later.lineStyleCalls).toEqual(g.lineStyleCalls);
    expect(later.fillStyleCalls).toEqual(g.fillStyleCalls);
  });

  it('keeps a real permanent field drawn after its temporary level window expires', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('force_field', true); // hold-full reward
    registry.applyCollect('force_field'); // field pickup: one charge + level window
    expect(registry.powerUpTemporaryRemaining('force_field')).toBeGreaterThan(0);

    // The level window expires but the granted charge is never clawed back,
    // so the field stays armed and the bubble keeps drawing — the arm signal
    // is the pool/permanence, never the countdown (AH-0MVVD8TCJ004RLXP).
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

  it('draws a steady bright bubble while a pickup holds its one charge and pops on the last spend', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('force_field'); // pickup: one charge, level-window only
    expect(registry.isForceFieldActive()).toBe(true);
    expect(registry.forceFieldRemaining()).toBe(1);

    const armed = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(armed), { x: 0, y: 0 }, registry)).toBe(true);
    expect(armed.lineStyleCalls[0][2]).toBe(FORCE_FIELD_STROKE_ALPHA);
    expect(armed.fillStyleCalls[0]).toEqual([0x33ffcc, FORCE_FIELD_FILL_ALPHA]);

    // One reflected bullet spends the pickup's only charge. A pickup-only
    // field is NOT owned, so `isForceFieldActive` turns false and the bubble
    // pops — reconciling the spent-dim rule with "armed means holds a charge"
    // (AH-0MVVD8TCJ004RLXP).
    expect(registry.tryConsumeForceFieldReflect()).toBe(true);
    expect(registry.isForceFieldActive()).toBe(false);

    const popped = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(popped), { x: 0, y: 0 }, registry)).toBe(false);
    expect(popped.pathCommands).toBe(0);
  });

  it('is safe with no graphics or no player (and clears when only the player is missing)', () => {
    expect(drawForceFieldBubble(null, { x: 1, y: 2 }, forceFieldAt(true))).toBe(false);
    const g = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(g), null, forceFieldAt(true))).toBe(false);
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
    // Two hold-full grants fill the level-0 pool (cap 2).
    full.applyCollect('thorns', true);
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

  it('draws a pickup aura while its charge is held, through the level-TTL expiry, and pops on the last free ram', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('thorns'); // pickup: one charge, level-window only
    expect(registry.hasThornsRam()).toBe(true);

    // The level window expires but the charge is never clawed back: the aura
    // stays up because the pool, not the level, is the arm signal.
    registry.tick((registry.powerUpTemporaryRemaining('thorns') ?? 0) + 1);
    expect(registry.powerUpTemporaryRemaining('thorns')).toBeUndefined();
    expect(registry.hasThornsRam()).toBe(true);

    const armed = new FakeGraphics();
    expect(drawThornsAura(graphics(armed), { x: 10, y: 20 }, registry)).toBe(true);
    expect(armed.pathCommands).toBeGreaterThan(0);

    // The last free ram spends the pickup's one charge: the aura pops.
    expect(registry.tryConsumeThornsRam()).toBe(true);
    expect(registry.hasThornsRam()).toBe(false);
    const popped = new FakeGraphics();
    expect(drawThornsAura(graphics(popped), { x: 10, y: 20 }, registry)).toBe(false);
    expect(popped.pathCommands).toBe(0);
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

// ── Permanent consumable charge visuals (AH-0MVUXH3X60078QR3,  F6) ──
//
// A permanently-owned consumable (hold-full reward) is armed only while its
// shared charge pool holds a charge (parent AH-0MVTQMREN009DSFW AC1/AC3).
// These tests pin the armed/empty rendering for the three kinds with an
// in-world look (Shield bubble, Thorn aura, Force Field bubble): an empty
// permanent pool must never render an always-on armed visual, and the look
// must return when the charge regenerates through the shared tick.

describe('CombatEffectVisuals — permanent consumable charge visuals (AH-0MVUXH3X60078QR3)', () => {
  it('draws the Shield bubble while a permanent Shield holds a charge, clears when spent, and returns on recharge', () => {
    const registry = new EffectsRegistry();
    const player = { x: 100, y: 50 };

    // A hold-full reward adds exactly one charge and never levels (parent
    // AC1): the shield is armed only while that pool is non-empty.
    registry.applyCollect('shield', true);
    expect(registry.consumableCharges('shield')).toBe(1);

    const armed = new FakeGraphics();
    expect(drawShieldBubble(graphics(armed), player, registry)).toBe(true);
    expect(armed.strokeCircleCalls).toEqual([[100, 50, SHIP_SIZE * 1.6]]);

    // One absorbed hit spends the charge: an empty permanent pool renders no
    // always-on armed bubble (AC4).
    expect(registry.tryAbsorbShield()).toBe(true);
    expect(registry.consumableCharges('shield')).toBe(0);

    const empty = new FakeGraphics();
    expect(drawShieldBubble(graphics(empty), player, registry)).toBe(false);
    expect(empty.lineStyleCalls).toEqual([]);
    expect(empty.strokeCircleCalls).toEqual([]);

    // The charge regenerates on the level-derived interval through the shared
    // tick, and the armed visual returns with it (AC4).
    registry.tick((resolvePowerUpAtLevel('shield', 0).shieldRecharge ?? 0) + 0.1);
    expect(registry.consumableCharges('shield')).toBe(1);

    const rearmed = new FakeGraphics();
    expect(drawShieldBubble(graphics(rearmed), player, registry)).toBe(true);
    expect(rearmed.strokeCircleCalls).toEqual([[100, 50, SHIP_SIZE * 1.6]]);
  });

  it('draws the Thorn aura only while a permanent field holds charges and returns on recharge', () => {
    const registry = new EffectsRegistry();
    // Two hold-full grants fill the level-0 pool (cap 2).
    registry.applyCollect('thorns', true);
    registry.applyCollect('thorns', true);
    expect(registry.thornsRemaining()).toBe(2);

    const armed = new FakeGraphics();
    expect(drawThornsAura(graphics(armed), { x: 10, y: 20 }, registry)).toBe(true);
    expect(armed.pathCommands).toBeGreaterThan(0);

    // Two free rams spend the pool: the aura must clear (no always-on halo).
    expect(registry.tryConsumeThornsRam()).toBe(true);
    expect(registry.tryConsumeThornsRam()).toBe(true);
    expect(registry.thornsRemaining()).toBe(0);

    const empty = new FakeGraphics();
    expect(drawThornsAura(graphics(empty), { x: 10, y: 20 }, registry)).toBe(false);
    expect(empty.pathCommands).toBe(0);

    registry.tick((resolvePowerUpAtLevel('thorns', 0).thornsRecharge ?? 0) + 0.1);
    // Both spent charges owned a timer of the same interval, so both elapse
    // together and the pool returns to the full cap in one cycle (per-charge
    // regeneration, parent AC2): the aura re-arms with the full halo.
    expect(registry.thornsRemaining()).toBe(2);
    const rearmed = new FakeGraphics();
    expect(drawThornsAura(graphics(rearmed), { x: 10, y: 20 }, registry)).toBe(true);
    expect(rearmed.pathCommands).toBeGreaterThan(0);
  });

  it('dims the Force Field bubble while a permanent field is empty and re-arms when a charge returns', () => {
    const registry = new EffectsRegistry();
    registry.applyCollect('force_field', true);
    expect(registry.isForceFieldActive()).toBe(true);
    expect(registry.consumableCharges('force_field')).toBe(1);

    const armed = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(armed), { x: 0, y: 0 }, registry)).toBe(true);
    // Bright (armed) baseline.
    expect(armed.lineStyleCalls[0][2]).toBe(FORCE_FIELD_STROKE_ALPHA);
    expect(armed.fillStyleCalls[0][1]).toBe(FORCE_FIELD_FILL_ALPHA);

    // One reflected bullet spends the charge: the bubble stays up but dims
    // (Q1 = b — a spent permanent field reads as inert, never as gone).
    expect(registry.tryConsumeForceFieldReflect()).toBe(true);
    expect(registry.consumableCharges('force_field')).toBe(0);

    const empty = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(empty), { x: 0, y: 0 }, registry)).toBe(true);
    expect(empty.lineStyleCalls[0][2]).toBe(FORCE_FIELD_SPENT_STROKE_ALPHA);
    expect(empty.fillStyleCalls[0][1]).toBe(FORCE_FIELD_SPENT_FILL_ALPHA);

    // The charge regenerates on the level-derived interval: the bubble
    // brightens back to its armed baseline (AC4 re-arm).
    registry.tick((resolvePowerUpAtLevel('force_field', 0).forceFieldRecharge ?? 0) + 0.1);
    expect(registry.consumableCharges('force_field')).toBe(1);
    const rearmed = new FakeGraphics();
    expect(drawForceFieldBubble(graphics(rearmed), { x: 0, y: 0 }, registry)).toBe(true);
    expect(rearmed.lineStyleCalls[0][2]).toBe(FORCE_FIELD_STROKE_ALPHA);
    expect(rearmed.fillStyleCalls[0][1]).toBe(FORCE_FIELD_FILL_ALPHA);
  });
});

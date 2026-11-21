/**
 * Unit tests for the danger tacho HUD read-out (AH-0MWL7ORK8007LXJI AC5).
 *
 * The read-out is how a player sees the chain they are holding: the
 * multiplier, a pip per tier (shape, not colour), and the drain of the decay
 * window. The pure resolution is asserted directly; the drawing half is
 * asserted through observable getters and the tier-change glyph.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { HUD_DEPTH } from '../core/constants';
import { GrazeTracker } from '../core/graze';
import {
  DANGER_TACHO_BAR_WIDTH,
  DANGER_TACHO_GAIN_GLYPH,
  DANGER_TACHO_LOSS_GLYPH,
  DANGER_TACHO_NAME,
  DANGER_TACHO_PIP_COUNT,
  DANGER_TACHO_PREFIX,
  DangerTacho,
  formatDangerMultiplier,
  resolveDangerTacho,
} from './dangerTacho';

/** Minimal bootable scene for the read-out. */
class HudStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'DangerTachoStubScene' });
  }
}

describe('danger tacho — pure resolution (AH-0MWL7ORK8007LXJI AC5)', () => {
  it('labels the read-out with the multiplier and one pip per tier reached', () => {
    const state = resolveDangerTacho(1, 0, 0);
    expect(state.label).toBe(`${DANGER_TACHO_PREFIX} ×1`);
    expect(state.filledPips).toBe(1);
    expect(state.totalPips).toBe(DANGER_TACHO_PIP_COUNT);

    expect(resolveDangerTacho(2, 2, 0.5).label).toBe(
      `${DANGER_TACHO_PREFIX} ×2`,
    );
    expect(resolveDangerTacho(2, 2, 0.5).filledPips).toBe(3);
    expect(resolveDangerTacho(5, 4, 0).filledPips).toBe(DANGER_TACHO_PIP_COUNT);
  });

  it('formats every shipped tier without depending on colour', () => {
    expect(formatDangerMultiplier(1)).toBe('×1');
    expect(formatDangerMultiplier(1.5)).toBe('×1.5');
    expect(formatDangerMultiplier(2)).toBe('×2');
    expect(formatDangerMultiplier(3)).toBe('×3');
    expect(formatDangerMultiplier(5)).toBe('×5');
  });

  it('clamps the decay fraction into [0, 1] and carries the change glyph', () => {
    expect(resolveDangerTacho(2, 2, 2).decayFraction).toBe(1);
    expect(resolveDangerTacho(2, 2, -3).decayFraction).toBe(0);
    expect(resolveDangerTacho(2, 2, Number.NaN).decayFraction).toBe(0);
    expect(resolveDangerTacho(2, 2, 0.5, 'loss').change).toBe('loss');
    expect(resolveDangerTacho(2, 2, 0.5).change).toBeNull();
  });

  it('clamps a degenerate tier and multiplier to the bottom tier', () => {
    const state = resolveDangerTacho(Number.NaN, 99, 0);
    expect(state.tierIndex).toBe(DANGER_TACHO_PIP_COUNT - 1);
    expect(state.multiplier).toBe(1);
    expect(resolveDangerTacho(1, -4, 0).tierIndex).toBe(0);
    expect(resolveDangerTacho(1, -4, 0).filledPips).toBe(1);
  });

  it('reads the live tracker state without owning a rule of its own', () => {
    const tracker = new GrazeTracker();
    const bottom = resolveDangerTacho(
      tracker.multiplier,
      tracker.tierIndex,
      tracker.decayFraction,
    );
    expect(bottom.label).toBe(`${DANGER_TACHO_PREFIX} ×1`);
    expect(bottom.decayFraction).toBe(0);
  });
});

describe('danger tacho — drawing (AH-0MWL7ORK8007LXJI AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HudStubScene]);
    return booted.scene;
  }

  it('renders the label and pips, and drains the bar with the decay window', async () => {
    const scene = await boot();
    const tacho = new DangerTacho(scene, 100, 20);

    expect(tacho.name).toBe(DANGER_TACHO_NAME);
    // HUD depth: the read-out never hides under gameplay.
    expect(tacho.depth).toBe(HUD_DEPTH);
    expect(tacho.getLabelText()).toBe(`${DANGER_TACHO_PREFIX} ×1`);
    expect(tacho.getFilledPips()).toBe(1);

    // A jump from ×1 to ×3 announces the gain with its own glyph …
    tacho.updateState(resolveDangerTacho(3, 3, 0.5));
    expect(tacho.getLabelText()).toBe(
      `${DANGER_TACHO_GAIN_GLYPH} ${DANGER_TACHO_PREFIX} ×3`,
    );
    expect(tacho.getFilledPips()).toBe(4);
    expect(tacho.getState().decayFraction).toBe(0.5);

    // … which expires, leaving the plain read-out.
    tacho.updateState(resolveDangerTacho(3, 3, 0.5), 5);
    expect(tacho.getLabelText()).toBe(`${DANGER_TACHO_PREFIX} ×3`);

    // The bar is redrawn rather than merely hidden: the drain is a
    // proportional fill of the shared width.
    const buffer = tacho.getAt(0) as Phaser.GameObjects.Graphics;
    expect(buffer.commandBuffer).toContain(DANGER_TACHO_BAR_WIDTH * 0.5);

    tacho.destroy();
  });

  it('announces a tier gain and loss with a distinct glyph, not colour', async () => {
    const scene = await boot();
    const tacho = new DangerTacho(scene, 100, 20);

    tacho.updateState(resolveDangerTacho(1.5, 1, 1), 0);
    expect(tacho.isAnnouncingChange()).toBe(true);
    expect(tacho.getState().change).toBe('gain');
    expect(tacho.getLabelText().startsWith(DANGER_TACHO_GAIN_GLYPH)).toBe(true);

    // The glyph expires on its own timer.
    tacho.updateState(resolveDangerTacho(1.5, 1, 1), 5);
    expect(tacho.isAnnouncingChange()).toBe(false);
    expect(tacho.getLabelText()).toBe(`${DANGER_TACHO_PREFIX} ×1.5`);

    tacho.updateState(resolveDangerTacho(1, 0, 0), 0);
    expect(tacho.getState().change).toBe('loss');
    expect(tacho.getLabelText().startsWith(DANGER_TACHO_LOSS_GLYPH)).toBe(
      true,
    );

    tacho.destroy();
  });

  it('pops on a credited graze so the moment reads even without a tier change', async () => {
    const scene = await boot();
    const tacho = new DangerTacho(scene, 100, 20);
    expect(() => tacho.confirmGraze()).not.toThrow();
    tacho.destroy();
  });
});

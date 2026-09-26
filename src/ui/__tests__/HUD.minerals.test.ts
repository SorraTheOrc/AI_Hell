/**
 * HUD mineral hold bar tests (AH-0MUDYTM7C00071Y1).
 *
 * Contract for the hold display: a fixed-length, hollow-outlined bar that
 * fills proportionally as minerals are collected. This replaces the
 * `Minerals: n/20` text counter (AH-0MUCST45Q0054X19) while leaving the
 * underlying hold arithmetic (`GameState`) untouched.
 */

import { describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../../test/gameHarness';
import { EffectsRegistry } from '../../powerups/effects';
import {
  HUD,
  HUD_ROW_HEIGHT,
  MINERAL_BAR_NAME,
  MINERAL_BAR_STROKE,
  MINERAL_BAR_WIDTH,
} from '../HUD';

/** Bare scene — proves the HUD mineral bar needs no gym-specific logic. */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareSceneMinerals' });
  }
}

/** Inner fill width available at full capacity (px). */
const INNER_WIDTH = MINERAL_BAR_WIDTH - MINERAL_BAR_STROKE * 2;

/** Boots a HUD on a bare scene with an optional registry. */
async function bootHud(
  registry: EffectsRegistry | null = null,
  showLives = false,
): Promise<{ game: Phaser.Game; hud: HUD }> {
  const { game, scene } = await bootScene([BareScene]);
  const hud = new HUD(scene, registry, { showLives });
  return { game, hud };
}

/** The HUD's child objects, in container order. */
function hudChildren(hud: HUD): Phaser.GameObjects.GameObject[] {
  return (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
}

/** Finds the mineral bar Graphics on the HUD (named for test access). */
function barGraphics(hud: HUD): Phaser.GameObjects.Graphics {
  const bar = hudChildren(hud).find((c) => c.name === MINERAL_BAR_NAME);
  if (!bar) throw new Error('mineral bar Graphics not found');
  return bar as Phaser.GameObjects.Graphics;
}

describe('HUD mineral hold bar', () => {
  it('replaces the text counter with a visible fixed-length bar when a capacity is configured', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(3, 20);

    const state = hud.getMineralBarState();
    expect(state.visible).toBe(true);
    expect(state.total).toBe(INNER_WIDTH);
    expect(barGraphics(hud).visible).toBe(true);

    // No `Minerals: n/20` text child remains as the primary representation.
    const texts = hudChildren(hud)
      .filter((c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text)
      .map((t) => t.text);
    expect(texts.some((t) => t.includes('Minerals'))).toBe(false);

    game.destroy(true);
  });

  it('is hollow at empty: the outline is drawn with zero fill', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(0, 20);

    expect(hud.getMineralBarState()).toEqual({
      filled: 0,
      total: INNER_WIDTH,
      visible: true,
    });
    // The outline was drawn (non-empty command buffer) but nothing filled it.
    expect(barGraphics(hud).commandBuffer.length).toBeGreaterThan(0);

    game.destroy(true);
  });

  it('fills proportionally at mid hold (10/20)', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(10, 20);

    expect(hud.getMineralBarState().filled).toBe(Math.round(INNER_WIDTH / 2));

    game.destroy(true);
  });

  it('fills the whole inner width at capacity (20/20)', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(20, 20);

    const state = hud.getMineralBarState();
    expect(state.filled).toBe(INNER_WIDTH);
    expect(state.filled).toBe(state.total);

    game.destroy(true);
  });

  it('clamps the fill when the store exceeds capacity', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(25, 20);

    expect(hud.getMineralBarState().filled).toBe(INNER_WIDTH);

    game.destroy(true);
  });

  it('renders a perceptible minimum fill for any non-zero hold', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(1, 1000); // raw ratio rounds to 0 px

    const state = hud.getMineralBarState();
    expect(state.filled).toBeGreaterThan(0);
    expect(state.filled).toBeLessThanOrEqual(state.total);

    game.destroy(true);
  });

  it('hides the bar row entirely when capacity is 0', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(0, 0);

    expect(hud.getMineralBarState().visible).toBe(false);
    expect(barGraphics(hud).visible).toBe(false);

    game.destroy(true);
  });
});

describe('HUD mineral bar layout', () => {
  /** Y of the first active-effect text row ("Speed Boost"). */
  function firstEffectRowY(hud: HUD): number {
    const row = hudChildren(hud).find(
      (c) =>
        c instanceof Phaser.GameObjects.Text && c.text === 'Speed Boost',
    ) as Phaser.GameObjects.Text | undefined;
    if (!row) throw new Error('effect row not found');
    return row.y;
  }

  it('pushes effect rows below the bar', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    const { game, hud } = await bootHud(reg);
    hud.setMineralStore(3, 20);
    hud.refresh();

    // The bar owns the first row band; the effect list starts below it.
    expect(firstEffectRowY(hud)).toBeGreaterThanOrEqual(HUD_ROW_HEIGHT);

    game.destroy(true);
  });

  it('keeps effect rows at the top when capacity is 0', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('P5');
    const { game, hud } = await bootHud(reg);
    hud.setMineralStore(0, 0);
    hud.refresh();

    // With no bar row, the list starts at the container's top band.
    expect(firstEffectRowY(hud)).toBeLessThan(HUD_ROW_HEIGHT);

    game.destroy(true);
  });
});

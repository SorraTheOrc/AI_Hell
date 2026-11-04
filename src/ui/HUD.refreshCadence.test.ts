/**
 * HUD refresh cadence (AH-0MVXV0FFJ0066EC8).
 *
 * The HUD is refreshed on the scene's per-frame path, but the row list it
 * renders changes far more slowly than the frame rate (a countdown moves once
 * per second, a loadout only on a pickup/spend). Rebuilding every row's
 * `Text`/`Graphics` objects per frame — the pre-change behaviour — forced a
 * canvas text re-render and a texture upload per row per frame for state that
 * had not changed.
 *
 * These tests pin the observable contract of the redraw-on-change path: the
 * rendered rows are stable objects while the state is stable, and every state
 * change that a player can see still reaches the screen on the next refresh.
 * They assert through the public surface (rendered text, container children,
 * the mineral-bar accessors) rather than by inspecting the signature itself.
 */

import { describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import { EffectsRegistry } from '../powerups/effects';
import { HUD, MINERAL_BAR_NAME } from './HUD';

/** Bare scene — the HUD needs no gym/game logic. */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareSceneHudCadence' });
  }
}

/** Boots a HUD on a bare scene with an optional registry. */
async function bootHud(
  registry: EffectsRegistry | null = null,
  showLives = true,
): Promise<{ game: Phaser.Game; hud: HUD }> {
  const { game, scene } = await bootScene([BareScene]);
  const hud = new HUD(scene, registry, { showLives });
  return { game, hud };
}

/** The HUD's direct children, in container order. */
function hudChildren(hud: HUD): Phaser.GameObjects.GameObject[] {
  return (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
}

/** A rendered text child by its exact string. */
function textChild(
  hud: HUD,
  text: string,
): Phaser.GameObjects.Text | undefined {
  return hudChildren(hud).find(
    (c): c is Phaser.GameObjects.Text =>
      c instanceof Phaser.GameObjects.Text && c.text === text,
  );
}

/** The mineral hold bar Graphics (named for test access). */
function barGraphics(hud: HUD): Phaser.GameObjects.Graphics {
  const bar = hudChildren(hud).find((c) => c.name === MINERAL_BAR_NAME);
  if (!bar) throw new Error('mineral bar Graphics not found');
  return bar as Phaser.GameObjects.Graphics;
}

describe('HUD redraw-on-change cadence (AH-0MVXV0FFJ0066EC8)', () => {
  it('keeps the rendered row objects when a refresh finds no state change', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('bomb', true); // permanent: label and value never change
    const { game, hud } = await bootHud(reg);

    const label = textChild(hud, 'Bomb Lvl 1');
    const children = hudChildren(hud).length;
    expect(label).toBeDefined();

    hud.refresh();
    hud.refresh();

    // Same rendered row, same objects: nothing was destroyed and re-created.
    expect(textChild(hud, 'Bomb Lvl 1')).toBe(label);
    expect(hudChildren(hud).length).toBe(children);

    game.destroy(true);
  });

  it('re-renders a countdown row when the remaining seconds change', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootHud(reg);

    const tenSeconds = textChild(hud, '10s');
    expect(tenSeconds).toBeDefined();

    reg.tick(1);
    hud.refresh();

    // The value column advances (and the row objects were rebuilt with it).
    expect(hud.getRows()[0].value).toBe('9s');
    expect(textChild(hud, '9s')).toBeDefined();
    expect(textChild(hud, '10s')).toBeUndefined();
    expect(textChild(hud, '9s')).not.toBe(tenSeconds);

    game.destroy(true);
  });

  it('renders a newly collected effect on the next refresh', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootHud(reg);
    expect(hud.getRows()).toHaveLength(0);

    reg.applyCollect('bomb', true);
    hud.refresh();

    expect(textChild(hud, 'Bomb Lvl 1')).toBeDefined();
    expect(hud.getRows().map((row) => row.id)).toEqual(['bomb']);

    game.destroy(true);
  });

  it('renders a changed lives counter on the next refresh', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootHud(reg);
    const before = hud.getLivesLabel();

    reg.setLives(reg.lives() + 1);
    hud.refresh();

    expect(hud.getLivesLabel()).not.toBe(before);
    expect(textChild(hud, hud.getLivesLabel())).toBeDefined();

    game.destroy(true);
  });

  it('re-lays out the rows when the mineral bar row appears', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('bomb', true);
    const { game, hud } = await bootHud(reg, false);

    const topRowY = () => textChild(hud, 'Bomb Lvl 1')?.y;
    const withoutBar = topRowY();
    expect(withoutBar).toBeDefined();

    hud.setMineralStore(3, 20);

    // The bar owns the first row band, so the effect list moves down by one
    // row even though the row's own text is unchanged.
    expect(topRowY()).toBeGreaterThan(withoutBar as number);

    game.destroy(true);
  });

  it('redraws the mineral bar only when its geometry changes', async () => {
    const { game, hud } = await bootHud();
    hud.setMineralStore(3, 20);

    const bar = barGraphics(hud);
    const clear = vi.spyOn(bar, 'clear');
    hud.refresh();
    hud.refresh();
    expect(clear).not.toHaveBeenCalled();

    hud.setMineralStore(10, 20); // the fill grows
    expect(clear).toHaveBeenCalledTimes(1);
    expect(hud.getMineralBarState().filled).toBeGreaterThan(0);

    game.destroy(true);
  });

  it('does not accumulate row objects over many unchanged frames', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('bomb', true);
    reg.applyCollect('shield', true);
    const { game, hud } = await bootHud(reg);

    const children = hudChildren(hud).length;
    for (let frame = 0; frame < 120; frame += 1) {
      hud.refresh();
    }

    expect(hudChildren(hud).length).toBe(children);
    expect(hud.getRows()).toHaveLength(2);

    game.destroy(true);
  });
});

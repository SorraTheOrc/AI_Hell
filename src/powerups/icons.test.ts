/**
 * Tests for the code-drawn drop visuals (GDD §4.4, §7.1): the glowing
 * bubble helper and the combined drop drawers that render bubble + icon
 * together (AH-0MTG5MGPZ00986B4 — "Power ups need to be larger").
 *
 * Phaser Graphics is not rasterised in CI (src/test/setup.ts stubs the
 * canvas context), so the presence of drawn geometry is asserted via the
 * Graphics `commandBuffer` — the list of draw commands that would be
 * rendered. This mirrors the manual visual check (npm run dev) at the
 * unit level.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  drawDropBubble,
  drawPowerUpDrop,
  drawPowerUpIcon,
  drawWeaponDrop,
  drawWeaponIcon,
  WeaponDropIconId,
} from './icons';
import { PowerUpType } from './types';

/** Minimal scene used only to allocate Graphics objects. */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareScene' });
  }
}

describe('drop visuals (AH-0MTG5MGPZ00986B4): glowing bubble', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots a bare scene and returns it, so tests can allocate Graphics. */
  async function bootBare(): Promise<Phaser.Scene> {
    booted = await bootScene([BareScene]);
    return booted!.scene as Phaser.Scene;
  }

  it('drawDropBubble appends glow + ring draw commands (never clears) to a Graphics', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    const before = g.commandBuffer.length;

    drawDropBubble(g, 0, 0, 32, 0x00ffff);
    expect(g.commandBuffer.length).toBeGreaterThan(before); // ring + halo drawn

    // Appends, not destructive: a second bubble adds more commands.
    const afterFirst = g.commandBuffer.length;
    drawDropBubble(g, 10, 10, 32, 0xff6ec7);
    expect(g.commandBuffer.length).toBeGreaterThan(afterFirst);
  });

  it('drawPowerUpDrop renders bubble + icon for every non-combat type — strictly more geometry than the bare icon', async () => {
    const scene = await bootBare();
    for (const type of [
      PowerUpType.SPEED_BOOST,
      PowerUpType.EXTRA_LIFE,
      PowerUpType.MAGNET,
    ]) {
      const icon = scene.add.graphics();
      drawPowerUpIcon(icon, type, 0, 0, 32);
      const iconCommands = icon.commandBuffer.length;

      const drop = scene.add.graphics();
      drawPowerUpDrop(drop, type, 0, 0, 32);
      // The full drop = glowing bubble + icon → more draw commands.
      expect(drop.commandBuffer.length).toBeGreaterThan(iconCommands);
    }
  });

  it('drawWeaponDrop renders bubble + icon for every weapon type and reset — strictly more geometry than the bare icon', async () => {
    const scene = await bootBare();
    const ids: WeaponDropIconId[] = ['cannon', 'spread', 'dual', 'rapid', 'reset'];
    for (const id of ids) {
      const icon = scene.add.graphics();
      drawWeaponIcon(icon, id, 0, 0, 32);
      const iconCommands = icon.commandBuffer.length;

      const drop = scene.add.graphics();
      drawWeaponDrop(drop, id, 0, 0, 32);
      expect(drop.commandBuffer.length).toBeGreaterThan(iconCommands);
    }
  });
});
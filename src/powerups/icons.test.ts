/**
 * Tests for the code-drawn drop visuals (GDD §4.4, §7.1): the glowing
 * bubble helper and the combined drop drawers that render bubble + icon
 * together (AH-0MTG5MGPZ00986B4 — "Power ups need to be larger").
 *
 * Phaser Graphics is not rasterised in CI (src/test/setup.ts stubs the
 * canvas context), so the presence of drawn geometry is asserted via the
 * Graphics `commandBuffer` — a flat array of Phaser command opcodes and
 * their parameters. This mirrors the manual visual check (npm run dev)
 * at the unit level.
 *
 * Weapon-icon geometry tests (AH-0MUAYB5UK0052P1D): verify that each
 * icon emits the expected draw commands to reflect its firing behaviour.
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

// ── Phaser Graphics command-opcode constants ──────────────────────

const Cmd = {
  ARC: 0,
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
  FILL_RECT: 3,
  LINE_TO: 4,
  MOVE_TO: 5,
  LINE_STYLE: 6,
  FILL_STYLE: 7,
  FILL_PATH: 8,
  STROKE_PATH: 9,
  FILL_TRIANGLE: 10,
} as const;

/**
 * Phaser command buffer is a flat array of opcodes and parameters.
 * Arc commands: opcode(0) + 7 params (x, y, radius, startAngle, endAngle, anticlockwise, overshoot).
 */

// ── Weapon icon geometry tests (AH-0MUAYB5UK0052P1D) ──────────────

describe('weapon icon geometry (AH-0MUAYB5UK0052P1D)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootBare(): Promise<Phaser.Scene> {
    booted = await bootScene([BareScene]);
    return booted!.scene as Phaser.Scene;
  }

  /** Count ARC draw commands in the command buffer. */
  function countArcCommands(buf: number[]): number {
    let count = 0;
    for (let i = 0; i < buf.length; ) {
      if (buf[i] === Cmd.ARC) {
        count++;
        i += 1 + 7; // opcode + 7 params
      } else if (buf[i] === Cmd.LINE_STYLE) {
        i += 1 + 3;
      } else if (buf[i] === Cmd.FILL_STYLE) {
        i += 1 + 2;
      } else if (buf[i] === Cmd.FILL_RECT) {
        i += 1 + 4;
      } else {
        i++;
      }
    }
    return count;
  }

  /**
   * Count line-segment draw commands (MOVE_TO and LINE_TO entries).
   * Each line drawn requires a MOVE_TO followed by a LINE_TO — two
   * entries in the flat command buffer.
   */
  function countLineSegments(buf: number[]): number {
    let count = 0;
    for (let i = 0; i < buf.length; ) {
      const op = buf[i];
      if (op === Cmd.LINE_TO) {
        count++;
        i += 1 + 2;
      } else if (op === Cmd.MOVE_TO) {
        count++;
        i += 1 + 2;
      } else if (op === Cmd.LINE_STYLE) {
        i += 1 + 3;
      } else if (op === Cmd.FILL_STYLE) {
        i += 1 + 2;
      } else if (op === Cmd.FILL_RECT) {
        i += 1 + 4;
      } else {
        i++;
      }
    }
    return count;
  }

  it('rapid icon draws stacked dots (≥ 4 arc commands), not a waveform', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'rapid', 0, 0, 32);
    expect(countArcCommands(g.commandBuffer as number[])).toBeGreaterThanOrEqual(4);
  });

  it('rapid icon has more dot outlines than cannon icon', async () => {
    const scene = await bootBare();
    const rapid = scene.add.graphics();
    drawWeaponIcon(rapid, 'rapid', 0, 0, 32);
    const rapidArcCount = countArcCommands(rapid.commandBuffer as number[]);

    const cannon = scene.add.graphics();
    drawWeaponIcon(cannon, 'cannon', 0, 0, 32);
    const cannonArcCount = countArcCommands(cannon.commandBuffer as number[]);

    expect(rapidArcCount).toBeGreaterThan(cannonArcCount);
  });

  it('cannon icon draws a barrel line and bullet circle', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'cannon', 0, 0, 32);
    expect(countArcCommands(g.commandBuffer as number[])).toBeGreaterThanOrEqual(1);
    expect(countLineSegments(g.commandBuffer as number[])).toBeGreaterThanOrEqual(2);
  });

  it('spread icon draws a 3-line fan', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'spread', 0, 0, 32);
    expect(countLineSegments(g.commandBuffer as number[])).toBeGreaterThanOrEqual(3);
  });

  it('dual icon draws two parallel bars', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'dual', 0, 0, 32);
    expect(countLineSegments(g.commandBuffer as number[])).toBeGreaterThanOrEqual(2);
  });

  it('reset icon draws an arc + arrowhead lines', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'reset', 0, 0, 32);
    const lineSegments = countLineSegments(g.commandBuffer as number[]);
    expect(lineSegments).toBeGreaterThanOrEqual(2);
  });

  it('all weapon icons are visually distinct from each other', async () => {
    const scene = await bootBare();
    const icons: WeaponDropIconId[] = ['cannon', 'spread', 'dual', 'rapid', 'reset'];
    const profiles: Array<{
      id: WeaponDropIconId;
      arcCount: number;
      lineSegments: number;
    }> = [];
    for (const id of icons) {
      const g = scene.add.graphics();
      drawWeaponIcon(g, id, 0, 0, 32);
      profiles.push({
        id,
        arcCount: countArcCommands(g.commandBuffer as number[]),
        lineSegments: countLineSegments(g.commandBuffer as number[]),
      });
    }
    // No two icons should share the same (arcCount, lineSegments) profile.
    const seen = new Set<string>();
    for (const p of profiles) {
      const key = `${p.arcCount}-${p.lineSegments}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// ── Original drop-visual tests (AH-0MTG5MGPZ00986B4) ─────────────

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
      PowerUpType.SHIELD,
      PowerUpType.BOMB,
      PowerUpType.SPEED_BOOST,
      PowerUpType.PHASE_SHIFT,
      PowerUpType.TELEPORT,
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

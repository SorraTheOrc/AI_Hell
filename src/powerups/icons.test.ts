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
  drawCountdownRing,
  drawDropBubble,
  drawPowerUpDrop,
  drawPowerUpIcon,
  drawWeaponDrop,
  drawWeaponIcon,
  dropBubbleRadius,
  dropCollectRadius,
  ICON_COLORS,
  MIN_RING_SWEEP,
  RING_RADIUS,
  RING_STROKE_WIDTH,
  weaponIconColour,
  WeaponDropIconId,
} from './icons';
import { POWER_UP_DROP_SIZE, WEAPON_DROP_SIZE } from '../core/constants';

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
    const icons: WeaponDropIconId[] = [
      'cannon',
      'spread',
      'dual',
      'rapid',
      'nova',
      'mortar',
      'arc',
      'reset',
    ];
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

  describe('drop collection radius matches the visible bubble (AH-0MTVYCM2N002NKE4)', () => {
    it('derives the ring and collection radius from the shared 1.4× bubble factor', () => {
      // 16 px icon × 1.4 = 22.4 px crisp ring at full scale.
      expect(dropBubbleRadius(POWER_UP_DROP_SIZE)).toBeCloseTo(22.4, 5);
      expect(dropCollectRadius(POWER_UP_DROP_SIZE, 1)).toBeCloseTo(22.4, 5);
    });

    it('tracks the lifecycle scale proportionally (grow / hold / shrink)', () => {
      expect(dropCollectRadius(POWER_UP_DROP_SIZE, 0.5)).toBeCloseTo(11.2, 5);
      expect(dropCollectRadius(POWER_UP_DROP_SIZE, 0.03)).toBeCloseTo(0.672, 5);
      expect(dropCollectRadius(POWER_UP_DROP_SIZE, 0)).toBe(0);
    });

    it('is the single source of truth shared by the bubble and every drop family', () => {
      // Collection radius at scale 1 is exactly the drawn ring radius.
      expect(dropCollectRadius(POWER_UP_DROP_SIZE, 1)).toBeCloseTo(
        dropBubbleRadius(POWER_UP_DROP_SIZE),
        10,
      );
      // Weapon drops use the same derivation (WEAPON_DROP_SIZE mirrors the power-up size).
      expect(dropCollectRadius(WEAPON_DROP_SIZE, 1)).toBeCloseTo(
        dropBubbleRadius(POWER_UP_DROP_SIZE),
        10,
      );
    });
  });

  it('drawPowerUpDrop renders bubble + icon for every non-combat type — strictly more geometry than the bare icon', async () => {
    const scene = await bootBare();
    for (const type of [
      'shield',
      'bomb',
      'speed_boost',
      'phase_shift',
      'teleport',
      'extra_life',
      'magnet',
      'mineral_scoop',
      'smart_bomb',
      'force_field',
      'mystery_ufo',
      'mining_laser',
    ] as const) {
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
    const ids: WeaponDropIconId[] = [
      'cannon',
      'spread',
      'dual',
      'rapid',
      'nova',
      'mortar',
      'arc',
      'reset',
    ];
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

describe('Mining Laser drop icon (AH-0MW9QMRC7007HVHQ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootBare(): Promise<Phaser.Scene> {
    booted = await bootScene([BareScene]);
    return booted!.scene as Phaser.Scene;
  }

  it('draws a distinctive cutting-beam + rock glyph, not empty and not a bolt', async () => {
    const scene = await bootBare();
    const mining = scene.add.graphics();
    drawPowerUpIcon(mining, 'mining_laser', 0, 0, 32);
    const miningCommands = mining.commandBuffer.length;

    // The glyph is code-drawn: it emits real geometry through the shared icon
    // path (never a colourless / blank icon).
    expect(miningCommands).toBeGreaterThan(0);
    // It includes a filled rock polygon and a hot spark — at least two fills.
    const fills = mining.commandBuffer.filter((v) => v === Cmd.FILL_STYLE).length;
    expect(fills).toBeGreaterThanOrEqual(2);

    // Visually distinct from the sibling auto-targeting Orbital Strike icon:
    // the two kinds must not share an identical command buffer.
    const strike = scene.add.graphics();
    drawPowerUpIcon(strike, 'strike', 0, 0, 32);
    expect(mining.commandBuffer).not.toEqual(strike.commandBuffer);
  });

  it('uses its palette colour from ICON_COLORS (mint, mineral economy)', async () => {
    const scene = await bootBare();
    const mining = scene.add.graphics();
    drawPowerUpIcon(mining, 'mining_laser', 0, 0, 32);
    expect(ICON_COLORS.mining_laser).toBe(0x7cffb2);
    // The first line-style command carries the icon colour.
    expect(mining.commandBuffer).toContain(ICON_COLORS.mining_laser);
  });
});

describe('AOE weapon icons (F5 AC4)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootBare(): Promise<Phaser.Scene> {
    booted = await bootScene([BareScene]);
    return booted!.scene as Phaser.Scene;
  }
  /** Count ARC draw commands in a graphics command buffer. */
  function countArcCommands(buf: number[]): number {
    let count = 0;
    for (let i = 0; i < buf.length; ) {
      if (buf[i] === Cmd.ARC) {
        count++;
        i += 1 + 7;
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

  /** Count MOVE_TO/LINE_TO commands in a graphics command buffer. */
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

  it('Nova draws concentric rings (≥ 2 arc commands)', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'nova', 0, 0, 32);
    expect(countArcCommands(g.commandBuffer as number[])).toBeGreaterThanOrEqual(2);
  });

  it('Mortar draws an arc + trajectory/blast lines', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'mortar', 0, 0, 32);
    expect(countArcCommands(g.commandBuffer as number[])).toBeGreaterThanOrEqual(1);
    expect(countLineSegments(g.commandBuffer as number[])).toBeGreaterThanOrEqual(4);
  });

  it('Arc draws a jagged multi-segment bolt (≥ 4 line segments, no arcs)', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawWeaponIcon(g, 'arc', 0, 0, 32);
    expect(countArcCommands(g.commandBuffer as number[])).toBe(0);
    expect(countLineSegments(g.commandBuffer as number[])).toBeGreaterThanOrEqual(4);
  });
});

// ── HUD countdown ring tests (AH-0MW2AXUEE0026OUY) ────────────────

interface RingArcCommand {
  x: number;
  y: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  anticlockwise: boolean;
  /** The stroke width of the `lineStyle` in effect before the arc. */
  strokeWidth: number | undefined;
  /** The stroke colour of the `lineStyle` in effect before the arc. */
  colour: number | undefined;
}

/**
 * Every `arc()` emitted to a Graphics, each tagged with the `lineStyle`
 * that was in effect when it was drawn (the command's parameters live
 * immediately before the arc opcode in Phaser's flat command buffer).
 * Table-driven so icon geometry (lines, triangles, fills) is skipped
 * correctly when a ring is drawn on a Graphics that already holds a glyph.
 */
function ringArcCommands(buf: number[]): RingArcCommand[] {
  // Opcode → parameter count (Phaser Commands.js; see the Cmd table above).
  const PARAMS: Record<number, number> = {
    [Cmd.ARC]: 7,
    [Cmd.LINE_TO]: 2,
    [Cmd.MOVE_TO]: 2,
    [Cmd.LINE_STYLE]: 3,
    [Cmd.FILL_STYLE]: 2,
    [Cmd.FILL_RECT]: 4,
    [Cmd.FILL_TRIANGLE]: 6,
  };
  const arcs: RingArcCommand[] = [];
  let strokeWidth: number | undefined;
  let colour: number | undefined;
  for (let i = 0; i < buf.length; ) {
    const op = buf[i];
    if (op === Cmd.LINE_STYLE) {
      strokeWidth = buf[i + 1];
      colour = buf[i + 2];
      i += 1 + PARAMS[op];
    } else if (op === Cmd.ARC) {
      arcs.push({
        x: buf[i + 1],
        y: buf[i + 2],
        radius: buf[i + 3],
        startAngle: buf[i + 4],
        endAngle: buf[i + 5],
        anticlockwise: buf[i + 6] === 1,
        strokeWidth,
        colour,
      });
      i += 1 + PARAMS[op];
    } else {
      i += 1 + (PARAMS[op] ?? 0);
    }
  }
  return arcs;
}

/** The countdown ring arc (drawn at {@link RING_RADIUS}), if any. */
function ringArcOf(buf: number[]): RingArcCommand | undefined {
  return ringArcCommands(buf).find(
    (entry) => Math.abs(entry.radius - RING_RADIUS) < 1e-6,
  );
}

/** The sweep of an arc as a fraction of a full turn. */
function ringArcSweep(arc: RingArcCommand): number {
  return Math.abs(arc.endAngle - arc.startAngle) / (Math.PI * 2);
}

describe('HUD countdown ring (AH-0MW2AXUEE0026OUY): drawCountdownRing', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootBare(): Promise<Phaser.Scene> {
    booted = await bootScene([BareScene]);
    return booted!.scene as Phaser.Scene;
  }

  it('AC1: draws a single ring arc at RING_RADIUS with RING_STROKE_WIDTH centred on (x, y)', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawCountdownRing(g, 12, 34, 0.5, 0x00ffff);

    const ring = ringArcOf(g.commandBuffer as number[]);
    expect(ring).toBeDefined();
    expect(ring!.radius).toBe(RING_RADIUS);
    expect(ring!.x).toBe(12); // centred on the icon
    expect(ring!.y).toBe(34);
    expect(ring!.strokeWidth).toBe(RING_STROKE_WIDTH);
    // Exactly one arc: the ring, nothing else.
    expect(ringArcCommands(g.commandBuffer as number[])).toHaveLength(1);
  });

  it('AC2: fraction 0.5 sweeps 180° clockwise from 12 o’clock', async () => {
    const scene = await bootBare();
    const g = scene.add.graphics();
    drawCountdownRing(g, 0, 0, 0.5, 0xffffff);

    const ring = ringArcOf(g.commandBuffer as number[]);
    expect(ring).toBeDefined();
    expect(ring!.startAngle).toBeCloseTo(-Math.PI / 2, 6); // 12 o'clock
    expect(ring!.endAngle - ring!.startAngle).toBeCloseTo(Math.PI, 6); // 180°
    expect(ring!.anticlockwise).toBe(false); // clockwise on screen
  });

  it('AC2b: the sweep grows linearly with the fraction across the unit range', async () => {
    const scene = await bootBare();
    for (const [fraction, expectedSweep] of [
      [0.25, 0.25],
      [0.5, 0.5],
      [1, 1],
    ] as const) {
      const g = scene.add.graphics();
      drawCountdownRing(g, 0, 0, fraction, 0xffffff);
      expect(ringArcSweep(ringArcOf(g.commandBuffer as number[])!)).toBeCloseTo(
        expectedSweep,
        6,
      );
    }
  });

  it('AC3: draws the ring in the caller-supplied palette colour (item hue and weapon hue)', async () => {
    const scene = await bootBare();

    const item = scene.add.graphics();
    drawCountdownRing(item, 0, 0, 0.5, ICON_COLORS.speed_boost);
    expect(ringArcOf(item.commandBuffer as number[])!.colour).toBe(
      ICON_COLORS.speed_boost,
    );

    const weapon = scene.add.graphics();
    drawCountdownRing(weapon, 0, 0, 0.5, weaponIconColour('spread'));
    const weaponRing = ringArcOf(weapon.commandBuffer as number[])!;
    expect(weaponRing.colour).toBe(weaponIconColour('spread'));
    // The weapon seam comes from the palette table, not a single constant:
    // reset's white return-arrow colour differs from a weapon hue.
    expect(weaponIconColour('reset')).toBe(0xffffff);
    expect(weaponIconColour('spread')).not.toBe(weaponIconColour('reset'));
  });

  it('AC4: keeps a minimum visible sweep when the fraction is near zero, and draws nothing at zero', async () => {
    const scene = await bootBare();

    const nearZero = scene.add.graphics();
    drawCountdownRing(nearZero, 0, 0, 0.001, 0xffffff);
    const tiny = ringArcOf(nearZero.commandBuffer as number[]);
    expect(tiny).toBeDefined();
    expect(ringArcSweep(tiny!)).toBeCloseTo(MIN_RING_SWEEP, 6);

    const zero = scene.add.graphics();
    drawCountdownRing(zero, 0, 0, 0, 0xffffff);
    expect(ringArcOf(zero.commandBuffer as number[])).toBeUndefined();
  });

  it('clamps out-of-range fractions into [0, 1]', async () => {
    const scene = await bootBare();

    const over = scene.add.graphics();
    drawCountdownRing(over, 0, 0, 1.5, 0xffffff);
    expect(ringArcSweep(ringArcOf(over.commandBuffer as number[])!)).toBeCloseTo(1, 6);

    const under = scene.add.graphics();
    drawCountdownRing(under, 0, 0, -0.5, 0xffffff);
    expect(ringArcOf(under.commandBuffer as number[])).toBeUndefined();
  });

  it('AC5: appends the ring to the existing row Graphics and creates no new object', async () => {
    const scene = await bootBare();
    const icon = scene.add.graphics();
    drawPowerUpIcon(icon, 'speed_boost', 0, 0, 8); // the row glyph, same Graphics
    const childrenBefore = scene.children.list.length;

    drawCountdownRing(icon, 0, 0, 0.5, ICON_COLORS.speed_boost);

    expect(scene.children.list.length).toBe(childrenBefore); // no new object
    // The ring arc rides on the same Graphics whose buffer holds the glyph.
    expect(ringArcOf(icon.commandBuffer as number[])).toBeDefined();
  });
});

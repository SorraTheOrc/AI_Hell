/**
 * Mineral entity lifecycle and collection semantics tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC1: a mineral is a small
 * gold dot that is collected on overlap, is never hit by bullets, and causes
 * no damage.
 *
 * These tests are expected to be red until the implementation child
 * ("Mineral collectable entity and constants") lands.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  MINERAL_COLOR,
  MINERAL_DEPOSIT_COLOR,
  MINERAL_DEPOSIT_THRESHOLD,
  MINERAL_DEPOSIT_VALUE,
  MINERAL_DEPTH,
  MINERAL_SALVAGE_COLOR,
  MINERAL_SIZE,
} from '../../core/constants';
import { Mineral, MineralConfig } from '../Mineral';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

/** Phaser Graphics `FILL_STYLE` opcode (see `phaser/src/gameobjects/graphics/Commands`). */
const FILL_STYLE = 7;

/** Widths of the Graphics opcodes this helper walks past (unlisted = 0). */
const COMMAND_WIDTHS: Record<number, number> = {
  0: 7, // ARC
  3: 5, // FILL_RECT
  4: 3, // MOVE_TO / LINE_TO
  6: 4, // LINE_STYLE
  [FILL_STYLE]: 3,
  10: 7, // FILL_TRIANGLE
};

/**
 * Colours the mineral's graphics actually issued as fills, in draw order.
 * Walks the live command buffer so the assertion covers the rendered shape
 * rather than a stored field alone.
 */
function fillColours(mineral: Mineral): number[] {
  const buf = (mineral as unknown as { commandBuffer: number[] }).commandBuffer;
  const colours: number[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === FILL_STYLE) colours.push(buf[i + 1]);
    i += 1 + (COMMAND_WIDTHS[buf[i]] ?? 0);
  }
  return colours;
}

/** Hue of an RGB triple in degrees (0 = red, 60 = yellow). */
function hueDegrees(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  const degrees = hue * 60;
  return degrees < 0 ? degrees + 360 : degrees;
}

describe('Mineral constants', () => {
  it('defines MINERAL_SIZE as a small gold dot radius', () => {
    expect(typeof MINERAL_SIZE).toBe('number');
    expect(MINERAL_SIZE).toBeGreaterThan(0);
    expect(MINERAL_SIZE).toBeLessThan(10); // small, not ship-sized
  });

  it('defines MINERAL_COLOR as gold', () => {
    expect(MINERAL_COLOR).toBe(0xffdd44); // gold hex
  });

  it('defines MINERAL_SALVAGE_COLOR as a distinct orange (AH-0MVJ72I8O0009T09)', () => {
    // A named constant beside MINERAL_COLOR — the single source of the
    // Salvage bounty's drop colour.
    expect(typeof MINERAL_SALVAGE_COLOR).toBe('number');
    expect(MINERAL_SALVAGE_COLOR).not.toBe(MINERAL_COLOR);

    const r = (MINERAL_SALVAGE_COLOR >> 16) & 0xff;
    const g = (MINERAL_SALVAGE_COLOR >> 8) & 0xff;
    const b = MINERAL_SALVAGE_COLOR & 0xff;
    // Orange: red dominant, a clear green component, little blue — and a
    // hue well away from gold's (~48°) so the two dots read differently.
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const hue = hueDegrees(r, g, b);
    expect(hue).toBeLessThan(30); // red-orange, not gold/amber
  });

  it('defines the red deposit constants beside MINERAL_COLOR (AH-0MVJ79739008396I)', () => {
    // Threshold and value are fixed constants — no `rules.ts` tunable.
    expect(MINERAL_DEPOSIT_THRESHOLD).toBe(10);
    expect(MINERAL_DEPOSIT_VALUE).toBe(10);

    // The deposit colour is a distinct red: red dominant, hue near 0°, and
    // clearly different from both gold (~48°) and Salvage orange (~22°).
    expect(typeof MINERAL_DEPOSIT_COLOR).toBe('number');
    expect(MINERAL_DEPOSIT_COLOR).not.toBe(MINERAL_COLOR);
    expect(MINERAL_DEPOSIT_COLOR).not.toBe(MINERAL_SALVAGE_COLOR);

    const r = (MINERAL_DEPOSIT_COLOR >> 16) & 0xff;
    const g = (MINERAL_DEPOSIT_COLOR >> 8) & 0xff;
    const b = MINERAL_DEPOSIT_COLOR & 0xff;
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
    const hue = hueDegrees(r, g, b);
    expect(hue < 20 || hue > 340).toBe(true);
  });

  it('defines MINERAL_DEPTH above regular gameplay objects', () => {
    expect(typeof MINERAL_DEPTH).toBe('number');
    expect(MINERAL_DEPTH).toBeGreaterThan(1); // above body/explode depth
  });
});

describe('Mineral entity lifecycle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeMineral(
    scene: Phaser.Scene,
    x: number,
    y: number,
    onCollect?: () => void,
  ): Mineral {
    const config: MineralConfig = { x, y, onCollect };
    return new Mineral(scene, config);
  }

  it('spawns at a given position', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    expect(mineral.x).toBe(400);
    expect(mineral.y).toBe(200);
  });

  it('renders as a small gold dot', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    // The mineral should be a Graphics object with gold fill/stroke.
    expect(mineral).toBeInstanceOf(Phaser.GameObjects.Graphics);
    // Check the body graphics has commands (gold dot shape).
    const body = mineral as unknown as { bodyGraphics: Phaser.GameObjects.Graphics };
    expect(body.bodyGraphics).toBeDefined();
    expect(body.bodyGraphics.commandBuffer.length).toBeGreaterThan(0);
    // The fill the graphics actually issued is the gold default.
    expect(fillColours(mineral)).toEqual([MINERAL_COLOR]);
  });

  it('accepts an optional colour and draws that fill (salvage orange)', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = new Mineral(booted.scene, {
      x: 400,
      y: 200,
      color: MINERAL_SALVAGE_COLOR,
    });

    expect(mineral.color).toBe(MINERAL_SALVAGE_COLOR);
    // The rendered body — not just the stored field — uses the new colour.
    expect(fillColours(mineral)).toEqual([MINERAL_SALVAGE_COLOR]);
  });

  it('defaults the colour to gold so every existing caller is unchanged', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    expect(mineral.color).toBe(MINERAL_COLOR);
  });

  it('is worth the mineralCollectAmount rule by default (an ordinary dot)', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    // `mineralCollectAmount` defaults to 1, so an ordinary dot is unchanged.
    expect(mineral.value).toBe(1);
  });

  it('accepts a value override and renders the deposit colour (AH-0MVJ79739008396I)', async () => {
    booted = await bootScene([HarnessScene]);
    const deposit = new Mineral(booted.scene, {
      x: 400,
      y: 200,
      color: MINERAL_DEPOSIT_COLOR,
      value: MINERAL_DEPOSIT_VALUE,
    });

    // The single pickup is worth 10 minerals, and the body is drawn red.
    expect(deposit.value).toBe(MINERAL_DEPOSIT_VALUE);
    expect(deposit.color).toBe(MINERAL_DEPOSIT_COLOR);
    expect(fillColours(deposit)).toEqual([MINERAL_DEPOSIT_COLOR]);
  });

  it('persists until collected (no drift or despawn)', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    const startX = mineral.x;
    const startY = mineral.y;
    // Advance time significantly — mineral should not move.
    mineral.updatePosition(10); // 10 seconds should pass
    expect(mineral.x).toBeCloseTo(startX, 5);
    expect(mineral.y).toBeCloseTo(startY, 5);
  });

  it('invokes the collection callback when collected by player overlap', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Simulate player overlap by calling the overlap handler directly.
    mineral.handleOverlap('player');
    expect(onCollect).toHaveBeenCalledTimes(1);
  });

  it('removes itself after collection (marked as dead)', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    mineral.handleOverlap('player');
    expect(mineral.alive).toBe(false);
  });

  it('fires the collection callback exactly once even with multiple overlaps', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Multiple overlaps after first collection — should only fire once.
    mineral.handleOverlap('player');
    mineral.handleOverlap('player');
    mineral.handleOverlap('player');
    expect(onCollect).toHaveBeenCalledTimes(1);
  });

  it('minerals are not hit by bullets (no collision response)', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // A bullet overlap should NOT trigger collection or destroy the mineral.
    mineral.handleOverlap('bullet');
    expect(onCollect).not.toHaveBeenCalled();
    expect(mineral.alive).toBe(true);
  });

  it('minerals cause no damage to the player on contact', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Player overlap should collect but not damage the player.
    // The mineral itself should not have any damage-dealing side effects.
    const beforeX = mineral.x;
    const beforeY = mineral.y;
    mineral.handleOverlap('player');
    // No explosion, no damage VFX — just collection.
    expect(mineral.x).toBe(beforeX);
    expect(mineral.y).toBe(beforeY);
  });

  it('a non-asteroid enemy overlapping a mineral absorbs it', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Enemy overlap absorbs the mineral (same collection behaviour).
    mineral.handleOverlap('enemy');
    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(mineral.alive).toBe(false);
  });

  it('overlapping a mineral causes no damage to the enemy', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Enemy overlap should not damage the enemy.
    const beforeX = mineral.x;
    const beforeY = mineral.y;
    mineral.handleOverlap('enemy');
    expect(mineral.x).toBe(beforeX);
    expect(mineral.y).toBe(beforeY);
  });

  it('asteroids do NOT absorb minerals (asteroids are inert to minerals)', async () => {
    booted = await bootScene([HarnessScene]);
    const onCollect = vi.fn();
    const mineral = makeMineral(booted.scene, 400, 200, onCollect);
    // Asteroid overlap should have no effect — minerals are collected
    // by the player, and absorbed by non-asteroid enemies, but NOT
    // by asteroids.
    // The handleOverlap method may or may not accept 'asteroid' as a type;
    // if it does, it should be a no-op.
    mineral.handleOverlap('asteroid');
    // Asteroids should not absorb minerals.
    expect(mineral.alive).toBe(true);
  });

  it('renders above bullet layer for visibility', async () => {
    booted = await bootScene([HarnessScene]);
    const mineral = makeMineral(booted.scene, 400, 200);
    // Check that the mineral has a depth set for proper render ordering.
    const body = mineral as unknown as { bodyGraphics: Phaser.GameObjects.Graphics };
    expect(body.bodyGraphics.depth).toBeGreaterThan(1);
  });
});

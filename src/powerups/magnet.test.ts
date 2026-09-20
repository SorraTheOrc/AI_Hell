/**
 * Tests for the shared magnet attraction helper.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyMagnetAttraction } from './magnet';
import { SHIP_SIZE } from '../core/constants';
import { magnetRadius } from './effects';

describe('applyMagnetAttraction', () => {
  function makeDrop(x: number, y: number, canCollect: boolean = true) {
    const graphics = { x, y, setPosition: vi.fn() };
    const powerUp = { canCollect: () => canCollect };
    return { x, y, graphics, powerUp };
  }

  const player = { x: 480, y: 270, size: SHIP_SIZE };

  it('moves a drop toward the player when stacks > 0', () => {
    const drop = makeDrop(510, 270); // 30 px right of player
    const drops = [drop];

    applyMagnetAttraction(drops, player, 1, 0.5); // ~0.5 s

    expect(drop.x).toBeLessThan(510); // pulled leftward (toward player)
    expect(drop.y).toBeCloseTo(270, 3);
    expect(drop.graphics.setPosition).toHaveBeenCalledWith(drop.x, drop.y);
  });

  it('does not move a drop when stacks === 0', () => {
    const drop = makeDrop(510, 270);
    const drops = [drop];
    const beforeX = drop.x;
    const beforeY = drop.y;

    applyMagnetAttraction(drops, player, 0, 0.5);

    expect(drop.x).toBe(beforeX);
    expect(drop.y).toBe(beforeY);
    expect(drop.graphics.setPosition).not.toHaveBeenCalled();
  });

  it('does not move a drop beyond the magnet radius', () => {
    // Magnet radius for 1 stack: 2 * 20 * (1 + 0.5) = 60 px.
    // Place the drop 70 px away (outside radius).
    const drop = makeDrop(550, 270); // 70 px right of player
    const drops = [drop];
    const beforeX = drop.x;

    applyMagnetAttraction(drops, player, 1, 0.5);

    expect(drop.x).toBe(beforeX); // not moved
  });

  it('collects a drop when the magnet pulls it into the ship', () => {
    // Ship radius = SHIP_SIZE/2 = 10 px. Place drop 5 px right of player.
    const drop = makeDrop(485, 270);
    const drops = [drop];

    applyMagnetAttraction(drops, player, 1, 0.5);

    // The drop is pulled to the player's x coordinate (or close).
    expect(drop.x).toBeCloseTo(player.x, 0);
  });

  it('grows radius with stacks', () => {
    // 1 stack: 60 px. 2 stacks: 90 px.
    const radius1 = magnetRadius(SHIP_SIZE, 1);
    const radius2 = magnetRadius(SHIP_SIZE, 2);
    expect(radius2).toBeGreaterThan(radius1);

    // Place a drop at 75 px (inside 2-stack radius but outside 1-stack).
    const drop = makeDrop(555, 270); // 75 px right
    const drops = [drop];

    applyMagnetAttraction(drops, player, 1, 0.5);
    expect(drop.x).toBe(555); // not pulled (outside 1-stack radius)

    const drop2 = makeDrop(555, 270);
    const drops2 = [drop2];
    applyMagnetAttraction(drops2, player, 2, 0.5);
    expect(drop2.x).toBeLessThan(555); // pulled (inside 2-stack radius)
  });

  it('moves multiple drops toward the player', () => {
    const drops = [
      makeDrop(500, 260), // up-right
      makeDrop(460, 280), // down-left
    ];

    applyMagnetAttraction(drops, player, 1, 0.5);

    expect(drops[0].x).toBeLessThan(500); // pulled right
    expect(drops[0].y).toBeGreaterThan(260); // pulled down
    expect(drops[1].x).toBeGreaterThan(460); // pulled right
    expect(drops[1].y).toBeLessThan(280); // pulled up
  });

  it('respects the max step distance (not teleporting)', () => {
    // Place drop 100 px away; at speed 120 px/s for 0.5 s, max step = 60.
    const drop = makeDrop(580, 270);
    const drops = [drop];

    applyMagnetAttraction(drops, player, 5, 0.5);

    // Should move by at most 60 px, not the full 100.
    expect(drop.x).toBeGreaterThanOrEqual(520); // 580 - 60
  });

  it('skips drops that are not collectible', () => {
    const drop = makeDrop(510, 270, false); // canCollect = false
    const drops = [drop];
    const beforeX = drop.x;

    applyMagnetAttraction(drops, player, 1, 0.5);

    expect(drop.x).toBe(beforeX); // not moved
  });

  it('graphics position tracks logical position', () => {
    const drop = makeDrop(510, 270);
    const drops = [drop];

    applyMagnetAttraction(drops, player, 1, 0.5);

    expect(drop.graphics.setPosition).toHaveBeenCalledWith(drop.x, drop.y);
  });

  it('handles dt === 0 (no movement)', () => {
    const drop = makeDrop(510, 270);
    const drops = [drop];
    const beforeX = drop.x;

    applyMagnetAttraction(drops, player, 1, 0);

    expect(drop.x).toBe(beforeX);
  });

  it('uses SHIP_SIZE as default when player.size is undefined', () => {
    const noSizePlayer = { x: 480, y: 270 };
    const drop = makeDrop(510, 270);
    const drops = [drop];

    applyMagnetAttraction(drops, noSizePlayer, 1, 0.5);

    expect(drop.x).toBeLessThan(510); // still moves with default size
  });
});

/**
 * Tests for the shared mineral scoop attraction helper (P10 Mineral Scoop,
 * AH-0MUPMR9TX00756BQ AC4).
 *
 * The scoop mirrors the P9 magnet but targets the mineral field: a single
 * exported `applyMineralScoop` pulls live minerals within the shared radius
 * toward the player at `MAGNET_ATTRACTION_SPEED`, syncing rendered positions;
 * it only ever attracts (collection stays with `collectMinerals`).
 */

import { describe, expect, it, vi } from 'vitest';

import { MAGNET_ATTRACTION_SPEED, SHIP_SIZE } from '../core/constants';
import { mineralScoopRadius, applyMineralScoop } from './mineralScoop';
import { magnetRadius } from './effects';

describe('mineralScoopRadius', () => {
  it('follows the magnet curve: 1 × ship size × (1 + 0.5 × stacks)', () => {
    expect(mineralScoopRadius(SHIP_SIZE, 1)).toBeCloseTo(1 * SHIP_SIZE * 1.5, 5);
    expect(mineralScoopRadius(SHIP_SIZE, 2)).toBeCloseTo(1 * SHIP_SIZE * 2, 5);
    // The radius formula at zero stacks is the bare base (1× ship size);
    // `applyMineralScoop` separately guards stacks <= 0 to disable attraction.
    expect(mineralScoopRadius(SHIP_SIZE, 0)).toBe(1 * SHIP_SIZE);
  });

  it('grows with stacks', () => {
    expect(mineralScoopRadius(SHIP_SIZE, 5)).toBeGreaterThan(
      mineralScoopRadius(SHIP_SIZE, 1),
    );
  });

  it('shares the exact magnet radius curve (single source of truth)', () => {
    for (const stacks of [0, 1, 2, 3, 5]) {
      expect(mineralScoopRadius(SHIP_SIZE, stacks)).toBe(
        magnetRadius(SHIP_SIZE, stacks),
      );
    }
  });
});

describe('applyMineralScoop', () => {
  function makeMineral(x: number, y: number, alive = true) {
    return { x, y, alive, setPosition: vi.fn() };
  }

  const player = { x: 480, y: 270, size: SHIP_SIZE };

  it('pulls an in-range live mineral toward the player and syncs its position', () => {
    const mineral = makeMineral(510, 270); // 30 px right of the player
    applyMineralScoop([mineral], player, 1, 0.5); // ~0.5 s at 120 px/s

    expect(mineral.x).toBeLessThan(510);
    expect(mineral.y).toBeCloseTo(270, 3);
    expect(mineral.setPosition).toHaveBeenCalledWith(mineral.x, mineral.y);
  });

  it('does not move an out-of-range mineral', () => {
    // 1-stack radius = 1 × 20 × 1.5 = 30 px; place it 70 px away.
    const mineral = makeMineral(550, 270);
    const before = { x: mineral.x, y: mineral.y };

    applyMineralScoop([mineral], player, 1, 0.5);

    expect(mineral.x).toBe(before.x);
    expect(mineral.y).toBe(before.y);
    expect(mineral.setPosition).not.toHaveBeenCalled();
  });

  it('is a no-op with zero effective stacks (no movement, no sync)', () => {
    const mineral = makeMineral(490, 270);
    const before = { x: mineral.x, y: mineral.y };

    applyMineralScoop([mineral], player, 0, 0.5);

    expect(mineral.x).toBe(before.x);
    expect(mineral.y).toBe(before.y);
    expect(mineral.setPosition).not.toHaveBeenCalled();
  });

  it('never collects, hides or destroys a mineral — only attracts', () => {
    const mineral = makeMineral(510, 270) as ReturnType<typeof makeMineral> & {
      destroy?: () => void;
      setVisible?: () => void;
      alive: boolean;
    };
    mineral.destroy = vi.fn();
    mineral.setVisible = vi.fn();

    applyMineralScoop([mineral], player, 5, 1);

    expect(mineral.alive).toBe(true);
    expect(mineral.destroy).not.toHaveBeenCalled();
    expect(mineral.setVisible).not.toHaveBeenCalled();
  });

  it('skips dead minerals', () => {
    const mineral = makeMineral(510, 270, false);
    const before = mineral.x;

    applyMineralScoop([mineral], player, 1, 0.5);

    expect(mineral.x).toBe(before);
    expect(mineral.setPosition).not.toHaveBeenCalled();
  });

  it('clamps the per-frame step to the remaining distance (no overshoot)', () => {
    const mineral = makeMineral(490, 270); // 10 px away
    applyMineralScoop([mineral], player, 5, 1); // wants 120 px of travel

    expect(mineral.x).toBeCloseTo(player.x, 5);
    expect(mineral.y).toBeCloseTo(player.y, 5);
  });

  it('attracts at MAGNET_ATTRACTION_SPEED (matches the magnet speed)', () => {
    const mineral = makeMineral(480, 270 - 20); // 20 px above, inside 30 px radius
    applyMineralScoop([mineral], player, 1, 0.1); // 0.1 s → 12 px

    expect(mineral.y).toBeCloseTo(270 - 20 + MAGNET_ATTRACTION_SPEED * 0.1, 5);
  });

  it('moves multiple minerals toward the player', () => {
    const a = makeMineral(500, 260);
    const b = makeMineral(460, 280);

    applyMineralScoop([a, b], player, 2, 0.5);

    expect(a.x).toBeLessThan(500);
    expect(a.y).toBeGreaterThan(260);
    expect(b.x).toBeGreaterThan(460);
    expect(b.y).toBeLessThan(280);
  });

  it('uses SHIP_SIZE as the default when player.size is absent', () => {
    const mineral = makeMineral(510, 270);
    applyMineralScoop([mineral], { x: 480, y: 270 }, 1, 0.5);

    expect(mineral.x).toBeLessThan(510);
  });

  it('handles dt === 0 (no movement)', () => {
    const mineral = makeMineral(510, 270);
    applyMineralScoop([mineral], player, 1, 0);

    expect(mineral.x).toBe(510);
  });
});

/**
 * Mini-boss wheel overlay scene — test-first contract
 * (AH-0MVSF61YO0002KE5, paired implementation AH-0MVSF63LN008YHMT).
 *
 * These tests pin the launcher-agnostic overlay **before** the scene exists,
 * so the implementation is driven by the contract rather than retrofitted
 * (parent AH-0MVLISU03006WDOD AC1/AC2/AC8):
 *
 * - one wedge per owned permanent kind (weapons **and** power-ups) plus one
 *   bonus wedge, drawn with the existing code-drawn icons;
 * - the launcher supplies the wedges **and** the resolved outcome — the scene
 *   never computes probabilities and never reaches into a launcher;
 * - spinning is player-initiated (click or any keyboard key), the wheel
 *   starts fast and eases out over the exported ≈2.2 s duration, and the
 *   landed wedge is highlighted and applied exactly once;
 * - a multi-upgrade landing wedge renders **all** the gained kinds' icons
 *   inside that one wedge, with no other wedge lit for the extra gains;
 * - demo mode auto-spins after `autoSpinMs`, normal play waits for input.
 *
 * The scene's icons come from `powerups/icons` (`drawPowerUpIcon` /
 * `drawWeaponIcon`); those are mocked with pass-through spies so the tests can
 * prove which wedges were drawn with the shared code-drawn icons without
 * asserting pixels.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { buildGameConfig } from '../../core/gameConfig';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import {
  MINI_BOSS_WHEEL_BONUS_ID,
  buildWheelWedges,
  drawWheelOutcome,
  type MiniBossWheelOutcome,
  type MiniBossWheelWedge,
} from '../../powerups/miniBossWheel';
import type { DropId } from '../../powerups/types';
import { drawPowerUpIcon, drawWeaponIcon } from '../../powerups/icons';
import {
  MINI_BOSS_WHEEL_REVEAL_HOLD_MS,
  MINI_BOSS_WHEEL_SPIN_DURATION_MS,
  MiniBossWheelScene,
  resolveTargetWedgeIndex,
} from '../MiniBossWheelScene';

vi.mock('../../powerups/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../powerups/icons')>();
  return {
    ...actual,
    drawPowerUpIcon: vi.fn(actual.drawPowerUpIcon),
    drawWeaponIcon: vi.fn(actual.drawWeaponIcon),
  };
});

/** Minimal scene used as the boot target; the wheel overlay is started on top. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('MiniBossWheelHarness');
  }
}

/** An owned snapshot spanning both halves of the shared six-slot pool. */
const OWNED_KINDS: readonly DropId[] = ['spread', 'shield', 'rapid'];
/** Slot indices from the 100-slot table (0 bonus / 1–5 triple / 6–15 double / 16+ single). */
const SLOT = { bonus: 0, triple: 1, double: 6, single: 16 } as const;

/** Resolves an outcome for the shared owned snapshot. */
function outcomeFor(slotIndex: number): MiniBossWheelOutcome {
  return drawWheelOutcome(slotIndex, OWNED_KINDS);
}

describe('MiniBossWheelScene', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /**
   * Boots the overlay on top of a harness scene with the supplied payload,
   * exactly how a launcher starts it (`scene.launch(...)` equivalent).
   */
  async function bootWheel(data: {
    wedges: readonly MiniBossWheelWedge[];
    outcome: MiniBossWheelOutcome;
    onResult?: (outcome: MiniBossWheelOutcome) => void;
    autoSpinMs?: number;
  }): Promise<MiniBossWheelScene> {
    booted = await bootScene([HarnessScene, MiniBossWheelScene]);
    booted.game.scene.start('MiniBossWheelScene', data);
    await advanceGame(booted.game, 50);
    return booted.game.scene.getScene(
      'MiniBossWheelScene',
    ) as MiniBossWheelScene;
  }

  /** Boots the single- or double-upgrade reward fixture used by most tests. */
  async function bootSingle(
    onResult?: (outcome: MiniBossWheelOutcome) => void,
  ): Promise<{ scene: MiniBossWheelScene; wedges: MiniBossWheelWedge[]; outcome: MiniBossWheelOutcome }> {
    const wedges = buildWheelWedges(OWNED_KINDS);
    const outcome = outcomeFor(SLOT.single);
    const scene = await bootWheel({ wedges, outcome, ...(onResult ? { onResult } : {}) });
    return { scene, wedges, outcome };
  }

  /** Advances the game past a completed spin and the landed-wedge reveal. */
  async function finishSpin(game: Phaser.Game): Promise<void> {
    await advanceGame(
      game,
      MINI_BOSS_WHEEL_SPIN_DURATION_MS + MINI_BOSS_WHEEL_REVEAL_HOLD_MS + 100,
    );
  }

  it('is registered in the game config so any launcher can start it by key', () => {
    const config = buildGameConfig();
    expect(config.scene).toContain(MiniBossWheelScene);
    expect(new MiniBossWheelScene().sys.settings.key).toBe('MiniBossWheelScene');
  });

  it('shows one wedge per owned permanent kind plus a single bonus wedge', async () => {
    const wedges = buildWheelWedges(OWNED_KINDS);
    const scene = await bootWheel({ wedges, outcome: outcomeFor(SLOT.single) });

    const visuals = scene.getWedges();
    expect(visuals).toHaveLength(OWNED_KINDS.length + 1);
    // One wedge per owned kind, in the shared stable order, each with its
    // catalogue display name …
    expect(visuals.slice(0, -1).map((wedge) => wedge.id)).toEqual([
      'spread',
      'rapid',
      'shield',
    ]);
    expect(visuals.map((wedge) => wedge.label)).toEqual([
      'Spread Shot',
      'Rapid Fire',
      'Shield',
      'BONUS',
    ]);
    // … plus exactly one bonus wedge, last.
    const bonusWedges = visuals.filter((wedge) => wedge.kind === 'bonus');
    expect(bonusWedges).toHaveLength(1);
    expect(bonusWedges[0].id).toBe(MINI_BOSS_WHEEL_BONUS_ID);
    expect(visuals[visuals.length - 1].kind).toBe('bonus');
  });

  it('draws every owned wedge with the existing code-drawn icons', async () => {
    const wedges = buildWheelWedges(OWNED_KINDS);
    await bootWheel({ wedges, outcome: outcomeFor(SLOT.single) });

    // Weapon kinds go through `drawWeaponIcon`, power-up kinds through
    // `drawPowerUpIcon` — the shared code-first icon set (no art assets).
    expect(drawWeaponIcon).toHaveBeenCalledTimes(2);
    expect(drawPowerUpIcon).toHaveBeenCalledTimes(1);
    const weaponIds = vi.mocked(drawWeaponIcon).mock.calls.map((call) => call[1]);
    const powerUpIds = vi
      .mocked(drawPowerUpIcon)
      .mock.calls.map((call) => call[1]);
    expect(weaponIds).toEqual(expect.arrayContaining(['spread', 'rapid']));
    expect(powerUpIds).toEqual(['shield']);
    // The bonus wedge is code-drawn by the scene itself, never an art asset.
    expect([...weaponIds, ...powerUpIds]).not.toContain(MINI_BOSS_WHEEL_BONUS_ID);
  });

  it('uses the launcher-resolved outcome instead of computing its own', async () => {
    const wedges = buildWheelWedges(OWNED_KINDS);
    const single = outcomeFor(SLOT.single);
    const double = outcomeFor(SLOT.double);
    // Two different launcher outcomes on the same wedge list must land on
    // different wedges — the scene animates the supplied outcome only.
    expect(resolveTargetWedgeIndex(wedges, single)).not.toBe(
      resolveTargetWedgeIndex(wedges, double),
    );

    const scene = await bootWheel({ wedges, outcome: double });
    expect(scene.getOutcome()).toEqual(double);
    expect(scene.getTargetWedgeIndex()).toBe(
      resolveTargetWedgeIndex(wedges, double),
    );
  });

  it('does not apply anything before the player spins', async () => {
    const onResult = vi.fn();
    const { scene } = await bootSingle(onResult);

    await advanceGame(booted!.game, MINI_BOSS_WHEEL_SPIN_DURATION_MS + 400);
    expect(scene.isSpinning()).toBe(false);
    expect(scene.isResolved()).toBe(false);
    expect(scene.getLandedWedgeIndex()).toBeNull();
    expect(scene.getHighlightedWedgeIndexes()).toEqual([]);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('starts the spin from a pointer click', async () => {
    const { scene } = await bootSingle();
    expect(scene.spin()).toBe(true);
  });

  it('starts the spin from a pointer click event', async () => {
    const { scene } = await bootSingle();
    scene.input.emit('pointerdown', { x: 10, y: 10 });
    expect(scene.isSpinning()).toBe(true);
  });

  it('starts the spin from any keyboard key', async () => {
    const { scene } = await bootSingle();
    scene.input.keyboard!.emit('keydown', { key: 'a' });
    expect(scene.isSpinning()).toBe(true);
  });

  it('spins fast at first and eases out over the exported duration', async () => {
    const { scene } = await bootSingle();
    scene.spin();

    const quarter = MINI_BOSS_WHEEL_SPIN_DURATION_MS / 4;
    await advanceGame(booted!.game, quarter);
    const atQuarter = Math.abs(scene.getRotationRadians());
    await advanceGame(booted!.game, quarter);
    const atHalf = Math.abs(scene.getRotationRadians());

    const firstQuarter = atQuarter;
    const secondQuarter = atHalf - atQuarter;
    // Ease-out: the second quarter covers strictly less than the first.
    expect(firstQuarter).toBeGreaterThan(secondQuarter);

    await finishSpin(booted!.game);
    const total = Math.abs(scene.getRotationRadians());
    // The first quarter already covers well over its linear share (ease-out).
    expect(firstQuarter).toBeGreaterThan(0.4 * total);
    // The total travel is three base revolutions plus at most one revolution
    // to reach the target wedge ("at most one overshoot revolution").
    expect(total).toBeGreaterThanOrEqual(2 * Math.PI * 3);
    expect(total).toBeLessThan(2 * Math.PI * 4);
  });

  it('keeps the outcome hidden until the wheel stops, then lands on it', async () => {
    const onResult = vi.fn();
    const { scene, wedges, outcome } = await bootSingle(onResult);
    const target = resolveTargetWedgeIndex(wedges, outcome);

    scene.spin();
    await advanceGame(booted!.game, MINI_BOSS_WHEEL_SPIN_DURATION_MS / 2);
    // Mid-spin: spinning, no landed wedge, nothing applied.
    expect(scene.isSpinning()).toBe(true);
    expect(scene.getLandedWedgeIndex()).toBeNull();
    expect(onResult).not.toHaveBeenCalled();

    await advanceGame(booted!.game, MINI_BOSS_WHEEL_SPIN_DURATION_MS / 2 + 16);
    // The wheel has stopped on the outcome's wedge (still revealing).
    expect(scene.isSpinning()).toBe(false);
    expect(scene.getLandedWedgeIndex()).toBe(target);
    expect(scene.getHighlightedWedgeIndexes()).toEqual([target]);
  });

  it('highlights the landed wedge and applies the outcome exactly once', async () => {
    const onResult = vi.fn();
    const { scene, outcome } = await bootSingle(onResult);

    scene.spin();
    await finishSpin(booted!.game);

    expect(scene.isResolved()).toBe(true);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(outcome);

    // A repeat spin/select after resolution is a no-op.
    expect(scene.spin()).toBe(false);
    scene.input.emit('pointerdown', { x: 10, y: 10 });
    scene.input.keyboard!.emit('keydown', { key: ' ' });
    expect(scene.spin()).toBe(false);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(scene.getResultCallCount()).toBe(1);
  });

  it('renders all gained kinds inside the multi-upgrade landing wedge', async () => {
    const wedges = buildWheelWedges(OWNED_KINDS);
    const outcome = outcomeFor(SLOT.triple);
    // The fixture really is a distinct three-kind upgrade.
    expect(outcome.slotKind).toBe('triple');
    expect(outcome.gains).toHaveLength(3);
    expect(new Set(outcome.gains.map((gain) => gain.id)).size).toBe(3);

    const onResult = vi.fn();
    const scene = await bootWheel({ wedges, outcome, onResult });
    const target = resolveTargetWedgeIndex(wedges, outcome);

    scene.spin();
    await finishSpin(booted!.game);

    const iconIds = scene.getWedgeIconIds();
    // "The wedge with the multi-results has all icons present": every gained
    // kind is rendered inside the single landing wedge …
    expect(new Set(iconIds[target])).toEqual(
      new Set(outcome.gains.map((gain) => gain.id)),
    );
    // … and no other wedge is separately lit for the extra gains.
    expect(scene.getHighlightedWedgeIndexes()).toEqual([target]);
    // The complete outcome still applies exactly once.
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(outcome);
  });

  it('lands the bonus outcome on the bonus wedge and grants every owned kind', async () => {
    const wedges = buildWheelWedges(OWNED_KINDS);
    const outcome = outcomeFor(SLOT.bonus);
    expect(outcome.slotKind).toBe('bonus');

    const onResult = vi.fn();
    const scene = await bootWheel({ wedges, outcome, onResult });
    const bonusIndex = wedges.findIndex((wedge) => wedge.kind === 'bonus');

    scene.spin();
    await finishSpin(booted!.game);

    expect(scene.getLandedWedgeIndex()).toBe(bonusIndex);
    expect(scene.getHighlightedWedgeIndexes()).toEqual([bonusIndex]);
    expect(new Set(scene.getWedgeIconIds()[bonusIndex])).toEqual(
      new Set(OWNED_KINDS),
    );
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(outcome.gains.map((gain) => gain.id).sort()).toEqual(
      [...OWNED_KINDS].sort(),
    );
  });

  it.fails('renders no Extra Life wedge for a run that owns it (AH-0MW3MLSTW007U8BD)', async () => {
    // Test-first half of parent AH-0MW10ZVLH005IJRM AC4: the overlay renders
    // only the launcher's wedges, so a permanently-owned Extra Life must never
    // reach it (no Extra Life wedge, and the remaining wedges unchanged).
    // `it.fails` until the exclusion lands (implementation
    // AH-0MW3MLV2V001NWBR).
    const owned: readonly DropId[] = ['spread', 'extra_life', 'shield'];
    const wedges = buildWheelWedges(owned);
    const scene = await bootWheel({
      wedges,
      outcome: drawWheelOutcome(SLOT.single, owned),
    });

    const visuals = scene.getWedges();
    expect(visuals.map((wedge) => wedge.id)).not.toContain('extra_life');
    expect(visuals.map((wedge) => wedge.label)).not.toContain('Extra Life');
    // The two genuine kinds and the bonus wedge remain.
    expect(visuals.map((wedge) => wedge.id)).toEqual([
      'spread',
      'shield',
      MINI_BOSS_WHEEL_BONUS_ID,
    ]);
  });

  it('auto-spins in demo mode after the supplied delay', async () => {
    const wedges = buildWheelWedges(OWNED_KINDS);
    const scene = await bootWheel({
      wedges,
      outcome: outcomeFor(SLOT.single),
      autoSpinMs: 250,
    });

    // Not yet spinning immediately after launch …
    expect(scene.isSpinning()).toBe(false);
    await advanceGame(booted!.game, 300);
    // … then the demo auto-spin starts without any player input.
    expect(scene.isSpinning()).toBe(true);
    await finishSpin(booted!.game);
    expect(scene.isResolved()).toBe(true);
  });

  it('closes the overlay once the result callback has run', async () => {
    const { scene } = await bootSingle();
    scene.spin();
    await finishSpin(booted!.game);

    expect(scene.isResolved()).toBe(true);
    expect(booted!.game.scene.isActive('MiniBossWheelScene')).toBe(false);
  });
});

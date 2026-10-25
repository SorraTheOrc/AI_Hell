/**
 * Six-slot accounting, weapon family (test-first companion to
 * `slots.test.ts`, AH-0MVNT2SD300874CP — AC1 "temporary field stacks of
 * **either** family consume none").
 *
 * ## Why this lives in its own file
 *
 * Proving the weapon half needs a live `Player`: permanent and temporary
 * weapon grants are instance state (`_permanentWeaponGrants` /
 * `_tempWeaponStacks`), and `Player` is a Phaser `GameObject`. Booting Phaser
 * puts this file in the slower `integration` Vitest project, so the pure
 * accounting assertions stay in `slots.test.ts` on the fast unit project.
 *
 * ## Test-first status (read before editing)
 *
 * `src/powerups/slots.ts` is added by the follow-on item
 * AH-0MVNT2TEK001BNQ4, so the assertion is registered with Vitest's
 * `it(...)` — the repo's documented test-first convention (see
 * `powerUpIdNaming.test.ts`) — which keeps the suite
 * green while the assertion is red against the absent helper. Flip `.fails`
 * to a plain `it(...)` when the helper lands; the assertions must not change.
 *
 * @module powerups/slots.weaponLevels.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { Player } from '../entities/Player';
import { GymPlayer } from '../scenes/gym/GymPlayer';
import type { DropId, PowerUpId } from './types';
import type { WeaponId } from '../utils/weapons';

// ── Pinned contract (implemented by AH-0MVNT2TEK001BNQ4) ────────────

type PowerUpLevels = Array<{ id: PowerUpId; level: number }>;
/** `Player.getWeaponLevels()` is `WeaponId`-keyed (it includes the cannon). */
type WeaponLevels = Array<{ id: WeaponId; level: number }>;

interface PowerUpSlotState {
  readonly used: number;
  readonly free: number;
  readonly isFull: boolean;
  readonly ownedIds: ReadonlySet<DropId>;
}

interface SlotsModule {
  resolveSlotState(powerUpLevels: PowerUpLevels, weaponLevels: WeaponLevels): PowerUpSlotState;
}

const SLOTS_MODULE: string = './slots';

async function loadSlots(): Promise<SlotsModule> {
  return (await import(/* @vite-ignore */ SLOTS_MODULE)) as SlotsModule;
}

describe('six-slot accounting for the weapon family (AC1)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  /** Boots the player gym and returns the live ship it created. */
  async function freshPlayer(): Promise<Player> {
    booted = await bootScene([GymPlayer]);
    advanceGame(booted.game, 200);
    const children = booted.scene.sys.displayList.getChildren();
    const player = children.find((child) => child instanceof Player) as
      | Player
      | undefined;
    expect(player).toBeDefined();
    return player!;
  }

  // Test-first: expected failure until the shared helper lands.
  it('counts permanent weapon grants but not temporary field stacks', async () => {
    const slots = await loadSlots();
    const player = await freshPlayer();

    // A field pickup is temporary: `getWeaponLevels()` is permanent-only, so
    // the accounting must see an empty pool.
    player.equipWeapon('spread');
    expect(player.getTempWeaponStacks('spread')).toBeGreaterThan(0);
    expect(slots.resolveSlotState([], player.getWeaponLevels()).used).toBe(0);

    // A hold-full reward is permanent: it consumes exactly one slot.
    player.equipWeapon('spread', true);
    const state = slots.resolveSlotState([], player.getWeaponLevels());

    expect(state.used).toBe(1);
    expect(state.free).toBe(5);
    expect(state.isFull).toBe(false);
    expect(state.ownedIds.has('spread')).toBe(true);
  });
});

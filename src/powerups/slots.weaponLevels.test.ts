/**
 * Six-slot accounting, weapon family (companion to `slots.test.ts`, parent
 * AH-0MVLIJT3M005HPHF AC1; producer Q4a — a temporary pickup occupies a slot
 * while it lasts).
 *
 * ## Why this lives in its own file
 *
 * Proving the weapon half needs a live `Player`: permanent and temporary
 * weapon grants are instance state (`_permanentWeaponGrants` /
 * `_tempWeaponStacks`), and `Player` is a Phaser `GameObject`. Booting Phaser
 * puts this file in the slower `integration` Vitest project, so the pure
 * accounting assertions stay in `slots.test.ts` on the fast unit project.
 *
 * @module powerups/slots.weaponLevels.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { Player } from '../entities/Player';
import { GymPlayer } from '../scenes/gym/GymPlayer';
import { resolvePlayerSlotState, resolveSlotState } from './slots';

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

  it('counts a temporary weapon stack as a held slot and releases it on expiry', async () => {
    const player = await freshPlayer();

    // A field pickup is temporary, but it still occupies a slot while it lasts
    // (producer Q4a) — the run can never hold more than six kinds at once.
    player.equipWeapon('spread');
    expect(player.getTempWeaponStacks('spread')).toBeGreaterThan(0);
    const heldState = resolvePlayerSlotState(player);
    expect(heldState.used).toBe(1);
    expect(heldState.free).toBe(5);
    expect(heldState.heldIds.has('spread')).toBe(true);
    // Not permanently owned: the choice still offers it as a new permanent pick.
    expect(heldState.ownedIds.has('spread')).toBe(false);

    // The timed window expiring (what `resetWeapon` does for timed activations)
    // releases the slot again.
    player.resetWeapon();
    const expired = resolvePlayerSlotState(player);
    expect(expired.used).toBe(0);
    expect(expired.isFull).toBe(false);
  });

  it('counts a permanent weapon grant in the same pool', async () => {
    const player = await freshPlayer();

    player.equipWeapon('spread', true);

    const state = resolvePlayerSlotState(player);
    expect(state.used).toBe(1);
    expect(state.ownedIds.has('spread')).toBe(true);
    expect(state.heldIds.has('spread')).toBe(true);
  });

  it('never counts the permanent cannon', async () => {
    const player = await freshPlayer();

    // The cannon is always active but is never a permanent *grant*, so the
    // snapshot the cap reads cannot contain it — it can never occupy a slot.
    expect(player.hasWeapon('cannon')).toBe(true);
    expect(player.getWeaponLevels().some((entry) => entry.id === 'cannon')).toBe(false);

    const state = resolvePlayerSlotState(player);
    expect(state.used).toBe(0);
    expect(state.isFull).toBe(false);

    // Defence in depth: the helper is `WeaponId`-keyed, so a snapshot that did
    // carry the cannon must still be ignored (it is not a weapon drop).
    const withCannon = resolveSlotState([], [{ id: 'cannon', level: 5 }]);
    expect(withCannon.used).toBe(0);
    expect(withCannon.heldIds.has('cannon' as never)).toBe(false);
  });
});

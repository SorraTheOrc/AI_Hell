/**
 * Six-slot permanent loadout accounting (parent AH-0MVLIJT3M005HPHF).
 *
 * The run's permanent loadout is capped at {@link POWER_UP_SLOT_CAP} distinct
 * kinds, and that pool is **shared** between power-up and weapon kinds: the
 * first six kinds taken as permanent rewards (hold-full choice or mini-boss
 * reward) define the build. Once the pool is full, only the owned kinds plus
 * catalogue entries flagged {@link PowerUpEntry.availableWhenSlotsFull} may be
 * drawn as a drop or offered by the choice — every other kind is gated out.
 * Field pickups never consume a slot, so a player can still enjoy a temporary
 * strength boost from a drop already on screen.
 *
 * ## One rule, one implementation
 *
 * Both decision points — the shared drop draw (`src/scenes/core/dropLayer.ts`)
 * and the hold-full choice pool (`src/powerups/choice.ts`) — consume this
 * module, so the rule exists exactly once and the game and every gym behave
 * identically (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * ## Derived, not counted
 *
 * Occupancy is **derived** from the two existing permanent-grant stores, never
 * tracked by a second counter:
 *
 * - `PowerUpLevelStore.getLevels()` — permanent power-up grants only (field
 *   pickup stacks are deliberately absent from that view);
 * - `Player.getWeaponLevels()` — permanent weapon grants only, `WeaponId`-keyed.
 *
 * The weapon snapshot also contains the permanent `cannon`, which can never be
 * granted as a reward; only ids that are real weapon **drops** occupy a slot,
 * so the cannon (and the `reset` utility, which is not a `WeaponId` at all and
 * therefore can never appear in a weapon-level snapshot) are excluded by
 * construction.
 *
 * ## Purity
 *
 * No Phaser import, no `Math.random()`, no wall-clock read, no input mutation:
 * the module is a pure function of the two permanent-only snapshots. Selection
 * stays injectable-rng deterministic in its callers.
 *
 * @module powerups/slots
 */

import { POWER_UP_SLOT_CAP } from '../core/constants';
import type { WeaponId } from '../utils/weapons';
import {
  POWER_UP_CATALOGUE,
  WEAPON_DROP_IDS,
  type DropId,
  type PowerUpId,
} from './types';

/** The permanent-only weapon-drop kinds (the cannon is not among them). */
const WEAPON_DROP_ID_SET: ReadonlySet<string> = new Set(WEAPON_DROP_IDS);

/** A permanent-only power-up level snapshot (`PowerUpLevelStore.getLevels()`). */
export type PowerUpSlotLevels = ReadonlyArray<{ id: PowerUpId; level: number }>;

/**
 * A permanent-only weapon level snapshot (`Player.getWeaponLevels()`).
 *
 * `WeaponId`-keyed, so it may contain the never-grantable `cannon`; the
 * accounting filters it out through {@link WEAPON_DROP_ID_SET}.
 */
export type WeaponSlotLevels = ReadonlyArray<{ id: WeaponId; level: number }>;

/** Slot occupancy plus the owned-kind view the eligibility predicates need. */
export interface PowerUpSlotState {
  /** Number of distinct permanently-owned drop kinds (may exceed the cap when exempt grants overflow). */
  readonly used: number;
  /** Remaining slots, clamped at 0 (`used` may exceed the cap via exempt grants). */
  readonly free: number;
  /** Whether the shared pool is full (or overflowing). */
  readonly isFull: boolean;
  /** The distinct permanently-owned drop kinds (power-ups and weapon drops). */
  readonly ownedIds: ReadonlySet<DropId>;
}

/**
 * Whether a catalogue entry remains available once the slots are full.
 *
 * Reads the data flag with its documented `false` default (`=== true`, so a
 * stray truthy value cannot silently exempt an entry). Weapon drop ids have no
 * catalogue entry and are therefore never exempt — the flag is power-up-only
 * until a weapon needs one (parent AC5).
 */
function isExemptWhenSlotsFull(dropId: DropId): boolean {
  const entry = POWER_UP_CATALOGUE[dropId as PowerUpId];
  return entry?.availableWhenSlotsFull === true;
}

/**
 * Resolves the run's slot occupancy from the two permanent-only snapshots.
 *
 * - Power-up ids with a permanent level ≥ 1 occupy one slot each.
 * - Weapon **drop** ids with a permanent level ≥ 1 occupy one slot each, in
 *   the same pool. The permanent `cannon` is ignored: it is not a weapon drop
 *   and can never be a permanent reward.
 * - Temporary field-pickup stacks are absent from both snapshots, so they
 *   never consume a slot.
 * - A repeat permanent grant of an owned kind levels it up instead of opening
 *   a second slot (both stores report one entry per kind).
 *
 * `free` is clamped at 0: an exempt kind (Extra Life, Mystery UFO) can still be
 * taken once the pool is full, so `used` may exceed {@link POWER_UP_SLOT_CAP}.
 */
export function resolveSlotState(
  powerUpLevels: PowerUpSlotLevels,
  weaponLevels: WeaponSlotLevels,
): PowerUpSlotState {
  const ownedIds = new Set<DropId>();

  for (const { id, level } of powerUpLevels) {
    if (level >= 1) {
      ownedIds.add(id);
    }
  }

  for (const { id, level } of weaponLevels) {
    // Drop kinds only: excludes the permanent cannon (and any future
    // non-drop weapon), which can never occupy one of the six slots.
    if (level >= 1 && WEAPON_DROP_ID_SET.has(id)) {
      ownedIds.add(id as DropId);
    }
  }

  const used = ownedIds.size;

  return {
    used,
    free: Math.max(0, POWER_UP_SLOT_CAP - used),
    isFull: used >= POWER_UP_SLOT_CAP,
    ownedIds,
  };
}

/**
 * May `dropId` be drawn as a drop / offered as a permanent pick?
 *
 * Below the cap every id is eligible, so the pre-cap distribution is unchanged
 * (same eligible set, same weights). At or above the cap only owned kinds and
 * catalogue entries flagged `availableWhenSlotsFull` remain eligible.
 */
export function isWithinSlotPool(
  dropId: DropId,
  state: PowerUpSlotState,
): boolean {
  if (!state.isFull) return true;
  return state.ownedIds.has(dropId) || isExemptWhenSlotsFull(dropId);
}

/**
 * Filters `dropIds` to those still eligible, preserving their order and
 * without mutating the input.
 *
 * Owned kinds always survive, so the eligible set is never empty for a full
 * pool: the six owned kinds are by definition eligible, and the flagged
 * entries (Extra Life, Mystery UFO) stay available too. A weapon-only build
 * therefore degrades to its owned weapons plus the flagged entries rather than
 * to nothing (documented design consequence of the shared pool).
 */
export function eligibleForSlotPool(
  dropIds: readonly DropId[],
  state: PowerUpSlotState,
): DropId[] {
  return dropIds.filter((dropId) => isWithinSlotPool(dropId, state));
}

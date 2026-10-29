/**
 * Six-slot loadout accounting (parent AH-0MVLIJT3M005HPHF).
 *
 * The run's loadout is capped at {@link POWER_UP_SLOT_CAP} distinct kinds, and
 * that pool is **shared** between power-up and weapon kinds: a kind occupies a
 * slot while it is held **either permanently** (a hold-full or mini-boss
 * reward) **or temporarily** (an active field pickup). Once the pool is full,
 * only the held kinds plus catalogue entries flagged
 * {@link PowerUpEntry.availableWhenSlotsFull} (and the slot-exempt `reset`
 * utility) may be drawn as a drop, offered by the choice, or collected from
 * the field — every other kind is gated out until a slot frees.
 *
 * ## Producer decisions this module encodes (2026-10-27)
 *
 * - **Q4(a):** a temporary pickup occupies a slot while it is held; the slot is
 *   released when its timed window expires (`PowerUpLevelStore.clearTemporary`
 *   / `Player.tickWeaponTimers`), so occupancy can churn during a run.
 * - **Q5(b):** at the cap a non-held, non-exempt drop is **not collectable**
 *   (the caller's collection gate asks {@link isWithinSlotPool}).
 * - **Q6(a):** the hold-full choice offers only items currently in the slots
 *   (plus the available-when-full entries).
 * - **Q7(a):** `availableWhenSlotsFull` entries never occupy a slot — the flag
 *   exempts them from the count as well as from the gates.
 *
 * ## One rule, one implementation
 *
 * Every decision point — the shared drop draw (`src/scenes/core/dropLayer.ts`),
 * the drop collection gate (`CombatCoreScene`), and the hold-full choice pool
 * (`src/powerups/choice.ts`) — consumes this module, so the rule exists exactly
 * once and the game and every gym behave identically (gym↔game parity,
 * AH-0MUGZDTFX004RBD1).
 *
 * ## Derived, not counted
 *
 * Occupancy is **derived** from the existing run-scoped stores, never tracked
 * by a second counter:
 *
 * - `PowerUpLevelStore.getLevels()` — permanent power-up grants;
 * - `PowerUpLevelStore.getTempPowerUpIds()` — active field-pickup stacks;
 * - `Player.getWeaponLevels()` — permanent weapon grants, `WeaponId`-keyed;
 * - `Player.getTempWeaponIds()` — active temporary weapon stacks.
 *
 * The weapon snapshots also contain the permanent `cannon`, which can never be
 * granted as a timed weapon; only ids that are real weapon **drops** occupy a
 * slot, so the cannon is excluded by construction. The `reset` utility cannot
 * be permanently granted either, so it is slot-exempt (never counted, never
 * gated) rather than merely untracked.
 *
 * ## Purity
 *
 * No Phaser import, no `Math.random()`, no wall-clock read, no input mutation:
 * the module is a pure function of the four snapshots. Selection stays
 * injectable-rng deterministic in its callers.
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

/** The weapon-drop kinds that can hold a permanent/temporary level. */
const WEAPON_DROP_ID_SET: ReadonlySet<string> = new Set(WEAPON_DROP_IDS);

/**
 * Drop ids that can never occupy a slot and are therefore never gated by the
 * cap: the `reset` utility. It is a `WeaponDropId` but **not** a `WeaponId`,
 * so it can never hold a permanent level; gating it would be an unintended
 * side effect of the cap (it is neither a power-up kind nor a weapon kind the
 * pool exists to bound).
 */
const SLOT_EXEMPT_UTILITY_DROP_IDS: ReadonlySet<DropId> = new Set<DropId>([
  'reset',
]);

/** A permanent power-up level snapshot (`PowerUpLevelStore.getLevels()`). */
export type PowerUpSlotLevels = ReadonlyArray<{ id: PowerUpId; level: number }>;

/**
 * A permanent weapon level snapshot (`Player.getWeaponLevels()`).
 *
 * `WeaponId`-keyed, so it may contain the never-grantable `cannon`; the
 * accounting filters it out through {@link WEAPON_DROP_ID_SET}.
 */
export type WeaponSlotLevels = ReadonlyArray<{ id: WeaponId; level: number }>;

/** Slot occupancy plus the held-kind view the eligibility predicates need. */
export interface PowerUpSlotState {
  /**
   * Number of distinct **counted** held kinds (permanent or temporary).
   *
   * Exempt entries (`availableWhenSlotsFull`) and slot-exempt utilities never
   * count, so this can never exceed {@link POWER_UP_SLOT_CAP} through them.
   */
  readonly used: number;
  /** Remaining slots, clamped at 0. */
  readonly free: number;
  /** Whether the shared pool is full. */
  readonly isFull: boolean;
  /**
   * The distinct kinds held **permanently** (power-ups and weapon drops).
   *
   * The hold-full choice uses this view for its level-up offers.
   */
  readonly ownedIds: ReadonlySet<DropId>;
  /**
   * The distinct kinds **currently held**, permanently or temporarily — the
   * set the spawn draw, the collection gate and the choice gate admit at the
   * cap (plus the exempt entries and slot-exempt utilities).
   */
  readonly heldIds: ReadonlySet<DropId>;
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
 * Whether `dropId` counts towards the six slots.
 *
 * Exempt entries (`availableWhenSlotsFull` → Extra Life, Mystery UFO) never
 * consume a slot (producer Q7a), and neither do slot-exempt utilities such as
 * `reset` — they can never occupy a slot, so they never push `used` up.
 */
function countsTowardsSlotCap(dropId: DropId): boolean {
  return !isExemptWhenSlotsFull(dropId) && !SLOT_EXEMPT_UTILITY_DROP_IDS.has(dropId);
}

/**
 * The catalogue entries exempt from the cap, in catalogue order.
 *
 * Derived from the {@link PowerUpEntry.availableWhenSlotsFull} flag only — there
 * are no `id === '…'` special cases, so a future exempt entry needs no code
 * change and a newly added entry is non-exempt by default. Catalogue order is
 * deterministic, which makes it usable as a degradation fallback.
 */
export const SLOTS_FULL_EXEMPT_IDS: readonly PowerUpId[] = (
  Object.keys(POWER_UP_CATALOGUE) as PowerUpId[]
).filter((id) => isExemptWhenSlotsFull(id));

/**
 * The ids a full pool still allows: every held kind, every
 * available-when-full catalogue entry, and the slot-exempt utilities.
 *
 * The shared drop draw uses this as the spawner's eligibility filter and the
 * collection gate admits the same set, so no scene ever re-derives it.
 */
export function eligibleDropIds(state: PowerUpSlotState): Set<DropId> {
  return new Set<DropId>([
    ...state.heldIds,
    ...SLOTS_FULL_EXEMPT_IDS,
    ...SLOT_EXEMPT_UTILITY_DROP_IDS,
  ]);
}

/**
 * The deterministic id a gated draw degrades to when its source offers nothing
 * eligible: the first available-when-full catalogue entry, else the first
 * catalogue id (so a catalogue change can never crash a draw).
 */
export function firstExemptDropId(): DropId {
  return SLOTS_FULL_EXEMPT_IDS[0] ?? (Object.keys(POWER_UP_CATALOGUE)[0] as PowerUpId);
}

/** Structural player view needed to derive the slot state. */
export interface SlotPlayerView {
  getPowerUpLevels(): PowerUpSlotLevels;
  getWeaponLevels(): WeaponSlotLevels;
  /** Active temporary (field-pickup) power-up kinds; optional for doubles. */
  getTempPowerUpIds?(): readonly PowerUpId[];
  /** Active temporary (field-pickup) weapon kinds; optional for doubles. */
  getTempWeaponIds?(): readonly WeaponId[];
}

/**
 * The four snapshots that define the slot state, shaped for a
 * `ChoiceContext` spread so every launcher (game and gyms) feeds the choice
 * exactly what the draw/collection gates use.
 */
export interface SlotSnapshot {
  powerUpLevels: PowerUpSlotLevels;
  weaponLevels: WeaponSlotLevels;
  tempPowerUpIds: readonly PowerUpId[];
  tempWeaponIds: readonly WeaponId[];
}

/**
 * Builds the slot snapshot from a player (empty snapshots when no player
 * exists, e.g. a scene before the ship spawns).
 */
export function slotSnapshotForPlayer(player: SlotPlayerView | null): SlotSnapshot {
  return {
    powerUpLevels: player?.getPowerUpLevels() ?? [],
    weaponLevels: player?.getWeaponLevels() ?? [],
    tempPowerUpIds: player?.getTempPowerUpIds?.() ?? [],
    tempWeaponIds: player?.getTempWeaponIds?.() ?? [],
  };
}

/**
 * Resolves the live run's slot state from a player (null when no player exists,
 * e.g. a scene before the ship spawns).
 *
 * A single structural seam so `PlayScene` and every gym derive occupancy the
 * same way (gym↔game parity, AH-0MUGZDTFX004RBD1).
 */
export function resolvePlayerSlotState(
  player: SlotPlayerView | null,
): PowerUpSlotState {
  const snapshot = slotSnapshotForPlayer(player);
  return resolveSlotState(
    snapshot.powerUpLevels,
    snapshot.weaponLevels,
    snapshot.tempPowerUpIds,
    snapshot.tempWeaponIds,
  );
}

/**
 * Resolves the run's slot occupancy from permanent grants plus active
 * temporary stacks.
 *
 * - Power-up ids with a permanent level ≥ 1, or with at least one active
 *   temporary stack, are held.
 * - Weapon **drop** ids with a permanent level ≥ 1, or with an active
 *   temporary stack, are held in the same pool. The permanent `cannon` is
 *   ignored: it is not a permanent reward and can never time out.
 * - Exempt entries (Extra Life, Mystery UFO) and the `reset` utility are held
 *   but never **count** towards the cap (Q7a), so `used` cannot be inflated by
 *   taking an always-available reward.
 * - A repeat pickup or grant of a held kind levels it, it never opens a second
 *   slot (both stores report one entry per kind).
 *
 * `free` is clamped at 0 so a state can never report a negative remainder.
 */
export function resolveSlotState(
  powerUpLevels: PowerUpSlotLevels,
  weaponLevels: WeaponSlotLevels,
  tempPowerUpIds: readonly PowerUpId[] = [],
  tempWeaponIds: readonly WeaponId[] = [],
): PowerUpSlotState {
  const ownedIds = new Set<DropId>();
  const heldIds = new Set<DropId>();

  for (const { id, level } of powerUpLevels) {
    if (level >= 1) {
      ownedIds.add(id);
      heldIds.add(id);
    }
  }

  for (const { id, level } of weaponLevels) {
    // Drop kinds only: excludes the permanent cannon (and any future
    // non-drop weapon), which can never occupy one of the six slots.
    if (level >= 1 && WEAPON_DROP_ID_SET.has(id)) {
      ownedIds.add(id as DropId);
      heldIds.add(id as DropId);
    }
  }

  // Active temporary (field-pickup) stacks occupy a slot while they last
  // (producer Q4a). The weapon half is restricted to real weapon drops so a
  // temporary cannon can never appear.
  for (const id of tempPowerUpIds) {
    heldIds.add(id);
  }
  for (const id of tempWeaponIds) {
    if (WEAPON_DROP_ID_SET.has(id)) {
      heldIds.add(id as DropId);
    }
  }

  const used = [...heldIds].filter(countsTowardsSlotCap).length;

  return {
    used,
    free: Math.max(0, POWER_UP_SLOT_CAP - used),
    isFull: used >= POWER_UP_SLOT_CAP,
    ownedIds,
    heldIds,
  };
}

/**
 * May `dropId` be drawn as a drop, offered as a permanent pick, or collected
 * from the field?
 *
 * Below the cap every id is eligible, so the pre-cap distribution is unchanged
 * (same eligible set, same weights). At or above the cap only the kinds
 * currently held, catalogue entries flagged `availableWhenSlotsFull`, and the
 * slot-exempt `reset` utility remain eligible — everything else is gated until
 * a slot frees (a temporary window expiring or a run restart).
 */
export function isWithinSlotPool(
  dropId: DropId,
  state: PowerUpSlotState,
): boolean {
  if (!state.isFull) return true;
  return (
    state.heldIds.has(dropId) ||
    isExemptWhenSlotsFull(dropId) ||
    SLOT_EXEMPT_UTILITY_DROP_IDS.has(dropId)
  );
}

/**
 * Filters `dropIds` to those still eligible, preserving their order and
 * without mutating the input.
 *
 * Held kinds always survive, so the eligible set is never empty for a full
 * pool: the six held kinds are by definition eligible, and the flagged
 * entries (Extra Life, Mystery UFO) plus `reset` stay available too. A
 * weapon-only build therefore degrades to its held weapons plus the flagged
 * entries rather than to nothing (documented design consequence of the shared
 * pool).
 */
export function eligibleForSlotPool(
  dropIds: readonly DropId[],
  state: PowerUpSlotState,
): DropId[] {
  return dropIds.filter((dropId) => isWithinSlotPool(dropId, state));
}

/**
 * Filters offer objects that carry a drop `id` (choice/reward options) to
 * those admissible on the shared pool.
 *
 * Offer surfaces that do **not** build their list through
 * `buildChoiceCandidates` must consult this: the mini-boss reward's **unlock**
 * half offers brand-new weapon kinds (`lockedWeaponIds()`), so without the gate
 * a single mini-boss unlock could grant a seventh kind and defeat the cap
 * (parent AH-0MVLIJT3M005HPHF AC4 — the reward must offer only items currently
 * in the slots). A level-up offer names a kind the player already holds
 * permanently, so it is always admissible and always survives; below the cap
 * the filter keeps every offer, so below-cap behaviour is unchanged.
 *
 * Never mutates the input list.
 */
export function filterOptionsWithinSlotPool<T extends { id: DropId }>(
  options: readonly T[],
  state: PowerUpSlotState,
): T[] {
  return options.filter((option) => isWithinSlotPool(option.id, state));
}

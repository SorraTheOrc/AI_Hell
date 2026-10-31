/**
 * Committed six-slot loadout fixtures for the HUD ↔ slot-model agreement
 * tests (AH-0MVVJRFDV007OI49, parent AH-0MVVF0POV001JNKX).
 *
 * ## Why a committed fixture
 *
 * The RCA for the "HUD shows more than six equipped upgrades" report ran
 * against `recordings/six-slot.jsonl`, which is **gitignored** (`recordings/`).
 * A test therefore cannot depend on it. These fixtures carry only the parts of
 * that recording that matter — the permanent/temporary kinds, the exempt
 * entry, and a charge pool left behind by an expired field window — and rebuild
 * them through the **real shipped seams**:
 *
 * - `PowerUpLevelStore` (the player's single run-scoped level store) for the
 *   permanent and temporary levels;
 * - `EffectsRegistry.applyCollect` / `applyWeapon` for the windows the HUD
 *   renders from — the same calls `CombatCoreScene._collectDrop` makes;
 * - `Player.equipWeapon` for the weapon level the slot model derives from.
 *
 * `resolvePlayerSlotState(player)` then derives occupancy exactly as the game
 * does, so a test never re-implements the accounting it is checking.
 *
 * ## The recorded states (runSeed 3596032192)
 *
 * - **tick 4540** — six slot-counted kinds held, but the HUD renders only five
 *   rows: the field-pickup **Orbital Strike** holds a slot while rendering no
 *   row (`_isPowerUpRowVisible('strike')` → `isStrikePermanent()`).
 * - **tick 5899** — seven rendered rows for five slots: five slot-counted
 *   kinds (three permanent weapons, one temporary weapon, one temporary
 *   power-up) plus the slot-exempt **Mystery UFO** (`availableWhenSlotsFull`,
 *   producer Q7a) and a **Phase Shift** row kept alive by residual charges
 *   after its 15 s temporary window expired (producer Resolved decision 1b).
 *
 * The fixtures are *states*, not expectations: the tests derive every expected
 * number from `resolveSlotState`/`POWER_UP_SLOT_CAP`, so a fixture can never
 * quietly encode the answer it is supposed to prove.
 *
 * ## Test-infrastructure only
 *
 * Nothing here is imported by production code.
 *
 * @module test/sixSlotLoadoutFixtures
 */

import type Phaser from 'phaser';

import { Player } from '../entities/Player';
import { EffectsRegistry } from '../powerups/effects';
import { resolveTemporaryWindow } from '../powerups/powerUpLevels';
import {
  resolvePlayerSlotState,
  type PowerUpSlotState,
} from '../powerups/slots';
import { POWER_UP_CATALOGUE, type PowerUpId } from '../powerups/types';
import type { WeaponId } from '../utils/weapons';

/** The three recorded/ordinary loadouts the agreement tests replay. */
export type SixSlotLoadoutId =
  | 'below-cap-mixed'
  | 'six-slots-five-rows'
  | 'seven-rows-five-slots';

/** One loadout state, described as the grants that build it. */
export interface SixSlotLoadoutSpec {
  readonly id: SixSlotLoadoutId;
  /** Where the state comes from (RCA tick or "ordinary play"). */
  readonly evidence: string;
  /** Hold-full/permanent power-up grants (one each). */
  readonly permanentPowerUps: readonly PowerUpId[];
  /** Live field-pickup power-up windows (one each). */
  readonly temporaryPowerUps: readonly PowerUpId[];
  /** Hold-full/permanent weapon grants (one each). */
  readonly permanentWeapons: readonly WeaponId[];
  /** Live field-pickup weapon windows (one each). */
  readonly temporaryWeapons: readonly WeaponId[];
  /**
   * Kinds collected as a field pickup whose temporary window has since
   * expired. Their granted consumables survive (Resolved decision 1b), which
   * is what keeps a charge-pool row on the HUD without holding a slot.
   */
  readonly expiredPowerUpWindows: readonly PowerUpId[];
}

/**
 * The fixture loadouts, in ascending occupancy.
 *
 * Kind membership follows the RCA comment above; `heavy_slug`, `mortar`,
 * `spread`, `rapid`, `shard_swarm` and `rear_guard` are the weapon drops,
 * `mineral_scoop`, `strike` and `salvage` the power-ups.
 */
export const SIX_SLOT_LOADOUTS: Readonly<
  Record<SixSlotLoadoutId, SixSlotLoadoutSpec>
> = {
  'below-cap-mixed': {
    id: 'below-cap-mixed',
    evidence: 'ordinary below-cap play (mixed permanent + countdown loadout)',
    permanentPowerUps: ['magnet', 'mystery_ufo'],
    temporaryPowerUps: ['speed_boost'],
    permanentWeapons: ['spread'],
    temporaryWeapons: ['rapid'],
    expiredPowerUpWindows: [],
  },
  'six-slots-five-rows': {
    id: 'six-slots-five-rows',
    evidence:
      'recordings/six-slot.jsonl tick 4540 (runSeed 3596032192): six slot-counted kinds, five rows',
    permanentPowerUps: ['mineral_scoop'],
    temporaryPowerUps: ['strike'],
    permanentWeapons: ['heavy_slug', 'mortar'],
    temporaryWeapons: ['rapid', 'shard_swarm'],
    expiredPowerUpWindows: [],
  },
  'seven-rows-five-slots': {
    id: 'seven-rows-five-slots',
    evidence:
      'recordings/six-slot.jsonl tick 5899 (runSeed 3596032192): seven rows for five slot-counted kinds',
    permanentPowerUps: ['mystery_ufo', 'extra_life'],
    temporaryPowerUps: ['salvage'],
    permanentWeapons: ['heavy_slug', 'mortar', 'spread'],
    temporaryWeapons: ['rear_guard'],
    expiredPowerUpWindows: ['phase_shift'],
  },
};

/** Every fixture id, in a stable order (ascending occupancy). */
export const SIX_SLOT_LOADOUT_IDS: readonly SixSlotLoadoutId[] = [
  'below-cap-mixed',
  'six-slots-five-rows',
  'seven-rows-five-slots',
];

/** A loadout built through the real seams, with the objects it lives on. */
export interface BuiltSixSlotLoadout {
  readonly spec: SixSlotLoadoutSpec;
  /** The live player the slot model reads (the fixture's `Player` double). */
  readonly player: Player;
  /** The registry the HUD renders rows from (bound to the player's store). */
  readonly registry: EffectsRegistry;
}

/** Extra time past a window so the expiry path definitely runs. */
const EXPIRY_MARGIN_SECONDS = 0.5;

/**
 * Builds `id` in `scene` through the shipped collection seams.
 *
 * Every field pickup opens its temporary level window, so the expired windows
 * are built **first**: ticking to expire them would otherwise expire the
 * windows that must still be alive.
 *
 * @param scene — The scene the fixture's `Player` belongs to.
 * @param id — Which fixture loadout to build.
 */
export function buildSixSlotLoadout(
  scene: Phaser.Scene,
  id: SixSlotLoadoutId,
): BuiltSixSlotLoadout {
  const spec = SIX_SLOT_LOADOUTS[id];

  const player = new Player(scene, { x: 0, y: 0 });
  scene.add.existing(player);
  // One level store for both consumers, exactly as the scenes wire it
  // (AH-0MUV5CLW6005VF7K, Q1=A): the HUD rows and the slot model can never
  // disagree about which kinds are held because they read the same store.
  const registry = new EffectsRegistry(player.getPowerUpLevelStore());

  for (const powerUpId of spec.expiredPowerUpWindows) {
    registry.applyCollect(powerUpId);
    registry.tick(
      resolveTemporaryWindow(powerUpId, 0) + EXPIRY_MARGIN_SECONDS,
    );
  }

  for (const powerUpId of spec.permanentPowerUps) {
    registry.applyCollect(powerUpId, true);
  }
  for (const powerUpId of spec.temporaryPowerUps) {
    registry.applyCollect(powerUpId);
  }

  // The shipped weapon seam (CombatCoreScene._collectDrop): the registry
  // carries the HUD-visible window, the player carries the level the slot
  // model derives occupancy from.
  for (const weaponId of spec.permanentWeapons) {
    registry.applyWeapon(weaponId, true);
    player.equipWeapon(weaponId, true);
  }
  for (const weaponId of spec.temporaryWeapons) {
    registry.applyWeapon(weaponId);
    player.equipWeapon(weaponId);
  }

  return { spec, player, registry };
}

/** The slot model's view of a built loadout (derived, never stored). */
export function sixSlotLoadoutState(
  loadout: BuiltSixSlotLoadout,
): PowerUpSlotState {
  return resolvePlayerSlotState(loadout.player);
}

/**
 * A row-kind oracle for the agreement tests: is `dropId` one of the kinds the
 * shared model counts towards the six slots?
 *
 * A row can be rendered without holding a slot (a residual Phase Shift /
 * Teleport charge pool, producer Resolved decision 1b), so "rendered" is not
 * the same as "slot-counted": the kind must be **held** *and* non-exempt.
 * This mirrors `countsTowardsSlotCap` in `src/powerups/slots.ts`; the HUD must
 * derive its own classification from the same model rather than repeat it.
 */
export function isSlotCountedKind(
  dropId: string,
  state: PowerUpSlotState,
): boolean {
  if (!state.heldIds.has(dropId as PowerUpId)) return false;
  const entry = POWER_UP_CATALOGUE[dropId as PowerUpId];
  if (entry?.availableWhenSlotsFull === true) return false;
  return dropId !== 'reset';
}

/** The distinct kinds the model counts towards the six slots, sorted. */
export function slotCountedKinds(state: PowerUpSlotState): string[] {
  return [...state.heldIds]
    .filter((dropId) => isSlotCountedKind(dropId, state))
    .sort();
}

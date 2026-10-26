/**
 * Shared scene-setup applier (AH-0MVNW8VNN004FFK1).
 *
 * Turns a validated, normalised capture `setup` into **play state** using only
 * existing shared seams — the player loadout (`Player.equipWeapon`) and the
 * power-up level store (`PowerUpLevelStore.collect`). Gyms call this from
 * `init`/`create` so the configured state is live **before** the first captured
 * frame (i.e. during the `playMs` warm-up), and so no per-scene copy of the
 * setup→state mapping can drift.
 *
 * Deliberate non-goals (recorded on the work item):
 *
 * - **No scene-class generation and no duplicated gameplay bodies.** This
 *   helper mutates already-constructed, shared objects; the gym↔game parity
 *   guard (`CombatScene.equivalence.test.ts`) therefore stays green.
 * - **Level / starting-wave / enemy hand-off stays scene-specific.** Those are
 *   structural launch parameters (a `LevelDefinition`, an enemy config key),
 *   not loadout state, so each gym applies them through its own documented
 *   seams (`GymLevelData.level`, `GymFodderEnemies.init({ enemyKey })`).
 * - **Formation-gym rosters stay config-driven.** A formation gym's enemy set
 *   is fixed by its constructor config; only `GymFodderEnemies` can select its
 *   roster from a setup (the divergence recorded on the work item).
 *
 * `applySceneSetup` is intentionally total: an absent setup (or a scene with no
 * player) is a no-op, so a scene started without a setup keeps exactly its
 * pre-change behaviour.
 */

import type { PowerUpId } from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';

/**
 * The narrow player surface a setup needs. Kept structural so the applier is
 * unit-testable with a fake and so it cannot reach into `Player` internals.
 */
export interface SceneSetupPlayer {
  /** Grants (`permanent`) or times (`!permanent`) a weapon. */
  equipWeapon(id: WeaponId, permanent?: boolean): void;
  /** The run-scoped power-up level store. */
  getPowerUpLevelStore(): {
    collect(id: PowerUpId, permanent?: boolean): number;
  };
}

/**
 * The diagnostic grid a scene exposes to a setup. Only a player accessor is
 * needed; level/enemy hand-off is scene-specific and applied by each gym.
 */
export interface SceneSetupSeams {
  /** The scene's player, or `null` when it has no player component. */
  getPlayer(): SceneSetupPlayer | null;
}

/** The loadout/power-up half of a normalised capture setup. */
export interface SceneSetupState {
  player?: {
    weapons?: readonly string[];
    timedWeapons?: readonly string[];
  };
  powerUps?: Readonly<Record<string, number>>;
}

/**
 * The default permanent loadout for a setup-less `GymLevel` run.
 *
 * This reproduces `GymLevel`'s pre-change hard-coded start exactly (spread +
 * dual, both permanent), so an omitted `player` is unchanged behaviour. Pinned
 * against the capture module's `DEFAULT_SCENE_SETUP_PLAYER_WEAPONS` by a parity
 * test so the two defaults cannot drift.
 */
export const DEFAULT_GYM_LEVEL_WEAPONS: readonly WeaponId[] = ['spread', 'dual'];

/**
 * Applies the loadout/power-up half of `setup` to the scene's player.
 *
 * - `setup.player.weapons` → `equipWeapon(id, true)` (permanent for the run).
 * - `setup.player.timedWeapons` → `equipWeapon(id, false)` (starts the shared
 *   timed-weapon countdown).
 * - `setup.powerUps[id] = n` → `collect(id, true)` **n** times, so the
 *   power-up reaches the configured permanent level.
 *
 * No-ops for an absent setup or a scene with no player, so a scene started
 * without a setup keeps its pre-change state.
 *
 * @param seams — the scene's player accessor.
 * @param setup — a normalised setup (or `null`/`undefined`).
 */
export function applySceneSetup(
  seams: SceneSetupSeams,
  setup: SceneSetupState | null | undefined,
): void {
  if (!setup) return;
  const player = seams.getPlayer();
  if (!player) return;

  for (const id of setup.player?.weapons ?? []) {
    player.equipWeapon(id as WeaponId, true);
  }
  for (const id of setup.player?.timedWeapons ?? []) {
    player.equipWeapon(id as WeaponId, false);
  }

  const store = player.getPowerUpLevelStore();
  for (const [id, level] of Object.entries(setup.powerUps ?? {})) {
    if (!Number.isInteger(level) || level <= 0) continue;
    for (let i = 0; i < level; i += 1) {
      store.collect(id as PowerUpId, true);
    }
  }
}

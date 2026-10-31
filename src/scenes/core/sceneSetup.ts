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
 *
 * ## Slot-cap divergence — documented, not silent
 *
 * A planned capture loadout may pre-grant **more than six counted kinds**
 * (`weapons` + `weaponLevels` + `powerUps`), which no organic play surface can
 * do: the Oct 29 recordings start at tick 0 with seven permanently-granted
 * kinds and zero pickups. Gating the applier would break the scripted video and
 * gym beats that exist to show a full late-game ship, so this surface
 * **intentionally diverges** from the cap (decision recorded on
 * AH-0MVVJS34M00551ES AC3, docs in GDD §4.4 and `docs/BALANCING.md`).
 *
 * The divergence is contained by a guard instead of a gate:
 * {@link resolveSceneSetupState} only returns a setup when the run-progress dev
 * gate is on (`import.meta.env.DEV`, folded to `false` in a shipped build), and
 * `PlayScene` applies a setup **only** through it — so the normal play path can
 * never inherit a capture loadout, while the capture/gym path keeps its
 * designed freedom. `applySceneSetup` itself never consults the slot pool.
 */

import type { PowerUpId } from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';

/**
 * Resolves the capture setup a scene is allowed to apply.
 *
 * The run-progress dev gate is the **only** thing that admits a setup: in a
 * shipped build `devEnabled` folds to `false`, so a launch payload can never
 * place a pre-granted (potentially over-cap) loadout into normal play. This is
 * the guard that contains the documented slot-cap divergence of this module
 * (AH-0MVVJS34M00551ES AC3) — see the module doc.
 *
 * @param setup - The raw `setup` field of a scene's launch data, if any.
 * @param options.devEnabled - Whether the run-progress dev gate is on.
 * @returns The setup to apply, or `null` when it must be ignored.
 */
export function resolveSceneSetupState(
  setup: unknown,
  options: { devEnabled: boolean },
): SceneSetupState | null {
  if (!options.devEnabled) return null;
  if (!setup || typeof setup !== 'object') return null;
  return setup as SceneSetupState;
}

/**
 * The narrow player surface a setup needs. Kept structural so the applier is
 * unit-testable with a fake and so it cannot reach into `Player` internals.
 */
export interface SceneSetupPlayer {
  /** Grants (`permanent`) or times (`!permanent`) a weapon. */
  equipWeapon(id: WeaponId, permanent?: boolean): void;
  /**
   * Sets the heading the ship reports while stationary (radians, `0` = right).
   * Optional so a fake without heading support stays valid
   * (AH-0MVTJW9JW002PHJG).
   */
  setDefaultHeading?(radians: number): void;
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
    /**
     * Per-weapon permanent levels (`id` → level). A level `N` is applied as
     * **N** permanent `equipWeapon(id, true)` grants, so a weapon configured
     * both here and in `weapons` starts at `1 + N` (AH-0MVRMFOB4002LMZS).
     */
    weaponLevels?: Readonly<Record<string, number>>;
    /**
     * Stationary facing in **degrees** (`0` = right/east, positive clockwise,
     * `-90` = up). A captured scene takes no input, so without this the ship
     * never moves, keeps `Player`'s default heading (right) and fires sideways
     * past the enemies above it (AH-0MVTJW9JW002PHJG).
     */
    heading?: number;
  };
  powerUps?: Readonly<Record<string, number>>;
  /**
   * Hold-full reward id the level gyms resolve to when their mineral hold
   * fills, instead of the random choice (AH-0MVRMFOB4002LMZS).
   */
  mineralReward?: string;
  /**
   * Hits the boss-capable gyms (`GymBoss`/`GymMiniBoss`) leave their spawned
   * entity when the scene starts (AH-0MVRMFPXF008BG77). Applied through the
   * entity's existing `initialHp` constructor seam — the same one the dev boss
   * scenario uses — so a scripted capture can start a boss close to death
   * without changing the entity's total hit pool. Absent ⇒ the full pool.
   */
  bossHitsRemaining?: number;
  /**
   * Initial state of a formation/combat gym's SHOOT toggle
   * (AH-0MVRMI0Q7001KG4Y). Consumed by the fire-capable gyms whose HUD exposes
   * the toggle (`GymBoss`, `GymFodderEnemies`, `GymMiniBoss`,
   * `GymPowerUpsCombat`); absent ⇒ the scene's historical default (OFF for the
   * formation family, ON for the combat power-up gym). The no-fire
   * `GymCentipede`/`GymMinerals` do not accept it.
   */
  shootEnabled?: boolean;
  /**
   * Whether `GymPlayer` spawns its deterministic obstacle course
   * (AH-0MVRMI0Q7001KG4Y). Absent or `true` ⇒ the historical course; `false`
   * ⇒ an empty arena, for a clean-flight capture.
   */
  obstacles?: boolean;
  /**
   * Whether `GymWeapons` spawns its inert AOE practice targets
   * (AH-0MVRMI0Q7001KG4Y). Absent or `true` ⇒ the historical tripod; `false`
   * ⇒ no targets, for a pure weapon-cadence capture.
   */
  practiceTargets?: boolean;
  /**
   * Size of `GymPowerUpsCombat`'s scout threat wave (AH-0MVRMI0Q7001KG4Y),
   * bounded by the capture schema to 1–12. Absent ⇒ the historical 3-scout V.
   */
  threatCount?: number;
  /**
   * Size of `GymPowerUpsUtility`'s seeded mineral field
   * (AH-0MVRMI0Q7001KG4Y), bounded by the capture schema to 0–200. Absent ⇒
   * the historical 40-mineral demonstration field.
   */
  minerals?: number;
  /**
   * 32-bit determinism seed (AH-0MVNW90FB003H3KM). When present, the scene
   * seeds its content RNGs from it so the same config reproduces the same
   * enemy placement, minerals and drop cadence.
   */
  seed?: number;
}

/**
 * Returns the deterministic seed a setup supplies, or `null` when it supplies
 * none (or an invalid one).
 *
 * Pure and total so a scene can decide in one place whether to re-seed its
 * content RNGs. A `null` result means "leave the scene's historical
 * `Math.random` default in place", which is what keeps a setup-less run
 * byte-for-byte behaviour-compatible.
 *
 * @param setup — a normalised (or raw) setup.
 * @returns a 32-bit unsigned integer seed, or `null`.
 */
export function resolveSetupSeed(
  setup: SceneSetupState | null | undefined,
): number | null {
  const seed = setup?.seed;
  if (
    typeof seed !== 'number'
    || !Number.isInteger(seed)
    || seed < 0
    || seed > 0xffffffff
  ) {
    return null;
  }
  return seed >>> 0;
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
 * Resolves the reward id a full mineral hold should grant.
 *
 * The level gyms resolve a full hold **automatically** (no modal, so an
 * autonomous bot keeps playing — a documented gym-only divergence). By
 * default they draw a random option; a capture setup can force the reward so a
 * scripted pay-off lands deterministically on camera (AH-0MVRMFOB4002LMZS).
 *
 * Pure and total: a forced `mineralReward` wins and `randomChoice` is **never**
 * called (so a forced scene consumes no choice RNG); without one the caller's
 * strategy chooses, i.e. today's behaviour is unchanged.
 *
 * @param setup — a normalised setup (or `null`/`undefined`).
 * @param randomChoice — today's random resolution, invoked only when the
 *   setup forces no reward.
 * @returns the reward id to apply.
 */
export function resolveMineralReward(
  setup: SceneSetupState | null | undefined,
  randomChoice: () => string,
): string {
  const forced = setup?.mineralReward;
  if (typeof forced === 'string' && forced !== '') return forced;
  return randomChoice();
}

/**
 * Applies the loadout/power-up half of `setup` to the scene's player.
 *
 * - `setup.player.weapons` → `equipWeapon(id, true)` (permanent for the run).
 * - `setup.player.timedWeapons` → `equipWeapon(id, false)` (starts the shared
 *   timed-weapon countdown).
 * - `setup.player.weaponLevels[id] = n` → **n** `equipWeapon(id, true)` calls,
 *   after the `weapons` grants, so the weapon reaches level `1 + n` when it is
 *   also listed in `weapons` (level N == N permanent grants; the same
 *   increment `Player.equipWeapon` applies on every pickup). Non-positive or
 *   non-integer levels are ignored, mirroring `powerUps`.
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
  const headingDegrees = setup.player?.heading;
  if (
    typeof headingDegrees === 'number'
    && Number.isFinite(headingDegrees)
    && typeof player.setDefaultHeading === 'function'
  ) {
    // Degrees are the capture-config vocabulary; the player model works in
    // radians (`0` = right, positive clockwise).
    player.setDefaultHeading((headingDegrees * Math.PI) / 180);
  }
  for (const [id, level] of Object.entries(setup.player?.weaponLevels ?? {})) {
    if (!Number.isInteger(level) || level <= 0) continue;
    for (let i = 0; i < level; i += 1) {
      player.equipWeapon(id as WeaponId, true);
    }
  }

  const store = player.getPowerUpLevelStore();
  for (const [id, level] of Object.entries(setup.powerUps ?? {})) {
    if (!Number.isInteger(level) || level <= 0) continue;
    for (let i = 0; i < level; i += 1) {
      store.collect(id as PowerUpId, true);
    }
  }
}

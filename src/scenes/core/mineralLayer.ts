/**
 * Shared mineral layer — collection, absorption and choice rewards
 * (parent AH-0MUII2FJ5007MDDA, gap 5).
 *
 * The mineral *collection* loop was duplicated (`PlayScene._handleMinerals`
 * ≈ `GymFormationScene._updateMinerals`) and the hold-full *reward*
 * application was written twice with different contracts. This module owns
 * the single implementations both scenes now call:
 *
 * - {@link collectMinerals} — player pickup + non-asteroid enemy absorption;
 * - {@link applyMineralChoiceReward} — permanent weapon/power-up application;
 * - {@link MineralHold} — re-exported from `core/mineralHold` so the whole
 *   mineral seam (collection + hold) is available from one place.
 *
 * The kill-drop rule stays in {@link ./mineralKillDrops} (delivered by
 * AH-0MUIGTRFY002JDDS) and plugs into the same seam: callers collect with
 * `collectMinerals` and spawn drops with `resolveMineralKillDrops`.
 *
 * @module scenes/core/mineralLayer
 */

import { MINERAL_SIZE, SHIP_SIZE } from '../../core/constants';
import { MineralHold } from '../../core/mineralHold';
import type { Mineral } from '../../entities/Mineral';
import type { EffectsRegistry } from '../../powerups/effects';
import type { ChoiceOption } from '../../powerups/choice';
import {
  isWeaponDrop,
  type PowerUpId,
} from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';

export { MineralHold };
export type { MineralHoldOptions } from '../../core/mineralHold';

/**
 * Minimal structural contract an enemy must satisfy to absorb minerals.
 * `PlayScene`'s `EnemyEntity` and the gym's `FormationSceneEntity` both
 * satisfy it for their non-asteroid archetypes; asteroids are filtered out
 * by the caller (they are inert to minerals — GDD §4.5).
 */
export interface MineralAbsorbingEnemy {
  /** World-space position. */
  readonly x: number;
  readonly y: number;
  /** False once the entity is destroyed. */
  readonly alive: boolean;
  /** Circle radius used for mineral overlap. */
  getHitRadius(): number;
  /** Tallies an absorbed mineral on the enemy. */
  collectMineral(): void;
}

/** Scene host whose player can collect minerals (structural minimum). */
export interface MineralCollectorPlayer {
  x: number;
  y: number;
}

/** Circle-vs-circle overlap (`Math.hypot <= rA + rB`), mirroring the shared core. */
function overlaps(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  return Math.hypot(ax - bx, ay - by) <= ar + br;
}

/** Options for {@link collectMinerals}. */
export interface MineralCollectionOptions {
  /**
   * When true the player cannot collect minerals — the P6 Phase Shift
   * pass-through also blocks mineral pickup while phased (Q7). Enemy
   * absorption is unaffected. Collection resumes the moment the phase
   * expires.
   */
  playerPhased?: boolean;
}

/**
 * Runs one mineral collection/absorption pass over `minerals`.
 *
 * For each live mineral: the player collects it when their hulls overlap
 * (invoking `onPlayerCollected` for hold/HUD side effects); otherwise the
 * first overlapping enemy in `enemies` absorbs it (tallied on the enemy,
 * with the mineral's absorb VFX triggered). Collected and absorbed minerals
 * are destroyed; the survivors are returned as a **new** array so the
 * caller can reassign its mineral field.
 *
 * `enemies` must contain only mineral-absorbing archetypes: the caller
 * excludes asteroids (inert) and any entity without `collectMineral`.
 *
 * When `options.playerPhased` is true the player collects nothing this pass
 * (P6 pass-through gates mineral pickup — Q7); the minerals survive unless
 * an enemy absorbs them.
 *
 * @param minerals — the live mineral field (not mutated in place).
 * @param player — the collecting player, or null when absent.
 * @param enemies — eligible non-asteroid enemies.
 * @param onPlayerCollected — invoked once per player pickup with the
 *   mineral that was collected (the mineral's `player` overlap has already
 *   been recorded).
 * @param options — optional collection gates (see {@link MineralCollectionOptions}).
 * @returns The surviving minerals (a new array).
 */
export function collectMinerals<TEnemy extends MineralAbsorbingEnemy>(
  minerals: Mineral[],
  player: MineralCollectorPlayer | null,
  enemies: readonly TEnemy[],
  onPlayerCollected: (mineral: Mineral) => void,
  options?: MineralCollectionOptions,
): Mineral[] {
  const kept: Mineral[] = [];
  const playerHull = SHIP_SIZE / 2;
  const playerCanCollect = !(options?.playerPhased ?? false);

  for (const mineral of minerals) {
    if (!mineral.alive) continue;

    if (
      player &&
      playerCanCollect &&
      overlaps(
        mineral.x,
        mineral.y,
        MINERAL_SIZE,
        player.x,
        player.y,
        playerHull,
      )
    ) {
      mineral.handleOverlap('player');
      onPlayerCollected(mineral);
      continue;
    }

    let absorbed = false;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      // Spawning enemies are still growing — they do not absorb minerals.
      if ((enemy as { isSpawning?: boolean }).isSpawning) continue;
      if (
        overlaps(
          mineral.x,
          mineral.y,
          MINERAL_SIZE,
          enemy.x,
          enemy.y,
          enemy.getHitRadius(),
        )
      ) {
        enemy.collectMineral();
        mineral.handleOverlap('enemy');
        absorbed = true;
        break;
      }
    }
    if (!absorbed) kept.push(mineral);
  }

  for (const mineral of minerals) {
    if (!kept.includes(mineral)) mineral.destroy();
  }
  return kept;
}

/**
 * Applies a hold-full choice option permanently for the current run, so
 * the gym and the game grant the same effect for the same choice:
 * a weapon option permanently equips the weapon; a `weapon-level` option
 * permanently **levels up** an owned weapon (the same `equipWeapon` path
 * increments the run-scoped level, AC3); a power-up option permanently
 * applies the collect effect (GDD §4.5).
 *
 * @param option — the chosen option (exactly the option offered).
 * @param effectsRegistry — the scene's effect registry.
 * @param player — the ship to equip, or null when no player exists.
 */
/**
 * Minimal player contract: weapon equip for weapon/weapon-level offers.
 * Structurally satisfied by {@link Player} in both the game and every gym.
 *
 * Power-up options no longer call into the player directly: the registry's
 * `applyCollect` advances the **single** run-scoped store the scene injected
 * from the player (AH-0MUV5CLW6005VF7K, Q1=A), so the level rises exactly
 * once with no double-count.
 */
interface MineralChoicePlayer {
  equipWeapon(weaponId: WeaponId, permanent?: boolean): void;
}

export function applyMineralChoiceReward(
  option: ChoiceOption,
  effectsRegistry: EffectsRegistry,
  player: MineralChoicePlayer | null,
): void {
  if (option.kind === 'weapon-level' || isWeaponDrop(option.id)) {
    const weaponId = option.id as WeaponId;
    // Permanent equip both grants the weapon and raises its run-scoped level
    // by one (`Player.equipWeapon` increments on every collection), so a
    // level-up offer permanently strengthens an already-owned weapon.
    effectsRegistry.applyWeapon(weaponId, true);
    player?.equipWeapon(weaponId, true);
  } else {
    // Power-up options (both `powerup` and `power-up-level`): the registry
    // applies the hold-full effect **and** advances the single run-scoped
    // store (it was injected from the player), so future choices can offer
    // level-ups with no double-count (parent AH-0MUV5CLVO002ZHS9;
    // AH-0MUV5CLW6005VF7K AC1/AC3).
    const powerUpId = option.id as PowerUpId;
    effectsRegistry.applyCollect(powerUpId, true);
  }
}

/** Convenience type guard: whether an arbitrary entity can absorb minerals. */
export function isMineralAbsorbingEnemy(
  entity: unknown,
): entity is MineralAbsorbingEnemy {
  return (
    typeof entity === 'object' &&
    entity !== null &&
    typeof (entity as { collectMineral?: unknown }).collectMineral ===
      'function'
  );
}

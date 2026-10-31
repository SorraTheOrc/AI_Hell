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
 * - {@link applyMineralChoiceReward} — permanent weapon/power-up application
 *   (defined in the Phaser-free `powerups/choiceReward` and re-exported here
 *   so the headless arena shares one reward path);
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

export { MineralHold };
export type { MineralHoldOptions } from '../../core/mineralHold';
// The hold-full reward application lives in the Phaser-free
// `powerups/choiceReward` module (shared with the headless eval arena) and
// is re-exported here so every scene import stays unchanged
// (AH-0MVD1RIH2008YCNV). The two permanent-grant helpers are re-exported for
// the checkpoint-resume replay so the restore path consumes the same seam
// (AH-0MVSHI07B003BZIP).
export {
  applyMineralChoiceReward,
  grantPermanentPowerUp,
  grantPermanentWeapon,
} from '../../powerups/choiceReward';

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
  /**
   * Tallies an absorbed mineral on the enemy. `value` is the mineral's worth
   * (1 for an ordinary dot, {@link MINERAL_DEPOSIT_VALUE} for a red deposit —
   * AH-0MVJ79739008396I), so absorbing a deposit counts as ten minerals and
   * the enemy's own later re-drop can itself resolve at the deposit
   * threshold.
   */
  collectMineral(value?: number): void;
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
   * When true the player cannot collect minerals — the Phase Shift
   * pass-through also blocks mineral pickup while phased (Q7). Enemy
   * absorption is unaffected. Collection resumes the moment the phase
   * expires. The between-waves/levels transition pause is the one
   * exception: `PlayScene` passes `false` for that non-combat breather so
   * an automatic defensive phase does not cost earned minerals
   * (AH-0MUX96GJF006CAZP).
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
 * Absorption credits the mineral's **worth** (`mineral.value`): 1 for an
 * ordinary dot, {@link MINERAL_DEPOSIT_VALUE} for a red deposit, so a deposit
 * is absorbed as ten minerals in one overlap (AH-0MVJ79739008396I). The player
 * pickup callback receives the same mineral, so the collecting scene credits
 * its value too.
 *
 * When `options.playerPhased` is true the player collects nothing this pass
 * (Phase Shift pass-through gates mineral pickup — Q7); the minerals survive unless
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
        enemy.collectMineral(mineral.value);
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

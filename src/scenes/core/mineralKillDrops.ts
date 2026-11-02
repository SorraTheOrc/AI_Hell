/**
 * Shared mineral kill-drop rule (parent AH-0MUHMT5JC004WRSB).
 *
 * Decides, for a destroyed enemy, how many minerals to drop and where. The
 * rule previously lived privately in `PlayScene` and was never shared, while
 * `GymFormationScene` re-implemented the mineral layer without the drop half
 * — so gym asteroids silently dropped nothing. Both the game and the gyms now
 * consume this single implementation, so they can no longer drift apart.
 *
 * Rule (GDD §4.4.1 / §4.5):
 * - small asteroid → exactly one mineral at the death site;
 * - large/medium asteroid → none (their small split children drop);
 * - non-asteroid enemy → its collected minerals plus a random additive bonus
 *   in [`mineralRedropBonusMin`, `mineralRedropBonusMax`] (defaults
 *   0.25–1.25), rounded to the nearest integer and scattered at the death
 *   site (there is no upper cap; an enemy that collected nothing still
 *   draws the bonus and may occasionally drop a single mineral);
 * - anything else → none.
 *
 * **Red deposits (AH-0MVJ79739008396I).** When the resolved re-drop count
 * reaches {@link MINERAL_DEPOSIT_THRESHOLD} (10) the wreck leaves a **single**
 * red deposit worth {@link MINERAL_DEPOSIT_VALUE} (10) minerals instead of a
 * scatter of gold dots. The deposit replaces the **whole** payout, so any
 * surplus is intentionally lost (a wreck resolving 17 pays one 10-value
 * deposit). Below the threshold the ordinary gold scatter is unchanged.
 *
 * The **Salvage** bounty (AH-0MVH80ZJ7009W18Z) layers on top through
 * {@link scatterSalvageMineralDrops}: while its timed window is active a
 * destroyed enemy ship also scatters its level-resolved bonus minerals,
 * rendered orange so the payout is visible on the field
 * (AH-0MVJ72I8O0009T09). {@link resolveMineralKillPayout} is the single seam
 * both scenes call: it folds the Salvage bonus into the threshold count and
 * suppresses the orange scatter when the deposit fires, so one wreck always
 * produces exactly one payout shape.
 *
 * @module scenes/core/mineralKillDrops
 */

import Phaser from 'phaser';

import {
  MINERAL_DEPOSIT_COLOR,
  MINERAL_DEPOSIT_THRESHOLD,
  MINERAL_DEPOSIT_VALUE,
  MINERAL_SALVAGE_COLOR,
} from '../../core/constants';
import { Mineral, scatterMineralDrops } from '../../entities/Mineral';

export { scatterMineralDrops };

/**
 * Minimal structural contract the shared rule reads. Both the game's
 * `EnemyEntity` and the gym's `FormationSceneEntity` satisfy it; only
 * asteroids carry `getSizeTier` and only mineral-absorbing enemies
 * (`BaseEnemy`) carry `mineralRedropCount`.
 */
export interface MineralKillDropEntity extends Phaser.GameObjects.GameObject {
  x: number;
  y: number;
  /** Asteroid size-tier accessor (asteroids only). */
  getSizeTier?(): 'large' | 'medium' | 'small';
  /** Re-drop count for a mineral-absorbing enemy (non-asteroid `BaseEnemy`s). */
  mineralRedropCount?(rng?: () => number): number;
}

/**
 * Resolves the minerals a destroyed `entity` leaves behind at its death site.
 * Returns them in spawn order; callers register them on their own mineral
 * field (the game and gym keep separate fields, so the helper never owns
 * scene-specific hold/HUD state).
 *
 * @param scene — scene that owns the new mineral display objects
 * @param entity — the destroyed enemy (asteroid or mineral-absorbing enemy)
 * @param rng — random-number generator (defaults to `Math.random`); injected
 *   by tests for deterministic bounds checking
 */
export function resolveMineralKillDrops(
  scene: Phaser.Scene,
  entity: MineralKillDropEntity,
  rng: () => number = Math.random,
): Mineral[] {
  // Asteroids: only the small tier leaves a mineral — large/medium rocks
  // split into smaller children, and those children drop when destroyed.
  if (typeof entity.getSizeTier === 'function') {
    return entity.getSizeTier() === 'small'
      ? [new Mineral(scene, { x: entity.x, y: entity.y })]
      : [];
  }

  // Non-asteroid enemy: re-drop its collected minerals plus a random
  // additive bonus (no upper cap), scattered at the death site — or, at the
  // deposit threshold, one red deposit replacing the whole payout.
  if (typeof entity.mineralRedropCount === 'function') {
    return spawnKillPayout(
      scene,
      entity.x,
      entity.y,
      entity.mineralRedropCount(rng),
      0,
      rng,
    );
  }

  return [];
}

/**
 * The **single** kill-payout seam the game and the formation gyms call
 * (AH-0MVJ79739008396I). Resolves everything a destroyed `entity` leaves
 * behind:
 *
 * - a small asteroid → one gold mineral (large/medium → nothing);
 * - a non-asteroid enemy whose resolved re-drop count **plus** the Salvage
 *   bonus reaches {@link MINERAL_DEPOSIT_THRESHOLD} → exactly one red
 *   {@link MINERAL_DEPOSIT_COLOR} deposit worth
 *   {@link MINERAL_DEPOSIT_VALUE} minerals at the wreck, with **no** gold
 *   scatter and **no** orange Salvage scatter (the deposit replaces the whole
 *   payout, so surplus above the deposit value is lost);
 * - a non-asteroid enemy below the threshold → its ordinary gold re-drop plus
 *   (when `salvageBonus > 0`) the orange Salvage scatter.
 *
 * Folding the Salvage bonus into the threshold and suppressing its scatter is
 * what keeps one wreck to exactly one payout shape; doing it here (rather than
 * in each scene) keeps the game and every gym in step.
 *
 * @param scene — scene that owns the new mineral display objects
 * @param entity — the destroyed enemy (asteroid or mineral-absorbing enemy)
 * @param salvageBonus — level-resolved Salvage bonus minerals for this wreck
 *   (0 when the bounty window is inactive or the wreck is not a bounty
 *   target); counted toward the deposit threshold
 * @param rng — random-number generator (defaults to `Math.random`); injected
 *   by tests for deterministic positions
 */
export function resolveMineralKillPayout(
  scene: Phaser.Scene,
  entity: MineralKillDropEntity,
  salvageBonus = 0,
  rng: () => number = Math.random,
): Mineral[] {
  // Asteroids keep the plain rule (they are not Salvage bounty targets and
  // never accumulate minerals, so they can never reach the deposit
  // threshold).
  if (typeof entity.getSizeTier === 'function') {
    return resolveMineralKillDrops(scene, entity, rng);
  }

  if (typeof entity.mineralRedropCount === 'function') {
    return spawnKillPayout(
      scene,
      entity.x,
      entity.y,
      entity.mineralRedropCount(rng),
      Math.max(0, salvageBonus),
      rng,
    );
  }

  // Not a mineral carrier: no re-drop, but the Salvage bounty (when active)
  // still pays out at the wreck exactly as it did before deposits existed.
  if (salvageBonus > 0) {
    return spawnKillPayout(scene, entity.x, entity.y, 0, salvageBonus, rng);
  }
  return [];
}

/**
 * Creates the single red **deposit** a wreck leaves when its resolved payout
 * reaches {@link MINERAL_DEPOSIT_THRESHOLD} (AH-0MVJ79739008396I).
 *
 * The deposit is an ordinary {@link Mineral} for every existing mineral rule
 * (stationary, persists until collected, bullets pass through, no damage, the
 * Phase-Shift collection gate and the Magnet/Scoop attraction) — only its
 * colour and worth differ. Constructing it here keeps the red colour and the
 * 10-mineral value paired in exactly one place, so the kill seam and any
 * deterministic test/gym placement can never disagree.
 *
 * @param scene — scene that owns the new display object
 * @param x — wreck x position (the deposit sits exactly on the wreck)
 * @param y — wreck y position
 */
export function createMineralDeposit(
  scene: Phaser.Scene,
  x: number,
  y: number,
): Mineral {
  return new Mineral(scene, {
    x,
    y,
    color: MINERAL_DEPOSIT_COLOR,
    value: MINERAL_DEPOSIT_VALUE,
  });
}

/**
 * Applies the deposit-vs-scatter decision to one wreck's resolved payout.
 *
 * The threshold compares the **total** resolved minerals
 * (`redropCount + salvageBonus`). At or above it a single red deposit replaces
 * the entire payout (gold scatter and Salvage scatter alike); below it the
 * ordinary gold re-drop is scattered and, when the Salvage bounty is active,
 * its orange bonus is scattered after it — the same RNG draw order as before
 * deposits existed.
 */
function spawnKillPayout(
  scene: Phaser.Scene,
  x: number,
  y: number,
  redropCount: number,
  salvageBonus: number,
  rng: () => number,
): Mineral[] {
  if (redropCount + salvageBonus >= MINERAL_DEPOSIT_THRESHOLD) {
    return [createMineralDeposit(scene, x, y)];
  }

  const drops = scatterMineralDrops(scene, x, y, redropCount, rng);
  if (salvageBonus > 0) {
    drops.push(...scatterSalvageMineralDrops(scene, x, y, salvageBonus, rng));
  }
  return drops;
}

/**
 * Scatters the **Salvage** bounty (AH-0MVH80ZJ7009W18Z) at a destroyed
 * enemy's wreck as orange minerals (AH-0MVJ72I8O0009T09).
 *
 * This is the one shared salvage-drop seam: `PlayScene` and
 * `GymFormationScene` both call it, so the bounty's colour and scatter maths
 * cannot drift between the game and the gyms. The count still comes from
 * `EffectsRegistry.salvageBonusMinerals()` (level-resolved), the scatter draws
 * are the same two per drop in the same order, and each dot is still worth
 * exactly one mineral — only the fill colour differs from an ordinary drop.
 *
 * @param scene — scene that owns the new mineral display objects
 * @param x — wreck x position
 * @param y — wreck y position
 * @param count — bonus minerals to spawn (returns none when ≤ 0)
 * @param rng — random-number generator (defaults to `Math.random`); injected
 *   by tests for deterministic positions
 */
export function scatterSalvageMineralDrops(
  scene: Phaser.Scene,
  x: number,
  y: number,
  count: number,
  rng: () => number = Math.random,
): Mineral[] {
  return scatterMineralDrops(
    scene,
    x,
    y,
    count,
    rng,
    MINERAL_SALVAGE_COLOR,
  );
}

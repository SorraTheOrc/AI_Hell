/**
 * Boss-aware auto-loadout selector — the one pure suggestion rule the game and
 * `GymHangar` consume (AH-0MWOWDNW7001C5X6, part of **AH-0MWOROJYT004WPSD**).
 *
 * The pre-battle hangar screen answers one question for the player: *given the
 * weapons and power-ups I own, and the weaknesses of the hex I am about to
 * attack, what should I bring?* This module computes that suggestion as plain
 * data, so the game, a gym and any future consumer share one rule instead of
 * re-deriving it in scene code.
 *
 * ## The rule (producer Q3 = "A then C")
 *
 * 1. **Variety cap** — at most one weapon per behaviour family, keyed on the
 *    shipped {@link WeaponDefinition} descriptors (`aoe`, `orbit`, `splits`,
 *    `bounce`, `hitscan`, two-or-more distinct `offsets`). No new taxonomy.
 * 2. **Weak weapons are never selected** — `resolveBossMatchup(...) === 'weak'`
 *    is dropped from every step, and the fill step never forces one back in.
 * 3. **Strong first** — owned weapons the boss is weak to come before every
 *    neutral weapon, in catalogue order.
 * 4. **At least one defensive power-up** the deployment auto-grants — the
 *    owned level-bearing power-up rows (`hangarPermanentLevels`), defensives
 *    (the shipped `UPGRADE_STAT_BUCKETS[id] === 'armour'` classification) first.
 * 5. **Then the highest permanent level** — the remaining neutral owned weapons
 *    fill by descending permanent weapon level, catalogue order breaking ties.
 * 6. **Shared six-slot budget** — every granted power-up row consumes a slot, so
 *    the weapon budget is `POWER_UP_SLOT_CAP - grantedPowerUps` and the
 *    suggestion can never present more counted kinds than the run can hold.
 *
 * ## One rule, no second copy
 *
 * Ownership comes from the pure economy (`ownsEntry`), matchup verdicts from
 * `resolveBossMatchup`, permanent levels from `hangarPermanentLevels` /
 * `currentUpgradeLevel`, the cap and its trimming from
 * `POWER_UP_SLOT_CAP` / `capDropIdsToSlotPool`, and behaviour families from the
 * shipped `WEAPON_CATALOGUE`. This module restates none of them.
 *
 * ## Where it runs (AH-0MWOWEYZQ006IR9T)
 *
 * The hangar screen **auto-fits** this suggestion when it opens on an empty
 * loadout (`isDefaultHangarLoadout` — the raw `activeLoadout.startingWeapons`
 * list, never a matchup verdict) and offers one explicit
 * `⚡ APPLY SUGGESTED BUILDOUT` row that applies it on demand for any loadout.
 * The game's `HangarScene` and the read-only `GymHangar` parity scene consume
 * the same suggestion through the shared screen model, so neither owns a
 * second selection rule.
 *
 * ## Pure, total, deterministic
 *
 * No Phaser, scene or DOM import, no mutation, no throwing, no wall-clock and
 * no unseeded randomness. The suggestion is a **full replacement** derived only
 * from ownership, levels and the target (never from the current
 * `activeLoadout`), so re-applying it is idempotent and the owning-set order
 * never changes the result.
 *
 * @module src/core/hangarWar/hangarAutoLoadout
 */

import { POWER_UP_SLOT_CAP } from '../constants';
import {
  HANGAR_CATALOGUE,
  type HangarEntry,
  type StartingWeaponDefinition,
} from '../../data/hangarCatalogue';
import { POWER_UP_CATALOGUE, type PowerUpId } from '../../powerups/types';
import { capDropIdsToSlotPool } from '../../powerups/slots';
import { WEAPON_CATALOGUE, type WeaponId } from '../../utils/weapons';
import {
  UPGRADE_STAT_BUCKETS,
  currentUpgradeLevel,
  hangarPermanentLevels,
  ownedLevelBearingPowerUpLevels,
  ownsEntry,
  type PermanentUpgradeLevels,
} from './hangarEconomy';
import {
  resolveBossMatchup,
  type BossMatchup,
  type MatchupDefinition,
} from './weaponMatchup';
import type { HangarState, HangarWarPayload } from './types';

/**
 * A weapon's behaviour family — the variety cap's key, derived from the
 * shipped {@link WeaponDefinition} descriptors rather than a second table.
 */
export type WeaponBehaviourFamily =
  | 'spread'
  | 'beam'
  | 'bounce'
  | 'split'
  | 'orbit'
  | 'aoe'
  | 'plain';

/** Why a pick is in the suggestion (the documented preference order). */
export type AutoLoadoutReason =
  | 'strong'
  | 'defensive-power-up'
  | 'highest-level'
  | 'granted';

/** One preference-ordered suggestion row (a weapon or an auto-granted power-up). */
export interface AutoLoadoutPick {
  /** Whether the row is an equipped weapon or an auto-granted power-up. */
  readonly kind: 'weapon' | 'power-up';
  /** Catalogue entry id for a weapon; power-up id for a granted row. */
  readonly id: string;
  /** Behaviour family (weapons only; `null` for power-ups). */
  readonly family: WeaponBehaviourFamily | null;
  /** Boss matchup verdict (weapons only; `null` for power-ups). */
  readonly matchup: BossMatchup | null;
  /** Permanent level (`1` when never upgraded). */
  readonly level: number;
  /** True for a granted power-up in the shipped `armour` bucket. */
  readonly defensive: boolean;
  /** Which preference step produced the row. */
  readonly reason: AutoLoadoutReason;
}

/** The shared six-slot budget the suggestion agrees with. */
export interface AutoLoadoutSlots {
  /** `POWER_UP_SLOT_CAP`. */
  readonly cap: number;
  /** Granted power-up rows. */
  readonly powerUps: number;
  /** Remaining weapon budget (`cap - powerUps`, never negative). */
  readonly weapons: number;
  /** `startingWeapons.length + powerUps`, never above `cap`. */
  readonly used: number;
}

/** The selector's plain-data suggestion. */
export interface AutoLoadoutSuggestion {
  /** Catalogue entry ids to equip (in `picks` order, no duplicates). */
  readonly startingWeapons: readonly string[];
  /** The auto-granted power-up rows (the deployment's grant list). */
  readonly grantedPowerUps: readonly AutoLoadoutPick[];
  /** The shared-slot accounting. */
  readonly slots: AutoLoadoutSlots;
  /** The preference-ordered suggestion (weapons and granted power-ups). */
  readonly picks: readonly AutoLoadoutPick[];
}

/**
 * The behaviour family of a shipped weapon, read from its
 * {@link WeaponDefinition} descriptors.
 *
 * Precedence: `aoe` → `orbit` → `splits` → `bounce` → `hitscan` → two or more
 * **distinct** offset angles (a fan) → `plain`. Distinct *angles* is the key:
 * the Dual carries two offsets at the same angle (a side-by-side pair, split by
 * `sideOffsets`), so it is `plain`, while the Broadside's two angled shots are
 * a `spread`. An unknown id is `plain` (the helper is total).
 *
 * @param weaponId — a shipped weapon id.
 * @returns its behaviour family.
 */
export function weaponBehaviourFamily(
  weaponId: WeaponId,
): WeaponBehaviourFamily {
  const def = WEAPON_CATALOGUE[weaponId];
  if (def === undefined) return 'plain';
  if (def.aoe !== undefined) return 'aoe';
  if (def.orbit !== undefined) return 'orbit';
  if (def.splits !== undefined) return 'split';
  if (def.bounce !== undefined) return 'bounce';
  if (def.hitscan !== undefined) return 'beam';
  if (new Set(def.offsets).size >= 2) return 'spread';
  return 'plain';
}

/** An owned, non-weak weapon plus the facts the selector needs about it. */
interface OwnedWeapon {
  /** The catalogue entry (its id is what the suggestion writes). */
  readonly entry: StartingWeaponDefinition;
  /** Its behaviour family (the variety key). */
  readonly family: WeaponBehaviourFamily;
  /** Its boss matchup verdict (`strong` or `neutral`). */
  readonly matchup: BossMatchup;
  /** Its permanent weapon level (base `1` when never upgraded). */
  readonly level: number;
  /** Its position in the catalogue (the deterministic tie-break). */
  readonly order: number;
}

/**
 * The owned, catalogue-known, non-weak weapons in catalogue order.
 *
 * Weak weapons are dropped here, so no later step can re-admit one. The order
 * is the catalogue's, making the result independent of the owned-set order.
 */
function collectOwnedWeapons(
  hangar: HangarState,
  catalogue: readonly HangarEntry[],
  target: MatchupDefinition | null | undefined,
  levels: PermanentUpgradeLevels,
): OwnedWeapon[] {
  const owned: OwnedWeapon[] = [];
  catalogue.forEach((entry, order) => {
    if (entry.kind !== 'weapon') return;
    if (!ownsEntry(hangar, entry)) return;
    const matchup = resolveBossMatchup(entry.weaponId, target);
    if (matchup === 'weak') return;
    owned.push({
      entry,
      family: weaponBehaviourFamily(entry.weaponId),
      matchup,
      level: currentUpgradeLevel(levels, entry.weaponId),
      order,
    });
  });
  return owned;
}

/** The catalogue position of every power-up, for a deterministic tie-break. */
function powerUpCatalogueOrder(): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  (Object.keys(POWER_UP_CATALOGUE) as PowerUpId[]).forEach((id, index) => {
    order.set(id, index);
  });
  return order;
}

/**
 * The granted power-up rows as suggestion rows, defensives first.
 *
 * The rows are exactly the fleet's **installable** power-ups — the same union
 * `buildHangarDeployment` grants when the selection is absent
 * ({@link ownedLevelBearingPowerUpLevels}), so the budget mirrors the grant.
 * Ordering is defensive-first, then descending permanent level, then catalogue
 * order — deterministic and independent of the stored row order.
 */
function buildPowerUpPicks(hangar: HangarState): AutoLoadoutPick[] {
  const order = powerUpCatalogueOrder();
  const ranked = ownedLevelBearingPowerUpLevels(hangar).map((row) => ({
    row,
    defensive: UPGRADE_STAT_BUCKETS[row.id] === 'armour',
    order: order.get(row.id) ?? Number.MAX_SAFE_INTEGER,
  }));
  ranked.sort(
    (a, b) =>
      Number(b.defensive) - Number(a.defensive) ||
      b.row.level - a.row.level ||
      a.order - b.order,
  );
  return ranked.map(({ row, defensive }) => ({
    kind: 'power-up',
    id: row.id,
    family: null,
    matchup: null,
    level: row.level,
    defensive,
    reason: defensive ? 'defensive-power-up' : 'granted',
  }));
}

/** A weapon pick row carrying its preference reason. */
function toWeaponPick(
  weapon: OwnedWeapon,
  reason: AutoLoadoutReason,
): AutoLoadoutPick {
  return {
    kind: 'weapon',
    id: weapon.entry.id,
    family: weapon.family,
    matchup: weapon.matchup,
    level: weapon.level,
    defensive: false,
    reason,
  };
}

/**
 * The boss-aware auto-loadout suggestion for one payload and target hex.
 *
 * Pure and total: reads only ownership, permanent levels and the target, never
 * mutates its inputs and never throws (a missing target is treated as neutral
 * by `resolveBossMatchup`). The result is a **full replacement** for
 * `activeLoadout.startingWeapons`, so re-applying it cannot duplicate or
 * oscillate entries.
 *
 * @param payload — the persistent war payload (read only; `activeLoadout` is
 *   deliberately ignored so the suggestion is a stable fixed point).
 * @param target — the target hex's authored strengths/weaknesses, or
 *   `null`/`undefined` for an unauthored/unknown hex (every weapon is neutral).
 * @param catalogue — the unlock tree to resolve ownership against (defaults to
 *   the shipped catalogue).
 * @returns the preference-ordered suggestion plus its shared-slot accounting.
 */
export function selectAutoLoadout(
  payload: HangarWarPayload,
  target: MatchupDefinition | null | undefined,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): AutoLoadoutSuggestion {
  const hangar = payload.hangar;
  const levels = hangarPermanentLevels(hangar);

  // The power-up grants the deployment will make; the shared slot rule trims
  // them so the suggestion can never reserve more than the pool holds.
  const orderedPowerUps = buildPowerUpPicks(hangar);
  const admitted = new Set<string>(
    capDropIdsToSlotPool(orderedPowerUps.map((pick) => pick.id as PowerUpId)),
  );
  const grantedPowerUps = orderedPowerUps.filter((pick) =>
    admitted.has(pick.id),
  );
  const powerUps = grantedPowerUps.length;
  const weaponBudget = Math.max(0, POWER_UP_SLOT_CAP - powerUps);

  const owned = collectOwnedWeapons(hangar, catalogue, target, levels);
  const usedFamilies = new Set<WeaponBehaviourFamily>();
  const strongPicks: AutoLoadoutPick[] = [];
  const fillPicks: AutoLoadoutPick[] = [];
  let weaponCount = 0;

  // Strong first, catalogue order, at most one weapon per family.
  for (const weapon of owned) {
    if (weaponCount >= weaponBudget) break;
    if (weapon.matchup !== 'strong') continue;
    if (usedFamilies.has(weapon.family)) continue;
    usedFamilies.add(weapon.family);
    strongPicks.push(toWeaponPick(weapon, 'strong'));
    weaponCount += 1;
  }

  // Then the neutral fill by descending permanent level, catalogue order ties.
  const fillCandidates = owned
    .filter((weapon) => weapon.matchup !== 'strong')
    .sort((a, b) => b.level - a.level || a.order - b.order);
  for (const weapon of fillCandidates) {
    if (weaponCount >= weaponBudget) break;
    if (usedFamilies.has(weapon.family)) continue;
    usedFamilies.add(weapon.family);
    fillPicks.push(toWeaponPick(weapon, 'highest-level'));
    weaponCount += 1;
  }

  const defensivePicks = grantedPowerUps.filter((pick) => pick.defensive);
  const otherPowerUps = grantedPowerUps.filter((pick) => !pick.defensive);
  const picks: AutoLoadoutPick[] = [
    ...strongPicks,
    ...defensivePicks,
    ...fillPicks,
    ...otherPowerUps,
  ];
  const startingWeapons = [...strongPicks, ...fillPicks].map(
    (pick) => pick.id,
  );

  return {
    startingWeapons,
    grantedPowerUps,
    slots: {
      cap: POWER_UP_SLOT_CAP,
      powerUps,
      weapons: weaponBudget,
      used: startingWeapons.length + powerUps,
    },
    picks,
  };
}

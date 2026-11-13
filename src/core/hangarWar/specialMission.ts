/**
 * Special-mission reward resolution (AH-0MWF0CX0H004OJ2Y, post-MVP Hangar War
 * AH-0MVWZYIWX0008C55).
 *
 * A **special-mission hex** is authored ring data (`isSpecialMission` on
 * `./hexRing`'s {@link HexRingDefinition}) whose deployment is the ordinary
 * one-level capture (producer answer Q1 = a) and whose only special thing is
 * the **reward** it pays on capture (Q2 = a): a hull with extra hit points,
 * granted into `unlockedHulls` through the shipped `resolveHexGrant` path.
 *
 * The reward derivation lives here once, as a pure function of authored data
 * plus the hangar catalogue, because two surfaces must agree on it:
 *
 * - the **capture path** (`./captureCycle`) reports the reward a victory paid,
 *   and
 * - the **known-ahead intel** (`./hexIntel`) publishes the same reward *before*
 *   the player commits a life, so a special mission is never a blind box.
 *
 * Neither surface re-derives the reward, so the map can never advertise a
 * different hull from the one the capture grants (the known-ahead rule).
 *
 * @module src/core/hangarWar/specialMission
 */

import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HangarEntry,
  type HullDefinition,
} from '../../data/hangarCatalogue';
import { findHangarEntry } from './hangarEconomy';
import type { HexRingDefinition } from './hexRing';

/**
 * The special reward a special-mission hex pays, resolved from authored data.
 *
 * Every number a caller needs to render the offer is carried, so the intel
 * panel and the capture report never look up the catalogue themselves.
 */
export interface SpecialMissionReward {
  /** The authored special-mission hex this reward belongs to. */
  readonly hexId: string;
  /** The boss that holds the hex (the mission's identity). */
  readonly boss: string;
  /** Catalogue id of the granted hull (the id land in `unlockedHulls`). */
  readonly hullId: string;
  /** The granted hull's catalogue entry (name/description for display). */
  readonly hull: HullDefinition;
  /** Lives the granted hull deploys with. */
  readonly startingLives: number;
  /** The granted hull's base defence rating (before hangar upgrades). */
  readonly baseDefence: number;
  /**
   * Extra starting lives over the starter hull — the "extra hit points" that
   * make the reward special. Never negative (a hull that is *not* tougher
   * than the starter hull reports `0`, so a display can never advertise a
   * penalty as a reward).
   */
  readonly bonusStartingLives: number;
}

/**
 * Whether an authored definition is a special-mission hex.
 *
 * Total: a missing/invalid definition is an ordinary hex (`false`), matching
 * the field's backward-compatible default on {@link HexRingDefinition}.
 *
 * @param definition — a ring definition (or nothing).
 * @returns `true` only when the hex is authored as a special mission.
 */
export function isSpecialMissionHex(
  definition: HexRingDefinition | null | undefined,
): boolean {
  return definition?.isSpecialMission === true;
}

/**
 * Resolves the reward a special-mission hex pays.
 *
 * Resolution is a straight read of authored data plus the catalogue: the
 * hex's `grants` id **is** the reward, so what the map publishes and what the
 * capture grants cannot drift. The ring validator already rejects a special
 * mission whose grant is not a hull catalogue entry
 * (`validateRingDefinitions`), so the `null` paths here only fire for
 * hand-built/harness definitions — never for validated authored data.
 *
 * @param definition — the authored ring definition (or nothing).
 * @param catalogue — the hangar tree to resolve against (defaults to shipped).
 * @returns the reward, or `null` for an ordinary hex or an unresolvable grant.
 */
export function specialMissionRewardFor(
  definition: HexRingDefinition | null | undefined,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): SpecialMissionReward | null {
  if (!isSpecialMissionHex(definition) || !definition) return null;

  const entry = findHangarEntry(definition.grants, catalogue);
  if (entry === null || entry.kind !== 'hull') return null;

  const starter = findHangarEntry(STARTER_HULL_ID, catalogue);
  const baselineLives =
    starter !== null && starter.kind === 'hull'
      ? starter.runStats.startingLives
      : entry.runStats.startingLives;

  return {
    hexId: definition.id,
    boss: definition.boss,
    hullId: entry.id,
    hull: entry,
    startingLives: entry.runStats.startingLives,
    baseDefence: entry.baseDefence,
    bonusStartingLives: Math.max(
      0,
      entry.runStats.startingLives - baselineLives,
    ),
  };
}

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
 * ## The rotating offer (AH-0MWF0CVNH005CG9T)
 *
 * The special mission the ring presents **rotates between sorties** (producer
 * answer Q3 = b). {@link specialMissionOfferFor} is that seam: a pure
 * composition of the persisted payload (`seed` + the sortie counter the
 * between-sortie tick already advances) and the authored ring data into the
 * shared seeded resolver in `./rng` (`resolveSpecialOffer`). No scene draws
 * random numbers, nothing extra is persisted, and the same payload seed always
 * replays the same rotation — while the map and the capture read one answer.
 *
 * @module src/core/hangarWar/specialMission
 */

import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HangarEntry,
  type HullDefinition,
} from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { findHangarEntry } from './hangarEconomy';
import type { HexRingDefinition } from './hexRing';
import { resolveSpecialOffer, type SpecialOfferHex } from './rng';
import type { HangarWarPayload } from './types';

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

/**
 * The ring hex the rotation reads: authored special-mission marker plus the
 * persisted ownership the offer has to respect.
 *
 * Structural (it extends {@link SpecialOfferHex}), so the ring's authored data
 * and its stored state compose into one view without a translation layer.
 */
export interface SpecialMissionHexView extends SpecialOfferHex {
  /** The authored definition the hex was composed from. */
  readonly definition: HexRingDefinition;
}

/**
 * The special mission the ring is offering on the **current** sortie.
 *
 * Everything a known-ahead surface needs: which hex is offered, which reward it
 * pays, and the sortie the rotation is positioned at (so a caller can label the
 * offer without re-deriving the counter).
 */
export interface SpecialMissionOffer {
  /** The persisted sortie counter the offer was resolved at. */
  readonly sortie: number;
  /** The offered hex's id. */
  readonly hexId: string;
  /** The offered hex's index in the composed ring view. */
  readonly index: number;
  /** The reward the offered hex pays (the reward and offer can never drift). */
  readonly reward: SpecialMissionReward;
}

/**
 * The war's sortie counter: the payload's frontier tick position.
 *
 * The between-sortie tick already advances `frontierTick` once per sortie
 * boundary (`runFrontierTick`), so the rotation needs **no new stored state**
 * — the same field that moves the frontier forward also moves the offer. A
 * save written before the tick landed has no field, which reads as sortie `0`.
 *
 * @param payload — the persisted war payload.
 * @returns the sortie index (`0` for a fresh war).
 */
export function sortieIndexFor(payload: HangarWarPayload): number {
  const tick = payload.frontierTick;
  if (typeof tick !== 'number' || !Number.isFinite(tick)) return 0;
  return Math.max(0, Math.trunc(tick));
}

/**
 * Composes the ring's hexes into the view the rotation resolves over.
 *
 * The authored definitions supply `isSpecialMission` (the kind of hex) and the
 * persisted ring supplies `held` (an offer is never repeated once captured), so
 * the composed view is exactly "the ring as authored, as stored". Hexes without
 * an authored definition are skipped rather than invented.
 *
 * @param payload — the persisted war payload.
 * @param definitions — authored ring definitions (defaults to the shipped table).
 * @returns the ring's hexes in generated order.
 */
export function specialMissionRingView(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS,
): SpecialMissionHexView[] {
  // Driven by the stored ring, never by the authored table alone: a definition
  // the war does not carry cannot be deployed at, so it cannot be offered.
  const views: SpecialMissionHexView[] = [];
  for (const state of payload.ring.hexes) {
    const definition =
      definitions.find((entry) => entry.id === state.id) ?? null;
    if (definition === null) continue;
    views.push({
      id: state.id,
      isSpecialMission: definition.isSpecialMission === true,
      held: state.held === true,
      definition,
    });
  }
  return views;
}

/**
 * Resolves the special mission the ring offers on the current sortie.
 *
 * Pure and total: a war with no special hex, or one whose every special hex is
 * already held, offers nothing (`null`) rather than falling back to an ordinary
 * hex. The rotation itself is the shared seeded resolver
 * (`resolveSpecialOffer`), so the same payload seed replays the same sequence
 * and no scene introduces randomness of its own.
 *
 * @param payload — the persisted war payload.
 * @param definitions — authored ring definitions (defaults to the shipped table).
 * @param catalogue — hangar tree the reward resolves against (defaults to shipped).
 * @returns the current offer, with its reward, or `null` when none is left.
 */
export function specialMissionOfferFor(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): SpecialMissionOffer | null {
  const sortie = sortieIndexFor(payload);
  const ring = specialMissionRingView(payload, definitions);
  const offer = resolveSpecialOffer(payload.seed, sortie, ring);
  if (offer === null) return null;

  const reward = specialMissionRewardFor(offer.hex.definition, catalogue);
  if (reward === null) return null;

  return { sortie, hexId: offer.hex.id, index: offer.index, reward };
}

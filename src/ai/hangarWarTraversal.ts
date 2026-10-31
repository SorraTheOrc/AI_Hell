/**
 * Attract-mode traversal decisions for the Hangar War surface
 * (AH-0MVUXCBBK004EJIP, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § *Gym
 * testability and the bot* — "**Attract mode:** the bot traverses or skips
 * every new screen — on the map it auto-picks the **weakest** adjacent hex, in
 * the hangar it auto-buys the cheapest useful unlock (seeded), and it
 * auto-advances the defence report. Because defence is **resolved
 * algorithmically**, there is no live defence battle for the demo to stall in —
 * the defending bot never needs to be flown."
 *
 * ## Pure decisions, no scene, no timer
 *
 * Every function here answers exactly one question — *what does the bot do on
 * this screen?* — from the stored payload and the authored definitions. There
 * is **no `Phaser`, no `localStorage`, no timer and no state**: the scenes own
 * the dwell that applies a decision, this module owns the decision. That is
 * what makes the traversal testable without a browser boot and what keeps the
 * bot's rules out of the screens (AGENTS.md gym↔game parity).
 *
 * ## Never "wait"
 *
 * Every decision is total and always names an action. There is no `wait`,
 * `idle` or `no-op` outcome, so a screen driven by this module cannot stall:
 *
 * | Screen | Decision |
 * |---|---|
 * | `menu` | open the map (the surface's hub) |
 * | `map` | deploy at the **weakest adjacent unheld hex**, or open the hangar when the ring is secured |
 * | `deployment` | none — the run drives itself to its end (the bot flies it) |
 * | `defenceReport` | continue to the map |
 * | `hangar` | buy the **cheapest useful unlock** (seeded tie-break), or deploy the active loadout |
 *
 * The map's choice is `pickAttractHex` (`src/core/hangarWar/hexIntel.ts`) — the
 * same weakest-adjacent rule the map screen itself focuses — so the bot and the
 * player's default focus can never disagree. On alternate between-sortie visits
 * it shops first (see {@link decideMapAction}), so a full attract cycle also
 * demonstrates the hangar.
 *
 * ## Seeded, not random
 *
 * The hangar's shopping list can hold several equally cheap unlocks. Rather
 * than always taking the first in catalogue order, the bot picks inside the
 * cheapest price tier from the war's stored seed, so two replays of the same
 * payload make the same choices and two different wars shop differently. When
 * the tier holds one entry the seeded pick is that entry — identical to the
 * unseeded "cheapest" rule.
 *
 * ## No defence battle, by construction
 *
 * Nothing in this module can start a battle: the defence is resolved by the
 * frontier tick (`src/core/hangarWar/hexDefence.ts`) before the report renders,
 * and the report's only action is `continueToMap`. A traversal therefore walks
 * `menu → map → deployment → defenceReport → map → hangar` with no screen that
 * could wait on a flown defender.
 *
 * @module src/ai/hangarWarTraversal
 */

import {
  canBuy,
  purchaseWeight,
  resolveActiveHull,
  resolveActiveLoadout,
} from '../core/hangarWar/hangarEconomy';
import { pickAttractHex } from '../core/hangarWar/hexIntel';
import type { HexRingDefinition } from '../core/hangarWar/hexRing';
import { createHangarWarRng } from '../core/hangarWar/rng';
import type { HangarLoadout, HangarWarPayload } from '../core/hangarWar/types';
import { HANGAR_CATALOGUE, type HangarEntry } from '../data/hangarCatalogue';

/**
 * How long the demo leaves a Hangar War screen up before applying the bot's
 * decision.
 *
 * Short enough that a whole traversal fits a demo cycle, long enough that a
 * watcher can read the screen. Scenes schedule it with `time.delayedCall`, so a
 * test advances the clock instead of waiting in real time.
 */
export const HANGAR_WAR_TRAVERSAL_DWELL_MS = 700;

/**
 * Upper bound on the demo actions one scene performs before it stops driving
 * itself.
 *
 * A pure safety bound, not a game rule: every decision is total, so a scene
 * reaches its next screen long before this, but a bug (or a refused purchase
 * that somehow repeats) can never spin the demo forever.
 */
export const HANGAR_WAR_TRAVERSAL_MAX_ACTIONS = 64;

/** The screens the traversal knows how to leave. */
export type HangarWarTraversalScreen =
  | 'menu'
  | 'map'
  | 'deployment'
  | 'defenceReport'
  | 'hangar';

/** What the bot does on the current screen. */
export type HangarWarTraversalAction =
  /** Leave the menu for the hex map (the surface's hub). */
  | { readonly kind: 'openMap' }
  /** Deploy at `hexId` (the weakest adjacent unheld hex), or `null` when none. */
  | { readonly kind: 'deploy'; readonly hexId: string | null }
  /** Open the hangar (the map is secured, so there is no hex left to attack). */
  | { readonly kind: 'openHangar' }
  /** Leave the defence report for the map. */
  | { readonly kind: 'continueToMap' }
  /** Buy the cheapest useful unlock (`entryId`). */
  | { readonly kind: 'buy'; readonly entryId: string }
  /** Accept the active hull/loadout and deploy. */
  | {
      readonly kind: 'deployFromHangar';
      readonly hullId: string;
      readonly loadout: HangarLoadout;
    };

/** Optional overrides for the decisions (tests, fixtures, captures). */
export interface HangarWarTraversalOptions {
  /** Authored ring definitions (defaults to the shipped table). */
  readonly definitions?: readonly HexRingDefinition[];
  /** Unlock tree to shop in (defaults to the shipped catalogue). */
  readonly catalogue?: readonly HangarEntry[];
  /** Seed override for the seeded tie-break (defaults to the payload's seed). */
  readonly seed?: number;
}

/**
 * The seeded stream the hangar's tie-break draws from.
 *
 * Mixed with the ring index so ring 1 and ring 2 of the same war do not shop in
 * lockstep, and normalised by the shared seeded helper.
 */
function shoppingSeed(payload: HangarWarPayload, seed?: number): number {
  const base = seed ?? payload.seed;
  return (base ^ Math.imul(payload.ring.ringIndex, 0x9e37_79b9)) >>> 0;
}

/** Sorted by id, so a reordered catalogue replays identically. */
function byId(a: HangarEntry, b: HangarEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The cheapest useful unlock, with a **seeded** pick inside the cheapest tier.
 *
 * "Useful" is the economy's own rule (`canBuy`: not owned, ring-unlocked and
 * affordable); "cheapest" is its own price weight (`purchaseWeight`, cores
 * converted at the economy's rate). The seed only breaks ties between entries
 * of equal weight, so the bot's shopping is the cheapest-unlock rule the design
 * names, made deterministic per war rather than per catalogue order.
 *
 * @param payload — the war payload (never mutated).
 * @param options — catalogue and seed overrides.
 * @returns the entry to buy, or `null` when nothing is buyable.
 */
export function cheapestSeededUnlock(
  payload: HangarWarPayload,
  options: HangarWarTraversalOptions = {},
): HangarEntry | null {
  const catalogue = options.catalogue ?? HANGAR_CATALOGUE;
  const context = { ringIndex: payload.ring.ringIndex };

  let cheapestWeight = Number.POSITIVE_INFINITY;
  const tier: HangarEntry[] = [];
  for (const entry of catalogue) {
    if (!canBuy(payload.hangar, entry, context).ok) continue;
    const weight = purchaseWeight(entry.price);
    if (weight < cheapestWeight) {
      cheapestWeight = weight;
      tier.length = 0;
      tier.push(entry);
    } else if (weight === cheapestWeight) {
      tier.push(entry);
    }
  }

  if (tier.length === 0) return null;
  if (tier.length === 1) return tier[0];
  const rng = createHangarWarRng(shoppingSeed(payload, options.seed));
  return rng.pick([...tier].sort(byId)) ?? tier[0];
}

/**
 * The bot's move on the **menu**: open the hex map.
 *
 * The map is the surface's hub (it reaches the hangar in one click), so the
 * traversal enters there. Total and argument-free: the menu has nothing to
 * decide.
 *
 * @returns the action to apply.
 */
export function decideMenuAction(): HangarWarTraversalAction {
  return { kind: 'openMap' };
}

/**
 * The bot's move on the **map**: attack the weakest adjacent unheld hex, or
 * shop first on alternate between-sortie visits.
 *
 * Two rules, both pure:
 *
 * 1. **Shopping cadence.** After an odd number of frontier ticks (i.e. on the
 *    map visit that follows every other defence report) the bot opens the
 *    hangar before deploying, so a full attract cycle demonstrates the hangar
 *    as well as the deployment. The cadence is keyed on the war's own
 *    `frontierTick` so it survives the report → map scene re-entry without any
 *    hidden demo state.
 * 2. **Weakest adjacent hex.** Otherwise it attacks `pickAttractHex` — the same
 *    rule the map's default focus uses. A secured ring has no hex left to
 *    attack, so the bot opens the hangar instead; either way the screen
 *    advances, so there is never a dead screen.
 *
 * @param payload — the war payload (never mutated).
 * @param options — ring-definition override.
 * @returns the action to apply.
 */
export function decideMapAction(
  payload: HangarWarPayload,
  options: HangarWarTraversalOptions = {},
): HangarWarTraversalAction {
  const frontierTick = Math.trunc(payload.frontierTick ?? 0);
  if (frontierTick > 0 && frontierTick % 2 === 1) {
    return { kind: 'openHangar' };
  }
  const hexId = pickAttractHex(payload, options.definitions);
  if (hexId === null) return { kind: 'openHangar' };
  return { kind: 'deploy', hexId };
}

/**
 * The bot's move on the **defence report**: continue to the map.
 *
 * The report is a pure view of a resolved tick, so there is nothing to fight
 * and nothing to wait for — the bot always advances.
 *
 * @returns the action to apply.
 */
export function decideReportAction(): HangarWarTraversalAction {
  return { kind: 'continueToMap' };
}

/**
 * The bot's move in the **hangar**: buy the cheapest useful unlock, else deploy.
 *
 * Shopping is finite (the catalogue is), so repeated application reaches the
 * deploy branch in a bounded number of steps and the demo always leaves the
 * screen.
 *
 * @param payload — the war payload (never mutated).
 * @param options — catalogue and seed overrides.
 * @returns the action to apply.
 */
export function decideHangarAction(
  payload: HangarWarPayload,
  options: HangarWarTraversalOptions = {},
): HangarWarTraversalAction {
  const entry = cheapestSeededUnlock(payload, options);
  if (entry !== null) return { kind: 'buy', entryId: entry.id };
  return {
    kind: 'deployFromHangar',
    hullId: resolveActiveHull(payload.hangar),
    loadout: resolveActiveLoadout(payload.hangar),
  };
}

/**
 * The bot's move on any traversal screen (the single dispatch point).
 *
 * A `deployment` is driven by the run itself, so it has no bot decision; it
 * reports `continueToMap` only as a safe, non-stalling fallback for a caller
 * that asks anyway (the report is where a finished deployment leads). An
 * unknown screen behaves like the menu, so a mis-wired screen can never freeze
 * the demo.
 *
 * @param screen — the screen the demo is on.
 * @param payload — the war payload (never mutated).
 * @param options — definition/catalogue/seed overrides.
 * @returns the action to apply.
 */
export function decideTraversalAction(
  screen: HangarWarTraversalScreen,
  payload: HangarWarPayload,
  options: HangarWarTraversalOptions = {},
): HangarWarTraversalAction {
  switch (screen) {
    case 'menu':
      return decideMenuAction();
    case 'map':
      return decideMapAction(payload, options);
    case 'defenceReport':
      return decideReportAction();
    case 'hangar':
      return decideHangarAction(payload, options);
    case 'deployment':
      return { kind: 'continueToMap' };
    default:
      return decideMenuAction();
  }
}

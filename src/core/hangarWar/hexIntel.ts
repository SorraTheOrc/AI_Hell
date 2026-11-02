/**
 * Hex-map intel view model — the pure "known-ahead intel" read model of the
 * ring map (AH-0MVUXCAG90086LH2, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene
 * surface ("A **hex ring map screen**: the hangar at the centre, the ring
 * around it, each hex showing held/unheld, aggression, its defending hull and
 * any pending attack") and § *Known-ahead intel and anti-checklist
 * mitigations* ("Before committing to a deployment the player can see, for
 * every hex: which **boss** holds it, what that boss is **strong and weak
 * against**, the **aggression** it is defended at, and exactly **which weapon
 * or upgrade it grants**").
 *
 * ## A pure view, never a rule
 *
 * Everything here is a **read model**: the stored payload (`HangarWarPayload`)
 * supplies ownership, aggression, defenders and queued attacks; the authored
 * ring definitions (`src/data/hexRingDefinitions.ts`) supply the geometry and
 * the boss/grant intel; the resolver (`./hexDefence`) supplies the
 * attack-strength preview. Nothing is decided, mutated or persisted here — the
 * map screen, the gym and the attract bot all read the same model, so no
 * gameplay rule can live in (or drift between) the scenes
 * (AGENTS.md gym↔game parity).
 *
 * ## Ring hexes shown
 *
 * - A payload with stored hexes renders **exactly** those hexes. A partial
 *   ring is never padded or discarded (GDD §6.6 / the store's parse policy).
 * - A payload whose ring is still empty (a fresh war, before the capture cycle
 *   generates it) renders the **generated** ring for its `ringIndex`, unheld
 *   and at its authored base aggression — so ring 2's twelve hexes render from
 *   generated hex definitions rather than a hand-placed list (epic AC2).
 * - A stored hex with no authored definition still renders its persisted state
 *   (boss/grant shown as unknown); intel is never fabricated for it.
 *
 * ## Attack preview
 *
 * A held hex with a queued attack publishes the resolver's **jitter-free**
 * numbers (`attackStrength`, `margin`, `outcome`). The frontier tick applies
 * the tuning's bounded jitter, so the preview is the legible baseline the
 * player plans against, not a promise — the defence report (B6) publishes the
 * tick's actual record.
 *
 * @module src/core/hangarWar/hexIntel
 */

import {
  createRingState,
  ringDepth,
  type AxialCoordinate,
  type HexRingDefinition,
} from './hexRing';
import { areNeighbours } from './hexRing';
import {
  DEFAULT_FRONTIER_TUNING,
  resolveDefence,
  type DefenceResolution,
} from './hexDefence';
import type {
  HangarWarPayload,
  HexDefender,
  HexState,
  PendingAttack,
} from './types';
import {
  HEX_RING_DEFINITIONS,
  findHexRingDefinition,
} from '../../data/hexRingDefinitions';

/** Title rendered by the map screen (asserted by tests). */
export const HEX_MAP_TITLE = 'HANGAR WAR — HEX MAP';

/** Row key of the "◀ HANGAR" navigation row. */
export const HEX_MAP_HANGAR_ROW_KEY = 'hangar';

/** Label of the "◀ HANGAR" navigation row (the screen's one-click hangar). */
export const HEX_MAP_HANGAR_LABEL = '◀ HANGAR — buy hulls, weapons, modifiers';

/** Prefix of a hex row key (`hex:<id>`). */
export const HEX_MAP_HEX_ROW_PREFIX = 'hex:';

/** A queued attack against a hex, as the map publishes it. */
export interface HexPendingAttackIntel {
  /** Summed force of every attack queued against this hex. */
  readonly force: number;
  /**
   * The resolver's jitter-free preview of the defence, or `null` when the hex
   * is not held by a defender (there is nothing to resolve yet).
   */
  readonly resolution: DefenceResolution | null;
}

/** One hex, with all the known-ahead intel the map publishes. */
export interface HexIntel {
  /** Row key (`hex:<id>`), unique within the map. */
  readonly key: string;
  /** Stable hex id. */
  readonly id: string;
  /** Axial coordinate `q`. */
  readonly q: number;
  /** Axial coordinate `r`. */
  readonly r: number;
  /** Ring the hex belongs to. */
  readonly ringIndex: number;
  /** Whether the player currently holds the hex. */
  readonly held: boolean;
  /** Frontier aggression the hex is defended at. */
  readonly aggression: number;
  /** The boss that holds the hex, or `null` when no definition is authored. */
  readonly boss: string | null;
  /** What the boss is strong against (empty when unknown). */
  readonly strengths: readonly string[];
  /** What the boss is weak against (empty when unknown). */
  readonly weaknesses: readonly string[];
  /** Weapon/upgrade the hex grants once its boss is beaten, or `null`. */
  readonly grants: string | null;
  /** True for the single hex that grants the ring's new weapon. */
  readonly weaponHex: boolean;
  /** Whether the hex's boss has already been beaten. */
  readonly bossDefeated: boolean;
  /** The weapon already granted by this hex, or `null`. */
  readonly grantedWeapon: string | null;
  /** The bot defending the hex, or `null` when unheld/undefended. */
  readonly defender: HexDefender | null;
  /** The queued attack against the hex, or `null` when none. */
  readonly pendingAttack: HexPendingAttackIntel | null;
  /**
   * True when the hex can be selected for deployment. An unheld hex can be
   * attacked; a held hex is already the player's, so the map presents it but
   * does not deploy at it.
   */
  readonly actionable: boolean;
  /** The tile's rendered text (every intel line, newline separated). */
  readonly label: string;
}

/** One focusable row of the map (the hangar action). */
export interface HexMapActionRow {
  /** Row key (`hangar`). */
  readonly key: string;
  /** Rendered text. */
  readonly label: string;
  /** Always true: the hangar is always one click away. */
  readonly actionable: boolean;
}

/** The complete rendered state of the hex map (pure data). */
export interface HexMapModel {
  /** Screen title. */
  readonly title: string;
  /** Ring index shown (1 = the first ring). */
  readonly ringIndex: number;
  /** Ring progress line (`RING 1 — 2/6 HEXES HELD`). */
  readonly ringLine: string;
  /** Hangar summary line (`HANGAR · hull-1 · 240 min · 3 cores`). */
  readonly hangarLine: string;
  /** The hangar navigation row. */
  readonly hangarRow: HexMapActionRow;
  /** Every hex, in generated (clockwise) order, then any stored extras. */
  readonly hexes: readonly HexIntel[];
  /** Number of hexes currently held. */
  readonly heldCount: number;
  /** True when every rendered hex is held (the ring's secured state). */
  readonly secured: boolean;
  /**
   * Keys of the rows that can be activated, in reading order — every
   * deployable (unheld) hex clockwise, then the hangar.
   */
  readonly focusOrder: readonly string[];
  /** The row focused by default (the attract bot's hex, or the hangar). */
  readonly defaultFocusKey: string | null;
  /** The attract bot's weakest-adjacent unheld hex, or `null` when secured. */
  readonly attractHexId: string | null;
}

/** Options for {@link buildHexMapModel}. */
export interface BuildHexMapOptions {
  /** Authored ring definitions (defaults to the shipped table). */
  readonly definitions?: readonly HexRingDefinition[];
  /** Screen title override (tests/captures). */
  readonly title?: string;
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** A finite, positive ring index, or the first ring for anything unusable. */
function toRingIndex(value: unknown): number {
  const index = toCount(value);
  return index >= 1 ? index : 1;
}

/** A detached copy of a stored hex, so rendering can never mutate a caller. */
function cloneHex(hex: HexState): HexState {
  return {
    ...hex,
    defender: hex.defender ? { ...hex.defender } : null,
  };
}

/**
 * The hexes the map draws: exactly the stored ring when it has any hexes,
 * otherwise the ring generated from definitions for the payload's ring index
 * (a fresh war's not-yet-generated ring). Never pads a partial stored ring.
 */
function displayHexStates(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[],
): HexState[] {
  if (payload.ring.hexes.length > 0) {
    return payload.ring.hexes.map(cloneHex);
  }
  try {
    return createRingState(toRingIndex(payload.ring.ringIndex), definitions).hexes;
  } catch {
    // An unauthored ring (e.g. ring 3 before its data lands) has nothing to
    // show; the map renders the hangar alone rather than inventing hexes.
    return [];
  }
}

/** Summed queued force per attacked hex id. */
function pendingForces(
  attacks: readonly PendingAttack[],
): Map<string, number> {
  const forces = new Map<string, number>();
  for (const attack of attacks) {
    if (typeof attack?.hexId !== 'string' || attack.hexId === '') continue;
    const force = toCount(attack.force);
    forces.set(attack.hexId, (forces.get(attack.hexId) ?? 0) + force);
  }
  return forces;
}

/**
 * The resolver's jitter-free preview of a queued attack.
 *
 * `jitterPercent: 0` makes the resolver a plain comparison, so the published
 * numbers are exactly reproducible; the tick still applies its bounded jitter.
 */
function previewDefence(
  defender: HexDefender,
  force: number,
  aggression: number,
): DefenceResolution {
  return resolveDefence(
    {
      defenderRating: defender.defenceRating,
      attackingForce: force,
      aggression,
      seed: 0,
    },
    { ...DEFAULT_FRONTIER_TUNING, jitterPercent: 0 },
  );
}

/** The tile text: id, state/aggression/attack, boss, strengths, weaknesses, grant. */
function hexLabel(
  state: HexState,
  definition: HexRingDefinition | undefined,
  pending: HexPendingAttackIntel | null,
  defender: HexDefender | null,
): string {
  const lines: string[] = [
    state.id,
    `${state.held ? 'HELD' : 'UNHELD'} · AGG ${toCount(state.aggression)}${
      pending ? ` · !${pending.force}` : ''
    }`,
  ];

  if (definition) {
    lines.push(
      definition.boss,
      `S:${definition.strengths.join(',')}`,
      `W:${definition.weaknesses.join(',')}`,
      `→${definition.grants}`,
    );
  } else {
    lines.push(
      'boss unknown',
      'S:unknown',
      'W:unknown',
      `→${state.grantedWeapon ?? 'unknown'}`,
    );
  }

  if (defender) {
    lines.push(`bot ${defender.hullId} (${defender.defenceRating})`);
  }
  if (pending?.resolution) {
    lines.push(
      `atk ${pending.resolution.attackStrength} vs ${
        pending.resolution.defenderRating
      } · ${pending.resolution.outcome === 'held' ? 'HOLDS' : 'FALLS'}`,
    );
  }

  return lines.join('\n');
}

/**
 * Builds one hex's intel from its stored state, its authored definition and
 * the force queued against it.
 *
 * Pure and total: an unknown definition, a malformed defender and a queued
 * attack on an unheld hex all degrade to a readable line instead of throwing.
 *
 * @param state — the stored hex (ownership, aggression, defender).
 * @param definition — the authored definition, or `undefined` when unknown.
 * @param pendingForce — summed queued attacking force (`0` for none).
 * @returns the hex's intel view.
 */
export function buildHexIntel(
  state: HexState,
  definition: HexRingDefinition | undefined,
  pendingForce = 0,
): HexIntel {
  const held = state.held === true;
  const aggression = toCount(state.aggression);
  const defender = held && state.defender ? { ...state.defender } : null;
  const force = toCount(pendingForce);
  const pending: HexPendingAttackIntel | null =
    force > 0
      ? {
          force,
          resolution: defender
            ? previewDefence(defender, force, aggression)
            : null,
        }
      : null;

  return {
    key: `${HEX_MAP_HEX_ROW_PREFIX}${state.id}`,
    id: state.id,
    q: state.q,
    r: state.r,
    ringIndex: definition?.ringIndex ?? ringDepth(state.q, state.r),
    held,
    aggression,
    boss: definition?.boss ?? null,
    strengths: definition ? [...definition.strengths] : [],
    weaknesses: definition ? [...definition.weaknesses] : [],
    grants: definition?.grants ?? null,
    weaponHex: definition?.weaponHex === true,
    bossDefeated: state.bossDefeated === true,
    grantedWeapon: state.grantedWeapon ?? null,
    defender,
    pendingAttack: pending,
    actionable: !held,
    label: hexLabel(state, definition, pending, defender),
  };
}

/**
 * The attract bot's ring choice: the **weakest adjacent unheld hex**.
 *
 * "Adjacent" means sharing an edge with the hangar (`0,0`) or with a hex the
 * player already holds, so the bot expands from territory it owns instead of
 * teleporting across the map. Ties are settled by aggression and then by
 * sorted id, so a reordered payload replays identically.
 *
 * Total and never stalling: when no unheld hex touches held territory (e.g.
 * ring 2 before ring 1 is held) the weakest unheld hex anywhere is chosen, and
 * when every hex is held `null` is returned (the ring is secured — there is
 * nothing left to attack).
 *
 * @param payload — the war's stored payload.
 * @param definitions — authored ring definitions (defaults to the shipped table).
 * @returns the hex id to attack, or `null` when the ring is fully held.
 */
export function pickAttractHex(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS,
): string | null {
  const hexes = displayHexStates(payload, definitions);
  const unheld = hexes.filter((hex) => hex.held !== true);
  if (unheld.length === 0) return null;

  const anchors: readonly AxialCoordinate[] = [
    { q: 0, r: 0 },
    ...hexes.filter((hex) => hex.held === true),
  ];
  const adjacent = unheld.filter((hex) =>
    anchors.some((anchor) => areNeighbours(anchor, hex)),
  );
  const candidates = adjacent.length > 0 ? adjacent : unheld;

  const [weakest] = [...candidates].sort(
    (a, b) =>
      toCount(a.aggression) - toCount(b.aggression) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return weakest.id;
}

/**
 * Builds the map's read model from the stored payload and the authored ring
 * definitions.
 *
 * @param payload — the war's stored payload (never mutated).
 * @param options — definitions override and title.
 * @returns the complete map model (hexes, ring/hangar lines, focus order).
 */
export function buildHexMapModel(
  payload: HangarWarPayload,
  options: BuildHexMapOptions = {},
): HexMapModel {
  const definitions = options.definitions ?? HEX_RING_DEFINITIONS;
  const ringIndex = toRingIndex(payload.ring.ringIndex);
  const definitionById = new Map(
    definitions.map((definition) => [definition.id, definition] as const),
  );
  const forces = pendingForces(payload.pendingAttacks);
  const states = displayHexStates(payload, definitions);

  const hexes = states.map((state) =>
    buildHexIntel(
      state,
      definitionById.get(state.id) ?? findHexRingDefinition(state.id),
      forces.get(state.id) ?? 0,
    ),
  );

  const heldCount = hexes.filter((hex) => hex.held).length;
  const secured = hexes.length > 0 && heldCount === hexes.length;
  const attractHexId = pickAttractHex(payload, definitions);

  const focusOrder = [
    ...hexes.filter((hex) => hex.actionable).map((hex) => hex.key),
    HEX_MAP_HANGAR_ROW_KEY,
  ];
  const defaultFocusKey =
    attractHexId !== null
      ? `${HEX_MAP_HEX_ROW_PREFIX}${attractHexId}`
      : (focusOrder[0] ?? null);

  return {
    title: options.title ?? HEX_MAP_TITLE,
    ringIndex,
    ringLine: `RING ${ringIndex} — ${heldCount}/${hexes.length} HEXES HELD${
      secured ? ' · SECURED' : ''
    }`,
    hangarLine: `HANGAR · ${payload.hangar.activeHull} · ${toCount(
      payload.hangar.bankedMinerals,
    )} min · ${toCount(payload.hangar.bankedCores)} cores`,
    hangarRow: {
      key: HEX_MAP_HANGAR_ROW_KEY,
      label: HEX_MAP_HANGAR_LABEL,
      actionable: true,
    },
    hexes,
    heldCount,
    secured,
    focusOrder,
    defaultFocusKey,
    attractHexId,
  };
}

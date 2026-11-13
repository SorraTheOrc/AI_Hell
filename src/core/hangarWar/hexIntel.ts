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
 * ## Reveal and selection (AH-0MWDBI33V003QQ3U)
 *
 * - **Adjacency-only reveal.** A hex is `displayed` only when it shares an edge
 *   with the hangar `(0,0)` or with a held hex (`isHexDisplayed`). The hangar
 *   anchors the reveal, so ring 1 always renders and later rings appear
 *   progressively as their near neighbours are held. Hidden hexes are never
 *   drawn, focused, deployed at or attract-targeted.
 * - **Selectable vs actionable.** Every displayed hex is `selectable`
 *   (focusable — a held hex can be inspected), while only an unheld displayed
 *   hex is `actionable` (deployable).
 * - **Tile label.** `tileLabel` carries the axial coordinates `(q,r)`, the
 *   `AGG n` badge **and** an ownership discriminator glyph (filled = held,
 *   hollow = unheld) so ownership is readable without colour; the full `label`
 *   block is unchanged.
 * - **Full-ring progress.** `ringLine` counts the whole stored/generated ring
 *   (hidden hexes included), so hiding hexes never loses progress.
 * - **Grid columns.** `gridColumns` exposes the spatial arrow-navigation data
 *   over displayed hexes with the `◀ HANGAR` row folded in as a bottom row — a
 *   pure read model the renderer wires without a per-scene rule.
 *
 * ## Attack preview
 *
 * A held hex with a queued attack publishes the resolver's **jitter-free**
 * numbers (`attackStrength`, `margin`, `outcome`). The frontier tick applies
 * the tuning's bounded jitter, so the preview is the legible baseline the
 * player plans against, not a promise — the defence report (B6) publishes the
 * tick's actual record.
 *
 * ## Rolled-in defence report (`AH-0MWDC3L9I008INDP`)
 *
 * When the map is entered straight from a deployment, the launch data carries
 * the between-sortie `FrontierTickRecord`. The model then publishes, on top of
 * the hexes:
 *
 * - `arrows` — one {@link HexMapAttackArrow} per `record.attacks[]` entry, in
 *   the record's order, carrying the attacker-origin axial coordinates the
 *   record itself stores (`attackerOrigin`, never re-derived);
 * - `attackDetails` — the report model's own {@link DefenceReportRow} keyed by
 *   the attacked hex id **and** by the attacker-origin hex id, so either arrow
 *   endpoint resolves the same attack's numbers. The rows come straight from
 *   {@link buildDefenceReport}, so the map can never publish a second,
 *   drifting set of numbers (AGENTS.md gym↔game parity).
 *
 * The record is transient launch data, never persisted: a map entered without
 * one (or with a quiet/malformed one) publishes no arrows and no details
 * rather than throwing.
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
import { resolvePlayerStrength } from './hangarEconomy';
import { beatableAggressionCeiling } from './hexDifficulty';
import { buildDefenceReport, type DefenceReportRow } from './defenceReport';
import type { FrontierTickRecord } from './hexDefence';

/** Title rendered by the map screen (asserted by tests). */
export const HEX_MAP_TITLE = 'HANGAR WAR — HEX MAP';

/** Row key of the "◀ HANGAR" navigation row. */
export const HEX_MAP_HANGAR_ROW_KEY = 'hangar';

/** Label of the "◀ HANGAR" navigation row (the screen's one-click hangar). */
export const HEX_MAP_HANGAR_LABEL = '◀ HANGAR — buy hulls, weapons, modifiers';

/** Prefix of a hex row key (`hex:<id>`). */
export const HEX_MAP_HEX_ROW_PREFIX = 'hex:';

/** The hangar's axial coordinate — the reveal's primary anchor. */
export const HANGAR_AXIAL: AxialCoordinate = { q: 0, r: 0 };

/** Ownership marker on a held tile's label (readable without colour). */
export const HELD_TILE_MARKER = '\u25CF';

/** Ownership marker on an unheld tile's label (readable without colour). */
export const UNHELD_TILE_MARKER = '\u25CB';

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
   * True when the hex is revealed by the map's adjacency rule — it shares an
   * edge with the hangar `(0,0)` or with a hex the player holds. Hidden hexes
   * are never drawn, focused, deployed at or attract-targeted.
   */
  readonly displayed: boolean;
  /**
   * True when the hex can be selected/focused on the map. Every displayed hex
   * is selectable — a held hex is selectable too, so its full intel can be
   * inspected — but only an unheld hex is deployable.
   */
  readonly selectable: boolean;
  /**
   * True when the hex can be deployed at: a displayed hex the player does not
   * hold. A held hex is selectable but never actionable (activating it
   * performs no deployment).
   */
  readonly actionable: boolean;
  /**
   * The short tile label — axial coordinates `(q,r)`, the `AGG n` badge and an
   * ownership marker (filled = held, hollow = unheld) so ownership is readable
   * without colour — rendered on the hex at a readable size.
   */
  readonly tileLabel: string;
  /** The full intel block the detail panel renders (every line, newline separated). */
  readonly label: string;
}

/**
 * One attack arrow over the transient tick record: the attacker-origin hex to
 * the attacked hex, with the origin's axial coordinates copied from the record.
 *
 * A pure descriptor — the renderer turns it into pixels through the existing
 * `axialToPixel` layout, so the arrow rule lives once (`AH-0MWEXI5460080WEI`).
 */
export interface HexMapAttackArrow {
  /** Arrow key (`arrow:<hexId>`), unique within the map. */
  readonly key: string;
  /** The attacked hex (the arrow's head). */
  readonly hexId: string;
  /** The unheld neighbour the attack came from (the arrow's tail). */
  readonly attackerOriginId: string;
  /** That neighbour's axial coordinate, copied from the record. */
  readonly attackerOrigin: AxialCoordinate;
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
  /** The player strength the frontier is sized from. */
  readonly playerStrength: number;
  /** The highest aggression still beatable with the current fleet. */
  readonly beatableCeiling: number;
  /** Frontier context line (`FRONTIER · STR 2 · BEAT ≤ 2 (3 IN REACH)`). */
  readonly frontierLine: string;
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
  /**
   * Spatial grid columns for arrow navigation, left to right by screen x; each
   * column lists its displayed-hex row keys top to bottom by screen y, with
   * the `◀ HANGAR` row folded in as the bottom row of every column, so arrows
   * reach it from anywhere. Row keys only — a pure read model, no scene rule.
   */
  readonly gridColumns: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * One arrow per attack in the carried between-sortie tick record, in the
   * record's order; empty for a map entered without a record (transient
   * launch data, never persisted) or a quiet tick.
   */
  readonly arrows: readonly HexMapAttackArrow[];
  /**
   * The report model's row for every resolved attack, keyed by the attacked
   * hex id **and** by the attacker-origin hex id (both arrow endpoints). When
   * a hex is both, the attacked entry wins. Empty without a record.
   */
  readonly attackDetails: ReadonlyMap<string, DefenceReportRow>;
}

/**
 * Whether a hex is revealed by the map's adjacency rule: it shares an edge
 * with the hangar `(0,0)` or with a hex the player holds. The hangar anchors
 * the reveal, so ring 1 always renders and later rings appear progressively
 * as their near neighbours are held.
 *
 * Pure geometry over the stored ring — never a scene rule.
 *
 * @param coordinate — the hex's axial coordinates.
 * @param heldHexes — every hex the player currently holds.
 * @returns true when the hex is revealed.
 */
export function isHexDisplayed(
  coordinate: AxialCoordinate,
  heldHexes: readonly AxialCoordinate[],
): boolean {
  if (areNeighbours(HANGAR_AXIAL, coordinate)) return true;
  return heldHexes.some((held) => areNeighbours(held, coordinate));
}

/**
 * Builds the spatial grid columns over the displayed hexes, folding the
 * hangar row in as the bottom row of every column.
 *
 * Columns are ordered left to right by the hexes' screen-x band (`2q + r` for
 * the pointy-top layout) and rows within a column top to bottom by `r`; the
 * hangar key is appended as the final row of each column so arrow-down wraps
 * to it from any column. A map with nothing displayed still exposes the
 * hangar as a single-column grid, so arrows never strand.
 *
 * @param hexes — the model's intel for the full ring (displayed flags set).
 * @param hangarKey — the hangar row's key.
 * @returns the grid columns (row keys).
 */
export function buildGridColumns(
  hexes: readonly HexIntel[],
  hangarKey: string,
): ReadonlyArray<ReadonlyArray<string>> {
  const displayed = hexes.filter((hex) => hex.displayed);
  if (displayed.length === 0) return [[hangarKey]];

  const byBand = new Map<number, HexIntel[]>();
  for (const hex of displayed) {
    const band = 2 * hex.q + hex.r;
    const column = byBand.get(band) ?? [];
    column.push(hex);
    byBand.set(band, column);
  }
  return [...byBand.keys()]
    .sort((a, b) => a - b)
    .map((band) => [
      ...(byBand.get(band) ?? [])
        .sort((a, b) => a.r - b.r)
        .map((hex) => hex.key),
      hangarKey,
    ]);
}

/** Options for {@link buildHexMapModel}. */
export interface BuildHexMapOptions {
  /** Authored ring definitions (defaults to the shipped table). */
  readonly definitions?: readonly HexRingDefinition[];
  /** Screen title override (tests/captures). */
  readonly title?: string;
  /**
   * The between-sortie tick record carried from the deployment, or omitted
   * when the map is entered without one (a transient overlay, never stored).
   */
  readonly record?: FrontierTickRecord;
}

/** The attack overlay a tick record contributes to the map model. */
interface HexMapAttackOverlay {
  readonly arrows: readonly HexMapAttackArrow[];
  readonly attackDetails: ReadonlyMap<string, DefenceReportRow>;
}

/**
 * Builds the map's attack overlay from the transient tick record.
 *
 * The arrows are copied from the record's own `attackerOrigin` coordinates and
 * the details are the report model's own rows (index-aligned with
 * `record.attacks`), so no number is re-resolved here. Total: a missing,
 * empty or malformed record yields no arrows and no details.
 *
 * @param payload — the war's stored payload (never mutated).
 * @param record — the between-sortie tick record, when one was carried.
 * @returns the arrows and the per-hex details.
 */
function buildAttackOverlay(
  payload: HangarWarPayload,
  record: FrontierTickRecord | undefined,
): HexMapAttackOverlay {
  const attacks = Array.isArray(record?.attacks) ? record.attacks : [];
  if (!record || attacks.length === 0) {
    return { arrows: [], attackDetails: new Map() };
  }

  const arrows = attacks.map((attack): HexMapAttackArrow => ({
    key: `arrow:${attack.hexId}`,
    hexId: attack.hexId,
    attackerOriginId: attack.attackerOriginId,
    attackerOrigin: {
      q: attack.attackerOrigin.q,
      r: attack.attackerOrigin.r,
    },
  }));

  const rows = buildDefenceReport(payload, record).rows;
  const attackDetails = new Map<string, DefenceReportRow>();
  // Attacked endpoints first, so the attacked entry wins when a hex is both
  // endpoints of an attack (a self-referential record).
  rows.forEach((row) => attackDetails.set(row.hexId, row));
  rows.forEach((row) => {
    if (!attackDetails.has(row.attackerOriginId)) {
      attackDetails.set(row.attackerOriginId, row);
    }
  });

  return { arrows, attackDetails };
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
  displayed = true,
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
    displayed,
    selectable: displayed,
    actionable: displayed && !held,
    tileLabel: `(${state.q},${state.r}) AGG ${aggression} ${
      held ? HELD_TILE_MARKER : UNHELD_TILE_MARKER
    }`,
    label: hexLabel(state, definition, pending, defender),
  };
}

/**
 * The attract bot's ring choice: the **weakest displayed unheld hex**.
 *
 * "Displayed" is the map's reveal rule ({@link isHexDisplayed}) — the hex
 * shares an edge with the hangar (`0,0`) or with a hex the player holds — so
 * the bot expands from territory it owns instead of teleporting across or
 * behind the reveal. Ties are settled by aggression and then by sorted id, so
 * a reordered payload replays identically.
 *
 * Total and never off-map: when no displayed unheld hex exists — the ring is
 * secured, or a later ring has not yet been revealed by a held neighbour —
 * `null` is returned. There is **no** fallback to a hidden hex: a hex the map
 * does not show can never be deployed at.
 *
 * @param payload — the war's stored payload.
 * @param definitions — authored ring definitions (defaults to the shipped table).
 * @returns the hex id to attack, or `null` when no displayed hex remains.
 */
export function pickAttractHex(
  payload: HangarWarPayload,
  definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS,
): string | null {
  const hexes = displayHexStates(payload, definitions);
  if (hexes.every((hex) => hex.held === true)) return null;

  const held = hexes.filter((hex) => hex.held === true);
  const candidates = hexes.filter(
    (hex) => hex.held !== true && isHexDisplayed(hex, held),
  );
  if (candidates.length === 0) return null;

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
 * @param options — definitions/title overrides and the transient tick record
 *   whose attacks become arrows and per-attack details.
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
  const heldStates = states.filter((state) => state.held === true);

  const hexes = states.map((state) =>
    buildHexIntel(
      state,
      definitionById.get(state.id) ?? findHexRingDefinition(state.id),
      forces.get(state.id) ?? 0,
      isHexDisplayed(state, heldStates),
    ),
  );

  const displayedHexes = hexes.filter((hex) => hex.displayed);
  // Ring progress is computed over the full stored/generated ring (hidden
  // hexes included), so hiding hexes never loses progress (AC4).
  const heldCount = hexes.filter((hex) => hex.held).length;
  const secured = hexes.length > 0 && heldCount === hexes.length;
  const attractHexId = pickAttractHex(payload, definitions);

  // Ring-level context (the shared resolvers, never a map-local rule): the
  // player strength the frontier was sized from and the aggression the current
  // fleet is expected to clear. The per-hex badges still render the stored
  // (redistributed) aggression untouched.
  const playerStrength = resolvePlayerStrength(payload.hangar);
  const beatableCeiling = beatableAggressionCeiling(playerStrength);
  const inReachCount = hexes.filter(
    (hex) => hex.aggression <= beatableCeiling,
  ).length;

  // Focus covers every selectable (displayed) hex plus the hangar row;
  // grid columns give the renderer spatial arrows without a per-scene rule.
  const focusOrder = [
    ...displayedHexes.map((hex) => hex.key),
    HEX_MAP_HANGAR_ROW_KEY,
  ];
  const gridColumns = buildGridColumns(hexes, HEX_MAP_HANGAR_ROW_KEY);
  const { arrows, attackDetails } = buildAttackOverlay(payload, options.record);
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
    playerStrength,
    beatableCeiling,
    frontierLine: `FRONTIER · STR ${playerStrength} · BEAT ≤ ${beatableCeiling} (${inReachCount} IN REACH)`,
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
    gridColumns,
    arrows,
    attackDetails,
  };
}

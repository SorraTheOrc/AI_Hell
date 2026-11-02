/**
 * Between-sortie defence report view model
 * (AH-0MVUXCBBK004EJIP, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene
 * surface ("A **between-sortie defence report**: which hexes were attacked,
 * which held, which fell, and what it would take to retake them") and the
 * failure mode it mitigates — *opaque defence*: "a hex falls and the player
 * cannot see why … show the numbers (defender rating vs. attacking force)".
 *
 * ## A pure view, never a rule
 *
 * This module renders **only** what the frontier tick already decided. Its two
 * inputs are the resolver's per-tick record (`FrontierTickRecord` from
 * `./hexDefence`) and the stored payload (`HangarWarPayload`); every number in
 * a row is copied from the record, and the payload is consulted for two facts
 * the record does not carry: whether the hex is still held after the tick, and
 * the attacking neighbour's aggression (what the player can strike back at).
 * Nothing is resolved, re-derived, mutated or persisted here — the report
 * screen, the gym and the attract traversal all read the same model, so no
 * gameplay rule can live in (or drift between) the scenes
 * (AGENTS.md gym↔game parity).
 *
 * ## What "what it would take to retake it" means
 *
 * The design's answerability rule is that an attack is always launched from an
 * **unheld neighbouring hex** (`attackingNeighbour` in `./hexDefence`), so a
 * fallen hex has exactly one answer: strike that neighbour, then leave a bot
 * strong enough to survive the same attack. Because a tie holds the line
 * (`margin === 0` is a hold), the required defender rating is the record's
 * `attackStrength` — not one more than it.
 *
 * ## A quiet tick
 *
 * A secured ring (every hex held) has no unheld neighbour to attack from, so a
 * tick on it reports **no attacks**. That is a legitimate, non-stalling report
 * — the model publishes `quiet: true` and an explicit "no hex was attacked"
 * line rather than an empty screen the demo could stall on.
 *
 * @module src/core/hangarWar/defenceReport
 */

import { areNeighbours, type AxialCoordinate } from './hexRing';
import type {
  DefenceOutcome,
  FrontierTickRecord,
  HexDefenceRecord,
} from './hexDefence';
import type { HangarWarPayload, HexState } from './types';

/** Title rendered by the report screen (asserted by tests). */
export const DEFENCE_REPORT_TITLE = 'DEFENCE REPORT';

/** Row key of the "continue" action (the screen's one action). */
export const DEFENCE_REPORT_CONTINUE_KEY = 'continue';

/** Label of the continue action (the way back to the map). */
export const DEFENCE_REPORT_CONTINUE_LABEL = '▶ CONTINUE TO THE MAP';

/** The line stating that nothing was simulated (the design's no-battle rule). */
export const DEFENCE_REPORT_NO_BATTLE_LINE =
  'Resolved from stored numbers — no battle was simulated.';

/**
 * What it would take to retake a hex that fell (or to hold one that stood).
 *
 * Every field comes from the tick's record or the stored payload; the note is
 * the one-line human reading of them.
 */
export interface DefenceRetakePlan {
  /** The unheld neighbouring hex the attack came from (the hex to strike). */
  readonly originHexId: string;
  /** That neighbour's axial coordinate (so the map can point at it). */
  readonly origin: AxialCoordinate;
  /** That neighbour's stored aggression after the tick. */
  readonly originAggression: number;
  /**
   * Defender rating needed to hold the hex against the same attack. A tie
   * holds, so this is the record's `attackStrength` (not one more).
   */
  readonly requiredDefenderRating: number;
  /** One-line reading of the plan (`strike … then hold with a bot rated ≥ …`). */
  readonly note: string;
}

/** One attacked hex, with every number the tick used and the retake plan. */
export interface DefenceReportRow {
  /** Row key (`defence:<hexId>`), unique within the report. */
  readonly key: string;
  /** The attacked hex. */
  readonly hexId: string;
  /** `held` when the defence stood, `fell` when the hex was retaken. */
  readonly outcome: DefenceOutcome;
  /** Whether the hex is still held after the tick (the payload's state). */
  readonly held: boolean;
  /** Attacking force before aggression/jitter (from the record). */
  readonly attackingForce: number;
  /** The hex's aggression that scaled the attack (from the record). */
  readonly aggression: number;
  /** Aggression multiplier applied, in percent (`100` = neutral). */
  readonly aggressionMultiplierPercent: number;
  /** Bounded seeded jitter applied, in percent (`0` = none). */
  readonly jitterPercent: number;
  /** The defending bot's stored rating (from the record). */
  readonly defenderRating: number;
  /** The force actually faced, after aggression and jitter. */
  readonly attackStrength: number;
  /** `defenderRating − attackStrength` (negative exactly when the hex fell). */
  readonly margin: number;
  /** Whether the attack was queued (`pending`) or opened by the tick. */
  readonly source: 'pending' | 'frontier';
  /** The unheld neighbour the attack came from. */
  readonly attackerOriginId: string;
  /** What the player can do about it (the answerability rule). */
  readonly retake: DefenceRetakePlan;
  /** The row's rendered text (every number, newline separated). */
  readonly label: string;
}

/** The complete rendered state of the defence report (pure data). */
export interface DefenceReportModel {
  /** Screen title. */
  readonly title: string;
  /** The clock tick this report belongs to. */
  readonly tick: number;
  /** Aggression rise the tick applied to every hex. */
  readonly aggressionRise: number;
  /** Tick line (`TICK 4 · aggression +2`). */
  readonly tickLine: string;
  /** Outcome summary (`ATTACKED 2 · HELD 1 · FELL 1`, or the quiet line). */
  readonly summaryLine: string;
  /** True when the tick resolved no attack at all (a quiet, non-stalling tick). */
  readonly quiet: boolean;
  /** Every attacked hex, in the record's order (weakest margin last). */
  readonly rows: readonly DefenceReportRow[];
  /** How many hexes were attacked this tick. */
  readonly attackedCount: number;
  /** How many of them held. */
  readonly heldCount: number;
  /** How many of them fell. */
  readonly fellCount: number;
  /** The "nothing was simulated" line (the design's no-battle rule). */
  readonly noBattleLine: string;
  /** The continue action's row key. */
  readonly continueKey: string;
  /** The continue action's rendered label. */
  readonly continueLabel: string;
  /** Keys of the rows that can be activated (exactly the continue action). */
  readonly focusOrder: readonly string[];
  /** The row focused by default (always the continue action). */
  readonly defaultFocusKey: string;
}

/** Optional overrides for {@link buildDefenceReport}. */
export interface BuildDefenceReportOptions {
  /** Screen title override (tests/captures). */
  readonly title?: string;
  /** Continue-label override (tests/captures). */
  readonly continueLabel?: string;
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** The payload's hex with `id`, or `undefined`. */
function findHex(
  payload: HangarWarPayload,
  hexId: string,
): HexState | undefined {
  return payload.ring.hexes.find((hex) => hex.id === hexId);
}

/**
 * The retake plan for one resolved attack.
 *
 * The origin is the record's attacking neighbour; its aggression is read from
 * the payload (post-tick, so it matches what the map shows). A payload that no
 * longer carries the origin (a partial ring) still yields a plan: the record's
 * own aggression is used and the note simply omits the origin's aggression.
 */
function buildRetakePlan(
  payload: HangarWarPayload,
  record: HexDefenceRecord,
): DefenceRetakePlan {
  const originHex = findHex(payload, record.attackerOriginId);
  const originAggression = toCount(originHex?.aggression);
  const requiredDefenderRating = toCount(record.attackStrength);
  const origin: AxialCoordinate = {
    q: record.attackerOrigin.q,
    r: record.attackerOrigin.r,
  };
  const strike = originHex
    ? `strike ${record.attackerOriginId} (AGG ${originAggression})`
    : `strike ${record.attackerOriginId}`;
  const note =
    record.outcome === 'fell'
      ? `${strike} to stop the pressure, then hold with a bot rated ≥ ${requiredDefenderRating}`
      : `held — a bot rated ≥ ${requiredDefenderRating} would hold it again`;
  return {
    originHexId: record.attackerOriginId,
    origin,
    originAggression,
    requiredDefenderRating,
    note,
  };
}

/** The rendered text of one attacked hex (every number the tick used). */
function rowLabel(
  record: HexDefenceRecord,
  held: boolean,
  retake: DefenceRetakePlan,
): string {
  const outcome = record.outcome === 'held' ? 'HELD' : 'FELL';
  const state = held ? '' : ' · LOST';
  const source = record.source === 'pending' ? 'queued' : 'frontier';
  const jitter =
    record.jitterPercent === 0
      ? 'no jitter'
      : `jitter ${record.jitterPercent > 0 ? '+' : ''}${record.jitterPercent}%`;
  return [
    `${record.hexId} — ${outcome}${state}`,
    `atk ${record.attackingForce} × AGG ${record.aggression} `
      + `(${record.aggressionMultiplierPercent}%, ${jitter}) `
      + `= ${record.attackStrength} vs bot ${record.defenderRating}`,
    `margin ${record.margin > 0 ? '+' : ''}${record.margin} · ${source} attack`,
    `retake: ${retake.note}`,
  ].join('\n');
}

/**
 * Builds the between-sortie defence report from the tick's record and the
 * stored payload.
 *
 * The record is the sole source of the resolved numbers; the payload supplies
 * the post-tick held state and the attacking neighbour's aggression. The model
 * is total: a missing/partial record yields a quiet report rather than
 * throwing, so a direct scene boot (or a corrupt save) never stalls the demo.
 *
 * @param payload — the stored war payload after the tick (never mutated).
 * @param record — the frontier tick's record (never mutated).
 * @param options — title/continue-label overrides.
 * @returns the complete report model.
 */
export function buildDefenceReport(
  payload: HangarWarPayload,
  record: FrontierTickRecord,
  options: BuildDefenceReportOptions = {},
): DefenceReportModel {
  const attacks = Array.isArray(record?.attacks) ? record.attacks : [];
  const rows: DefenceReportRow[] = attacks.map((attack) => {
    const hex = findHex(payload, attack.hexId);
    const held = hex?.held === true;
    const retake = buildRetakePlan(payload, attack);
    return {
      key: `defence:${attack.hexId}`,
      hexId: attack.hexId,
      outcome: attack.outcome,
      held,
      attackingForce: toCount(attack.attackingForce),
      aggression: toCount(attack.aggression),
      aggressionMultiplierPercent: toCount(attack.aggressionMultiplierPercent),
      jitterPercent:
        typeof attack.jitterPercent === 'number'
        && Number.isFinite(attack.jitterPercent)
          ? attack.jitterPercent
          : 0,
      defenderRating: toCount(attack.defenderRating),
      attackStrength: toCount(attack.attackStrength),
      margin:
        typeof attack.margin === 'number' && Number.isFinite(attack.margin)
          ? attack.margin
          : 0,
      source: attack.source === 'pending' ? 'pending' : 'frontier',
      attackerOriginId: attack.attackerOriginId,
      retake,
      label: rowLabel(attack, held, retake),
    };
  });

  const heldCount = rows.filter((row) => row.outcome === 'held').length;
  const fellCount = rows.filter((row) => row.outcome === 'fell').length;
  const quiet = rows.length === 0;
  const tick = toCount(record?.tick);
  const aggressionRise = toCount(record?.aggressionRise);

  return {
    title: options.title ?? DEFENCE_REPORT_TITLE,
    tick,
    aggressionRise,
    tickLine: `TICK ${tick} · aggression +${aggressionRise}`,
    summaryLine: quiet
      ? 'QUIET — no hex was attacked this tick'
      : `ATTACKED ${rows.length} · HELD ${heldCount} · FELL ${fellCount}`,
    quiet,
    rows,
    attackedCount: rows.length,
    heldCount,
    fellCount,
    noBattleLine: DEFENCE_REPORT_NO_BATTLE_LINE,
    continueKey: DEFENCE_REPORT_CONTINUE_KEY,
    continueLabel: options.continueLabel ?? DEFENCE_REPORT_CONTINUE_LABEL,
    focusOrder: [DEFENCE_REPORT_CONTINUE_KEY],
    defaultFocusKey: DEFENCE_REPORT_CONTINUE_KEY,
  };
}

/**
 * The unheld neighbour a retake should strike first, or `null` when none.
 *
 * A convenience over {@link buildDefenceReport} for the attract traversal: the
 * first fallen row's origin is the hex that keeps the pressure on. Pure and
 * total — an empty/quiet report has nothing to strike.
 *
 * @param model — a built report model.
 * @returns the hex id to deploy at, or `null` when no hex fell.
 */
export function retakeTargetHex(model: DefenceReportModel): string | null {
  const fallen = model.rows.find((row) => row.outcome === 'fell');
  return fallen ? fallen.attackerOriginId : null;
}

/**
 * Whether the report's origin hex is still a valid, unheld neighbour of the
 * attacked hex — the invariant the answerability rule promises.
 *
 * Exposed so tests (and a future scene hint) can assert the report never
 * points at a hex the player cannot deploy at.
 *
 * @param payload — the payload the report was built from.
 * @param row — one report row.
 * @returns true when the row's retake target is an unheld neighbour.
 */
export function retakeTargetIsAnswerable(
  payload: HangarWarPayload,
  row: DefenceReportRow,
): boolean {
  const attacked = findHex(payload, row.hexId);
  const origin = findHex(payload, row.retake.originHexId);
  if (!attacked || !origin) return false;
  return !origin.held && areNeighbours(attacked, origin);
}

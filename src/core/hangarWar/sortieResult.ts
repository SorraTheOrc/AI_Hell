/**
 * Post-battle **sortie results** view model — the pure "result for view"
 * builder of the hex combat results dialog
 * (AH-0MWMGPQUE0064AFH, child of AH-0MWMFGXD6005WTMN).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene
 * surface. A finished hex deployment must end on one readable summary: the
 * outcome and the run's final score, every reward the capture actually paid,
 * and — on a defeat — what the defending boss was strong and weak against.
 * (The copy is sentence case throughout; a defeat does not dwell on what was
 * not claimed.)
 *
 * ## A pure view, never a rule
 *
 * This module renders **only** what the game already decided. Its inputs are
 * the finished sortie's own record ({@link SortieResultRecord}) and the
 * authored hex definitions (`HEX_RING_DEFINITIONS` in
 * `src/data/hexRingDefinitions.ts`):
 *
 * - on a victory, every reward figure is copied from the capture cycle's own
 *   `HexCaptureResult` (child of AH-0MVUXCAW0001VUM6) — `bankedDelta`,
 *   `grant`, `specialReward`, `contractBonus`, `cachePayout` — plus the
 *   landing's `winBonusMinerals`;
 * - on a defeat, the strengths/weaknesses come straight from the target hex's
 *   authored `HexRingDefinition` (the record's `forfeited` amounts stay on the
 *   type for other consumers but are no longer rendered).
 *
 * Nothing is re-derived, computed, mutated or persisted here: a reward field
 * added to the capture cycle later reaches the dialog without a second copy
 * edit, and no gameplay rule can live in (or drift between) the scenes
 * (AGENTS.md gym↔game parity). The module imports no Phaser, reads no store and
 * never mutates its arguments — a frozen input is rendered like any other.
 *
 * ## Rows, in draw order
 *
 * The outcome + score row is always first (`Victory · score 1200`). A victory
 * then draws `salvage`, `grant`, `special`, `contract`, `cache`, `win-bonus`;
 * a defeat draws only `strengths` and `weaknesses`.
 * **A reward that was not paid contributes no row** — a `null`, zero or empty
 * reward is omitted rather than rendered as a zero line, so the dialog never
 * advertises salvage that was not banked.
 *
 * ## Degradation
 *
 * The builder is total. A target hex the authored table does not name draws
 * the outcome (and, on a victory, the carried rewards) with no invented boss
 * intel; a malformed amount, score or definition degrades to a zero/absent
 * row instead of throwing.
 *
 * @module src/core/hangarWar/sortieResult
 */

import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { HexCaptureResult } from './captureCycle';
import type { HexRingDefinition } from './hexRing';
import type { SalvageAmounts } from './salvageBanking';

/** The dialog's fixed title. */
export const SORTIE_RESULT_TITLE = 'Sortie results';

/**
 * The capture-cycle fields the results view reads.
 *
 * A {@link Pick} of the shipped `HexCaptureResult`, deliberately, so a reward
 * field added to the capture cycle is one edit away from the dialog rather
 * than a hand-copied subset that can silently drop it.
 */
export type SortieCaptureRecord = Pick<
  HexCaptureResult,
  | 'bankedDelta'
  | 'grant'
  | 'specialReward'
  | 'contractBonus'
  | 'cachePayout'
  | 'ringSecured'
  | 'ringAdvanced'
>;

/**
 * The finished deployment's record, as the deployment→map handoff carries it.
 *
 * Transient launch data only: it is never persisted, so a later menu/hangar
 * landing shows no results dialog.
 */
export interface SortieResultRecord {
  /** The hex the deployment targeted, or `null` for a hexless run. */
  readonly hexId: string | null;
  /** True when the deployment was won. */
  readonly won: boolean;
  /** The run's final score, as the run recorded it. */
  readonly score: number;
  /** The fixed win bonus banked on a victory; `0` when none was paid. */
  readonly winBonusMinerals: number;
  /** The win path's own capture record, or `null` (a loss, or a hexless win). */
  readonly capture: SortieCaptureRecord | null;
  /** The loss path's forfeited unbanked salvage, or `null` on a victory. */
  readonly forfeited: SalvageAmounts | null;
}

/** Every row kind the view can draw, in the order each outcome draws them. */
export type SortieResultRowKey =
  | 'outcome'
  | 'salvage'
  | 'grant'
  | 'special'
  | 'contract'
  | 'cache'
  | 'win-bonus'
  | 'strengths'
  | 'weaknesses';

/** One rendered dialog row: its kind and the whole line to draw. */
export interface SortieResultRow {
  /** The row's kind (stable, so callers can assert on it). */
  readonly key: SortieResultRowKey;
  /** The whole rendered line. */
  readonly text: string;
}

/** The rendered results view the dialog draws. */
export interface SortieResultView {
  /** The dialog title ({@link SORTIE_RESULT_TITLE}). */
  readonly title: string;
  /** The battle outcome discriminator. */
  readonly outcome: 'VICTORY' | 'DEFEAT';
  /** The hex the deployment targeted, or `null`. */
  readonly hexId: string | null;
  /** The rows, in draw order (the outcome row first). */
  readonly rows: readonly SortieResultRow[];
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** The `<n> core` fragment, singular for one core. */
function coresText(cores: number): string {
  return `${cores} core${cores === 1 ? '' : 's'}`;
}

/**
 * The `+120 minerals, +1 core` fragment for amounts a capture **paid**, zero
 * parts omitted, or `''` when nothing was paid (so the caller draws no row).
 */
function paidAmounts(amounts: SalvageAmounts | null | undefined): string {
  if (!amounts) return '';
  const parts: string[] = [];
  const minerals = toCount(amounts.minerals);
  const cores = toCount(amounts.cores);
  if (minerals > 0) parts.push(`+${minerals} minerals`);
  if (cores > 0) parts.push(`+${coresText(cores)}`);
  return parts.join(', ');
}

/** Every victory row after the outcome, copied from the carried record. */
function victoryRows(record: SortieResultRecord): SortieResultRow[] {
  const rows: SortieResultRow[] = [];
  const capture = record.capture;

  if (capture) {
    const salvage = paidAmounts(capture.bankedDelta);
    if (salvage) {
      rows.push({ key: 'salvage', text: `Salvage banked: ${salvage}` });
    }

    const grant = capture.grant;
    if (grant && grant.entryId) {
      rows.push({
        key: 'grant',
        text: `Technology recovered: ${grant.entryId}`,
      });
    }

    const special = capture.specialReward;
    if (special) {
      // The catalogue entry names the hull for display; the id is the total
      // fallback for a reward authored without one.
      const name = special.hull?.name ?? special.hullId;
      if (name) {
        rows.push({ key: 'special', text: `Special reward: ${name}` });
      }
    }

    const contract = paidAmounts(capture.contractBonus);
    if (contract) {
      rows.push({ key: 'contract', text: `Contract bonus: ${contract}` });
    }

    const cache = paidAmounts(capture.cachePayout);
    if (cache) {
      rows.push({ key: 'cache', text: `Cache payout: ${cache}` });
    }
  }

  const winBonus = toCount(record.winBonusMinerals);
  if (winBonus > 0) {
    rows.push({
      key: 'win-bonus',
      text: `Win bonus banked: +${winBonus} minerals`,
    });
  }

  return rows;
}

/** Every defeat row after the outcome: the defending boss's authored intel. */
function defeatRows(
  record: SortieResultRecord,
  definitions: readonly HexRingDefinition[],
): SortieResultRow[] {
  const rows: SortieResultRow[] = [];
  const definition = definitions.find((row) => row?.id === record.hexId);

  if (definition) {
    const strengths = (definition.strengths ?? []).filter(
      (entry): entry is string => typeof entry === 'string' && entry !== '',
    );
    if (strengths.length > 0) {
      rows.push({
        key: 'strengths',
        text: `Strong against: ${strengths.join(', ')}`,
      });
    }

    const weaknesses = (definition.weaknesses ?? []).filter(
      (entry): entry is string => typeof entry === 'string' && entry !== '',
    );
    if (weaknesses.length > 0) {
      rows.push({
        key: 'weaknesses',
        text: `Weak against: ${weaknesses.join(', ')}`,
      });
    }
  }

  return rows;
}

/**
 * Builds the results dialog's view from a finished deployment.
 *
 * Pure and total: every figure and every strength/weakness string is copied
 * from `record` or the authored `definitions`, and neither argument is
 * mutated. An unknown target hex and a `null` capture each simply contribute
 * no row.
 *
 * @param record — the finished deployment's own record.
 * @param definitions — the authored hex definitions to read boss intel from;
 *   the shipped `HEX_RING_DEFINITIONS` table by default.
 * @returns the ordered rows the dialog draws.
 */
export function buildSortieResultView(
  record: SortieResultRecord,
  definitions: readonly HexRingDefinition[] = HEX_RING_DEFINITIONS,
): SortieResultView {
  const outcome = record.won ? 'VICTORY' : 'DEFEAT';
  const outcomeLabel = record.won ? 'Victory' : 'Defeat';
  const rows: SortieResultRow[] = [
    {
      key: 'outcome',
      text: `${outcomeLabel} · score ${toCount(record.score)}`,
    },
  ];

  if (record.won) {
    rows.push(...victoryRows(record));
  } else {
    const table = Array.isArray(definitions) ? definitions : [];
    rows.push(...defeatRows(record, table));
  }

  return {
    title: SORTIE_RESULT_TITLE,
    outcome,
    hexId: record.hexId,
    rows,
  };
}

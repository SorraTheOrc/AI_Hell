/**
 * Salvage banking at the run's checkpoint moments
 * (AH-0MVUXC118004B4OX, part of **Build Candidate D — Hangar War**).
 *
 * The persistent echo of the shipped in-run mineral economy. Design of record:
 * `docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *States* — "a bad run still
 * banks salvage from the checkpoints it reached"; "losing a run never does
 * this [the hangar falls]: the run's unbanked salvage is forfeit, the hangar
 * and the ring survive".
 *
 * ## What is banked, and when
 *
 * The extraction moments are the **existing** checkpoint moments (mini-boss
 * defeats — see `checkpointStore` and `PlayScene._saveCheckpoint`). At each one
 * the run's cumulative salvage snapshot is
 *
 * - **minerals** the ship is holding at that moment (the run's own mineral
 *   economy is untouched — banking is a copy, never a withdrawal), and
 * - **mini-boss cores** earned by the run so far (one per defeated mini-boss).
 *
 * Because a snapshot is **cumulative**, banking adds only what the run earned
 * *since the previous bank*, tracked by the `bankedThisRun` watermark. A banked
 * run therefore never double-counts a checkpoint it already banked, and the
 * balance can never go down when the player spends minerals in-run.
 *
 * ## Forfeiture
 *
 * `unbankedSalvage` / `forfeitUnbankedSalvage` make the death rule explicit:
 * a lost run forfeits exactly the salvage earned since its last bank, and the
 * persistent balance is returned untouched. Nothing here persists anything —
 * the caller writes the balance through the hangar-war store
 * (`hangarWarStore.saveHangarWarPayload`), so this module stays pure and
 * injectable (no DOM, no `localStorage`) and every rule is table-testable.
 *
 * @module src/core/hangarWar/salvageBanking
 */

import type { HangarState } from './types';

/** A pair of salvage amounts: minerals and mini-boss cores. */
export interface SalvageAmounts {
  /** Minerals banked/earned (non-negative integer). */
  minerals: number;
  /** Mini-boss cores banked/earned (non-negative integer). */
  cores: number;
}

/**
 * What a run has earned at one checkpoint moment (a **cumulative** snapshot of
 * the run, not a delta — the banking function derives the delta).
 */
export interface RunSalvageSource {
  /**
   * Stable identity of the run. Two runs that share checkpoint ids (e.g. both
   * start at `cp-1`) must not share a watermark, so this is the run's own key
   * (the shipped run uses its seed).
   */
  runId: string;
  /** Stable identity of the checkpoint moment within the run. */
  checkpointId: string;
  /** Minerals the ship is holding at the checkpoint. */
  minerals: number;
  /** Mini-boss cores the run has earned so far. */
  cores: number;
}

/** A normalised run snapshot at one checkpoint moment. */
export interface RunSalvage extends SalvageAmounts {
  /** See {@link RunSalvageSource.runId}. */
  runId: string;
  /** See {@link RunSalvageSource.checkpointId}. */
  checkpointId: string;
}

/**
 * The persistent bank plus the per-run watermark that makes banking idempotent
 * per checkpoint.
 *
 * Only {@link BankedSalvage.minerals} / {@link BankedSalvage.cores} are
 * persisted (through the hangar-war store); the watermark is run-scoped and
 * lives with the run that created it, so a resumed run starts its watermark
 * from the checkpoint it resumes at rather than re-banking it.
 */
export interface BankedSalvage extends SalvageAmounts {
  /** The run whose salvage was banked last, or `null` before the first bank. */
  runId: string | null;
  /** The share of that run's cumulative salvage already banked. */
  bankedThisRun: SalvageAmounts;
  /** The last checkpoint moment banked for that run, or `null`. */
  lastCheckpointId: string | null;
}

/** The zero amount pair (shared read-only value). */
const ZERO: SalvageAmounts = { minerals: 0, cores: 0 };

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** Normalises an amount pair, so a corrupt count can never be banked. */
function normaliseAmounts(raw: undefined | Partial<SalvageAmounts>): SalvageAmounts {
  if (!raw) return { minerals: 0, cores: 0 };
  return { minerals: toAmount(raw.minerals), cores: toAmount(raw.cores) };
}

/** Builds the persistent bank from its stored balance (empty by default). */
export function createBankedSalvage(
  minerals: number = 0,
  cores: number = 0,
): BankedSalvage {
  return {
    minerals: toAmount(minerals),
    cores: toAmount(cores),
    runId: null,
    bankedThisRun: { minerals: 0, cores: 0 },
    lastCheckpointId: null,
  };
}

/** Builds the persistent bank from an existing hangar's banked balance. */
export function bankedSalvageFromHangar(hangar: HangarState): BankedSalvage {
  return createBankedSalvage(hangar.bankedMinerals, hangar.bankedCores);
}

/** Snapshots a run's salvage at a checkpoint moment, normalised. */
export function runSalvageFromRun(source: RunSalvageSource): RunSalvage {
  return {
    runId: source.runId,
    checkpointId: source.checkpointId,
    minerals: toAmount(source.minerals),
    cores: toAmount(source.cores),
  };
}

/** Normalises an existing bank (its stored balance is already persisted data). */
function normaliseBank(banked: BankedSalvage): BankedSalvage {
  return {
    minerals: toAmount(banked.minerals),
    cores: toAmount(banked.cores),
    runId: banked.runId,
    bankedThisRun: normaliseAmounts(banked.bankedThisRun),
    lastCheckpointId: banked.lastCheckpointId,
  };
}

/**
 * Banks one checkpoint moment's salvage into the persistent balance.
 *
 * Pure and idempotent per checkpoint: only the increase over what this run has
 * already banked is added, so replaying the same checkpoint adds nothing. A new
 * run (different `runId`) starts from a zero watermark and banks afresh even
 * when it reuses the same checkpoint ids.
 *
 * @param banked — the persistent balance (plus the run watermark).
 * @param runSalvage — the run's cumulative salvage at this checkpoint.
 * @returns the updated balance; the inputs are never mutated.
 */
export function bankSalvage(
  banked: BankedSalvage,
  runSalvage: RunSalvage,
): BankedSalvage {
  const bank = normaliseBank(banked);
  const run: RunSalvage = {
    runId: runSalvage.runId,
    checkpointId: runSalvage.checkpointId,
    minerals: toAmount(runSalvage.minerals),
    cores: toAmount(runSalvage.cores),
  };
  const sameRun = bank.runId !== null && bank.runId === run.runId;
  const baseline = sameRun ? bank.bankedThisRun : ZERO;

  return {
    minerals: bank.minerals + Math.max(0, run.minerals - baseline.minerals),
    cores: bank.cores + Math.max(0, run.cores - baseline.cores),
    runId: run.runId,
    // The watermark always follows the latest snapshot (it may move down when
    // the player spends minerals, so later earnings bank again).
    bankedThisRun: { minerals: run.minerals, cores: run.cores },
    lastCheckpointId: run.checkpointId,
  };
}

/**
 * The salvage a run would forfeit if it ended now: everything it has earned
 * since the last bank of **this** run (its whole snapshot for a new run).
 */
export function unbankedSalvage(
  banked: BankedSalvage,
  runSalvage: RunSalvage,
): SalvageAmounts {
  const bank = normaliseBank(banked);
  const baseline =
    bank.runId !== null && bank.runId === runSalvage.runId
      ? bank.bankedThisRun
      : ZERO;
  return {
    minerals: Math.max(0, toAmount(runSalvage.minerals) - baseline.minerals),
    cores: Math.max(0, toAmount(runSalvage.cores) - baseline.cores),
  };
}

/**
 * Settles a lost run: the persistent balance is returned **unchanged** and the
 * run's unbanked salvage is reported as forfeit ("unbanked is forfeit on
 * death", Candidate D *States*).
 *
 * Nothing is written here — the caller keeps the unchanged bank and may record
 * the forfeited amount for the end-of-run summary.
 */
export function forfeitUnbankedSalvage(
  banked: BankedSalvage,
  runSalvage: RunSalvage,
): { banked: BankedSalvage; forfeited: SalvageAmounts } {
  return {
    banked: normaliseBank(banked),
    forfeited: unbankedSalvage(banked, runSalvage),
  };
}

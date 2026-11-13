/**
 * Test-side contract for the **win-path bonus** (test-first child
 * AH-0MWF2PA5H008XCXW; implementation children AH-0MWF2PYIE001XZOV,
 * AH-0MWF2Q0O0008NGKL, AH-0MWF2Q2JC008MAJE).
 *
 * The win path stopped paying a run-scoped mini-boss wheel and now banks a
 * **fixed mineral bonus** into the persistent hangar war (parent
 * AH-0MWEVNBMM000QFO2, producer Q1 = c / Q2 = a / Q3 = b, recorded
 * 2026-11-13). This module is the single place that declares the runtime
 * surface the implementation must provide and probes whether it exists yet, so
 * the contract tests can be written **before** the code without leaving `dev`
 * red and without `any` casts spread across four suites.
 *
 * - {@link WinBonusBanking} — the pure seam: `bankWinBonus(banked)` in
 *   `src/core/hangarWar/salvageBanking.ts`, alongside `bankSalvage`.
 * - {@link winBonusMinerals} — the named balance knob `WIN_BONUS_MINERALS` in
 *   `src/core/hangarWar/hangarEconomy.ts`. Its **value** is baselined from
 *   AH-0MWCOWTOR00994NA's measured per-deployment income when that lands, so no
 *   test hardcodes a number: every assertion compares against the constant.
 * - {@link winBonusSeamReady} — false until `bankWinBonus` exists.
 *
 * The suites are authored red under Vitest's `it.fails` (the repo's
 * red-before/green-after convention — see `src/vfx/orbitalStrike.test.ts`), and
 * each implementation child **flips its `it.fails` back to a plain `it`** once
 * the behaviour lands. A leftover `it.fails` then fails the suite, so the flip
 * is a real target rather than a permanent exemption.
 *
 * ## The contract the tests pin down
 *
 * 1. **Minerals only** (Q2 = a). A capture already banks its one core through
 *    the capture cycle, so the win bonus grants **no** cores — a bonus core
 *    would double-count.
 * 2. **Cumulative, watermark-safe.** Like `bankSalvage`, `bankWinBonus` returns
 *    a new bank and never mutates its input. It adds exactly
 *    `WIN_BONUS_MINERALS` to `minerals` and leaves the run watermark
 *    (`runId` / `bankedThisRun` / `lastCheckpointId`) untouched, so it can
 *    neither disturb the capture cycle's watermark arithmetic nor be re-derived
 *    from a run snapshot.
 * 3. **Called exactly once per win**, by the win resolution, so the persisted
 *    balance grows by exactly one bonus. The replay guard is the single call
 *    site (`_finaliseHangarWarMiniBossVictory`), not a stored marker: a lost
 *    deployment banks nothing.
 * 4. **Persisted through the one payload write.** The bonus lands in
 *    `hangar.bankedMinerals` / `hangar.bankedCores` and is written through the
 *    shipped `ai_hell_hangar_war` payload (no second store, no new key).
 * 5. **Announced, not silently banked** (Q3 = b). The landing report model
 *    carries a `winBonusLine` (`WIN BONUS BANKED: +N MINERALS`, `null` without a
 *    bonus) and the hex map renders it before interaction resumes — the rolled-
 *    in successor of the retired standalone `DefenceReportScene`.
 */

import type { BankedSalvage } from '../core/hangarWar/salvageBanking';
import type { BuildDefenceReportOptions } from '../core/hangarWar/defenceReport';
import * as salvageBanking from '../core/hangarWar/salvageBanking';
import * as hangarEconomy from '../core/hangarWar/hangarEconomy';

/**
 * The pure banking surface the win path requires
 * (AH-0MWF2PYIE001XZOV, `src/core/hangarWar/salvageBanking.ts`).
 */
export interface WinBonusBanking {
  /**
   * Banks the fixed win bonus into the persistent balance.
   *
   * @param banked — the persistent balance (plus the run watermark).
   * @returns the updated balance: `minerals + WIN_BONUS_MINERALS`, the same
   *   `cores`, and the watermark unchanged. The input is never mutated.
   */
  readonly bankWinBonus: (banked: BankedSalvage) => BankedSalvage;
}

/** Actionable message when the seam has not landed yet. */
export const WIN_BONUS_BANKING_PENDING_MESSAGE =
  'The win-path bonus banking seam is not available: ' +
  'src/core/hangarWar/salvageBanking.ts must export bankWinBonus(banked) and ' +
  'src/core/hangarWar/hangarEconomy.ts must export the WIN_BONUS_MINERALS amount ' +
  '(AH-0MWF2PYIE001XZOV).';

/** The partial view of `salvageBanking` the contract is probed against. */
const bankingCandidate = salvageBanking as unknown as Partial<WinBonusBanking>;

/** The partial view of `hangarEconomy` the amount is probed against. */
const economyCandidate = hangarEconomy as unknown as {
  readonly WIN_BONUS_MINERALS?: unknown;
};

/** True once the pure seam exists; every bonus suite keys off this. */
export const winBonusSeamReady: boolean =
  typeof bankingCandidate.bankWinBonus === 'function';

/**
 * The typed pure seam.
 *
 * @throws Error naming the missing export and work item when the implementation
 *   has not landed — a guard mistake is loud, never a confusing
 *   `undefined is not a function`.
 */
export function bankWinBonus(banked: BankedSalvage): BankedSalvage {
  const seam = bankingCandidate.bankWinBonus;
  if (typeof seam !== 'function') throw new Error(WIN_BONUS_BANKING_PENDING_MESSAGE);
  return seam(banked);
}

/**
 * The fixed win bonus amount (minerals), read from the named constant.
 *
 * @throws Error naming the missing constant and work item when it has not
 *   landed, or when the constant is not a positive whole number of minerals
 *   (a balance knob is never fractional or negative).
 */
export function winBonusMinerals(): number {
  const amount = economyCandidate.WIN_BONUS_MINERALS;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw new Error(WIN_BONUS_BANKING_PENDING_MESSAGE);
  }
  return amount;
}

/**
 * The banked-bonus announcement a landing surface publishes (Q3 = b): the
 * `winBonusLine` the report model renders before interaction resumes.
 *
 * `null` until the field lands, so the "no bonus" cases read green on
 * pre-change HEAD while the announcement case is authored red.
 */
export function winBonusLine(model: object): string | null {
  const line = (model as { readonly winBonusLine?: unknown }).winBonusLine;
  return typeof line === 'string' && line !== '' ? line : null;
}

/**
 * The report-model options a landing supplies for the banked bonus.
 *
 * Cast-based on purpose: the field does not exist until
 * AH-0MWF2Q2JC008MAJE lands, and `tsc` must stay green before then.
 */
export function winBonusReportOptions(
  winBonusMinerals: number,
): BuildDefenceReportOptions {
  return { winBonusMinerals } as unknown as BuildDefenceReportOptions;
}

/**
 * Salvage banking at checkpoint moments
 * (AH-0MVUXC118004B4OX, part of **Build Candidate D — Hangar War**).
 *
 * The banking rules are pure, so these are table-driven contract tests over
 * the design of record (`docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *States*):
 * every checkpoint moment banks what the run has earned since the last one, a
 * repeated checkpoint never double-counts, and a lost run forfeits only its
 * **unbanked** salvage — the persistent balance is never reduced.
 *
 * The last case drives the real versioned store (`hangarWarStore`) through its
 * injectable in-memory storage, proving the banked balance survives the
 * `ai_hell_hangar_war` round trip.
 */

import { describe, expect, it } from 'vitest';

import {
  bankSalvage,
  bankedSalvageFromHangar,
  createBankedSalvage,
  forfeitUnbankedSalvage,
  runSalvageFromRun,
  unbankedSalvage,
  type BankedSalvage,
  type RunSalvageSource,
} from './salvageBanking';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from './hangarWarStore';
import { createInMemoryHangarWarStorage } from './storage';

/** A run snapshot at one checkpoint moment. */
function snapshot(
  runId: string,
  checkpointId: string,
  minerals: number,
  cores: number,
): RunSalvageSource {
  return { runId, checkpointId, minerals, cores };
}

describe('salvageBanking — pure checkpoint banking', () => {
  it('creates an empty bank, normalising unusable amounts to zero', () => {
    expect(createBankedSalvage()).toEqual({
      minerals: 0,
      cores: 0,
      runId: null,
      bankedThisRun: { minerals: 0, cores: 0 },
      lastCheckpointId: null,
    });
    // Fractional amounts floor; negative/NaN/Infinity are never banked.
    const bank = createBankedSalvage(7.9, -3);
    expect(bank.minerals).toBe(7);
    expect(bank.cores).toBe(0);
  });

  it('snapshots a run at a checkpoint moment (minerals held + cores earned)', () => {
    const salvage = runSalvageFromRun(snapshot('run-a', 'cp-1', 4.8, 1.2));

    expect(salvage).toEqual({
      runId: 'run-a',
      checkpointId: 'cp-1',
      minerals: 4,
      cores: 1,
    });
    // A corrupt count can never bank a negative or non-finite amount.
    const corrupt = runSalvageFromRun(snapshot('run-a', 'cp-1', -5, NaN));
    expect(corrupt.minerals).toBe(0);
    expect(corrupt.cores).toBe(0);
  });

  it('banks each checkpoint moment, adding only what was earned since the last', () => {
    const checkpoints: RunSalvageSource[] = [
      snapshot('run-a', 'cp-1', 3, 1),
      snapshot('run-a', 'cp-2', 7, 2),
      snapshot('run-a', 'cp-3', 7, 3),
      snapshot('run-a', 'cp-4', 12, 3),
    ];
    const expected: Array<{ minerals: number; cores: number }> = [
      { minerals: 3, cores: 1 },
      { minerals: 7, cores: 2 },
      { minerals: 7, cores: 3 },
      { minerals: 12, cores: 3 },
    ];

    let bank: BankedSalvage = createBankedSalvage();
    checkpoints.forEach((checkpoint, index) => {
      bank = bankSalvage(bank, runSalvageFromRun(checkpoint));
      expect({ minerals: bank.minerals, cores: bank.cores }).toEqual(
        expected[index],
      );
      expect(bank.lastCheckpointId).toBe(checkpoint.checkpointId);
    });
  });

  it('is idempotent per checkpoint: re-banking the same moment adds nothing', () => {
    const bank = bankSalvage(
      createBankedSalvage(),
      runSalvageFromRun(snapshot('run-a', 'cp-1', 5, 1)),
    );

    // The same checkpoint replayed (e.g. a hook fired twice) is a no-op…
    const replayed = bankSalvage(
      bank,
      runSalvageFromRun(snapshot('run-a', 'cp-1', 5, 1)),
    );
    expect(replayed).toEqual(bank);

    // …and an out-of-order replay of an earlier checkpoint can never reduce or
    // double-count the balance.
    const earlier = bankSalvage(
      replayed,
      runSalvageFromRun(snapshot('run-a', 'cp-0', 2, 0)),
    );
    expect(earlier.minerals).toBe(5);
    expect(earlier.cores).toBe(1);
  });

  it('banks only the increase when a repeated checkpoint carries more salvage', () => {
    let bank = bankSalvage(
      createBankedSalvage(),
      runSalvageFromRun(snapshot('run-a', 'cp-1', 4, 1)),
    );
    bank = bankSalvage(
      bank,
      runSalvageFromRun(snapshot('run-a', 'cp-1', 9, 2)),
    );

    expect(bank.minerals).toBe(9);
    expect(bank.cores).toBe(2);
  });

  it('a new run banks afresh even when it reuses the same checkpoint ids', () => {
    let bank = bankSalvage(
      createBankedSalvage(),
      runSalvageFromRun(snapshot('run-a', 'cp-1', 6, 1)),
    );
    bank = bankSalvage(
      bank,
      runSalvageFromRun(snapshot('run-b', 'cp-1', 4, 1)),
    );

    expect(bank.minerals).toBe(10);
    expect(bank.cores).toBe(2);
    expect(bank.runId).toBe('run-b');
  });

  it('builds the bank from a stored hangar balance', () => {
    const payload = createDefaultPayload(7);
    payload.hangar.bankedMinerals = 12;
    payload.hangar.bankedCores = 4;

    const bank = bankedSalvageFromHangar(payload.hangar);

    expect(bank).toEqual({
      minerals: 12,
      cores: 4,
      runId: null,
      bankedThisRun: { minerals: 0, cores: 0 },
      lastCheckpointId: null,
    });
  });

  it('spent minerals never reduce the bank, and later earnings still bank', () => {
    let bank = bankSalvage(
      createBankedSalvage(),
      runSalvageFromRun(snapshot('run-a', 'cp-1', 5, 0)),
    );
    // The player spends the hold on in-run rewards before the next checkpoint.
    bank = bankSalvage(
      bank,
      runSalvageFromRun(snapshot('run-a', 'cp-2', 2, 0)),
    );
    expect(bank.minerals).toBe(5);

    bank = bankSalvage(
      bank,
      runSalvageFromRun(snapshot('run-a', 'cp-3', 4, 0)),
    );
    expect(bank.minerals).toBe(7);
  });

  it('reports the unbanked salvage a death would forfeit', () => {
    const bank = bankSalvage(
      createBankedSalvage(10, 2),
      runSalvageFromRun(snapshot('run-a', 'cp-1', 5, 1)),
    );

    expect(
      unbankedSalvage(bank, runSalvageFromRun(snapshot('run-a', 'cp-2', 8, 3))),
    ).toEqual({ minerals: 3, cores: 2 });
    // A brand-new run has banked nothing, so all of it is at risk.
    expect(
      unbankedSalvage(bank, runSalvageFromRun(snapshot('run-b', 'cp-1', 8, 3))),
    ).toEqual({ minerals: 8, cores: 3 });
    // Never negative, even if the run's snapshot moved backwards.
    expect(
      unbankedSalvage(bank, runSalvageFromRun(snapshot('run-a', 'cp-2', 1, 0))),
    ).toEqual({ minerals: 0, cores: 0 });
  });

  it('losing a run forfeits only the unbanked salvage and never the balance', () => {
    const bank = bankSalvage(
      createBankedSalvage(10, 2),
      runSalvageFromRun(snapshot('run-a', 'cp-1', 5, 1)),
    );
    const atDeath = runSalvageFromRun(snapshot('run-a', 'cp-1', 9, 2));

    const outcome = forfeitUnbankedSalvage(bank, atDeath);

    // The persistent balance survives a game over untouched.
    expect(outcome.banked).toEqual(bank);
    // Only what was earned after the last bank is lost.
    expect(outcome.forfeited).toEqual({ minerals: 4, cores: 1 });
  });

  it('never mutates its inputs', () => {
    const bank = createBankedSalvage(3, 1);
    const source = snapshot('run-a', 'cp-1', 5, 2);
    const run = runSalvageFromRun(source);
    const bankBefore = JSON.parse(JSON.stringify(bank));
    const runBefore = JSON.parse(JSON.stringify(run));
    const sourceBefore = JSON.parse(JSON.stringify(source));

    bankSalvage(bank, run);
    unbankedSalvage(bank, run);
    forfeitUnbankedSalvage(bank, run);

    expect(bank).toEqual(bankBefore);
    expect(run).toEqual(runBefore);
    expect(source).toEqual(sourceBefore);
  });

  it('persists the banked balance through the versioned hangar-war store', () => {
    const storage = createInMemoryHangarWarStorage();
    const payload = createDefaultPayload(1234);
    let bank = createBankedSalvage(
      payload.hangar.bankedMinerals,
      payload.hangar.bankedCores,
    );
    bank = bankSalvage(
      bank,
      runSalvageFromRun(snapshot('run-a', 'cp-1', 6, 2)),
    );
    payload.hangar.bankedMinerals = bank.minerals;
    payload.hangar.bankedCores = bank.cores;
    expect(saveHangarWarPayload(payload, storage)).toBe(true);

    const loaded = loadHangarWarPayload(storage);
    expect(loaded).not.toBeNull();
    expect(loaded!.hangar.bankedMinerals).toBe(6);
    expect(loaded!.hangar.bankedCores).toBe(2);
    // The rest of the hangar payload is untouched by banking.
    expect(loaded!.hangar.unlockedHulls).toEqual(
      payload.hangar.unlockedHulls,
    );
  });
});

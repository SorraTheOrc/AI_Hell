/**
 * Fire-discipline A/B tests (AH-0MWPOET5A002IPTP · fire-discipline remediation).
 *
 * The producer's rejection is behavioural: the bot "will sometimes appear to be
 * firing at nothing". These tests make that a number and pin the fix: the same
 * documented scenario matrix is flown twice — the shipped unconditional
 * auto-fire (gate off) and the range-aware fire discipline (gate on) — and the
 * gate arm must be provably quiet without losing hits.
 */
import { describe, expect, it } from 'vitest';
import { runFireDiscipline, type FireDisciplineReport } from './aimAccuracy';

/**
 * The matrix is the aim-accuracy scenario set (5 classes × 3 seeds), flown
 * twice (gate off and on). It runs the live competent brain, the real governor
 * and the arena's ship physics, so it is a measured comparison rather than a
 * unit mock — hence the generous budget, matching the sibling accuracy harness.
 */
const report: FireDisciplineReport = runFireDiscipline();

describe('fire discipline A/B (AH-0MWPOET5A002IPTP)', () => {
  it('fires nothing at nothing when the gate is on', () => {
    for (const row of report.rows) {
      expect(
        row.gated.shotsAtNothing,
        `${row.movementClass}: gated arm fired at nothing`,
      ).toBe(0);
    }
    expect(report.gated.shotsAtNothing).toBe(0);
  });

  it('the ungated bot does fire at nothing (the reported defect)', () => {
    // The full matrix must show the defect, otherwise the A/B proves nothing.
    expect(
      report.ungated.shotsAtNothing,
      'the shipped unconditional trigger should fire off-target somewhere',
    ).toBeGreaterThan(0);
  });

  it('the gate only removes shots, never adds them', () => {
    for (const row of report.rows) {
      expect(row.gated.shotsFired).toBeLessThanOrEqual(row.ungated.shotsFired);
    }
    expect(report.gated.shotsFired).toBeLessThanOrEqual(
      report.ungated.shotsFired,
    );
  });

  it('the gate does not cost hits (hit rate is not worse)', () => {
    // Every gated-away shot had no live body in reach on its line, so it could
    // not have connected with the body it was aimed at. The measured gate must
    // therefore keep at least the ungated hit rate.
    expect(
      report.gated.hitRate,
      `gated ${report.gated.hitRate} vs ungated ${report.ungated.hitRate}`,
    ).toBeGreaterThanOrEqual(report.ungated.hitRate);
  }, 900_000);

  it('is deterministic across two runs', () => {
    const repeated = runFireDiscipline();
    expect(repeated).toEqual(report);
  }, 1_800_000);
});

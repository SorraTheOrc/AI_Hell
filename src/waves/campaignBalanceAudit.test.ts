/**
 * Campaign balance audit, seeded-dynamic determinism and gym↔game parity
 * (AH-0MV84TWEK001UBN2; parent AH-0MV29XQ0H009P9WP, F5; covers parent AC4/AC5).
 *
 * F5 is the verification feature of the balance-rule epic: it audits the
 * shipped campaign (built from `defaultDifficultyCurves()` through the public
 * `buildSequencedLevels()` API) with the **shared rule validator**
 * (`src/core/waveBalance.ts`), proves seeded-`dynamic` reproducibility, and
 * asserts gym↔game parity by construction.
 *
 * Coverage:
 * - **AC1 — campaign audit.** Every generated (`curve`/`dynamic`) wave of the
 *   shipped campaign satisfies R1–R3 when run through `auditWaves`; hand-
 *   authored `fixed` waves are excluded by design (reported `exempt`, never
 *   sequenced, no rules evaluated) per producer Q3=a.
 * - **AC2 — seeded-dynamic determinism.** The same seed yields an identical
 *   campaign; a different seed diverges on the `dynamic` waves only; rule
 *   enforcement stays a pure function of its inputs (identical across
 *   rebuilds, different across seeds).
 * - **AC3 — gym↔game parity.** `GymCurveSequencer`'s preview delegates verbatim
 *   to the shared `sequencer` (and via it the shared rule module), so the gym
 *   and the game campaign run the same rule-enforcing code path — asserted
 *   through the shared API, not by grepping for duplicate copies.
 * - **AC4 — enforcement cost.** Per-wave target-difficulty error growth caused
 *   by rule enforcement (R2/R3 repair) is measured for the documented
 *   campaign. The measured vector is pinned below so a change to the rules,
 *   the curve or the pool that alters the enforcement cost fails this test
 *   and forces the documentation (F6, AH-0MV84U0Y2006KXE8) to be updated.
 * - **AC5 — playability.** The shipped campaign is complete (all ten levels,
 *   every wave a non-empty, non-zero composition); the existing
 *   `campaignInvariants.test.ts` / `campaignRoster.test.ts` suites continue to
 *   pin the shape and roster invariants.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildSequencedLevels, type SequencerFn } from './sequencedLevels';
import { getLevelDefinition, type LevelDefinition } from './Formations';
import { defaultDifficultyCurves } from '../core/configStore';
import { defaultCandidatePool, sequencer } from '../core/difficultySequencer';
import {
  auditWaves,
  classifyWaveGroups,
  isOpeningWavePosition,
  type BalancedWave,
  type BalanceAudit,
} from '../core/waveBalance';
import {
  CURVE_TARGET_TOLERANCE,
  sequenceVariedWaves,
} from '../scenes/gym/GymCurveSequencer';
import type { DifficultyCurveRow } from '../core/configTypes';

// ── Helpers ───────────────────────────────────────────────────────────

/** Round to two decimal places, matching the sequencer's recorded error. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The default campaign's rows in build order (level, then wave). */
function campaignRows(): DifficultyCurveRow[] {
  return [...defaultDifficultyCurves()].sort(
    (a, b) => a.level - b.level || a.wave - b.wave,
  );
}

/** Rows whose wave is generated (`curve` or `dynamic`), in build order. */
function generatedRows(): DifficultyCurveRow[] {
  return campaignRows().filter((row) => (row.generation ?? 'curve') !== 'fixed');
}

/** Rows whose wave is hand-authored (`fixed`), in build order. */
function fixedRows(): DifficultyCurveRow[] {
  return campaignRows().filter((row) => (row.generation ?? 'curve') === 'fixed');
}

/**
 * The shipped campaign, built explicitly from `defaultDifficultyCurves()`
 * through the public builder (the AC pins the default curve, not whatever CSV
 * the config store may have loaded at boot). `seed` defaults to the builder's
 * own default of `0`.
 */
function buildDefaultCampaign(seed = 0): LevelDefinition[] {
  return buildSequencedLevels(defaultDifficultyCurves(), undefined, { seed });
}

/**
 * Audit the shipped campaign with the shared validator, mapping each curve
 * row to its built wave (the config defines the wave count of every level).
 *
 * Every row's `generation` is carried into the {@link BalancedWave}, so
 * `fixed` waves are reported `exempt` by the validator (Q3=a) and generated
 * waves are checked against R1–R3. This mirrors exactly how the campaign
 * builder and the sequencer consume the shared rule module.
 */
function auditShippedCampaign(
  campaign: LevelDefinition[] = buildDefaultCampaign(),
): { audit: BalanceAudit; waves: BalancedWave[] } {
  const byLevel = new Map(campaign.map((level) => [level.level, level]));
  const waves: BalancedWave[] = campaignRows().map((row) => {
    const level = byLevel.get(row.level);
    const wave = level?.waves[row.wave - 1];
    if (!wave) {
      throw new Error(
        `Campaign audit cannot map L${row.level}W${row.wave}: no built wave.`,
      );
    }
    return {
      id: `${row.level}:${row.wave}`,
      groups: classifyWaveGroups(wave.groups),
      shootEnabled: wave.shootEnabled,
      isOpening: isOpeningWavePosition(row.level, row.wave),
      generation: row.generation ?? 'curve',
    };
  });
  return { audit: auditWaves(waves), waves };
}

/** The campaign with the given seed, built through the public API. */
function seededCampaign(seed: number): LevelDefinition[] {
  return buildDefaultCampaign(seed);
}

/**
 * Instrument the campaign build to measure per-wave target-difficulty error.
 *
 * The builder's injectable sequencer seam is used to capture, for every
 * generated wave, the error reported by the shared sequencer **with** rule
 * enforcement (as shipped) and **without** it. The un-enforced probe runs
 * against a snapshot of the builder's per-level archetype-usage map so it
 * cannot perturb the campaign build, and keeps the caller's R1
 * `ruleConstraints` so only the R2/R3 enforcement is isolated.
 */
function measureEnforcementError(seed = 0): Array<{
  level: number;
  wave: number;
  target: number;
  unenforcedError: number;
  enforcedError: number;
  growth: number;
}> {
  const probes: Array<{
    target: number;
    unenforcedError: number;
    enforcedError: number;
  }> = [];
  const spy: SequencerFn = (curve, candidates, options = {}) => {
    const target = curve[0];
    const usageSnapshot = options.archetypeUsage
      ? new Map(options.archetypeUsage)
      : undefined;
    const enforced = sequencer(curve, candidates, {
      ...options,
      enforceRules: true,
    });
    const unenforced = sequencer(curve, candidates, {
      ...options,
      enforceRules: false,
      ...(usageSnapshot ? { archetypeUsage: usageSnapshot } : {}),
    });
    probes.push({
      target,
      unenforcedError: round2(unenforced.errors[0] ?? 0),
      enforcedError: round2(enforced.errors[0] ?? 0),
    });
    return enforced;
  };

  const campaign = buildSequencedLevels(defaultDifficultyCurves(), undefined, {
    sequencer: spy,
    seed,
  });
  if (campaign.length === 0) {
    throw new Error('measureEnforcementError: campaign is empty.');
  }
  const rows = generatedRows();
  if (probes.length !== rows.length) {
    throw new Error(
      `measureEnforcementError: ${probes.length} sequencer calls for ${rows.length} generated rows.`,
    );
  }
  return probes.map((probe, index) => {
    const row = rows[index];
    return {
      level: row.level,
      wave: row.wave,
      target: probe.target,
      unenforcedError: probe.unenforcedError,
      enforcedError: probe.enforcedError,
      growth: round2(probe.enforcedError - probe.unenforcedError),
    };
  });
}

// ── AC1 — campaign audit with the shared validator ────────────────────

describe('shipped campaign balance audit (AC1)', () => {
  it('passes every generated (curve/dynamic) wave through the shared validator', () => {
    const { audit, waves } = auditShippedCampaign();
    expect(audit.pass).toBe(true);

    const generated = waves.filter(
      (wave) => (wave.generation ?? 'curve') !== 'fixed',
    );
    expect(generated.length).toBeGreaterThan(0);
    waves.forEach((wave, index) => {
      if ((wave.generation ?? 'curve') === 'fixed') return;
      const verdict = audit.waves[index];
      expect(verdict.pass, `${wave.id}: ${verdict.rules.map((r) => r.message).join(' ')}`).toBe(
        true,
      );
      expect(verdict.exempt).toBe(false);
      expect(verdict.rules.map((r) => r.id)).toEqual(['R1', 'R2', 'R3']);
    });
  });

  it('excludes hand-authored fixed waves from the audit by design (Q3=a)', () => {
    const { audit, waves } = auditShippedCampaign();
    const fixed = waves.filter((wave) => wave.generation === 'fixed');
    expect(fixed.length).toBeGreaterThan(0);
    waves.forEach((wave, index) => {
      if (wave.generation !== 'fixed') return;
      const verdict = audit.waves[index];
      expect(verdict.exempt, `${wave.id} should be exempt`).toBe(true);
      expect(verdict.pass).toBe(true);
      expect(verdict.rules).toHaveLength(0);
    });
  });

  it('never sequences a fixed wave that has a static counterpart', () => {
    // A spy over the real sequencer proves the builder makes one call per
    // generated wave and none for hand-authored fixed waves.
    const spy = vi.fn(sequencer);
    const campaign = buildSequencedLevels(defaultDifficultyCurves(), undefined, {
      sequencer: spy,
    });
    expect(spy).toHaveBeenCalledTimes(generatedRows().length);

    // Every fixed wave is taken verbatim from the static skeleton (reference
    // identity), so the authored composition is unchanged by rule
    // enforcement.
    for (const row of fixedRows()) {
      const staticLevel = getLevelDefinition(row.level);
      expect(staticLevel, `L${row.level} has no static definition`).not.toBeNull();
      const builtLevel = campaign.find((level) => level.level === row.level);
      expect(builtLevel, `L${row.level} missing from campaign`).toBeDefined();
      expect(builtLevel!.waves[row.wave - 1]).toBe(staticLevel!.waves[row.wave - 1]);
    }
  });

  it('exercises every audit mode across the shipped campaign', () => {
    const { audit, waves } = auditShippedCampaign();
    const generations = new Set(waves.map((wave) => wave.generation));
    expect(generations.has('curve')).toBe(true);
    expect(generations.has('dynamic')).toBe(true);
    expect(generations.has('fixed')).toBe(true);
    expect(audit.waves.some((wave) => wave.exempt)).toBe(true);
    expect(audit.waves.some((wave) => !wave.exempt)).toBe(true);
  });
});

// ── AC2 — seeded-dynamic determinism ──────────────────────────────────

describe('seeded-dynamic reproducibility (AC2)', () => {
  it('builds an identical campaign for the same seed', () => {
    expect(seededCampaign(7)).toEqual(seededCampaign(7));
    expect(seededCampaign(42)).toEqual(seededCampaign(42));
  });

  it('diverges across seeds on dynamic waves only', () => {
    const seedA = seededCampaign(1);
    const seedB = seededCampaign(2);
    expect(seedB).not.toEqual(seedA);

    // Curve and fixed waves are seed-independent: only dynamic waves differ,
    // so every differing wave sits at a configured dynamic position.
    for (let li = 0; li < seedA.length; li++) {
      const levelA = seedA[li];
      const levelB = seedB[li];
      expect(levelB.level).toBe(levelA.level);
      expect(levelB.waves.length).toBe(levelA.waves.length);
      for (let wi = 0; wi < levelA.waves.length; wi++) {
        const sameWave =
          JSON.stringify(levelA.waves[wi]) === JSON.stringify(levelB.waves[wi]);
        if (!sameWave) {
          const row = campaignRows().find(
            (r) => r.level === levelA.level && r.wave === wi + 1,
          );
          expect(row, `no config row for L${levelA.level}W${wi + 1}`).toBeDefined();
          expect(row!.generation, `L${row!.level}W${row!.wave} differs across seeds`).toBe(
            'dynamic',
          );
        }
      }
    }
  });

  it('keeps the generated waves of every seed R1–R3 compliant (deterministic enforcement)', () => {
    for (const seed of [0, 1, 2, 5]) {
      const { audit } = auditShippedCampaign(seededCampaign(seed));
      expect(audit.pass, `seed ${seed} violates a rule`).toBe(true);
    }
  });

  it('is deterministic with and without rule enforcement', () => {
    const pool = defaultCandidatePool();
    const withRules = sequencer([40, 60], pool);
    const withRulesAgain = sequencer([40, 60], pool);
    expect(withRulesAgain).toEqual(withRules);

    const withoutRules = sequencer([40, 60], pool, { enforceRules: false });
    const withoutRulesAgain = sequencer([40, 60], pool, { enforceRules: false });
    expect(withoutRulesAgain).toEqual(withoutRules);
  });
});

// ── AC3 — gym↔game parity by construction ────────────────────────────

describe('gym↔game parity (AC3)', () => {
  it('the gym preview delegates verbatim to the shared sequencer', () => {
    const pool = defaultCandidatePool();
    const target = 30;
    const gym = sequenceVariedWaves([target], pool, CURVE_TARGET_TOLERANCE);
    const core = sequencer([target], pool, {
      tolerance: CURVE_TARGET_TOLERANCE,
    });
    expect(gym).toEqual(core.waves);
  });

  it('the game campaign and the gym preview both satisfy the shared rules', () => {
    // Game: the shipped campaign built from the shared core + rules.
    expect(auditShippedCampaign().audit.pass).toBe(true);

    // Gym: the curve-editor pipeline (shared sequencer, shared pool, shared
    // rule module) produces rule-compliant waves for representative targets.
    const gymWaves = sequenceVariedWaves([30, 55, 80]);
    const gymAudit = auditWaves(
      gymWaves.map((wave, index) => ({
        id: `gym:${index + 1}`,
        groups: classifyWaveGroups(wave.groups),
        shootEnabled: wave.shootEnabled,
      })),
    );
    const failures = gymAudit.waves
      .filter((wave) => !wave.pass)
      .map((wave) => `${wave.id}: ${wave.rules.map((r) => r.message).join(' ')}`);
    expect(gymAudit.pass, failures.join(' | ')).toBe(true);
  });
});

// ── AC4 — enforcement cost (per-wave target-error growth) ─────────────

describe('rule-enforcement target-error growth (AC4)', () => {
  /**
   * Pinned per-wave measurement for the documented campaign (F6 reference).
   *
   * Recorded by {@link measureEnforcementError} for the shipped curve, pool
   * and seed `0`. `unenforced` is the sequencer's error with R2/R3 repair
   * disabled; `enforced` is the shipped error with the shared rules active.
   * The two late-campaign waves whose raw composition is all-ranged are
   * repaired with a tuned contact group that happens to land *closer* to the
   * target, so the enforcement cost is zero or negative — rules never widen
   * the recorded target gap for this campaign.
   *
   * Any change to the rules, the curve or the candidate pool that moves these
   * values must update the balance documentation (F6, AH-0MV84U0Y2006KXE8).
   */
  const EXPECTED_ENFORCEMENT_COST: ReadonlyArray<{
    level: number;
    wave: number;
    unenforced: number;
    enforced: number;
  }> = [
    { level: 1, wave: 1, unenforced: 0.28, enforced: 0.28 },
    { level: 1, wave: 2, unenforced: 5.17, enforced: 5.17 },
    { level: 2, wave: 1, unenforced: 4.37, enforced: 4.37 },
    { level: 2, wave: 2, unenforced: 4.49, enforced: 4.49 },
    { level: 4, wave: 1, unenforced: 0.1, enforced: 0.1 },
    { level: 4, wave: 2, unenforced: 0.09, enforced: 0.09 },
    { level: 4, wave: 3, unenforced: 0.31, enforced: 0.31 },
    { level: 5, wave: 1, unenforced: 0.03, enforced: 0.03 },
    { level: 5, wave: 2, unenforced: 1.95, enforced: 1.95 },
    { level: 6, wave: 3, unenforced: 0.08, enforced: 0.08 },
    { level: 6, wave: 4, unenforced: 1.59, enforced: 1.59 },
    { level: 7, wave: 3, unenforced: 0.71, enforced: 0.71 },
    { level: 7, wave: 4, unenforced: 0.2, enforced: 0.2 },
    { level: 9, wave: 3, unenforced: 6.89, enforced: 3.45 },
    { level: 10, wave: 2, unenforced: 8.89, enforced: 1.45 },
  ];

  /** The sequencer's default per-wave acceptance tolerance (campaign build). */
  const SEQUENCER_TOLERANCE = 10;

  it('measures the shipped campaign per-wave enforcement cost', () => {
    const measured = measureEnforcementError();
    expect(
      measured.map((wave) => ({
        level: wave.level,
        wave: wave.wave,
        unenforced: wave.unenforcedError,
        enforced: wave.enforcedError,
      })),
    ).toEqual(EXPECTED_ENFORCEMENT_COST);
  });

  it('keeps every enforced wave inside the sequencer acceptance band', () => {
    for (const wave of measureEnforcementError()) {
      const label = `L${wave.level}W${wave.wave}`;
      expect(wave.enforcedError, label).toBeLessThanOrEqual(SEQUENCER_TOLERANCE);
      expect(wave.unenforcedError, label).toBeGreaterThanOrEqual(0);
      // Enforcement never increases the recorded target gap for this
      // campaign (it is zero or negative growth — rules can even narrow it).
      expect(wave.growth, label).toBeLessThanOrEqual(0);
    }
  });

  it('proves enforcement actually binds somewhere in the campaign', () => {
    // At least one wave must have a non-zero enforcement cost, otherwise the
    // measurement would not exercise the R2/R3 repair at all.
    const measured = measureEnforcementError();
    expect(measured.some((wave) => wave.growth !== 0)).toBe(true);
  });
});

// ── AC5 — playability of the shipped campaign ─────────────────────────

describe('shipped campaign playability (AC5)', () => {
  it('ships all ten levels with a non-empty, non-zero composition per wave', () => {
    const campaign = buildDefaultCampaign();
    expect(campaign.map((level) => level.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const level of campaign) {
      expect(level.waves.length, `L${level.level} has no waves`).toBeGreaterThan(0);
      for (let wi = 0; wi < level.waves.length; wi++) {
        const wave = level.waves[wi];
        const label = `L${level.level}W${wi + 1}`;
        expect(wave.groups.length, label).toBeGreaterThan(0);
        const count = wave.groups.reduce((sum, group) => sum + group.count, 0);
        expect(count, label).toBeGreaterThan(0);
      }
    }
  });

  it('matches the configured wave count for every level', () => {
    const byLevel = new Map<number, number>();
    for (const row of campaignRows()) {
      byLevel.set(row.level, (byLevel.get(row.level) ?? 0) + 1);
    }
    for (const level of buildDefaultCampaign()) {
      expect(level.waves.length).toBe(byLevel.get(level.level) ?? 0);
    }
  });
});

// ── 10-wave campaign verification harness (AH-0MVCRAHWO0007US2) ──
//
// Test-first verification for the expanded campaign (epic AH-0MVCC8XSS007P01Z):
// the shipped curve must configure exactly 10 waves per level (100 rows), so
// the balance audit spans the full expanded grid.
//
// GREEN once the campaign-data item (AH-0MVCYANT6003SG5C) landed the 10-wave
// rows, so the pins run as plain `it` and hard-gate the shipped shape.
describe('10-wave campaign verification harness — wave counts (AH-0MVCRAHWO0007US2)', () => {
  it('AC3 — the shipped curve configures exactly 10 waves per level (100 rows)', () => {
    const rows = campaignRows();
    expect(rows).toHaveLength(100);
    const perLevel = new Map<number, number>();
    for (const row of rows) {
      perLevel.set(row.level, (perLevel.get(row.level) ?? 0) + 1);
    }
    for (let level = 1; level <= 10; level++) {
      expect(perLevel.get(level), `L${level} configured wave count`).toBe(10);
    }
  });

  it('AC2 — every level has a wave-10 row to map its mini-boss encounter', () => {
    const rows = campaignRows();
    for (let level = 1; level <= 10; level++) {
      expect(
        rows.some((row) => row.level === level && row.wave === 10),
        `L${level} has no wave-10 row`,
      ).toBe(true);
    }
  });
});

/**
 * Campaign variety verification — the C1 evidence item of the
 * "waves need more variation in enemy types" epic (AH-0MVSE7ILL000Y27B;
 * parent AH-0MVI5XXOU00954EA).
 *
 * This file is **verification only**: it changes no behaviour. It closes the
 * one coverage gap the sibling items left open — every campaign-wide variety
 * assertion in `campaignVariety.test.ts` runs at the **default seed only**,
 * while a `dynamic` wave is a function of the run seed and can therefore
 * shift a level's archetype set (Level 5 fields six archetypes at seeds 0, 7
 * and 42 but seven at seed 1) and, in principle, its dominant archetype.
 * The evidence below re-runs the AC1–AC3 invariants over a seed sweep, so the
 * "varied campaign" claim holds for generated campaigns and not just for
 * seed 0.
 *
 * Coverage map for this item's acceptance criteria:
 *
 * - **AC1 (adjacent distinctness over the seed sweep)** — asserted here for
 *   all 100 waves of every seeded campaign. The default-seed aggregate and the
 *   per-level assertions live in `campaignVariety.test.ts`; the generated-wave
 *   R4 constraint over ten seeds lives in `modeLedger.test.ts`.
 * - **AC2 (≥ 2 archetypes per level) and AC3 (dominant identity + showcase)**
 *   — asserted here for all ten levels of every seeded campaign, with the
 *   default-seed measurements pinned as the recorded evidence.
 * - **AC4 (R1–R4 balance rules and enforcement cost)** — covered by
 *   `campaignBalanceAudit.test.ts` (pinned per-wave enforcement cost and the
 *   sequencer acceptance band) and `modeLedger.test.ts`'s multi-seed R1–R4
 *   sweep; not duplicated here.
 * - **AC5 (difficulty ramp, fire boundary, wave shape, mini-boss pins)** —
 *   covered by `campaignInvariants.test.ts` and the
 *   "Retuned default campaign (AH-0MUJSUTXI008NP8K)" block in
 *   `sequencedLevels.test.ts`. The campaign shape pinned below (ten levels of
 *   ten waves) is the joint precondition those suites rely on.
 * - **AC6/AH-0MVSE7ILL AC5 (determinism)** — the byte-level same-seed rebuild
 *   identity, seed independence of `curve`/`fixed` waves and divergence of
 *   `dynamic` waves are asserted here at the campaign level (the ledger-level
 *   version of the same contract is `modeLedger.test.ts` AC3; this one is
 *   deliberately stricter — it compares serialised campaigns so key order or
 *   an `undefined` field cannot slip through `toEqual`).
 * - **Gym↔game parity** — covered by `campaignBalanceAudit.test.ts` AC3 and
 *   `src/scenes/core/CombatScene.equivalence.test.ts`; both consumers build
 *   from the same shared modules, so nothing is duplicated here.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';

import { buildSequencedLevels } from './sequencedLevels';
import {
  LEVEL_IDENTITY,
  auditCampaignVariety,
  waveComposition,
  type CampaignVarietyAudit,
} from './campaignVariety';
import { buildModeLedger, countModes } from './modeLedger';
import { defaultDifficultyCurves } from '../core/configStore';
import type { LevelDefinition } from './Formations';

// ── Evidence fixtures ───────────────────────────────────────────────

/**
 * The seed sweep used as evidence: the builder default plus three further
 * seeds, which is the minimum the work item asks for and enough to move the
 * `dynamic` compositions (see the module docblock).
 */
const EVIDENCE_SEEDS = [0, 1, 7, 42] as const;

/** The shipped per-wave mode ledger (mode data derived from the config). */
const MODE_LEDGER = buildModeLedger();

/** Build the shipped campaign for one run seed through the public API. */
function campaign(seed: number): LevelDefinition[] {
  return buildSequencedLevels(defaultDifficultyCurves(), undefined, { seed });
}

/** Audit one seeded campaign with the shared variety audit. */
function audit(seed: number): CampaignVarietyAudit {
  return auditCampaignVariety(campaign(seed));
}

// ── AC1 — adjacent distinctness over the seed sweep ─────────────────

describe('campaign variety across the seed sweep (AC1)', () => {
  it('keeps every seeded campaign adjacent-distinct across all 100 waves', () => {
    for (const seed of EVIDENCE_SEEDS) {
      const result = audit(seed);
      expect(result.totalWaves, `seed ${seed} wave count`).toBe(100);
      expect(
        result.adjacentDuplicates,
        `seed ${seed} adjacent duplicates: ${result.adjacentDuplicates
          .map(
            (duplicate) =>
              `L${duplicate.level}W${duplicate.previousWave}/W${duplicate.wave} (${duplicate.composition})`,
          )
          .join(', ')}`,
      ).toEqual([]);
      expect(result.distinct, `seed ${seed} campaign distinct`).toBe(true);
    }
  });

  it('ships ten levels of ten waves for every seed', () => {
    for (const seed of EVIDENCE_SEEDS) {
      const built = campaign(seed);
      expect(built.map((level) => level.level), `seed ${seed} levels`).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      for (const level of built) {
        expect(level.waves.length, `seed ${seed} L${level.level} waves`).toBe(
          10,
        );
      }
    }
  });
});

// ── AC2/AC3 — per-level variety and identity over the seed sweep ────

describe('per-level variety and identity across the seed sweep (AC2/AC3)', () => {
  it('gives every level at least two archetypes in every seeded campaign (AC2)', () => {
    for (const seed of EVIDENCE_SEEDS) {
      for (const entry of audit(seed).levels) {
        expect(
          entry.distinctArchetypeCount,
          `seed ${seed} L${entry.level} delivers ${entry.distinctArchetypes.join(', ')}`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('keeps every level’s documented dominant archetype and showcase at every seed (AC3)', () => {
    for (const seed of EVIDENCE_SEEDS) {
      for (const entry of audit(seed).levels) {
        const identity = LEVEL_IDENTITY[entry.level];
        expect(identity, `L${entry.level} identity`).toBeDefined();
        if (identity.dominant !== null) {
          expect(
            entry.dominantArchetype,
            `seed ${seed} L${entry.level} dominant archetype`,
          ).toBe(identity.dominant);
        }
        for (const key of identity.showcase) {
          expect(
            entry.distinctArchetypes,
            `seed ${seed} L${entry.level} ${identity.label} showcase ${key}`,
          ).toContain(key);
        }
      }
    }
  });
});

// ── AC6 — determinism over the rebuilt campaign ────────────────────

describe('determinism over the rebuilt campaign (AH-0MVSE7ILL000Y27B AC5)', () => {
  it('reproduces a byte-identical campaign for the same seed', () => {
    for (const seed of EVIDENCE_SEEDS) {
      expect(
        JSON.stringify(campaign(seed)),
        `seed ${seed} rebuild`,
      ).toBe(JSON.stringify(campaign(seed)));
    }
  });

  it('keeps curve and fixed waves seed-independent and lets dynamic waves diverge', () => {
    const baseline = campaign(EVIDENCE_SEEDS[0]);
    const dynamicRows = MODE_LEDGER.filter((row) => row.mode === 'dynamic');
    expect(dynamicRows.length).toBeGreaterThan(0);

    for (const seed of EVIDENCE_SEEDS) {
      const built = campaign(seed);
      for (const row of MODE_LEDGER) {
        if (row.mode === 'dynamic') continue;
        const label = `seed ${seed} L${row.level}W${row.wave} (${row.mode})`;
        expect(JSON.stringify(built[row.level - 1].waves[row.wave - 1]), label).toBe(
          JSON.stringify(baseline[row.level - 1].waves[row.wave - 1]),
        );
      }
    }

    // The sweep really does exercise the seeded path: the dynamic waves'
    // compositions are not all identical across the seeds.
    const patterns = new Set(
      EVIDENCE_SEEDS.map((seed) => {
        const built = campaign(seed);
        return dynamicRows
          .map((row) =>
            waveComposition(built[row.level - 1].waves[row.wave - 1]),
          )
          .join('|');
      }),
    );
    expect(patterns.size).toBeGreaterThan(1);
  });
});

// ── Recorded evidence snapshot (AC8) ───────────────────────────────

/**
 * The measurements the verification report quotes: the mode ledger counts and
 * the default-seed per-level variety audit. Pinning them keeps the recorded
 * report honest — a campaign change that alters these numbers fails here and
 * forces the report (and the GDD identity table) to be revisited rather than
 * silently drifting.
 */
describe('recorded campaign evidence snapshot (AC8)', () => {
  it('records the shipped mode mix as curve 10 / fixed 85 / dynamic 5', () => {
    expect(countModes(MODE_LEDGER)).toEqual({
      curve: 10,
      fixed: 85,
      dynamic: 5,
    });
  });

  it('records the default-seed per-level archetype counts and dominant archetype', () => {
    const measured = audit(0).levels.map((entry) => ({
      level: entry.level,
      count: entry.distinctArchetypeCount,
      dominant: entry.dominantArchetype,
    }));
    expect(measured).toEqual([
      { level: 1, count: 3, dominant: 'scout' },
      { level: 2, count: 3, dominant: 'diver' },
      { level: 3, count: 4, dominant: 'tank' },
      { level: 4, count: 7, dominant: 'tank' },
      { level: 5, count: 6, dominant: 'phaser' },
      { level: 6, count: 9, dominant: 'march' },
      { level: 7, count: 10, dominant: 'tank' },
      { level: 8, count: 8, dominant: 'swarm' },
      { level: 9, count: 9, dominant: 'phaser' },
      { level: 10, count: 12, dominant: 'swarm' },
    ]);
  });
});

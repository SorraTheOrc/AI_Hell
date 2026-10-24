/**
 * Scaled-campaign determinism and invariant tests (AH-0MVLJF1PO000PB21).
 *
 * **TEST-FIRST.** These tests pin how the level enemy-count multiplier
 * (`src/core/levelScaling.ts`, AH-0MVLJEE7O008RX9X) reaches the campaign —
 * the static `LEVELS` campaign and the sequenced campaign (all three
 * generation modes) — without breaking determinism or the authored campaign
 * invariants. The scaling seam is F2 (AH-0MVLJF30O000E3J3): **F2 has since
 * flipped every `it.fails` back to `it`** — the seam lives in
 * `resolveCampaignLevels` (`src/scenes/PlayScene.ts`), which scales both the
 * static `LEVELS` campaign and the sequenced campaign exactly once.
 * (The repo's red-before/green-after convention is documented in
 * `src/core/levelScaling.test.ts` and
 * `src/powerups/powerUpIdNaming.test.ts`.) The guards that already held
 * (single scaling module, composition invariance, campaign invariants,
 * determinism) run as
 * plain `it` and hard-gate from day one.
 *
 * ## What is pinned, and where
 *
 * The **contract** of `applyEnemyCountScaling` (rounding half up, floor of 1,
 * 200-per-group cap, `single` groups at exactly 1, level-1 identity) is
 * already pinned by `src/core/levelScaling.test.ts`; this suite deliberately
 * does **not** re-test it. It consumes the helper as the documented spec and
 * asserts the *seam* applies it exactly once:
 *
 * - **Static `LEVELS` campaign** — level 1 is byte-identical to the authored
 *   data, every level `L` carries `applyEnemyCountScaling(L, authored)`, and
 *   level 10 grows by the documented 2.00× multiplier with the documented
 *   rounding.
 * - **Sequenced campaign** — the same seam scales `fixed`, `curve` **and**
 *   `dynamic` waves. A stub sequencer with a known baseline count is injected
 *   so the expected post-scaling counts are exact and independent of where
 *   inside the build pipeline the seam lives (the campaign is always built
 *   through the public `resolveCampaignLevels` → `buildSequencedLevels`
 *   path the game uses).
 * - **Determinism** — same-seed builds are byte-identical, a second build of
 *   the same campaign is idempotent (no cumulative/double scaling), and the
 *   authored `LEVELS` data is never mutated in place.
 * - **Existing invariants** — the scaled campaign keeps the authored
 *   composition (archetypes, formations, spawner flags, wave counts,
 *   mini-boss markers), satisfies R1–R3 through the shared rule validator,
 *   keeps roster coverage, and stays inside the per-group safety cap.
 * - **Parity seam** — the scaling maths is defined once
 *   (`src/core/levelScaling.ts`) and every campaign-seam consumer imports it
 *   from there rather than carrying a duplicated copy (AGENTS.md gym↔game
 *   parity).
 *
 * All assertions run through public APIs (`resolveCampaignLevels`,
 * `buildSequencedLevels`, `LEVELS`, the shared rule module) — no production
 * code is modified by this item.
 *
 * @module waves/scaledCampaign.test
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyEnemyCountScaling } from '../core/levelScaling';
import { DEFAULT_RULES } from '../core/rules';
import {
  LEVELS,
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
  type WaveGroup,
} from './Formations';
import { buildSequencedLevels, type SequencerFn } from './sequencedLevels';
import type { AdjustedGroup } from '../core/difficultySequencer';
import { defaultDifficultyCurves } from '../core/configStore';
import type {
  DifficultyCurveRow,
  DifficultyGeneration,
} from '../core/configTypes';
import { resolveCampaignLevels } from '../scenes/PlayScene';
import {
  auditWaves,
  classifyWaveGroups,
  isOpeningWavePosition,
  type BalancedWave,
} from '../core/waveBalance';
import { GHOST_ENEMY_KEYS } from './GhostSpawner';
import { GRUNT_ENEMY_KEY } from './HordeSpawner';
import { CENTIPEDE_ENEMY_KEY } from './CentipedeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from './LaneTrafficSpawner';
import {
  collectProductionSourceFiles,
  definesFunction,
} from '../test/duplicateBodyGuard';

// ── Pristine authored baseline (mutation detector) ───────────────────

/**
 * The authored `LEVELS` data snapshotted at import time, before any test can
 * build a campaign. Comparing against this snapshot (rather than against the
 * live `LEVELS` object) is what makes an in-place mutation of the authored
 * data detectable: a seam that scaled `LEVELS` in place would corrupt the
 * source of truth and double-scale every later build.
 */
const AUTHORED_LEVELS_SNAPSHOT = JSON.stringify(LEVELS);

/** Per-level authored group counts, snapshotted at import time. */
const AUTHORED_COUNTS: ReadonlyMap<number, readonly number[]> = new Map(
  LEVELS.map((level) => [
    level.level,
    level.waves.flatMap((wave) => wave.groups.map((group) => group.count)),
  ]),
);

/** Per-level authored groups (copies), snapshotted at import time. */
const AUTHORED_GROUPS: ReadonlyMap<number, readonly (readonly WaveGroup[])[]> =
  new Map(
    LEVELS.map((level) => [
      level.level,
      level.waves.map((wave) => wave.groups.map((group) => ({ ...group }))),
    ]),
  );

// ── Campaign entry seams ─────────────────────────────────────────────

/** Rules with the sequenced campaign disabled (the static `LEVELS` path). */
const STATIC_RULES = { sequencedWavesEnabled: false } as const;

/** Rules with the sequenced campaign enabled (the generated path). */
const SEQUENCED_RULES = { sequencedWavesEnabled: true } as const;

/** The campaign the game plays when `sequencedWavesEnabled` is off. */
function staticCampaign(): LevelDefinition[] {
  return resolveCampaignLevels(STATIC_RULES);
}

/**
 * The campaign the game plays when `sequencedWavesEnabled` is on, built from
 * the default difficulty curve through the public builder (the same
 * `resolveCampaignLevels` → `buildSequencedLevels` pipeline `PlayScene` uses).
 */
function sequencedCampaign(seed = 0): LevelDefinition[] {
  return resolveCampaignLevels(SEQUENCED_RULES, () =>
    buildSequencedLevels(defaultDifficultyCurves(), undefined, { seed }),
  );
}

// ── Count helpers ────────────────────────────────────────────────────

/** Flat `count` vector of a level, in wave/group order. */
function countsOf(level: LevelDefinition): number[] {
  return level.waves.flatMap((wave) => wave.groups.map((group) => group.count));
}

/** Flat `count` vector of a list of waves, in wave/group order. */
function countsOfWaves(waves: readonly WaveDefinition[]): number[] {
  return waves.flatMap((wave) => wave.groups.map((group) => group.count));
}

/**
 * The documented single-application scaling of `waves` at `level`, computed
 * with the shared helper (the spec, pinned by `levelScaling.test.ts`).
 */
function expectedScaledCounts(
  level: number,
  waves: readonly WaveDefinition[],
): number[] {
  return waves.flatMap((wave) =>
    applyEnemyCountScaling(level, wave.groups).map((group) => group.count),
  );
}

/** The documented scaling of a list of group-count vectors at `level`. */
function expectedScaledGroupCounts(
  level: number,
  groupsPerWave: readonly (readonly WaveGroup[])[],
): number[] {
  return groupsPerWave.flatMap((groups) =>
    applyEnemyCountScaling(level, groups).map((group) => group.count),
  );
}

/** Total spawned enemies declared by a level (`count` sum, not geometry). */
function totalCount(level: LevelDefinition): number {
  return countsOf(level).reduce((sum, count) => sum + count, 0);
}

/** The level with the given number from a campaign, or a loud failure. */
function levelFrom(campaign: LevelDefinition[], level: number): LevelDefinition {
  const found = campaign.find((entry) => entry.level === level);
  if (!found) throw new Error(`Campaign has no level ${level}`);
  return found;
}

// ── Stub sequencer: known baseline counts for exact scaling pins ─────

/** Baseline `count` the stub sequencer puts in every generated group. */
const STUB_BASELINE_COUNT = 5;

/**
 * A deterministic stub sequencer producing one `v` group of
 * `baselineCount` per wave. Injecting it gives the sequenced-campaign tests a
 * **known** pre-scaling baseline, so the expected post-scaling counts are
 * exact without depending on where inside the build pipeline the seam lives.
 * The stub is a test harness, not a re-implementation of any production
 * logic.
 */
function stubSequencer(baselineCount: number = STUB_BASELINE_COUNT): SequencerFn {
  return (curve, candidates, options) => {
    const target = curve[0] ?? 0;
    const group: AdjustedGroup = {
      enemyKey: candidates[0]?.enemyKey ?? 'scout',
      formation: 'v',
      count: baselineCount,
      spacingX: 28,
      spacingY: 22,
      startX: 100,
      startY: 100,
      score: target,
    };
    return {
      waves: [
        {
          groups: [group],
          shootEnabled: options?.defaultShootEnabled ?? false,
          targetDifficulty: target,
        },
      ],
      errors: [0],
    };
  };
}

/** Curve rows for one level with the given per-wave generation modes. */
function stubRows(
  level: number,
  modes: readonly DifficultyGeneration[],
): DifficultyCurveRow[] {
  const levelName = getLevelDefinition(level)?.name ?? `Level ${level}`;
  return modes.map((generation, index) => ({
    level,
    levelName,
    wave: index + 1,
    targetDifficulty: 10 + index * 5,
    generation,
  }));
}

/**
 * The pre-scaling baseline waves the stub build produces for one level:
 * `fixed` waves are the authored static waves, generated waves are the stub
 * group. Both are copied so a mutating seam cannot corrupt the baseline.
 */
function stubBaselineWaves(
  level: number,
  modes: readonly DifficultyGeneration[],
  baselineCount: number = STUB_BASELINE_COUNT,
): WaveDefinition[] {
  const staticLevel = getLevelDefinition(level);
  return modes.map((mode, index) => {
    if (mode === 'fixed') {
      const authored = staticLevel?.waves[index];
      if (!authored) throw new Error(`No authored wave L${level}W${index + 1}`);
      return {
        ...authored,
        groups: authored.groups.map((group) => ({ ...group })),
      };
    }
    return {
      groups: [
        {
          enemyKey: 'scout',
          formation: 'v',
          count: baselineCount,
          spacingX: 28,
          spacingY: 22,
          startX: 100,
          startY: 100,
        },
      ],
      shootEnabled: level >= 4,
    };
  });
}

/** Builds a stub-sequenced campaign through the game's campaign seam. */
function stubCampaign(
  level: number,
  modes: readonly DifficultyGeneration[],
  baselineCount: number = STUB_BASELINE_COUNT,
  seed = 3,
): LevelDefinition[] {
  const rows = stubRows(level, modes);
  return resolveCampaignLevels(SEQUENCED_RULES, () =>
    buildSequencedLevels(rows, undefined, {
      sequencer: stubSequencer(baselineCount),
      seed,
    }),
  );
}

// ── Static LEVELS campaign ───────────────────────────────────────────

describe('scaled static LEVELS campaign (AH-0MVLJF1PO000PB21)', () => {
  it('leaves level 1 onboarding data byte-identical to the authored LEVELS', () => {
    // Onboarding is the calibration baseline: the level-1 multiplier is 1.00,
    // so the static campaign's first level must deep-equal the authored data.
    expect(levelFrom(staticCampaign(), 1)).toEqual(LEVELS[0]);
    expect(countsOf(levelFrom(staticCampaign(), 1))).toEqual(
      AUTHORED_COUNTS.get(1),
    );
  });

  it(
    'scales every level L by the documented multiplier at level L (no double scaling)',
    () => {
      const campaign = staticCampaign();
      for (const authoredLevel of LEVELS) {
        const scaled = levelFrom(campaign, authoredLevel.level);
        expect(
          countsOf(scaled),
          `L${authoredLevel.level} counts`,
        ).toEqual(
          expectedScaledGroupCounts(
            authoredLevel.level,
            AUTHORED_GROUPS.get(authoredLevel.level) ?? [],
          ),
        );
      }
    },
  );

  it(
    'grows a level-10 group by the documented 2.00× multiplier (explicit pin)',
    () => {
      // Level 10 wave 1 is authored `raider` (single), `capturer` (single),
      // `tank` 8, `diver` 10, `swarm` 10. The level-10 multiplier is 2.00, so
      // the `single` groups stay at 1 and the rest double.
      const level10 = levelFrom(staticCampaign(), 10);
      expect(countsOfWaves([level10.waves[0]])).toEqual([1, 1, 16, 20, 20]);
    },
  );

  it(
    'applies the documented rounding at the fractional levels (explicit pin)',
    () => {
      // L2 multiplier 1 + 1/9 = 1.111…: authored scout 8 → 8.888… → 9 (round
      // half up). L4 multiplier 1 + 3/9 = 1.333…: authored diver 6 → 8.0 → 8
      // and authored swarm 10 → 13.333… → 13.
      const campaign = staticCampaign();
      expect(countsOfWaves([levelFrom(campaign, 2).waves[0]])).toEqual([9]);
      expect(countsOfWaves([levelFrom(campaign, 4).waves[0]])).toEqual([8]);
      expect(countsOfWaves([levelFrom(campaign, 4).waves[2]])).toEqual([13]);
    },
  );

  it('keeps every campaign group inside the documented per-group safety cap', () => {
    const cap = DEFAULT_RULES.enemyCountCap;
    for (const level of staticCampaign()) {
      for (const count of countsOf(level)) {
        expect(count, `L${level.level}`).toBeGreaterThanOrEqual(1);
        expect(count, `L${level.level}`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('keeps every single-formation group at exactly 1 across the campaign', () => {
    for (const level of staticCampaign()) {
      for (const wave of level.waves) {
        for (const group of wave.groups) {
          if (group.formation !== 'single') continue;
          expect(group.count, `L${level.level} ${group.enemyKey}`).toBe(1);
        }
      }
    }
  });
});

// ── Sequenced campaign: fixed, curve and dynamic modes ───────────────

describe('scaled sequenced campaign (AH-0MVLJF1PO000PB21)', () => {
  it(
    'scales fixed, curve and dynamic waves alike (no mode is skipped)',
    () => {
      // Level 6 exercises the `single`-formation rule (authored wave 2 has a
      // `capturer` single group) alongside `fixed` waves; level 4 mixes a
      // `curve` wave with a stub baseline; level 1 mixes `dynamic` with a stub
      // baseline. Level 6's multiplier is 1 + 5/9 = 1.555…, level 4's is
      // 1.333…, level 1's is the identity.
      const level1 = levelFrom(
        stubCampaign(1, ['dynamic', 'curve', 'fixed', 'fixed']),
        1,
      );
      expect(countsOf(level1)).toEqual(
        expectedScaledCounts(
          1,
          stubBaselineWaves(1, ['dynamic', 'curve', 'fixed', 'fixed']),
        ),
      );

      const level4 = levelFrom(
        stubCampaign(4, ['curve', 'dynamic', 'fixed', 'fixed']),
        4,
      );
      expect(countsOf(level4)).toEqual(
        expectedScaledCounts(
          4,
          stubBaselineWaves(4, ['curve', 'dynamic', 'fixed', 'fixed']),
        ),
      );

      const level6 = levelFrom(
        stubCampaign(6, ['fixed', 'fixed', 'curve', 'dynamic']),
        6,
      );
      expect(countsOf(level6)).toEqual(
        expectedScaledCounts(
          6,
          stubBaselineWaves(6, ['fixed', 'fixed', 'curve', 'dynamic']),
        ),
      );
    },
  );

  it(
    'leaves single-formation groups at exactly 1 while scaling their wave',
    () => {
      // Authored L6W2: capturer (single) 1, tank 6, swarm 8. At level 6
      // (×1.555…) the single group must stay 1 while the others grow.
      const wave = levelFrom(stubCampaign(6, ['fixed', 'fixed']), 6).waves[1];
      const single = wave.groups.filter((group) => group.formation === 'single');
      expect(single.length).toBeGreaterThan(0);
      expect(single.every((group) => group.count === 1)).toBe(true);
      expect(
        wave.groups.filter((group) => group.formation !== 'single'),
      ).not.toEqual(
        getLevelDefinition(6)!.waves[1].groups.filter(
          (group) => group.formation !== 'single',
        ),
      );
    },
  );

  it(
    'floors a scaled generated count at 1 and caps a large one at 200',
    () => {
      // Baseline 0 at the level-10 multiplier (2.00) would be 0 → floored to 1;
      // baseline 150 would be 300 → capped at 200.
      const floored = levelFrom(stubCampaign(10, ['curve'], 0), 10);
      expect(countsOf(floored)).toEqual([1]);

      const capped = levelFrom(stubCampaign(10, ['curve'], 150), 10);
      expect(countsOf(capped)).toEqual([DEFAULT_RULES.enemyCountCap]);
    },
  );

  it('keeps the shipped sequenced campaign’s late levels denser than its opening', () => {
    // The authored campaign already escalates (level 10 throws more enemies
    // than level 1), and the count multiplier only amplifies that ramp. This
    // is an invariant, not a red-first pin: it locks the escalation staying
    // true after F2 applies scaling to the sequenced path.
    const campaign = sequencedCampaign();
    const opening = totalCount(levelFrom(campaign, 1));
    const finale = totalCount(levelFrom(campaign, 10));
    expect(finale).toBeGreaterThan(opening);
  });
});

// ── Determinism and idempotence ──────────────────────────────────────

describe('scaled campaign determinism (AH-0MVLJF1PO000PB21)', () => {
  it('builds a byte-identical sequenced campaign for the same seed', () => {
    for (const seed of [0, 7]) {
      expect(JSON.stringify(sequencedCampaign(seed))).toBe(
        JSON.stringify(sequencedCampaign(seed)),
      );
    }
  });

  it('keeps distinct seeds distinct (the `dynamic` contract still holds)', () => {
    expect(JSON.stringify(sequencedCampaign(7))).not.toBe(
      JSON.stringify(sequencedCampaign(8)),
    );
  });

  it('is idempotent: a second build of the same campaign does not re-scale', () => {
    // Two independent builds of the same source must agree exactly. A seam
    // that scaled in place would accumulate and diverge here.
    expect(staticCampaign()).toEqual(staticCampaign());
    expect(sequencedCampaign(7)).toEqual(sequencedCampaign(7));
    expect(
      JSON.stringify(stubCampaign(4, ['curve', 'fixed', 'dynamic'])),
    ).toBe(JSON.stringify(stubCampaign(4, ['curve', 'fixed', 'dynamic'])));
  });

  it('never mutates the authored LEVELS data', () => {
    // The authored campaign is the source of truth every build scales *from*.
    staticCampaign();
    sequencedCampaign();
    stubCampaign(10, ['fixed', 'curve', 'dynamic']);
    expect(JSON.stringify(LEVELS)).toBe(AUTHORED_LEVELS_SNAPSHOT);
    for (const level of LEVELS) {
      expect(
        level.waves.flatMap((wave) => wave.groups.map((group) => group.count)),
      ).toEqual(AUTHORED_COUNTS.get(level.level));
    }
  });
});

// ── Existing campaign invariants under scaling ───────────────────────

describe('existing campaign invariants survive scaling (AH-0MVLJF1PO000PB21)', () => {
  /** Every spawner-delivered archetype key a wave opts into. */
  function spawnerKeysInWave(wave: WaveDefinition): string[] {
    const keys: string[] = [];
    if (wave.ghosts) keys.push(...GHOST_ENEMY_KEYS);
    if (wave.centipede) keys.push(CENTIPEDE_ENEMY_KEY);
    if (wave.horde) keys.push(GRUNT_ENEMY_KEY);
    if (wave.laneTraffic) keys.push(LANE_TRAFFIC_ENEMY_KEY);
    return keys;
  }

  it('keeps the authored composition of the static campaign intact', () => {
    // Scaling may only change `count`: every other authored field — the wave
    // and group order, archetypes, formations, spawner flags and shoot state
    // — must be preserved.
    for (const scaled of staticCampaign()) {
      const authored = getLevelDefinition(scaled.level);
      expect(authored, `L${scaled.level}`).not.toBeNull();
      expect(scaled.name, `L${scaled.level} name`).toBe(authored!.name);
      expect(scaled.waves.length, `L${scaled.level} wave count`).toBe(
        authored!.waves.length,
      );
      scaled.waves.forEach((wave, index) => {
        const authoredWave = authored!.waves[index];
        expect(wave.shootEnabled, `L${scaled.level}W${index + 1} fire`).toBe(
          authoredWave.shootEnabled,
        );
        expect(wave.miniBoss, `L${scaled.level}W${index + 1} mini-boss`).toBe(
          authoredWave.miniBoss,
        );
        expect(wave.ghosts, `L${scaled.level}W${index + 1} ghosts`).toBe(
          authoredWave.ghosts,
        );
        expect(wave.centipede, `L${scaled.level}W${index + 1} centipede`).toBe(
          authoredWave.centipede,
        );
        expect(wave.horde, `L${scaled.level}W${index + 1} horde`).toBe(
          authoredWave.horde,
        );
        expect(
          wave.laneTraffic,
          `L${scaled.level}W${index + 1} laneTraffic`,
        ).toBe(authoredWave.laneTraffic);
        expect(
          wave.groups.map((group) => `${group.enemyKey}:${group.formation}`),
          `L${scaled.level}W${index + 1} groups`,
        ).toEqual(
          authoredWave.groups.map(
            (group) => `${group.enemyKey}:${group.formation}`,
          ),
        );
      });
    }
  });

  it('keeps the shipped sequenced campaign complete (10 levels × 10 waves, mini-bosses)', () => {
    const campaign = sequencedCampaign();
    expect(campaign.map((level) => level.level)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    for (const level of campaign) {
      expect(level.waves.length, `L${level.level} waves`).toBe(10);
      expect(level.waves[9].miniBoss, `L${level.level} wave 10`).toBe(true);
      for (let index = 0; index < level.waves.length; index += 1) {
        const wave = level.waves[index];
        expect(wave.groups.length, `L${level.level}W${index + 1}`).toBeGreaterThan(
          0,
        );
        expect(totalCount({ ...level, waves: [wave] })).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the scaled sequenced campaign R1–R3 compliant', () => {
    // The shared rule validator is the single source of truth used by the
    // campaign audit (`campaignBalanceAudit.test.ts`). `fixed` waves are
    // hand-authored and exempt by design (producer Q3=a).
    const campaign = sequencedCampaign();
    const rows = [...defaultDifficultyCurves()].sort(
      (a, b) => a.level - b.level || a.wave - b.wave,
    );
    const waves: BalancedWave[] = rows.map((row) => {
      const level = levelFrom(campaign, row.level);
      const wave = level.waves[row.wave - 1];
      if (!wave) {
        throw new Error(`Scaled campaign has no L${row.level}W${row.wave}`);
      }
      return {
        id: `${row.level}:${row.wave}`,
        groups: classifyWaveGroups(wave.groups),
        shootEnabled: wave.shootEnabled,
        isOpening: isOpeningWavePosition(row.level, row.wave),
        generation: row.generation ?? 'curve',
      };
    });

    const audit = auditWaves(waves);
    const failures = audit.waves
      .filter((wave) => !wave.pass)
      .map(
        (wave) =>
          `${wave.id}: ${wave.rules.map((rule) => rule.message).join(' ')}`,
      );
    expect(audit.pass, failures.join(' | ')).toBe(true);
  });

  it('keeps the classic-arcade roster covered after scaling', () => {
    // Roster coverage (`campaignRoster.test.ts`) must survive scaling: the
    // scaled campaign must still deliver every classic archetype.
    const campaign = sequencedCampaign();
    const delivered = new Set<string>();
    for (const level of campaign) {
      for (const wave of level.waves) {
        for (const group of wave.groups) delivered.add(group.enemyKey);
        for (const key of spawnerKeysInWave(wave)) delivered.add(key);
      }
    }
    const classic: ReadonlyArray<{ label: string; keys: readonly string[] }> = [
      { label: 'march', keys: ['march'] },
      { label: 'capturer', keys: ['capturer'] },
      { label: 'ghost-*', keys: GHOST_ENEMY_KEYS },
      { label: 'centipede', keys: [CENTIPEDE_ENEMY_KEY] },
      { label: 'grunt', keys: [GRUNT_ENEMY_KEY] },
      { label: 'raider', keys: ['raider'] },
      { label: 'lane-traffic', keys: [LANE_TRAFFIC_ENEMY_KEY] },
    ];
    for (const entry of classic) {
      expect(
        entry.keys.some((key) => delivered.has(key)),
        `scaled campaign delivers no ${entry.label}`,
      ).toBe(true);
    }
  });

  it('keeps the scaled campaign inside the per-group safety cap', () => {
    const cap = DEFAULT_RULES.enemyCountCap;
    for (const level of sequencedCampaign()) {
      for (const count of countsOf(level)) {
        expect(count, `L${level.level}`).toBeGreaterThanOrEqual(1);
        expect(count, `L${level.level}`).toBeLessThanOrEqual(cap);
      }
    }
  });
});

// ── Parity seam: one scaling implementation, consumed by the build ───

/** Production (non-test) TypeScript sources under `src/`, repo-relative. */
function productionSources(): Array<{ rel: string; source: string }> {
  const srcRoot = path.join(process.cwd(), 'src');
  return collectProductionSourceFiles(srcRoot).map((file) => ({
    rel: path.relative(srcRoot, file).split(path.sep).join('/'),
    source: fs.readFileSync(file, 'utf8'),
  }));
}

/** The modules that consume the shared campaign-scaling seam. */
const CAMPAIGN_SCALING_CONSUMERS = ['scenes/PlayScene.ts', 'ai/eval/arena.ts'];

describe('scaling parity seam (AH-0MVLJF1PO000PB21)', () => {
  it('defines the enemy-count scaling maths in exactly one module', () => {
    // AGENTS.md gym↔game parity: enabled gameplay behaviour is shared code.
    // A second definition of the scaling curve would let the game and the
    // level gyms drift apart, so the maths may exist only in
    // `core/levelScaling.ts`.
    const definers = productionSources()
      .filter(
        ({ rel, source }) =>
          rel !== 'core/levelScaling.ts' &&
          (definesFunction(source, 'applyEnemyCountScaling') ||
            definesFunction(source, 'enemyCountMultiplier')),
      )
      .map(({ rel }) => rel);
    expect(definers).toEqual([]);
  });

  it('has every scaling consumer import it from the shared module', () => {
    // Any production file that applies the scaling must take it from
    // `core/levelScaling` — never a local copy or an inlined formula.
    const unshared = productionSources()
      .filter(
        ({ rel, source }) =>
          rel !== 'core/levelScaling.ts' &&
          /\bapplyEnemyCountScaling\s*\(/.test(source) &&
          !/from\s+['"][^'"]*levelScaling['"]/.test(source),
      )
      .map(({ rel }) => rel);
    expect(unshared).toEqual([]);
  });

  it(
    'has the campaign build seam consume the shared campaign-scaling helper',
    () => {
      // The scaling is applied once, by `scaleCampaignLevelCounts` in the
      // shared `core/levelScaling` module; the game's campaign resolution and
      // the headless eval arena both consume that helper (never a local copy
      // or an inline multiplier). The old pin required the seam itself to
      // call `applyEnemyCountScaling` directly, which forced a second copy
      // of the campaign mapping — this pins the stronger single-owner shape
      // (AH-0MVD1RGKM005GW0C).
      const sources = productionSources();
      const owner = sources.find(({ rel }) => rel === 'core/levelScaling.ts');
      expect(owner).toBeDefined();
      expect(definesFunction(owner?.source ?? '', 'scaleCampaignLevelCounts')).toBe(
        true,
      );
      expect(/\bapplyEnemyCountScaling\s*\(/.test(owner?.source ?? '')).toBe(true);

      for (const seam of CAMPAIGN_SCALING_CONSUMERS) {
        const consumer = sources.find(({ rel }) => rel === seam);
        expect(consumer, seam).toBeDefined();
        expect(
          /\bscaleCampaignLevelCounts\s*\(/.test(consumer?.source ?? ''),
          seam,
        ).toBe(true);
        expect(
          /from\s+['"][^'"]*levelScaling['"]/.test(consumer?.source ?? ''),
          seam,
        ).toBe(true);
      }
    },
  );
});

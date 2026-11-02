/**
 * Campaign-wide enemy-composition variety — AC1–AC3 scaffolding and the
 * shared audit module's unit tests (AH-0MVSE6D2L0034SKG).
 *
 * Parent epic: AH-0MVI5XXOU00954EA ("Waves need more variation in enemy
 * types"). The three campaign-wide invariants this file expresses are:
 *
 * - **AC1** — no two adjacent waves inside a level share an enemy
 *   composition ("same enemies" = the same archetype *set*; counts, order and
 *   spacing alone do not count as variety).
 * - **AC2** — every level shows at least two distinct archetypes across its
 *   ten waves.
 * - **AC3** — every level keeps the dominant archetype its GDD §3.2 identity
 *   documents, varying around it with secondary archetypes (parent Q2 = a).
 *
 * ## Test-first staging (why some assertions are skipped in this commit)
 *
 * The repo rule is never to commit a red tree. The campaign is still
 * repetitive when this analysis module lands, so the campaign-wide
 * assertions are committed with their exact current violations recorded as a
 * red baseline in the work-item and parent comments, and **staged**: a level
 * (or the campaign aggregate) is un-skipped by the sibling item that makes it
 * green. The activation ledger below is the single place to flip:
 *
 * - `ACTIVATED_LEVELS` — the level-scoped AC1/AC2/AC3 assertions.
 * - `CAMPAIGN_AGGREGATE_ACTIVE` — the campaign-wide AC1/AC2 aggregates.
 *
 * The committed baseline is **not** empty-assertion padding: the audit module
 * itself is fully unit-tested above, and every assertion that is already
 * green in the merged campaign runs now (the per-AC activation ledger below is
 * seeded from the recorded baseline), so a regression in today's measured
 * campaign is caught immediately. Only the genuinely red assertions are
 * skipped, each naming the item that must activate it.
 *
 * Recorded red baseline at this commit (100 waves, `buildSequencedLevels()`
 * at default config/seed):
 *
 * - AC1: 17 adjacent duplicate pairs, all in Levels 1–5 (L1 ×7, L2 ×2,
 *   L3 ×1, L4 ×1, L5 ×6). Levels 6–10 are already pairwise distinct.
 * - AC2: green for every level today — the smallest level shows 2 archetypes
 *   (L1 fields scouts plus the generated `diver` opening wave), so the
 *   aggregate is active.
 * - AC3: green except **L7**, whose measured dominant archetype is `diver`
 *   rather than the documented tank-led "Segmented Assault" identity — the
 *   classic-arcade rework item restores it.
 *
 * Post-pilot state (AH-0MVSE6VIW009QG2E): Levels 1 and 5 are now pairwise
 * distinct, so their AC1 assertions are activated and run unskipped. The
 * campaign-wide AC1 aggregate stays red until the remaining rework items land.
 *
 * Post-onboarding state (AH-0MVSE7F090010EG3): re-mixing the authored Levels
 * 2–4 waves removed the last four recorded duplicate pairs (L2 ×2 at W4/W5 and
 * W9/W10, L3 ×1 at W9/W10, L4 ×1 at W9/W10; the L1 ×7 and L5 ×6 pairs were
 * already fixed by the pilot), so Levels 2, 3 and 4 are activated here too.
 * Every level of the ten is therefore pairwise distinct; the campaign-wide AC1
 * aggregate still waits for the classic-arcade/finale rework.
 *
 * Post-finale state (AH-0MVSEFST20086D87): the Levels 6–10 re-mix restores the
 * documented Level 7 tank dominance (the merged campaign had measured `diver`
 * first because two generated curve waves at that level field a large
 * diver/phased tail). With `tank` dominant again, **every** level now matches
 * its `LEVEL_IDENTITY` entry, so the L7 AC3 assertion is activated and the
 * campaign-wide AC1 aggregate is activated too — the whole 100-wave campaign
 * is pairwise distinct, so the ledger has no remaining staged assertion.
 *
 * Activation owners (from the parent plan):
 * - Levels 1 & 5 → AH-0MVSE6VIW009QG2E (pilot) — **done, activated here**
 * - Levels 2, 3, 4 → AH-0MVSE7F090010EG3 (onboarding rework) — **done,
 *   activated here**
 * - Levels 6–10 and the campaign-wide AC1 aggregate → AH-0MVSEFST20086D87
 *   (classic-arcade/finale rework) — **done, activated here**
 */

import { describe, expect, it } from 'vitest';

import { buildSequencedLevels } from './sequencedLevels';
import { LEVELS, type LevelDefinition, type WaveDefinition, type WaveGroup } from './Formations';
import type { EnemyFormationKind } from '../utils/formations';
import {
  LEVEL_IDENTITY,
  auditCampaignVariety,
  waveComposition,
} from './campaignVariety';
import { GHOST_ENEMY_KEYS } from './GhostSpawner';
import { CENTIPEDE_ENEMY_KEY } from './CentipedeSpawner';
import { GRUNT_ENEMY_KEY } from './HordeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from './LaneTrafficSpawner';

// ── Test fixtures ───────────────────────────────────────────────────

/** A wave group with the fields the audit reads (geometry is irrelevant). */
function group(
  enemyKey: string,
  count: number,
  formation: EnemyFormationKind = 'v',
): WaveGroup {
  return {
    enemyKey,
    formation,
    count,
    spacingX: 30,
    spacingY: 26,
    startX: 100,
    startY: 100,
  };
}

/** A non-firing wave from the given groups and optional spawner flags. */
function wave(
  groups: WaveGroup[],
  flags: Pick<
    WaveDefinition,
    'ghosts' | 'centipede' | 'horde' | 'laneTraffic'
  > = {},
): WaveDefinition {
  return { groups, shootEnabled: false, ...flags };
}

/** A level from the given waves. */
function level(
  levelNumber: number,
  ...waves: WaveDefinition[]
): LevelDefinition {
  return { level: levelNumber, name: `Level ${levelNumber}`, waves };
}

// ── waveComposition: the AC1 comparison unit ────────────────────────

describe('waveComposition — the AC1 archetype signature', () => {
  it('returns the empty signature for a wave that delivers no archetype', () => {
    expect(waveComposition(wave([]))).toBe('');
  });

  it('returns the single archetype key for a single-group wave', () => {
    expect(waveComposition(wave([group('scout', 6)]))).toBe('scout');
  });

  it('sorts and de-duplicates repeated groups of the same archetype', () => {
    expect(
      waveComposition(
        wave([group('swarm', 8), group('scout', 4), group('scout', 10)]),
      ),
    ).toBe('scout+swarm');
  });

  it('includes every archetype scheduled by a spawner opt-in flag', () => {
    const flagged = wave([], {
      ghosts: true,
      centipede: true,
      horde: true,
      laneTraffic: true,
    });
    const expected = [
      ...GHOST_ENEMY_KEYS,
      CENTIPEDE_ENEMY_KEY,
      GRUNT_ENEMY_KEY,
      LANE_TRAFFIC_ENEMY_KEY,
    ]
      .sort()
      .join('+');
    expect(waveComposition(flagged)).toBe(expected);
    expect(waveComposition(flagged)).toContain('ghost-chase');
  });

  it('ignores group order, counts and spacing — the same set is the same composition', () => {
    const short = wave([group('scout', 4), group('tank', 6)]);
    const long = wave([
      group('tank', 40, 'rect'),
      group('scout', 400, 'v'),
    ]);
    // Different geometry/counts/order, identical archetype set: AC1 must
    // treat these as the *same* composition, so re-tuning counts cannot
    // manufacture variety.
    expect(waveComposition(long)).toBe(waveComposition(short));
  });

  it('changes when the archetype set changes, even with identical counts', () => {
    const base = wave([group('scout', 6)]);
    const extraGroup = wave([group('scout', 6), group('diver', 6)]);
    const extraFlag = wave([group('scout', 6)], { horde: true });
    expect(waveComposition(extraGroup)).not.toBe(waveComposition(base));
    expect(waveComposition(extraFlag)).not.toBe(waveComposition(base));
  });
});

// ── auditCampaignVariety: per-level measurements ────────────────────

describe('auditCampaignVariety — AC1–AC3 measurements', () => {
  it('reports each adjacent composition duplicate as a level/wave pair', () => {
    const campaign = [
      level(
        2,
        wave([group('scout', 4)]),
        wave([group('scout', 8)]),
        wave([group('diver', 6)]),
        wave([group('diver', 6)]),
      ),
    ];
    const audit = auditCampaignVariety(campaign);
    expect(audit.adjacentDuplicates).toEqual([
      {
        level: 2,
        previousWave: 1,
        wave: 2,
        composition: 'scout',
      },
      {
        level: 2,
        previousWave: 3,
        wave: 4,
        composition: 'diver',
      },
    ]);
    expect(audit.distinct).toBe(false);
    expect(audit.levels[0].distinct).toBe(false);
  });

  it('does not flag a non-adjacent repeat of a composition', () => {
    const audit = auditCampaignVariety([
      level(
        1,
        wave([group('scout', 4)]),
        wave([group('diver', 4)]),
        wave([group('scout', 12)]),
      ),
    ]);
    expect(audit.adjacentDuplicates).toEqual([]);
    expect(audit.levels[0].distinct).toBe(true);
  });

  it('counts the distinct archetypes each level delivers (wave groups and flags)', () => {
    const audit = auditCampaignVariety([
      level(
        7,
        wave([group('tank', 6)], { ghosts: true }),
        wave([group('diver', 4)], { centipede: true }),
      ),
    ]);
    const entry = audit.levels[0];
    expect(entry.distinctArchetypeCount).toBe(2 + GHOST_ENEMY_KEYS.length + 1);
    expect(entry.distinctArchetypes).toContain('tank');
    expect(entry.distinctArchetypes).toContain('diver');
    expect(entry.distinctArchetypes).toContain(CENTIPEDE_ENEMY_KEY);
    for (const key of GHOST_ENEMY_KEYS) {
      expect(entry.distinctArchetypes).toContain(key);
    }
  });

  it('picks the dominant archetype by spawned weight, not the declared count', () => {
    // `single` is count-independent: it always spawns one entity, so the
    // boss's declared 99 must not outweigh two spawned scouts.
    const audit = auditCampaignVariety([
      level(10, wave([group('boss', 99, 'single'), group('scout', 2)])),
    ]);
    expect(audit.levels[0].dominantArchetype).toBe('scout');
    expect(audit.levels[0].dominantWeight).toBe(2);
  });

  it('counts spawner-delivered archetypes in the dominant-weight table', () => {
    const audit = auditCampaignVariety([
      level(8, wave([], { ghosts: true })),
    ]);
    const entry = audit.levels[0];
    const sortedGhosts = [...GHOST_ENEMY_KEYS].sort();
    // Every ghost personality weighs 1; ties break alphabetically so the
    // measurement is stable across runs.
    expect(entry.dominantArchetype).toBe(sortedGhosts[0]);
    expect(entry.dominantWeight).toBe(1);
  });

  it('treats an empty level as trivially distinct with no dominant archetype', () => {
    const audit = auditCampaignVariety([level(3)]);
    expect(audit.levels[0]).toMatchObject({
      level: 3,
      distinctArchetypes: [],
      distinctArchetypeCount: 0,
      dominantArchetype: null,
      dominantWeight: 0,
      distinct: true,
    });
  });

  it('reports an empty campaign as distinct with zero waves', () => {
    const audit = auditCampaignVariety([]);
    expect(audit.adjacentDuplicates).toEqual([]);
    expect(audit.levels).toEqual([]);
    expect(audit.totalWaves).toBe(0);
    expect(audit.distinct).toBe(true);
  });

  it('orders levels ascending and totals every wave in the campaign', () => {
    const audit = auditCampaignVariety([
      level(3, wave([group('tank', 2)])),
      level(1, wave([group('scout', 2)]), wave([group('diver', 2)])),
    ]);
    expect(audit.levels.map((entry) => entry.level)).toEqual([1, 3]);
    expect(audit.totalWaves).toBe(3);
  });

  it('never mutates the campaign it audits', () => {
    const campaign = [
      level(
        4,
        wave([group('diver', 6), group('tank', 6)]),
        wave([group('swarm', 10)], { ghosts: true }),
      ),
    ];
    const before = JSON.stringify(campaign);
    auditCampaignVariety(campaign);
    expect(JSON.stringify(campaign)).toBe(before);
  });
});

// ── Campaign-wide AC1–AC3 scaffolding ───────────────────────────────

/**
 * AC1 activation ledger — levels with no adjacent composition duplicate.
 * Levels 1 and 5 were activated by the pilot (AH-0MVSE6VIW009QG2E), Levels 2–4
 * by the onboarding rework (AH-0MVSE7F090010EG3) and Levels 6–10 were already
 * pairwise distinct at the baseline. The campaign-wide aggregate is activated
 * by the finale rework (AH-0MVSEFST20086D87), so every level is live.
 */
const ACTIVE_AC1_LEVELS: ReadonlySet<number> = new Set<number>([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
]);

/**
 * AC2 activation ledger — levels showing at least two distinct archetypes.
 * Green for every level at this commit (the smallest shows two), so the whole
 * ledger is active; a rework that collapses a level to one archetype fails
 * here immediately.
 */
const ACTIVE_AC2_LEVELS: ReadonlySet<number> = new Set<number>([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
]);

/**
 * AC3 activation ledger — levels whose measured dominant archetype matches
 * `LEVEL_IDENTITY` and which contain its showcase archetypes. Level 7 was
 * diver-dominant at the baseline rather than the documented tank-led identity;
 * the classic-arcade/finale rework (AH-0MVSEFST20086D87) restores tank
 * dominance, so all ten levels are live.
 */
const ACTIVE_AC3_LEVELS: ReadonlySet<number> = new Set<number>([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
]);

/**
 * Campaign-wide AC1 aggregate: activated by AH-0MVSEFST20086D87 once the
 * Levels 6–10 rework removed the last identity gap, so the whole 100-wave
 * campaign is pairwise distinct.
 */
const CAMPAIGN_AC1_ACTIVE = true;

/** Campaign-wide AC2 aggregate: green at this commit, so it runs now. */
const CAMPAIGN_AC2_ACTIVE = true;

/** The work item that activates each level's staged assertions. */
const ACTIVATION_OWNER: Readonly<Record<number, string>> = {
  1: 'AH-0MVSE6VIW009QG2E',
  2: 'AH-0MVSE7F090010EG3',
  3: 'AH-0MVSE7F090010EG3',
  4: 'AH-0MVSE7F090010EG3',
  5: 'AH-0MVSE6VIW009QG2E',
  6: 'AH-0MVSEFST20086D87',
  7: 'AH-0MVSEFST20086D87',
  8: 'AH-0MVSEFST20086D87',
  9: 'AH-0MVSEFST20086D87',
  10: 'AH-0MVSEFST20086D87',
};

/** Registers a per-level assertion, skipped until its owner activates it. */
function stagedLevelIt(
  activeLevels: ReadonlySet<number>,
  levelNumber: number,
  name: string,
  body: () => void,
): void {
  if (activeLevels.has(levelNumber)) {
    it(name, body);
    return;
  }
  it.skip(
    `${name} — pending activation by ${ACTIVATION_OWNER[levelNumber]}`,
    body,
  );
}

/** Registers a campaign-wide aggregate, skipped until its owner activates it. */
function stagedAggregateIt(
  active: boolean,
  name: string,
  body: () => void,
): void {
  if (active) {
    it(name, body);
    return;
  }
  it.skip(
    `${name} — pending activation by AH-0MVSEFST20086D87`,
    body,
  );
}

describe('campaign variety invariants (AC1–AC3)', () => {
  const campaign = buildSequencedLevels();
  const audit = auditCampaignVariety(campaign);

  // Green baseline: these run today and must stay green through every rework
  // item, catching a regression in the measured campaign before activation.
  it('pins the Level 1 scout identity that must survive the variety rework', () => {
    const levelOne = audit.levels.find((entry) => entry.level === 1);
    expect(levelOne).toBeDefined();
    expect(levelOne?.distinctArchetypes).toContain('scout');
    expect(levelOne?.dominantArchetype).toBe(LEVEL_IDENTITY[1].dominant);
    expect(
      campaign[0].waves[0].groups.map((waveGroup) => waveGroup.enemyKey),
    ).toContain('scout');
  });

  it('documents an identity for every shipped level and audits all of them', () => {
    expect(audit.levels.map((entry) => entry.level)).toEqual(
      campaign.map((entry) => entry.level),
    );
    for (const entry of audit.levels) {
      expect(
        LEVEL_IDENTITY[entry.level],
        `L${entry.level} identity`,
      ).toBeDefined();
    }
    expect(audit.totalWaves).toBe(100);
  });

  // AC1 — campaign-wide aggregate (activated last, by the finale rework).
  stagedAggregateIt(
    CAMPAIGN_AC1_ACTIVE,
    'AC1 — no adjacent wave pair in the 100-wave campaign shares a composition',
    () => {
      expect(audit.adjacentDuplicates).toEqual([]);
      expect(audit.distinct).toBe(true);
    },
  );

  // AC2 — campaign-wide aggregate.
  stagedAggregateIt(
    CAMPAIGN_AC2_ACTIVE,
    'AC2 — every level shows at least two distinct archetypes',
    () => {
      for (const entry of audit.levels) {
        expect(
          entry.distinctArchetypeCount,
          `L${entry.level} distinct archetype count`,
        ).toBeGreaterThanOrEqual(2);
      }
    },
  );

  for (const entry of audit.levels) {
    const levelNumber = entry.level;

    // AC1 — per-level sequential distinctness.
    stagedLevelIt(
      ACTIVE_AC1_LEVELS,
      levelNumber,
      `AC1 — L${levelNumber} has no adjacent wave pair sharing a composition`,
      () => {
        const duplicates = audit.adjacentDuplicates.filter(
          (duplicate) => duplicate.level === levelNumber,
        );
        expect(
          duplicates,
          `L${levelNumber} adjacent duplicates: ${duplicates
            .map(
              (duplicate) =>
                `W${duplicate.previousWave}/W${duplicate.wave} (${duplicate.composition})`,
            )
            .join(', ')}`,
        ).toEqual([]);
      },
    );

    // AC2 — per-level variety coverage.
    stagedLevelIt(
      ACTIVE_AC2_LEVELS,
      levelNumber,
      `AC2 — L${levelNumber} shows at least two distinct archetypes`,
      () => {
        expect(
          entry.distinctArchetypeCount,
          `L${levelNumber} delivers ${entry.distinctArchetypes.join(', ')}`,
        ).toBeGreaterThanOrEqual(2);
      },
    );

    // AC3 — per-level identity preservation (dominant archetype + showcase).
    stagedLevelIt(
      ACTIVE_AC3_LEVELS,
      levelNumber,
      `AC3 — L${levelNumber} keeps its documented dominant archetype and showcase`,
      () => {
        const identity = LEVEL_IDENTITY[levelNumber];
        expect(identity, `L${levelNumber} identity`).toBeDefined();
        if (identity.dominant !== null) {
          expect(
            entry.dominantArchetype,
            `L${levelNumber} dominant archetype`,
          ).toBe(identity.dominant);
        }
        for (const key of identity.showcase) {
          expect(
            entry.distinctArchetypes,
            `L${levelNumber} ${identity.label} showcase archetype ${key}`,
          ).toContain(key);
        }
      },
    );
  }
});

// ── Authored onboarding rework guard (AH-0MVSE7F090010EG3) ──────────

describe('authored onboarding levels (AH-0MVSE7F090010EG3)', () => {
  it('keeps Level 4 to its three showcase archetypes — no fourth-archetype explosion', () => {
    // Level 4's documented identity is a deliberate Diver/Tank/Swarm mix
    // (LEVEL_IDENTITY[4].showcase). The onboarding rework re-mixes its
    // authored waves to break adjacent composition repeats; this pin keeps
    // that re-mix inside the three-archetype budget, so variety is bought
    // with new *combinations* rather than by widening the level's roster.
    const authored = LEVELS[3];
    expect(authored.level).toBe(4);
    const [audit] = auditCampaignVariety([authored]).levels;
    expect(audit.distinctArchetypes).toEqual(['diver', 'swarm', 'tank']);
  });
});

// ── Authored classic-arcade/finale rework guard (AH-0MVSEFST20086D87) ─

describe('authored classic-arcade and finale levels (AH-0MVSEFST20086D87)', () => {
  /** The authored Levels 6–10. */
  const authoredClassic = LEVELS.filter((entry) => entry.level >= 6);

  it('keeps Level 7 tank-led with its centipede and ghost showcase intact', () => {
    // Level 7's documented identity is the segmented/pursuit showcase *around
    // a Tank line* (LEVEL_IDENTITY[7]). The finale rework re-mixes the
    // secondary escorts (the shipped campaign previously measured Diver
    // first because two generated curve waves field a large diver tail); this
    // pin keeps the authored data Tank-led with both showcase spawners in
    // kind, and the wave-10 mini-boss unchanged.
    const authored = LEVELS[6];
    expect(authored.level).toBe(7);
    expect(authored.waves[0].centipede).toBe(true);
    expect(authored.waves.some((wave) => wave.ghosts === true)).toBe(true);
    expect(authored.waves[9].miniBoss).toBe(true);

    const [audit] = auditCampaignVariety([authored]).levels;
    expect(audit.dominantArchetype).toBe('tank');
    expect(audit.distinctArchetypes).toContain(CENTIPEDE_ENEMY_KEY);
    for (const key of GHOST_ENEMY_KEYS) {
      expect(audit.distinctArchetypes).toContain(key);
    }
  });

  it('never fields the orbital-strike hazard as a wave group in Levels 6–10', () => {
    // `orbital-strike` is a non-wave-accounted hazard delivered by the
    // telegraphed strike plan. Adding it as a group would soft-lock wave
    // clearance (parent AC6).
    for (const level of authoredClassic) {
      for (const wave of level.waves) {
        expect(
          wave.groups.map((waveGroup) => waveGroup.enemyKey),
          `L${level.level} fields orbital-strike as a wave group`,
        ).not.toContain('orbital-strike');
      }
    }
  });

  it('keeps spawner opt-in density bounded across Levels 6–10', () => {
    // Variety is bought with new *combinations*, never by spraying the
    // spawner opt-ins across every filler wave: each flag stays on at most two
    // waves per level and no level opts into more than three flagged waves in
    // total (parent AC5 — wave accounting and performance stay as designed).
    const flags = [
      'ghosts',
      'centipede',
      'horde',
      'laneTraffic',
    ] as const;
    for (const level of authoredClassic) {
      const flaggedWaves = level.waves.filter((wave) =>
        flags.some((flag) => wave[flag] === true),
      );
      expect(
        flaggedWaves.length,
        `L${level.level} flags ${flaggedWaves.length} waves`,
      ).toBeLessThanOrEqual(3);
      for (const flag of flags) {
        const count = level.waves.filter((wave) => wave[flag] === true).length;
        expect(
          count,
          `L${level.level} opts into ${flag} on ${count} waves`,
        ).toBeLessThanOrEqual(2);
      }
    }
  });
});

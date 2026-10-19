/**
 * AH-0MV398ZWL009TTOB — Campaign-level design invariants for the ten-level
 * campaign (parent epic AH-0MV29SBAQ000HQR2).
 *
 * The parent epic grew the shipped campaign from five to ten regular levels
 * to showcase the classic-arcade enemy roster. `campaignRoster.test.ts`
 * (AH-0MV3953EO005V6HH) pins the roster-coverage and player-targeter pairing
 * invariants; this file pins the complementary campaign-shape invariants that
 * keep the ten levels varied and escalating:
 *
 * 1. **Style variety** — adjacent levels differ in their dominant
 *    movement/attack style, so the campaign never presents two levels in a
 *    row with the same feel (the operator's "variety of movement and attack
 *    styles between levels" requirement).
 * 2. **Difficulty continuity** — the per-wave `targetDifficulty` curve is
 *    non-decreasing across all ten levels and the new final target exceeds
 *    the previous five-level campaign's peak.
 * 3. **Onboarding & authoring mix** — Levels 1–3 stay no-fire, Levels 4–10
 *    fire, and the campaign uses both `fixed` and `dynamic` waves with every
 *    hand-authored showcase wave pinned to `fixed` (so a featured archetype
 *    is guaranteed for a given run seed).
 * 4. **Per-level showcase coverage** — every one of the five new levels 6–10
 *    introduces at least one classic-arcade archetype, so the roster is
 *    distributed across the campaign rather than concentrated.
 *
 * Assertions run through the public `buildSequencedLevels()` /
 * `defaultDifficultyCurves()` APIs and the public spawner key constants. No
 * production code is touched.
 */

import { describe, expect, it } from 'vitest';

import { buildSequencedLevels } from './sequencedLevels';
import { LEVELS, type LevelDefinition, type WaveDefinition } from './Formations';
import { defaultDifficultyCurves } from '../core/configStore';
import { formationSpawnCount } from '../utils/formations';
import { GHOST_ENEMY_KEYS } from './GhostSpawner';
import { GRUNT_ENEMY_KEY } from './HordeSpawner';
import { CENTIPEDE_ENEMY_KEY } from './CentipedeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from './LaneTrafficSpawner';
import { computeSpawns as computeStrikeSpawns } from './StrikeSpawner';

// ── Style taxonomy ──────────────────────────────────────────────────

/**
 * Movement-style tag for an enemy-config key. The tag names the *way the
 * archetype moves*, which is what distinguishes one level from the next.
 */
function movementStyleOf(key: string): string {
  switch (key) {
    case 'scout':
      return 'v-drift';
    case 'diver':
      return 'diver';
    case 'tank':
      return 'rect';
    case 'swarm':
      return 'swarm';
    case 'phaser':
      return 'orbital-paths';
    case 'march':
      return 'stepping-march';
    case 'capturer':
      return 'tractor-descent';
    case 'ghost-chase':
    case 'ghost-ambush':
    case 'ghost-flank':
    case 'ghost-wander':
      return 'pursuit';
    case 'grunt':
      return 'homing';
    case 'raider':
      return 'patrol-dive';
    case 'lane-traffic':
      return 'lanes';
    case 'orbital-strike':
      return 'telegraphed-arcs';
    default:
      return 'other';
  }
}

/** Every archetype key a wave delivers (wave groups + spawner opt-in flags). */
function keysInWave(wave: WaveDefinition): string[] {
  const keys = wave.groups.map((group) => group.enemyKey);
  if (wave.ghosts) keys.push(...GHOST_ENEMY_KEYS);
  if (wave.centipede) keys.push(CENTIPEDE_ENEMY_KEY);
  if (wave.horde) keys.push(GRUNT_ENEMY_KEY);
  if (wave.laneTraffic) keys.push(LANE_TRAFFIC_ENEMY_KEY);
  return keys;
}

/**
 * Spawn weight of each archetype in a wave: groups contribute their real
 * spawned count (`formationSpawnCount`, so a `single` group counts once),
 * spawner flags contribute their scheduled archetypes once each.
 */
function waveWeightByStyle(wave: WaveDefinition): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (key: string, count: number): void => {
    const style = movementStyleOf(key);
    weights.set(style, (weights.get(style) ?? 0) + count);
  };
  for (const group of wave.groups) {
    add(group.enemyKey, formationSpawnCount(group.formation, group.count));
  }
  if (wave.ghosts) GHOST_ENEMY_KEYS.forEach((key) => add(key, 1));
  if (wave.centipede) add(CENTIPEDE_ENEMY_KEY, 1);
  if (wave.horde) add(GRUNT_ENEMY_KEY, 1);
  if (wave.laneTraffic) add(LANE_TRAFFIC_ENEMY_KEY, 1);
  return weights;
}

/** The movement style with the greatest spawned weight in a level. */
function dominantMovementStyle(level: LevelDefinition): string {
  const totals = new Map<string, number>();
  for (const wave of level.waves) {
    for (const [style, count] of waveWeightByStyle(wave)) {
      totals.set(style, (totals.get(style) ?? 0) + count);
    }
  }
  let best = '';
  let bestCount = -1;
  for (const [style, count] of totals) {
    if (count > bestCount) {
      best = style;
      bestCount = count;
    }
  }
  return best;
}

/** The set of movement styles present anywhere in a level. */
function movementStyles(level: LevelDefinition): Set<string> {
  const styles = new Set<string>();
  for (const wave of level.waves) {
    for (const key of keysInWave(wave)) styles.add(movementStyleOf(key));
  }
  return styles;
}

/** Stable, comparable signature of a movement-style set. */
function styleSignature(level: LevelDefinition): string {
  return [...movementStyles(level)].sort().join('+');
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Campaign design invariants for the ten-level campaign (AH-0MV398ZWL009TTOB)', () => {
  /** The real merged shipped campaign (default curve + candidate pool). */
  function campaign(): LevelDefinition[] {
    return buildSequencedLevels();
  }

  describe('style variety', () => {
    it('gives every adjacent pair of authored levels a different dominant movement style', () => {
      const dominants = LEVELS.map((level) => ({
        level: level.level,
        style: dominantMovementStyle(level),
      }));
      for (let i = 1; i < dominants.length; i++) {
        const previous = dominants[i - 1];
        const current = dominants[i];
        expect(
          current.style,
          `L${previous.level} and L${current.level} share dominant style ${current.style}`,
        ).not.toBe(previous.style);
      }
    });

    it('gives every authored level a distinct movement-style set from its neighbour', () => {
      for (let i = 1; i < LEVELS.length; i++) {
        expect(
          styleSignature(LEVELS[i]),
          `L${LEVELS[i - 1].level} and L${LEVELS[i].level} share a movement-style set`,
        ).not.toBe(styleSignature(LEVELS[i - 1]));
      }
    });

    it('keeps every adjacent pair of merged campaign levels stylistically distinct', () => {
      const merged = campaign();
      for (let i = 1; i < merged.length; i++) {
        expect(
          styleSignature(merged[i]),
          `merged L${merged[i - 1].level} and L${merged[i].level} share a movement-style set`,
        ).not.toBe(styleSignature(merged[i - 1]));
      }
    });
  });

  describe('difficulty continuity', () => {
    it('keeps the ten-level per-wave target curve non-decreasing', () => {
      const rows = [...defaultDifficultyCurves()].sort(
        (a, b) => a.level - b.level || a.wave - b.wave,
      );
      expect(rows.map((row) => row.level)).toContain(10);
      for (let i = 1; i < rows.length; i++) {
        expect(
          rows[i].targetDifficulty,
          `L${rows[i].level}W${rows[i].wave} drops below L${rows[i - 1].level}W${rows[i - 1].wave}`,
        ).toBeGreaterThanOrEqual(rows[i - 1].targetDifficulty);
      }
    });

    it('peaks beyond the previous five-level campaign final target', () => {
      const rows = [...defaultDifficultyCurves()].sort(
        (a, b) => a.level - b.level || a.wave - b.wave,
      );
      const finalTarget = rows[rows.length - 1].targetDifficulty;
      expect(rows[rows.length - 1].level).toBe(10);
      expect(finalTarget).toBeGreaterThan(62);
    });
  });

  describe('onboarding & authoring mix', () => {
    it('keeps Levels 1–3 no-fire and enables fire from Level 4 on', () => {
      for (const level of LEVELS) {
        for (const wave of level.waves) {
          expect(wave.shootEnabled, `L${level.level}`).toBe(level.level >= 4);
        }
      }
    });

    it('uses both fixed and dynamic waves, with every showcase wave fixed', () => {
      const rows = defaultDifficultyCurves();
      const modes = new Set(rows.map((row) => row.generation));
      expect(modes.has('fixed')).toBe(true);
      expect(modes.has('dynamic')).toBe(true);

      // Each new archetype debuts on a hand-authored fixed showcase wave.
      const showcase = new Set([
        '6:1', '6:2',
        '7:1', '7:2',
        '8:1', '8:2', '8:3',
        '9:1', '9:2',
        '10:1',
      ]);
      for (const row of rows) {
        if (showcase.has(`${row.level}:${row.wave}`)) {
          expect(row.generation, `L${row.level}W${row.wave}`).toBe('fixed');
        }
      }
    });
  });

  describe('per-level showcase coverage', () => {
    /** Classic-arcade archetypes keyed by a readable label. */
    const CLASSIC: ReadonlyArray<{ label: string; keys: readonly string[] }> = [
      { label: 'march', keys: ['march'] },
      { label: 'capturer', keys: ['capturer'] },
      { label: 'ghost-*', keys: GHOST_ENEMY_KEYS },
      { label: 'centipede', keys: [CENTIPEDE_ENEMY_KEY] },
      { label: 'grunt', keys: [GRUNT_ENEMY_KEY] },
      { label: 'raider', keys: ['raider'] },
      { label: 'lane-traffic', keys: [LANE_TRAFFIC_ENEMY_KEY] },
    ];

    it('introduces at least one classic-arcade archetype per new level 6–10', () => {
      const merged = campaign();
      for (const level of merged.filter((l) => l.level >= 6)) {
        const keys = new Set(level.waves.flatMap(keysInWave));
        const introduced = CLASSIC.some((entry) =>
          entry.keys.some((key) => keys.has(key)),
        );
        expect(introduced, `L${level.level} introduces no classic archetype`).toBe(
          true,
        );
      }
    });

    it('arms the orbital-strike hazard at the Level 9 showcase but not during onboarding', () => {
      // The strike planner is a campaign-wide telegraphed hazard. Find the
      // global wave index at which Level 9 ("Orbital Siege") begins and prove
      // the planner emits strikes there, while the opening waves do not.
      let globalIndex = 0;
      let levelNineStart = -1;
      for (const level of campaign()) {
        if (level.level === 9) levelNineStart = globalIndex;
        globalIndex += level.waves.length;
      }
      expect(levelNineStart).toBeGreaterThanOrEqual(0);

      const rng = () => 0.5;
      const atLevelNine = computeStrikeSpawns(
        levelNineStart,
        960,
        640,
        30,
        480,
        480,
        rng,
      );
      expect(atLevelNine.length).toBeGreaterThan(0);

      // The no-fire onboarding section (global wave 0) never arms a strike.
      expect(computeStrikeSpawns(0, 960, 640, 30, 480, 480, rng)).toEqual([]);
    });
  });
});

// ── 10-wave campaign & mini-boss verification harness (AH-0MVCRAHWO0007US2) ──
//
// Test-first verification for the expanded campaign (epic AH-0MVCC8XSS007P01Z):
// every level 1–10 must define exactly 10 waves with the 10th flagged as that
// level's mini-boss encounter, and the difficulty targets across all 100 waves
// must stay non-decreasing.
//
// These pins went GREEN once the production data landed (AH-0MVCYANT6003SG5C
// re-landed the 10-wave campaign data foundation), so they run as plain `it`
// and hard-gate the shipped shape.
describe('10-wave campaign & mini-boss verification harness (AH-0MVCRAHWO0007US2)', () => {
  /**
   * The wave-10 mini-boss marker the data foundation lands on every level's
   * 10th `WaveDefinition` (contract: `miniBoss === true`). Read through a
   * cast today so the harness compiles before the production type exists.
   */
  interface MiniBossMarkedWave extends WaveDefinition {
    miniBoss?: boolean;
  }

  /** The 10th wave of a level, or undefined when the level has fewer waves. */
  function tenthWave(level: LevelDefinition): WaveDefinition | undefined {
    return level.waves[9];
  }

  it('AC1 — every level 1–10 in LEVELS defines exactly 10 waves', () => {
    expect(LEVELS).toHaveLength(10);
    for (const level of LEVELS) {
      expect(
        level.waves.length,
        `L${level.level} (${level.name}) has ${level.waves.length} waves`,
      ).toBe(10);
    }
  });

  it('AC1/AC2 — the merged campaign has exactly 10 waves per level, 100 in total', () => {
    const merged = buildSequencedLevels();
    expect(merged).toHaveLength(10);
    const total = merged.reduce((sum, level) => sum + level.waves.length, 0);
    expect(total, 'campaign wave total').toBe(100);
    for (const level of merged) {
      expect(level.waves.length, `L${level.level}`).toBe(10);
    }
  });

  it("AC2 — wave 10 of every merged level is flagged as that level's mini-boss", () => {
    for (const level of buildSequencedLevels()) {
      const wave = tenthWave(level);
      expect(wave, `L${level.level} has no 10th wave`).toBeDefined();
      expect(
        (wave as MiniBossMarkedWave).miniBoss,
        `L${level.level} wave 10 is not flagged mini-boss`,
      ).toBe(true);
    }
  });

  it('AC3 — the default difficulty curve spans exactly 100 waves, 10 per level, non-decreasing', () => {
    const rows = [...defaultDifficultyCurves()].sort(
      (a, b) => a.level - b.level || a.wave - b.wave,
    );
    expect(rows).toHaveLength(100);
    const perLevel = new Map<number, number>();
    for (const row of rows) {
      perLevel.set(row.level, (perLevel.get(row.level) ?? 0) + 1);
    }
    for (let level = 1; level <= 10; level++) {
      expect(perLevel.get(level), `L${level} row count`).toBe(10);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].targetDifficulty).toBeGreaterThanOrEqual(
        rows[i - 1].targetDifficulty,
      );
    }
  });
});

/**
 * AH-0MV3953EO005V6HH — Campaign roster-coverage and player-targeter pairing
 * invariants for the ten-level campaign (parent epic AH-0MV29SBAQ000HQR2).
 *
 * The classic-arcade sprint added eight enemy archetypes but the shipped
 * campaign was still five levels, so the new roster was only reachable in the
 * gym scenes. These tests pin the two campaign-design invariants that guard
 * the expansion:
 *
 * 1. **Roster coverage** — the merged ten-level campaign delivers every one
 *    of the eight classic-arcade archetypes at least once.
 * 2. **Player-targeter pairing** — every wave that fields a player-targeting
 *    archetype (`capturer`, `ghost-*`, `grunt`, `raider`) also fields at
 *    least one non-player-targeting kind, so a targeter is never the sole
 *    threat a player faces in a wave.
 *
 * Everything is asserted through the public `buildSequencedLevels()` API (the
 * real merged campaign: the default difficulty curve and default candidate
 * pool) and the public spawner key constants. No production code is touched.
 *
 * Delivery seams (see `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §1.1):
 * `march`, `capturer` and `raider` ship as wave groups; `ghosts`,
 * `centipede`, `horde` and `laneTraffic` are spawner-delivered via per-wave
 * opt-in flags; `orbital-strike` is a campaign-wide telegraphed hazard whose
 * planner (`waves/StrikeSpawner.ts`) arms from `STRIKE_SPAWN_START_WAVE`
 * onward, so any wave at or after that global wave index delivers it.
 */

import { describe, expect, it } from 'vitest';

import { buildSequencedLevels } from './sequencedLevels';
import {
  LEVELS,
  LEVEL_COUNT,
  type LevelDefinition,
  type WaveDefinition,
} from './Formations';
import { GHOST_ENEMY_KEYS } from './GhostSpawner';
import { GRUNT_ENEMY_KEY } from './HordeSpawner';
import { CENTIPEDE_ENEMY_KEY } from './CentipedeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from './LaneTrafficSpawner';
import { STRIKE_SPAWN_START_WAVE } from './StrikeSpawner';

/**
 * Enemy-config key for the Missile-Command orbital strike. The entity exposes
 * no key constant, so the test pins the canonical key named by the roster
 * design (`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §1.1).
 */
const ORBITAL_STRIKE_ENEMY_KEY = 'orbital-strike';

// ── Wave → archetype helpers ────────────────────────────────────────

/**
 * Every spawner-delivered archetype key a wave opts into. The `ghosts` flag
 * releases all four Pac-Man personalities; the other flags map to one key.
 */
function spawnerKeysInWave(wave: WaveDefinition): string[] {
  const keys: string[] = [];
  if (wave.ghosts) keys.push(...GHOST_ENEMY_KEYS);
  if (wave.centipede) keys.push(CENTIPEDE_ENEMY_KEY);
  if (wave.horde) keys.push(GRUNT_ENEMY_KEY);
  if (wave.laneTraffic) keys.push(LANE_TRAFFIC_ENEMY_KEY);
  return keys;
}

/** Every archetype key a single wave delivers (wave groups + spawner opt-ins). */
function enemyKeysInWave(wave: WaveDefinition): string[] {
  return [
    ...wave.groups.map((group) => group.enemyKey),
    ...spawnerKeysInWave(wave),
  ];
}

/**
 * Every archetype key the campaign delivers, including the campaign-wide
 * orbital-strike hazard. The hazard has no per-wave flag, so it is derived
 * from each wave's cumulative (0-based) index: the strike planner arms from
 * `STRIKE_SPAWN_START_WAVE` onward.
 */
function campaignArchetypes(levels: readonly LevelDefinition[]): Set<string> {
  const keys = new Set<string>();
  let globalWaveIndex = 0;
  for (const level of levels) {
    for (const wave of level.waves) {
      for (const key of enemyKeysInWave(wave)) keys.add(key);
      if (globalWaveIndex >= STRIKE_SPAWN_START_WAVE) {
        keys.add(ORBITAL_STRIKE_ENEMY_KEY);
      }
      globalWaveIndex += 1;
    }
  }
  return keys;
}

/** One wave tagged with its `L<level>W<wave>` label for failure messages. */
interface LabelledWave {
  label: string;
  wave: WaveDefinition;
}

/** Every wave of a campaign, in play order, with a readable label. */
function allWaves(levels: readonly LevelDefinition[]): LabelledWave[] {
  const waves: LabelledWave[] = [];
  for (const level of levels) {
    level.waves.forEach((wave, index) => {
      waves.push({ label: `L${level.level}W${index + 1}`, wave });
    });
  }
  return waves;
}

// ── The roster and the targeter set ─────────────────────────────────

/** One required classic-arcade archetype (ghosts span four personality keys). */
interface RosterEntry {
  /** Roster label used in failure messages, e.g. `ghost-*`. */
  label: string;
  /** Whether the campaign delivers this archetype. */
  isPresent(keys: ReadonlySet<string>): boolean;
}

/** The eight classic-arcade archetypes the ten-level campaign must showcase. */
const CLASSIC_ROSTER: readonly RosterEntry[] = [
  { label: 'march', isPresent: (keys) => keys.has('march') },
  { label: 'capturer', isPresent: (keys) => keys.has('capturer') },
  {
    label: 'ghost-*',
    isPresent: (keys) => GHOST_ENEMY_KEYS.some((key) => keys.has(key)),
  },
  { label: 'centipede', isPresent: (keys) => keys.has(CENTIPEDE_ENEMY_KEY) },
  { label: 'grunt', isPresent: (keys) => keys.has(GRUNT_ENEMY_KEY) },
  { label: 'raider', isPresent: (keys) => keys.has('raider') },
  {
    label: 'orbital-strike',
    isPresent: (keys) => keys.has(ORBITAL_STRIKE_ENEMY_KEY),
  },
  {
    label: 'lane-traffic',
    isPresent: (keys) => keys.has(LANE_TRAFFIC_ENEMY_KEY),
  },
];

/**
 * Player-targeting archetypes: each steers at, homes on or dives onto the
 * live player. Parameterising the pairing test by this set means a new
 * targeter automatically gains coverage by being added here.
 */
const PLAYER_TARGETING_ARCHETYPES: readonly string[] = [
  'capturer',
  ...GHOST_ENEMY_KEYS,
  'grunt',
  'raider',
];

// ── Tests ───────────────────────────────────────────────────────────

describe('Campaign roster coverage and player-targeter pairing (AH-0MV3953EO005V6HH)', () => {
  /**
   * The real merged shipped campaign from the default difficulty curve and
   * default candidate pool (no test-only injection).
   */
  function campaign(): LevelDefinition[] {
    return buildSequencedLevels();
  }

  it('runs over the merged ten-level campaign', () => {
    expect(LEVEL_COUNT).toBe(10);
    expect(campaign().map((level) => level.level)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it.each(CLASSIC_ROSTER)(
    'delivers the $label archetype at least once',
    (entry) => {
      expect(entry.isPresent(campaignArchetypes(campaign()))).toBe(true);
    },
  );

  it('is not vacuous: the pre-expansion five-level campaign misses most of the roster', () => {
    const fiveLevelKeys = campaignArchetypes(LEVELS.slice(0, 5));
    const missing = CLASSIC_ROSTER.filter(
      (entry) => !entry.isPresent(fiveLevelKeys),
    ).map((entry) => entry.label);

    // The five-level campaign predates the classic roster, so seven of the
    // eight entries are absent (only the campaign-wide orbital strike, armed
    // from global wave index 3, is present). This proves the check can
    // actually fail rather than passing on any input.
    expect(missing).toEqual(
      expect.arrayContaining([
        'march',
        'capturer',
        'ghost-*',
        'centipede',
        'grunt',
        'raider',
        'lane-traffic',
      ]),
    );
  });

  it('delivers every player-targeting archetype at least once (so the pairing check is not vacuous)', () => {
    const keys = campaignArchetypes(campaign());
    for (const targeter of PLAYER_TARGETING_ARCHETYPES) {
      expect(keys.has(targeter), targeter).toBe(true);
    }
  });

  it.each(PLAYER_TARGETING_ARCHETYPES)(
    'pairs every wave containing %s with a non-player-targeting kind',
    (targeter) => {
      const targetingWaves = allWaves(campaign()).filter(({ wave }) =>
        enemyKeysInWave(wave).includes(targeter),
      );

      // The coverage test above guarantees the archetype is present, so this
      // list can never be empty; asserting it here stops a future roster
      // rename from silently making the pairing check vacuous.
      expect(
        targetingWaves.length,
        `no campaign wave contains ${targeter}`,
      ).toBeGreaterThan(0);

      for (const { label, wave } of targetingWaves) {
        const hasNonTargeter = enemyKeysInWave(wave).some(
          (key) => !PLAYER_TARGETING_ARCHETYPES.includes(key),
        );
        expect(
          hasNonTargeter,
          `${label} fields ${targeter} without a non-player-targeting kind`,
        ).toBe(true);
      }
    },
  );
});

// ── 10-wave campaign verification harness (AH-0MVCRAHWO0007US2) ──
//
// Test-first verification for the expanded campaign (epic AH-0MVCC8XSS007P01Z):
// every level must grow to exactly 10 waves (100 in total) with the 10th wave
// flagged as its mini-boss encounter, and the roster/pairing invariants above
// continue to hold across the expanded grid (they are data-driven, so they
// automatically span the 100 waves once the production data lands).
//
// RED against today's 29-wave campaign (AC5); run under `it.fails(...)` so the
// gate stays green. Flip each `it.fails` back to a plain `it` once the
// campaign-data item (AH-0MVCRAR89009C8GZ) lands the 10-wave rows.
describe('10-wave campaign verification harness — expanded grid (AH-0MVCRAHWO0007US2)', () => {
  it.fails('AC1 — the merged campaign spans exactly 10 waves per level, 100 in total', () => {
    const merged = buildSequencedLevels();
    expect(merged).toHaveLength(10);
    const total = merged.reduce((sum, level) => sum + level.waves.length, 0);
    expect(total, 'campaign wave total').toBe(100);
    for (const level of merged) {
      expect(level.waves.length, `L${level.level}`).toBe(10);
    }
  });

  it.fails('AC2/AC3 — every wave-10 mini-boss wave is part of the covered 100-wave grid', () => {
    const merged = buildSequencedLevels();
    for (const labelled of allWaves(merged)) {
      if (labelled.label.endsWith('W10')) {
        // The roster helpers must still recognise the mini-boss wave: it
        // delivers at least one enemy group (the mini-boss) and participates
        // in the archetype-reuse invariants like any other wave.
        expect(
          enemyKeysInWave(labelled.wave).length,
          `${labelled.label} mini-boss wave has no enemies`,
        ).toBeGreaterThan(0);
      }
    }
    // The grid really is 100 waves: without the expansion this loop sees no
    // W10 rows at all and the pairing/coverage invariants above would be
    // trivially vacuous for the mini-boss waves.
    expect(allWaves(merged).filter((l) => l.label.endsWith('W10'))).toHaveLength(10);
  });
});

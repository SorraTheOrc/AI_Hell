/**
 * Level & wave definitions for the playable game (GDD §3.2, §4.2).
 *
 * Pure data — no Phaser runtime dependency, so it is fully unit-testable.
 * Each of the ten levels is an ordered list of waves; a wave is one or
 * more groups of enemies that spawn together. Wave/level progression and
 * spawning are driven by `WaveManager` (`./WaveManager.ts`).
 *
 * GDD mapping (GDD §3.2):
 * - Level 1 — **Entry**: single enemy type, simple V-formation waves.
 * - Level 2 — **Descent**: mixed single-enemy waves, tighter formations.
 * - Level 3 — **The Core**: dense mixed *pairs* of enemy types.
 * - Level 4 — **Firestorm**: enemies begin firing projectiles.
 * - Level 5 — **Predictable Death**: fewer enemies, predictable patterns.
 * - Level 6 — **Invasion**: the classic-arcade roster debuts — a stepping
 *   Space-Invaders `march` plus the Galaga `capturer` tractor pull.
 * - Level 7 — **Segmented Assault**: the Centipede `centipede` chain winds
 *   around the arena while Pac-Man `ghosts` hunt the player.
 * - Level 8 — **Gridlock**: Frogger `laneTraffic` lanes, the Robotron
 *   `horde` rush and the Defender `raider` dive criss-cross the arena.
 * - Level 9 — **Orbital Siege**: Missile-Command `orbital-strike` arcs land
 *   among the orbital Phasers, with `ghosts` pursuing between barrages.
 * - Level 10 — **The Gauntlet**: a dense mixed finale pairing every
 *   remaining player-targeter with non-targeting archetypes.
 *
 * Levels 1–3 have `shootEnabled: false` ("enemies are the bullets",
 * GDD §2.4). Levels 4–10 have `shootEnabled: true` (GDD §2.5).
 *
 * Every wave that carries a player-targeting archetype (`capturer`,
 * `ghost-*`, `grunt`, `raider`) also carries at least one
 * non-player-targeting kind; adjacent levels differ in dominant
 * movement/attack style. Spawner-delivered archetypes opt in per wave via
 * the `ghosts`, `centipede`, `horde` and `laneTraffic` flags rather than as
 * wave groups (AH-0MV396OK0001FX14).
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { formationSpawnCount } from '../utils/formations';
import type { EnemyFormationKind } from '../utils/formations';

// ── Wave / level shapes ─────────────────────────────────────────────

/** One group of same-archetype enemies inside a wave. */
export interface WaveGroup {
  /** Enemy config key resolved through `loadEnemyConfig` / entity factory. */
  enemyKey: string;
  /** Formation geometry builder kind (see `utils/formations.ts`). */
  formation: EnemyFormationKind;
  /**
   * Number of enemies in this group. Must be `1` for the `single`
   * formation (it represents exactly one entity); see `validateWaveGroups`
   * in `./WaveManager.ts`.
   */
  count: number;
  /** Horizontal spacing between formation slots (px). */
  spacingX: number;
  /** Vertical spacing between formation slots (px). */
  spacingY: number;
  /** Formation base x at spawn (px). */
  startX: number;
  /** Formation base y at spawn (px). */
  startY: number;
  /**
   * Optional per-group spawn X range (px). When set, it overrides the
   * enemy archetype's configured range for this group; when absent the
   * group inherits the archetype's `startXMin`/`startXMax`
   * (AH-0MUKCLXLW0032R67, WG4 priority).
   */
  startXMin?: number;
  /** Optional per-group maximum spawn X (px). See {@link startXMin}. */
  startXMax?: number;
  /** Optional per-group spawn Y range (px). See {@link startXMin}. */
  startYMin?: number;
  /** Optional per-group maximum spawn Y (px). See {@link startXMin}. */
  startYMax?: number;
}

/** A set of enemies that spawn together and are cleared when all die. */
export interface WaveDefinition {
  /** Groups spawned together in this wave. */
  groups: WaveGroup[];
  /**
   * Whether enemies in this wave fire projectiles. `false` for Levels 1–3
   * ("enemies are the bullets", GDD §2.4); `true` for Levels 4–10
   * (GDD §2.5).
   */
  shootEnabled: boolean;
  /**
   * Opt-in flag for the Pac-Man ghost-pursuer group (classic-arcade
   * archetype, AH-0MV01EH2U008XT3Q). When `true`, the wave schedules the
   * four personality pursuers through the shared `GhostSpawner`; they are
   * registered with the `WaveManager` so they gate wave completion. Absent
   * (the default) leaves the wave exactly as it was — no behaviour change
   * for existing campaign data.
   */
  ghosts?: boolean;
  /**
   * Opt-in flag for the Centipede chain (classic-arcade archetype,
   * AH-0MV01EJ92008ZZ86). When `true`, the wave schedules one linked
   * Centipede chain through the shared `CentipedeSpawner`; every segment is
   * registered with the `WaveManager` so it gates wave completion. Absent
   * (the default) leaves the wave exactly as it was.
   */
  centipede?: boolean;
  /**
   * Opt-in flag for the Robotron homing-horde (classic-arcade archetype,
   * AH-0MV01EKTL001NRE6). When `true`, the wave schedules a timed horde of
   * grunts from the arena edges through the shared `HordeSpawner`; every
   * grunt is registered with the `WaveManager` so it gates wave completion.
   * Absent (the default) leaves the wave exactly as it was.
   */
  horde?: boolean;
  /**
   * Opt-in flag for the Frogger lane-traffic hazard (classic-arcade
   * archetype, AH-0MV01EPM40008N8T). When `true`, the wave schedules one to
   * three horizontal lanes of non-firing traffic through the shared
   * `LaneTrafficSpawner`. Traffic is a **non-blocking** world hazard (the
   * Asteroid accounting): it is never registered with the `WaveManager`, so
   * it neither gates nor stalls wave completion. Absent (the default) leaves
   * the wave exactly as it was.
   */
  laneTraffic?: boolean;
}

/** An ordered sequence of waves forming one level. */
export interface LevelDefinition {
  /** Level number (1–10). */
  level: number;
  /** Human-readable theme name (GDD §3.2), e.g. `The Core`. */
  name: string;
  /** Waves in play order; the level is cleared once all are wiped. */
  waves: WaveDefinition[];
}

/** Enemy config key of the final boss (E-Boss — the Central AI). */
export const BOSS_ENEMY_KEY = 'boss';

/** Default formation base x for spawned groups (off the left-centre). */
const START_X = GAME_WIDTH * 0.2;
/** Default formation base y for spawned groups. */
const START_Y = GAME_HEIGHT * 0.38;

/** Shorthand for a non-firing wave (Levels 1–3). */
function noFire(...groups: WaveGroup[]): WaveDefinition {
  return { groups, shootEnabled: false };
}

/** Shorthand for a firing wave (Levels 4–10). */
function openFire(...groups: WaveGroup[]): WaveDefinition {
  return { groups, shootEnabled: true };
}

/** Builds a wave group with sensible defaults for spacing/position. */
function group(
  enemyKey: string,
  formation: EnemyFormationKind,
  count: number,
  overrides: Partial<
    Pick<
      WaveGroup,
      'spacingX' | 'spacingY' | 'startX' | 'startY' |
      'startXMin' | 'startXMax' | 'startYMin' | 'startYMax'
    >
  > = {},
): WaveGroup {
  return {
    enemyKey,
    formation,
    count,
    spacingX: overrides.spacingX ?? 30,
    spacingY: overrides.spacingY ?? 26,
    startX: overrides.startX ?? START_X,
    startY: overrides.startY ?? START_Y,
    startXMin: overrides.startXMin,
    startXMax: overrides.startXMax,
    startYMin: overrides.startYMin,
    startYMax: overrides.startYMax,
  };
}

// ── Level definitions (GDD §3.2) ────────────────────────────────────

/**
 * The ten playable levels plus the boss trigger point. Index 0 is
 * Level 1; the boss is triggered after the final level is cleared.
 */
export const LEVELS: LevelDefinition[] = [
  {
    level: 1,
    name: 'Entry',
    // Single enemy type (Scouts), simple movement — no enemy fire.
    // Asteroids now come from the random spawner (GDD §4.1 — E6 Asteroid):
    // a non-firing rock that drifts in from a random offscreen edge,
    // wraps, and splits into two smaller rocks when shot.
    waves: [
      noFire(
        group('scout', 'v', 6, { spacingX: 28, spacingY: 22 }),
      ),
      noFire(group('scout', 'v', 8, { spacingX: 34, spacingY: 24 })),
    ],
  },
  {
    level: 2,
    name: 'Descent',
    // Mixed single-enemy waves (Scouts, then Divers, then Swarms).
    waves: [
      noFire(group('scout', 'v', 8)),
      noFire(group('diver', 'diver', 8, { spacingY: 28 })),
      noFire(group('swarm', 'swarm', 10, { spacingX: 26, spacingY: 22 })),
    ],
  },
  {
    level: 3,
    name: 'The Core',
    // Dense mixed pairs — two archetypes spawn together per wave.
    waves: [
      noFire(
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
        group('scout', 'v', 4, { startX: START_X + 120, spacingX: 26 }),
      ),
      noFire(
        group('diver', 'diver', 6, { spacingY: 30 }),
        group('scout', 'v', 4, { startX: START_X + 120, spacingX: 26 }),
      ),
      noFire(
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
        group('swarm', 'swarm', 10, { startX: START_X + 140, spacingX: 24 }),
      ),
    ],
  },
  {
    level: 4,
    name: 'Firestorm',
    // Enemies begin firing projectiles (GDD §2.5).
    waves: [
      openFire(group('diver', 'diver', 6, { spacingY: 30 })),
      openFire(group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 })),
      openFire(group('swarm', 'swarm', 10, { spacingX: 26, spacingY: 22 })),
    ],
  },
  {
    level: 5,
    name: 'Predictable Death',
    // Fewer enemies, structured memorisable patterns: Phasers only.
    waves: [
      openFire(group('phaser', 'orbital', 4, { spacingX: 84, spacingY: 84 })),
      openFire(group('phaser', 'orbital', 5, { spacingX: 80, spacingY: 80 })),
    ],
  },
  {
    level: 6,
    name: 'Invasion',
    // The classic-arcade roster debuts. Wave 1 is the Space-Invaders
    // `march` (a stepping formation that drops at the arena edge); wave 2
    // pairs the Galaga `capturer` tractor pull (a player-targeter) with
    // non-targeting tanks and swarms. Both showcase waves are hand-authored
    // (`fixed`) so the debut is guaranteed for a given run seed.
    waves: [
      openFire(
        group('march', 'march', 11, { spacingX: 26, spacingY: 24 }),
        group('scout', 'v', 4, { startX: START_X + 140, spacingX: 26 }),
      ),
      openFire(
        group('capturer', 'single', 1, { startX: START_X + 200, startY: START_Y - 40 }),
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
        group('swarm', 'swarm', 8, { startX: START_X + 150, spacingX: 24 }),
      ),
      openFire(
        group('diver', 'diver', 8, { spacingY: 28 }),
        group('phaser', 'orbital', 4, { spacingX: 84, spacingY: 84 }),
      ),
      openFire(
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44 }),
        group('swarm', 'swarm', 10, { spacingX: 26 }),
      ),
    ],
  },
  {
    level: 7,
    name: 'Segmented Assault',
    // Wave 1 launches the Centipede `centipede` chain (a winding segmented
    // column that gates the wave); wave 2 lets the Pac-Man `ghosts` loose to
    // pursue the live player, paired with non-targeting divers and Phasers.
    // The chain and pursuers are spawner-delivered, opted in per wave.
    waves: [
      {
        ...openFire(
          group('scout', 'v', 6),
          group('tank', 'rect', 4, { spacingX: 52, spacingY: 46 }),
        ),
        centipede: true,
      },
      {
        ...openFire(
          group('diver', 'diver', 6, { spacingY: 30 }),
          group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
        ),
        ghosts: true,
      },
      openFire(
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44 }),
        group('swarm', 'swarm', 10, { spacingX: 26 }),
      ),
      openFire(
        group('phaser', 'orbital', 5, { spacingX: 80, spacingY: 80 }),
        group('diver', 'diver', 8, { spacingY: 28 }),
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
      ),
    ],
  },
  {
    level: 8,
    name: 'Gridlock',
    // Three distinct non-formation movement styles: wave 1 is Frogger
    // `laneTraffic` (non-blocking horizontal lanes), wave 2 the Robotron
    // `horde` rush (a player-targeter, paired with non-targeting divers and
    // scouts), wave 3 the Defender `raider` dive (a player-targeter, paired
    // with orbital Phasers and a Swarm). All three are hand-authored
    // (`fixed`) so the showcase is guaranteed.
    waves: [
      {
        ...openFire(
          group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
          group('scout', 'v', 4, { startX: START_X + 140, spacingX: 26 }),
        ),
        laneTraffic: true,
      },
      {
        ...openFire(
          group('diver', 'diver', 6, { spacingY: 30 }),
          group('scout', 'v', 4, { startX: START_X + 140, spacingX: 26 }),
        ),
        horde: true,
      },
      openFire(
        group('raider', 'single', 1, { startX: START_X + 220, startY: START_Y - 60 }),
        group('raider', 'single', 1, { startX: START_X + 260, startY: START_Y + 60 }),
        group('phaser', 'orbital', 5, { spacingX: 80, spacingY: 80 }),
        group('swarm', 'swarm', 10, { spacingX: 26 }),
      ),
    ],
  },
  {
    level: 9,
    name: 'Orbital Siege',
    // Missile-Command `orbital-strike` arcs rain down from above: the level
    // is the campaign's Orbital Siege showcase and the telegraphed strike plan
    // (`waves/StrikeSpawner.ts`) is active for every wave this late in the
    // campaign, so the archetype is delivered as a non-blocking hazard rather
    // than a wave group (strikes are never wave-accounted and must never gate
    // wave completion). Wave 1 pairs orbital Phasers with tanks and divers;
    // wave 2 adds pursuing `ghosts` (a player-targeter, paired with
    // non-targeting tanks and divers); wave 3 is the generated orbital tail.
    waves: [
      openFire(
        group('tank', 'rect', 8, { spacingX: 50, spacingY: 44 }),
        group('diver', 'diver', 8, { spacingY: 28 }),
        group('swarm', 'swarm', 10, { spacingX: 26 }),
      ),
      {
        ...openFire(
          group('tank', 'rect', 8, { spacingX: 50, spacingY: 44 }),
          group('diver', 'diver', 8, { spacingY: 28 }),
        ),
        ghosts: true,
      },
      openFire(
        group('phaser', 'orbital', 6, { spacingX: 78, spacingY: 78 }),
        group('diver', 'diver', 8, { spacingY: 28 }),
        group('tank', 'rect', 6, { spacingX: 52, spacingY: 46 }),
      ),
    ],
  },
  {
    level: 10,
    name: 'The Gauntlet',
    // Dense mixed finale. Wave 1 pairs both remaining player-targeters
    // (`raider`, `capturer`) with non-targeting tanks, Phasers and divers,
    // and re-runs the `ghosts` and `horde` spawners for maximum pressure.
    // Wave 2 is the generated tail — a dense mix that still pairs its
    // `raider` with non-targeting Phasers, tanks and a Swarm.
    waves: [
      {
        ...openFire(
          group('raider', 'single', 1, { startX: START_X + 220, startY: START_Y - 70 }),
          group('capturer', 'single', 1, { startX: START_X + 260, startY: START_Y + 70 }),
          group('tank', 'rect', 8, { spacingX: 50, spacingY: 44 }),
          group('diver', 'diver', 10, { spacingY: 28 }),
          group('swarm', 'swarm', 10, { spacingX: 26 }),
        ),
        ghosts: true,
        horde: true,
      },
      openFire(
        group('phaser', 'orbital', 8, { spacingX: 76, spacingY: 76 }),
        group('tank', 'rect', 10, { spacingX: 48, spacingY: 42 }),
        group('swarm', 'swarm', 12, { spacingX: 26 }),
        group('raider', 'single', 1, { startX: START_X + 240, startY: START_Y }),
      ),
    ],
  },
];

/** Number of regular playable levels (10). */
export const LEVEL_COUNT = LEVELS.length;

/** Returns the level definition for a 1-based level number, or null. */
export function getLevelDefinition(level: number): LevelDefinition | null {
  return LEVELS[level - 1] ?? null;
}

/**
 * Total number of enemies across every wave of a level.
 *
 * Derived from each group's formation builder (not the raw `count` field)
 * so it matches what actually spawns — a `single` group always contributes
 * one enemy even if its declared count is inconsistent.
 */
export function enemyCountForLevel(level: number): number {
  const def = getLevelDefinition(level);
  if (!def) return 0;
  return def.waves.reduce(
    (sum, wave) =>
      sum + wave.groups.reduce((s, g) => s + formationSpawnCount(g.formation, g.count), 0),
    0,
  );
}

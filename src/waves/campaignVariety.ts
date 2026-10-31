/**
 * Campaign-wide enemy-composition variety audit (AH-0MVSE6D2L0034SKG).
 *
 * The parent epic (AH-0MVI5XXOU00954EA) turns "waves need more variation in
 * enemy types" into three campaign-wide invariants, recorded as AC1–AC3 on
 * that item:
 *
 * - **AC1 — sequential distinctness.** No two adjacent waves inside a level
 *   share the same enemy composition. "Same enemies" means the same *set* of
 *   enemy archetypes; order, spacing and count alone do not make a wave
 *   distinct (producer Q1 = a + explicit rule).
 * - **AC2 — whole-campaign coverage.** Every level shows more than one enemy
 *   archetype across its ten waves.
 * - **AC3 — level identity preserved.** Each level keeps the dominant
 *   archetype its GDD §3.2 identity describes, varying around it with
 *   secondary archetypes (producer Q2 = a).
 *
 * This module is the **single, pure measurement seam** for those three
 * invariants: the campaign tests, the authored-data rework items and the
 * documentation all consume it instead of reimplementing composition logic.
 * It has no Phaser/runtime dependency — only pure type/data modules and the
 * spawner key constants — so it runs in the fast unit project.
 *
 * The audit is deliberately read-only: it never mutates the campaign it is
 * given and never caches, so a test can compare two runs directly.
 *
 * @module campaignVariety
 */

import { formationSpawnCount } from '../utils/formations';
import type { LevelDefinition, WaveDefinition } from './Formations';
import { GHOST_ENEMY_KEYS } from './GhostSpawner';
import { CENTIPEDE_ENEMY_KEY } from './CentipedeSpawner';
import { GRUNT_ENEMY_KEY } from './HordeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from './LaneTrafficSpawner';

/** Separator used by {@link waveComposition} between sorted archetype keys. */
const COMPOSITION_SEPARATOR = '+';

/**
 * The documented dominant identity of one level (GDD §3.2).
 *
 * The identity is *dominance, not purity* (parent Q2 = a): a level keeps the
 * archetype that names it while secondary archetypes vary around it. A level
 * whose GDD identity is a deliberate mix (Level 4 Firestorm, Level 8
 * Gridlock, Level 10 The Gauntlet) carries `dominant: null` and relies on its
 * `showcase` keys instead of a single spawned-weight anchor.
 */
export interface LevelIdentity {
  /** Human-readable identity label, matching the GDD §3.2 level text. */
  readonly label: string;
  /**
   * The archetype expected to carry the greatest spawned weight across the
   * level, or `null` when the documented identity is a mix rather than a
   * single dominant archetype.
   */
  readonly dominant: string | null;
  /**
   * Archetype keys that express the level's identity and must therefore
   * appear somewhere in its ten waves (the classic-arcade showcases, the
   * spawner-delivered archetypes and the finale's player-targeters).
   */
  readonly showcase: readonly string[];
}

/**
 * The documented dominant archetype (and showcase archetypes) per level.
 *
 * Every entry carries its GDD §3.2 reference:
 *
 * - **Level 1 — Entry (GDD §3.2):** single enemy type, simple V-formation
 *   waves; scout-dominant.
 * - **Level 2 — Descent (GDD §3.2):** mixed single-enemy waves with a
 *   dive-led character; diver-dominant.
 * - **Level 3 — The Core (GDD §3.2):** dense mixed pairs; tank-core-dominant.
 * - **Level 4 — Firestorm (GDD §3.2):** the firing debut with a mixed
 *   diver/tank/swarm core — a deliberate mix, so no single dominant anchor.
 * - **Level 5 — Predictable Death (GDD §3.2):** fewer enemies in memorisable
 *   crosshair patterns; phaser-dominant.
 * - **Level 6 — Invasion (GDD §3.2):** the classic-arcade roster debuts with
 *   the Space-Invaders march; march-dominant, with the Galaga capturer.
 * - **Level 7 — Segmented Assault (GDD §3.2):** the Centipede chain plus
 *   Pac-Man ghosts around a tank line; tank-dominant.
 * - **Level 8 — Gridlock (GDD §3.2):** Frogger lanes, the Robotron horde and
 *   the Defender raider criss-cross the arena — a deliberate showcase mix
 *   with no single dominant formation archetype.
 * - **Level 9 — Orbital Siege (GDD §3.2):** Missile-Command arcs landing
 *   among the orbital Phasers, with ghosts pursuing between barrages;
 *   phaser-dominant.
 * - **Level 10 — The Gauntlet (GDD §3.2):** the dense mixed finale pairing
 *   every remaining player-targeter — a deliberate mix, so no single
 *   dominant anchor (the gauntlet's raider/capturer/horde showcase is
 *   asserted through `showcase`).
 */
export const LEVEL_IDENTITY: Readonly<Record<number, LevelIdentity>> = {
  1: {
    label: 'Entry — scout-led V-formation ramp',
    dominant: 'scout',
    showcase: ['scout'],
  },
  2: {
    label: 'Descent — dive-led single-enemy waves',
    dominant: 'diver',
    showcase: ['diver'],
  },
  3: {
    label: 'The Core — tank cores in mixed pairs',
    dominant: 'tank',
    showcase: ['tank'],
  },
  4: {
    label: 'Firestorm — firing debut with a mixed core',
    dominant: null,
    showcase: ['diver', 'tank', 'swarm'],
  },
  5: {
    label: 'Predictable Death — phaser crosshair grid',
    dominant: 'phaser',
    showcase: ['phaser'],
  },
  6: {
    label: 'Invasion — marching columns and the capturer',
    dominant: 'march',
    showcase: ['march', 'capturer'],
  },
  7: {
    label: 'Segmented Assault — tank line with centipede and ghosts',
    dominant: 'tank',
    showcase: [CENTIPEDE_ENEMY_KEY, GHOST_ENEMY_KEYS[0]],
  },
  8: {
    label: 'Gridlock — lane traffic, horde and raider showcase',
    dominant: null,
    showcase: [LANE_TRAFFIC_ENEMY_KEY, GRUNT_ENEMY_KEY, 'raider'],
  },
  9: {
    label: 'Orbital Siege — phaser siege line with ghosts',
    dominant: 'phaser',
    showcase: ['phaser', GHOST_ENEMY_KEYS[0]],
  },
  10: {
    label: 'The Gauntlet — dense player-targeter finale',
    dominant: null,
    showcase: ['raider', 'capturer', GRUNT_ENEMY_KEY],
  },
};

/** One adjacent wave pair inside a level that shares an archetype set. */
export interface AdjacentCompositionDuplicate {
  /** Level number the pair belongs to. */
  readonly level: number;
  /** 1-based wave number of the earlier wave. */
  readonly previousWave: number;
  /** 1-based wave number of the later wave. */
  readonly wave: number;
  /** Shared composition signature (see {@link waveComposition}). */
  readonly composition: string;
}

/** Per-level variety measurements. */
export interface LevelVarietyAudit {
  /** Level number. */
  readonly level: number;
  /** Level name (GDD §3.2). */
  readonly name: string;
  /**
   * Distinct archetype keys delivered anywhere in the level, sorted. Wave
   * groups and spawner opt-in flags both count.
   */
  readonly distinctArchetypes: string[];
  /** Length of {@link distinctArchetypes}. */
  readonly distinctArchetypeCount: number;
  /**
   * Heaviest archetype across the level by spawned weight, or `null` for a
   * level with no waves. Ties break alphabetically so the audit is stable.
   */
  readonly dominantArchetype: string | null;
  /** Spawned weight of {@link dominantArchetype} (0 when there is none). */
  readonly dominantWeight: number;
  /**
   * Whether every adjacent wave pair inside the level is compositionally
   * distinct. A level with fewer than two waves is trivially distinct.
   */
  readonly distinct: boolean;
}

/** Result of {@link auditCampaignVariety}. */
export interface CampaignVarietyAudit {
  /** Every adjacent pair that repeats a composition, in campaign order. */
  readonly adjacentDuplicates: AdjacentCompositionDuplicate[];
  /** Per-level measurements, ascending by level number. */
  readonly levels: LevelVarietyAudit[];
  /** Total waves examined across the campaign. */
  readonly totalWaves: number;
  /** Whether the whole campaign has no adjacent composition duplicate. */
  readonly distinct: boolean;
}

/**
 * Every archetype key a wave delivers, in delivery order and with
 * duplicates preserved: the wave's explicit groups first, then the
 * archetypes scheduled by its opt-in spawner flags.
 *
 * The flag mapping mirrors the shared spawners' key constants exactly, so a
 * flag can never be audited with a stale archetype name.
 */
function archetypeKeysInWave(wave: WaveDefinition): string[] {
  const keys = wave.groups.map((group) => group.enemyKey);
  if (wave.ghosts) keys.push(...GHOST_ENEMY_KEYS);
  if (wave.centipede) keys.push(CENTIPEDE_ENEMY_KEY);
  if (wave.horde) keys.push(GRUNT_ENEMY_KEY);
  if (wave.laneTraffic) keys.push(LANE_TRAFFIC_ENEMY_KEY);
  return keys;
}

/**
 * Sorted, de-duplicated archetype keys a wave delivers.
 *
 * This is the per-wave presence unit behind {@link waveComposition}: a test
 * asserting that an archetype appears in every wave (the identity-preserving
 * replacement for a single-type purity pin, parent Q2 = a) reads the list
 * directly instead of reimplementing the group/flag traversal.
 *
 * @param wave — the wave to inspect.
 * @returns archetype keys in ascending order (duplicates removed); an empty
 *   array for a wave that delivers no archetype at all.
 */
export function waveArchetypes(wave: WaveDefinition): string[] {
  return [...new Set(archetypeKeysInWave(wave))].sort();
}

/**
 * Sorted, de-duplicated archetype signature of a wave.
 *
 * This is the AC1 comparison unit: two waves have the "same enemies" exactly
 * when their signatures are equal. Count, spacing, group order and duplicate
 * groups therefore cannot manufacture variety, while adding an archetype (as
 * a group or a spawner opt-in flag) always changes the signature.
 *
 * @param wave — the wave to fingerprint.
 * @returns archetype keys joined by `+` in ascending order; the empty string
 *   for a wave that delivers no archetype at all.
 */
export function waveComposition(wave: WaveDefinition): string {
  return waveArchetypes(wave).join(COMPOSITION_SEPARATOR);
}

/**
 * Spawned weight of every archetype in a wave.
 *
 * Group weight uses {@link formationSpawnCount}, the shared "declared vs
 * spawned" source of truth, so a `single` group counts once regardless of its
 * declared `count`. Each spawner opt-in contributes one per scheduled
 * archetype (all four ghost personalities for `ghosts`), matching the demo
 * population the player actually sees.
 */
function waveWeightByArchetype(wave: WaveDefinition): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (key: string, weight: number): void => {
    weights.set(key, (weights.get(key) ?? 0) + weight);
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

/** The heaviest archetype in a weight table (ties break alphabetically). */
function heaviestArchetype(weights: Map<string, number>): {
  key: string | null;
  weight: number;
} {
  let key: string | null = null;
  let weight = 0;
  for (const [candidate, candidateWeight] of weights) {
    if (
      candidateWeight > weight ||
      (candidateWeight === weight && (key === null || candidate < key))
    ) {
      key = candidate;
      weight = candidateWeight;
    }
  }
  return { key, weight };
}

/**
 * 1-based wave numbers inside a level whose composition repeats the wave
 * immediately before them. A level with fewer than two waves yields none.
 */
function adjacentDuplicateWaves(level: LevelDefinition): number[] {
  const duplicates: number[] = [];
  let previous = '';
  level.waves.forEach((wave, index) => {
    const composition = waveComposition(wave);
    if (index > 0 && composition === previous) duplicates.push(index + 1);
    previous = composition;
  });
  return duplicates;
}

/** Measure one level's composition variety. */
function auditLevel(level: LevelDefinition): LevelVarietyAudit {
  const archetypes = new Set<string>();
  const weights = new Map<string, number>();
  for (const wave of level.waves) {
    archetypeKeysInWave(wave).forEach((key) => archetypes.add(key));
    for (const [key, weight] of waveWeightByArchetype(wave)) {
      weights.set(key, (weights.get(key) ?? 0) + weight);
    }
  }

  const heaviest = heaviestArchetype(weights);
  return {
    level: level.level,
    name: level.name,
    distinctArchetypes: [...archetypes].sort(),
    distinctArchetypeCount: archetypes.size,
    dominantArchetype: heaviest.key,
    dominantWeight: heaviest.weight,
    distinct: adjacentDuplicateWaves(level).length === 0,
  };
}

/**
 * Audit a whole campaign against the AC1–AC3 variety invariants.
 *
 * Adjacency is evaluated **within** a level (parent assumption: "sequential"
 * means consecutive waves of the same level; a level's final wave is never
 * compared with the next level's first wave).
 *
 * @param levels — the campaign to audit, typically the output of
 *   `buildSequencedLevels()`. Never mutated.
 * @returns the adjacent duplicate list (AC1), per-level measurements (AC2,
 *   AC3) and the campaign-wide `distinct` verdict.
 */
export function auditCampaignVariety(
  levels: readonly LevelDefinition[],
): CampaignVarietyAudit {
  const adjacentDuplicates: AdjacentCompositionDuplicate[] = [];
  const levelAudits: LevelVarietyAudit[] = [];
  let totalWaves = 0;

  for (const level of levels) {
    levelAudits.push(auditLevel(level));
    totalWaves += level.waves.length;
    for (const wave of adjacentDuplicateWaves(level)) {
      adjacentDuplicates.push({
        level: level.level,
        previousWave: wave - 1,
        wave,
        composition: waveComposition(level.waves[wave - 1]),
      });
    }
  }

  levelAudits.sort((a, b) => a.level - b.level);
  return {
    adjacentDuplicates,
    levels: levelAudits,
    totalWaves,
    distinct: adjacentDuplicates.length === 0,
  };
}

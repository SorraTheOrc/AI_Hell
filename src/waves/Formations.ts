/**
 * Level & wave definitions for the playable game (GDD §3.2, §4.2).
 *
 * Pure data — no Phaser runtime dependency, so it is fully unit-testable.
 * Each of the five levels is an ordered list of waves; a wave is one or
 * more groups of enemies that spawn together. Wave/level progression and
 * spawning are driven by `WaveManager` (`./WaveManager.ts`).
 *
 * GDD mapping (GDD §3.2):
 * - Level 1 — **Entry**: single enemy type, simple V-formation waves.
 * - Level 2 — **Descent**: mixed single-enemy waves, tighter formations.
 * - Level 3 — **The Core**: dense mixed *pairs* of enemy types.
 * - Level 4 — **Firestorm**: enemies begin firing projectiles.
 * - Level 5 — **Predictable Death**: fewer enemies, predictable patterns.
 *
 * Levels 1–3 have `shootEnabled: false` ("enemies are the bullets",
 * GDD §2.4). Levels 4–5 have `shootEnabled: true` (GDD §2.5).
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { EnemyFormationKind } from '../utils/formations';

// ── Wave / level shapes ─────────────────────────────────────────────

/** One group of same-archetype enemies inside a wave. */
export interface WaveGroup {
  /** Enemy config key resolved through `loadEnemyConfig` / entity factory. */
  enemyKey: string;
  /** Formation geometry builder kind (see `utils/formations.ts`). */
  formation: EnemyFormationKind;
  /** Number of enemies in this group. */
  count: number;
  /** Horizontal spacing between formation slots (px). */
  spacingX: number;
  /** Vertical spacing between formation slots (px). */
  spacingY: number;
  /** Formation base x at spawn (px). */
  startX: number;
  /** Formation base y at spawn (px). */
  startY: number;
}

/** A set of enemies that spawn together and are cleared when all die. */
export interface WaveDefinition {
  /** Groups spawned together in this wave. */
  groups: WaveGroup[];
  /**
   * Whether enemies in this wave fire projectiles. `false` for Levels 1–3
   * ("enemies are the bullets", GDD §2.4); `true` for Levels 4–5
   * (GDD §2.5).
   */
  shootEnabled: boolean;
}

/** An ordered sequence of waves forming one level. */
export interface LevelDefinition {
  /** Level number (1–5). */
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

/** Shorthand for a firing wave (Levels 4–5). */
function openFire(...groups: WaveGroup[]): WaveDefinition {
  return { groups, shootEnabled: true };
}

/** Builds a wave group with sensible defaults for spacing/position. */
function group(
  enemyKey: string,
  formation: EnemyFormationKind,
  count: number,
  overrides: Partial<Pick<WaveGroup, 'spacingX' | 'spacingY' | 'startX' | 'startY'>> = {},
): WaveGroup {
  return {
    enemyKey,
    formation,
    count,
    spacingX: overrides.spacingX ?? 30,
    spacingY: overrides.spacingY ?? 26,
    startX: overrides.startX ?? START_X,
    startY: overrides.startY ?? START_Y,
  };
}

// ── Level definitions (GDD §3.2) ────────────────────────────────────

/**
 * The five playable levels plus the boss trigger point. Index 0 is
 * Level 1; the boss is triggered after the final level is cleared.
 */
export const LEVELS: LevelDefinition[] = [
  {
    level: 1,
    name: 'Entry',
    // Single enemy type (Scouts), simple movement — no enemy fire.
    waves: [
      noFire(group('scout', 'v', 6, { spacingX: 28, spacingY: 22 })),
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
];

/** Number of regular playable levels (5). */
export const LEVEL_COUNT = LEVELS.length;

/** Returns the level definition for a 1-based level number, or null. */
export function getLevelDefinition(level: number): LevelDefinition | null {
  return LEVELS[level - 1] ?? null;
}

/** Total number of enemies across every wave of a level. */
export function enemyCountForLevel(level: number): number {
  const def = getLevelDefinition(level);
  if (!def) return 0;
  return def.waves.reduce(
    (sum, wave) =>
      sum + wave.groups.reduce((s, g) => s + g.count, 0),
    0,
  );
}

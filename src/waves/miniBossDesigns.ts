/**
 * The ten bespoke per-level mini-boss designs (epic AH-0MVCC8XSS007P01Z,
 * AH-0MVCRBXSS008JSV0).
 *
 * Every campaign level's wave 10 is its mini-boss encounter (see
 * `WaveManager`). This module is the **single data source** for that
 * encounter's identity and behaviour: one {@link MiniBossDesign} per level,
 * 1–10, each a named net-new archetype layered on the reusable
 * {@link MiniBoss} entity family (AH-0MVCRAYSH0014BQJ). Designs are pure data
 * — phases/pattern sets, HP, colour and optional minion waves — so the game
 * (`PlayScene.miniBossConfigFor`) and the gym (`GymMiniBoss`) consume exactly
 * the same configuration through the shared entity (gym↔game parity).
 *
 * Design intent:
 *
 * - **Escalation** — the hit pool per phase and the number of phases rise
 *   with the level, so a level-10 mini-boss is materially longer than a
 *   level-1 one while staying below the final boss.
 * - **Distinct phase sets** — no two levels share a phase/pattern sequence,
 *   so each encounter reads differently.
 * - **Net-new archetypes** — every design is a new named alien beyond the
 *   shipped 17-archetype roster (they are mini-boss encounters, not regular
 *   wave enemies).
 *
 * Positions are supplied by the caller (the game centres the encounter like
 * the final boss; the gym uses its formation anchor), so a design carries no
 * x/y/formation data.
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  MINI_BOSS_DEFAULT_HP_PER_PHASE,
  type MiniBossConfig,
  type MiniBossMinionWaveConfig,
  type MiniBossPattern,
} from '../entities/MiniBoss';
import type { FormationOffset } from '../utils/formations';

/** Number of campaign levels that carry a bespoke mini-boss design. */
export const MINI_BOSS_DESIGN_LEVELS = 10;

/**
 * One level's bespoke mini-boss design: everything except the live position
 * and RNG, which the spawning context supplies.
 */
export interface MiniBossDesign {
  /** Campaign level this design belongs to (1–10). */
  level: number;
  /**
   * The design's net-new alien archetype name (the encounter's display name
   * and its catalogue identity).
   */
  archetype: string;
  /** Body colour. */
  color: number;
  /** Final-phase body colour (defaults to {@link color} in the config). */
  desperationColor?: number;
  /** Hits to deplete each phase. */
  hpPerPhase: number;
  /** Phase pattern set, one entry per phase (all distinct per design). */
  phases: readonly MiniBossPattern[];
  /** Optional per-phase minion waves. */
  minions?: readonly MiniBossMinionWaveConfig[];
}

/**
 * The ten designs, indexed by level (index 0 = level 1). Kept as one literal
 * so the catalogue is auditable at a glance and the 1:1 level mapping is
 * testable without reading code paths.
 */
export const MINI_BOSS_DESIGNS: readonly MiniBossDesign[] = [
  {
    level: 1,
    archetype: 'Pulse Warden',
    color: 0x66ddff,
    desperationColor: 0xaaf2ff,
    hpPerPhase: 12,
    phases: ['spread', 'pulse'],
  },
  {
    level: 2,
    archetype: 'Coil Sentinel',
    color: 0x88ff66,
    desperationColor: 0xc4ffb0,
    hpPerPhase: 14,
    phases: ['spiral', 'combined'],
  },
  {
    level: 3,
    archetype: 'Shard Matron',
    color: 0xffcc33,
    desperationColor: 0xffe79a,
    hpPerPhase: 16,
    phases: ['pulse', 'spiral', 'pulse'],
    minions: [
      {
        phase: 1,
        shootEnabled: true,
        groups: [
          {
            enemyKey: 'scout',
            formation: 'v',
            count: 2,
            spacingX: 30,
            spacingY: 24,
            startX: GAME_WIDTH * 0.15,
            startY: GAME_HEIGHT * 0.28,
          },
        ],
      },
    ],
  },
  {
    level: 4,
    archetype: 'Void Herald',
    color: 0xaa55ff,
    desperationColor: 0xd6aaff,
    hpPerPhase: 18,
    phases: ['combined', 'spread', 'pulse'],
  },
  {
    level: 5,
    archetype: 'Ion Tyrant',
    color: 0x33e0ff,
    desperationColor: 0x9af3ff,
    hpPerPhase: 20,
    phases: ['spiral', 'spiral', 'pulse'],
    minions: [
      {
        phase: 2,
        shootEnabled: true,
        groups: [
          {
            enemyKey: 'diver',
            formation: 'diver',
            count: 2,
            spacingX: 34,
            spacingY: 26,
            startX: GAME_WIDTH * 0.68,
            startY: GAME_HEIGHT * 0.22,
          },
        ],
      },
    ],
  },
  {
    level: 6,
    archetype: 'Cinder Maw',
    color: 0xff5522,
    desperationColor: 0xffa07a,
    hpPerPhase: 22,
    phases: ['pulse', 'combined', 'spread'],
  },
  {
    level: 7,
    archetype: 'Prism Wraith',
    color: 0x66ffcc,
    desperationColor: 0xb3ffe6,
    hpPerPhase: 24,
    phases: ['spread', 'pulse', 'combined'],
    minions: [
      {
        phase: 2,
        shootEnabled: true,
        groups: [
          {
            enemyKey: 'scout',
            formation: 'rect',
            count: 3,
            spacingX: 28,
            spacingY: 22,
            startX: GAME_WIDTH * 0.2,
            startY: GAME_HEIGHT * 0.3,
          },
        ],
      },
    ],
  },
  {
    level: 8,
    archetype: 'Gravemind',
    color: 0xbb88ff,
    desperationColor: 0xdec7ff,
    hpPerPhase: 26,
    phases: ['spiral', 'combined', 'spiral', 'pulse'],
  },
  {
    level: 9,
    archetype: 'Star Eater',
    color: 0xff88dd,
    desperationColor: 0xffc2ee,
    hpPerPhase: 28,
    phases: ['combined', 'pulse', 'spiral', 'spread'],
    minions: [
      {
        phase: 3,
        shootEnabled: true,
        groups: [
          {
            enemyKey: 'diver',
            formation: 'diver',
            count: 2,
            spacingX: 32,
            spacingY: 26,
            startX: GAME_WIDTH * 0.7,
            startY: GAME_HEIGHT * 0.24,
          },
        ],
      },
    ],
  },
  {
    level: 10,
    archetype: 'The Hollow King',
    color: 0xff3355,
    desperationColor: 0xff8fa3,
    hpPerPhase: 32,
    phases: ['spread', 'spiral', 'pulse', 'combined'],
    minions: [
      {
        phase: 4,
        shootEnabled: true,
        groups: [
          {
            enemyKey: 'scout',
            formation: 'v',
            count: 3,
            spacingX: 30,
            spacingY: 24,
            startX: GAME_WIDTH * 0.2,
            startY: GAME_HEIGHT * 0.28,
          },
        ],
      },
    ],
  },
];

/**
 * Returns the bespoke design for a campaign level.
 *
 * @param level - 1-based campaign level.
 * @returns The level's design.
 * @throws RangeError when the level has no design (outside 1–10).
 */
export function miniBossDesignForLevel(level: number): MiniBossDesign {
  const design = MINI_BOSS_DESIGNS.find((candidate) => candidate.level === level);
  if (!design) {
    throw new RangeError(
      `No mini-boss design for level ${String(level)} — designs exist for ` +
        `levels 1–${MINI_BOSS_DESIGN_LEVELS}.`,
    );
  }
  return design;
}

/** Options a spawning context supplies to build a live mini-boss config. */
export interface MiniBossSpawnOptions {
  /** World x of the encounter. */
  x: number;
  /** World y of the encounter. */
  y: number;
  /** Formation offset required by the shared entity interface. */
  formationOffset: FormationOffset;
  /** Injectable random source (fire rolls / minion placement). */
  rng?: () => number;
  /** Default hit pool used when a design does not specify one. */
  defaultHpPerPhase?: number;
  /**
   * Explicit hit-pool override. The gym uses a small pool so a tester can
   * step through every phase quickly; the game always uses the design's own
   * escalation value.
   */
  hpPerPhase?: number;
}

/**
 * Builds the {@link MiniBossConfig} for a level's bespoke design, ready to
 * hand to `new MiniBoss(scene, config)`. The game and the gym both use this
 * so a design cannot diverge between them (gym↔game parity).
 *
 * @param level - 1-based campaign level.
 * @param options - Live position/formation/RNG supplied by the caller.
 * @returns A validated-shape config (the entity performs the final
 *   validation and throws `MiniBossConfigError` on a bad design).
 */
export function miniBossConfigForLevel(
  level: number,
  options: MiniBossSpawnOptions,
): MiniBossConfig {
  const design = miniBossDesignForLevel(level);
  return {
    level: design.level,
    name: design.archetype,
    x: options.x,
    y: options.y,
    formationOffset: options.formationOffset,
    color: design.color,
    desperationColor: design.desperationColor,
    hpPerPhase:
      options.hpPerPhase ??
      design.hpPerPhase ??
      options.defaultHpPerPhase ??
      MINI_BOSS_DEFAULT_HP_PER_PHASE,
    phases: design.phases.map((pattern) => ({ pattern })),
    minions: design.minions?.map((wave) => ({
      ...wave,
      groups: wave.groups.map((group) => ({ ...group })),
    })),
    rng: options.rng,
  };
}

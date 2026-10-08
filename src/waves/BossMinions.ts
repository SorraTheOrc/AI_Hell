/**
 * Boss minion spawning (GDD §4.3).
 *
 * The Central AI boss summons formation minions as a phase mechanic:
 *
 * - **Phase 1 — Scan:** formation enemies spawn on the sides.
 * - **Phase 2 — Firestorm:** enemies dive from the top and bottom.
 * - **Phase 3 — Pulse:** no minions (the screen-wide pulse is the threat).
 * - **Phase 4 — Desperation:** a swarm cluster reinforces the boss.
 *
 * Pure data + planning — no Phaser dependency — so the minion logic is
 * unit-testable. `PlayScene` consumes {@link planMinionSpawns} when the
 * boss advances to a new phase.
 */

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import type { WaveGroup } from './Formations';
import { planGroupSpawns, wavePlannedSpawnCount, type EnemySpawn } from './WaveManager';

/** Minion groups that accompany one boss phase. */
export interface BossMinionWave {
  /** Phase number (1–4) this wave accompanies. */
  phase: number;
  /** Groups spawned when the phase begins. */
  groups: WaveGroup[];
  /** Whether the minions fire projectiles. */
  shootEnabled: boolean;
}

/** Shorthand for a minion group. */
function group(
  enemyKey: string,
  formation: WaveGroup['formation'],
  count: number,
  startX: number,
  startY: number,
  spacingX = 28,
  spacingY = 24,
): WaveGroup {
  return { enemyKey, formation, count, spacingX, spacingY, startX, startY };
}

/**
 * The minion wave for each boss phase (GDD §4.3). Phase 3 spawns none;
 * phases 1, 2 and 4 reinforce the boss: phase 1 summons **12 scouts**
 * (two groups of 6), phase 2 **12 divers** (two groups of 6), and phase 4
 * a single **15-strong swarm**. Counts are retuned on the boss encounter
 * (AH-0MUZMTRW00065PID) without changing formations, keys, fire gating or
 * phase-3 emptiness.
 */
export const BOSS_MINION_WAVES: Record<number, BossMinionWave> = {
  1: {
    phase: 1,
    groups: [
      group('scout', 'v', 6, GAME_WIDTH * 0.08, GAME_HEIGHT * 0.3),
      group('scout', 'v', 6, GAME_WIDTH * 0.78, GAME_HEIGHT * 0.3),
    ],
    shootEnabled: true,
  },
  2: {
    phase: 2,
    groups: [
      group('diver', 'diver', 6, GAME_WIDTH * 0.3, GAME_HEIGHT * 0.06, 30, 26),
      group('diver', 'diver', 6, GAME_WIDTH * 0.6, GAME_HEIGHT * 0.06, 30, 26),
    ],
    shootEnabled: true,
  },
  3: {
    phase: 3,
    groups: [],
    shootEnabled: false,
  },
  4: {
    phase: 4,
    // Base X sits left of centre: the swarm clusters grow rightward, so the
    // wider 15-strong formation must start further out to keep every member
    // clear of the boss body (AH-0MUZMTRW00065PID).
    groups: [group('swarm', 'swarm', 15, GAME_WIDTH * 0.26, GAME_HEIGHT * 0.18)],
    shootEnabled: true,
  },
};

/** Returns the minion wave for a boss phase, or null for unknown phases. */
export function minionsForPhase(phase: number): BossMinionWave | null {
  return BOSS_MINION_WAVES[phase] ?? null;
}

/**
 * Plans the concrete minion spawns for a boss phase. Returns an empty
 * array for phases with no minions (or unknown phases).
 *
 * @param phase — boss phase number (1–4).
 * @param rng — RNG for range-based positioning; defaults to `Math.random`.
 *   The scene passes its own RNG so minion positions match the game stream.
 */
export function planMinionSpawns(
  phase: number,
  rng: () => number = Math.random,
): EnemySpawn[] {
  const wave = minionsForPhase(phase);
  if (!wave || wave.groups.length === 0) return [];
  return planGroupSpawns(wave.groups, wave.shootEnabled, rng);
}

/**
 * Total number of minions spawned for a phase (0 when none). Derived from
 * the formation builders (not the raw `count` field) so it always matches
 * `planMinionSpawns(phase).length`.
 */
export function minionCountForPhase(phase: number): number {
  const wave = minionsForPhase(phase);
  if (!wave) return 0;
  return wavePlannedSpawnCount(wave.groups);
}

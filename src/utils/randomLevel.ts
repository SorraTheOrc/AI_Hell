/**
 * Seeded random-level generator for the bot-tuning gym (AH-0MV4D7LAD009XYR0).
 *
 * The gym needs a supply of *random but reproducible* levels: a designer can
 * watch the bot play a fresh scenario, and a maintainer can replay the exact
 * same scenario by reusing the seed. This module wraps the shipped runtime
 * auto-sequencer (`src/core/difficultySequencer.ts`) — the same code the
 * campaign uses for `curve`/`dynamic` waves — so a random level is a real,
 * playable `LevelDefinition` with no bespoke composition logic.
 *
 * Determinism: the only entropy source is the seed. Two calls with the same
 * seed produce byte-identical levels; the generator never reads the wall
 * clock or `Math.random()`.
 *
 * @module src/utils/randomLevel
 */

import {
  defaultCandidatePool,
  sequencer,
  type AdjustedGroup,
  type CandidateGroup,
  type ShootableWave,
} from '../core/difficultySequencer';
import { createSeededRng, normaliseSeed } from '../core/rng';
import type { EnemyFormationKind } from '../utils/formations';
import type { LevelDefinition, WaveDefinition, WaveGroup } from '../waves/Formations';

/** Default number of waves in a generated level. */
export const DEFAULT_RANDOM_WAVE_COUNT = 4;
/** Default lowest target-difficulty score in the generated curve (0–100). */
export const DEFAULT_RANDOM_MIN_TARGET = 15;
/** Default highest target-difficulty score in the generated curve (0–100). */
export const DEFAULT_RANDOM_MAX_TARGET = 80;

/** Options accepted by {@link generateRandomLevel}. */
export interface RandomLevelOptions {
  /** Seed that fully determines the generated level. */
  seed: number;
  /** Number of waves to generate (default {@link DEFAULT_RANDOM_WAVE_COUNT}). */
  waveCount?: number;
  /** Lowest target-difficulty score (default 15). */
  minTarget?: number;
  /** Highest target-difficulty score (default 80). */
  maxTarget?: number;
  /** Candidate archetypes; defaults to the shipped {@link defaultCandidatePool}. */
  pool?: CandidateGroup[];
  /** Whether generated waves fire (default `true`, so the bot must dodge). */
  defaultShootEnabled?: boolean;
  /** Level display name; defaults to `Random Level (seed <n>)`. */
  name?: string;
}

/**
 * Builds a seeded target-difficulty curve (one 0–100 score per wave). Pure and
 * deterministic: the same seed yields the same curve.
 */
export function randomDifficultyCurve(
  seed: number,
  waveCount: number = DEFAULT_RANDOM_WAVE_COUNT,
  minTarget: number = DEFAULT_RANDOM_MIN_TARGET,
  maxTarget: number = DEFAULT_RANDOM_MAX_TARGET,
): number[] {
  const count = Math.max(1, Math.floor(waveCount));
  const lo = Math.min(minTarget, maxTarget);
  const hi = Math.max(minTarget, maxTarget);
  const span = hi - lo + 1;
  const rng = createSeededRng(normaliseSeed(seed));
  const curve: number[] = [];
  for (let i = 0; i < count; i += 1) {
    curve.push(lo + Math.floor(rng() * span));
  }
  return curve;
}

/** Copies the spawn-relevant fields of a sequencer group into a `WaveGroup`. */
function toWaveGroup(group: AdjustedGroup): WaveGroup {
  const waveGroup: WaveGroup = {
    enemyKey: group.enemyKey,
    formation: group.formation as EnemyFormationKind,
    count: group.count,
    spacingX: group.spacingX,
    spacingY: group.spacingY,
    startX: group.startX,
    startY: group.startY,
  };
  if (group.startXMin !== undefined) waveGroup.startXMin = group.startXMin;
  if (group.startXMax !== undefined) waveGroup.startXMax = group.startXMax;
  if (group.startYMin !== undefined) waveGroup.startYMin = group.startYMin;
  if (group.startYMax !== undefined) waveGroup.startYMax = group.startYMax;
  return waveGroup;
}

/** Maps a sequencer wave to the game's `WaveDefinition` shape. */
function toWaveDefinition(wave: ShootableWave): WaveDefinition {
  return {
    groups: wave.groups.map(toWaveGroup),
    shootEnabled: wave.shootEnabled,
  };
}

/**
 * Generates one reproducible random level from `seed`. The level is composed
 * by the shipped sequencer, so every group is a valid, playable wave group.
 */
export function generateRandomLevel(options: RandomLevelOptions): LevelDefinition {
  const seed = normaliseSeed(options.seed);
  const curve = randomDifficultyCurve(
    seed,
    options.waveCount ?? DEFAULT_RANDOM_WAVE_COUNT,
    options.minTarget ?? DEFAULT_RANDOM_MIN_TARGET,
    options.maxTarget ?? DEFAULT_RANDOM_MAX_TARGET,
  );
  const result = sequencer(curve, options.pool ?? defaultCandidatePool(), {
    defaultShootEnabled: options.defaultShootEnabled ?? true,
  });
  return {
    level: 1,
    name: options.name ?? `Random Level (seed ${seed})`,
    waves: result.waves.map(toWaveDefinition),
  };
}

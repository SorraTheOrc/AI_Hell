/**
 * Sequenced campaign builder (AH-0MUITS0VD000DVSV).
 *
 * Pure, deterministic bridge between the data-driven difficulty-curve config
 * (`src/data/difficulty-curves.csv`, loaded by `configStore`) and the
 * playable game's `LevelDefinition[]`. For each configured level it calls the
 * read-only runtime auto-sequencer (`src/core/difficultySequencer.ts`) once
 * with that level's per-wave target curve, then converts the produced
 * `ShootableWave`s into `WaveDefinition`s and applies the campaign fire rule
 * (levels 1–3 do not fire; levels 4+ do — GDD §2.4/§2.5).
 *
 * The level count, level names and per-level wave counts are all data-driven
 * (the curve length sets the wave count). Whenever the config is empty or
 * degenerate — or the sequencer throws — the builder returns the static
 * `LEVELS` campaign unchanged, so the shipped game is never left unplayable.
 *
 * No I/O, no RNG and no clock: the same inputs always yield identical output.
 *
 * @module sequencedLevels
 */

import {
  sequencer,
  defaultCandidatePool,
  type CandidateGroup,
  type DifficultyCurveConfig,
} from '../core/difficultySequencer';
import { loadDifficultyCurves } from '../core/configStore';
import type { DifficultyCurveRow } from '../core/configTypes';
import type { AdjustedGroup } from '../core/difficultySequencer';
import {
  LEVELS,
  type LevelDefinition,
  type WaveDefinition,
  type WaveGroup,
} from './Formations';

/** Level number at which enemies begin firing (GDD §2.5). */
export const FIRST_FIRING_LEVEL = 4;

/**
 * Convert a sequencer-adjusted group into a plain `WaveGroup` (dropping the
 * sequencer-only `score` field, which the game does not consume).
 */
function toWaveGroup(group: AdjustedGroup): WaveGroup {
  return {
    enemyKey: group.enemyKey,
    formation: group.formation,
    count: group.count,
    spacingX: group.spacingX,
    spacingY: group.spacingY,
    startX: group.startX,
    startY: group.startY,
  };
}

/**
 * Group curve rows by level, ascending by level number and then by wave
 * number. Never mutates the input rows.
 */
function groupByLevel(
  rows: DifficultyCurveRow[],
): Map<number, DifficultyCurveRow[]> {
  const byLevel = new Map<number, DifficultyCurveRow[]>();
  for (const row of rows) {
    const list = byLevel.get(row.level) ?? [];
    list.push({ ...row });
    byLevel.set(row.level, list);
  }
  for (const list of byLevel.values()) {
    list.sort((a, b) => a.wave - b.wave);
  }
  return byLevel;
}

/**
 * Build the generated campaign from the difficulty-curve config.
 *
 * @param rows — curve rows. Defaults to `loadDifficultyCurves()` (the CSV
 *   config, or its computed default fallback when the CSV is absent).
 * @param candidates — sequencer candidate pool. Defaults to
 *   `defaultCandidatePool()`.
 * @returns the data-driven `LevelDefinition[]`, or the static `LEVELS`
 *   campaign when the input is empty or degenerate.
 */
export function buildSequencedLevels(
  rows?: DifficultyCurveRow[],
  candidates?: CandidateGroup[],
): LevelDefinition[] {
  const curveRows = rows ?? loadDifficultyCurves();
  const pool = candidates ?? defaultCandidatePool();

  // Fallback: nothing to sequence with.
  if (curveRows.length === 0 || pool.length === 0) return LEVELS;

  const byLevel = groupByLevel(curveRows);
  const levelNumbers = [...byLevel.keys()].sort((a, b) => a - b);

  const levels: LevelDefinition[] = [];
  try {
    for (const levelNumber of levelNumbers) {
      const levelRows = byLevel.get(levelNumber) ?? [];
      if (levelRows.length === 0) return LEVELS;

      const curve: DifficultyCurveConfig = levelRows.map(
        (row) => row.targetDifficulty,
      );
      const shootEnabled = levelNumber >= FIRST_FIRING_LEVEL;

      // One call per level: the sequencer applies a single `defaultShootEnabled`
      // for a whole call, so per-level calls are what let the fire rule vary.
      const result = sequencer(curve, pool, { defaultShootEnabled: shootEnabled });

      const waves: WaveDefinition[] = result.waves.map((wave) => ({
        groups: wave.groups.map(toWaveGroup),
        shootEnabled,
      }));

      levels.push({
        level: levelNumber,
        name: levelRows[0].levelName,
        waves,
      });
    }
  } catch {
    // A malformed candidate pool or other degenerate input must never break
    // the run — fall back to the static campaign.
    return LEVELS;
  }

  if (levels.length === 0) return LEVELS;
  return levels;
}

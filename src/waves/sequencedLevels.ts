/**
 * Sequenced campaign builder (AH-0MUITS0VD000DVSV; mixed sources
 * AH-0MUH7Q6HN0006QPD).
 *
 * Pure, deterministic bridge between the data-driven difficulty-curve config
 * (`src/data/difficulty-curves.csv`, loaded by `configStore`) and the
 * playable game's `LevelDefinition[]`. Each configured level declares a
 * `source`:
 *
 * - **`generated`** — the level's waves come from the read-only runtime
 *   auto-sequencer (`src/core/difficultySequencer.ts`), called once with that
 *   level's per-wave target curve, then converted to `WaveDefinition`s and
 *   given the campaign fire rule (levels 1–3 do not fire; levels 4+ do —
 *   GDD §2.4/§2.5).
 * - **`scripted`** — the level is taken byte-for-byte from the static
 *   `LEVELS` campaign and is never passed to the sequencer.
 *
 * The merged campaign starts from the static `LEVELS` skeleton, so every
 * static level 1–`LEVEL_COUNT` is present unless a configured `generated`
 * level overrides it; configured `generated` levels numbered beyond
 * `LEVEL_COUNT` are appended. The result is ordered ascending by `level`
 * because `WaveManager` progresses by array index.
 *
 * Fallback is per-level: a `generated` level with an empty/malformed curve (or
 * a sequencer throw) keeps that level's static definition when one exists,
 * and is skipped otherwise. Whole-campaign fallback to static `LEVELS` only
 * happens when there is nothing to sequence with (empty rows or candidate
 * pool) or when the resulting campaign would be empty. No path may yield an
 * unplayable campaign or crash.
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
import type { DifficultyCurveRow, DifficultySource } from '../core/configTypes';
import type { AdjustedGroup } from '../core/difficultySequencer';
import {
  LEVELS,
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
  type WaveGroup,
} from './Formations';

/** Level number at which enemies begin firing (GDD §2.5). */
export const FIRST_FIRING_LEVEL = 4;

/** Source used when a level declares none (AH-0MUH7Q6HN0006QPD). */
const DEFAULT_LEVEL_SOURCE: DifficultySource = 'generated';

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

/** The source declared by a level's rows (all rows are validated to agree). */
function levelSource(rows: DifficultyCurveRow[]): DifficultySource {
  return rows[0]?.source ?? DEFAULT_LEVEL_SOURCE;
}

/**
 * True when a level's rows disagree on their `source`. Such a level is
 * malformed; `buildSequencedLevels` then falls back to the static campaign.
 */
function hasConflictingSources(
  byLevel: Map<number, DifficultyCurveRow[]>,
): boolean {
  for (const rows of byLevel.values()) {
    const first = levelSource(rows);
    for (const row of rows) {
      if ((row.source ?? DEFAULT_LEVEL_SOURCE) !== first) return true;
    }
  }
  return false;
}

/**
 * Produce a `generated` level with the sequencer, or `null` when the curve is
 * empty/degenerate (so the caller can apply its per-level fallback).
 */
function generateLevel(
  levelNumber: number,
  levelRows: DifficultyCurveRow[],
  candidates: CandidateGroup[],
): LevelDefinition | null {
  // Empty or malformed (non-finite target) curves cannot be sequenced; the
  // caller keeps the level's static definition when one exists.
  if (levelRows.length === 0) return null;

  const curve: DifficultyCurveConfig = levelRows.map(
    (row) => row.targetDifficulty,
  );
  if (curve.some((target) => !Number.isFinite(target))) return null;

  const shootEnabled = levelNumber >= FIRST_FIRING_LEVEL;

  try {
    // One call per level: the sequencer applies a single `defaultShootEnabled`
    // for a whole call, so per-level calls are what let the fire rule vary.
    const result = sequencer(curve, candidates, {
      defaultShootEnabled: shootEnabled,
    });
    if (result.waves.length === 0) return null;

    const waves: WaveDefinition[] = result.waves.map((wave) => ({
      groups: wave.groups.map(toWaveGroup),
      shootEnabled,
    }));

    return { level: levelNumber, name: levelRows[0].levelName, waves };
  } catch {
    // A malformed candidate pool or other degenerate input must never break
    // the run — the caller applies the per-level fallback.
    return null;
  }
}

/**
 * Build the campaign from the difficulty-curve config, mixing `generated` and
 * `scripted` levels per the config's per-level `source`.
 *
 * @param rows — curve rows. Defaults to `loadDifficultyCurves()` (the CSV
 *   config, or its computed default fallback when the CSV is absent).
 * @param candidates — sequencer candidate pool. Defaults to
 *   `defaultCandidatePool()`.
 * @returns the merged `LevelDefinition[]`, or the static `LEVELS` campaign
 *   when there is nothing to sequence with or the result would be empty.
 */
export function buildSequencedLevels(
  rows?: DifficultyCurveRow[],
  candidates?: CandidateGroup[],
): LevelDefinition[] {
  const curveRows = rows ?? loadDifficultyCurves();
  const pool = candidates ?? defaultCandidatePool();

  // Whole-campaign fallback: nothing to sequence with.
  if (curveRows.length === 0 || pool.length === 0) return LEVELS;

  const byLevel = groupByLevel(curveRows);
  // A level must declare one consistent source; conflicting rows are
  // malformed, so the whole campaign falls back to static `LEVELS`.
  if (hasConflictingSources(byLevel)) return LEVELS;

  // Campaign skeleton: every static level is present and used verbatim when
  // the level is `scripted` or unlisted.
  const merged = new Map<number, LevelDefinition>();
  for (const staticLevel of LEVELS) merged.set(staticLevel.level, staticLevel);

  try {
    const levelNumbers = [...byLevel.keys()].sort((a, b) => a - b);

    for (const levelNumber of levelNumbers) {
      const levelRows = byLevel.get(levelNumber) ?? [];

      if (levelSource(levelRows) === 'scripted') {
        // Scripted levels are taken byte-for-byte from static `LEVELS` and
        // never passed to the sequencer. A scripted level beyond
        // `LEVEL_COUNT` has no static source and is skipped (documented
        // default for the non-blocking open question).
        const staticLevel = getLevelDefinition(levelNumber);
        if (staticLevel) merged.set(levelNumber, staticLevel);
        continue;
      }

      const generated = generateLevel(levelNumber, levelRows, pool);
      if (generated) {
        merged.set(levelNumber, generated);
        continue;
      }

      // Per-level fallback: keep the level's static definition when one
      // exists, otherwise skip the unusable level.
      const staticLevel = getLevelDefinition(levelNumber);
      if (staticLevel) merged.set(levelNumber, staticLevel);
      else merged.delete(levelNumber);
    }
  } catch {
    // Defensive: any unexpected error must never leave an unplayable campaign.
    return LEVELS;
  }

  const campaign = [...merged.values()].sort((a, b) => a.level - b.level);
  return campaign.length > 0 ? campaign : LEVELS;
}

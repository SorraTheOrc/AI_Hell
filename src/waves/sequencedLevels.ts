/**
 * Sequenced campaign builder (AH-0MUITS0VD000DVSV; per-wave generation modes
 * AH-0MUJSUQD8003FSUT).
 *
 * Pure, deterministic bridge between the data-driven difficulty-curve config
 * (`src/data/difficulty-curves.csv`, loaded by `configStore`) and the
 * playable game's `LevelDefinition[]`. Each configured wave declares a
 * `generation` mode:
 *
 * - **`curve`** (default) — the wave comes from the read-only runtime
 *   auto-sequencer (`src/core/difficultySequencer.ts`) built from its
 *   `targetDifficulty`. The composition is fixed for the whole run.
 * - **`fixed`** — the wave uses the hand-authored static `LEVELS` composition
 *   at the same (level, wave) number, verbatim, and is **never** passed to the
 *   sequencer. A `fixed` wave with no static counterpart (a level numbered
 *   beyond `LEVEL_COUNT`, or an out-of-range wave index) falls back safely to
 *   `curve` generation for that wave.
 * - **`dynamic`** — the wave is rebuilt from its curve at run start, seeded
 *   from the run's seed, so successive runs differ while remaining
 *   reproducible for a given seed. The seed perturbs the wave's target before
 *   sequencing (it never touches the curve config itself).
 *
 * The merged campaign starts from the static `LEVELS` skeleton, so every
 * static level 1–`LEVEL_COUNT` is present unless a configured level overrides
 * it; configured levels numbered beyond `LEVEL_COUNT` are appended. The result
 * is ordered ascending by `level` because `WaveManager` progresses by array
 * index.
 *
 * Determinism contract: `curve` and `fixed` waves are independent of the
 * seed; `dynamic` waves are a pure function of (curve, candidate pool, seed).
 *
 * Fallback is per level: a level with an empty/malformed curve (or a
 * sequencer throw) keeps that level's static definition when one exists, and
 * is skipped otherwise. Whole-campaign fallback to static `LEVELS` only
 * happens when there is nothing to sequence with (empty rows or candidate
 * pool) or when the resulting campaign would be empty. No path may yield an
 * unplayable campaign or crash.
 *
 * @module sequencedLevels
 */

import {
  sequencer,
  defaultCandidatePool,
  type CandidateGroup,
  type DifficultyCurveConfig,
  type SequencerOptions,
  type SequencerResult,
} from '../core/difficultySequencer';
import { loadDifficultyCurves } from '../core/configStore';
import type {
  DifficultyCurveRow,
  DifficultyGeneration,
} from '../core/configTypes';
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

/** Mode used when a wave declares none. */
const DEFAULT_WAVE_GENERATION: DifficultyGeneration = 'curve';

/**
 * Maximum magnitude (± points on the 0–100 difficulty scale) by which a
 * `dynamic` wave's target is shifted by the run seed. Large enough that
 * distinct seeds reliably select different compositions, small enough that the
 * wave still tracks its configured curve.
 */
export const DYNAMIC_TARGET_JITTER = 20;

/**
 * Maximum target jitter for `dynamic` waves in the no-fire onboarding levels
 * (1–3). Much tighter than {@link DYNAMIC_TARGET_JITTER}: at the low opening
 * targets the ±20 global jitter would overwhelm the target band and
 * reintroduce the degenerate 1-count / asteroid-only waves the retuned
 * campaign removed (AH-0MUOCJM0N000RW2B). The level-5 dynamic wave keeps the
 * global ±20 so its pinned composition is unchanged.
 */
export const EARLY_DYNAMIC_TARGET_JITTER = 2;

/** Signature of the injected sequencer, matching `difficultySequencer`. */
export type SequencerFn = (
  curve: DifficultyCurveConfig,
  candidates: CandidateGroup[],
  options?: SequencerOptions,
) => SequencerResult;

/**
 * Optional builder controls. All fields are optional so existing
 * `buildSequencedLevels(rows, candidates)` calls are unchanged.
 */
export interface SequencedLevelsOptions {
  /**
   * Injectable sequencer. Defaults to the real `sequencer()`; tests use a spy
   * to prove `fixed` waves are never sequenced.
   */
  sequencer?: SequencerFn;
  /**
   * Run seed for `dynamic` waves. Defaults to `0`, which makes dynamic waves
   * deterministic (but still distinct from `curve` where the seed shifts the
   * target). The same seed always yields the same campaign.
   */
  seed?: number;
}

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
 * The generation mode for a wave: its explicit `generation`, else the legacy
 * per-level `source` mapping (`scripted` → `fixed`, `generated` → `curve`),
 * else the `curve` default. Unknown runtime values also fall back to `curve`.
 */
function generationOf(row: DifficultyCurveRow): DifficultyGeneration {
  if (row.generation) return row.generation;
  if (row.source === 'scripted') return 'fixed';
  if (row.source === 'generated') return 'curve';
  return DEFAULT_WAVE_GENERATION;
}

/**
 * Deterministic 32-bit hash of (seed, level, wave) → `[0, 1)`. Pure: the same
 * inputs always yield the same fraction, so a given run seed reproduces its
 * campaign while different seeds diverge.
 */
function seededUnit(seed: number, level: number, wave: number): number {
  let h =
    (seed >>> 0) ^
    Math.imul(level, 0x9e3779b1) ^
    Math.imul(wave, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/**
 * Shift a `dynamic` wave's target by up to ±`jitter` points, seeded from
 * (seed, level, wave) and clamped to the 0–100 scale. `jitter` defaults to the
 * global {@link DYNAMIC_TARGET_JITTER} (used by the level-5 dynamic wave);
 * the no-fire opening waves pass {@link EARLY_DYNAMIC_TARGET_JITTER}.
 */
export function dynamicTarget(
  target: number,
  seed: number,
  level: number,
  wave: number,
  jitter: number = DYNAMIC_TARGET_JITTER,
): number {
  const shift = (seededUnit(seed, level, wave) * 2 - 1) * jitter;
  return Math.max(0, Math.min(100, target + shift));
}

/**
 * Curated candidate pools and a minimum-count floor for the campaign's
 * `dynamic` opening waves (AH-0MUOCJM0N000RW2B). The opening targets sit in a
 * narrow band where one shared pool cannot deliver variety without producing
 * degenerate waves, so each opening wave is constrained to a few light
 * archetypes. `1:2` and `2:1` deliberately exchange `diver`/`swarm` on a
 * seed-derived bit so repeat runs open on a different order; the two `scout`
 * anchors keep the level ramp safe.
 */
const OPENING_WAVE_CURATION: Readonly<
  Record<
    string,
    { candidateKeys: readonly string[]; seedSwap?: boolean; minCount: number }
  >
> = {
  '1:1': { candidateKeys: ['scout'], minCount: 4 },
  '1:2': { candidateKeys: ['diver', 'swarm'], seedSwap: true, minCount: 4 },
  '2:1': { candidateKeys: ['swarm', 'diver'], seedSwap: true, minCount: 4 },
  '2:2': { candidateKeys: ['scout'], minCount: 4 },
};

/**
 * Resolve a curated opening wave to a candidate pool drawn from `pool`,
 * applying the minimum-count floor and (for swapped waves) the seed-derived
 * archetype choice. Unknown keys are dropped rather than inventing an
 * archetype, so a custom pool that omits a curated key simply narrows the
 * wave's options.
 */
function openingCandidates(
  curation: { candidateKeys: readonly string[]; seedSwap?: boolean; minCount: number },
  pool: CandidateGroup[],
  seed: number,
): CandidateGroup[] {
  const keys = curation.seedSwap
    ? [curation.candidateKeys[seededUnit(seed, 0, 0) >= 0.5 ? 1 : 0]]
    : curation.candidateKeys;
  const byKey = new Map(pool.map((candidate) => [candidate.enemyKey, candidate]));
  return keys
    .map((key) => byKey.get(key))
    .filter((candidate): candidate is CandidateGroup => candidate !== undefined)
    .map((candidate) => ({
      ...candidate,
      minCount: Math.max(candidate.minCount, curation.minCount),
    }));
}

/**
 * Build a single curve/dynamic wave with the sequencer, or `null` when the
 * curve is degenerate (non-finite target) or the sequencer throws.
 */
function buildSequencedWave(
  seq: SequencerFn,
  target: number,
  shootEnabled: boolean,
  candidates: CandidateGroup[],
): WaveDefinition | null {
  if (!Number.isFinite(target)) return null;
  try {
    const result = seq([target], candidates, { defaultShootEnabled: shootEnabled });
    const wave = result.waves[0];
    if (!wave || wave.groups.length === 0) return null;
    return { groups: wave.groups.map(toWaveGroup), shootEnabled };
  } catch {
    // A malformed candidate pool or other degenerate input must never break
    // the run — the caller applies its fallback.
    return null;
  }
}

/**
 * Build one configured level from its rows, dispatching per wave by
 * `generation` mode. Returns `null` when a curve/dynamic wave cannot be
 * produced, so the caller can fall back to the level's static definition.
 *
 * An all-`fixed` level that exactly matches the static level's wave count
 * returns the static `LevelDefinition` object verbatim (preserving the legacy
 * `scripted` byte-for-byte contract).
 */
function buildConfiguredLevel(
  levelNumber: number,
  levelRows: DifficultyCurveRow[],
  candidates: CandidateGroup[],
  seq: SequencerFn,
  seed: number,
): LevelDefinition | null {
  const staticLevel = getLevelDefinition(levelNumber);
  const shootEnabled = levelNumber >= FIRST_FIRING_LEVEL;
  const waves: WaveDefinition[] = [];
  let allFixedResolved = true;

  for (const row of levelRows) {
    const mode = generationOf(row);

    if (mode === 'fixed') {
      const staticWave = staticLevel?.waves[row.wave - 1];
      if (staticWave) {
        waves.push(staticWave);
        continue;
      }
      // No static counterpart: fall back to `curve` for this wave so the run
      // stays playable (a level beyond LEVEL_COUNT or a missing wave).
      allFixedResolved = false;
    }

    const target =
      mode === 'dynamic'
        ? dynamicTarget(
            row.targetDifficulty,
            seed,
            levelNumber,
            row.wave,
            levelNumber < FIRST_FIRING_LEVEL
              ? EARLY_DYNAMIC_TARGET_JITTER
              : DYNAMIC_TARGET_JITTER,
          )
        : row.targetDifficulty;
    const curation =
      mode === 'dynamic'
        ? OPENING_WAVE_CURATION[`${levelNumber}:${row.wave}`]
        : undefined;
    const waveCandidates = curation
      ? openingCandidates(curation, candidates, seed)
      : candidates;
    const wave = buildSequencedWave(seq, target, shootEnabled, waveCandidates);
    if (!wave) return null;
    waves.push(wave);
  }

  if (
    allFixedResolved &&
    staticLevel &&
    staticLevel.waves.length === levelRows.length &&
    levelRows.every((row) => generationOf(row) === 'fixed')
  ) {
    return staticLevel;
  }

  return { level: levelNumber, name: levelRows[0].levelName, waves };
}

/**
 * Build the campaign from the difficulty-curve config, mixing `curve`, `fixed`
 * and `dynamic` waves per the config's per-wave `generation` mode.
 *
 * @param rows — curve rows. Defaults to `loadDifficultyCurves()` (the CSV
 *   config, or its computed default fallback when the CSV is absent).
 * @param candidates — sequencer candidate pool. Defaults to
 *   `defaultCandidatePool()`.
 * @param options — optional builder controls (`sequencer` override and the
 *   `dynamic` run `seed`).
 * @returns the merged `LevelDefinition[]`, or the static `LEVELS` campaign
 *   when there is nothing to sequence with or the result would be empty.
 */
export function buildSequencedLevels(
  rows?: DifficultyCurveRow[],
  candidates?: CandidateGroup[],
  options: SequencedLevelsOptions = {},
): LevelDefinition[] {
  const curveRows = rows ?? loadDifficultyCurves();
  const pool = candidates ?? defaultCandidatePool();
  const seq = options.sequencer ?? sequencer;
  const seed = options.seed ?? 0;

  // Whole-campaign fallback: nothing to sequence with.
  if (curveRows.length === 0 || pool.length === 0) return LEVELS;

  const byLevel = groupByLevel(curveRows);

  // Campaign skeleton: every static level is present and used verbatim when
  // the level is `fixed` or unlisted.
  const merged = new Map<number, LevelDefinition>();
  for (const staticLevel of LEVELS) merged.set(staticLevel.level, staticLevel);

  try {
    const levelNumbers = [...byLevel.keys()].sort((a, b) => a - b);

    for (const levelNumber of levelNumbers) {
      const levelRows = byLevel.get(levelNumber) ?? [];
      const built = buildConfiguredLevel(
        levelNumber,
        levelRows,
        pool,
        seq,
        seed,
      );
      if (built) {
        merged.set(levelNumber, built);
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

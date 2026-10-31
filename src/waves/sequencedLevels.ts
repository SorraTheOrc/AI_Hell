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
 * Sequential distinctness (R4, AH-0MVSE6XIO007BXYM): a level's built waves are
 * tracked in order and each generated wave is handed the immediately preceding
 * wave's composition — including a preceding `fixed` wave's — through
 * `SequencerOptions.avoidCompositions`. `fixed` waves are never passed to the
 * sequencer, so they stay exempt on the generated path; their adjacency is
 * covered by the authored data and the campaign variety audit. A level
 * boundary is not an adjacency, so the tracker resets per level.
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
  EnemyMovementClass,
} from '../core/configTypes';
import {
  OPENING_MOVEMENT_CLASSES,
  OPENING_WAVE_POSITIONS,
  classifyArchetype,
  isOpeningWavePosition,
} from '../core/waveBalance';
import type { AdjustedGroup } from '../core/difficultySequencer';
import {
  LEVELS,
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
  type WaveGroup,
} from './Formations';
import { waveComposition } from './campaignVariety';

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
 * Curated sub-selection data for one opening slot. The R1 *positions* live in
 * the shared rule module (`OPENING_WAVE_POSITIONS`); this table only narrows
 * the R1-derived pool to the curated band for each slot.
 */
interface OpeningCuration {
  /** Curated archetype keys for this slot (sub-selection of the R1 pool). */
  candidateKeys: readonly string[];
  /** Exchange the two candidate keys on a seed-derived bit. */
  seedSwap?: boolean;
  /** Minimum group count floor for the curated wave. */
  minCount: number;
}

/**
 * Curated opening-wave sub-selection (data, not classification logic).
 *
 * The opening-wave *pool* is derived from R1 (movement-class guard, producer
 * Q2=b): every candidate that may enter an opening wave is validated through
 * the shared rule module ({@link OPENING_MOVEMENT_CLASSES} +
 * {@link classifyArchetype}) before the curated band below is applied. The
 * band is kept as data because the opening target band is narrow — a full
 * R1 pool of every formation/diver archetype would make openers degenerate
 * (the retuned campaign removed exactly those waves, AH-0MUOCJM0N000RW2B).
 *
 * Entries align 1:1 with `OPENING_WAVE_POSITIONS` (L1W1, L1W2, L2W1, L2W2),
 * so the opening positions live in exactly one place — the shared rule
 * module. `1:2` and `2:1` deliberately exchange `diver`/`swarm` on a
 * seed-derived bit so repeat runs open on a different order; the two `scout`
 * anchors keep the level ramp safe.
 */
const OPENING_CURATION: readonly OpeningCuration[] = [
  { candidateKeys: ['scout'], minCount: 4 },                      // L1W1
  { candidateKeys: ['diver', 'swarm'], seedSwap: true, minCount: 4 }, // L1W2
  { candidateKeys: ['swarm', 'diver'], seedSwap: true, minCount: 4 }, // L2W1
  { candidateKeys: ['scout'], minCount: 4 },                      // L2W2
];

/**
 * The curated options for an opening position, or `undefined` when the
 * (level, wave) pair is not an R1 opening position.
 */
function openingCurationFor(
  level: number,
  wave: number,
): OpeningCuration | undefined {
  const index = OPENING_WAVE_POSITIONS.findIndex(
    ([openingLevel, openingWave]) =>
      openingLevel === level && openingWave === wave,
  );
  return index >= 0 ? OPENING_CURATION[index] : undefined;
}

/**
 * Resolve a curated opening wave to a candidate pool drawn from `pool`,
 * guarded by R1.
 *
 * The pool is first derived from R1 — only archetypes whose `movementClass`
 * is in {@link OPENING_MOVEMENT_CLASSES} may enter an opening wave (resolved
 * through the shared {@link classifyArchetype}) — and is then narrowed by the
 * curated band. The minimum-count floor is applied and (for swapped waves)
 * the seed-derived archetype choice. Unknown keys are dropped rather than
 * inventing an archetype, so a custom pool that omits a curated key simply
 * narrows the wave's options.
 */
function openingCandidates(
  curation: OpeningCuration,
  pool: CandidateGroup[],
  seed: number,
): CandidateGroup[] {
  // R1 derivation: the curated band may narrow the R1 pool, never widen it.
  const r1Pool = pool.filter((candidate) =>
    OPENING_MOVEMENT_CLASSES.includes(
      classifyArchetype(candidate.enemyKey).movementClass,
    ),
  );
  const keys = curation.seedSwap
    ? [curation.candidateKeys[seededUnit(seed, 0, 0) >= 0.5 ? 1 : 0]]
    : curation.candidateKeys;
  const byKey = new Map(r1Pool.map((candidate) => [candidate.enemyKey, candidate]));
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
 *
 * `archetypeUsage` is the level's shared per-level archetype-usage map
 * (AH-0MV2SGIX5005PFJT): the sequencer reads and updates it in place so the
 * {@link MAX_ARCHETYPE_PER_LEVEL} cap spans the whole level rather than a
 * single wave.
 *
 * `previousComposition` is the preceding wave's composition signature in the
 * same level (R4 sequential distinctness, AH-0MVSE6XIO007BXYM). It is passed
 * to the sequencer as the avoided composition, so a generated wave can never
 * repeat its predecessor's archetype set. `fixed` waves never reach here, so
 * they stay exempt on the generated path (their adjacency is covered by the
 * authored data and the campaign variety audit).
 */
function buildSequencedWave(
  seq: SequencerFn,
  target: number,
  shootEnabled: boolean,
  candidates: CandidateGroup[],
  archetypeUsage: Map<string, number>,
  allowedMovementClasses?: readonly EnemyMovementClass[],
  previousComposition?: string,
): WaveDefinition | null {
  if (!Number.isFinite(target)) return null;
  try {
    const result = seq([target], candidates, {
      defaultShootEnabled: shootEnabled,
      archetypeUsage,
      ...(previousComposition !== undefined
        ? { avoidCompositions: [previousComposition] }
        : {}),
      ...(allowedMovementClasses
        ? { ruleConstraints: { allowedMovementClasses } }
        : {}),
    });
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
  // Per-level archetype usage, shared across the level's sequenced waves so
  // no archetype fills every wave (AH-0MV2SGIX5005PFJT). `fixed` waves bypass
  // the sequencer and therefore do not consume the cap.
  const archetypeUsage = new Map<string, number>();
  // Previous wave's composition signature in this level (R4 sequential
  // distinctness, AH-0MVSE6XIO007BXYM). Reset per level: a level's final wave
  // is never compared with the next level's first wave, and a `fixed` wave
  // becomes the predecessor of the generated wave that follows it.
  let previousComposition: string | undefined;

  for (const row of levelRows) {
    const mode = generationOf(row);

    if (mode === 'fixed') {
      const staticWave = staticLevel?.waves[row.wave - 1];
      if (staticWave) {
        waves.push(staticWave);
        previousComposition = waveComposition(staticWave);
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
    // R1 opening guard (F4, AH-0MV84TQTG004ZKPV): the opening positions come
    // from the shared rule module (`isOpeningWavePosition`), the curated band
    // is looked up from that same position constant, and the sequencer is
    // handed the R1 movement classes so only formation/diver archetypes may
    // enter an opening wave. Fixed waves never reach here (they continue
    // above), so they stay exempt exactly as authored.
    const isOpening = isOpeningWavePosition(levelNumber, row.wave);
    // The curated band applies only to `dynamic` openings (as before); the R1
    // movement-class guard applies to any generated opening wave (curve or
    // dynamic) so the builder agrees with the F5 campaign validator.
    const curation =
      isOpening && mode === 'dynamic'
        ? openingCurationFor(levelNumber, row.wave)
        : undefined;
    const waveCandidates = curation
      ? openingCandidates(curation, candidates, seed)
      : candidates;
    const wave = buildSequencedWave(
      seq,
      target,
      shootEnabled,
      waveCandidates,
      archetypeUsage,
      // Only generated waves reach here: `fixed` waves with a static
      // counterpart `continue` above, and the no-counterpart fallback is
      // generated as `curve`. So any wave at an opening position is guarded.
      isOpening ? OPENING_MOVEMENT_CLASSES : undefined,
      previousComposition,
    );
    if (!wave) return null;
    waves.push(wave);
    // The built wave is the next wave's predecessor (R4).
    previousComposition = waveComposition(wave);
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

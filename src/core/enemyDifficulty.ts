/**
 * Enemy difficulty scoring module (AH-0MTZWZ7MC002B01K).
 *
 * Pure TypeScript — no Phaser runtime dependency, no browser globals. Computes
 * a normalised 0–100 difficulty index for a single `EnemyConfig` archetype,
 * for a `WaveDefinition`, and for a level (an ordered list of waves), with a
 * per-factor breakdown so every score is explainable and auditable.
 *
 * Design-time only: the metric informs manual authoring in the Enemy Gym and
 * serves as a regression check for campaign calibration (GDD §3.2). It is
 * **absolute** — derived only from enemy properties, never from player HP,
 * lives, weapons or power-ups (Producer decision, AH-0MTZWZ7MC002B01K).
 *
 * The index is relative and monotonic, not an absolute truth: the weights
 * encode opinions, so they are named, documented constants in one place and
 * the tests pin *ordering* and *monotonicity*, not magic numbers.
 *
 * @module enemyDifficulty
 */

import { DEFAULT_ENEMY_CONFIGS } from './enemyConfig';
import type { EnemyConfig, EnemyShotPattern } from './enemyConfig';
import type { WaveDefinition } from '../waves/Formations';

// ── Factor weight constants ──────────────────────────────────────────

/**
 * Named weights for each difficulty axis. Weights are relative; the score is
 * the weighted mean of the normalised factors, so the total is 0–100
 * regardless of how the individual weights change.
 *
 * A factor with weight 0 is effectively disabled. All weights are positive.
 */
export const FACTOR_WEIGHTS = {
  /** Number of enemies in the archetype's formation (`count`). */
  count: 25,
  /** Movement speed of the formation (`driftSpeed`, px/s). */
  driftSpeed: 8,
  /** Attack-pattern complexity (`shotPattern`). */
  shotPattern: 15,
  /** Attack cadence (`fireInterval`, inverted — a shorter interval is harder). */
  fireInterval: 12,
  /** Chance that an individual enemy fires per cycle (`shotProbability`). */
  shotProbability: 5,
  /** Bullet velocity (`bulletSpeed`, px/s). */
  bulletSpeed: 5,
  /** Bullets emitted per volley / radial spokes (`burstCount`). */
  burstCount: 12,
  /** Formation-geometry complexity (`formationKind`). */
  formationKind: 8,
  /** Asteroid split chain (one large = 7 destroyed entities). */
  asteroidSplit: 10,
} as const;

/** Sum of all weights — used to normalise the weighted score. */
const WEIGHT_SUM = Object.values(FACTOR_WEIGHTS).reduce((s, w) => s + w, 0);

// ── Normalisation range constants ────────────────────────────────────

/**
 * Normalisation ranges for each factor. Each raw value is clamped to its
 * range and linearly mapped to 0–100:
 *
 *   normalised(value) = clamp01((value - min) / (max - min)) × 100
 *
 * Ranges cover the full span of values across all seed archetypes plus the
 * slider ranges defined in the gym editor (`GymEnemies.ENEMY_SLIDER_RANGES`).
 */
export const FACTOR_RANGES: Record<string, { min: number; max: number }> = {
  count: { min: 1, max: 200 },
  driftSpeed: { min: 0, max: 200 },
  shotPattern: { min: 0, max: 5 },
  fireInterval: { min: 100, max: 5000 },
  shotProbability: { min: 0, max: 1 },
  bulletSpeed: { min: 40, max: 600 },
  burstCount: { min: 1, max: 24 },
  formationKind: { min: 0, max: 5 },
  asteroidSplit: { min: 1, max: 7 },
};

// ── Ordinal mappings for enum factors ────────────────────────────────

/**
 * Attack-pattern ordinals, ordered by how hard the pattern is to dodge:
 * `none` (no attack) → `aimed` (single aimed shot) → `coordinated`
 * (synchronised aimed burst) → `spread` (multiple angles) → `radial`
 * (360° hazard) → `orbital` (moving, rotating pattern).
 */
const SHOT_PATTERN_ORDINAL: Record<EnemyShotPattern, number> = {
  none: 0,
  aimed: 1,
  coordinated: 2,
  spread: 3,
  radial: 4,
  orbital: 5,
};

/**
 * Formation-geometry ordinals, ordered by positional threat:
 * `single` → `v` → `diver` → `rect` → `swarm` → `orbital`.
 */
const FORMATION_KIND_ORDINAL: Record<string, number> = {
  single: 0,
  v: 1,
  diver: 2,
  rect: 3,
  swarm: 4,
  orbital: 5,
};

// ── Utility helpers ──────────────────────────────────────────────────

/** Clamp a value to [0, 1]. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Round to two decimal places for stable, comparable output. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Normalise a raw numeric value to 0–100 based on its range definition.
 * Returns 0 when the range is degenerate (min === max).
 */
function normaliseValue(raw: number, range: { min: number; max: number }): number {
  if (range.max === range.min) return 0;
  const safe = Number.isFinite(raw) ? raw : range.min;
  return clamp01((safe - range.min) / (range.max - range.min)) * 100;
}

/**
 * True when the archetype is the Asteroid splitter (GDD §4.1 — E6).
 * Asteroids never fire and split into a chain of 7 destroyed entities.
 */
function isAsteroid(config: EnemyConfig): boolean {
  return config.key === 'asteroid';
}

/**
 * Asteroid split-chain entity count: one large → two medium → four small,
 * i.e. 1 + 2 + 4 = 7 destroyed enemies (GDD §4.1 — E6). Non-asteroids are 1.
 */
function asteroidChainSize(config: EnemyConfig): number {
  return isAsteroid(config) ? 7 : 1;
}

// ── Public types ─────────────────────────────────────────────────────

/** Per-factor breakdown of a difficulty score. */
export interface DifficultyBreakdown {
  /** Normalised 0–100 difficulty index. */
  score: number;
  /** Weighted per-factor contributions (sum of values ÷ WEIGHT_SUM = score/100). */
  breakdown: Record<string, number>;
  /**
   * Raw normalised per-factor values (0–100) for explainability.
   * Keys match `FACTOR_WEIGHTS`.
   */
  factors: Record<string, number>;
}

// ── Enemy scoring ────────────────────────────────────────────────────

/**
 * Compute the difficulty index for a single `EnemyConfig` archetype.
 *
 * The score is absolute (no player state), deterministic, and ranges 0–100.
 * The breakdown exposes each factor's contribution so the score is
 * explainable.
 *
 * **Firing factors** (`fireInterval`, `shotProbability`, `bulletSpeed`,
 * `burstCount`) contribute zero whenever `shotPattern === 'none'`, or when the
 * caller passes `suppressFiring: true` (used by `waveDifficulty` for waves
 * with `shootEnabled: false`, GDD §2.4 — Levels 1–3).
 *
 * @param config — the enemy archetype configuration.
 * @param options — optional flags overriding the default suppression rule.
 * @returns the difficulty index with per-factor breakdown.
 */
export function enemyDifficulty(
  config: EnemyConfig,
  options?: { suppressFiring?: boolean },
): DifficultyBreakdown {
  // Auto-suppress firing for non-firing archetypes (e.g. Asteroid); callers
  // may force suppression for non-firing waves.
  const suppressFiring = options?.suppressFiring ?? config.shotPattern === 'none';

  const factors: Record<string, number> = {};

  // Non-firing axes.
  factors.count = normaliseValue(config.count, FACTOR_RANGES.count);
  factors.driftSpeed = normaliseValue(config.driftSpeed, FACTOR_RANGES.driftSpeed);
  factors.shotPattern = normaliseValue(
    SHOT_PATTERN_ORDINAL[config.shotPattern] ?? 0,
    FACTOR_RANGES.shotPattern,
  );
  factors.formationKind = normaliseValue(
    FORMATION_KIND_ORDINAL[config.formationKind] ?? 0,
    FACTOR_RANGES.formationKind,
  );
  factors.asteroidSplit = normaliseValue(
    asteroidChainSize(config),
    FACTOR_RANGES.asteroidSplit,
  );

  // Firing axes — suppressed to zero when the archetype/wave does not fire.
  if (suppressFiring) {
    factors.fireInterval = 0;
    factors.shotProbability = 0;
    factors.bulletSpeed = 0;
    factors.burstCount = 0;
  } else {
    // Invert the interval so a *shorter* interval (faster fire) maps to a
    // *higher* score: normalise the fire rate (volleys per ms) instead.
    const fireRate = 1 / Math.max(1, config.fireInterval);
    factors.fireInterval = normaliseValue(fireRate, {
      min: 1 / FACTOR_RANGES.fireInterval.max,
      max: 1 / FACTOR_RANGES.fireInterval.min,
    });
    factors.shotProbability = normaliseValue(
      config.shotProbability,
      FACTOR_RANGES.shotProbability,
    );
    factors.bulletSpeed = normaliseValue(config.bulletSpeed, FACTOR_RANGES.bulletSpeed);
    factors.burstCount = normaliseValue(config.burstCount, FACTOR_RANGES.burstCount);
  }

  // Weighted mean of the normalised factors → 0–100.
  let weightedSum = 0;
  const breakdown: Record<string, number> = {};
  for (const factor of Object.keys(FACTOR_WEIGHTS)) {
    const weight = FACTOR_WEIGHTS[factor as keyof typeof FACTOR_WEIGHTS];
    const weighted = ((factors[factor] ?? 0) / 100) * weight;
    breakdown[factor] = round2(weighted);
    weightedSum += weighted;
  }

  const score = clamp01(weightedSum / WEIGHT_SUM) * 100;
  return { score: round2(score), breakdown, factors };
}

// ── Wave scoring ─────────────────────────────────────────────────────

/**
 * Maximum wave score (the saturating asymptote).
 * A wave approaches but never reaches this value.
 */
export const WAVE_SCORE_MAX = 100;

/**
 * Total raw threat at which a wave scores half of `WAVE_SCORE_MAX`.
 * Tuned so the built-in campaign spreads across a useful 0–100 range.
 * The saturating curve gives diminishing returns, so a wave of many weak
 * enemies does not swamp a wave of few strong ones, while remaining strictly
 * monotonic in total threat.
 */
export const WAVE_SCALE = 900;

/** Resolve the effective `EnemyConfig` for one wave group. */
function groupEnemyConfig(
  group: WaveDefinition['groups'][number],
): EnemyConfig {
  const seed = DEFAULT_ENEMY_CONFIGS[group.enemyKey];
  const base: EnemyConfig = seed ?? {
    key: group.enemyKey,
    displayName: group.enemyKey,
    formationKind: group.formation,
    count: group.count,
    spacingX: group.spacingX,
    spacingY: group.spacingY,
    driftSpeed: 40,
    startX: group.startX,
    startY: group.startY,
    size: 16,
    color: 0x00ff00,
    bulletColor: 0xff4444,
    bulletSize: 3,
    shotPattern: 'aimed',
    fireInterval: 1200,
    bulletSpeed: 200,
    burstCount: 1,
    shotProbability: 1.0,
  };
  // Group placement overrides the archetype defaults.
  return {
    ...base,
    key: group.enemyKey,
    count: group.count,
    formationKind: group.formation,
    spacingX: group.spacingX,
    spacingY: group.spacingY,
    startX: group.startX,
    startY: group.startY,
  };
}

/**
 * Compute the difficulty index for a wave (one or more enemy groups).
 *
 * The wave score is the total threat of the wave — how hard it is to survive —
 * expressed as a saturating 0–100 index:
 *
 *   totalThreat = Σ (enemyScore × effectiveCount)
 *   score       = WAVE_SCORE_MAX × totalThreat / (totalThreat + WAVE_SCALE)
 *
 * `effectiveCount` accounts for the Asteroid split chain (one large = 7
 * destroyed entities). The curve is strictly increasing in total threat, so
 * the score increases with group count, enemy count and mix. When
 * `shootEnabled` is `false`, firing factors are suppressed so the wave is not
 * scored as if its enemies fire (GDD §2.4 — Levels 1–3; GDD §2.5 — 4–5).
 *
 * @param wave — the wave definition to score.
 * @returns the difficulty index with a per-wave breakdown.
 */
export function waveDifficulty(wave: WaveDefinition): DifficultyBreakdown {
  let totalThreat = 0;
  let totalEnemies = 0;
  const groupBreakdown: Record<string, number> = {};

  for (let gi = 0; gi < wave.groups.length; gi++) {
    const group = wave.groups[gi];
    const config = groupEnemyConfig(group);
    const result = enemyDifficulty(config, { suppressFiring: !wave.shootEnabled });
    // The Asteroid split chain is already represented by the `asteroidSplit`
    // factor in the enemy score, so the group count is used verbatim here
    // (no double counting).
    totalThreat += result.score * group.count;
    totalEnemies += group.count;
    groupBreakdown[`group${gi + 1}:${group.enemyKey}`] = round2(result.score);
  }

  const score = WAVE_SCORE_MAX * (totalThreat / (totalThreat + WAVE_SCALE));

  return {
    score: round2(score),
    breakdown: groupBreakdown,
    factors: {
      groupCount: wave.groups.length,
      totalEnemies,
      totalThreat: round2(totalThreat),
    },
  };
}

// ── Level scoring ────────────────────────────────────────────────────

/**
 * Compute the difficulty index for a level (an ordered sequence of waves).
 *
 * A level's difficulty is the **enemy-count-weighted mean** of the per-enemy
 * difficulty across every group in every wave — i.e. the average threat of
 * the level's content. Weighting by count (and by the Asteroid split chain)
 * means one dangerous enemy and many dangerous enemies describe the same
 * per-encounter challenge, which is what makes the intended campaign
 * progression (GDD §3.2 — Entry ≤ Descent ≤ The Core ≤ Firestorm ≤
 * Predictable Death) meaningful: "Predictable Death" is uniformly
 * high-threat even though it has *fewer* enemies than earlier levels.
 *
 * Total wave threat (how many enemies, how long the level is) is available
 * separately via `waveDifficulty`; the breakdown here exposes the per-wave
 * contributions.
 *
 * @param waves — the wave definitions in play order.
 * @returns the difficulty index with a per-wave breakdown.
 */
export function levelDifficulty(waves: WaveDefinition[]): DifficultyBreakdown {
  if (waves.length === 0) {
    return { score: 0, breakdown: {}, factors: { waveCount: 0, totalEnemies: 0 } };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let totalEnemies = 0;
  const breakdown: Record<string, number> = {};

  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    let waveWeighted = 0;
    let waveWeight = 0;

    for (const group of wave.groups) {
      const config = groupEnemyConfig(group);
      const result = enemyDifficulty(config, { suppressFiring: !wave.shootEnabled });
      // See `waveDifficulty`: the split chain lives in the `asteroidSplit`
      // factor, so the weighting uses the group count directly.
      const weight = group.count;
      waveWeighted += result.score * weight;
      waveWeight += weight;
      totalEnemies += group.count;
    }

    weightedScore += waveWeighted;
    totalWeight += waveWeight;
    const waveScore = waveWeight > 0 ? waveWeighted / waveWeight : 0;
    breakdown[`wave${wi + 1}`] = round2(waveScore);
  }

  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

  return {
    score: round2(score),
    breakdown,
    factors: {
      waveCount: waves.length,
      totalEnemies,
    },
  };
}

// ── Exported constants for documentation / calibration ───────────────

/** Ordered factor names matching `FACTOR_WEIGHTS` (for docs/reports). */
export const FACTOR_NAMES = Object.keys(FACTOR_WEIGHTS);

/** Ordered normalisation range keys matching `FACTOR_RANGES` (for docs). */
export const FACTOR_RANGE_KEYS = Object.keys(FACTOR_RANGES);

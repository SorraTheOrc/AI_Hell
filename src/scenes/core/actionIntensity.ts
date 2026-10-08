/**
 * Pure on-screen action-intensity core (AH-0MUZQ33GR006AKXD; decision doc
 * `docs/dev/action-intensity.md` §6–§7.1).
 *
 * `computeActionIntensity` is the single, deterministic scoring function the
 * shipped game and the gyms consume (repo gym↔game parity convention, see
 * `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §5.1). It combines two layers
 * over one scalar:
 *
 * - **Layer 1 — weighted on-screen presence** ({@link computePresenceScore}):
 *   the weighted count of live objects, `P(t) = Σ_c w_c · min(n_c, cap_c)`.
 * - **Layer 2 — event-window burst** (the event contribution, `k_E · E(t)`):
 *   the discrete-event score over the sliding window, supplied by the caller
 *   either as pre-summed {@link ActionIntensityState.eventScore} or as the
 *   {@link ActionIntensityState.events} observed since the previous sample.
 *
 * The combined raw score `R(t) = P(t) + k_E · E(t)` is then normalised with a
 * saturating hyperbola `intensity = R/(R+B)`, smoothed with an exponential
 * moving average, and exposed as a `burstiness` derivative
 * (`intensity − smoothed`) for moment detection.
 *
 * ## Purity and cost
 *
 * The function is a **pure function** of `(state, config)`: it reads only its
 * arguments, allocates only the returned sample, mutates nothing, and
 * introduces **no RNG**. It is `O(categories)` (i.e. `O(1)`, since the counts
 * are already aggregated from `O(entities)` registries) plus `O(1)` per event
 * in the supplied list. The previous EMA value is threaded back in by the
 * caller as {@link ActionIntensityState.previousSmoothed}, so the function
 * itself stays stateless.
 *
 * @module scenes/core/actionIntensity
 */

/** The nine object categories, in the schema/breakdown order (§6.1, §7.1). */
export const ACTION_INTENSITY_CATEGORIES = [
  'playerBullets',
  'enemyBullets',
  'enemies',
  'asteroids',
  'drops',
  'enemyExplosions',
  'bossExplosions',
  'playerExplosions',
  'bosses',
] as const;

/** A discriminator from {@link ACTION_INTENSITY_CATEGORIES}. */
export type ActionIntensityCategory =
  (typeof ACTION_INTENSITY_CATEGORIES)[number];

/** The discrete events the burst layer consumes, in schema order (§6.2). */
export const ACTION_INTENSITY_EVENT_TYPES = [
  'enemy_killed',
  'player_hit',
  'life_lost',
  'boss_phase',
  'powerup_collected',
  'wave_clear',
  'level_clear',
  'run_started',
  'run_ended',
] as const;

/** A discriminator from {@link ACTION_INTENSITY_EVENT_TYPES}. */
export type ActionIntensityEventType =
  (typeof ACTION_INTENSITY_EVENT_TYPES)[number];

/**
 * Live per-category object counts `n_c(t)` at one tick. Counts are raw
 * (unweighted) and are echoed unchanged as the sample's `breakdown`.
 */
export interface ActionIntensityCounts {
  readonly playerBullets: number;
  readonly enemyBullets: number;
  readonly enemies: number;
  readonly asteroids: number;
  readonly drops: number;
  readonly enemyExplosions: number;
  readonly bossExplosions: number;
  readonly playerExplosions: number;
  readonly bosses: number;
}

/**
 * One discrete event observed since the previous sample. `at` is seconds
 * since run start; the event-window accumulator uses it to select the events
 * inside `eventWindowSeconds` (§6.2).
 */
export interface ActionIntensityEvent {
  readonly type: ActionIntensityEventType;
  readonly at: number;
}

/**
 * The recorded sample shape (§7.1). `breakdown` carries the raw live counts so
 * a consumer can attribute the score to individual categories.
 */
export interface ActionIntensitySample {
  /** Unbounded combined raw score `R(t) = P(t) + k_E · E(t)`. */
  readonly rawScore: number;
  /** Normalised score in `[0, 1)` (`R/(R+B)`). */
  readonly intensity: number;
  /** Exponential moving average `S(t)` of `intensity`. */
  readonly smoothed: number;
  /** `intensity(t) − smoothed(t)`; positive ⇒ a spike above trend. */
  readonly burstiness: number;
  /** Raw live per-category counts `n_c(t)` (unweighted). */
  readonly breakdown: ActionIntensityCounts;
}

/**
 * Every tunable knob (§6.6). All values are **documented defaults** here at
 * the definition site and are expected to be revisited by the calibration
 * follow-up (§9); none is expected to be final.
 */
export interface ActionIntensityConfig {
  /** Per-category weights `w_c` (dimensionless relative units). */
  readonly weights: Readonly<Record<ActionIntensityCategory, number>>;
  /** Per-category caps `cap_c` applied before weighting (default `Infinity`). */
  readonly caps: Readonly<Record<ActionIntensityCategory, number>>;
  /** Event-window width `W` in seconds. */
  readonly eventWindowSeconds: number;
  /** Per-event values `v_e` (same units as the weights). */
  readonly eventValues: Readonly<Record<ActionIntensityEventType, number>>;
  /** Reference budget `B`: raw score of a "busy but readable" screen. */
  readonly referenceBudget: number;
  /** Presence↔burst blend `k_E`. */
  readonly eventBlend: number;
  /** EMA half-life `h` in seconds. */
  readonly halfLifeSeconds: number;
  /** Recording/sampling rate in Hz; sets `Δt = 1 / sampleRateHz`. */
  readonly sampleRateHz: number;
}

/**
 * The documented default configuration (§6.1–§6.4):
 *
 * - weights: player bullets **0.5** (auto-fire baseline), enemy bullets 1.0,
 *   enemies 2.0, asteroids 1.0, drops 1.0, enemy explosions 2.0, boss
 *   explosions 5.0, player explosions 20.0, bosses 5.0;
 * - caps: `Infinity` for every category;
 * - event window `W` = 2.0 s, event values `enemy_killed` 2, `player_hit` /
 *   `life_lost` 20, `boss_phase` 5, `powerup_collected` 1, `wave_clear` /
 *   `level_clear` 3, `run_started` / `run_ended` 0;
 * - reference budget `B` = 30, blend `k_E` = 1.0, half-life `h` = 0.5 s,
 *   sample rate 10 Hz.
 */
export const DEFAULT_ACTION_INTENSITY_CONFIG: ActionIntensityConfig =
  Object.freeze({
    weights: Object.freeze({
      playerBullets: 0.5,
      enemyBullets: 1.0,
      enemies: 2.0,
      asteroids: 1.0,
      drops: 1.0,
      enemyExplosions: 2.0,
      bossExplosions: 5.0,
      playerExplosions: 20.0,
      bosses: 5.0,
    }),
    caps: Object.freeze({
      playerBullets: Number.POSITIVE_INFINITY,
      enemyBullets: Number.POSITIVE_INFINITY,
      enemies: Number.POSITIVE_INFINITY,
      asteroids: Number.POSITIVE_INFINITY,
      drops: Number.POSITIVE_INFINITY,
      enemyExplosions: Number.POSITIVE_INFINITY,
      bossExplosions: Number.POSITIVE_INFINITY,
      playerExplosions: Number.POSITIVE_INFINITY,
      bosses: Number.POSITIVE_INFINITY,
    }),
    eventWindowSeconds: 2.0,
    eventValues: Object.freeze({
      enemy_killed: 2,
      player_hit: 20,
      life_lost: 20,
      boss_phase: 5,
      powerup_collected: 1,
      wave_clear: 3,
      level_clear: 3,
      run_started: 0,
      run_ended: 0,
    }),
    referenceBudget: 30,
    eventBlend: 1.0,
    halfLifeSeconds: 0.5,
    sampleRateHz: 10,
  });

/**
 * The minimal, structural input to {@link computeActionIntensity}: the live
 * per-category counts plus the discrete events (or a pre-summed event score)
 * and the previous EMA value.
 */
export interface ActionIntensityState {
  /** Live per-category counts `n_c(t)`. */
  readonly counts: ActionIntensityCounts;
  /**
   * Discrete events observed since the previous sample. Summed with the
   * per-event values from `config` (each in `O(1)`).
   */
  readonly events?: readonly ActionIntensityEvent[];
  /**
   * Pre-summed event-window score `E(t)`, for callers that maintain the
   * sliding-window accumulator themselves. Combined additively with
   * {@link events}.
   */
  readonly eventScore?: number;
  /** The EMA value produced by the previous sample; omit on the first sample. */
  readonly previousSmoothed?: number;
}

/**
 * Layer 1: the weighted on-screen presence `P(t) = Σ_c w_c · min(n_c, cap_c)`.
 *
 * Negative counts are clamped to zero so a transient bookkeeping error cannot
 * pull the score below the empty screen.
 *
 * @param counts - Live per-category counts `n_c(t)`.
 * @param config - The scoring configuration.
 */
export function computePresenceScore(
  counts: ActionIntensityCounts,
  config: ActionIntensityConfig,
): number {
  let score = 0;
  for (const category of ACTION_INTENSITY_CATEGORIES) {
    const capped = Math.min(
      Math.max(counts[category], 0),
      config.caps[category],
    );
    score += config.weights[category] * capped;
  }
  return score;
}

/**
 * Layer 2: sums the per-event values `v_e` for the supplied events. Each
 * event is handled in `O(1)`; windowing is the caller's responsibility.
 *
 * @param events - The events to score.
 * @param config - The scoring configuration.
 */
export function computeEventScore(
  events: readonly ActionIntensityEvent[],
  config: ActionIntensityConfig,
): number {
  let score = 0;
  for (const event of events) {
    score += config.eventValues[event.type];
  }
  return score;
}

/**
 * The EMA coefficient `α = 1 − 2^(−Δt/h)` with `Δt = 1 / sampleRateHz` (§6.4).
 *
 * @param config - The scoring configuration.
 */
export function smoothingAlpha(config: ActionIntensityConfig): number {
  const deltaSeconds = 1 / config.sampleRateHz;
  return 1 - Math.pow(2, -deltaSeconds / config.halfLifeSeconds);
}

/**
 * Computes one action-intensity sample from the live counts and events (§6–§7.1).
 *
 * Pure: it reads only its arguments and returns a fresh sample object; the
 * caller threads {@link ActionIntensitySample.smoothed} back in as
 * {@link ActionIntensityState.previousSmoothed} for the next tick.
 *
 * @param state - The per-tick counts, events and previous EMA value.
 * @param config - The scoring configuration; defaults to
 *   {@link DEFAULT_ACTION_INTENSITY_CONFIG}.
 */
export function computeActionIntensity(
  state: ActionIntensityState,
  config: ActionIntensityConfig = DEFAULT_ACTION_INTENSITY_CONFIG,
): ActionIntensitySample {
  const presence = computePresenceScore(state.counts, config);
  const events = state.events
    ? computeEventScore(state.events, config)
    : 0;
  const rawScore = presence + config.eventBlend * ((state.eventScore ?? 0) + events);

  const denominator = rawScore + config.referenceBudget;
  const intensity = denominator > 0 ? rawScore / denominator : 0;

  const alpha = smoothingAlpha(config);
  const smoothed =
    state.previousSmoothed === undefined
      ? intensity
      : alpha * intensity + (1 - alpha) * state.previousSmoothed;

  return {
    rawScore,
    intensity,
    smoothed,
    burstiness: intensity - smoothed,
    breakdown: {
      playerBullets: state.counts.playerBullets,
      enemyBullets: state.counts.enemyBullets,
      enemies: state.counts.enemies,
      asteroids: state.counts.asteroids,
      drops: state.counts.drops,
      enemyExplosions: state.counts.enemyExplosions,
      bossExplosions: state.counts.bossExplosions,
      playerExplosions: state.counts.playerExplosions,
      bosses: state.counts.bosses,
    },
  };
}

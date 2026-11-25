/**
 * Elite (anomaly) vocabulary and load-time validation
 * (AH-0MWU664T300140IL).
 *
 * An elite is **not** a new entity class: it is one ordinary, counted
 * archetype carrying one extra bounded behaviour and a bonus hit-point
 * pool, authored through the `eliteBehaviour` / `eliteBonusHp` columns of
 * `src/data/enemy-configs.csv`. This leaf module is the single place the
 * bounded vocabulary lives — the per-slice implementation modules import
 * it instead of copying id lists — mirroring
 * `HEX_PERSONALITY_MECHANICS` in `src/core/hangarWar/hexRing.ts`.
 *
 * Validation is deliberately **loud and load-time**: an unknown behaviour
 * id, an elite on an uncounted-hazard archetype, or an out-of-range bonus
 * hit-point value fails when the config is loaded
 * (`configStore.loadEnemyConfig`) rather than later at spawn. A blank or
 * absent value is neutral, so an ordinary enemy keeps today's behaviour
 * byte-for-byte.
 *
 * @module src/core/eliteVocabulary
 */

/**
 * The **bounded** elite-behaviour set: one extra behaviour per elite, drawn
 * from a short, exported list so the shared combat core cannot grow an
 * unbounded mechanic set.
 *
 * - `splitter` — on death releases two ordinary children of its archetype.
 * - `reinforced` — spawns behind the shipped force-field layer with one
 *   extra field hit.
 * - `volatile` — on death leaves a short-lived radial burst of bullets.
 */
export const ELITE_BEHAVIOURS = Object.freeze([
  'splitter',
  'reinforced',
  'volatile',
] as const);

/** One authored elite behaviour id (see {@link ELITE_BEHAVIOURS}). */
export type EliteBehaviour = (typeof ELITE_BEHAVIOURS)[number];

/** Minimum extra hit points an elite may carry (inclusive). */
export const ELITE_BONUS_HP_MIN = 1;

/** Maximum extra hit points an elite may carry (inclusive). */
export const ELITE_BONUS_HP_MAX = 3;

/**
 * Archetype keys that are **uncounted hazards**: they are not registered as
 * wave enemies, so an elite variant of one could not be wave-accounted and
 * could stall or short-circuit a wave. An elite is only ever a variant of a
 * counted archetype, so these keys are rejected at load.
 *
 * `centipede` has no CSV row (its seed default comes from
 * `resolveWrapAwareDefault`), but it is listed here so the rule is stated
 * once for every uncounted hazard the game ships.
 */
export const UNCOUNTED_HAZARD_KEYS = Object.freeze([
  'asteroid',
  'lane-traffic',
  'centipede',
  'ghost-chase',
  'ghost-ambush',
  'ghost-flank',
  'ghost-wander',
  // The telegraphed Missile-Command strike is delivered by the non-blocking
  // strike plan and is never wave-accounted.
  'orbital-strike',
] as const);

/** One archetype key the elite axis refuses (see {@link UNCOUNTED_HAZARD_KEYS}). */
export type UncountedHazardKey = (typeof UNCOUNTED_HAZARD_KEYS)[number];

/** The elite field an {@link EliteValidationError} refers to. */
export type EliteValidationField =
  | 'eliteBehaviour'
  | 'eliteBonusHp'
  | 'uncountedHazard';

/** One actionable elite-config validation failure. */
export interface EliteValidationError {
  /** The authored field (or rule) the failure belongs to. */
  field: EliteValidationField;
  /** Human-readable, actionable message. */
  message: string;
}

/** Result of {@link validateEliteArchetype}. */
export interface EliteValidationResult {
  /** True when the elite fields are valid (or neutral). */
  ok: boolean;
  /** Every failure found; empty when `ok` is true. */
  errors: EliteValidationError[];
}

/**
 * The elite-relevant slice of an archetype: its key plus the two authored
 * CSV cells. Raw string cells are accepted so the codec can validate a row
 * before coercion, and a resolved `EnemyConfig` also satisfies the shape.
 */
export interface EliteArchetypeInput {
  /** Archetype key (used for the uncounted-hazard rule). */
  key?: string;
  /** Authored `eliteBehaviour` cell; blank/absent is neutral. */
  eliteBehaviour?: string | null;
  /** Authored `eliteBonusHp` cell; blank/absent is neutral. */
  eliteBonusHp?: string | number | null;
}

/** True when `value` is one of the bounded {@link ELITE_BEHAVIOURS}. */
export function isEliteBehaviour(value: unknown): value is EliteBehaviour {
  return (
    typeof value === 'string' &&
    (ELITE_BEHAVIOURS as readonly string[]).includes(value)
  );
}

/** True when `key` is an uncounted hazard (see {@link UNCOUNTED_HAZARD_KEYS}). */
export function isUncountedHazardKey(key: string): boolean {
  return (UNCOUNTED_HAZARD_KEYS as readonly string[]).includes(key);
}

/**
 * Validate an archetype's elite fields.
 *
 * A blank/absent `eliteBehaviour` is neutral. When present, the id must be
 * one of {@link ELITE_BEHAVIOURS} and the archetype must not be an uncounted
 * hazard. A present `eliteBonusHp` must be an integer in
 * `[ELITE_BONUS_HP_MIN, ELITE_BONUS_HP_MAX]`. Every failure is returned so a
 * caller can report all of them at once.
 */
export function validateEliteArchetype(
  input: EliteArchetypeInput,
): EliteValidationResult {
  const errors: EliteValidationError[] = [];
  const key = (input.key ?? '').trim();

  const rawBehaviour =
    input.eliteBehaviour == null ? '' : String(input.eliteBehaviour).trim();
  const hasBehaviour = rawBehaviour !== '';

  if (hasBehaviour && !isEliteBehaviour(rawBehaviour)) {
    errors.push({
      field: 'eliteBehaviour',
      message:
        `Unknown eliteBehaviour "${rawBehaviour}" — valid values: ` +
        ELITE_BEHAVIOURS.join(', '),
    });
  }

  // An elite must be a counted wave enemy. A hazard with a (valid or invalid)
  // behaviour is rejected rather than silently spawning an uncountable elite.
  if (hasBehaviour && isUncountedHazardKey(key)) {
    errors.push({
      field: 'uncountedHazard',
      message:
        `Archetype "${key}" is an uncounted hazard and cannot be an elite ` +
        '(elites must be counted wave enemies)',
    });
  }

  const rawBonusHp =
    input.eliteBonusHp == null ? '' : String(input.eliteBonusHp).trim();
  if (rawBonusHp !== '') {
    const bonusHp = Number(rawBonusHp);
    if (
      !Number.isInteger(bonusHp) ||
      bonusHp < ELITE_BONUS_HP_MIN ||
      bonusHp > ELITE_BONUS_HP_MAX
    ) {
      errors.push({
        field: 'eliteBonusHp',
        message:
          `Invalid eliteBonusHp "${rawBonusHp}" — must be a positive integer ` +
          `in range ${ELITE_BONUS_HP_MIN}–${ELITE_BONUS_HP_MAX}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Error thrown when an invalid elite archetype is loaded. Carries the
 * structured failures so a caller can surface every problem, and names the
 * elite fields in the message so the failure is the loud, load-time signal
 * the data model promises.
 */
export class EliteConfigError extends Error {
  /** Every elite-config failure that caused the throw. */
  readonly errors: EliteValidationError[];

  constructor(errors: EliteValidationError[]) {
    super(
      'Invalid elite enemy config:\n' +
        errors.map((error) => `  - ${error.message}`).join('\n'),
    );
    this.name = 'EliteConfigError';
    this.errors = errors;
  }
}

/**
 * Throw an {@link EliteConfigError} when the archetype's elite fields are
 * invalid. Used by `configStore.loadEnemyConfig` so a bad value fails at
 * load, not at spawn.
 */
export function assertEliteArchetype(input: EliteArchetypeInput): void {
  const result = validateEliteArchetype(input);
  if (!result.ok) throw new EliteConfigError(result.errors);
}

/**
 * Type declarations for the dependency-free promo wave definitions
 * (`scripts/promo-scenarios.mjs`, AH-0MVSDM79Y000HM3R).
 *
 * The implementation is plain ESM so bare Node (the capture CLI) and the Vite
 * game build can both import it; these declarations let the scenario
 * catalogue, the resolver, `PlayScene` and the tests consume the authored
 * levels without `any` leaks. A promo level is structurally a shipped
 * `LevelDefinition` plus the promo metadata the catalogue needs, so it can be
 * handed to `WaveManager.setLevels(...)` unchanged.
 */

import type { LevelDefinition } from '../src/waves/Formations';
import type { EditorialCategory } from './capture-scenario-schema.mjs';

/**
 * One hand-authored promo level.
 *
 * `level`, `name` and `waves` are exactly what `WaveManager` plays (a promo
 * level is always a single-level injected campaign, hence `level: 1`);
 * `promoLevel` is the id a registry scenario references and `categories` is
 * the editorial coverage the level is authored to evidence.
 */
export interface PromoLevelDefinition extends LevelDefinition {
  /** Lower-case kebab-case id, e.g. `promo-blitz-hook`. */
  readonly promoLevel: string;
  /** Editorial categories this level is authored to evidence (at least one). */
  readonly categories: readonly EditorialCategory[];
}

/** The arena defaults promo waves are authored against. */
export interface PromoArenaDefaults {
  /** Formation base x at spawn (px). */
  readonly startX: number;
  /** Formation base y at spawn (px). */
  readonly startY: number;
  /** Default horizontal slot spacing (px). */
  readonly spacingX: number;
  /** Default vertical slot spacing (px). */
  readonly spacingY: number;
}

/** Enemy keys a promo wave may place as a wave group. */
export const PROMO_GROUP_ARCHETYPES: readonly string[];

/** Formation builder kinds a promo group may use (mirrors `EnemyFormationKind`). */
export const PROMO_FORMATIONS: readonly string[];

/** Spawner opt-in flags a promo wave may set (mirrors `WaveDefinition`). */
export const PROMO_WAVE_FLAGS: readonly (
  | 'ghosts'
  | 'centipede'
  | 'horde'
  | 'laneTraffic'
  | 'miniBoss'
)[];

/** The arena defaults promo waves are authored against. */
export const PROMO_ARENA_DEFAULTS: PromoArenaDefaults;

/** The promo levels keyed by their `promoLevel` id. Frozen and validated. */
export const PROMO_LEVELS: Readonly<Record<string, PromoLevelDefinition>>;

/** The promo level ids in catalogue-listing order (the hook first). */
export const PROMO_LEVEL_KEYS: readonly string[];

/**
 * Validates one promo level against the authoring contract, throwing with an
 * actionable message naming the level, wave and group on the first problem.
 */
export function assertPromoLevelDefinition(level: unknown, label?: string): void;

/** Returns the frozen promo level for a `promoLevel` reference (throws if unknown). */
export function getPromoLevel(key: unknown): PromoLevelDefinition;

/** Lists the promo levels as fresh deep copies, in catalogue order. */
export function listPromoLevels(): PromoLevelDefinition[];
